/**
 * Orchestrator — fetch unprocessed Airtable emails, classify with Claude,
 * insert into rent_payments or utility_bills (Conservice), mark as
 * processed so we never re-classify.
 *
 * Caller is responsible for setting up the heartbeat — this just runs the work.
 */

import pool from './db.js';
import { getUnprocessedEmails, markProcessed } from './airtable.js';
import { classifyEmail } from './rent-parser.js';
import { extractRentPayment, cleanRentUnit } from './rent-providers.js';
import { resolveLandlord, resolveRentAlias } from './landlord-resolver.js';
import { createNotification } from './notifier.js';

// Alert (max once per 12h) when classification fails for API-side reasons —
// above all "credit balance is too low", which silently killed rent ingestion
// between Jul 28 and Aug 2 2026.
async function alertApiDown(message) {
  const recent = await pool.query(
    `SELECT 1 FROM notifications WHERE title = 'Claude API unavailable — rent sync paused'
       AND created_at > NOW() - INTERVAL '12 hours' LIMIT 1`
  );
  if (recent.rowCount > 0) return;
  await createNotification({
    type:    'error',
    title:   'Claude API unavailable — rent sync paused',
    message: `Email classification is failing (${(message || '').slice(0, 140)}). If it mentions credit balance, top up the Anthropic account — rent/Conservice emails are deferred, not lost, and will process once the API responds.`,
  });
}

// Rate-limit knobs. Anthropic Haiku ~30k tokens/min. Each classify call uses
// ~2000 input + 500 output ≈ 2.5k tokens — so 12/min max. 500ms gap gives us
// margin and keeps the cron under 60s for batches of ~20.
const PAUSE_BETWEEN_CLAUDE_MS = 500;

export async function syncAirtable({ limit = 20 } = {}) {
  const emails = await getUnprocessedEmails({ limit });

  if (emails.length === 0) {
    return { ok: true, scanned: 0, rent: 0, conservice: 0, skipped: 0, errors: 0 };
  }

  let rent       = 0;
  let conservice = 0;
  let skipped    = 0;
  let errors     = 0;
  const results  = [];

  let usoIA = false;
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      // Paso 5 del plan: el remitente decide, como en utilities. Los 7
      // portales conocidos se leen con reglas fijas — sin IA, sin credito que
      // agotar (el fallo del 1/8/2026). Claude queda de reserva para
      // remitentes que no reconozcamos (Conservice incluido).
      let verdict;
      const det = extractRentPayment(email);
      if (det && det.kind === 'rent_payment') {
        verdict = { category: 'rent_payment', ...det, confidence: 'deterministic' };
        usoIA = false;
      } else if (det && det.kind === 'noise'
                 && !/payment|receipt|confirm/i.test(email.subject || '')) {
        // Ruido claro de un portal conocido (marketing, avisos): fuera sin IA.
        verdict = { category: 'skip', reason: `regla fija: ${det.template}` };
        usoIA = false;
      } else {
        // Red de seguridad: si el asunto tiene pinta de recibo pero la regla
        // no pudo leerlo (variante de plantilla nueva), decide la IA en vez
        // de tirarlo. Un pago degradado a silencio seria una regresion.
        verdict = await classifyEmail(email);
        usoIA = true;
      }

      if (!verdict || verdict.category === 'skip') {
        await markProcessed(email.id, 'skip', verdict?.reason || 'unclassified');
        skipped++;
        results.push({ id: email.id, status: 'skipped', reason: verdict?.reason });
        continue;
      }

      if (verdict.category === 'rent_payment') {
        await insertRentPayment(email, verdict);
        await markProcessed(email.id, 'rent_payment', verdict.reason || null);
        rent++;
        results.push({ id: email.id, status: 'rent_payment', amount: verdict.amount_paid });
        continue;
      }

      if (verdict.category === 'conservice_utility') {
        await insertConserviceUtility(email, verdict);
        await markProcessed(email.id, 'conservice_utility', verdict.reason || null);
        conservice++;
        results.push({ id: email.id, status: 'conservice_utility', amount: verdict.amount_due });
        continue;
      }
    } catch (e) {
      // TRANSIENT failures (no API credit, rate limit, 5xx) must NOT be
      // marked processed — that made them permanent: on Jul 28 + Aug 2 2026
      // the Anthropic account ran out of credit and 26 emails (including
      // the month-end rent confirmations) were silently lost as 'error'.
      // Leave them unprocessed so the next run retries.
      const transient = /credit balance|rate.?limit|429|overloaded|5\d\d|timeout|ECONNRESET|fetch failed/i.test(e.message || '');
      if (!transient) {
        await markProcessed(email.id, 'error', e.message?.slice(0, 200) || 'unknown');
      }
      errors++;
      results.push({ id: email.id, status: transient ? 'deferred_api_error' : 'error', reason: e.message });
      if (transient) {
        try { await alertApiDown(e.message); } catch { /* never block on alerting */ }
        break; // API is down/degraded — stop burning the batch, retry next run
      }
    }

    // La pausa protege el rate limit de Claude: solo hace falta si este
    // email consumio IA. Las reglas fijas no gastan nada.
    if (usoIA && i < emails.length - 1) {
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_CLAUDE_MS));
    }
  }

  return { ok: true, scanned: emails.length, rent, conservice, skipped, errors, results };
}

/**
 * Insert a rent payment confirmation.
 *
 * Property+unit resolution order:
 *   1. Claude's own extraction from the email body (often the most precise
 *      because it can read the actual confirmation page snippet)
 *   2. The landlord mapping (handles the case where Claude knew the landlord
 *      name but not the building address — Edonis configured the address once
 *      in /admin/landlords)
 *   3. Legacy mailbox mapping (still consulted as a fallback for old data)
 *
 * If none resolve → property stays NULL → shows up under "Unassigned" in the
 * Rent tab so Jake/Edonis sees there's work to do.
 */
// Management-company OFFICE addresses that portal emails sometimes carry
// instead of the rented unit's address. Never a service address — discard so
// the alias/landlord resolvers below fill the real property. (837 Washington
// St NY is VRS/PR's corporate office; it mis-labeled Genoa/Sorrento/Portofino
// payments as a New York property until Aug 2026.)
const OFFICE_ADDRESSES = [/837\s+washington/i];

async function insertRentPayment(email, v) {
  // Orden de autoridad (paso 5): igual que en utilities, la tabla curada
  // manda y la extraccion del email rellena huecos.
  //   1. rent_alias_map — buzon + importe, construido desde las Classes de
  //      Jake. Conservador: con ambiguedad devuelve null.
  //   2. Lo extraido del propio email (regla fija del portal, o Claude).
  //   3. El mapa de landlords.
  // Antes la extraccion de Claude iba primero, y de ahi salian cosas como la
  // oficina de 837 Washington como si fuera una propiedad.
  let property = null;
  let unit     = null;

  const alias = await resolveRentAlias({ mailbox: email.mailbox, amount: v.amount_paid, landlord: v.landlord });
  if (alias) {
    property = alias.property_address;
    unit     = alias.unit;
  }

  const extraido = v.property_address || null;
  if (!property && extraido && !OFFICE_ADDRESSES.some(re => re.test(extraido))) {
    property = extraido;
  }
  if (!unit && v.unit) unit = cleanRentUnit(v.unit);

  // 2. Landlord mapping
  if ((!property || !unit) && v.landlord) {
    const r = await resolveLandlord({ landlord: v.landlord, mailbox: email.mailbox });
    if (r) {
      property = property || r.property_address;
      unit     = unit     || r.unit;
    }
  }

  // 3. Legacy mailbox mapping (fallback)
  if (!property && email.mailbox) {
    const map = await pool.query(
      `SELECT property_address, unit FROM mailbox_property_map WHERE mailbox = $1 LIMIT 1`,
      [email.mailbox]
    );
    if (map.rows[0]) {
      property = map.rows[0].property_address;
      unit     = unit || map.rows[0].unit;
    }
  }

  const paidDate = v.paid_date || (email.received ? email.received.slice(0, 10) : null);

  await pool.query(
    `INSERT INTO rent_payments
       (source, airtable_record_id, mailbox, property_address, unit, amount_paid,
        paid_date, landlord, payment_portal, confirmation_number,
        email_received_at, email_subject, email_from, status, raw)
     VALUES
       ('airtable', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'paid', $13)
     ON CONFLICT (airtable_record_id) DO NOTHING`,
    [
      email.id,
      email.mailbox,
      property,
      unit,
      v.amount_paid,
      paidDate,
      v.landlord,
      v.payment_portal,
      v.confirmation_number,
      email.received,
      email.subject,
      email.fromEmail || email.from,
      JSON.stringify({ verdict: v, from: email.from, fromEmail: email.fromEmail }),
    ]
  );
}

/**
 * Insert a Conservice consolidated utility bill into utility_bills as
 * utility_type='building'. Uses a synthetic airtable:<id> as the
 * gmail_message_id so it doesn't collide with real Gmail emails.
 */
async function insertConserviceUtility(email, v) {
  const syntheticId = `airtable:${email.id}`;
  const building = v.building_name || v.property_address || null;

  await pool.query(
    `INSERT INTO utility_bills
       (gmail_message_id, utility_type, property_address, unit, account_last4,
        amount_due, due_date, email_received_at, email_subject, email_from, status)
     VALUES ($1, 'building', $2, NULL, NULL, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    [
      syntheticId,
      building,
      v.amount_due,
      v.due_date,
      email.received,
      email.subject,
      email.fromEmail || email.from,
    ]
  );
}

/**
 * Assign a mailbox to a property + unit, then back-fill ALL existing
 * rent_payments rows from that mailbox so the dashboard shows them assigned.
 *
 * The back-fill overwrites any previous property on rows from this mailbox —
 * the new mapping is the source of truth. This matters when a previous
 * mapping was wrong (typo) and the user is correcting it now.
 *
 * Returns:
 *   - newlyAssigned: rows that had NULL property → now set
 *   - reassigned:    rows that had a (different) property → corrected
 */
export async function assignMailbox({ mailbox, property_address, unit = null, assigned_by = null }) {
  if (!mailbox || !property_address) {
    throw new Error('mailbox and property_address are required');
  }
  await pool.query(
    `INSERT INTO mailbox_property_map (mailbox, property_address, unit, assigned_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (mailbox) DO UPDATE
       SET property_address = EXCLUDED.property_address,
           unit             = EXCLUDED.unit,
           assigned_by      = EXCLUDED.assigned_by,
           updated_at       = NOW()`,
    [mailbox, property_address, unit, assigned_by]
  );
  // Newly-assigned (NULL → property)
  const nullAssign = await pool.query(
    `UPDATE rent_payments
        SET property_address = $1, unit = COALESCE(unit, $2)
      WHERE mailbox = $3 AND property_address IS NULL`,
    [property_address, unit, mailbox]
  );
  // Re-assigned (different property → corrected)
  const reassign = await pool.query(
    `UPDATE rent_payments
        SET property_address = $1, unit = COALESCE(NULLIF($2, ''), unit)
      WHERE mailbox = $3
        AND property_address IS NOT NULL
        AND property_address <> $1`,
    [property_address, unit, mailbox]
  );
  const newlyAssigned = nullAssign.rowCount;
  const reassigned    = reassign.rowCount;
  return {
    newlyAssigned,
    reassigned,
    backfilled: newlyAssigned + reassigned,  // total for the toast
  };
}

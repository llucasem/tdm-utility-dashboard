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

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      const verdict = await classifyEmail(email);

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
      await markProcessed(email.id, 'error', e.message?.slice(0, 200) || 'unknown');
      errors++;
      results.push({ id: email.id, status: 'error', reason: e.message });
    }

    // Don't pause after the last record — wastes 500ms on the cron budget.
    if (i < emails.length - 1) {
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_CLAUDE_MS));
    }
  }

  return { ok: true, scanned: emails.length, rent, conservice, skipped, errors, results };
}

/**
 * Insert a rent payment confirmation. Tries to auto-resolve the property
 * from mailbox_property_map. If unmapped, the row goes in with NULL
 * property → shows up in "Unassigned" section of the Rent tab.
 */
async function insertRentPayment(email, v) {
  const map = await pool.query(
    `SELECT property_address, unit FROM mailbox_property_map WHERE mailbox = $1 LIMIT 1`,
    [email.mailbox]
  );
  const property = map.rows[0]?.property_address || v.property_address || null;
  const unit     = map.rows[0]?.unit             || v.unit             || null;

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

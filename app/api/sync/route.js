/**
 * Sync de facturas — reescrito en la fase 3 del reset (14/08/2026).
 *
 * Como funciona ahora, y en que se diferencia del anterior:
 *
 *   1. El remitente decide. Los 5 proveedores que mandan facturas de verdad
 *      usan plantillas rigidas (lib/providers.js): se leen con expresiones
 *      regulares, sin IA, sin coste y sin margen de error.
 *   2. La IA solo interviene con remitentes que NO reconocemos, y limitada a
 *      leer importe / vencimiento / cuenta. Nunca decide de quien es la factura.
 *   3. La propiedad sale del registro de cuentas (account_registry). Antes se
 *      le preguntaba a la IA en cada email, y contestaba distinto cada mes.
 *   4. El ruido va a processed_emails, no a utility_bills. La tabla de
 *      facturas pasa a tener solo facturas (antes el 72% era basura).
 */
import { getUtilityEmails }   from '@/lib/gmail';
import { parseEmail }         from '@/lib/parser';
import pool                   from '@/lib/db';
import { extractBill }        from '@/lib/providers';
import { loadRegistry, resolveAccount, normAddress, normUnit } from '@/lib/account-registry';
import { matchBatch }         from '@/lib/qb-match';
import { createNotification } from '@/lib/notifier';
import { startHeartbeat, endHeartbeat } from '@/lib/heartbeat';
import { syncAirtable }       from '@/lib/airtable-sync';

export const maxDuration = 60;

// Sin llamadas a Claude el trabajo por email es de milisegundos, asi que el
// limite ya no es el numero de emails sino el reloj de Vercel (60s duros).
const DEADLINE_MS     = 42_000;   // deja ~18s para el match de QB y Airtable
const MAX_IA_POR_RUN  = 8;        // solo para remitentes desconocidos
const VENTANA_DUP_DIAS = 18;      // recordatorios del mismo recibo

export async function GET() {
  const hb = startHeartbeat('sync');
  const t0 = Date.now();
  const transcurrido = () => Date.now() - t0;

  try {
    const [emails, registry] = await Promise.all([
      getUtilityEmails(),
      loadRegistry(pool),
    ]);

    const stats = { facturas: 0, saldo_favor: 0, pagos: 0, ruido: 0, errores: 0, aplazados: 0, ia: 0 };
    const nuevasIds = [];
    const revisar   = [];
    let usosIA = 0;

    for (const email of emails) {
      if (transcurrido() > DEADLINE_MS) { stats.aplazados++; continue; }

      let lectura = extractBill(email);

      // Remitente desconocido -> IA de reserva, con presupuesto.
      if (!lectura) {
        if (usosIA >= MAX_IA_POR_RUN) { stats.aplazados++; continue; }
        usosIA++; stats.ia++;
        try {
          const p = await parseEmail(email);
          lectura = p && p.amount_due > 0
            ? { kind: 'bill', provider: null, utility_type: p.utility_type || 'other',
                account_last4: p.account_last4 || null, amount_due: parseFloat(p.amount_due),
                due_date: p.due_date || null, template: 'ia/reserva' }
            : { kind: 'noise', template: 'ia/sin-importe' };
        } catch (e) {
          stats.errores++;
          await registrar(email, { decision: 'error', note: e.message?.slice(0, 200) });
          continue;
        }
      }

      const items = lectura.kind === 'multi' ? lectura.items : [lectura];

      for (const item of items) {
        if (item.kind === 'noise') {
          stats.ruido++;
          await registrar(email, { decision: 'noise', ...item });
          continue;
        }

        if (item.kind === 'payment') {
          const marcadas = await marcarPagada(item, email);
          stats.pagos++;
          await registrar(email, { decision: 'payment', ...item,
            note: marcadas ? `marcada pagada la factura ${marcadas}` : 'sin factura que casar' });
          continue;
        }

        if (item.kind === 'credit') {
          stats.saldo_favor++;
          await registrar(email, { decision: 'credit', ...item,
            note: `saldo a favor $${item.credit_balance ?? item.amount_due}` });
          continue;
        }

        // ── factura ──────────────────────────────────────────────────────
        const prop = resolverPropiedad(registry, item, revisar);

        const duplicada = await esDuplicada(item, email);
        const res = await pool.query(
          `INSERT INTO utility_bills
             (gmail_message_id, utility_type, property_address, unit, account_last4,
              amount_due, due_date, email_received_at, email_subject, email_from,
              status, is_duplicate, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'email')
           ON CONFLICT (gmail_message_id) DO NOTHING
           RETURNING id`,
          [idFactura(email, item, items), item.utility_type, prop.address, prop.unit,
           item.account_last4, item.amount_due, item.due_date, email.date,
           email.subject, email.from || null, 'pending', duplicada]
        );

        if (res.rowCount) {
          stats.facturas++;
          nuevasIds.push(res.rows[0].id);
          await registrar(email, { decision: 'bill', ...item, bill_id: res.rows[0].id,
            note: `propiedad desde ${prop.origen}${duplicada ? ' · duplicada' : ''}` });
          // Cuenta nueva: se aprende sola desde la direccion que trae el email.
          if (prop.origen === 'email' && item.account_last4) {
            await aprenderCuenta(item, prop, registry);
          }
        }
      }
    }

    // ── QuickBooks: ya solo responde "¿esta pagada?" ────────────────────
    let match = null;
    if (nuevasIds.length && transcurrido() < 50_000) {
      try { match = await matchBatch(nuevasIds); }
      catch (e) { match = { error: e.message }; }
    }

    // ── Airtable (rent) con el tiempo que quede ─────────────────────────
    let airtable = null;
    const queda = 55_000 - transcurrido();
    if (queda < 8_000) {
      airtable = { ok: true, skipped: 'aplazado — el presupuesto de tiempo se fue en Gmail' };
    } else {
      try { airtable = await syncAirtable({ limit: Math.max(1, Math.min(15, Math.floor(queda / 3_000))) }); }
      catch (e) { airtable = { ok: false, error: e.message }; }
    }

    if (revisar.length) {
      await createNotification({
        type: 'warning',
        title: `${revisar.length} facturas sin propiedad`,
        message: 'Cuentas que no estan en el registro. Al asignarlas una vez, quedan fijadas.'
               + ' · ' + revisar.slice(0, 5).map(r => `${r.utility_type} ····${r.account_last4}`).join(', '),
        metadata: { revisar },
      });
    }

    if (stats.facturas || stats.errores) {
      await createNotification({
        type: stats.errores ? 'warning' : 'success',
        title: `Sync · ${stats.facturas} facturas nuevas`,
        message: [`${stats.facturas} facturas`, `${stats.pagos} pagos`, `${stats.saldo_favor} saldo a favor`,
                  `${stats.ruido} ruido`, `${stats.ia} con IA`,
                  match?.matched ? `${match.matched} casadas en QB` : null,
                 ].filter(Boolean).join(' · '),
        metadata: { stats, match },
      });
    }

    await endHeartbeat(hb, { ok: stats.errores === 0 });
    return Response.json({ ok: true, emails: emails.length, ...stats, match, airtable, revisar });

  } catch (error) {
    console.error('[sync]', error);
    await endHeartbeat(hb, { ok: false, error: error.message });
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// ── auxiliares ───────────────────────────────────────────────────────────────

/** Un email consolidado genera varias facturas: cada una necesita su propio id. */
function idFactura(email, item, items) {
  if (items.length === 1) return email.id;
  return `${email.id}#${item.account_last4}-${item.amount_due}`;
}

/**
 * La propiedad SIEMPRE del registro. Solo si la cuenta no esta registrada se
 * usa la direccion que venga en el propio email (Spectrum y el consolidado de
 * ConEd la traen). Si no hay ni una ni otra, la factura queda sin asignar y
 * Jake la resuelve UNA vez.
 */
function resolverPropiedad(registry, item, revisar) {
  const reg = resolveAccount(registry, item.utility_type, item.account_last4);
  if (reg) return { address: reg.property_address, unit: reg.unit, origen: 'registro' };

  if (item.service_address) {
    return { address: normAddress(item.service_address), unit: normUnit(item.unit), origen: 'email' };
  }

  revisar.push({ utility_type: item.utility_type, account_last4: item.account_last4, amount: item.amount_due });
  return { address: null, unit: null, origen: 'sin asignar' };
}

/** Una cuenta nueva se registra sola con la direccion que trae el proveedor. */
async function aprenderCuenta(item, prop, registry) {
  if (!prop.address) return;
  await pool.query(
    `INSERT INTO account_registry
       (utility_type, account_last4, provider, property_address, unit, confidence, bills_seen, notes, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,'provisional',1,$6, now(), now())
     ON CONFLICT (utility_type, account_last4) DO NOTHING`,
    [item.utility_type, item.account_last4, item.provider || null, prop.address, prop.unit,
     'Aprendida del propio email del proveedor durante el sync.']
  );
  registry.set(`${item.utility_type}|${item.account_last4}`,
    { property_address: prop.address, unit: prop.unit, confidence: 'provisional' });
}

/**
 * Los proveedores mandan varios avisos del mismo recibo (ConEd "Bill Is Ready"
 * y "Bill Is Due" 12-14 dias despues, Spectrum statement y domiciliacion 8
 * dias despues). Misma cuenta + mismo importe dentro de 18 dias = el mismo
 * recibo. Los ciclos mensuales de verdad van a 28-31 dias, asi que no hay
 * riesgo de tapar una factura real.
 */
async function esDuplicada(item, email) {
  if (!item.account_last4 || !item.amount_due) return false;
  const r = await pool.query(
    `SELECT 1 FROM utility_bills
      WHERE utility_type = $1 AND account_last4 = $2
        AND ROUND(amount_due::numeric,2) = ROUND($3::numeric,2)
        AND NOT coalesce(is_duplicate,false)
        AND email_received_at BETWEEN $4::timestamptz - make_interval(days => $5)
                                  AND $4::timestamptz + make_interval(days => $5)
      LIMIT 1`,
    [item.utility_type, item.account_last4, item.amount_due, email.date, VENTANA_DUP_DIAS]
  );
  return r.rowCount > 0;
}

/** Una confirmacion de pago marca pagada la factura que le corresponde. */
async function marcarPagada(item, email) {
  if (!item.account_last4 || !item.amount_due) return null;
  const r = await pool.query(
    `UPDATE utility_bills SET status = 'paid'
      WHERE id = (
        SELECT id FROM utility_bills
         WHERE utility_type = $1 AND account_last4 = $2
           AND ROUND(amount_due::numeric,2) = ROUND($3::numeric,2)
           AND status <> 'paid' AND NOT coalesce(is_duplicate,false)
           AND email_received_at BETWEEN $4::timestamptz - interval '45 days' AND $4::timestamptz + interval '5 days'
         ORDER BY email_received_at DESC LIMIT 1)
      RETURNING id`,
    [item.utility_type, item.account_last4, item.amount_due, email.date]
  );
  return r.rows[0]?.id || null;
}

/** Deja constancia de que este email ya se miro, decida lo que decida. */
async function registrar(email, info) {
  await pool.query(
    `INSERT INTO processed_emails
       (gmail_message_id, provider, decision, template, account_last4, amount,
        email_subject, email_from, email_received_at, bill_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (gmail_message_id) DO UPDATE SET
       decision = excluded.decision, template = excluded.template,
       bill_id = coalesce(excluded.bill_id, processed_emails.bill_id),
       note = excluded.note, processed_at = now()`,
    [email.id, info.provider || null, info.decision, info.template || null,
     info.account_last4 || null, info.amount_due ?? null,
     email.subject, email.from || null, email.date, info.bill_id || null, info.note || null]
  );
}

/**
 * Sync de facturas — reescrito en la fase 3 del reset (14/08/2026).
 *
 *   1. El remitente decide. Los 5 proveedores que mandan facturas de verdad
 *      usan plantillas rigidas (lib/providers.js): se leen con expresiones
 *      regulares, sin IA, sin coste y sin margen de error.
 *   2. La IA solo interviene con remitentes que NO reconocemos, y limitada a
 *      leer importe / vencimiento / cuenta. Nunca decide de quien es la factura.
 *   3. La propiedad sale del registro de cuentas (account_registry).
 *   4. El ruido va a processed_emails, no a utility_bills.
 *
 * La logica de decision vive en lib/sync-core.js para poder probarla sin
 * Gmail, sin Claude y sin base de datos. Aqui solo queda la orquestacion.
 */
import { getUtilityEmails }   from '@/lib/gmail';
import { parseEmail }         from '@/lib/parser';
import pool                   from '@/lib/db';
import { loadRegistry }       from '@/lib/account-registry';
import { procesarEmail }      from '@/lib/sync-core';
import { matchBatch }         from '@/lib/qb-match';
import { createNotification } from '@/lib/notifier';
import { startHeartbeat, endHeartbeat } from '@/lib/heartbeat';
import { syncAirtable }       from '@/lib/airtable-sync';

export const maxDuration = 60;

// Sin llamadas a Claude el trabajo por email es de milisegundos, asi que el
// limite ya no es el numero de emails sino el reloj de Vercel (60s duros).
const DEADLINE_MS    = 42_000;   // deja ~18s para el match de QB y Airtable
const MAX_IA_POR_RUN = 8;        // solo para remitentes desconocidos

export async function GET() {
  const hb = startHeartbeat('sync');
  const t0 = Date.now();
  const transcurrido = () => Date.now() - t0;

  try {
    const [emails, registry] = await Promise.all([
      getUtilityEmails(),
      loadRegistry(pool),
    ]);

    const stats = { facturas: 0, saldo_favor: 0, pagos: 0, ruido: 0, errores: 0,
                    aplazados: 0, ia: 0, duplicadas: 0, ya_existian: 0 };
    const nuevasIds = [];
    const revisar   = [];
    const discrepancias = [];
    let usosIA = 0;

    // La IA de reserva, solo para remitentes desconocidos y con presupuesto.
    const iaFallback = async (email) => {
      usosIA++; stats.ia++;
      const p = await parseEmail(email);
      return (p && p.amount_due > 0)
        ? { kind: 'bill', provider: null, utility_type: p.utility_type || 'other',
            account_last4: p.account_last4 || null, amount_due: parseFloat(p.amount_due),
            due_date: p.due_date || null, template: 'ia/reserva' }
        : { kind: 'noise', template: 'ia/sin-importe' };
    };

    for (const email of emails) {
      if (transcurrido() > DEADLINE_MS) { stats.aplazados++; continue; }

      const res = await procesarEmail({
        db: pool, email, registry,
        iaFallback: usosIA < MAX_IA_POR_RUN ? iaFallback : null,
      });

      nuevasIds.push(...res.billIds);
      revisar.push(...res.revisar);

      for (const a of res.acciones) {
        if (a.decision === 'bill')        { stats.facturas++; if (a.duplicada) stats.duplicadas++; }
        else if (a.decision === 'credit')   stats.saldo_favor++;
        else if (a.decision === 'payment')  stats.pagos++;
        else if (a.decision === 'noise')    stats.ruido++;
        else if (a.decision === 'error')    stats.errores++;
        else if (a.decision === 'deferred') stats.aplazados++;
        else if (a.decision === 'ya-existia') stats.ya_existian++;
        if (a.discrepancia) discrepancias.push({ ...a });
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

    if (discrepancias.length) {
      await createNotification({
        type: 'warning',
        title: `${discrepancias.length} direcciones que no cuadran`,
        message: 'El proveedor manda una direccion distinta a la del registro. Puede ser un cambio real de inquilino.',
        metadata: { discrepancias },
      });
    }

    if (stats.facturas || stats.errores) {
      await createNotification({
        type: stats.errores ? 'warning' : 'success',
        title: `Sync · ${stats.facturas} facturas nuevas`,
        message: [`${stats.facturas} facturas`, `${stats.pagos} pagos`,
                  `${stats.saldo_favor} saldo a favor`, `${stats.ruido} ruido`,
                  stats.ia ? `${stats.ia} con IA` : null,
                  match?.matched ? `${match.matched} casadas en QB` : null,
                 ].filter(Boolean).join(' · '),
        metadata: { stats, match },
      });
    }

    await endHeartbeat(hb, { ok: stats.errores === 0 });
    return Response.json({ ok: true, emails: emails.length, ...stats, match, airtable, revisar, discrepancias });

  } catch (error) {
    console.error('[sync]', error);
    await endHeartbeat(hb, { ok: false, error: error.message });
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

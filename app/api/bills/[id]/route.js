import pool from '@/lib/db';
import { autoTagBill } from '@/lib/auto-tag';
import { matchBill, matchBatch } from '@/lib/qb-match';
import { normAddress, normUnit } from '@/lib/account-registry';

export async function PATCH(req, { params }) {
  try {
    const { id } = await params;
    const billId = parseInt(id);
    const { property_address, unit } = await req.json();

    if (!property_address?.trim()) {
      return Response.json({ ok: false, error: 'Property address is required' }, { status: 400 });
    }

    const result = await pool.query(
      `UPDATE utility_bills
       SET property_address = $1, unit = $2
       WHERE id = $3
       RETURNING id, amount_due, due_date, email_received_at, property_address, unit, utility_type, account_last4, email_from, qb_match_status, qb_match_count, qb_match_data`,
      [property_address.trim(), unit?.trim() || null, billId]
    );

    if (result.rowCount === 0) {
      return Response.json({ ok: false, error: 'Bill not found' }, { status: 404 });
    }

    const bill = result.rows[0];

    // Cuando una persona asigna una propiedad, esa decision manda y no se
    // vuelve a preguntar: se escribe en account_registry como 'manual' y
    // locked, de modo que ni el sync ni la reconstruccion del registro la
    // pisen jamas. Es lo que hace cierto el "corrigelo una vez y queda".
    //
    // OJO: hasta el 14/08/2026 esto escribia en account_mappings, la tabla
    // que el sync nuevo ya no lee. La correccion de Jake se perdia en la
    // siguiente factura.
    let bulkUpdated = 0;
    let bulkUpdatedIds = [];
    if (bill.account_last4 && bill.utility_type) {
      const provider = (bill.email_from || '').match(/<([^>]+)>/)?.[1] || bill.email_from || null;
      try {
        // Dos formas: la canonica agrupa, la que escribio la persona se muestra.
        await pool.query(`
          INSERT INTO account_registry
            (utility_type, account_last4, provider, property_address, display_address, unit,
             confidence, locked, bills_seen, notes, first_seen_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'manual', true, 1, $7, now(), now())
          ON CONFLICT (utility_type, account_last4) DO UPDATE SET
            provider         = EXCLUDED.provider,
            property_address = EXCLUDED.property_address,
            display_address  = EXCLUDED.display_address,
            unit             = EXCLUDED.unit,
            confidence       = 'manual',
            locked           = true,
            notes            = EXCLUDED.notes,
            updated_at       = now()
        `, [bill.utility_type, bill.account_last4, provider,
            normAddress(bill.property_address), bill.property_address, normUnit(bill.unit),
            `Asignada a mano desde el dashboard el ${new Date().toISOString().slice(0, 10)}.`]);

        const bulk = await pool.query(`
          UPDATE utility_bills
          SET property_address = $1, unit = COALESCE(unit, $2)
          WHERE utility_type  = $3
            AND account_last4 = $4
            AND id != $5
            AND (property_address IS NULL OR TRIM(property_address) = '' OR property_address = '(no address)')
          RETURNING id, qb_match_status
        `, [bill.property_address, bill.unit, bill.utility_type, bill.account_last4, billId]);
        bulkUpdated    = bulk.rowCount;
        bulkUpdatedIds = bulk.rows.filter(r => r.qb_match_status === 'pending').map(r => r.id);
      } catch (mapErr) {
        // Mapping save is non-fatal — the primary assignment already succeeded
        console.error('[bills PATCH] account mapping failed:', mapErr.message);
      }
    }

    // Make sure the bill has a persisted QB match. If it doesn't (legacy data
    // or fresh bills before the cron ran), populate it now so autoTagBill can
    // reuse it.
    if (bill.qb_match_status === 'pending') {
      try {
        const r = await matchBill(bill);
        bill.qb_match_status = r.status;
        bill.qb_match_count  = r.count;
        bill.qb_match_data   = r.matches;
      } catch (e) {
        // Match failure is non-fatal — autoTagBill will handle 'pending' defensively
        console.error('[bills PATCH] match failed:', e.message);
      }
    }

    // Match the bulk-assigned siblings too so their badges show up immediately
    if (bulkUpdatedIds.length > 0) {
      try { await matchBatch(bulkUpdatedIds); } catch {}
    }

    // Try to auto-tag in QuickBooks now that we have a property assigned.
    // Failures are non-fatal — the assignment itself succeeded.
    let autoTagResult = null;
    try {
      autoTagResult = await autoTagBill(bill);
    } catch (e) {
      autoTagResult = { status: 'error', reason: e.message };
    }

    return Response.json({ ok: true, autoTag: autoTagResult, bulkUpdated });
  } catch (err) {
    console.error('[bills PATCH]', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

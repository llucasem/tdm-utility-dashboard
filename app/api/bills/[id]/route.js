import pool from '@/lib/db';
import { autoTagBill } from '@/lib/auto-tag';
import { matchBill, matchBatch } from '@/lib/qb-match';

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

    // Recurrent auto-assignment: remember this account_last4 → property mapping so
    // future bills with the same account get pre-assigned automatically. Also
    // back-fill any other unassigned bills for the same account in one go.
    let bulkUpdated = 0;
    let bulkUpdatedIds = [];
    if (bill.account_last4 && bill.utility_type) {
      const provider = (bill.email_from || '').match(/<([^>]+)>/)?.[1] || bill.email_from || null;
      try {
        await pool.query(`
          INSERT INTO account_mappings (utility_type, provider, account_last4, property_address, unit)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (utility_type, account_last4) DO UPDATE SET
            provider         = EXCLUDED.provider,
            property_address = EXCLUDED.property_address,
            unit             = EXCLUDED.unit
        `, [bill.utility_type, provider, bill.account_last4, bill.property_address, bill.unit]);

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

/**
 * Auto-tag a utility bill in QuickBooks based on its property + amount + date.
 *
 * Strict guardrails (designed to NEVER damage the customer's QuickBooks):
 *  1. Bill must have property_address  → otherwise 'skipped: no_property'
 *  2. property_qb_class mapping required → otherwise 'error: no_class_mapping'
 *  3. Exactly ONE Purchase must match (amount + ±15d) → otherwise 'not_found' / 'ambiguous'
 *  4. The Purchase must have NO existing Class anywhere → enforced inside
 *     `tagPurchaseWithClass` (returns 'skipped: already_tagged' if not)
 *
 * Persists outcome in:
 *  - utility_bills (qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at)
 *  - quickbooks_tag_log (audit trail with previous class for revertability)
 */

import pool from '@/lib/db';
import { searchTransactions, tagPurchaseWithClass } from '@/lib/quickbooks';

const DATE_TOLERANCE_DAYS = 15;

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function persist({ billId, qb_purchase_id = null, qb_purchase_type = null, qb_class_id_new = null, qb_class_id_old = null, status, match_count = null, error = null }) {
  await pool.query(`
    INSERT INTO quickbooks_tag_log
      (bill_id, qb_purchase_id, qb_purchase_type, qb_class_id_new, qb_class_id_old, status, match_count, error_message)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [billId, qb_purchase_id, qb_purchase_type, qb_class_id_new, qb_class_id_old, status, match_count, error]);

  await pool.query(`
    UPDATE utility_bills
    SET qb_tag_status  = $2,
        qb_purchase_id = COALESCE($3, qb_purchase_id),
        qb_class_id    = COALESCE($4, qb_class_id),
        qb_tagged_at   = CASE WHEN $2 = 'tagged' THEN NOW() ELSE qb_tagged_at END
    WHERE id = $1
  `, [billId, status, qb_purchase_id, qb_class_id_new]);
}

export async function autoTagBill(bill) {
  const billId = bill.id;

  if (!bill.property_address || !bill.property_address.trim()) {
    await persist({ billId, status: 'skipped', error: 'no_property' });
    return { billId, status: 'skipped', reason: 'no_property' };
  }

  const m = await pool.query(
    `SELECT qb_class_id, qb_class_name FROM property_qb_class
     WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')`,
    [bill.property_address.trim(), (bill.unit || '').trim() || null]
  );
  if (m.rows.length === 0) {
    await persist({ billId, status: 'error', error: 'no_class_mapping' });
    return { billId, status: 'error', reason: 'no_class_mapping' };
  }
  const { qb_class_id, qb_class_name } = m.rows[0];

  const anchor = (bill.due_date || bill.email_received_at).toISOString().slice(0, 10);
  const dateFrom = shiftDate(anchor, -DATE_TOLERANCE_DAYS);
  const dateTo   = shiftDate(anchor,  DATE_TOLERANCE_DAYS);

  let matches;
  try {
    matches = await searchTransactions({ amount: Number(bill.amount_due), dateFrom, dateTo });
  } catch (e) {
    await persist({ billId, status: 'error', match_count: 0, error: `qb_search: ${e.message}` });
    return { billId, status: 'error', reason: `qb_search: ${e.message}` };
  }

  // Only Purchases get tagged with Class — BillPayment uses different fields
  const purchaseMatches = matches.filter(m => m.type === 'Purchase');

  if (purchaseMatches.length === 0) {
    await persist({ billId, status: 'not_found', match_count: 0 });
    return { billId, status: 'not_found' };
  }
  if (purchaseMatches.length > 1) {
    await persist({ billId, status: 'ambiguous', match_count: purchaseMatches.length });
    return { billId, status: 'ambiguous', count: purchaseMatches.length };
  }

  const purchase = purchaseMatches[0];

  let tagResult;
  try {
    tagResult = await tagPurchaseWithClass({ purchaseId: purchase.id, classId: qb_class_id, className: qb_class_name });
  } catch (e) {
    await persist({ billId, qb_purchase_id: purchase.id, status: 'error', match_count: 1, error: `qb_update: ${e.message}` });
    return { billId, status: 'error', reason: `qb_update: ${e.message}` };
  }

  if (!tagResult.ok) {
    await persist({ billId, qb_purchase_id: purchase.id, status: 'error', match_count: 1, error: tagResult.error });
    return { billId, status: 'error', reason: tagResult.error };
  }

  if (tagResult.status === 'skipped') {
    await persist({
      billId,
      qb_purchase_id: purchase.id,
      status:         'skipped',
      match_count:    1,
      error:          'already_tagged_in_qb',
      qb_class_id_old: tagResult.previousClass?.topClass || tagResult.previousClass?.lineClasses?.[0] || null,
    });
    return { billId, status: 'skipped', reason: 'already_tagged_in_qb' };
  }

  await persist({
    billId,
    qb_purchase_id:   purchase.id,
    qb_purchase_type: 'Purchase',
    status:           'tagged',
    match_count:      1,
    qb_class_id_new:  qb_class_id,
  });
  return { billId, status: 'tagged', purchase, classId: qb_class_id, className: qb_class_name };
}

/**
 * Process a batch of billIds, return aggregated counts.
 * Notification creation is left to the caller.
 */
export async function autoTagBatch(billIds) {
  if (!Array.isArray(billIds) || billIds.length === 0) {
    return { tagged: 0, skipped: 0, ambiguous: 0, not_found: 0, error: 0, items: [] };
  }
  const r = await pool.query(`
    SELECT id, amount_due, due_date, email_received_at, property_address, unit
    FROM utility_bills
    WHERE id = ANY($1::int[]) AND amount_due IS NOT NULL AND amount_due > 0
  `, [billIds]);

  const stats = { tagged: 0, skipped: 0, ambiguous: 0, not_found: 0, error: 0, items: [] };
  for (const row of r.rows) {
    const out = await autoTagBill(row);
    stats[out.status]++;
    stats.items.push(out);
  }
  return stats;
}

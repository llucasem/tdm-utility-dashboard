import pool from '@/lib/db';
import { mapBillRow } from '@/lib/bill-view';
import { matchBill } from '@/lib/qb-match';
import { autoTagBill } from '@/lib/auto-tag';

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, gmail_message_id, utility_type, property_address, unit, account_last4,
              amount_due, due_date, email_received_at, email_subject, status, source,
              qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at,
              qb_match_status, qb_match_count, qb_match_data, qb_matched_at,
              is_anomaly, anomaly_baseline, anomaly_ratio,
              pay.pay_date, pay.pay_amount, pay.pay_count, pay.pay_items
       FROM utility_bills
       LEFT JOIN LATERAL (
         -- El pago DERIVADO de payments/bill_payments (paso 3): el hecho vive
         -- alli; esto es solo la vista agregada por factura.
         SELECT MIN(p.paid_date)                                    AS pay_date,
                SUM(COALESCE(bp.allocated_amount, p.amount))        AS pay_amount,
                COUNT(*)::int                                       AS pay_count,
                jsonb_agg(jsonb_build_object(
                  'qbId', p.qb_purchase_id, 'date', p.paid_date,
                  'amount', COALESCE(bp.allocated_amount, p.amount),
                  'payee', p.payee, 'source', bp.source, 'locked', bp.locked
                ) ORDER BY p.paid_date)                             AS pay_items
           FROM bill_payments bp
           JOIN payments p ON p.id = bp.payment_id
          WHERE bp.bill_id = utility_bills.id
       ) pay ON true
       WHERE amount_due IS NOT NULL AND amount_due > 0
         AND NOT is_duplicate
       ORDER BY email_received_at DESC NULLS LAST, created_at DESC`
    );

    const bills = result.rows.map(mapBillRow);
    return Response.json({ ok: true, bills });
  } catch (error) {
    console.error('[bills GET]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/bills — insert a manually-entered bill.
 *
 * Used by the "Add bill" modal. Generates a synthetic gmail_message_id so the
 * UNIQUE constraint stays clean and the row is distinguishable from real emails.
 *
 * Body: { utility_type, property_address, unit, account_last4, amount_due, due_date, status }
 */
export async function POST(request) {
  try {
    const { utility_type, property_address, unit, account_last4, amount_due, due_date, status } =
      await request.json();

    if (!property_address?.trim()) {
      return Response.json({ ok: false, error: 'Property address is required' }, { status: 400 });
    }
    const amt = parseFloat(amount_due);
    if (!Number.isFinite(amt) || amt <= 0) {
      return Response.json({ ok: false, error: 'Amount must be a positive number' }, { status: 400 });
    }
    if (!due_date) {
      return Response.json({ ok: false, error: 'Due date is required' }, { status: 400 });
    }

    const syntheticId = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    const res = await pool.query(
      `INSERT INTO utility_bills
         (gmail_message_id, utility_type, property_address, unit, account_last4,
          amount_due, due_date, email_received_at, email_subject, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
       RETURNING id, gmail_message_id, utility_type, property_address, unit, account_last4,
                 amount_due, due_date, email_received_at, email_subject, status,
                 qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at,
                 qb_match_status, qb_match_count, qb_match_data, qb_matched_at,
                 is_anomaly, anomaly_baseline, anomaly_ratio`,
      [
        syntheticId,
        utility_type || 'other',
        property_address.trim(),
        unit?.trim() || null,
        account_last4?.trim() || null,
        amt,
        due_date,
        `Manual entry — ${utility_type || 'other'}`,
        status || 'pending',
      ]
    );

    const bill = res.rows[0];

    // Best-effort QuickBooks match + auto-tag. Failures are non-fatal — the
    // bill is already saved.
    try {
      await matchBill(bill);
    } catch (e) {
      console.error('[bills POST] match failed:', e.message);
    }
    try {
      await autoTagBill(bill);
    } catch (e) {
      console.error('[bills POST] auto-tag failed:', e.message);
    }

    // Re-read so the response includes the freshly-persisted match/tag fields
    const refreshed = await pool.query(
      `SELECT id, gmail_message_id, utility_type, property_address, unit, account_last4,
              amount_due, due_date, email_received_at, email_subject, status, source,
              qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at,
              qb_match_status, qb_match_count, qb_match_data, qb_matched_at,
              is_anomaly, anomaly_baseline, anomaly_ratio
       FROM utility_bills WHERE id = $1`,
      [bill.id]
    );

    return Response.json({ ok: true, bill: mapBillRow(refreshed.rows[0]) });
  } catch (error) {
    console.error('[bills POST]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

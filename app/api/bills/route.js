import pool from '@/lib/db';
import { matchBill } from '@/lib/qb-match';
import { autoTagBill } from '@/lib/auto-tag';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDue(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function mapBillRow(row) {
  // Group bills by when the EMAIL ARRIVED, not by due date.
  // A bill received in May is conceptually a May bill, even if it's due
  // June 1. due_date is only used as fallback when email_received_at is
  // missing (rare).
  const recDate    = row.email_received_at ? new Date(row.email_received_at) : null;
  const dueDate    = row.due_date ? new Date(row.due_date) : null;
  const filterDate = recDate || dueDate;

  return {
    id:         row.id,
    type:       row.utility_type || 'other',
    property:   row.property_address || null,
    unit:       row.unit || '',
    account:    row.account_last4 || '—',
    amount:     row.amount_due ? parseFloat(row.amount_due) : 0,
    due:        formatDue(row.email_received_at) || formatDue(row.due_date) || '—',
    dueRaw:     filterDate ? filterDate.toISOString().slice(0, 10) : null,
    status:     row.status || 'pending',
    gmailLink:  row.gmail_message_id
      && !String(row.gmail_message_id).startsWith('manual:')
      && !String(row.gmail_message_id).startsWith('qb:')
      // ConEd consolidated emails yield one row per bill ('<gmailId>#2'...) —
      // strip the suffix so every row links to the same source email.
      ? `https://mail.google.com/mail/u/0/#all/${String(row.gmail_message_id).split('#')[0]}`
      : null,
    dueMonth:   filterDate ? filterDate.getUTCMonth() : null,
    dueYear:    filterDate ? filterDate.getUTCFullYear() : null,
    qbTagStatus:    row.qb_tag_status || 'pending',
    qbPurchaseId:   row.qb_purchase_id || null,
    qbClassId:      row.qb_class_id || null,
    qbTaggedAt:     row.qb_tagged_at,
    qbMatchStatus:  row.qb_match_status || 'pending',
    qbMatchCount:   row.qb_match_count || 0,
    qbMatchData:    row.qb_match_data || [],
    qbMatchedAt:    row.qb_matched_at,
    source:     row.source || 'email',
    isAnomaly:        row.is_anomaly || false,
    anomalyBaseline: row.anomaly_baseline ? Number(row.anomaly_baseline) : null,
    anomalyRatio:    row.anomaly_ratio ? Number(row.anomaly_ratio) : null,
  };
}

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, gmail_message_id, utility_type, property_address, unit, account_last4,
              amount_due, due_date, email_received_at, email_subject, status, source,
              qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at,
              qb_match_status, qb_match_count, qb_match_data, qb_matched_at,
              is_anomaly, anomaly_baseline, anomaly_ratio
       FROM utility_bills
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

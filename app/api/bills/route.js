import pool from '@/lib/db';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDue(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, utility_type, property_address, unit, account_last4,
              amount_due, due_date, email_received_at, email_subject, status,
              qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at,
              qb_match_status, qb_match_count, qb_match_data, qb_matched_at,
              is_anomaly, anomaly_baseline, anomaly_ratio
       FROM utility_bills
       WHERE amount_due IS NOT NULL AND amount_due > 0
       ORDER BY due_date ASC NULLS LAST, created_at DESC`
    );

    const bills = result.rows.map(row => {
      const dueDate = row.due_date ? new Date(row.due_date) : null;
      const recDate = row.email_received_at ? new Date(row.email_received_at) : null;
      // Usamos due_date para filtrar; si no hay, usamos email_received_at
      const filterDate = dueDate || recDate;

      return {
        id:         row.id,
        type:       row.utility_type || 'other',
        property:   row.property_address || null,
        unit:       row.unit || '',
        account:    row.account_last4 || '—',
        amount:     row.amount_due ? parseFloat(row.amount_due) : 0,
        due:        formatDue(row.due_date) || formatDue(row.email_received_at) || '—',
        dueRaw:     filterDate ? filterDate.toISOString().slice(0, 10) : null, // YYYY-MM-DD for sorting
        status:     row.status || 'pending',
        gmailLink:  row.gmail_message_id
          ? `https://mail.google.com/mail/u/0/#all/${row.gmail_message_id}`
          : null,
        dueMonth:   filterDate ? filterDate.getUTCMonth() : null,  // 0-11
        dueYear:    filterDate ? filterDate.getUTCFullYear() : null,
        qbTagStatus:    row.qb_tag_status || 'pending',
        qbPurchaseId:   row.qb_purchase_id || null,
        qbClassId:      row.qb_class_id || null,
        qbTaggedAt:     row.qb_tagged_at,
        qbMatchStatus:  row.qb_match_status || 'pending',
        qbMatchCount:   row.qb_match_count || 0,
        qbMatchData:    row.qb_match_data || [],
        qbMatchedAt:    row.qb_matched_at,
        isAnomaly:        row.is_anomaly || false,
        anomalyBaseline: row.anomaly_baseline ? Number(row.anomaly_baseline) : null,
        anomalyRatio:    row.anomaly_ratio ? Number(row.anomaly_ratio) : null,
      };
    });

    return Response.json({ ok: true, bills });

  } catch (error) {
    console.error('[bills] Error:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

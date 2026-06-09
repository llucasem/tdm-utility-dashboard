import pool from '@/lib/db';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function mapPaymentRow(row) {
  // Date used for filtering/grouping. Prefer paid_date (when payment actually
  // happened) but fall back to email_received_at (when the confirmation arrived).
  const paid    = row.paid_date          ? new Date(row.paid_date)          : null;
  const arrived = row.email_received_at  ? new Date(row.email_received_at)  : null;
  const filterDate = paid || arrived;

  return {
    id:                 row.id,
    source:             row.source || 'airtable',
    airtableRecordId:   row.airtable_record_id || null,
    mailbox:            row.mailbox || null,
    property:           row.property_address || null,
    unit:               row.unit || '',
    amount:             row.amount_paid ? parseFloat(row.amount_paid) : 0,
    paidDate:           formatDate(row.paid_date)         || formatDate(row.email_received_at) || '—',
    paidDateRaw:        filterDate ? filterDate.toISOString().slice(0, 10) : null,
    landlord:           row.landlord || null,
    portal:             row.payment_portal || null,
    confirmationNumber: row.confirmation_number || null,
    subject:            row.email_subject || null,
    from:               row.email_from || null,
    status:             row.status || 'paid',
    month:              filterDate ? filterDate.getUTCMonth() : null,
    year:               filterDate ? filterDate.getUTCFullYear() : null,
  };
}

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, source, airtable_record_id, mailbox, property_address, unit,
              amount_paid, paid_date, landlord, payment_portal, confirmation_number,
              email_received_at, email_subject, email_from, status
         FROM rent_payments
        WHERE amount_paid IS NOT NULL AND amount_paid > 0
        ORDER BY COALESCE(paid_date, email_received_at::date) DESC NULLS LAST, created_at DESC`
    );
    return Response.json({ ok: true, payments: result.rows.map(mapPaymentRow) });
  } catch (e) {
    console.error('[rent-payments GET]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

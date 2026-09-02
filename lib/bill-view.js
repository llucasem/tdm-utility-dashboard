/**
 * Como se le presenta una factura al dashboard.
 *
 * Vive fuera de la ruta HTTP por lo mismo que sync-core: para poder probarlo.
 * Aqui nacen los DOS ejes de mes que pidio Jake:
 *   dueMonth/dueYear    mes de FACTURA (email_received_at) — "que se debe"
 *   paidMonth/paidYear  mes de PAGO (qb_match_data[0].date) — su cierre de caja
 */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDue(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function mapBillRow(row) {
  // Group bills by when the EMAIL ARRIVED, not by due date.
  // A bill received in May is conceptually a May bill, even if it's due
  // June 1. due_date is only used as fallback when email_received_at is
  // missing (rare).
  const recDate    = row.email_received_at ? new Date(row.email_received_at) : null;
  const dueDate    = row.due_date ? new Date(row.due_date) : null;
  const filterDate = recDate || dueDate;

  // Fecha e importe del PAGO real. Fuente primaria: las tablas
  // payments/bill_payments (el hecho + la asignacion, paso 3). Reserva: el
  // JSON del match, para filas aun no sembradas. Es el segundo eje de mes:
  // el cierre de Jake va por cuando salio el dinero.
  // pg entrega las columnas `date` como Date a MEDIANOCHE LOCAL; toISOString
  // la correria al dia anterior en cualquier huso al este de Greenwich. Se
  // formatea con los componentes locales para conservar el dia del calendario.
  const asDateStr = (v) => v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : (v || null);
  const paidStr = asDateStr(row.pay_date)
    ?? (row.qb_match_status === 'matched' && Array.isArray(row.qb_match_data)
        ? row.qb_match_data[0]?.date || null : null);
  const paidDate = paidStr ? new Date(paidStr) : null;
  const paidAmount = row.pay_amount != null ? Number(row.pay_amount)
    : (paidStr && Array.isArray(row.qb_match_data) && row.qb_match_data[0]?.amount != null
        ? Number(row.qb_match_data[0].amount) : null);

  return {
    paidDate:  paidStr,
    paidLabel: paidStr ? formatDue(paidStr) : null,
    paidMonth: paidDate ? paidDate.getUTCMonth() : null,
    paidYear:  paidDate ? paidDate.getUTCFullYear() : null,
    paidAmount,
    payments:  Array.isArray(row.pay_items) ? row.pay_items : [],
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


/**
 * Anomaly detection for incoming utility bills.
 *
 * Rule (kept simple on purpose — easy for Jake to understand):
 *   For a given (property_address, unit, utility_type), compute the average
 *   amount over the last 6 months of bills (excluding the current bill itself).
 *   If we have at least 3 historical samples and the new bill exceeds the
 *   baseline by 80% or more, flag it as anomalous.
 *
 * The flag is purely informational — it doesn't block anything. It surfaces
 * as a ⚡ badge in the dashboard plus an in-app notification.
 */

import pool from '@/lib/db';
import { createNotification } from '@/lib/notifier';

const ANOMALY_THRESHOLD_RATIO = 1.80; // bill is 80% above baseline
const MIN_SAMPLES             = 3;
const HISTORY_MONTHS          = 6;

/**
 * Check a single bill against history. If anomalous, set the flag and notify.
 * Returns { isAnomaly, baseline, ratio }.
 */
export async function detectAnomaly(billId) {
  const r = await pool.query(`
    SELECT id, utility_type, property_address, unit, amount_due, due_date, account_last4
    FROM utility_bills
    WHERE id = $1
  `, [billId]);
  if (r.rows.length === 0) return null;
  const bill = r.rows[0];

  // Skip bills with no property — we can't establish a meaningful baseline
  if (!bill.property_address || !bill.amount_due) return null;

  const baselineRes = await pool.query(`
    SELECT AVG(amount_due)::float AS avg_amount, COUNT(*)::int AS samples
    FROM utility_bills
    WHERE utility_type    = $1
      AND property_address = $2
      AND COALESCE(unit, '') = COALESCE($3, '')
      AND id != $4
      AND amount_due IS NOT NULL AND amount_due > 0
      AND email_received_at >= NOW() - INTERVAL '${HISTORY_MONTHS} months'
  `, [bill.utility_type, bill.property_address, bill.unit, billId]);

  const { avg_amount, samples } = baselineRes.rows[0];
  if (samples < MIN_SAMPLES || !avg_amount) {
    return { isAnomaly: false, reason: 'not_enough_history', samples };
  }

  const amount = Number(bill.amount_due);
  const ratio  = amount / avg_amount;
  const isAnomaly = ratio >= ANOMALY_THRESHOLD_RATIO;

  await pool.query(`
    UPDATE utility_bills
    SET is_anomaly = $2, anomaly_baseline = $3, anomaly_ratio = $4
    WHERE id = $1
  `, [billId, isAnomaly, avg_amount, ratio]);

  if (isAnomaly) {
    const pct = Math.round((ratio - 1) * 100);
    await createNotification({
      type:    'warning',
      title:   `Anomaly detected · ${bill.utility_type}`,
      message: `$${amount.toFixed(2)} at ${bill.property_address}${bill.unit ? ' · ' + bill.unit : ''} is ${pct}% above the ${HISTORY_MONTHS}-month average ($${avg_amount.toFixed(2)}, ${samples} prior bills). Possible leak, rate change, or billing error.`,
      billId,
      metadata: { baseline: avg_amount, ratio, samples, threshold: ANOMALY_THRESHOLD_RATIO },
    });
  }

  return { isAnomaly, baseline: avg_amount, ratio, samples };
}

/** Run anomaly detection on a batch of bill ids. */
export async function detectAnomaliesBatch(billIds) {
  if (!Array.isArray(billIds) || billIds.length === 0) return { checked: 0, anomalies: 0 };
  let anomalies = 0;
  for (const id of billIds) {
    const out = await detectAnomaly(id);
    if (out?.isAnomaly) anomalies++;
  }
  return { checked: billIds.length, anomalies };
}

/**
 * Persistent QuickBooks match.
 *
 * Looks up QuickBooks transactions that fit a utility bill (exact amount + ±15
 * day window) and stores the result in `utility_bills.qb_match_*`. The match
 * is read-only against QB — this never writes to the customer's books.
 *
 * Designed to be called automatically:
 *  - From /api/sync after each new bill is inserted
 *  - From /api/bills/[id] PATCH after a manual property assignment
 *  - From /api/quickbooks/match-pending (daily cron) for retries
 *
 * The auto-tag flow reads the persisted match instead of calling QB again,
 * so we make at most one search call per bill per attempt.
 */

import pool from '@/lib/db';
import { searchTransactions } from '@/lib/quickbooks';

const DATE_TOLERANCE_DAYS = 15;
const MAX_STORED_MATCHES  = 20;  // defensive cap on JSONB size

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function persist({ billId, status, count = null, data = null, error = null }) {
  await pool.query(`
    UPDATE utility_bills
    SET qb_match_status = $2,
        qb_match_count  = $3,
        qb_match_data   = $4,
        qb_matched_at   = NOW(),
        qb_match_error  = $5
    WHERE id = $1
  `, [billId, status, count, data ? JSON.stringify(data) : null, error]);
}

/**
 * Run match for a single bill and persist the outcome.
 * Returns { status, count, matches }.
 */
export async function matchBill(bill) {
  const billId = bill.id;

  if (!bill.amount_due || Number(bill.amount_due) <= 0) {
    await persist({ billId, status: 'skipped', error: 'no_amount' });
    return { status: 'skipped', count: 0, matches: [] };
  }

  const anchor = (bill.due_date || bill.email_received_at);
  if (!anchor) {
    await persist({ billId, status: 'skipped', error: 'no_date' });
    return { status: 'skipped', count: 0, matches: [] };
  }

  const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0, 10) : String(anchor).slice(0, 10);
  const dateFrom  = shiftDate(anchorIso, -DATE_TOLERANCE_DAYS);
  const dateTo    = shiftDate(anchorIso,  DATE_TOLERANCE_DAYS);

  let matches;
  try {
    matches = await searchTransactions({ amount: Number(bill.amount_due), dateFrom, dateTo });
  } catch (e) {
    await persist({ billId, status: 'error', count: 0, error: e.message });
    return { status: 'error', count: 0, matches: [], error: e.message };
  }

  // Cap the stored array — almost never relevant in practice, but keeps JSONB small
  const stored = matches.slice(0, MAX_STORED_MATCHES);

  let status;
  if (matches.length === 0)      status = 'not_found';
  else if (matches.length === 1) status = 'matched';
  else                            status = 'ambiguous';

  await persist({ billId, status, count: matches.length, data: stored });
  return { status, count: matches.length, matches: stored };
}

/**
 * Process a list of bill ids sequentially (to respect QB rate limits).
 * Loads each bill from DB so callers only need to pass ids.
 */
export async function matchBatch(billIds) {
  if (!Array.isArray(billIds) || billIds.length === 0) {
    return { matched: 0, ambiguous: 0, not_found: 0, error: 0, skipped: 0, items: [] };
  }

  const r = await pool.query(`
    SELECT id, amount_due, due_date, email_received_at
    FROM utility_bills
    WHERE id = ANY($1::int[])
  `, [billIds]);

  const stats = { matched: 0, ambiguous: 0, not_found: 0, error: 0, skipped: 0, items: [] };
  for (const row of r.rows) {
    const out = await matchBill(row);
    stats[out.status] = (stats[out.status] || 0) + 1;
    stats.items.push({ id: row.id, ...out });
  }
  return stats;
}

/**
 * Read the already-persisted match from the DB (without calling QB).
 * Returns the same shape as matchBill but without persisting.
 */
export async function getPersistedMatch(billId) {
  const r = await pool.query(`
    SELECT qb_match_status, qb_match_count, qb_match_data
    FROM utility_bills
    WHERE id = $1
  `, [billId]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    status:  row.qb_match_status || 'pending',
    count:   row.qb_match_count  || 0,
    matches: row.qb_match_data   || [],
  };
}

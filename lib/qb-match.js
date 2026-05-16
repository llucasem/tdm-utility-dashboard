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

/**
 * Infer the utility vendor from a bill's email_from header. Returns an array
 * of likely vendor name substrings to match against the QB Purchase payee, or
 * null if we cannot identify the vendor from the email.
 *
 * Falsos positivos como "Yaritza" para una factura de Spectrum se evitan
 * exigiendo que el payee del Purchase contenga al menos uno de estos strings.
 */
export function inferBillVendor(emailFrom) {
  if (!emailFrom) return null;
  const f = emailFrom.toLowerCase();
  if (f.includes('spectrum'))                       return ['spectrum'];
  if (f.includes('coned'))                          return ['con edis', 'conedison', 'con edison'];
  if (f.includes('socalgas'))                       return ['socalgas'];
  if (f.includes('sce.com') || f.includes('@sce.')) return ['southern california edison', 'sce'];
  if (f.includes('ladwp') || f.includes('@dwp.'))   return ['ladwp', 'dwp', 'city of la dwp'];
  if (f.includes('amazon'))                         return ['amazon'];
  if (f.includes('att.') || f.includes('at&t'))     return ['at&t', 'att'];
  if (f.includes('optimum'))                        return ['optimum'];
  if (f.includes('verizon'))                        return ['verizon'];
  if (f.includes('national grid') || f.includes('nationalgrid')) return ['national grid'];
  if (f.includes('nyseg'))                          return ['nyseg'];
  if (f.includes('eversource'))                     return ['eversource'];
  if (f.includes('pge.com') || f.includes('@pge.')) return ['pg&e', 'pge'];
  return null;
}

/**
 * Returns true if the Purchase's payee name plausibly belongs to one of the
 * expected vendor names. Case-insensitive substring match — handles
 * variations like "ConEdison" vs "Con Edison" vs "Consolidated Edison".
 */
export function vendorMatches(expectedVendors, payee) {
  if (!expectedVendors || expectedVendors.length === 0) return false;
  if (!payee) return false;
  const p = payee.toLowerCase();
  return expectedVendors.some(v => p.includes(v.toLowerCase()));
}

// ── Historical-aware disambiguation ───────────────────────────────────────
//
// When the matcher finds >1 unclaimed candidate Purchases for a bill, look
// at Jake-verified history for the same property+utility_type to pick the
// most plausible candidate. If no candidate stands out clearly, we keep
// the bill as 'ambiguous' (no regression vs the old behavior).

const HISTORY_SAMPLE_LIMIT = 6;
const HISTORY_MIN_SAMPLE   = 2;
const HISTORY_MIN_SCORE    = 2;   // require at least a payee match
const HISTORY_GAP          = 1;   // winner must beat runner-up by this many points

/**
 * Pull verified historical patterns for (property+unit+utility_type).
 * Returns null if there isn't enough history to be useful.
 */
export async function getHistoricalPattern(property_address, unit, utility_type) {
  if (!property_address || !utility_type) return null;
  const r = await pool.query(`
    SELECT qb_match_data
    FROM utility_bills
    WHERE property_address = $1
      AND COALESCE(unit, '') = COALESCE($2, '')
      AND utility_type = $3
      AND qb_tag_status = 'tagged'
      AND qb_match_data IS NOT NULL
    ORDER BY due_date DESC NULLS LAST
    LIMIT ${HISTORY_SAMPLE_LIMIT}
  `, [property_address, unit, utility_type]);

  const payees = new Set();
  const amounts = [];
  const days = new Set();
  for (const row of r.rows) {
    const purchase = (row.qb_match_data || [])[0];
    if (!purchase) continue;
    if (purchase.payee) payees.add(purchase.payee.toLowerCase());
    if (typeof purchase.amount === 'number') amounts.push(purchase.amount);
    if (purchase.date) {
      const day = parseInt(purchase.date.slice(8, 10), 10);
      if (!isNaN(day)) days.add(day);
    }
  }
  if (amounts.length < HISTORY_MIN_SAMPLE) return null;
  const mean = amounts.reduce((s, x) => s + x, 0) / amounts.length;
  return {
    payees,
    amountMin:   Math.min(...amounts),
    amountMax:   Math.max(...amounts),
    amountMean:  mean,
    typicalDays: days,
    sampleSize:  amounts.length,
  };
}

/**
 * Score a candidate Purchase against the historical pattern. Higher = better fit.
 */
export function scoreCandidate(candidate, pattern) {
  if (!pattern) return 0;
  let score = 0;

  // Payee match (strongest signal): +2
  if (candidate.payee && pattern.payees.size > 0) {
    const cp = candidate.payee.toLowerCase();
    for (const histPayee of pattern.payees) {
      if (cp.includes(histPayee) || histPayee.includes(cp)) {
        score += 2;
        break;
      }
    }
  }

  // Amount within [mean × 0.5, mean × 1.5]: +1
  if (typeof candidate.amount === 'number' && pattern.amountMean > 0) {
    const ratio = candidate.amount / pattern.amountMean;
    if (ratio >= 0.5 && ratio <= 1.5) score += 1;
  }

  // Day-of-month within ±5 days of any typical day: +1
  if (candidate.date && pattern.typicalDays.size > 0) {
    const candDay = parseInt(candidate.date.slice(8, 10), 10);
    if (!isNaN(candDay)) {
      for (const histDay of pattern.typicalDays) {
        if (Math.abs(candDay - histDay) <= 5) {
          score += 1;
          break;
        }
      }
    }
  }

  return score;
}

/**
 * Given multiple unclaimed candidates, pick the one that best matches the
 * historical pattern of this bill's property+utility_type. Returns the winner
 * (with disambiguation metadata) or null if no clear winner.
 */
async function disambiguateByHistory(bill, candidates) {
  const pattern = await getHistoricalPattern(bill.property_address, bill.unit, bill.utility_type);
  if (!pattern) return null;

  const scored = candidates.map(c => ({ c, score: scoreCandidate(c, pattern) }));
  scored.sort((a, b) => b.score - a.score);

  const winner   = scored[0];
  const runnerUp = scored[1];
  if (!winner || winner.score < HISTORY_MIN_SCORE) return null;
  if (runnerUp && winner.score - runnerUp.score < HISTORY_GAP) return null;

  return {
    candidate: winner.c,
    disambiguation: {
      reason:           'history',
      score:            winner.score,
      runnerUpScore:    runnerUp?.score ?? null,
      basedOnSample:    pattern.sampleSize,
    },
  };
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

  // ANCHOR = email_received_at (when the bill was issued).
  // due_date is the deadline to pay, NOT the bill's identity. Per Lluis:
  // "la fecha de una factura es la del email, no la due_date".
  const anchor = (bill.email_received_at || bill.due_date);
  if (!anchor) {
    await persist({ billId, status: 'skipped', error: 'no_date' });
    return { status: 'skipped', count: 0, matches: [] };
  }

  const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0, 10) : String(anchor).slice(0, 10);
  // Asymmetric window: a Purchase for THIS bill can be up to 10 days BEFORE
  // the email (autopago temprano) or up to 30 days AFTER (pago manual tardío).
  // If it's >10 days before the email, it's from the previous billing cycle.
  const dateFrom  = shiftDate(anchorIso, -10);
  const dateTo    = shiftDate(anchorIso,  30);

  let matches;
  try {
    matches = await searchTransactions({ amount: Number(bill.amount_due), dateFrom, dateTo });
  } catch (e) {
    await persist({ billId, status: 'error', count: 0, error: e.message });
    return { status: 'error', count: 0, matches: [], error: e.message };
  }

  // Claim filter (Jake) — drop any Purchase that already has a Class in QB.
  // A Class means the owner has already attributed that transaction to a
  // specific property; we'd double-attribute it otherwise.
  const unclaimedByQB = matches.filter(m => !m.hasClass);
  const claimedByQB   = matches.length - unclaimedByQB.length;

  // Bill-purchase exclusivity — drop any Purchase that is already linked to
  // a DIFFERENT bill in our DB. This prevents the classic cross-month bug:
  // an April Spectrum autopay accidentally matching the May Spectrum bill
  // (same amount, dates fall in ±15d window of each other).
  const candidateIds = unclaimedByQB.map(m => String(m.id));
  let trulyUnclaimed = unclaimedByQB;
  let claimedByOurBills = 0;
  if (candidateIds.length > 0) {
    const r = await pool.query(`
      SELECT DISTINCT (m->>'id') AS pid
      FROM utility_bills,
           LATERAL jsonb_array_elements(qb_match_data) AS m
      WHERE id != $1
        AND qb_match_status = 'matched'
        AND qb_match_data IS NOT NULL
        AND jsonb_typeof(qb_match_data) = 'array'
        AND (m->>'id') = ANY($2::text[])
    `, [billId, candidateIds]);
    const takenIds = new Set(r.rows.map(x => x.pid));
    trulyUnclaimed = unclaimedByQB.filter(m => !takenIds.has(String(m.id)));
    claimedByOurBills = unclaimedByQB.length - trulyUnclaimed.length;
  }

  const unclaimed = trulyUnclaimed;
  const claimedCount = claimedByQB + claimedByOurBills;

  let status, stored, disambiguation = null;
  if (unclaimed.length === 0) {
    status = 'not_found';
    stored = [];
  } else if (unclaimed.length === 1) {
    status = 'matched';
    stored = unclaimed;
  } else {
    // Multiple candidates — try to pick one using historical pattern.
    const pick = await disambiguateByHistory(bill, unclaimed);
    if (pick) {
      status = 'matched';
      stored = [{ ...pick.candidate, disambiguation: pick.disambiguation }];
      disambiguation = pick.disambiguation;
    } else {
      status = 'ambiguous';
      stored = unclaimed.slice(0, MAX_STORED_MATCHES);
    }
  }

  await persist({ billId, status, count: stored.length, data: stored });
  return { status, count: stored.length, matches: stored, claimedCount, disambiguation };
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
    SELECT id, amount_due, due_date, email_received_at, email_from,
           property_address, unit, utility_type
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

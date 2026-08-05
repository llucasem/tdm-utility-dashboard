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
import { inferVendorFromEmail, vendorMatchesPayee } from '@/lib/known-vendors';
import { addressesMatch, normalizeUnit } from '@/lib/address-normalize';

const MAX_STORED_MATCHES = 20;  // defensive cap on JSONB size

// Payees that must NEVER match a utility bill, regardless of amount/date.
// "yaritza" is a person, not a utility vendor — historical Purchases under
// that name are personal transactions that share amounts with our bills.
const BLOCKED_PAYEES = ['yaritza'];

function isBlockedPayee(payee) {
  if (!payee) return false;
  const p = payee.toLowerCase();
  return BLOCKED_PAYEES.some(b => p.includes(b));
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Vendor inference + payee matching moved to lib/known-vendors.js (single
// source of truth). Re-export aliases here for backward compatibility — the
// public API used to expose them from this module.
export { inferVendorFromEmail as inferBillVendor, vendorMatchesPayee as vendorMatches } from '@/lib/known-vendors';

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

// property_qb_class cache — matchBatch runs matchBill for dozens of bills in
// a row and the old per-bill full-table lookups were a real chunk of the 60s
// Vercel budget. The table changes rarely; 60s of staleness is harmless.
let _pqcCache = { at: 0, rows: [] };
async function loadClassMappings() {
  if (Date.now() - _pqcCache.at > 60_000) {
    const r = await pool.query(
      `SELECT property_address, unit, qb_class_id, qb_class_name FROM property_qb_class`
    );
    _pqcCache = { at: Date.now(), rows: r.rows };
  }
  return _pqcCache.rows;
}

/**
 * Resolve the QB Class this bill SHOULD have, via property_qb_class.
 * Exact property+unit match first, then normalized (St/Street, Apt 3/3...).
 * Returns { qb_class_id, qb_class_name } or null.
 */
async function getExpectedClass(bill) {
  if (!bill.property_address || !bill.property_address.trim()) return null;
  const all = await loadClassMappings();
  const prop = bill.property_address.trim();
  const unitRaw = (bill.unit || '').trim();
  const exact = all.find(r => r.property_address === prop && (r.unit || '') === unitRaw);
  if (exact) return exact;
  const u = normalizeUnit(bill.unit);
  return all.find(r => addressesMatch(r.property_address, bill.property_address) && normalizeUnit(r.unit) === u) || null;
}

/** Reverse lookup: qb_class_id → { property_address, unit } for a set of ids. */
async function getClassProperties(classIds) {
  if (!classIds || classIds.length === 0) return new Map();
  const all = await loadClassMappings();
  const want = new Set(classIds.map(String));
  return new Map(all.filter(x => want.has(String(x.qb_class_id))).map(x => [String(x.qb_class_id), x]));
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
  // Search window: Spectrum bills advance-billed (Purchase TxnDate up to
  // ~20-25 days BEFORE the email), so the QB search reaches 45 days back.
  // But a Purchase that far back is only trusted when it carries Jake's
  // Class (verified against the property below) — UNCLASSED candidates keep
  // the strict "max 3 days before the email" cutoff, because an unverified
  // earlier Purchase is presumed to belong to the previous billing cycle.
  const dateFrom    = shiftDate(anchorIso, -45);
  const dateTo      = shiftDate(anchorIso,  30);
  const strictFloor = shiftDate(anchorIso, -3);

  let rawMatches;
  try {
    rawMatches = await searchTransactions({ amount: Number(bill.amount_due), dateFrom, dateTo });
  } catch (e) {
    await persist({ billId, status: 'error', count: 0, error: e.message });
    return { status: 'error', count: 0, matches: [], error: e.message };
  }

  // Payee blocklist — drop transactions under names that are never utility
  // vendors (e.g. personal payments to "Yaritza" sharing the same amount).
  const matches = rawMatches.filter(m => !isBlockedPayee(m.payee))
    .filter(m => m.hasClass || !m.date || String(m.date) >= strictFloor);

  // Bill-purchase exclusivity — drop any Purchase that is already linked to
  // a DIFFERENT bill in our DB. This prevents the classic cross-month bug:
  // an April Spectrum autopay accidentally matching the May Spectrum bill
  // (same amount, dates fall in ±15d window of each other).
  // Claims held by rows flagged is_duplicate do NOT count: those are hidden
  // reminder copies (ConEd "Ready"→"Due"), and honoring their claim kept the
  // visible bill at not_found forever.
  const candidateIds = matches.map(m => String(m.id));
  let trulyUnclaimed = matches;
  let claimedByOurBills = 0;
  if (candidateIds.length > 0) {
    const r = await pool.query(`
      SELECT DISTINCT (m->>'id') AS pid
      FROM utility_bills,
           LATERAL jsonb_array_elements(qb_match_data) AS m
      WHERE id != $1
        AND qb_match_status = 'matched'
        AND NOT is_duplicate
        AND qb_match_data IS NOT NULL
        AND jsonb_typeof(qb_match_data) = 'array'
        AND (m->>'id') = ANY($2::text[])
    `, [billId, candidateIds]);
    const takenIds = new Set(r.rows.map(x => x.pid));
    trulyUnclaimed = matches.filter(m => !takenIds.has(String(m.id)));
    claimedByOurBills = matches.length - trulyUnclaimed.length;
  }

  // Vendor whitelist filter — if the email tells us which vendor sent the bill
  // (e.g. Spectrum, ConEd), restrict candidates to Purchases whose payee
  // actually matches. Protects against false positives like a Spectrum bill of
  // $76.25 matching an Amazon Purchase of $76.25 in the same date window.
  //
  // If expected vendor matches NOTHING in the candidates, fall through to
  // not_found rather than silently picking the wrong Purchase.
  let vendorFiltered = trulyUnclaimed;
  let vendorMismatchCount = 0;
  const expectedVendors = inferVendorFromEmail(bill.email_from);
  if (expectedVendors && trulyUnclaimed.length > 0) {
    const matching = trulyUnclaimed.filter(c => vendorMatchesPayee(expectedVendors, c.payee));
    if (matching.length > 0) {
      vendorFiltered = matching;
      vendorMismatchCount = trulyUnclaimed.length - matching.length;
    } else {
      // All candidates fail the vendor check — treat as not_found.
      vendorFiltered = [];
      vendorMismatchCount = trulyUnclaimed.length;
    }
  }

  // Class handling — a Class set by Jake is CONFIRMATION, not a blocker.
  // (The old "claim filter" dropped classed Purchases entirely; since Jake
  // classes every Purchase when he reconciles the bank feed, any bill whose
  // Purchase he touched first could never match — the July 2026 "a lot are
  // not matching" bug.)
  //
  //  - Candidate's Class == the Class mapped to this bill's property → the
  //    strongest possible match (Jake himself attributed the payment).
  //  - Any other classed candidate → drop. A Class we can't positively link
  //    to this bill means the payment belongs to some other property; letting
  //    it through as a "neutral" candidate mis-matched same-amount Spectrum
  //    bills across properties. Better ✗ than a wrong ✓.
  //  - Exception: an UNASSIGNED bill may adopt a classed candidate whose
  //    Class reverse-maps to a known property (fills the property in).
  const expected = await getExpectedClass(bill);
  const classedIds = [...new Set(vendorFiltered.filter(m => m.hasClass && m.classId).map(m => String(m.classId)))];
  const classProps = await getClassProperties(classedIds);

  let jakeConfirmed = null;
  let wrongClassCount = 0;
  let unclaimed = vendorFiltered;
  if (expected) {
    const sameClass = vendorFiltered.filter(m => m.hasClass && String(m.classId) === String(expected.qb_class_id));
    if (sameClass.length > 0) {
      const anchorTs = new Date(anchorIso).getTime();
      jakeConfirmed = sameClass.slice().sort((a, b) =>
        Math.abs(new Date(a.date).getTime() - anchorTs) - Math.abs(new Date(b.date).getTime() - anchorTs)
      )[0];
    }
    unclaimed = vendorFiltered.filter(m => !m.hasClass || String(m.classId) === String(expected.qb_class_id));
    wrongClassCount = vendorFiltered.length - unclaimed.length;
  } else {
    const billHasProperty = !!(bill.property_address && bill.property_address.trim());
    unclaimed = vendorFiltered.filter(m => {
      if (!m.hasClass) return true;
      if (billHasProperty) return false;    // Class we can't verify against this property → drop
      // Unassigned bill: adopt only a Class we can reverse-map to a property
      return !!(m.classId && classProps.get(String(m.classId)));
    });
    wrongClassCount = vendorFiltered.length - unclaimed.length;
  }

  const claimedCount = claimedByOurBills + vendorMismatchCount + wrongClassCount;

  let status, stored, disambiguation = null;
  if (jakeConfirmed) {
    disambiguation = { reason: 'jake_class', classId: jakeConfirmed.classId, className: jakeConfirmed.className };
    status = 'matched';
    stored = [{ ...jakeConfirmed, disambiguation }];
  } else if (unclaimed.length === 0) {
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

  // A matched Purchase that already carries Jake's Class is not just matched —
  // it's already attributed in QB. Mark the bill tagged so the auto-tagger
  // doesn't try to re-tag it, and adopt the Class's property if the bill
  // arrived unassigned (electricity/gas emails without address).
  if (status === 'matched' && stored[0]?.hasClass) {
    const rm = stored[0].classId ? (classProps.get(String(stored[0].classId)) || null) : null;
    await pool.query(`
      UPDATE utility_bills
      SET qb_tag_status  = 'tagged',
          qb_purchase_id = $2,
          qb_class_id    = COALESCE($3, qb_class_id),
          qb_tagged_at   = NOW(),
          property_address = COALESCE(NULLIF(TRIM(property_address), ''), $4),
          unit             = COALESCE(NULLIF(TRIM(unit), ''), $5)
      WHERE id = $1
    `, [billId, String(stored[0].id), stored[0].classId ? String(stored[0].classId) : null,
        rm?.property_address || null, rm?.unit || null]);
  }

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

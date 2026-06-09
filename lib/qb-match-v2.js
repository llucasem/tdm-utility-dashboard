/**
 * Matching v2 — identidad por (provider, account_last4, billing_cycle).
 *
 * Diagnóstico v1: matchear por (amount, ventana_de_fechas) es defectuoso
 * porque ninguno de los dos es invariante. Spectrum factura por adelantado
 * (TxnDate del Purchase ≈ −20 días vs email_received_at). 5 cuentas
 * distintas pagan el mismo $76.25 — el amount no identifica una factura.
 *
 * Algoritmo v2:
 *   1. La bill conoce su provider_account (FK desde populate script).
 *   2. Cargo el typical_day_of_month de esa cuenta.
 *   3. Calculo el ciclo de facturación de la bill (mes del email).
 *   4. Busco en QB los Purchases del provider en un margen amplio
 *      (−45/+15 días desde email_received_at) — ventana suficiente para
 *      cubrir facturación adelantada.
 *   5. Para cada candidato, calculo su billing_cycle (TxnDate.month).
 *   6. Filtro: solo el Purchase cuyo cycle coincide con la bill.
 *   7. Si exactamente 1 → matched. Si >1 → fallback a v1 disambig.
 *   8. Amount se usa como CHECK posterior, no como identidad — un mismatch
 *      genera warning pero no rompe el match.
 *
 * Mantiene los mismos guardrails que v1: blocked payees, claim filter
 * (Class ya existente), bill-purchase exclusivity.
 */

import pool from '@/lib/db';
import { searchTransactions, queryQB } from '@/lib/quickbooks';
import { matchBill as matchBillV1 } from '@/lib/qb-match';

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

function cycleKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Provider canonical name → QB vendor substring(s) to match in EntityRef.name
const PROVIDER_QB_VENDOR = {
  spectrum:  ['spectrum'],
  conedison: ['con edis', 'conedison', 'con edison', 'consolidated edison'],
  sce:       ['southern california edison', 'sce'],
  ladwp:     ['ladwp', 'dwp', 'city of la dwp'],
  socalgas:  ['socalgas', 'so cal gas'],
  att:       ['at&t', 'att'],
  tmobile:   ['t-mobile', 'tmobile'],
  optimum:   ['optimum'],
  verizon:   ['verizon'],
  pge:       ['pg&e', 'pge'],
};

/**
 * v2 matcher. Returns { status, count, matches, method, warning? }.
 * Falls back to v1 if the bill has no account_id (legacy bill).
 */
export async function matchBillV2(bill) {
  // No account_id → no v2 possible, fall back to v1.
  if (!bill.account_id) {
    const r = await matchBillV1(bill);
    return { ...r, method: 'v1-fallback-no-account' };
  }

  // Load provider_account context
  const a = await pool.query(
    `SELECT provider, account_last4, utility_type, property_address, unit,
            typical_day_of_month, last_amount
       FROM provider_accounts WHERE id = $1`,
    [bill.account_id]
  );
  if (a.rows.length === 0) {
    const r = await matchBillV1(bill);
    return { ...r, method: 'v1-fallback-account-missing' };
  }
  const account = a.rows[0];
  const vendorTerms = PROVIDER_QB_VENDOR[account.provider];
  if (!vendorTerms) {
    const r = await matchBillV1(bill);
    return { ...r, method: 'v1-fallback-unknown-provider' };
  }

  const anchor = bill.email_received_at || bill.due_date;
  if (!anchor) return { status: 'skipped', count: 0, matches: [], method: 'v2-skipped-no-date', error: 'no_date' };

  const billCycle = cycleKey(anchor);
  // Wide window: covers advance billing (Spectrum) and late acceptance by Jake.
  const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0, 10) : String(anchor).slice(0, 10);
  const dateFrom = shiftDate(anchorIso, -45);
  const dateTo   = shiftDate(anchorIso, 30);

  // Query QB Purchases by date range — vendor filter applied client-side
  // because QBO QL doesn't support OR on EntityRef.name reliably.
  const where = `WHERE TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;
  let purchases = [];
  try {
    let pos = 1;
    while (true) {
      const r = await queryQB(`SELECT * FROM Purchase ${where} STARTPOSITION ${pos} MAXRESULTS 100`);
      const items = r?.QueryResponse?.Purchase || [];
      purchases.push(...items);
      if (items.length < 100) break;
      pos += items.length;
      if (pos > 1000) break;
    }
  } catch (e) {
    return { status: 'error', count: 0, matches: [], method: 'v2-search-failed', error: e.message };
  }

  // Filter to vendor matches, not blocked, no existing Class (claim filter)
  const vendorMatches = purchases.filter(p => {
    const name = (p.EntityRef?.name || '').toLowerCase();
    if (!vendorTerms.some(v => name.includes(v))) return false;
    if (isBlockedPayee(p.EntityRef?.name)) return false;
    // Claim filter: skip Purchases that already have a Class
    const topClass = p?.ClassRef;
    const lineClasses = (p?.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef || l?.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
    if (topClass?.value || lineClasses.length > 0) return false;
    return true;
  });

  // Bill-purchase exclusivity (same as v1): drop Purchases already linked
  // to a different bill in our DB
  const ids = vendorMatches.map(p => String(p.Id));
  let unclaimed = vendorMatches;
  if (ids.length > 0) {
    const taken = await pool.query(`
      SELECT DISTINCT (m->>'id') AS pid
      FROM utility_bills,
           LATERAL jsonb_array_elements(qb_match_data) AS m
      WHERE id != $1 AND qb_match_status = 'matched' AND qb_match_data IS NOT NULL
        AND jsonb_typeof(qb_match_data) = 'array'
        AND (m->>'id') = ANY($2::text[])
    `, [bill.id, ids]);
    const takenSet = new Set(taken.rows.map(r => r.pid));
    unclaimed = vendorMatches.filter(p => !takenSet.has(String(p.Id)));
  }

  // Group candidates by billing_cycle
  const byCycle = new Map();
  for (const p of unclaimed) {
    const cycle = cycleKey(p.TxnDate);
    if (!byCycle.has(cycle)) byCycle.set(cycle, []);
    byCycle.get(cycle).push(p);
  }

  // Pick candidates whose cycle == bill cycle, OR the cycle one month before
  // (Spectrum advance billing case: TxnDate is in month N-1, email arrives in month N)
  const prevMonthDate = new Date(anchor);
  prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1);
  const prevCycle = cycleKey(prevMonthDate);

  let pickedCycle = null;
  let candidates = [];
  if (byCycle.has(billCycle) && byCycle.get(billCycle).length > 0) {
    candidates = byCycle.get(billCycle);
    pickedCycle = billCycle;
  } else if (byCycle.has(prevCycle) && byCycle.get(prevCycle).length > 0) {
    candidates = byCycle.get(prevCycle);
    pickedCycle = prevCycle;
  } else {
    candidates = unclaimed;
  }

  // Convert to v1's match shape so downstream auto-tag works unchanged
  const normalized = candidates.map(p => {
    const topClass = p?.ClassRef;
    const lineClasses = (p?.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef || l?.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
    return {
      type: 'Purchase', id: p.Id, date: p.TxnDate, amount: Number(p.TotalAmt),
      payee: p.EntityRef?.name || null, account: p.AccountRef?.name || null,
      docNumber: p.DocNumber || null, note: p.PrivateNote || null,
      classId: topClass?.value || lineClasses[0]?.value || null,
      className: topClass?.name || lineClasses[0]?.name || null,
      hasClass: !!(topClass?.value || lineClasses.length > 0),
    };
  });

  let status, stored, warning = null;
  if (normalized.length === 0) {
    status = 'not_found';
    stored = [];
  } else if (normalized.length === 1) {
    status = 'matched';
    stored = normalized;
    // Sanity check: warn if amount differs significantly
    const billAmt = Number(bill.amount_due);
    const purchaseAmt = normalized[0].amount;
    if (Math.abs(billAmt - purchaseAmt) > 0.01) {
      warning = `amount_mismatch: bill=$${billAmt} vs purchase=$${purchaseAmt}`;
    }
  } else {
    // Multiple cycle-matching candidates — fall back to amount as tiebreaker
    const exactAmt = normalized.filter(m => Math.abs(m.amount - Number(bill.amount_due)) < 0.01);
    if (exactAmt.length === 1) {
      status = 'matched';
      stored = exactAmt;
    } else {
      status = 'ambiguous';
      stored = normalized.slice(0, 20);
    }
  }

  return { status, count: stored.length, matches: stored, method: `v2-cycle-${pickedCycle || 'window'}`, warning };
}

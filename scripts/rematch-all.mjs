/**
 * One-shot re-cotejado: aplica la lógica actual (claim filter + historical
 * disambiguation) a todas las bills con status matched/ambiguous/not_found
 * de los últimos 90 días.
 *
 * Read-only against QB (only queries). Writes new status to utility_bills.
 * Idempotent — re-ejecutable.
 *
 * Run with:  node scripts/rematch-all.mjs
 * Opcional:  --dry-run  para ver qué cambiaría sin escribir
 *            --month YYYY-MM  para acotar a un mes
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const DRY_RUN = process.argv.includes('--dry-run');
const monthArg = (() => {
  const i = process.argv.indexOf('--month');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── QB token ──────────────────────────────────────────────────────────
async function getTok() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row;
  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const t = await res.json();
  await pool.query(`UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, new Date(Date.now() + t.expires_in * 1000), row.realm_id]);
  return { ...row, access_token: t.access_token };
}
const tok = await getTok();
async function qb(sql) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB ${r.status}`);
  return r.json();
}

function extractClass(p) {
  const top = p?.ClassRef || null;
  const lines = (p?.Line || []).map(l => l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
  return { classId: top?.value || lines[0]?.value || null, className: top?.name || lines[0]?.name || null, hasClass: !!(top?.value || lines.length > 0) };
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Historical pattern (mirrors lib/qb-match.js) ──────────────────────
async function getHistoricalPattern(property_address, unit, utility_type) {
  if (!property_address || !utility_type) return null;
  const r = await pool.query(`
    SELECT qb_match_data FROM utility_bills
    WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')
      AND utility_type = $3 AND qb_tag_status = 'tagged'
      AND qb_match_data IS NOT NULL
    ORDER BY due_date DESC NULLS LAST LIMIT 6
  `, [property_address, unit, utility_type]);
  const payees = new Set(), amounts = [], days = new Set();
  for (const row of r.rows) {
    const p = (row.qb_match_data || [])[0];
    if (!p) continue;
    if (p.payee) payees.add(p.payee.toLowerCase());
    if (typeof p.amount === 'number') amounts.push(p.amount);
    if (p.date) {
      const d = parseInt(p.date.slice(8, 10), 10);
      if (!isNaN(d)) days.add(d);
    }
  }
  if (amounts.length < 2) return null;
  const mean = amounts.reduce((s, x) => s + x, 0) / amounts.length;
  return { payees, amountMean: mean, typicalDays: days, sampleSize: amounts.length };
}

function scoreCandidate(c, pattern) {
  if (!pattern) return 0;
  let score = 0;
  if (c.payee && pattern.payees.size > 0) {
    const cp = c.payee.toLowerCase();
    for (const hp of pattern.payees) {
      if (cp.includes(hp) || hp.includes(cp)) { score += 2; break; }
    }
  }
  if (typeof c.amount === 'number' && pattern.amountMean > 0) {
    const ratio = c.amount / pattern.amountMean;
    if (ratio >= 0.5 && ratio <= 1.5) score += 1;
  }
  if (c.date && pattern.typicalDays.size > 0) {
    const d = parseInt(c.date.slice(8, 10), 10);
    if (!isNaN(d)) {
      for (const hd of pattern.typicalDays) {
        if (Math.abs(d - hd) <= 5) { score += 1; break; }
      }
    }
  }
  return score;
}

async function disambiguate(bill, candidates) {
  const pattern = await getHistoricalPattern(bill.property_address, bill.unit, bill.utility_type);
  if (!pattern) return null;
  const scored = candidates.map(c => ({ c, score: scoreCandidate(c, pattern) })).sort((a, b) => b.score - a.score);
  const w = scored[0], r = scored[1];
  if (!w || w.score < 2) return null;
  if (r && w.score - r.score < 1) return null;
  return { candidate: w.c, score: w.score, runnerUp: r?.score ?? null, basedOnSample: pattern.sampleSize };
}

// ── Re-evaluate one bill ──────────────────────────────────────────────
async function rematch(bill) {
  const amt = Number(bill.amount_due).toFixed(2);
  const anchor = bill.due_date || bill.email_received_at;
  if (!anchor) return { newStatus: 'skipped' };
  const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0, 10) : String(anchor).slice(0, 10);
  const dateFrom = shiftDate(anchorIso, -15);
  const dateTo   = shiftDate(anchorIso,  15);

  const where = `WHERE TotalAmt = '${amt}' AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;
  const [pRes, bpRes] = await Promise.all([
    qb(`SELECT * FROM Purchase ${where}`).catch(() => null),
    qb(`SELECT Id, TxnDate, TotalAmt, VendorRef, PrivateNote, DocNumber FROM BillPayment ${where}`).catch(() => null),
  ]);

  const candidates = [];
  for (const p of pRes?.QueryResponse?.Purchase || []) {
    const cls = extractClass(p);
    candidates.push({
      type: 'Purchase', id: p.Id, date: p.TxnDate, amount: Number(p.TotalAmt),
      payee: p.EntityRef?.name || null, account: p.AccountRef?.name || null,
      docNumber: p.DocNumber || null, note: p.PrivateNote || null,
      classId: cls.classId, className: cls.className, hasClass: cls.hasClass,
    });
  }
  for (const bp of bpRes?.QueryResponse?.BillPayment || []) {
    candidates.push({
      type: 'BillPayment', id: bp.Id, date: bp.TxnDate, amount: Number(bp.TotalAmt),
      payee: bp.VendorRef?.name || null, account: null,
      docNumber: bp.DocNumber || null, note: bp.PrivateNote || null,
      classId: null, className: null, hasClass: false,
    });
  }

  const unclaimed = candidates.filter(c => !c.hasClass);

  let newStatus, stored, disambig = null;
  if (unclaimed.length === 0) { newStatus = 'not_found'; stored = []; }
  else if (unclaimed.length === 1) { newStatus = 'matched'; stored = unclaimed; }
  else {
    const pick = await disambiguate(bill, unclaimed);
    if (pick) {
      newStatus = 'matched';
      stored = [{ ...pick.candidate, disambiguation: { reason: 'history', score: pick.score, runnerUpScore: pick.runnerUp, basedOnSample: pick.basedOnSample } }];
      disambig = pick;
    } else {
      newStatus = 'ambiguous';
      stored = unclaimed.slice(0, 20);
    }
  }
  return { newStatus, count: stored.length, matches: stored, disambig };
}

// ── Main ─────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  REMATCH-ALL  ${DRY_RUN ? '(DRY RUN)' : '(WRITING)'}${monthArg ? ` · month=${monthArg}` : ''}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

let where = `qb_match_status IN ('matched', 'ambiguous', 'not_found')
             AND amount_due > 0
             AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '90 days'
             AND (qb_tag_status IS NULL OR qb_tag_status != 'tagged')`;  // don't touch tagged
const params = [];
if (monthArg) {
  where += ` AND TO_CHAR(COALESCE(due_date, email_received_at), 'YYYY-MM') = $1`;
  params.push(monthArg);
}

const bills = await pool.query(`
  SELECT id, amount_due, due_date, email_received_at, email_from,
         property_address, unit, utility_type, qb_match_status
  FROM utility_bills WHERE ${where} ORDER BY id
`, params);
console.log(`Bills to re-evaluate: ${bills.rowCount}\n`);

const transitions = {};
let changed = 0, disambiguated = 0;
for (let i = 0; i < bills.rows.length; i++) {
  const b = bills.rows[i];
  process.stdout.write(`\r  ⏳ ${i + 1}/${bills.rowCount}  changed=${changed}  disambig=${disambiguated}`);
  let result;
  try {
    result = await rematch(b);
  } catch (e) { continue; }
  const key = `${b.qb_match_status} → ${result.newStatus}`;
  transitions[key] = (transitions[key] || 0) + 1;
  if (b.qb_match_status !== result.newStatus) changed++;
  if (result.disambig) disambiguated++;

  if (!DRY_RUN) {
    await pool.query(`
      UPDATE utility_bills
      SET qb_match_status = $2, qb_match_count = $3, qb_match_data = $4, qb_matched_at = NOW()
      WHERE id = $1
    `, [b.id, result.newStatus, result.count, JSON.stringify(result.matches)]);
  }
  await new Promise(r => setTimeout(r, 80));
}

console.log(`\n\n  Transitions:`);
for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(30)}  ${v}`);
}
console.log(`\n  ${changed} bills changed status (${disambiguated} disambiguated by history) of ${bills.rowCount} total\n`);
if (DRY_RUN) console.log(`  💡 DRY RUN — no se ha escrito. Repite sin --dry-run para aplicar.\n`);

await pool.end();

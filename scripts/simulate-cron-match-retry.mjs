/**
 * Simulate step 1 of /api/cron/retry-and-learn locally.
 *
 * Replicates: pull up to 20 bills with qb_match_status IN ('pending',
 * 'not_found', 'error') in the last 90 days, run the matcher, persist.
 * Same SQL, same logic, same window (-3/+30), same blocklist.
 *
 * This is what the daily cron will do at 02:00 UTC. We run it manually
 * to confirm it works against current data without surprises.
 *
 * Run with:  node scripts/simulate-cron-match-retry.mjs
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

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const BLOCKED_PAYEES = ['yaritza'];
function isBlocked(p) { return p && BLOCKED_PAYEES.some(b => p.toLowerCase().includes(b)); }

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
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`,
    { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`QB ${r.status}`);
  return r.json();
}

function extractClass(p) {
  const top = p?.ClassRef || null;
  const lines = (p?.Line || []).map(l => l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
  return { classId: top?.value || lines[0]?.value || null, className: top?.name || lines[0]?.name || null, hasClass: !!(top?.value || lines.length > 0) };
}

function shift(iso, days) {
  const d = new Date(iso); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function matchOne(bill) {
  const amt = Number(bill.amount_due).toFixed(2);
  const anchor = bill.email_received_at || bill.due_date;
  if (!anchor) return { status: 'skipped', error: 'no_date' };
  const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0, 10) : String(anchor).slice(0, 10);
  const dateFrom = shift(anchorIso, -3);
  const dateTo   = shift(anchorIso, 30);

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
      classId: cls.classId, className: cls.className, hasClass: cls.hasClass,
    });
  }
  for (const bp of bpRes?.QueryResponse?.BillPayment || []) {
    candidates.push({
      type: 'BillPayment', id: bp.Id, date: bp.TxnDate, amount: Number(bp.TotalAmt),
      payee: bp.VendorRef?.name || null, classId: null, className: null, hasClass: false,
    });
  }

  // Apply blocklist + claim filter + exclusivity (same as production)
  const filtered = candidates.filter(c => !isBlocked(c.payee));
  const unclaimedByQB = filtered.filter(c => !c.hasClass);

  let trulyUnclaimed = unclaimedByQB;
  if (unclaimedByQB.length > 0) {
    const ids = unclaimedByQB.map(c => String(c.id));
    const taken = await pool.query(`
      SELECT DISTINCT (m->>'id') AS pid
      FROM utility_bills, LATERAL jsonb_array_elements(qb_match_data) AS m
      WHERE id != $1 AND qb_match_status = 'matched' AND qb_match_data IS NOT NULL
        AND jsonb_typeof(qb_match_data) = 'array' AND (m->>'id') = ANY($2::text[])
    `, [bill.id, ids]);
    const takenSet = new Set(taken.rows.map(r => r.pid));
    trulyUnclaimed = unclaimedByQB.filter(c => !takenSet.has(String(c.id)));
  }

  if (trulyUnclaimed.length === 0) return { status: 'not_found', count: 0, matches: [] };
  if (trulyUnclaimed.length === 1) return { status: 'matched', count: 1, matches: trulyUnclaimed };
  return { status: 'ambiguous', count: trulyUnclaimed.length, matches: trulyUnclaimed.slice(0, 20) };
}

// ── Main ─────────────────────────────────────────────────────────────
console.log('Simulando paso 1 del cron: match retry de hasta 20 bills\n');

const bills = await pool.query(`
  SELECT id, amount_due, due_date, email_received_at, email_from,
         property_address, unit, utility_type, qb_match_status
  FROM utility_bills
  WHERE qb_match_status IN ('pending', 'not_found', 'error')
    AND amount_due IS NOT NULL AND amount_due > 0
    AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '90 days'
  ORDER BY due_date DESC NULLS LAST
  LIMIT 20
`);
console.log(`Bills a reintentar: ${bills.rowCount}\n`);

const transitions = {};
let changed = 0;
for (let i = 0; i < bills.rows.length; i++) {
  const b = bills.rows[i];
  process.stdout.write(`\r  ${i + 1}/${bills.rowCount}  changed=${changed}    `);

  let result;
  try {
    result = await matchOne(b);
  } catch (e) {
    transitions['error'] = (transitions['error'] || 0) + 1;
    continue;
  }

  const key = `${b.qb_match_status} → ${result.status}`;
  transitions[key] = (transitions[key] || 0) + 1;
  if (b.qb_match_status !== result.status) {
    changed++;
    // Persist (would be done by the cron)
    await pool.query(`
      UPDATE utility_bills
      SET qb_match_status = $2, qb_match_count = $3, qb_match_data = $4, qb_matched_at = NOW()
      WHERE id = $1
    `, [b.id, result.status, result.count, JSON.stringify(result.matches || [])]);
  }
  await new Promise(r => setTimeout(r, 80));
}

console.log(`\n\nResultado de la simulación:`);
console.log(`  Bills procesadas:  ${bills.rowCount}`);
console.log(`  Cambios de estado: ${changed}`);
console.log(`\n  Transiciones:`);
for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(30)} ${v}`);
}

await pool.end();

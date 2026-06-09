/**
 * A/B test: compara matcher v1 (amount + ventana) vs v2 (provider + cycle).
 * Corre ambos sobre bills facturables de mayo 2026 y reporta diferencias.
 *
 * READ-ONLY. No persiste cambios.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

// Set env so lib/db.js works
for (const [k, v] of Object.entries(env)) process.env[k] = v;

const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

// Token refresh helper (since we're running outside Next.js)
async function refreshIfNeeded() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  const expiresIn = row.expires_at ? Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000) : -1;
  if (expiresIn > 300) return row;
  const basic = Buffer.from(`${env['QB_CLIENT_ID']}:${env['QB_CLIENT_SECRET']}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const tk = await res.json();
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, refresh_expires_at = $4, updated_at = NOW() WHERE realm_id = $5`,
    [tk.access_token, tk.refresh_token,
     new Date(Date.now() + tk.expires_in * 1000),
     new Date(Date.now() + tk.x_refresh_token_expires_in * 1000),
     row.realm_id]
  );
  return { realm_id: row.realm_id, access_token: tk.access_token };
}
const { realm_id, access_token } = await refreshIfNeeded();
const BASE = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;

async function qb(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB ${r.status}: ${await r.text()}`);
  return r.json();
}

function shiftDate(iso, days) { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function cycleKey(date) { const d = new Date(date); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

const PROVIDER_QB_VENDOR = {
  spectrum: ['spectrum'], conedison: ['con edis', 'conedison', 'con edison'],
  sce: ['southern california edison', 'sce'], ladwp: ['ladwp', 'dwp'],
  socalgas: ['socalgas'], att: ['at&t', 'att'], tmobile: ['t-mobile', 'tmobile'],
};

// v1: amount + ±3/+30 window + vendor inference from email_from
async function matchV1(bill) {
  const amt = Number(bill.amount_due).toFixed(2);
  const dateFrom = shiftDate(bill.email_received_at.toISOString().slice(0, 10), -3);
  const dateTo   = shiftDate(bill.email_received_at.toISOString().slice(0, 10), 30);
  const r = await qb(`SELECT * FROM Purchase WHERE TotalAmt = '${amt}' AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`).catch(() => null);
  const all = r?.QueryResponse?.Purchase || [];
  // Apply vendor filter
  const ef = (bill.email_from || '').toLowerCase();
  let vendorTerms = null;
  if (ef.includes('spectrum')) vendorTerms = ['spectrum'];
  else if (ef.includes('coned')) vendorTerms = ['con edis', 'conedison'];
  else if (ef.includes('sce')) vendorTerms = ['southern california edison', 'sce'];
  else if (ef.includes('socalgas')) vendorTerms = ['socalgas'];
  else if (ef.includes('ladwp')) vendorTerms = ['ladwp', 'dwp'];
  let filtered = all;
  if (vendorTerms) filtered = all.filter(p => vendorTerms.some(v => (p.EntityRef?.name || '').toLowerCase().includes(v)));
  // Claim filter
  filtered = filtered.filter(p => !p.ClassRef?.value && !(p.Line || []).some(l => l?.AccountBasedExpenseLineDetail?.ClassRef?.value));
  return { status: filtered.length === 0 ? 'not_found' : (filtered.length === 1 ? 'matched' : 'ambiguous'), count: filtered.length };
}

// v2: provider + account + cycle
async function matchV2(bill) {
  if (!bill.account_id) return { status: 'skipped', count: 0, reason: 'no_account_id' };
  const a = await pool.query(`SELECT provider FROM provider_accounts WHERE id = $1`, [bill.account_id]);
  const provider = a.rows[0]?.provider;
  const vendorTerms = PROVIDER_QB_VENDOR[provider];
  if (!vendorTerms) return { status: 'skipped', count: 0, reason: 'unknown_provider' };

  const dateFrom = shiftDate(bill.email_received_at.toISOString().slice(0, 10), -45);
  const dateTo   = shiftDate(bill.email_received_at.toISOString().slice(0, 10), 30);
  const r = await qb(`SELECT * FROM Purchase WHERE TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`).catch(() => null);
  let all = r?.QueryResponse?.Purchase || [];
  // Vendor filter
  all = all.filter(p => vendorTerms.some(v => (p.EntityRef?.name || '').toLowerCase().includes(v)));
  // Claim filter
  all = all.filter(p => !p.ClassRef?.value && !(p.Line || []).some(l => l?.AccountBasedExpenseLineDetail?.ClassRef?.value));
  // Cycle filter (bill cycle or prev month)
  const billCycle = cycleKey(bill.email_received_at);
  const prevMonth = new Date(bill.email_received_at); prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
  const prevCycle = cycleKey(prevMonth);
  const byCycle = new Map();
  for (const p of all) {
    const c = cycleKey(p.TxnDate);
    if (!byCycle.has(c)) byCycle.set(c, []);
    byCycle.get(c).push(p);
  }
  let candidates = byCycle.get(billCycle) || byCycle.get(prevCycle) || all;
  // Amount tiebreaker
  if (candidates.length > 1) {
    const exact = candidates.filter(p => Math.abs(Number(p.TotalAmt) - Number(bill.amount_due)) < 0.01);
    if (exact.length === 1) candidates = exact;
  }
  return { status: candidates.length === 0 ? 'not_found' : (candidates.length === 1 ? 'matched' : 'ambiguous'), count: candidates.length };
}

// Run A/B on May 2026 facturable bills, non-duplicate, non-tagged
const bills = await pool.query(`
  SELECT id, utility_type, amount_due, email_received_at, property_address, unit,
         account_last4, account_id, email_from, qb_match_status, qb_tag_status
  FROM utility_bills
  WHERE amount_due > 0
    AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
    AND NOT is_duplicate
  ORDER BY id
`);
console.log(`Bills mayo: ${bills.rowCount}\n`);

const counters = {
  v1: { matched: 0, ambiguous: 0, not_found: 0, skipped: 0, error: 0 },
  v2: { matched: 0, ambiguous: 0, not_found: 0, skipped: 0, error: 0 },
};
const diffs = [];

for (let i = 0; i < bills.rowCount; i++) {
  const b = bills.rows[i];
  const r1 = await matchV1(b).catch(e => ({ status: 'error', error: e.message }));
  const r2 = await matchV2(b).catch(e => ({ status: 'error', error: e.message }));
  counters.v1[r1.status] = (counters.v1[r1.status] || 0) + 1;
  counters.v2[r2.status] = (counters.v2[r2.status] || 0) + 1;
  if (r1.status !== r2.status) {
    diffs.push({ id: b.id, type: b.utility_type, amt: b.amount_due, recv: b.email_received_at.toISOString().slice(0, 10), v1: r1.status, v2: r2.status });
  }
  if ((i + 1) % 10 === 0) console.log(`  processed ${i + 1}/${bills.rowCount}...`);
}

console.log('\n═══ Resumen A/B ═══');
console.log('              v1     v2     delta');
for (const k of ['matched', 'ambiguous', 'not_found', 'skipped', 'error']) {
  const a = counters.v1[k] || 0, b = counters.v2[k] || 0;
  const sign = b - a > 0 ? '+' : '';
  console.log(`  ${k.padEnd(10)} ${String(a).padStart(4)}  ${String(b).padStart(4)}  ${sign}${b - a}`);
}
console.log(`\nDiferencias por bill: ${diffs.length}\n`);
console.log('Detalle (primeros 30):');
for (const d of diffs.slice(0, 30)) {
  console.log(`  Bill #${d.id}  ${d.type.padEnd(12)} $${String(d.amt).padStart(7)} recv=${d.recv}   v1=${d.v1.padEnd(10)} v2=${d.v2}`);
}

await pool.end();

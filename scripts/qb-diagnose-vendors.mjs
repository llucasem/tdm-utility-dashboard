/**
 * Diagnose: do utility vendors exist in QB and what transactions do they have?
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = join(__dirname, '..', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const API_BASE = (env['QB_ENV'] || 'production').toLowerCase() === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';

const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

const t = await pool.query(`SELECT realm_id, access_token FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
const { realm_id, access_token } = t.rows[0];

async function qb(sql) {
  const url = `${API_BASE}/v3/company/${realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' }});
  return r.json();
}

console.log('\n─── Looking for utility-vendor names in QB Vendor table ───');
const vendorNames = ['SoCalGas','Southern California Gas','SCE','Southern California Edison','ConEd','Con Edison','LADWP','Spectrum','Charter','Time Warner','Cox','AT&T','Verizon'];
for (const name of vendorNames) {
  const r = await qb(`SELECT Id, DisplayName FROM Vendor WHERE DisplayName LIKE '%${name}%'`);
  const v = r?.QueryResponse?.Vendor || [];
  if (v.length) console.log(`  ${name.padEnd(30)} → ${v.map(x => `${x.DisplayName} (id=${x.Id})`).join(', ')}`);
}

console.log('\n─── Recent Purchases on the "Utilities" account (any utility-style account) ───');
// Find accounts with "utilit" or "internet" or "gas" in the name first
const accs = await qb(`SELECT Id, Name, AccountSubType FROM Account WHERE Active = true MAXRESULTS 1000`);
const utilAccs = (accs?.QueryResponse?.Account || []).filter(a => /utilit|internet|gas|electric|cable/i.test(a.Name));
console.log(`  Found ${utilAccs.length} utility-related accounts:`);
utilAccs.slice(0, 15).forEach(a => console.log(`    - ${a.Name}  (${a.AccountSubType})  id=${a.Id}`));

console.log('\n─── Recent Purchases in April 2026 with utility-style payee names ───');
const purchases = await qb(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef FROM Purchase WHERE TxnDate >= '2026-04-01' AND TxnDate <= '2026-05-10' MAXRESULTS 1000`);
const all = purchases?.QueryResponse?.Purchase || [];
console.log(`  Total Purchases in window: ${all.length}`);
const utilLike = all.filter(p => /socalgas|edison|sce|ladwp|spectrum|coned|charter|cox|verizon|gas|electric|internet|utilit/i.test(`${p.EntityRef?.name || ''} ${p.AccountRef?.name || ''}`));
console.log(`  Of those, utility-like: ${utilLike.length}`);
utilLike.slice(0, 30).forEach(p => console.log(`    ${p.TxnDate}  $${p.TotalAmt}  payee=${p.EntityRef?.name || '—'}  acct=${p.AccountRef?.name || '—'}`));

console.log('\n─── Distinct payees on recent utility-related Purchases ───');
const payeeMap = new Map();
for (const p of utilLike) {
  const key = p.EntityRef?.name || '(unknown)';
  if (!payeeMap.has(key)) payeeMap.set(key, []);
  payeeMap.get(key).push(p);
}
for (const [payee, list] of payeeMap.entries()) {
  console.log(`  ${payee}: ${list.length} txns`);
  list.slice(0, 6).forEach(p => console.log(`     - ${p.TxnDate} $${p.TotalAmt}  acct=${p.AccountRef?.name}`));
}

await pool.end();

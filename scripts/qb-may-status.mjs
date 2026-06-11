/**
 * QB status check — May 2026 only.
 *
 * (1) Re-query for Spectrum $104.99 Purchase — to see if Jake just accepted it
 * (2) List all Purchases in May 2026 — proxy for "what's been moved out of For Review"
 *
 * Read-only.
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
const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

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
  if (!res.ok) { console.error('Refresh failed:', res.status, await res.text()); process.exit(1); }
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

async function qbQuery(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) return { error: `${r.status}: ${(await r.text()).slice(0, 300)}` };
  return r.json();
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Estado QB para mayo 2026');
console.log('═══════════════════════════════════════════════════════════\n');

// (1) Spectrum $104.99 in May
console.log('1️⃣ ¿Existe ya el Purchase de Spectrum $104.99 en mayo?\n');
const may = await qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef FROM Purchase WHERE TotalAmt = '104.99' AND TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31'`);
if (may.error) {
  console.log(`  ❌ Error QB: ${may.error}`);
} else {
  const ps = may?.QueryResponse?.Purchase || [];
  if (ps.length === 0) {
    console.log('  ❌ No. Jake todavía no ha aceptado el pago de mayo (sigue "for review")');
  } else {
    console.log(`  ✅ ¡SÍ! Encontrados ${ps.length}:`);
    for (const p of ps) {
      console.log(`     - id=${p.Id}  ${p.TxnDate}  $${p.TotalAmt}  vendor: ${p.EntityRef?.name || '—'}`);
    }
  }
}

console.log('');

// (2) All Purchases in May 2026
console.log('2️⃣ Todos los Purchases con TxnDate en mayo 2026 (ya aceptados)\n');
const all = await qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef FROM Purchase WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31' ORDERBY TxnDate DESC MAXRESULTS 200`);
if (all.error) {
  console.log(`  ❌ Error QB: ${all.error}`);
} else {
  const ps = all?.QueryResponse?.Purchase || [];
  console.log(`  Total Purchases mayo 2026: ${ps.length}\n`);

  // Group by vendor
  const byVendor = {};
  for (const p of ps) {
    const v = p.EntityRef?.name || '(sin vendor)';
    if (!byVendor[v]) byVendor[v] = [];
    byVendor[v].push(p);
  }
  const sorted = Object.entries(byVendor).sort((a, b) => b[1].length - a[1].length);
  console.log('  Por vendor:');
  for (const [v, arr] of sorted) {
    console.log(`    ${String(arr.length).padStart(3)}  ${v}`);
  }
}

console.log('');

// (3) Also try BankTransaction entity (might not be exposed)
console.log('3️⃣ Probando si QB API expone BankTransaction (for review)\n');
const bt = await qbQuery(`SELECT COUNT(*) FROM BankTransaction`);
if (bt.error) {
  console.log(`  ❌ BankTransaction no expuesto: ${bt.error.slice(0, 120)}`);
} else {
  console.log(`  ✅ BankTransaction sí está expuesto:`, JSON.stringify(bt).slice(0, 200));
}

await pool.end();

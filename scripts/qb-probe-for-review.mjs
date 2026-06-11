/**
 * Probe what QB API exposes for "For Review" / uncategorized bank feed transactions.
 *
 * Tests several entity names and the TransactionList report, focused on May 2026.
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

const t = await pool.query(`SELECT realm_id, access_token FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
const { realm_id, access_token } = t.rows[0];
const BASE = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;

async function qbQuery(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) return { error: `${r.status}: ${(await r.text()).slice(0, 250)}` };
  return r.json();
}

async function qbGet(path) {
  const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) return { error: `${r.status}: ${(await r.text()).slice(0, 250)}` };
  return r.json();
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Probe QB API para transacciones "For Review" — mayo 2026');
console.log('═══════════════════════════════════════════════════════════\n');

// (A) Try various entity names that COULD represent for-review transactions
const entities = [
  'BankTransaction',
  'OnlineBankingTransaction',
  'DownloadedBankTransaction',
  'StatementCharge',
  'Transaction',
  'ReviewTransaction',
];
console.log('A) Entidades QB que podrían exponer "for review":\n');
for (const e of entities) {
  const r = await qbQuery(`SELECT COUNT(*) FROM ${e}`);
  if (r.error) console.log(`   ${e.padEnd(28)} ❌ ${r.error.slice(0, 100)}`);
  else console.log(`   ${e.padEnd(28)} ✅ existe — ${JSON.stringify(r).slice(0, 120)}`);
}

// (B) List Bank-type accounts
console.log('\nB) Accounts tipo Bank (para saber qué bancos están sincronizados):\n');
const accts = await qbQuery(`SELECT Id, Name, AccountType, AccountSubType, CurrentBalance FROM Account WHERE AccountType = 'Bank'`);
if (accts.error) console.log(`   Error: ${accts.error}`);
else {
  const list = accts?.QueryResponse?.Account || [];
  for (const a of list) {
    console.log(`   - id=${a.Id}  ${a.Name}  (${a.AccountSubType})  balance=$${a.CurrentBalance}`);
  }
}

// (C) TransactionList report (this report CAN include all transaction types)
console.log('\nC) Reporte TransactionList — todas las transacciones de mayo 2026:\n');
const rep = await qbGet(`/reports/TransactionList?start_date=2026-05-01&end_date=2026-05-31&columns=tx_date,txn_type,name,amount,account_name,memo`);
if (rep.error) {
  console.log(`   Error: ${rep.error}`);
} else {
  const rows = rep?.Rows?.Row || [];
  // Count transaction types
  const byType = {};
  for (const row of rows) {
    if (row.ColData) {
      const type = row.ColData[1]?.value || '(unknown)';
      byType[type] = (byType[type] || 0) + 1;
    }
  }
  console.log(`   Total filas: ${rows.length}`);
  console.log('   Por tipo:');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(v).padStart(3)}  ${k}`);
  }
}

// (D) Try the CDC (change data capture) endpoint
console.log('\nD) CDC endpoint — entidades cambiadas recientemente:\n');
const cdc = await qbGet(`/cdc?entities=Purchase,BillPayment,Deposit,Transfer&changedSince=2026-05-01T00:00:00-00:00`);
if (cdc.error) {
  console.log(`   Error: ${cdc.error}`);
} else {
  const responses = cdc?.CDCResponse?.[0]?.QueryResponse || [];
  for (const qr of responses) {
    const keys = Object.keys(qr).filter(k => !['startPosition','maxResults'].includes(k));
    for (const k of keys) {
      if (Array.isArray(qr[k])) console.log(`   ${k}: ${qr[k].length} cambiadas desde mayo`);
    }
  }
}

// (E) Check Purchases with "Uncategorized" account — proxy for things Jake hasn't categorized
console.log('\nE) Purchases en mayo con account "Uncategorized" (señal de "no procesado"):\n');
const unc = await qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef FROM Purchase WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31'`);
if (unc.error) {
  console.log(`   Error: ${unc.error}`);
} else {
  const ps = unc?.QueryResponse?.Purchase || [];
  const uncat = ps.filter(p => /uncategor/i.test(p.AccountRef?.name || ''));
  console.log(`   Total Purchases mayo: ${ps.length}`);
  console.log(`   Con account "Uncategorized*": ${uncat.length}`);
  for (const p of uncat) {
    console.log(`     - id=${p.Id}  ${p.TxnDate}  $${p.TotalAmt}  vendor: ${p.EntityRef?.name || '—'}  account: ${p.AccountRef?.name}`);
  }
}

await pool.end();
console.log('\n═══════════════════════════════════════════════════════════');
console.log('Lee A) — si alguna entidad sale ✅ tenemos forma directa.');
console.log('Si no, las "for review" están en una capa que QB API no expone.');
console.log('═══════════════════════════════════════════════════════════');

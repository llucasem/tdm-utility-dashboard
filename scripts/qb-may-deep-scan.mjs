/**
 * Deep scan of May 2026 in QuickBooks — finds all transactions across every
 * entity type, focusing on potential utility payments that may be "pending"
 * (no Class yet, in Bill form awaiting BillPayment, etc.)
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
  if (!r.ok) return { __err: `${r.status}: ${(await r.text()).slice(0, 200)}` };
  return r.json();
}

const UTILITY = /Spectrum|Con\s*Edis|SoCalGas|SCE|Southern California Edison|LADWP|City of LA DWP|DWP|Amazon|AT&T|Verizon|Optimum|National Grid|NYSEG|Eversource|PG&E/i;

function extractClass(p) {
  const top = p?.ClassRef || null;
  const lines = (p?.Line || []).map(l => l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
  return {
    classId:   top?.value || lines[0]?.value || null,
    className: top?.name  || lines[0]?.name  || null,
    hasClass:  !!(top?.value || lines.length > 0),
  };
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  DEEP SCAN: All May 2026 utility-related QB transactions');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ENTITY TYPES to probe (those that can represent payment/obligation)
const ENTITIES = ['Purchase', 'Bill', 'BillPayment', 'Check', 'CreditCardPayment', 'VendorCredit', 'JournalEntry', 'Transfer', 'Deposit'];

const summary = {};
const utilityFinds = [];

for (const e of ENTITIES) {
  const q = await qb(`SELECT * FROM ${e} WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31' MAXRESULTS 500`);
  if (q.__err) {
    console.log(`  ${e.padEnd(18)}  ✗ ${q.__err}`);
    summary[e] = -1;
    continue;
  }
  const items = q?.QueryResponse?.[e] || [];
  summary[e] = items.length;
  const utilities = items.filter(t => {
    const name = (t.EntityRef?.name || t.VendorRef?.name || t.PayeeRef?.name || '') + ' ' + (t.PrivateNote || '');
    return UTILITY.test(name);
  });
  for (const t of utilities) {
    const cls = (e === 'Purchase') ? extractClass(t) : { hasClass: false, classId: null, className: null };
    utilityFinds.push({
      entity: e,
      id: t.Id,
      date: t.TxnDate,
      amount: Number(t.TotalAmt || 0),
      payee: t.EntityRef?.name || t.VendorRef?.name || t.PayeeRef?.name || '-',
      account: t.AccountRef?.name || t.APAccountRef?.name || '-',
      hasClass: cls.hasClass,
      className: cls.className,
      paymentType: t.PaymentType || null,
      docNumber: t.DocNumber || null,
      balance: t.Balance !== undefined ? Number(t.Balance) : null,
      privateNote: t.PrivateNote || null,
    });
  }
}

console.log('Entity counts (May 2026):');
for (const [e, n] of Object.entries(summary)) {
  console.log(`  ${e.padEnd(20)} ${n < 0 ? 'ERROR' : n}`);
}

console.log(`\n━━━ UTILITY transactions found across ALL entity types (${utilityFinds.length}) ━━━\n`);
utilityFinds.sort((a, b) => a.date.localeCompare(b.date));
for (const t of utilityFinds) {
  const tag = t.hasClass ? `✓ Class: ${t.className}` : '⚠ NO CLASS';
  const bal = t.balance !== null ? ` Balance=$${t.balance.toFixed(2)}` : '';
  console.log(`  [${t.entity.padEnd(13)}] ${t.date}  $${t.amount.toFixed(2).padStart(8)}  ${t.payee.padEnd(25)}  ${tag}${bal}`);
}

// Stats by entity for utilities
console.log(`\n━━━ Utility transactions by entity + class status ━━━\n`);
const byEntity = {};
for (const t of utilityFinds) {
  const k = `${t.entity}${t.hasClass ? ' (Class)' : ' (no Class)'}`;
  byEntity[k] = (byEntity[k] || 0) + 1;
}
for (const [k, v] of Object.entries(byEntity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${v}`);
}

// Now compare: our DB May bills vs these utility transactions
const billsR = await pool.query(`
  SELECT id, utility_type, property_address, unit, amount_due
  FROM utility_bills
  WHERE email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
    AND amount_due > 0
  ORDER BY amount_due
`);
console.log(`\n━━━ Our May bills (${billsR.rowCount}) vs QB utility txns (${utilityFinds.length}) ━━━\n`);

const billAmts = new Set(billsR.rows.map(b => Number(b.amount_due).toFixed(2)));
const qbAmts = new Set(utilityFinds.map(t => t.amount.toFixed(2)));
const common = [...billAmts].filter(a => qbAmts.has(a));
console.log(`  Amounts both sides:  ${common.length}`);
console.log(`  Only our bills:      ${[...billAmts].filter(a => !qbAmts.has(a)).length}`);
console.log(`  Only QB:             ${[...qbAmts].filter(a => !billAmts.has(a)).length}`);

console.log('\n');
await pool.end();

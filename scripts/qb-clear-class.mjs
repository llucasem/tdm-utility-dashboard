/**
 * Strip ClassRef from a specific QuickBooks Purchase.
 *
 * Use case: a Purchase was mis-classed (e.g. a personal Zelle to "Yaritza"
 * got Class "472 9th #3" assigned during testing). This removes that Class
 * so the customer's books don't carry our test artifacts.
 *
 * Run with:  node scripts/qb-clear-class.mjs <PURCHASE_ID> [--apply]
 *            Without --apply this is dry-run (shows what would change).
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

const PURCHASE_ID = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!PURCHASE_ID) { console.error('Usage: node scripts/qb-clear-class.mjs <PURCHASE_ID> [--apply]'); process.exit(1); }

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
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, new Date(Date.now() + t.expires_in * 1000), row.realm_id]
  );
  return { ...row, access_token: t.access_token };
}

const tok = await getTok();

async function qbGet(path) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}${path}&minorversion=70`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function qbPost(path, body) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}${path}?minorversion=70`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`QB POST ${r.status}: ${await r.text()}`);
  return r.json();
}

// 1. Fetch current Purchase
console.log(`Fetching Purchase ${PURCHASE_ID}…\n`);
const purchaseRes = await qbGet(`/purchase/${PURCHASE_ID}?`);
const p = purchaseRes.Purchase;
if (!p) { console.error('Purchase not found'); process.exit(1); }

console.log('CURRENT STATE:');
console.log(`  Id:           ${p.Id}`);
console.log(`  SyncToken:    ${p.SyncToken}`);
console.log(`  Date:         ${p.TxnDate}`);
console.log(`  Amount:       $${p.TotalAmt}`);
console.log(`  Payee:        ${p.EntityRef?.name || '(none)'}`);
console.log(`  PrivateNote:  ${(p.PrivateNote || '').slice(0, 80)}`);
console.log(`  Top ClassRef: ${p.ClassRef ? `${p.ClassRef.name} (${p.ClassRef.value})` : '(none)'}`);

const lineClasses = (p.Line || []).map((l, i) => ({
  index: i,
  amount: l.Amount,
  detailType: l.DetailType,
  cls: l.AccountBasedExpenseLineDetail?.ClassRef
    || l.ItemBasedExpenseLineDetail?.ClassRef
    || null,
}));
for (const lc of lineClasses) {
  console.log(`  Line[${lc.index}] $${lc.amount}: ${lc.cls ? `Class "${lc.cls.name}" (${lc.cls.value})` : '(no class)'}`);
}

const hasAnyClass = !!p.ClassRef || lineClasses.some(lc => lc.cls);
if (!hasAnyClass) {
  console.log('\nNothing to remove — Purchase has no Class.');
  await pool.end();
  process.exit(0);
}

// 2. Build sparse update that omits ClassRef
const updatedLines = (p.Line || []).map(l => {
  const newLine = { ...l };
  if (newLine.AccountBasedExpenseLineDetail?.ClassRef) {
    const detail = { ...newLine.AccountBasedExpenseLineDetail };
    delete detail.ClassRef;
    newLine.AccountBasedExpenseLineDetail = detail;
  }
  if (newLine.ItemBasedExpenseLineDetail?.ClassRef) {
    const detail = { ...newLine.ItemBasedExpenseLineDetail };
    delete detail.ClassRef;
    newLine.ItemBasedExpenseLineDetail = detail;
  }
  return newLine;
});

// Sparse update — keep required fields verbatim, only change Line to drop ClassRef.
// QBO requires PaymentType, AccountRef, TotalAmt to be present even on sparse Line edits.
const payload = {
  Id:          p.Id,
  SyncToken:   p.SyncToken,
  sparse:      true,
  PaymentType: p.PaymentType,
  AccountRef:  p.AccountRef,
  TotalAmt:    p.TotalAmt,
  TxnDate:     p.TxnDate,
  Line:        updatedLines,
};
if (p.EntityRef) payload.EntityRef = p.EntityRef;
if (p.CurrencyRef) payload.CurrencyRef = p.CurrencyRef;

console.log('\nPLAN:');
console.log(`  - Strip top-level ClassRef (was "${p.ClassRef?.name}")` );
for (const lc of lineClasses) {
  if (lc.cls) console.log(`  - Strip Class from Line[${lc.index}] (was "${lc.cls.name}")`);
}

if (!APPLY) {
  console.log('\nDRY RUN — repite con --apply para escribir el cambio en QB.');
  await pool.end();
  process.exit(0);
}

// 3. POST update
console.log('\nApplying…');
const res = await qbPost(`/purchase`, payload);
const updated = res.Purchase;
console.log(`  SyncToken: ${p.SyncToken} → ${updated.SyncToken}`);
console.log(`  Top ClassRef now: ${updated.ClassRef ? `${updated.ClassRef.name}` : '(removed)'}`);
for (const [i, line] of (updated.Line || []).entries()) {
  const cls = line.AccountBasedExpenseLineDetail?.ClassRef || line.ItemBasedExpenseLineDetail?.ClassRef;
  console.log(`  Line[${i}] Class: ${cls ? cls.name : '(removed)'}`);
}

console.log('\nDone.');
await pool.end();

/**
 * Diagnose why /api/quickbooks/match is returning 0 matches.
 *
 * For a sample of real bills:
 *  1. Print bill details
 *  2. Try the same query the endpoint uses (Purchase + BillPayment, exact amount, ±15d)
 *  3. Try broader queries to learn what's actually in QuickBooks:
 *     - Transactions with that amount, NO date filter
 *     - Transactions in that date window, NO amount filter (to see what entities exist)
 *     - Try other entity types (Bill, Expense via PaymentType filter, JournalEntry, Transfer)
 *
 * Run: node scripts/qb-diagnose-match.mjs
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

const QB_ENV   = (env['QB_ENV'] || 'production').toLowerCase();
const API_BASE = QB_ENV === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

// ── Load tokens ──────────────────────────────────────────────────────────────
const t = await pool.query(`SELECT realm_id, access_token FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
if (t.rows.length === 0) { console.error('No tokens'); process.exit(1); }
const { realm_id, access_token } = t.rows[0];

async function qbQuery(sql) {
  const url = `${API_BASE}/v3/company/${realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' }});
  if (!res.ok) {
    return { error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  return res.json();
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Pick a varied sample of bills ────────────────────────────────────────────
const billsRes = await pool.query(`
  SELECT id, utility_type, amount_due, due_date, email_received_at, email_subject, account_last4
  FROM utility_bills
  WHERE amount_due IS NOT NULL AND amount_due > 0 AND due_date IS NOT NULL
  ORDER BY due_date DESC
  LIMIT 8
`);

console.log(`\n═══ DIAGNOSE: ${billsRes.rows.length} bills ═══\n`);
console.log(`Realm ID: ${realm_id}`);
console.log(`API base: ${API_BASE}\n`);

// First, peek at QB to confirm the company has any transactions at all
console.log('─── QB sanity checks ───');
const all = await qbQuery(`SELECT COUNT(*) FROM Purchase`);
console.log(`Total Purchase entities in QB: ${all?.QueryResponse?.totalCount ?? JSON.stringify(all)}`);
const allBP = await qbQuery(`SELECT COUNT(*) FROM BillPayment`);
console.log(`Total BillPayment entities in QB: ${allBP?.QueryResponse?.totalCount ?? JSON.stringify(allBP)}`);
const allBill = await qbQuery(`SELECT COUNT(*) FROM Bill`);
console.log(`Total Bill entities in QB: ${allBill?.QueryResponse?.totalCount ?? JSON.stringify(allBill)}`);

// Look at recent Purchase samples to see what fields and date range exist
console.log('\n─── Sample of 5 recent Purchases ───');
const recent = await qbQuery(`SELECT * FROM Purchase ORDERBY TxnDate DESC MAXRESULTS 5`);
for (const p of recent?.QueryResponse?.Purchase || []) {
  console.log(`  ${p.TxnDate}  $${p.TotalAmt}  ${p.EntityRef?.name || '—'}  (${p.AccountRef?.name || ''})  PaymentType=${p.PaymentType}`);
}

console.log('\n─── Sample of 5 recent BillPayments ───');
const recentBP = await qbQuery(`SELECT * FROM BillPayment ORDERBY TxnDate DESC MAXRESULTS 5`);
for (const p of recentBP?.QueryResponse?.BillPayment || []) {
  console.log(`  ${p.TxnDate}  $${p.TotalAmt}  ${p.VendorRef?.name || '—'}`);
}

console.log('\n─── Sample of 5 recent Bills ───');
const recentBill = await qbQuery(`SELECT * FROM Bill ORDERBY TxnDate DESC MAXRESULTS 5`);
for (const p of recentBill?.QueryResponse?.Bill || []) {
  console.log(`  ${p.TxnDate}  $${p.TotalAmt}  ${p.VendorRef?.name || '—'}  (DueDate=${p.DueDate})`);
}

// ── Now diagnose each bill ───────────────────────────────────────────────────
for (const bill of billsRes.rows) {
  const amt      = Number(bill.amount_due).toFixed(2);
  const anchor   = bill.due_date.toISOString().slice(0, 10);
  const dateFrom = shiftDate(anchor, -15);
  const dateTo   = shiftDate(anchor,  15);

  console.log(`\n══════ Bill #${bill.id} ══════`);
  console.log(`  ${bill.utility_type}  $${amt}  due ${anchor}  acct ····${bill.account_last4}`);
  console.log(`  subject: ${bill.email_subject?.slice(0, 80)}`);

  // 1) Current endpoint logic: Purchase + BillPayment, exact amount, ±15 days
  const q1a = `SELECT Id, TxnDate, TotalAmt, EntityRef FROM Purchase WHERE TotalAmt = ${amt} AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;
  const q1b = `SELECT Id, TxnDate, TotalAmt, VendorRef FROM BillPayment WHERE TotalAmt = ${amt} AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;
  const r1a = await qbQuery(q1a);
  const r1b = await qbQuery(q1b);
  const purchases    = r1a?.QueryResponse?.Purchase || [];
  const billPayments = r1b?.QueryResponse?.BillPayment || [];
  console.log(`  [endpoint] Purchase: ${purchases.length}  BillPayment: ${billPayments.length}`);
  for (const p of purchases) console.log(`     - Purchase ${p.TxnDate}  $${p.TotalAmt}  ${p.EntityRef?.name || ''}`);
  for (const p of billPayments) console.log(`     - BillPayment ${p.TxnDate}  $${p.TotalAmt}  ${p.VendorRef?.name || ''}`);

  // 2) Same amount, NO date filter
  const r2a = await qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef FROM Purchase WHERE TotalAmt = ${amt}`);
  const r2b = await qbQuery(`SELECT Id, TxnDate, TotalAmt, VendorRef FROM BillPayment WHERE TotalAmt = ${amt}`);
  const totalAmtPurch = r2a?.QueryResponse?.Purchase?.length || 0;
  const totalAmtBP    = r2b?.QueryResponse?.BillPayment?.length || 0;
  console.log(`  [amount-only, no date] Purchase: ${totalAmtPurch}  BillPayment: ${totalAmtBP}`);
  if (totalAmtPurch > 0 && totalAmtPurch < 10) {
    for (const p of r2a.QueryResponse.Purchase) console.log(`     - Purchase ${p.TxnDate}  $${p.TotalAmt}  ${p.EntityRef?.name || ''}`);
  }

  // 3) Try Bill (the invoice itself, not the payment)
  const r3 = await qbQuery(`SELECT Id, TxnDate, DueDate, TotalAmt, VendorRef FROM Bill WHERE TotalAmt = ${amt} AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`);
  const bills = r3?.QueryResponse?.Bill || [];
  console.log(`  [Bill table, ±15d] ${bills.length}`);
  for (const b of bills) console.log(`     - Bill ${b.TxnDate}  $${b.TotalAmt}  ${b.VendorRef?.name || ''}`);
}

await pool.end();
console.log('\n══════ done ══════');

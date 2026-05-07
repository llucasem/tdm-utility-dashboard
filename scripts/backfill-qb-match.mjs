/**
 * One-time backfill: run QuickBooks match against every existing bill that
 * still has qb_match_status='pending' (the default after the migration).
 *
 * Run with: node scripts/backfill-qb-match.mjs
 *
 * Safe to run multiple times — only processes 'pending' rows.
 * Read-only against QuickBooks (the persisted match never writes to QB).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const QB_ENV   = (process.env.QB_ENV || 'production').toLowerCase();
const API_BASE = QB_ENV === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── token loading ────────────────────────────────────────────────────────────
const t = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
if (t.rows.length === 0) { console.error('No QB tokens'); process.exit(1); }
let { realm_id, access_token, refresh_token, expires_at } = t.rows[0];

async function refreshIfNeeded() {
  const expiresInMs = new Date(expires_at).getTime() - Date.now();
  if (expiresInMs >= 5 * 60_000) return;

  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const body  = new URLSearchParams({ grant_type: 'refresh_token', refresh_token });
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method:  'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body,
  });
  const tk = await r.json();
  access_token = tk.access_token;
  refresh_token = tk.refresh_token;
  expires_at = new Date(Date.now() + tk.expires_in * 1000);
  await pool.query(`
    UPDATE quickbooks_tokens
    SET access_token = $1, refresh_token = $2, expires_at = $3, refresh_expires_at = $4, updated_at = NOW()
    WHERE realm_id = $5
  `, [access_token, refresh_token, expires_at, new Date(Date.now() + tk.x_refresh_token_expires_in * 1000), realm_id]);
  console.log('🔄 Token refreshed');
}

async function qbQuery(sql) {
  await refreshIfNeeded();
  const url = `${API_BASE}/v3/company/${realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' }});
  if (!r.ok) throw new Error(`QB ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_TOLERANCE_DAYS = 15;
const MAX_STORED = 20;

async function searchTransactions({ amount, dateFrom, dateTo }) {
  const amt   = Number(amount).toFixed(2);
  const where = `WHERE TotalAmt = '${amt}' AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;
  const [pur, bp] = await Promise.all([
    qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef, PrivateNote, DocNumber FROM Purchase ${where}`).catch(() => null),
    qbQuery(`SELECT Id, TxnDate, TotalAmt, VendorRef, PrivateNote, DocNumber FROM BillPayment ${where}`).catch(() => null),
  ]);
  const matches = [];
  for (const p of pur?.QueryResponse?.Purchase || []) {
    matches.push({ type: 'Purchase', id: p.Id, date: p.TxnDate, amount: Number(p.TotalAmt), payee: p.EntityRef?.name || null, account: p.AccountRef?.name || null, docNumber: p.DocNumber || null, note: p.PrivateNote || null });
  }
  for (const p of bp?.QueryResponse?.BillPayment || []) {
    matches.push({ type: 'BillPayment', id: p.Id, date: p.TxnDate, amount: Number(p.TotalAmt), payee: p.VendorRef?.name || null, account: null, docNumber: p.DocNumber || null, note: p.PrivateNote || null });
  }
  return matches;
}

async function matchBill(bill) {
  if (!bill.amount_due || Number(bill.amount_due) <= 0) {
    await pool.query(`UPDATE utility_bills SET qb_match_status='skipped', qb_match_error='no_amount', qb_matched_at=NOW() WHERE id=$1`, [bill.id]);
    return 'skipped';
  }
  const anchor = bill.due_date || bill.email_received_at;
  if (!anchor) {
    await pool.query(`UPDATE utility_bills SET qb_match_status='skipped', qb_match_error='no_date', qb_matched_at=NOW() WHERE id=$1`, [bill.id]);
    return 'skipped';
  }
  const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0, 10) : String(anchor).slice(0, 10);
  const dateFrom  = shiftDate(anchorIso, -DATE_TOLERANCE_DAYS);
  const dateTo    = shiftDate(anchorIso,  DATE_TOLERANCE_DAYS);

  try {
    const matches = await searchTransactions({ amount: Number(bill.amount_due), dateFrom, dateTo });
    const stored  = matches.slice(0, MAX_STORED);
    let status;
    if (matches.length === 0) status = 'not_found';
    else if (matches.length === 1) status = 'matched';
    else status = 'ambiguous';
    await pool.query(`
      UPDATE utility_bills
      SET qb_match_status=$2, qb_match_count=$3, qb_match_data=$4::jsonb, qb_matched_at=NOW(), qb_match_error=NULL
      WHERE id=$1
    `, [bill.id, status, matches.length, JSON.stringify(stored)]);
    return status;
  } catch (e) {
    await pool.query(`
      UPDATE utility_bills SET qb_match_status='error', qb_match_count=0, qb_match_error=$2, qb_matched_at=NOW() WHERE id=$1
    `, [bill.id, e.message]);
    return 'error';
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
const pendingRes = await pool.query(`
  SELECT id, amount_due, due_date, email_received_at
  FROM utility_bills
  WHERE qb_match_status = 'pending' AND amount_due IS NOT NULL AND amount_due > 0
  ORDER BY due_date DESC NULLS LAST, id DESC
`);
const bills = pendingRes.rows;

console.log(`\n📊 Pending bills to match: ${bills.length}`);
console.log(`📡 QB env: ${QB_ENV}\n`);

const stats = { matched: 0, ambiguous: 0, not_found: 0, error: 0, skipped: 0 };
const start = Date.now();

const BATCH = 50;
for (let i = 0; i < bills.length; i += BATCH) {
  const chunk = bills.slice(i, i + BATCH);
  for (const b of chunk) {
    const out = await matchBill(b);
    stats[out] = (stats[out] || 0) + 1;
  }
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`\r⏳ ${Math.min(i + BATCH, bills.length)}/${bills.length}  matched=${stats.matched}  amb=${stats.ambiguous}  miss=${stats.not_found}  err=${stats.error}  (${elapsedSec}s)`);
  if (i + BATCH < bills.length) await new Promise(r => setTimeout(r, 1000));
}

console.log(`\n\n✅ Backfill complete.`);
console.log(`   matched:   ${stats.matched}`);
console.log(`   ambiguous: ${stats.ambiguous}`);
console.log(`   not_found: ${stats.not_found}`);
console.log(`   error:     ${stats.error}`);
console.log(`   skipped:   ${stats.skipped}`);

await pool.end();

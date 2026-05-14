/**
 * Comprehensive QuickBooks ↔ utility_bills cotejado, broken down by month.
 *
 * Pulls ALL transaction types that could represent a utility payment or
 * obligation in QuickBooks:
 *   - Purchase        (cash/credit card/check expense)
 *   - Bill            (vendor invoice recorded as an obligation)
 *   - BillPayment     (settling a Bill)
 *   - VendorCredit    (refund from vendor)
 *   - CreditCardCredit (refund on credit card)
 *   - JournalEntry    (manual debit/credit)
 *   - Transfer        (between accounts)
 *   - Deposit         (incoming, included just in case)
 *
 * For each calendar month, reports:
 *  - count of utility_bills with email_received_at in that month
 *  - count of QB transactions of each type with TxnDate in that month
 *  - bill-by-bill match status (exact amount within the month)
 *
 * Read-only. Run with: node scripts/qb-full-coteja.mjs
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

// ── QB API helpers ────────────────────────────────────────────────────────
async function getAccessToken() {
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

let tokenCache = null;
async function qbQuery(sql) {
  if (!tokenCache) tokenCache = await getAccessToken();
  const url = `https://quickbooks.api.intuit.com/v3/company/${tokenCache.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenCache.access_token}`, Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    return { __error: `${res.status}: ${text.slice(0, 200)}` };
  }
  return res.json();
}

async function fetchAllOfType(entity, monthStart, monthEnd) {
  const all = [];
  let pos = 1;
  while (true) {
    const q = await qbQuery(`SELECT * FROM ${entity} WHERE TxnDate >= '${monthStart}' AND TxnDate <= '${monthEnd}' STARTPOSITION ${pos} MAXRESULTS 500`);
    if (q.__error) return { error: q.__error, items: [] };
    const items = q?.QueryResponse?.[entity] || [];
    all.push(...items);
    if (items.length < 500) break;
    pos += 500;
  }
  return { items: all };
}

// ── Main ──────────────────────────────────────────────────────────────────
const ENTITIES = ['Purchase', 'Bill', 'BillPayment', 'VendorCredit', 'CreditCardCredit', 'JournalEntry', 'Transfer', 'Deposit'];
const MONTHS = [
  { label: 'enero',   start: '2026-01-01', end: '2026-01-31' },
  { label: 'febrero', start: '2026-02-01', end: '2026-02-28' },
  { label: 'marzo',   start: '2026-03-01', end: '2026-03-31' },
  { label: 'abril',   start: '2026-04-01', end: '2026-04-30' },
  { label: 'mayo',    start: '2026-05-01', end: '2026-05-31' },
];

function extractAmount(t, entity) {
  // Most entities expose TotalAmt at the top level
  if (typeof t.TotalAmt === 'number') return Number(t.TotalAmt);
  if (typeof t.TotalAmt === 'string') return parseFloat(t.TotalAmt);
  // JournalEntry has Line[] with Amount each — return the largest line amount
  if (entity === 'JournalEntry' && Array.isArray(t.Line)) {
    let max = 0;
    for (const l of t.Line) if (Number(l.Amount) > max) max = Number(l.Amount);
    return max;
  }
  return null;
}

function payee(t, entity) {
  return t.EntityRef?.name || t.VendorRef?.name || t.PayeeRef?.name || t.CustomerRef?.name || '-';
}

for (const month of MONTHS) {
  console.log(`\n═════════════════════════════════════════════════════════════════════`);
  console.log(`   ${month.label.toUpperCase()} 2026`);
  console.log(`═════════════════════════════════════════════════════════════════════`);

  // Bills in our DB for this month
  const billsR = await pool.query(`
    SELECT id, utility_type, property_address, unit, amount_due, due_date::text
    FROM utility_bills
    WHERE email_received_at >= $1::date AND email_received_at < ($2::date + INTERVAL '1 day')
      AND amount_due > 0
    ORDER BY amount_due
  `, [month.start, month.end]);

  console.log(`\n📋  ${billsR.rowCount} facturas en nuestra DB (email recibido en ${month.label})`);

  // Pull every entity type
  const txByEntity = {};
  let totalTx = 0;
  for (const e of ENTITIES) {
    const r = await fetchAllOfType(e, month.start, month.end);
    if (r.error) {
      console.log(`  ${e.padEnd(18)}  ERROR: ${r.error}`);
      txByEntity[e] = [];
    } else {
      txByEntity[e] = r.items;
      totalTx += r.items.length;
    }
  }
  console.log(`\n☁  QuickBooks (TxnDate en ${month.label}):`);
  for (const e of ENTITIES) console.log(`     ${e.padEnd(18)}  ${txByEntity[e].length}`);
  console.log(`     ${'TOTAL'.padEnd(18)}  ${totalTx}`);

  // Index all QB transactions by amount
  const qbByAmt = new Map(); // amount -> [{entity, t}]
  for (const e of ENTITIES) {
    for (const t of txByEntity[e]) {
      const amt = extractAmount(t, e);
      if (amt == null || amt <= 0) continue;
      const key = amt.toFixed(2);
      if (!qbByAmt.has(key)) qbByAmt.set(key, []);
      qbByAmt.get(key).push({ entity: e, t });
    }
  }

  // Match each bill
  let matched = 0, ambiguous = 0, notFound = 0;
  const matchedExamples = [];
  for (const b of billsR.rows) {
    const key = Number(b.amount_due).toFixed(2);
    const cands = qbByAmt.get(key) || [];
    if (cands.length === 0)      notFound++;
    else if (cands.length === 1) { matched++;   matchedExamples.push({ b, cand: cands[0] }); }
    else                          { ambiguous++; matchedExamples.push({ b, cands }); }
  }

  console.log(`\n🔗  Cotejado por importe exacto (mismo mes en ambos lados):`);
  console.log(`     ✓ matched     ${matched}`);
  console.log(`     ⚠ ambiguous   ${ambiguous}`);
  console.log(`     ✗ not_found   ${notFound}`);

  if (matched > 0 || ambiguous > 0) {
    console.log(`\n  — Detalle de matches —`);
    for (const m of matchedExamples) {
      if (m.cand) {
        const { entity, t } = m.cand;
        console.log(`   ✓ bill #${m.b.id} $${m.b.amount_due} ${m.b.utility_type} ${(m.b.property_address || '-').slice(0, 35)} u=${m.b.unit || '-'}`);
        console.log(`      → ${entity} ${t.Id || ''} on ${t.TxnDate} payee=${payee(t, entity)}`);
      } else {
        console.log(`   ⚠ bill #${m.b.id} $${m.b.amount_due} → ${m.cands.length} candidatos en QB:`);
        for (const c of m.cands.slice(0, 5)) console.log(`      · ${c.entity} ${c.t.Id || ''} on ${c.t.TxnDate} payee=${payee(c.t, c.entity)}`);
      }
    }
  }
}

console.log('\n');
await pool.end();

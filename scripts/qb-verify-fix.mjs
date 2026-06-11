/**
 * Verify the QB match fix: replicate endpoint logic and report results.
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

async function qb(sql) {
  const url = `https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' }});
  if (!r.ok) return { error: `${r.status}: ${(await r.text()).slice(0,200)}` };
  return r.json();
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const bills = await pool.query(`
  SELECT id, utility_type, amount_due, due_date, account_last4
  FROM utility_bills
  WHERE amount_due IS NOT NULL AND amount_due > 0 AND due_date IS NOT NULL
  ORDER BY due_date DESC
  LIMIT 20
`);

let totalMatched = 0, ambiguous = 0, missed = 0;
for (const b of bills.rows) {
  const amt    = Number(b.amount_due).toFixed(2);
  const anchor = b.due_date.toISOString().slice(0, 10);
  const from   = shiftDate(anchor, -15);
  const to     = shiftDate(anchor,  15);

  const where = `WHERE TotalAmt = '${amt}' AND TxnDate >= '${from}' AND TxnDate <= '${to}'`;
  const [rPur, rBP] = await Promise.all([
    qb(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef FROM Purchase ${where}`),
    qb(`SELECT Id, TxnDate, TotalAmt, VendorRef FROM BillPayment ${where}`),
  ]);
  const matches = [
    ...(rPur?.QueryResponse?.Purchase || []).map(p => ({ type: 'Purchase', date: p.TxnDate, amount: p.TotalAmt, payee: p.EntityRef?.name, account: p.AccountRef?.name })),
    ...(rBP?.QueryResponse?.BillPayment || []).map(p => ({ type: 'BillPayment', date: p.TxnDate, amount: p.TotalAmt, payee: p.VendorRef?.name })),
  ];

  if (matches.length === 0)      missed++;
  else if (matches.length === 1) totalMatched++;
  else                            ambiguous++;

  const flag = matches.length === 0 ? '✗' : matches.length === 1 ? '✓' : `⚠ ${matches.length}`;
  console.log(`${flag.padEnd(4)} #${String(b.id).padEnd(5)} ${b.utility_type.padEnd(11)} $${amt.padStart(7)} ${anchor}  matches=${matches.length}`);
  matches.forEach(m => console.log(`         → ${m.type} ${m.date} $${m.amount} ${m.payee || ''}`));
}

console.log(`\nSummary of ${bills.rows.length}: matched=${totalMatched}  ambiguous=${ambiguous}  missed=${missed}`);
await pool.end();

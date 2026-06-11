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
  const text = await r.text();
  return { status: r.status, body: text };
}

async function show(label, sql) {
  console.log(`\n=== ${label} ===`);
  console.log(`Query: ${sql}`);
  const r = await qb(sql);
  console.log(`Status: ${r.status}`);
  console.log(`Body:   ${r.body.slice(0, 600)}`);
}

await show('Sanity', `SELECT Id, TxnDate, TotalAmt FROM Purchase MAXRESULTS 1`);
await show('Amount only no quotes', `SELECT Id, TxnDate, TotalAmt FROM Purchase WHERE TotalAmt = 89.91`);
await show('Amount only with quotes', `SELECT Id, TxnDate, TotalAmt FROM Purchase WHERE TotalAmt = '89.91'`);
await show('Date only', `SELECT Id, TxnDate, TotalAmt FROM Purchase WHERE TxnDate = '2026-04-20' MAXRESULTS 5`);
await show('Range amount', `SELECT Id, TxnDate, TotalAmt FROM Purchase WHERE TotalAmt >= 89.90 AND TotalAmt <= 89.92`);

await pool.end();

/**
 * Phase B audit — read-only diagnostic of QuickBooks matching health.
 *
 * Sections:
 *   1. Current match/tag distribution
 *   2. matched-but-not-tagged breakdown (where does tag fail?)
 *   3. property_qb_class coverage (which properties lack Class mapping?)
 *   4. not_found sample (which bills can't find their Purchase?)
 *   5. Are we looking at Bills/Expenses too, or only Purchase + BillPayment?
 *   6. QB Purchase volume vs our bill volume (sanity check)
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

// QB token
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

async function qb(sql) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB ${r.status}`);
  return r.json();
}

console.log('═'.repeat(80));
console.log('1. DISTRIBUCIÓN ACTUAL DE MATCH/TAG (bills con amount > 0)');
console.log('─'.repeat(80));
const dist = await pool.query(`
  SELECT qb_match_status, qb_tag_status, COUNT(*) AS count
  FROM utility_bills
  WHERE amount_due > 0
  GROUP BY qb_match_status, qb_tag_status
  ORDER BY count DESC
`);
console.table(dist.rows);

console.log('\n' + '═'.repeat(80));
console.log('2. MATCHED PERO NO TAGGED — ¿dónde falla el tag?');
console.log('─'.repeat(80));
const matchedNotTagged = await pool.query(`
  SELECT b.id, b.amount_due, b.property_address, b.unit, b.utility_type,
         b.qb_tag_status, b.qb_match_error,
         CASE WHEN pc.qb_class_id IS NULL THEN 'NO CLASS MAPPED' ELSE 'class mapped' END AS class_mapping
  FROM utility_bills b
  LEFT JOIN property_qb_class pc
    ON pc.property_address = b.property_address
   AND COALESCE(pc.unit, '') = COALESCE(b.unit, '')
  WHERE b.qb_match_status = 'matched'
    AND b.qb_tag_status != 'tagged'
    AND b.amount_due > 0
  ORDER BY b.id DESC
  LIMIT 20
`);
console.log(`Total matched pero no tagged: ${matchedNotTagged.rowCount}`);
for (const r of matchedNotTagged.rows) {
  console.log(`  id=${r.id} $${r.amount_due} ${r.utility_type} | ${r.property_address}${r.unit ? ' '+r.unit : ''} | tag=${r.qb_tag_status} | ${r.class_mapping}`);
}

console.log('\n' + '═'.repeat(80));
console.log('3. COBERTURA DE property_qb_class');
console.log('─'.repeat(80));
const coverage = await pool.query(`
  WITH props AS (
    SELECT DISTINCT property_address, COALESCE(unit, '') AS unit
    FROM utility_bills
    WHERE property_address IS NOT NULL AND amount_due > 0
  )
  SELECT COUNT(*) AS total_properties,
         COUNT(pc.qb_class_id) AS with_class,
         COUNT(*) - COUNT(pc.qb_class_id) AS without_class
  FROM props p
  LEFT JOIN property_qb_class pc
    ON pc.property_address = p.property_address
   AND COALESCE(pc.unit, '') = p.unit
`);
console.table(coverage.rows);

const missingClass = await pool.query(`
  WITH props AS (
    SELECT DISTINCT property_address, COALESCE(unit, '') AS unit,
           COUNT(*) FILTER (WHERE qb_match_status = 'matched') AS matched_bills
    FROM utility_bills
    WHERE property_address IS NOT NULL AND amount_due > 0
    GROUP BY 1, 2
  )
  SELECT p.property_address, p.unit, p.matched_bills
  FROM props p
  LEFT JOIN property_qb_class pc
    ON pc.property_address = p.property_address
   AND COALESCE(pc.unit, '') = p.unit
  WHERE pc.qb_class_id IS NULL AND p.matched_bills > 0
  ORDER BY p.matched_bills DESC
  LIMIT 20
`);
console.log('\nPropiedades SIN Class mapping pero CON facturas matched (top 20):');
for (const r of missingClass.rows) {
  console.log(`  ${r.matched_bills} bills matched | ${r.property_address} ${r.unit || ''}`);
}

console.log('\n' + '═'.repeat(80));
console.log('4. SAMPLE DE not_found RECIENTES (últimos 30 días)');
console.log('─'.repeat(80));
const notFound = await pool.query(`
  SELECT id, amount_due, utility_type, property_address, unit,
         email_received_at::date AS recv,
         qb_matched_at::date AS last_tried,
         email_from
  FROM utility_bills
  WHERE qb_match_status = 'not_found'
    AND email_received_at >= NOW() - INTERVAL '30 days'
    AND amount_due > 0
  ORDER BY email_received_at DESC
  LIMIT 15
`);
console.log(`Total not_found en últimos 30d: ${notFound.rowCount}`);
for (const r of notFound.rows) {
  console.log(`  id=${r.id} $${r.amount_due} ${r.utility_type} | recv=${r.recv} | ${r.property_address || '(no addr)'}${r.unit ? ' '+r.unit : ''}`);
}

console.log('\n' + '═'.repeat(80));
console.log('5. QB ENTITIES — ¿qué transacciones puede ver el matcher?');
console.log('─'.repeat(80));
// We check: Purchase, BillPayment, Bill, Expense, and pending bank feed if accessible
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const entities = {};
for (const entity of ['Purchase', 'BillPayment', 'Bill']) {
  try {
    const r = await qb(`SELECT COUNT(*) FROM ${entity} WHERE TxnDate >= '${since}'`);
    entities[entity] = r?.QueryResponse?.totalCount ?? r?.QueryResponse?.[entity]?.length ?? '?';
  } catch (e) {
    entities[entity] = `ERROR: ${e.message}`;
  }
}
console.log(`Transacciones en QB últimos 30 días:`);
for (const [k, v] of Object.entries(entities)) {
  console.log(`  ${k.padEnd(15)} ${v}`);
}

// Sample Purchase amounts vs our not_found amounts — coincidence test
const ourAmounts = notFound.rows.map(r => Number(r.amount_due)).slice(0, 5);
if (ourAmounts.length > 0) {
  console.log(`\nBuscando en QB los amounts de las 5 not_found más recientes (cualquier fecha):`);
  for (const amt of ourAmounts) {
    const amtStr = amt.toFixed(2);
    const r = await qb(`SELECT Id, TxnDate, TotalAmt, EntityRef FROM Purchase WHERE TotalAmt = '${amtStr}' MAXRESULTS 5`);
    const matches = r?.QueryResponse?.Purchase || [];
    console.log(`  $${amtStr}: ${matches.length} Purchase candidates`);
    for (const p of matches.slice(0, 3)) {
      console.log(`    - ${p.TxnDate} ${p.EntityRef?.name || '?'} ($${p.TotalAmt})`);
    }
  }
}

console.log('\n' + '═'.repeat(80));
console.log('6. VOLUMEN MENSUAL: nuestras bills vs QB Purchases');
console.log('─'.repeat(80));
const billMonths = await pool.query(`
  SELECT TO_CHAR(date_trunc('month', email_received_at), 'YYYY-MM') AS month,
         COUNT(*) AS bills,
         COUNT(*) FILTER (WHERE qb_match_status = 'matched') AS matched,
         COUNT(*) FILTER (WHERE qb_match_status = 'not_found') AS not_found,
         COUNT(*) FILTER (WHERE qb_match_status = 'ambiguous') AS ambiguous
  FROM utility_bills
  WHERE amount_due > 0 AND email_received_at IS NOT NULL
  GROUP BY 1 ORDER BY 1 DESC LIMIT 6
`);
console.table(billMonths.rows);

await pool.end();

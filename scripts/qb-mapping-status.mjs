/**
 * Diagnostic: report on the state of property↔QuickBooks Class mapping.
 *
 * Answers:
 *  - How many distinct property+unit pairs exist in our utility_bills?
 *  - How many of those have a saved mapping in property_qb_class?
 *  - Which Classes exist on the QuickBooks side?
 *  - How many bills are matched, ambiguous, not_found?
 *  - How many bills could be auto-tagged if mapping existed?
 *
 * Read-only. Safe to run any time.
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

// ── QuickBooks helpers (self-contained — bypass Next.js path aliases) ────────
const QB_BASE = (process.env.QB_ENV || 'production').toLowerCase() === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

async function getAccessToken() {
  const r = await pool.query(
    `SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`
  );
  if (r.rows.length === 0) throw new Error('No QB tokens in DB');
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row;

  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  const t = await res.json();
  const expiresAt = new Date(Date.now() + t.expires_in * 1000);
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, expiresAt, row.realm_id]
  );
  return { realm_id: row.realm_id, access_token: t.access_token };
}

async function qbQuery(sql) {
  const tok = await getAccessToken();
  const url = `${QB_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`QB query failed (${res.status}): ${await res.text()}`);
  return res.json();
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  STATE OF PROPERTY ↔ QUICKBOOKS CLASS MAPPING');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ── 1. Dashboard side ──────────────────────────────────────────────────────
const propsR = await pool.query(`
  SELECT property_address, COALESCE(unit, '') AS unit, COUNT(*)::int AS bill_count,
         SUM(amount_due)::float AS total_amount
  FROM utility_bills
  WHERE property_address IS NOT NULL AND TRIM(property_address) != ''
    AND amount_due > 0
  GROUP BY property_address, COALESCE(unit, '')
  ORDER BY property_address, unit
`);
const properties = propsR.rows;
console.log(`📋  DASHBOARD: ${properties.length} distinct property+unit pairs with bills\n`);

// ── 2. QB Classes side ─────────────────────────────────────────────────────
console.log('☁  Fetching QuickBooks Classes...');
let qbClasses = [];
try {
  const q = await qbQuery(`SELECT Id, Name, Active, FullyQualifiedName FROM Class MAXRESULTS 1000`);
  qbClasses = q?.QueryResponse?.Class || [];
} catch (e) {
  console.log(`   ❌ Could not fetch QB Classes: ${e.message}`);
}
const activeClasses = qbClasses.filter(c => c.Active);
console.log(`     QuickBooks has ${qbClasses.length} total Classes (${activeClasses.length} active)\n`);

// ── 3. Mapping table ───────────────────────────────────────────────────────
const mapR = await pool.query(`
  SELECT property_address, unit, qb_class_id, qb_class_name
  FROM property_qb_class
`);
const mappings = mapR.rows;
console.log(`🔗  MAPPING TABLE: ${mappings.length} of ${properties.length} property+unit pairs mapped to a QB Class\n`);

// ── 4. Bill status breakdown ───────────────────────────────────────────────
console.log('— Bill status breakdown —\n');

const stats = await pool.query(`
  SELECT
    COUNT(*)::int                                                                  AS total_bills,
    COUNT(*) FILTER (WHERE property_address IS NOT NULL AND TRIM(property_address) != '')::int
                                                                                   AS with_property,
    COUNT(*) FILTER (WHERE qb_match_status = 'matched')::int                       AS matched,
    COUNT(*) FILTER (WHERE qb_match_status = 'ambiguous')::int                     AS ambiguous,
    COUNT(*) FILTER (WHERE qb_match_status = 'not_found')::int                     AS not_found,
    COUNT(*) FILTER (WHERE qb_match_status = 'pending')::int                       AS match_pending,
    COUNT(*) FILTER (WHERE qb_match_status = 'matched'
                       AND property_address IS NOT NULL
                       AND TRIM(property_address) != '')::int                      AS matched_with_property,
    COUNT(*) FILTER (WHERE qb_tag_status = 'tagged')::int                          AS tagged,
    COUNT(*) FILTER (WHERE qb_tag_status = 'pending')::int                         AS tag_pending,
    COUNT(*) FILTER (WHERE qb_tag_status = 'error')::int                           AS tag_error
  FROM utility_bills
  WHERE amount_due > 0
`);
const s = stats.rows[0];

console.log(`  Total bills with amount > 0:                     ${s.total_bills}`);
console.log(`  ├─ With property assigned:                       ${s.with_property}`);
console.log(`  └─ Without property (Unassigned):                ${s.total_bills - s.with_property}`);
console.log('');
console.log(`  Match status (cotejado con QuickBooks):`);
console.log(`  ├─ ✓ matched  (encontró 1 transacción en QB):    ${s.matched}`);
console.log(`  ├─ ⚠ ambiguous (varias coincidencias):           ${s.ambiguous}`);
console.log(`  ├─ ✗ not_found (sin coincidencia en QB):         ${s.not_found}`);
console.log(`  └─ · pending (sin importe — no se busca):        ${s.match_pending}`);
console.log('');
console.log(`  Tag status (etiqueta de Class aplicada en QB):`);
console.log(`  ├─ 🏷  tagged   (Class escrita en QB):            ${s.tagged}`);
console.log(`  ├─ ! tag_error (sin mapping property→class):     ${s.tag_error}`);
console.log(`  └─ · tag_pending:                                ${s.tag_pending}`);

console.log('\n— Bills auto-taggable RIGHT NOW —\n');

const taggable = await pool.query(`
  SELECT COUNT(*)::int AS n
  FROM utility_bills b
  WHERE b.qb_match_status = 'matched'
    AND b.property_address IS NOT NULL
    AND TRIM(b.property_address) != ''
    AND EXISTS (
      SELECT 1 FROM property_qb_class p
      WHERE p.property_address = b.property_address
        AND COALESCE(p.unit, '') = COALESCE(b.unit, '')
    )
`);
console.log(`  ${taggable.rows[0].n} bills would auto-tag right now (matched + property + class mapping)`);
console.log(`  ${s.matched - taggable.rows[0].n} bills are matched + have property but are STUCK because no class mapping exists`);

// ── 5. Per-property report ─────────────────────────────────────────────────
console.log('\n— Property-by-property report —\n');

const perProp = await pool.query(`
  SELECT
    b.property_address,
    COALESCE(b.unit, '') AS unit,
    COUNT(*)::int                                              AS bill_count,
    COUNT(*) FILTER (WHERE b.qb_match_status = 'matched')::int AS matched_bills,
    SUM(b.amount_due)::float                                   AS total_amount,
    p.qb_class_id,
    p.qb_class_name
  FROM utility_bills b
  LEFT JOIN property_qb_class p
    ON p.property_address = b.property_address
   AND COALESCE(p.unit, '') = COALESCE(b.unit, '')
  WHERE b.property_address IS NOT NULL AND TRIM(b.property_address) != ''
    AND b.amount_due > 0
  GROUP BY b.property_address, COALESCE(b.unit, ''), p.qb_class_id, p.qb_class_name
  ORDER BY b.property_address, unit
`);

console.log('  Property                                                  Unit   Bills  Match  Amount    QB Class');
console.log('  ' + '─'.repeat(105));
for (const row of perProp.rows) {
  const addr   = row.property_address.length > 52 ? row.property_address.slice(0, 49) + '...' : row.property_address.padEnd(52);
  const unit   = (row.unit || '—').padEnd(6);
  const bills  = String(row.bill_count).padStart(5);
  const match  = String(row.matched_bills).padStart(5);
  const amt    = `$${row.total_amount.toFixed(0)}`.padStart(7);
  const cls    = row.qb_class_name ? `✓ ${row.qb_class_name}` : '✗ (no mapping)';
  console.log(`  ${addr}  ${unit}  ${bills}  ${match}  ${amt}   ${cls}`);
}

// ── 6. QB Classes that DO exist ────────────────────────────────────────────
console.log(`\n— QuickBooks Classes available (${activeClasses.length}) —\n`);
if (activeClasses.length === 0) {
  console.log('  ⚠  QuickBooks has NO active Classes. Edonis must create them first.');
} else {
  for (const c of activeClasses.slice(0, 30)) {
    console.log(`  · ${c.Name}${c.FullyQualifiedName !== c.Name ? `  (${c.FullyQualifiedName})` : ''}`);
  }
  if (activeClasses.length > 30) console.log(`  ... and ${activeClasses.length - 30} more`);
}

console.log('\n═══════════════════════════════════════════════════════════════════\n');
await pool.end();

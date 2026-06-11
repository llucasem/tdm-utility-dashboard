/**
 * Phase D audit — Bill → Property mapping health (read-only).
 *
 * Sections:
 *   1. account_mappings coverage: how many distinct (utility_type, account_last4)
 *      exist in bills vs how many have a mapping
 *   2. Unassigned bills (property_address IS NULL with amount > 0)
 *   3. Orphaned mappings — mappings that no longer have any bill
 *   4. Retro-fill verification — bills sharing account_last4 with mapped ones
 *      but still showing property_address NULL
 *   5. Provider domain detection — which senders deliver bills with full
 *      address vs which need account_mappings
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

console.log('═'.repeat(80));
console.log('1. COBERTURA DE account_mappings');
console.log('─'.repeat(80));

const coverage = await pool.query(`
  WITH distinct_accounts AS (
    SELECT DISTINCT utility_type, account_last4
    FROM utility_bills
    WHERE account_last4 IS NOT NULL
      AND utility_type IS NOT NULL
      AND amount_due > 0
  )
  SELECT COUNT(*) AS total_distinct_accounts,
         COUNT(am.id) AS with_mapping,
         COUNT(*) - COUNT(am.id) AS without_mapping
  FROM distinct_accounts da
  LEFT JOIN account_mappings am
    ON am.utility_type = da.utility_type
   AND am.account_last4 = da.account_last4
`);
console.table(coverage.rows);

const byType = await pool.query(`
  WITH distinct_accounts AS (
    SELECT DISTINCT utility_type, account_last4
    FROM utility_bills
    WHERE account_last4 IS NOT NULL AND utility_type IS NOT NULL AND amount_due > 0
  )
  SELECT da.utility_type,
         COUNT(*) AS total,
         COUNT(am.id) AS mapped,
         COUNT(*) - COUNT(am.id) AS missing
  FROM distinct_accounts da
  LEFT JOIN account_mappings am
    ON am.utility_type = da.utility_type AND am.account_last4 = da.account_last4
  GROUP BY da.utility_type
  ORDER BY total DESC
`);
console.log('\nDesglose por utility_type:');
console.table(byType.rows);

console.log('\n' + '═'.repeat(80));
console.log('2. BILLS UNASSIGNED (property_address NULL, amount > 0)');
console.log('─'.repeat(80));
const unassigned = await pool.query(`
  SELECT id, utility_type, account_last4, amount_due,
         email_received_at::date AS recv,
         email_from, email_subject
  FROM utility_bills
  WHERE property_address IS NULL
    AND amount_due > 0
  ORDER BY email_received_at DESC
`);
console.log(`Total unassigned facturables: ${unassigned.rowCount}`);
for (const r of unassigned.rows) {
  console.log(`  id=${r.id} ${r.utility_type} $${r.amount_due} ····${r.account_last4 || '?'} | recv=${r.recv}`);
  console.log(`    ${(r.email_subject || '').slice(0, 70)}`);
  console.log(`    from: ${r.email_from}`);
}

console.log('\n' + '═'.repeat(80));
console.log('3. RETRO-FILL CHECK — bills con cuenta mapeada pero sin dirección');
console.log('─'.repeat(80));
const retroOrphans = await pool.query(`
  SELECT b.id, b.utility_type, b.account_last4, b.amount_due,
         b.email_received_at::date AS recv,
         am.property_address AS mapping_says,
         b.property_address AS bill_has
  FROM utility_bills b
  JOIN account_mappings am
    ON am.utility_type = b.utility_type AND am.account_last4 = b.account_last4
  WHERE b.property_address IS NULL
    AND b.amount_due > 0
`);
console.log(`Bills sin dirección pero CON mapping en account_mappings: ${retroOrphans.rowCount}`);
if (retroOrphans.rowCount > 0) {
  console.log('  ⚠ RETRO-FILL ROTO — estas deberían tener dirección');
  for (const r of retroOrphans.rows) {
    console.log(`    id=${r.id} ····${r.account_last4} mapping="${r.mapping_says}" bill="${r.bill_has}"`);
  }
}

console.log('\n' + '═'.repeat(80));
console.log('4. ORPHANED MAPPINGS — mappings sin bills activas');
console.log('─'.repeat(80));
const orphaned = await pool.query(`
  SELECT am.id, am.utility_type, am.account_last4, am.property_address, am.unit,
         COUNT(b.id) AS bill_count,
         MAX(b.email_received_at) AS last_bill
  FROM account_mappings am
  LEFT JOIN utility_bills b
    ON b.utility_type = am.utility_type AND b.account_last4 = am.account_last4
   AND b.amount_due > 0
  GROUP BY am.id, am.utility_type, am.account_last4, am.property_address, am.unit
  HAVING COUNT(b.id) = 0
`);
console.log(`Mappings huérfanos (sin ninguna bill que use esa cuenta): ${orphaned.rowCount}`);
for (const r of orphaned.rows.slice(0, 10)) {
  console.log(`  ${r.utility_type} ····${r.account_last4} → ${r.property_address} ${r.unit || ''}`);
}

console.log('\n' + '═'.repeat(80));
console.log('5. ¿QUÉ PROVEEDORES MANDAN DIRECCIÓN EN EL EMAIL?');
console.log('─'.repeat(80));
const byProvider = await pool.query(`
  SELECT REGEXP_REPLACE(LOWER(COALESCE(email_from, '')), '^.*<([^>]+)>$', '\\1') AS sender,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE property_address IS NOT NULL) AS with_address,
         COUNT(*) FILTER (WHERE property_address IS NULL) AS without_address,
         ROUND(100.0 * COUNT(*) FILTER (WHERE property_address IS NOT NULL) / COUNT(*), 1) AS pct_with_address
  FROM utility_bills
  WHERE amount_due > 0
  GROUP BY 1
  HAVING COUNT(*) > 5
  ORDER BY total DESC
`);
console.log('Top remitentes (>5 bills) — % con dirección extraída:');
console.table(byProvider.rows);

console.log('\n' + '═'.repeat(80));
console.log('6. DUPLICADOS DE PROPIEDAD POR VARIANTE DE ESCRITURA');
console.log('─'.repeat(80));
const dupes = await pool.query(`
  WITH normalized AS (
    SELECT property_address,
           REGEXP_REPLACE(
             REGEXP_REPLACE(LOWER(TRIM(property_address)), 'avenue', 'ave', 'g'),
             'street', 'st', 'g'
           ) AS norm
    FROM utility_bills
    WHERE property_address IS NOT NULL AND amount_due > 0
    GROUP BY property_address
  )
  SELECT norm, ARRAY_AGG(DISTINCT property_address) AS variants, COUNT(DISTINCT property_address) AS n
  FROM normalized
  GROUP BY norm
  HAVING COUNT(DISTINCT property_address) > 1
  ORDER BY n DESC
`);
console.log(`Propiedades con más de una variante de escritura: ${dupes.rowCount}`);
for (const r of dupes.rows.slice(0, 10)) {
  console.log(`  ${r.n} variantes: ${JSON.stringify(r.variants)}`);
}

await pool.end();

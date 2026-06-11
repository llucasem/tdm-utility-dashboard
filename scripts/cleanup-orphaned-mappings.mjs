/**
 * Delete account_mappings entries whose (utility_type, account_last4)
 * no longer has any billable bill in utility_bills.
 *
 * Safe: even if a future bill arrives with that account, it just won't
 * auto-fill the property — Jake assigns it manually once and the mapping
 * is recreated on the spot via PATCH /api/bills/[id].
 *
 * Run with:  node scripts/cleanup-orphaned-mappings.mjs [--apply]
 *            Without --apply this is dry-run.
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

const APPLY = process.argv.includes('--apply');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Find mappings whose account has no active bill
const orphans = await pool.query(`
  SELECT am.id, am.utility_type, am.account_last4, am.property_address, am.unit, am.created_at,
         COUNT(b.id) AS bill_count
  FROM account_mappings am
  LEFT JOIN utility_bills b
    ON b.utility_type = am.utility_type
   AND b.account_last4 = am.account_last4
   AND b.amount_due > 0
  GROUP BY am.id, am.utility_type, am.account_last4, am.property_address, am.unit, am.created_at
  HAVING COUNT(b.id) = 0
  ORDER BY am.created_at
`);

console.log(`Huérfanos encontrados: ${orphans.rowCount}\n`);
for (const r of orphans.rows) {
  console.log(`  ${r.utility_type.padEnd(11)} ····${r.account_last4}  → ${r.property_address}${r.unit ? ' '+r.unit : ''}`);
}

if (orphans.rowCount === 0) {
  console.log('\nNada que limpiar.');
  await pool.end();
  process.exit(0);
}

if (!APPLY) {
  console.log(`\nDRY RUN — repite con --apply para borrar los ${orphans.rowCount} mappings.`);
  await pool.end();
  process.exit(0);
}

const ids = orphans.rows.map(r => r.id);
const del = await pool.query(`DELETE FROM account_mappings WHERE id = ANY($1::int[]) RETURNING id`, [ids]);
console.log(`\nBorrados: ${del.rowCount} mappings.`);

await pool.end();

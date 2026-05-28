/**
 * Migration: create learned_vendors + learned_bank_accounts tables.
 *
 * These tables are populated by lib/known-vendors.js:refreshLearned*()
 * from the cron retry-and-learn. They store payees and bank accounts
 * observed in successfully tagged bills, with a sample count. Vendors
 * with sample_count >= 3 are promoted to the auto-tag whitelist.
 *
 * Safe to run multiple times — uses IF NOT EXISTS.
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

const SQL = `
CREATE TABLE IF NOT EXISTS learned_vendors (
  id               SERIAL PRIMARY KEY,
  utility_type     TEXT NOT NULL,
  vendor_substring TEXT NOT NULL,
  sample_count     INT  NOT NULL DEFAULT 0,
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(utility_type, vendor_substring)
);
CREATE INDEX IF NOT EXISTS idx_lv_type_count ON learned_vendors (utility_type, sample_count);

CREATE TABLE IF NOT EXISTS learned_bank_accounts (
  id           SERIAL PRIMARY KEY,
  account_name TEXT NOT NULL UNIQUE,
  sample_count INT  NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lba_count ON learned_bank_accounts (sample_count);
`;

console.log('Aplicando migración…');
await pool.query(SQL);
console.log('  ✓ Tablas learned_vendors + learned_bank_accounts listas');

// Sanity check
const t1 = await pool.query(`SELECT COUNT(*) AS c FROM learned_vendors`);
const t2 = await pool.query(`SELECT COUNT(*) AS c FROM learned_bank_accounts`);
console.log(`  learned_vendors: ${t1.rows[0].c} filas`);
console.log(`  learned_bank_accounts: ${t2.rows[0].c} filas`);

await pool.end();

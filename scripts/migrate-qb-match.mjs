/**
 * Migration: persistent QuickBooks match columns on utility_bills.
 * Run with: node scripts/migrate-qb-match.mjs
 *
 * Adds (idempotent):
 *  - qb_match_status  ('pending' | 'matched' | 'ambiguous' | 'not_found' | 'error' | 'skipped')
 *  - qb_match_count   how many QB transactions matched
 *  - qb_match_data    JSONB with the full normalized matches array
 *  - qb_matched_at    when the match was last attempted
 *  - qb_match_error   error message if status='error'
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

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SQL = `
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_match_status TEXT DEFAULT 'pending';
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_match_count  INTEGER;
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_match_data   JSONB;
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_matched_at   TIMESTAMPTZ;
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_match_error  TEXT;

CREATE INDEX IF NOT EXISTS idx_ub_qb_match_status ON utility_bills (qb_match_status);
CREATE INDEX IF NOT EXISTS idx_ub_qb_match_pending
  ON utility_bills (qb_match_status, due_date)
  WHERE qb_match_status IN ('pending', 'not_found', 'error');
`;

console.log('🔧 Adding qb_match_* columns to utility_bills...');
await pool.query(SQL);

const r = await pool.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'utility_bills' AND column_name LIKE 'qb_match%'
  ORDER BY ordinal_position
`);
console.log('\n✅ Match columns:');
r.rows.forEach(c => console.log(`  - ${c.column_name.padEnd(20)} ${c.data_type}`));

await pool.end();

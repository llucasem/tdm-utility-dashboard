/**
 * Migration: tables and columns for QuickBooks auto-tag.
 * Run with: node scripts/migrate-qb-autotag.mjs
 *
 * Creates (idempotent):
 *  - quickbooks_tag_log    : audit of every tag attempt
 *  - property_qb_class     : mapping property+unit -> QuickBooks Class id
 *
 * Adds (idempotent):
 *  - utility_bills.qb_tag_status      ('pending' | 'tagged' | 'not_found' | 'ambiguous' | 'error' | 'skipped')
 *  - utility_bills.qb_purchase_id     (the QB transaction id we tagged, when applicable)
 *  - utility_bills.qb_class_id        (the QB class id we wrote, when applicable)
 *  - utility_bills.qb_tagged_at       (when it was tagged successfully)
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
-- ── quickbooks_tag_log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quickbooks_tag_log (
  id                 SERIAL PRIMARY KEY,
  bill_id            INTEGER NOT NULL REFERENCES utility_bills(id),
  qb_purchase_id     TEXT,
  qb_purchase_type   TEXT,
  qb_class_id_new    TEXT,
  qb_class_id_old    TEXT,
  status             TEXT NOT NULL,
  match_count        INTEGER,
  error_message      TEXT,
  email_notified     BOOLEAN DEFAULT false,
  tagged_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qbtl_bill   ON quickbooks_tag_log (bill_id);
CREATE INDEX IF NOT EXISTS idx_qbtl_status ON quickbooks_tag_log (status, tagged_at DESC);

-- ── property_qb_class ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_qb_class (
  id                  SERIAL PRIMARY KEY,
  property_id         INTEGER REFERENCES properties(id),
  property_address    TEXT NOT NULL,
  unit                TEXT,
  qb_class_id         TEXT NOT NULL,
  qb_class_name       TEXT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pqc_property_unit ON property_qb_class (property_address, COALESCE(unit, ''));

-- ── columns on utility_bills ──────────────────────────────────────────
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_tag_status TEXT DEFAULT 'pending';
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_purchase_id TEXT;
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_class_id    TEXT;
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS qb_tagged_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ub_qb_tag_status ON utility_bills (qb_tag_status);
`;

console.log('🔧 Running migration...\n');
await pool.query(SQL);

const checks = await pool.query(`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_name IN ('quickbooks_tag_log', 'property_qb_class')
     OR (table_name = 'utility_bills' AND column_name LIKE 'qb_%')
  ORDER BY table_name, ordinal_position
`);

let lastTable = '';
for (const r of checks.rows) {
  if (r.table_name !== lastTable) {
    console.log(`\n  ${r.table_name}`);
    lastTable = r.table_name;
  }
  console.log(`    - ${r.column_name.padEnd(22)} ${r.data_type}`);
}

await pool.end();
console.log('\n✅ Migration complete.');

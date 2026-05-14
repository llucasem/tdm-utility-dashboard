/**
 * Migration: schema for the auto-learning system.
 *
 * Adds:
 *  - property_qb_class.source  ('manual' | 'inferred' | 'bulk-import')
 *  - property_qb_class.inferred_from_bill_id
 *  - property_qb_class.inferred_from_purchase_id
 *  - class_learning_log (audit trail for every learning attempt)
 *
 * Run with:  node scripts/migrate-class-claim.mjs
 * Idempotent — safe to re-run.
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

const SQL = `
ALTER TABLE property_qb_class
  ADD COLUMN IF NOT EXISTS source                    TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS inferred_from_bill_id     INTEGER,
  ADD COLUMN IF NOT EXISTS inferred_from_purchase_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pqc_source ON property_qb_class (source);

CREATE TABLE IF NOT EXISTS class_learning_log (
  id                SERIAL PRIMARY KEY,
  bill_id           INTEGER REFERENCES utility_bills(id),
  qb_purchase_id    TEXT,
  qb_class_id       TEXT,
  qb_class_name     TEXT,
  property_address  TEXT,
  unit              TEXT,
  action            TEXT NOT NULL,
  previous_class    TEXT,
  details           TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cll_action      ON class_learning_log (action);
CREATE INDEX IF NOT EXISTS idx_cll_purchase    ON class_learning_log (qb_purchase_id);
CREATE INDEX IF NOT EXISTS idx_cll_created_at  ON class_learning_log (created_at DESC);
`;

console.log('🔧 Applying migration class-claim...');
await pool.query(SQL);

// Confirm
const checks = await pool.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'property_qb_class'
    AND column_name IN ('source', 'inferred_from_bill_id', 'inferred_from_purchase_id')
  UNION ALL
  SELECT table_name FROM information_schema.tables WHERE table_name = 'class_learning_log'
`);
for (const r of checks.rows) console.log(`  ✓ ${r.column_name}`);

console.log('\n✅ Migration complete.');
await pool.end();

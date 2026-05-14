/**
 * Migration: review_flags table.
 *
 * Replaces the file-based data/review-flags.json (which was read-only on Vercel
 * and broke the DELETE endpoint). Seeds existing flags from the JSON file once.
 *
 * Run with:  node scripts/migrate-review-flags.mjs
 * Idempotent — safe to re-run.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('🔧 Creating review_flags table...');

await pool.query(`
  CREATE TABLE IF NOT EXISTS review_flags (
    id            SERIAL PRIMARY KEY,
    tag           TEXT NOT NULL,
    utility_type  TEXT,
    provider      TEXT,
    address       TEXT,
    unit          TEXT,
    account_last4 TEXT,
    note          TEXT,
    addresses     JSONB,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_review_flags_unresolved
    ON review_flags (created_at) WHERE resolved_at IS NULL;
`);

// One-time seed from JSON if the table is empty
const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM review_flags`);
if (existing.rows[0].n === 0) {
  const jsonPath = join(__dirname, '..', 'data', 'review-flags.json');
  if (existsSync(jsonPath)) {
    const flags = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    for (const f of flags) {
      await pool.query(
        `INSERT INTO review_flags (tag, utility_type, provider, address, unit, account_last4, note, addresses)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          f.tag, f.utility_type || null, f.provider || null, f.address || null,
          f.unit || null, f.account_last4 || null, f.note || null,
          f.addresses ? JSON.stringify(f.addresses) : null,
        ]
      );
    }
    console.log(`  Seeded ${flags.length} flags from data/review-flags.json`);
  }
} else {
  console.log(`  Table already has ${existing.rows[0].n} flags — skipping seed`);
}

const final = await pool.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved FROM review_flags`);
console.log(`\n✅ Migration complete. ${final.rows[0].n} total flags, ${final.rows[0].unresolved} unresolved.`);

await pool.end();

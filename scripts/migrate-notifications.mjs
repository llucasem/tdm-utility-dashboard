/**
 * Migration: in-app notifications table.
 * Run with: node scripts/migrate-notifications.mjs
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
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL,                    -- 'info' | 'success' | 'warning' | 'error'
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  bill_id     INTEGER REFERENCES utility_bills(id),
  metadata    JSONB,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_unread  ON notifications (created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications (created_at DESC);
`;

console.log('🔧 Creating notifications table...');
await pool.query(SQL);

const r = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='notifications' ORDER BY ordinal_position`);
console.log('\n✅ Schema:');
r.rows.forEach(c => console.log(`  - ${c.column_name.padEnd(14)} ${c.data_type}`));

await pool.end();

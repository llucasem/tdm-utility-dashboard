/**
 * Migration: anomaly tracking columns on utility_bills.
 * Run with: node scripts/migrate-anomalies.mjs
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

await pool.query(`
  ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS is_anomaly       BOOLEAN DEFAULT false;
  ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS anomaly_baseline NUMERIC;
  ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS anomaly_ratio    NUMERIC;
  CREATE INDEX IF NOT EXISTS idx_ub_anomaly ON utility_bills (is_anomaly) WHERE is_anomaly = true;
`);

console.log('✅ Anomaly columns added to utility_bills');
await pool.end();

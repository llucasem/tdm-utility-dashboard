/**
 * Database backup — exports all tables to a single JSON file.
 *
 * Run with: node scripts/backup-db.mjs [output-path]
 *
 * The output is a UTF-8 JSON file containing every row of every table.
 * Safe to run on production — read-only.
 *
 * Used by .github/workflows/backup.yml as the daily backup mechanism.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import pg from 'pg';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env vars (skip if running in CI where they're already in process.env)
const envPath = join(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// List all user tables in the public schema
const tablesRes = await pool.query(`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
`);
const tables = tablesRes.rows.map(r => r.tablename);

console.log(`📦 Backing up ${tables.length} tables...`);
const backup = {
  generatedAt: new Date().toISOString(),
  schema:      'public',
  tables:      {},
};

for (const t of tables) {
  const r = await pool.query(`SELECT * FROM ${t}`);
  backup.tables[t] = r.rows;
  console.log(`   - ${t.padEnd(28)} ${r.rows.length} rows`);
}

await pool.end();

// Output path
const date    = new Date().toISOString().slice(0, 10);
const outDir  = join(__dirname, '..', 'backups');
const outPath = process.argv[2] || join(outDir, `${date}.json.gz`);

if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });

const json = JSON.stringify(backup);
const gzip = zlib.gzipSync(json, { level: 9 });
writeFileSync(outPath, gzip);

const sizeKB = (gzip.length / 1024).toFixed(1);
const rowsTotal = Object.values(backup.tables).reduce((s, t) => s + t.length, 0);
console.log(`\n✅ Wrote ${outPath}`);
console.log(`   ${rowsTotal.toLocaleString()} rows  ·  ${sizeKB} KB compressed`);

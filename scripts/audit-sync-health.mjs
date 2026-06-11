/**
 * Diagnose sync health: when was the last bill inserted? When was the last
 * "real bill" subject ingested?
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

async function main() {
  // Most recent created_at
  const recent = await pool.query(`
    SELECT id, gmail_message_id, email_subject, email_from,
           amount_due, qb_match_status,
           created_at, email_received_at
    FROM utility_bills
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log('═'.repeat(80));
  console.log('Últimas 10 inserciones en utility_bills (por created_at):');
  console.log('─'.repeat(80));
  for (const r of recent.rows) {
    console.log(`  created=${r.created_at.toISOString()} recv=${r.email_received_at?.toISOString().slice(0,10)} | ${r.email_subject?.slice(0,60)}`);
    console.log(`     id=${r.id} amount=${r.amount_due ?? 'NULL'} status=${r.qb_match_status}`);
  }

  // Distribution by created_at day in the last 30 days
  const byDay = await pool.query(`
    SELECT created_at::date AS day, COUNT(*) AS inserts
    FROM utility_bills
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  console.log('\n' + '═'.repeat(80));
  console.log('Inserciones por día (últimos 30 días):');
  console.log('─'.repeat(80));
  console.table(byDay.rows);

  // Time between consecutive inserts — gaps
  const gaps = await pool.query(`
    WITH ordered AS (
      SELECT created_at,
             LAG(created_at) OVER (ORDER BY created_at) AS prev
      FROM utility_bills
      WHERE created_at >= NOW() - INTERVAL '60 days'
    )
    SELECT to_char(created_at, 'YYYY-MM-DD HH24:MI') AS at,
           EXTRACT(EPOCH FROM (created_at - prev)) / 3600 AS hours_since_prev
    FROM ordered
    WHERE EXTRACT(EPOCH FROM (created_at - prev)) / 3600 > 24
    ORDER BY at DESC
    LIMIT 15
  `);
  console.log('\n' + '═'.repeat(80));
  console.log('Gaps > 24h entre inserciones (últimos 60 días):');
  console.log('─'.repeat(80));
  console.table(gaps.rows);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

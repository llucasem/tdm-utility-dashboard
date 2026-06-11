/**
 * Phase A — List the ~16 bills with subjects suggesting "real bill"
 * but amount_due is NULL / 0. Likely Claude false negatives.
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
  const r = await pool.query(`
    SELECT id,
           gmail_message_id,
           email_subject,
           email_from,
           utility_type,
           property_address,
           email_received_at::date AS received,
           amount_due
    FROM utility_bills
    WHERE qb_match_status = 'pending'
      AND (amount_due IS NULL OR amount_due <= 0)
      AND (
        LOWER(email_subject) LIKE '%your bill%'
        OR LOWER(email_subject) LIKE '%bill is ready%'
        OR LOWER(email_subject) LIKE '%statement%ready%'
        OR LOWER(email_subject) LIKE '%invoice%'
      )
    ORDER BY email_received_at DESC
  `);

  console.log(`Encontradas: ${r.rows.length} sospechosas de falso negativo de Claude.\n`);
  for (const row of r.rows) {
    console.log(`• id=${row.id} | ${row.received} | ${row.utility_type || '?'} | ${row.email_from}`);
    console.log(`  Subject: ${row.email_subject}`);
    console.log(`  amount_due=${row.amount_due ?? 'NULL'} | property=${row.property_address || '(none)'}`);
    console.log(`  gmail_message_id=${row.gmail_message_id}`);
    console.log('');
  }

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

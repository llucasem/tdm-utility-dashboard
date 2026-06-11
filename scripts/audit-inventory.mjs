/**
 * Phase A — Inventory queries against Neon (read-only).
 *
 * Produces a snapshot of utility_bills state for the audit report.
 *
 * Run with:  node scripts/audit-inventory.mjs
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

const sections = [];
function section(title, rows, note = null) {
  sections.push({ title, rows, note });
}

async function main() {
  console.log('Connecting to Neon…');

  // 1. Total bills by month (anchored on email_received_at)
  const byMonth = await pool.query(`
    SELECT TO_CHAR(date_trunc('month', email_received_at), 'YYYY-MM') AS month,
           COUNT(*)                                                   AS total,
           COUNT(*) FILTER (WHERE amount_due > 0)                     AS positive_amount,
           COUNT(*) FILTER (WHERE amount_due IS NULL OR amount_due <= 0) AS zero_or_null,
           COUNT(*) FILTER (WHERE property_address IS NULL)           AS unassigned
    FROM utility_bills
    WHERE email_received_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  section('1. Facturas por mes (anchored en email_received_at)', byMonth.rows);

  // 2. Distribution by utility_type
  const byType = await pool.query(`
    SELECT utility_type,
           COUNT(*)                                AS total,
           COUNT(*) FILTER (WHERE amount_due > 0)  AS billable,
           COUNT(*) FILTER (WHERE property_address IS NULL) AS unassigned
    FROM utility_bills
    GROUP BY utility_type
    ORDER BY total DESC
  `);
  section('2. Facturas por utility_type', byType.rows);

  // 3. amount_due <= 0 (marked as noise / duplicate / paid confirmation)
  const noise = await pool.query(`
    SELECT qb_match_status,
           COUNT(*) AS count
    FROM utility_bills
    WHERE amount_due IS NULL OR amount_due <= 0
    GROUP BY qb_match_status
    ORDER BY count DESC
  `);
  section('3. Facturas con amount_due <= 0 (noise/duplicate/confirmation)', noise.rows);

  // 4. Unassigned (property_address null)
  const unassigned = await pool.query(`
    SELECT COALESCE(SUBSTRING(email_from FROM '@[^>]+'), '?') AS sender_domain,
           COUNT(*) AS count
    FROM utility_bills
    WHERE property_address IS NULL AND amount_due > 0
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 15
  `);
  section('4. Unassigned (property_address NULL, amount_due > 0) por dominio remitente', unassigned.rows);

  // 5. Duplicates despite UNIQUE constraint
  const dupes = await pool.query(`
    SELECT gmail_message_id, COUNT(*) AS count
    FROM utility_bills
    WHERE gmail_message_id IS NOT NULL
    GROUP BY gmail_message_id
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 10
  `);
  section('5. Duplicados por gmail_message_id (deberían ser 0)', dupes.rows,
    dupes.rows.length === 0 ? 'OK: UNIQUE constraint funcionando' : 'WARN: hay duplicados pese a UNIQUE');

  // 6. Backlog: pending older than 7 days
  const backlog = await pool.query(`
    SELECT TO_CHAR(date_trunc('week', email_received_at), 'YYYY-MM-DD') AS week,
           COUNT(*) AS pending_count
    FROM utility_bills
    WHERE qb_match_status = 'pending'
      AND amount_due > 0
      AND email_received_at < NOW() - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 12
  `);
  section('6. Backlog: bills pending > 7 días por semana', backlog.rows,
    backlog.rows.length === 0 ? 'OK: no hay backlog' : 'WARN: bills atascadas en pending');

  // Bonus: global qb_match_status + qb_tag_status distribution (informational)
  const matchStatus = await pool.query(`
    SELECT qb_match_status, COUNT(*) AS count
    FROM utility_bills
    WHERE amount_due > 0
    GROUP BY qb_match_status
    ORDER BY count DESC
  `);
  section('7. Distribución qb_match_status (solo bills facturables)', matchStatus.rows);

  const tagStatus = await pool.query(`
    SELECT qb_tag_status, COUNT(*) AS count
    FROM utility_bills
    WHERE amount_due > 0
    GROUP BY qb_tag_status
    ORDER BY count DESC
  `);
  section('8. Distribución qb_tag_status (solo bills facturables)', tagStatus.rows);

  // Print
  for (const { title, rows, note } of sections) {
    console.log('\n' + '═'.repeat(80));
    console.log(title);
    console.log('─'.repeat(80));
    if (rows.length === 0) {
      console.log('  (sin filas)');
    } else {
      console.table(rows);
    }
    if (note) console.log('→ ' + note);
  }

  await pool.end();
  console.log('\nInventario completo.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

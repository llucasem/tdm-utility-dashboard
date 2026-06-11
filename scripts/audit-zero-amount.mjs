/**
 * Phase A — Diagnose 440 bills with amount_due <= 0 in state 'pending'.
 *
 * Goal: distinguish (a) skipped confirmations that bypassed pre-filter
 * from (b) real bills where Claude failed to extract amount.
 *
 * Run with:  node scripts/audit-zero-amount.mjs
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
  // Group by subject pattern to see what dominates
  const bySubject = await pool.query(`
    WITH zeroes AS (
      SELECT email_subject, email_from, utility_type
      FROM utility_bills
      WHERE qb_match_status = 'pending' AND (amount_due IS NULL OR amount_due <= 0)
    )
    SELECT
      CASE
        WHEN LOWER(email_subject) LIKE '%payment is scheduled%' THEN 'payment scheduled'
        WHEN LOWER(email_subject) LIKE '%thanks for paying%' THEN 'thanks for paying'
        WHEN LOWER(email_subject) LIKE '%thank you for your payment%' THEN 'thank you for payment'
        WHEN LOWER(email_subject) LIKE '%received your payment%' THEN 'received your payment'
        WHEN LOWER(email_subject) LIKE '%autopay%' THEN 'autopay'
        WHEN LOWER(email_subject) LIKE '%payment received%' THEN 'payment received'
        WHEN LOWER(email_subject) LIKE '%bill is ready%' OR LOWER(email_subject) LIKE '%statement%ready%' THEN 'bill/statement ready (REAL BILL — parser failed?)'
        WHEN LOWER(email_subject) LIKE '%your bill%' THEN 'your bill (REAL BILL — parser failed?)'
        WHEN LOWER(email_subject) LIKE '%invoice%' THEN 'invoice (REAL BILL — parser failed?)'
        WHEN LOWER(email_subject) LIKE '%survey%' OR LOWER(email_subject) LIKE '%feedback%' THEN 'survey/feedback'
        WHEN LOWER(email_subject) LIKE '%get internet%' OR LOWER(email_subject) LIKE '%speed%' THEN 'marketing/upsell'
        WHEN LOWER(email_subject) LIKE '%paperless%' OR LOWER(email_subject) LIKE '%go green%' THEN 'paperless promo'
        WHEN LOWER(email_subject) LIKE '%credit%' OR LOWER(email_subject) LIKE '%refund%' THEN 'credit/refund (not billable)'
        ELSE 'other'
      END AS category,
      COUNT(*) AS count
    FROM zeroes
    GROUP BY 1
    ORDER BY count DESC
  `);

  console.log('═'.repeat(80));
  console.log('Bills pending + amount_due <= 0 — clasificación por subject');
  console.log('─'.repeat(80));
  console.table(bySubject.rows);

  // Top 20 distinct subjects in the "other" bucket
  const otherSubjects = await pool.query(`
    SELECT email_subject, COUNT(*) AS count
    FROM utility_bills
    WHERE qb_match_status = 'pending'
      AND (amount_due IS NULL OR amount_due <= 0)
      AND LOWER(email_subject) NOT LIKE '%payment is scheduled%'
      AND LOWER(email_subject) NOT LIKE '%thanks for paying%'
      AND LOWER(email_subject) NOT LIKE '%thank you for your payment%'
      AND LOWER(email_subject) NOT LIKE '%received your payment%'
      AND LOWER(email_subject) NOT LIKE '%autopay%'
      AND LOWER(email_subject) NOT LIKE '%payment received%'
      AND LOWER(email_subject) NOT LIKE '%bill is ready%'
      AND LOWER(email_subject) NOT LIKE '%statement%ready%'
      AND LOWER(email_subject) NOT LIKE '%your bill%'
      AND LOWER(email_subject) NOT LIKE '%invoice%'
      AND LOWER(email_subject) NOT LIKE '%survey%'
      AND LOWER(email_subject) NOT LIKE '%feedback%'
      AND LOWER(email_subject) NOT LIKE '%get internet%'
      AND LOWER(email_subject) NOT LIKE '%speed%'
      AND LOWER(email_subject) NOT LIKE '%paperless%'
      AND LOWER(email_subject) NOT LIKE '%go green%'
      AND LOWER(email_subject) NOT LIKE '%credit%'
      AND LOWER(email_subject) NOT LIKE '%refund%'
    GROUP BY email_subject
    ORDER BY count DESC
    LIMIT 25
  `);

  console.log('\n' + '═'.repeat(80));
  console.log('Top 25 subjects en la categoría "other" (sin clasificar)');
  console.log('─'.repeat(80));
  console.table(otherSubjects.rows);

  // Top senders
  const bySender = await pool.query(`
    SELECT
      COALESCE(REGEXP_REPLACE(email_from, '^.*<([^>]+)>$', '\\1'), email_from) AS sender,
      COUNT(*) AS count
    FROM utility_bills
    WHERE qb_match_status = 'pending' AND (amount_due IS NULL OR amount_due <= 0)
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 15
  `);

  console.log('\n' + '═'.repeat(80));
  console.log('Top remitentes de bills sin importe');
  console.log('─'.repeat(80));
  console.table(bySender.rows);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

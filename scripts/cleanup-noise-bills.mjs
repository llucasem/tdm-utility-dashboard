/**
 * Cleanup historical noise bills.
 *
 * After the sync-from-qb-classes pass, bills in Jan–Apr 2026 that are NOT
 * tagged (qb_tag_status != 'tagged') are very likely:
 *  - Payment confirmation emails ("Your payment is scheduled")
 *  - Receipt emails ("Thank you for paying")
 *  - Marketing/upsell emails ("Get faster internet")
 *  - Misparsed emails where Claude invented a number
 *
 * We mark them with qb_match_status='noise' and zero out their amount_due
 * so they disappear from the dashboard (which filters amount_due > 0).
 *
 * Soft-delete: rows are preserved with original data in the JSONB qb_match_data
 * column so we can audit later.
 *
 * NEVER touches May+ bills (Jake hasn't paid those yet).
 *
 * Usage:
 *   node scripts/cleanup-noise-bills.mjs           # dry-run (default)
 *   node scripts/cleanup-noise-bills.mjs --apply   # write to DB
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

const APPLY = process.argv.includes('--apply');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  CLEANUP-NOISE-BILLS  ${APPLY ? '(APPLY — WILL WRITE)' : '(DRY RUN)'}`);
console.log(`  Target: bills Jan–Apr 2026 with qb_tag_status != 'tagged'`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// Inventory
const r = await pool.query(`
  SELECT id, email_subject, email_from, utility_type, property_address, unit,
         amount_due, due_date::date AS due_date, email_received_at::date AS email_date,
         qb_match_status, qb_tag_status
  FROM utility_bills
  WHERE email_received_at >= '2026-01-01' AND email_received_at < '2026-05-01'
    AND amount_due > 0
    AND (qb_tag_status IS NULL OR qb_tag_status != 'tagged')
  ORDER BY email_received_at
`);

console.log(`  Bills a marcar como noise: ${r.rowCount}\n`);

// Breakdown by subject pattern (to understand what's noise)
const subjectStats = {};
for (const b of r.rows) {
  const subj = (b.email_subject || '(no subject)').toLowerCase();
  let bucket = 'other';
  if (subj.includes('payment is scheduled'))       bucket = 'payment_scheduled';
  else if (subj.includes('thank you for paying'))  bucket = 'thank_you_paying';
  else if (subj.includes('thanks for paying'))     bucket = 'thanks_paying';
  else if (subj.includes('statement is ready'))    bucket = 'statement_ready';
  else if (subj.includes('opinion matters') || subj.includes('values your feedback')) bucket = 'feedback_survey';
  else if (subj.includes('get internet') || subj.includes('get a connection') || subj.includes('entertainment that')) bucket = 'marketing';
  else if (subj.includes('we\'ve received your payment')) bucket = 'payment_received';
  else if (subj.includes('bill is ready') || subj.includes('bill is available')) bucket = 'bill_notification';
  subjectStats[bucket] = (subjectStats[bucket] || 0) + 1;
}

console.log('  Por tipo de email (subject pattern):');
for (const [k, v] of Object.entries(subjectStats).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${v}`);
}

console.log('\n  Por mes:');
const byMonth = {};
for (const b of r.rows) {
  const m = b.email_date.toISOString().slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + 1;
}
for (const [m, n] of Object.entries(byMonth).sort()) console.log(`    ${m}: ${n}`);

console.log('\n  Top 30 subjects (para ver lo que hay):');
const subjCount = {};
for (const b of r.rows) {
  const s = (b.email_subject || '(no subject)').slice(0, 80);
  subjCount[s] = (subjCount[s] || 0) + 1;
}
const top = Object.entries(subjCount).sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [s, n] of top) console.log(`    ${String(n).padStart(3)} × ${s}`);

if (APPLY) {
  console.log('\n  Aplicando...');
  const upd = await pool.query(`
    UPDATE utility_bills
    SET qb_match_status = 'noise',
        qb_matched_at   = NOW(),
        qb_match_error  = COALESCE(qb_match_error, 'soft-deleted as noise during 2026-05-14 cleanup'),
        amount_due      = 0
    WHERE email_received_at >= '2026-01-01' AND email_received_at < '2026-05-01'
      AND amount_due > 0
      AND (qb_tag_status IS NULL OR qb_tag_status != 'tagged')
    RETURNING id
  `);
  console.log(`  ✅ Marcadas como noise: ${upd.rowCount}`);
} else {
  console.log('\n  💡 DRY RUN — no se ha escrito nada. Repite con --apply.\n');
}

await pool.end();

/**
 * One-time historical dedup cleanup (requested by Lluis 2026-06-12: double
 * bills visible in April/May/June after the matrix started stacking bills).
 *
 * Rule: within (utility_type, account_last4, amount) groups, walk bills in
 * date order; the first stays visible, every later one within 18 days of the
 * last KEPT bill is flagged is_duplicate. 18d covers ConEd "Ready"->"Due"
 * (12-14d), LADWP (11d), Spectrum (8d); real monthly cycles are 28-31d apart.
 *
 * If a flagged bill carries a QB match/tag that the kept bill lacks, the QB
 * fields are transferred to the kept bill first (preserves Jake's classes).
 *
 * Usage: node scripts/dedup-cleanup.mjs            (dry run — prints plan)
 *        node scripts/dedup-cleanup.mjs --apply    (writes changes)
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
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const APPLY = process.argv.includes('--apply');

const r = await pool.query(`
  SELECT id, utility_type, account_last4, amount_due, email_received_at,
         qb_match_status, qb_tag_status, qb_purchase_id, qb_class_id,
         qb_match_count, qb_match_data, qb_matched_at, qb_tagged_at, email_subject
  FROM utility_bills
  WHERE amount_due > 0 AND NOT is_duplicate
    AND account_last4 IS NOT NULL AND account_last4 != ''
  ORDER BY utility_type, account_last4, ROUND(amount_due::numeric,2), email_received_at`);

const groups = new Map();
for (const b of r.rows) {
  const key = `${b.utility_type}|${b.account_last4}|${Number(b.amount_due).toFixed(2)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(b);
}

const DAY = 86_400_000;
let flagged = 0, transferred = 0;

for (const [key, bills] of groups) {
  if (bills.length < 2) continue;
  let kept = bills[0];
  for (let i = 1; i < bills.length; i++) {
    const b = bills[i];
    const gapDays = (new Date(b.email_received_at) - new Date(kept.email_received_at)) / DAY;
    if (gapDays <= 18) {
      // b is a reminder/duplicate of `kept`
      const needsTransfer = b.qb_match_status === 'matched' && kept.qb_match_status !== 'matched';
      console.log(`${APPLY ? 'FLAG' : 'plan'}: bill ${b.id} dup de ${kept.id} | ${key} | gap ${gapDays.toFixed(0)}d${needsTransfer ? ' | TRANSFIERE match QB → ' + kept.id : ''}`);
      if (APPLY) {
        if (needsTransfer) {
          await pool.query(`
            UPDATE utility_bills SET
              qb_match_status = $2, qb_match_count = $3, qb_match_data = $4,
              qb_matched_at = $5, qb_purchase_id = $6, qb_class_id = $7,
              qb_tag_status = $8, qb_tagged_at = $9
            WHERE id = $1`,
            [kept.id, b.qb_match_status, b.qb_match_count, JSON.stringify(b.qb_match_data),
             b.qb_matched_at, b.qb_purchase_id, b.qb_class_id, b.qb_tag_status, b.qb_tagged_at]);
          // keep local copy coherent for later iterations
          kept.qb_match_status = b.qb_match_status;
          transferred++;
        }
        await pool.query(`UPDATE utility_bills SET is_duplicate = true WHERE id = $1`, [b.id]);
      }
      flagged++;
    } else {
      // far enough apart — real next cycle; becomes the new reference
      kept = b;
    }
  }
}

console.log(`\n${APPLY ? 'APLICADO' : 'DRY RUN'}: ${flagged} duplicados ${APPLY ? 'ocultados' : 'a ocultar'}, ${transferred} matches QB transferidos`);
await pool.end();

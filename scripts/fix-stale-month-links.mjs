/**
 * Demote bills linked to a Purchase from a PREVIOUS billing cycle.
 *
 * Pattern detected: Spectrum autopay charges happen ~mid-month, then the
 * "Statement is Ready" email arrives weeks later for the NEXT cycle. Our
 * sync-from-qb-classes (with ±30 day window) was greedy and linked the
 * may bill to the april Purchase when only the april Purchase had Class.
 *
 * Heuristic: if email_received_at - Purchase.TxnDate > 10 days, the
 * Purchase is for an earlier billing cycle. Demote the bill.
 *
 * Read-only QB. Writes to utility_bills.
 *
 * Run:
 *   node scripts/fix-stale-month-links.mjs            # dry-run
 *   node scripts/fix-stale-month-links.mjs --apply    # write
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
const THRESHOLD_DAYS = 10;
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  FIX-STALE-MONTH-LINKS  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
console.log(`  Threshold: |email_received - Purchase.TxnDate| > ${THRESHOLD_DAYS} days`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

const r = await pool.query(`
  SELECT id, property_address, unit, amount_due,
         email_received_at::date::text AS e,
         (qb_match_data->0->>'date') AS p_date,
         (qb_match_data->0->>'payee') AS payee,
         (email_received_at::date - (qb_match_data->0->>'date')::date) AS days_diff
  FROM utility_bills
  WHERE qb_match_status = 'matched'
    AND qb_match_data IS NOT NULL
    AND amount_due > 0
    AND (email_received_at::date - (qb_match_data->0->>'date')::date) > $1
  ORDER BY (email_received_at::date - (qb_match_data->0->>'date')::date) DESC
`, [THRESHOLD_DAYS]);

console.log(`  Bills mal-linkadas (Purchase es de cycle previo):  ${r.rowCount}\n`);
for (const b of r.rows) {
  console.log(`    #${b.id} | ${b.days_diff}d gap | email ${b.e} → Purchase ${b.p_date} | ${b.property_address.slice(0,30)} u=${b.unit} | $${b.amount_due} | ${b.payee}`);
}

if (APPLY && r.rowCount > 0) {
  const ids = r.rows.map(b => b.id);
  const upd = await pool.query(`
    UPDATE utility_bills
    SET qb_match_status = 'pending',
        qb_match_count  = 0,
        qb_match_data   = NULL,
        qb_matched_at   = NOW(),
        qb_tag_status   = 'pending',
        qb_purchase_id  = NULL,
        qb_class_id     = NULL,
        qb_tagged_at    = NULL,
        qb_match_error  = 'demoted: Purchase from prior billing cycle (gap > ${THRESHOLD_DAYS}d)'
    WHERE id = ANY($1::int[])
    RETURNING id
  `, [ids]);
  console.log(`\n  ✅ Demoted ${upd.rowCount} bills. Will re-evaluate on next cron with the new logic.`);
} else if (!APPLY) {
  console.log('\n  💡 DRY RUN — repite con --apply.\n');
}

await pool.end();

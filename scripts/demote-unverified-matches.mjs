/**
 * Phase B — Demote unverified matches.
 *
 * Bills currently marked 'matched' but never tag-verified by Jake (qb_tag_status
 * != 'tagged') get demoted to 'pending'. The next cron run re-evaluates them
 * with the new logic (claim filter + bill-purchase exclusivity + historical
 * disambiguation). False positives like the old Yaritza/Spectrum collision
 * will fall to 'not_found' until Jake actually pays.
 *
 * Safety:
 *   - Only touches bills with amount_due > 0 (skips noise)
 *   - Only touches bills NOT in qb_tag_status='tagged' (skips Jake-verified)
 *   - Resets qb_match_data so the next match starts clean
 *
 * Dry-run por defecto. --apply para escribir.
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
console.log(`  DEMOTE-UNVERIFIED-MATCHES  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

const r = await pool.query(`
  SELECT id, property_address, unit, amount_due, due_date,
         qb_match_status, qb_tag_status
  FROM utility_bills
  WHERE qb_match_status = 'matched'
    AND (qb_tag_status IS NULL OR qb_tag_status != 'tagged')
    AND amount_due > 0
  ORDER BY id
`);

console.log(`  Bills 'matched' sin 'tagged' verification: ${r.rowCount}\n`);

const byMonth = {};
for (const b of r.rows) {
  const m = (b.due_date || new Date()).toISOString().slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + 1;
}
console.log('  Por mes:');
for (const [m, n] of Object.entries(byMonth).sort()) console.log(`    ${m}: ${n}`);

if (APPLY) {
  const upd = await pool.query(`
    UPDATE utility_bills
    SET qb_match_status = 'pending',
        qb_match_count  = 0,
        qb_match_data   = NULL,
        qb_matched_at   = NOW(),
        qb_match_error  = 'demoted: not verified by Jake — will re-evaluate on next cron'
    WHERE qb_match_status = 'matched'
      AND (qb_tag_status IS NULL OR qb_tag_status != 'tagged')
      AND amount_due > 0
    RETURNING id
  `);
  console.log(`\n  ✅ Demoted ${upd.rowCount} bills to 'pending'.`);
  console.log(`  → Próximo cron (02:00 UTC) las re-evaluará con la nueva lógica.`);
} else {
  console.log('\n  💡 DRY RUN — repite con --apply.\n');
}

await pool.end();

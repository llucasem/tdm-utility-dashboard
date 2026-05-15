/**
 * Consolida bills duplicadas — múltiples emails de la misma factura.
 *
 * Spectrum (y otros) mandan varios emails para la misma factura:
 *   - "Your Payment Is Scheduled Soon"
 *   - "Your Spectrum Statement is Ready"
 *   - "Autopay was successful"
 * Cada uno tiene su gmail_message_id, así que nuestro sync los inserta como
 * bills distintas a pesar de que conceptualmente son la misma factura.
 *
 * Criterio de duplicado: mismo property+unit+amount+due_date+utility_type.
 * Estrategia: keep canonical (id menor), marcar el resto como noise.
 *
 * Read-only por defecto, --apply para escribir.
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
console.log(`  DEDUP-BILLS  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// Find duplicate groups by content
const r = await pool.query(`
  SELECT property_address, COALESCE(unit, '') AS unit, amount_due, due_date,
         utility_type, COUNT(*)::int AS n, array_agg(id ORDER BY id) AS ids
  FROM utility_bills
  WHERE amount_due > 0
  GROUP BY 1, 2, 3, 4, 5
  HAVING COUNT(*) > 1
  ORDER BY n DESC, property_address
`);

console.log(`  Duplicate groups found: ${r.rowCount}`);
let toMark = 0;
const idsToMark = [];
for (const group of r.rows) {
  const [canonical, ...duplicates] = group.ids;
  toMark += duplicates.length;
  idsToMark.push(...duplicates);
}
console.log(`  Total extras (will keep ${r.rowCount} canonical, mark ${toMark} as duplicate)\n`);

if (APPLY && idsToMark.length > 0) {
  const upd = await pool.query(`
    UPDATE utility_bills
    SET qb_match_status = 'duplicate',
        qb_matched_at   = NOW(),
        qb_match_error  = 'duplicate: same bill in another row (kept canonical)',
        amount_due      = 0
    WHERE id = ANY($1::int[])
    RETURNING id
  `, [idsToMark]);
  console.log(`  ✅ Marked ${upd.rowCount} bills as 'duplicate' (amount_due zeroed).`);
} else if (!APPLY) {
  console.log('  💡 DRY RUN — repite con --apply para aplicar.');
}

await pool.end();

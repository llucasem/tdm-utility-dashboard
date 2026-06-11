/**
 * Data fixes confirmed by Lluis on 2026-06-11 (Jake's May complaints).
 * Source of truth: "Utilities backup - Sheet1.csv" (Jake's own account list)
 * and Jake's WhatsApp lists.
 *
 *  1. LADWP account ····9589 → 939 S Broadway unit 508 (Jake's list)
 *  2. Address variant unification (same building split into 2 matrix rows):
 *       "939 S Broadway, Los Angeles CA 90015"        → with comma
 *       "3221 Carter Avenue, …"                       → "3221 Carter Ave, …"
 *       "472/474/478 9th Ave New York, NY 10018"      → with comma
 *  3. ConEd account ····7417 was wrongly mapped to 472 9th Ave unit 3.
 *     Per CSV: unit 3 belongs to ····9289; the other unit at 472 is unit 2
 *     (old account ····3643, replaced — same pattern as 0780→7235 at 478).
 *     → remap 7417 to unit 2 and fix its bills. Flagged for Jake to confirm.
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

// ── 1. Broadway 508 ─────────────────────────────────────────────────────
await pool.query(`
  INSERT INTO account_mappings (utility_type, account_last4, property_address, unit)
  VALUES ('electricity', '9589', '939 S Broadway, Los Angeles, CA 90015', '508')
  ON CONFLICT DO NOTHING`);
const u1 = await pool.query(`
  UPDATE utility_bills
  SET property_address = '939 S Broadway, Los Angeles, CA 90015', unit = '508'
  WHERE account_last4 = '9589' AND utility_type = 'electricity' AND property_address IS NULL`);
console.log(`1. Broadway 508: mapping creado, ${u1.rowCount} bill(s) asignadas`);

// ── 2. Unificación de variantes de dirección ────────────────────────────
const FIXES = [
  ['939 S Broadway, Los Angeles CA 90015',          '939 S Broadway, Los Angeles, CA 90015'],
  ['3221 Carter Avenue, Marina Del Rey, CA 90292',  '3221 Carter Ave, Marina Del Rey, CA 90292'],
  ['472 9th Ave New York, NY 10018',                '472 9th Ave, New York, NY 10018'],
  ['474 9th Ave New York, NY 10018',                '474 9th Ave, New York, NY 10018'],
  ['478 9th Ave New York, NY 10018',                '478 9th Ave, New York, NY 10018'],
];
for (const [oldA, newA] of FIXES) {
  const a = await pool.query(`UPDATE utility_bills SET property_address = $2 WHERE property_address = $1`, [oldA, newA]);
  const b = await pool.query(`UPDATE account_mappings SET property_address = $2 WHERE property_address = $1`, [oldA, newA]);
  if (a.rowCount || b.rowCount) console.log(`2. "${oldA}" → "${newA}": ${a.rowCount} bills, ${b.rowCount} mappings`);
}

// ── 3. ConEd 472 9th Ave: ····9289 → unit 2 (APLICADO 2026-06-11) ────────
// La fuente definitiva fueron las Classes que Jake asigna en QuickBooks:
//   ····7417 → "472 9th #3" (ene-may, consistente) → unit 3, no tocar
//   ····9289 → "472 9th #2" ($355.14)              → unit 2 ← corregido
// El CSV "Utilities backup" decía 9289=unit 3 pero estaba DESACTUALIZADO.
// El fix se aplicó directamente (mapping + 13 filas). Este bloque queda
// documentado a propósito; no hay nada más que ejecutar.

// ── Verificación final ──────────────────────────────────────────────────
const v = await pool.query(`
  SELECT property_address, unit, account_last4, COUNT(*) AS n
  FROM utility_bills
  WHERE property_address ILIKE '%9th Ave%' AND utility_type = 'electricity' AND amount_due > 0
  GROUP BY 1,2,3 ORDER BY 1,2`);
console.log('\nVerificación 9th Ave (electricidad):');
for (const x of v.rows) console.log(`  ${x.property_address} | u=${x.unit} | ····${x.account_last4} | ${x.n} bills`);

const v2 = await pool.query(`
  SELECT property_address, COUNT(*) AS n FROM utility_bills
  WHERE property_address ILIKE '%broadway%' OR property_address ILIKE '%carter%'
  GROUP BY 1 ORDER BY 1`);
console.log('\nVerificación variantes Broadway/Carter:');
for (const x of v2.rows) console.log(`  ${x.n}  ${x.property_address}`);

await pool.end();

/**
 * Normaliza todos los units a UPPERCASE para evitar duplicados como "3D"/"3d".
 *
 * Toca dos tablas:
 *   - utility_bills.unit       → UPPER(unit) si contiene letras minúsculas
 *   - property_qb_class.unit   → consolidar duplicados case-insensitive
 *
 * Idempotente, dry-run por defecto, --apply para escribir.
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
console.log(`  NORMALIZE-UNITS  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// ── 1. Detect property_qb_class duplicate pairs ──────────────────────────
const dups = await pool.query(`
  SELECT
    property_address,
    UPPER(COALESCE(unit, '')) AS canonical_unit,
    COUNT(*) AS n,
    array_agg(unit ORDER BY unit) AS unit_variants,
    array_agg(id ORDER BY unit) AS ids,
    array_agg(qb_class_name ORDER BY unit) AS classes
  FROM property_qb_class
  GROUP BY property_address, UPPER(COALESCE(unit, ''))
  HAVING COUNT(*) > 1
`);

console.log(`  property_qb_class duplicate pairs: ${dups.rowCount}`);
for (const r of dups.rows) {
  console.log(`    "${r.property_address.slice(0, 35)}" variants ${JSON.stringify(r.unit_variants)} → classes ${JSON.stringify(r.classes)}`);
}

// ── 2. Detect bills with lowercase letters in unit ──────────────────────
const billsToNormalize = await pool.query(`
  SELECT id, unit FROM utility_bills
  WHERE unit ~ '[a-z]' AND amount_due > 0
`);
console.log(`\n  utility_bills con minúsculas en unit: ${billsToNormalize.rowCount}`);
const sampleBills = {};
for (const b of billsToNormalize.rows) {
  sampleBills[b.unit] = (sampleBills[b.unit] || 0) + 1;
}
console.log('  Variantes minúsculas (top 10):');
for (const [u, n] of Object.entries(sampleBills).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    "${u}" → "${u.toUpperCase()}" (${n} bills)`);
}

if (APPLY) {
  console.log('\n  Applying...');

  // 2a. Delete lowercase duplicates from property_qb_class (keep the one
  //     whose unit has more uppercase letters)
  for (const r of dups.rows) {
    const variants = r.unit_variants;
    // Pick the canonical: prefer the one with more uppercase letters
    let canonical = variants[0];
    let canonicalScore = (canonical || '').replace(/[^A-Z]/g, '').length;
    for (const v of variants.slice(1)) {
      const s = (v || '').replace(/[^A-Z]/g, '').length;
      if (s > canonicalScore) { canonical = v; canonicalScore = s; }
    }
    // Delete the non-canonical entries
    const toDelete = variants.filter(v => v !== canonical);
    for (const u of toDelete) {
      await pool.query(
        `DELETE FROM property_qb_class WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')`,
        [r.property_address, u]
      );
      console.log(`    DELETED duplicate "${r.property_address.slice(0,30)}" unit="${u}" (kept "${canonical}")`);
    }
    // Normalize the canonical to uppercase if it has lowercase
    if (canonical && canonical !== canonical.toUpperCase()) {
      await pool.query(
        `UPDATE property_qb_class SET unit = $3, updated_at = NOW()
         WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')`,
        [r.property_address, canonical, canonical.toUpperCase()]
      );
      console.log(`    UPDATED canonical "${canonical}" → "${canonical.toUpperCase()}"`);
    }
  }

  // 2b. Also normalize remaining single-row units that are lowercase
  const singletonNormalize = await pool.query(`
    UPDATE property_qb_class
    SET unit = UPPER(unit), updated_at = NOW()
    WHERE unit ~ '[a-z]'
      AND NOT EXISTS (
        SELECT 1 FROM property_qb_class p2
        WHERE p2.property_address = property_qb_class.property_address
          AND p2.unit = UPPER(property_qb_class.unit)
          AND p2.id != property_qb_class.id
      )
    RETURNING id
  `);
  console.log(`    Normalized ${singletonNormalize.rowCount} additional singleton property_qb_class units to UPPER`);

  // 2c. Update utility_bills units to UPPER
  const billsUpd = await pool.query(`
    UPDATE utility_bills
    SET unit = UPPER(unit)
    WHERE unit ~ '[a-z]'
    RETURNING id
  `);
  console.log(`    Normalized ${billsUpd.rowCount} utility_bills units to UPPER`);
} else {
  console.log('\n  💡 DRY RUN — repite con --apply para aplicar.');
}

await pool.end();

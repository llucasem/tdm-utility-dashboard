/**
 * Después de ejecutar normalize-addresses.mjs:
 *   1. Re-verifica los 8 grupos duplicados de mayo
 *   2. Resuelve el caso "360 W PICO RD" (mayúsculas)
 *   3. Lista propiedades sin factura de internet en mayo (para identificar la 296)
 *
 * Read+modify (solo el fix de mayúsculas si Lluis confirma).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

function normAddr(addr) {
  if (!addr) return '';
  return addr.toLowerCase()
    .split(',')[0].trim()
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\blane\b/g, 'ln')
    .replace(/\s+/g, ' ');
}
function normUnit(u) {
  return (u || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim();
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Re-auditoría mayo 2026 tras normalize-addresses');
console.log('═══════════════════════════════════════════════════════════\n');

// ── 1) Re-verificar duplicados ───────────────────────────────────────────────
const bills = await pool.query(`
  SELECT id, utility_type, property_address, unit, account_last4, amount_due, email_received_at
  FROM utility_bills
  WHERE amount_due > 0
    AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
  ORDER BY email_received_at
`);

const byNorm = new Map();
for (const b of bills.rows) {
  if (!b.property_address) continue;
  const key = normAddr(b.property_address) + '|' + normUnit(b.unit);
  if (!byNorm.has(key)) byNorm.set(key, []);
  byNorm.get(key).push(b);
}

const duplicates = [];
for (const [key, list] of byNorm.entries()) {
  const distinct = new Set(list.map(b => (b.property_address || '') + '|' + (b.unit || '')));
  if (distinct.size > 1) duplicates.push({ key, variants: [...distinct], list });
}

console.log(`1) Duplicados restantes: ${duplicates.length}\n`);
for (const dup of duplicates) {
  console.log(`  Grupo "${dup.key}":`);
  for (const v of dup.variants) {
    const [addr, unit] = v.split('|');
    const billsForVariant = dup.list.filter(b => (b.property_address || '') === addr && (b.unit || '') === unit);
    console.log(`    "${addr}" unit="${unit}"  (${billsForVariant.length} bills)`);
    for (const b of billsForVariant) {
      console.log(`      Bill #${b.id}  ${b.utility_type}  $${b.amount_due}  recv=${b.email_received_at?.toISOString().slice(0,10)}  acct ····${b.account_last4 || '?'}`);
    }
  }
  console.log('');
}

// ── 2) Fix manual del caso mayúsculas "360 W PICO RD" ────────────────────────
const upperCase = await pool.query(`
  SELECT id, property_address, unit, utility_type, amount_due, account_last4
  FROM utility_bills
  WHERE property_address = property_address
    AND property_address <> '' AND property_address ~ '^[A-Z0-9 ]+$'
`);
console.log(`2) Direcciones en MAYÚSCULAS (formato no canónico): ${upperCase.rows.length}`);
for (const r of upperCase.rows) {
  console.log(`    Bill #${r.id}  "${r.property_address}"  unit="${r.unit || ''}"  ${r.utility_type} $${r.amount_due} acct ····${r.account_last4 || '?'}`);
}

// Look up canonical (proper case) version for "360 W Pico Rd" in account_mappings or utility_bills
const canonicalProbe = await pool.query(`
  SELECT DISTINCT property_address, unit, COUNT(*) AS uses
  FROM utility_bills
  WHERE LOWER(property_address) LIKE '360 w pico%'
    AND property_address !~ '^[A-Z0-9 ]+$'
  GROUP BY property_address, unit
  ORDER BY uses DESC
  LIMIT 3
`);
console.log(`\n   Versiones canónicas de "360 W Pico" disponibles:`);
for (const r of canonicalProbe.rows) {
  console.log(`    "${r.property_address}"  unit="${r.unit || ''}"  (${r.uses} bills)`);
}

if (upperCase.rows.length > 0 && canonicalProbe.rows.length > 0) {
  const canonical = canonicalProbe.rows[0].property_address;
  const canonicalUnit = canonicalProbe.rows[0].unit;
  console.log(`\n   Aplicando fix: "${upperCase.rows[0].property_address}" → "${canonical}"`);
  const r = await pool.query(
    `UPDATE utility_bills SET property_address = $1, unit = COALESCE(NULLIF(TRIM(unit), ''), $2) WHERE id = ANY($3::int[])`,
    [canonical, canonicalUnit, upperCase.rows.map(r => r.id)]
  );
  console.log(`   ✓ ${r.rowCount} bills actualizadas`);
}

// ── 3) Propiedades SIN factura de internet en mayo ───────────────────────────
console.log('\n3) Propiedades con bills facturables en mayo y su cobertura de internet\n');

// Get all distinct property+unit combos with any bill in May
const allProps = await pool.query(`
  SELECT property_address, unit,
         COUNT(*) FILTER (WHERE utility_type = 'internet')    AS internet,
         COUNT(*) FILTER (WHERE utility_type = 'electricity') AS electricity,
         COUNT(*) FILTER (WHERE utility_type = 'gas')         AS gas,
         COUNT(*) FILTER (WHERE utility_type = 'water')       AS water,
         COUNT(*)                                              AS total
  FROM utility_bills
  WHERE amount_due > 0
    AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
    AND property_address IS NOT NULL
  GROUP BY property_address, unit
  ORDER BY property_address, unit
`);

const noInternet = [];
for (const p of allProps.rows) {
  if (Number(p.internet) === 0) noInternet.push(p);
}

console.log(`   Total propiedades con bills en mayo: ${allProps.rows.length}`);
console.log(`   SIN factura de internet en mayo:    ${noInternet.length}\n`);

if (noInternet.length > 0) {
  console.log('   Propiedades sin internet en mayo (Jake dijo: todas menos "la 296" deberían tener):');
  for (const p of noInternet) {
    const parts = [];
    if (Number(p.electricity)) parts.push(`elec×${p.electricity}`);
    if (Number(p.gas))         parts.push(`gas×${p.gas}`);
    if (Number(p.water))       parts.push(`water×${p.water}`);
    console.log(`     "${p.property_address}" unit="${p.unit || ''}"  → ${parts.join(', ') || 'solo otros'}`);
  }
}

await pool.end();

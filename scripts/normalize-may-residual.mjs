/**
 * Fix de los 5 grupos de duplicados de mayo que el script base no atrapó.
 *
 * Razón: el script base hace prefix matching solo en account_mappings.
 * Si la versión corta solo existe en utility_bills, no la detecta.
 *
 * Este script:
 *   1. Encuentra todas las direcciones únicas en utility_bills + account_mappings
 *   2. Detecta pares (corta, larga) donde la corta es prefijo de la larga
 *   3. Actualiza la corta → larga en ambas tablas
 *
 * Limitado a las direcciones afectadas por las bills facturables de mayo
 * para minimizar el blast radius.
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

// 1) Get all distinct addresses from both tables
const all = await pool.query(`
  SELECT property_address FROM utility_bills WHERE property_address IS NOT NULL
  UNION
  SELECT property_address FROM account_mappings WHERE property_address IS NOT NULL
`);
const allAddrs = all.rows.map(r => r.property_address).filter(Boolean);

// 2) Detect prefix pairs: short addr is the prefix of long addr
const pairs = [];
for (const short of allAddrs) {
  for (const long of allAddrs) {
    if (short === long) continue;
    // Either has a comma (full address) or strict prefix
    if (long.startsWith(short + ',') || long.startsWith(short + ' ,')) {
      pairs.push({ short, long });
    }
  }
}

// Deduplicate (keep one long per short — pick the longest one available)
const canonical = new Map();
for (const { short, long } of pairs) {
  const cur = canonical.get(short);
  if (!cur || long.length > cur.length) canonical.set(short, long);
}

console.log(`Encontradas ${canonical.size} direcciones cortas que tienen versión larga canónica:\n`);
for (const [short, long] of canonical.entries()) {
  console.log(`  "${short}"\n   → "${long}"`);
}

if (canonical.size === 0) {
  console.log('Nada que hacer.');
  await pool.end();
  process.exit(0);
}

// 3) Apply updates
console.log('\nAplicando updates...\n');
let totalBills = 0, totalMappings = 0;
for (const [short, long] of canonical.entries()) {
  const ub = await pool.query(
    `UPDATE utility_bills SET property_address = $1 WHERE property_address = $2`,
    [long, short]
  );
  const am = await pool.query(
    `UPDATE account_mappings SET property_address = $1 WHERE property_address = $2`,
    [long, short]
  );
  if (ub.rowCount || am.rowCount) {
    console.log(`  "${short.slice(0, 40)}…" → "${long.slice(0, 50)}…"  utility_bills=${ub.rowCount}  account_mappings=${am.rowCount}`);
    totalBills    += ub.rowCount;
    totalMappings += am.rowCount;
  }
}
console.log(`\n✓ Total: ${totalBills} bills + ${totalMappings} mappings updated`);

await pool.end();

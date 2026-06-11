/**
 * Cross-check Jake's three May 2026 lists (WhatsApp, 2026-06-11) against
 * utility_bills. Read-only. Classifies every line as:
 *   ✓ FOUND      — in Neon with property+unit
 *   ◐ UNASSIGNED — in Neon but property/unit missing (needs mapping)
 *   ✗ MISSING    — not in Neon at all
 *
 * Usage: node scripts/verify-jake-may.mjs
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

// Jake's lists: [amount, expected property hint, expected unit]
const LISTS = {
  internet: [
    [84.99,  '175 W 107th', '1'],
    [91.78,  '2200 Colorado', '337'],
    [66.24,  '4750 Lincoln', '183'],
    [76.25,  '939 S Broadway', '806'],
    [81.24,  '4750 Lincoln', '382'],
    [76.25,  '2200 Colorado', '540'],
    [96.25,  '1528 6th', '209'],
    [101.25, '607 2nd Ave', '2'],
    [76.25,  '4750 Lincoln', '1-461'],
    [61.25,  '507 Wilshire', '313'],
    [61.25,  '226', 'Dale'],
    [91.24,  'Sorrento', '409'],
  ],
  electricity: [
    [328.62, '2200 Colorado', '337'],
    [382.55, '2200 Colorado', '630'],
    [235.96, '939 S Broadway', '606'],
    [264.5,  '939 S Broadway', '806'],
    [179.16, '939 S Broadway', '202'],
    [164.62, '7141 Santa Monica', '321'],
    [261.35, '2200 Colorado', '540'],
    [355.14, '472 9th Ave', '3FL'],
    [575.59, '478 9th Ave', '2'],
    [268.66, '2200 Colorado', '627'],
    [106.21, '620 Santa Monica', '510'],
    [255.58, 'Pico', ''],
    [219.75, '939 S Broadway', '607'],
    [192.68, '939 S Broadway', 'M03'],
    [248.01, '939 S Broadway', '508'],
    [101.54, 'Arrezo', '313'],
    [148.64, 'NMS', '306'],
    [140.11, 'Portofino', '410'],
    [108.29, 'Sorrento', '409'],
    [82.63,  '474', '4D'],
  ],
  gas: [
    [null, 'Jefferson', '269'],
    [null, 'Pico', ''],
  ],
};

let found = 0, unassigned = 0, missing = 0;

for (const [type, rows] of Object.entries(LISTS)) {
  console.log('═'.repeat(78));
  console.log(`${type.toUpperCase()} (lista de Jake)`);
  console.log('─'.repeat(78));
  for (const [amount, hint, unit] of rows) {
    let r;
    if (amount !== null) {
      r = await pool.query(
        `SELECT id, property_address, unit, account_last4, amount_due, status,
                email_received_at::date AS recv
         FROM utility_bills
         WHERE utility_type = $1 AND ROUND(amount_due::numeric,2) = ROUND($2::numeric,2)
           AND email_received_at BETWEEN '2026-04-20' AND '2026-06-12'
         ORDER BY email_received_at`,
        [type, amount]
      );
    } else {
      r = await pool.query(
        `SELECT id, property_address, unit, account_last4, amount_due, status,
                email_received_at::date AS recv
         FROM utility_bills
         WHERE utility_type = $1 AND property_address ILIKE '%' || $2 || '%'
           AND amount_due > 0
           AND email_received_at BETWEEN '2026-04-20' AND '2026-06-12'
         ORDER BY email_received_at`,
        [type, hint]
      );
    }
    const label = `$${amount ?? '?'} · ${hint} ${unit}`.padEnd(40);
    if (r.rows.length === 0) {
      console.log(`  ✗ MISSING     ${label}`);
      missing++;
    } else {
      const b = r.rows[0];
      if (!b.property_address) {
        console.log(`  ◐ UNASSIGNED  ${label} → bill ${b.id} acct ····${b.account_last4} recv ${b.recv.toISOString().slice(0,10)}`);
        unassigned++;
      } else {
        console.log(`  ✓ FOUND       ${label} → ${b.property_address} u=${b.unit || '-'} (bill ${b.id}, ${b.recv.toISOString().slice(0,10)})`);
        found++;
      }
    }
  }
}

console.log('═'.repeat(78));
console.log(`RESUMEN: ✓ ${found} encontradas · ◐ ${unassigned} sin asignar · ✗ ${missing} faltan`);
await pool.end();

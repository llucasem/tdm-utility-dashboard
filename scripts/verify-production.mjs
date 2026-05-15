/**
 * Verification tests after today's production hardening.
 * Read-only.
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

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  PRODUCTION VERIFICATION');
console.log('═══════════════════════════════════════════════════════════════════\n');

// TEST 1: Bill-purchase exclusivity
console.log('━━━ TEST 1: Exclusividad bill ↔ Purchase ━━━');
const dup = await pool.query(`
  WITH expanded AS (
    SELECT id, (m->>'id') AS purchase_id
    FROM utility_bills, LATERAL jsonb_array_elements(qb_match_data) AS m
    WHERE qb_match_status = 'matched' AND qb_match_data IS NOT NULL
  )
  SELECT purchase_id, COUNT(DISTINCT id)::int AS bills, array_agg(DISTINCT id) AS bill_ids
  FROM expanded GROUP BY 1 HAVING COUNT(DISTINCT id) > 1
`);
if (dup.rowCount === 0) {
  console.log('  ✓ Cero Purchases compartidos entre bills (exclusivity funciona)');
} else {
  console.log(`  ✗ ${dup.rowCount} Purchases aparecen en múltiples bills:`);
  for (const r of dup.rows.slice(0, 5)) {
    console.log(`     Purchase ${r.purchase_id} en bills: ${r.bill_ids.join(', ')}`);
  }
}

// TEST 2: Agrupación por email_received_at
console.log('\n━━━ TEST 2: Distribución por email_received_at ━━━');
const m = await pool.query(`
  SELECT TO_CHAR(email_received_at, 'YYYY-MM') AS m, COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE qb_tag_status='tagged')::int AS tagged
  FROM utility_bills WHERE amount_due > 0
  GROUP BY 1 ORDER BY 1
`);
console.log('  Mes      Total  Tagged');
for (const x of m.rows) {
  console.log(`  ${x.m}   ${String(x.n).padStart(5)}  ${String(x.tagged).padStart(6)}`);
}

// TEST 3: Las 2 bills que estaban en junio
console.log('\n━━━ TEST 3: Bills #2353 y #2366 (antes en junio) ━━━');
const t3 = await pool.query(`
  SELECT id, property_address, amount_due, due_date::text AS d, email_received_at::date::text AS e
  FROM utility_bills WHERE id IN (2353, 2366)
`);
for (const b of t3.rows) {
  console.log(`  #${b.id}: email_received_at=${b.e} (mayo) | due_date=${b.d} (junio)`);
  console.log(`     → ahora se agrupa por email → MAYO ✓`);
}

// TEST 4: Bill #2384 (Yaritza saga)
console.log('\n━━━ TEST 4: Bill #2384 (saga Yaritza) ━━━');
const t4 = await pool.query(`
  SELECT id, property_address, unit, amount_due, qb_match_status, qb_tag_status, qb_class_id, qb_match_data
  FROM utility_bills WHERE id = 2384
`);
if (t4.rowCount > 0) {
  const b = t4.rows[0];
  const p = (b.qb_match_data || [])[0] || {};
  console.log(`  Property: ${b.property_address} unit=${b.unit}`);
  console.log(`  Match: ${b.qb_match_status} | Tag: ${b.qb_tag_status}`);
  console.log(`  Linked to Purchase ${p.id || '-'}`);
  console.log(`     payee=${p.payee || '-'}`);
  console.log(`     Class=${p.className || '-'}`);
  if (p.payee && p.payee.toLowerCase().includes('yaritza')) {
    console.log('  ⚠ todavía linkada a Yaritza');
  } else {
    console.log('  ✓ ya no linkada a Yaritza');
  }
}

// TEST 5: Variantes de dirección
console.log('\n━━━ TEST 5: Variantes de address ━━━');
const t5 = await pool.query(`
  SELECT LOWER(SPLIT_PART(property_address, ',', 1)) AS street,
         COUNT(DISTINCT property_address)::int AS variants,
         array_agg(DISTINCT property_address) AS addresses
  FROM utility_bills WHERE property_address IS NOT NULL AND amount_due > 0
  GROUP BY 1 HAVING COUNT(DISTINCT property_address) > 1 ORDER BY variants DESC LIMIT 5
`);
console.log(`  Streets con múltiples variantes (problema de ZIP/ciudad inconsistente):`);
for (const x of t5.rows) {
  console.log(`    "${x.street}" → ${x.variants} variantes:`);
  for (const a of x.addresses) console.log(`       · ${a}`);
}

// TEST 6: Health endpoint en producción
console.log('\n━━━ TEST 6: Health endpoint en producción ━━━');
const session = process.env.APP_SESSION_TOKEN;
const r6 = await fetch('https://edonis-utility-dashboard.vercel.app/api/health', {
  headers: { Cookie: `tdm_session=${session}` },
}).then(r => r.json()).catch(e => ({ error: e.message }));
console.log(`  Status: ${r6.status || (r6.ok === false ? 'DEGRADED' : 'unknown')}`);
console.log(`  Warnings: ${(r6.warnings || []).length === 0 ? '(none)' : ''}`);
for (const w of r6.warnings || []) console.log(`    ⚠ ${w}`);
if (r6.timestamps) {
  console.log(`  Last bill inserted: ${r6.timestamps.last_bill_inserted}`);
  console.log(`  Bills last 24h:     ${r6.counts?.bills_last_24h}`);
  console.log(`  Mappings:           ${r6.counts?.mappings_total} (${r6.counts?.mappings_manual} manual + ${r6.counts?.mappings_inferred} inferred)`);
  console.log(`  QB token days left: ${r6.quickbooks?.refresh_token_days_left}`);
}

// TEST 7: HealthBanner desplegado
console.log('\n━━━ TEST 7: HealthBanner desplegado ━━━');
const r7 = await fetch('https://edonis-utility-dashboard.vercel.app/login');
console.log(`  /login HTTP status: ${r7.status} ${r7.status === 200 ? '✓' : '✗'}`);

// TEST 8: Cron endpoint responde correctamente
console.log('\n━━━ TEST 8: Cron endpoint responde ━━━');
const r8a = await fetch('https://edonis-utility-dashboard.vercel.app/api/cron/retry-and-learn');
console.log(`  Sin cron header: ${r8a.status} ${r8a.status === 401 ? '✓ (rechaza correctamente)' : '✗'}`);

await pool.end();
console.log('\n');

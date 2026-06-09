/**
 * FASE 1 — Migraciones SQL del super plan.
 *
 * Crea/altera:
 *   1.1 system_lessons (+ seed con 5 lecciones conocidas)
 *   1.2 cron_heartbeats
 *   1.3 provider_accounts (para matching v2)
 *   1.4 property_qb_class: UNIQUE index por expresión
 *   1.5 utility_bills.account_last4 → TEXT
 *   1.6 6 índices que faltan
 *   1.7 utility_bills: añadir parse_error_count, account_id
 *
 * Idempotente — IF NOT EXISTS en todo. Safe to re-run.
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

async function run(sql, label) {
  try {
    await pool.query(sql);
    console.log(`  ✓ ${label}`);
  } catch (e) {
    console.error(`  ❌ ${label}: ${e.message}`);
    throw e;
  }
}

console.log('═══ FASE 1.1 — system_lessons ═══');
await run(`
  CREATE TABLE IF NOT EXISTS system_lessons (
    id               SERIAL PRIMARY KEY,
    lesson_type      TEXT NOT NULL,
    context          JSONB NOT NULL,
    description      TEXT,
    detected_by      TEXT NOT NULL DEFAULT 'lluis_manual',
    evidence_ids     JSONB,
    applied_in       TEXT,
    times_triggered  INT NOT NULL DEFAULT 0,
    last_triggered_at TIMESTAMPTZ,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ
  )
`, 'CREATE TABLE system_lessons');

await run(`
  CREATE INDEX IF NOT EXISTS idx_sl_active_type
    ON system_lessons (lesson_type, is_active)
    WHERE is_active = true
`, 'idx_sl_active_type');

// Seed 5 known lessons
const lessons = [
  {
    type: 'parser_pattern',
    desc: 'Spectrum + ConEd envían 2 emails por factura ("Statement Ready" y "Payment Scheduled"). Sin dedup, generan 2 bills con mismo account+amount.',
    context: { pattern: 'duplicate_bill_emails', vendors: ['spectrum', 'con edison'], dedup_key: '(account_last4, utility_type, amount_due, ±10 days)' },
    applied_in: 'TBD lib/parser.js post-parse dedup',
  },
  {
    type: 'parser_pattern',
    desc: 'Apt N embebido en property_address. Ej: "472 9th Ave, Apt 2, NY". Hay que extraer "Apt 2" → campo unit, y dejar address limpio.',
    context: { pattern: 'apt_embedded_in_address', regex: '/,?\\s*(apt\\.?|unit|suite|#)\\s*[\\w-]+/i' },
    applied_in: 'TBD lib/parser.js sanitize()',
  },
  {
    type: 'parser_pattern',
    desc: 'Prompt pide "last 5 digits" pero columna era VARCHAR(4). Causaba crashes silenciosos. Fix: prompt pide 4 + truncar últimos 4 + columna TEXT.',
    context: { pattern: 'account_last4_overflow' },
    applied_in: 'lib/parser.js sanitize() + ALTER COLUMN TEXT',
  },
  {
    type: 'address_variant',
    desc: 'Variantes de capitalización ("360 W PICO RD") y comas faltantes en address generan duplicados en property_qb_class. Normalizar siempre a Title Case + city/state/zip.',
    context: { pattern: 'address_capitalization_drift', target_format: 'Title Case + comma + city + state + zip' },
    applied_in: 'TBD lib/parser.js sanitize()',
  },
  {
    type: 'match_false_positive',
    desc: 'Spectrum factura adelantado: TxnDate del Purchase suele ser -16 a -20 días vs email_received_at. Ventana -3/+30 no abarca. Por eso muchas Spectrum bills quedan not_found cuando el Purchase sí existe.',
    context: { pattern: 'window_too_narrow_for_advance_billing', vendor: 'spectrum', observed_offset_days: -20 },
    applied_in: 'TBD lib/qb-match-v2.js (matching por provider+account+cycle)',
  },
];

for (const l of lessons) {
  await pool.query(`
    INSERT INTO system_lessons (lesson_type, context, description, detected_by, applied_in)
    SELECT $1::text, $2::jsonb, $3, 'lluis_manual', $4
    WHERE NOT EXISTS (
      SELECT 1 FROM system_lessons WHERE lesson_type = $1 AND description = $3
    )
  `, [l.type, JSON.stringify(l.context), l.desc, l.applied_in]);
}
const lessonCount = await pool.query(`SELECT COUNT(*)::int AS c FROM system_lessons`);
console.log(`  ✓ Seed: ${lessonCount.rows[0].c} lecciones en la tabla`);

console.log('\n═══ FASE 1.2 — cron_heartbeats ═══');
await run(`
  CREATE TABLE IF NOT EXISTS cron_heartbeats (
    cron_name      TEXT PRIMARY KEY,
    last_ran_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_run_ms    INT,
    last_run_ok    BOOLEAN NOT NULL DEFAULT true,
    last_error     TEXT,
    runs_total     INT NOT NULL DEFAULT 0,
    runs_failed    INT NOT NULL DEFAULT 0
  )
`, 'CREATE TABLE cron_heartbeats');

// Pre-populate with known crons so /api/health always finds them
for (const name of ['sync', 'retry-and-learn', 'match-pending', 'autotag-pending', 'learn-classes']) {
  await pool.query(`
    INSERT INTO cron_heartbeats (cron_name) VALUES ($1)
    ON CONFLICT (cron_name) DO NOTHING
  `, [name]);
}
console.log('  ✓ Seed cron names');

console.log('\n═══ FASE 1.3 — provider_accounts ═══');
await run(`
  CREATE TABLE IF NOT EXISTS provider_accounts (
    id                SERIAL PRIMARY KEY,
    provider          TEXT NOT NULL,
    account_last4     TEXT NOT NULL,
    utility_type      TEXT NOT NULL,
    property_address  TEXT,
    unit              TEXT,
    qb_class_id       TEXT,
    qb_class_name     TEXT,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bills_count       INT NOT NULL DEFAULT 0,
    last_amount       NUMERIC(10, 2),
    last_cycle        TEXT,
    typical_day_of_month INT,
    is_active         BOOLEAN NOT NULL DEFAULT true
  )
`, 'CREATE TABLE provider_accounts');

await run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_provider_acct
    ON provider_accounts (provider, account_last4)
`, 'idx_pa_provider_acct (UNIQUE)');

await run(`
  CREATE INDEX IF NOT EXISTS idx_pa_address
    ON provider_accounts (property_address, COALESCE(unit, ''))
`, 'idx_pa_address');

console.log('\n═══ FASE 1.4 — property_qb_class UNIQUE index by expression ═══');
// Check what currently exists
const idxCheck = await pool.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE tablename = 'property_qb_class'
`);
console.log('  Índices actuales en property_qb_class:');
for (const r of idxCheck.rows) console.log('    ' + r.indexname + ': ' + r.indexdef.slice(0, 100));

await run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pqc_addr_unit_expr
    ON property_qb_class (property_address, COALESCE(unit, ''))
`, 'idx_pqc_addr_unit_expr (UNIQUE by expression — FIX para class-learner.js)');

// Also: index by qb_class_id (used by linkBillsFromRecentClasses)
await run(`
  CREATE INDEX IF NOT EXISTS idx_pqc_class_id
    ON property_qb_class (qb_class_id)
`, 'idx_pqc_class_id');

console.log('\n═══ FASE 1.5 — utility_bills.account_last4 → TEXT ═══');
// Check current type
const colCheck = await pool.query(`
  SELECT data_type, character_maximum_length FROM information_schema.columns
  WHERE table_name = 'utility_bills' AND column_name = 'account_last4'
`);
console.log(`  Tipo actual: ${colCheck.rows[0].data_type}(${colCheck.rows[0].character_maximum_length})`);
if (colCheck.rows[0].character_maximum_length === 4) {
  await run(`ALTER TABLE utility_bills ALTER COLUMN account_last4 TYPE TEXT`, 'ALTER account_last4 → TEXT');
} else {
  console.log('  (ya es TEXT u otro tipo, skip)');
}

// Idem para account_mappings
const colCheck2 = await pool.query(`
  SELECT data_type, character_maximum_length FROM information_schema.columns
  WHERE table_name = 'account_mappings' AND column_name = 'account_last4'
`);
if (colCheck2.rows.length > 0 && colCheck2.rows[0].character_maximum_length === 4) {
  await run(`ALTER TABLE account_mappings ALTER COLUMN account_last4 TYPE TEXT`, 'ALTER account_mappings.account_last4 → TEXT');
}

console.log('\n═══ FASE 1.6 — Índices que faltan ═══');
await run(`
  CREATE INDEX IF NOT EXISTS idx_ub_amount_recv
    ON utility_bills (amount_due, email_received_at)
    WHERE amount_due > 0
`, 'idx_ub_amount_recv (compuesto, partial)');

await run(`
  CREATE INDEX IF NOT EXISTS idx_ub_match_data_gin
    ON utility_bills USING GIN (qb_match_data)
`, 'idx_ub_match_data_gin (GIN para JSONB lookups)');

await run(`
  CREATE INDEX IF NOT EXISTS idx_ub_prop_util_tagged
    ON utility_bills (property_address, utility_type)
    WHERE qb_tag_status = 'tagged'
`, 'idx_ub_prop_util_tagged (partial, para getHistoricalPattern)');

await run(`
  CREATE INDEX IF NOT EXISTS idx_ub_match_retry
    ON utility_bills (qb_match_status, email_received_at)
    WHERE qb_match_status IN ('pending', 'not_found', 'error') AND amount_due > 0
`, 'idx_ub_match_retry (partial, para cron match)');

await run(`
  CREATE INDEX IF NOT EXISTS idx_ub_bills_list
    ON utility_bills (email_received_at DESC NULLS LAST, created_at DESC)
    WHERE amount_due > 0
`, 'idx_ub_bills_list (para GET /api/bills)');

await run(`
  CREATE INDEX IF NOT EXISTS idx_ub_tag_retry
    ON utility_bills (qb_tag_status, email_received_at)
    WHERE qb_tag_status IN ('pending', 'not_found', 'error') AND amount_due > 0
`, 'idx_ub_tag_retry (partial, para cron autotag)');

console.log('\n═══ FASE 1.7 — Columnas extras en utility_bills ═══');
const cols = await pool.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'utility_bills'
`);
const colSet = new Set(cols.rows.map(r => r.column_name));

if (!colSet.has('parse_error_count')) {
  await run(`ALTER TABLE utility_bills ADD COLUMN parse_error_count INT NOT NULL DEFAULT 0`, 'add parse_error_count');
} else { console.log('  (parse_error_count ya existe, skip)'); }

if (!colSet.has('account_id')) {
  await run(`ALTER TABLE utility_bills ADD COLUMN account_id INT REFERENCES provider_accounts(id)`, 'add account_id FK');
  await run(`CREATE INDEX IF NOT EXISTS idx_ub_account_id ON utility_bills (account_id)`, 'idx_ub_account_id');
} else { console.log('  (account_id ya existe, skip)'); }

// is_duplicate flag for dedup
if (!colSet.has('is_duplicate')) {
  await run(`ALTER TABLE utility_bills ADD COLUMN is_duplicate BOOLEAN NOT NULL DEFAULT false`, 'add is_duplicate');
  await run(`CREATE INDEX IF NOT EXISTS idx_ub_not_duplicate ON utility_bills (id) WHERE NOT is_duplicate`, 'idx_ub_not_duplicate');
} else { console.log('  (is_duplicate ya existe, skip)'); }

console.log('\n═══ Resumen FASE 1 ═══');
const counts = await pool.query(`
  SELECT
    (SELECT COUNT(*)::int FROM system_lessons) AS lessons,
    (SELECT COUNT(*)::int FROM cron_heartbeats) AS heartbeats,
    (SELECT COUNT(*)::int FROM provider_accounts) AS provider_accounts,
    (SELECT COUNT(*)::int FROM utility_bills) AS bills
`);
console.log('  Tablas listas:');
console.log('    system_lessons:    ' + counts.rows[0].lessons + ' rows');
console.log('    cron_heartbeats:   ' + counts.rows[0].heartbeats + ' rows');
console.log('    provider_accounts: ' + counts.rows[0].provider_accounts + ' rows');
console.log('    utility_bills:     ' + counts.rows[0].bills + ' rows (sin cambios)');

await pool.end();
console.log('\n✅ FASE 1 completada\n');

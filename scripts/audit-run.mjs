/**
 * Internal audit script.
 *
 * Read-only checks against the Neon database to verify schema integrity,
 * data invariants, and surface any inconsistencies that could break the app
 * in production.
 *
 * Run with:  node scripts/audit-run.mjs
 *
 * Optional:  AUDIT_BASE_URL=https://your-app.vercel.app to also probe HTTP.
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

const findings = { ok: 0, warn: 0, fail: 0, items: [] };

function record(level, area, msg, detail = null) {
  findings.items.push({ level, area, msg, detail });
  findings[level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'fail']++;
  const icon = level === 'ok' ? '✓' : level === 'warn' ? '⚠' : '✗';
  const color = level === 'ok' ? '\x1b[32m' : level === 'warn' ? '\x1b[33m' : '\x1b[31m';
  console.log(`${color}${icon}\x1b[0m  [${area}] ${msg}${detail ? ` — ${detail}` : ''}`);
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  TDM UTILITY DASHBOARD — INTERNAL AUDIT');
console.log(`  ${new Date().toISOString()}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

// ── 1. Schema integrity ──────────────────────────────────────────────────────
console.log('— Schema integrity —');
{
  const tablesQ = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  const expected = [
    'account_mappings', 'notifications', 'properties', 'property_qb_class',
    'quickbooks_tag_log', 'quickbooks_tokens', 'utility_bills',
  ];
  const actual = tablesQ.rows.map(r => r.table_name);
  for (const t of expected) {
    if (actual.includes(t)) record('ok', 'schema', `Table ${t} exists`);
    else                     record('fail', 'schema', `Table ${t} MISSING`);
  }

  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'utility_bills'
  `);
  const colNames = cols.rows.map(r => r.column_name);
  const requiredCols = [
    'id', 'gmail_message_id', 'utility_type', 'property_address', 'unit',
    'account_last4', 'amount_due', 'due_date', 'email_received_at',
    'email_subject', 'status', 'created_at',
    'qb_tag_status', 'qb_purchase_id', 'qb_class_id', 'qb_tagged_at',
    'qb_match_status', 'qb_match_count', 'qb_match_data', 'qb_matched_at', 'qb_match_error',
    'is_anomaly', 'anomaly_baseline', 'anomaly_ratio',
  ];
  for (const c of requiredCols) {
    if (colNames.includes(c)) record('ok', 'schema', `utility_bills.${c} present`);
    else                       record('fail', 'schema', `utility_bills.${c} MISSING`);
  }
}

// ── 2. Indexes ──────────────────────────────────────────────────────────────
console.log('\n— Indexes —');
{
  const idxQ = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'utility_bills'
  `);
  const idx = idxQ.rows.map(r => r.indexname);
  const required = ['idx_ub_qb_tag_status', 'idx_ub_qb_match_status', 'idx_ub_qb_match_pending'];
  for (const i of required) {
    if (idx.includes(i)) record('ok', 'indexes', `${i} exists`);
    else                   record('warn', 'indexes', `${i} missing (queries may scan full table)`);
  }
  const uniqs = idx.filter(n => /uniq|unique|uq/i.test(n));
  record('ok', 'indexes', `Unique indexes found: ${uniqs.join(', ') || 'none'}`);
}

// ── 3. Deduplication invariant ──────────────────────────────────────────────
console.log('\n— Deduplication —');
{
  const dup = await pool.query(`
    SELECT gmail_message_id, COUNT(*) AS n FROM utility_bills
    WHERE gmail_message_id IS NOT NULL
    GROUP BY gmail_message_id HAVING COUNT(*) > 1
  `);
  if (dup.rowCount === 0) record('ok', 'data', 'No duplicate gmail_message_id rows');
  else                     record('fail', 'data', `${dup.rowCount} duplicate gmail_message_ids`, dup.rows.slice(0,3).map(r => r.gmail_message_id).join(', '));
}

// ── 4. Status enum values ───────────────────────────────────────────────────
console.log('\n— Status enums —');
{
  const tagStatuses = await pool.query(`
    SELECT qb_tag_status, COUNT(*)::int AS n FROM utility_bills
    GROUP BY qb_tag_status ORDER BY n DESC
  `);
  const validTag = new Set(['pending', 'tagged', 'not_found', 'ambiguous', 'error', 'skipped']);
  let invalidTagFound = false;
  for (const r of tagStatuses.rows) {
    if (r.qb_tag_status && !validTag.has(r.qb_tag_status)) {
      record('fail', 'enum', `Invalid qb_tag_status="${r.qb_tag_status}" in ${r.n} rows`);
      invalidTagFound = true;
    }
  }
  if (!invalidTagFound) record('ok', 'enum', `qb_tag_status values valid: ${tagStatuses.rows.map(r => `${r.qb_tag_status || 'null'}=${r.n}`).join(', ')}`);

  const matchStatuses = await pool.query(`
    SELECT qb_match_status, COUNT(*)::int AS n FROM utility_bills
    GROUP BY qb_match_status ORDER BY n DESC
  `);
  const validMatch = new Set(['pending', 'matched', 'not_found', 'ambiguous', 'error', 'skipped']);
  let invalidMatchFound = false;
  for (const r of matchStatuses.rows) {
    if (r.qb_match_status && !validMatch.has(r.qb_match_status)) {
      record('fail', 'enum', `Invalid qb_match_status="${r.qb_match_status}" in ${r.n} rows`);
      invalidMatchFound = true;
    }
  }
  if (!invalidMatchFound) record('ok', 'enum', `qb_match_status values valid: ${matchStatuses.rows.map(r => `${r.qb_match_status || 'null'}=${r.n}`).join(', ')}`);
}

// ── 5. QB token freshness ───────────────────────────────────────────────────
console.log('\n— QuickBooks tokens —');
{
  const tok = await pool.query(`
    SELECT realm_id, expires_at, refresh_expires_at, updated_at
    FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1
  `);
  if (tok.rowCount === 0) {
    record('fail', 'qb', 'No QB tokens stored — app cannot talk to QuickBooks');
  } else {
    const t = tok.rows[0];
    const refreshDaysLeft = (new Date(t.refresh_expires_at) - new Date()) / 86_400_000;
    record('ok', 'qb', `realm ${t.realm_id}, last refresh ${new Date(t.updated_at).toISOString().slice(0,16)}Z`);
    if (refreshDaysLeft < 30)      record('fail', 'qb', `Refresh token expires in ${refreshDaysLeft.toFixed(1)} days — re-auth needed`);
    else if (refreshDaysLeft < 60) record('warn', 'qb', `Refresh token expires in ${refreshDaysLeft.toFixed(1)} days`);
    else                            record('ok', 'qb', `Refresh token has ${refreshDaysLeft.toFixed(0)} days left`);
  }
}

// ── 6. Match data sanity (JSONB) ────────────────────────────────────────────
console.log('\n— qb_match_data shape —');
{
  const sample = await pool.query(`
    SELECT id, qb_match_status, qb_match_count, qb_match_data
    FROM utility_bills
    WHERE qb_match_status IN ('matched', 'ambiguous')
      AND qb_match_data IS NOT NULL
    LIMIT 5
  `);
  let allShaped = true;
  for (const r of sample.rows) {
    if (!Array.isArray(r.qb_match_data)) {
      record('fail', 'jsonb', `Bill ${r.id}: qb_match_data is not an array`);
      allShaped = false;
      continue;
    }
    if (r.qb_match_data.length !== r.qb_match_count) {
      // not necessarily a bug — we cap at 20 — only flag if both small
      if (r.qb_match_count < 20 && r.qb_match_data.length !== r.qb_match_count) {
        record('warn', 'jsonb', `Bill ${r.id}: count=${r.qb_match_count} but array has ${r.qb_match_data.length} items`);
      }
    }
    const first = r.qb_match_data[0];
    if (first && (!first.type || !first.id || !first.date)) {
      record('warn', 'jsonb', `Bill ${r.id}: match entry missing required fields`);
      allShaped = false;
    }
  }
  if (allShaped) record('ok', 'jsonb', `Sampled ${sample.rowCount} matched/ambiguous rows — all well-shaped`);

  const counts = await pool.query(`
    SELECT qb_match_status, COUNT(*)::int AS n
    FROM utility_bills WHERE amount_due > 0
    GROUP BY qb_match_status ORDER BY n DESC
  `);
  record('ok', 'match', `Distribution: ${counts.rows.map(r => `${r.qb_match_status || 'null'}=${r.n}`).join(', ')}`);
}

// ── 7. Orphan / unmapped tag attempts ───────────────────────────────────────
console.log('\n— Tag log integrity —');
{
  const orphan = await pool.query(`
    SELECT COUNT(*)::int AS n FROM quickbooks_tag_log l
    LEFT JOIN utility_bills b ON b.id = l.bill_id
    WHERE b.id IS NULL
  `);
  if (orphan.rows[0].n === 0) record('ok', 'fk', 'No orphan rows in quickbooks_tag_log');
  else                          record('fail', 'fk', `${orphan.rows[0].n} orphan tag_log rows reference deleted bills`);

  const recentErrors = await pool.query(`
    SELECT status, COUNT(*)::int AS n FROM quickbooks_tag_log
    WHERE tagged_at > NOW() - INTERVAL '7 days'
    GROUP BY status
  `);
  record('ok', 'tag-log', `Last 7 days: ${recentErrors.rows.map(r => `${r.status}=${r.n}`).join(', ') || 'no activity'}`);
}

// ── 8. Property → QB class mappings ─────────────────────────────────────────
console.log('\n— Property↔Class mappings —');
{
  const totalProps = await pool.query(`
    SELECT COUNT(DISTINCT (property_address, COALESCE(unit, '')))::int AS n
    FROM utility_bills WHERE property_address IS NOT NULL AND TRIM(property_address) != ''
  `);
  const mapped = await pool.query(`SELECT COUNT(*)::int AS n FROM property_qb_class`);
  const ratio = totalProps.rows[0].n > 0 ? Math.round((mapped.rows[0].n / totalProps.rows[0].n) * 100) : 0;
  if (mapped.rows[0].n === 0)        record('warn', 'mapping', `0 of ${totalProps.rows[0].n} property/unit pairs mapped to a QB Class — auto-tag cannot work yet`);
  else if (ratio < 50)                record('warn', 'mapping', `Only ${mapped.rows[0].n}/${totalProps.rows[0].n} (${ratio}%) properties mapped to QB Class`);
  else                                record('ok',   'mapping', `${mapped.rows[0].n}/${totalProps.rows[0].n} (${ratio}%) properties mapped to QB Class`);
}

// ── 9. Anomaly flag sanity ──────────────────────────────────────────────────
console.log('\n— Anomaly flags —');
{
  const bad = await pool.query(`
    SELECT COUNT(*)::int AS n FROM utility_bills
    WHERE is_anomaly = true AND (anomaly_baseline IS NULL OR anomaly_ratio IS NULL)
  `);
  if (bad.rows[0].n === 0) record('ok', 'anomaly', 'All anomaly-flagged bills have baseline + ratio');
  else                      record('fail', 'anomaly', `${bad.rows[0].n} anomaly-flagged bills missing baseline or ratio`);

  const anomCount = await pool.query(`SELECT COUNT(*)::int AS n FROM utility_bills WHERE is_anomaly = true`);
  record('ok', 'anomaly', `${anomCount.rows[0].n} bills currently flagged as anomalies`);
}

// ── 10. HTTP probes (optional) ──────────────────────────────────────────────
const baseUrl = process.env.AUDIT_BASE_URL;
if (baseUrl) {
  console.log(`\n— HTTP probes against ${baseUrl} —`);
  // 10a. Unauthenticated API call should get 401 JSON
  try {
    const res = await fetch(`${baseUrl}/api/bills`);
    const ctype = res.headers.get('content-type') || '';
    if (res.status === 401 && ctype.includes('application/json')) {
      record('ok', 'http', '/api/bills without cookie returns 401 JSON');
    } else {
      record('fail', 'http', `/api/bills without cookie: status=${res.status}, content-type=${ctype}`);
    }
  } catch (e) { record('fail', 'http', `/api/bills probe failed: ${e.message}`); }

  // 10b. Unauthenticated cron path without x-vercel-cron should also 401
  try {
    const res = await fetch(`${baseUrl}/api/quickbooks/match-pending`);
    if (res.status === 401) record('ok', 'http', '/api/quickbooks/match-pending rejects without x-vercel-cron');
    else                     record('fail', 'http', `/api/quickbooks/match-pending: status=${res.status} (should be 401)`);
  } catch (e) { record('fail', 'http', `cron probe failed: ${e.message}`); }

  // 10c. Login page should be reachable
  try {
    const res = await fetch(`${baseUrl}/login`);
    if (res.status === 200) record('ok', 'http', '/login reachable (200)');
    else                     record('warn', 'http', `/login status=${res.status}`);
  } catch (e) { record('fail', 'http', `/login probe failed: ${e.message}`); }
} else {
  console.log('\n— HTTP probes skipped (set AUDIT_BASE_URL to enable) —');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`  RESULT: ✓ ${findings.ok}  ⚠ ${findings.warn}  ✗ ${findings.fail}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

await pool.end();
process.exit(findings.fail > 0 ? 1 : 0);

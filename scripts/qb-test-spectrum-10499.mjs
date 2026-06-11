/**
 * Phase 1 — Read-only diagnostic for Spectrum $104.99 bill.
 *
 * Steps:
 *   1. Find utility_bill rows: amount_due = 104.99 + Spectrum sender
 *   2. For each, fetch property_qb_class mapping
 *   3. Query QB for Purchase with TotalAmt = 104.99 in ±15d of email_received_at
 *   4. Report whether auto-tag conditions are met
 *
 * Does NOT modify anything. Read-only.
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

async function refreshIfNeeded() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  if (r.rows.length === 0) { console.error('No QB tokens'); process.exit(1); }
  const row = r.rows[0];
  const expiresIn = row.expires_at ? Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000) : -1;
  if (expiresIn > 300) return row;

  console.log(`  (token expira en ${expiresIn}s — refrescando)`);
  const basic = Buffer.from(`${env['QB_CLIENT_ID']}:${env['QB_CLIENT_SECRET']}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  if (!res.ok) { console.error('Refresh failed:', res.status, await res.text()); process.exit(1); }
  const tk = await res.json();
  const expiresAt = new Date(Date.now() + tk.expires_in * 1000);
  const refreshExpiresAt = new Date(Date.now() + tk.x_refresh_token_expires_in * 1000);
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, refresh_expires_at = $4, updated_at = NOW() WHERE realm_id = $5`,
    [tk.access_token, tk.refresh_token, expiresAt, refreshExpiresAt, row.realm_id]
  );
  return { realm_id: row.realm_id, access_token: tk.access_token };
}

const { realm_id, access_token } = await refreshIfNeeded();
const BASE = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;

async function qbQuery(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    const text = await r.text();
    return { error: `${r.status}: ${text.slice(0, 300)}` };
  }
  return r.json();
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Diagnóstico de auto-tag — Spectrum $104.99');
console.log('═══════════════════════════════════════════════════════════\n');

// ── STEP 1: Find bills in our DB ────────────────────────────────────────────
console.log('STEP 1 — Buscando bills en utility_bills con amount_due = 104.99');
const bills = await pool.query(`
  SELECT id, utility_type, amount_due, due_date, email_received_at,
         email_subject, email_from, property_address, unit, account_last4,
         qb_match_status, qb_match_count, qb_tag_status, qb_purchase_id, qb_class_id
  FROM utility_bills
  WHERE amount_due = 104.99
  ORDER BY email_received_at DESC
`);

console.log(`  Encontradas ${bills.rows.length} bills con amount_due = $104.99\n`);

const spectrumBills = bills.rows.filter(b =>
  (b.email_from || '').toLowerCase().includes('spectrum') ||
  (b.email_subject || '').toLowerCase().includes('spectrum') ||
  (b.utility_type === 'internet')
);

console.log(`  De esas, ${spectrumBills.length} parecen ser de Spectrum (sender o tipo internet)\n`);

if (bills.rows.length === 0) {
  console.log('❌ No hay ninguna factura con ese importe. Para. Fin.');
  await pool.end();
  process.exit(0);
}

for (const b of bills.rows) {
  console.log(`  Bill #${b.id}`);
  console.log(`    type=${b.utility_type}  amount=$${b.amount_due}  due=${b.due_date?.toISOString().slice(0,10)}  recv=${b.email_received_at?.toISOString().slice(0,10)}`);
  console.log(`    from: ${(b.email_from || '').slice(0, 70)}`);
  console.log(`    subj: ${(b.email_subject || '').slice(0, 70)}`);
  console.log(`    property: ${b.property_address || '(NULL — Unassigned)'}  unit=${b.unit || '—'}  acct ····${b.account_last4 || '?'}`);
  console.log(`    match_status=${b.qb_match_status}  tag_status=${b.qb_tag_status}  qb_purchase_id=${b.qb_purchase_id || '—'}`);
  console.log('');
}

// ── STEP 2: For each, check Class mapping ───────────────────────────────────
console.log('STEP 2 — Comprobando property_qb_class mapping\n');

for (const b of bills.rows) {
  if (!b.property_address) {
    console.log(`  Bill #${b.id}: ⚠ sin property_address — NO se puede taguear hasta que Jake la asigne`);
    continue;
  }
  const m = await pool.query(
    `SELECT qb_class_id, qb_class_name FROM property_qb_class
     WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')`,
    [b.property_address.trim(), (b.unit || '').trim() || null]
  );
  if (m.rows.length === 0) {
    // Try normalized lookup (strip city/state, normalize unit)
    const all = await pool.query(`SELECT property_address, unit, qb_class_id, qb_class_name FROM property_qb_class`);
    const street = (b.property_address || '').toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ');
    const unit = (b.unit || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim();
    const hit = all.rows.find(r =>
      (r.property_address || '').toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ') === street &&
      (r.unit || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim() === unit
    );
    if (hit) {
      console.log(`  Bill #${b.id}: ✓ mapping encontrado (normalized) → Class "${hit.qb_class_name}" (id=${hit.qb_class_id})`);
    } else {
      console.log(`  Bill #${b.id}: ❌ propiedad "${b.property_address}" unit="${b.unit || ''}" sin mapping en property_qb_class`);
    }
  } else {
    console.log(`  Bill #${b.id}: ✓ mapping → Class "${m.rows[0].qb_class_name}" (id=${m.rows[0].qb_class_id})`);
  }
}

console.log('');

// ── STEP 3: Query QB for Purchases matching $104.99 ─────────────────────────
console.log('STEP 3 — Consultando QuickBooks por Purchases con TotalAmt = 104.99\n');

// First, total count without date filter
const purchasesAll = await qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef FROM Purchase WHERE TotalAmt = '104.99' ORDERBY TxnDate DESC MAXRESULTS 100`);
if (purchasesAll.error) {
  console.log(`  Error QB: ${purchasesAll.error}`);
} else {
  const ps = purchasesAll?.QueryResponse?.Purchase || [];
  console.log(`  Total Purchases en QB con $104.99 (sin filtro de fecha): ${ps.length}`);
  for (const p of ps) {
    console.log(`    - id=${p.Id}  ${p.TxnDate}  vendor: ${p.EntityRef?.name || '—'}  account: ${p.AccountRef?.name || '—'}`);
  }
}

console.log('');

// For each bill, run the matcher window
for (const b of bills.rows) {
  const anchor = b.email_received_at?.toISOString().slice(0, 10);
  if (!anchor) continue;
  const from = shiftDate(anchor, -3);
  const to   = shiftDate(anchor, 30);
  console.log(`  Bill #${b.id} ventana ${from} → ${to} (anchor=email_received_at=${anchor}):`);
  const r = await qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef FROM Purchase WHERE TotalAmt = '104.99' AND TxnDate >= '${from}' AND TxnDate <= '${to}'`);
  if (r.error) {
    console.log(`    Error QB: ${r.error}`);
    continue;
  }
  const ps = r?.QueryResponse?.Purchase || [];
  console.log(`    matches: ${ps.length}`);
  for (const p of ps) {
    // Fetch full Purchase to see if it already has a Class
    const full = await qbQuery(`SELECT * FROM Purchase WHERE Id = '${p.Id}'`);
    const fp = full?.QueryResponse?.Purchase?.[0];
    const topClass = fp?.ClassRef?.name || null;
    const lineClasses = (fp?.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef?.name || null);
    const hasClass = topClass || lineClasses.some(c => c);
    console.log(`      - id=${p.Id}  ${p.TxnDate}  vendor: ${p.EntityRef?.name || '—'}`);
    console.log(`        Class actual: top="${topClass || '—'}"  lines=[${lineClasses.map(c => c || '—').join(', ')}]`);
    console.log(`        ¿Pisaría guardrail? ${hasClass ? '⚠ SÍ — auto-tag haría SKIP' : '✓ NO — Class vacío, se puede escribir'}`);
  }
  console.log('');
}

// ── STEP 4: Final verdict ───────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  RESUMEN');
console.log('═══════════════════════════════════════════════════════════');
console.log('Para cada Bill #X, las 4 condiciones para que la Fase 2 escriba Class en QB:');
console.log('  1. property_address asignada    (sin ella → SKIP)');
console.log('  2. mapping en property_qb_class (sin ello → ERROR no_class_mapping)');
console.log('  3. exactamente 1 Purchase QB en ventana ±3/+30d');
console.log('  4. ese Purchase NO tiene Class todavía (guardrail anti-pisada)');
console.log('');
console.log('Lee los STEP 1-3 arriba y dime si cuadra todo para alguno.');
console.log('Si quieres ejecutar la Fase 2, di "confirmar fase 2" e indícame el Bill #.');

await pool.end();

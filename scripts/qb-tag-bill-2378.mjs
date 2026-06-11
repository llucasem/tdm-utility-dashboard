/**
 * Phase 2 — Execute auto-tag for Bill #2378 (Spectrum $104.99, May 2026).
 *
 * Replicates the exact logic of lib/auto-tag.js + lib/quickbooks.js
 * tagPurchaseWithClass — including the guardrail that aborts if the
 * Purchase already has any Class.
 *
 * Persists to quickbooks_tag_log + utility_bills.
 *
 * After tagging, re-queries QB to verify the write landed.
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

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshIfNeeded() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
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
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, refresh_expires_at = $4, updated_at = NOW() WHERE realm_id = $5`,
    [tk.access_token, tk.refresh_token,
     new Date(Date.now() + tk.expires_in * 1000),
     new Date(Date.now() + tk.x_refresh_token_expires_in * 1000),
     row.realm_id]
  );
  return { realm_id: row.realm_id, access_token: tk.access_token };
}

const { realm_id, access_token } = await refreshIfNeeded();
const BASE = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;

async function qbQuery(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB query ${r.status}: ${await r.text()}`);
  return r.json();
}
async function qbGet(path) {
  const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB get ${r.status}: ${await r.text()}`);
  return r.json();
}
async function qbPost(path, payload) {
  const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}minorversion=70`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`QB post ${r.status}: ${text}`);
  return JSON.parse(text);
}

function extractClassInfo(p) {
  const topClass = p?.ClassRef || null;
  const lineClasses = (p?.Line || [])
    .map(l => l?.AccountBasedExpenseLineDetail?.ClassRef || l?.ItemBasedExpenseLineDetail?.ClassRef)
    .filter(Boolean);
  return { topClass, lineClasses, hasClass: !!(topClass?.value || lineClasses.length > 0) };
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Fase 2 — Auto-tag de Bill #2378 (Spectrum $104.99 mayo)');
console.log('═══════════════════════════════════════════════════════════\n');

const BILL_ID = 2378;

// ── STEP 1: Load bill ────────────────────────────────────────────────────────
console.log('STEP 1 — Cargando Bill #2378...');
const br = await pool.query(`
  SELECT id, amount_due, email_received_at, property_address, unit
  FROM utility_bills
  WHERE id = $1
`, [BILL_ID]);
if (br.rows.length === 0) { console.error('Bill no encontrada'); process.exit(1); }
const bill = br.rows[0];
const anchor = bill.email_received_at.toISOString().slice(0, 10);
const dateFrom = shiftDate(anchor, -3);
const dateTo   = shiftDate(anchor, 30);
console.log(`  amount=$${bill.amount_due}  recv=${anchor}  property="${bill.property_address}" unit="${bill.unit}"`);
console.log(`  window=${dateFrom} → ${dateTo}\n`);

// ── STEP 2: Find Class mapping ───────────────────────────────────────────────
console.log('STEP 2 — Buscando property_qb_class mapping...');
let m = await pool.query(
  `SELECT qb_class_id, qb_class_name FROM property_qb_class
   WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')`,
  [bill.property_address.trim(), (bill.unit || '').trim() || null]
);
if (m.rows.length === 0) {
  // Normalized fallback
  const allMappings = await pool.query(`SELECT property_address, unit, qb_class_id, qb_class_name FROM property_qb_class`);
  const street = bill.property_address.toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ');
  const unit = (bill.unit || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim();
  const hit = allMappings.rows.find(r =>
    (r.property_address || '').toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ') === street &&
    (r.unit || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim() === unit
  );
  if (hit) m = { rows: [hit] };
}
if (m.rows.length === 0) { console.error('Sin mapping. Aborto.'); process.exit(1); }
const { qb_class_id, qb_class_name } = m.rows[0];
console.log(`  ✓ Class="${qb_class_name}" (id=${qb_class_id})\n`);

// ── STEP 3: Search QB ─────────────────────────────────────────────────────────
console.log('STEP 3 — Buscando Purchase en QB...');
const amt = Number(bill.amount_due).toFixed(2);
const search = await qbQuery(`SELECT * FROM Purchase WHERE TotalAmt = '${amt}' AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`);
const purchases = search?.QueryResponse?.Purchase || [];
console.log(`  Encontrados ${purchases.length} Purchase(s)`);
for (const p of purchases) {
  const ci = extractClassInfo(p);
  console.log(`    - id=${p.Id}  ${p.TxnDate}  $${p.TotalAmt}  vendor=${p.EntityRef?.name}  hasClass=${ci.hasClass}`);
}
if (purchases.length === 0) { console.error('\n0 matches. Aborto.'); process.exit(1); }
if (purchases.length > 1) { console.error('\n>1 matches — ambiguous. Aborto.'); process.exit(1); }

const targetPurchase = purchases[0];
const ci = extractClassInfo(targetPurchase);
if (ci.hasClass) {
  console.log(`\n⚠ El Purchase ${targetPurchase.Id} ya tiene Class. Guardrail SKIP.`);
  await pool.end();
  process.exit(0);
}

// ── STEP 4: Snapshot for audit ────────────────────────────────────────────────
console.log(`\nSTEP 4 — Snapshot del Purchase ${targetPurchase.Id} antes de escribir...`);
const beforeFull = await qbGet(`/purchase/${targetPurchase.Id}`);
const before = beforeFull.Purchase;
const beforeClass = extractClassInfo(before);
console.log(`  ClassRef top: ${JSON.stringify(beforeClass.topClass)}`);
console.log(`  Line classes: ${beforeClass.lineClasses.map(c => c.name || c.value).join(', ') || '(ninguna)'}`);
console.log(`  SyncToken: ${before.SyncToken}\n`);

// ── STEP 5: Build sparse update + POST ────────────────────────────────────────
console.log('STEP 5 — Construyendo update sparse...');
const updatedLines = (before.Line || []).map(line => {
  if (line.AccountBasedExpenseLineDetail) {
    return {
      ...line,
      AccountBasedExpenseLineDetail: {
        ...line.AccountBasedExpenseLineDetail,
        ClassRef: { value: qb_class_id, name: qb_class_name },
      },
    };
  }
  if (line.ItemBasedExpenseLineDetail) {
    return {
      ...line,
      ItemBasedExpenseLineDetail: {
        ...line.ItemBasedExpenseLineDetail,
        ClassRef: { value: qb_class_id, name: qb_class_name },
      },
    };
  }
  return line;
});

const payload = {
  ...before,
  sparse: true,
  Line:   updatedLines,
};

console.log('STEP 6 — POST update a QB...');
const updateRes = await qbPost(`/purchase`, payload);
const updated = updateRes.Purchase;
console.log(`  ✓ Update aceptado. Nuevo SyncToken=${updated.SyncToken}\n`);

// ── STEP 7: Verify ───────────────────────────────────────────────────────────
console.log('STEP 7 — Verificando re-leyendo el Purchase...');
const verify = await qbGet(`/purchase/${targetPurchase.Id}`);
const after = verify.Purchase;
const afterClass = extractClassInfo(after);
console.log(`  ClassRef top: ${JSON.stringify(afterClass.topClass)}`);
console.log(`  Line classes: ${afterClass.lineClasses.map(c => c.name || c.value).join(', ') || '(ninguna)'}`);
console.log('');

// ── STEP 8: Persist to quickbooks_tag_log + utility_bills ────────────────────
console.log('STEP 8 — Persistiendo audit trail en quickbooks_tag_log + utility_bills...');
await pool.query(`
  INSERT INTO quickbooks_tag_log
    (bill_id, qb_purchase_id, qb_purchase_type, qb_class_id_new, qb_class_id_old, status, match_count, error_message)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`, [BILL_ID, targetPurchase.Id, 'Purchase', qb_class_id, null, 'tagged', 1, null]);

await pool.query(`
  UPDATE utility_bills
  SET qb_tag_status  = 'tagged',
      qb_purchase_id = $2,
      qb_class_id    = $3,
      qb_tagged_at   = NOW()
  WHERE id = $1
`, [BILL_ID, targetPurchase.Id, qb_class_id]);
console.log(`  ✓ Persistido\n`);

// ── Final summary ────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  ✅ AUTO-TAG COMPLETADO');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Bill #${BILL_ID} → Purchase ${targetPurchase.Id}`);
console.log(`  Class antes:  (vacío)`);
console.log(`  Class ahora:  ${qb_class_name} (id=${qb_class_id})`);
console.log(`  Verificado en QB: ${afterClass.hasClass ? 'sí' : 'no'}`);

await pool.end();

/**
 * Executive inventory for the Edonis meeting — what's the state of utility
 * Class tagging in QB across all months we have data for.
 *
 * Three views:
 *   A) Resumen mensual desde NUESTRA DB (utility_bills) — % tagged
 *   B) Inventario desde QB — Purchases de vendors utility con/sin Class
 *   C) Sistema vs Jake (quien puso la Class)
 *   D) Pendientes accionables ahora
 *
 * Read-only.
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
  const row = r.rows[0];
  const expiresIn = row.expires_at ? Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000) : -1;
  if (expiresIn > 300) return row;
  const basic = Buffer.from(`${env['QB_CLIENT_ID']}:${env['QB_CLIENT_SECRET']}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
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
  if (!r.ok) throw new Error(`QB ${r.status}: ${await r.text()}`);
  return r.json();
}

const UTILITY_VENDORS_LC = ['spectrum','con edis','conedison','con edison','sce','southern california edison','ladwp','dwp','socalgas','desert water','national grid','pg&e','optimum','t-mobile','verizon','at&t','eversource','nyseg'];
function isUtilityVendor(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return UTILITY_VENDORS_LC.some(v => n.includes(v));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  INVENTARIO EJECUTIVO — utilities & Class en QB');
console.log('  ' + new Date().toISOString().slice(0, 19).replace('T', ' '));
console.log('═══════════════════════════════════════════════════════════\n');

// ── A) Resumen mensual desde nuestra DB ──────────────────────────────────
console.log('A) Bills facturables de utilities — por mes (desde nuestra DB)\n');
const monthly = await pool.query(`
  SELECT
    TO_CHAR(email_received_at, 'YYYY-MM')                        AS month,
    COUNT(*)::int                                                AS total,
    COUNT(*) FILTER (WHERE qb_tag_status = 'tagged')::int        AS tagged,
    COUNT(*) FILTER (WHERE qb_tag_status = 'ambiguous')::int     AS ambiguous,
    COUNT(*) FILTER (WHERE qb_tag_status IN ('not_found','pending','error','skipped'))::int AS pending,
    COALESCE(SUM(amount_due), 0)::float                          AS total_amount,
    COALESCE(SUM(amount_due) FILTER (WHERE qb_tag_status = 'tagged'), 0)::float AS tagged_amount
  FROM utility_bills
  WHERE amount_due > 0 AND email_received_at IS NOT NULL
  GROUP BY TO_CHAR(email_received_at, 'YYYY-MM')
  ORDER BY month
`);

console.log('  Mes      Bills  Tagged  Pendient.  Amb.   Importe total    Importe tagged   % tagged');
console.log('  ' + '─'.repeat(95));
for (const r of monthly.rows) {
  const pct = r.total > 0 ? Math.round((r.tagged / r.total) * 100) : 0;
  console.log('  ' + r.month + '  ' +
    String(r.total).padStart(5) + '  ' +
    String(r.tagged).padStart(6) + '  ' +
    String(r.pending).padStart(9) + '  ' +
    String(r.ambiguous).padStart(4) + '  $' +
    Math.round(r.total_amount).toLocaleString('en-US').padStart(13) + '  $' +
    Math.round(r.tagged_amount).toLocaleString('en-US').padStart(13) + '   ' +
    String(pct).padStart(3) + '%');
}
const totals = monthly.rows.reduce((a, r) => ({ total: a.total + r.total, tagged: a.tagged + r.tagged, pending: a.pending + r.pending, ambiguous: a.ambiguous + r.ambiguous, total_amount: a.total_amount + r.total_amount, tagged_amount: a.tagged_amount + r.tagged_amount }), { total: 0, tagged: 0, pending: 0, ambiguous: 0, total_amount: 0, tagged_amount: 0 });
const overallPct = totals.total > 0 ? Math.round((totals.tagged / totals.total) * 100) : 0;
console.log('  ' + '─'.repeat(95));
console.log('  TOTAL    ' + String(totals.total).padStart(5) + '  ' + String(totals.tagged).padStart(6) + '  ' + String(totals.pending).padStart(9) + '  ' + String(totals.ambiguous).padStart(4) + '  $' + Math.round(totals.total_amount).toLocaleString('en-US').padStart(13) + '  $' + Math.round(totals.tagged_amount).toLocaleString('en-US').padStart(13) + '   ' + String(overallPct).padStart(3) + '%');

// ── B) Inventario desde QB ────────────────────────────────────────────────
console.log('\nB) Inventario desde QuickBooks — Purchases de utility por mes\n');
console.log('  Vendors detectados: spectrum, con edison, sce, ladwp, socalgas, desert water, t-mobile, +otros\n');

const monthsToScan = ['2026-01','2026-02','2026-03','2026-04','2026-05'];
console.log('  Mes      Util.QB  ConClass  SinClass   Amount-total');
console.log('  ' + '─'.repeat(55));

const qbDetail = {};
for (const m of monthsToScan) {
  const [y, mo] = m.split('-');
  const last = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  const r = await qbQuery(`SELECT * FROM Purchase WHERE TxnDate >= '${m}-01' AND TxnDate <= '${m}-${String(last).padStart(2,'0')}' MAXRESULTS 500`);
  const ps = r?.QueryResponse?.Purchase || [];
  const util = ps.filter(p => isUtilityVendor(p.EntityRef?.name));
  let withClass = 0, withoutClass = 0, amount = 0;
  const detail = { withClass: [], withoutClass: [] };
  for (const p of util) {
    const topClass = p.ClassRef?.name;
    const lineClass = (p.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef?.name).find(Boolean);
    const has = topClass || lineClass;
    amount += Number(p.TotalAmt);
    if (has) { withClass++; detail.withClass.push({ id: p.Id, vendor: p.EntityRef?.name, amount: Number(p.TotalAmt), className: has, txnDate: p.TxnDate, updated: p.MetaData?.LastUpdatedTime }); }
    else     { withoutClass++; detail.withoutClass.push({ id: p.Id, vendor: p.EntityRef?.name, amount: Number(p.TotalAmt), txnDate: p.TxnDate }); }
  }
  qbDetail[m] = detail;
  console.log('  ' + m + '  ' + String(util.length).padStart(7) + '  ' + String(withClass).padStart(8) + '  ' + String(withoutClass).padStart(8) + '   $' + Math.round(amount).toLocaleString('en-US').padStart(11));
}

// ── C) Sistema vs Jake ────────────────────────────────────────────────────
console.log('\nC) ¿Quién puso la Class? — Purchases utility con Class por mes\n');
const sysTagged = await pool.query(`SELECT qb_purchase_id FROM quickbooks_tag_log WHERE qb_purchase_id IS NOT NULL AND status = 'tagged'`);
const sysSet = new Set(sysTagged.rows.map(r => String(r.qb_purchase_id)));

console.log('  Mes      Total  🤖 Sistema  👤 Jake');
console.log('  ' + '─'.repeat(40));
for (const m of monthsToScan) {
  const wc = qbDetail[m]?.withClass || [];
  let sys = 0, jake = 0;
  for (const p of wc) (sysSet.has(p.id) ? sys++ : jake++);
  console.log('  ' + m + '  ' + String(wc.length).padStart(5) + '  ' + String(sys).padStart(10) + '  ' + String(jake).padStart(7));
}

// ── D) Sin Class todavía (QB) ─────────────────────────────────────────────
console.log('\nD) Purchases utility en QB sin Class (Jake aún no las clasificó)\n');
let totalSinClass = 0;
for (const m of monthsToScan) {
  const wc = qbDetail[m]?.withoutClass || [];
  if (wc.length === 0) continue;
  totalSinClass += wc.length;
  console.log('  ' + m + ' (' + wc.length + '):');
  for (const p of wc.sort((a,b) => a.txnDate.localeCompare(b.txnDate))) {
    console.log('    Purchase ' + String(p.id).padEnd(6) + ' ' + p.txnDate + '  ' + (p.vendor || '').padEnd(28).slice(0,28) + ' $' + String(p.amount).padStart(8));
  }
}
if (totalSinClass === 0) console.log('  Ninguno. Todas las utilities aceptadas por Jake ya tienen Class.');

// ── E) Bills nuestras que esperan match QB ────────────────────────────────
console.log('\nE) Bills nuestras pendientes de tag (esperando que Jake acepte el pago en QB)\n');
const pending = await pool.query(`
  SELECT TO_CHAR(email_received_at, 'YYYY-MM') AS month, utility_type, COUNT(*) AS c, SUM(amount_due) AS amt
  FROM utility_bills
  WHERE amount_due > 0 AND qb_tag_status IN ('not_found','pending','error','skipped')
  GROUP BY TO_CHAR(email_received_at, 'YYYY-MM'), utility_type
  ORDER BY month, utility_type
`);
console.log('  Mes      Tipo         Cantidad   Importe');
console.log('  ' + '─'.repeat(50));
for (const r of pending.rows) {
  console.log('  ' + r.month + '  ' + (r.utility_type || 'other').padEnd(12) + '  ' + String(r.c).padStart(7) + '   $' + Math.round(Number(r.amt)).toLocaleString('en-US').padStart(9));
}

// ── F) Bills unassigned ───────────────────────────────────────────────────
const unassigned = await pool.query(`SELECT COUNT(*)::int AS c FROM utility_bills WHERE amount_due > 0 AND property_address IS NULL`);
console.log('\nF) Bills sin propiedad asignada (Jake las tiene que asignar manualmente): ' + unassigned.rows[0].c);

await pool.end();
console.log('\n═══════════════════════════════════════════════════════════');

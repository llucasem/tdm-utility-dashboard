/**
 * Recent QB activity audit — sólo mayo 2026.
 *
 * Muestra 4 vistas:
 *   A) Estado actual de las 6 bills nuevas (#2671-#2676)
 *   B) quickbooks_tag_log — lo que el sistema ha intentado/escrito
 *   C) Purchases de mayo en QB con Class — quién la puso (Jake o nosotros)
 *      basándonos en MetaData.LastUpdatedTime vs qb_tagged_at
 *   D) Notificaciones recientes (drift, rate alarm, etc.)
 *
 * READ-ONLY.
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

function fmtTime(t) {
  if (!t) return '—';
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Auditoría actividad reciente — mayo 2026');
console.log('═══════════════════════════════════════════════════════════\n');

// ── A) Estado actual de las 6 bills nuevas ────────────────────────────────
console.log('A) Las 6 bills nuevas — estado actual\n');
const bills = await pool.query(`
  SELECT id, utility_type, amount_due, email_received_at, property_address, unit, account_last4,
         qb_match_status, qb_match_count, qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at
  FROM utility_bills
  WHERE id = ANY($1::int[]) ORDER BY id
`, [[2671, 2672, 2673, 2674, 2675, 2676]]);

for (const b of bills.rows) {
  console.log(`  Bill #${b.id}  ${b.utility_type} $${b.amount_due}  recv=${b.email_received_at?.toISOString().slice(0,10)}  "${b.property_address}" #${b.unit || ''}  ····${b.account_last4 || '?'}`);
  console.log(`     match=${b.qb_match_status} (${b.qb_match_count || 0})  tag=${b.qb_tag_status}  purchase=${b.qb_purchase_id || '—'}  tagged_at=${fmtTime(b.qb_tagged_at)}`);
}

// ── B) quickbooks_tag_log — últimos 7 días ─────────────────────────────────
console.log('\nB) quickbooks_tag_log — últimos 7 días (lo que el SISTEMA intentó)\n');
const tagLog = await pool.query(`
  SELECT l.*, b.utility_type, b.amount_due, b.property_address, b.unit
  FROM quickbooks_tag_log l
  LEFT JOIN utility_bills b ON l.bill_id = b.id
  WHERE l.tagged_at > NOW() - INTERVAL '7 days'
  ORDER BY l.tagged_at DESC
  LIMIT 50
`);

if (tagLog.rowCount === 0) {
  console.log('  Sin actividad de tag en los últimos 7 días.');
} else {
  console.log(`  ${tagLog.rowCount} entradas:\n`);
  const byStatus = {};
  for (const e of tagLog.rows) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  console.log('  Por estado: ' + Object.entries(byStatus).map(([k,v]) => `${k}=${v}`).join(' · '));
  console.log('');
  for (const e of tagLog.rows.slice(0, 20)) {
    const status = e.status.padEnd(10);
    console.log(`  ${fmtTime(e.tagged_at)}  bill#${e.bill_id}  ${status}  purchase=${e.qb_purchase_id || '—'}  class=${e.qb_class_id_new || '—'}  ${e.error_message || ''}`);
  }
  if (tagLog.rowCount > 20) console.log(`  … (+${tagLog.rowCount - 20} más)`);
}

// ── C) Purchases de mayo con Class — quién la puso ─────────────────────────
console.log('\nC) Purchases de mayo en QB con Class — ¿quién la puso?\n');
const allMay = await qbQuery(`SELECT * FROM Purchase WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31' MAXRESULTS 200`);
const ps = allMay?.QueryResponse?.Purchase || [];

// Identify which have Class set
const classed = [];
for (const p of ps) {
  const topClass = p.ClassRef?.name || null;
  const lineClass = (p.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef?.name).find(Boolean) || null;
  const className = topClass || lineClass;
  if (className) {
    classed.push({
      id: p.Id, vendor: p.EntityRef?.name || '—', amount: Number(p.TotalAmt),
      txnDate: p.TxnDate, className,
      created:  p.MetaData?.CreateTime || null,
      updated:  p.MetaData?.LastUpdatedTime || null,
    });
  }
}

// Cross-check: which ones we tagged (have entry in quickbooks_tag_log with status='tagged')?
const ourTagged = await pool.query(`
  SELECT qb_purchase_id, tagged_at, bill_id FROM quickbooks_tag_log
  WHERE qb_purchase_id IS NOT NULL AND status = 'tagged'
`);
const ourTaggedMap = new Map();
for (const r of ourTagged.rows) ourTaggedMap.set(String(r.qb_purchase_id), { taggedAt: r.tagged_at, billId: r.bill_id });

console.log(`  Purchases mayo totales: ${ps.length}`);
console.log(`  Con Class: ${classed.length}\n`);

const bySource = { 'sistema': 0, 'jake': 0 };
const detailed = [];
for (const p of classed) {
  const ours = ourTaggedMap.get(p.id);
  const source = ours ? 'sistema' : 'jake';
  bySource[source]++;
  detailed.push({ ...p, source, ourTaggedAt: ours?.taggedAt, ourBillId: ours?.billId });
}

console.log(`  Class puesta por NUESTRO sistema: ${bySource.sistema}`);
console.log(`  Class puesta por JAKE (u otra fuente): ${bySource.jake}\n`);

console.log('  Detalle (Purchases con Class, mayo):');
console.log('  Source   Purchase TxnDate    Vendor                    Amount   Class                     Updated');
console.log('  ' + '─'.repeat(110));
for (const d of detailed.sort((a,b) => (b.updated || '').localeCompare(a.updated || ''))) {
  const tag = d.source === 'sistema' ? '🤖 sis' : '👤 jake';
  console.log(`  ${tag}    ${String(d.id).padEnd(8)} ${d.txnDate}  ${(d.vendor || '—').padEnd(25).slice(0,25)} $${String(d.amount).padStart(8)}  ${(d.className || '—').padEnd(25).slice(0,25)} ${fmtTime(d.updated)}`);
}

// ── D) Notificaciones recientes ───────────────────────────────────────────
console.log('\nD) Notificaciones recientes (drift, rate alarm, sync, learning)\n');
const notifs = await pool.query(`
  SELECT id, type, title, message, created_at
  FROM notifications
  WHERE created_at > NOW() - INTERVAL '7 days'
  ORDER BY created_at DESC LIMIT 25
`);
if (notifs.rowCount === 0) {
  console.log('  Sin notificaciones en los últimos 7 días.');
} else {
  for (const n of notifs.rows) {
    const t = n.type.padEnd(8);
    console.log(`  ${fmtTime(n.created_at)}  ${t}  ${n.title}`);
    if (n.message) console.log(`            ${n.message.slice(0, 100)}`);
  }
}

await pool.end();
console.log('\n═══════════════════════════════════════════════════════════');

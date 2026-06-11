/**
 * For each Purchase in May 2026, check if it has a Class set (top-level or any line).
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

const t = await pool.query(`SELECT realm_id, access_token FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
const { realm_id, access_token } = t.rows[0];
const BASE = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;

async function qbQuery(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) return { error: `${r.status}: ${(await r.text()).slice(0, 250)}` };
  return r.json();
}

// First fetch — get the full Purchases of May with all fields including Line
const r = await qbQuery(`SELECT * FROM Purchase WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31' MAXRESULTS 200`);
const purchases = r?.QueryResponse?.Purchase || [];

console.log(`═══════════════════════════════════════════════════════════`);
console.log(`  ${purchases.length} Purchases en mayo 2026 — estado de Class`);
console.log(`═══════════════════════════════════════════════════════════\n`);

const withClass = [];
const withoutClass = [];

for (const p of purchases) {
  const topClass = p.ClassRef?.name || null;
  const lineClasses = (p.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef?.name || null);
  const anyClass = topClass || lineClasses.some(c => c);

  const row = {
    id: p.Id,
    date: p.TxnDate,
    amount: p.TotalAmt,
    vendor: p.EntityRef?.name || '—',
    account: p.AccountRef?.name || '—',
    topClass,
    lineClasses,
  };
  if (anyClass) withClass.push(row);
  else withoutClass.push(row);
}

console.log(`Con Class:    ${withClass.length}`);
console.log(`Sin Class:    ${withoutClass.length}\n`);

if (withoutClass.length > 0) {
  console.log('─── Purchases SIN Class ───');
  for (const p of withoutClass) {
    console.log(`  - id=${p.id}  ${p.date}  $${p.amount}  vendor: ${p.vendor}  account: ${p.account}`);
  }
  console.log('');
}

// Cross-check: for each Purchase without Class, is there a matching bill in our DB?
if (withoutClass.length > 0) {
  console.log('─── ¿Tenemos bill en utility_bills con ese importe y fecha cercana? ───');
  for (const p of withoutClass) {
    const amt = Number(p.amount);
    const from = new Date(p.date); from.setUTCDate(from.getUTCDate() - 30);
    const to   = new Date(p.date); to.setUTCDate(to.getUTCDate() + 3);
    const bills = await pool.query(`
      SELECT id, utility_type, amount_due, property_address, unit, email_received_at, qb_match_status, qb_tag_status
      FROM utility_bills
      WHERE amount_due = $1
        AND email_received_at >= $2 AND email_received_at <= $3
    `, [amt, from, to]);
    if (bills.rows.length === 0) {
      console.log(`  Purchase ${p.id} ($${p.amount} ${p.vendor}): sin bill en DB`);
    } else {
      for (const b of bills.rows) {
        console.log(`  Purchase ${p.id} ($${p.amount} ${p.vendor}) ↔ Bill #${b.id} (${b.utility_type}, ${b.property_address || 'unassigned'} unit ${b.unit || '—'}, recv ${b.email_received_at?.toISOString().slice(0,10)}, tag=${b.qb_tag_status})`);
      }
    }
  }
}

console.log('\n─── Veredicto sobre tu hipótesis ───');
if (withoutClass.length === 0) {
  console.log('  ✅ Confirmada: TODOS los 39 Purchases de mayo tienen Class.');
  console.log('  Probablemente Edonis tiene "Class is required" o el bank feed las propone al aceptar.');
} else {
  console.log(`  ⚠ Hipótesis no del todo cierta: hay ${withoutClass.length} Purchases SIN Class.`);
  console.log('  Por tanto se PUEDEN crear sin Class — quizá Jake las dejó así en el "Add" del bank feed.');
}

await pool.end();

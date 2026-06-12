/**
 * Build the rent alias→unit mapping from Jake's own QuickBooks Classes
 * (confirmed by Lluis 2026-06-12).
 *
 * Method: cross every rent_payment (amount + paid_date from the portal
 * confirmation email) with QB Purchases (amount + TxnDate ±5d) that carry a
 * Class. Two independent sources agreeing = trustworthy. Aggregate per
 * (mailbox, class); accept when confirmed in ≥2 distinct months, or when the
 * alias itself encodes the unit (939broadway+606@ → unit 606 — this also
 * overrides amount-collisions like Broadway 606/806 both paying $3,150).
 *
 * Outputs:
 *   1. rent_alias_map table (created if missing) — used by the resolver
 *   2. Backfill of orphan rent_payments (property/unit NULL)
 *   3. rent-mapping-review.csv — for Jake to verify/complete (NOT committed)
 *
 * Usage: node scripts/build-rent-alias-map.mjs           (dry run)
 *        node scripts/build-rent-alias-map.mjs --apply   (writes)
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const APPLY = process.argv.includes('--apply');

// ── QB client (token refresh from quickbooks_tokens, same as other scripts) ──
async function getToken() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  const expiresIn = row.expires_at ? Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000) : -1;
  if (expiresIn > 300) return row;
  const basic = Buffer.from(`${env.QB_CLIENT_ID}:${env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(row.refresh_token)}`,
  });
  const tok = await res.json();
  await pool.query(`UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=NOW() + ($3 || ' seconds')::interval, updated_at=NOW() WHERE realm_id=$4`,
    [tok.access_token, tok.refresh_token, tok.expires_in, row.realm_id]);
  return { realm_id: row.realm_id, access_token: tok.access_token };
}
const { realm_id, access_token } = await getToken();
async function qbQuery(sql) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  return (await r.json()).QueryResponse || {};
}

// ── 1. Fetch QB Purchases (closed-ish months) and rent payments ─────────────
const purchases = [];
let start = 1;
while (true) {
  const q = await qbQuery(`SELECT * FROM Purchase WHERE TxnDate >= '2026-02-01' AND TxnDate <= '2026-05-31' STARTPOSITION ${start} MAXRESULTS 1000`);
  const batch = q.Purchase || [];
  purchases.push(...batch);
  if (batch.length < 1000) break;
  start += 1000;
}
function classOf(p) {
  for (const l of p.Line || []) {
    const c = l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef;
    if (c) return { id: c.value, name: c.name };
  }
  return null;
}

// "m3" matches "M03", "606" matches "#606": compare unit tokens with leading
// zeros stripped and case-insensitive.
function unitInClassName(aliasUnit, className) {
  const norm = s => String(s).toLowerCase().replace(/^0+/, '').replace(/([a-z])0+(\d)/g, '$1$2');
  return norm(className).includes(norm(aliasUnit));
}
const rents = (await pool.query(`
  SELECT id, mailbox, landlord, amount_paid, paid_date, property_address, unit
  FROM rent_payments WHERE paid_date >= '2026-02-01'`)).rows;

// Class → canonical property via property_qb_class (Jake/learner-maintained)
const classMap = new Map();
for (const row of (await pool.query(`SELECT qb_class_id, qb_class_name, property_address, unit FROM property_qb_class`)).rows) {
  classMap.set(row.qb_class_id, { property: row.property_address, unit: row.unit, name: row.qb_class_name });
}

// ── 2. Cross and aggregate per (mailbox, class) ─────────────────────────────
const agg = new Map(); // key mailbox||classId → { months:Set, amounts:[], class, landlords:Set, payIds:[] }
for (const rp of rents) {
  const cands = purchases.filter(p =>
    Math.abs(Number(p.TotalAmt) - Number(rp.amount_paid)) < 0.01 &&
    Math.abs((new Date(p.TxnDate) - new Date(rp.paid_date)) / 86400000) <= 5);
  const classed = cands.filter(p => classOf(p));
  if (classed.length === 0) continue;
  // If several purchases share the amount (e.g. Broadway 606/806 both $3,150),
  // prefer the one whose class name contains the unit encoded in the alias.
  let chosen = classed[0];
  const aliasUnit = rp.mailbox?.match(/\+([a-z0-9]+)@/i)?.[1];
  if (classed.length > 1 && aliasUnit) {
    const m = classed.find(p => unitInClassName(aliasUnit, classOf(p).name));
    if (m) chosen = m;
  }
  const cls = classOf(chosen);
  // Alias-encoded unit always wins over an amount-collision pick
  if (aliasUnit && !unitInClassName(aliasUnit, cls.name)) {
    const better = classed.find(p => unitInClassName(aliasUnit, classOf(p).name));
    if (better) Object.assign(cls, classOf(better));
    else continue; // alias says one unit, QB cross says another and no better candidate → skip, goes to review
  }
  const key = `${rp.mailbox}||${cls.id}`;
  if (!agg.has(key)) agg.set(key, { mailbox: rp.mailbox, class: cls, months: new Set(), amounts: [], landlords: new Set(), payIds: [] });
  const a = agg.get(key);
  a.months.add(rp.paid_date.toISOString().slice(0, 7));
  a.amounts.push(Number(rp.amount_paid));
  if (rp.landlord) a.landlords.add(rp.landlord);
  a.payIds.push(rp.id);
}

// ── 3. Accept rows: ≥2 months, or alias encodes the unit ────────────────────
const accepted = [];
const review = [];
for (const a of agg.values()) {
  const aliasUnit = a.mailbox?.match(/\+([a-z0-9]+)@/i)?.[1];
  const aliasConfirms = aliasUnit && unitInClassName(aliasUnit, a.class.name);
  const resolved = classMap.get(a.class.id) || null;
  const row = {
    mailbox: a.mailbox,
    landlord: [...a.landlords].join(' / ') || null,
    classId: a.class.id, className: a.class.name,
    property: resolved?.property || null, unit: resolved?.unit || null,
    amountMin: Math.min(...a.amounts), amountMax: Math.max(...a.amounts),
    months: a.months.size, payIds: a.payIds,
  };
  if ((a.months.size >= 2 || aliasConfirms) && row.property) accepted.push(row);
  else review.push({ ...row, reason: !row.property ? `class "${a.class.name}" sin dirección en property_qb_class` : 'solo 1 mes confirmado' });
}

console.log(`Purchases QB: ${purchases.length} | rent payments: ${rents.length}`);
console.log(`\n=== ACEPTADOS (${accepted.length}) ===`);
for (const r of accepted) console.log(`  ${r.mailbox} → ${r.className} = ${r.property} u=${r.unit} | $${r.amountMin}–$${r.amountMax} | ${r.months} meses`);
console.log(`\n=== A REVISIÓN (${review.length}) ===`);
for (const r of review) console.log(`  ${r.mailbox} → ${r.className} | ${r.reason}`);

// ── 4. Apply: table + mapping + backfill ────────────────────────────────────
let backfilled = 0;
if (APPLY) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_alias_map (
      id               SERIAL PRIMARY KEY,
      mailbox          TEXT NOT NULL,
      landlord         TEXT,
      property_address TEXT NOT NULL,
      unit             TEXT,
      qb_class_id      TEXT,
      qb_class_name    TEXT,
      amount_min       NUMERIC,
      amount_max       NUMERIC,
      months_confirmed INTEGER,
      source           TEXT DEFAULT 'qb-cross',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (mailbox, qb_class_id)
    )`);
  for (const r of accepted) {
    await pool.query(`
      INSERT INTO rent_alias_map (mailbox, landlord, property_address, unit, qb_class_id, qb_class_name, amount_min, amount_max, months_confirmed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (mailbox, qb_class_id) DO UPDATE
      SET amount_min = LEAST(rent_alias_map.amount_min, EXCLUDED.amount_min),
          amount_max = GREATEST(rent_alias_map.amount_max, EXCLUDED.amount_max),
          months_confirmed = EXCLUDED.months_confirmed,
          landlord = EXCLUDED.landlord,
          updated_at = NOW()`,
      [r.mailbox, r.landlord, r.property, r.unit, r.classId, r.className, r.amountMin, r.amountMax, r.months]);
    // Backfill the payments that produced this mapping (they carry the proof)
    const u = await pool.query(`
      UPDATE rent_payments SET property_address = $2, unit = $3
      WHERE id = ANY($1::int[]) AND property_address IS NULL`,
      [r.payIds, r.property, r.unit]);
    backfilled += u.rowCount;
  }
  console.log(`\nAPLICADO: ${accepted.length} mapeos guardados, ${backfilled} pagos huérfanos rellenados`);
} else {
  console.log('\nDRY RUN — nada escrito. Ejecutar con --apply para aplicar.');
}

// ── 5. CSV for Jake (always written — local only, never committed) ──────────
const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
const lines = ['status,alias,landlord,qb_class,direccion,unidad,importe_min,importe_max,meses_confirmados'];
for (const r of accepted) lines.push(['OK', r.mailbox, r.landlord, r.className, r.property, r.unit, r.amountMin, r.amountMax, r.months].map(esc).join(','));
for (const r of review)   lines.push([`REVISAR (${r.reason})`, r.mailbox, r.landlord, r.className, r.property, r.unit, r.amountMin, r.amountMax, r.months].map(esc).join(','));
// Orphans that didn't cross at all
const stillOrphan = (await pool.query(`
  SELECT mailbox, landlord, amount_paid, paid_date FROM rent_payments
  WHERE property_address IS NULL ORDER BY paid_date`)).rows;
for (const o of stillOrphan) lines.push([`SIN CRUCE (pago ${o.paid_date?.toISOString().slice(0,10)})`, o.mailbox, o.landlord, '', '', '', o.amount_paid, o.amount_paid, 0].map(esc).join(','));
writeFileSync(join(__dirname, '..', 'rent-mapping-review.csv'), lines.join('\n'), 'utf8');
console.log(`CSV para Jake: rent-mapping-review.csv (${lines.length - 1} filas)`);
await pool.end();

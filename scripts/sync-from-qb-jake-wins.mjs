/**
 * Aggressive sync: Jake's QB data always wins. Resolves the conflicts and
 * unassigned bills that sync-from-qb-classes left flagged.
 *
 * Different from sync-from-qb-classes:
 *  - When a Class on a Purchase points to a property DIFFERENT from the bill's
 *    current property_address, we OVERWRITE the bill's property with the
 *    Class's mapping. (sync-from-qb-classes just logged conflict.)
 *  - When a bill is Unassigned but a classed Purchase matches it by amount+
 *    date, we ASSIGN the property even if the Class is not mapped — we infer
 *    the mapping from the Class.
 *  - Bills already 'tagged' are skipped (idempotent).
 *
 * Read-only against QB. Writes to utility_bills + property_qb_class +
 * class_learning_log.
 *
 * Run:
 *   node scripts/sync-from-qb-jake-wins.mjs            # dry-run
 *   node scripts/sync-from-qb-jake-wins.mjs --apply    # write
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

const APPLY = process.argv.includes('--apply');
const DATE_TOLERANCE_DAYS = 30;
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function getTok() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row;
  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const t = await res.json();
  await pool.query(`UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, new Date(Date.now() + t.expires_in * 1000), row.realm_id]);
  return { ...row, access_token: t.access_token };
}
const tok = await getTok();
async function qb(sql) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`QB ${r.status}`);
  return r.json();
}

function extractClass(p) {
  const top = p?.ClassRef || null;
  const lines = (p?.Line || []).map(l => l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
  return { classId: top?.value || lines[0]?.value || null, className: top?.name || lines[0]?.name || null, hasClass: !!(top?.value || lines.length > 0) };
}
function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function streetOnly(a) { return (a || '').trim().toLowerCase().split(',')[0].replace(/\s+/g, ' '); }
function normUnit(u) { return (u || '').trim().toLowerCase().replace(/^apt\.?\s*/i, '').replace(/^#\s*/, ''); }

async function log({ billId, purchaseId, classId, className, propertyAddress, unit, action, previousClass, details }) {
  if (!APPLY) return;
  await pool.query(
    `INSERT INTO class_learning_log (bill_id, qb_purchase_id, qb_class_id, qb_class_name, property_address, unit, action, previous_class, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [billId, purchaseId, classId, className, propertyAddress, unit, action, previousClass, details]
  );
}

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  SYNC-FROM-QB-JAKE-WINS  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// Pull classed Purchases 2026
console.log('  Pulling classed Purchases from QB...');
const all = [];
let pos = 1;
while (true) {
  const q = await qb(`SELECT * FROM Purchase WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31' STARTPOSITION ${pos} MAXRESULTS 500`);
  const items = q?.QueryResponse?.Purchase || [];
  all.push(...items);
  if (items.length < 500) break;
  pos += 500;
}
const classed = all.map(p => ({ p, cls: extractClass(p) })).filter(x => x.cls.hasClass);
console.log(`    ${all.length} total, ${classed.length} with Class\n`);

// Load mappings
const mapR = await pool.query(`SELECT property_address, unit, qb_class_id, qb_class_name FROM property_qb_class`);
const propByClass = new Map(mapR.rows.map(m => [m.qb_class_id, m]));
console.log(`  ${mapR.rowCount} property↔Class mappings loaded.\n`);

// Load bills
const billsR = await pool.query(`
  SELECT id, property_address, unit, amount_due, due_date::date AS due_date,
         email_received_at::date AS email_date, qb_match_status, qb_tag_status, qb_purchase_id, qb_match_data
  FROM utility_bills
  WHERE amount_due > 0 AND COALESCE(due_date::date, email_received_at::date) >= '2025-12-01'
`);
const billsByAmt = new Map();
for (const b of billsR.rows) {
  const k = Number(b.amount_due).toFixed(2);
  if (!billsByAmt.has(k)) billsByAmt.set(k, []);
  billsByAmt.get(k).push(b);
}
console.log(`  ${billsR.rowCount} bills loaded.\n`);

const stats = { property_overwritten: 0, property_filled: 0, mapping_learned: 0, tag_linked: 0, skipped_tagged: 0, ambiguous: 0, no_bill: 0 };

for (const { p, cls } of classed) {
  const amt = Number(p.TotalAmt).toFixed(2);
  const dateFrom = shiftDate(p.TxnDate, -DATE_TOLERANCE_DAYS);
  const dateTo   = shiftDate(p.TxnDate,  DATE_TOLERANCE_DAYS);
  const candidates = (billsByAmt.get(amt) || []).filter(b => {
    const d = b.due_date || b.email_date;
    if (!d) return false;
    const iso = d.toISOString().slice(0, 10);
    return iso >= dateFrom && iso <= dateTo;
  });
  if (candidates.length === 0) { stats.no_bill++; continue; }

  const mapping = propByClass.get(cls.classId);

  // Pick best bill — prefer one whose property matches the Class mapping
  let target;
  if (mapping) {
    const mapStreet = streetOnly(mapping.property_address);
    const mapUnit   = normUnit(mapping.unit);
    const exact = candidates.filter(b =>
      streetOnly(b.property_address) === mapStreet && normUnit(b.unit) === mapUnit
    );
    if (exact.length === 1) target = exact[0];
    else if (exact.length > 1) {
      // closest date
      const tDate = new Date(p.TxnDate).getTime();
      target = exact.sort((a, b) => Math.abs(new Date(a.due_date || a.email_date).getTime() - tDate) - Math.abs(new Date(b.due_date || b.email_date).getTime() - tDate))[0];
    } else {
      // No bill with matching property — but we have a Class mapping. Pick a
      // candidate (unassigned preferred, else closest date) and OVERWRITE
      // its property to match Jake's reality.
      const unassigned = candidates.filter(b => !b.property_address || !b.property_address.trim());
      target = unassigned[0] || candidates.sort((a, b) => {
        const td = new Date(p.TxnDate).getTime();
        return Math.abs(new Date(a.due_date || a.email_date).getTime() - td) - Math.abs(new Date(b.due_date || b.email_date).getTime() - td);
      })[0];
    }
  } else {
    // Class not mapped. Use bill with property to infer mapping; else unassigned candidate.
    const withProp = candidates.filter(b => b.property_address && b.property_address.trim());
    if (withProp.length === 1) target = withProp[0];
    else if (withProp.length > 1) { stats.ambiguous++; continue; }
    else if (candidates.length === 1) target = candidates[0];
    else { stats.ambiguous++; continue; }
  }

  if (!target) { stats.ambiguous++; continue; }

  // Skip if already tagged with this Purchase
  if (target.qb_tag_status === 'tagged' && target.qb_purchase_id === p.Id) {
    stats.skipped_tagged++;
    continue;
  }

  // Determine what's changing
  const matchData = [{
    type: 'Purchase', id: p.Id, date: p.TxnDate, amount: Number(p.TotalAmt),
    payee: p.EntityRef?.name || null, account: p.AccountRef?.name || null,
    docNumber: p.DocNumber || null, note: p.PrivateNote || null,
    classId: cls.classId, className: cls.className, hasClass: true,
  }];

  let newAddress = target.property_address;
  let newUnit    = target.unit;
  let didOverwrite = false;
  let didFillProperty = false;

  if (mapping) {
    const mapStreet = streetOnly(mapping.property_address);
    const mapUnit   = normUnit(mapping.unit);
    const billStreet = streetOnly(target.property_address);
    const billUnit   = normUnit(target.unit);

    if (!target.property_address || !target.property_address.trim()) {
      // Unassigned → fill
      newAddress = mapping.property_address;
      newUnit    = mapping.unit;
      didFillProperty = true;
    } else if (mapStreet !== billStreet || mapUnit !== billUnit) {
      // Conflict → Jake wins
      newAddress = mapping.property_address;
      newUnit    = mapping.unit;
      didOverwrite = true;
    }
  } else {
    // Class not mapped, but we have a bill. Learn the mapping if bill has property.
    if (target.property_address && target.property_address.trim() && APPLY) {
      await pool.query(`
        INSERT INTO property_qb_class (property_address, unit, qb_class_id, qb_class_name, source, inferred_from_bill_id, inferred_from_purchase_id)
        VALUES ($1, $2, $3, $4, 'inferred', $5, $6)
        ON CONFLICT (property_address, COALESCE(unit, '')) DO NOTHING
      `, [target.property_address.trim(), (target.unit || '').trim() || null, cls.classId, cls.className, target.id, p.Id]);
      stats.mapping_learned++;
    }
  }

  if (APPLY) {
    await pool.query(`
      UPDATE utility_bills
      SET qb_match_status = 'matched',
          qb_match_count  = 1,
          qb_match_data   = $2,
          qb_matched_at   = NOW(),
          qb_purchase_id  = $3,
          qb_class_id     = $4,
          qb_tag_status   = 'tagged',
          qb_tagged_at    = NOW(),
          property_address = $5,
          unit             = $6
      WHERE id = $1
    `, [target.id, JSON.stringify(matchData), p.Id, cls.classId, newAddress, newUnit]);
  }

  await log({
    billId: target.id, purchaseId: p.Id, classId: cls.classId, className: cls.className,
    propertyAddress: newAddress, unit: newUnit,
    action: didOverwrite ? 'property_overwritten' : (didFillProperty ? 'property_filled' : 'synced_from_qb'),
    previousClass: didOverwrite ? `was: ${target.property_address}/${target.unit}` : null,
    details: `Jake-wins sync`,
  });

  stats.tag_linked++;
  if (didOverwrite) stats.property_overwritten++;
  if (didFillProperty) stats.property_filled++;
}

console.log('\n  Results:');
console.log(`    ✓ Bills linked + tagged:        ${stats.tag_linked}`);
console.log(`    ↻ Property overwritten:         ${stats.property_overwritten}`);
console.log(`    + Property filled (Unassigned): ${stats.property_filled}`);
console.log(`    + Mapping learned:              ${stats.mapping_learned}`);
console.log(`    ⏭ Skipped (already tagged):     ${stats.skipped_tagged}`);
console.log(`    ⚠ Ambiguous:                    ${stats.ambiguous}`);
console.log(`    ✗ No matching bill:             ${stats.no_bill}`);

if (!APPLY) console.log('\n  💡 DRY RUN — repite con --apply.\n');
await pool.end();

/**
 * Bootstrap our DB from QuickBooks Classes (Jake's ground truth).
 *
 * One-shot, idempotent. For each Purchase that Jake has assigned a Class to
 * in QB during 2026, find the corresponding utility_bill in our DB and link
 * them — marking the bill as matched+tagged with Jake's verified Class.
 *
 * Also: auto-fills property_address+unit on Unassigned bills when the Class
 * unambiguously identifies the property, and learns new property→Class
 * mappings when the bill data lets us infer them.
 *
 * Read-only against QB. Writes to:
 *   - utility_bills (qb_match_*, qb_tag_*, qb_purchase_id, qb_class_*, property_address, unit)
 *   - property_qb_class (INSERT inferred mappings)
 *   - class_learning_log (audit trail)
 *
 * Usage:
 *   node scripts/sync-from-qb-classes.mjs            # dry-run (default)
 *   node scripts/sync-from-qb-classes.mjs --apply    # write to DB
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
const PURCHASE_DATE_FROM  = '2026-01-01';
const PURCHASE_DATE_TO    = '2026-12-31';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── QB token + query helpers (self-contained) ────────────────────────────
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
  const url = `https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`QB ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── Helpers para extraer Class + normalizar property/unit ────────────────
function extractClassInfo(purchase) {
  const topClass = purchase?.ClassRef || null;
  const lineClasses = (purchase?.Line || [])
    .map(l => l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef)
    .filter(Boolean);
  return {
    classId:   topClass?.value || lineClasses[0]?.value || null,
    className: topClass?.name  || lineClasses[0]?.name  || null,
    hasClass:  !!(topClass?.value || lineClasses.length > 0),
  };
}

function streetOnly(addr) {
  return (addr || '').trim().toLowerCase().split(',')[0].replace(/\s+/g, ' ');
}
function normUnit(u) {
  return (u || '').trim().toLowerCase().replace(/^apt\.?\s*/i, '').replace(/^#\s*/, '');
}
function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function log({ billId = null, purchaseId, classId, className, propertyAddress = null, unit = null, action, previousClass = null, details = null }) {
  if (!APPLY) return;
  await pool.query(`
    INSERT INTO class_learning_log
      (bill_id, qb_purchase_id, qb_class_id, qb_class_name, property_address, unit, action, previous_class, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [billId, purchaseId, classId, className, propertyAddress, unit, action, previousClass, details]);
}

// ── Main ─────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  SYNC-FROM-QB-CLASSES  ${APPLY ? '(APPLY — WILL WRITE)' : '(DRY RUN)'}`);
console.log(`  QB realm: ${tok.realm_id}`);
console.log(`  Window:   ${PURCHASE_DATE_FROM} → ${PURCHASE_DATE_TO}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

// 1. Pull ALL Purchases of 2026 (paginated)
console.log('  Pulling Purchases from QB...');
const purchases = [];
let pos = 1;
while (true) {
  const q = await qb(`SELECT * FROM Purchase WHERE TxnDate >= '${PURCHASE_DATE_FROM}' AND TxnDate <= '${PURCHASE_DATE_TO}' STARTPOSITION ${pos} MAXRESULTS 500`);
  const items = q?.QueryResponse?.Purchase || [];
  purchases.push(...items);
  if (items.length < 500) break;
  pos += 500;
}
console.log(`    Total Purchases 2026:       ${purchases.length}`);

const classed = purchases
  .map(p => ({ p, cls: extractClassInfo(p) }))
  .filter(x => x.cls.hasClass);
console.log(`    With Class assigned:        ${classed.length}\n`);

// 2. Load property_qb_class into a Map keyed by class_id
const mappingsR = await pool.query(`SELECT property_address, unit, qb_class_id, qb_class_name, source FROM property_qb_class`);
const propertyByClassId = new Map();
for (const m of mappingsR.rows) {
  propertyByClassId.set(m.qb_class_id, m);
}
console.log(`  Loaded ${propertyByClassId.size} existing property↔Class mappings.\n`);

// 3. Load all utility_bills of 2026 into a Map keyed by amount (cheap lookup)
const billsR = await pool.query(`
  SELECT id, property_address, unit, amount_due, due_date::date AS due_date,
         email_received_at::date AS email_date, email_from,
         qb_match_status, qb_match_data, qb_tag_status, qb_purchase_id
  FROM utility_bills
  WHERE COALESCE(due_date::date, email_received_at::date) >= '2025-12-01'
    AND amount_due IS NOT NULL AND amount_due > 0
`);
const billsByAmt = new Map();
for (const b of billsR.rows) {
  const key = Number(b.amount_due).toFixed(2);
  if (!billsByAmt.has(key)) billsByAmt.set(key, []);
  billsByAmt.get(key).push(b);
}
console.log(`  Loaded ${billsR.rowCount} utility_bills.\n`);

// 4. Process each classed Purchase
const stats = {
  linked: 0,
  property_filled: 0,
  replaced: 0,
  mapping_learned: 0,
  conflict_property: 0,
  ambiguous: 0,
  unknown_class_no_bill: 0,
  purchase_without_bill: 0,
  skipped_already_tagged: 0,
};
const byMonth = {};
const unknownClasses = new Map();   // classId → { className, count }
const purchasesWithoutBill = [];

for (const { p, cls } of classed) {
  const purchaseId = p.Id;
  const txnDate    = p.TxnDate;
  const amount     = Number(p.TotalAmt);
  const payee      = p.EntityRef?.name || null;
  const amtKey     = amount.toFixed(2);
  const month      = txnDate.slice(0, 7);

  const dateFrom = shiftDate(txnDate, -DATE_TOLERANCE_DAYS);
  const dateTo   = shiftDate(txnDate,  DATE_TOLERANCE_DAYS);

  const mapping = propertyByClassId.get(cls.classId);
  const allCandidates = (billsByAmt.get(amtKey) || []).filter(b => {
    const billDate = b.due_date || b.email_date;
    if (!billDate) return false;
    const iso = billDate.toISOString().slice(0, 10);
    return iso >= dateFrom && iso <= dateTo;
  });

  if (allCandidates.length === 0) {
    stats.purchase_without_bill++;
    purchasesWithoutBill.push({ id: purchaseId, date: txnDate, amount, payee, classId: cls.classId, className: cls.className });
    continue;
  }

  // Pick the best candidate
  let candidate = null;

  // Helper: pick the bill closest to the Purchase's TxnDate
  const pickClosest = (bills) => {
    const txnTs = new Date(txnDate).getTime();
    return bills.slice().sort((a, b) => {
      const aTs = (a.due_date || a.email_date).getTime();
      const bTs = (b.due_date || b.email_date).getTime();
      return Math.abs(aTs - txnTs) - Math.abs(bTs - txnTs);
    })[0];
  };

  if (mapping) {
    // Prefer bill whose property+unit matches the mapping
    const mapStreet = streetOnly(mapping.property_address);
    const mapUnit   = normUnit(mapping.unit);
    const propMatch = allCandidates.filter(b =>
      streetOnly(b.property_address) === mapStreet && normUnit(b.unit) === mapUnit
    );
    if (propMatch.length === 1) {
      candidate = { bill: propMatch[0], reason: 'property_match' };
    } else if (propMatch.length > 1) {
      // Misma propiedad, varias bills (probablemente meses distintos mismo importe).
      // Elegir la más cercana en fecha al Purchase.
      candidate = { bill: pickClosest(propMatch), reason: 'property_match_closest_date' };
    } else {
      // No bill with matching property; pick the unassigned one if there's exactly one
      const unassigned = allCandidates.filter(b => !b.property_address || !b.property_address.trim());
      if (unassigned.length === 1) {
        candidate = { bill: unassigned[0], reason: 'unassigned', fillProperty: true };
      } else if (unassigned.length > 1) {
        // Varias unassigned con mismo importe+fecha. Elegir la más cercana en fecha.
        candidate = { bill: pickClosest(unassigned), reason: 'unassigned_closest_date', fillProperty: true };
      } else {
        // Bills exist with amount+date but all have a DIFFERENT property than the Class says
        stats.conflict_property++;
        await log({
          purchaseId, classId: cls.classId, className: cls.className,
          propertyAddress: mapping.property_address, unit: mapping.unit,
          action: 'conflict',
          details: `Class points to "${mapping.property_address}/${mapping.unit}" but ${allCandidates.length} bills with same amount+date have different properties: ` +
                   allCandidates.map(b => `#${b.id}=${b.property_address}/${b.unit}`).join('; '),
        });
        continue;
      }
    }
  } else {
    // Class is not mapped. Try to infer.
    const withProperty = allCandidates.filter(b => b.property_address && b.property_address.trim());
    if (withProperty.length === 1) {
      candidate = { bill: withProperty[0], reason: 'inferring_mapping', inferMapping: true };
    } else if (withProperty.length > 1) {
      // Several bills with different properties match this Purchase — ambiguous
      stats.ambiguous++;
      continue;
    } else if (allCandidates.length === 1 && !allCandidates[0].property_address) {
      // Only unassigned bill candidate — can't infer mapping without property data
      const k = cls.classId;
      const entry = unknownClasses.get(k) || { className: cls.className, count: 0 };
      entry.count++;
      unknownClasses.set(k, entry);
      stats.unknown_class_no_bill++;
      continue;
    } else {
      stats.ambiguous++;
      continue;
    }
  }

  // ── We have a candidate — LINK it
  if (candidate.ambiguous) {
    stats.ambiguous++;
    continue;
  }

  const bill = candidate.bill;
  if (bill.qb_tag_status === 'tagged' && bill.qb_purchase_id === purchaseId) {
    stats.skipped_already_tagged++;
    continue;
  }

  // Check if this is a "replace" — the bill currently links to a different Purchase
  const oldPurchaseId = bill.qb_purchase_id || (bill.qb_match_data?.[0]?.id);
  const isReplace = oldPurchaseId && oldPurchaseId !== purchaseId;

  const matchData = [{
    type: 'Purchase',
    id: purchaseId,
    date: txnDate,
    amount,
    payee,
    account: p.AccountRef?.name || null,
    docNumber: p.DocNumber || null,
    note: p.PrivateNote || null,
    classId: cls.classId,
    className: cls.className,
    hasClass: true,
  }];

  const fillAddr = candidate.fillProperty;
  const newProperty = fillAddr ? (mapping?.property_address || null) : null;
  const newUnit     = fillAddr ? (mapping?.unit || null)             : null;

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
          property_address = COALESCE($5, property_address),
          unit             = COALESCE($6, unit)
      WHERE id = $1
    `, [bill.id, JSON.stringify(matchData), purchaseId, cls.classId, newProperty, newUnit]);
  }

  await log({
    billId: bill.id, purchaseId,
    classId: cls.classId, className: cls.className,
    propertyAddress: newProperty || bill.property_address,
    unit: newUnit || bill.unit,
    action: isReplace ? 'replaced' : 'synced_from_qb',
    previousClass: isReplace ? `Purchase ${oldPurchaseId}` : null,
    details: candidate.reason + (isReplace ? ` (replaced old Purchase ${oldPurchaseId})` : ''),
  });

  stats.linked++;
  if (fillAddr) stats.property_filled++;
  if (isReplace) stats.replaced++;
  byMonth[month] = (byMonth[month] || 0) + 1;

  // If Class was unmapped, learn the mapping
  if (candidate.inferMapping) {
    if (APPLY) {
      await pool.query(`
        INSERT INTO property_qb_class
          (property_address, unit, qb_class_id, qb_class_name, source, inferred_from_bill_id, inferred_from_purchase_id)
        VALUES ($1, $2, $3, $4, 'inferred', $5, $6)
        ON CONFLICT (property_address, COALESCE(unit, '')) DO NOTHING
      `, [bill.property_address.trim(), (bill.unit || '').trim() || null, cls.classId, cls.className, bill.id, purchaseId]);
    }
    await log({
      billId: bill.id, purchaseId,
      classId: cls.classId, className: cls.className,
      propertyAddress: bill.property_address, unit: bill.unit,
      action: 'created',
      details: 'Mapping learned during sync-from-qb',
    });
    stats.mapping_learned++;
  }
}

// ── Report ───────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`  RESULTS  ${APPLY ? '(applied)' : '(dry-run)'}`);
console.log('═══════════════════════════════════════════════════════════════════\n');
console.log(`  ✓ Linked (matched + tagged) .......... ${stats.linked}`);
console.log(`  + Property auto-assigned ............. ${stats.property_filled}`);
console.log(`  ↻ Replaced previous match ............ ${stats.replaced}`);
console.log(`  + Mapping learned (inferred) ......... ${stats.mapping_learned}`);
console.log(`  ⏭ Skipped (already tagged correctly) . ${stats.skipped_already_tagged}`);
console.log(`  ⚠ Property conflict .................. ${stats.conflict_property}`);
console.log(`  ⚠ Ambiguous (multiple bills) ......... ${stats.ambiguous}`);
console.log(`  ✗ Class unmapped, no clear bill ...... ${stats.unknown_class_no_bill}`);
console.log(`  ✗ Purchase without matching bill ..... ${stats.purchase_without_bill}`);

console.log('\n  Linked by month:');
for (const m of Object.keys(byMonth).sort()) console.log(`    ${m}: ${byMonth[m]}`);

if (unknownClasses.size > 0) {
  console.log(`\n  Unknown Classes (top 15):`);
  const top = [...unknownClasses.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  for (const [id, e] of top) console.log(`    "${e.className}" (id ${id}) × ${e.count}`);
}

if (purchasesWithoutBill.length > 0) {
  console.log(`\n  Purchases sin matching bill (top 20):`);
  for (const p of purchasesWithoutBill.slice(0, 20)) {
    console.log(`    ${p.date}  $${p.amount.toFixed(2).padStart(8)}  ${(p.payee || '-').padEnd(25)}  → ${p.className}`);
  }
  if (purchasesWithoutBill.length > 20) console.log(`    ... and ${purchasesWithoutBill.length - 20} more`);
}

if (!APPLY) {
  console.log('\n  💡 DRY RUN — no se ha escrito nada. Repite con --apply para aplicar.\n');
}

await pool.end();

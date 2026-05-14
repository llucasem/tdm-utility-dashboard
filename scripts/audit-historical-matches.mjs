/**
 * Historical reconciliation: re-verify every `matched` utility_bill against
 * the current state of its QuickBooks Purchase.
 *
 * Categorizes each existing match as:
 *   - confirmed: Purchase has the same Class our mapping expects
 *   - inferred:  Purchase has a Class but our bill had no mapping → learn it
 *   - conflict:  Purchase has a Class that disagrees with our mapping
 *   - claimed_other: Purchase has a Class that maps to a DIFFERENT property
 *                    → this match was a collision (false positive). Demote to
 *                    `ambiguous` and clear qb_match_data so it re-evaluates.
 *   - unclaimed: Purchase still has no Class — match remains valid
 *
 * Read-only by default. Pass `--apply` to actually mutate state.
 *
 * Run with:
 *   node scripts/audit-historical-matches.mjs             # dry-run
 *   node scripts/audit-historical-matches.mjs --apply     # write changes
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

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Self-contained QB client (avoids next.js path aliases) ───────────────
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
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, new Date(Date.now() + t.expires_in * 1000), row.realm_id]
  );
  return { ...row, access_token: t.access_token };
}
const tok = await getTok();

async function qbGet(path) {
  const url = `https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}${path}?minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`QB ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractClass(purchase) {
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

// ── Load mappings as a quick lookup table ────────────────────────────────
const mappings = await pool.query(`SELECT property_address, COALESCE(unit, '') AS unit, qb_class_id, qb_class_name, source FROM property_qb_class`);
const mapByPropertyKey = new Map();
const mapByClassId = new Map();
for (const m of mappings.rows) {
  const key = `${m.property_address.trim().toLowerCase()}|${m.unit.trim().toLowerCase()}`;
  mapByPropertyKey.set(key, m);
  mapByClassId.set(m.qb_class_id, m);
}

function propertyKey(addr, unit) {
  return `${(addr || '').trim().toLowerCase().split(',')[0]}|${(unit || '').trim().toLowerCase().replace(/^apt\.?\s*/i, '').replace(/^#\s*/, '')}`;
}

// ── Iterate matched bills ────────────────────────────────────────────────
const r = await pool.query(`
  SELECT id, property_address, unit, amount_due, due_date, email_received_at, qb_match_data
  FROM utility_bills
  WHERE qb_match_status = 'matched'
    AND amount_due > 0
    AND qb_match_data IS NOT NULL
  ORDER BY id
`);

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  HISTORICAL AUDIT  ${APPLY ? '(APPLY MODE — WILL WRITE)' : '(DRY RUN)'}`);
console.log(`  ${r.rowCount} bills with qb_match_status='matched' to inspect`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

const stats = { unclaimed: 0, confirmed: 0, inferred: 0, conflict: 0, claimed_other: 0, errors: 0 };
const conflictRows = [];
const claimedOtherRows = [];

for (let i = 0; i < r.rows.length; i++) {
  const b = r.rows[i];
  if (i % 25 === 0) process.stdout.write(`\r  ⏳ ${i + 1}/${r.rowCount}  conf=${stats.confirmed} inf=${stats.inferred} clm-other=${stats.claimed_other} conflict=${stats.conflict}`);

  const matches = b.qb_match_data || [];
  const firstPurchase = matches.find(m => m.type === 'Purchase');
  if (!firstPurchase) continue;

  let purchase;
  try {
    purchase = (await qbGet(`/purchase/${firstPurchase.id}`))?.Purchase;
  } catch (e) {
    stats.errors++;
    continue;
  }
  if (!purchase) { stats.errors++; continue; }

  const cls = extractClass(purchase);

  if (!cls.hasClass) {
    stats.unclaimed++;
    continue;
  }

  // Purchase has a Class. Look up what property it belongs to (according to mappings).
  const classOwnerMapping = mapByClassId.get(cls.classId);
  const billKey = propertyKey(b.property_address, b.unit);
  const billMapping = b.property_address ? mapByPropertyKey.get(billKey) : null;

  if (billMapping && billMapping.qb_class_id === cls.classId) {
    stats.confirmed++;
    continue;
  }

  if (classOwnerMapping) {
    const ownerKey = propertyKey(classOwnerMapping.property_address, classOwnerMapping.unit);
    if (ownerKey !== billKey) {
      // The Purchase is claimed by a DIFFERENT property. Our match was a collision.
      stats.claimed_other++;
      claimedOtherRows.push({ bill: b, purchase, ownerMapping: classOwnerMapping });
      continue;
    }
  }

  if (!billMapping && b.property_address) {
    // Bill has a property but no mapping yet. The Class on the Purchase
    // tells us the mapping → infer it.
    stats.inferred++;
    if (APPLY) {
      await pool.query(`
        INSERT INTO property_qb_class
          (property_address, unit, qb_class_id, qb_class_name, source, inferred_from_bill_id, inferred_from_purchase_id)
        VALUES ($1, $2, $3, $4, 'inferred', $5, $6)
        ON CONFLICT (property_address, COALESCE(unit, '')) DO NOTHING
      `, [b.property_address.trim(), (b.unit || '').trim() || null, cls.classId, cls.className, b.id, purchase.Id]);
      await pool.query(`
        INSERT INTO class_learning_log (bill_id, qb_purchase_id, qb_class_id, qb_class_name, property_address, unit, action, details)
        VALUES ($1, $2, $3, $4, $5, $6, 'created', 'Inferred during historical audit')
      `, [b.id, purchase.Id, cls.classId, cls.className, b.property_address.trim(), (b.unit || '').trim() || null]);
    }
    continue;
  }

  // Otherwise it's a real conflict.
  stats.conflict++;
  conflictRows.push({ bill: b, purchase, billMapping, qbClass: cls });
}

console.log(`\n\n  Summary:`);
console.log(`    ✓ confirmed    (Class matches mapping):                 ${stats.confirmed}`);
console.log(`    + inferred     (bill had property, no mapping yet):     ${stats.inferred}`);
console.log(`    · unclaimed    (Purchase still has no Class):           ${stats.unclaimed}`);
console.log(`    ⚠ claimed_other (Purchase owned by another property):    ${stats.claimed_other}`);
console.log(`    ✗ conflict     (mapping vs Class disagree):             ${stats.conflict}`);
console.log(`    ! errors:                                                ${stats.errors}`);

if (claimedOtherRows.length > 0) {
  console.log(`\n  — Collisions to demote (claimed_other) —`);
  for (const c of claimedOtherRows.slice(0, 30)) {
    console.log(`    bill #${c.bill.id} ($${c.bill.amount_due}, ${(c.bill.property_address || '-').slice(0,30)}) → Purchase ${c.purchase.Id} is class "${c.ownerMapping.qb_class_name}" mapped to ${(c.ownerMapping.property_address || '').slice(0,40)}`);
  }
  if (APPLY) {
    console.log(`\n  Applying: demoting these to qb_match_status='ambiguous' so they re-evaluate...`);
    const ids = claimedOtherRows.map(c => c.bill.id);
    await pool.query(`
      UPDATE utility_bills
      SET qb_match_status = 'ambiguous',
          qb_match_data   = '[]'::jsonb,
          qb_match_count  = 0,
          qb_matched_at   = NOW()
      WHERE id = ANY($1::int[])
    `, [ids]);
    console.log(`    Done: ${ids.length} bills demoted.`);
  }
}

if (conflictRows.length > 0) {
  console.log(`\n  — Conflicts (mapping vs Jake's Class disagree) —`);
  for (const c of conflictRows.slice(0, 30)) {
    console.log(`    bill #${c.bill.id} property=${(c.bill.property_address || '-').slice(0,30)} u=${c.bill.unit || '-'}`);
    console.log(`        our mapping: ${c.billMapping?.qb_class_name || '(none)'} (${c.billMapping?.source || '-'})`);
    console.log(`        QB Class:    ${c.qbClass.className} (${c.qbClass.classId})`);
  }
}

if (!APPLY) {
  console.log(`\n  💡 This was a DRY RUN. Re-run with --apply to write changes.`);
}

await pool.end();

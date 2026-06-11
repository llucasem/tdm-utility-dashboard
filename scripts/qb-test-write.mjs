/**
 * Test write capability: can we tag a Purchase with property/unit info?
 *
 * Flow:
 *  1. Discover whether Classes (or Departments) are enabled and what's available
 *  2. Pick a Purchase with a unique match (Spectrum $61.24 on 2026-04-23)
 *  3. Snapshot original
 *  4. Try update (Class if available, else PrivateNote)
 *  5. Verify
 *  6. Revert to original
 *  7. Verify revert
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

async function qbGet(path) {
  const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  return { status: r.status, body: await r.json().catch(() => null), text: null };
}

async function qbQuery(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  return r.json();
}

async function qbPost(path, payload) {
  const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}minorversion=70`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

console.log('═══ STEP 1 — Are Classes/Departments enabled? ═══');
const prefs = await qbQuery(`SELECT * FROM Preferences`);
const ai = prefs?.QueryResponse?.Preferences?.[0]?.AccountingInfoPrefs;
console.log(`  TrackDepartments: ${ai?.TrackDepartments}  (${ai?.DepartmentTerminology || 'no terminology'})`);
console.log(`  ClassTrackingPerTxn: ${ai?.ClassTrackingPerTxn}`);
console.log(`  ClassTrackingPerTxnLine: ${ai?.ClassTrackingPerTxnLine}`);

const classes = await qbQuery(`SELECT Id, Name, FullyQualifiedName FROM Class MAXRESULTS 20`);
const allClasses = classes?.QueryResponse?.Class || [];
console.log(`\n  Classes defined: ${allClasses.length}`);
allClasses.slice(0, 20).forEach(c => console.log(`    - id=${c.Id}  ${c.FullyQualifiedName || c.Name}`));

console.log('\n═══ STEP 2 — Pick a target Purchase ═══');
const target = await qbQuery(`SELECT * FROM Purchase WHERE TotalAmt = '61.24' AND TxnDate = '2026-04-23' MAXRESULTS 1`);
const purchase = target?.QueryResponse?.Purchase?.[0];
if (!purchase) { console.error('No matching Purchase found'); process.exit(1); }
console.log(`  Found Purchase Id=${purchase.Id}  TxnDate=${purchase.TxnDate}  TotalAmt=${purchase.TotalAmt}`);
console.log(`  Payee: ${purchase.EntityRef?.name}  Account: ${purchase.AccountRef?.name}`);
console.log(`  Lines: ${purchase.Line?.length || 0}`);
purchase.Line?.forEach((l, i) => {
  console.log(`    Line ${i}: amount=${l.Amount}  ClassRef=${JSON.stringify(l.AccountBasedExpenseLineDetail?.ClassRef || null)}  desc="${l.Description || ''}"`);
});
console.log(`  PrivateNote: "${purchase.PrivateNote || ''}"`);
console.log(`  SyncToken: ${purchase.SyncToken}`);

console.log('\n═══ STEP 3 — Fetch full Purchase by Id (snapshot) ═══');
const snap = await qbGet(`/purchase/${purchase.Id}`);
const original = snap.body?.Purchase;
console.log(`  Snapshot saved. SyncToken=${original?.SyncToken}`);

console.log('\n═══ STEP 4 — Attempt UPDATE ═══');

// Decide what to write. Prefer ClassRef if Classes exist, else PrivateNote.
let writeStrategy, payload;
if (allClasses.length > 0) {
  writeStrategy = 'ClassRef';
  const testClass = allClasses[0];
  console.log(`  Strategy: ClassRef → using Class id=${testClass.Id} "${testClass.Name}"`);
  payload = {
    ...original,
    sparse: true,
    Line: original.Line.map(l => ({
      ...l,
      AccountBasedExpenseLineDetail: {
        ...(l.AccountBasedExpenseLineDetail || {}),
        ClassRef: { value: testClass.Id, name: testClass.Name },
      },
    })),
  };
} else {
  writeStrategy = 'PrivateNote';
  console.log(`  Strategy: PrivateNote (Classes are not enabled or empty)`);
  payload = {
    ...original,
    sparse: true,
    PrivateNote: '[TEST] property=123 Main St unit=4B',
  };
}

console.log('  Sending update...');
const updateRes = await qbPost(`/purchase`, payload);
console.log(`  Status: ${updateRes.status}`);
if (updateRes.status >= 400) {
  console.log(`  Error body: ${JSON.stringify(updateRes.body).slice(0, 500)}`);
  console.log('\n❌ UPDATE FAILED — write capability NOT available with this token/scope');
  process.exit(1);
}
const updated = updateRes.body?.Purchase;
console.log(`  ✓ Update accepted. New SyncToken=${updated?.SyncToken}`);
if (writeStrategy === 'PrivateNote') {
  console.log(`  PrivateNote now: "${updated?.PrivateNote}"`);
} else {
  console.log(`  Line[0] ClassRef now: ${JSON.stringify(updated?.Line?.[0]?.AccountBasedExpenseLineDetail?.ClassRef)}`);
}

console.log('\n═══ STEP 5 — Re-fetch to confirm change persisted ═══');
const verify = await qbGet(`/purchase/${purchase.Id}`);
const after = verify.body?.Purchase;
if (writeStrategy === 'PrivateNote') {
  console.log(`  Confirmed PrivateNote: "${after?.PrivateNote}"`);
} else {
  console.log(`  Confirmed Line[0] ClassRef: ${JSON.stringify(after?.Line?.[0]?.AccountBasedExpenseLineDetail?.ClassRef)}`);
}

console.log('\n═══ STEP 6 — Revert to original state ═══');
const revertPayload = {
  ...after,
  sparse: true,
  ...(writeStrategy === 'PrivateNote'
    ? { PrivateNote: original.PrivateNote || '' }
    : {
        Line: after.Line.map((l, i) => ({
          ...l,
          AccountBasedExpenseLineDetail: {
            ...(l.AccountBasedExpenseLineDetail || {}),
            ClassRef: original.Line[i]?.AccountBasedExpenseLineDetail?.ClassRef || undefined,
          },
        })),
      }),
};

const revertRes = await qbPost(`/purchase`, revertPayload);
console.log(`  Status: ${revertRes.status}`);
if (revertRes.status >= 400) {
  console.log(`  ⚠ Revert failed: ${JSON.stringify(revertRes.body).slice(0, 400)}`);
  console.log(`  Manual cleanup may be needed for Purchase ${purchase.Id}`);
} else {
  console.log(`  ✓ Revert accepted. New SyncToken=${revertRes.body?.Purchase?.SyncToken}`);
}

console.log('\n═══ STEP 7 — Final verification ═══');
const final = await qbGet(`/purchase/${purchase.Id}`);
const fin = final.body?.Purchase;
console.log(`  Final PrivateNote: "${fin?.PrivateNote || ''}"`);
console.log(`  Final Line[0] ClassRef: ${JSON.stringify(fin?.Line?.[0]?.AccountBasedExpenseLineDetail?.ClassRef || null)}`);
console.log(`  Original PrivateNote: "${original.PrivateNote || ''}"`);
console.log(`  Original Line[0] ClassRef: ${JSON.stringify(original.Line?.[0]?.AccountBasedExpenseLineDetail?.ClassRef || null)}`);

const samePN = (fin?.PrivateNote || '') === (original.PrivateNote || '');
const sameClass = JSON.stringify(fin?.Line?.[0]?.AccountBasedExpenseLineDetail?.ClassRef || null)
                === JSON.stringify(original.Line?.[0]?.AccountBasedExpenseLineDetail?.ClassRef || null);

if (samePN && sameClass) {
  console.log('\n✅ SUCCESS: write capability confirmed AND original state restored.');
} else {
  console.log('\n⚠ Final state differs from original — review Purchase manually.');
}

await pool.end();

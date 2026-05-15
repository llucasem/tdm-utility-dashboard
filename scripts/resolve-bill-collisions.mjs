/**
 * Resolve bill-purchase collisions: cases where the SAME Purchase is linked
 * to MORE THAN ONE bill in our DB (visible in qb_match_data of multiple bills).
 *
 * Algoritmo:
 *   1. Find bills that share a Purchase
 *   2. Fetch that Purchase from QB to read its current Class
 *   3. The bill whose property matches the Class is the correct one → keep
 *   4. The other(s) → demote to 'pending' (no qb_match_data) so the next cron
 *      can re-evaluate them with bill-purchase exclusivity (it'll find the
 *      Purchase already taken and skip → status becomes not_found)
 *
 * Read-only on QB. Writes to utility_bills.
 *
 * Run:
 *   node scripts/resolve-bill-collisions.mjs            # dry-run
 *   node scripts/resolve-bill-collisions.mjs --apply    # write
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

async function getPurchase(id) {
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/purchase/${id}?minorversion=70`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return (await r.json()).Purchase;
}

function extractClass(p) {
  const top = p?.ClassRef || null;
  const lines = (p?.Line || []).map(l => l.AccountBasedExpenseLineDetail?.ClassRef || l.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
  return {
    classId:   top?.value || lines[0]?.value || null,
    className: top?.name  || lines[0]?.name  || null,
    hasClass:  !!(top?.value || lines.length > 0),
  };
}

function streetOnly(a) { return (a || '').trim().toLowerCase().split(',')[0].replace(/\s+/g, ' '); }
function normUnit(u)   { return (u || '').trim().toLowerCase().replace(/^apt\.?\s*/i, '').replace(/^#\s*/, ''); }

console.log(`\n═══════════════════════════════════════════════════════════════════`);
console.log(`  RESOLVE BILL-PURCHASE COLLISIONS  ${APPLY ? '(APPLY)' : '(DRY RUN)'}`);
console.log(`═══════════════════════════════════════════════════════════════════\n`);

const r = await pool.query(`
  WITH expanded AS (
    SELECT id, property_address, unit, (m->>'id') AS purchase_id
    FROM utility_bills, LATERAL jsonb_array_elements(qb_match_data) AS m
    WHERE qb_match_status = 'matched' AND qb_match_data IS NOT NULL
  )
  SELECT purchase_id, array_agg(json_build_object('id', id, 'addr', property_address, 'unit', unit)) AS bills
  FROM expanded GROUP BY 1 HAVING COUNT(DISTINCT id) > 1
`);
console.log(`  Collisions to resolve: ${r.rowCount}\n`);

// Load mappings to translate Class → property
const mapR = await pool.query(`SELECT property_address, unit, qb_class_id, qb_class_name FROM property_qb_class`);
const propByClassId = new Map(mapR.rows.map(m => [m.qb_class_id, m]));

let kept = 0, demoted = 0, unresolved = 0;

for (const row of r.rows) {
  const purchase = await getPurchase(row.purchase_id);
  if (!purchase) {
    console.log(`  ✗ Purchase ${row.purchase_id}: could not fetch from QB`);
    unresolved++;
    continue;
  }
  const cls = extractClass(purchase);
  if (!cls.hasClass) {
    console.log(`  ⚠ Purchase ${row.purchase_id}: no Class assigned in QB → can't resolve`);
    unresolved++;
    continue;
  }
  const classMapping = propByClassId.get(cls.classId);
  if (!classMapping) {
    console.log(`  ⚠ Purchase ${row.purchase_id}: Class "${cls.className}" not in property_qb_class → can't resolve`);
    unresolved++;
    continue;
  }

  const classStreet = streetOnly(classMapping.property_address);
  const classUnit   = normUnit(classMapping.unit);

  const matches = row.bills.filter(b =>
    streetOnly(b.addr) === classStreet && normUnit(b.unit) === classUnit
  );
  const nonMatches = row.bills.filter(b => !matches.some(m => m.id === b.id));

  console.log(`  Purchase ${row.purchase_id} → Class "${cls.className}" (${classMapping.property_address.slice(0,30)} #${classMapping.unit})`);
  for (const m of matches)    console.log(`     ✓ keep    #${m.id} (${(m.addr||'-').slice(0,30)} u=${m.unit}) — matches Class`);
  for (const n of nonMatches) console.log(`     ✗ demote  #${n.id} (${(n.addr||'-').slice(0,30)} u=${n.unit}) — wrong property`);

  if (matches.length === 0) {
    console.log(`     [skip — no bill matches the Class, would lose all]`);
    unresolved++;
    continue;
  }

  if (APPLY) {
    for (const n of nonMatches) {
      await pool.query(`
        UPDATE utility_bills
        SET qb_match_status = 'pending',
            qb_match_count  = 0,
            qb_match_data   = NULL,
            qb_matched_at   = NOW(),
            qb_tag_status   = 'pending',
            qb_purchase_id  = NULL,
            qb_class_id     = NULL,
            qb_tagged_at    = NULL,
            qb_match_error  = 'collision-resolved: this Purchase belongs to property "' || $2 || '"'
        WHERE id = $1
      `, [n.id, classMapping.property_address]);
      demoted++;
    }
    kept += matches.length;
  }
}

console.log(`\n  Resumen: keep=${kept} demote=${demoted} unresolved=${unresolved}`);
if (!APPLY) console.log('  💡 DRY RUN — repite con --apply.\n');
await pool.end();

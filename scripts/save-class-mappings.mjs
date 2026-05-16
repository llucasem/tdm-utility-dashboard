/**
 * Saves the confirmed property↔QuickBooks Class mappings into property_qb_class.
 *
 * Only includes mappings I (Claude) am confident about — strong matches (18) +
 * building-nickname matches (24). Duplicates of uppercase/lowercase units are
 * stored as separate rows pointing to the same Class so bills with either
 * spelling auto-tag correctly. Total inserted: ~45 rows covering 42 unique
 * property+unit pairs.
 *
 * Read-only against QuickBooks (only queries Class names → IDs).
 * Idempotent: re-running won't duplicate rows (uses ON CONFLICT).
 *
 * After running this, the system "knows" the mapping. Auto-tag is NOT triggered.
 * Run scripts/run-auto-tag-batch.mjs to actually write Classes to QB.
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

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── QB helpers ────────────────────────────────────────────────────────────
const QB_BASE = (process.env.QB_ENV || 'production').toLowerCase() === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

async function getAccessToken() {
  const r = await pool.query(
    `SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`
  );
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row;
  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const t = await res.json();
  const expiresAt = new Date(Date.now() + t.expires_in * 1000);
  await pool.query(
    `UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, expiresAt, row.realm_id]
  );
  return { realm_id: row.realm_id, access_token: t.access_token };
}

async function qbQuery(sql) {
  const tok = await getAccessToken();
  const url = `${QB_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`QB ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── The confirmed mappings ────────────────────────────────────────────────
const MAPPINGS = [
  // ── Strong matches (street number + unit lined up exactly) ──
  { addr: '1711 Franklin Street, Santa Monica, CA 90404',         unit: null,     cls: '1711 Franklin' },
  { addr: '175 W 107th St, New York, NY 10025',                   unit: '1',      cls: '175 #1' },
  { addr: '1880 3rd Ave, New York, NY 10029',                     unit: 'A',      cls: '1880 #A' },
  { addr: '360 W Pico Rd, Palm Springs, CA 92262',                unit: null,     cls: '360 W Pico' },
  { addr: '472 9th Ave, New York, NY 10018',                      unit: '2',      cls: '472 9th #2' },
  { addr: '472 9th Ave, New York, NY 10018',                      unit: '3',      cls: '472 9th #3' },
  { addr: '474 9th Ave, New York, NY 10018',                      unit: '3D',     cls: '474 9th #3D' },
  { addr: '474 9th Ave, New York, NY 10018',                      unit: '3d',     cls: '474 9th #3D' },
  { addr: '474 9th Ave, New York, NY 10018',                      unit: '4D',     cls: '474 9th #4D' },
  { addr: '474 9th Ave, New York, NY 10018',                      unit: '4d',     cls: '474 9th #4D' },
  { addr: '478 9th Ave, New York, NY 10018',                      unit: '2',      cls: '478 9th #2' },
  { addr: '607 2nd Ave, New York, NY 10016',                      unit: '2',      cls: '607 #2' },
  { addr: '607 2nd Ave, New York, NY 10016',                      unit: '3',      cls: '607 #3' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: '202',    cls: '939 #202' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: '408',    cls: '939 #408' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: '508',    cls: '939 #508' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: '606',    cls: '939 #606' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: '607',    cls: '939 #607' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: '806',    cls: '939 #806' },
  { addr: '939 S Broadway, Los Angeles, CA 90015',                unit: 'M03',    cls: '939 #M03' },

  // ── Building-nickname matches (manually verified by reading QB Class list) ──
  { addr: '3221 Carter Ave, Marina Del Rey, CA 90292',            unit: '140',    cls: 'JEFFERSON #140' },
  { addr: '3221 Carter Ave, Marina Del Rey, CA 90292',            unit: '269',    cls: 'JEFFERSON #269' },
  { addr: '3221 Carter Ave, Marina Del Rey, CA 90292',            unit: '347',    cls: 'JEFFERSON #347' },
  { addr: '3221 Carter Ave, Marina Del Rey, CA 90292',            unit: '447',    cls: 'JEFFERSON #447' },
  { addr: '4750 Lincoln Blvd, Marina Del Rey, CA 90292',          unit: '183',    cls: 'AQUA #183' },
  { addr: '4750 Lincoln Blvd, Marina Del Rey, CA 90292',          unit: '382',    cls: 'AQUA #382' },
  { addr: '4750 Lincoln Blvd, Marina Del Rey, CA 90292',          unit: '1-461',  cls: 'AQUA #01-461' },
  { addr: '2200 Colorado Ave, Santa Monica, CA 90404',            unit: '337',    cls: 'AO #337' },
  { addr: '2200 Colorado Ave, Santa Monica, CA 90404',            unit: '540',    cls: 'AO 540' },
  { addr: '2200 Colorado Ave, Santa Monica, CA 90404',            unit: '627',    cls: 'AO 627' },
  { addr: '2200 Colorado Ave, Santa Monica, CA 90404',            unit: '630',    cls: 'AO #630' },
  { addr: '13488 Maxella Ave, Marina Del Rey, CA 90292',          unit: '469',    cls: 'STELLA #469' },
  { addr: '1418 7th St, Santa Monica, CA 90401',                  unit: '307',    cls: 'Genoa 307' },
  { addr: '1420 5th St, Santa Monica, CA 90401',                  unit: '501',    cls: 'Riva 501' },
  { addr: '1450 5th St, Santa Monica, CA 90401',                  unit: '410',    cls: 'PORTOFINO #410' },
  { addr: '1548 6th St, Santa Monica, CA 90401',                  unit: '306',    cls: 'NMS #306' },
  { addr: '226 S Gale Dr, Beverly Hills, CA 90211',               unit: 'C',      cls: 'GALE AVENUE C' },
  { addr: '439 W 51st St, New York, NY 10019',                    unit: '2W',     cls: '439 West 2W' },
  { addr: '439 W 51st St, New York, NY 10019',                    unit: '2w',     cls: '439 West 2W' },
  { addr: '4241 Redwood Ave, Los Angeles, CA 90066',              unit: '2212',   cls: 'Tierra #2212' },
  { addr: '4250 Glencoe Ave, Marina Del Rey, CA 90292',           unit: '1101',   cls: 'TIERRA #1101' },
  { addr: '4250 Glencoe Ave, Marina Del Rey, CA 90292',           unit: '1326',   cls: 'TIERRA #1326' },
  { addr: '501 E 116th St, New York, NY 10029',                   unit: '4',      cls: '501 116th 4' },
  { addr: '507 Wilshire Blvd, Santa Monica, CA 90401',            unit: '313',    cls: 'ARREZO #313' },
  { addr: '6677 Santa Monica Blvd, Los Angeles, CA 90038',        unit: '4522',   cls: 'AVA #4522' },
];

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  STEP 1: saving 45 property→Class mappings to property_qb_class');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ── 1. Pull QB Classes and build a name lookup ────────────────────────────
const classes = (await qbQuery(`SELECT Id, Name FROM Class WHERE Active = true MAXRESULTS 1000`))
  ?.QueryResponse?.Class || [];
const byName = new Map(classes.map(c => [c.Name, c.Id]));
console.log(`Pulled ${classes.length} active Classes from QuickBooks.\n`);

// ── 2. Insert each mapping ────────────────────────────────────────────────
let saved = 0, missing = 0;
for (const m of MAPPINGS) {
  const classId = byName.get(m.cls);
  if (!classId) {
    console.log(`  ✗ Class "${m.cls}" NOT FOUND in QuickBooks — skipping ${m.addr} / ${m.unit || 'no unit'}`);
    missing++;
    continue;
  }
  await pool.query(`
    INSERT INTO property_qb_class (property_address, unit, qb_class_id, qb_class_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (property_address, COALESCE(unit, ''))
    DO UPDATE SET qb_class_id = EXCLUDED.qb_class_id, qb_class_name = EXCLUDED.qb_class_name, updated_at = NOW()
  `, [m.addr, m.unit, classId, m.cls]);
  saved++;
}
console.log(`\n✓ Saved ${saved} mappings.${missing > 0 ? `  ⚠ ${missing} Class names not found in QB.` : ''}`);

// ── 3. Survey Purchases — how many already have a Class? ──────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  STEP 2: checking how many matching Purchases already have a Class');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Build the set of Purchase IDs we'd target during auto-tag
const billsR = await pool.query(`
  SELECT b.id, b.property_address, b.unit, b.qb_match_data, p.qb_class_name, p.qb_class_id
  FROM utility_bills b
  JOIN property_qb_class p
    ON p.property_address = b.property_address
   AND COALESCE(p.unit, '') = COALESCE(b.unit, '')
  WHERE b.qb_match_status = 'matched' AND b.amount_due > 0
`);

const purchaseToBill = new Map();   // purchase_id -> { bill_id, expectedClassName, expectedClassId, property }
for (const row of billsR.rows) {
  const matches = row.qb_match_data || [];
  for (const m of matches) {
    if (m.type === 'Purchase') {
      purchaseToBill.set(m.id, {
        billId:           row.id,
        expectedClassName: row.qb_class_name,
        expectedClassId:   row.qb_class_id,
        property:          row.property_address + (row.unit ? ` · ${row.unit}` : ''),
      });
    }
  }
}

console.log(`Bills with mapping + matched in QB:        ${billsR.rowCount}`);
console.log(`Unique Purchase IDs to check:              ${purchaseToBill.size}`);

// Fetch all Purchases since 2026-01-01 (bulk)
const purchaseInfo = new Map();    // purchase_id -> { hasClass, currentClassId, currentClassName }
let pageStart = 1;
const PAGE = 500;
while (true) {
  const q = await qbQuery(
    `SELECT * FROM Purchase WHERE TxnDate >= '2026-01-01' STARTPOSITION ${pageStart} MAXRESULTS ${PAGE}`
  );
  const items = q?.QueryResponse?.Purchase || [];
  for (const p of items) {
    const topClassId   = p.ClassRef?.value || null;
    const topClassName = p.ClassRef?.name  || null;
    const lineWithClass = (p.Line || []).find(l =>
      l.AccountBasedExpenseLineDetail?.ClassRef?.value ||
      l.ItemBasedExpenseLineDetail?.ClassRef?.value
    );
    const lineClassRef =
      lineWithClass?.AccountBasedExpenseLineDetail?.ClassRef ||
      lineWithClass?.ItemBasedExpenseLineDetail?.ClassRef    || null;
    const classId   = topClassId   || lineClassRef?.value || null;
    const className = topClassName || lineClassRef?.name  || null;
    purchaseInfo.set(p.Id, { hasClass: !!classId, classId, className });
  }
  if (items.length < PAGE) break;
  pageStart += PAGE;
}
console.log(`\nFetched ${purchaseInfo.size} Purchases from QB (since 2026-01-01).`);

// Cross-reference + check agreement
let readyToTag = 0;          // no class currently — auto-tag will set one
let agreesAlready = 0;       // already has the SAME class we'd assign
let disagreesExisting = 0;   // already has a DIFFERENT class
let notFound = 0;
const disagreements = [];

for (const [pid, expected] of purchaseToBill) {
  const info = purchaseInfo.get(pid);
  if (!info) { notFound++; continue; }
  if (!info.hasClass)                              readyToTag++;
  else if (info.classId === expected.expectedClassId) agreesAlready++;
  else {
    disagreesExisting++;
    disagreements.push({
      pid,
      property: expected.property,
      proposed: expected.expectedClassName,
      current:  info.className || `(id ${info.classId})`,
    });
  }
}

console.log('\n— RESULTADO PARA LA DEMO ─────────────────────────────────────────\n');
console.log(`  ✓ Listas para etiquetar (sin Class todavía):                ${readyToTag}`);
console.log(`     → Jake las verá CAMBIAR en QB en directo durante la reunión`);
console.log('');
console.log(`  ✓ Ya tienen la Class CORRECTA (mismo que propondríamos):    ${agreesAlready}`);
console.log(`     → Edonis ya las clasificó bien. Auto-tag las salta (guardrail).`);
console.log('');
console.log(`  ⚠ Tienen una Class DISTINTA a la que propondríamos:         ${disagreesExisting}`);
if (disagreesExisting > 0) console.log(`     → Investigar: o nuestro mapeo está mal, o Edonis tagueó mal.`);
console.log('');
if (notFound > 0) console.log(`  ? Purchase no encontrado en el query (raro):                ${notFound}`);

if (disagreements.length > 0) {
  console.log('\n— DESACUERDOS (revisar) ─────────────────────────────────────────\n');
  console.log('  Propiedad                                              Propondríamos       QB actual');
  console.log('  ' + '─'.repeat(110));
  const seen = new Set();
  for (const d of disagreements) {
    const k = `${d.property}|${d.proposed}|${d.current}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const prop  = d.property.length > 50 ? d.property.slice(0, 47) + '...' : d.property.padEnd(50);
    const proposed = d.proposed.padEnd(18);
    console.log(`  ${prop}  ${proposed}  ${d.current}`);
  }
}

// ── STEP 3: in-app notifications (so Jake sees the result in the bell) ────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  STEP 3: creating in-app notifications');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Find properties that have bills but no Class mapping (need manual review)
const unmappedR = await pool.query(`
  SELECT b.property_address, COALESCE(b.unit, '') AS unit, COUNT(*)::int AS bill_count
  FROM utility_bills b
  WHERE b.property_address IS NOT NULL
    AND TRIM(b.property_address) != ''
    AND b.amount_due > 0
    AND NOT EXISTS (
      SELECT 1 FROM property_qb_class p
      WHERE p.property_address = b.property_address
        AND COALESCE(p.unit, '') = COALESCE(b.unit, '')
    )
  GROUP BY b.property_address, COALESCE(b.unit, '')
  ORDER BY bill_count DESC, b.property_address
`);
const unmapped = unmappedR.rows;

const mappedCountR = await pool.query(`SELECT COUNT(*)::int AS n FROM property_qb_class`);
const totalMapped = mappedCountR.rows[0].n;

const totalPropsR = await pool.query(`
  SELECT COUNT(DISTINCT (property_address, COALESCE(unit, '')))::int AS n
  FROM utility_bills
  WHERE property_address IS NOT NULL AND TRIM(property_address) != '' AND amount_due > 0
`);
const totalProps = totalPropsR.rows[0].n;

// Mark any previous unread mapping summary notifications as read so the bell
// doesn't accumulate stale duplicates each time this script is re-run.
const dismissed = await pool.query(`
  UPDATE notifications SET read_at = NOW()
  WHERE read_at IS NULL
    AND (
      -- Spanish legacy titles (pre-2026-05-16)
      title LIKE '%mapeadas a QuickBooks Classes%' OR
      title LIKE '%sin mapear — revisión manual%' OR
      title LIKE '%facturas con Class distinta%' OR
      -- Current English titles
      title LIKE '%properties mapped to QuickBooks Classes%' OR
      title LIKE '%properties unmapped — manual review%' OR
      title LIKE '%bills with a different Class than proposed%'
    )
`);
if (dismissed.rowCount > 0) console.log(`  · Marked ${dismissed.rowCount} previous mapping notifications as read\n`);

// 1. Success notification
await pool.query(
  `INSERT INTO notifications (type, title, message, metadata)
   VALUES ($1, $2, $3, $4)`,
  [
    'success',
    `${totalMapped} properties mapped to QuickBooks Classes`,
    `Mapping complete: ${totalMapped} of ${totalProps} property+unit pairs are now associated with their QuickBooks Class. When a new bill arrives for any of these, it will be auto-tagged with no manual intervention.`,
    JSON.stringify({ totalMapped, totalProps, mappedPct: Math.round(totalMapped / totalProps * 100) }),
  ]
);
console.log(`  ✓ Created success notification: ${totalMapped}/${totalProps} mapped`);

// 2. Warning notification with the list of unmapped
if (unmapped.length > 0) {
  const totalBillsAffected = unmapped.reduce((s, p) => s + p.bill_count, 0);
  const list = unmapped.map(p => {
    const u = p.unit ? ` · ${p.unit}` : '';
    return `${p.property_address.split(',')[0]}${u} (${p.bill_count} bills)`;
  }).join(' · ');

  await pool.query(
    `INSERT INTO notifications (type, title, message, metadata)
     VALUES ($1, $2, $3, $4)`,
    [
      'warning',
      `${unmapped.length} properties unmapped — manual review needed`,
      `These properties have bills but couldn't be auto-paired to a QuickBooks Class (${totalBillsAffected} bills affected). Review with Jake/Edonis whether the Class exists under a different name, or whether it needs to be created. List: ${list}`,
      JSON.stringify({ count: unmapped.length, billsAffected: totalBillsAffected, properties: unmapped }),
    ]
  );
  console.log(`  ⚠ Created warning notification: ${unmapped.length} unmapped (${totalBillsAffected} bills affected)`);
}

// 3. Info notification about disagreements (only if any)
if (disagreesExisting > 0) {
  await pool.query(
    `INSERT INTO notifications (type, title, message, metadata)
     VALUES ($1, $2, $3, $4)`,
    [
      'info',
      `${disagreesExisting} bills with a different Class than proposed`,
      `We detected ${disagreesExisting} Purchases in QuickBooks that already have a Class assigned different from what we'd propose. Most are matching collisions (same amount on neighbouring properties) — the guardrail won't touch them, but it's worth reviewing them with Jake to confirm.`,
      JSON.stringify({ disagreesExisting, agreesAlready, readyToTag }),
    ]
  );
  console.log(`  ℹ Created info notification: ${disagreesExisting} disagreements`);
}

console.log(`\n  → Jake will see these in the bell 🔔 when he opens the dashboard`);

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  LISTO. En la reunión ejecuta:');
console.log('     node scripts/run-auto-tag-batch.mjs');
console.log('═══════════════════════════════════════════════════════════════════\n');

await pool.end();

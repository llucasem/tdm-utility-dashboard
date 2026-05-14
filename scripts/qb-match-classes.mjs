/**
 * Read-only cotejado: cruza las propiedades del dashboard con las QuickBooks
 * Classes existentes y reporta cuáles emparejan.
 *
 * Reglas de matching (sin modificar nada):
 *  1. Extrae número de calle + primera palabra significativa del nombre de la calle
 *  2. Combina con el unit (si existe) usando el patrón "<num> <street> #<unit>"
 *  3. Compara contra los nombres de las QB Classes con la misma normalización
 *  4. Si dos rows del dashboard solo se diferencian por mayúsculas en el unit
 *     (e.g. "4D" vs "4d"), se prioriza la mayúscula.
 *
 * No escribe nada en la DB ni en QuickBooks — solo informa.
 *
 * Run:  node scripts/qb-match-classes.mjs
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

// ── QB API helpers ────────────────────────────────────────────────────────
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

// ── Normalization ─────────────────────────────────────────────────────────
const STREET_SUFFIXES = new Set([
  'ave', 'avenue', 'st', 'street', 'blvd', 'boulevard', 'rd', 'road',
  'dr', 'drive', 'way', 'pl', 'place', 'ln', 'lane', 'ct', 'court',
  'pkwy', 'parkway', 'hwy', 'highway', 'ter', 'terrace',
]);

const DIRECTIONAL = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);

/**
 * Extract a normalized "signature" from a street address, e.g.:
 *   "474 9th Ave, New York, NY 10018"   → { num: '474', words: ['9th'] }
 *   "1711 Franklin Street, Santa Monica" → { num: '1711', words: ['franklin'] }
 *   "6677 Santa Monica Blvd, Los Angeles" → { num: '6677', words: ['santa','monica'] }
 *   "175 W 107th St, New York"            → { num: '175', words: ['107th'] }  (directional dropped)
 */
function addressSig(addr) {
  if (!addr) return { num: '', words: [] };
  // Take just the street portion (before first comma)
  const street = addr.split(',')[0].trim().toLowerCase().replace(/[.,]/g, '');
  const tokens = street.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { num: '', words: [] };
  const num   = /^\d+$/.test(tokens[0]) ? tokens[0] : '';
  const rest  = (num ? tokens.slice(1) : tokens)
    .filter(t => !STREET_SUFFIXES.has(t) && !DIRECTIONAL.has(t));
  return { num, words: rest };
}

/** Normalize unit for case-insensitive comparison */
function normUnit(u) {
  return (u || '').trim().toLowerCase().replace(/^apt\.?\s*/i, '').replace(/^#\s*/, '');
}

/**
 * Try to derive a structured signature from a QB Class name, which usually
 * follows patterns like "474 9th #4D", "1711 Franklin", "607 #2".
 */
function classSig(name) {
  if (!name) return { num: '', words: [], unit: null };
  const m = name.match(/^\s*(\d+)?\s*([^#]*?)\s*(?:#\s*([A-Za-z0-9-]+))?\s*$/);
  if (!m) return { num: '', words: [], unit: null };
  const num = m[1] || '';
  const rest = (m[2] || '').toLowerCase().replace(/[.,]/g, '').split(/\s+/)
    .filter(Boolean)
    .filter(t => !STREET_SUFFIXES.has(t) && !DIRECTIONAL.has(t));
  const unit = m[3] || null;
  return { num, words: rest, unit };
}

/**
 * Score how well a dashboard property matches a QB Class.
 * Returns 0-1.
 */
function score(propSig, propUnit, klassSig) {
  if (!propSig.num || !klassSig.num) return 0;
  if (propSig.num !== klassSig.num) return 0;     // street number MUST match

  const pWords = new Set(propSig.words);
  const kWords = new Set(klassSig.words);
  const intersection = [...pWords].filter(w => kWords.has(w));
  const pUnit = normUnit(propUnit);
  const kUnit = normUnit(klassSig.unit);

  // Strongest signal: same number + same unit (case-insensitive). This catches
  // QB Classes that were abbreviated to just "<num> #<unit>" (e.g. "939 #202").
  if (pUnit && kUnit && pUnit === kUnit) {
    if (pWords.size === 0 || kWords.size === 0 || intersection.length > 0) return 1.0;
    return 0.92;                                  // same num + unit, conflicting street word
  }

  // No unit on either side but street number + word match
  if (!pUnit && !kUnit) {
    if (pWords.size === 0 || kWords.size === 0)        return 0.95;
    if (intersection.length > 0)                       return 1.0;
    return 0;
  }

  // Word overlap fallback
  if (pWords.size === 0 || kWords.size === 0) {
    var wordScore = 0.5;
  } else {
    var wordScore = intersection.length / Math.max(pWords.size, kWords.size);
  }
  if (wordScore < 0.3) return 0;

  let unitScore = 1;
  if (pUnit && kUnit) unitScore = pUnit === kUnit ? 1 : 0;
  else if (pUnit !== kUnit)   unitScore = 0.3;

  return 0.6 * wordScore + 0.4 * unitScore;
}

// ── Load data ─────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  COTEJADO: PROPIEDADES DEL DASHBOARD ↔ QUICKBOOKS CLASSES');
console.log('═══════════════════════════════════════════════════════════════════\n');

const propsR = await pool.query(`
  SELECT property_address, COALESCE(unit, '') AS unit, COUNT(*)::int AS bill_count
  FROM utility_bills
  WHERE property_address IS NOT NULL AND TRIM(property_address) != ''
    AND amount_due > 0
  GROUP BY property_address, COALESCE(unit, '')
  ORDER BY property_address, unit
`);
const properties = propsR.rows;

const classes = (await qbQuery(`SELECT Id, Name, Active FROM Class WHERE Active = true MAXRESULTS 1000`))
  ?.QueryResponse?.Class || [];

console.log(`📋  Dashboard: ${properties.length} property+unit pairs`);
console.log(`☁  QuickBooks: ${classes.length} active Classes\n`);

// ── Resolve duplicates: prefer uppercase variant ──────────────────────────
// Group by (address lower, unit lower) and pick the row whose unit has the
// most uppercase letters. Mark the others as "dup_of".
const grouped = new Map();
for (const p of properties) {
  const k = `${p.property_address.trim().toLowerCase()}__${normUnit(p.unit)}`;
  const arr = grouped.get(k) || [];
  arr.push(p);
  grouped.set(k, arr);
}

const canonical = [];
const dups      = [];
for (const arr of grouped.values()) {
  if (arr.length === 1) { canonical.push(arr[0]); continue; }
  // Pick the one whose unit has the most uppercase letters; ties broken by bill_count
  arr.sort((a, b) => {
    const upA = (a.unit || '').replace(/[^A-Z]/g, '').length;
    const upB = (b.unit || '').replace(/[^A-Z]/g, '').length;
    if (upA !== upB) return upB - upA;
    return b.bill_count - a.bill_count;
  });
  canonical.push(arr[0]);
  for (let i = 1; i < arr.length; i++) dups.push({ ...arr[i], canonical_unit: arr[0].unit });
}

if (dups.length > 0) {
  console.log(`⚠  Duplicados de capitalización detectados: ${dups.length} (se priorizará la versión en mayúsculas, no se borra nada)`);
  for (const d of dups) {
    console.log(`     · ${d.property_address}  unit "${d.unit}"  →  unit "${d.canonical_unit}" (${d.bill_count} bills se mapearán igual que la canónica)`);
  }
  console.log('');
}

// ── Match each canonical property against the best QB Class ───────────────
const klassSigs = classes.map(c => ({ ...c, sig: classSig(c.Name) }));
const results = [];

for (const p of canonical) {
  const pSig = addressSig(p.property_address);
  let best = { class: null, score: 0 };
  for (const k of klassSigs) {
    const s = score(pSig, p.unit, k.sig);
    if (s > best.score) best = { class: k, score: s };
  }
  results.push({ property: p, best });
}

// ── Report ────────────────────────────────────────────────────────────────
const HIGH = 0.85, MED = 0.55;
const high   = results.filter(r => r.best.score >= HIGH);
const medium = results.filter(r => r.best.score >= MED && r.best.score < HIGH);
const none   = results.filter(r => r.best.score < MED);

console.log('— Resumen ─────────────────────────────────────────────────────────\n');
console.log(`  Propiedades canónicas (sin duplicados):              ${canonical.length}`);
console.log(`  ✓ Match fuerte    (score ≥ 0.85, casi seguro):       ${high.length}`);
console.log(`  ~ Match probable  (score 0.55–0.85, revisar):        ${medium.length}`);
console.log(`  ✗ Sin match       (score < 0.55, requiere atención): ${none.length}\n`);

const factura_potential = results
  .filter(r => r.best.score >= HIGH)
  .reduce((sum, r) => {
    // count bills for the canonical AND its duplicates pointing to same canonical
    const dupBills = dups
      .filter(d => d.canonical_unit === r.property.unit && d.property_address === r.property.property_address)
      .reduce((s, d) => s + d.bill_count, 0);
    return sum + r.property.bill_count + dupBills;
  }, 0);

const totalBillsR = await pool.query(`
  SELECT COUNT(*)::int AS n FROM utility_bills
  WHERE property_address IS NOT NULL AND TRIM(property_address) != '' AND amount_due > 0
`);

console.log(`  💡  Si aplicamos sólo los matches "fuertes":`);
console.log(`     ${factura_potential} de ${totalBillsR.rows[0].n} facturas con propiedad quedarían listas para auto-tag\n`);

// ── Detail tables ─────────────────────────────────────────────────────────
function printRow(r) {
  const addr = (r.property.property_address.length > 48
    ? r.property.property_address.slice(0, 45) + '...'
    : r.property.property_address).padEnd(48);
  const unit  = (r.property.unit || '—').padEnd(6);
  const bills = String(r.property.bill_count).padStart(4);
  const sc    = r.best.score.toFixed(2);
  const klass = r.best.class ? r.best.class.Name : '(none)';
  console.log(`  ${addr}  ${unit}  ${bills}  ${sc}   → ${klass}`);
}

console.log('— ✓ Matches FUERTES (recomendado aplicar tal cual) ──────────────────\n');
console.log('  Dashboard                                         Unit    Bills Score   QB Class');
console.log('  ' + '─'.repeat(100));
for (const r of high) printRow(r);

if (medium.length > 0) {
  console.log('\n— ~ Matches PROBABLES (revisar antes de aplicar) ────────────────────\n');
  console.log('  Dashboard                                         Unit    Bills Score   QB Class');
  console.log('  ' + '─'.repeat(100));
  for (const r of medium) printRow(r);
}

if (none.length > 0) {
  console.log('\n— ✗ SIN MATCH (no encontramos Class equivalente) ────────────────────\n');
  console.log('  Estas propiedades no tienen una Class candidata en QB con el mismo nº de calle.');
  console.log('  Posibles causas: la Class no existe, está nombrada de forma muy distinta, o es una propiedad nueva.\n');
  console.log('  Dashboard                                         Unit    Bills  Mejor candidato');
  console.log('  ' + '─'.repeat(100));
  for (const r of none) printRow(r);
}

// ── Full QB Class dump so the user can inspect names ──────────────────────
console.log('\n— Las 99 Classes que hay en QuickBooks (lista completa) ─────────────\n');
const classesSorted = [...classes].sort((a, b) => a.Name.localeCompare(b.Name));
const COLS = 3;
for (let i = 0; i < classesSorted.length; i += COLS) {
  const row = classesSorted.slice(i, i + COLS).map(c => c.Name.padEnd(32));
  console.log('  ' + row.join('  '));
}

console.log('\n═══════════════════════════════════════════════════════════════════\n');
await pool.end();

/**
 * Build the expected-accounts catalog by crossing two independent sources:
 *
 *   A) utility_bills history (email bills with property assigned)
 *   B) QuickBooks Purchases classed by Jake (via property_qb_class mapping)
 *
 * A property×service×provider combo seen in ≥2 distinct months becomes an
 * active expected account (one bill per month). Combos seen once are stored
 * inactive for review. QB-only combos are exactly the accounts that never
 * email — the ones Jake logs into portals for.
 *
 * Dry-run by default (prints the catalog). `--apply` upserts into
 * expected_accounts, preserving manual `active`/`notes` edits.
 *
 * Run: node scripts/build-expected-accounts.mjs [--apply]
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
const SINCE_DAYS = 185;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Canonical helpers (mirrors lib/address-normalize.js, standalone) ─────────
const ABBR = [['street','st'],['avenue','ave'],['boulevard','blvd'],['road','rd'],['drive','dr'],['lane','ln'],['place','pl'],['court','ct'],['parkway','pkwy'],['highway','hwy'],['terrace','ter'],['way','wy'],['west','w'],['east','e'],['north','n'],['south','s']];
function normAddr(addr) {
  if (!addr) return '';
  let s = addr.toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ').replace(/\.(\s|$)/g, '$1');
  for (const [l, sh] of ABBR) s = s.replace(new RegExp(`\\b${l}\\b`, 'g'), sh);
  return s.trim();
}
function addrsMatch(a, b) {
  const na = normAddr(a), nb = normAddr(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + ' ') || nb.startsWith(na + ' ');
}
function normUnit(u) {
  if (!u) return '';
  return u.toLowerCase().replace(/^apt\.?\s*/, '').replace(/^unit\s*/, '').replace(/^suite\s*/, '').replace(/^ste\.?\s*/, '').replace(/^#\s*/, '').replace(/\s+/g, '')
    .replace(/^([a-z]+)0+(\d)/, '$1$2')   // M03 → m3 (Jake pads with zeros)
    .trim();
}

// email_from → canonical provider
function providerFromEmail(from) {
  const f = (from || '').toLowerCase();
  if (f.includes('spectrum')) return 'spectrum';
  if (f.includes('coned')) return 'conedison';
  if (f.includes('socalgas')) return 'socalgas';
  if (f.includes('sce.com') || f.includes('@sce.')) return 'sce';
  if (f.includes('ladwp') || f.includes('@dwp.')) return 'ladwp';
  if (f.includes('att.') || f.includes('at&t') || f.includes('att-mail')) return 'att';
  if (f.includes('t-mobile') || f.includes('tmobile')) return 'tmobile';
  if (f.includes('optimum')) return 'optimum';
  if (f.includes('verizon')) return 'verizon';
  if (f.includes('frontier')) return 'frontier';
  if (f.includes('nationalgrid') || f.includes('national grid')) return 'nationalgrid';
  if (f.includes('pge.com') || f.includes('@pge.')) return 'pge';
  return null;
}

// QB vendor name → [provider, utility_type]
function providerFromVendor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('spectrum') || n.includes('charter')) return ['spectrum', 'internet'];
  if (n.includes('conedison') || n.includes('con edison') || n.includes('con edis')) return ['conedison', 'electricity'];
  if (n.includes('southern california edison')) return ['sce', 'electricity'];
  if (n.includes('la dwp') || n.includes('ladwp')) return ['ladwp', 'electricity'];
  if (n.includes('socalgas') || n.includes('so cal gas')) return ['socalgas', 'gas'];
  if (n.includes('at&t') || n === 'att' || n.startsWith('att ')) return ['att', 'internet'];
  if (n.includes('t-mobile') || n.includes('tmobile')) return ['tmobile', 'internet'];
  if (n.includes('verizon')) return ['verizon', 'internet'];
  if (n.includes('frontier')) return ['frontier', 'internet'];
  if (n.includes('optimum')) return ['optimum', 'internet'];
  if (n.includes('national grid')) return ['nationalgrid', 'gas'];
  return null;
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mode = a => { const c = {}; let best = null; for (const x of a) { if (!x) continue; c[x] = (c[x] || 0) + 1; if (!best || c[x] > c[best]) best = x; } return best; };

// combos: key → { displays:[], units:[], type, provider, months:Set, amounts:[], days:[], last4:[], classIds:[], classNames:[], lastSeen, sources:Set }
const combos = new Map();
function feed({ address, unit, type, provider, month, amount, day, last4, classId, className, date, source }) {
  if (!address || !type || !provider) return;
  // canonical merge: find an existing combo whose address matches fuzzily
  let key = null;
  const uKey = normUnit(unit);
  for (const [k, c] of combos) {
    if (c.type === type && c.provider === provider && c.uKey === uKey && addrsMatch(c.displays[0], address)) { key = k; break; }
  }
  if (!key) {
    key = `${normAddr(address)}|${uKey}|${type}|${provider}`;
    combos.set(key, { displays: [], units: [], type, provider, uKey, months: new Set(), amounts: [], days: [], last4: [], classIds: [], classNames: [], lastSeen: null, sources: new Set() });
  }
  const c = combos.get(key);
  c.displays.push(address);
  if (unit) c.units.push(unit);
  c.months.add(month);
  if (amount > 0) c.amounts.push(Number(amount));
  if (day) c.days.push(day);
  if (last4) c.last4.push(last4);
  if (classId) { c.classIds.push(String(classId)); c.classNames.push(className); }
  if (!c.lastSeen || date > c.lastSeen) c.lastSeen = date;
  c.sources.add(source);
}

// ── Source A: bills ──────────────────────────────────────────────────────────
const bills = await pool.query(`
  SELECT property_address, unit, utility_type, email_from, amount_due::float AS amt,
         email_received_at::date AS d, account_last4
  FROM utility_bills
  WHERE amount_due > 0 AND NOT is_duplicate
    AND property_address IS NOT NULL AND TRIM(property_address) != ''
    AND utility_type IN ('electricity', 'internet', 'gas', 'water')
    AND email_received_at >= NOW() - INTERVAL '${SINCE_DAYS} days'
    AND COALESCE(source, 'email') != 'qb'   -- QB-backfilled rows are NOT email evidence
`);
for (const b of bills.rows) {
  const provider = providerFromEmail(b.email_from) || (b.source === 'qb' ? null : 'otro');
  const d = b.d;
  feed({
    address: b.property_address, unit: b.unit, type: b.utility_type,
    provider: provider || 'otro',
    month: d.toISOString().slice(0, 7), amount: b.amt, day: d.getUTCDate(),
    last4: b.account_last4, date: d, source: 'bills',
  });
}

// ── Source B: QB classed purchases ───────────────────────────────────────────
async function getTok() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  let tok = r.rows[0];
  if (new Date(tok.expires_at).getTime() - Date.now() < 5 * 60_000) {
    const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }),
    });
    const t = await res.json();
    await pool.query(`UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
      [t.access_token, t.refresh_token, new Date(Date.now() + t.expires_in * 1000), tok.realm_id]);
    tok = { ...tok, access_token: t.access_token };
  }
  return tok;
}
const tok = await getTok();
async function queryQB(sql) {
  const url = `https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`QB ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

const since = new Date(Date.now() - SINCE_DAYS * 86_400_000).toISOString().slice(0, 10);
const purchases = [];
let pos = 1;
while (true) {
  const r = await queryQB(`SELECT * FROM Purchase WHERE TxnDate >= '${since}' STARTPOSITION ${pos} MAXRESULTS 500`);
  const items = r?.QueryResponse?.Purchase || [];
  purchases.push(...items);
  if (items.length < 500) break;
  pos += items.length;
  if (pos > 10000) break;
}

const classMap = new Map(); // qb_class_id → {property_address, unit}
for (const row of (await pool.query(`SELECT qb_class_id, qb_class_name, property_address, unit FROM property_qb_class`)).rows) {
  classMap.set(String(row.qb_class_id), row);
}

const unmappedClasses = new Map(); // className → count (utility purchases we can't place)
for (const p of purchases) {
  const pv = providerFromVendor(p.EntityRef?.name);
  if (!pv) continue;
  const [provider, type] = pv;
  const top = p.ClassRef;
  const lines = (p.Line || []).map(l => l?.AccountBasedExpenseLineDetail?.ClassRef || l?.ItemBasedExpenseLineDetail?.ClassRef).filter(Boolean);
  const cls = top?.value ? top : lines[0];
  if (!cls?.value) continue;
  const mapped = classMap.get(String(cls.value));
  if (!mapped) {
    unmappedClasses.set(cls.name, (unmappedClasses.get(cls.name) || 0) + 1);
    continue;
  }
  const d = new Date(p.TxnDate);
  feed({
    address: mapped.property_address, unit: mapped.unit, type, provider,
    month: p.TxnDate.slice(0, 7), amount: Number(p.TotalAmt), day: d.getUTCDate(),
    classId: cls.value, className: cls.name, date: d, source: 'qb',
  });
}

// ── Merge "otro" combos into their real-provider sibling ────────────────────
// Old bills without email_from produce a parallel combo with provider 'otro'
// next to the real one (same property+unit+type). Fold them together.
for (const [key, c] of [...combos]) {
  if (c.provider !== 'otro') continue;
  for (const [k2, c2] of combos) {
    if (k2 === key || c2.provider === 'otro' || c2.type !== c.type || c2.uKey !== c.uKey) continue;
    if (!addrsMatch(c.displays[0], c2.displays[0])) continue;
    for (const m of c.months) c2.months.add(m);
    c2.displays.push(...c.displays);
    c2.units.push(...c.units);
    c2.amounts.push(...c.amounts);
    c2.days.push(...c.days);
    c2.last4.push(...c.last4);
    for (const s of c.sources) c2.sources.add(s);
    if (c.lastSeen > c2.lastSeen) c2.lastSeen = c.lastSeen;
    combos.delete(key);
    break;
  }
}

// ── Assemble catalog ─────────────────────────────────────────────────────────
const rows = [];
for (const c of combos.values()) {
  const monthsSeen = c.months.size;
  const src = c.sources.has('bills') && c.sources.has('qb') ? 'both' : (c.sources.has('qb') ? 'qb' : 'bills');
  // Billing cadence: LADWP bills every 2 months. Median gap (in months)
  // between consecutive observed months, clamped to [1, 3].
  const sortedMonths = [...c.months].sort();
  const gaps = [];
  for (let i = 1; i < sortedMonths.length; i++) {
    const [y1, m1] = sortedMonths[i - 1].split('-').map(Number);
    const [y2, m2] = sortedMonths[i].split('-').map(Number);
    gaps.push((y2 - y1) * 12 + (m2 - m1));
  }
  const cadence = gaps.length >= 2 ? Math.min(3, Math.max(1, Math.round(median(gaps)))) : 1;
  rows.push({
    property_address: mode(c.displays),
    unit: mode(c.units) || null,
    utility_type: c.type,
    provider: c.provider,
    account_last4: mode(c.last4) || null,
    qb_class_id: mode(c.classIds) || null,
    qb_class_name: mode(c.classNames) || null,
    typical_amount: c.amounts.length ? median(c.amounts).toFixed(2) : null,
    amount_min: c.amounts.length ? Math.min(...c.amounts).toFixed(2) : null,
    amount_max: c.amounts.length ? Math.max(...c.amounts).toFixed(2) : null,
    typical_day: median(c.days),
    months_seen: monthsSeen,
    cadence_months: cadence,
    last_seen: c.lastSeen instanceof Date ? c.lastSeen.toISOString().slice(0, 10) : String(c.lastSeen).slice(0, 10),
    source: src,
    active: monthsSeen >= 2,
    notes: monthsSeen >= 2 ? null : 'visto solo 1 mes — revisar',
  });
}
rows.sort((a, b) => (a.property_address + a.unit).localeCompare(b.property_address + b.unit) || a.utility_type.localeCompare(b.utility_type));

console.log(`\nCatálogo: ${rows.length} cuentas esperadas (${rows.filter(r => r.active).length} activas)`);
console.log(`  Solo QB (nunca envían email): ${rows.filter(r => r.source === 'qb' && r.active).length}`);
for (const r of rows) {
  console.log(`  ${r.active ? '●' : '○'} ${(r.property_address || '').slice(0, 38).padEnd(38)} ${(r.unit || '—').padEnd(8)} ${r.utility_type.padEnd(11)} ${(r.provider || '').padEnd(10)} ~$${String(r.typical_amount ?? '?').padStart(8)} día~${String(r.typical_day ?? '?').padStart(2)} ${String(r.months_seen)}m [${r.source}]${r.qb_class_name ? ' class="' + r.qb_class_name + '"' : ''}`);
}
if (unmappedClasses.size) {
  console.log(`\n⚠ Classes de utilities SIN mapeo a propiedad (no entran en el catálogo):`);
  for (const [name, n] of unmappedClasses) console.log(`    "${name}" × ${n}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN — nada escrito. Ejecuta con --apply para guardar.');
} else {
  let up = 0;
  for (const r of rows) {
    await pool.query(`
      INSERT INTO expected_accounts
        (property_address, unit, utility_type, provider, account_last4, qb_class_id, qb_class_name,
         typical_amount, amount_min, amount_max, typical_day, months_seen, last_seen, source, active, notes, cadence_months)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (property_address, COALESCE(unit, ''), utility_type, COALESCE(provider, ''))
      DO UPDATE SET
        account_last4 = COALESCE(EXCLUDED.account_last4, expected_accounts.account_last4),
        qb_class_id   = COALESCE(EXCLUDED.qb_class_id, expected_accounts.qb_class_id),
        qb_class_name = COALESCE(EXCLUDED.qb_class_name, expected_accounts.qb_class_name),
        typical_amount = EXCLUDED.typical_amount,
        amount_min = EXCLUDED.amount_min,
        amount_max = EXCLUDED.amount_max,
        typical_day = EXCLUDED.typical_day,
        months_seen = EXCLUDED.months_seen,
        last_seen = EXCLUDED.last_seen,
        source = EXCLUDED.source,
        cadence_months = EXCLUDED.cadence_months,
        updated_at = NOW()
        -- active/notes NOT touched: manual edits win
    `, [r.property_address, r.unit, r.utility_type, r.provider, r.account_last4, r.qb_class_id, r.qb_class_name,
        r.typical_amount, r.amount_min, r.amount_max, r.typical_day, r.months_seen, r.last_seen, r.source, r.active, r.notes, r.cadence_months]);
    up++;
  }
  console.log(`\n✓ APLICADO: ${up} filas upsert en expected_accounts.`);
}
await pool.end();

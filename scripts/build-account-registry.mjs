/**
 * Construye el REGISTRO DE CUENTAS: (proveedor, account_last4) -> propiedad + unidad.
 *
 * La idea: el numero de cuenta es la identidad. No se adivina cada mes,
 * se mira aqui. Este script deduce el registro desde el historial real de
 * Neon y marca el nivel de confianza de cada fila.
 *
 * Dry-run por defecto. Con --apply escribe en la tabla account_registry.
 */
import fs from 'fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const APPLY = process.argv.includes('--apply');

// --- normalizacion -------------------------------------------------------
// OJO: no se tocan los tokens direccionales (N/S/E/W). El normalizador viejo
// se comia la S de WILSHIRE y dejaba "WIL HIRE".
const STREET_ABBR = [
  [/\bAVENUE\b/g, 'AVE'], [/\bSTREET\b/g, 'ST'], [/\bBOULEVARD\b/g, 'BLVD'],
  [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bPLACE\b/g, 'PL'],
  [/\bCOURT\b/g, 'CT'], [/\bLANE\b/g, 'LN'], [/\bTERRACE\b/g, 'TER'],
];

export function normAddress(raw) {
  if (!raw) return null;
  let s = String(raw).split(',')[0];                 // solo la calle, sin ciudad/estado/zip
  s = s.toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of STREET_ABBR) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim() || null;
}

export function normUnit(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(APARTMENT|APT|UNIT|STE|SUITE)\s*/,'').trim();
  if (!s || s === '-' || s === 'NULL') return null;
  return s;
}

const key = (a, u) => `${a || '?'}|${u || '-'}`;

// --- main ----------------------------------------------------------------
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (s, p) => (await pool.query(s, p)).rows;

const bills = await q(`
  select utility_type, account_last4, property_address, unit, amount_due,
         email_received_at, email_from
    from utility_bills
   where amount_due > 0
     and account_last4 is not null
     and coalesce(source,'email') = 'email'
     and not coalesce(is_duplicate, false)
   order by email_received_at`);

const providerOf = (from, type) => {
  const f = (from || '').toLowerCase();
  if (f.includes('spectrum')) return 'Spectrum';
  if (f.includes('coned'))    return 'ConEd';
  if (f.includes('ladwp'))    return 'LADWP';
  if (f.includes('sce'))      return 'SCE';
  if (f.includes('socalgas')) return 'SoCalGas';
  if (f.includes('t-mobile')) return 'T-Mobile';
  return type === 'internet' ? 'Spectrum' : null;   // historico sin email_from
};

const acc = new Map();
for (const b of bills) {
  const k = `${b.utility_type}|${b.account_last4}`;
  if (!acc.has(k)) acc.set(k, {
    utility_type: b.utility_type, account_last4: b.account_last4,
    providers: new Map(), obs: new Map(), n: 0, first: b.email_received_at, last: b.email_received_at,
    amounts: [],
  });
  const a = acc.get(k);
  a.n++;
  a.last = b.email_received_at;
  a.amounts.push(Number(b.amount_due));
  const p = providerOf(b.email_from, b.utility_type);
  if (p) a.providers.set(p, (a.providers.get(p) || 0) + 1);
  const addr = normAddress(b.property_address), unit = normUnit(b.unit);
  if (!addr) continue;
  const ok = key(addr, unit);
  if (!a.obs.has(ok)) a.obs.set(ok, { addr, unit, count: 0, last: b.email_received_at });
  const o = a.obs.get(ok); o.count++; o.last = b.email_received_at;
}

const rows = [];
for (const a of acc.values()) {
  const obs = [...a.obs.values()].sort((x, y) => y.count - x.count || (y.last - x.last));
  const total = obs.reduce((s, o) => s + o.count, 0);
  const top = obs[0] || null;
  const share = top ? top.count / total : 0;
  let confidence;
  if (!top)                          confidence = 'sin_datos';
  else if (obs.length === 1)         confidence = a.n >= 2 ? 'solida' : 'unica_observacion';
  else if (share >= 0.8)             confidence = 'mayoria';
  else                               confidence = 'CONFLICTO';
  const provider = [...a.providers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  const amts = a.amounts.slice().sort((x, y) => x - y);
  rows.push({
    provider, utility_type: a.utility_type, account_last4: a.account_last4,
    address: top?.addr || null, unit: top?.unit || null,
    confidence, bills: a.n, share: Math.round(share * 100),
    alternativas: obs.slice(1).map(o => `${o.addr} #${o.unit || '-'} (x${o.count})`).join(' | ') || '',
    importe_tipico: amts.length ? amts[Math.floor(amts.length / 2)].toFixed(2) : null,
    ultima: a.last.toISOString().slice(0, 10),
  });
}

rows.sort((a, b) => (a.confidence === 'CONFLICTO' ? -1 : 0) - (b.confidence === 'CONFLICTO' ? -1 : 0)
  || (a.provider || '').localeCompare(b.provider || '') || b.bills - a.bills);

const by = c => rows.filter(r => r.confidence === c);
console.log('\n================ REGISTRO DE CUENTAS deducido del historial ================\n');
console.log(`Facturas analizadas : ${bills.length}`);
console.log(`Cuentas distintas   : ${rows.length}\n`);
for (const c of ['solida', 'mayoria', 'unica_observacion', 'CONFLICTO']) {
  console.log(`  ${c.padEnd(20)} ${String(by(c).length).padStart(3)} cuentas   ${String(by(c).reduce((s,r)=>s+r.bills,0)).padStart(3)} facturas`);
}

console.log('\n---------------- CONFLICTOS (necesitan a Jake) ----------------');
console.table(by('CONFLICTO').map(r => ({ prov: r.provider, tipo: r.utility_type, cuenta: r.account_last4,
  gana: `${r.address} #${r.unit || '-'}`, pct: r.share + '%', contra: r.alternativas, n: r.bills })));

console.log('\n---------------- UNA SOLA OBSERVACION (sin confirmar) ----------------');
console.table(by('unica_observacion').map(r => ({ prov: r.provider, tipo: r.utility_type, cuenta: r.account_last4,
  propiedad: `${r.address} #${r.unit || '-'}`, ultima: r.ultima })));

fs.writeFileSync('account-registry-propuesto.json', JSON.stringify(rows, null, 2));
console.log('\nDetalle completo -> account-registry-propuesto.json');

if (!APPLY) { console.log('\n(dry-run: no se ha escrito nada en la base de datos. Usa --apply)'); }
await pool.end();

/**
 * Construye el REGISTRO DE CUENTAS: (tipo de servicio, account_last4) -> propiedad + unidad.
 *
 * La idea del reset: el numero de cuenta es la identidad. No se adivina en cada
 * email, se mira aqui. Este script deduce el registro desde el historial real de
 * Neon, lo corrobora contra las tablas viejas, y marca el nivel de confianza.
 *
 * Niveles de confianza:
 *   solida       todas las observaciones del historial coinciden
 *   mayoria      una domina (>=80%)
 *   provisional  vista una sola vez; se confirma sola con la proxima factura
 *   conflicto    el historial se contradice de verdad -> lo decide Jake
 *   manual       resuelto a mano con evidencia; locked=true, no se pisa nunca
 *
 * Uso:
 *   node scripts/build-account-registry.mjs            (dry-run, no escribe)
 *   node scripts/build-account-registry.mjs --apply    (crea la tabla y escribe)
 */
import fs from 'fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const APPLY = process.argv.includes('--apply');

import { normAddress, normUnit } from '../lib/account-registry.js';

const key = (a, u) => `${a || '?'}|${u || '-'}`;

// --- resoluciones a mano -------------------------------------------------
// Los 3 conflictos que se resuelven con la propia evidencia del historial.
// Se marcan locked: ninguna pasada automatica los volvera a tocar.
const RESUELTOS = {
  'internet|4449': {
    address: '939 S BROADWAY', unit: '607',
    notes: 'Resuelto 13/08/2026: 5 observaciones 607 vs 2 M03, y jun/jul/ago coinciden en 607. La alternancia era la IA adivinando.',
  },
  'internet|6715': {
    address: '474 9TH AVE', unit: '4D',
    notes: 'Resuelto 13/08/2026: 4 observaciones 474 9th #4D; 472 9th #3 y 360 W Pico eran despistes sueltos. Importe constante $100.',
  },
  'electricity|8467': {
    address: '501 E 106TH ST', unit: '4',
    notes: 'Resuelto 13/08/2026: la unidad #4 aparece en abr/may y se pierde al parsear desde junio. OJO: cuenta morosa, el saldo crece cada mes.',
  },

  // Los 4 conflictos de SoCalGas. NO hizo falta preguntar a Jake: el apodo y la
  // unidad venian escritos en el propio email, siempre en el mismo sitio:
  //     Account Number *****19501 (SORRENTO 510)
  // El parser los ignoraba y se inventaba una direccion distinta cada mes.
  // Confirmado por tres fuentes que coinciden: el apodo del email, la unica
  // direccion fiable del registro con esa unidad, y la Class de Jake en QB.
  'gas|9501': {
    address: '620 SANTA MONICA BLVD', unit: '510',
    notes: 'Resuelto 14/08/2026 desde el email: "(SORRENTO 510)". Class de Jake: SORRENTO #510.',
  },
  'gas|4904': {
    address: '1528 6TH ST', unit: '209',
    notes: 'Resuelto 14/08/2026 desde el email: "(VERONA 209)". Class de Jake: SM Verona #209.',
  },
  'gas|3904': {
    address: '1420 5TH ST', unit: '501',
    notes: 'Resuelto 14/08/2026 desde el email: "(RIVA 501)". Class de Jake: Riva 501.',
  },
  'gas|4706': {
    address: '13488 MAXELLA AVE', unit: '469',
    notes: 'Resuelto 14/08/2026 desde el email: "(STELLA 469)". Class de Jake: STELLA #469. '
         + 'URGENTE: aviso final de corte de gas por $3.174,09 vencidos el 20/07/2026.',
  },
};

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
    providers: new Map(), obs: new Map(), n: 0,
    first: b.email_received_at, last: b.email_received_at, amounts: [],
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

// --- corroboracion contra las tablas viejas ------------------------------
const viejas = new Map();
for (const t of ['account_mappings', 'provider_accounts']) {
  for (const r of await q(`select utility_type, account_last4, property_address, unit from ${t}`)) {
    const k = `${r.utility_type}|${r.account_last4}`;
    if (!viejas.has(k)) viejas.set(k, []);
    viejas.get(k).push({ tabla: t, addr: normAddress(r.property_address), unit: normUnit(r.unit) });
  }
}

const rows = [];
for (const a of acc.values()) {
  const k = `${a.utility_type}|${a.account_last4}`;
  const obs = [...a.obs.values()].sort((x, y) => y.count - x.count || (y.last - x.last));
  const total = obs.reduce((s, o) => s + o.count, 0);
  const top = obs[0] || null;
  const share = top ? top.count / total : 0;

  // Si otra observacion es la MISMA direccion pero mas completa ("175 W 107TH"
  // vs "175 W 107TH ST"), gana la completa: no son variantes en disputa, es la
  // misma calle escrita a medias.
  if (top) {
    const masCompleta = obs.find(o => o !== top && o.unit === top.unit
      && o.addr.length > top.addr.length && o.addr.startsWith(top.addr + ' '));
    if (masCompleta) top.addr = masCompleta.addr;
  }

  let confidence, address = top?.addr || null, unit = top?.unit || null, locked = false, notes = null;
  if (RESUELTOS[k]) {
    ({ address, unit, notes } = RESUELTOS[k]);
    confidence = 'manual'; locked = true;
  } else if (!top)              confidence = 'sin_datos';
  else if (obs.length === 1)    confidence = a.n >= 2 ? 'solida' : 'provisional';
  else if (share >= 0.8)        confidence = 'mayoria';
  else                          confidence = 'conflicto';

  // ¿lo confirma alguna tabla vieja?
  const v = viejas.get(k) || [];
  const confirma = v.filter(x => x.addr === address && (x.unit || null) === (unit || null));
  if (confirma.length && confidence === 'provisional') {
    confidence = 'mayoria';
    notes = `Una sola factura en el historial, pero ${confirma.map(c => c.tabla).join(' y ')} lo confirman.`;
  } else if (v.length && !confirma.length && confidence !== 'manual') {
    notes = `Discrepa de ${v.map(c => `${c.tabla} (${c.addr} #${c.unit || '-'})`).join(' ; ')}`;
  }

  const amts = a.amounts.slice().sort((x, y) => x - y);
  rows.push({
    utility_type: a.utility_type, account_last4: a.account_last4,
    provider: [...a.providers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null,
    address, unit, confidence, locked, notes,
    bills_seen: a.n, share: Math.round(share * 100),
    alternatives: obs.filter(o => !(o.addr === address && (o.unit || null) === (unit || null)))
                     .map(o => `${o.addr} #${o.unit || '-'} (x${o.count})`).join(' | ') || null,
    typical_amount: amts.length ? amts[Math.floor(amts.length / 2)].toFixed(2) : null,
    first_seen_at: a.first, last_seen_at: a.last,
  });
}

const by = c => rows.filter(r => r.confidence === c);
console.log('\n============ REGISTRO DE CUENTAS ============\n');
console.log(`Facturas analizadas : ${bills.length}`);
console.log(`Cuentas distintas   : ${rows.length}\n`);
for (const c of ['solida', 'mayoria', 'provisional', 'manual', 'conflicto', 'sin_datos']) {
  const g = by(c);
  if (g.length) console.log(`  ${c.padEnd(13)} ${String(g.length).padStart(3)} cuentas  ${String(g.reduce((s, r) => s + r.bills_seen, 0)).padStart(4)} facturas`);
}

console.log('\n---- CONFLICTO: lo decide Jake ----');
console.table(by('conflicto').map(r => ({ prov: r.provider, tipo: r.utility_type, cuenta: r.account_last4,
  mejor_apuesta: `${r.address} #${r.unit || '-'}`, pct: r.share + '%', contra: r.alternatives, $: r.typical_amount })));

const discrepan = rows.filter(r => r.notes && r.notes.startsWith('Discrepa'));
if (discrepan.length) {
  console.log('\n---- Discrepan de las tablas viejas (gana el historial) ----');
  console.table(discrepan.map(r => ({ tipo: r.utility_type, cuenta: r.account_last4,
    historial: `${r.address} #${r.unit || '-'}`, conf: r.confidence, aviso: r.notes.slice(0, 90) })));
}

fs.writeFileSync('account-registry-propuesto.json', JSON.stringify(rows, null, 2));
console.log('\nDetalle completo -> account-registry-propuesto.json');

if (!APPLY) {
  console.log('\n(dry-run: no se ha escrito nada. Usa --apply)');
  await pool.end();
  process.exit(0);
}

// --- escritura -----------------------------------------------------------
console.log('\n--- APLICANDO ---');
await q(`
  create table if not exists account_registry (
    id             serial primary key,
    utility_type   text not null,
    account_last4  text not null,
    provider       text,
    property_address text,
    unit           text,
    confidence     text not null,
    locked         boolean not null default false,
    bills_seen     integer not null default 0,
    typical_amount numeric,
    alternatives   text,
    notes          text,
    first_seen_at  timestamptz,
    last_seen_at   timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (utility_type, account_last4)
  )`);
console.log('tabla account_registry lista');

let ins = 0, upd = 0, skip = 0;
for (const r of rows) {
  // locked = confirmado a mano o por Jake: no se pisa jamas por una pasada automatica
  const res = await q(`
    insert into account_registry
      (utility_type, account_last4, provider, property_address, unit, confidence, locked,
       bills_seen, typical_amount, alternatives, notes, first_seen_at, last_seen_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    on conflict (utility_type, account_last4) do update set
      provider       = excluded.provider,
      property_address = case when account_registry.locked then account_registry.property_address else excluded.property_address end,
      unit           = case when account_registry.locked then account_registry.unit else excluded.unit end,
      confidence     = case when account_registry.locked then account_registry.confidence else excluded.confidence end,
      bills_seen     = excluded.bills_seen,
      typical_amount = excluded.typical_amount,
      alternatives   = excluded.alternatives,
      notes          = case when account_registry.locked then account_registry.notes else excluded.notes end,
      last_seen_at   = excluded.last_seen_at,
      updated_at     = now()
    returning (xmax = 0) as inserted, locked`,
    [r.utility_type, r.account_last4, r.provider, r.address, r.unit, r.confidence, r.locked,
     r.bills_seen, r.typical_amount, r.alternatives, r.notes, r.first_seen_at, r.last_seen_at]);
  if (res[0].inserted) ins++; else upd++;
}
console.log(`insertadas ${ins} · actualizadas ${upd} · saltadas ${skip}`);

const fin = await q(`select confidence, count(*)::int n from account_registry group by 1 order by 2 desc`);
console.table(fin);
await pool.end();

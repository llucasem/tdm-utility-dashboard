/**
 * Paso 3 del plan post-reset: tablas `payments` y `bill_payments`.
 *
 * El principio (del /roast, Logician + Researcher): guardar el HECHO y derivar
 * la interpretacion. Un pago es un hecho ("salieron $75 el dia 3"); a que
 * factura corresponde es una interpretacion, y tiene que ser revisable.
 * Por eso NO van columnas planas en la factura: un pago puede saldar N
 * facturas (statement consolidado de ConEd) y una factura pagarse a plazos.
 *
 *   payments        el hecho — una fila por transaccion de QuickBooks
 *   bill_payments   la asignacion — que pago salda que factura, con origen
 *                   ('exact-match' | 'manual') y locked para las decisiones
 *                   de una persona, como en account_registry
 *
 * paid_amount/paid_date de una factura se DERIVAN de aqui: siempre
 * recalculables, nunca fuente de verdad.
 *
 * Semilla: los matches exactos ya persistidos en qb_match_data. Si dos
 * facturas reclaman el MISMO pago, no se siembra ninguna de las dos: van a la
 * cola de revision (paso 4). Mejor un hueco visible que un pago contado dos veces.
 *
 * Uso:  node scripts/migrate-payments.mjs [--apply]
 */
import fs from 'fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const APPLY = process.argv.includes('--apply');
const pool  = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (s, p) => (await pool.query(s, p)).rows;

// ── 1. Candidatos: facturas con match unico y datos del pago ────────────────
const candidatas = await q(`
  select id, utility_type, property_address, unit, amount_due, source,
         qb_match_data, qb_match_count
    from utility_bills
   where qb_match_status = 'matched'
     and jsonb_array_length(coalesce(qb_match_data, '[]'::jsonb)) >= 1
     and amount_due > 0
     and not coalesce(is_duplicate, false)   -- un recordatorio no reclama pagos
   order by id`);

const unicas     = candidatas.filter(b => (b.qb_match_count ?? b.qb_match_data.length) === 1);
const ambiguas   = candidatas.length - unicas.length;

// ── 2. Colisiones: el mismo pago reclamado por mas de una factura ───────────
const porPago = new Map();
for (const b of unicas) {
  const m = b.qb_match_data[0];
  if (!m?.id || !m?.date || !(Number(m.amount) > 0)) continue;
  const k = String(m.id);
  if (!porPago.has(k)) porPago.set(k, []);
  porPago.get(k).push(b);
}
const limpias    = [...porPago.entries()].filter(([, bs]) => bs.length === 1);
const colisiones = [...porPago.entries()].filter(([, bs]) => bs.length > 1);

console.log(`Facturas con match:            ${candidatas.length}`);
console.log(`  con match unico:             ${unicas.length}`);
console.log(`  ambiguas (no se siembran):   ${ambiguas}`);
console.log(`Pagos distintos:               ${porPago.size}`);
console.log(`  sembrables (1 pago = 1 factura): ${limpias.length}`);
console.log(`  COLISIONES (a cola de revision): ${colisiones.length}`);

if (colisiones.length) {
  console.log('\n=== Un mismo pago reclamado por varias facturas ===');
  console.table(colisiones.slice(0, 12).map(([pid, bs]) => ({
    pago: pid, importe: bs[0].qb_match_data[0].amount,
    facturas: bs.map(b => `#${b.id} ${(b.property_address || '?').split(',')[0]} ${b.unit || ''}`).join('  |  '),
  })));
}

if (!APPLY) { console.log('\n(dry-run: no se ha escrito nada. Usa --apply)'); await pool.end(); process.exit(0); }

// ── 3. Esquema ──────────────────────────────────────────────────────────────
await q(`
  create table if not exists payments (
    id             serial primary key,
    qb_purchase_id text unique,
    source         text not null default 'quickbooks',
    paid_date      date not null,
    amount         numeric not null,
    payee          text,
    qb_class_id    text,
    qb_class_name  text,
    bank_account   text,
    raw            jsonb,
    created_at     timestamptz not null default now()
  )`);
await q(`
  create table if not exists bill_payments (
    bill_id          integer not null references utility_bills(id) on delete cascade,
    payment_id       integer not null references payments(id) on delete cascade,
    allocated_amount numeric,
    source           text not null,
    locked           boolean not null default false,
    created_at       timestamptz not null default now(),
    primary key (bill_id, payment_id)
  )`);
await q(`create index if not exists bill_payments_by_payment on bill_payments (payment_id)`);
console.log('\ntablas payments y bill_payments listas');

// ── 4. Semilla ──────────────────────────────────────────────────────────────
let pagos = 0, asignaciones = 0;
for (const [pid, [b]] of limpias) {
  const m = b.qb_match_data[0];
  const pr = await q(`
    insert into payments (qb_purchase_id, source, paid_date, amount, payee,
                          qb_class_id, qb_class_name, bank_account, raw)
    values ($1,'quickbooks',$2,$3,$4,$5,$6,$7,$8)
    on conflict (qb_purchase_id) do update set
      paid_date = excluded.paid_date, amount = excluded.amount,
      payee = excluded.payee, qb_class_name = excluded.qb_class_name
    returning id, (xmax = 0) as inserted`,
    [pid, m.date, m.amount, m.payee ?? null, m.classId ?? null,
     m.className ?? null, m.account ?? null, JSON.stringify(m)]);
  if (pr[0].inserted) pagos++;

  const ar = await q(`
    insert into bill_payments (bill_id, payment_id, allocated_amount, source)
    values ($1,$2,null,'exact-match')
    on conflict (bill_id, payment_id) do nothing
    returning 1`, [b.id, pr[0].id]);
  if (ar.length) asignaciones++;
}
console.log(`sembrados ${pagos} pagos y ${asignaciones} asignaciones (origen exact-match)`);

console.table(await q(`
  select (select count(*)::int from payments) pagos,
         (select count(*)::int from bill_payments) asignaciones,
         (select count(*)::int from bill_payments where locked) bloqueadas`));
await pool.end();

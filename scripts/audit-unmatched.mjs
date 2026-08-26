/**
 * Clasifica las facturas que NO tienen pago casado (`not_found`).
 *
 * Por que existe: la peticion principal de Jake — "ensename el importe pagado,
 * no el facturado" — se justificaba con UN caso ($100 facturado / $75 pagado).
 * El sistema no tiene evidencia propia de cuantas veces pasa eso, porque el
 * matcher solo casa importes identicos: un pago parcial no aparece como
 * discrepancia, aparece como `not_found`.
 *
 * Antes de aflojar el matcher hay que saber de que tamaño es el problema.
 * Este script reparte las `not_found` en cubos, usando SOLO datos que ya
 * tenemos (sin llamar a QuickBooks):
 *
 *   escalera_de_saldo   la misma cuenta con un saldo que crece mes a mes: es
 *                       UNA deuda, no N facturas. Sumarlas es contar de mas.
 *   impagada_conocida   deuda documentada (Maxella, ConEd ....8467)
 *   demasiado_reciente  el extracto bancario de QB tarda 3-4 semanas
 *   duplicado_de_qb     hay una fila source='qb' de la misma propiedad cerca
 *   consolidada         email de ConEd con N facturas: se pagan en un solo cargo
 *   sin_explicacion     candidatas de verdad a pago parcial -> el residuo
 *
 * Uso:  node scripts/audit-unmatched.mjs
 */
import fs from 'fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (s, p) => (await pool.query(s, p)).rows;

const sinPago = await q(`
  select id, utility_type, account_last4, property_address, unit, amount_due,
         email_received_at, email_subject, source
    from utility_bills
   where qb_match_status = 'not_found' and amount_due > 0
     and not coalesce(is_duplicate, false)
   order by email_received_at desc`);

// Todas las facturas de cada cuenta, para detectar escaleras de saldo.
const porCuenta = new Map();
for (const b of await q(`
  select account_last4, utility_type, amount_due, email_received_at
    from utility_bills where amount_due > 0 and account_last4 is not null
      and not coalesce(is_duplicate,false) order by email_received_at`)) {
  const k = `${b.utility_type}|${b.account_last4}`;
  if (!porCuenta.has(k)) porCuenta.set(k, []);
  porCuenta.get(k).push(b);
}

// Filas creadas desde QuickBooks, para detectar el duplicado de la fase A.
const filasQB = await q(`
  select utility_type, property_address, unit, amount_due, email_received_at
    from utility_bills where source = 'qb' and not coalesce(is_duplicate,false)`);

const HOY = (await q(`select now() as t`))[0].t;
const dias = (d) => (HOY - new Date(d)) / 86_400_000;

const cubos = {};
const detalle = {};
const meter = (cubo, b, nota) => {
  cubos[cubo] = (cubos[cubo] || 0) + 1;
  (detalle[cubo] ??= []).push({
    id: b.id, fecha: b.email_received_at.toISOString().slice(0, 10),
    tipo: b.utility_type, cuenta: b.account_last4,
    propiedad: (b.property_address || 'SIN ASIGNAR').slice(0, 26),
    unit: b.unit, importe: Number(b.amount_due), nota,
  });
};

for (const b of sinPago) {
  const hermanas = porCuenta.get(`${b.utility_type}|${b.account_last4}`) || [];

  // 1. Escalera de saldo: existe una factura POSTERIOR de la misma cuenta con
  //    importe mayor dentro de ~45 dias. Es la misma deuda creciendo.
  const posteriorMayor = hermanas.find(h =>
    new Date(h.email_received_at) > new Date(b.email_received_at) &&
    (new Date(h.email_received_at) - new Date(b.email_received_at)) / 86_400_000 <= 45 &&
    Number(h.amount_due) > Number(b.amount_due));
  if (posteriorMayor) {
    meter('escalera_de_saldo', b, `luego sube a $${Number(posteriorMayor.amount_due).toFixed(2)}`);
    continue;
  }

  // 2. Demasiado reciente: el extracto bancario de QuickBooks tarda 3-4 semanas.
  if (dias(b.email_received_at) < 35) {
    meter('demasiado_reciente', b, `hace ${Math.round(dias(b.email_received_at))} dias`);
    continue;
  }

  // 3. Duplicado del backfill: hay una fila de QB de la misma propiedad+tipo cerca.
  const gemela = filasQB.find(x =>
    x.utility_type === b.utility_type && x.property_address === b.property_address &&
    Math.abs((new Date(x.email_received_at) - new Date(b.email_received_at)) / 86_400_000) <= 45);
  if (gemela) {
    meter('duplicado_de_qb', b, `fila QB de $${Number(gemela.amount_due).toFixed(2)} al lado`);
    continue;
  }

  // 4. Consolidada de ConEd: varias facturas del mismo email.
  if ((b.email_subject || '').toLowerCase().includes('con edison bill is ready')) {
    meter('consolidada', b, 'statement consolidado de ConEd');
    continue;
  }

  // 5. Residuo: estas son las unicas que podrian ser pagos parciales.
  meter('sin_explicacion', b, '');
}

console.log(`\nFacturas sin pago casado: ${sinPago.length}\n`);
console.log('=== En que se reparten ===');
const orden = ['escalera_de_saldo', 'demasiado_reciente', 'duplicado_de_qb', 'consolidada', 'sin_explicacion'];
console.table(orden.filter(c => cubos[c]).map(c => ({
  cubo: c, facturas: cubos[c], pct: Math.round(cubos[c] / sinPago.length * 100) + '%',
  importe: '$' + detalle[c].reduce((s, x) => s + x.importe, 0).toFixed(2),
})));

const residuo = detalle['sin_explicacion'] || [];
console.log(`\n=== EL RESIDUO: ${residuo.length} facturas ===`);
console.log('Solo estas pueden ser pagos parciales. Es la cifra que decide');
console.log('si merece la pena aflojar el matcher.\n');
console.table(residuo.slice(0, 30));

fs.writeFileSync('audit-unmatched.json', JSON.stringify({ cubos, detalle }, null, 2));
console.log('\nDetalle completo -> audit-unmatched.json');
await pool.end();

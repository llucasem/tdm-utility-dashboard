/**
 * Unifica la forma de las direcciones y las unidades en toda la base.
 *
 * El problema que arregla (lo reporto Jake en su revision de julio, y los
 * cambios del 14/08 lo agravaron): la misma propiedad aparecia escrita de
 * varias formas — "2200 Colorado Ave, Santa Monica, CA 90404" y
 * "2200 COLORADO AVE" — asi que el dashboard la mostraba como dos grupos
 * distintos y los totales no cuadraban.
 *
 * A partir de ahora hay DOS formas y cada una tiene su sitio:
 *   property_address (registro)  clave canonica, para agrupar
 *   display_address  (registro)  lo que ve Jake, con ciudad
 *   utility_bills.property_address  siempre la forma de mostrar
 *
 * Uso:  node scripts/unify-addresses.mjs [--apply]
 */
import fs from 'fs';
import pg from 'pg';
import { normAddress, normUnit, pickDisplayAddress } from '../lib/account-registry.js';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const APPLY = process.argv.includes('--apply');
const pool  = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (s, p) => (await pool.query(s, p)).rows;

const SUFIJOS = /\b(AVE|ST|BLVD|RD|DR|PL|CT|LN|TER|WAY|CIR|PKWY)$/;

// ── 1. Todas las grafias vistas, agrupadas por clave canonica ────────────────
const variantes = await q(`
  select property_address text, count(*)::int count
    from utility_bills where property_address is not null group by 1`);

const grupos = new Map();
for (const v of variantes) {
  const clave = normAddress(v.text);
  if (!clave) continue;
  if (!grupos.has(clave)) grupos.set(clave, []);
  grupos.get(clave).push(v);
}

// ── 2. Fusionar la calle incompleta con la completa ──────────────────────────
// "175 W 107TH" (sin tipo de via) y "175 W 107TH ST" son la misma calle: el
// remitente se dejo el "St". Se fusiona en la completa.
const claves = [...grupos.keys()].sort((a, b) => b.length - a.length);
const fusiones = [];
for (const corta of [...claves].reverse()) {
  if (SUFIJOS.test(corta)) continue;               // ya esta completa
  const larga = claves.find(k => k !== corta && k.startsWith(corta + ' ') && SUFIJOS.test(k));
  if (!larga) continue;
  grupos.get(larga).push(...grupos.get(corta));
  grupos.delete(corta);
  fusiones.push({ incompleta: corta, se_une_a: larga });
}

// ── 3. Elegir la forma de mostrar de cada propiedad ──────────────────────────
const display = new Map();
for (const [clave, vs] of grupos) display.set(clave, pickDisplayAddress(vs));

console.log(`Propiedades distintas: ${grupos.size}   ·   grafias en la base: ${variantes.length}\n`);
if (fusiones.length) { console.log('=== Calles incompletas fusionadas ==='); console.table(fusiones); }

console.log('\n=== Forma canonica -> lo que vera Jake ===');
console.table([...grupos.entries()]
  .filter(([, vs]) => vs.length > 1)
  .map(([clave, vs]) => ({
    canonica: clave,
    se_muestra_como: display.get(clave),
    grafias_que_desaparecen: vs.filter(v => v.text !== display.get(clave)).map(v => v.text).join(' | ').slice(0, 70),
    filas: vs.reduce((s, v) => s + v.count, 0),
  })));

// ── 4. Unidades ──────────────────────────────────────────────────────────────
const unidades = await q(`select unit, count(*)::int n from utility_bills where unit is not null group by 1`);
const cambiosUnidad = unidades
  .filter(u => normUnit(u.unit) !== u.unit)
  .map(u => ({ antes: u.unit, despues: normUnit(u.unit), filas: u.n }));
console.log(`\n=== Unidades a normalizar: ${cambiosUnidad.length} formas ===`);
if (cambiosUnidad.length) console.table(cambiosUnidad.slice(0, 30));

if (!APPLY) { console.log('\n(dry-run: no se ha escrito nada. Usa --apply)'); await pool.end(); process.exit(0); }

// ── 5. Aplicar ───────────────────────────────────────────────────────────────
console.log('\n--- APLICANDO ---');
await q(`alter table account_registry add column if not exists display_address text`);

let reg = 0;
for (const [clave, texto] of display) {
  const r = await q(`update account_registry set display_address = $1, updated_at = now()
                      where property_address = $2 and coalesce(display_address,'') <> $1
                      returning id`, [texto, clave]);
  reg += r.length;
}
console.log(`registro: ${reg} cuentas con direccion de mostrar`);

// Cuentas del registro cuya clave no aparece en utility_bills: se muestran
// con su propia forma canonica, que es lo unico que sabemos de ellas.
const huecos = await q(`update account_registry set display_address = property_address
                         where display_address is null and property_address is not null
                         returning id`);
if (huecos.length) console.log(`registro: ${huecos.length} cuentas sin grafia completa, se muestran en canonico`);

// Facturas: una sola forma de la direccion y de la unidad.
let filas = 0;
for (const [clave, texto] of display) {
  const vs = grupos.get(clave).map(v => v.text).filter(t => t !== texto);
  if (!vs.length) continue;
  const r = await q(`update utility_bills set property_address = $1
                      where property_address = any($2) returning id`, [texto, vs]);
  filas += r.length;
}
console.log(`facturas: ${filas} filas con la direccion unificada`);

let uds = 0;
for (const c of cambiosUnidad) {
  const r = await q(`update utility_bills set unit = $1 where unit = $2 returning id`, [c.despues, c.antes]);
  uds += r.length;
}
console.log(`facturas: ${uds} filas con la unidad normalizada`);

console.log('\n=== Comprobacion final: queda alguna propiedad con dos grafias? ===');
const resto = await q(`
  with n as (select property_address, upper(regexp_replace(split_part(property_address,',',1),'[^A-Za-z0-9 ]','','g')) k
               from utility_bills where property_address is not null)
  select k clave, count(distinct property_address)::int formatos from n group by 1 having count(distinct property_address) > 1`);
console.log(resto.length ? resto : '  ninguna — una sola forma por propiedad');
await pool.end();

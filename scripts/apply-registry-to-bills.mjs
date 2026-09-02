/**
 * Aplica el registro de cuentas a las facturas que se guardaron ANTES de que
 * el registro existiera y quedaron sin propiedad.
 *
 * No adivina nada: solo copia lo que ya dice account_registry para esa cuenta,
 * y unicamente en cuentas de fiar (solida / mayoria / manual).
 *
 * Uso:  node scripts/apply-registry-to-bills.mjs [--apply]
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

const pendientes = await q(`
  select b.id, b.utility_type, b.account_last4, b.amount_due,
         to_char(b.email_received_at,'YYYY-MM-DD') fecha,
         r.property_address, r.unit, r.confidence
    from utility_bills b
    join account_registry r
      on r.utility_type = b.utility_type
     and r.account_last4 = b.account_last4
   where b.property_address is null
     and r.property_address is not null
     and r.confidence in ('solida','mayoria','manual')
   order by b.email_received_at desc`);

console.log(`Facturas sin propiedad que el registro SI sabe resolver: ${pendientes.length}\n`);
if (pendientes.length) console.table(pendientes.map(p => ({
  id: p.id, fecha: p.fecha, tipo: p.utility_type, cuenta: p.account_last4,
  importe: p.amount_due, pasa_a: `${p.property_address} #${p.unit || '-'}`, confianza: p.confidence,
})));

// Facturas que SI tienen propiedad pero les falta la unidad (o la tienen
// distinta de una decision humana). El backfill original solo miraba
// `property_address is null`, asi que estas nunca se tocaron: por eso
// 501 E 106th St seguia mostrandose sin "#4" pese a estar fijado y locked
// en el registro desde el 14/08.
const unidades = await q(`
  select b.id, b.utility_type, b.account_last4, b.unit unidad_actual,
         r.unit unidad_registro, r.confidence, r.locked,
         to_char(b.email_received_at,'YYYY-MM-DD') fecha, b.amount_due
    from utility_bills b
    join account_registry r
      on r.utility_type = b.utility_type and r.account_last4 = b.account_last4
   where r.unit is not null
     and r.confidence in ('solida','mayoria','manual')
     and b.unit is distinct from r.unit
     -- Una unidad distinta solo se pisa si la decidio una persona (locked).
     -- Si solo falta, se rellena siempre.
     and (b.unit is null or r.locked)
   order by b.email_received_at desc`);

if (unidades.length) {
  console.log(`\n=== Facturas con la unidad ausente o desalineada: ${unidades.length} ===`);
  console.table(unidades.slice(0, 20).map(u => ({
    id: u.id, fecha: u.fecha, tipo: u.utility_type, cuenta: u.account_last4,
    importe: u.amount_due, ahora: u.unidad_actual ?? '(vacia)',
    pasa_a: u.unidad_registro, motivo: u.locked ? 'decision humana' : 'estaba vacia',
  })));
}

const sinResolver = await q(`
  select b.utility_type tipo, b.account_last4 cuenta, count(*)::int facturas, max(b.amount_due) importe_max
    from utility_bills b
   where b.property_address is null and b.amount_due > 0
     and not coalesce(b.is_duplicate,false)
     and not exists (
       select 1 from account_registry r
        where r.utility_type = b.utility_type and r.account_last4 = b.account_last4
          and r.property_address is not null and r.confidence in ('solida','mayoria','manual'))
   group by 1,2 order by 4 desc`);

if (sinResolver.length) {
  console.log('\n=== Estas siguen necesitando que alguien las identifique ===');
  console.table(sinResolver);
}

if (!APPLY) { console.log('\n(dry-run: no se ha escrito nada. Usa --apply)'); await pool.end(); process.exit(0); }

const upd = await q(`
  update utility_bills b
     set property_address = r.property_address,
         unit             = coalesce(b.unit, r.unit)
    from account_registry r
   where r.utility_type = b.utility_type
     and r.account_last4 = b.account_last4
     and b.property_address is null
     and r.property_address is not null
     and r.confidence in ('solida','mayoria','manual')
  returning b.id`);
console.log(`\nactualizadas ${upd.length} facturas sin propiedad`);

const updU = await q(`
  update utility_bills b
     set unit = r.unit
    from account_registry r
   where r.utility_type = b.utility_type and r.account_last4 = b.account_last4
     and r.unit is not null
     and r.confidence in ('solida','mayoria','manual')
     and b.unit is distinct from r.unit
     and (b.unit is null or r.locked)
  returning b.id`);
console.log(`alineadas ${updU.length} unidades con el registro`);
await pool.end();

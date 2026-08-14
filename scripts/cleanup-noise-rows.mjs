/**
 * Fase 5 del reset: saca el ruido de utility_bills.
 *
 * El sistema viejo guardaba cada email descartado como una fila de importe 0,
 * porque era su unica forma de recordar "esto ya lo he mirado". Resultado: el
 * 72% de la tabla de facturas no eran facturas.
 *
 * Ese trabajo lo hace ahora processed_emails. Estas filas ya no sirven para
 * nada... pero solo se pueden borrar si constan en el registro nuevo. Si no,
 * Gmail volveria a ofrecer esos emails y el sync los reprocesaria.
 *
 * El script COMPRUEBA esa condicion antes de borrar nada.
 *
 * Uso:  node scripts/cleanup-noise-rows.mjs [--apply]
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

const antes = await q(`
  select count(*)::int total,
         count(*) filter (where coalesce(amount_due,0) = 0)::int ruido,
         count(*) filter (where amount_due > 0)::int facturas
    from utility_bills`);
console.log('=== utility_bills ahora ===');
console.table(antes);

// La condicion de seguridad: cada fila de ruido tiene que constar ya en
// processed_emails. Si alguna no consta, NO se borra.
const huerfanas = await q(`
  select b.id, b.gmail_message_id, b.email_subject, b.email_received_at
    from utility_bills b
   where coalesce(b.amount_due,0) = 0
     and b.gmail_message_id is not null
     and not exists (
       select 1 from processed_emails p
        where p.gmail_message_id = split_part(b.gmail_message_id,'#',1))`);

const sinId = await q(`
  select count(*)::int n from utility_bills
   where coalesce(amount_due,0) = 0 and gmail_message_id is null`);

console.log(`\nFilas de ruido SIN rastro en processed_emails : ${huerfanas.length}`);
console.log(`Filas de ruido sin id de Gmail (manuales)     : ${sinId[0].n}`);

if (huerfanas.length) {
  console.log('\nEstas se quedan como estan (se reprocesarian):');
  console.table(huerfanas.slice(0, 10).map(h => ({
    id: h.id, asunto: (h.email_subject || '').slice(0, 50),
    fecha: h.email_received_at?.toISOString().slice(0, 10),
  })));
}

const borrables = await q(`
  select count(*)::int n from utility_bills b
   where coalesce(b.amount_due,0) = 0
     and b.gmail_message_id is not null
     and exists (
       select 1 from processed_emails p
        where p.gmail_message_id = split_part(b.gmail_message_id,'#',1))`);

console.log(`\n>>> Se pueden borrar con seguridad: ${borrables[0].n} filas`);
console.log(`>>> La tabla quedaria en ${antes[0].total - borrables[0].n} filas`);

if (!APPLY) { console.log('\n(dry-run: no se ha borrado nada. Usa --apply)'); await pool.end(); process.exit(0); }

// class_learning_log apunta a utility_bills con una clave ajena. Sus
// anotaciones sobre filas de ruido no describen nada real (el ruido nunca fue
// una factura), asi que se quitan primero. El resto del log se conserva:
// lib/known-vendors.js lo sigue usando para la lista de proveedores fiables.
const logs = await q(`
  delete from class_learning_log l
   using utility_bills b
   where b.id = l.bill_id and coalesce(b.amount_due,0) = 0
  returning l.id`);
console.log(`\nquitadas ${logs.length} anotaciones de class_learning_log que apuntaban a ruido`);

const del = await q(`
  delete from utility_bills b
   where coalesce(b.amount_due,0) = 0
     and b.gmail_message_id is not null
     and exists (
       select 1 from processed_emails p
        where p.gmail_message_id = split_part(b.gmail_message_id,'#',1))
  returning b.id`);
console.log(`\nborradas ${del.length} filas de ruido`);

console.log('\n=== utility_bills despues ===');
console.table(await q(`
  select count(*)::int total,
         count(*) filter (where amount_due > 0 and not coalesce(is_duplicate,false))::int facturas_visibles,
         count(*) filter (where is_duplicate)::int recordatorios,
         count(*) filter (where coalesce(amount_due,0) = 0)::int ruido_restante
    from utility_bills`));
await pool.end();

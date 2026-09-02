/**
 * Pasa las reglas de lib/rent-providers.js por los emails REALES que ya
 * generaron pagos de renta, y compara con lo que la IA extrajo en su dia.
 *
 * Contesta: ¿cuantas rentas leerian las reglas fijas sin gastar una sola
 * llamada a Claude, y coinciden los datos?
 *
 * Uso:  node scripts/validate-rent-providers.mjs
 */
import fs from 'fs';
import pg from 'pg';
import { extractRentPayment, cleanRentUnit } from '../lib/rent-providers.js';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false }, query_timeout: 40000 });
// La variable viene vacia con un comentario en linea ('=   # Se rellenara'),
// que un parser ingenuo se traga como valor. Igual que hace lib/airtable.js:
const limpia = v => (v && !v.trim().startsWith('#')) ? v.trim() : null;
const BASE = limpia(env.AIRTABLE_RENT_BASE_ID) || 'app4hMyYd61s95xqV';
const TABLE = env.AIRTABLE_EMAILS_TABLE_ID || 'tblcWkXqmdR8JI6Pq';

const filas = (await pool.query(
  `select id, airtable_record_id, payment_portal, amount_paid, unit,
          to_char(paid_date,'YYYY-MM-DD') paid_date
     from rent_payments where airtable_record_id is not null
     order by created_at desc`)).rows;

console.log(`Pagos de renta con email en Airtable: ${filas.length}\n`);

const stats = {};
const discrepancias = [];
let i = 0;
for (const f of filas) {
  if (++i % 5 === 0) await new Promise(r => setTimeout(r, 1100)); // limite Airtable 5 req/s
  let rec;
  try {
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}/${f.airtable_record_id}`,
      { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) { (stats.sin_email ??= 0), stats.sin_email++; continue; }
    rec = (await r.json()).fields || {};
  } catch { (stats.sin_email ??= 0), stats.sin_email++; continue; }

  const email = {
    fromEmail: (rec['From Email'] || '').toLowerCase(), from: rec.From || '',
    subject: rec.Subject || '', content: rec.Content || '', htmlContent: rec['HTML Content'] || '',
  };
  const out = extractRentPayment(email);
  const portal = f.payment_portal || '?';
  stats[portal] ??= { total: 0, regla: 0, importe_ok: 0, iria_a_ia: 0, ruido: 0 };
  stats[portal].total++;

  if (!out) { stats[portal].iria_a_ia++; continue; }
  if (out.kind !== 'rent_payment') { stats[portal].ruido++; discrepancias.push({ portal, id: f.id, caso: `regla dice ruido (${out.template})` }); continue; }

  stats[portal].regla++;
  if (Math.abs(Number(out.amount_paid) - Number(f.amount_paid)) < 0.01) stats[portal].importe_ok++;
  else discrepancias.push({ portal, id: f.id, caso: `importe: IA ${f.amount_paid} vs regla ${out.amount_paid}` });

  const unidadRegla = out.unit ?? null;
  const unidadIA = cleanRentUnit(f.unit);
  if (unidadRegla && unidadIA && unidadRegla !== unidadIA) {
    discrepancias.push({ portal, id: f.id, caso: `unidad: guardada ${f.unit} vs regla ${unidadRegla}` });
  }
  if (out.paid_date && f.paid_date && out.paid_date !== f.paid_date) {
    discrepancias.push({ portal, id: f.id, caso: `fecha: guardada ${f.paid_date} vs regla ${out.paid_date}` });
  }
}

console.log('=== Cobertura por portal ===');
console.table(stats);
const tot = Object.values(stats).filter(v => typeof v === 'object');
const suma = k => tot.reduce((s, v) => s + (v[k] || 0), 0);
console.log(`\nTOTAL: ${suma('total')} · leidas por regla fija: ${suma('regla')} (${Math.round(suma('regla') / suma('total') * 100)}%) · importe identico: ${suma('importe_ok')} · irian a IA: ${suma('iria_a_ia')}`);

if (discrepancias.length) {
  console.log(`\n=== Discrepancias: ${discrepancias.length} ===`);
  console.table(discrepancias.slice(0, 25));
} else {
  console.log('\nSin discrepancias.');
}
await pool.end();

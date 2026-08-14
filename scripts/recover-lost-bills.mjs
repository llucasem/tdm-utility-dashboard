/**
 * Recupera las facturas que el sistema viejo tiro a la papelera.
 *
 * Busca emails guardados como ruido (importe 0) que las reglas nuevas SI leen
 * como factura — tipicamente SoCalGas, cuyo asunto "Your Automatic Monthly
 * Payment is scheduled" estaba en la lista de descarte y era justamente el
 * email que llevaba cuenta, apodo, unidad e importe.
 *
 * No inserta nada: borra la marca de "ya procesado" para que el sync nuevo los
 * vuelva a ver y los procese con las reglas correctas. Asi hay un solo camino
 * por el que entran las facturas.
 *
 * Uso:  node scripts/recover-lost-bills.mjs [dias] [--apply]
 */
import fs from 'fs';
import pg from 'pg';
import { google } from 'googleapis';
import { extractBill } from '../lib/providers.js';

const DIAS  = Number(process.argv.find(a => /^\d+$/.test(a))) || 60;
const APPLY = process.argv.includes('--apply');
const SOLO  = process.argv.find(a => a.startsWith('--solo='))?.split('=')[1] || null;

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const pool  = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const oauth = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
oauth.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth });

function decode(p) {
  if (!p) return '';
  if ((p.mimeType === 'text/html' || p.mimeType === 'text/plain') && p.body?.data)
    return Buffer.from(p.body.data, 'base64url').toString('utf-8');
  if (p.parts) return p.parts.map(decode).join('\n');
  return '';
}

const candidatos = (await pool.query(
  `select id, gmail_message_id, email_subject, email_from, email_received_at
     from utility_bills
    where coalesce(amount_due,0) = 0
      and gmail_message_id is not null
      and gmail_message_id not like 'qb:%'
      and email_received_at > now() - make_interval(days => $1)
    order by email_received_at desc`, [DIAS])).rows;

console.log(`Emails guardados como ruido en los ultimos ${DIAS} dias: ${candidatos.length}\n`);

const recuperables = [];
for (const c of candidatos) {
  const msgId = c.gmail_message_id.split('#')[0];
  if (SOLO && msgId !== SOLO) continue;
  let m;
  try { m = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' }); }
  catch { continue; }
  const h = m.data.payload?.headers || [];
  const email = {
    id: msgId,
    from:    h.find(x => x.name === 'From')?.value || c.email_from || '',
    subject: h.find(x => x.name === 'Subject')?.value || c.email_subject || '',
    body:    decode(m.data.payload), snippet: m.data.snippet || '',
  };

  const out = extractBill(email);
  if (!out) continue;
  const items = out.kind === 'multi' ? out.items : [out];
  const facturas = items.filter(i => i.kind === 'bill');
  if (!facturas.length) continue;

  recuperables.push({
    billRowId: c.id, msgId,
    fecha: c.email_received_at.toISOString().slice(0, 10),
    asunto: (email.subject || '').slice(0, 42),
    cuenta: facturas[0].account_last4,
    importe: facturas[0].amount_due,
    plantilla: facturas[0].template,
  });
}

console.log(`=== Facturas recuperables: ${recuperables.length} ===`);
if (recuperables.length) console.table(recuperables.slice(0, 40));

if (!APPLY) { console.log('\n(dry-run: no se ha tocado nada. Usa --apply)'); await pool.end(); process.exit(0); }

const ids  = recuperables.map(r => r.billRowId);
const msgs = recuperables.map(r => r.msgId);
const a = await pool.query(`delete from utility_bills where id = any($1)`, [ids]);
const b = await pool.query(`delete from processed_emails where gmail_message_id = any($1)`, [msgs]);
console.log(`\nborradas ${a.rowCount} filas de ruido y ${b.rowCount} marcas de procesado`);
console.log('El proximo sync volvera a ver esos emails y los procesara con las reglas nuevas.');
await pool.end();

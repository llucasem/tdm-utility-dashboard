/**
 * Simula el sync nuevo sobre emails REALES y compara con lo que hay guardado.
 * No escribe nada.
 *
 * Contesta la pregunta que importa: si el pipeline nuevo hubiera procesado
 * estos emails, ¿habria sacado lo mismo, mejor o peor que el viejo?
 *
 * Uso:  node scripts/dry-run-sync.mjs [dias] [maxEmails]
 */
import fs from 'fs';
import pg from 'pg';
import { google } from 'googleapis';
import { extractBill } from '../lib/providers.js';
import { loadRegistry, resolveAccount, normAddress, normUnit } from '../lib/account-registry.js';

const DIAS = Number(process.argv[2]) || 45;
const MAX  = Number(process.argv[3]) || 250;

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

const registry = await loadRegistry(pool);
const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
const util   = labels.find(l => /^utilities$/i.test(l.name));

let ids = [], token = null;
do {
  const r = await gmail.users.messages.list({ userId: 'me', labelIds: [util.id], maxResults: 100, pageToken: token, q: `newer_than:${DIAS}d` });
  ids.push(...(r.data.messages || []).map(m => m.id));
  token = r.data.nextPageToken;
} while (token && ids.length < MAX);
ids = ids.slice(0, MAX);

// Lo que el sistema VIEJO guardo para esos mismos emails
const guardadas = new Map();
for (const row of (await pool.query(
  `select split_part(gmail_message_id,'#',1) msg, amount_due, property_address, unit, account_last4, utility_type
     from utility_bills where split_part(gmail_message_id,'#',1) = any($1)`, [ids])).rows) {
  if (!guardadas.has(row.msg)) guardadas.set(row.msg, []);
  guardadas.get(row.msg).push(row);
}

const R = { nuevas: 0, iguales: 0, mejoradas: 0, distintas: 0, rescatadas: 0, duplicadas: 0, ruido: 0, pagos: 0, credito: 0, ia: 0 };
const rescatadas = [], mejoras = [], discrepancias = [];

for (const id of ids) {
  let m; try { m = await gmail.users.messages.get({ userId: 'me', id, format: 'full' }); } catch { continue; }
  const h = m.data.payload?.headers || [];
  const email = {
    id,
    from:    h.find(x => x.name === 'From')?.value || '',
    subject: h.find(x => x.name === 'Subject')?.value || '',
    date:    h.find(x => x.name === 'Date')?.value || '',
    body:    decode(m.data.payload), snippet: m.data.snippet || '',
  };

  const lectura = extractBill(email);
  if (!lectura) { R.ia++; continue; }

  const items = lectura.kind === 'multi' ? lectura.items : [lectura];
  const viejo = (guardadas.get(id) || []).filter(b => Number(b.amount_due) > 0);

  for (const it of items) {
    if (it.kind === 'noise')   { R.ruido++;   continue; }
    if (it.kind === 'payment') { R.pagos++;   continue; }
    if (it.kind === 'credit')  { R.credito++; continue; }

    const reg = resolveAccount(registry, it.utility_type, it.account_last4);
    const prop = reg
      ? { addr: reg.property_address, unit: reg.unit, origen: 'registro' }
      : it.service_address
        ? { addr: normAddress(it.service_address), unit: normUnit(it.unit), origen: 'email' }
        : { addr: null, unit: null, origen: 'sin asignar' };

    const par = viejo.find(b => Math.abs(Number(b.amount_due) - it.amount_due) < 0.01);
    if (!par) {
      // Este email no genero factura antes. Pero puede ser el recordatorio de
      // un recibo que SI se guardo desde otro email: hay que comprobar la
      // ventana de dedup antes de cantar victoria.
      const yaEsta = await pool.query(
        `select id from utility_bills
          where utility_type=$1 and account_last4=$2
            and round(amount_due::numeric,2)=round($3::numeric,2)
            and not coalesce(is_duplicate,false)
            and email_received_at between $4::timestamptz - interval '18 days'
                                      and $4::timestamptz + interval '18 days'
          limit 1`,
        [it.utility_type, it.account_last4, it.amount_due, new Date(email.date).toISOString()]
      );
      if (yaEsta.rowCount) { R.duplicadas++; continue; }
      R.rescatadas++;
      rescatadas.push({ asunto: email.subject.slice(0, 44), cuenta: it.account_last4,
        importe: it.amount_due, propiedad: `${prop.addr || '?'} #${prop.unit || '-'}`, plantilla: it.template });
      continue;
    }

    const viejaProp = `${normAddress(par.property_address) || '?'} #${normUnit(par.unit) || '-'}`;
    const nuevaProp = `${prop.addr || '?'} #${prop.unit || '-'}`;
    if (viejaProp === nuevaProp) R.iguales++;
    else if (viejaProp.startsWith('?') && !nuevaProp.startsWith('?')) {
      R.mejoradas++;
      mejoras.push({ cuenta: it.account_last4, importe: it.amount_due, antes: viejaProp, ahora: nuevaProp });
    } else {
      R.distintas++;
      discrepancias.push({ cuenta: it.account_last4, importe: it.amount_due, antes: viejaProp, ahora: nuevaProp, origen: prop.origen });
    }
  }
}

console.log(`\nEmails analizados: ${ids.length}  ·  ultimos ${DIAS} dias\n`);
console.log('=== Comparacion contra lo que hay guardado ===');
console.log(`  facturas identicas          : ${R.iguales}`);
console.log(`  facturas MEJORADAS          : ${R.mejoradas}   (antes sin propiedad, ahora con ella)`);
console.log(`  facturas RESCATADAS         : ${R.rescatadas}   (el sistema viejo no las guardo)`);
console.log(`  discrepan                   : ${R.distintas}`);
  console.log(`  recordatorios colapsados    : ${R.duplicadas}   (mismo recibo, otro email)`);
console.log(`\n  pagos reconocidos           : ${R.pagos}`);
console.log(`  saldos a favor              : ${R.credito}`);
console.log(`  ruido descartado            : ${R.ruido}`);
console.log(`  irian a la IA de reserva    : ${R.ia}`);

if (mejoras.length)      { console.log('\n=== MEJORADAS ===');       console.table(mejoras.slice(0, 20)); }
if (rescatadas.length)   { console.log('\n=== RESCATADAS ===');      console.table(rescatadas.slice(0, 30)); }
if (discrepancias.length){ console.log('\n=== DISCREPANCIAS (revisar) ==='); console.table(discrepancias.slice(0, 25)); }

await pool.end();

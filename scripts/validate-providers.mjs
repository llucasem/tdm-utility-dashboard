/**
 * Pasa las reglas deterministas de lib/providers.js por los emails REALES de
 * la carpeta "Utilities" y cuenta que sale.
 *
 * Sirve para dos cosas:
 *   1. Comprobar que las reglas cubren lo que tienen que cubrir antes de
 *      confiarles el sync.
 *   2. Enterarse cuando un proveedor cambia de plantilla: si un remitente
 *      conocido empieza a devolver "ruido" en masa, algo se ha movido.
 *
 * Uso:  node scripts/validate-providers.mjs [dias] [maxEmails]
 */
import fs from 'fs';
import { google } from 'googleapis';
import { extractBill, findProvider, toText } from '../lib/providers.js';

const DIAS = Number(process.argv[2]) || 90;
const MAX  = Number(process.argv[3]) || 400;

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

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

// Localiza la etiqueta "Utilities" (el nombre puede venir anidado).
const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
const util   = labels.find(l => /^utilities$/i.test(l.name)) || labels.find(l => /utilities/i.test(l.name));
if (!util) { console.error('No encuentro la etiqueta "Utilities"'); process.exit(1); }

let ids = [], token = null;
do {
  const r = await gmail.users.messages.list({
    userId: 'me', labelIds: [util.id], maxResults: 100, pageToken: token,
    q: `newer_than:${DIAS}d`,
  });
  ids.push(...(r.data.messages || []).map(m => m.id));
  token = r.data.nextPageToken;
} while (token && ids.length < MAX);
ids = ids.slice(0, MAX);

console.log(`Etiqueta "${util.name}" · ${ids.length} emails de los ultimos ${DIAS} dias\n`);

const stats = {};
const bump = (prov, kind, n = 1) => {
  stats[prov] ??= { bill: 0, credit: 0, payment: 0, noise: 0, total: 0 };
  stats[prov][kind] = (stats[prov][kind] || 0) + n;
  stats[prov].total += n;
};
const desconocidos = new Map();
const plantillas   = new Map();
const sinLeer      = [];

for (const id of ids) {
  let m;
  try { m = await gmail.users.messages.get({ userId: 'me', id, format: 'full' }); }
  catch { continue; }
  const h = m.data.payload?.headers || [];
  const from    = h.find(x => x.name === 'From')?.value || '';
  const subject = h.find(x => x.name === 'Subject')?.value || '';
  const email   = { id, from, subject, body: decode(m.data.payload), snippet: m.data.snippet || '' };

  const prov = findProvider(from);
  if (!prov) {
    const dom = (from.match(/@([\w.-]+)/) || [])[1] || from;
    desconocidos.set(dom, (desconocidos.get(dom) || 0) + 1);
    bump('(desconocido)', 'noise');
    continue;
  }

  const out = extractBill(email);
  if (out.kind === 'multi') {
    for (const it of out.items) bump(prov.name, it.kind);
  } else {
    bump(prov.name, out.kind);
  }
  plantillas.set(out.template, (plantillas.get(out.template) || 0) + 1);

  // Un email de un proveedor conocido que menciona dinero pero sale como ruido
  // es sospechoso: puede ser una plantilla nueva que no estamos leyendo.
  if (out.kind === 'noise' && /\$[\d,]+\.\d{2}/.test(toText(email.body))) {
    sinLeer.push({ prov: prov.name, subject: subject.slice(0, 62) });
  }
}

console.log('=== Que saca cada proveedor ===');
console.table(stats);

console.log('\n=== Plantillas reconocidas ===');
console.table([...plantillas.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ plantilla: t, n })));

if (desconocidos.size) {
  console.log('\n=== Remitentes que NO reconocemos (irian a la IA de reserva) ===');
  console.table([...desconocidos.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ dominio: d, n })));
}

if (sinLeer.length) {
  console.log(`\n=== OJO: ${sinLeer.length} emails de proveedor conocido con importe que salen como ruido ===`);
  const agrupado = new Map();
  for (const s of sinLeer) {
    const k = `${s.prov} · ${s.subject}`;
    agrupado.set(k, (agrupado.get(k) || 0) + 1);
  }
  console.table([...agrupado.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => ({ caso: k, n })));
}

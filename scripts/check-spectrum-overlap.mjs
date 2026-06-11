/**
 * Verifica que las 14 facturas Spectrum "Statement is Ready" de mayo no
 * solapen con bills ya existentes en el dashboard.
 *
 * Comprueba 2 tipos de solapamiento:
 *   A) Por cuenta + importe + mes (duplicado lógico aunque sea otro email)
 *   B) Por propiedad+unit (ya hay factura de internet en mayo para esa unidad)
 *
 * READ-ONLY.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { google } from 'googleapis';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

function getGmail() {
  const c = new google.auth.OAuth2(env['GMAIL_CLIENT_ID'], env['GMAIL_CLIENT_SECRET']);
  c.setCredentials({ refresh_token: env['GMAIL_REFRESH_TOKEN'] });
  return google.gmail({ version: 'v1', auth: c });
}

function decodeBody(part) {
  if (!part) return '';
  if ((part.mimeType === 'text/plain' || part.mimeType === 'text/html') && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }
  if (part.parts) {
    for (const p of part.parts) if (p.mimeType === 'text/html' && p.body?.data) {
      return Buffer.from(p.body.data, 'base64url').toString('utf-8');
    }
    for (const p of part.parts) { const t = decodeBody(p); if (t) return t; }
  }
  return '';
}
function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
}
function extract(text) {
  const a = text.match(/\$\s*([0-9,]+\.[0-9]{2})/);
  const amount = a ? parseFloat(a[1].replace(/,/g,'')) : null;
  const ac = text.match(/Account(?:\s+(?:Number|#))?[:\s]+\*+\s*(\d{4})/i)
          || text.match(/Account[:\s]+x+(\d{4})/i)
          || text.match(/ending in\s*(\d{4})/i);
  const last4 = ac ? ac[1] : null;
  const ad = text.match(/Service Address[:\s]*([^\n]+?)(?:Account|Statement|Date|$)/i);
  const addr = ad ? ad[1].trim().replace(/\s+,/g,',').slice(0,100) : null;
  return { amount, last4, addr };
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Comprobación de solapamiento — 14 Spectrum mayo');
console.log('═══════════════════════════════════════════════════════════\n');

const gmail = getGmail();
const userId = env['GMAIL_USER'];

const labelsRes = await gmail.users.labels.list({ userId });
const utLabel = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === 'utilities');

const ids = [];
let pageToken;
do {
  const r = await gmail.users.messages.list({
    userId, labelIds: [utLabel.id], maxResults: 500,
    q: 'after:2026/5/1 before:2026/6/1 subject:"Spectrum Statement is Ready"',
    ...(pageToken ? { pageToken } : {}),
  });
  for (const m of r.data.messages || []) ids.push(m.id);
  pageToken = r.data.nextPageToken;
} while (pageToken);

const inDbR = await pool.query(`SELECT gmail_message_id FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`, [ids]);
const inDbIds = new Set(inDbR.rows.map(r => r.gmail_message_id));
const missing = ids.filter(id => !inDbIds.has(id));
console.log(`Emails a analizar: ${missing.length}\n`);

// Process each
const targets = [];
for (const id of missing) {
  const msg = await gmail.users.messages.get({ userId, id, format: 'full' });
  const headers = msg.data.payload?.headers || [];
  const dateStr = headers.find(h => h.name === 'Date')?.value || '';
  const date = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : null;
  const text = stripHtml(decodeBody(msg.data.payload));
  const ex = extract(text);
  targets.push({ id, date, ...ex });
}

// For each, check for overlaps
let overlapCount = 0;
console.log('Análisis por email:\n');
for (const t of targets) {
  const acct = t.last4 || '?';
  const amt = t.amount !== null ? `$${t.amount}` : 'no amt';
  console.log(`─── ${t.date}  ····${acct}  ${amt}  →  ${(t.addr || '').slice(0, 60)}`);

  // A) Overlap by account + amount + same month (May)
  const overlapAcctAmt = await pool.query(`
    SELECT id, amount_due, email_received_at, property_address, unit, gmail_message_id, email_subject
    FROM utility_bills
    WHERE utility_type = 'internet'
      AND account_last4 = $1
      AND ROUND(amount_due::numeric, 2) = ROUND($2::numeric, 2)
      AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
  `, [t.last4, t.amount]);

  if (overlapAcctAmt.rows.length > 0) {
    overlapCount++;
    console.log(`    🔴 SOLAPAMIENTO A — ya hay ${overlapAcctAmt.rows.length} bill(s) con esta cuenta+importe en mayo:`);
    for (const r of overlapAcctAmt.rows) {
      console.log(`       Bill #${r.id}  recv=${r.email_received_at?.toISOString().slice(0,10)}  $${r.amount_due}  ${r.property_address} #${r.unit || ''}  subj="${(r.email_subject || '').slice(0,40)}"`);
    }
  }

  // B) Overlap by property+unit (extract from addr)
  if (t.addr) {
    // Try to find property+unit by matching street prefix
    const streetMatch = t.addr.match(/^(.*?)\s+Apt\s+(\w+)/i);
    if (streetMatch) {
      const street = streetMatch[1].trim();
      const unit = streetMatch[2].trim();
      const overlapProp = await pool.query(`
        SELECT id, amount_due, email_received_at, property_address, unit, account_last4, gmail_message_id
        FROM utility_bills
        WHERE utility_type = 'internet'
          AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
          AND property_address ILIKE $1
          AND LOWER(COALESCE(unit, '')) = LOWER($2)
      `, [`${street}%`, unit]);

      if (overlapProp.rows.length > 0 && !overlapAcctAmt.rows.length) {
        overlapCount++;
        console.log(`    🟡 SOLAPAMIENTO B — esta propiedad+unit ya tiene internet en mayo (cuenta distinta):`);
        for (const r of overlapProp.rows) {
          console.log(`       Bill #${r.id}  recv=${r.email_received_at?.toISOString().slice(0,10)}  $${r.amount_due}  acct ····${r.account_last4}  "${r.property_address}" #${r.unit || ''}`);
        }
      }
    }
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  Resumen: ${overlapCount} de ${targets.length} con algún solapamiento`);
console.log(`           ${targets.length - overlapCount} entrarían limpio sin duplicar`);
console.log('═══════════════════════════════════════════════════════════');

await pool.end();

/**
 * Test the upgraded parser (Sonnet + LADWP exception + confidence) against
 * real emails WITHOUT writing anything to the database.
 *
 * Usage: node scripts/test-parser-sample.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const { parseEmail } = await import('../lib/parser.js');

const c = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
c.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: c });
const userId = process.env.GMAIL_USER;

function decodeBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/html' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.mimeType === 'text/plain' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.parts) { for (const p of part.parts) { const t = decodeBody(p); if (t) return t; } }
  return '';
}

async function fetchOne(q) {
  const r = await gmail.users.messages.list({ userId, q, maxResults: 1 });
  const id = r.data.messages?.[0]?.id;
  if (!id) return null;
  const full = await gmail.users.messages.get({ userId, id, format: 'full' });
  const h = full.data.payload?.headers || [];
  return {
    id,
    subject: h.find(x => x.name === 'Subject')?.value || '',
    from:    h.find(x => x.name === 'From')?.value || '',
    date:    h.find(x => x.name === 'Date')?.value || '',
    snippet: full.data.snippet || '',
    body:    decodeBody(full.data.payload),
    pdfsBase64: [], // these providers attach no PDFs (verified 2026-06-11)
  };
}

const CASES = [
  ['LADWP confirmación', 'from:ladwp.com subject:"Payment Received" newer_than:30d'],
  ['SCE Bill is Ready',  'from:sce@message.sce.com subject:"Bill is Ready" newer_than:30d'],
  ['SoCalGas available', 'from:socalgas.com subject:"now available" newer_than:60d'],
];

for (const [tag, q] of CASES) {
  console.log('═'.repeat(70));
  console.log(`CASO: ${tag}`);
  const email = await fetchOne(q);
  if (!email) { console.log('  (no se encontró email)'); continue; }
  console.log(`  Subject: ${email.subject}`);
  const parsed = await parseEmail(email);
  console.log('  Resultado del parser:', JSON.stringify(parsed, null, 2));
}

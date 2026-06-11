/**
 * Read the full body of specific Gmail messages so I can see what kind of
 * email it actually is — bill itself, or just a notification.
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

const c = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
c.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: c });
const userId = process.env.GMAIL_USER;

function decode(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.mimeType === 'text/html' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  if (part.parts) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data)
        return Buffer.from(p.body.data, 'base64url').toString('utf-8');
    }
    for (const p of part.parts) { const t = decode(p); if (t) return t; }
  }
  return '';
}

// IDs from previous audit: known "Your bill is ready" without amount
const IDs = [
  ['SoCalGas', '19d879e401dda469'],   // bill id=1484, $NULL, "Your bill from SoCalGas is now available"
  ['Spectrum', '19d730f7a6edef9f'],   // bill id=1523, $NULL, "Your Spectrum Statement is Ready"
  ['ConEd',    '19cdd07d9a00071c'],   // bill id=1835, $NULL, "Your Con Edison bill is ready"
];

for (const [tag, id] of IDs) {
  console.log('═'.repeat(80));
  console.log(`${tag} — gmail_message_id=${id}`);
  console.log('─'.repeat(80));
  try {
    const r = await gmail.users.messages.get({ userId, id, format: 'full' });
    const headers = r.data.payload?.headers || [];
    console.log('Subject:', headers.find(h => h.name === 'Subject')?.value || '');
    console.log('From:   ', headers.find(h => h.name === 'From')?.value || '');
    console.log('Date:   ', headers.find(h => h.name === 'Date')?.value || '');
    console.log('Snippet:', r.data.snippet);
    console.log('\nBody (first 2500 chars):');
    const body = decode(r.data.payload);
    console.log(body.slice(0, 2500));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log('');
}

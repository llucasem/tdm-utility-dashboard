/**
 * Quick check: how many Gmail "Utilities" emails received AFTER the last
 * Neon insertion (2026-05-14) are NOT in the database?
 *
 * If > 0 → cron is broken, real emails are accumulating.
 * If == 0 → no new emails arrived, cron has nothing to do (still suspect).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { google } from 'googleapis';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function getGmail() {
  const c = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  c.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: c });
}

async function main() {
  const gmail  = getGmail();
  const userId = process.env.GMAIL_USER;

  const labelsRes = await gmail.users.labels.list({ userId });
  const utLabel = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === 'utilities');

  // Search for emails since May 14 (last insertion day)
  const q = 'after:2026/5/14';
  const allIds = [];
  let pageToken;
  do {
    const r = await gmail.users.messages.list({
      userId, labelIds: [utLabel.id], maxResults: 500, q,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of r.data.messages || []) allIds.push(m.id);
    pageToken = r.data.nextPageToken;
  } while (pageToken);

  console.log(`Emails con label Utilities desde 2026-05-14: ${allIds.length}`);

  if (allIds.length === 0) {
    console.log('No hay emails nuevos. Cron no tiene nada que procesar.');
    await pool.end();
    return;
  }

  const known = await pool.query(
    `SELECT gmail_message_id FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`,
    [allIds]
  );
  const knownSet = new Set(known.rows.map(r => r.gmail_message_id));

  const missing = allIds.filter(id => !knownSet.has(id));
  console.log(`  → ya en Neon:   ${allIds.length - missing.length}`);
  console.log(`  → NO en Neon:   ${missing.length}`);

  if (missing.length === 0) {
    console.log('Todos los emails nuevos están en BD. Sync funciona, simplemente no había backlog real.');
    await pool.end();
    return;
  }

  // Fetch metadata for missing
  console.log('\nDetalle de los emails NO ingresados:');
  console.log('─'.repeat(80));
  for (let i = 0; i < missing.length; i += 8) {
    const chunk = missing.slice(i, i + 8);
    const batch = await Promise.all(chunk.map(async id => {
      const r = await gmail.users.messages.get({
        userId, id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const h = r.data.payload?.headers || [];
      return {
        id,
        subject: h.find(x => x.name === 'Subject')?.value || '(no subject)',
        from:    h.find(x => x.name === 'From')?.value || '(unknown)',
        date:    h.find(x => x.name === 'Date')?.value || null,
      };
    }));
    for (const m of batch) {
      const d = m.date ? new Date(m.date).toISOString().slice(0, 16).replace('T', ' ') : '?';
      console.log(`  ${d}  ${(m.subject || '').slice(0, 55).padEnd(55)}  ${(m.from || '').slice(0, 35)}`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

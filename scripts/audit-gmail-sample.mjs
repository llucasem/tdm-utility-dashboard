/**
 * Phase A.2 — Blind sample of Gmail "Utilities" label for last 30 days.
 *
 * Lists all messages, cross-checks against Neon utility_bills.gmail_message_id.
 * Reports:
 *   (a) emails in Gmail AND in Neon  → ingested (broken down by status)
 *   (b) emails in Gmail but NOT in Neon → likely skipped (or sync didn't run)
 *
 * Read-only. Fetches headers only (subject, from, date) — no bodies, no PDFs.
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

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function main() {
  const gmail  = getGmailClient();
  const userId = process.env.GMAIL_USER;
  console.log(`Conectando a Gmail como ${userId}…`);

  const labelsRes = await gmail.users.labels.list({ userId });
  const utLabel = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === 'utilities');
  if (!utLabel) throw new Error('Label "Utilities" not found.');

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const q = `after:${since.getUTCFullYear()}/${since.getUTCMonth() + 1}/${since.getUTCDate()}`;
  console.log(`Filtro: ${q} (últimos 30 días)`);

  const allIds = [];
  let pageToken;
  do {
    const r = await gmail.users.messages.list({
      userId,
      labelIds: [utLabel.id],
      maxResults: 500,
      q,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of r.data.messages || []) allIds.push(m.id);
    pageToken = r.data.nextPageToken;
  } while (pageToken);

  console.log(`Total emails con label Utilities en últimos 30 días: ${allIds.length}`);

  // Bulk fetch metadata (Subject + From + Date) for each id, in chunks
  const META_CONCURRENCY = 8;
  const meta = new Map();
  let done = 0;
  for (let i = 0; i < allIds.length; i += META_CONCURRENCY) {
    const chunk = allIds.slice(i, i + META_CONCURRENCY);
    const batch = await Promise.all(chunk.map(async id => {
      const r = await gmail.users.messages.get({
        userId, id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const headers = r.data.payload?.headers || [];
      return {
        id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from:    headers.find(h => h.name === 'From')?.value || '(unknown)',
        date:    headers.find(h => h.name === 'Date')?.value || null,
        snippet: r.data.snippet || '',
      };
    }));
    for (const m of batch) meta.set(m.id, m);
    done += chunk.length;
    if (done % 50 === 0 || done === allIds.length) {
      console.log(`  fetched ${done}/${allIds.length}`);
    }
  }

  // Cross-check against Neon
  const db = await pool.query(
    `SELECT gmail_message_id, amount_due, qb_match_status, qb_tag_status,
            email_subject, email_from
       FROM utility_bills
      WHERE gmail_message_id = ANY($1::text[])`,
    [allIds]
  );
  const inDb = new Map();
  for (const row of db.rows) inDb.set(row.gmail_message_id, row);

  // Classify
  const ingested = [];
  const notIngested = [];
  for (const id of allIds) {
    const m = meta.get(id);
    if (inDb.has(id)) {
      ingested.push({ ...m, ...inDb.get(id) });
    } else {
      notIngested.push(m);
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('RESUMEN');
  console.log('─'.repeat(80));
  console.log(`Total Gmail (Utilities, últimos 30d): ${allIds.length}`);
  console.log(`  → Ingresados en Neon:               ${ingested.length}`);
  console.log(`  → NO ingresados (filtrados o nuevos): ${notIngested.length}`);

  // Breakdown of ingested
  const counts = {};
  for (const e of ingested) {
    const key = `amount_due ${e.amount_due > 0 ? '> 0' : '≤ 0/NULL'} · status=${e.qb_match_status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log('\nDesglose ingresados:');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(50)} ${v}`);
  }

  // Top patterns of NOT ingested (these should be skipped-noise or unprocessed)
  console.log('\nTop subjects NO ingresados:');
  const bySubject = {};
  for (const m of notIngested) {
    const s = (m.subject || '').slice(0, 80);
    bySubject[s] = (bySubject[s] || 0) + 1;
  }
  const top = Object.entries(bySubject).sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [s, c] of top) {
    console.log(`  ${String(c).padStart(3)}  ${s}`);
  }

  console.log('\nTop senders NO ingresados:');
  const bySender = {};
  for (const m of notIngested) {
    const f = (m.from || '').slice(0, 70);
    bySender[f] = (bySender[f] || 0) + 1;
  }
  const tops = Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [s, c] of tops) {
    console.log(`  ${String(c).padStart(3)}  ${s}`);
  }

  // Save details to JSON for further analysis
  const out = {
    period_days: 30,
    total: allIds.length,
    ingested: ingested.length,
    not_ingested: notIngested.length,
    not_ingested_samples: notIngested.slice(0, 50).map(m => ({
      id: m.id,
      subject: m.subject,
      from: m.from,
      date: m.date,
      snippet: m.snippet?.slice(0, 200),
    })),
    ingested_samples: ingested.slice(0, 30).map(e => ({
      id: e.id,
      subject: e.email_subject,
      from: e.email_from,
      amount_due: e.amount_due,
      qb_match_status: e.qb_match_status,
      qb_tag_status: e.qb_tag_status,
    })),
  };
  const outPath = join(__dirname, '..', 'audit-gmail-sample-30d.json');
  const fs = await import('fs');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nDetalle volcado a: ${outPath}`);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

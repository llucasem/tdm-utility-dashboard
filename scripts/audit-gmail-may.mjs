/**
 * Audit: emails con label "Utilities" en mayo 2026 vs filas en utility_bills.
 *
 * Para cada email en Gmail con label Utilities desde 2026-05-01:
 *   - ¿Está en utility_bills (gmail_message_id)?
 *     - Sí, con amount > 0   → factura real procesada
 *     - Sí, con amount <= 0  → procesado como ruido (confirmación, OTP, etc.)
 *     - No                   → NO ingresado (cron lo saltó o falló)
 *
 * Read-only. Guarda detalle en audit-gmail-may-2026.json.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
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
  console.log(`Conectando a Gmail como ${userId}...\n`);

  const labelsRes = await gmail.users.labels.list({ userId });
  const utLabel = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === 'utilities');
  if (!utLabel) throw new Error('Label "Utilities" not found.');

  const q = 'after:2026/5/1 before:2026/6/1';
  console.log(`Filtro Gmail: ${q}`);

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

  console.log(`Emails Gmail (Utilities, mayo 2026): ${allIds.length}\n`);

  // Fetch metadata for all
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
      const h = r.data.payload?.headers || [];
      return {
        id,
        subject: h.find(x => x.name === 'Subject')?.value || '(no subject)',
        from:    h.find(x => x.name === 'From')?.value || '(unknown)',
        date:    h.find(x => x.name === 'Date')?.value || null,
        snippet: r.data.snippet || '',
      };
    }));
    for (const m of batch) meta.set(m.id, m);
    done += chunk.length;
    if (done % 50 === 0 || done === allIds.length) {
      console.log(`  metadata fetched ${done}/${allIds.length}`);
    }
  }

  // Cross-check against Neon
  const db = await pool.query(
    `SELECT gmail_message_id, amount_due, qb_match_status, qb_tag_status,
            email_subject, email_from, utility_type, property_address, unit
       FROM utility_bills
      WHERE gmail_message_id = ANY($1::text[])`,
    [allIds]
  );
  const inDb = new Map();
  for (const row of db.rows) inDb.set(row.gmail_message_id, row);

  // Classify each Gmail email
  const realBills = [];     // in DB, amount > 0
  const filteredNoise = []; // in DB, amount <= 0 or NULL
  const missing = [];       // not in DB

  for (const id of allIds) {
    const m = meta.get(id);
    const dbRow = inDb.get(id);
    if (!dbRow) {
      missing.push(m);
    } else if (Number(dbRow.amount_due) > 0) {
      realBills.push({ ...m, ...dbRow });
    } else {
      filteredNoise.push({ ...m, ...dbRow });
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('RESUMEN — Mayo 2026');
  console.log('='.repeat(80));
  console.log(`Emails Gmail (Utilities):        ${allIds.length}`);
  console.log(`  ✓ Facturas reales en DB:       ${realBills.length}`);
  console.log(`  · Procesado como ruido:        ${filteredNoise.length}`);
  console.log(`  ✗ NO ingresado en DB:          ${missing.length}`);

  // Breakdown of real bills by match/tag status
  if (realBills.length > 0) {
    console.log('\nFacturas reales — estado en QuickBooks:');
    const tagCounts = {};
    for (const b of realBills) {
      const k = `match=${b.qb_match_status || 'null'} · tag=${b.qb_tag_status || 'null'}`;
      tagCounts[k] = (tagCounts[k] || 0) + 1;
    }
    for (const [k, v] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(50)} ${v}`);
    }
  }

  // Top subjects of missing
  if (missing.length > 0) {
    console.log('\nTop subjects NO ingresados:');
    const bySubject = {};
    for (const m of missing) {
      const s = (m.subject || '').slice(0, 70);
      bySubject[s] = (bySubject[s] || 0) + 1;
    }
    const top = Object.entries(bySubject).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [s, c] of top) {
      console.log(`  ${String(c).padStart(3)}  ${s}`);
    }

    console.log('\nTop senders NO ingresados:');
    const bySender = {};
    for (const m of missing) {
      const f = (m.from || '').slice(0, 60);
      bySender[f] = (bySender[f] || 0) + 1;
    }
    const tops = Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [s, c] of tops) {
      console.log(`  ${String(c).padStart(3)}  ${s}`);
    }
  }

  // Dump detail to JSON
  const out = {
    audited_at: new Date().toISOString(),
    period: { since: '2026-05-01', until: '2026-05-31' },
    totals: {
      gmail_total: allIds.length,
      real_bills: realBills.length,
      filtered_noise: filteredNoise.length,
      missing: missing.length,
    },
    missing: missing.map(m => ({
      id: m.id,
      date: m.date,
      subject: m.subject,
      from: m.from,
      snippet: (m.snippet || '').slice(0, 200),
    })),
    real_bills: realBills.map(b => ({
      id: b.id,
      date: b.date,
      subject: b.subject,
      from: b.from,
      utility_type: b.utility_type,
      amount_due: b.amount_due,
      property: b.property_address,
      unit: b.unit,
      qb_match_status: b.qb_match_status,
      qb_tag_status: b.qb_tag_status,
    })),
  };
  const outPath = join(__dirname, '..', 'audit-gmail-may-2026.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nDetalle volcado a: ${outPath}`);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

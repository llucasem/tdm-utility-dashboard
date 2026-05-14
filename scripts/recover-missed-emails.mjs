/**
 * Recovery sync — pulls only emails NOT yet in the DB.
 *
 * Use this when the daily cron hasn't been running and a backlog has built up.
 * Unlike scripts/run-sync.mjs, this skips emails already in utility_bills
 * BEFORE calling Gmail/Claude, so it's fast and doesn't waste tokens.
 *
 * Run with:  node scripts/recover-missed-emails.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ai   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are a utility bill data extractor for The Dream Management LLC. Extract fields from a utility bill email or PDF and return ONLY a valid JSON object.

Fields:
- utility_type: one of "electricity", "internet", "gas", "water", "rent", "insurance", "other"
- property_address: full service address if mentioned, otherwise partial street/building name, otherwise null. NEVER the utility company's HQ address.
- unit: apartment/unit number if present (e.g. "Apt 4B"), otherwise null
- account_last4: last 4-5 digits of the account number, otherwise null
- amount_due: numeric amount to pay (no currency symbol), or null
- due_date: ISO YYYY-MM-DD or null

Return ONLY the JSON, no markdown.`;

function decodeBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.mimeType === 'text/html'  && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.parts) for (const p of part.parts) { const t = decodeBody(p); if (t) return t; }
  return '';
}
function findPdf(part) {
  if (!part) return null;
  if (part.mimeType === 'application/pdf' && part.body?.attachmentId) return { filename: part.filename, attachmentId: part.body.attachmentId };
  if (part.parts) for (const p of part.parts) { const r = findPdf(p); if (r) return r; }
  return null;
}

async function parseEmail(email) {
  const pdfSmall = email.pdfBase64 && email.pdfBase64.length < 200000;
  const content = pdfSmall
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: email.pdfBase64 } },
        { type: 'text',     text: `Subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}` },
      ]
    : [{ type: 'text', text: `Subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\n${email.body || email.snippet}` }];

  const res  = await ai.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, system: SYSTEM, messages: [{ role: 'user', content }] });
  const text = res.content[0]?.text || '';
  try { return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
  catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────
const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail  = google.gmail({ version: 'v1', auth: oauth2 });
const userId = process.env.GMAIL_USER;

// Default to May 2026 — pass a YYYY/MM/DD as 1st arg to override
const SINCE = process.argv[2] || '2026/05/01';
console.log(`\n🔍 Listing Utilities emails since ${SINCE}...`);
const labels = (await gmail.users.labels.list({ userId })).data.labels || [];
const utLbl  = labels.find(l => l.name.toLowerCase() === 'utilities');
if (!utLbl) { console.error('No Utilities label'); process.exit(1); }

const allMessages = [];
let pageToken;
do {
  const r = await gmail.users.messages.list({
    userId, labelIds: [utLbl.id], maxResults: 500, q: `after:${SINCE}`,
    ...(pageToken ? { pageToken } : {}),
  });
  allMessages.push(...(r.data.messages || []));
  pageToken = r.data.nextPageToken;
} while (pageToken);
console.log(`  Found ${allMessages.length} emails in Gmail`);

// Filter out the ones already in DB
const existing = await pool.query(
  `SELECT gmail_message_id FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`,
  [allMessages.map(m => m.id)]
);
const known = new Set(existing.rows.map(r => r.gmail_message_id));
const todo  = allMessages.filter(m => !known.has(m.id));
console.log(`  ${known.size} already in DB, ${todo.length} NEW to process\n`);

if (todo.length === 0) {
  console.log('✅ Nothing to recover.');
  await pool.end();
  process.exit(0);
}

const SKIP_SUBJECTS = [
  'automatic monthly payment is scheduled',
  'thanks for paying your con edison bill',
  'thank you for your payment',
];

let saved = 0, skipped = 0, errors = 0;
const newBillIds = [];

for (let i = 0; i < todo.length; i++) {
  const { id } = todo[i];
  process.stdout.write(`\r⏳ ${i + 1}/${todo.length}  saved=${saved} skip=${skipped} err=${errors}`);

  let email;
  try {
    const msg     = (await gmail.users.messages.get({ userId, id, format: 'full' })).data;
    const headers = msg.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from    = headers.find(h => h.name === 'From')?.value    || '';
    const dateStr = headers.find(h => h.name === 'Date')?.value    || '';
    const body    = decodeBody(msg.payload);
    const pdfRef  = findPdf(msg.payload);
    let pdfBase64 = null;
    if (pdfRef) {
      const att = await gmail.users.messages.attachments.get({ userId, messageId: id, id: pdfRef.attachmentId });
      pdfBase64 = att.data.data?.replace(/-/g, '+').replace(/_/g, '/') || null;
    }
    email = { id, subject, from, date: dateStr ? new Date(dateStr).toISOString() : null, snippet: msg.snippet || '', body, pdfBase64 };
  } catch (e) { errors++; continue; }

  if (SKIP_SUBJECTS.some(s => email.subject.toLowerCase().includes(s))) { skipped++; continue; }

  let parsed;
  try { parsed = await parseEmail(email); }
  catch (e) {
    if (e.message?.includes('429')) await new Promise(r => setTimeout(r, 60000));
    errors++; continue;
  }
  if (!parsed) { errors++; continue; }
  if (!parsed.amount_due || parseFloat(parsed.amount_due) <= 0) { skipped++; continue; }

  // Apply account-mapping if we have one
  let addr = parsed.property_address, unit = parsed.unit;
  if (!addr && parsed.account_last4 && parsed.utility_type) {
    const mp = await pool.query(
      `SELECT property_address, unit FROM account_mappings WHERE utility_type = $1 AND account_last4 = $2 LIMIT 1`,
      [parsed.utility_type, parsed.account_last4]
    );
    if (mp.rowCount > 0) { addr = mp.rows[0].property_address; unit = unit || mp.rows[0].unit; }
  }

  try {
    const res = await pool.query(
      `INSERT INTO utility_bills (gmail_message_id, utility_type, property_address, unit, account_last4, amount_due, due_date, email_received_at, email_subject, email_from, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') ON CONFLICT (gmail_message_id) DO NOTHING RETURNING id`,
      [id, parsed.utility_type || 'other', addr, unit, parsed.account_last4 || null, parsed.amount_due, parsed.due_date || null, email.date, email.subject, email.from || null]
    );
    if (res.rowCount === 0) skipped++;
    else { saved++; newBillIds.push(res.rows[0].id); }
  } catch (e) { errors++; }

  await new Promise(r => setTimeout(r, 500));
}

console.log(`\n\n✅ Recovery complete:`);
console.log(`   Saved:    ${saved} new bills`);
console.log(`   Skipped:  ${skipped} (no amount or duplicate)`);
console.log(`   Errors:   ${errors}`);

// ── Now match the new bills against QuickBooks ────────────────────────────
if (newBillIds.length > 0) {
  console.log(`\n☁  Cotejando ${newBillIds.length} facturas contra QuickBooks...`);

  // Refresh QB token if needed
  const tokR = await pool.query(
    `SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`
  );
  let tok = tokR.rows[0];
  if (new Date(tok.expires_at).getTime() - Date.now() < 5 * 60_000) {
    const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }),
    });
    const t = await r.json();
    const expiresAt = new Date(Date.now() + t.expires_in * 1000);
    await pool.query(
      `UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
      [t.access_token, t.refresh_token, expiresAt, tok.realm_id]
    );
    tok = { ...tok, access_token: t.access_token };
  }

  const QB_BASE = 'https://quickbooks.api.intuit.com';
  async function qbQuery(sql) {
    const url = `${QB_BASE}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`QB ${r.status}`);
    return r.json();
  }

  function shiftDate(iso, days) {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  const billsR = await pool.query(
    `SELECT id, amount_due, due_date, email_received_at FROM utility_bills WHERE id = ANY($1::int[])`,
    [newBillIds]
  );

  let matched = 0, ambiguous = 0, notFound = 0, errored = 0;
  for (let i = 0; i < billsR.rows.length; i++) {
    const b = billsR.rows[i];
    process.stdout.write(`\r  ⏳ ${i + 1}/${billsR.rowCount}  matched=${matched} ambig=${ambiguous} notfound=${notFound}`);
    try {
      const anchor   = b.due_date || b.email_received_at;
      const anchorIso = anchor instanceof Date ? anchor.toISOString().slice(0,10) : String(anchor).slice(0,10);
      const dateFrom = shiftDate(anchorIso, -15);
      const dateTo   = shiftDate(anchorIso, 15);
      const amt = Number(b.amount_due).toFixed(2);
      const where = `WHERE TotalAmt = '${amt}' AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;

      const [p, bp] = await Promise.all([
        qbQuery(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef, PrivateNote, DocNumber FROM Purchase ${where}`).catch(() => null),
        qbQuery(`SELECT Id, TxnDate, TotalAmt, VendorRef, PrivateNote, DocNumber FROM BillPayment ${where}`).catch(() => null),
      ]);

      const matches = [];
      for (const x of p?.QueryResponse?.Purchase || []) {
        matches.push({ type: 'Purchase', id: x.Id, date: x.TxnDate, amount: Number(x.TotalAmt), payee: x.EntityRef?.name || null, account: x.AccountRef?.name || null, docNumber: x.DocNumber || null, note: x.PrivateNote || null });
      }
      for (const x of bp?.QueryResponse?.BillPayment || []) {
        matches.push({ type: 'BillPayment', id: x.Id, date: x.TxnDate, amount: Number(x.TotalAmt), payee: x.VendorRef?.name || null, account: null, docNumber: x.DocNumber || null, note: x.PrivateNote || null });
      }

      let status;
      if (matches.length === 0)      status = 'not_found';
      else if (matches.length === 1) status = 'matched';
      else                            status = 'ambiguous';
      const stored = matches.slice(0, 20);

      await pool.query(
        `UPDATE utility_bills SET qb_match_status=$2, qb_match_count=$3, qb_match_data=$4, qb_matched_at=NOW() WHERE id=$1`,
        [b.id, status, matches.length, JSON.stringify(stored)]
      );

      if (status === 'matched')        matched++;
      else if (status === 'ambiguous') ambiguous++;
      else                              notFound++;
    } catch (e) {
      errored++;
      await pool.query(
        `UPDATE utility_bills SET qb_match_status='error', qb_match_error=$2, qb_matched_at=NOW() WHERE id=$1`,
        [b.id, e.message]
      );
    }
  }

  console.log(`\n\n📊  RESULTADO MATCH EN QUICKBOOKS:`);
  console.log(`     ✓ matched    ${matched}  (1 Purchase exacto encontrado)`);
  console.log(`     ⚠ ambiguous  ${ambiguous}  (varias Purchases con mismo importe)`);
  console.log(`     ✗ not_found  ${notFound}  (ningún Purchase con ese importe)`);
  if (errored > 0) console.log(`     ! errors     ${errored}`);
}

await pool.end();

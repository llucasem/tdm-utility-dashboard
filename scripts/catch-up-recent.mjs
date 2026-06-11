/**
 * Surgical catch-up sync: process ONLY emails received after a given date
 * that are not yet in Neon, applying the FULL noise filter from
 * app/api/sync/route.js (21 SKIP_SUBJECTS + SKIP_SENDERS) and the post-parse
 * amount_due > 0 guardrail.
 *
 * Run with: node scripts/catch-up-recent.mjs [yyyy/mm/dd]
 *           default: 2026/5/14
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

const SINCE = process.argv[2] || '2026/5/14';

// ── Filters copied verbatim from app/api/sync/route.js ─────────────────────────
const SKIP_SUBJECTS = [
  'automatic monthly payment is scheduled',
  'your payment is scheduled',
  'thanks for paying your con edison bill',
  'thank you for your payment',
  "we've received your payment",
  'payment received (confirmation)',
  'order confirmation',
  'automatic payment declined',
  'autopay was successful',
  'autopay payment',
  'your opinion matters',
  'values your feedback',
  'annual survey',
  'get internet speed',
  'get a connection that keeps up',
  'enhance your connection',
  'entertainment that moves',
  'california climate credit timing update',
];
const SKIP_SENDERS = [
  'spectrum customer experience team',
  'spectrum@exchange.spectrum',
];

// ── Parser prompt (verbatim from lib/parser.js) ────────────────────────────────
const SYSTEM_PROMPT = `You are a utility bill data extractor for a short-term rental property management company called The Dream Management LLC. They manage ~67 short-term rental properties.

Extract fields from utility bill emails and return ONLY a valid JSON object.

Fields to extract:
- utility_type: one of "electricity", "internet", "gas", "water", "rent", "insurance", "other"
- property_address: the best property identifier you can find. Try in this order:
    1. Full service address (e.g. "4750 Lincoln Blvd, Marina Del Rey, CA 90292") — ideal
    2. Partial address or street name only (e.g. "Genoa", "Lincoln Blvd", "Palm Canyon Dr") — if no full address
    3. Property name or building name (e.g. "The Palms", "Sunset Building") — if no address at all
    4. null — only if there is truly NO property reference anywhere in the email
  IMPORTANT: Do NOT return the utility company's address (e.g. ConEd HQ, SCE office). Only return an address or name that refers to the rental property receiving the service.
- unit: apartment/unit number if present (e.g. "Apt 4B", "Unit 102"), otherwise null
- account_last4: last 5 digits of the account or service number (e.g. from "Account XXXXXXX88108" extract "88108"), otherwise null
- amount_due: numeric amount to pay (just the number, no currency symbol), or null
- due_date: due date in ISO format YYYY-MM-DD, or null

Return ONLY the JSON object, no markdown, no explanation.`;

function decodeBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.mimeType === 'text/html' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  if (part.parts) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data)
        return Buffer.from(p.body.data, 'base64url').toString('utf-8');
    }
    for (const p of part.parts) { const t = decodeBody(p); if (t) return t; }
  }
  return '';
}

function findPdf(part) {
  if (!part) return null;
  if (part.mimeType === 'application/pdf' && part.body?.attachmentId)
    return { filename: part.filename, attachmentId: part.body.attachmentId };
  if (part.parts) { for (const p of part.parts) { const r = findPdf(p); if (r) return r; } }
  return null;
}

async function parseEmail(email) {
  let content;
  const pdfIsSmall = email.pdfBase64 && email.pdfBase64.length < 200000;
  if (pdfIsSmall) {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: email.pdfBase64 } },
      { type: 'text', text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nExtract the utility bill data from the attached PDF.` },
    ];
  } else {
    content = [{ type: 'text', text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nEmail body:\n${email.body || email.snippet}` }];
  }
  const res = await ai.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  const text = res.content[0]?.text || '';
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
function getGmail() {
  const c = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  c.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: c });
}

const gmail  = getGmail();
const userId = process.env.GMAIL_USER;

console.log(`🔍 Buscando emails con label "Utilities" desde ${SINCE}…`);
const labelsRes = await gmail.users.labels.list({ userId });
const utLabel = labelsRes.data.labels?.find(l => l.name.toLowerCase() === 'utilities');
if (!utLabel) { console.error('❌ Label "Utilities" no encontrado'); process.exit(1); }

const allIds = [];
let pageToken;
do {
  const r = await gmail.users.messages.list({
    userId, labelIds: [utLabel.id], maxResults: 500,
    q: `after:${SINCE}`,
    ...(pageToken ? { pageToken } : {}),
  });
  for (const m of r.data.messages || []) allIds.push(m.id);
  pageToken = r.data.nextPageToken;
} while (pageToken);
console.log(`📨 Encontrados ${allIds.length} emails en Gmail.`);

if (allIds.length === 0) {
  console.log('Nada que procesar.');
  await pool.end();
  process.exit(0);
}

// Filter against DB
const known = await pool.query(
  `SELECT gmail_message_id FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`,
  [allIds]
);
const knownSet = new Set(known.rows.map(r => r.gmail_message_id));
const newIds = allIds.filter(id => !knownSet.has(id));
console.log(`   → ya en Neon: ${allIds.length - newIds.length}`);
console.log(`   → a procesar:  ${newIds.length}\n`);

if (newIds.length === 0) {
  console.log('Todos ya están en BD.');
  await pool.end();
  process.exit(0);
}

const stats = { saved: 0, skipped_noise: 0, skipped_no_amount: 0, errors: 0, parser_failed: 0 };

for (let i = 0; i < newIds.length; i++) {
  const id = newIds[i];
  process.stdout.write(`\r⏳ ${i + 1}/${newIds.length} | saved=${stats.saved} noise=${stats.skipped_noise} no_amount=${stats.skipped_no_amount} errors=${stats.errors}    `);

  // 1. Fetch full email
  let email;
  try {
    const msgRes = await gmail.users.messages.get({ userId, id, format: 'full' });
    const headers = msgRes.data.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from    = headers.find(h => h.name === 'From')?.value || '';
    const dateStr = headers.find(h => h.name === 'Date')?.value || '';
    const body    = decodeBody(msgRes.data.payload);
    const pdfRef  = findPdf(msgRes.data.payload);
    let pdfBase64 = null;
    if (pdfRef) {
      const att = await gmail.users.messages.attachments.get({ userId, messageId: id, id: pdfRef.attachmentId });
      pdfBase64 = att.data.data?.replace(/-/g, '+').replace(/_/g, '/') || null;
    }
    email = { id, subject, from, date: dateStr ? new Date(dateStr).toISOString() : null, snippet: msgRes.data.snippet || '', body, pdfBase64 };
  } catch (e) {
    stats.errors++;
    continue;
  }

  // 2. Apply FULL noise filter (before burning Claude tokens)
  const subjectLower = (email.subject || '').toLowerCase();
  const fromLower    = (email.from || '').toLowerCase();
  if (SKIP_SUBJECTS.some(s => subjectLower.includes(s)) || SKIP_SENDERS.some(s => fromLower.includes(s))) {
    stats.skipped_noise++;
    continue;
  }

  // 3. Parse with Claude
  let parsed;
  try {
    parsed = await parseEmail(email);
  } catch (e) {
    if (e.message?.includes('429')) await new Promise(r => setTimeout(r, 60000));
    stats.errors++;
    continue;
  }
  if (!parsed) {
    stats.parser_failed++;
    continue;
  }

  // 4. Post-parse guardrail: drop if no payable amount
  if (!parsed.amount_due || parseFloat(parsed.amount_due) <= 0) {
    stats.skipped_no_amount++;
    continue;
  }

  // 5. Apply account_mappings fallback if no address
  let finalAddress = parsed.property_address || null;
  let finalUnit    = parsed.unit || null;
  if (!finalAddress && parsed.account_last4 && parsed.utility_type) {
    const mr = await pool.query(
      `SELECT property_address, unit FROM account_mappings
       WHERE utility_type = $1 AND account_last4 = $2 LIMIT 1`,
      [parsed.utility_type, parsed.account_last4]
    );
    if (mr.rows.length > 0) {
      finalAddress = mr.rows[0].property_address;
      finalUnit    = finalUnit || mr.rows[0].unit;
    }
  }

  // 6. Insert
  try {
    const res = await pool.query(
      `INSERT INTO utility_bills
         (gmail_message_id, utility_type, property_address, unit, account_last4,
          amount_due, due_date, email_received_at, email_subject, email_from, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING id`,
      [
        id,
        parsed.utility_type || 'other',
        finalAddress,
        finalUnit,
        parsed.account_last4 || null,
        parsed.amount_due,
        parsed.due_date || null,
        email.date,
        email.subject,
        email.from || null,
      ]
    );
    if (res.rowCount > 0) stats.saved++;
  } catch (e) {
    stats.errors++;
  }

  await new Promise(r => setTimeout(r, 1500));
}

console.log('\n\n✅ Catch-up completo:');
console.log(`   Saved (factura real con importe): ${stats.saved}`);
console.log(`   Skipped por filtro de ruido:       ${stats.skipped_noise}`);
console.log(`   Skipped sin importe (notif.):      ${stats.skipped_no_amount}`);
console.log(`   Parser falló:                      ${stats.parser_failed}`);
console.log(`   Errors (Gmail/DB):                 ${stats.errors}`);

await pool.end();

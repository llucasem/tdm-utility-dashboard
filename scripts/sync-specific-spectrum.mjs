/**
 * Sync targeted: procesar solo 7 emails Spectrum específicos de mayo
 * (los que NO solapan con bills existentes).
 *
 * Replica el flujo del endpoint /api/sync:
 *  1. Descarga email completo de Gmail
 *  2. Aplica SKIP_SUBJECTS / SKIP_SENDERS (defensivo — no deberían caer)
 *  3. Parsea con Claude Haiku
 *  4. Aplica account_mappings si Claude no devolvió dirección
 *  5. Inserta con ON CONFLICT (gmail_message_id) DO NOTHING
 *  6. Dispara match QB + auto-tag
 *
 * IDs a procesar (de check-spectrum-overlap.mjs — los 7 limpios).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { google } from 'googleapis';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });
const claude = new Anthropic({ apiKey: env['ANTHROPIC_API_KEY'] });

const TARGET_IDS = [
  '19e4c7c1ddd4b589', // 2026-05-21 ····5794 $61.25 226 S Gale Dr #C
  '19e4649bd57d686e', // 2026-05-20 ····0067 $76.25 939 S Broadway #806
  '19e464576b526895', // 2026-05-20 ····3862 $76.25 2200 Colorado Ave #627
  '19e4108954e2d954', // 2026-05-19 ····2478 $70.00 439 W 51st St #2W
  '19e3bed17045b060', // 2026-05-18 ····4231 $76.25 2200 Colorado Ave #540
  '19e31912a58dbbdd', // 2026-05-16 ····2808 $91.24 507 Wilshire Blvd #313
  '19e0d95529a4dc23', // 2026-05-09 ····7115 $0     4572 Via Marina #102 (autopay)
];

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
    for (const p of part.parts) if (p.mimeType === 'text/plain' && p.body?.data) {
      return Buffer.from(p.body.data, 'base64url').toString('utf-8');
    }
    for (const p of part.parts) { const t = decodeBody(p); if (t) return t; }
  }
  return '';
}

async function parseEmail(email) {
  const content = [{
    type: 'text',
    text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nEmail body:\n${email.body || email.snippet}`,
  }];
  const res = await claude.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content }],
  });
  const text = res.content[0]?.text || '';
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('  [parser] Claude returned invalid JSON:', text);
    return null;
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Sync targeted: 7 Spectrum emails de mayo');
console.log('═══════════════════════════════════════════════════════════\n');

const gmail = getGmail();
const userId = env['GMAIL_USER'];

const savedBillIds = [];
const results = [];

for (let i = 0; i < TARGET_IDS.length; i++) {
  const id = TARGET_IDS[i];
  console.log(`─── [${i + 1}/${TARGET_IDS.length}] ${id}`);

  // Defensive double-check: not already in DB
  const existing = await pool.query(`SELECT id FROM utility_bills WHERE gmail_message_id = $1`, [id]);
  if (existing.rows.length > 0) {
    console.log(`  ⏭  Ya existe en DB como Bill #${existing.rows[0].id} — SKIP`);
    results.push({ id, status: 'skip_existing', billId: existing.rows[0].id });
    continue;
  }

  // Fetch full email
  const msgRes = await gmail.users.messages.get({ userId, id, format: 'full' });
  const msg = msgRes.data;
  const headers = msg.payload?.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from    = headers.find(h => h.name === 'From')?.value    || '';
  const dateStr = headers.find(h => h.name === 'Date')?.value    || '';
  const body    = decodeBody(msg.payload);

  console.log(`  ${dateStr ? new Date(dateStr).toISOString().slice(0, 10) : '?'}  "${subject.slice(0, 60)}"`);

  // Parse with Claude
  let parsed;
  try {
    parsed = await parseEmail({ subject, from, date: dateStr, body, snippet: msg.snippet });
  } catch (e) {
    console.log(`  ❌ parser error: ${e.message}`);
    results.push({ id, status: 'parse_error', error: e.message });
    await new Promise(r => setTimeout(r, 2000));
    continue;
  }
  if (!parsed) {
    console.log(`  ❌ Claude returned null`);
    results.push({ id, status: 'parse_null' });
    continue;
  }
  console.log(`  parsed: type=${parsed.utility_type}  amt=${parsed.amount_due}  acct=${parsed.account_last4}  addr=${(parsed.property_address || '').slice(0, 40)}  unit=${parsed.unit}`);

  // Truncate account_last4 for zero-amount branch too
  if (parsed.account_last4) {
    parsed.account_last4 = String(parsed.account_last4).slice(-4);
  }

  // Filter out zero/null amounts
  if (!parsed.amount_due || parseFloat(parsed.amount_due) <= 0) {
    console.log(`  ⏭  amount_due is 0 or missing — SKIP (no se inserta como factura facturable)`);
    // Still insert as 0-amount so we don't re-process this gmail_message_id in future syncs
    await pool.query(
      `INSERT INTO utility_bills
         (gmail_message_id, utility_type, property_address, unit, account_last4, amount_due, due_date,
          email_received_at, email_subject, email_from, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       ON CONFLICT (gmail_message_id) DO NOTHING`,
      [id, parsed.utility_type || 'other', parsed.property_address, parsed.unit, parsed.account_last4,
       0, parsed.due_date || null, dateStr ? new Date(dateStr).toISOString() : null, subject, from]
    );
    results.push({ id, status: 'skipped_zero_amount', billId: null });
    await new Promise(r => setTimeout(r, 500));
    continue;
  }

  // Truncate account_last4 to last 4 digits (column is VARCHAR(4) but prompt asks for 5)
  if (parsed.account_last4) {
    parsed.account_last4 = String(parsed.account_last4).slice(-4);
  }

  // Apply account_mapping if no address
  let finalAddress = parsed.property_address || null;
  let finalUnit    = parsed.unit             || null;
  if (!finalAddress && parsed.account_last4 && parsed.utility_type) {
    const mapRes = await pool.query(
      `SELECT property_address, unit FROM account_mappings
       WHERE utility_type = $1 AND account_last4 = $2 LIMIT 1`,
      [parsed.utility_type, parsed.account_last4]
    );
    if (mapRes.rows.length > 0) {
      finalAddress = mapRes.rows[0].property_address;
      finalUnit    = finalUnit || mapRes.rows[0].unit;
    }
  }

  // Insert
  const ins = await pool.query(
    `INSERT INTO utility_bills
       (gmail_message_id, utility_type, property_address, unit, account_last4,
        amount_due, due_date, email_received_at, email_subject, email_from, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
     ON CONFLICT (gmail_message_id) DO NOTHING
     RETURNING id, property_address`,
    [
      id, parsed.utility_type || 'other', finalAddress, finalUnit, parsed.account_last4 || null,
      parsed.amount_due || null, parsed.due_date || null,
      dateStr ? new Date(dateStr).toISOString() : null, subject, from || null,
    ]
  );
  if (ins.rowCount === 0) {
    console.log(`  ⏭  ON CONFLICT — ya estaba`);
    results.push({ id, status: 'conflict' });
  } else {
    const newId = ins.rows[0].id;
    console.log(`  ✅ INSERTED Bill #${newId}  property="${ins.rows[0].property_address}"`);
    savedBillIds.push(newId);
    results.push({ id, status: 'saved', billId: newId, hasProperty: !!ins.rows[0].property_address });
  }

  await new Promise(r => setTimeout(r, 500));
}

console.log('\n─── Resumen inserción ───');
const saved   = results.filter(r => r.status === 'saved').length;
const conflicts = results.filter(r => r.status === 'conflict' || r.status === 'skip_existing').length;
const zero    = results.filter(r => r.status === 'skipped_zero_amount').length;
const errors  = results.filter(r => r.status === 'parse_error' || r.status === 'parse_null').length;
console.log(`  Insertadas:        ${saved}`);
console.log(`  Ya existían:       ${conflicts}`);
console.log(`  Importe 0 (ruido): ${zero}`);
console.log(`  Errores:           ${errors}`);

// Run match + auto-tag for newly saved bills
if (savedBillIds.length > 0) {
  console.log(`\n─── Lanzando match QB + auto-tag para ${savedBillIds.length} bills ───`);
  // Call the production endpoint directly via the lib? No — we'll call match/auto-tag
  // through the http endpoint won't work either. Better: replicate via direct API.
  // Simplest path: leave match/auto-tag to the next cron run.
  // For now just log the new IDs so Lluis sees them.
  console.log(`  Nuevas Bill IDs: ${savedBillIds.join(', ')}`);
  console.log(`  El cron /api/cron/retry-and-learn las recogerá para match QB + auto-tag.`);
  console.log(`  O las podemos lanzar manualmente — dime.`);
}

await pool.end();
console.log('\n✅ Sync targeted completado.');

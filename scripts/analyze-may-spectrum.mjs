/**
 * Analiza las 14 facturas "Spectrum Statement is Ready" no ingresadas en mayo.
 *
 * Para cada email:
 *   1. Descarga el HTML completo
 *   2. Extrae amount due, service address, account last4
 *   3. Compara contra account_mappings + utility_bills históricas para sugerir match
 *
 * READ-ONLY. NO TOCA la DB.
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
    // Prefer text/html for Spectrum
    for (const p of part.parts) if (p.mimeType === 'text/html' && p.body?.data) {
      return Buffer.from(p.body.data, 'base64url').toString('utf-8');
    }
    for (const p of part.parts) {
      const t = decodeBody(p);
      if (t) return t;
    }
  }
  return '';
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFromSpectrum(text, htmlRaw) {
  // Amount due — Spectrum patterns
  const amtPatterns = [
    /(?:Amount Due|Total Due|Balance Due|Total Amount Due|Amount of Statement)[:\s]*\$\s*([0-9,]+\.[0-9]{2})/i,
    /\$\s*([0-9,]+\.[0-9]{2})\s*(?:due|Amount Due|Balance)/i,
    /(?:Statement Amount|Current Charges|New Charges)[:\s]*\$\s*([0-9,]+\.[0-9]{2})/i,
  ];
  let amount = null;
  for (const p of amtPatterns) {
    const m = text.match(p);
    if (m) { amount = parseFloat(m[1].replace(/,/g, '')); break; }
  }
  // Fallback: any "$X.XX" near "due" or "amount"
  if (amount === null) {
    const m = text.match(/\$\s*([0-9,]+\.[0-9]{2})/);
    if (m) amount = parseFloat(m[1].replace(/,/g, ''));
  }

  // Service address — Spectrum often shows "Service Address" or address near top
  let addr = null;
  const addrPatterns = [
    /Service Address[:\s]*([^\n]+?)(?:Account|Statement|Date|$)/i,
    /Service at[:\s]*([^\n]+?)(?:Account|Statement|Date|$)/i,
  ];
  for (const p of addrPatterns) {
    const m = text.match(p);
    if (m) { addr = m[1].trim().replace(/\s+,/g, ',').slice(0, 100); break; }
  }

  // Account number (last 4)
  let last4 = null;
  const acctPatterns = [
    /Account(?:\s+(?:Number|#))?[:\s]+\*+\s*(\d{4})/i,
    /Account[:\s]+x+(\d{4})/i,
    /Account[:\s]+\d*[*x](\d{4})/i,
    /ending in\s*(\d{4})/i,
  ];
  for (const p of acctPatterns) {
    const m = text.match(p);
    if (m) { last4 = m[1]; break; }
  }

  // Due date
  let dueDate = null;
  const ddPatterns = [
    /(?:Due Date|Payment Due|Due by)[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(?:Due Date|Payment Due)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  ];
  for (const p of ddPatterns) {
    const m = text.match(p);
    if (m) { dueDate = m[1]; break; }
  }

  return { amount, addr, last4, dueDate };
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Análisis: 14 Spectrum Statement is Ready de mayo no ingresados');
console.log('═══════════════════════════════════════════════════════════\n');

const gmail = getGmail();
const userId = env['GMAIL_USER'];

// 1) Get Utilities label
const labelsRes = await gmail.users.labels.list({ userId });
const utLabel = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === 'utilities');

// 2) List all Spectrum Statement messages in May
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

console.log(`Emails Gmail con subject "Spectrum Statement is Ready" en mayo: ${ids.length}`);

// 3) Filter out ones already in DB
const inDbR = await pool.query(`SELECT gmail_message_id FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`, [ids]);
const inDb = new Set(inDbR.rows.map(r => r.gmail_message_id));
const missing = ids.filter(id => !inDb.has(id));
console.log(`  Ya en DB: ${ids.length - missing.length}`);
console.log(`  Faltantes a analizar: ${missing.length}\n`);

// 4) Load known mappings (account_last4 → property+unit) for Spectrum
const mappings = await pool.query(`
  SELECT account_last4, property_address, unit FROM account_mappings
  WHERE utility_type = 'internet'
`);
const mappingByAcct = new Map();
for (const m of mappings.rows) {
  if (m.account_last4) mappingByAcct.set(m.account_last4, m);
}

// Also load Spectrum bills from history for additional matching by account
const histR = await pool.query(`
  SELECT DISTINCT account_last4, property_address, unit
  FROM utility_bills
  WHERE utility_type = 'internet'
    AND email_from ILIKE '%spectrum%'
    AND property_address IS NOT NULL
    AND account_last4 IS NOT NULL
`);
const histByAcct = new Map();
for (const h of histR.rows) {
  if (!histByAcct.has(h.account_last4)) histByAcct.set(h.account_last4, h);
}

// 5) Process each missing email
const results = [];
for (let i = 0; i < missing.length; i++) {
  const id = missing[i];
  console.log(`─── [${i + 1}/${missing.length}] Email ${id} ───`);
  const msg = await gmail.users.messages.get({ userId, id, format: 'full' });
  const headers = msg.data.payload?.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from    = headers.find(h => h.name === 'From')?.value || '';
  const dateStr = headers.find(h => h.name === 'Date')?.value || '';
  const date    = dateStr ? new Date(dateStr).toISOString().slice(0, 16).replace('T', ' ') : '?';

  const html = decodeBody(msg.data.payload);
  const text = stripHtml(html);
  const { amount, addr, last4, dueDate } = extractFromSpectrum(text, html);

  // Match by account_last4
  let matchSource = null, matchAddr = null, matchUnit = null;
  if (last4) {
    if (mappingByAcct.has(last4)) {
      matchSource = 'account_mappings';
      matchAddr = mappingByAcct.get(last4).property_address;
      matchUnit = mappingByAcct.get(last4).unit;
    } else if (histByAcct.has(last4)) {
      matchSource = 'utility_bills (histórico)';
      matchAddr = histByAcct.get(last4).property_address;
      matchUnit = histByAcct.get(last4).unit;
    }
  }

  const result = {
    id, date, subject, amount, last4, dueDate,
    extractedAddr: addr, matchSource, matchAddr, matchUnit,
  };
  results.push(result);

  console.log(`  Fecha: ${date}`);
  console.log(`  From:  ${from.slice(0, 70)}`);
  console.log(`  Amount extraído: ${amount !== null ? `$${amount}` : '⚠ no encontrado'}`);
  console.log(`  Account ····${last4 || '?'}`);
  console.log(`  Due date: ${dueDate || '—'}`);
  console.log(`  Service address (del email): ${addr || '⚠ no encontrado'}`);
  if (last4) {
    if (matchSource) {
      console.log(`  ✓ MATCH por cuenta (${matchSource}): "${matchAddr}" unit="${matchUnit || ''}"`);
    } else {
      console.log(`  ⚠ Cuenta ····${last4} sin mapping conocido — sería UNASSIGNED`);
    }
  }
  console.log('');
}

// Summary
console.log('═══════════════════════════════════════════════════════════');
console.log('  Resumen para decisión');
console.log('═══════════════════════════════════════════════════════════');
const haveAmount = results.filter(r => r.amount !== null && r.amount > 0);
const noAmount   = results.filter(r => !r.amount || r.amount === 0);
const matched    = results.filter(r => r.matchSource);
const unmatched  = results.filter(r => !r.matchSource);
console.log(`Total analizados: ${results.length}`);
console.log(`  ✓ Con importe extraído:    ${haveAmount.length}`);
console.log(`  ⚠ Sin importe (revisar):   ${noAmount.length}`);
console.log(`  ✓ Match a propiedad:       ${matched.length}`);
console.log(`  ⚠ Sin match (Unassigned):  ${unmatched.length}`);

console.log('\nTabla resumen:');
console.log('Date              Acct   Amount    Match propiedad');
console.log('─'.repeat(80));
for (const r of results) {
  const amt = r.amount !== null ? `$${r.amount.toFixed(2)}`.padStart(9) : '   ⚠ N/A';
  const acct = r.last4 ? `····${r.last4}` : '····?';
  const matchStr = r.matchSource ? `${r.matchAddr}${r.matchUnit ? ` #${r.matchUnit}` : ''}` : '⚠ UNASSIGNED';
  console.log(`${r.date}   ${acct}  ${amt}   ${matchStr.slice(0, 50)}`);
}

await pool.end();

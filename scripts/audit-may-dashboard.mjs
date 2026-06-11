/**
 * Audit del dashboard — solo mayo 2026.
 *
 * Tres checks:
 *  A) Direcciones duplicadas (variantes de escritura) entre bills facturables
 *     con email_received_at en mayo.
 *  B) Facturas faltantes: emails en Gmail (Utilities, mayo) que no están en
 *     utility_bills como facturables (amount > 0).
 *  C) Verificar que email_received_at coincide con el mes mostrado en el
 *     dashboard (mayo), nunca uses due_date.
 *
 * Read-only.
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
process.env.GMAIL_USER = env['GMAIL_USER'];

const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

function getGmail() {
  const c = new google.auth.OAuth2(env['GMAIL_CLIENT_ID'], env['GMAIL_CLIENT_SECRET']);
  c.setCredentials({ refresh_token: env['GMAIL_REFRESH_TOKEN'] });
  return google.gmail({ version: 'v1', auth: c });
}

// Normalize address: lowercase, drop city/state/zip, collapse common abbreviations
function normAddr(addr) {
  if (!addr) return '';
  return addr.toLowerCase()
    .split(',')[0]              // drop city/state/zip
    .trim()
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\blane\b/g, 'ln')
    .replace(/\s+/g, ' ');
}
function normUnit(u) {
  return (u || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim();
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Auditoría dashboard — mayo 2026');
console.log('═══════════════════════════════════════════════════════════\n');

// ── A) Bills facturables de mayo ─────────────────────────────────────────────
const bills = await pool.query(`
  SELECT id, utility_type, property_address, unit, account_last4, amount_due,
         due_date, email_received_at, email_subject, email_from, gmail_message_id
  FROM utility_bills
  WHERE amount_due IS NOT NULL AND amount_due > 0
    AND email_received_at >= '2026-05-01'
    AND email_received_at <  '2026-06-01'
  ORDER BY email_received_at
`);
console.log(`A) Bills facturables en mayo: ${bills.rows.length}\n`);

// ── A.1) Direcciones duplicadas ──────────────────────────────────────────────
console.log('A.1) Buscando direcciones duplicadas (misma normalización, distinta escritura)\n');
const byNorm = new Map();
for (const b of bills.rows) {
  if (!b.property_address) continue;
  const key = normAddr(b.property_address) + '|' + normUnit(b.unit);
  if (!byNorm.has(key)) byNorm.set(key, []);
  byNorm.get(key).push(b);
}

const duplicates = [];
for (const [key, list] of byNorm.entries()) {
  // Are there >1 distinct property_address+unit raw values in this group?
  const distinct = new Set(list.map(b => (b.property_address || '') + '|' + (b.unit || '')));
  if (distinct.size > 1) {
    duplicates.push({ key, list, variants: [...distinct] });
  }
}

if (duplicates.length === 0) {
  console.log('  ✅ Sin duplicados detectados en mayo\n');
} else {
  console.log(`  ⚠ ${duplicates.length} grupos con variantes:\n`);
  for (const dup of duplicates) {
    console.log(`  Grupo "${dup.key}":`);
    for (const v of dup.variants) {
      const [addr, unit] = v.split('|');
      const billsForVariant = dup.list.filter(b => (b.property_address || '') === addr && (b.unit || '') === unit);
      console.log(`    "${addr}" unit="${unit}"  (${billsForVariant.length} bills)`);
      for (const b of billsForVariant) {
        console.log(`      Bill #${b.id}  ${b.utility_type}  $${b.amount_due}  recv=${b.email_received_at?.toISOString().slice(0,10)}  account ····${b.account_last4 || '?'}`);
      }
    }
    console.log('');
  }
}

// ── B) Facturas faltantes: Gmail vs DB ───────────────────────────────────────
console.log('B) Comparando emails Gmail (Utilities, mayo) vs DB\n');
const gmail  = getGmail();
const userId = env['GMAIL_USER'];
const labelsRes = await gmail.users.labels.list({ userId });
const utLabel = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === 'utilities');

const ids = [];
let pageToken;
do {
  const r = await gmail.users.messages.list({
    userId, labelIds: [utLabel.id], maxResults: 500, q: 'after:2026/5/1 before:2026/6/1',
    ...(pageToken ? { pageToken } : {}),
  });
  for (const m of r.data.messages || []) ids.push(m.id);
  pageToken = r.data.nextPageToken;
} while (pageToken);
console.log(`  Emails en Gmail (mayo): ${ids.length}`);

// Bulk lookup against DB
const dbRows = await pool.query(
  `SELECT gmail_message_id, amount_due, email_subject, email_from FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`,
  [ids]
);
const inDb = new Map(dbRows.rows.map(r => [r.gmail_message_id, r]));

const realBills = [];
const noiseProcessed = [];
const missing = [];
for (const id of ids) {
  const row = inDb.get(id);
  if (!row) missing.push(id);
  else if (Number(row.amount_due) > 0) realBills.push({ id, ...row });
  else noiseProcessed.push({ id, ...row });
}
console.log(`    ✓ Facturas reales en DB:  ${realBills.length}`);
console.log(`    · Procesado como ruido:   ${noiseProcessed.length}`);
console.log(`    ✗ NO ingresado en DB:     ${missing.length}\n`);

if (missing.length > 0) {
  // Fetch metadata for missing
  console.log('  Detalle emails NO ingresados (subject + sender):\n');
  const META_CONCURRENCY = 8;
  const meta = [];
  for (let i = 0; i < missing.length; i += META_CONCURRENCY) {
    const chunk = missing.slice(i, i + META_CONCURRENCY);
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
    meta.push(...batch);
  }
  // Group by subject pattern
  const bySubj = {};
  for (const m of meta) {
    const s = (m.subject || '').slice(0, 70);
    if (!bySubj[s]) bySubj[s] = [];
    bySubj[s].push(m);
  }
  const sorted = Object.entries(bySubj).sort((a, b) => b[1].length - a[1].length);
  for (const [s, arr] of sorted) {
    // Mark potential real bills
    const looksReal = /statement is ready|bill is ready|bill.*ready|your bill|invoice|amount due|payment due|past due/i.test(s) && !/payment is scheduled|scheduled soon|thanks for paying|payment received|payment confirmation/i.test(s);
    const flag = looksReal ? ' ⚠ REVISAR' : '';
    console.log(`  ${String(arr.length).padStart(3)} × "${s}"${flag}`);
    if (looksReal) {
      for (const m of arr.slice(0, 5)) {
        console.log(`        ${m.date ? new Date(m.date).toISOString().slice(0,10) : '?'}  from: ${(m.from || '').slice(0, 55)}`);
      }
    }
  }
  console.log('');
}

// ── C) Verificar email_received_at en mayo ───────────────────────────────────
console.log('C) Verificando que email_received_at es la fecha "de la factura"\n');
const orderCheck = await pool.query(`
  SELECT id, email_received_at, due_date, utility_type, amount_due, property_address
  FROM utility_bills
  WHERE amount_due > 0
    AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
    AND (due_date IS NULL OR due_date > email_received_at + INTERVAL '60 days' OR due_date < email_received_at - INTERVAL '60 days')
  ORDER BY id
`);
console.log(`  Bills donde due_date discrepa mucho con email_received_at: ${orderCheck.rows.length}`);
if (orderCheck.rows.length > 0) {
  console.log('  (Esto NO es un bug — el dashboard ya usa email_received_at. Solo informativo.)');
  for (const r of orderCheck.rows.slice(0, 8)) {
    console.log(`    Bill #${r.id}  recv=${r.email_received_at?.toISOString().slice(0,10)}  due=${r.due_date?.toISOString().slice(0,10) || '—'}  ${r.utility_type} $${r.amount_due}`);
  }
}

// Also check: any bill in May without email_received_at?
const noRecv = await pool.query(`
  SELECT id, due_date, utility_type, amount_due
  FROM utility_bills
  WHERE amount_due > 0 AND email_received_at IS NULL
    AND due_date >= '2026-05-01' AND due_date < '2026-06-01'
`);
console.log(`\n  Bills SIN email_received_at (caerían a fallback due_date): ${noRecv.rows.length}`);
if (noRecv.rows.length > 0) {
  for (const r of noRecv.rows) {
    console.log(`    ⚠ Bill #${r.id}  due=${r.due_date?.toISOString().slice(0,10)}  ${r.utility_type} $${r.amount_due}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Resumen');
console.log('═══════════════════════════════════════════════════════════');
console.log(`A) ${bills.rows.length} bills facturables en mayo · ${duplicates.length} grupos de direcciones duplicadas`);
console.log(`B) ${ids.length} emails Gmail mayo · ${realBills.length} facturas en DB · ${missing.length} no ingresados`);
console.log(`C) ${noRecv.rows.length} bills sin email_received_at (problema potencial de fecha mostrada)`);

await pool.end();

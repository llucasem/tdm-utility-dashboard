/**
 * Airtable EMAILS deep-dive — read-only.
 *
 * Pulls EVERY record from `EMAILS - Rental Portals`, then groups by:
 *   - Mailbox      (which inbox received it)
 *   - From Email   (who sent it — domain-level)
 *   - Subject kw   (keywords that hint at rent/utility/spam/etc.)
 *
 * Goal: identify which senders are RENT platforms so we can build a
 * focused sync (only those go into the dashboard), and surface what
 * "noise" there is to filter out.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = join(__dirname, '..', '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) {
    const k = m[1].trim();
    const v = m[2].split('#')[0].trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const PAT      = process.env.AIRTABLE_PAT;
const BASE_ID  = 'app4hMyYd61s95xqV';
const TABLE_ID = 'tblcWkXqmdR8JI6Pq';

async function airtable(path) {
  const r = await fetch(`https://api.airtable.com/v0${path}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}

// Paginate through all records (Airtable returns max 100 per page)
const all = [];
let offset;
do {
  const url = `/${BASE_ID}/${TABLE_ID}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
  const page = await airtable(url);
  all.push(...page.records);
  offset = page.offset;
  process.stderr.write(`  fetched ${all.length}…\r`);
} while (offset);
process.stderr.write('\n');

console.log('═'.repeat(70));
console.log(`AIRTABLE EMAILS — full sweep`);
console.log('═'.repeat(70));
console.log(`Total records: ${all.length}`);
console.log();

// 1. Group by Mailbox
const byMailbox = new Map();
for (const r of all) {
  const mb = r.fields.Mailbox || '(no mailbox)';
  byMailbox.set(mb, (byMailbox.get(mb) || 0) + 1);
}
console.log('── BY MAILBOX (which inbox receives mail) ──');
const mailboxSorted = [...byMailbox.entries()].sort((a, b) => b[1] - a[1]);
for (const [mb, n] of mailboxSorted) console.log(`  ${String(n).padStart(5)}  ${mb}`);
console.log();

// 2. Group by From Email (extract domain)
const byFromDomain = new Map();
const byFromFull = new Map();
for (const r of all) {
  const fromEmail = (r.fields['From Email'] || '(no from)').toLowerCase();
  byFromFull.set(fromEmail, (byFromFull.get(fromEmail) || 0) + 1);
  const dom = fromEmail.split('@')[1] || fromEmail;
  byFromDomain.set(dom, (byFromDomain.get(dom) || 0) + 1);
}
console.log('── BY SENDER DOMAIN (top 30) ──');
const domSorted = [...byFromDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [d, n] of domSorted) console.log(`  ${String(n).padStart(5)}  ${d}`);
console.log();

// 3. Group by Type field (Airtable categorization)
const byType = new Map();
for (const r of all) {
  const t = r.fields.Type || '(no type)';
  byType.set(t, (byType.get(t) || 0) + 1);
}
console.log('── BY TYPE (Airtable classification) ──');
const typeSorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, n] of typeSorted) console.log(`  ${String(n).padStart(5)}  ${t}`);
console.log();

// 4. Rent-keyword scan in subjects
const RENT_KW = /\b(rent|lease|payment|receipt|invoice|statement|deposit|due|past due|balance|charge|autopay|monthly payment)\b/i;
const rentish = all.filter((r) => RENT_KW.test(r.fields.Subject || ''));
console.log(`── RENT-KEYWORD MATCHES in Subject: ${rentish.length} of ${all.length} ──`);
const rentBySender = new Map();
for (const r of rentish) {
  const k = `${r.fields.From || ''}  <${r.fields['From Email'] || ''}>`;
  rentBySender.set(k, (rentBySender.get(k) || 0) + 1);
}
const rentSenderSorted = [...rentBySender.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('  Top senders of rent-looking subjects:');
for (const [k, n] of rentSenderSorted) console.log(`    ${String(n).padStart(4)}  ${k}`);
console.log();

// 5. Sample 8 rent-looking subjects
console.log('── 8 SAMPLE rent-looking subjects (for sanity check) ──');
for (const r of rentish.slice(0, 8)) {
  console.log(`  · ${r.fields.Received?.slice(0, 10) || '????'}  ${r.fields.From} → ${r.fields.Subject}`);
}
console.log();

// 6. Known rent platforms to look for explicitly
const KNOWN_PLATFORMS = [
  'buildium', 'appfolio', 'yardi', 'rentmanager', 'rentmanager.com',
  'realpage', 'rent.com', 'avail', 'rentredi', 'zumper', 'apartments.com',
  'hostaway', 'guesty', 'lodgify', 'hostfully', 'tokeet',
  'airbnb', 'vrbo', 'booking.com',
  'bnbtally', 'doorloop', 'turnoverbnb', 'turno',
  'stessa', 'baselane', 'tenantcloud', 'cozy', 'rentec',
];
console.log('── KNOWN RENT / STR PLATFORMS detected ──');
const platformHits = new Map();
for (const r of all) {
  const blob = `${r.fields.From || ''} ${r.fields['From Email'] || ''}`.toLowerCase();
  for (const p of KNOWN_PLATFORMS) {
    if (blob.includes(p)) {
      platformHits.set(p, (platformHits.get(p) || 0) + 1);
    }
  }
}
if (platformHits.size === 0) {
  console.log('  (none of the typical platforms found — needs manual review)');
} else {
  for (const [p, n] of [...platformHits.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${p}`);
  }
}
console.log();

// 7. Date range
const dates = all.map((r) => r.fields.Received).filter(Boolean).sort();
console.log('── DATE RANGE ──');
console.log(`  earliest: ${dates[0] || '?'}`);
console.log(`  latest:   ${dates[dates.length - 1] || '?'}`);
console.log();

console.log('═'.repeat(70));
console.log('Done.');

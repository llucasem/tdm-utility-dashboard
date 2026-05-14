/**
 * MEETING TOOL — runs auto-tag against the production app, bill by bill.
 *
 * Each bill that has a property→Class mapping + a matched Purchase in QB is
 * processed sequentially. Prints a live line per bill so Jake can watch in
 * real time while looking at QuickBooks.
 *
 * Safety:
 *  - Calls the production /api/quickbooks/auto-tag endpoint (authenticated
 *    with APP_SESSION_TOKEN cookie)
 *  - The guardrail inside tagPurchaseWithClass NEVER overwrites an existing
 *    Class — anything Edonis already tagged correctly stays untouched
 *  - You can stop the script with Ctrl+C at any moment
 *
 * Run during the meeting with:
 *   node scripts/run-auto-tag-batch.mjs
 *
 * Optional: --dry-run prints what would be done without calling the API.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const DRY_RUN  = process.argv.includes('--dry-run');
const BASE_URL = process.env.AUTO_TAG_BASE_URL || 'https://edonis-utility-dashboard.vercel.app';
const SESSION  = process.env.APP_SESSION_TOKEN;
if (!SESSION) { console.error('Missing APP_SESSION_TOKEN in .env.local'); process.exit(1); }

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`  AUTO-TAG BATCH RUN  ${DRY_RUN ? '(DRY RUN)' : ''}`);
console.log(`  Target: ${BASE_URL}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

// Pick bills that have everything ready: matched in QB + property assigned + mapping exists
const r = await pool.query(`
  SELECT
    b.id,
    b.property_address,
    COALESCE(b.unit, '') AS unit,
    b.amount_due,
    b.qb_tag_status,
    p.qb_class_name
  FROM utility_bills b
  JOIN property_qb_class p
    ON p.property_address = b.property_address
   AND COALESCE(p.unit, '') = COALESCE(b.unit, '')
  WHERE b.qb_match_status = 'matched'
    AND b.amount_due > 0
    AND b.qb_tag_status IN ('pending', 'not_found', 'error')
  ORDER BY b.due_date DESC NULLS LAST
`);

const bills = r.rows;
console.log(`  Found ${bills.length} bills ready to attempt auto-tag.\n`);
if (bills.length === 0) {
  console.log('  Nothing to do. Either no bills match, or all have qb_tag_status terminal already.');
  await pool.end();
  process.exit(0);
}

let tagged = 0, skipped = 0, error = 0, notFound = 0, ambiguous = 0;

for (let i = 0; i < bills.length; i++) {
  const b = bills[i];
  const num   = String(i + 1).padStart(3);
  const total = String(bills.length).padStart(3);
  const label = `${b.property_address}${b.unit ? ' · ' + b.unit : ''} ($${Number(b.amount_due).toFixed(2)})`;
  process.stdout.write(`  [${num}/${total}] ${label.padEnd(70)}  `);

  if (DRY_RUN) {
    process.stdout.write(`would tag → ${b.qb_class_name}\n`);
    continue;
  }

  try {
    const res = await fetch(`${BASE_URL}/api/quickbooks/auto-tag?billId=${b.id}`, {
      headers: { Cookie: `tdm_session=${SESSION}` },
    });
    const data = await res.json();
    const status = data?.result?.status || 'unknown';
    const reason = data?.result?.reason  || '';

    let symbol;
    switch (status) {
      case 'tagged':    symbol = '✓ tagged'; tagged++; break;
      case 'skipped':   symbol = `· skipped (${reason})`; skipped++; break;
      case 'not_found': symbol = '✗ not_found'; notFound++; break;
      case 'ambiguous': symbol = '⚠ ambiguous'; ambiguous++; break;
      case 'error':     symbol = `! error (${reason})`; error++; break;
      default:          symbol = `? ${status}`;
    }
    process.stdout.write(`${symbol}\n`);
  } catch (e) {
    process.stdout.write(`! network: ${e.message}\n`);
    error++;
  }

  // Pause briefly so QB API isn't hammered, and so Jake has time to watch
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  RESUMEN');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`  ✓ tagged       ${tagged}   (Class escrito en QB)`);
console.log(`  · skipped      ${skipped}   (ya tenía Class — guardrail respetado)`);
console.log(`  ⚠ ambiguous    ${ambiguous}   (varias Purchases con mismo importe)`);
console.log(`  ✗ not_found    ${notFound}   (sin Purchase candidata en QB)`);
console.log(`  ! error        ${error}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

await pool.end();

/**
 * Airtable read-only diagnostic — run with: node scripts/explore-airtable.mjs
 *
 * Lists every base accessible to AIRTABLE_PAT, every table inside,
 * every field with its type, and samples 3 records per table to
 * understand actual data shape. No writes, no DB touched.
 *
 * Output to stdout. Save with `> airtable-investigation.txt` if long.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = join(__dirname, '..', '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) {
    const key = m[1].trim();
    const val = m[2].split('#')[0].trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const PAT = process.env.AIRTABLE_PAT;
if (!PAT || PAT.startsWith('PASTE_')) {
  console.error('❌ AIRTABLE_PAT missing or still a placeholder in .env.local');
  process.exit(1);
}

async function airtable(path) {
  const r = await fetch(`https://api.airtable.com/v0${path}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Airtable ${r.status} on ${path}: ${body}`);
  }
  return r.json();
}

function summarizeField(f) {
  let extra = '';
  if (f.options?.choices) {
    const choices = f.options.choices.map((c) => c.name).slice(0, 8);
    extra = ` [${choices.join(' | ')}${f.options.choices.length > 8 ? ', ...' : ''}]`;
  } else if (f.options?.result?.type) {
    extra = ` (formula → ${f.options.result.type})`;
  } else if (f.options?.linkedTableId) {
    extra = ` (→ tbl ${f.options.linkedTableId})`;
  }
  return `    • ${f.name}  [${f.type}]${extra}`;
}

function truncateValue(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (typeof v[0] === 'object') return `[${v.length} linked records]`;
    return `[${v.slice(0, 3).join(', ')}${v.length > 3 ? `, +${v.length - 3}` : ''}]`;
  }
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

console.log('═'.repeat(70));
console.log('AIRTABLE DIAGNOSTIC — The Dream Management');
console.log('═'.repeat(70));
console.log();

const basesResp = await airtable('/meta/bases');
const bases = basesResp.bases || [];

console.log(`Bases accessible to this PAT: ${bases.length}\n`);
for (const b of bases) {
  console.log(`  📁 ${b.name}`);
  console.log(`     id: ${b.id}   permission: ${b.permissionLevel}`);
}
console.log();

for (const base of bases) {
  console.log('═'.repeat(70));
  console.log(`📁 BASE: ${base.name}   (${base.id})`);
  console.log('═'.repeat(70));

  let schema;
  try {
    schema = await airtable(`/meta/bases/${base.id}/tables`);
  } catch (e) {
    console.log(`  ⚠️  Cannot read schema: ${e.message}`);
    console.log();
    continue;
  }

  for (const table of schema.tables) {
    console.log();
    console.log(`  📊 TABLE: ${table.name}   (${table.id})`);
    console.log(`     Fields (${table.fields.length}):`);
    for (const f of table.fields) console.log(summarizeField(f));

    // Sample 3 records
    try {
      const sample = await airtable(`/${base.id}/${table.id}?maxRecords=3`);
      if (sample.records.length === 0) {
        console.log(`     (table is empty)`);
      } else {
        console.log(`     Sample records (${sample.records.length}):`);
        for (const rec of sample.records) {
          console.log(`       ─ ${rec.id}`);
          for (const [k, v] of Object.entries(rec.fields)) {
            console.log(`         ${k}: ${truncateValue(v)}`);
          }
        }
      }
    } catch (e) {
      console.log(`     (sampling failed: ${e.message})`);
    }
  }
  console.log();
}

console.log('═'.repeat(70));
console.log('Done.');

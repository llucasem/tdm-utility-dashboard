/**
 * One-time backfill: populate provider_accounts from utility_bills history.
 *
 * Builds the canonical account registry that matcher-v2 uses:
 *   provider + account_last4 → property+unit+typical_day+last_amount
 *
 * Safe to re-run — uses ON CONFLICT to update last_seen_at + bills_count.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

// Provider inferred from utility_type + email_from + property_address. Lowercase canonical.
// Primary signal: email_from. Fallback for legacy rows: utility_type + region inferred from
// property_address (NY/NYC → ConEd for electricity, LA/CA → SCE/LADWP, etc.)
function inferProvider(b) {
  const ef = (b.email_from || '').toLowerCase();
  if (ef.includes('spectrum'))                       return 'spectrum';
  if (ef.includes('coned'))                          return 'conedison';
  if (ef.includes('socalgas'))                       return 'socalgas';
  if (ef.includes('sce.com') || ef.includes('@sce.')) return 'sce';
  if (ef.includes('ladwp') || ef.includes('@dwp.'))   return 'ladwp';
  if (ef.includes('att.') || ef.includes('at&t'))     return 'att';
  if (ef.includes('t-mobile') || ef.includes('tmobile')) return 'tmobile';
  if (ef.includes('optimum'))                        return 'optimum';
  if (ef.includes('verizon'))                        return 'verizon';
  if (ef.includes('pge.com'))                        return 'pge';

  // Fallback for rows without email_from (legacy from before we saved that column).
  // Region inferred from state in property_address.
  const addr = (b.property_address || '').toLowerCase();
  const isNY = addr.includes(', ny') || addr.includes(' new york') || addr.includes('nyc');
  const isCA_LA = (addr.includes(', ca ') || addr.includes(', ca,')) && (addr.includes('los angeles') || addr.includes('beverly hills'));
  const isCA_SM = addr.includes('santa monica') || addr.includes('marina del rey') || addr.includes('palm springs') || addr.includes('long beach');

  if (b.utility_type === 'internet') return 'spectrum'; // dominant ISP in client's footprint
  if (b.utility_type === 'gas')      return 'socalgas';
  if (b.utility_type === 'water')    return isNY ? 'nyc-water' : 'ladwp';
  if (b.utility_type === 'electricity') {
    if (isNY) return 'conedison';
    if (isCA_LA) return 'ladwp';
    if (isCA_SM) return 'sce';
    return 'sce'; // conservative default for CA
  }
  return null;
}

console.log('═══ Backfill provider_accounts ═══\n');

const bills = await pool.query(`
  SELECT id, utility_type, account_last4, email_from, property_address, unit,
         amount_due, email_received_at
  FROM utility_bills
  WHERE account_last4 IS NOT NULL AND account_last4 != ''
    AND utility_type != 'other'
    AND amount_due > 0
    AND NOT is_duplicate
  ORDER BY email_received_at
`);

console.log(`Bills facturables con account_last4: ${bills.rowCount}\n`);

// Aggregate: provider+last4 → bills
const grouped = new Map();
for (const b of bills.rows) {
  const provider = inferProvider(b);
  if (!provider) continue;
  const key = `${provider}|${b.account_last4}`;
  if (!grouped.has(key)) grouped.set(key, { provider, last4: b.account_last4, bills: [] });
  grouped.get(key).bills.push(b);
}
console.log(`Grupos (provider+account): ${grouped.size}\n`);

let upserted = 0;
let updated = 0;
const linkUpdates = [];

for (const [key, g] of grouped.entries()) {
  // Pick the most recent bill for property/unit/utility_type (could've drifted)
  const sorted = [...g.bills].sort((a, b) => b.email_received_at - a.email_received_at);
  const latest = sorted[0];
  const typical_day = (() => {
    const days = g.bills.map(b => b.email_received_at.getUTCDate()).filter(Boolean);
    if (days.length === 0) return null;
    const mean = Math.round(days.reduce((s, d) => s + d, 0) / days.length);
    return Math.min(28, Math.max(1, mean));
  })();
  const last_cycle = `${latest.email_received_at.getUTCFullYear()}-${String(latest.email_received_at.getUTCMonth() + 1).padStart(2, '0')}`;

  const r = await pool.query(`
    INSERT INTO provider_accounts
      (provider, account_last4, utility_type, property_address, unit,
       first_seen_at, last_seen_at, bills_count, last_amount, last_cycle, typical_day_of_month)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (provider, account_last4)
    DO UPDATE SET
      utility_type   = EXCLUDED.utility_type,
      property_address = EXCLUDED.property_address,
      unit           = EXCLUDED.unit,
      last_seen_at   = GREATEST(provider_accounts.last_seen_at, EXCLUDED.last_seen_at),
      bills_count    = EXCLUDED.bills_count,
      last_amount    = EXCLUDED.last_amount,
      last_cycle     = EXCLUDED.last_cycle,
      typical_day_of_month = EXCLUDED.typical_day_of_month
    RETURNING id, (xmax = 0) AS inserted
  `, [
    g.provider, g.last4, latest.utility_type, latest.property_address, latest.unit,
    g.bills[0].email_received_at, latest.email_received_at,
    g.bills.length, latest.amount_due, last_cycle, typical_day,
  ]);
  const account_id = r.rows[0].id;
  if (r.rows[0].inserted) upserted++; else updated++;

  // Link all bills of this account to the new provider_accounts row
  for (const b of g.bills) {
    linkUpdates.push({ id: b.id, account_id });
  }
}

console.log(`Insertados:  ${upserted}`);
console.log(`Actualizados: ${updated}`);
console.log(`Bills a vincular a account_id: ${linkUpdates.length}\n`);

// Batch update utility_bills.account_id
for (let i = 0; i < linkUpdates.length; i += 100) {
  const chunk = linkUpdates.slice(i, i + 100);
  for (const u of chunk) {
    await pool.query('UPDATE utility_bills SET account_id = $1 WHERE id = $2', [u.account_id, u.id]);
  }
}
console.log('  ✓ Bills vinculadas\n');

// Stats
const final = await pool.query(`
  SELECT
    COUNT(*)::int AS accounts,
    COUNT(DISTINCT property_address)::int AS distinct_properties,
    COUNT(*) FILTER (WHERE utility_type = 'internet')::int AS internet,
    COUNT(*) FILTER (WHERE utility_type = 'electricity')::int AS electricity,
    COUNT(*) FILTER (WHERE utility_type = 'gas')::int AS gas,
    COUNT(*) FILTER (WHERE utility_type = 'water')::int AS water
  FROM provider_accounts
`);
const linked = await pool.query(`SELECT COUNT(*)::int AS c FROM utility_bills WHERE account_id IS NOT NULL AND amount_due > 0`);
console.log('═══ provider_accounts stats ═══');
console.log(`  Total accounts:        ${final.rows[0].accounts}`);
console.log(`  Distinct properties:   ${final.rows[0].distinct_properties}`);
console.log(`  internet:              ${final.rows[0].internet}`);
console.log(`  electricity:           ${final.rows[0].electricity}`);
console.log(`  gas:                   ${final.rows[0].gas}`);
console.log(`  water:                 ${final.rows[0].water}`);
console.log(`  utility_bills linked:  ${linked.rows[0].c}\n`);

await pool.end();

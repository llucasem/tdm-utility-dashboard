/**
 * Known vendors + bank accounts for utility bills.
 *
 * Combines two sources:
 *   1. SEED list — hardcoded baseline (Spectrum, ConEd, SCE, LADWP, SoCalGas...)
 *   2. LEARNED — populated by refreshLearnedVendors() from tagged history.
 *      Auto-adds vendors/accounts that appear ≥ MIN_SAMPLES times in
 *      successfully tagged utility bills, per utility_type.
 *
 * Cached in-memory for 5 minutes to avoid hitting DB on every match attempt.
 */

import pool from '@/lib/db';

// Auto-promote to "known" after this many tagged sightings for the same utility_type
const MIN_SAMPLES = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── SEED — vendor substrings considered safe for each utility type ──────────
// These are the patterns inferBillVendor already used. Kept lowercase.
const SEED_VENDORS = {
  internet:    ['spectrum', 'optimum', 'verizon', 'at&t', 'att', 'comcast', 'cox'],
  electricity: ['con edis', 'conedison', 'con edison', 'southern california edison', 'sce', 'ladwp', 'dwp', 'pg&e', 'pge', 'eversource', 'national grid', 'nyseg'],
  gas:         ['socalgas', 'so cal gas', 'national grid', 'con edison', 'conedison'],
  water:       ['dwp', 'sjwd', 'lacswd', 'mwd'],
  other:       [],
};

// Hardcoded bank accounts that should be the SOURCE for utility payments.
// Seen in production: all May utility Purchases come from this card account.
const SEED_BANK_ACCOUNTS = [
  'bofa - business advantage travel rewards',
  'bofa - business advantage',
];

let cache = { vendors: null, accounts: null, loadedAt: 0 };

async function loadFromDb() {
  // Tolerate the case where the learned_* tables don't exist yet (first deploy)
  let learnedVendors = [];
  let learnedAccounts = [];
  try {
    const v = await pool.query(`SELECT utility_type, vendor_substring FROM learned_vendors WHERE sample_count >= $1`, [MIN_SAMPLES]);
    learnedVendors = v.rows;
  } catch { /* table doesn't exist yet */ }
  try {
    const a = await pool.query(`SELECT account_name FROM learned_bank_accounts WHERE sample_count >= $1`, [MIN_SAMPLES]);
    learnedAccounts = a.rows;
  } catch { /* table doesn't exist yet */ }

  const vendors = {};
  for (const [type, list] of Object.entries(SEED_VENDORS)) vendors[type] = new Set(list);
  for (const row of learnedVendors) {
    if (!vendors[row.utility_type]) vendors[row.utility_type] = new Set();
    vendors[row.utility_type].add(row.vendor_substring.toLowerCase());
  }

  const accounts = new Set(SEED_BANK_ACCOUNTS.map(a => a.toLowerCase()));
  for (const row of learnedAccounts) accounts.add(row.account_name.toLowerCase());

  return { vendors, accounts };
}

async function getCached() {
  if (cache.vendors && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  const fresh = await loadFromDb();
  cache = { ...fresh, loadedAt: Date.now() };
  return cache;
}

/** Invalidate cache — call after refreshLearned* writes. */
export function invalidateKnownVendorsCache() {
  cache = { vendors: null, accounts: null, loadedAt: 0 };
}

/**
 * Infer expected vendor substrings from a bill's email_from.
 * Used as the FIRST signal — if the email tells us who sent it, prefer that.
 */
export function inferVendorFromEmail(emailFrom) {
  if (!emailFrom) return null;
  const f = emailFrom.toLowerCase();
  if (f.includes('spectrum'))                       return ['spectrum'];
  if (f.includes('coned'))                          return ['con edis', 'conedison', 'con edison'];
  if (f.includes('socalgas'))                       return ['socalgas'];
  if (f.includes('sce.com') || f.includes('@sce.')) return ['southern california edison', 'sce'];
  if (f.includes('ladwp') || f.includes('@dwp.'))   return ['ladwp', 'dwp', 'city of la dwp'];
  if (f.includes('att.') || f.includes('at&t'))     return ['at&t', 'att'];
  if (f.includes('optimum'))                        return ['optimum'];
  if (f.includes('verizon'))                        return ['verizon'];
  if (f.includes('national grid') || f.includes('nationalgrid')) return ['national grid'];
  if (f.includes('nyseg'))                          return ['nyseg'];
  if (f.includes('eversource'))                     return ['eversource'];
  if (f.includes('pge.com') || f.includes('@pge.')) return ['pg&e', 'pge'];
  return null;
}

/** Returns true if `payee` contains any vendor substring known for `utility_type`. */
export async function isKnownVendor(utilityType, payee) {
  if (!payee) return false;
  const { vendors } = await getCached();
  const set = vendors[utilityType];
  if (!set || set.size === 0) return false;
  const p = payee.toLowerCase();
  for (const v of set) if (p.includes(v)) return true;
  return false;
}

/** Returns true if `accountName` is a known bank account for utilities. */
export async function isKnownBankAccount(accountName) {
  if (!accountName) return false;
  const { accounts } = await getCached();
  const a = accountName.toLowerCase();
  for (const known of accounts) if (a.includes(known) || known.includes(a)) return true;
  return false;
}

/** Returns true if vendor_substring matches given payee (case-insensitive). */
export function vendorMatchesPayee(expectedVendors, payee) {
  if (!expectedVendors || expectedVendors.length === 0 || !payee) return false;
  const p = payee.toLowerCase();
  return expectedVendors.some(v => p.includes(v.toLowerCase()));
}

// ── Learning ────────────────────────────────────────────────────────────────

/**
 * Walk through utility_bills that are 'tagged' and aggregate the payees of
 * their persisted Purchase matches by utility_type. Vendors that appear ≥
 * MIN_SAMPLES times get promoted to the learned whitelist.
 *
 * Idempotent — uses ON CONFLICT to update sample_count + last_seen_at.
 */
export async function refreshLearnedVendors({ sinceDays = 180 } = {}) {
  const stats = { processed: 0, promoted: 0, new: 0 };

  // Aggregate: utility_type → vendor (top-level payee from match data) → count
  const r = await pool.query(`
    WITH parsed AS (
      SELECT utility_type,
             LOWER(TRIM(REGEXP_REPLACE(((qb_match_data->0)->>'payee')::text, '[^a-zA-Z0-9 &]', '', 'g'))) AS payee
      FROM utility_bills
      WHERE qb_tag_status = 'tagged'
        AND qb_match_data IS NOT NULL
        AND jsonb_typeof(qb_match_data) = 'array'
        AND jsonb_array_length(qb_match_data) >= 1
        AND ((qb_match_data->0)->>'payee') IS NOT NULL
        AND COALESCE(due_date, email_received_at) > NOW() - ($1 * INTERVAL '1 day')
    )
    SELECT utility_type, payee, COUNT(*) AS cnt
    FROM parsed
    WHERE payee IS NOT NULL AND TRIM(payee) <> ''
    GROUP BY utility_type, payee
  `, [sinceDays]);

  for (const row of r.rows) {
    stats.processed++;
    const wasNew = await pool.query(`
      INSERT INTO learned_vendors (utility_type, vendor_substring, sample_count, last_seen_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (utility_type, vendor_substring)
      DO UPDATE SET sample_count = EXCLUDED.sample_count, last_seen_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `, [row.utility_type, row.payee, Number(row.cnt)]);
    if (wasNew.rows[0]?.inserted) stats.new++;
    if (Number(row.cnt) >= MIN_SAMPLES) stats.promoted++;
  }

  invalidateKnownVendorsCache();
  return stats;
}

/**
 * Same as refreshLearnedVendors but for bank accounts (AccountRef on Purchase).
 */
export async function refreshLearnedBankAccounts({ sinceDays = 180 } = {}) {
  const stats = { processed: 0, promoted: 0, new: 0 };
  const r = await pool.query(`
    WITH parsed AS (
      SELECT LOWER(TRIM(((qb_match_data->0)->>'account')::text)) AS account
      FROM utility_bills
      WHERE qb_tag_status = 'tagged'
        AND qb_match_data IS NOT NULL
        AND jsonb_typeof(qb_match_data) = 'array'
        AND jsonb_array_length(qb_match_data) >= 1
        AND ((qb_match_data->0)->>'account') IS NOT NULL
        AND COALESCE(due_date, email_received_at) > NOW() - ($1 * INTERVAL '1 day')
    )
    SELECT account, COUNT(*) AS cnt
    FROM parsed
    WHERE account IS NOT NULL AND TRIM(account) <> ''
    GROUP BY account
  `, [sinceDays]);

  for (const row of r.rows) {
    stats.processed++;
    const ins = await pool.query(`
      INSERT INTO learned_bank_accounts (account_name, sample_count, last_seen_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (account_name)
      DO UPDATE SET sample_count = EXCLUDED.sample_count, last_seen_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `, [row.account, Number(row.cnt)]);
    if (ins.rows[0]?.inserted) stats.new++;
    if (Number(row.cnt) >= MIN_SAMPLES) stats.promoted++;
  }

  invalidateKnownVendorsCache();
  return stats;
}

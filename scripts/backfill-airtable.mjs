/**
 * Backfill — process unprocessed Airtable emails into rent_payments
 * and utility_bills (Conservice). Designed to be runnable in small
 * batches so we can monitor progress and respect rate limits.
 *
 * Usage: node --env-file=.env.local scripts/backfill-airtable.mjs [limit]
 *   default limit = 100
 *
 * Anthropic Haiku rate limit: 30k tokens/min. Each Claude call ~2500 tokens.
 * Pre-filter skips obvious junk without spending tokens. Real Claude calls
 * are paced via PAUSE_BETWEEN_CLAUDE_MS.
 */

import { syncAirtable } from '../lib/airtable-sync.js';

const limit = parseInt(process.argv[2] || '100', 10);
console.log(`── Backfilling up to ${limit} unprocessed Airtable records ──\n`);

const start = Date.now();
const result = await syncAirtable({ limit });
const seconds = Math.round((Date.now() - start) / 1000);

console.log(`\n── Summary ──`);
console.log(`  Scanned:    ${result.scanned}`);
console.log(`  Rent saved: ${result.rent}`);
console.log(`  Conservice: ${result.conservice}`);
console.log(`  Skipped:    ${result.skipped}`);
console.log(`  Errors:     ${result.errors}`);
console.log(`  Time:       ${seconds}s`);

if (result.errors > 0) {
  console.log(`\n  First few errors:`);
  for (const r of result.results.filter(r => r.status === 'error').slice(0, 5)) {
    console.log(`    · ${r.id}  ${r.reason?.slice(0, 100)}`);
  }
}

// Show a few wins
if (result.rent > 0) {
  console.log(`\n  First few rent saves:`);
  for (const r of result.results.filter(r => r.status === 'rent_payment').slice(0, 5)) {
    console.log(`    · ${r.id}  $${r.amount}`);
  }
}

if (result.conservice > 0) {
  console.log(`\n  First few Conservice utility saves:`);
  for (const r of result.results.filter(r => r.status === 'conservice_utility').slice(0, 5)) {
    console.log(`    · ${r.id}  $${r.amount}`);
  }
}

process.exit(0);

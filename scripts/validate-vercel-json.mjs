#!/usr/bin/env node
/**
 * Pre-commit validator for vercel.json — enforces Vercel Hobby plan constraints.
 *
 * Vercel Hobby:
 *   - Max 2 cron jobs
 *   - Daily frequency only (one trigger per day: "0 H * * *" or "M H * * *")
 *
 * Failing this exits 1 so it can be wired to husky/lint-staged or CI.
 *
 * Run manually:  npm run validate:vercel
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, '..', 'vercel.json');

let config;
try {
  config = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`❌ Cannot read vercel.json: ${e.message}`);
  process.exit(1);
}

const errors = [];
const crons = config.crons || [];

if (crons.length > 2) {
  errors.push(`Hobby plan allows max 2 cron jobs, found ${crons.length}.`);
}

// A "daily" schedule on the Hobby plan must trigger at most once per day.
// Allowed patterns: "M H D M W" where:
//   - Minute is a single integer 0-59 (not "*", not a list, not a step)
//   - Hour is a single integer 0-23
// (The rest can be * because day-of-month/month/day-of-week still produce at
// most one trigger per day, just on different days.)
const dailyPattern = /^([0-9]|[1-5][0-9])\s+([0-9]|1[0-9]|2[0-3])\s+\S+\s+\S+\s+\S+$/;

for (const c of crons) {
  if (!c.schedule) {
    errors.push(`Cron "${c.path}" has no schedule.`);
    continue;
  }
  if (!dailyPattern.test(c.schedule)) {
    errors.push(
      `Cron "${c.path}" has schedule "${c.schedule}". ` +
      `Hobby plan requires once-per-day pattern "M H * * *". ` +
      `Examples that work: "0 0 * * *" (midnight UTC daily), "30 14 * * 1" (every Monday at 14:30 UTC).`
    );
  }
}

if (errors.length === 0) {
  console.log('✅ vercel.json is valid for Hobby plan.');
  console.log(`   ${crons.length} cron(s) configured:`);
  for (const c of crons) console.log(`     ${c.schedule.padEnd(14)} → ${c.path}`);
  process.exit(0);
}

console.error('❌ vercel.json has issues:\n');
for (const e of errors) console.error('   - ' + e);
console.error('\nFix and re-run. See https://vercel.com/docs/cron-jobs/usage-and-pricing');
process.exit(1);

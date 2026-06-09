/**
 * Deep classification of Airtable emails to decide which senders
 * are actually RENT BILLS that Edonis needs to pay.
 *
 * Picks 3 sample emails from each candidate sender, feeds each
 * email's real content to Claude Haiku, asks: "is this a rent bill
 * to pay? amount? due date? landlord? property?". Aggregates the
 * verdict per sender so we have evidence before trusting anyone.
 *
 * Read-only on Airtable. No DB writes.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';

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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Candidate senders to deeply investigate. These are the ones that
// COULD be rent landlords or rent-related — we'll let Claude decide
// after reading the actual content.
const CANDIDATE_SENDERS = [
  // Confirmed apartment operators (likely landlords)
  'Anara@bozzuto.com',
  'Livesantamonicalc@greystar.com',
  'livesantamonica@greystar.com',
  'Jefferson_at_Marina_Del_Rey@mail.welcomehome.com',
  'Tierra_del_Rey@mail.welcomehome.com',
  'donotreply@appfolio.com',
  'aqua@essex.com',
  'no-reply@essex.com',
  'no_reply_packages@avalonbay.com',
  'marinadelrey@udr.com',

  // Payment platforms — could be confirmations, not bills
  'notifications@alerts.biltrewards.com',
  'notifications@members.bilt.com',

  // Maybe rent, maybe not
  'no-reply@modernmsg.com',
  'noreply@bozzuto.com',
  'no-reply@entrata.com',
  'service@homebody.com',

  // Conservice = utility consolidator, double-check
  'ebill@conservicemail.com',
];

async function airtable(path) {
  const r = await fetch(`https://api.airtable.com/v0${path}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}

// Pull all records (paginated)
const all = [];
let offset;
do {
  const url = `/${BASE_ID}/${TABLE_ID}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
  const page = await airtable(url);
  all.push(...page.records);
  offset = page.offset;
} while (offset);

console.log(`Loaded ${all.length} emails total.\n`);

// Helper: pick N most recent from a sender (more recent = more representative of current setup)
function pickRecent(senderEmail, n) {
  return all
    .filter((r) => (r.fields['From Email'] || '').toLowerCase() === senderEmail.toLowerCase())
    .sort((a, b) => (b.fields.Received || '').localeCompare(a.fields.Received || ''))
    .slice(0, n);
}

const CLASSIFY_PROMPT = (subject, from, content, received) => `You are analyzing emails for The Dream Management LLC. They LEASE apartments from various landlords (Greystar, Bozzuto, etc.) and re-rent them as short-term rentals. They need a dashboard of RENT BILLS THEY OWE to landlords each month.

Look at this email and tell me — strictly — whether it is a RENT BILL THAT MUST BE PAID by The Dream Management.

NOT a rent bill if it is:
- A payment confirmation (rent already paid)
- A payout from Booking/VRBO/Airbnb (income, not expense)
- A community notice / event invitation
- A promotional / rewards / credit card offer
- A late fee notice unless it explicitly says an amount is due now
- A move-in / move-out / lease renewal notice with no due amount

IS a rent bill if:
- It explicitly states an amount due
- It explicitly states or implies a due date
- It is from a landlord or property management portal

Email:
From: ${from}
Received: ${received}
Subject: ${subject}

Body (truncated to 3000 chars):
${(content || '').slice(0, 3000)}

Respond with ONLY raw JSON (no markdown). Schema:
{
  "is_rent_bill": boolean,
  "category": "bill_due" | "payment_confirmation" | "payout_income" | "promotional" | "community_notice" | "lease_event" | "late_fee" | "statement" | "other",
  "amount_due": number | null,
  "due_date": "YYYY-MM-DD" | null,
  "landlord": string | null,
  "property_address": string | null,
  "unit": string | null,
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence"
}`;

async function classify(rec) {
  const f = rec.fields;
  const prompt = CLASSIFY_PROMPT(f.Subject, f.From, f.Content || '', f.Received);
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0]?.text || '{}';
    const jsonStr = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    return { error: e.message };
  }
}

// Results aggregator
const results = [];

for (const sender of CANDIDATE_SENDERS) {
  const samples = pickRecent(sender, 3);
  if (samples.length === 0) {
    console.log(`⏭️  ${sender} — no samples in dataset`);
    continue;
  }
  console.log(`\n📨 ${sender}  (${samples.length} samples)`);

  for (const s of samples) {
    process.stderr.write(`   classifying ${s.id}...\r`);
    const verdict = await classify(s);
    results.push({
      sender,
      record_id: s.id,
      received: s.fields.Received,
      subject: s.fields.Subject,
      from_display: s.fields.From,
      verdict,
    });
    // Tiny pause to be polite with API
    await new Promise((r) => setTimeout(r, 600));

    const v = verdict;
    if (v.error) {
      console.log(`   ❌ ${s.fields.Subject?.slice(0, 70)} — ERROR: ${v.error}`);
    } else {
      const flag = v.is_rent_bill ? '✅ BILL' : `   ${v.category}`;
      const amount = v.amount_due ? `$${v.amount_due}` : '—';
      const date = v.due_date || '—';
      console.log(`   ${flag.padEnd(20)} ${amount.padStart(8)}  due:${date.padEnd(10)}  ${s.fields.Subject?.slice(0, 60)}`);
    }
  }
}

console.log('\n');
console.log('═'.repeat(70));
console.log('SUMMARY BY SENDER — does this sender send real rent bills?');
console.log('═'.repeat(70));

const bySender = new Map();
for (const r of results) {
  if (!bySender.has(r.sender)) bySender.set(r.sender, { total: 0, bills: 0, samples: [] });
  const s = bySender.get(r.sender);
  s.total++;
  if (r.verdict?.is_rent_bill) s.bills++;
  s.samples.push(r);
}

const sorted = [...bySender.entries()].sort((a, b) => (b[1].bills / b[1].total) - (a[1].bills / a[1].total));
for (const [sender, s] of sorted) {
  const ratio = s.bills > 0 ? `✅ ${s.bills}/${s.total} bills` : `❌ 0/${s.total} bills`;
  console.log(`\n  ${sender}`);
  console.log(`    Verdict: ${ratio}`);
  for (const sa of s.samples) {
    const v = sa.verdict;
    if (v.error) continue;
    console.log(`      · ${v.category.padEnd(22)} ${v.is_rent_bill ? '✅' : '  '}  ${sa.subject?.slice(0, 60)}`);
  }
}

// Save full JSON for reference
import { writeFileSync } from 'fs';
const out = join(__dirname, '..', 'airtable-rent-classification.json');
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nFull JSON saved to: ${out}`);

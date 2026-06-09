/**
 * Classify Airtable EMAILS records using Claude Haiku.
 *
 * Three possible verdicts:
 *
 *   1. RENT_PAYMENT       — a payment confirmation that Edonis paid rent.
 *                           Goes into rent_payments table.
 *   2. CONSERVICE_UTILITY — a Conservice consolidated building utility bill.
 *                           Goes into utility_bills with utility_type='building'.
 *   3. SKIP               — anything else (promo, community notice, lease event,
 *                           OTP, Booking/VRBO payout, marketing).
 *
 * Cheap pre-filter runs first so we don't burn tokens on obvious junk.
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ──────────────────────────────────────────────────────────────────
// Cheap pre-filter — never call Claude on these
// ──────────────────────────────────────────────────────────────────

const HARD_SKIP_FROM = [
  // Marketing / community / rewards
  'no-reply@modernmsg.com',
  'noreply@modernmsg.com',
  // Bilt promotional (NOT the "automatic rent payment is processing" one)
  'pay-with-bilt@members.bilt.com',
  // STR platforms — payouts are income, not bills
  '@booking.com',
  '@vrbo.com',
  '@homeaway.com',
  '@airbnb.com',
  '@expediagroup.com',
  '@hostaway.com',
  '@expedia.com',
  // Banking alerts
  '@ealerts.bankofamerica.com',
  // Google / OTP / login
  'accounts-noreply@google.com',
  'no-reply@accounts.google.com',
  // Package notifications
  'no_reply_packages@avalonbay.com',
  // Reviews / aggregators
  '@revyoos.com',
];

const HARD_SKIP_SUBJECT = [
  /^otp for login/i,
  /^your verification code/i,
  /lease renewal/i,
  /lease is up for renewal/i,
  /lease expiring/i,
  /renewal rate request/i,
  /ready to renew/i,
  /stale package charge/i,
  /pay (june|july|august|september|october|november|december|january|february|march|april|may) rent with bilt and earn/i,
  /earn points when you pay rent with bilt/i,
  /monthly payout statement/i,
  /your receipt from hostaway/i,
  /booking\.com (invoice|reservation)/i,
];

// Conservice — building-level utility consolidations. Excluded by Lluis
// decision (2026-06-09): these were importing as utility_type='building'
// and didn't fit the per-unit Property|Unit|Electricity|Internet|Gas matrix.
// All 84 historical rows were deleted; future emails are pre-filter skipped.
function isConservice(email) {
  const f = (email.fromEmail || '').toLowerCase();
  return f.includes('conservicemail.com') || f.includes('conservice.com');
}

// Fast rejection without calling Claude.
function preFilter(email) {
  const from    = (email.fromEmail || '').toLowerCase();
  const subject = email.subject || '';

  if (isConservice(email)) {
    return { skip: true, reason: 'Conservice building utilities — not tracked in dashboard' };
  }
  if (HARD_SKIP_FROM.some((p) => from.includes(p.replace(/^@/, '')))) {
    return { skip: true, reason: 'sender is on hard-skip list' };
  }
  if (HARD_SKIP_SUBJECT.some((re) => re.test(subject))) {
    return { skip: true, reason: 'subject matches a known noise pattern' };
  }
  return { skip: false };
}

// ──────────────────────────────────────────────────────────────────
// Claude prompt
// ──────────────────────────────────────────────────────────────────

const CLASSIFY_PROMPT = (email) => `You are classifying emails for The Dream Management LLC. They LEASE apartments from landlords (Greystar, Bozzuto, AppFolio-managed buildings) and re-rent them as short-term rentals. Most rent is paid automatically through Bilt or building portals.

Your job: extract structured data from this email.

THREE possible outputs (return JSON with category set to one of):

(1) "rent_payment" — a confirmation that Edonis PAID rent.
    Examples: "Payment Confirmation", "Payment Receipt", "Online Payment Confirmation",
    "your automatic rent payment is processing" (from Bilt).
    Required fields: amount_paid, paid_date (the date payment was made/processed).

(2) "conservice_utility" — a Conservice utility statement (water/sewer/trash consolidated
    for an apartment building). Sender is ebill@conservicemail.com or similar.
    Required fields: amount_due (the new charges), due_date, building_name.

(3) "skip" — everything else: promo, OTP, lease renewal, payout from Booking, community
    notice, banking alert, etc. Be aggressive — when in doubt, skip.

Email:
Mailbox: ${email.mailbox}
From:    ${email.from}  <${email.fromEmail}>
Date:    ${email.received}
Subject: ${email.subject}

Body (first 3500 chars, plain text):
${(email.content || '').slice(0, 3500)}

Respond with ONLY raw JSON (no markdown, no code fence). Schema:
{
  "category": "rent_payment" | "conservice_utility" | "skip",
  "amount_paid": number | null,
  "amount_due": number | null,
  "paid_date": "YYYY-MM-DD" | null,
  "due_date": "YYYY-MM-DD" | null,
  "landlord": string | null,
  "payment_portal": string | null,
  "confirmation_number": string | null,
  "building_name": string | null,
  "property_address": string | null,
  "unit": string | null,
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence"
}`;

// ──────────────────────────────────────────────────────────────────
// Main classifier
// ──────────────────────────────────────────────────────────────────

export async function classifyEmail(email) {
  const pf = preFilter(email);
  if (pf.skip) {
    return { category: 'skip', reason: pf.reason, source: 'prefilter' };
  }

  // Conservice fast path — always classify as conservice_utility but still
  // need amounts/due_date from the body, so we DO call Claude with a hint.
  let promptToUse = CLASSIFY_PROMPT(email);
  if (isConservice(email)) {
    promptToUse = `NOTE: this email is from Conservice — treat it as "conservice_utility".\n\n${promptToUse}`;
  }

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: 'user', content: promptToUse }],
    });
    const text = msg.content[0]?.text || '{}';
    // Strip ```json or plain ``` code fences if Claude wrapped the JSON
    const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return { category: 'skip', reason: 'invalid JSON from Claude', source: 'parse_error' };
    }
    return sanitize(parsed);
  } catch (e) {
    throw new Error(`Claude classification failed: ${e.message}`);
  }
}

/**
 * Normalize + validate the Claude response.
 * Pure function for unit tests.
 */
export function sanitize(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Category fallback
  const validCategories = ['rent_payment', 'conservice_utility', 'skip'];
  if (!validCategories.includes(parsed.category)) {
    parsed.category = 'skip';
    parsed.reason = parsed.reason || 'invalid category from Claude — defaulted to skip';
  }

  // Numbers: coerce or null
  for (const k of ['amount_paid', 'amount_due']) {
    if (parsed[k] !== null && parsed[k] !== undefined) {
      const n = typeof parsed[k] === 'number' ? parsed[k] : parseFloat(String(parsed[k]).replace(/[^0-9.]/g, ''));
      parsed[k] = Number.isFinite(n) && n > 0 ? n : null;
    } else {
      parsed[k] = null;
    }
  }

  // Dates: keep YYYY-MM-DD only, drop anything else
  for (const k of ['paid_date', 'due_date']) {
    if (typeof parsed[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed[k])) {
      // pass through
    } else {
      parsed[k] = null;
    }
  }

  // Strings: trim or null
  for (const k of ['landlord', 'payment_portal', 'confirmation_number', 'building_name', 'property_address', 'unit', 'reason']) {
    if (typeof parsed[k] === 'string') {
      parsed[k] = parsed[k].trim() || null;
    } else if (parsed[k] !== null && parsed[k] !== undefined) {
      parsed[k] = String(parsed[k]).trim() || null;
    } else {
      parsed[k] = null;
    }
  }

  // Confidence default
  if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
    parsed.confidence = 'low';
  }

  // Promote rent_payment → skip if no amount AND no confirmation number — useless.
  if (parsed.category === 'rent_payment' && !parsed.amount_paid && !parsed.confirmation_number) {
    parsed.category = 'skip';
    parsed.reason = (parsed.reason || '') + ' [demoted: no amount, no confirmation]';
  }

  // Conservice: promote to skip if no amount due
  if (parsed.category === 'conservice_utility' && !parsed.amount_due) {
    parsed.category = 'skip';
    parsed.reason = (parsed.reason || '') + ' [demoted: no amount_due]';
  }

  return parsed;
}

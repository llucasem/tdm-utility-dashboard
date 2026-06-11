import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a data extractor for a short-term rental property management company (The Dream Management LLC, ~67 properties). Your only job is to extract structured billing data from utility emails.

RETURN FORMAT
Return ONLY a valid JSON object with these exact keys — no markdown fences, no prose:
{
  "utility_type":    "<see allowed values below>",
  "is_confirmation": <true|false>,
  "property_address":"<string or null>",
  "unit":            "<string or null>",
  "account_last4":   "<exactly 4 digits or null>",
  "amount_due":      <number or null>,
  "due_date":        "<YYYY-MM-DD or null>",
  "confidence":      "<high|low>"
}

FIELD RULES

utility_type
  Allowed: "electricity" | "internet" | "gas" | "water" | "rent" | "insurance" | "other"
  Map T-Mobile / AT&T / Spectrum / Xfinity / Optimum / Verizon → "internet"
  Map SCE / LADWP / ConEd / PG&E / Eversource / NYSEG → "electricity"
  Map SoCalGas / National Grid Gas / Nicor → "gas"
  Default to "other" only when no category fits.

is_confirmation
  Set to true when the email is a payment receipt, payment confirmation, autopay
  notice, "Thank you for paying", "Your payment is scheduled" or "Your payment
  was received" message. These are NOT new invoices — they report a payment
  already made or scheduled.
  Set to false for genuine new bills / statements / "bill is ready" notices.
  EXCEPTION — LADWP: LADWP never sends "bill ready" emails; their "Payment
  Received (Confirmation)" email is the ONLY billing record that exists. For
  emails from LADWP set is_confirmation to false, utility_type to
  "electricity", and extract the "Payment Amount" as amount_due.

property_address
  Return the SERVICE address — the address where utility is delivered.
  Do NOT return the utility company's own mailing address or headquarters.
  Selection priority:
    1. Full service address (e.g. "4750 Lincoln Blvd, Marina Del Rey, CA 90292")
    2. Partial street only (e.g. "Lincoln Blvd") — if no full address exists
    3. Property/building name (e.g. "The Palms") — if no address at all
    4. null — only if there is truly no property reference in the email
  Format: Title Case canonical form — e.g. "472 9th Ave, New York, NY 10018".
  Do NOT include apartment / unit identifiers in this field (see unit below).
  Normalize ALL-CAPS addresses (e.g. "360 W PICO RD") to Title Case
  (e.g. "360 W Pico Rd").

unit
  Apartment or unit designator ONLY — e.g. "Apt 2", "Unit 4B", "#3".
  If the address contains "Apt", "Unit", "Suite", "#" followed by an identifier,
  strip it from property_address and place it here.
  Preserve the EXACT designator as written: "3FL" stays "3FL" (floor 3), "2R"
  stays "2R", "4D" stays "4D". Do NOT simplify "3FL" to "3" — in NYC multi-unit
  buildings (e.g. 472 9th Ave, 478 9th Ave, 607 2nd Ave) different units have
  separate accounts and the exact designator is what tells them apart.
  Return null if no unit is present.

account_last4
  Extract exactly the LAST 4 digits of the account or service number.
  Examples:
    "Account XXXXXXX88108" → "8108"
    "Account #xxx-12345"   → "2345"
    "*****1234"            → "1234"
    "xxxxxxx1234"          → "1234"
  Always exactly 4 digits. If you cannot isolate 4 clean digits, return null.

amount_due
  The amount currently owed on this bill — a positive number, no currency symbol.
  For "bill is ready" notifications that contain no dollar amount, return null.
  Do NOT return an amount that was already paid or a balance of $0.00.
  If the email lists multiple amounts (e.g. "Previous balance: $45 | Amount due:
  $112"), return only the current amount due.

due_date
  Due date in ISO format YYYY-MM-DD. Return null if not present.

confidence
  "high" when you are sure which property/unit this bill belongs to (or when
  there is no property reference at all and you returned null).
  "low" when the email is ambiguous about WHICH property or unit it belongs
  to — e.g. multiple addresses appear, the unit designator is unclear, or you
  are guessing. A "low" answer routes the bill to manual review instead of
  silently landing on the wrong unit. When unsure, prefer "low".`;

// Post-parse sanitizer. Last line of defense against prompt drift. Costs zero
// tokens — guarantees that whatever Claude returned satisfies the DB constraints.
// `from` (the email sender) drives provider-specific exceptions like LADWP.
export function sanitize(parsed, from = '') {
  if (!parsed || typeof parsed !== 'object') return null;

  const isLadwp = String(from).toLowerCase().includes('ladwp');

  // 1. Hard-truncate account_last4 to exactly 4 digits.
  if (typeof parsed.account_last4 === 'string') {
    const digits = parsed.account_last4.replace(/\D/g, '');
    parsed.account_last4 = digits.length >= 4 ? digits.slice(-4) : null;
  } else {
    parsed.account_last4 = null;
  }

  // 2. Force unit out of property_address. If Claude leaves "Apt N" embedded
  // in the address (a common drift), move it to unit and clean address.
  if (typeof parsed.property_address === 'string') {
    const aptPattern = /,?\s*(apt\.?|unit|suite|#)\s*([\w-]+)/i;
    const match = parsed.property_address.match(aptPattern);
    if (match) {
      parsed.property_address = parsed.property_address.replace(match[0], '').trim().replace(/,\s*$/, '');
      if (!parsed.unit || !String(parsed.unit).trim()) {
        // Reconstruct unit canonical form (Apt N / Unit N / Suite N)
        const kind = (match[1] || 'Apt').replace(/\.$/, '').replace(/^./, c => c.toUpperCase());
        parsed.unit = `${kind} ${match[2]}`;
      }
    }
  }

  // 3. Title Case normalization for ALL-CAPS addresses.
  if (typeof parsed.property_address === 'string' && /^[A-Z0-9\s,.\-]+$/.test(parsed.property_address) && /[A-Z]{4}/.test(parsed.property_address)) {
    parsed.property_address = parsed.property_address
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\bNy\b/g, 'NY').replace(/\bCa\b/g, 'CA').replace(/\bTx\b/g, 'TX')
      .replace(/\bUsa\b/g, 'USA');
  }

  // 4. amount_due must be a positive finite number.
  if (parsed.amount_due !== null && parsed.amount_due !== undefined) {
    const n = parseFloat(parsed.amount_due);
    parsed.amount_due = (isFinite(n) && n > 0) ? n : null;
  } else {
    parsed.amount_due = null;
  }

  // 5. If this is a payment confirmation, return a sentinel so the sync route
  // skips it cleanly (doesn't insert as a bill, doesn't infinite-retry).
  // EXCEPTION: LADWP only ever sends payment confirmations — that email IS
  // the bill record, so we keep it and mark it as already paid.
  if (parsed.is_confirmation === true && !isLadwp) {
    return { __skip: true, reason: 'payment confirmation', account_last4: parsed.account_last4 };
  }
  if (isLadwp) {
    parsed.utility_type = 'electricity';
    parsed.__paid = true; // autopay already charged — save with status 'paid'
  }

  // 6. Normalize utility_type to the allowed set.
  const allowed = ['electricity', 'internet', 'gas', 'water', 'rent', 'insurance', 'other'];
  if (!allowed.includes(parsed.utility_type)) parsed.utility_type = 'other';

  // 6.5. Low confidence on property/unit → drop both so the bill lands in
  // the "Unassigned" section for Jake to assign manually (and teach the
  // account mapping), instead of silently landing on the wrong unit.
  if (parsed.confidence === 'low') {
    parsed.property_address = null;
    parsed.unit = null;
    parsed.__lowConfidence = true;
  }

  // 7. unit cleanup — trim whitespace, normalize prefix.
  if (typeof parsed.unit === 'string') {
    parsed.unit = parsed.unit.trim().replace(/^#\s*/, '').replace(/^apt\.?\s+/i, 'Apt ').replace(/^unit\s+/i, 'Unit ').replace(/^suite\s+/i, 'Suite ');
    if (!parsed.unit) parsed.unit = null;
  }

  return parsed;
}

// Max base64 size per PDF sent to Claude (~7.5MB binary). The API accepts
// requests up to 32MB / 100 PDF pages; utility bills are 1-5 pages so this
// is generous. The old 200KB cap silently dropped most real bill PDFs.
const MAX_PDF_BASE64 = 10_000_000;

// ── Extract data from an email using Claude ───────────────────────────────────
export async function parseEmail(email) {
  // Attach every usable PDF (lib/gmail.js caps at 3). Fall back to the email
  // body only when there is no attached PDF at all.
  const pdfs = (email.pdfsBase64 || (email.pdfBase64 ? [email.pdfBase64] : []))
    .filter(d => d && d.length < MAX_PDF_BASE64);

  let content;
  if (pdfs.length > 0) {
    content = [
      ...pdfs.map(data => ({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      })),
      {
        type: 'text',
        text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nExtract the utility bill data from the attached PDF${pdfs.length > 1 ? 's' : ''}. The email body is:\n${(email.body || email.snippet || '').slice(0, 4000)}`,
      },
    ];
  } else {
    content = [
      {
        type: 'text',
        text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nEmail body:\n${email.body || email.snippet}`,
      },
    ];
  }

  const response = await client.messages.create({
    model:       'claude-sonnet-4-6',
    max_tokens:  300,
    temperature: 0,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: 'user', content }],
  });

  const text = response.content[0]?.text || '';

  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(clean);
    return sanitize(parsed, email.from);
  } catch {
    console.error('[parser] Claude returned invalid JSON:', text);
    return null;
  }
}

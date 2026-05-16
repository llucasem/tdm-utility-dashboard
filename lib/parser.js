import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a utility bill data extractor for a short-term rental property management company called The Dream Management LLC. They manage ~67 short-term rental properties.

Extract fields from utility bill emails and return ONLY a valid JSON object.

Fields to extract:
- utility_type: one of "electricity", "internet", "gas", "water", "rent", "insurance", "other"
- property_address: the best property identifier you can find. Try in this order:
    1. Full service address (e.g. "4750 Lincoln Blvd, Marina Del Rey, CA 90292") — ideal
    2. Partial address or street name only (e.g. "Genoa", "Lincoln Blvd", "Palm Canyon Dr") — if no full address
    3. Property name or building name (e.g. "The Palms", "Sunset Building") — if no address at all
    4. null — only if there is truly NO property reference anywhere in the email
  IMPORTANT: Do NOT return the utility company's address (e.g. ConEd HQ, SCE office). Only return an address or name that refers to the rental property receiving the service.
- unit: apartment/unit number if present (e.g. "Apt 4B", "Unit 102"), otherwise null
- account_last4: last 5 digits of the account or service number (e.g. from "Account XXXXXXX88108" extract "88108"), otherwise null
- amount_due: numeric amount to pay (just the number, no currency symbol), or null
- due_date: due date in ISO format YYYY-MM-DD, or null

Return ONLY the JSON object, no markdown, no explanation.`;

// ── Extract data from an email using Claude ───────────────────────────────────
export async function parseEmail(email) {
  let content;

  // Only send the PDF if it's small (< 200KB base64 ≈ 1-2 page bill)
  const pdfIsSmall = email.pdfBase64 && email.pdfBase64.length < 200000;

  if (pdfIsSmall) {
    // Has a manageable PDF attachment → send the PDF to Claude directly
    content = [
      {
        type: 'document',
        source: {
          type:       'base64',
          media_type: 'application/pdf',
          data:       email.pdfBase64,
        },
      },
      {
        type: 'text',
        text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nExtract the utility bill data from the attached PDF.`,
      },
    ];
  } else {
    // No PDF → send the email body
    content = [
      {
        type: 'text',
        text: `Email subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\nEmail body:\n${email.body || email.snippet}`,
      },
    ];
  }

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content }],
  });

  const text = response.content[0]?.text || '';

  try {
    // Limpiar posible envoltorio markdown (```json ... ```)
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('[parser] Claude returned invalid JSON:', text);
    return null;
  }
}

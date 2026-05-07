import Anthropic from '@anthropic-ai/sdk';
import { listClasses } from '@/lib/quickbooks';
import pool from '@/lib/db';

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * POST /api/property-qb-class/suggest
 * Optional body: { propertyAddresses: ["...", "..."] } to limit suggestions.
 *
 * Asks Claude to propose a QuickBooks Class for each property.
 * Does NOT save anything — returns suggestions for the human to confirm.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const filterAddresses = Array.isArray(body.propertyAddresses) ? body.propertyAddresses : null;

    // 1. Pull distinct (property_address, unit) pairs
    const propsRes = await pool.query(`
      SELECT DISTINCT property_address, COALESCE(unit, '') AS unit
      FROM utility_bills
      WHERE property_address IS NOT NULL AND TRIM(property_address) != ''
      ${filterAddresses ? `AND property_address = ANY($1::text[])` : ''}
      ORDER BY property_address, unit
    `, filterAddresses ? [filterAddresses] : []);

    const properties = propsRes.rows;
    if (properties.length === 0) {
      return Response.json({ ok: true, suggestions: [] });
    }

    // 2. Fetch QB Classes
    const classes = await listClasses();
    const classList = classes.map(c => ({ id: c.Id, name: c.Name, fullName: c.FullyQualifiedName }));

    // 3. Build prompt for Claude
    const propsText = properties.map((p, i) =>
      `${i + 1}. address="${p.property_address}" unit="${p.unit || '(none)'}"`
    ).join('\n');
    const classesText = classList.map((c, i) =>
      `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) || ''}. id="${c.id}" name="${c.name}" full="${c.fullName}"`
    ).join('\n');

    const prompt = `You are matching property addresses to QuickBooks Class names for a property management company.

PROPERTIES TO MATCH:
${propsText}

AVAILABLE QUICKBOOKS CLASSES:
${classesText}

Rules:
- For each property, pick the QB Class whose name most plausibly refers to the same physical building.
- Consider street numbers, street names, abbreviations (Blvd vs Boulevard, St vs Street), and unit numbers.
- If two QB Classes look equally plausible, prefer the one that also matches the unit if specified.
- If no QB Class plausibly matches, set qb_class_id and qb_class_name to null and confidence to 0.
- Confidence: 0.95+ = clear match, 0.7-0.95 = likely, 0.5-0.7 = guess, <0.5 = no match.

Return ONLY a JSON array (no markdown, no commentary). Each element corresponds to one property in the order given:
[
  {
    "property_address": "...",
    "unit": "...",
    "qb_class_id": "..." or null,
    "qb_class_name": "..." or null,
    "confidence": 0.0 to 1.0,
    "reasoning": "<short>"
  }
]`;

    const res = await ai.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text = res.content[0]?.text || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let suggestions;
    try {
      suggestions = JSON.parse(cleaned);
    } catch {
      return Response.json({
        ok: false,
        error: 'Could not parse Claude response as JSON',
        raw: cleaned.slice(0, 500),
      }, { status: 500 });
    }

    return Response.json({ ok: true, suggestions, classes: classList });

  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

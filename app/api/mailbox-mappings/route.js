import pool from '@/lib/db';
import { assignMailbox } from '@/lib/airtable-sync';

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT mailbox, property_address, unit, assigned_by, created_at, updated_at
         FROM mailbox_property_map
        ORDER BY mailbox ASC`
    );
    return Response.json({
      ok: true,
      mappings: result.rows.map((r) => ({
        mailbox:    r.mailbox,
        property:   r.property_address,
        unit:       r.unit,
        assignedBy: r.assigned_by,
        createdAt:  r.created_at,
        updatedAt:  r.updated_at,
      })),
    });
  } catch (e) {
    console.error('[mailbox-mappings GET]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// Coerce to trimmed string or empty — protects against clients sending
// numbers / objects / null without 500-ing on .trim().
function asTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export async function POST(request) {
  try {
    const body = await request.json();
    const mailbox    = asTrimmedString(body.mailbox);
    const property   = asTrimmedString(body.property_address);
    const unit       = asTrimmedString(body.unit) || null;
    const assignedBy = asTrimmedString(body.assigned_by) || null;

    if (!mailbox) {
      return Response.json({ ok: false, error: 'mailbox is required (string)' }, { status: 400 });
    }
    if (!property) {
      return Response.json({ ok: false, error: 'property_address is required (string)' }, { status: 400 });
    }

    const result = await assignMailbox({
      mailbox,
      property_address: property,
      unit,
      assigned_by: assignedBy,
    });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error('[mailbox-mappings POST]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

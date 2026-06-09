import pool from '@/lib/db';
import { applyResolverToHistory } from '@/lib/landlord-resolver';

/**
 * GET — list all landlord rows with stats: # of payments per landlord and
 * how many of those are already assigned to a property.
 *
 * Response shape:
 *   { ok, landlords: [{ landlord, mailbox, property_address, unit, notes,
 *                       totalPayments, assigned, unassigned }] }
 */
export async function GET() {
  try {
    const rows = await pool.query(
      `WITH stats AS (
         SELECT landlord,
                COUNT(*) FILTER (WHERE amount_paid > 0) AS total,
                COUNT(*) FILTER (WHERE amount_paid > 0 AND property_address IS NOT NULL) AS assigned
           FROM rent_payments
          WHERE landlord IS NOT NULL
          GROUP BY landlord
       )
       SELECT m.landlord, m.mailbox, m.property_address, m.unit, m.notes,
              m.created_at, m.updated_at,
              COALESCE(s.total, 0)    AS total_payments,
              COALESCE(s.assigned, 0) AS assigned_payments
         FROM landlord_property_map m
         LEFT JOIN stats s ON s.landlord = m.landlord
        ORDER BY m.landlord ASC, m.mailbox ASC`
    );

    const landlords = rows.rows.map((r) => ({
      landlord:         r.landlord,
      mailbox:          r.mailbox,
      property:         r.property_address,
      unit:             r.unit,
      notes:            r.notes,
      totalPayments:    parseInt(r.total_payments, 10),
      assigned:         parseInt(r.assigned_payments, 10),
      isDefault:        r.mailbox === '',
      isPlaceholder:    !r.property_address,
    }));

    return Response.json({ ok: true, landlords });
  } catch (e) {
    console.error('[landlord-mappings GET]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * POST — upsert one landlord mapping row, then propagate to history.
 * Body: { landlord, mailbox?, property_address, unit?, notes? }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const landlord = asStr(body.landlord);
    const mailbox  = asStr(body.mailbox);     // '' = default
    const property = asStr(body.property_address);
    const unit     = asStr(body.unit) || null;
    const notes    = asStr(body.notes) || null;

    if (!landlord) {
      return Response.json({ ok: false, error: 'landlord is required' }, { status: 400 });
    }
    if (!property) {
      return Response.json({ ok: false, error: 'property_address is required' }, { status: 400 });
    }

    await pool.query(
      `INSERT INTO landlord_property_map (landlord, mailbox, property_address, unit, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (landlord, mailbox) DO UPDATE
         SET property_address = EXCLUDED.property_address,
             unit             = EXCLUDED.unit,
             notes            = EXCLUDED.notes,
             updated_at       = NOW()`,
      [landlord, mailbox, property, unit, notes]
    );

    // Apply to historical rent payments for this landlord
    const result = await applyResolverToHistory({ onlyLandlord: landlord });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error('[landlord-mappings POST]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/**
 * DELETE — remove a row. Body: { landlord, mailbox }.
 * Does NOT touch rent_payments — historical assignments stay.
 */
export async function DELETE(request) {
  try {
    const body = await request.json();
    const landlord = asStr(body.landlord);
    const mailbox  = asStr(body.mailbox);

    if (!landlord) {
      return Response.json({ ok: false, error: 'landlord is required' }, { status: 400 });
    }

    const res = await pool.query(
      `DELETE FROM landlord_property_map WHERE landlord = $1 AND mailbox = $2`,
      [landlord, mailbox]
    );
    return Response.json({ ok: true, deleted: res.rowCount });
  } catch (e) {
    console.error('[landlord-mappings DELETE]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

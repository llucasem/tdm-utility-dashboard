import pool from '@/lib/db';

/**
 * GET /api/property-qb-class
 * Returns:
 *  - properties: every distinct (property_address, unit) pair seen in utility_bills
 *  - mappings:   the saved property_address -> qb_class_id rows
 *
 * The frontend joins both client-side to render the matrix.
 */
export async function GET() {
  try {
    const props = await pool.query(`
      SELECT DISTINCT
        property_address,
        COALESCE(unit, '') AS unit
      FROM utility_bills
      WHERE property_address IS NOT NULL AND TRIM(property_address) != ''
      ORDER BY property_address, unit
    `);

    const maps = await pool.query(`
      SELECT id, property_address, unit, qb_class_id, qb_class_name, updated_at
      FROM property_qb_class
    `);

    return Response.json({
      ok:         true,
      properties: props.rows,
      mappings:   maps.rows,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/property-qb-class
 * body: { property_address, unit, qb_class_id, qb_class_name }
 * Upsert by (property_address, COALESCE(unit, '')).
 */
export async function POST(request) {
  try {
    const { property_address, unit, qb_class_id, qb_class_name } = await request.json();
    if (!property_address || !qb_class_id || !qb_class_name) {
      return Response.json({ ok: false, error: 'property_address, qb_class_id and qb_class_name are required' }, { status: 400 });
    }

    const r = await pool.query(`
      INSERT INTO property_qb_class (property_address, unit, qb_class_id, qb_class_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (property_address, COALESCE(unit, ''))
      DO UPDATE SET
        qb_class_id   = EXCLUDED.qb_class_id,
        qb_class_name = EXCLUDED.qb_class_name,
        updated_at    = NOW()
      RETURNING id
    `, [property_address.trim(), (unit || '').trim() || null, qb_class_id, qb_class_name]);

    return Response.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/**
 * DELETE /api/property-qb-class
 * body: { property_address, unit }
 */
export async function DELETE(request) {
  try {
    const { property_address, unit } = await request.json();
    if (!property_address) {
      return Response.json({ ok: false, error: 'property_address is required' }, { status: 400 });
    }
    await pool.query(
      `DELETE FROM property_qb_class WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')`,
      [property_address.trim(), (unit || '').trim() || null]
    );
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

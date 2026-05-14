import pool from '@/lib/db';

/**
 * GET /api/review-flags — list unresolved review flags.
 *
 * Returns the same shape the admin page expects: an array of flag objects
 * including their database id (used as the dismiss key going forward).
 */
export async function GET() {
  try {
    const r = await pool.query(`
      SELECT id, tag, utility_type, provider, address, unit, account_last4, note, addresses
      FROM review_flags
      WHERE resolved_at IS NULL
      ORDER BY created_at ASC
    `);
    return Response.json({ ok: true, flags: r.rows });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/review-flags?id=123  — mark a flag as resolved.
 * Also accepts ?index=N for backwards compatibility with the JSON-file era.
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id    = parseInt(searchParams.get('id'), 10);
    const index = parseInt(searchParams.get('index'), 10);

    if (Number.isInteger(id) && id > 0) {
      const r = await pool.query(
        `UPDATE review_flags SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
        [id]
      );
      if (r.rowCount === 0) return Response.json({ ok: false, error: 'Flag not found' }, { status: 404 });
    } else if (Number.isInteger(index) && index >= 0) {
      // Legacy fallback: resolve the Nth unresolved flag in created_at order
      const r = await pool.query(`
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 AS pos
          FROM review_flags WHERE resolved_at IS NULL
        )
        UPDATE review_flags SET resolved_at = NOW()
        WHERE id = (SELECT id FROM ordered WHERE pos = $1)
        RETURNING id
      `, [index]);
      if (r.rowCount === 0) return Response.json({ ok: false, error: 'Invalid index' }, { status: 400 });
    } else {
      return Response.json({ ok: false, error: 'id or index required' }, { status: 400 });
    }

    const remaining = await pool.query(`SELECT COUNT(*)::int AS n FROM review_flags WHERE resolved_at IS NULL`);
    return Response.json({ ok: true, remaining: remaining.rows[0].n });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

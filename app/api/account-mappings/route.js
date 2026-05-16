import pool from '@/lib/db';

// GET — devuelve todos los mappings existentes
export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, utility_type, provider, account_last4, property_address, unit
       FROM account_mappings
       ORDER BY utility_type, provider, account_last4`
    );
    return Response.json({ ok: true, mappings: result.rows });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// POST — saves a new mapping and updates existing bills using that account
export async function POST(request) {
  try {
    const { utility_type, provider, account_last4, property_address, unit } = await request.json();

    if (!utility_type || !account_last4 || !property_address) {
      return Response.json({ ok: false, error: 'utility_type, account_last4 and property_address are required' }, { status: 400 });
    }

    // Insert or update the mapping
    await pool.query(
      `INSERT INTO account_mappings (utility_type, provider, account_last4, property_address, unit)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (utility_type, account_last4) DO UPDATE
         SET provider         = EXCLUDED.provider,
             property_address = EXCLUDED.property_address,
             unit             = EXCLUDED.unit`,
      [utility_type, provider || null, account_last4, property_address, unit || null]
    );

    // Update any existing bills with this account and no address
    const updated = await pool.query(
      `UPDATE utility_bills
       SET property_address = $1,
           unit             = COALESCE(unit, $2)
       WHERE utility_type  = $3
         AND account_last4 = $4
         AND (property_address IS NULL OR property_address = '(no address)')
       RETURNING id`,
      [property_address, unit || null, utility_type, account_last4]
    );

    return Response.json({ ok: true, billsUpdated: updated.rowCount });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

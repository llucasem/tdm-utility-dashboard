import pool from '@/lib/db';

/**
 * Mapeos cuenta -> propiedad para la pantalla de administracion.
 *
 * Desde el 14/08/2026 leen y escriben en account_registry, la unica fuente de
 * verdad. La tabla account_mappings quedo retirada: convivian dos tablas
 * haciendo el mismo trabajo y ninguna mandaba.
 */

// GET — todos los mapeos, con su nivel de confianza
export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, utility_type, provider, account_last4, property_address, unit,
              confidence, locked, bills_seen, typical_amount, alternatives, notes
         FROM account_registry
        ORDER BY (confidence = 'manual') DESC, utility_type, provider, account_last4`
    );
    return Response.json({ ok: true, mappings: result.rows });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// POST — guarda un mapeo hecho por una persona y lo aplica a las facturas
// existentes de esa cuenta que estuvieran sin asignar.
export async function POST(request) {
  try {
    const { utility_type, provider, account_last4, property_address, unit } = await request.json();

    if (!utility_type || !account_last4 || !property_address) {
      return Response.json({ ok: false, error: 'utility_type, account_last4 and property_address are required' }, { status: 400 });
    }

    // locked: lo que decide una persona no lo pisa ninguna pasada automatica.
    await pool.query(
      `INSERT INTO account_registry
         (utility_type, account_last4, provider, property_address, unit,
          confidence, locked, bills_seen, notes, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'manual', true, 0, $6, now(), now())
       ON CONFLICT (utility_type, account_last4) DO UPDATE
         SET provider         = EXCLUDED.provider,
             property_address = EXCLUDED.property_address,
             unit             = EXCLUDED.unit,
             confidence       = 'manual',
             locked           = true,
             notes            = EXCLUDED.notes,
             updated_at       = now()`,
      [utility_type, account_last4, provider || null, property_address, unit || null,
       `Asignada a mano desde administracion el ${new Date().toISOString().slice(0, 10)}.`]
    );

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

import pool from '@/lib/db';

// GET — returns unique accounts that have bills without an assigned address
export async function GET() {
  try {
    const result = await pool.query(
      `SELECT
         utility_type,
         account_last4,
         COUNT(*)                                        AS bill_count,
         MIN(amount_due)                                 AS amount_min,
         MAX(amount_due)                                 AS amount_max,
         MIN(email_received_at)                          AS date_min,
         MAX(email_received_at)                          AS date_max,
         STRING_AGG(DISTINCT email_from, ', '
           ORDER BY email_from)                          AS senders,
         MIN(email_subject)                              AS email_subject
       FROM utility_bills
       WHERE account_last4 IS NOT NULL
         AND (property_address IS NULL OR property_address = '(no address)')
         -- Cuentas que el registro todavia no resuelve. Las provisionales o en
         -- conflicto SI aparecen aqui: el sync no las usa para asignar, asi
         -- que siguen necesitando que una persona las confirme.
         AND NOT EXISTS (
           SELECT 1 FROM account_registry ar
           WHERE ar.utility_type  = utility_bills.utility_type
             AND ar.account_last4 = utility_bills.account_last4
             AND (
               (ar.property_address IS NOT NULL
                 AND ar.confidence IN ('solida', 'mayoria', 'manual'))
               -- Una fila locked sin propiedad significa que una persona ya
               -- decidio sobre esta cuenta (p.ej. "inactiva", Jake 19/08/2026
               -- sobre ConEd ····0121). No volver a preguntar.
               OR ar.locked
             )
         )
       GROUP BY utility_type, account_last4
       ORDER BY utility_type, account_last4`
    );
    return Response.json({ ok: true, accounts: result.rows });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

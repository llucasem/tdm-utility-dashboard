/**
 * Resolve a rent payment to a property+unit using the landlord mapping.
 *
 * Lookup order (first hit wins):
 *   1. Exact (landlord, mailbox) — handles mailboxes that span multiple
 *      buildings AND for mailbox aliases that encode the unit number.
 *   2. (landlord, '') — the default mapping for that landlord.
 *
 * Returns { property_address, unit, source } or null if nothing matches.
 */

import pool from './db.js';

export async function resolveLandlord({ landlord, mailbox }) {
  if (!landlord) return null;

  // 1. Exact mailbox match — only consider rows where property is set, since
  // a "(landlord, mailbox) with NULL property" is just a unit-only override
  // that needs to combine with the landlord-default property.
  if (mailbox) {
    const specific = await pool.query(
      `SELECT property_address, unit FROM landlord_property_map
        WHERE landlord = $1 AND mailbox = $2 LIMIT 1`,
      [landlord, mailbox]
    );
    if (specific.rows.length) {
      const row = specific.rows[0];
      // If the alias-row has a unit but no property, combine with the landlord
      // default property.
      if (!row.property_address) {
        const def = await pool.query(
          `SELECT property_address FROM landlord_property_map
            WHERE landlord = $1 AND mailbox = '' AND property_address IS NOT NULL LIMIT 1`,
          [landlord]
        );
        if (def.rows[0]?.property_address) {
          return {
            property_address: def.rows[0].property_address,
            unit:             row.unit,
            source:           'landlord_alias+default',
          };
        }
        return null;  // alias row has unit but no default property yet
      }
      return {
        property_address: row.property_address,
        unit:             row.unit,
        source:           'landlord_exact',
      };
    }
  }

  // 2. Landlord default
  const def = await pool.query(
    `SELECT property_address, unit FROM landlord_property_map
      WHERE landlord = $1 AND mailbox = '' AND property_address IS NOT NULL LIMIT 1`,
    [landlord]
  );
  if (def.rows.length) {
    return {
      property_address: def.rows[0].property_address,
      unit:             def.rows[0].unit,
      source:           'landlord_default',
    };
  }

  return null;
}

/**
 * Apply resolver to all existing rent_payments rows whose property_address
 * is currently NULL but whose landlord is set. Returns { updated, skipped }.
 *
 * Used by:
 *   - Backfill script after seeding new landlord mappings
 *   - Admin UI when a landlord row is updated (so the change propagates
 *     to historical payments)
 */
export async function applyResolverToHistory({ onlyLandlord = null } = {}) {
  const filter = onlyLandlord ? `AND landlord = $1` : '';
  const params = onlyLandlord ? [onlyLandlord] : [];
  const candidates = await pool.query(
    `SELECT id, landlord, mailbox FROM rent_payments
      WHERE landlord IS NOT NULL
        AND (property_address IS NULL OR unit IS NULL)
        ${filter}`,
    params
  );

  let updated = 0, skipped = 0;
  for (const row of candidates.rows) {
    const r = await resolveLandlord({ landlord: row.landlord, mailbox: row.mailbox });
    if (!r) { skipped++; continue; }
    // Only overwrite NULL — never overwrite a value that was already populated
    // (preserves any manual assignments).
    await pool.query(
      `UPDATE rent_payments
          SET property_address = COALESCE(property_address, $1),
              unit             = COALESCE(unit, $2)
        WHERE id = $3`,
      [r.property_address, r.unit, row.id]
    );
    updated++;
  }
  return { candidates: candidates.rows.length, updated, skipped };
}

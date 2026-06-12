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

/**
 * Resolve a rent payment to property+unit via the alias map (rent_alias_map),
 * built from crossing portal confirmation emails with Jake's QB Classes
 * (scripts/build-rent-alias-map.mjs). The mailbox alias is the primary key;
 * the amount disambiguates aliases that pay several units (e.g. one "tenant"
 * gmail paying both AO #627 and PORTOFINO #410 through Bilt).
 *
 * Conservative by design: returns null on any ambiguity (weird amount, two
 * units in range) so the payment lands in review instead of on a wrong unit.
 */
export async function resolveRentAlias({ mailbox, amount, landlord = null }) {
  if (!mailbox) return null;
  const { rows } = await pool.query(
    `SELECT property_address, unit, qb_class_name,
            amount_min::float AS amount_min, amount_max::float AS amount_max
       FROM rent_alias_map WHERE mailbox = $1`,
    [mailbox]
  );
  if (rows.length === 0) return null;
  const amt = Number(amount);
  const hit = r => ({ property_address: r.property_address, unit: r.unit, source: 'rent_alias_map' });

  if (rows.length === 1) {
    const r = rows[0];
    // Single-unit alias: accept with generous bounds (rents drift on renewal).
    // Out-of-bounds amounts (fees, deposits, double months) go to review.
    if (!amt || (amt >= r.amount_min * 0.9 && amt <= r.amount_max * 1.15)) return hit(r);
    return null;
  }

  // Multi-unit alias: the amount picks the unit.
  const inRange = rows.filter(r => amt && amt >= r.amount_min * 0.97 && amt <= r.amount_max * 1.05);
  if (inRange.length === 1) return hit(inRange[0]);

  // Tiebreak: a distinctive word from the landlord name appearing in exactly
  // one class name ("PR SM Sorrento LLC" → "SORRENTO #510").
  if (landlord) {
    const tokens = String(landlord).toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !['apartments', 'realty'].includes(t));
    const candidates = inRange.length > 1 ? inRange : rows;
    const byLandlord = candidates.filter(r => tokens.some(t => (r.qb_class_name || '').toLowerCase().includes(t)));
    if (byLandlord.length === 1) return hit(byLandlord[0]);
  }

  // Nearest range, but only with a clear margin over the runner-up.
  if (amt && rows.length >= 2) {
    const dist = r => (amt < r.amount_min ? r.amount_min - amt : (amt > r.amount_max ? amt - r.amount_max : 0));
    const sorted = rows.slice().sort((a, b) => dist(a) - dist(b));
    if (dist(sorted[0]) <= sorted[0].amount_max * 0.05 && dist(sorted[1]) - dist(sorted[0]) > 150) {
      return hit(sorted[0]);
    }
  }
  return null;
}

/**
 * Migration — landlord_property_map.
 *
 * Auto-assigns rent payments by landlord (and optionally mailbox).
 * Replaces the brittle mailbox→property assumption, because some mailboxes
 * pay for multiple properties (e.g. gilmarvalencia69@gmail.com handles
 * 4 different landlords).
 *
 * Composite key: (landlord, mailbox). When mailbox is empty string '' the
 * row is the default for that landlord regardless of mailbox.
 *
 *   Lookup order:
 *     1. Exact (landlord, mailbox) match
 *     2. Fallback to (landlord, '')
 *
 * Idempotent — safe to re-run.
 */
import pool from '../lib/db.js';

async function run() {
  console.log('── Migration: landlord_property_map ──\n');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS landlord_property_map (
      landlord          TEXT NOT NULL,
      mailbox           TEXT NOT NULL DEFAULT '',
      property_address  TEXT,
      unit              TEXT,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (landlord, mailbox)
    )
  `);
  console.log('✓ landlord_property_map table');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_landlord_map_landlord ON landlord_property_map(landlord)`);
  console.log('✓ landlord index');

  // ── Pre-populate from extracted data ──────────────────────────
  // For these 4 landlords we have high-confidence property+unit info already
  // extracted by Claude — load them as the defaults (mailbox='').
  const seeds = [
    {
      landlord: 'Margit Realty LLC',
      property_address: '312 E 93rd Street, New York, NY',
      unit: '3A',
      notes: 'auto-derived from Claude extraction (3 payments, single mailbox alguaciljuan00@gmail.com)',
    },
    {
      landlord: 'Riva',
      property_address: '1420 5th St, Santa Monica, CA 90401',
      unit: '501',
      notes: 'auto-derived (1420 5th St Apt 501 — also payable via VRS / Riva-Verbena variant)',
    },
    {
      landlord: 'Riva- Verbena WRC 5th LP',
      property_address: '1420 5th St, Santa Monica, CA 90401',
      unit: '501',
      notes: 'legal entity for Riva — same building, same unit',
    },
    {
      landlord: 'Arrive Seaside I',
      property_address: '1548 6th Street, Santa Monica, CA 90401',
      unit: '306',
      notes: 'auto-derived from Claude (mailbox surgeyflores@gmail.com)',
    },
  ];

  for (const s of seeds) {
    await pool.query(
      `INSERT INTO landlord_property_map (landlord, mailbox, property_address, unit, notes)
       VALUES ($1, '', $2, $3, $4)
       ON CONFLICT (landlord, mailbox) DO UPDATE
         SET property_address = EXCLUDED.property_address,
             unit             = EXCLUDED.unit,
             notes            = EXCLUDED.notes,
             updated_at       = NOW()`,
      [s.landlord, s.property_address, s.unit, s.notes]
    );
    console.log(`  ✓ seeded: ${s.landlord} → ${s.property_address} (unit ${s.unit})`);
  }

  // Stub rows (no address yet) for landlords we KNOW exist but need Edonis
  // input. These appear in the admin UI immediately as "needs address".
  const stubs = [
    '6th ST. Lofts, LLC',
    'Tierra del Rey',
    'Jefferson at Marina Del Rey',
    'AvalonBay',
    'PR SM Sorrento LLC',
    'VRS Arrezo Apartments LLC',
    'VRS Genoa Apartments LLC',
    'VRS Portofino LLC',
  ];
  for (const landlord of stubs) {
    await pool.query(
      `INSERT INTO landlord_property_map (landlord, mailbox, property_address, unit, notes)
       VALUES ($1, '', NULL, NULL, 'PLACEHOLDER — Edonis needs to provide the property address and units rented')
       ON CONFLICT (landlord, mailbox) DO NOTHING`,
      [landlord]
    );
    console.log(`  ◌ stub:   ${landlord}`);
  }

  // ── Special seeds: per-mailbox overrides ──────────────────────
  // The 939broadway+NNN@thedreammanagement.com aliases encode the unit
  // in the alias itself. If 6th ST. Lofts is ever assigned an address,
  // these per-mailbox rules let the unit auto-resolve.
  // Seeded with NULL property so they don't activate until Edonis fills 6th ST. Lofts.
  const aliasSeeds = [
    { mailbox: '939broadway+606@thedreammanagement.com', unit: '606' },
    { mailbox: '939broadway+607@thedreammanagement.com', unit: '607' },
    { mailbox: '939broadway+806@thedreammanagement.com', unit: '806' },
    { mailbox: '939broadway+m3@thedreammanagement.com',  unit: 'M3'  },
    { mailbox: '939broadway+8066@thedreammanagement.com', unit: '8066' },
  ];
  for (const a of aliasSeeds) {
    await pool.query(
      `INSERT INTO landlord_property_map (landlord, mailbox, property_address, unit, notes)
       VALUES ('6th ST. Lofts, LLC', $1, NULL, $2, 'Unit derived from mailbox alias 939broadway+NNN')
       ON CONFLICT (landlord, mailbox) DO UPDATE
         SET unit  = EXCLUDED.unit,
             notes = EXCLUDED.notes,
             updated_at = NOW()`,
      [a.mailbox, a.unit]
    );
    console.log(`  + alias:  6th ST. Lofts × ${a.mailbox} → unit ${a.unit}`);
  }

  // Final count
  const r = await pool.query(`SELECT COUNT(*) FROM landlord_property_map`);
  console.log(`\n  ${r.rows[0].count} rows in landlord_property_map`);

  await pool.end();
  console.log('\nDone.');
}

run().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

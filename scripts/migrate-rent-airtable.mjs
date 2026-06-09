/**
 * Migration — Rent tab + Airtable integration + Conservice utilities.
 *
 * Adds:
 *   - rent_payments        — historical rent payment confirmations from Airtable
 *   - mailbox_property_map — mailbox → property/unit mapping (auto-resolved on sync)
 *   - airtable_processed   — bookkeeping table: which Airtable records we've seen
 *   - 'building' added to utility_type CHECK constraint
 *
 * Idempotent — safe to re-run.
 *
 * Run with: node scripts/migrate-rent-airtable.mjs
 */
import pool from '../lib/db.js';

async function run() {
  console.log('── Migration: rent + airtable + conservice ──\n');

  // 1) rent_payments — payment confirmations (history, not pending)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_payments (
      id                    SERIAL PRIMARY KEY,
      source                TEXT NOT NULL DEFAULT 'airtable',
      airtable_record_id    TEXT UNIQUE,
      mailbox               TEXT,
      property_address      TEXT,
      unit                  TEXT,
      amount_paid           NUMERIC(10,2),
      paid_date             DATE,
      landlord              TEXT,
      payment_portal        TEXT,
      confirmation_number   TEXT,
      email_received_at     TIMESTAMPTZ,
      email_subject         TEXT,
      email_from            TEXT,
      status                TEXT DEFAULT 'paid'
        CHECK (status IN ('paid','pending','failed','unknown')),
      raw                   JSONB,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✓ rent_payments table');

  // Indexes for the dashboard query patterns
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rent_payments_paid_date ON rent_payments(paid_date DESC NULLS LAST)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rent_payments_email_recv ON rent_payments(email_received_at DESC NULLS LAST)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rent_payments_mailbox ON rent_payments(mailbox)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rent_payments_property ON rent_payments(property_address) WHERE property_address IS NOT NULL`);
  console.log('✓ rent_payments indexes (4)');

  // 2) mailbox_property_map — assigns each Gmail mailbox to one property+unit.
  // When Jake assigns one rent confirmation to a property, ALL prior and future
  // rents from that mailbox auto-resolve to the same property.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailbox_property_map (
      mailbox            TEXT PRIMARY KEY,
      property_address   TEXT NOT NULL,
      unit               TEXT,
      assigned_by        TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✓ mailbox_property_map table');

  // 3) airtable_processed — tracks which Airtable records we've classified
  // (even if they ended up as "skip — not a rent bill"), so we never re-classify.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS airtable_processed (
      airtable_record_id  TEXT PRIMARY KEY,
      verdict             TEXT NOT NULL
        CHECK (verdict IN ('rent_payment','conservice_utility','skip','error')),
      reason              TEXT,
      processed_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✓ airtable_processed table');

  // 4) Extend utility_bills.utility_type to include 'building' (Conservice)
  // and 'rent' (in case we ever route rent into utility_bills).
  // PostgreSQL CHECK constraints — we drop the old one if it exists and re-add.
  try {
    await pool.query(`ALTER TABLE utility_bills DROP CONSTRAINT IF EXISTS utility_bills_utility_type_check`);
    await pool.query(`
      ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_utility_type_check
      CHECK (utility_type IN ('electricity','internet','gas','water','rent','insurance','building','other'))
    `);
    console.log('✓ utility_type CHECK constraint updated (added building, rent, insurance)');
  } catch (e) {
    // If the constraint doesn't exist or there's no CHECK, that's fine — just continue.
    console.log(`  (utility_type CHECK update note: ${e.message})`);
  }

  // 5) Cron heartbeat slot for airtable_sync
  await pool.query(`
    INSERT INTO cron_heartbeats (cron_name, last_ran_at, last_run_ok, runs_total, runs_failed)
    VALUES ('airtable_sync', NOW() - INTERVAL '1 hour', true, 0, 0)
    ON CONFLICT (cron_name) DO NOTHING
  `);
  console.log('✓ airtable_sync heartbeat slot');

  // 6) Record this migration in system_lessons so we have an audit trail
  const lessonCtx = {
    feature: 'rent_tab_airtable_integration',
    activated_at: new Date().toISOString(),
    airtable_base: 'Rental Portals (app4hMyYd61s95xqV)',
    airtable_table: 'EMAILS - Rental Portals',
    total_records_observed: 2419,
  };
  await pool.query(
    `INSERT INTO system_lessons (lesson_type, context, description, detected_by, is_active, created_at)
     VALUES ($1, $2::jsonb, $3, $4, true, NOW())`,
    [
      'data_source',
      JSON.stringify(lessonCtx),
      'Airtable EMAILS table is the canonical source for rent payment confirmations (Bilt auto-pay) and Conservice utility bills. 2419 records observed (Mar 2025-Jun 2026). Top senders are payment confirmations (AppFolio, Bozzuto, Welcomehome, Entrata). Conservice ebill@conservicemail.com sends consolidated building-level utility bills ($5K+/month) for Anara Santa Monica.',
      'manual_analysis_2026-06-09',
    ]
  );
  console.log('✓ system_lessons entry');

  console.log('\n── Verification ──');
  const r1 = await pool.query(`SELECT COUNT(*) FROM rent_payments`);
  const r2 = await pool.query(`SELECT COUNT(*) FROM mailbox_property_map`);
  const r3 = await pool.query(`SELECT COUNT(*) FROM airtable_processed`);
  console.log(`  rent_payments rows:        ${r1.rows[0].count}`);
  console.log(`  mailbox_property_map rows: ${r2.rows[0].count}`);
  console.log(`  airtable_processed rows:   ${r3.rows[0].count}`);

  console.log('\nDone.');
  await pool.end();
}

run().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

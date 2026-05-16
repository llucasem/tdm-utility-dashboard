import pool from '@/lib/db';

/**
 * GET /api/health
 *
 * Operational status snapshot. Tells you whether the crons are alive and
 * QB tokens are still good. Designed to be polled (manually or by an
 * external uptime monitor).
 *
 * No secrets in the response — safe to expose, but middleware still
 * requires the session cookie (it's protected like the rest of /api).
 */
export async function GET() {
  try {
    // Most recent bill inserted via sync
    const lastBill = await pool.query(`
      SELECT MAX(created_at) AS ts
      FROM utility_bills
    `);

    // Bills inserted in the last 24h (proxy for "sync did run recently")
    const last24h = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM utility_bills
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    // Most recent successful match (any non-pending status)
    const lastMatch = await pool.query(`
      SELECT MAX(qb_matched_at) AS ts
      FROM utility_bills
      WHERE qb_match_status NOT IN ('pending', NULL)
    `);

    // Most recent auto-tag attempt
    const lastTag = await pool.query(`
      SELECT MAX(tagged_at) AS ts
      FROM quickbooks_tag_log
    `);

    // Most recent learning entry (Phase 3)
    let lastLearn = null;
    try {
      const r = await pool.query(`SELECT MAX(created_at) AS ts FROM class_learning_log`);
      lastLearn = r.rows[0].ts;
    } catch {}

    // QB token freshness
    const tok = await pool.query(`
      SELECT realm_id, refresh_expires_at FROM quickbooks_tokens
      ORDER BY updated_at DESC LIMIT 1
    `);
    const tokenDaysLeft = tok.rowCount > 0
      ? Math.floor((new Date(tok.rows[0].refresh_expires_at).getTime() - Date.now()) / 86_400_000)
      : null;

    // Mapping coverage
    const mappingStats = await pool.query(`
      SELECT
        (SELECT COUNT(DISTINCT (property_address, COALESCE(unit, '')))::int
         FROM utility_bills
         WHERE property_address IS NOT NULL AND TRIM(property_address) != '' AND amount_due > 0) AS properties,
        (SELECT COUNT(*)::int FROM property_qb_class) AS mapped,
        (SELECT COUNT(*)::int FROM property_qb_class WHERE source = 'manual')   AS manual,
        (SELECT COUNT(*)::int FROM property_qb_class WHERE source = 'inferred') AS inferred
    `);
    const m = mappingStats.rows[0];

    // Warnings
    const warnings = [];
    const lastSyncMs = lastBill.rows[0].ts ? (Date.now() - new Date(lastBill.rows[0].ts).getTime()) : Infinity;
    // Threshold: 10 days. Utility emails are bursty — 1-3 day gaps are
    // normal. We only worry after 10 days of complete silence, which would
    // genuinely indicate the cron is broken or Gmail access is lost.
    const lastSyncDays = lastSyncMs / 86_400_000;
    if (lastSyncDays > 10) {
      warnings.push(`sync hasn't inserted a bill in ${Math.floor(lastSyncDays)} days — cron may be dead`);
    }
    if (tokenDaysLeft !== null && tokenDaysLeft < 30) warnings.push(`QB refresh token expires in ${tokenDaysLeft} days`);
    if (m.mapped < m.properties * 0.7) warnings.push(`only ${Math.round(m.mapped / m.properties * 100)}% of properties have a QB Class mapping`);

    return Response.json({
      ok: true,
      status: warnings.length === 0 ? 'healthy' : 'degraded',
      timestamps: {
        last_bill_inserted: lastBill.rows[0].ts,
        last_match_at:      lastMatch.rows[0].ts,
        last_autotag_at:    lastTag.rowCount > 0 ? lastTag.rows[0].ts : null,
        last_learn_at:      lastLearn,
      },
      counts: {
        bills_last_24h:       last24h.rows[0].n,
        properties:           m.properties,
        mappings_total:       m.mapped,
        mappings_manual:      m.manual,
        mappings_inferred:    m.inferred,
      },
      quickbooks: {
        realm_id:                tok.rows[0]?.realm_id || null,
        refresh_token_days_left: tokenDaysLeft,
      },
      warnings,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

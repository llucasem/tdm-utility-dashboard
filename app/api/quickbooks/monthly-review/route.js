import pool from '@/lib/db';
import { createNotification } from '@/lib/notifier';

/**
 * GET /api/quickbooks/monthly-review
 *
 * "Deep" monthly review focused on what the SYSTEM learned and what needs
 * human attention. Complements /api/quickbooks/monthly-report (which is
 * a financial summary).
 *
 * Query params:
 *   ?send=true       create an in-app notification with the review
 *   ?month=YYYY-MM   override (defaults to previous month)
 *
 * What it reports:
 *   - Tag activity (matched/tagged/ambiguous/not_found/skipped)
 *   - Vendors newly learned (added to learned_vendors during the month)
 *   - Bank accounts newly seen
 *   - Class-learning conflicts (Jake disagreeing with our stored Class)
 *   - Drift warnings (auto-tag fired but vendor/account was unknown)
 *   - Bills that stayed ambiguous all month (manual review needed)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const send  = searchParams.get('send') === 'true';
    const month = searchParams.get('month');

    let year, mIdx;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      year = y; mIdx = m - 1;
    } else {
      const now = new Date();
      year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      mIdx = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
    }
    const monthName  = ['January','February','March','April','May','June','July','August','September','October','November','December'][mIdx];
    const monthStart = new Date(Date.UTC(year, mIdx,     1)).toISOString().slice(0, 10);
    const monthEnd   = new Date(Date.UTC(year, mIdx + 1, 0, 23, 59, 59)).toISOString();

    // ── 1. Tag activity for bills received that month ───────────────────────
    const activity = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE qb_tag_status = 'tagged')::int    AS tagged,
        COUNT(*) FILTER (WHERE qb_tag_status = 'ambiguous')::int AS ambiguous,
        COUNT(*) FILTER (WHERE qb_tag_status = 'not_found')::int AS not_found,
        COUNT(*) FILTER (WHERE qb_tag_status = 'skipped')::int   AS skipped,
        COUNT(*) FILTER (WHERE qb_tag_status = 'error')::int     AS errors,
        COUNT(*) FILTER (WHERE qb_tag_status = 'pending')::int   AS pending,
        COUNT(*)::int                                            AS total
      FROM utility_bills
      WHERE amount_due > 0
        AND email_received_at >= $1 AND email_received_at <= $2
    `, [monthStart, monthEnd]);

    // ── 2. Vendors newly added to learned_vendors this month ────────────────
    let newVendors = { rows: [] };
    try {
      newVendors = await pool.query(`
        SELECT utility_type, vendor_substring, sample_count
        FROM learned_vendors
        WHERE created_at >= $1 AND created_at <= $2
        ORDER BY sample_count DESC
      `, [monthStart, monthEnd]);
    } catch { /* table may not exist yet on very first run */ }

    // ── 3. Bank accounts newly added ────────────────────────────────────────
    let newAccounts = { rows: [] };
    try {
      newAccounts = await pool.query(`
        SELECT account_name, sample_count FROM learned_bank_accounts
        WHERE created_at >= $1 AND created_at <= $2
        ORDER BY sample_count DESC
      `, [monthStart, monthEnd]);
    } catch { /* same */ }

    // ── 4. Conflicts in class_learning_log (Jake disagreed with our Class) ─
    let conflicts = { rows: [] };
    try {
      conflicts = await pool.query(`
        SELECT bill_id, qb_class_name, previous_class, details, created_at
        FROM class_learning_log
        WHERE action = 'conflict'
          AND created_at >= $1 AND created_at <= $2
        ORDER BY created_at DESC
        LIMIT 30
      `, [monthStart, monthEnd]);
    } catch { /* class_learning_log may not be created yet */ }

    // ── 5. Drift warnings created this month ────────────────────────────────
    const driftCount = await pool.query(`
      SELECT COUNT(*)::int AS c FROM notifications
      WHERE type = 'warning'
        AND title LIKE 'Auto-tag drift%'
        AND created_at >= $1 AND created_at <= $2
    `, [monthStart, monthEnd]);

    // ── 6. Bills stuck ambiguous all month — need manual review ─────────────
    const stuckAmbiguous = await pool.query(`
      SELECT id, utility_type, amount_due, property_address, unit, email_received_at, qb_match_count
      FROM utility_bills
      WHERE qb_tag_status = 'ambiguous'
        AND email_received_at >= $1 AND email_received_at <= $2
        AND amount_due > 0
      ORDER BY amount_due DESC
      LIMIT 20
    `, [monthStart, monthEnd]);

    // ── Build summary ───────────────────────────────────────────────────────
    const a = activity.rows[0];
    const taggedRate = a.total > 0 ? Math.round((a.tagged / a.total) * 100) : 0;

    const lines = [];
    lines.push(`📊 ${monthName} ${year}: ${a.total} bills processed`);
    lines.push(`✓ ${a.tagged} tagged (${taggedRate}%)`);
    if (a.ambiguous)  lines.push(`⚠ ${a.ambiguous} ambiguous`);
    if (a.not_found)  lines.push(`✗ ${a.not_found} not found`);
    if (a.errors)     lines.push(`! ${a.errors} errors`);
    if (a.pending)    lines.push(`⏳ ${a.pending} pending`);
    if (newVendors.rowCount > 0)  lines.push(`🆕 ${newVendors.rowCount} new vendor patterns learned`);
    if (newAccounts.rowCount > 0) lines.push(`🆕 ${newAccounts.rowCount} new bank accounts learned`);
    if (conflicts.rowCount > 0)   lines.push(`⚠ ${conflicts.rowCount} class conflicts (Jake vs system)`);
    if (driftCount.rows[0].c > 0) lines.push(`⚠ ${driftCount.rows[0].c} drift warnings (unknown vendor/account)`);
    if (stuckAmbiguous.rowCount > 0) lines.push(`👀 ${stuckAmbiguous.rowCount} bills need manual review`);

    const review = {
      month:     `${year}-${String(mIdx + 1).padStart(2, '0')}`,
      monthName: `${monthName} ${year}`,
      activity:  a,
      taggedRate,
      newVendors:      newVendors.rows,
      newAccounts:     newAccounts.rows,
      conflicts:       conflicts.rows,
      driftCount:      driftCount.rows[0].c,
      stuckAmbiguous:  stuckAmbiguous.rows,
      summary:         lines,
    };

    if (send) {
      const type = (a.errors > 0 || conflicts.rowCount > 0 || driftCount.rows[0].c > 0) ? 'warning' : 'info';
      await createNotification({
        type,
        title:    `Monthly review · ${monthName} ${year}`,
        message:  lines.join(' · '),
        metadata: review,
      });
    }

    return Response.json({ ok: true, ...review });
  } catch (e) {
    console.error('[monthly-review]', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

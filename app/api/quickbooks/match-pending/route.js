import pool from '@/lib/db';
import { matchBatch } from '@/lib/qb-match';
import { createNotification } from '@/lib/notifier';

/**
 * GET /api/quickbooks/match-pending
 *
 * Cron job: re-runs the QuickBooks match for bills whose previous attempt was
 * 'pending', 'not_found' or 'error'. The most common reason is bank-feed lag —
 * the bill arrived in our inbox before the corresponding charge made it to
 * QuickBooks.
 *
 * Considers bills from the last 90 days only and caps the batch at 200 per
 * run to stay well below QB API rate limits.
 *
 * Scheduled to run at 02:00 UTC, one hour before /auto-tag-pending so that
 * the latter finds fresh matches.
 */
export async function GET() {
  try {
    const r = await pool.query(`
      SELECT id
      FROM utility_bills
      WHERE qb_match_status IN ('pending', 'not_found', 'error')
        AND amount_due IS NOT NULL AND amount_due > 0
        AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '90 days'
      ORDER BY due_date DESC NULLS LAST
      LIMIT 200
    `);

    const ids = r.rows.map(x => x.id);
    if (ids.length === 0) {
      return Response.json({ ok: true, retried: 0 });
    }

    const stats = await matchBatch(ids);

    // Only notify when something actually changed (a 'matched' or 'ambiguous'
    // resolved or a real error happened)
    if (stats.matched > 0 || stats.ambiguous > 0 || stats.error > 0) {
      const parts = [];
      if (stats.matched > 0)   parts.push(`✓ ${stats.matched} resolved`);
      if (stats.ambiguous > 0) parts.push(`⚠ ${stats.ambiguous} ambiguous`);
      if (stats.error > 0)     parts.push(`! ${stats.error} errors`);
      await createNotification({
        type:    stats.error > 0 ? 'warning' : 'success',
        title:   `Match retry · ${ids.length} bills`,
        message: parts.join(' · '),
        metadata: { stats },
      });
    }

    return Response.json({ ok: true, retried: ids.length, ...stats });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

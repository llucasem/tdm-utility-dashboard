import pool from '@/lib/db';
import { autoTagBatch } from '@/lib/auto-tag';
import { createNotification } from '@/lib/notifier';

/**
 * GET /api/quickbooks/auto-tag-pending
 *
 * Cron job: retries auto-tag for bills whose previous attempt was 'not_found'
 * or 'error'. The most common reason for 'not_found' is bank-feed lag — the
 * bill arrived in our inbox before the corresponding charge made it to
 * QuickBooks.
 *
 * Considers bills from the last 60 days only (older ones are unlikely to ever
 * appear, and we don't want to keep retrying them forever).
 */
export async function GET() {
  try {
    const r = await pool.query(`
      SELECT id
      FROM utility_bills
      WHERE qb_tag_status IN ('not_found', 'error')
        AND amount_due IS NOT NULL AND amount_due > 0
        AND property_address IS NOT NULL
        AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '60 days'
      ORDER BY due_date DESC NULLS LAST
      LIMIT 200
    `);

    const ids   = r.rows.map(x => x.id);
    if (ids.length === 0) {
      return Response.json({ ok: true, retried: 0 });
    }

    const stats = await autoTagBatch(ids);

    if (stats.tagged > 0 || stats.error > 0) {
      const parts = [];
      if (stats.tagged > 0) parts.push(`✓ ${stats.tagged} newly tagged`);
      if (stats.error > 0)  parts.push(`! ${stats.error} still erroring`);
      await createNotification({
        type:    stats.error > 0 ? 'warning' : 'success',
        title:   `Pending tag retry · ${ids.length} bills`,
        message: parts.join(' · '),
        metadata: { stats },
      });
    }

    return Response.json({ ok: true, retried: ids.length, ...stats });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

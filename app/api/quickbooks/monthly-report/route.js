import pool from '@/lib/db';
import { createNotification } from '@/lib/notifier';

/**
 * GET /api/quickbooks/monthly-report
 *
 * Generates a summary of last full month and either previews it or creates an
 * in-app notification.
 *
 * Query params:
 *   ?send=true   create a notification (used by the cron job)
 *   ?month=YYYY-MM   override the target month (defaults to previous month)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const send  = searchParams.get('send') === 'true';
    const month = searchParams.get('month');

    let year, mIdx;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      year = y;
      mIdx = m - 1;
    } else {
      const now = new Date();
      year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      mIdx = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
    }
    const monthName  = ['January','February','March','April','May','June','July','August','September','October','November','December'][mIdx];
    const monthStart = new Date(Date.UTC(year, mIdx,     1)).toISOString().slice(0, 10);
    const monthEnd   = new Date(Date.UTC(year, mIdx + 1, 0)).toISOString().slice(0, 10);

    // Aggregate from utility_bills + the audit log
    const billsRes = await pool.query(`
      SELECT
        COUNT(*)::int                                                                AS total,
        COUNT(*) FILTER (WHERE qb_tag_status = 'tagged')::int                        AS tagged,
        COUNT(*) FILTER (WHERE qb_tag_status = 'ambiguous')::int                     AS ambiguous,
        COUNT(*) FILTER (WHERE qb_tag_status = 'not_found')::int                     AS not_found,
        COUNT(*) FILTER (WHERE qb_tag_status = 'error')::int                         AS error,
        COUNT(*) FILTER (WHERE qb_tag_status = 'skipped')::int                       AS skipped,
        COUNT(*) FILTER (WHERE qb_tag_status = 'pending')::int                       AS pending,
        COALESCE(SUM(amount_due), 0)::float                                          AS total_amount,
        COALESCE(SUM(amount_due) FILTER (WHERE qb_tag_status = 'tagged'), 0)::float  AS tagged_amount
      FROM utility_bills
      WHERE amount_due IS NOT NULL AND amount_due > 0
        AND email_received_at >= $1::date AND email_received_at < ($2::date + 1)
        -- Regla del proyecto: la fecha de una factura es email_received_at,
        -- NUNCA due_date. Este informe la violaba y media un mes distinto al
        -- del dashboard (tercer eje de fecha, hallado en el /roast).
    `, [monthStart, monthEnd]);

    const stats = billsRes.rows[0];

    // Per type breakdown
    const byType = await pool.query(`
      SELECT utility_type, COUNT(*)::int AS count, SUM(amount_due)::float AS amount
      FROM utility_bills
      WHERE amount_due IS NOT NULL AND amount_due > 0
        AND email_received_at >= $1::date AND email_received_at < ($2::date + 1)
        -- Regla del proyecto: la fecha de una factura es email_received_at,
        -- NUNCA due_date. Este informe la violaba y media un mes distinto al
        -- del dashboard (tercer eje de fecha, hallado en el /roast).
      GROUP BY utility_type
      ORDER BY count DESC
    `, [monthStart, monthEnd]);

    const matchRate = stats.total > 0 ? Math.round((stats.tagged / stats.total) * 100) : 0;

    const summaryParts = [
      `${stats.total} bills · $${stats.total_amount.toFixed(2)}`,
      `✓ ${stats.tagged} tagged (${matchRate}%)`,
    ];
    if (stats.ambiguous > 0) summaryParts.push(`⚠ ${stats.ambiguous} ambiguous`);
    if (stats.not_found > 0) summaryParts.push(`✗ ${stats.not_found} not found`);
    if (stats.error > 0)     summaryParts.push(`! ${stats.error} errors`);
    if (stats.pending > 0)   summaryParts.push(`· ${stats.pending} pending`);

    const message = summaryParts.join(' · ') +
      (byType.rows.length > 0
        ? '. Top: ' + byType.rows.slice(0, 3).map(r => `${r.count} ${r.utility_type}`).join(', ')
        : '');

    if (send) {
      await createNotification({
        type:    stats.error > 0 ? 'warning' : 'info',
        title:   `Monthly report — ${monthName} ${year}`,
        message,
        metadata: {
          period: { start: monthStart, end: monthEnd },
          stats,
          byType: byType.rows,
        },
      });
    }

    return Response.json({
      ok:     true,
      sent:   send,
      period: { start: monthStart, end: monthEnd, month: monthName, year },
      stats,
      byType: byType.rows,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

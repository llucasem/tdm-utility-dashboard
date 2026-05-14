import pool from '@/lib/db';
import { matchBatch } from '@/lib/qb-match';
import { autoTagBatch } from '@/lib/auto-tag';
import { runLearningPass } from '@/lib/class-learner';
import { createNotification } from '@/lib/notifier';

// Vercel Hobby caps function timeout at 60s. We sequence multiple batches
// of small size so the total fits comfortably.
export const maxDuration = 60;

/**
 * GET /api/cron/retry-and-learn
 *
 * Consolidated daily cron — runs four operations sequentially. This exists
 * because Vercel Hobby only allows 2 cron jobs and we have ~5 things to
 * schedule. Each operation is capped so the total stays under 60s.
 *
 *   1. match-pending  : up to 20 bills with status pending/not_found/error
 *   2. auto-tag-pending : up to 20 bills with property + pending tag
 *   3. learn-from-classes : QB Purchases with Class from the last 7 days
 *   4. monthly-report : only on the 1st of the month, fire-and-forget
 *
 * Scheduled at 02:00 UTC — gives QB activity time to settle from the
 * previous day before retrying.
 */
export async function GET() {
  const stats = {};
  const summary = [];
  let hadError = false;

  // ── 1. Match retries ─────────────────────────────────────────────────
  try {
    const r = await pool.query(`
      SELECT id FROM utility_bills
      WHERE qb_match_status IN ('pending', 'not_found', 'error')
        AND amount_due IS NOT NULL AND amount_due > 0
        AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '90 days'
      ORDER BY due_date DESC NULLS LAST
      LIMIT 20
    `);
    const ids = r.rows.map(x => x.id);
    stats.match = ids.length > 0 ? await matchBatch(ids) : { skipped: 0 };
    if (stats.match.matched)   summary.push(`✓ ${stats.match.matched} match resolved`);
    if (stats.match.ambiguous) summary.push(`⚠ ${stats.match.ambiguous} ambiguous`);
    if (stats.match.error)     summary.push(`! ${stats.match.error} match errors`);
  } catch (e) {
    stats.match = { error: e.message };
    hadError = true;
  }

  // ── 2. Auto-tag retries ──────────────────────────────────────────────
  try {
    const r = await pool.query(`
      SELECT id FROM utility_bills
      WHERE qb_tag_status IN ('pending', 'not_found', 'error')
        AND amount_due IS NOT NULL AND amount_due > 0
        AND property_address IS NOT NULL
        AND qb_match_status = 'matched'
        AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '60 days'
      ORDER BY due_date DESC NULLS LAST
      LIMIT 20
    `);
    const ids = r.rows.map(x => x.id);
    stats.autoTag = ids.length > 0 ? await autoTagBatch(ids) : { skipped: 0 };
    if (stats.autoTag.tagged) summary.push(`🏷 ${stats.autoTag.tagged} tagged in QB`);
    if (stats.autoTag.error)  summary.push(`! ${stats.autoTag.error} tag errors`);
  } catch (e) {
    stats.autoTag = { error: e.message };
    hadError = true;
  }

  // ── 3. Learning pass (small window for speed) ────────────────────────
  try {
    stats.learn = await runLearningPass({ sinceDays: 7 });
    if (stats.learn.created)   summary.push(`+ ${stats.learn.created} new mappings`);
    if (stats.learn.conflicts) summary.push(`⚠ ${stats.learn.conflicts} mapping conflicts`);
  } catch (e) {
    stats.learn = { error: e.message };
    hadError = true;
  }

  // ── 4. Monthly report (only on day 1) ────────────────────────────────
  const today = new Date();
  if (today.getUTCDate() === 1) {
    try {
      const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      // Fire-and-forget — the monthly-report endpoint handles its own notification
      await fetch(`${base}/api/quickbooks/monthly-report?send=true`, {
        headers: { 'x-vercel-cron': '1' },
      }).catch(() => {});
      stats.monthlyReport = 'fired';
      summary.push('📊 monthly report fired');
    } catch (e) {
      stats.monthlyReport = `error: ${e.message}`;
    }
  }

  // ── Notification summary ─────────────────────────────────────────────
  if (summary.length > 0) {
    await createNotification({
      type:    hadError ? 'warning' : 'success',
      title:   `Daily retry & learn`,
      message: summary.join(' · '),
      metadata: { stats },
    });
  }

  return Response.json({ ok: !hadError, summary, ...stats });
}

import pool from '@/lib/db';
import { matchBatch } from '@/lib/qb-match';
import { autoTagBatch } from '@/lib/auto-tag';
import { runLearningPass, linkBillsFromRecentClasses } from '@/lib/class-learner';
import { refreshLearnedVendors, refreshLearnedBankAccounts } from '@/lib/known-vendors';
import { createNotification } from '@/lib/notifier';
import { startHeartbeat, endHeartbeat } from '@/lib/heartbeat';

// Alarm threshold: more than this many tags in a single cron run is suspicious
// (typical day is 5-10 tags). Triggers a warning notification.
const TAG_RATE_ALARM = 20;

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
  const hb = startHeartbeat('retry-and-learn');
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

    // Rate alarm — too many tags in a single run is suspicious
    if (stats.autoTag.tagged >= TAG_RATE_ALARM) {
      await createNotification({
        type:    'warning',
        title:   `High tag rate · ${stats.autoTag.tagged} tags in one cron run`,
        message: `Threshold is ${TAG_RATE_ALARM}. Review the daily activity in the dashboard to confirm.`,
        metadata: { tagged: stats.autoTag.tagged, ids },
      });
    }
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

  // ── 4. Daily mini-sync from QB Classes ───────────────────────────────
  // Closes the loop: when Jake classes a Purchase that should link to a
  // bill currently in pending/not_found/matched-wrong, this step links it.
  try {
    stats.jakeSync = await linkBillsFromRecentClasses({ sinceDays: 14 });
    if (stats.jakeSync.linked)         summary.push(`🔗 ${stats.jakeSync.linked} bills linked from Jake`);
    if (stats.jakeSync.relinked)       summary.push(`↻ ${stats.jakeSync.relinked} relinked`);
    if (stats.jakeSync.property_filled) summary.push(`+ ${stats.jakeSync.property_filled} properties auto-filled`);
  } catch (e) {
    stats.jakeSync = { error: e.message };
    hadError = true;
  }

  // ── 4b. Refresh learned vendors + bank accounts (cheap) ──────────────
  // Aggregates payees and bank accounts seen in successfully tagged bills and
  // promotes the ones that appear ≥3 times to the known whitelist.
  try {
    const v = await refreshLearnedVendors({ sinceDays: 180 });
    const a = await refreshLearnedBankAccounts({ sinceDays: 180 });
    stats.learnVendors  = v;
    stats.learnAccounts = a;
    if (v.new > 0) summary.push(`🆕 ${v.new} new vendor patterns`);
    if (a.new > 0) summary.push(`🆕 ${a.new} new bank accounts`);
  } catch (e) {
    stats.learnVendors = { error: e.message };
  }

  // ── 4c. Maintenance: prune notifications older than 90 days ──────────
  try {
    const r = await pool.query(`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'`);
    if (r.rowCount > 0) {
      stats.notificationsPruned = r.rowCount;
      summary.push(`🧹 ${r.rowCount} old notifications pruned`);
    }
  } catch (e) {
    stats.notificationsPruned = { error: e.message };
  }

  // ── 4d. Maintenance: backfill duplicate flag on legacy bills ─────────
  // The dedup logic in the sync route only catches new bills going forward.
  // This sweep catches the legacy ones (same utility_type + account_last4 +
  // amount within ±10 days, keep the oldest, mark the rest as duplicate).
  try {
    const r = await pool.query(`
      WITH grouped AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY utility_type, account_last4, ROUND(amount_due::numeric, 2),
                       date_trunc('week', email_received_at)
          ORDER BY email_received_at
        ) AS rn
        FROM utility_bills
        WHERE amount_due > 0 AND account_last4 IS NOT NULL AND account_last4 != ''
          AND NOT is_duplicate
      )
      UPDATE utility_bills SET is_duplicate = true
      WHERE id IN (SELECT id FROM grouped WHERE rn > 1)
    `);
    if (r.rowCount > 0) {
      stats.duplicatesFlagged = r.rowCount;
      summary.push(`🔁 ${r.rowCount} legacy duplicates flagged`);
    }
  } catch (e) {
    stats.duplicatesFlagged = { error: e.message };
  }

  // ── 5. Monthly report (only on day 1) ────────────────────────────────
  const today = new Date();
  if (today.getUTCDate() === 1) {
    try {
      const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      // Fire-and-forget — both endpoints create their own notifications
      await Promise.all([
        fetch(`${base}/api/quickbooks/monthly-report?send=true`, { headers: { 'x-vercel-cron': '1' } }).catch(() => {}),
        fetch(`${base}/api/quickbooks/monthly-review?send=true`, { headers: { 'x-vercel-cron': '1' } }).catch(() => {}),
      ]);
      stats.monthlyReport = 'fired';
      summary.push('📊 monthly report + review fired');
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

  await endHeartbeat(hb, { ok: !hadError, error: hadError ? JSON.stringify(stats).slice(0, 400) : null });
  return Response.json({ ok: !hadError, summary, ...stats });
}

import pool from '@/lib/db';
import { matchBatch } from '@/lib/qb-match';
import { autoTagBatch } from '@/lib/auto-tag';
import { backfillBillsFromQB } from '@/lib/qb-backfill';
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
 *   1. match-pending   : hasta 20 facturas pendientes -> ¿esta pagada?
 *   2. auto-tag-pending: etiqueta en QB las que ya tienen propiedad
 *   3. qb-backfill     : crea facturas de cuentas que NO mandan email
 *   4. learned-vendors : refresca la lista de proveedores conocidos
 *   5. monthly-report  : solo el dia 1, fire-and-forget
 *
 * RETIRADO el 14/08/2026 (fase 4 del reset): los pasos que deducian la
 * PROPIEDAD desde las Classes de QuickBooks (runLearningPass y
 * linkBillsFromRecentClasses). Esa era una capa de reparacion: existia porque
 * el dato nacia mal. Ahora la propiedad sale de account_registry y no hay nada
 * que reparar. Las Classes de Jake siguen sirviendo de desempate, pero al
 * construir el registro (scripts/build-account-registry.mjs), no factura a
 * factura cada noche.
 *
 * Scheduled at 02:00 UTC — gives QB activity time to settle from the
 * previous day before retrying.
 */
export async function GET(request) {
  // Optional overrides for manual deep passes (defaults = nightly behaviour):
  //   ?matchLimit=200   retry up to N bills instead of 20
  //   ?sinceDays=120    learn/link from QB classes going back N days (default 60)
  const params     = request?.nextUrl?.searchParams;
  const matchLimit = Math.min(parseInt(params?.get('matchLimit') || '20', 10) || 20, 500);
  const sinceDays  = Math.min(parseInt(params?.get('sinceDays')  || '60', 10) || 60, 365);

  const hb = startHeartbeat('retry-and-learn');
  const stats = {};
  const summary = [];
  let hadError = false;

  // Wall-clock budget: Vercel Hobby kills the function at 60s. When that
  // happened mid-run (July 2026), everything after the kill silently never
  // executed for WEEKS — no links, no backfill, no notification, no alarm.
  // Reserve time for the summary/heartbeat tail and skip steps that no
  // longer fit; a skipped step runs tomorrow, a killed run reports nothing.
  const startedAt = Date.now();
  const msLeft = () => (maxDuration * 1000) - 10_000 - (Date.now() - startedAt);
  const skippedForTime = [];

  // ── 0. Sync staleness alarm ──────────────────────────────────────────
  // The sync should run every ~2h (GitHub Actions) plus daily (Vercel cron).
  // If its heartbeat is older than 12h, BOTH schedules are failing. This is
  // the alarm that was missing in April-May 2026, when the sync silently
  // stayed down for 28 days and a month of bills never reached the dashboard.
  try {
    const r = await pool.query(
      `SELECT last_ran_at, NOW() - last_ran_at AS age FROM cron_heartbeats WHERE cron_name = 'sync'`
    );
    const ageHours = r.rows[0] ? (Date.now() - new Date(r.rows[0].last_ran_at).getTime()) / 3.6e6 : Infinity;
    if (ageHours > 12) {
      stats.syncStale = { lastRanAt: r.rows[0]?.last_ran_at || null, ageHours: Math.round(ageHours) };
      summary.push(`🚨 sync has not run in ${Math.round(ageHours)}h`);
      await createNotification({
        type:    'error',
        title:   `Sync is DOWN — last ran ${Math.round(ageHours)}h ago`,
        message: `Neither the GitHub Actions schedule nor the Vercel cron has executed /api/sync in over 12 hours. New bills are NOT being ingested. Check GitHub Actions and the Vercel dashboard.`,
        metadata: stats.syncStale,
      });
    }
  } catch (e) {
    stats.syncStale = { error: e.message };
  }

  // ── 0b. Own staleness alarm ──────────────────────────────────────────
  // The heartbeat is only written when a run COMPLETES. If this cron gets
  // killed every night (60s timeout), the sync alarm above still fires
  // nightly but nobody notices that matching/backfill are dead. >36h since
  // the last COMPLETED run → error notification (→ WhatsApp).
  try {
    const r = await pool.query(
      `SELECT last_ran_at FROM cron_heartbeats WHERE cron_name = 'retry-and-learn'`
    );
    const ageHours = r.rows[0] ? (Date.now() - new Date(r.rows[0].last_ran_at).getTime()) / 3.6e6 : 0;
    if (ageHours > 36) {
      summary.push(`🚨 retry-and-learn has not COMPLETED in ${Math.round(ageHours)}h`);
      await createNotification({
        type:    'error',
        title:   `Nightly QB pass incomplete for ${Math.round(ageHours)}h`,
        message: `retry-and-learn keeps starting but never finishing (probably killed by Vercel's 60s limit). Matching, auto-tag and QB backfill are NOT running to completion.`,
        metadata: { ageHours: Math.round(ageHours) },
      });
    }
  } catch (e) { /* non-fatal */ }

  // ── 1. Match retries ─────────────────────────────────────────────────
  // Least-recently-tried FIRST. The old `due_date DESC` order retried the
  // 20 NEWEST bills every night — exactly the ones whose payments can't be
  // in QB yet — while older bills (whose payments HAD arrived) starved and
  // stayed ✗ forever. New bills get their first attempt at sync time anyway.
  try {
    const r = await pool.query(`
      SELECT id FROM utility_bills
      WHERE qb_match_status IN ('pending', 'not_found', 'error')
        AND amount_due IS NOT NULL AND amount_due > 0
        AND NOT is_duplicate
        AND COALESCE(due_date, email_received_at) > NOW() - INTERVAL '90 days'
      ORDER BY qb_matched_at ASC NULLS FIRST
      LIMIT $1
    `, [matchLimit]);
    const ids = r.rows.map(x => x.id);
    // Chunked so the wall-clock guard can stop between chunks instead of
    // being killed mid-batch.
    stats.match = { matched: 0, ambiguous: 0, not_found: 0, error: 0, skipped: 0, items: [] };
    for (let i = 0; i < ids.length; i += 5) {
      if (msLeft() < 15_000) { skippedForTime.push(`match (${ids.length - i} left)`); break; }
      const part = await matchBatch(ids.slice(i, i + 5));
      for (const k of ['matched', 'ambiguous', 'not_found', 'error', 'skipped']) stats.match[k] += part[k] || 0;
      stats.match.items.push(...(part.items || []));
    }
    if (stats.match.matched)   summary.push(`✓ ${stats.match.matched} match resolved`);
    if (stats.match.ambiguous) summary.push(`⚠ ${stats.match.ambiguous} ambiguous`);
    if (stats.match.error)     summary.push(`! ${stats.match.error} match errors`);
  } catch (e) {
    stats.match = { error: e.message };
    hadError = true;
  }

  // ── 2. Auto-tag retries ──────────────────────────────────────────────
  if (msLeft() < 15_000) { skippedForTime.push('autoTag'); stats.autoTag = { skippedForTime: true }; }
  else try {
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

  // ── 3. Backfill de facturas desde QB (cuentas que no mandan email) ───
  // SCE/AT&T/T-Mobile/... send no notification email; their payments only
  // exist in QB (classed by Jake). Create the missing dashboard bills so
  // Jake stops logging into provider portals to check them.
  if (msLeft() < 12_000) { skippedForTime.push('qbBackfill'); stats.qbBackfill = { skippedForTime: true }; }
  else try {
    // Short window on purpose: new payments only appear as Jake accepts the
    // bank feed (~3-4 week lag), and the whole cron must fit Vercel's 60s.
    stats.qbBackfill = await backfillBillsFromQB({ sinceDays: Math.min(sinceDays, 35), maxCreates: 15 });
    if (stats.qbBackfill.created) summary.push(`📥 ${stats.qbBackfill.created} bills desde QB`);
  } catch (e) {
    stats.qbBackfill = { error: e.message };
    hadError = true;
  }

  // ── 4. Refrescar proveedores y cuentas bancarias conocidas ───────────
  // Aggregates payees and bank accounts seen in successfully tagged bills and
  // promotes the ones that appear ≥3 times to the known whitelist.
  if (msLeft() < 8_000) { skippedForTime.push('learnVendors'); stats.learnVendors = { skippedForTime: true }; }
  else try {
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
  // This sweep flags any bill that has an OLDER visible twin (same
  // utility_type + account_last4 + amount) within 18 days — the window that
  // covers ConEd "Ready"→"Due" reminders (12-14d), LADWP (11d) and Spectrum
  // (8d) without touching real monthly cycles (28-31d). The old version
  // partitioned by calendar week and missed every pair that crossed a week
  // boundary (the June 2026 double-bills bug).
  try {
    const r = await pool.query(`
      UPDATE utility_bills b SET is_duplicate = true
      WHERE b.amount_due > 0 AND b.account_last4 IS NOT NULL AND b.account_last4 != ''
        AND NOT b.is_duplicate
        AND EXISTS (
          SELECT 1 FROM utility_bills a
          WHERE a.utility_type = b.utility_type
            AND a.account_last4 = b.account_last4
            AND ROUND(a.amount_due::numeric, 2) = ROUND(b.amount_due::numeric, 2)
            AND NOT a.is_duplicate
            AND a.email_received_at < b.email_received_at
            AND b.email_received_at - a.email_received_at <= INTERVAL '18 days'
        )
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
  if (skippedForTime.length > 0) {
    stats.skippedForTime = skippedForTime;
    summary.push(`⏱ time budget: skipped ${skippedForTime.join(', ')}`);
  }
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

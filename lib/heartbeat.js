/**
 * Cron heartbeat — unconditional write at the start/end of every cron run.
 *
 * Distinguishes "cron actually ran" from "cron found nothing to do".
 * Without this, /api/health can't tell if a quiet day is healthy or if the
 * cron itself is dead.
 *
 * Usage:
 *   const hb = startHeartbeat('retry-and-learn');
 *   try {
 *     ... work ...
 *     await endHeartbeat(hb, { ok: true });
 *   } catch (e) {
 *     await endHeartbeat(hb, { ok: false, error: e.message });
 *     throw e;
 *   }
 */

import pool from '@/lib/db';

export function startHeartbeat(cronName) {
  return { cronName, startTime: Date.now() };
}

export async function endHeartbeat(hb, { ok = true, error = null } = {}) {
  if (!hb || !hb.cronName) return;
  const durationMs = Date.now() - hb.startTime;
  try {
    await pool.query(`
      INSERT INTO cron_heartbeats (cron_name, last_ran_at, last_run_ms, last_run_ok, last_error, runs_total, runs_failed)
      VALUES ($1, NOW(), $2, $3, $4, 1, $5)
      ON CONFLICT (cron_name) DO UPDATE
      SET last_ran_at  = NOW(),
          last_run_ms  = $2,
          last_run_ok  = $3,
          last_error   = $4,
          runs_total   = cron_heartbeats.runs_total + 1,
          runs_failed  = cron_heartbeats.runs_failed + $5
    `, [hb.cronName, durationMs, ok, ok ? null : (error || '').slice(0, 500), ok ? 0 : 1]);
  } catch (e) {
    // Don't break the cron because of a heartbeat write failure
    console.error(`[heartbeat] failed to write ${hb.cronName}:`, e.message);
  }
}

import { runLearningPass } from '@/lib/class-learner';

// Vercel function timeout — learning pass can iterate over hundreds of
// Purchases with QB queries. 60s is the Hobby plan ceiling.
export const maxDuration = 60;

/**
 * GET /api/quickbooks/learn-from-classes
 *
 * Cron job: scans QuickBooks for Purchases that already have a Class assigned,
 * cross-references each one against our utility_bills by amount + date, and
 * auto-creates property→Class mappings where the match is unique and the
 * mapping doesn't already exist.
 *
 * Scheduled at 02:30 UTC so the freshly-learned mappings are available before
 * /auto-tag-pending runs at 03:00 UTC.
 */
export async function GET() {
  try {
    const stats = await runLearningPass({ sinceDays: 60 });
    return Response.json({ ok: true, ...stats });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/**
 * WhatsApp alerts via Lluis's Jarvis VPS.
 *
 * POSTs error alerts to ALERT_WEBHOOK_URL (Jarvis /notify endpoint), which
 * forwards them to Lluis as a WhatsApp message. Wired into createNotification
 * for type 'error', so every error alert in the system reaches WhatsApp
 * without each caller having to know about it.
 *
 * Fire-and-forget by design: a down VPS must never break a sync or cron run.
 * The notification is already persisted in the dashboard either way.
 *
 * Env (set in .env.local and Vercel):
 *   ALERT_WEBHOOK_URL    e.g. https://jarvis.../notify
 *   ALERT_WEBHOOK_TOKEN  shared secret, sent as Bearer
 */

export async function sendAlert({ title, message }) {
  const url   = process.env.ALERT_WEBHOOK_URL;
  const token = process.env.ALERT_WEBHOOK_TOKEN;
  if (!url || !token) return { ok: false, skipped: 'ALERT_WEBHOOK_URL/TOKEN not configured' };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ source: 'edonis-dashboard', title, message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      console.error(`[alert-webhook] Jarvis responded ${r.status}`);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[alert-webhook] failed:', e.message);
    return { ok: false, error: e.message };
  }
}

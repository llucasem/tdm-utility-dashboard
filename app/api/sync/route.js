import { getUtilityEmails } from '@/lib/gmail';
import { parseEmail }       from '@/lib/parser';
import pool                 from '@/lib/db';
import { autoTagBatch }     from '@/lib/auto-tag';
import { matchBatch }       from '@/lib/qb-match';
import { detectAnomaliesBatch } from '@/lib/anomaly-detector';
import { createNotification } from '@/lib/notifier';
import { startHeartbeat, endHeartbeat } from '@/lib/heartbeat';
import { syncAirtable }     from '@/lib/airtable-sync';

// Vercel function timeout — bumped from the default 10s. On Hobby plan the
// max is 60s; on Pro this can go up to 300s. The pre-filter in lib/gmail.js
// caps each invocation at 30 new emails so we comfortably fit in 60s even
// when there's a backlog.
export const maxDuration = 60;

export async function GET() {
  const hb = startHeartbeat('sync');
  try {
    const emails = await getUtilityEmails();

    if (emails.length === 0) {
      await endHeartbeat(hb, { ok: true });
      return Response.json({ ok: true, saved: 0, message: 'No new emails in the Utilities folder.' });
    }

    const results = [];

    // Subjects that are NOT real bills — skip before Claude burns tokens parsing them.
    // Categories: payment confirmations, marketing/upsell, surveys, generic announcements.
    // We err on the side of caution — only patterns we're confident are not bills.
    const SKIP_SUBJECTS = [
      // Payment confirmations / scheduling
      'automatic monthly payment is scheduled',
      'your payment is scheduled',
      'thanks for paying',
      'thank you for your payment',
      'we\'ve received your payment',
      'one-time payment confirmation',
      'order confirmation',
      'automatic payment declined',
      'issue with your automatic monthly payment',
      'autopay was successful',
      'autopay payment',
      'your request to sign up for auto pay',
      // Surveys & feedback
      'your opinion matters',
      'values your feedback',
      'annual survey',
      'your outage experience',
      // Marketing / upsell
      'get internet speed',
      'get a connection that keeps up',
      'enhance your connection',
      'entertainment that moves',
      'free spectrum mobile line',
      // Account / service operations (no billing info)
      'your verification code',
      'service alert',
      'power outage',
      'service is restored',
      'please return your spectrum equipment',
      'work notice',
      'canceled service appointment',
      'scheduled your service appointment',
      'welcome to spectrum notifications',
      'changes have been made to your account',
      'you have a credit on your bill',
      // Generic announcements that don't carry billing info
      'california climate credit timing update',
      'notice of cpuc',
    ];

    // Sender patterns that are marketing-only (never carry real bills).
    // NOTE: LADWP must NEVER be skipped — their "Payment Received" emails are
    // the only billing signal LADWP sends (no "bill ready" emails exist).
    const SKIP_SENDERS = [
      'spectrum customer experience team',
      'spectrum@exchange.spectrum',  // marketing list
      'sce-feedback@feedback.sce.com', // SCE surveys
    ];

    // Cap on Claude calls per invocation. Fetching/discarding noise is cheap
    // (~0.2s each) but each parse costs 2-3s — this cap is what keeps the
    // function under Vercel's 60s limit. Noise beyond the cap still gets
    // persisted, so every run permanently shrinks the backlog.
    const MAX_PARSES_PER_RUN = 10;
    let parseCount = 0;

    // Persist a noise email as a 0-amount row so it is never re-fetched.
    // CRITICAL: without this insert, skipped emails come back from Gmail on
    // every run and permanently hog the per-run slots (the bug that starved
    // out real bills during May 2026).
    async function persistNoise(email, reason) {
      await pool.query(
        `INSERT INTO utility_bills
           (gmail_message_id, utility_type, amount_due, email_received_at, email_subject, email_from, status)
         VALUES ($1, 'other', 0, $2, $3, $4, 'pending')
         ON CONFLICT (gmail_message_id) DO NOTHING`,
        [email.id, email.date, email.subject, email.from || null]
      );
      results.push({ id: email.id, status: 'skipped', reason });
    }

    for (const email of emails) {
      // Skip known payment-confirmation / marketing / survey emails before
      // burning Claude tokens. See SKIP_SUBJECTS + SKIP_SENDERS above.
      const subjectLower = (email.subject || '').toLowerCase();
      const fromLower    = (email.from    || '').toLowerCase();
      if (SKIP_SUBJECTS.some(s => subjectLower.includes(s))) {
        await persistNoise(email, `noise filter: subject contains "${SKIP_SUBJECTS.find(s => subjectLower.includes(s))}"`);
        continue;
      }
      if (SKIP_SENDERS.some(s => fromLower.includes(s))) {
        await persistNoise(email, 'noise filter: sender is marketing list');
        continue;
      }

      // Parse budget exhausted — leave this (non-noise) email for the next
      // run. No row is inserted, so Gmail will return it again.
      if (parseCount >= MAX_PARSES_PER_RUN) {
        results.push({ id: email.id, status: 'deferred', reason: 'parse budget for this run exhausted' });
        continue;
      }
      parseCount++;

      // 1. Parse with Claude (PDF if attached, otherwise email body)
      let parsed;
      try {
        parsed = await parseEmail(email);
      } catch (parseErr) {
        const reason = parseErr.message?.includes('429') ? 'rate limit — retry later' : parseErr.message;
        results.push({ id: email.id, status: 'error', reason });
        await new Promise(r => setTimeout(r, 2000)); // wait extra if rate-limited
        continue;
      }

      if (!parsed) {
        // Persist a synthetic row so this email doesn't infinite-retry on
        // every sync. parse_error_count caps retries to avoid filling the DB
        // with junk if Claude can't parse a malformed email.
        await pool.query(
          `INSERT INTO utility_bills
             (gmail_message_id, utility_type, amount_due, email_received_at, email_subject, email_from, status, parse_error_count)
           VALUES ($1, 'other', NULL, $2, $3, $4, 'pending', 1)
           ON CONFLICT (gmail_message_id) DO UPDATE SET parse_error_count = utility_bills.parse_error_count + 1`,
          [email.id, email.date, email.subject, email.from || null]
        );
        results.push({ id: email.id, status: 'error', reason: 'Claude no pudo extraer datos' });
        continue;
      }

      // Sentinel from sanitize(): this email is a payment confirmation — not a bill.
      // Insert a 0-amount row so we mark it as processed and never re-attempt it.
      if (parsed.__skip) {
        await pool.query(
          `INSERT INTO utility_bills
             (gmail_message_id, utility_type, amount_due, email_received_at, email_subject, email_from, status, account_last4)
           VALUES ($1, 'other', 0, $2, $3, $4, 'pending', $5)
           ON CONFLICT (gmail_message_id) DO NOTHING`,
          [email.id, email.date, email.subject, email.from || null, parsed.account_last4 || null]
        );
        results.push({ id: email.id, status: 'skipped', reason: parsed.reason || 'payment confirmation' });
        continue;
      }

      // Skip emails with no payable amount — notifications, confirmations, etc.
      if (!parsed.amount_due || parseFloat(parsed.amount_due) <= 0) {
        // Same insert-as-skipped pattern to avoid infinite retries.
        await pool.query(
          `INSERT INTO utility_bills
             (gmail_message_id, utility_type, amount_due, email_received_at, email_subject, email_from, status, account_last4)
           VALUES ($1, $2, 0, $3, $4, $5, 'pending', $6)
           ON CONFLICT (gmail_message_id) DO NOTHING`,
          [email.id, parsed.utility_type || 'other', email.date, email.subject, email.from || null, parsed.account_last4 || null]
        );
        results.push({ id: email.id, status: 'skipped', reason: 'amount_due is 0 or missing' });
        continue;
      }

      // 2. Apply mapping if it exists and the email didn't yield an address
      let finalAddress = parsed.property_address || null;
      let finalUnit    = parsed.unit             || null;
      if (!finalAddress && parsed.account_last4 && parsed.utility_type) {
        const mapRes = await pool.query(
          `SELECT property_address, unit FROM account_mappings
           WHERE utility_type = $1 AND account_last4 = $2 LIMIT 1`,
          [parsed.utility_type, parsed.account_last4]
        );
        if (mapRes.rows.length > 0) {
          finalAddress = mapRes.rows[0].property_address;
          finalUnit    = finalUnit || mapRes.rows[0].unit;
        }
      }

      // 2.5 — DEDUP rule (system_lesson "Spectrum/ConEd send 2 emails per
      // bill"): if we already saved a bill with the same (utility_type,
      // account_last4, amount_due) within ±10 days, mark this one as
      // duplicate so it doesn't pollute the dashboard or matcher.
      let isDuplicate = false;
      if (parsed.account_last4 && parsed.amount_due && parsed.utility_type) {
        const dup = await pool.query(
          `SELECT id FROM utility_bills
            WHERE utility_type = $1 AND account_last4 = $2
              AND ROUND(amount_due::numeric, 2) = ROUND($3::numeric, 2)
              AND email_received_at BETWEEN $4::timestamptz - INTERVAL '10 days'
                                       AND $4::timestamptz + INTERVAL '10 days'
              AND NOT is_duplicate
            LIMIT 1`,
          [parsed.utility_type, parsed.account_last4, parsed.amount_due, email.date]
        );
        if (dup.rowCount > 0) isDuplicate = true;
      }

      // 3. Save to Neon — ON CONFLICT skips duplicates atomically.
      // __paid: LADWP payment confirmations are the only bill record LADWP
      // sends — the autopay already went through, so they arrive as 'paid'.
      const res = await pool.query(
        `INSERT INTO utility_bills
           (gmail_message_id, utility_type, property_address, unit, account_last4,
            amount_due, due_date, email_received_at, email_subject, email_from, status, is_duplicate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (gmail_message_id) DO NOTHING
         RETURNING id, property_address`,
        [
          email.id,
          parsed.utility_type  || 'other',
          finalAddress,
          finalUnit,
          parsed.account_last4 || null,
          parsed.amount_due    || null,
          parsed.due_date      || null,
          email.date,
          email.subject,
          email.from           || null,
          parsed.__paid ? 'paid' : 'pending',
          isDuplicate,
        ]
      );

      if (res.rowCount === 0) {
        results.push({ id: email.id, status: 'skipped', reason: 'already processed' });
      } else if (isDuplicate) {
        results.push({ id: email.id, status: 'skipped', reason: 'duplicate of existing bill (same account+amount within ±10d)', billId: res.rows[0].id });
      } else {
        results.push({ id: email.id, status: 'saved', data: parsed, billId: res.rows[0].id, hasProperty: !!res.rows[0].property_address });
      }

      // Pause between Claude calls to stay under the rate limit
      // (Anthropic Haiku: 30k tokens/min — 500ms gives ~120 calls/min headroom)
      await new Promise(r => setTimeout(r, 500));
    }

    const saved    = results.filter(r => r.status === 'saved').length;
    const skipped  = results.filter(r => r.status === 'skipped').length;
    const errors   = results.filter(r => r.status === 'error').length;
    const deferred = results.filter(r => r.status === 'deferred').length;

    // QuickBooks match for ALL new bills (independent of property). The result
    // is persisted in utility_bills.qb_match_* so the dashboard shows badges
    // automatically and auto-tag can reuse the lookup.
    const newBillIds = results
      .filter(r => r.status === 'saved')
      .map(r => r.billId);

    let matchStats = null;
    if (newBillIds.length > 0) {
      try {
        matchStats = await matchBatch(newBillIds);
      } catch (e) {
        matchStats = { error: e.message };
      }
    }

    // Auto-tag the ones that already have a property assigned. They will reuse
    // the persisted match (no extra QB calls).
    const billIdsToTag = results
      .filter(r => r.status === 'saved' && r.hasProperty)
      .map(r => r.billId);

    let autoTagStats = null;
    if (billIdsToTag.length > 0) {
      try {
        autoTagStats = await autoTagBatch(billIdsToTag);
      } catch (e) {
        autoTagStats = { error: e.message };
        await createNotification({
          type:    'error',
          title:   'Auto-tag failed during sync',
          message: `Could not run auto-tag: ${e.message}. New bills were saved but not tagged in QuickBooks.`,
        });
      }
    }

    // Anomaly detection on every new bill — does its own notifications when it finds something
    let anomalyStats = null;
    if (newBillIds.length > 0) {
      try {
        anomalyStats = await detectAnomaliesBatch(newBillIds);
      } catch (e) {
        anomalyStats = { error: e.message };
      }
    }

    // One summary notification per sync run
    if (saved > 0 || errors > 0) {
      const parts = [`${saved} new bills`];
      if (errors > 0) parts.push(`${errors} parse errors`);
      if (matchStats?.matched)     parts.push(`${matchStats.matched} matched`);
      if (matchStats?.ambiguous)   parts.push(`${matchStats.ambiguous} ambiguous`);
      if (matchStats?.not_found)   parts.push(`${matchStats.not_found} not found`);
      if (autoTagStats?.tagged)    parts.push(`${autoTagStats.tagged} tagged in QB`);
      if (autoTagStats?.error)     parts.push(`${autoTagStats.error} tag errors`);

      await createNotification({
        type:    errors > 0 || autoTagStats?.error > 0 ? 'warning' : (saved > 0 ? 'success' : 'info'),
        title:   `Sync complete · ${saved} new bills`,
        message: parts.join(' · '),
        metadata: { saved, errors, match: matchStats, autoTag: autoTagStats },
      });
    }

    // ── Airtable sync (rent payments + Conservice utilities) ───────────
    // Runs after Gmail so the same /api/sync handles everything in 60s.
    // We cap to 15 records per run to stay well under the Hobby 60s limit
    // when combined with the Gmail half.
    let airtableStats = null;
    try {
      airtableStats = await syncAirtable({ limit: 15 });
    } catch (e) {
      airtableStats = { ok: false, error: e.message };
      await createNotification({
        type:    'error',
        title:   'Airtable sync failed',
        message: `Could not run Airtable rent sync: ${e.message}`,
      });
    }

    await endHeartbeat(hb, { ok: errors === 0 && !autoTagStats?.error });
    return Response.json({
      ok: true,
      saved, skipped, errors, deferred, results,
      match: matchStats,
      autoTag: autoTagStats,
      airtable: airtableStats,
    });

  } catch (error) {
    console.error('[sync] Error:', error.message);
    await endHeartbeat(hb, { ok: false, error: error.message });
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

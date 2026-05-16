import { getUtilityEmails } from '@/lib/gmail';
import { parseEmail }       from '@/lib/parser';
import pool                 from '@/lib/db';
import { autoTagBatch }     from '@/lib/auto-tag';
import { matchBatch }       from '@/lib/qb-match';
import { detectAnomaliesBatch } from '@/lib/anomaly-detector';
import { createNotification } from '@/lib/notifier';

// Vercel function timeout — bumped from the default 10s. On Hobby plan the
// max is 60s; on Pro this can go up to 300s. The pre-filter in lib/gmail.js
// caps each invocation at 30 new emails so we comfortably fit in 60s even
// when there's a backlog.
export const maxDuration = 60;

export async function GET() {
  try {
    const emails = await getUtilityEmails();

    if (emails.length === 0) {
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
      'thanks for paying your con edison bill',
      'thank you for your payment',
      'we\'ve received your payment',
      'payment received (confirmation)',
      'order confirmation',
      'automatic payment declined',
      'autopay was successful',
      'autopay payment',
      // Surveys & feedback
      'your opinion matters',
      'values your feedback',
      'annual survey',
      // Marketing / upsell
      'get internet speed',
      'get a connection that keeps up',
      'enhance your connection',
      'entertainment that moves',
      // Generic announcements that don't carry billing info
      'california climate credit timing update',
    ];

    // Sender patterns that are marketing-only (never carry real bills)
    const SKIP_SENDERS = [
      'spectrum customer experience team',
      'spectrum@exchange.spectrum',  // marketing list
    ];

    for (const email of emails) {
      // Skip known payment-confirmation / marketing / survey emails before
      // burning Claude tokens. See SKIP_SUBJECTS + SKIP_SENDERS above.
      const subjectLower = (email.subject || '').toLowerCase();
      const fromLower    = (email.from    || '').toLowerCase();
      if (SKIP_SUBJECTS.some(s => subjectLower.includes(s))) {
        results.push({ id: email.id, status: 'skipped', reason: `noise filter: subject contains "${SKIP_SUBJECTS.find(s => subjectLower.includes(s))}"` });
        continue;
      }
      if (SKIP_SENDERS.some(s => fromLower.includes(s))) {
        results.push({ id: email.id, status: 'skipped', reason: `noise filter: sender is marketing list` });
        continue;
      }

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
        results.push({ id: email.id, status: 'error', reason: 'Claude no pudo extraer datos' });
        continue;
      }

      // Skip emails with no payable amount — notifications, confirmations, etc.
      if (!parsed.amount_due || parseFloat(parsed.amount_due) <= 0) {
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

      // 3. Save to Neon — ON CONFLICT skips duplicates atomically
      const res = await pool.query(
        `INSERT INTO utility_bills
           (gmail_message_id, utility_type, property_address, unit, account_last4,
            amount_due, due_date, email_received_at, email_subject, email_from, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
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
        ]
      );

      if (res.rowCount === 0) {
        results.push({ id: email.id, status: 'skipped', reason: 'already processed' });
      } else {
        results.push({ id: email.id, status: 'saved', data: parsed, billId: res.rows[0].id, hasProperty: !!res.rows[0].property_address });
      }

      // Pause between Claude calls to stay under the rate limit
      await new Promise(r => setTimeout(r, 2000));
    }

    const saved   = results.filter(r => r.status === 'saved').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors  = results.filter(r => r.status === 'error').length;

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

    return Response.json({ ok: true, saved, skipped, errors, results, match: matchStats, autoTag: autoTagStats });

  } catch (error) {
    console.error('[sync] Error:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

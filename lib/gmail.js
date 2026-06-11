import { google } from 'googleapis';
import pool from '@/lib/db';

// ── Create OAuth client with credentials from .env.local ─────────────────────
function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });
  return oauth2Client;
}

// ── Decode the email body (comes base64-encoded from Gmail) ───────────────────
// IMPORTANT: prefer text/html over text/plain. Utility bills (Spectrum, ConEd,
// SCE, etc.) put the address and amount inside the HTML body. The plain-text
// alternative is often a 1-3 line stub ("Your bill is ready. View it at...")
// that lacks the data Claude needs to extract.
function decodeBody(part) {
  if (!part) return '';

  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }
  if (part.parts) {
    // First pass: prefer HTML across nested multipart structures
    for (const p of part.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) {
        return Buffer.from(p.body.data, 'base64url').toString('utf-8');
      }
    }
    // Second pass: fall back to plain text
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        return Buffer.from(p.body.data, 'base64url').toString('utf-8');
      }
    }
    // Third pass: recurse into deeper parts (multipart within multipart)
    for (const p of part.parts) {
      const text = decodeBody(p);
      if (text) return text;
    }
  }
  return '';
}

function findPdfAttachments(part) {
  const pdfs = [];
  if (!part) return pdfs;
  if (part.mimeType === 'application/pdf' && part.body?.attachmentId) {
    pdfs.push({
      filename:     part.filename || 'attachment.pdf',
      attachmentId: part.body.attachmentId,
    });
  }
  if (part.parts) {
    for (const p of part.parts) {
      pdfs.push(...findPdfAttachments(p));
    }
  }
  return pdfs;
}

// Maximum emails to FETCH per sync run. Fetching is cheap (~0.2s each,
// chunked 5-concurrent) — the expensive part is parsing with Claude, which
// the sync route caps separately (MAX_PARSES_PER_RUN). Fetching 50 lets each
// run burn through lots of noise (persisted as 0-amount rows, never
// re-fetched) while still finishing well under Vercel's 60s limit.
const MAX_PER_RUN = 50;

// Chunked parallel fetch — avoids EBUSY DNS-exhaustion on high backlogs by
// keeping concurrent Gmail requests bounded.
const FETCH_CONCURRENCY = 5;

async function fetchOneEmail(gmail, userId, id) {
  const msgRes = await gmail.users.messages.get({ userId, id, format: 'full' });
  const msg     = msgRes.data;
  const headers = msg.payload?.headers || [];

  const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
  const from    = headers.find(h => h.name === 'From')?.value    || '(unknown sender)';
  const dateStr = headers.find(h => h.name === 'Date')?.value    || '';
  const body    = decodeBody(msg.payload);
  const pdfRefs = findPdfAttachments(msg.payload);

  // Download ALL PDF attachments (capped at 3 — bills never have more). The
  // old code took only the first one and the parser dropped it if >200KB,
  // which made bills with a heavy PDF and a stub body invisible.
  const pdfsBase64 = [];
  for (const ref of pdfRefs.slice(0, 3)) {
    const attRes = await gmail.users.messages.attachments.get({
      userId, messageId: id, id: ref.attachmentId,
    });
    const data = attRes.data.data?.replace(/-/g, '+').replace(/_/g, '/') || null;
    if (data) pdfsBase64.push(data);
  }

  return {
    id, subject, from,
    date:    dateStr ? new Date(dateStr).toISOString() : null,
    snippet: msg.snippet || '',
    body,
    pdfBase64: pdfsBase64[0] || null, // back-compat for older callers
    pdfsBase64,
  };
}

// ── Read emails from the "Utilities" label ────────────────────────────────────
export async function getUtilityEmails() {
  const auth   = getOAuthClient();
  const gmail  = google.gmail({ version: 'v1', auth });
  const userId = process.env.GMAIL_USER;

  // 1. Locate the Utilities label
  const labelsRes = await gmail.users.labels.list({ userId });
  const labels    = labelsRes.data.labels || [];
  const utLabel   = labels.find(l => l.name.toLowerCase() === 'utilities');
  if (!utLabel) {
    throw new Error('Gmail label "Utilities" not found. Create it and add some test emails.');
  }

  // 2. List message IDs from a rolling 90-day window (cheap — just IDs).
  // Was 365 days, but that reached back into mid-2025 — months before the
  // project existed — exposing ~2,100 pre-project emails as permanent
  // "pending" backlog. 90 days covers every operational need (bills are
  // monthly; noise is persisted on first sight) and stays cheap forever.
  const since = new Date(Date.now() - 90 * 86_400_000);
  const q = `after:${since.getUTCFullYear()}/${since.getUTCMonth() + 1}/${since.getUTCDate()}`;
  const allIds = [];
  let pageToken = undefined;
  do {
    const listRes = await gmail.users.messages.list({
      userId,
      labelIds:   [utLabel.id],
      maxResults: 500,
      q,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of listRes.data.messages || []) allIds.push(m.id);
    pageToken = listRes.data.nextPageToken;
  } while (pageToken);

  if (allIds.length === 0) return [];

  // 3. Filter against the DB — skip emails already saved. This is what makes
  //    the daily cron fast: it doesn't re-fetch 400+ already-processed emails.
  const knownR = await pool.query(
    `SELECT gmail_message_id FROM utility_bills WHERE gmail_message_id = ANY($1::text[])`,
    [allIds]
  );
  const known = new Set(knownR.rows.map(r => r.gmail_message_id));
  const newIds = allIds.filter(id => !known.has(id));

  if (newIds.length === 0) return [];

  // 4. Cap to MAX_PER_RUN so each invocation stays within Vercel's timeout.
  //    Gmail returns IDs in DESC order (newest first), so slice(0, N) gives
  //    us the newest unprocessed emails. Critical: this used to be
  //    slice(-N) which silently took the OLDEST N — bills from a year ago
  //    were being processed instead of today's. Fixed 2026-06-09.
  const idsToFetch = newIds.slice(0, MAX_PER_RUN);

  // 5. Chunked parallel fetch (bounded concurrency to avoid EBUSY)
  const emails = [];
  for (let i = 0; i < idsToFetch.length; i += FETCH_CONCURRENCY) {
    const chunk = idsToFetch.slice(i, i + FETCH_CONCURRENCY);
    const batch = await Promise.all(chunk.map(id => fetchOneEmail(gmail, userId, id)));
    emails.push(...batch);
  }

  return emails;
}

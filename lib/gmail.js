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

// Maximum emails to fetch+parse per sync run. Keeps each invocation under
// the Vercel function timeout (60s on Hobby plan). With ~3-5s per email
// (Gmail fetch + Claude parse + 500ms pause + DB insert), 10 emails fit
// comfortably. Cron runs every 6h so up to 40 emails/day get processed.
const MAX_PER_RUN = 10;

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

  let pdfBase64 = null;
  if (pdfRefs.length > 0) {
    const attRes = await gmail.users.messages.attachments.get({
      userId, messageId: id, id: pdfRefs[0].attachmentId,
    });
    pdfBase64 = attRes.data.data?.replace(/-/g, '+').replace(/_/g, '/') || null;
  }

  return {
    id, subject, from,
    date:    dateStr ? new Date(dateStr).toISOString() : null,
    snippet: msg.snippet || '',
    body,
    pdfBase64,
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

  // 2. List message IDs from a rolling 365-day window (cheap — just IDs).
  // Was hardcoded to 'after:2026/01/01' which would silently stop working
  // when the project entered 2027.
  const since = new Date(Date.now() - 365 * 86_400_000);
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
  //    Newer emails first so users see the freshest data first.
  const idsToFetch = newIds.slice(-MAX_PER_RUN);

  // 5. Chunked parallel fetch (bounded concurrency to avoid EBUSY)
  const emails = [];
  for (let i = 0; i < idsToFetch.length; i += FETCH_CONCURRENCY) {
    const chunk = idsToFetch.slice(i, i + FETCH_CONCURRENCY);
    const batch = await Promise.all(chunk.map(id => fetchOneEmail(gmail, userId, id)));
    emails.push(...batch);
  }

  return emails;
}

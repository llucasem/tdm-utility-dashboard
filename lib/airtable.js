/**
 * Airtable client for the Rental Portals base.
 *
 * Pulls email records from the EMAILS table — these are inbound emails from
 * Edonis's various tenant Gmails and management aliases, captured by some
 * upstream automation. We classify each one downstream (rent confirmation
 * vs Conservice utility vs noise).
 *
 * Read-only against Airtable. No writes.
 */

import pool from './db.js';

const API_BASE   = 'https://api.airtable.com/v0';
const BASE_ID    = process.env.AIRTABLE_RENT_BASE_ID || 'app4hMyYd61s95xqV';
const TABLE_ID   = process.env.AIRTABLE_EMAILS_TABLE_ID || 'tblcWkXqmdR8JI6Pq';
const PAT        = process.env.AIRTABLE_PAT;

function requirePat() {
  if (!PAT || PAT.startsWith('PASTE_')) {
    throw new Error('AIRTABLE_PAT is missing or still a placeholder');
  }
}

async function airtableGet(path) {
  requirePat();
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Airtable ${r.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

/**
 * Fetch up to `limit` records from the EMAILS table that have NOT yet been
 * classified (i.e. not in airtable_processed). Returns the newest unseen
 * records first.
 *
 * Strategy: ask Airtable for records sorted by Received DESC, paginate, and
 * skip any we've already processed. We stop as soon as we have `limit`
 * unseen records, or we run out of records to scan.
 *
 * This is naive (no upstream filter on the API call) but it's fine: 2419
 * records total, scanned in ~25 pages of 100. As the table grows we can add
 * a `&filterByFormula=IS_AFTER(...)` for the last processed date.
 */
export async function getUnprocessedEmails({ limit = 25, maxScan = 500 } = {}) {
  // Pull processed IDs once into a Set for O(1) lookups.
  const processedRes = await pool.query(
    `SELECT airtable_record_id FROM airtable_processed`
  );
  const processed = new Set(processedRes.rows.map((r) => r.airtable_record_id));

  const result = [];
  let scanned  = 0;
  let offset;

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      // Newest first — most relevant to the current sync
      'sort[0][field]': 'Received',
      'sort[0][direction]': 'desc',
    });
    if (offset) params.set('offset', offset);

    const page = await airtableGet(`/${BASE_ID}/${TABLE_ID}?${params.toString()}`);
    for (const rec of page.records) {
      scanned++;
      if (processed.has(rec.id)) continue;
      result.push(mapAirtableRecord(rec));
      if (result.length >= limit) return result;
    }
    offset = page.offset;
    if (scanned >= maxScan) break;
  } while (offset);

  return result;
}

/**
 * Fetch ALL records (paginated). Used by the one-shot backfill script.
 * Returns full mapped records.
 */
export async function getAllEmails({ onPage } = {}) {
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (offset) params.set('offset', offset);
    const page = await airtableGet(`/${BASE_ID}/${TABLE_ID}?${params.toString()}`);
    for (const rec of page.records) out.push(mapAirtableRecord(rec));
    if (onPage) onPage(out.length);
    offset = page.offset;
  } while (offset);
  return out;
}

/**
 * Mark a record as processed (rent_payment, conservice_utility, skip, or error)
 * so we never re-classify it.
 */
export async function markProcessed(airtableId, verdict, reason = null) {
  await pool.query(
    `INSERT INTO airtable_processed (airtable_record_id, verdict, reason, processed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (airtable_record_id) DO UPDATE
       SET verdict = EXCLUDED.verdict,
           reason = EXCLUDED.reason,
           processed_at = NOW()`,
    [airtableId, verdict, reason]
  );
}

function mapAirtableRecord(rec) {
  const f = rec.fields || {};
  return {
    id:           rec.id,
    mailbox:      f.Mailbox || null,
    from:         f.From || null,
    fromEmail:    (f['From Email'] || '').toLowerCase() || null,
    subject:      f.Subject || null,
    content:      f.Content || '',
    htmlContent:  f['HTML Content'] || '',
    received:     f.Received || null,
    attachments:  Array.isArray(f.Attachments) ? f.Attachments.length : 0,
    type:         f.Type || null,
  };
}

/**
 * QuickBooks Online API client.
 *
 * Responsibilities:
 *  - Read tokens from Neon (table: quickbooks_tokens)
 *  - Auto-refresh the access_token when it has expired (or is close to it)
 *  - Provide helpers to query QuickBooks via SQL-like queries
 *
 * Usage from API routes:
 *    import { searchTransactions, getCompanyInfo } from '@/lib/quickbooks';
 */

import pool from '@/lib/db';

const QB_ENV   = (process.env.QB_ENV || 'production').toLowerCase();
const API_BASE = QB_ENV === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

// Refresh the access_token when there are fewer than this many seconds left
const REFRESH_BUFFER_SECONDS = 5 * 60; // 5 minutes

// ── Token management ──────────────────────────────────────────────────────────

async function loadTokens() {
  const r = await pool.query(
    `SELECT realm_id, access_token, refresh_token, expires_at, refresh_expires_at
     FROM quickbooks_tokens
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  return r.rows[0] || null;
}

async function refreshAccessToken(row) {
  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('QB_CLIENT_ID or QB_CLIENT_SECRET missing in environment');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body  = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: row.refresh_token,
  });

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const tokens = await res.json();
  const expiresAt        = new Date(Date.now() + (tokens.expires_in * 1000));
  const refreshExpiresAt = new Date(Date.now() + (tokens.x_refresh_token_expires_in * 1000));

  // Persist (refresh_token rotates each time, so we MUST save the new one)
  await pool.query(
    `UPDATE quickbooks_tokens
     SET access_token = $1, refresh_token = $2, expires_at = $3, refresh_expires_at = $4, updated_at = NOW()
     WHERE realm_id = $5`,
    [tokens.access_token, tokens.refresh_token, expiresAt, refreshExpiresAt, row.realm_id]
  );

  return {
    realm_id:           row.realm_id,
    access_token:       tokens.access_token,
    refresh_token:      tokens.refresh_token,
    expires_at:         expiresAt,
    refresh_expires_at: refreshExpiresAt,
  };
}

/**
 * Returns a usable access_token + realm_id, refreshing if needed.
 * Throws if no tokens exist yet (i.e. nobody has authorized the app).
 */
export async function getValidTokens() {
  let row = await loadTokens();
  if (!row) {
    throw new Error('No QuickBooks tokens found. Run scripts/get-qb-token.js first.');
  }

  const expiresInMs = new Date(row.expires_at).getTime() - Date.now();
  if (expiresInMs < REFRESH_BUFFER_SECONDS * 1000) {
    row = await refreshAccessToken(row);
  }
  return row;
}

// ── Low-level QB API helper ──────────────────────────────────────────────────

async function qbFetch(path, { method = 'GET', body, retries = 1 } = {}) {
  const tokens = await getValidTokens();
  const url    = `${API_BASE}/v3/company/${tokens.realm_id}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Accept':        'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 401 means token rejected — refresh once and retry
  if (res.status === 401 && retries > 0) {
    const row = await loadTokens();
    if (row) await refreshAccessToken(row);
    return qbFetch(path, { method, body, retries: retries - 1 });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QuickBooks API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ── High-level helpers ───────────────────────────────────────────────────────

/**
 * Run a QBO SQL-like query via the /query endpoint.
 * Example:
 *    queryQB("SELECT * FROM Purchase WHERE TotalAmt = 61.25 AND TxnDate >= '2026-04-01'")
 */
export async function queryQB(sql) {
  const path = `/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  return qbFetch(path);
}

/**
 * Search for transactions that match a given amount and date window.
 * Looks across the most relevant entity types for utility-bill payments.
 *
 * @param {object} opts
 * @param {number} opts.amount        Exact amount to match (will be rounded to 2 decimals)
 * @param {string} opts.dateFrom      YYYY-MM-DD
 * @param {string} opts.dateTo        YYYY-MM-DD
 * @returns {Promise<Array>}          Array of normalized transactions
 */
export async function searchTransactions({ amount, dateFrom, dateTo }) {
  if (!amount || !dateFrom || !dateTo) {
    throw new Error('searchTransactions requires amount, dateFrom and dateTo');
  }
  // QBO query requires single-quoted values for TotalAmt (even though it's numeric)
  const amt = Number(amount).toFixed(2);
  const where = `WHERE TotalAmt = '${amt}' AND TxnDate >= '${dateFrom}' AND TxnDate <= '${dateTo}'`;

  // We hit Purchase + BillPayment in parallel — those cover the typical
  // utility-bill payment paths in QuickBooks.
  const [purchases, billPayments] = await Promise.all([
    queryQB(`SELECT Id, TxnDate, TotalAmt, EntityRef, AccountRef, PrivateNote, DocNumber FROM Purchase ${where}`).catch(() => null),
    queryQB(`SELECT Id, TxnDate, TotalAmt, VendorRef, PrivateNote, DocNumber FROM BillPayment ${where}`).catch(() => null),
  ]);

  const matches = [];

  for (const p of purchases?.QueryResponse?.Purchase || []) {
    matches.push({
      type:       'Purchase',
      id:         p.Id,
      date:       p.TxnDate,
      amount:     Number(p.TotalAmt),
      payee:      p.EntityRef?.name || null,
      account:    p.AccountRef?.name || null,
      docNumber:  p.DocNumber || null,
      note:       p.PrivateNote || null,
    });
  }
  for (const bp of billPayments?.QueryResponse?.BillPayment || []) {
    matches.push({
      type:       'BillPayment',
      id:         bp.Id,
      date:       bp.TxnDate,
      amount:     Number(bp.TotalAmt),
      payee:      bp.VendorRef?.name || null,
      account:    null,
      docNumber:  bp.DocNumber || null,
      note:       bp.PrivateNote || null,
    });
  }
  return matches;
}

/** Quick health check — used by the /api/quickbooks/status endpoint */
export async function getCompanyInfo() {
  const tokens = await getValidTokens();
  const path   = `/companyinfo/${tokens.realm_id}?minorversion=70`;
  return qbFetch(path);
}

// ── Class management ────────────────────────────────────────────────────────

/** List all active QuickBooks Classes (for the property↔class mapping UI). */
export async function listClasses() {
  const r = await queryQB(`SELECT Id, Name, Active, FullyQualifiedName FROM Class WHERE Active = true MAXRESULTS 1000`);
  return r?.QueryResponse?.Class || [];
}

/** Create a new Class in QuickBooks. */
export async function createClass(name) {
  if (!name || typeof name !== 'string') throw new Error('createClass: name required');
  const res = await qbFetch(`/class?minorversion=70`, { method: 'POST', body: { Name: name } });
  return res?.Class || null;
}

// ── Purchase tagging ────────────────────────────────────────────────────────

/** Fetch a single Purchase (needed for SyncToken + current ClassRef). */
export async function getPurchase(purchaseId) {
  const r = await qbFetch(`/purchase/${purchaseId}?minorversion=70`);
  return r?.Purchase || null;
}

/**
 * Tag a Purchase with a Class — but ONLY IF the Purchase currently has no Class
 * assigned (top-level OR on any line). This is a strict guardrail to avoid
 * overwriting any existing categorization in the customer's QuickBooks.
 *
 * Returns one of:
 *  { ok: true,  status: 'tagged',  previousClass: null, newClass: { id, name } }
 *  { ok: true,  status: 'skipped', reason: 'already_tagged', previousClass: {...} }
 *  { ok: false, status: 'error',   error: '...' }
 */
export async function tagPurchaseWithClass({ purchaseId, classId, className }) {
  if (!purchaseId || !classId) throw new Error('tagPurchaseWithClass requires purchaseId and classId');

  const purchase = await getPurchase(purchaseId);
  if (!purchase) return { ok: false, status: 'error', error: 'Purchase not found' };

  // GUARDRAIL: bail out if there's any existing Class anywhere on the Purchase
  const topClass = purchase.ClassRef?.value || null;
  const lineClasses = (purchase.Line || [])
    .map(l => l.AccountBasedExpenseLineDetail?.ClassRef?.value || l.ItemBasedExpenseLineDetail?.ClassRef?.value)
    .filter(Boolean);

  if (topClass || lineClasses.length > 0) {
    return {
      ok: true,
      status: 'skipped',
      reason: 'already_tagged',
      previousClass: { topClass, lineClasses },
    };
  }

  // Build sparse update — apply ClassRef to each line (per QBO best practice
  // when ClassTrackingPerTxnLine is enabled, which is the case here).
  const updatedLines = (purchase.Line || []).map(line => {
    const detail = line.AccountBasedExpenseLineDetail
      ? { ...line.AccountBasedExpenseLineDetail, ClassRef: { value: classId, name: className } }
      : line.ItemBasedExpenseLineDetail
        ? { ...line.ItemBasedExpenseLineDetail, ClassRef: { value: classId, name: className } }
        : null;
    if (!detail) return line;
    return line.AccountBasedExpenseLineDetail
      ? { ...line, AccountBasedExpenseLineDetail: detail }
      : { ...line, ItemBasedExpenseLineDetail: detail };
  });

  const payload = {
    Id:        purchase.Id,
    SyncToken: purchase.SyncToken,
    sparse:    true,
    Line:      updatedLines,
  };

  const res = await qbFetch(`/purchase?minorversion=70`, { method: 'POST', body: payload });
  if (!res?.Purchase) return { ok: false, status: 'error', error: 'Update failed (no Purchase in response)' };

  return {
    ok: true,
    status: 'tagged',
    previousClass: null,
    newClass: { id: classId, name: className },
    syncToken: res.Purchase.SyncToken,
  };
}

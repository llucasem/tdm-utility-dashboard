/**
 * Backfill dashboard bills from QuickBooks for accounts that never email.
 *
 * Several utility accounts (SCE, AT&T, T-Mobile, some SoCalGas/Spectrum) send
 * no notification email, so their bills can never arrive via /api/sync. But
 * their payments DO land in QuickBooks, and Jake attributes each one to a
 * property with a Class. This module turns those classed Purchases into
 * dashboard bills (source='qb', status='paid') so the matrix is complete
 * without Jake logging into any provider portal.
 *
 * Guardrails:
 *  - Only Purchases whose vendor maps to a known utility provider.
 *  - Only Purchases with a Class that reverse-maps in property_qb_class.
 *  - Skip if a bill already covers the payment: same utility_type + amount
 *    within ±45 days that is (a) the same property, (b) unassigned (the
 *    matcher's adopt path will claim it), or (c) already linked to this
 *    Purchase.
 *  - Synthetic key 'qb:<purchaseId>' in gmail_message_id — the existing
 *    UNIQUE constraint makes the whole thing idempotent.
 */

import pool from '@/lib/db';
import { queryQB, extractClassInfo } from '@/lib/quickbooks';
import { addressesMatch, normalizeUnit } from '@/lib/address-normalize';

// QB vendor name → [canonical provider, utility_type]
const VENDOR_TYPE = [
  [/spectrum|charter/i,                ['spectrum', 'internet']],
  [/con ?edis/i,                       ['conedison', 'electricity']],
  [/southern california edison/i,      ['sce', 'electricity']],
  [/la ?dwp/i,                         ['ladwp', 'electricity']],
  [/socal ?gas|so cal gas/i,           ['socalgas', 'gas']],
  [/at&t|^att\b/i,                     ['att', 'internet']],
  [/t-?mobile/i,                       ['tmobile', 'internet']],
  [/verizon/i,                         ['verizon', 'internet']],
  [/frontier/i,                        ['frontier', 'internet']],
  [/optimum/i,                         ['optimum', 'internet']],
  [/national grid/i,                   ['nationalgrid', 'gas']],
];

function vendorInfo(name) {
  if (!name) return null;
  const hit = VENDOR_TYPE.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

/**
 * Scan classed QB Purchases from the last `sinceDays` days and create
 * missing bills. Returns stats. `maxCreates` bounds the run time.
 */
export async function backfillBillsFromQB({ sinceDays = 60, maxCreates = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);

  const purchases = [];
  let pos = 1;
  while (true) {
    const q = await queryQB(`SELECT * FROM Purchase WHERE TxnDate >= '${since}' STARTPOSITION ${pos} MAXRESULTS 500`);
    const items = q?.QueryResponse?.Purchase || [];
    purchases.push(...items);
    if (items.length < 500) break;
    pos += items.length;
    if (pos > 10000) break;
  }

  const classMap = new Map();
  for (const row of (await pool.query(
    `SELECT qb_class_id, qb_class_name, property_address, unit FROM property_qb_class`
  )).rows) {
    classMap.set(String(row.qb_class_id), row);
  }

  const stats = { scanned: 0, created: 0, covered: 0, unmapped: 0, skipped: 0, errors: 0, createdBills: [] };

  for (const p of purchases) {
    const vi = vendorInfo(p.EntityRef?.name);
    if (!vi) continue;
    const [provider, utilityType] = vi;
    const cls = extractClassInfo(p);
    if (!cls.hasClass) continue;
    stats.scanned++;

    const classId = String(cls.topClass?.value || cls.lineClasses[0]?.value);
    const className = cls.topClass?.name || cls.lineClasses[0]?.name;
    const mapped = classMap.get(classId);
    if (!mapped) { stats.unmapped++; continue; }

    const amount = Number(p.TotalAmt);
    if (!(amount > 0)) { stats.skipped++; continue; }

    // Is this payment already covered by an existing bill?
    const cand = await pool.query(`
      SELECT id, property_address, unit, qb_purchase_id, qb_match_data
      FROM utility_bills
      WHERE utility_type = $1
        AND ROUND(amount_due::numeric, 2) = ROUND($2::numeric, 2)
        AND email_received_at::date BETWEEN ($3::date - INTERVAL '45 days') AND ($3::date + INTERVAL '45 days')
        AND NOT is_duplicate
    `, [utilityType, amount.toFixed(2), p.TxnDate]);

    const covered = cand.rows.some(b => {
      if (String(b.qb_purchase_id || '') === String(p.Id)) return true;
      if (Array.isArray(b.qb_match_data) && b.qb_match_data.some(m => String(m.id) === String(p.Id))) return true;
      if (!b.property_address || !b.property_address.trim()) return true; // unassigned → matcher adopts it
      return addressesMatch(b.property_address, mapped.property_address)
          && normalizeUnit(b.unit) === normalizeUnit(mapped.unit);
    });
    if (covered) { stats.covered++; continue; }

    if (stats.created >= maxCreates) { stats.skipped++; continue; }

    const matchData = [{
      type: 'Purchase', id: p.Id, date: p.TxnDate, amount,
      payee: p.EntityRef?.name || null, account: p.AccountRef?.name || null,
      docNumber: p.DocNumber || null, note: p.PrivateNote || null,
      classId, className, hasClass: true,
    }];

    try {
      const ins = await pool.query(`
        INSERT INTO utility_bills
          (gmail_message_id, utility_type, property_address, unit, account_last4,
           amount_due, due_date, email_received_at, email_subject, email_from, status,
           source, is_duplicate,
           qb_match_status, qb_match_count, qb_match_data, qb_matched_at,
           qb_tag_status, qb_purchase_id, qb_class_id, qb_tagged_at)
        VALUES ($1, $2, $3, $4, NULL,
                $5, NULL, $6, $7, $8, 'paid',
                'qb', false,
                'matched', 1, $9, NOW(),
                'tagged', $10, $11, NOW())
        ON CONFLICT (gmail_message_id) DO NOTHING
        RETURNING id
      `, [
        `qb:${p.Id}`, utilityType, mapped.property_address, mapped.unit,
        amount.toFixed(2), p.TxnDate,
        `Pago en QuickBooks · ${p.EntityRef?.name || provider} · ${className}`,
        `quickbooks:${provider}`,
        JSON.stringify(matchData), String(p.Id), classId,
      ]);
      if (ins.rows.length > 0) {
        stats.created++;
        stats.createdBills.push({ id: ins.rows[0].id, property: mapped.property_address, unit: mapped.unit, type: utilityType, amount, date: p.TxnDate });
      } else {
        stats.covered++; // qb:<id> row already existed
      }
    } catch (e) {
      stats.errors++;
    }
  }

  return stats;
}

/**
 * Auto-learning from Jake's manual Class assignments in QuickBooks.
 *
 * The premise: when Jake assigns a QB Purchase to a Class, he's encoding
 * "this transaction belongs to property X". By cross-referencing those
 * classed Purchases against our utility_bills (by amount + date window), we
 * can infer property→Class mappings we don't have yet.
 *
 * Strict policy:
 *   - We only auto-create a mapping when EXACTLY one utility_bill matches
 *     the classed Purchase (no ambiguity).
 *   - Existing 'manual' mappings are NEVER overwritten — conflicts go to
 *     the audit log and a notification, no DB mutation.
 *   - Inferred mappings can be re-inferred (idempotent within source).
 *
 * Public API:
 *   - runLearningPass({ sinceDays }) → process all classed Purchases in
 *     the time window, return aggregated stats.
 *   - learnFromClassedPurchase(purchase) → single-purchase entry point,
 *     used by both the cron and the historical audit script.
 */

import pool from '@/lib/db';
import { queryQB, extractClassInfo } from '@/lib/quickbooks';
import { createNotification } from '@/lib/notifier';

const DATE_TOLERANCE_DAYS = 15;

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function log({ billId = null, purchaseId, classId, className, propertyAddress = null, unit = null, action, previousClass = null, details = null }) {
  await pool.query(`
    INSERT INTO class_learning_log
      (bill_id, qb_purchase_id, qb_class_id, qb_class_name, property_address, unit, action, previous_class, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [billId, purchaseId, classId, className, propertyAddress, unit, action, previousClass, details]);
}

/**
 * Process a single classed Purchase: find the matching bill and learn/confirm/flag.
 *
 * @param {object} purchase  QB Purchase entity (already known to have Class)
 * @returns {Promise<{action: string, ...}>}
 */
export async function learnFromClassedPurchase(purchase) {
  const cls = extractClassInfo(purchase);
  if (!cls.hasClass) return { action: 'skipped', reason: 'no_class_on_purchase' };

  const classId   = cls.topClass?.value || cls.lineClasses[0]?.value;
  const className = cls.topClass?.name  || cls.lineClasses[0]?.name;
  const purchaseId = purchase.Id;
  const txnDate    = purchase.TxnDate;
  const amount     = Number(purchase.TotalAmt);

  // Find utility_bills with same amount in ±15 day window
  const dateFrom = shiftDate(txnDate, -DATE_TOLERANCE_DAYS);
  const dateTo   = shiftDate(txnDate,  DATE_TOLERANCE_DAYS);
  const candidates = await pool.query(`
    SELECT id, property_address, unit, amount_due, due_date, email_received_at
    FROM utility_bills
    WHERE amount_due = $1
      AND COALESCE(due_date::date, email_received_at::date) BETWEEN $2::date AND $3::date
      AND property_address IS NOT NULL AND TRIM(property_address) != ''
  `, [amount.toFixed(2), dateFrom, dateTo]);

  if (candidates.rowCount === 0) {
    return { action: 'no_bill_match', purchaseId, classId, amount };
  }
  if (candidates.rowCount > 1) {
    return { action: 'ambiguous_bills', purchaseId, classId, candidateCount: candidates.rowCount };
  }

  const bill = candidates.rows[0];
  const property = bill.property_address.trim();
  const unit = bill.unit ? bill.unit.trim() : null;

  // Does a mapping already exist for this property+unit?
  const existing = await pool.query(`
    SELECT qb_class_id, qb_class_name, source FROM property_qb_class
    WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')
  `, [property, unit]);

  if (existing.rowCount > 0) {
    const e = existing.rows[0];
    if (e.qb_class_id === classId) {
      // Same Class — confirmed, no action needed
      await log({
        billId: bill.id, purchaseId, classId, className,
        propertyAddress: property, unit, action: 'confirmed',
        details: `Existing ${e.source} mapping matches`,
      });
      return { action: 'confirmed', billId: bill.id, classId };
    }
    // Conflict — different Class assigned
    if (e.source === 'manual') {
      await log({
        billId: bill.id, purchaseId, classId, className,
        propertyAddress: property, unit, action: 'conflict',
        previousClass: `${e.qb_class_name} (${e.qb_class_id})`,
        details: `Manual mapping disagrees with Jake's Class on Purchase ${purchaseId}`,
      });
      return { action: 'conflict', billId: bill.id, existingClassId: e.qb_class_id, newClassId: classId };
    }
    // Existing inferred mapping — overwrite with latest inferred value
    await pool.query(`
      UPDATE property_qb_class
      SET qb_class_id   = $3,
          qb_class_name = $4,
          inferred_from_bill_id     = $5,
          inferred_from_purchase_id = $6,
          source = 'inferred',
          updated_at = NOW()
      WHERE property_address = $1 AND COALESCE(unit, '') = COALESCE($2, '')
    `, [property, unit, classId, className, bill.id, purchaseId]);
    await log({
      billId: bill.id, purchaseId, classId, className,
      propertyAddress: property, unit, action: 'updated',
      previousClass: `${e.qb_class_name} (${e.qb_class_id})`,
      details: 'Overwrote previous inferred mapping',
    });
    return { action: 'updated', billId: bill.id, classId };
  }

  // No existing mapping — create one with source='inferred'
  await pool.query(`
    INSERT INTO property_qb_class
      (property_address, unit, qb_class_id, qb_class_name, source, inferred_from_bill_id, inferred_from_purchase_id)
    VALUES ($1, $2, $3, $4, 'inferred', $5, $6)
    ON CONFLICT (property_address, COALESCE(unit, '')) DO NOTHING
  `, [property, unit, classId, className, bill.id, purchaseId]);
  await log({
    billId: bill.id, purchaseId, classId, className,
    propertyAddress: property, unit, action: 'created',
    details: 'New mapping inferred from QB Class assignment',
  });
  return { action: 'created', billId: bill.id, classId, className };
}

/**
 * Iterate over all classed Purchases in QB from the last N days and learn from each.
 * Returns aggregated stats.
 */
export async function runLearningPass({ sinceDays = 60 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);

  // Paginate through all Purchases since `since` — using SELECT * to get
  // ClassRef + Line. Filter classed ones in JS.
  const allPurchases = [];
  let pos = 1;
  while (true) {
    const q = await queryQB(`SELECT * FROM Purchase WHERE TxnDate >= '${since}' STARTPOSITION ${pos} MAXRESULTS 500`);
    const items = q?.QueryResponse?.Purchase || [];
    allPurchases.push(...items);
    if (items.length < 500) break;
    pos += 500;
  }

  const classed = allPurchases.filter(p => extractClassInfo(p).hasClass);
  const stats = { processed: classed.length, created: 0, confirmed: 0, updated: 0, conflicts: 0, no_bill_match: 0, ambiguous_bills: 0, skipped: 0 };
  const conflictDetails = [];

  for (const p of classed) {
    const r = await learnFromClassedPurchase(p);
    if (r.action === 'created')        stats.created++;
    else if (r.action === 'confirmed') stats.confirmed++;
    else if (r.action === 'updated')   stats.updated++;
    else if (r.action === 'conflict')  { stats.conflicts++; conflictDetails.push(r); }
    else if (r.action === 'no_bill_match')   stats.no_bill_match++;
    else if (r.action === 'ambiguous_bills') stats.ambiguous_bills++;
    else stats.skipped++;
    await new Promise(r => setTimeout(r, 250));
  }

  // Notify if there's anything notable
  if (stats.created > 0 || stats.conflicts > 0) {
    const parts = [];
    if (stats.created > 0)   parts.push(`✓ ${stats.created} mapeos nuevos inferidos`);
    if (stats.updated > 0)   parts.push(`↻ ${stats.updated} actualizados`);
    if (stats.confirmed > 0) parts.push(`✓ ${stats.confirmed} confirmados`);
    if (stats.conflicts > 0) parts.push(`⚠ ${stats.conflicts} conflictos`);
    await createNotification({
      type:    stats.conflicts > 0 ? 'warning' : 'success',
      title:   `Auto-learn · ${classed.length} Purchases con Class procesados`,
      message: parts.join(' · '),
      metadata: { stats, conflicts: conflictDetails.slice(0, 20) },
    });
  }

  return stats;
}

/**
 * Daily mini-sync: for each Class-tagged Purchase in QB from the last N days,
 * find the matching utility_bill and LINK it (matched + tagged) if it isn't
 * already correctly linked. This closes the loop when Jake classes a Purchase
 * AFTER our matcher has already evaluated the bill incorrectly.
 *
 * Different from runLearningPass: this UPDATES utility_bills to reflect
 * Jake's reality (Jake wins). Same date tolerance ±15 days as the matcher.
 *
 * Returns stats including how many bills got linked/relinked.
 */
export async function linkBillsFromRecentClasses({ sinceDays = 14 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);

  // Pull recent classed Purchases
  const allPurchases = [];
  let pos = 1;
  while (true) {
    const q = await queryQB(`SELECT * FROM Purchase WHERE TxnDate >= '${since}' STARTPOSITION ${pos} MAXRESULTS 500`);
    const items = q?.QueryResponse?.Purchase || [];
    allPurchases.push(...items);
    if (items.length < 500) break;
    pos += 500;
  }
  const classed = allPurchases.filter(p => extractClassInfo(p).hasClass);

  const stats = { processed: classed.length, linked: 0, relinked: 0, property_filled: 0, already_correct: 0, skipped: 0, errors: 0 };

  for (const purchase of classed) {
    const cls = extractClassInfo(purchase);
    const classId   = cls.topClass?.value || cls.lineClasses[0]?.value;
    const className = cls.topClass?.name  || cls.lineClasses[0]?.name;
    const txnDate   = purchase.TxnDate;
    const amount    = Number(purchase.TotalAmt);
    const dateFrom  = shiftDate(txnDate, -DATE_TOLERANCE_DAYS);
    const dateTo    = shiftDate(txnDate,  DATE_TOLERANCE_DAYS);

    // Find candidate bills
    const candidates = await pool.query(`
      SELECT id, property_address, unit, amount_due, due_date, email_received_at,
             qb_purchase_id, qb_tag_status, qb_match_status
      FROM utility_bills
      WHERE amount_due = $1
        AND COALESCE(due_date::date, email_received_at::date) BETWEEN $2::date AND $3::date
    `, [amount.toFixed(2), dateFrom, dateTo]);

    if (candidates.rowCount === 0) { stats.skipped++; continue; }

    // Get the property mapping for this Class
    const mapR = await pool.query(
      `SELECT property_address, unit FROM property_qb_class WHERE qb_class_id = $1 LIMIT 1`,
      [classId]
    );
    const mapping = mapR.rows[0] || null;

    // Pick the best candidate
    let target = null;
    if (mapping) {
      // Prefer candidate matching mapping's property+unit (loose comparison)
      const mapAddrLow = (mapping.property_address || '').toLowerCase().split(',')[0].trim();
      const mapUnitLow = (mapping.unit || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim();
      const matches = candidates.rows.filter(b => {
        const bAddr = (b.property_address || '').toLowerCase().split(',')[0].trim();
        const bUnit = (b.unit || '').toLowerCase().replace(/^apt\.?\s*/, '').replace(/^#\s*/, '').trim();
        return bAddr === mapAddrLow && bUnit === mapUnitLow;
      });
      if (matches.length === 1) target = matches[0];
      else if (matches.length > 1) {
        const tTs = new Date(txnDate).getTime();
        target = matches.sort((a, b) => Math.abs(new Date(a.due_date || a.email_received_at).getTime() - tTs) - Math.abs(new Date(b.due_date || b.email_received_at).getTime() - tTs))[0];
      } else {
        // No bill with matching property — pick Unassigned if exactly one
        const unassigned = candidates.rows.filter(b => !b.property_address || !b.property_address.trim());
        if (unassigned.length === 1) target = unassigned[0];
      }
    } else {
      // No mapping. Single candidate is OK.
      if (candidates.rowCount === 1) target = candidates.rows[0];
    }

    if (!target) { stats.skipped++; continue; }

    // Already correctly linked?
    if (target.qb_tag_status === 'tagged' && target.qb_purchase_id === purchase.Id) {
      stats.already_correct++;
      continue;
    }

    const isRelink = target.qb_purchase_id && target.qb_purchase_id !== purchase.Id;

    // Build new match data
    const matchData = [{
      type: 'Purchase', id: purchase.Id, date: txnDate, amount,
      payee: purchase.EntityRef?.name || null,
      account: purchase.AccountRef?.name || null,
      docNumber: purchase.DocNumber || null,
      note: purchase.PrivateNote || null,
      classId, className, hasClass: true,
    }];

    const newProperty = mapping && (!target.property_address || !target.property_address.trim()) ? mapping.property_address : null;
    const newUnit     = mapping && (!target.unit || !target.unit.trim()) ? mapping.unit : null;

    try {
      await pool.query(`
        UPDATE utility_bills
        SET qb_match_status = 'matched',
            qb_match_count  = 1,
            qb_match_data   = $2,
            qb_matched_at   = NOW(),
            qb_purchase_id  = $3,
            qb_class_id     = $4,
            qb_tag_status   = 'tagged',
            qb_tagged_at    = NOW(),
            property_address = COALESCE($5, property_address),
            unit             = COALESCE($6, unit)
        WHERE id = $1
      `, [target.id, JSON.stringify(matchData), purchase.Id, classId, newProperty, newUnit]);

      await log({
        billId: target.id, purchaseId: purchase.Id, classId, className,
        propertyAddress: target.property_address, unit: target.unit,
        action: isRelink ? 'relinked' : 'synced_from_qb',
        previousClass: isRelink ? `was: Purchase ${target.qb_purchase_id}` : null,
        details: 'Daily mini-sync from QB classes',
      });

      stats.linked++;
      if (isRelink) stats.relinked++;
      if (newProperty) stats.property_filled++;
    } catch (e) {
      stats.errors++;
    }
  }

  return stats;
}

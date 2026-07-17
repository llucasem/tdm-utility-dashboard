import pool from '@/lib/db';
import { addressesMatch, normalizeUnit } from '@/lib/address-normalize';

/**
 * GET /api/expected?month=YYYY-MM
 *
 * Expected-vs-actual for one month: for every ACTIVE row of the
 * expected_accounts catalog, report whether its bill for that month exists
 * and in what state. This is what turns the dashboard from "list of what
 * arrived" into "checklist of what should exist".
 *
 * Status per account:
 *   'paid'     — bill exists and is paid (or its QB payment is matched)
 *   'received' — bill exists, still pending payment
 *   'coming'   — no bill yet, but we're within its normal arrival window
 *   'missing'  — no bill and its typical day (+margin) already passed
 *
 * Margin: accounts seen via email get 12 days past typical_day; accounts
 * that only exist in QB get 35 (Jake accepts the bank feed weeks late).
 */
export async function GET(request) {
  try {
    const monthParam = request?.nextUrl?.searchParams?.get('month'); // 'YYYY-MM'
    const now = new Date();
    const month = /^\d{4}-\d{2}$/.test(monthParam || '') ? monthParam : now.toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);

    const [expected, bills] = await Promise.all([
      pool.query(`SELECT * FROM expected_accounts WHERE active ORDER BY property_address, unit, utility_type`),
      pool.query(`
        SELECT id, utility_type, property_address, unit, amount_due, status,
               qb_match_status, source, email_received_at
        FROM utility_bills
        WHERE amount_due > 0 AND NOT is_duplicate
          AND to_char(email_received_at, 'YYYY-MM') = $1
      `, [month]),
    ]);

    const nowMonth = now.toISOString().slice(0, 7);
    const isFuture = month > nowMonth;

    const accounts = expected.rows.map(exp => {
      const bill = bills.rows.find(b =>
        b.utility_type === exp.utility_type &&
        b.property_address && addressesMatch(b.property_address, exp.property_address) &&
        normalizeUnit(b.unit) === normalizeUnit(exp.unit)
      );

      // Bi-monthly accounts (LADWP bills every 2 months): only expect a bill
      // when this month lines up with the observed cycle, anchored on the
      // last month we actually saw one.
      let offCycle = false;
      const cadence = exp.cadence_months || 1;
      if (cadence > 1 && exp.last_seen) {
        const ls = new Date(exp.last_seen);
        const monthsSince = (y - ls.getUTCFullYear()) * 12 + (m - 1 - ls.getUTCMonth());
        offCycle = ((monthsSince % cadence) + cadence) % cadence !== 0;
      }

      let status;
      if (bill) {
        status = (bill.status === 'paid' || bill.qb_match_status === 'matched') ? 'paid' : 'received';
      } else if (isFuture || offCycle) {
        status = 'coming';
      } else if (exp.typical_amount !== null && Number(exp.typical_amount) <= 15) {
        // Tiny recurring amounts (SoCalGas accounts sitting on a credit
        // balance pay $0 for months) — never alarm on these, there is
        // nothing meaningful to pay even if a cycle is skipped.
        status = 'coming';
      } else {
        // Deadline = typical arrival day of that month + margin, as a real
        // date — works the same for the current month and for past months.
        const margin = exp.source === 'qb' ? 35 : 12;
        const deadline = new Date(Date.UTC(y, m - 1, (exp.typical_day || 15) + margin));
        status = now <= deadline ? 'coming' : 'missing';
      }

      return {
        id: exp.id,
        property: exp.property_address,
        unit: exp.unit || '',
        type: exp.utility_type,
        provider: exp.provider,
        typicalAmount: exp.typical_amount ? Number(exp.typical_amount) : null,
        typicalDay: exp.typical_day,
        source: exp.source,
        qbClassName: exp.qb_class_name,
        status,
        billId: bill ? bill.id : null,
      };
    });

    const missing = accounts.filter(a => a.status === 'missing');
    const coming = accounts.filter(a => a.status === 'coming');

    return Response.json({
      ok: true,
      month,
      totals: {
        expected: accounts.length,
        paid: accounts.filter(a => a.status === 'paid').length,
        received: accounts.filter(a => a.status === 'received').length,
        coming: coming.length,
        missing: missing.length,
      },
      accounts,
    });
  } catch (error) {
    console.error('[expected GET]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

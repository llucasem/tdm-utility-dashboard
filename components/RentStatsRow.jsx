import { fmt } from '@/lib/utils';

/**
 * Stats for the Rent tab — payment confirmations, not bills.
 *
 *   1. Total paid this month  — sum of confirmed rent payments
 *   2. Payments recorded      — count for this month
 *   3. Properties paid        — distinct properties with at least one payment
 *   4. Unassigned             — payments without a mapped property
 *
 * Unlike Utilities, "more rent paid" doesn't have a quality signal — direction
 * is neutral. We display the % change but don't paint it red/green.
 */
export default function RentStatsRow({ monthPayments, prevMonthPayments }) {
  const total     = monthPayments.reduce((s, p) => s + (p.amount || 0), 0);
  const prevTotal = prevMonthPayments.reduce((s, p) => s + (p.amount || 0), 0);

  const propertiesPaid = new Set(
    monthPayments.filter((p) => p.property).map((p) => `${p.property}|||${p.unit || ''}`)
  ).size;

  const unassigned = monthPayments.filter((p) => !p.property).length;

  let pctLabel = null;
  if (prevTotal > 0) {
    const pct = ((total - prevTotal) / prevTotal) * 100;
    pctLabel = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs last month`;
  }

  return (
    <div className="stats-row">
      <div className="stat-card">
        <div className="stat-label">Total paid this month</div>
        <div className="stat-value">{fmt(total)}</div>
        <div className="stat-sub">{pctLabel || 'No data for last month'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Payments recorded</div>
        <div className="stat-value">{monthPayments.length}</div>
        <div className="stat-sub">{prevMonthPayments.length} last month</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Properties paid</div>
        <div className="stat-value">{propertiesPaid}</div>
        <div className="stat-sub">distinct units with rent paid</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Unassigned</div>
        <div
          className="stat-value"
          style={unassigned > 0 ? { color: 'var(--accent)' } : null}
        >
          {unassigned}
        </div>
        <div className="stat-sub">
          {unassigned === 0
            ? 'all mapped ✓'
            : <a href="/admin/landlords" style={{ color: 'var(--accent)' }}>configure landlords →</a>}
        </div>
      </div>
    </div>
  );
}

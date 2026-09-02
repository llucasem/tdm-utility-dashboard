import { fmt } from '@/lib/utils';

const SERVICES = ['electricity', 'internet', 'gas'];
const SERVICE_LABELS = { electricity: 'Electricity', internet: 'Internet', gas: 'Gas' };
const EMPTY_VALUES = ['', '—', 'n/a', 'unknown', '(no address)'];

function normalizeUnit(unit) {
  return (unit || '')
    .replace(/^apt\.?\s*/i, '')
    .replace(/^#\s*/, '')
    .trim();
}

function isMapped(b) {
  return b.property && !EMPTY_VALUES.includes(b.property.trim().toLowerCase());
}

// A recent not_found is NOT an error: the bank payment simply hasn't been
// accepted into QuickBooks yet (Jake reviews the bank feed with a 2-4 week
// lag). Show ⏳ for those; the real ✗ only appears when a bill is old enough
// that its payment should long since be in QB.
const QB_LAG_GRACE_DAYS = 45;

function isWithinQbGrace(bill) {
  if (!bill.dueRaw) return true;
  return (Date.now() - new Date(bill.dueRaw).getTime()) / 86_400_000 <= QB_LAG_GRACE_DAYS;
}

function MatchBadge({ bill }) {
  const status = bill.qbMatchStatus;
  const count  = bill.qbMatchCount || 0;
  if (!status || status === 'pending' || status === 'skipped') return null;
  if (status === 'matched')   return <span className="qb-badge qb-ok"   title="1 match in QuickBooks">✓</span>;
  if (status === 'ambiguous') return <span className="qb-badge qb-warn" title={`${count} possible matches — review manually`}>⚠ {count}</span>;
  if (status === 'not_found') {
    return isWithinQbGrace(bill)
      ? <span className="qb-badge qb-wait" title="Payment not in QuickBooks yet (pending bank-feed review) — retried nightly">⏳</span>
      : <span className="qb-badge qb-miss" title={`No match found in QuickBooks after ${QB_LAG_GRACE_DAYS} days — needs a look`}>✗</span>;
  }
  if (status === 'error')     return <span className="qb-badge qb-err"  title="QuickBooks lookup error — will retry">!</span>;
  return null;
}

function TagBadge({ status }) {
  if (status === 'tagged')    return <span className="qb-tag qb-tag-ok"   title="Tagged in QuickBooks">🏷</span>;
  if (status === 'ambiguous') return <span className="qb-tag qb-tag-warn" title="Multiple QB matches — manual review needed">🏷?</span>;
  if (status === 'error')     return <span className="qb-tag qb-tag-err"  title="Auto-tag error — see notifications">🏷!</span>;
  if (status === 'not_found') return <span className="qb-tag qb-tag-miss" title="Not found in QuickBooks yet">🏷·</span>;
  return null;
}

export default function BillsTable({ filtered, onSelectBill, onAssignBill }) {
  // Separate mapped vs unmapped bills
  const mapped   = filtered.filter(isMapped);
  const unmapped = filtered.filter(b => !isMapped(b));

  // Build property+unit rows from mapped bills
  const rowMap = new Map();
  for (const bill of mapped) {
    const key = `${bill.property}|||${normalizeUnit(bill.unit)}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, { property: bill.property, unit: normalizeUnit(bill.unit), bills: {}, allBills: [] });
    }
    const row = rowMap.get(key);
    row.allBills.push(bill);
    const type = bill.type;
    if (SERVICES.includes(type)) {
      // Keep ALL bills per service. Two statements of the same service can
      // land in the same month (e.g. after a sync backlog catch-up) — the old
      // "first bill wins" rule silently hid the second one.
      if (!row.bills[type]) row.bills[type] = [];
      row.bills[type].push(bill);
    }
  }

  // For each row, find the earliest bill date (first bill of the month for this property)
  for (const row of rowMap.values()) {
    const dated = row.allBills.filter(b => b.dueRaw);
    if (dated.length === 0) {
      row.firstDate = null;
      continue;
    }
    dated.sort((a, b) => a.dueRaw.localeCompare(b.dueRaw));
    row.firstDate = dated[0].due; // formatted "Apr 11"
  }

  // Sort rows: alphabetically by property, then by unit
  const rows = Array.from(rowMap.values()).sort((a, b) => {
    const pa = a.property.toLowerCase();
    const pb = b.property.toLowerCase();
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (a.unit || '').localeCompare(b.unit || '', undefined, { numeric: true });
  });

  // Column totals
  const sumCell = bills => (bills || []).reduce((s, b) => s + (b.amount || 0), 0);
  const colTotals = {};
  for (const svc of SERVICES) {
    colTotals[svc] = rows.reduce((s, r) => s + sumCell(r.bills[svc]), 0);
  }
  const grandTotal = SERVICES.reduce((s, svc) => s + colTotals[svc], 0);

  if (rows.length === 0 && unmapped.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">No entries found</div>
        <p>No bills found for this month</p>
      </div>
    );
  }

  return (
    <div>
      {rows.length > 0 && (
        <div className="property-matrix">
          {/* Header */}
          <div className="matrix-header">
            <span className="th">Property</span>
            <span className="th">Unit</span>
            <span className="th">First bill</span>
            {SERVICES.map(svc => (
              <span key={svc} className="th">{SERVICE_LABELS[svc]}</span>
            ))}
            <span className="th" style={{ textAlign: 'right' }}>Total</span>
          </div>

          {/* Data rows */}
          {rows.map((row, i) => {
            const rowTotal = SERVICES.reduce((s, svc) => s + sumCell(row.bills[svc]), 0);
            return (
              <div key={i} className="matrix-row">
                <span className="td-property">{row.property}</span>
                <span className="td mono">{row.unit || '—'}</span>
                <span className="td mono" style={{ fontSize: 13, color: 'var(--text2)' }}>{row.firstDate || '—'}</span>
                {SERVICES.map(svc => {
                  const cellBills = row.bills[svc];
                  if (!cellBills || cellBills.length === 0) return (
                    <span key={svc} className="matrix-cell-empty">—</span>
                  );
                  // Stack every bill of this service in the cell — each one
                  // stays individually clickable so the detail modal works.
                  return (
                    <span key={svc} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {cellBills.map(bill => (
                        <span
                          key={bill.id}
                          className="matrix-cell"
                          onClick={() => onSelectBill(bill)}
                        >
                          <span className="matrix-cell-amount">
                            {fmt(bill.amount)}
                            <MatchBadge bill={bill} />
                            <TagBadge status={bill.qbTagStatus} />
                          </span>
                          <span className="matrix-cell-account">
                            {bill.source === 'qb' ? 'via QuickBooks' : `·····${bill.account}`}
                          </span>
                          {bill.paidAmount != null ? (
                            <span className="matrix-cell-paid">
                              paid {fmt(bill.paidAmount)} · {bill.paidLabel}
                            </span>
                          ) : bill.status !== 'paid' && (
                            <span className="matrix-cell-unpaid">unpaid</span>
                          )}
                        </span>
                      ))}
                    </span>
                  );
                })}
                <span className="matrix-row-total">{rowTotal > 0 ? fmt(rowTotal) : '—'}</span>
              </div>
            );
          })}

          {/* Totals row */}
          <div className="matrix-total-row">
            <span>Total</span>
            <span></span>
            <span></span>
            {SERVICES.map(svc => (
              <span key={svc} className="mono">{colTotals[svc] > 0 ? fmt(colTotals[svc]) : '—'}</span>
            ))}
            <span className="mono" style={{ textAlign: 'right' }}>{fmt(grandTotal)}</span>
          </div>
        </div>
      )}

      {/* Unmapped bills section */}
      {unmapped.length > 0 && (
        <div className="matrix-unmapped">
          <div className="matrix-unmapped-title">
            Unassigned ({unmapped.length} {unmapped.length === 1 ? 'bill' : 'bills'} — click a row to assign it to a property)
          </div>
          {unmapped.map(bill => (
            <div
              key={bill.id}
              className="matrix-unmapped-row"
              onClick={() => onAssignBill ? onAssignBill(bill) : onSelectBill(bill)}
              title="Click to assign to a property"
            >
              <span className="matrix-unmapped-type">{bill.type}</span>
              <span className="mono">·····{bill.account}</span>
              <span className="mono">{fmt(bill.amount)} <MatchBadge bill={bill} /></span>
              <span className="matrix-unmapped-due">{bill.due}</span>
              <span style={{ color: 'var(--accent)', fontSize: 11, marginLeft: 'auto' }}>+ Assign →</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

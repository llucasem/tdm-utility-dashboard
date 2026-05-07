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

function MatchBadge({ match }) {
  if (!match) return null;
  if (match.count === 1) return <span className="qb-badge qb-ok" title="1 match in QuickBooks">✓</span>;
  if (match.count > 1)   return <span className="qb-badge qb-warn" title={`${match.count} possible matches — review manually`}>⚠ {match.count}</span>;
  return <span className="qb-badge qb-miss" title="No match found in QuickBooks">✗</span>;
}

function TagBadge({ status }) {
  if (status === 'tagged')    return <span className="qb-tag qb-tag-ok"   title="Tagged in QuickBooks">🏷</span>;
  if (status === 'ambiguous') return <span className="qb-tag qb-tag-warn" title="Multiple QB matches — manual review needed">🏷?</span>;
  if (status === 'error')     return <span className="qb-tag qb-tag-err"  title="Auto-tag error — see notifications">🏷!</span>;
  if (status === 'not_found') return <span className="qb-tag qb-tag-miss" title="Not found in QuickBooks yet">🏷·</span>;
  return null;
}

function AnomalyBadge({ bill }) {
  if (!bill.isAnomaly) return null;
  const pct = bill.anomalyRatio ? Math.round((bill.anomalyRatio - 1) * 100) : 0;
  const baseline = bill.anomalyBaseline ? bill.anomalyBaseline.toFixed(2) : '—';
  return (
    <span className="anomaly-badge" title={`+${pct}% above the 6-month average ($${baseline}). Possible leak or billing error.`}>
      ⚡
    </span>
  );
}

export default function BillsTable({ filtered, onSelectBill, onAssignBill, matches = {} }) {
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
      // Keep first bill found for each service (duplicates in same month are rare)
      if (!row.bills[type]) {
        row.bills[type] = bill;
      }
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
  const colTotals = {};
  for (const svc of SERVICES) {
    colTotals[svc] = rows.reduce((s, r) => s + (r.bills[svc]?.amount || 0), 0);
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
            const rowTotal = SERVICES.reduce((s, svc) => s + (row.bills[svc]?.amount || 0), 0);
            return (
              <div key={i} className="matrix-row">
                <span className="td-property">{row.property}</span>
                <span className="td mono">{row.unit || '—'}</span>
                <span className="td mono" style={{ fontSize: 13, color: 'var(--text2)' }}>{row.firstDate || '—'}</span>
                {SERVICES.map(svc => {
                  const bill = row.bills[svc];
                  if (!bill) return (
                    <span key={svc} className="matrix-cell-empty">—</span>
                  );
                  return (
                    <span
                      key={svc}
                      className="matrix-cell"
                      onClick={() => onSelectBill(bill)}
                    >
                      <span className="matrix-cell-amount">
                        {fmt(bill.amount)}
                        <AnomalyBadge bill={bill} />
                        <MatchBadge match={matches[bill.id]} />
                        <TagBadge status={bill.qbTagStatus} />
                      </span>
                      <span className="matrix-cell-account">·····{bill.account}</span>
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
              <span className="mono">{fmt(bill.amount)} <MatchBadge match={matches[bill.id]} /></span>
              <span className="matrix-unmapped-due">{bill.due}</span>
              <span style={{ color: 'var(--accent)', fontSize: 11, marginLeft: 'auto' }}>+ Assign →</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

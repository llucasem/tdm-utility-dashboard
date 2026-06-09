import { fmt } from '@/lib/utils';

const EMPTY_VALUES = ['', '—', 'n/a', 'unknown', '(no address)'];

function isMapped(p) {
  return p.property && !EMPTY_VALUES.includes(p.property.trim().toLowerCase());
}

function shortMailbox(mb) {
  if (!mb) return '—';
  if (mb.length <= 32) return mb;
  return mb.slice(0, 29) + '…';
}

function PortalBadge({ portal }) {
  if (!portal) return null;
  return <span className="portal-badge" title={`Paid via ${portal}`}>{portal}</span>;
}

// Keyboard activator for clickable rows — Enter / Space triggers the callback.
function rowKeyHandler(callback) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      callback();
    }
  };
}

export default function RentTable({ filtered, onSelectPayment, onAssignPayment }) {
  const mapped   = filtered.filter(isMapped);
  const unmapped = filtered.filter((p) => !isMapped(p));

  if (mapped.length === 0 && unmapped.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">No entries found</div>
        <p>No rent payments recorded for this month</p>
      </div>
    );
  }

  // Sort: rows with a date come first (descending), nulls go to the bottom.
  const sorted = [...mapped].sort((a, b) => {
    const av = a.paidDateRaw || '';
    const bv = b.paidDateRaw || '';
    if (!av && !bv) return 0;
    if (!av) return 1;   // a (null) goes after b
    if (!bv) return -1;  // b (null) goes after a
    return bv.localeCompare(av);
  });
  const total = sorted.reduce((s, p) => s + (p.amount || 0), 0);

  return (
    <div>
      {sorted.length > 0 && (
        <div className="rent-table">
          <div className="rent-header">
            <span className="th">Paid</span>
            <span className="th">Property</span>
            <span className="th">Unit</span>
            <span className="th">Landlord</span>
            <span className="th">Portal</span>
            <span className="th" style={{ textAlign: 'right' }}>Amount</span>
          </div>

          {sorted.map((p) => {
            const open = () => onSelectPayment(p);
            return (
              <div
                key={p.id}
                className="rent-row"
                role="button"
                tabIndex={0}
                onClick={open}
                onKeyDown={rowKeyHandler(open)}
                title="View payment details"
                aria-label={`View details for ${fmt(p.amount || 0)} paid ${p.paidDate || ''} at ${p.property || 'unassigned'}`}
              >
                <span className="td mono" style={{ fontSize: 13, color: 'var(--text2)' }}>
                  {p.paidDate || '—'}
                </span>
                <span className="td-property">{p.property}</span>
                <span className="td mono">{p.unit || '—'}</span>
                <span className="td" style={{ fontSize: 13, color: 'var(--text2)' }}>
                  {p.landlord || '—'}
                </span>
                <span className="td">
                  <PortalBadge portal={p.portal} />
                </span>
                <span className="td mono" style={{ textAlign: 'right' }}>
                  {fmt(p.amount || 0)}
                  {p.status === 'paid' && (
                    <span className="rent-paid-check" aria-label="paid" title="Payment confirmed">✓</span>
                  )}
                </span>
              </div>
            );
          })}

          <div className="rent-total-row">
            <span>Total</span>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
            <span className="mono" style={{ textAlign: 'right' }}>{fmt(total)}</span>
          </div>
        </div>
      )}

      {unmapped.length > 0 && (
        <div className="matrix-unmapped">
          <div className="matrix-unmapped-title">
            Unassigned ({unmapped.length} {unmapped.length === 1 ? 'payment' : 'payments'} — click a row to map the mailbox to a property)
          </div>
          {unmapped.map((p) => {
            const open = () => (onAssignPayment ? onAssignPayment(p) : onSelectPayment(p));
            return (
              <div
                key={p.id}
                className="matrix-unmapped-row"
                role="button"
                tabIndex={0}
                onClick={open}
                onKeyDown={rowKeyHandler(open)}
                title="Click to assign mailbox to a property"
                aria-label={`Assign mailbox ${p.mailbox || ''} to a property`}
              >
                <span className="matrix-unmapped-type">rent</span>
                <span className="mono" style={{ fontSize: 12 }}>{shortMailbox(p.mailbox)}</span>
                <span className="mono">{fmt(p.amount || 0)}</span>
                <span className="matrix-unmapped-due">{p.paidDate}</span>
                <span style={{ color: 'var(--accent)', fontSize: 11, marginLeft: 'auto' }}>+ Map mailbox →</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

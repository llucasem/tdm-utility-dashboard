import { fmt } from '@/lib/utils';

export default function BillDetailModal({ bill, onClose, year }) {
  return (
    <div
      className={`overlay ${bill ? 'show' : ''}`}
      onClick={e => { if (e.target.classList.contains('overlay')) onClose(); }}
    >
      {bill && (
        <div className="modal">
          <div className="modal-header">
            <h2>{bill.property}</h2>
            <p>{bill.unit} · {bill.type.charAt(0).toUpperCase() + bill.type.slice(1)}</p>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Account</label>
              <span className="form-value">·····{bill.account}</span>
            </div>
            <div className="form-group">
              <label>Amount due</label>
              <span className="form-value">{fmt(bill.amount)}</span>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Due date</label>
              <span className="form-value">{bill.due}, {year}</span>
            </div>
            <div className="form-group">
              <label>Status</label>
              <span className="form-value">
                <span className={`status-badge ${bill.status}`}>{bill.status}</span>
              </span>
            </div>
          </div>

          {bill.qbMatchStatus && bill.qbMatchStatus !== 'pending' && bill.qbMatchStatus !== 'skipped' && (
            <div className="qb-match-block">
              <label>
                QuickBooks match
                {bill.qbMatchedAt && (
                  <span style={{ color: 'var(--text3)', fontStyle: 'italic', marginLeft: 8 }}>
                    · checked {new Date(bill.qbMatchedAt).toLocaleDateString()}
                  </span>
                )}
              </label>

              {bill.qbMatchStatus === 'not_found' && (
                <p className="qb-match-empty">No matching transaction found in QuickBooks (±15 days).</p>
              )}

              {bill.qbMatchStatus === 'error' && (
                <p className="qb-match-warn">Lookup error — will retry tomorrow.</p>
              )}

              {(bill.qbMatchStatus === 'matched' || bill.qbMatchStatus === 'ambiguous') && (
                <>
                  {bill.qbMatchStatus === 'ambiguous' && (
                    <p className="qb-match-warn">⚠ {bill.qbMatchCount} possible matches — review manually.</p>
                  )}
                  <ul className="qb-match-list">
                    {(bill.qbMatchData || []).map(m => (
                      <li key={`${m.type}-${m.id}`}>
                        <span className="qb-match-date">{m.date}</span>
                        <span className="qb-match-amount">{fmt(Number(m.amount))}</span>
                        <span className="qb-match-payee">{m.payee || m.account || '—'}</span>
                        <span className="qb-match-type">{m.type}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="modal-footer">
            <button className="btn" onClick={onClose}>Close</button>
            {bill.gmailLink && (
              <a className="btn" href={bill.gmailLink} target="_blank" rel="noopener noreferrer">
                View email →
              </a>
            )}
            {bill.status !== 'paid' && <button className="btn primary">Mark as paid</button>}
          </div>
        </div>
      )}
    </div>
  );
}

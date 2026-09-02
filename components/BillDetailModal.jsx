import { useState, useEffect } from 'react';
import { fmt } from '@/lib/utils';

export default function BillDetailModal({ bill, onClose, year, onResolved }) {
  // Cola de revision (paso 4): para una factura sin pago casado se proponen
  // los pagos candidatos de QuickBooks y decide una persona. La decision se
  // guarda manual + locked y no se vuelve a preguntar.
  const [candidates, setCandidates] = useState(null);
  const [assigning,  setAssigning]  = useState(null);
  const needsReview = bill && (bill.qbMatchStatus === 'not_found' || bill.qbMatchStatus === 'ambiguous');

  useEffect(() => {
    setCandidates(null);
    if (!needsReview) return;
    let alive = true;
    fetch(`/api/review-queue?billId=${bill.id}`)
      .then(r => r.json())
      .then(d => { if (alive) setCandidates(d.ok ? d.candidates : []); })
      .catch(() => { if (alive) setCandidates([]); });
    return () => { alive = false; };
  }, [bill?.id, needsReview]);

  const assign = async (paymentId) => {
    setAssigning(paymentId);
    try {
      const r = await fetch('/api/review-queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billId: bill.id, paymentId }),
      });
      const d = await r.json();
      if (d.ok && onResolved) onResolved();
    } finally { setAssigning(null); }
  };

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
              <span className="form-value">
                {bill.source === 'qb'
                  ? <span style={{ fontStyle: 'italic', color: 'var(--text2)' }}>via QuickBooks</span>
                  : <>·····{bill.account}</>}
              </span>
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
                (!bill.dueRaw || (Date.now() - new Date(bill.dueRaw).getTime()) / 86_400_000 <= 45)
                  ? <p className="qb-match-empty">⏳ Payment not in QuickBooks yet — it's likely still pending bank-feed review. Retried automatically every night.</p>
                  : <p className="qb-match-warn">✗ No matching transaction found in QuickBooks after 45 days — worth a manual look.</p>
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

          {needsReview && candidates && candidates.length > 0 && (
            <div className="qb-match-block">
              <label>Possible payments — pick the right one, it sticks</label>
              <ul className="qb-match-list">
                {candidates.map(c => (
                  <li key={c.id} title={c.razones.join(' · ')}>
                    <span className="qb-match-date">{c.paid_date}</span>
                    <span className="qb-match-amount">{fmt(Number(c.amount))}</span>
                    <span className="qb-match-payee">{c.qb_class_name || c.payee || '—'}</span>
                    <button
                      className="btn candidate-btn"
                      disabled={assigning !== null}
                      onClick={() => assign(c.id)}
                    >{assigning === c.id ? 'Saving…' : 'This one'}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(bill.payments || []).length > 0 && (
            <div className="qb-match-block">
              <label>Receipts</label>
              <ul className="qb-match-list">
                {bill.payments.map(p => (
                  <li key={p.qbId}>
                    <span className="qb-match-date">{p.date}</span>
                    <span className="qb-match-amount">{fmt(Number(p.amount))}</span>
                    <span className="qb-match-payee">{p.payee || '—'}</span>
                    <a
                      className="qb-receipt-link"
                      href={`https://qbo.intuit.com/app/expense?txnId=${p.qbId}`}
                      target="_blank" rel="noopener noreferrer"
                      title="Open this transaction in QuickBooks"
                    >QuickBooks →</a>
                  </li>
                ))}
              </ul>
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

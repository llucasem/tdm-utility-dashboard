'use client';

import { useEffect } from 'react';
import { fmt } from '@/lib/utils';

const AIRTABLE_BASE_ID  = process.env.NEXT_PUBLIC_AIRTABLE_BASE_ID  || 'app4hMyYd61s95xqV';
const AIRTABLE_TABLE_ID = process.env.NEXT_PUBLIC_AIRTABLE_TABLE_ID || 'tblcWkXqmdR8JI6Pq';

export default function RentDetailModal({ payment, onClose }) {
  // Close on Escape
  useEffect(() => {
    if (!payment) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [payment, onClose]);

  return (
    <div
      className={`overlay ${payment ? 'show' : ''}`}
      onClick={(e) => { if (e.target.classList.contains('overlay')) onClose(); }}
    >
      {payment && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rent-detail-title"
        >
          <div className="modal-header">
            <h2 id="rent-detail-title">{payment.property || 'Unassigned rent payment'}</h2>
            <p>{payment.unit || '—'} · Rent payment confirmation</p>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Amount paid</label>
              <span className="form-value">{fmt(payment.amount)}</span>
            </div>
            <div className="form-group">
              <label>Paid date</label>
              <span className="form-value">{payment.paidDate || '—'}</span>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Landlord</label>
              <span className="form-value">{payment.landlord || '—'}</span>
            </div>
            <div className="form-group">
              <label>Payment portal</label>
              <span className="form-value">{payment.portal || '—'}</span>
            </div>
          </div>

          {payment.confirmationNumber && (
            <div className="form-row">
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Confirmation #</label>
                <span className="form-value mono">{payment.confirmationNumber}</span>
              </div>
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label>Mailbox (origin)</label>
              <span className="form-value mono" style={{ fontSize: 12 }}>{payment.mailbox || '—'}</span>
            </div>
            <div className="form-group">
              <label>Status</label>
              <span className="form-value">
                <span className={`status-badge ${payment.status || 'paid'}`}>
                  {payment.status || 'paid'}
                </span>
              </span>
            </div>
          </div>

          {payment.subject && (
            <div className="form-row">
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Email subject</label>
                <span className="form-value" style={{ fontSize: 13 }}>{payment.subject}</span>
              </div>
            </div>
          )}

          <div className="modal-footer">
            <button className="btn" onClick={onClose}>Close</button>
            {payment.airtableRecordId && (
              <a
                className="btn"
                href={`https://airtable.com/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}/${payment.airtableRecordId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View in Airtable →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

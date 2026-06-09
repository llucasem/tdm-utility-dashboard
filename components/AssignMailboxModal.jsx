'use client';

import { useState, useEffect, useRef } from 'react';
import { fmt } from '@/lib/utils';

/**
 * Map a mailbox (e.g. gilmarvalencia69@gmail.com) to a property + unit.
 * Once saved, ALL rent payments from that mailbox (past and future)
 * auto-resolve to the same property — Jake only maps each mailbox once.
 */
export default function AssignMailboxModal({ payment, properties, onClose, onAssigned }) {
  const [address, setAddress] = useState('');
  const [unit,    setUnit]    = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const addressInputRef       = useRef(null);

  // Close on Escape, focus first input on open
  useEffect(() => {
    if (!payment) return;
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKey);
    setTimeout(() => addressInputRef.current?.focus(), 50);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id]);

  const handleClose = () => {
    setAddress('');
    setUnit('');
    setError('');
    onClose();
  };

  const handleSave = async () => {
    const trimmed = address.trim();
    if (!trimmed) {
      setError('Please select a property from the list.');
      return;
    }
    // Strict validation: address must be in the known properties list to
    // avoid typo-generated phantom properties (e.g. "472 9th st" vs "472 9th St").
    const known = (properties || []).find(
      (p) => p.toLowerCase() === trimmed.toLowerCase()
    );
    if (!known) {
      setError('Pick a property from the list — or add it first from the "+ Add data" form.');
      return;
    }
    if (!payment?.mailbox) {
      setError('This payment has no mailbox — cannot map.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/mailbox-mappings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          mailbox:          payment.mailbox,
          property_address: known,
          unit:             unit.trim() || null,
          assigned_by:      'dashboard',
        }),
      });
      const data = await res.json();
      if (data.ok) {
        onAssigned(data);
        handleClose();
      } else {
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`overlay ${payment ? 'show' : ''}`}
      onClick={(e) => { if (e.target.classList.contains('overlay')) handleClose(); }}
    >
      {payment && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="map-mailbox-title"
        >
          <div className="modal-header">
            <h2 id="map-mailbox-title">Map mailbox to property</h2>
            <p>
              All rent payments arriving at{' '}
              <code style={{ fontSize: 12, fontStyle: 'normal' }}>{payment.mailbox}</code>{' '}
              will be assigned to this property — past and future.
            </p>
          </div>

          {/* Payment summary strip */}
          <div style={{
            display:       'flex',
            gap:           12,
            alignItems:    'center',
            flexWrap:      'wrap',
            padding:       '12px 0',
            borderBottom:  '1px solid var(--border)',
            marginBottom:  20,
          }}>
            <span className="status-badge rent">rent</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmt(payment.amount)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{payment.paidDate}</span>
            {payment.landlord && (
              <span style={{ color: 'var(--text2)', fontSize: 13 }}>{payment.landlord}</span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="map-mailbox-property">Property address *</label>
            <input
              id="map-mailbox-property"
              ref={addressInputRef}
              className="field-input"
              type="text"
              list="assign-mailbox-property-list"
              placeholder="Pick a property from the list…"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="off"
            />
            <datalist id="assign-mailbox-property-list">
              {(properties || []).map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>

          <div className="form-group">
            <label>Unit (optional)</label>
            <input
              className="field-input"
              type="text"
              placeholder="e.g. 209, Apt 3B"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-footer">
            <button className="btn" onClick={handleClose}>Cancel</button>
            <button className="btn primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Map mailbox'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

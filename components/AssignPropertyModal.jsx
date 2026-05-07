'use client';

import { useState } from 'react';
import { fmt } from '@/lib/utils';

const TYPE_LABELS = {
  electricity: 'Electricity',
  internet:    'Internet',
  gas:         'Gas',
  water:       'Water',
  rent:        'Rent',
  insurance:   'Insurance',
  other:       'Other',
};

export default function AssignPropertyModal({ bill, properties, onClose, onAssigned }) {
  const [address, setAddress] = useState('');
  const [unit,    setUnit]    = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  const handleClose = () => {
    setAddress('');
    setUnit('');
    setError('');
    onClose();
  };

  const handleSave = async () => {
    if (!address.trim()) {
      setError('Please select or enter a property address.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res  = await fetch(`/api/bills/${bill.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ property_address: address.trim(), unit: unit.trim() || null }),
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
      className={`overlay ${bill ? 'show' : ''}`}
      onClick={e => { if (e.target.classList.contains('overlay')) handleClose(); }}
    >
      {bill && (
        <div className="modal">
          <div className="modal-header">
            <h2>Assign to property</h2>
            <p>Choose which property this bill belongs to</p>
          </div>

          {/* Bill summary strip */}
          <div style={{
            display:       'flex',
            gap:           12,
            alignItems:    'center',
            flexWrap:      'wrap',
            padding:       '12px 0',
            borderBottom:  '1px solid var(--border)',
            marginBottom:  20,
          }}>
            <span
              className={`status-badge ${bill.type}`}
              style={{ textTransform: 'capitalize' }}
            >
              {TYPE_LABELS[bill.type] || bill.type}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>·····{bill.account}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmt(bill.amount)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{bill.due}</span>
          </div>

          <div className="form-group">
            <label>Property address *</label>
            <input
              className="field-input"
              type="text"
              list="assign-property-list"
              placeholder="Search or type an address…"
              value={address}
              onChange={e => setAddress(e.target.value)}
              autoComplete="off"
            />
            <datalist id="assign-property-list">
              {properties.map(p => <option key={p} value={p} />)}
            </datalist>
          </div>

          <div className="form-group">
            <label>Unit (optional)</label>
            <input
              className="field-input"
              type="text"
              placeholder="e.g. 209"
              value={unit}
              onChange={e => setUnit(e.target.value)}
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-footer">
            <button className="btn" onClick={handleClose}>Cancel</button>
            <button className="btn primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save assignment'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

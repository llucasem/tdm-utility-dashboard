'use client';

import { useState } from 'react';
import { UTILITY_TYPES } from '@/lib/constants';

const EMPTY_BILL = {
  type: 'electricity', property: '', unit: '', account: '', amount: '', due: '', status: 'pending',
};
const EMPTY_PROP = { address: '', nickname: '' };

export default function AddBillModal({ open, onClose, onSave, properties = [], onPropertyAdded }) {
  const [tab,        setTab]        = useState('bill');
  const [billForm,   setBillForm]   = useState(EMPTY_BILL);
  const [propForm,   setPropForm]   = useState(EMPTY_PROP);
  const [billError,  setBillError]  = useState('');
  const [billSaving, setBillSaving] = useState(false);
  const [propError,  setPropError]  = useState('');
  const [propSaving, setPropSaving] = useState(false);
  const [propSaved,  setPropSaved]  = useState(false);

  const handleClose = () => {
    setBillForm(EMPTY_BILL);
    setPropForm(EMPTY_PROP);
    setBillError('');
    setPropError('');
    setPropSaved(false);
    setTab('bill');
    onClose();
  };

  const handleSaveBill = async () => {
    if (!billForm.amount || !billForm.due || !billForm.property) {
      setBillError('Please fill in property, amount, and due date.');
      return;
    }
    const parsedAmount = parseFloat(billForm.amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setBillError('Amount must be a positive number.');
      return;
    }

    setBillSaving(true);
    setBillError('');
    try {
      const res = await fetch('/api/bills', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          utility_type:     billForm.type,
          property_address: billForm.property,
          unit:             billForm.unit    || null,
          account_last4:    billForm.account || null,
          amount_due:       parsedAmount,
          due_date:         billForm.due,    // YYYY-MM-DD from <input type="date">
          status:           billForm.status,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setBillError(data.error || 'Failed to save');
        return;
      }
      onSave(data.bill);
      setBillForm(EMPTY_BILL);
      onClose();
    } catch {
      setBillError('Network error — please try again');
    } finally {
      setBillSaving(false);
    }
  };

  const handleSaveProperty = async () => {
    if (!propForm.address.trim()) {
      setPropError('Address is required.');
      return;
    }
    setPropSaving(true);
    setPropError('');
    try {
      const res  = await fetch('/api/properties', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ address: propForm.address.trim(), nickname: propForm.nickname.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setPropSaved(true);
        setPropForm(EMPTY_PROP);
        onPropertyAdded?.();
        setTimeout(() => setPropSaved(false), 3000);
      } else {
        setPropError(data.error || 'Failed to save');
      }
    } catch {
      setPropError('Network error — please try again');
    } finally {
      setPropSaving(false);
    }
  };

  const tabStyle = (id) => ({
    background:   'none',
    border:       'none',
    cursor:       'pointer',
    padding:      '8px 16px',
    fontSize:     13,
    fontWeight:   tab === id ? 600 : 400,
    color:        tab === id ? 'var(--accent)' : 'var(--text-muted)',
    borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
    marginBottom: -1,
    fontFamily:   'var(--font-sans)',
  });

  return (
    <div
      className={`overlay ${open ? 'show' : ''}`}
      onClick={e => { if (e.target.classList.contains('overlay')) handleClose(); }}
    >
      {open && (
        <div className="modal">
          <div className="modal-header" style={{ paddingBottom: 0 }}>
            <h2>Add data</h2>
            <div style={{ display: 'flex', gap: 0, marginTop: 12, borderBottom: '1px solid var(--border)' }}>
              <button style={tabStyle('bill')}     onClick={() => setTab('bill')}>Add bill</button>
              <button style={tabStyle('property')} onClick={() => setTab('property')}>Add property</button>
            </div>
          </div>

          {/* ── Add bill tab ──────────────────────────────────────── */}
          {tab === 'bill' && (
            <>
              <div className="form-row" style={{ marginTop: 20 }}>
                <div className="form-group">
                  <label>Utility type</label>
                  <select className="field-select" value={billForm.type}
                    onChange={e => setBillForm(f => ({ ...f, type: e.target.value }))}>
                    {UTILITY_TYPES.map(t => (
                      <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select className="field-select" value={billForm.status}
                    onChange={e => setBillForm(f => ({ ...f, status: e.target.value }))}>
                    <option value="pending">Pending</option>
                    <option value="paid">Paid</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Property *</label>
                <input
                  className="field-input"
                  type="text"
                  list="add-bill-property-list"
                  placeholder="Search or type an address…"
                  value={billForm.property}
                  onChange={e => setBillForm(f => ({ ...f, property: e.target.value }))}
                  autoComplete="off"
                />
                <datalist id="add-bill-property-list">
                  {properties.map(p => <option key={p} value={p} />)}
                </datalist>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Unit</label>
                  <input className="field-input" type="text" placeholder="e.g. 209"
                    value={billForm.unit}
                    onChange={e => setBillForm(f => ({ ...f, unit: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Account (last 4)</label>
                  <input className="field-input mono" type="text" maxLength={4} placeholder="e.g. 7235"
                    value={billForm.account}
                    onChange={e => setBillForm(f => ({ ...f, account: e.target.value.replace(/\D/, '') }))} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Amount due *</label>
                  <input className="field-input mono" type="number" min="0" step="0.01" placeholder="0.00"
                    value={billForm.amount}
                    onChange={e => setBillForm(f => ({ ...f, amount: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Due date *</label>
                  <input className="field-input" type="date" value={billForm.due}
                    onChange={e => setBillForm(f => ({ ...f, due: e.target.value }))} />
                </div>
              </div>

              {billError && <p className="form-error">{billError}</p>}
              <div className="modal-footer">
                <button className="btn" onClick={handleClose}>Cancel</button>
                <button className="btn primary" onClick={handleSaveBill} disabled={billSaving}>
                  {billSaving ? 'Saving…' : 'Save bill'}
                </button>
              </div>
            </>
          )}

          {/* ── Add property tab ──────────────────────────────────── */}
          {tab === 'property' && (
            <>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '16px 0 20px' }}>
                Register a new property so it appears in assignment dropdowns, even before any bills arrive for it.
              </p>

              <div className="form-group">
                <label>Full address *</label>
                <input
                  className="field-input"
                  type="text"
                  placeholder="e.g. 620 Santa Monica Blvd, Santa Monica, CA 90401"
                  value={propForm.address}
                  onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label>Nickname (optional)</label>
                <input
                  className="field-input"
                  type="text"
                  placeholder="e.g. Santa Monica Blvd building"
                  value={propForm.nickname}
                  onChange={e => setPropForm(f => ({ ...f, nickname: e.target.value }))}
                />
              </div>

              {propError && <p className="form-error">{propError}</p>}
              {propSaved && (
                <p style={{ color: 'var(--accent)', fontSize: 13, marginTop: 4 }}>
                  ✓ Property saved successfully
                </p>
              )}

              <div className="modal-footer">
                <button className="btn" onClick={handleClose}>Close</button>
                <button className="btn primary" onClick={handleSaveProperty} disabled={propSaving}>
                  {propSaving ? 'Saving…' : 'Save property'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

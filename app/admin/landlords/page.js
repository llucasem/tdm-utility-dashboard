'use client';

import { useState, useEffect } from 'react';

/**
 * Admin page — Landlord mappings.
 *
 * Each landlord maps to a property address + (optional) default unit.
 * Per-mailbox override rows exist for mailboxes whose alias encodes the
 * unit (e.g. 939broadway+606@thedreammanagement.com → unit 606 at the
 * same building).
 *
 * Saving an address propagates immediately to all historical rent payments
 * of that landlord (back-fill), so the dashboard refreshes without a sync.
 */
export default function AdminLandlords() {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [form,    setForm]    = useState({});
  const [saving,  setSaving]  = useState({});
  const [saved,   setSaved]   = useState({});
  const [error,   setError]   = useState({});

  const load = async () => {
    setLoading(true);
    const r = await fetch('/api/landlord-mappings').then((res) => res.json());
    if (r.ok) {
      setRows(r.landlords);
      // Pre-fill the form with whatever's already saved
      const f = {};
      for (const row of r.landlords) {
        f[key(row)] = { property: row.property || '', unit: row.unit || '' };
      }
      setForm(f);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const key = (r) => `${r.landlord}__${r.mailbox}`;

  const setField = (k, field, value) =>
    setForm((prev) => ({ ...prev, [k]: { ...prev[k], [field]: value } }));

  const handleSave = async (row) => {
    const k = key(row);
    const f = form[k] || {};
    if (!f.property?.trim()) {
      setError((prev) => ({ ...prev, [k]: 'Property address is required' }));
      return;
    }
    setSaving((prev) => ({ ...prev, [k]: true }));
    setError((prev) => ({ ...prev, [k]: '' }));
    setSaved((prev) => ({ ...prev, [k]: '' }));

    try {
      const res  = await fetch('/api/landlord-mappings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          landlord:         row.landlord,
          mailbox:          row.mailbox,
          property_address: f.property.trim(),
          unit:             f.unit?.trim() || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        const upd = data.updated || 0;
        setSaved((prev) => ({ ...prev, [k]: `Saved · ${upd} payment${upd !== 1 ? 's' : ''} back-filled` }));
        await load();
      } else {
        setError((prev) => ({ ...prev, [k]: data.error }));
      }
    } catch {
      setError((prev) => ({ ...prev, [k]: 'Network error' }));
    } finally {
      setSaving((prev) => ({ ...prev, [k]: false }));
    }
  };

  // Group rows: defaults at top, per-mailbox overrides nested under
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.landlord)) groups.set(row.landlord, { default: null, overrides: [] });
    if (row.isDefault) groups.get(row.landlord).default = row;
    else               groups.get(row.landlord).overrides.push(row);
  }

  // Sort landlords: placeholder (no property) first so they're top-of-mind
  const sorted = [...groups.entries()].sort(([la, ga], [lb, gb]) => {
    const aPlaceholder = ga.default?.isPlaceholder !== false;
    const bPlaceholder = gb.default?.isPlaceholder !== false;
    if (aPlaceholder !== bPlaceholder) return aPlaceholder ? -1 : 1;
    return la.localeCompare(lb);
  });

  const stubCount = sorted.filter(([, g]) => g.default?.isPlaceholder).length;
  const totalPayments = sorted.reduce((s, [, g]) => s + (g.default?.totalPayments || 0), 0);
  const assignedTotal = sorted.reduce((s, [, g]) => s + (g.default?.assigned      || 0), 0);

  return (
    <div className="page-wrap">
      <div className="topbar">
        <div className="brand">
          <h1>TDM Utilities</h1>
          <span className="tag">Landlord Mappings</span>
        </div>
        <div className="topbar-right">
          <a href="/" className="btn">← Back to dashboard</a>
        </div>
      </div>

      <div style={{ padding: '32px 24px', maxWidth: 940, margin: '0 auto' }}>
        <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 24, marginBottom: 8 }}>
          Landlord Mappings
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: 14 }}>
          Tell the system which property each landlord corresponds to. Save once per landlord
          and all rent payments — past and future — are auto-assigned.
        </p>

        {/* Stats strip */}
        {!loading && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <span className="qbc-stat">
              {sorted.length} landlord{sorted.length !== 1 ? 's' : ''} detected
            </span>
            <span className="qbc-stat">
              {stubCount} need{stubCount === 1 ? 's' : ''} an address
            </span>
            <span className="qbc-stat">
              {assignedTotal} / {totalPayments} payments assigned
            </span>
          </div>
        )}

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        ) : sorted.length === 0 ? (
          <div className="empty-state" style={{ margin: '24px 0' }}>
            <p>No landlord rows yet — they'll appear here as rent payments are synced.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {sorted.map(([landlord, group]) => {
              const def = group.default;
              if (!def) return null;
              const k = key(def);
              const f = form[k] || {};
              const stub = def.isPlaceholder;

              return (
                <div
                  key={landlord}
                  style={{
                    background:   'var(--surface)',
                    border:       stub ? '1px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    padding:      '18px 22px',
                    boxShadow:    'var(--shadow-sm)',
                  }}
                >
                  {/* Header strip */}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 14, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 15, fontFamily: 'var(--font-serif)' }}>
                      {landlord}
                    </strong>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                      {def.totalPayments} payment{def.totalPayments !== 1 ? 's' : ''}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                      · {def.assigned} assigned
                    </span>
                    {stub && (
                      <span
                        style={{
                          marginLeft:    'auto',
                          background:    'var(--accent)',
                          color:         '#fff',
                          padding:       '2px 9px',
                          borderRadius:  4,
                          fontSize:      11,
                          fontWeight:    600,
                          letterSpacing: '0.5px',
                          textTransform: 'uppercase',
                        }}
                      >
                        Needs address
                      </span>
                    )}
                  </div>

                  {/* Form */}
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.7fr auto', gap: 10, alignItems: 'end' }}>
                    <div>
                      <label className="form-label" style={{ fontSize: 12, color: 'var(--text2)' }}>
                        Property address *
                      </label>
                      <input
                        className="field-input"
                        type="text"
                        placeholder="e.g. 13488 Maxella Ave, Marina Del Rey, CA 90292"
                        value={f.property || ''}
                        onChange={(e) => setField(k, 'property', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="form-label" style={{ fontSize: 12, color: 'var(--text2)' }}>
                        Default unit
                      </label>
                      <input
                        className="field-input"
                        type="text"
                        placeholder="e.g. 501"
                        value={f.unit || ''}
                        onChange={(e) => setField(k, 'unit', e.target.value)}
                      />
                    </div>
                    <button
                      className="btn primary"
                      onClick={() => handleSave(def)}
                      disabled={saving[k]}
                      style={{ height: 38 }}
                    >
                      {saving[k] ? 'Saving…' : 'Save'}
                    </button>
                  </div>

                  {error[k] && <p style={{ color: '#c0392b', fontSize: 13, marginTop: 8 }}>{error[k]}</p>}
                  {saved[k] && <p style={{ color: 'var(--accent)', fontSize: 13, marginTop: 8 }}>✓ {saved[k]}</p>}

                  {/* Per-mailbox overrides */}
                  {group.overrides.length > 0 && (
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 8 }}>
                        Per-mailbox overrides (units encoded in the mailbox alias)
                      </div>
                      {group.overrides.map((ov) => (
                        <div
                          key={key(ov)}
                          style={{
                            display:       'grid',
                            gridTemplateColumns: '1.6fr 0.6fr 1.4fr',
                            gap:           10,
                            fontSize:      13,
                            padding:       '4px 0',
                            color:         'var(--text2)',
                          }}
                        >
                          <span className="mono" style={{ fontSize: 12 }}>{ov.mailbox}</span>
                          <span className="mono">unit {ov.unit || '—'}</span>
                          <span style={{ fontStyle: 'italic', fontSize: 12 }}>{ov.notes || ''}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {def.notes && !stub && (
                    <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10, fontStyle: 'italic' }}>
                      {def.notes}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

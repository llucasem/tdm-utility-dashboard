'use client';

import { useState, useEffect } from 'react';

const TYPE_LABELS = {
  electricity: 'Electricity',
  gas:         'Gas',
  internet:    'Internet',
  water:       'Water',
  rent:        'Rent',
  insurance:   'Insurance',
  other:       'Other',
};

const FLAG_CONFIG = {
  collision:       { label: 'Account collision',  color: '#c0392b', bg: '#fff5f5', border: '#fed7d7' },
  missing_account: { label: 'Missing account #',  color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  dual_account:    { label: 'Two accounts found', color: '#744210', bg: '#fffff0', border: '#f6e05e' },
};

// ── Context chips shown per unmapped account card ─────────────────────────────
function ContextRow({ account }) {
  // Dollar range
  const lo = account.amount_min != null ? parseFloat(account.amount_min) : null;
  const hi = account.amount_max != null ? parseFloat(account.amount_max) : null;
  const fmt = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const amountLabel = lo !== null && hi !== null
    ? (lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`)
    : null;

  // Date range — "Jan 2026" or "Jan – Apr 2026"
  const fmtMonth = (iso) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const dateLabel = account.date_min && account.date_max
    ? (() => {
        const a = fmtMonth(account.date_min);
        const b = fmtMonth(account.date_max);
        return a === b ? a : `${a} – ${b}`;
      })()
    : null;

  // Sender — extract domain from "Display Name <email@domain.com>" or bare email
  const senderLabel = account.senders
    ? [...new Set(
        account.senders.split(', ').map(s => {
          const m = s.match(/<([^>]+@[^>]+)>/) || s.match(/(\S+@\S+)/);
          const addr = m ? m[1] : s;
          return addr.includes('@') ? addr.split('@')[1] : addr;
        })
      )].join(', ')
    : null;

  const chips = [
    senderLabel           && { icon: '✉', text: senderLabel,             mono: false },
    amountLabel           && { icon: '$', text: amountLabel,             mono: true  },
    dateLabel             && { icon: '◷', text: dateLabel,               mono: true  },
    account.email_subject && { icon: '·', text: account.email_subject,   mono: false },
  ].filter(Boolean);

  if (chips.length === 0) return null;

  return (
    <div style={{
      display:       'flex',
      flexWrap:      'wrap',
      gap:           8,
      marginBottom:  14,
      paddingBottom: 12,
      borderBottom:  '1px solid var(--border)',
    }}>
      {chips.map((c, i) => (
        <span key={i} style={{
          display:     'inline-flex',
          alignItems:  'center',
          gap:         5,
          background:  'var(--surface2)',
          border:      '1px solid var(--border)',
          borderRadius: 6,
          padding:     '3px 10px',
          fontSize:    12,
          fontFamily:  c.mono ? 'var(--font-mono)' : 'inherit',
          color:       'var(--text2)',
          maxWidth:    420,
          overflow:    'hidden',
          textOverflow: 'ellipsis',
          whiteSpace:  'nowrap',
        }}>
          <span style={{ color: 'var(--accent)', fontSize: 10, flexShrink: 0 }}>{c.icon}</span>
          {c.text}
        </span>
      ))}
    </div>
  );
}

// ── Review Flag Card ──────────────────────────────────────────────────────────
function FlagCard({ flag, onDismiss }) {
  const cfg = FLAG_CONFIG[flag.tag] || FLAG_CONFIG.missing_account;

  return (
    <div style={{
      border:       `1px solid ${cfg.border}`,
      background:   cfg.bg,
      borderRadius: 8,
      padding:      '16px 20px',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{
          background:    cfg.color,
          color:         '#fff',
          padding:       '2px 10px',
          borderRadius:  20,
          fontSize:      12,
          fontWeight:    600,
          letterSpacing: '0.03em',
        }}>
          {cfg.label.toUpperCase()}
        </span>
        <span className={`status-badge ${flag.utility_type}`} style={{ textTransform: 'capitalize' }}>
          {TYPE_LABELS[flag.utility_type] || flag.utility_type}
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{flag.provider}</span>
        {flag.account_last4 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            Account ···{flag.account_last4}
          </span>
        )}
      </div>

      {flag.address && (
        <p style={{ fontSize: 14, marginBottom: 6 }}>
          <strong>Property:</strong> {flag.address}{flag.unit ? `, Apt ${flag.unit}` : ''}
        </p>
      )}
      {flag.addresses && (
        <div style={{ marginBottom: 6 }}>
          {flag.addresses.map((a, i) => (
            <p key={i} style={{ fontSize: 14, margin: '2px 0' }}>
              <strong>Property {i + 1}:</strong> {a.address}{a.unit ? `, Apt ${a.unit}` : ''}
            </p>
          ))}
        </div>
      )}

      <p style={{ fontSize: 13, color: cfg.color, marginTop: 8, lineHeight: 1.5 }}>
        ⚠ {flag.note}
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
        {flag.tag === 'collision'
          ? 'Once you verify the correct account in the portal, add two separate mappings in the "Unmapped accounts" section below.'
          : flag.tag === 'missing_account'
          ? 'Look up the account number in the utility portal, then add the mapping in the "Unmapped accounts" section below.'
          : 'Verify which account number is currently active in the utility portal.'}
      </p>
      <div style={{ marginTop: 14, borderTop: `1px solid ${cfg.border}`, paddingTop: 12 }}>
        <button
          onClick={onDismiss}
          style={{
            background:   'transparent',
            border:       `1px solid ${cfg.border}`,
            borderRadius: 6,
            padding:      '5px 14px',
            fontSize:     12,
            color:        cfg.color,
            cursor:       'pointer',
            fontWeight:   500,
          }}
        >
          ✓ Mark as resolved
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AdminMappings() {
  const [unmapped,     setUnmapped]     = useState([]);
  const [mappings,     setMappings]     = useState([]);
  const [flags,        setFlags]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [form,         setForm]         = useState({});
  const [saving,       setSaving]       = useState({});
  const [saved,        setSaved]        = useState({});
  const [error,        setError]        = useState({});
  const [dismissing,   setDismissing]   = useState({});

  const load = async () => {
    setLoading(true);
    const [u, m, f] = await Promise.all([
      fetch('/api/account-mappings/unmapped').then(r => r.json()),
      fetch('/api/account-mappings').then(r => r.json()),
      fetch('/api/review-flags').then(r => r.json()),
    ]);
    if (u.ok) setUnmapped(u.accounts);
    if (m.ok) setMappings(m.mappings);
    if (f.ok) setFlags(f.flags);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const key = (a) => `${a.utility_type}__${a.account_last4}`;

  const handleSave = async (account) => {
    const k = key(account);
    const f = form[k] || {};
    if (!f.property?.trim()) {
      setError(prev => ({ ...prev, [k]: 'Property address is required' }));
      return;
    }
    setSaving(prev => ({ ...prev, [k]: true }));
    setError(prev => ({ ...prev, [k]: '' }));

    try {
      const res  = await fetch('/api/account-mappings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          utility_type:     account.utility_type,
          account_last4:    account.account_last4,
          provider:         f.provider || '',
          property_address: f.property.trim(),
          unit:             f.unit?.trim() || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaved(prev => ({ ...prev, [k]: `Saved · ${data.billsUpdated} bill${data.billsUpdated !== 1 ? 's' : ''} updated` }));
        await load();
      } else {
        setError(prev => ({ ...prev, [k]: data.error }));
      }
    } catch {
      setError(prev => ({ ...prev, [k]: 'Network error' }));
    } finally {
      setSaving(prev => ({ ...prev, [k]: false }));
    }
  };

  const handleDismiss = async (flagId) => {
    setDismissing(prev => ({ ...prev, [flagId]: true }));
    try {
      const res  = await fetch(`/api/review-flags?id=${flagId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        setFlags(prev => prev.filter(f => f.id !== flagId));
      }
    } finally {
      setDismissing(prev => ({ ...prev, [flagId]: false }));
    }
  };

  const setField = (k, field, value) =>
    setForm(prev => ({ ...prev, [k]: { ...prev[k], [field]: value } }));

  return (
    <div className="page-wrap">
      <div className="topbar">
        <div className="brand">
          <h1>TDM Utilities</h1>
          <span className="tag">Account Mappings</span>
        </div>
        <div className="topbar-right">
          <a href="/" className="btn">← Back to dashboard</a>
        </div>
      </div>

      <div style={{ padding: '32px 24px', maxWidth: 940, margin: '0 auto' }}>
        <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 24, marginBottom: 8 }}>
          Account Mappings
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 36, fontSize: 14 }}>
          Map utility account numbers to their property addresses. Done once per account —
          all existing and future bills update automatically.
        </p>

        {/* ── Needs Review ──────────────────────────────────────────────── */}
        {!loading && flags.length > 0 && (
          <section style={{ marginBottom: 48 }}>
            <h3 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, marginBottom: 4 }}>
              Needs your review
              <span style={{
                marginLeft:   10,
                background:   '#c0392b',
                color:        '#fff',
                borderRadius: 20,
                padding:      '1px 9px',
                fontSize:     13,
                fontWeight:   700,
                verticalAlign: 'middle',
              }}>
                {flags.length}
              </span>
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
              These accounts couldn't be mapped automatically and need manual action.
            </p>
            {flags.map(f => (
              <FlagCard
                key={f.id}
                flag={f}
                onDismiss={() => handleDismiss(f.id)}
                dismissing={dismissing[f.id]}
              />
            ))}
          </section>
        )}

        {/* ── Unmapped accounts ──────────────────────────────────────────── */}
        <h3 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, marginBottom: 4 }}>
          Unmapped accounts{' '}
          {!loading && (
            <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>({unmapped.length})</span>
          )}
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Accounts with bills in the system that still need a property address.
        </p>

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        ) : unmapped.length === 0 ? (
          <div className="empty-state" style={{ margin: '24px 0' }}>
            <p>All accounts have been mapped.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 48 }}>
            {unmapped.map(account => {
              const k = key(account);
              return (
                <div key={k} className="modal-card" style={{ padding: 20, borderRadius: 8 }}>

                  {/* Identity strip */}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap' }}>
                    <span className={`status-badge ${account.utility_type}`} style={{ textTransform: 'capitalize' }}>
                      {TYPE_LABELS[account.utility_type] || account.utility_type}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
                      Account ···{account.account_last4}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                      {account.bill_count} bill{account.bill_count !== '1' ? 's' : ''}
                    </span>
                  </div>

                  {/* Context chips */}
                  <ContextRow account={account} />

                  {/* Form fields */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                    <div>
                      <label className="form-label">Provider (optional)</label>
                      <input
                        className="form-input"
                        value={form[k]?.provider || ''}
                        onChange={e => setField(k, 'provider', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="form-label">Property address *</label>
                      <input
                        className="form-input"
                        value={form[k]?.property || ''}
                        onChange={e => setField(k, 'property', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="form-label">Unit (optional)</label>
                      <input
                        className="form-input"
                        value={form[k]?.unit || ''}
                        onChange={e => setField(k, 'unit', e.target.value)}
                      />
                    </div>
                  </div>

                  {error[k] && <p style={{ color: '#e53e3e', fontSize: 13, marginBottom: 8 }}>{error[k]}</p>}
                  {saved[k] && <p style={{ color: 'var(--accent)', fontSize: 13, marginBottom: 8 }}>✓ {saved[k]}</p>}

                  <button
                    className="btn primary"
                    onClick={() => handleSave(account)}
                    disabled={saving[k]}
                  >
                    {saving[k] ? 'Saving…' : 'Save mapping'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Saved mappings ─────────────────────────────────────────────── */}
        {mappings.length > 0 && (
          <>
            <h3 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, marginBottom: 16 }}>
              Saved mappings{' '}
              <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>({mappings.length})</span>
            </h3>
            <div className="table-wrap">
              <div className="table-header" style={{ gridTemplateColumns: '1fr 1fr 1fr 2fr 1fr' }}>
                <span className="th">Type</span>
                <span className="th">Provider</span>
                <span className="th">Account</span>
                <span className="th">Property</span>
                <span className="th">Unit</span>
              </div>
              {mappings.map(m => (
                <div key={m.id} className="table-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 2fr 1fr' }}>
                  <span className="td" style={{ textTransform: 'capitalize' }}>{TYPE_LABELS[m.utility_type] || m.utility_type}</span>
                  <span className="td">{m.provider || '—'}</span>
                  <span className="td mono">···{m.account_last4}</span>
                  <span className="td">{m.property_address}</span>
                  <span className="td">{m.unit || '—'}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

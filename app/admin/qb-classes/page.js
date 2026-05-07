'use client';

import { useEffect, useState } from 'react';

export default function QBClassesAdminPage() {
  const [properties,   setProperties]   = useState([]);
  const [mappings,     setMappings]     = useState({});       // key => { qb_class_id, qb_class_name }
  const [classes,      setClasses]      = useState([]);
  const [suggestions,  setSuggestions]  = useState({});       // key => { qb_class_id, qb_class_name, confidence, reasoning }
  const [loading,      setLoading]      = useState(true);
  const [suggesting,   setSuggesting]   = useState(false);
  const [savingKey,    setSavingKey]    = useState(null);
  const [search,       setSearch]       = useState('');
  const [filter,       setFilter]       = useState('all');     // all | mapped | unmapped | suggested

  const keyOf = (p) => `${p.property_address}|||${p.unit || ''}`;

  const fetchData = async () => {
    setLoading(true);
    try {
      const [pqcRes, classesRes] = await Promise.all([
        fetch('/api/property-qb-class').then(r => r.json()),
        fetch('/api/quickbooks/classes').then(r => r.json()),
      ]);
      if (pqcRes.ok) {
        setProperties(pqcRes.properties);
        const map = {};
        for (const m of pqcRes.mappings) {
          map[`${m.property_address}|||${m.unit || ''}`] = m;
        }
        setMappings(map);
      }
      if (classesRes.ok) setClasses(classesRes.classes);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const runSuggest = async () => {
    setSuggesting(true);
    try {
      const res  = await fetch('/api/property-qb-class/suggest', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      });
      const data = await res.json();
      if (data.ok) {
        const out = {};
        for (const s of data.suggestions) {
          out[`${s.property_address}|||${s.unit || ''}`] = s;
        }
        setSuggestions(out);
      } else {
        alert('Error: ' + data.error);
      }
    } finally {
      setSuggesting(false);
    }
  };

  const acceptSuggestion = async (p) => {
    const k = keyOf(p);
    const s = suggestions[k];
    if (!s || !s.qb_class_id) return;
    await save(p, s.qb_class_id, s.qb_class_name);
  };

  const save = async (p, qb_class_id, qb_class_name) => {
    const k = keyOf(p);
    setSavingKey(k);
    try {
      const res = await fetch('/api/property-qb-class', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ property_address: p.property_address, unit: p.unit, qb_class_id, qb_class_name }),
      });
      const data = await res.json();
      if (data.ok) {
        setMappings(prev => ({ ...prev, [k]: { property_address: p.property_address, unit: p.unit, qb_class_id, qb_class_name } }));
      } else {
        alert('Error: ' + data.error);
      }
    } finally {
      setSavingKey(null);
    }
  };

  const remove = async (p) => {
    const k = keyOf(p);
    setSavingKey(k);
    try {
      await fetch('/api/property-qb-class', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ property_address: p.property_address, unit: p.unit }),
      });
      setMappings(prev => {
        const next = { ...prev };
        delete next[k];
        return next;
      });
    } finally {
      setSavingKey(null);
    }
  };

  const acceptAllConfident = async () => {
    const high = Object.entries(suggestions).filter(([k, s]) =>
      s.qb_class_id && s.confidence >= 0.85 && !mappings[k]
    );
    if (high.length === 0) {
      alert('No high-confidence suggestions to accept');
      return;
    }
    if (!confirm(`Accept ${high.length} suggestions with confidence ≥ 85%?`)) return;
    for (const [k, s] of high) {
      const [property_address, unit] = k.split('|||');
      await save({ property_address, unit }, s.qb_class_id, s.qb_class_name);
    }
  };

  // Filtering
  const filtered = properties.filter(p => {
    const k = keyOf(p);
    if (search && !`${p.property_address} ${p.unit}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'mapped'    && !mappings[k]) return false;
    if (filter === 'unmapped'  &&  mappings[k]) return false;
    if (filter === 'suggested' && (!suggestions[k] || mappings[k])) return false;
    return true;
  });

  const stats = {
    total:     properties.length,
    mapped:    Object.keys(mappings).length,
    unmapped:  properties.length - Object.keys(mappings).length,
    suggested: Object.keys(suggestions).filter(k => !mappings[k] && suggestions[k].qb_class_id).length,
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div className="page-wrap" style={{ padding: '24px 32px' }}>
      <h1 style={{ margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>Property → QuickBooks Class</h1>
      <p style={{ marginTop: 0, color: 'var(--text2)', fontSize: 13 }}>
        Map each property/unit to a QuickBooks Class. Auto-tag will use this mapping.
      </p>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
        <span className="qbc-stat">Total: <b>{stats.total}</b></span>
        <span className="qbc-stat" style={{ color: '#2e6b27' }}>Mapped: <b>{stats.mapped}</b></span>
        <span className="qbc-stat" style={{ color: '#8a2828' }}>Unmapped: <b>{stats.unmapped}</b></span>
        {stats.suggested > 0 && <span className="qbc-stat" style={{ color: '#8a6418' }}>Pending suggestions: <b>{stats.suggested}</b></span>}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          className="search-input"
          placeholder="Search property…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 240px' }}
        />
        <select className="qbc-select" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="mapped">Only mapped</option>
          <option value="unmapped">Only unmapped</option>
          <option value="suggested">Has suggestion</option>
        </select>
        <button className="btn" onClick={runSuggest} disabled={suggesting}>
          {suggesting ? '⏳ Asking Claude…' : '🤖 Suggest with AI'}
        </button>
        {stats.suggested > 0 && (
          <button className="btn primary" onClick={acceptAllConfident}>
            ✓ Accept all ≥85% confidence
          </button>
        )}
      </div>

      {/* Table */}
      <div className="property-matrix">
        <div className="qbc-row qbc-header">
          <span>Property</span>
          <span>Unit</span>
          <span>Mapped Class</span>
          <span>AI suggestion</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {filtered.map(p => {
          const k         = keyOf(p);
          const mapping   = mappings[k];
          const suggested = suggestions[k];
          const isSaving  = savingKey === k;

          return (
            <div key={k} className="qbc-row">
              <span style={{ fontSize: 13 }}>{p.property_address}</span>
              <span className="mono" style={{ fontSize: 13 }}>{p.unit || '—'}</span>

              <span>
                <select
                  className="qbc-select"
                  value={mapping?.qb_class_id || ''}
                  disabled={isSaving}
                  onChange={e => {
                    const id = e.target.value;
                    if (!id) {
                      remove(p);
                    } else {
                      const c = classes.find(c => c.id === id);
                      save(p, id, c?.name || '');
                    }
                  }}
                  style={{ width: '100%' }}
                >
                  <option value="">— not mapped —</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </span>

              <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                {suggested ? (
                  suggested.qb_class_id ? (
                    <>
                      <span style={{ fontWeight: 600 }}>{suggested.qb_class_name}</span>
                      {' '}
                      <span style={{
                        color: suggested.confidence >= 0.85 ? '#2e6b27' :
                               suggested.confidence >= 0.5  ? '#8a6418' : '#8a2828'
                      }}>
                        ({Math.round(suggested.confidence * 100)}%)
                      </span>
                    </>
                  ) : <span style={{ color: '#8a2828' }}>no plausible match</span>
                ) : <span style={{ color: 'var(--text3)' }}>—</span>}
              </span>

              <span style={{ textAlign: 'right' }}>
                {suggested?.qb_class_id && (!mapping || mapping.qb_class_id !== suggested.qb_class_id) && (
                  <button className="btn" onClick={() => acceptSuggestion(p)} disabled={isSaving} style={{ fontSize: 11 }}>
                    ✓ Accept
                  </button>
                )}
              </span>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="empty-state"><p>No properties match this filter</p></div>
        )}
      </div>
    </div>
  );
}

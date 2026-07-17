'use client';

import { useState, useEffect } from 'react';
import { fmt } from '@/lib/utils';

const TYPE_LABELS = { electricity: 'Electricity', internet: 'Internet', gas: 'Gas', water: 'Water' };
const PROVIDER_LABELS = {
  spectrum: 'Spectrum', sce: 'SCE', ladwp: 'LADWP', socalgas: 'SoCalGas',
  conedison: 'ConEd', att: 'AT&T', tmobile: 'T-Mobile', verizon: 'Verizon',
  frontier: 'Frontier', optimum: 'Optimum', nationalgrid: 'National Grid', otro: '—',
};

/**
 * "What SHOULD exist this month" — reads /api/expected and surfaces the
 * accounts whose bill hasn't appeared. This is the checklist that replaces
 * Jake logging into provider portals one by one to see what's missing.
 */
export default function ExpectedPanel({ monthIndex, year, refreshTick }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(true);

  const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  useEffect(() => {
    let alive = true;
    fetch(`/api/expected?month=${month}`)
      .then(r => r.json())
      .then(d => { if (alive && d.ok) setData(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [month, refreshTick]);

  if (!data) return null;
  const missing = data.accounts.filter(a => a.status === 'missing');
  const coming = data.totals.coming;

  if (missing.length === 0) {
    return (
      <div className="expected-ok">
        ✓ All {data.totals.expected} expected bills accounted for
        {coming > 0 && <> — {coming} still within their normal arrival window</>}
      </div>
    );
  }

  return (
    <div className="expected-panel">
      <div className="expected-title" onClick={() => setOpen(o => !o)}>
        <span>
          ⚠ {missing.length} expected {missing.length === 1 ? 'bill has' : 'bills have'} not appeared this month
          {coming > 0 && <span className="expected-coming"> · {coming} more still in their normal window</span>}
        </span>
        <span className="expected-chevron">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div>
          {missing.map(a => (
            <div key={a.id} className="expected-row">
              <span className="expected-prop">{a.property}</span>
              <span className="mono">{a.unit || '—'}</span>
              <span>{TYPE_LABELS[a.type] || a.type}</span>
              <span className="mono">{PROVIDER_LABELS[a.provider] || a.provider}</span>
              <span className="mono">{a.typicalAmount ? `~${fmt(a.typicalAmount)}` : '—'}</span>
              <span className="expected-hint">
                {a.source === 'qb' ? 'no email — check portal / QB' : `usually arrives ~day ${a.typicalDay || '?'}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

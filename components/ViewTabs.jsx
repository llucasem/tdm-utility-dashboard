'use client';

import { useRef } from 'react';

/**
 * Two-tab navigation between Utilities and Rent views.
 *
 * Implements the WAI-ARIA tabs pattern:
 *  - role="tablist" → role="tab" for each button
 *  - aria-controls links each tab to its panel (rendered in page.js)
 *  - Left/Right arrows move focus between tabs
 *  - Only the active tab is in the regular tab order (tabIndex=0)
 *
 * Maintains the "Madera y Lino" identity — solid border, accent for the
 * active pill, subtle hover on the inactive one.
 */
const TABS = [
  { id: 'utilities', label: 'Utilities' },
  { id: 'rent',      label: 'Rent'      },
];

export default function ViewTabs({ view, onChange }) {
  const refs = useRef([]);

  const onKeyDown = (e, i) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = e.key === 'ArrowRight'
      ? (i + 1) % TABS.length
      : (i - 1 + TABS.length) % TABS.length;
    onChange(TABS[next].id);
    refs.current[next]?.focus();
  };

  return (
    <nav className="view-tabs" role="tablist" aria-label="Dashboard view">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          role="tab"
          aria-selected={view === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={view === t.id ? 0 : -1}
          ref={(el) => { refs.current[i] = el; }}
          className={`view-tab ${view === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

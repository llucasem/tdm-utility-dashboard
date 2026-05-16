'use client';

import { useEffect, useState } from 'react';

/**
 * Yellow banner that appears at the top of the dashboard when /api/health
 * reports warnings — dead sync, QB token about to expire, low mapping
 * coverage, etc.
 *
 * Fetches on mount and every 10 minutes.
 */
export default function HealthBanner() {
  const [warnings, setWarnings] = useState([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        if (data.ok && Array.isArray(data.warnings)) {
          setWarnings(data.warnings);
        }
      } catch {}
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (warnings.length === 0 || dismissed) return null;

  return (
    <div style={{
      background:    '#FFF6D5',
      border:        '1px solid #E0C260',
      borderRadius:  8,
      padding:       '12px 16px',
      margin:        '16px 0',
      display:       'flex',
      alignItems:    'flex-start',
      gap:           12,
      fontSize:      14,
    }}>
      <span style={{ fontSize: 20, lineHeight: 1, color: '#8A6500' }}>⚠</span>
      <div style={{ flex: 1, color: '#5C4400' }}>
        <strong style={{ display: 'block', marginBottom: 4 }}>The system needs your attention:</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
          {warnings.map((w, i) => (
            <li key={i} style={{ lineHeight: 1.5 }}>{w}</li>
          ))}
        </ul>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background:   'transparent',
          border:       'none',
          fontSize:     20,
          cursor:       'pointer',
          color:        '#8A6500',
          padding:      0,
          lineHeight:   1,
        }}
        title="Dismiss until reload"
      >×</button>
    </div>
  );
}

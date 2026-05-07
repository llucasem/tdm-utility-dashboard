import { IconChart } from './Icons';
import NotificationBell from './NotificationBell';

export default function TopBar({
  exportCSV, onAnalytics, onAddData, toggleDark,
  onSync, syncing, lastSynced,
  onMatchQB, matchingQB, qbConnected,
}) {
  return (
    <div className="topbar">
      <div className="brand">
        <h1>TDM Utilities</h1>
        <span className="tag">Beta</span>
      </div>
      <div className="topbar-right">
        <div className="sync-status">
          <span className={`sync-dot ${syncing ? 'syncing' : 'live'}`}></span>
          <span>{syncing ? 'Syncing…' : lastSynced ? `Synced · ${lastSynced}` : 'Not synced yet'}</span>
        </div>
        <button className="btn" onClick={exportCSV}>↓ Export for QuickBooks</button>
        <button className="btn" onClick={onAnalytics}>
          <IconChart /> Analytics
        </button>
        <button className="btn" onClick={onAddData}>+ Add data</button>
        <button
          className="btn"
          onClick={onMatchQB}
          disabled={matchingQB || !qbConnected}
          title={qbConnected ? 'Match payments with QuickBooks' : 'QuickBooks not connected yet'}
        >
          {matchingQB ? '⏳ Matching…' : '⇆ Match QB'}
        </button>
        <button className="btn primary" onClick={onSync} disabled={syncing}>
          {syncing ? '⏳ Syncing…' : '↻ Sync now'}
        </button>
        <NotificationBell />
        <button className="toggle-track" onClick={toggleDark} title="Toggle dark mode">
          <div className="toggle-thumb"></div>
        </button>
      </div>
    </div>
  );
}

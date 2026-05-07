'use client';

import { useEffect, useRef, useState } from 'react';

const TYPE_ICON  = { info: 'ℹ', success: '✓', warning: '⚠', error: '✗' };
const TYPE_CLASS = { info: 'notif-info', success: 'notif-success', warning: 'notif-warn', error: 'notif-error' };

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function NotificationBell() {
  const [open, setOpen]                 = useState(false);
  const [items, setItems]               = useState([]);
  const [unreadCount, setUnreadCount]   = useState(0);
  const [loading, setLoading]           = useState(false);
  const wrapperRef                       = useRef(null);

  const fetchData = async () => {
    try {
      const res  = await fetch('/api/notifications?limit=30');
      const data = await res.json();
      if (data.ok) {
        setItems(data.items);
        setUnreadCount(data.unreadCount);
      }
    } catch {}
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // poll every minute
    return () => clearInterval(interval);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const toggleOpen = () => {
    setOpen(o => !o);
    if (!open) fetchData(); // refresh when opening
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    setLoading(true);
    try {
      await fetch('/api/notifications', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'markAllRead' }),
      });
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const handleItemClick = async (n) => {
    if (!n.read_at) {
      await fetch(`/api/notifications/${n.id}`, { method: 'PATCH' });
      fetchData();
    }
  };

  return (
    <div className="notif-wrapper" ref={wrapperRef}>
      <button className="notif-bell" onClick={toggleOpen} title="Notifications">
        <span className="notif-bell-icon">🔔</span>
        {unreadCount > 0 && (
          <span className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-dropdown-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button className="notif-mark-all" onClick={markAllRead} disabled={loading}>
                Mark all read
              </button>
            )}
          </div>

          <div className="notif-list">
            {items.length === 0 && (
              <div className="notif-empty">No notifications yet</div>
            )}
            {items.map(n => (
              <div
                key={n.id}
                className={`notif-item ${TYPE_CLASS[n.type] || ''} ${n.read_at ? 'read' : 'unread'}`}
                onClick={() => handleItemClick(n)}
              >
                <span className="notif-icon">{TYPE_ICON[n.type] || '·'}</span>
                <div className="notif-body">
                  <div className="notif-title">{n.title}</div>
                  <div className="notif-message">{n.message}</div>
                  <div className="notif-time">{timeAgo(n.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

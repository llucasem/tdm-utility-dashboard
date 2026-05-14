'use client';

import { useState, useEffect } from 'react';
import TopBar               from '@/components/TopBar';
import StatsRow              from '@/components/StatsRow';
import FiltersBar            from '@/components/FiltersBar';
import BillsTable            from '@/components/BillsTable';
import BillDetailModal       from '@/components/BillDetailModal';
import AddBillModal          from '@/components/AddBillModal';
import AssignPropertyModal   from '@/components/AssignPropertyModal';
import AnalyticsModal        from '@/components/AnalyticsModal';

const DUE_MONTH_MAP = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

export default function Dashboard() {
  const [bills,           setBills]           = useState([]);
  const [properties,      setProperties]      = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [monthIndex,      setMonthIndex]      = useState(() => new Date().getMonth());
  const [year,            setYear]            = useState(() => new Date().getFullYear());
  const [search,          setSearch]          = useState('');
  const [selectedBill,    setSelectedBill]    = useState(null);
  const [assignBill,      setAssignBill]      = useState(null);
  const [darkMode,        setDarkMode]        = useState(false);
  const [toast,           setToast]           = useState(false);
  const [toastMsg,        setToastMsg]        = useState('');
  const [analyticsOpen,   setAnalyticsOpen]   = useState(false);
  const [addOpen,         setAddOpen]         = useState(false);
  const [syncing,         setSyncing]         = useState(false);
  const [lastSynced,      setLastSynced]      = useState('');

  const fetchBills = async () => {
    const res  = await fetch('/api/bills');
    const data = await res.json();
    if (data.ok) setBills(data.bills);
  };

  const fetchProperties = async () => {
    const res  = await fetch('/api/properties');
    const data = await res.json();
    if (data.ok) setProperties(data.properties);
  };

  useEffect(() => {
    Promise.all([fetchBills(), fetchProperties()])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const showToast = (msg) => {
    setToastMsg(msg);
    setToast(true);
    setTimeout(() => setToast(false), 4000);
  };

  const toggleDark = () => {
    const next = !darkMode;
    setDarkMode(next);
    document.body.classList.toggle('dark', next);
  };

  const prevMonth = () => {
    if (monthIndex === 0) { setMonthIndex(11); setYear(y => y - 1); }
    else setMonthIndex(m => m - 1);
  };
  const nextMonth = () => {
    if (monthIndex === 11) { setMonthIndex(0); setYear(y => y + 1); }
    else setMonthIndex(m => m + 1);
  };

  const exportCSV = () => {
    const monthNum = String(monthIndex + 1).padStart(2, '0');
    const rows = filtered.map(b => {
      const [mon, day] = b.due.split(' ');
      const dateStr = `${DUE_MONTH_MAP[mon]}/${String(day).padStart(2, '0')}/${year}`;
      const type = b.type.charAt(0).toUpperCase() + b.type.slice(1);
      const desc = `${type} | ${b.unit} | ${b.property} | Acct \u00B7\u00B7\u00B7${b.account}`;
      return `${dateStr},"${desc}",-${b.amount.toFixed(2)}`;
    });
    const csv = ['Date,Description,Amount', ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quickbooks-utilities-${year}-${monthNum}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV ready — import into QuickBooks via Transactions → Upload from file');
  };

  const handleAddBill = (newBill) => {
    setBills(prev => [...prev, newBill]);
    showToast('Bill added successfully');
  };

  const handleAssigned = async (result) => {
    await fetchBills();
    const bulk = result?.bulkUpdated || 0;
    const tagStatus = result?.autoTag?.status;
    let msg = 'Bill assigned to property';
    if (bulk > 0) msg += ` · ${bulk} other bill${bulk === 1 ? '' : 's'} with same account also assigned`;
    if (tagStatus === 'tagged')    msg += ' · tagged in QuickBooks';
    if (tagStatus === 'ambiguous') msg += ' · multiple QB matches — review needed';
    showToast(msg);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res  = await fetch('/api/sync');
      const data = await res.json();
      if (data.ok) {
        await fetchBills();

        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        setLastSynced(`today ${timeStr}`);

        if (data.saved > 0) showToast(`Sync complete — ${data.saved} new bill${data.saved !== 1 ? 's' : ''} added`);
        else showToast('Sync complete — no new bills found');
      } else {
        showToast('Sync failed — check connection');
      }
    } catch {
      showToast('Sync failed — check connection');
    } finally {
      setSyncing(false);
    }
  };

  const prevMonthIndex = monthIndex === 0 ? 11 : monthIndex - 1;
  const prevYear       = monthIndex === 0 ? year - 1 : year;

  const monthBills    = bills.filter(b => b.dueMonth === monthIndex && b.dueYear === year);
  const prevMonthBills = bills.filter(b => b.dueMonth === prevMonthIndex && b.dueYear === prevYear);
  const filtered      = monthBills.filter(b => {
    if (search === '') return true;
    const term = search.trim().toLowerCase();

    // Text match — property and unit
    if ((b.property || '').toLowerCase().includes(term)) return true;
    if ((b.unit || '').toLowerCase().includes(term)) return true;

    // Amount match — accept "61.25", "$61.25", "61", etc.
    const numeric = parseFloat(term.replace(/[^0-9.]/g, ''));
    if (!isNaN(numeric) && numeric > 0) {
      const amt = b.amount;
      // Exact match (after rounding to 2 decimals)
      if (Math.abs(amt - numeric) < 0.005) return true;
      // Substring match on the number itself (e.g. "61" finds 61.25, 161.40)
      if (amt.toFixed(2).includes(term)) return true;
    }

    return false;
  });
  if (loading) return (
    <div className="page-wrap" style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh' }}>
      <p style={{ color:'var(--text-muted)', fontFamily:'var(--font-serif)' }}>Loading bills…</p>
    </div>
  );

  return (
    <div className="page-wrap">
      <TopBar
        exportCSV={exportCSV}
        onAnalytics={() => setAnalyticsOpen(true)}
        onAddData={() => setAddOpen(true)}
        toggleDark={toggleDark}
        onSync={handleSync}
        syncing={syncing}
        lastSynced={lastSynced}
      />
      <StatsRow monthBills={monthBills} prevMonthBills={prevMonthBills} />
      <FiltersBar
        monthIndex={monthIndex}
        year={year}
        onPrev={prevMonth}
        onNext={nextMonth}
        search={search}
        onSearch={setSearch}
      />
      <BillsTable
        filtered={filtered}
        onSelectBill={setSelectedBill}
        onAssignBill={setAssignBill}
      />

      <div className={`toast ${toast ? 'show' : ''}`}>{toastMsg}</div>

      <BillDetailModal
        bill={selectedBill}
        onClose={() => setSelectedBill(null)}
        year={year}
      />
      <AddBillModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={handleAddBill}
        properties={properties}
        onPropertyAdded={fetchProperties}
      />
      <AssignPropertyModal
        bill={assignBill}
        properties={properties}
        onClose={() => setAssignBill(null)}
        onAssigned={handleAssigned}
      />
      <AnalyticsModal
        open={analyticsOpen}
        onClose={() => setAnalyticsOpen(false)}
      />
    </div>
  );
}

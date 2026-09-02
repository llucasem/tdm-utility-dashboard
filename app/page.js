'use client';

import { useState, useEffect } from 'react';
import TopBar               from '@/components/TopBar';
import ViewTabs             from '@/components/ViewTabs';
import StatsRow              from '@/components/StatsRow';
import FiltersBar            from '@/components/FiltersBar';
import BillsTable            from '@/components/BillsTable';
import ExpectedPanel         from '@/components/ExpectedPanel';
import BillDetailModal       from '@/components/BillDetailModal';
import AddBillModal          from '@/components/AddBillModal';
import AssignPropertyModal   from '@/components/AssignPropertyModal';
import AnalyticsModal        from '@/components/AnalyticsModal';
import RentStatsRow          from '@/components/RentStatsRow';
import RentTable             from '@/components/RentTable';
import RentDetailModal       from '@/components/RentDetailModal';

const DUE_MONTH_MAP = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

export default function Dashboard() {
  const [view,             setView]             = useState('utilities');  // 'utilities' | 'rent'
  const [bills,            setBills]            = useState([]);
  const [rentPayments,     setRentPayments]     = useState([]);
  const [properties,       setProperties]       = useState([]);
  const [loading,          setLoading]          = useState(true);
  const [monthIndex,       setMonthIndex]       = useState(() => new Date().getMonth());
  // 'bill' = mes de factura (Devengo, que se debe) · 'paid' = mes de pago
  // (Caja, el cierre de Jake). Ver lib/bill-view.js.
  const [monthMode,        setMonthMode]        = useState('bill');
  const [showUnpaid,       setShowUnpaid]       = useState(false);
  const [year,             setYear]             = useState(() => new Date().getFullYear());
  const [search,           setSearch]           = useState('');
  const [selectedBill,     setSelectedBill]     = useState(null);
  const [assignBill,       setAssignBill]       = useState(null);
  const [selectedPayment,  setSelectedPayment]  = useState(null);
  const [darkMode,         setDarkMode]         = useState(false);
  const [toast,            setToast]            = useState(false);
  const [toastMsg,         setToastMsg]         = useState('');
  const [analyticsOpen,    setAnalyticsOpen]    = useState(false);
  const [addOpen,          setAddOpen]          = useState(false);
  const [syncing,          setSyncing]          = useState(false);
  const [lastSynced,       setLastSynced]       = useState('');

  const fetchBills = async () => {
    const res  = await fetch('/api/bills');
    const data = await res.json();
    if (data.ok) setBills(data.bills);
  };

  const fetchRentPayments = async () => {
    const res  = await fetch('/api/rent-payments');
    const data = await res.json();
    if (data.ok) setRentPayments(data.payments);
  };

  const fetchProperties = async () => {
    const res  = await fetch('/api/properties');
    const data = await res.json();
    if (data.ok) setProperties(data.properties);
  };

  useEffect(() => {
    Promise.all([fetchBills(), fetchRentPayments(), fetchProperties()])
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
        await Promise.all([fetchBills(), fetchRentPayments()]);

        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        setLastSynced(`today ${timeStr}`);

        const rentNew = data.airtable?.rent || 0;
        const buildNew = data.airtable?.conservice || 0;
        const totalNew = (data.saved || 0) + rentNew + buildNew;
        const parts = [];
        if (data.saved)  parts.push(`${data.saved} bill${data.saved !== 1 ? 's' : ''}`);
        if (rentNew)     parts.push(`${rentNew} rent payment${rentNew !== 1 ? 's' : ''}`);
        if (buildNew)    parts.push(`${buildNew} Conservice`);
        if (totalNew > 0) showToast(`Sync complete — ${parts.join(' · ')} added`);
        else showToast('Sync complete — no new entries');
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

  // For the Utilities view we ONLY want per-unit utility bills (electricity,
  // internet, gas, water). 'building' = Conservice consolidated utility
  // statements which are not per-unit and shouldn't appear in the matrix.
  const UTILITY_TYPES = ['electricity', 'internet', 'gas', 'water'];
  const utilityBills  = bills.filter(b => UTILITY_TYPES.includes(b.type));
  const inMonth = (b, mIdx, yr) => monthMode === 'paid'
    ? (b.paidMonth === mIdx && b.paidYear === yr)
    : (b.dueMonth === mIdx && b.dueYear === yr);
  const monthBills     = utilityBills.filter(b => inMonth(b, monthIndex, year));
  const prevMonthBills = utilityBills.filter(b => inMonth(b, prevMonthIndex, prevYear));
  // En modo Caja una factura sin pago casado no cae en NINGUN mes. No puede
  // desaparecer en silencio (ahi es donde vive la deuda de Maxella): se
  // ensena aparte, siempre visible.
  const unpaidBills = monthMode === 'paid'
    ? utilityBills.filter(b => !b.paidDate && b.status !== 'paid')
    : [];
  const unpaidTotal = unpaidBills.reduce((s2, b) => s2 + b.amount, 0);

  const monthPayments     = rentPayments.filter(p => p.month === monthIndex && p.year === year);
  const prevMonthPayments = rentPayments.filter(p => p.month === prevMonthIndex && p.year === prevYear);

  // Shared search predicate for amount + text
  function searchMatches(term, fields, amount) {
    if (!term) return true;
    for (const f of fields) {
      if ((f || '').toLowerCase().includes(term)) return true;
    }
    const numeric = parseFloat(term.replace(/[^0-9.]/g, ''));
    if (!isNaN(numeric) && numeric > 0) {
      if (Math.abs(amount - numeric) < 0.005) return true;
      if (amount.toFixed(2).includes(term)) return true;
    }
    return false;
  }

  const term = search.trim().toLowerCase();
  const tableBills = (monthMode === 'paid' && showUnpaid) ? unpaidBills : monthBills;
  const filtered = tableBills.filter(b =>
    searchMatches(term, [b.property, b.unit], b.amount)
  );
  const filteredPayments = monthPayments.filter(p =>
    searchMatches(term, [p.property, p.unit, p.landlord, p.portal, p.mailbox], p.amount)
  );
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
      <ViewTabs view={view} onChange={setView} />

      {view === 'utilities' && (
        <section role="tabpanel" id="panel-utilities" aria-labelledby="tab-utilities">
          <StatsRow monthBills={monthBills} prevMonthBills={prevMonthBills} />
          <FiltersBar
            monthIndex={monthIndex}
            year={year}
            onPrev={prevMonth}
            onNext={nextMonth}
            search={search}
            onSearch={setSearch}
            mode={monthMode}
            onMode={(m) => { setMonthMode(m); setShowUnpaid(false); }}
          />
          {monthMode === 'paid' && unpaidBills.length > 0 && (
            <div className="unpaid-strip">
              <span className="unpaid-text">
                <strong>{unpaidBills.length} bills without a matched payment</strong>
                {' '}· <span className="amt">${unpaidTotal.toFixed(2)}</span> — outside every month in this view
              </span>
              <button className="btn" onClick={() => setShowUnpaid(v => !v)}>
                {showUnpaid ? 'Back to the month' : 'Show them'}
              </button>
            </div>
          )}
          <ExpectedPanel
            monthIndex={monthIndex}
            year={year}
            refreshTick={bills.length}
          />
          <BillsTable
            filtered={filtered}
            onSelectBill={setSelectedBill}
            onAssignBill={setAssignBill}
          />
        </section>
      )}

      {view === 'rent' && (
        <section role="tabpanel" id="panel-rent" aria-labelledby="tab-rent">
          <RentStatsRow monthPayments={monthPayments} prevMonthPayments={prevMonthPayments} />
          <FiltersBar
            monthIndex={monthIndex}
            year={year}
            onPrev={prevMonth}
            onNext={nextMonth}
            search={search}
            onSearch={setSearch}
            placeholder="Search by property, landlord, mailbox or amount…"
          />
          <RentTable
            filtered={filteredPayments}
            onSelectPayment={setSelectedPayment}
          />
        </section>
      )}

      <div className={`toast ${toast ? 'show' : ''}`}>{toastMsg}</div>

      <BillDetailModal
        bill={selectedBill}
        onClose={() => setSelectedBill(null)}
        year={year}
        onResolved={() => { setSelectedBill(null); fetchBills(); showToast('Payment assigned — locked in'); }}
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
      <RentDetailModal
        payment={selectedPayment}
        onClose={() => setSelectedPayment(null)}
      />
    </div>
  );
}

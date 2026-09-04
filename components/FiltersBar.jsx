import { MONTHS } from '@/lib/constants';

export default function FiltersBar({
  monthIndex, year, onPrev, onNext, search, onSearch,
  mode, onMode,
  placeholder = 'Search by property, address or amount (e.g. 61.25)…',
}) {
  return (
    <div className="filters-bar">
      <div className="month-picker">
        <button className="nav-btn" onClick={onPrev} aria-label="Previous month">‹</button>
        <span className="month-label">{MONTHS[monthIndex]} {year}</span>
        <button className="nav-btn" onClick={onNext} aria-label="Next month">›</button>
      </div>
      {onMode && (
        /* Los dos ejes de mes que pidio Jake: la factura (que se debe) y el
           pago (su cierre de caja). El mismo interruptor que trae QuickBooks
           en sus informes: Accrual / Cash. */
        <div className="mode-toggle" role="group" aria-label="Group bills by">
          <button
            className={mode === 'paid' ? 'mode-btn' : 'mode-btn active'}
            onClick={() => onMode('bill')}
            title="Accrual — group by the month the bill arrived (what's owed)"
          >Bill month</button>
          <button
            className={mode === 'paid' ? 'mode-btn active' : 'mode-btn'}
            onClick={() => onMode('paid')}
            title="Cash — group by the month the payment left the bank. Heads up: the current month always looks light here, because QuickBooks' bank feed lags 3-4 weeks. Bills billed this month with no payment yet are listed right below."
          >Paid month</button>
        </div>
      )}
      <input
        className="search-input"
        type="text"
        placeholder={placeholder}
        value={search}
        onChange={e => onSearch(e.target.value)}
      />
    </div>
  );
}

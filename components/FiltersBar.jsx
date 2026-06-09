import { MONTHS } from '@/lib/constants';

export default function FiltersBar({
  monthIndex, year, onPrev, onNext, search, onSearch,
  placeholder = 'Search by property, address or amount (e.g. 61.25)…',
}) {
  return (
    <div className="filters-bar">
      <div className="month-picker">
        <button className="nav-btn" onClick={onPrev} aria-label="Previous month">‹</button>
        <span className="month-label">{MONTHS[monthIndex]} {year}</span>
        <button className="nav-btn" onClick={onNext} aria-label="Next month">›</button>
      </div>
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

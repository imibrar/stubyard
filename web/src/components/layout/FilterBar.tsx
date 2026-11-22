import type { ReactNode } from 'react';
import { Icon } from '../people';

export interface ActiveFilter {
  id: string;
  label: ReactNode;
  onRemove: () => void;
}

/**
 * Search + filter controls + the active filters as removable chips. Pages pass their own controls (selects,
 * a Filters popover) as children; the chips row only shows when something is active.
 */
export function FilterBar({ search, onSearch, placeholder = 'Search…', children, active, onClearAll, end }: { search?: string; onSearch?: (v: string) => void; placeholder?: string; children?: ReactNode; active?: ActiveFilter[]; onClearAll?: () => void; end?: ReactNode }) {
  return (
    <div className="filter-bar">
      <div className="filter-bar-row">
        {onSearch && (
          <label className="filter-search">
            <Icon name="search" size={14} />
            <input type="search" value={search ?? ''} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} aria-label={placeholder.replace(/…$/, '')} />
          </label>
        )}
        {children}
        {end && <div className="filter-bar-end">{end}</div>}
      </div>
      {active && active.length > 0 && (
        <div className="filter-chips" aria-label="Active filters">
          {active.map((f) => (
            <button key={f.id} type="button" className="chip active filter-chip" onClick={f.onRemove} aria-label={`Remove filter ${typeof f.label === 'string' ? f.label : f.id}`}>
              {f.label} <Icon name="close" size={11} />
            </button>
          ))}
          {onClearAll && active.length > 1 && (
            <button type="button" className="btn xs ghost" onClick={onClearAll}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

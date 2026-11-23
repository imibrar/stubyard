import type { KeyboardEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** One short line under the value. */
  sub?: ReactNode;
  icon?: ReactNode;
  /** Link target (the tile becomes a link) … */
  to?: string;
  /** … or a button (filters). */
  onClick?: () => void;
  /** Pressed state for filter tiles. */
  active?: boolean;
  tone?: 'ok' | 'warn' | 'bad' | 'accent';
  title?: string;
  /** Filter tiles inside a tablist (StatTiles tablist) use role="tab". */
  tab?: boolean;
}

/** A number with a label: links to its section or toggles a filter. Group them in <StatTiles>. */
export function StatTile({ label, value, sub, icon, to, onClick, active, tone, title, tab }: StatTileProps) {
  const cls = `stat-tile ${active ? 'active' : ''} ${tone ? `tone-${tone}` : ''}`;
  const body = (
    <>
      <span className="stat-label">
        {icon}
        {label}
      </span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </>
  );
  if (to)
    return (
      <Link to={to} className={cls} title={title}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} title={title} {...(tab ? { role: 'tab', 'aria-selected': !!active, tabIndex: active ? 0 : -1 } : { 'aria-pressed': !!active })}>
        {body}
      </button>
    );
  return (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

export function StatTiles({ children, label, compact, className = '', tablist }: { children: ReactNode; label?: string; compact?: boolean; className?: string; tablist?: boolean }) {
  // Tablist: arrow keys move between the tiles.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tablist || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=tab]')];
    const cur = els.indexOf(document.activeElement as HTMLElement);
    if (cur < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (cur + (e.key === 'ArrowRight' ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
  };
  return (
    <div className={`stat-tiles ${compact ? 'compact' : ''} ${className}`} role={tablist ? 'tablist' : 'group'} aria-label={label} onKeyDown={onKey}>
      {children}
    </div>
  );
}

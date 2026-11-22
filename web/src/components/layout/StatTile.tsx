import type { ReactNode } from 'react';
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
}

/** A number with a label: links to its section or toggles a filter. Group them in <StatTiles>. */
export function StatTile({ label, value, sub, icon, to, onClick, active, tone, title }: StatTileProps) {
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
      <button type="button" className={cls} onClick={onClick} aria-pressed={!!active} title={title}>
        {body}
      </button>
    );
  return (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

export function StatTiles({ children, label, compact, className = '' }: { children: ReactNode; label?: string; compact?: boolean; className?: string }) {
  return (
    <div className={`stat-tiles ${compact ? 'compact' : ''} ${className}`} role="group" aria-label={label}>
      {children}
    </div>
  );
}

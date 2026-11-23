import type { ReactNode } from 'react';

/** A row of controls above a list or table: search, filters, view options, count. Wraps on narrow screens. */
export function Toolbar({ children, end, label = 'Toolbar', className = '' }: { children?: ReactNode; end?: ReactNode; label?: string; className?: string }) {
  return (
    <div className={`toolbar ${className}`} role="toolbar" aria-label={label}>
      <div className="toolbar-start">{children}</div>
      {end && <div className="toolbar-end">{end}</div>}
    </div>
  );
}

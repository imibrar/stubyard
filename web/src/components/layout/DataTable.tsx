import type { KeyboardEvent, ReactNode } from 'react';
import { usePhone } from './hooks';

export interface Column<R> {
  key: string;
  header: ReactNode;
  render: (row: R) => ReactNode;
  /** 1 = always shown (also in stack mode), 2 = hidden in stack mode, 3 = hidden below 1024 px too. Default 1. */
  priority?: 1 | 2 | 3;
  align?: 'start' | 'end' | 'center';
  /** CSS width of the column (e.g. '120px', '30%'). */
  width?: string;
  /** Takes the remaining width and ellipsizes. */
  fill?: boolean;
  mono?: boolean;
  className?: string;
}

/**
 * Table with a sticky header and single-line rows. Rows can be clickable (Enter/Space too) and selected.
 * Stack mode (phones, or stack="always"): each row becomes a two-line list item with the priority-1 columns.
 */
export function DataTable<R>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  stack = 'phone',
  caption,
  className = '',
  rowMenu,
}: {
  columns: Column<R>[];
  rows: readonly R[];
  rowKey: (row: R) => string;
  onRowClick?: (row: R) => void;
  selectedKey?: string | null;
  empty?: ReactNode;
  stack?: 'phone' | 'never' | 'always';
  caption?: string;
  className?: string;
  /** Trailing per-row menu (always visible: no hover-only actions). */
  rowMenu?: (row: R) => ReactNode;
}) {
  const phone = usePhone();
  const stacked = stack === 'always' || (stack === 'phone' && phone);
  if (!rows.length && empty) return <>{empty}</>;
  const onKey = (e: KeyboardEvent, r: R) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      onRowClick(r);
    }
  };
  if (stacked) {
    const shown = columns.filter((c) => (c.priority ?? 1) === 1);
    const [first, ...rest] = shown;
    return (
      <ul className={`data-stack ${className}`} aria-label={caption}>
        {rows.map((r) => {
          const k = rowKey(r);
          return (
            <li key={k} className={`data-stack-row ${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'selected' : ''}`} tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={(e) => onKey(e, r)}>
              <div className="data-stack-main">
                <div className="data-stack-title">{first?.render(r)}</div>
                <div className="data-stack-meta">
                  {rest.map((c) => (
                    <span key={c.key} className={c.mono ? 'mono' : undefined}>
                      {c.render(r)}
                    </span>
                  ))}
                </div>
              </div>
              {rowMenu && (
                <div className="data-row-menu" onClick={(e) => e.stopPropagation()}>
                  {rowMenu(r)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className={`table-wrap data-table-wrap ${className}`}>
      <table className="data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`${c.priority === 3 ? 'col-md' : c.priority === 2 ? 'col-sm' : ''} align-${c.align ?? 'start'} ${c.className ?? ''}`} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
            {rowMenu && (
              <th scope="col" className="data-row-menu-col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={`${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'selected' : ''}`} tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={(e) => onKey(e, r)} aria-selected={selectedKey !== undefined ? selectedKey === k : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={`${c.priority === 3 ? 'col-md' : c.priority === 2 ? 'col-sm' : ''} ${c.fill ? 'cell-fill ellipsis' : ''} ${c.mono ? 'mono' : ''} align-${c.align ?? 'start'} ${c.className ?? ''}`}>
                    {c.render(r)}
                  </td>
                ))}
                {rowMenu && (
                  <td className="data-row-menu" onClick={(e) => e.stopPropagation()}>
                    {rowMenu(r)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

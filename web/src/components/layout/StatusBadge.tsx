import type { ReactNode } from 'react';

export type Status = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'neutral';

/** Status shown with text (and an optional dot), never by colour alone. Uses the .badge kinds. */
export function StatusBadge({ status = 'neutral', children, dot, title }: { status?: Status; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`badge status-badge ${status === 'neutral' ? '' : status}`} title={title}>
      {dot && <span className={`status-dot ${status}`} aria-hidden />}
      {children}
    </span>
  );
}

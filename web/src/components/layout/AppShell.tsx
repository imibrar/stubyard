import type { ReactNode } from 'react';

/**
 * Outer frame (Direction C "Relay"): navigation column | work area. The work area has a thin global header over
 * the list pane, <main> (the detail pane) and the optional context panel. Keeps the .shell / .main classes.
 */
export function AppShell({ header, nav, children, overlays, list, context, className = '' }: { header?: ReactNode; nav?: ReactNode; children: ReactNode; overlays?: ReactNode; list?: ReactNode; context?: ReactNode; className?: string }) {
  return (
    <div className={`shell app-shell ${className}`}>
      {nav}
      <div className="work">
        {header}
        {list}
        <main className="main" id="main">
          {children}
        </main>
        {context}
      </div>
      {overlays}
    </div>
  );
}

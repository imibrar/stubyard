import type { ReactNode } from 'react';

/**
 * Outer frame: header (top bar), nav (sidebar / rail / top nav, per direction) and main. Overlays (palette, sheets)
 * go in `overlays`. Markup keeps the 0.14 classes (.shell, .main) so the current look holds.
 */
export function AppShell({ header, nav, children, overlays, className = '' }: { header?: ReactNode; nav?: ReactNode; children: ReactNode; overlays?: ReactNode; className?: string }) {
  return (
    <div className={`shell app-shell ${className}`}>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), document.getElementById('main')?.focus())}>
        Skip to content
      </a>
      {header}
      {nav}
      <main className="main" id="main" tabIndex={-1}>
        <div className="main-inner">{children}</div>
      </main>
      {overlays}
    </div>
  );
}

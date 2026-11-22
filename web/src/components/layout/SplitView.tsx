import type { CSSProperties, ReactNode } from 'react';

/**
 * List + detail. mode "split": detail beside the list from 1024 px (one pane at a time below, with the caller's back
 * control); mode "stack": list only, the caller opens the detail in a Drawer. `hasSelection` decides which pane shows on
 * narrow screens. Classes: .split-view, .split-list, .split-detail (+ .has-selection).
 */
export function SplitView({ list, detail, hasSelection, mode = 'split', listWidth, className = '', empty }: { list: ReactNode; detail?: ReactNode; hasSelection: boolean; mode?: 'split' | 'stack'; listWidth?: string; className?: string; empty?: ReactNode }) {
  return (
    <div className={`split-view split-${mode} ${hasSelection ? 'has-selection' : ''} ${className}`} style={listWidth ? ({ '--split-list-w': listWidth } as CSSProperties) : undefined}>
      <div className="split-list">{list}</div>
      {mode === 'split' && <div className="split-detail">{detail ?? empty}</div>}
    </div>
  );
}

/**
 * Workspace template: header, optional summary strip, primary pane, secondary pane and optional context panel.
 * Panes scroll independently from 1024 px; stacked below.
 */
export function Workspace({ header, summary, primary, secondary, context, className = '' }: { header?: ReactNode; summary?: ReactNode; primary: ReactNode; secondary?: ReactNode; context?: ReactNode; className?: string }) {
  return (
    <div className={`workspace ${context ? 'has-context' : ''} ${className}`}>
      {header}
      {summary && <div className="workspace-summary">{summary}</div>}
      <div className="workspace-panes">
        <div className="workspace-primary">{primary}</div>
        {secondary && <div className="workspace-secondary">{secondary}</div>}
        {context && <aside className="workspace-context">{context}</aside>}
      </div>
    </div>
  );
}

/** Log template: filter toolbar + a table with a sticky header; the row drawer stays with the caller. */
export function LogLayout({ toolbar, children, className = '' }: { toolbar?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`log-layout ${className}`}>
      {toolbar && <div className="log-toolbar">{toolbar}</div>}
      <div className="log-body">{children}</div>
    </div>
  );
}

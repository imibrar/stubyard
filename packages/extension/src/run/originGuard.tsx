// Fill only into the run's own pages without asking (security review item 1). A page outside the run's origins (the
// tester ticked "Show on this tab" there, or the tab was redirected) gets credentials or form data only after the
// tester confirms in the side panel; the on-page widget refuses and points to the panel, because a page could make the
// widget invisible and bait the click.
import { useRef, useState } from 'react';
import { pageOrigin } from '../shared/settings';
import { originAllowed } from '../shared/widget';
import { useStepHost } from './host';

export interface OriginGuard {
  /** The tab's origin when it is not one of the run's origins (null: fine). */
  off: string | null;
  /** Run `fn` now, or first ask (panel) / refuse (widget). */
  guard: (fn: () => void) => void;
  asking: boolean;
  refused: boolean;
  confirm: () => void;
  dismiss: () => void;
}

export function useOriginGuard(): OriginGuard {
  const p = useStepHost();
  const [pendingFn, setPendingFn] = useState<(() => void) | null>(null);
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const confirmed = useRef<string | null>(null);
  const url = p.tab?.url ?? null;
  const off = originAllowed(url, p.appOrigins) ? null : (pageOrigin(url) ?? url ?? 'this page');
  const guard = (fn: () => void) => {
    if (!off || confirmed.current === off) return fn();
    if (p.surface === 'widget') return setRefusedFor(off);
    setPendingFn(() => fn);
  };
  return {
    off,
    guard,
    asking: !!off && pendingFn !== null,
    refused: !!off && refusedFor === off,
    confirm: () => {
      const fn = pendingFn;
      confirmed.current = off;
      setPendingFn(null);
      fn?.();
    },
    dismiss: () => {
      setPendingFn(null);
      setRefusedFor(null);
    },
  };
}

export function OriginPrompt({ g, what }: { g: OriginGuard; what: string }) {
  const p = useStepHost();
  if (g.refused)
    return (
      <p className="status warn" role="alert">
        This page (<code>{g.off}</code>) is not one of this run’s app origins, so the widget does not fill {what} here. Fill it from the side panel.{' '}
        {p.openPanel && (
          <button className="link" onClick={() => p.openPanel?.()}>
            Open panel
          </button>
        )}
      </p>
    );
  if (!g.asking) return null;
  return (
    <div className="status warn" role="alert">
      This tab is on <code>{g.off}</code>, which is not one of this run’s app origins. Fill {what} there anyway?{' '}
      <div className="row wrap">
        <button className="primary" onClick={g.confirm}>
          Fill anyway
        </button>
        <button onClick={g.dismiss}>Cancel</button>
      </div>
    </div>
  );
}

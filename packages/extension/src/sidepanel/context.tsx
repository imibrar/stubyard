// Shared panel state (React context) and small hooks used by every screen.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { StepHost } from '../run/host';
import type { ActiveWalkthrough, Settings } from '../shared/settings';
import { errorText } from './hub';
import type { RunMode } from './state';
import { isAbort, type TabInfo } from './tabs';

export type Screen = { name: 'home' } | { name: 'start'; storyboard: string; mode?: RunMode } | { name: 'walkthrough' } | { name: 'page' } | { name: 'settings' } | { name: 'cleanup' };

/** The panel's state. Its StepHost part (tab, windowId, target, notify, fillRequest, openWalkthrough) is what the step controls use. */
export interface PanelState extends StepHost {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** The active tab of the panel's window (null when it has none). */
  tab: TabInfo | null;
  /** The tab's http(s) origin, else null. */
  origin: string | null;
  /** The project chosen for the tab's origin. */
  project: string | null;
  /** Use a project for the tab's origin (remembered); null forgets it. */
  chooseProject: (slug: string | null) => Promise<void>;
  /** The walkthrough open in this window. */
  active: ActiveWalkthrough | null;
  go: (s: Screen) => void;
  /** Bumped by events: storyboards / data sets changed; the open walkthrough changed elsewhere; any walkthrough or user changed (cleanup lists). */
  ticks: { storyboards: number; walkthrough: number; cleanup: number };
}

export const PanelContext = createContext<PanelState | null>(null);

export function usePanel(): PanelState {
  const p = useContext(PanelContext);
  if (!p) throw new Error('usePanel outside PanelContext');
  return p;
}

/** Run async actions with a busy label and an error message; aborts are not errors. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (!isAbort(err)) setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, setError, run };
}

/** An AbortController per long task, aborted on unmount or when a new one starts. */
export function useAbortable() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return {
    start: () => {
      ref.current?.abort();
      ref.current = new AbortController();
      return ref.current.signal;
    },
    cancel: () => {
      ref.current?.abort();
      ref.current = null;
    },
  };
}

/** Load data when the dependencies change; `reload` runs it again. */
export function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!fn });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!fn) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (err) => live && setState({ data: null, error: errorText(err), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}

// The widget iframe's shell: the hello handshake (token check, own tab), settings, the run (useRun, the same loader
// as the panel), the event stream (walkthrough.changed, while the tab is visible), the live tab URL (SPA routes), the
// StepHost for the shared step controls, and the Port to the page host (size, Esc collapses, progress for the pill).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribe } from '@stubyard/client/stream';
import { type StepHost, StepHostContext } from '../run/host';
import { useRun } from '../run/useRun';
import { type ActiveWalkthrough, loadSettings, setActiveWalkthrough, type Settings, touchesSettings } from '../shared/settings';
import { HINT_KEY, setTabOverride, widgetTakesFill } from '../shared/widget';
import { progress } from '../sidepanel/state';
import type { TabInfo } from '../sidepanel/tabs';
import { connectHost, hello, type HostLink } from './link';
import { WidgetCard, WidgetMessage } from './WidgetCard';

type Boot = { status: 'loading' } | { status: 'denied' } | { status: 'ready'; tabId: number; windowId: number; url: string };

export function WidgetApp() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  useEffect(() => {
    void hello().then((r) => setBoot('error' in r ? { status: 'denied' } : { status: 'ready', ...r }));
  }, []);
  if (boot.status === 'loading') return <div className="w-card w-loading muted small">stubyard…</div>;
  if (boot.status === 'denied') return <div className="w-card muted small">This stubyard widget is not available on this page.</div>;
  return <Ready tabId={boot.tabId} windowId={boot.windowId} url={boot.url} />;
}

function Ready({ tabId, windowId, url }: { tabId: number; windowId: number; url: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<TabInfo>({ id: tabId, windowId, url });
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [status, setStatus] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [fillRequest, setFillRequest] = useState(0);
  const link = useRef<HostLink | null>(null);
  const busyKeys = useRef(new Set<string>());
  const box = useRef<HTMLDivElement>(null);

  // The Port to the page host.
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
    link.current = connectHost(tabId, token, () => {});
    return () => link.current?.close();
  }, [tabId]);

  // Settings (and changes from the panel); the first-run hint.
  useEffect(() => {
    void loadSettings().then(setSettings);
    void chrome.storage.local.get(HINT_KEY).then((r) => setHint(r[HINT_KEY] !== true));
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && touchesSettings(changes)) void loadSettings().then(setSettings);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // The tab's URL stays live: SPA route changes and navigations (the widget acts on its own tab).
  useEffect(() => {
    const onUpdated = (id: number, change: { url?: string; status?: string }, t: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (change.url || change.status) setTab({ id, windowId: t.windowId, url: t.url ?? change.url ?? '', status: t.status });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [tabId]);

  // The stream runs only while the tab is visible; coming back reloads the run.
  useEffect(() => {
    const onVis = () => {
      const v = document.visibilityState === 'visible';
      setVisible(v);
      if (v) setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const active: ActiveWalkthrough | null = settings?.activeWalkthroughByWindow[String(windowId)] ?? null;
  const apiUrl = settings?.apiUrl ?? '';
  const t = useMemo(() => (active && apiUrl ? { apiUrl, project: active.project } : null), [apiUrl, active?.project]);
  const run = useRun(t, active?.id ?? null, tick);

  useEffect(() => {
    if (!apiUrl || !active || !visible) return;
    const ac = new AbortController();
    subscribe(
      { apiUrl, project: active.project },
      {
        types: ['walkthrough.changed'],
        signal: ac.signal,
        onEvent: (e) => {
          if ((e.data as { id?: string } | null)?.id === active.id) setTick((n) => n + 1);
        },
        onError: () => {},
      },
    );
    return () => ac.abort();
  }, [apiUrl, active?.project, active?.id, visible]);

  // Esc anywhere in the widget collapses it (keys of the page never reach this frame).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        link.current?.post({ t: 'collapse' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The content height, for the host to size the frame.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const report = () => link.current?.post({ t: 'size', height: Math.ceil(el.getBoundingClientRect().height) });
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings === null]);

  // Progress for the pill.
  const w = run.w;
  const title = run.resolved?.r.text?.title ?? run.step?.title ?? '';
  useEffect(() => {
    if (!w) return;
    const { finished, total } = progress(w);
    link.current?.post({ t: 'progress', finished, total, title: w.status === 'active' ? title : `${w.storyboard.name} (${w.status})` });
  }, [w, title]);

  // Alt+Shift+F: the service worker asks this tab's widget first; it takes the press when it can fill (one fill per press).
  const fillTarget = useRef({ tabId, stepKind: null as string | null, resolved: false, active: false });
  fillTarget.current = {
    tabId,
    stepKind: run.step?.kind ?? null,
    resolved: !!run.step && run.resolved?.stepId === run.step.id,
    active: w?.status === 'active',
  };
  useEffect(() => {
    const onMessage = (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      const take = widgetTakesFill(msg, fillTarget.current);
      if (take === null) return false;
      if (take) setFillRequest((n) => n + 1);
      sendResponse({ handled: take });
      return false;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const setBusy = useCallback((key: string, on: boolean) => {
    const keys = busyKeys.current;
    const before = keys.size > 0;
    if (on) keys.add(key);
    else keys.delete(key);
    if (before !== keys.size > 0) link.current?.post({ t: 'busy', on: keys.size > 0 });
  }, []);
  const widgetOn = useCallback(async (id: number) => id === tabId, [tabId]);
  // Must run inside the click (user gesture).
  const openPanel = useCallback(() => {
    chrome.sidePanel.open({ tabId }).catch(() => setStatus('Click the stubyard toolbar icon to open the panel.'));
  }, [tabId]);

  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(id);
  }, [status]);

  const openWalkthrough = useCallback(async (a: ActiveWalkthrough | null) => setSettings(await setActiveWalkthrough(windowId, a)), [windowId]);

  const host = useMemo<StepHost | null>(
    () =>
      settings
        ? {
            surface: 'widget',
            compact: true,
            tab,
            windowId,
            target: (p: string) => ({ apiUrl: settings.apiUrl, project: p }),
            notify: setStatus,
            fillRequest,
            openWalkthrough,
            widgetOn,
            openPanel,
            setBusy,
          }
        : null,
    [settings, tab, windowId, openWalkthrough, fillRequest, widgetOn, openPanel, setBusy],
  );

  const ui = {
    openPanel,
    collapse: () => link.current?.post({ t: 'collapse' }),
    hide: () => {
      link.current?.post({ t: 'hide' });
      void setTabOverride(tabId, 'hide', chrome.storage.session as unknown as Parameters<typeof setTabOverride>[2]);
    },
  };

  let body;
  if (!host) body = <div className="w-loading muted small">stubyard…</div>;
  else if (!active || !t) body = <WidgetMessage ui={ui} text="No walkthrough is open in this window." />;
  else if (!w) body = run.loadError ? <WidgetMessage ui={ui} text={run.loadError} error /> : <div className="w-loading muted small">Loading the walkthrough…</div>;
  else body = <WidgetCard t={t} run={run} ui={ui} />;

  return (
    <StepHostContext.Provider value={host}>
      <div ref={box} className="w-root">
        {body}
        {status && (
          <p className="w-status" role="status" aria-live="polite" onClick={() => setStatus(null)}>
            {status}
          </p>
        )}
        {hint && host && w && (
          <p className="w-hint small muted">
            Drag the bar above to move this card · Esc collapses it · switch it off in the panel's Settings.{' '}
            <button
              className="link small"
              onClick={() => {
                setHint(false);
                void chrome.storage.local.set({ [HINT_KEY]: true });
              }}
            >
              Got it
            </button>
          </p>
        )}
      </div>
    </StepHostContext.Provider>
  );
}

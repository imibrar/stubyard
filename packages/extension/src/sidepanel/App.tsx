// The side panel shell: settings, the window's active tab, the project for its origin, the event stream, navigation.
// All state that matters lives in stubyard (the walkthrough record); closing the panel loses nothing.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { matchProjects } from '@stubyard/client/storyboards';
import { subscribe } from '@stubyard/client/stream';
import type { PanelMessage } from '../shared/protocol';
import { type ActiveWalkthrough, loadSettings, needsHostPermission, pageOrigin, rememberProject, saveSettings, setActiveWalkthrough, type Settings } from '../shared/settings';
import { PanelContext, type PanelState, type Screen } from './context';
import { errorText, listProjects, systemInfo, type ProjectInfo } from './hub';
import { HomeScreen } from './screens/Home';
import { PageDataScreen } from './screens/PageData';
import { SettingsScreen } from './screens/Settings';
import { StartScreen } from './screens/Start';
import { WalkthroughScreen } from './screens/Walkthrough';
import { activeTab, hasOriginAccess, requestOriginAccess, type TabInfo } from './tabs';

export type ProjectMatch =
  | { status: 'idle' | 'loading' }
  | { status: 'matched'; slug: string }
  | { status: 'many'; projects: { slug: string; name: string; storyboards: number }[] }
  | { status: 'none'; projects: ProjectInfo[] }
  | { status: 'error'; error: string };

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [match, setMatch] = useState<ProjectMatch>({ status: 'idle' });
  const [hubStatus, setHubStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pageAccess, setPageAccess] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [ticks, setTicks] = useState({ storyboards: 0, walkthrough: 0 });
  const [fillRequest, setFillRequest] = useState(0);

  // Settings (and changes made by another panel window).
  useEffect(() => {
    void loadSettings().then(setSettings);
    void chrome.windows.getCurrent().then((w) => setWindowId(w.id ?? chrome.windows.WINDOW_ID_CURRENT));
    const onChanged = (_c: unknown, area: string) => {
      if (area === 'local') void loadSettings().then(setSettings);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // The window's active tab: on open, on tab switch, and when a page finished loading or changed URL.
  useEffect(() => {
    if (windowId === null) return;
    const refresh = () => void activeTab(windowId).then(setTab);
    refresh();
    const onActivated = (info: { windowId: number }) => info.windowId === windowId && refresh();
    const onUpdated = (_id: number, change: { status?: string; url?: string }, t: chrome.tabs.Tab) => {
      if (t.windowId === windowId && t.active && (change.status === 'complete' || change.url)) refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [windowId]);

  // The keyboard command relayed by the service worker.
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if ((msg as PanelMessage | null)?.type === 'panel.command' && (msg as PanelMessage).command === 'fill-form') setFillRequest((n) => n + 1);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const apiUrl = settings?.apiUrl ?? '';
  const origin = pageOrigin(tab?.url);
  const remembered = origin ? settings?.lastProjectByOrigin[origin] : undefined;
  const active = settings && windowId !== null ? (settings.activeWalkthroughByWindow[String(windowId)] ?? null) : null;

  // Connection check.
  useEffect(() => {
    if (!apiUrl) return;
    let live = true;
    systemInfo(apiUrl).then(
      (s) => live && setHubStatus({ ok: true, text: `stubyard ${s.version}` }),
      (err) => live && setHubStatus({ ok: false, text: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [apiUrl]);

  // Can the extension script the page?
  useEffect(() => {
    if (!tab?.url || !origin || !needsHostPermission(tab.url)) return setPageAccess(true);
    void hasOriginAccess(tab.url).then(setPageAccess, () => setPageAccess(false));
  }, [tab?.url, origin]);

  // The project of the tab's origin (§6.9).
  useEffect(() => {
    if (!apiUrl || !origin) return setMatch({ status: 'idle' });
    if (remembered) return setMatch({ status: 'matched', slug: remembered });
    let live = true;
    setMatch({ status: 'loading' });
    (async () => {
      const m = await matchProjects({ apiUrl }, origin);
      if (m.projects.length === 1) return { status: 'matched', slug: m.projects[0].slug } as const;
      if (m.projects.length > 1) return { status: 'many', projects: m.projects } as const;
      return { status: 'none', projects: await listProjects(apiUrl) } as const;
    })().then(
      (r) => live && setMatch(r),
      (err) => live && setMatch({ status: 'error', error: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [apiUrl, origin, remembered, ticks.storyboards]);

  const project = match.status === 'matched' ? match.slug : null;
  const streamProject = active?.project ?? project;

  // Live events: keep the panel in sync with the dashboard and other panels.
  useEffect(() => {
    if (!apiUrl || !streamProject) return;
    const ac = new AbortController();
    subscribe(
      { apiUrl, project: streamProject },
      {
        types: ['walkthrough.changed', 'storyboards.changed'],
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === 'storyboards.changed') setTicks((t) => ({ ...t, storyboards: t.storyboards + 1 }));
          else if (!active || (e.data as { id?: string } | null)?.id === active.id) setTicks((t) => ({ ...t, walkthrough: t.walkthrough + 1 }));
        },
        onError: () => {},
      },
    );
    return () => ac.abort();
  }, [apiUrl, streamProject, active?.id]);

  // First screen: the open walkthrough, else home.
  useEffect(() => {
    if (settings && windowId !== null && !screen) setScreen(active ? { name: 'walkthrough' } : { name: 'home' });
  }, [settings, windowId, screen, active]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => setSettings(await saveSettings(patch)), []);
  const chooseProject = useCallback(
    async (slug: string | null) => {
      if (origin) setSettings(await rememberProject(origin, slug));
    },
    [origin],
  );
  const openWalkthrough = useCallback(
    async (a: ActiveWalkthrough | null) => {
      if (windowId === null) return;
      setSettings(await setActiveWalkthrough(windowId, a));
      setScreen(a ? { name: 'walkthrough' } : { name: 'home' });
    },
    [windowId],
  );

  const ctx = useMemo<PanelState | null>(
    () =>
      settings && windowId !== null
        ? {
            settings,
            updateSettings,
            windowId,
            tab,
            origin,
            project,
            chooseProject,
            target: (p: string) => ({ apiUrl: settings.apiUrl, project: p }),
            active,
            openWalkthrough,
            go: setScreen,
            notify: setToast,
            ticks,
            fillRequest,
          }
        : null,
    [settings, windowId, tab, origin, project, chooseProject, active, openWalkthrough, ticks, fillRequest, updateSettings],
  );

  if (!ctx || !screen) return <div className="loading">Loading…</div>;

  const navItem = (s: Screen, label: string, disabled = false) => (
    <button className={screen.name === s.name ? 'tab on' : 'tab'} disabled={disabled} onClick={() => setScreen(s)}>
      {label}
    </button>
  );

  return (
    <PanelContext.Provider value={ctx}>
      <header className="topbar">
        <nav>
          {navItem({ name: 'home' }, 'Home')}
          {navItem({ name: 'walkthrough' }, 'Walkthrough', !active)}
          {navItem({ name: 'page' }, 'Page data')}
          {navItem({ name: 'settings' }, 'Settings')}
        </nav>
        <div className="context">
          <span className={hubStatus?.ok === false ? 'dot bad' : hubStatus ? 'dot ok' : 'dot'} title={hubStatus?.text ?? 'checking…'} />
          <span className="muted">{origin ?? 'no app page'}</span>
          {project && <span className="chip">{project}</span>}
        </div>
      </header>
      {hubStatus?.ok === false && (
        <div className="banner bad">
          stubyard is not reachable at {apiUrl}. <button className="link" onClick={() => setScreen({ name: 'settings' })}>Settings</button>
        </div>
      )}
      {origin && !pageAccess && (
        <div className="banner">
          The extension needs access to {origin} to fill and read this page.{' '}
          <button className="link" onClick={() => void requestOriginAccess(tab!.url).then(setPageAccess)}>Grant access</button>
        </div>
      )}
      <main>
        {screen.name === 'home' && <HomeScreen match={match} />}
        {screen.name === 'start' && <StartScreen storyboard={screen.storyboard} />}
        {screen.name === 'walkthrough' && <WalkthroughScreen />}
        {screen.name === 'page' && <PageDataScreen />}
        {screen.name === 'settings' && <SettingsScreen match={match} hubStatus={hubStatus} />}
      </main>
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </PanelContext.Provider>
  );
}

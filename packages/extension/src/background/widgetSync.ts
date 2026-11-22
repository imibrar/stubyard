// The service worker's part of the on-page widget (docs/design/floating-widget.md). Stateless: every event reads
// storage again. It decides which tabs show the widget (shared/widget.ts eligibility), injects content.js where needed,
// mints one token per tab (chrome.storage.session, which pages and content scripts cannot read), sends widget.mount /
// widget.unmount, and answers the widget iframe's widget.hello. chrome.* is passed in, so the logic is unit-tested.
import { CONTENT_VERSION, type ContentRequest, type PanelMessage, type WidgetCommand, type WidgetHello, type WidgetHelloResult, type WidgetToggleResult } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { helloAllowed, readTabState as readSession, type SessionArea, setTabOverride, TAB_OVERRIDE_KEY, type TabOverride, TOKENS_KEY, widgetEligibility } from '../shared/widget';

export { setTabOverride };

export interface TabLike {
  id?: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
}

export interface SyncDeps {
  loadSettings(): Promise<Settings>;
  /** chrome.storage.session */
  session: SessionArea;
  /** The tab's content-script version, or null when none answers. */
  ping(tabId: number): Promise<string | null>;
  inject(tabId: number): Promise<void>;
  send(tabId: number, msg: ContentRequest): Promise<unknown>;
  newToken(): string;
  /** chrome.runtime.getURL('widget.html') */
  widgetUrl: string;
}

export const readTabState = (deps: Pick<SyncDeps, 'session'>) => readSession(deps.session);

export type SyncResult = 'mounted' | 'unmounted' | 'none' | 'error';

/** Show or remove the widget in one tab, as the settings and the tab's override say. */
export async function syncTab(tab: TabLike, deps: SyncDeps, pre?: { settings: Settings; tokens: Record<string, string>; overrides: Record<string, TabOverride> }): Promise<SyncResult> {
  if (tab.id === undefined || tab.id < 0) return 'none';
  const tabId = tab.id;
  const settings = pre?.settings ?? (await deps.loadSettings());
  const { tokens, overrides } = pre ?? (await readTabState(deps));
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  const url = tab.url || tab.pendingUrl || '';
  const { show } = widgetEligibility({ enabled: settings.widgetEnabled, hiddenOrigins: settings.widgetHiddenOrigins, active, override: overrides[String(tabId)] ?? null, url });
  try {
    const version = await deps.ping(tabId);
    if (!show) {
      if (version === null) return 'none';
      await deps.send(tabId, { type: 'widget.unmount' });
      return 'unmounted';
    }
    if (version !== CONTENT_VERSION) await deps.inject(tabId);
    const token = tokens[String(tabId)] ?? (await tokenFor(tabId, deps));
    await deps.send(tabId, { type: 'widget.mount', token });
    return 'mounted';
  } catch {
    // A page the extension may not script (chrome://, the web store), or one navigating away: the next event retries.
    return 'error';
  }
}

let minting: Promise<unknown> = Promise.resolve();

/**
 * The tab's token, minted once. Mints run one at a time (read, then write the whole map): two events of one tab, or
 * two new tabs at once, would otherwise each write their own map and one tab's frame would keep a token that is gone.
 */
export function tokenFor(tabId: number, deps: Pick<SyncDeps, 'session' | 'newToken'>): Promise<string> {
  const next = minting.then(async () => {
    const fresh = (await readTabState(deps)).tokens;
    const have = fresh[String(tabId)];
    if (have) return have;
    const token = deps.newToken();
    await deps.session.set({ [TOKENS_KEY]: { ...fresh, [String(tabId)]: token } });
    return token;
  });
  minting = next.catch(() => {});
  return next;
}

/** Sync every tab given (after a settings change, on startup / install). */
export async function syncTabs(tabs: TabLike[], deps: SyncDeps): Promise<SyncResult[]> {
  const settings = await deps.loadSettings();
  const state = await readTabState(deps);
  return Promise.all(tabs.map((t) => syncTab(t, deps, { settings, ...state })));
}

/** A tab closed: forget its token and override. */
export async function forgetTab(tabId: number, deps: Pick<SyncDeps, 'session'>): Promise<void> {
  const { tokens, overrides } = await readTabState(deps);
  const k = String(tabId);
  if (!(k in tokens) && !(k in overrides)) return;
  delete tokens[k];
  delete overrides[k];
  await deps.session.set({ [TOKENS_KEY]: tokens, [TAB_OVERRIDE_KEY]: overrides });
}

export interface HelloSender {
  tab?: { id?: number; windowId: number; url?: string };
  url?: string;
  frameId?: number;
}

/**
 * The widget iframe's widget.hello: it must come from our widget.html inside a tab, carry the token minted for that
 * tab, and the tab must still be eligible. Anything else (a page framing widget.html itself) is denied.
 */
export async function handleHello(msg: WidgetHello, sender: HelloSender, deps: Pick<SyncDeps, 'session' | 'loadSettings' | 'widgetUrl'>): Promise<WidgetHelloResult> {
  const tab = sender.tab;
  const { tokens, overrides } = await readTabState(deps);
  if (!tab || !helloAllowed({ token: msg?.token, senderUrl: sender.url, widgetUrl: deps.widgetUrl, tabId: tab.id, tokens })) return { error: 'denied' };
  if ((sender.frameId ?? 1) === 0) return { error: 'denied' }; // widget.html opened as a page, not framed
  const settings = await deps.loadSettings();
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  const { show } = widgetEligibility({ enabled: settings.widgetEnabled, hiddenOrigins: settings.widgetHiddenOrigins, active, override: overrides[String(tab.id)] ?? null, url: tab.url });
  if (!show) return { error: 'denied' };
  return { tabId: tab.id!, windowId: tab.windowId, url: tab.url ?? '' };
}

// ---------------------------------------------------------------------------------------------------------------
// Keyboard commands (manifest "commands")

export interface CommandDeps {
  /** chrome.runtime.sendMessage: reaches the widget iframes and the side panel; resolves the first answer. */
  broadcast(msg: WidgetCommand | PanelMessage): Promise<unknown>;
}

/**
 * Alt+Shift+F: the widget of the active tab first (it answers handled: true when its current step is a fill or login
 * step), else the side panel, as before. Exactly one view fills per press.
 */
export async function routeFill(tabId: number | undefined, deps: CommandDeps): Promise<'widget' | 'panel'> {
  if (tabId !== undefined && tabId >= 0) {
    const r = await deps.broadcast({ type: 'widget.command', command: 'fill-form', tabId }).catch(() => null);
    if (r && typeof r === 'object' && (r as { handled?: unknown }).handled === true) return 'widget';
  }
  // No receiver (the panel is closed) rejects; that is fine.
  await deps.broadcast({ type: 'panel.command', command: 'fill-form' }).catch(() => {});
  return 'panel';
}

/**
 * Alt+Shift+W: collapse or expand the widget of the active tab. When it is not on the page (hidden on this tab, or a
 * page outside the run's origins) and the window has a walkthrough open, show it there ("Show on this tab"), expanded.
 */
export async function toggleWidgetCommand(tab: TabLike | undefined, deps: SyncDeps): Promise<'toggled' | 'shown' | 'none'> {
  if (!tab || tab.id === undefined || tab.id < 0) return 'none';
  const tabId = tab.id;
  const r = (await deps.send(tabId, { type: 'widget.toggle' }).catch(() => null)) as WidgetToggleResult | null;
  if (r && r.mounted === true) return 'toggled';
  const settings = await deps.loadSettings();
  if (!settings.activeWalkthroughByWindow[String(tab.windowId)]) return 'none';
  await setTabOverride(tabId, 'show', deps.session);
  if ((await syncTab(tab, deps)) !== 'mounted') return 'none';
  await deps.send(tabId, { type: 'widget.toggle', collapsed: false }).catch(() => null);
  return 'shown';
}

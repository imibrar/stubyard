// The service worker's part of the on-page widget (docs/design/floating-widget.md). Stateless: every event reads
// storage again. It decides which tabs show the widget (shared/widget.ts eligibility), injects content.js where needed,
// sends widget.mount / widget.unmount, mints a fresh single-use token for every widget frame (widget.token from the
// tab's content host; chrome.storage.session, which pages cannot read) and answers the frame's widget.hello, which
// uses the token up. chrome.* is passed in, so the logic is unit-tested.
import { CONTENT_VERSION, type ContentRequest, type PanelMessage, type WidgetCommand, type WidgetHello, type WidgetHelloResult, type WidgetToggleResult, type WidgetTokenResult } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { effectiveOverride, helloAllowed, overrideKey, overrideStale, readTabOverride, readTabState as readSession, type SessionArea, setTabOverride, type TabOverrideRec, tokenKey, widgetEligibility } from '../shared/widget';

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
export async function syncTab(tab: TabLike, deps: SyncDeps, pre?: { settings: Settings; overrides: Record<string, TabOverrideRec> }): Promise<SyncResult> {
  if (tab.id === undefined || tab.id < 0) return 'none';
  const tabId = tab.id;
  const settings = pre?.settings ?? (await deps.loadSettings());
  const rec = pre ? (pre.overrides[String(tabId)] ?? null) : await readTabOverride(deps.session, tabId);
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  const url = tab.url || tab.pendingUrl || '';
  // "Show on this tab" was given on another origin: the tab navigated away, so it is dropped (review item 1).
  if (overrideStale(rec, url)) await deps.session.remove(overrideKey(tabId)).catch(() => {});
  const override = effectiveOverride(rec, url);
  const { show } = widgetEligibility({ enabled: settings.widgetEnabled, hiddenOrigins: settings.widgetHiddenOrigins, active, override, url });
  try {
    const version = await deps.ping(tabId);
    if (!show) {
      if (version === null) return 'none';
      await deps.send(tabId, { type: 'widget.unmount' });
      return 'unmounted';
    }
    if (version !== CONTENT_VERSION) await deps.inject(tabId);
    await deps.send(tabId, { type: 'widget.mount' });
    return 'mounted';
  } catch {
    // A page the extension may not script (chrome://, the web store), or one navigating away: the next event retries.
    return 'error';
  }
}

/**
 * Token work (mint, use up, forget) runs one step at a time in the worker, so a hello that reads a token and then
 * removes it cannot interleave with a mint for the same tab.
 */
let tokenQueue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = tokenQueue.then(fn);
  tokenQueue = next.catch(() => {});
  return next;
}

/** Whether a tab shows the widget now (the worker's rules, with the tab's effective override). */
async function eligibleNow(tab: { id?: number; windowId: number; url?: string }, deps: Pick<SyncDeps, 'session' | 'loadSettings'>): Promise<boolean> {
  if (tab.id === undefined) return false;
  const settings = await deps.loadSettings();
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  const rec = await readTabOverride(deps.session, tab.id);
  return widgetEligibility({ enabled: settings.widgetEnabled, hiddenOrigins: settings.widgetHiddenOrigins, active, override: effectiveOverride(rec, tab.url), url: tab.url }).show;
}

/**
 * A fresh token for the next widget frame of a tab (it replaces any earlier one, which is then dead). Only the
 * tab's top-frame content script of this extension may ask, and only while the tab shows the widget.
 */
export async function handleTokenRequest(sender: TokenSender, deps: Pick<SyncDeps, 'session' | 'loadSettings' | 'newToken' | 'widgetUrl'>): Promise<WidgetTokenResult> {
  const tab = sender.tab;
  if (!tab || tab.id === undefined || tab.id < 0) return { error: 'denied' };
  if ((sender.frameId ?? -1) !== 0) return { error: 'denied' };
  const extBase = deps.widgetUrl.replace(/widget\.html$/, '');
  if (sender.url?.startsWith(extBase)) return { error: 'denied' }; // an extension page, not a content script
  if (!(await eligibleNow(tab, deps))) return { error: 'denied' };
  return { token: await mintToken(tab.id, deps) };
}

export interface TokenSender {
  tab?: { id?: number; windowId: number; url?: string };
  url?: string;
  frameId?: number;
}

/** Mint and store a tab's frame token (one key per tab). */
export function mintToken(tabId: number, deps: Pick<SyncDeps, 'session' | 'newToken'>): Promise<string> {
  return queued(async () => {
    const token = deps.newToken();
    await deps.session.set({ [tokenKey(tabId)]: token });
    return token;
  });
}

/** Sync every tab given (after a settings change, on startup / install). */
export async function syncTabs(tabs: TabLike[], deps: SyncDeps): Promise<SyncResult[]> {
  const settings = await deps.loadSettings();
  const { overrides } = await readTabState(deps);
  return Promise.all(tabs.map((t) => syncTab(t, deps, { settings, overrides })));
}

/** A tab closed: forget its token and override (their own keys: nothing else is read or rewritten). */
export function forgetTab(tabId: number, deps: Pick<SyncDeps, 'session'>): Promise<void> {
  return queued(() => deps.session.remove([tokenKey(tabId), overrideKey(tabId)]));
}

export interface HelloSender {
  tab?: { id?: number; windowId: number; url?: string };
  url?: string;
  frameId?: number;
}

/**
 * The widget iframe's widget.hello: it must come from our widget.html inside a tab, carry the token minted for that
 * tab's current frame, and the tab must still be eligible. The token is then used up (single-use): a page that
 * learned it cannot frame widget.html with it again. Anything else (a page framing widget.html itself) is denied.
 */
export function handleHello(msg: WidgetHello, sender: HelloSender, deps: Pick<SyncDeps, 'session' | 'loadSettings' | 'widgetUrl'>): Promise<WidgetHelloResult> {
  return queued(async (): Promise<WidgetHelloResult> => {
    const tab = sender.tab;
    if (!tab || tab.id === undefined) return { error: 'denied' };
    const k = tokenKey(tab.id);
    const expected = (await deps.session.get(k).catch(() => ({}) as Record<string, unknown>))[k];
    if (!helloAllowed({ token: msg?.token, senderUrl: sender.url, widgetUrl: deps.widgetUrl, tabId: tab.id, expected: typeof expected === 'string' ? expected : null })) return { error: 'denied' };
    if ((sender.frameId ?? 1) === 0) return { error: 'denied' }; // widget.html opened as a page, not framed
    if (!(await eligibleNow(tab, deps))) return { error: 'denied' };
    await deps.session.remove(k);
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url ?? '' };
  });
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
  await setTabOverride(tabId, 'show', deps.session, tab.url || tab.pendingUrl);
  if ((await syncTab(tab, deps)) !== 'mounted') return 'none';
  await deps.send(tabId, { type: 'widget.toggle', collapsed: false }).catch(() => null);
  return 'shown';
}

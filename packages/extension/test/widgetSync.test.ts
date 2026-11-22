// The service worker's widget sync (src/background/widgetSync.ts) with fakes: which tabs get the widget, injection
// only where needed, unmount, a fresh single-use token per frame (widget.token, used up by the hello), one storage key
// per tab (no lost updates), forgetting closed tabs, and the hello check.
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetTab, handleHello, handleTokenRequest, routeFill, syncTab, syncTabs, type SyncDeps, toggleWidgetCommand } from '../src/background/widgetSync';
import { CONTENT_VERSION, type ContentRequest } from '../src/shared/protocol';
import { defaultSettings, type Settings } from '../src/shared/settings';
import { overrideKey, readTabState, setTabOverride, tokenKey } from '../src/shared/widget';

/** chrome.storage.session imitation; `delay` makes every call yield, so interleaved writers really interleave. */
export const memorySession = (init: Record<string, unknown> = {}, delay = 0) => {
  const data: Record<string, unknown> = structuredClone(init);
  const tick = () => new Promise((r) => setTimeout(r, delay));
  const keysOf = (k: string | string[] | null) => (k === null ? Object.keys(data) : Array.isArray(k) ? k : [k]);
  return {
    data,
    get: async (k: string | string[] | null) => {
      await tick();
      const out: Record<string, unknown> = {};
      for (const key of keysOf(k)) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      await tick();
      Object.assign(data, structuredClone(items));
    },
    remove: async (k: string | string[]) => {
      await tick();
      for (const key of keysOf(k)) delete data[key];
    },
  };
};

const APP = 'http://localhost:3183';
let settings: Settings;
let session: ReturnType<typeof memorySession>;
let versions: Record<number, string | null>;
let sent: { tabId: number; msg: ContentRequest }[];
let injected: number[];
let n: number;
let deps: SyncDeps;

beforeEach(() => {
  settings = { ...defaultSettings(), activeWalkthroughByWindow: { '1': { project: 'p', id: 'w1', origins: [APP] } } };
  session = memorySession();
  versions = {};
  sent = [];
  injected = [];
  n = 0;
  deps = {
    loadSettings: async () => structuredClone(settings),
    session,
    ping: async (id) => versions[id] ?? null,
    inject: async (id) => {
      if (id === 666) throw new Error('Cannot access a chrome:// URL');
      injected.push(id);
      versions[id] = CONTENT_VERSION;
    },
    send: async (tabId, msg) => void sent.push({ tabId, msg }),
    newToken: () => `tok${++n}`,
    widgetUrl: 'chrome-extension://ext/widget.html',
  };
});

describe('syncTab', () => {
  it('injects the content script and mounts on an app page of the run’s window (no token in the mount)', async () => {
    expect(await syncTab({ id: 5, windowId: 1, url: `${APP}/register` }, deps)).toBe('mounted');
    expect(injected).toEqual([5]);
    expect(sent).toEqual([{ tabId: 5, msg: { type: 'widget.mount' } }]);
    expect(n).toBe(0); // tokens are minted for frames, when the host asks
  });

  it('reuses a live content script of this version (SPA route change, reload)', async () => {
    await syncTab({ id: 5, windowId: 1, url: `${APP}/a` }, deps);
    await syncTab({ id: 5, windowId: 1, url: `${APP}/b` }, deps);
    expect(injected).toEqual([5]);
    expect(sent.map((s) => s.msg)).toEqual([{ type: 'widget.mount' }, { type: 'widget.mount' }]);
  });

  it('replaces an older content script', async () => {
    versions[5] = '0.2.0';
    await syncTab({ id: 5, windowId: 1, url: APP }, deps);
    expect(injected).toEqual([5]);
  });

  it('unmounts where it no longer belongs, and leaves pages without a content script alone', async () => {
    versions[6] = CONTENT_VERSION;
    expect(await syncTab({ id: 6, windowId: 1, url: 'https://other.test/' }, deps)).toBe('unmounted');
    expect(sent).toEqual([{ tabId: 6, msg: { type: 'widget.unmount' } }]);
    expect(await syncTab({ id: 7, windowId: 2, url: APP }, deps)).toBe('none'); // no run in window 2
    expect(injected).toEqual([]);
  });

  it('follows the Settings switch and the tab’s show / hide choice', async () => {
    settings.widgetEnabled = false;
    expect(await syncTab({ id: 5, windowId: 1, url: APP }, deps)).toBe('none');
    session.data[overrideKey(5)] = { value: 'show', origin: 'https://idp.test' };
    session.data[overrideKey(8)] = { value: 'hide', origin: APP };
    expect(await syncTab({ id: 5, windowId: 1, url: 'https://idp.test/login' }, deps)).toBe('mounted');
    settings.widgetEnabled = true;
    versions[8] = CONTENT_VERSION;
    expect(await syncTab({ id: 8, windowId: 1, url: APP }, deps)).toBe('unmounted');
    // "Hide on this tab" holds on any origin of the tab.
    expect(await syncTab({ id: 8, windowId: 1, url: `${APP.replace('3183', '3184')}/x` }, deps)).toBe('unmounted');
  });

  it('"Show on this tab" is dropped when the tab navigates to another origin (review item 1)', async () => {
    await setTabOverride(5, 'show', session, 'https://idp.test/login');
    expect(await syncTab({ id: 5, windowId: 1, url: 'https://idp.test/other' }, deps)).toBe('mounted');
    versions[5] = CONTENT_VERSION;
    expect(await syncTab({ id: 5, windowId: 1, url: 'https://evil.test/' }, deps)).toBe('unmounted');
    expect(session.data[overrideKey(5)]).toBeUndefined();
    // Coming back to the first origin does not bring it back either: it was dropped.
    expect(await syncTab({ id: 5, windowId: 1, url: 'https://idp.test/other' }, deps)).toBe('unmounted');
    // An old-style override without an origin never shows the widget.
    session.data[overrideKey(5)] = 'show';
    expect(await syncTab({ id: 5, windowId: 1, url: 'https://idp.test/other' }, deps)).toBe('unmounted');
  });

  it('a page the extension may not script is an error, not a throw', async () => {
    settings.activeWalkthroughByWindow['1'].origins = ['https://chromewebstore.google.com'];
    expect(await syncTab({ id: 666, windowId: 1, url: 'https://chromewebstore.google.com/x' }, deps)).toBe('error');
    expect(await syncTab({ id: undefined, windowId: 1, url: APP }, deps)).toBe('none');
  });

  it('syncTabs reads storage once for all tabs', async () => {
    let loads = 0;
    const counting = { ...deps, loadSettings: async () => (loads++, structuredClone(settings)) };
    const r = await syncTabs(
      [
        { id: 1, windowId: 1, url: APP },
        { id: 2, windowId: 1, url: 'about:blank' },
        { id: 3, windowId: 1, url: `${APP}/x` },
      ],
      counting,
    );
    expect(r).toEqual(['mounted', 'none', 'mounted']);
    expect(loads).toBe(1);
  });

  it('forgetTab drops a closed tab’s token and choice', async () => {
    session.data[tokenKey(5)] = 'a';
    session.data[tokenKey(6)] = 'b';
    session.data[overrideKey(5)] = { value: 'hide', origin: null };
    await forgetTab(5, deps);
    expect(session.data).toEqual({ [tokenKey(6)]: 'b' });
  });

  it('writers that interleave lose nothing: one key per tab (review item 4)', async () => {
    const slow = memorySession({ [overrideKey(7)]: { value: 'hide', origin: null }, [tokenKey(7)]: 'x' }, 2);
    const d = { ...deps, session: slow };
    // The panel, a widget frame and the worker at once: show on 5, hide on 6, tab 7 closes, a token for 8.
    await Promise.all([setTabOverride(5, 'show', slow, `${APP}/a`), setTabOverride(6, 'hide', slow), forgetTab(7, d), setTabOverride(9, 'hide', slow), setTabOverride(9, null, slow)]);
    const st = await readTabState(slow);
    expect(st.overrides).toEqual({ '5': { value: 'show', origin: APP }, '6': { value: 'hide', origin: null } });
    expect(st.tokens).toEqual({});
  });
});

describe('widget.token (a fresh single-use token per frame)', () => {
  const cs = (o: Partial<{ id: number; windowId: number; url: string; senderUrl: string; frameId: number }> = {}) => ({
    tab: { id: o.id ?? 5, windowId: o.windowId ?? 1, url: o.url ?? `${APP}/register` },
    url: o.senderUrl ?? o.url ?? `${APP}/register`,
    frameId: o.frameId ?? 0,
  });
  const frame = (token: string) => ({ tab: cs().tab, url: `chrome-extension://ext/widget.html#token=${token}`, frameId: 3 });

  it('the tab’s top-frame content script gets one; each new one replaces the last; the hello uses it up', async () => {
    expect(await handleTokenRequest(cs(), deps)).toEqual({ token: 'tok1' });
    expect(session.data[tokenKey(5)]).toBe('tok1');
    expect(await handleTokenRequest(cs(), deps)).toEqual({ token: 'tok2' }); // a remount rotates it
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, frame('tok1'), deps)).toEqual({ error: 'denied' });
    expect(await handleHello({ type: 'widget.hello', token: 'tok2' }, frame('tok2'), deps)).toEqual({ tabId: 5, windowId: 1, url: `${APP}/register` });
    // Single-use: a page that learned the token cannot frame widget.html with it again.
    expect(session.data[tokenKey(5)]).toBeUndefined();
    expect(await handleHello({ type: 'widget.hello', token: 'tok2' }, frame('tok2'), deps)).toEqual({ error: 'denied' });
  });

  it('two hellos with the same token at once: exactly one gets in', async () => {
    const slow = memorySession({}, 2);
    const d = { ...deps, session: slow };
    const { token } = (await handleTokenRequest(cs(), d)) as { token: string };
    const r = await Promise.all([handleHello({ type: 'widget.hello', token }, frame(token), d), handleHello({ type: 'widget.hello', token }, frame(token), d)]);
    expect(r.filter((x) => 'tabId' in x)).toHaveLength(1);
  });

  it('denied for a sub-frame, an extension page, a tab without the widget, no tab', async () => {
    const no = { error: 'denied' };
    expect(await handleTokenRequest(cs({ frameId: 2 }), deps)).toEqual(no);
    expect(await handleTokenRequest(cs({ senderUrl: 'chrome-extension://ext/sidepanel.html' }), deps)).toEqual(no);
    expect(await handleTokenRequest(cs({ url: 'https://other.test/' }), deps)).toEqual(no);
    expect(await handleTokenRequest({ url: APP, frameId: 0 }, deps)).toEqual(no);
    expect(n).toBe(0);
  });
});

describe('handleHello', () => {
  const sender = (o: Partial<{ id: number; windowId: number; url: string; senderUrl: string; frameId: number }> = {}) => ({
    tab: { id: o.id ?? 5, windowId: o.windowId ?? 1, url: o.url ?? `${APP}/register` },
    url: o.senderUrl ?? 'chrome-extension://ext/widget.html#token=tok1',
    frameId: o.frameId ?? 3,
  });
  beforeEach(() => {
    session.data[tokenKey(5)] = 'tok1';
  });

  it('answers the widget its tab with the right token', async () => {
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, sender(), deps)).toEqual({ tabId: 5, windowId: 1, url: `${APP}/register` });
  });
  it('denies a wrong token, another tab, a top-level widget page, another extension page', async () => {
    const no = { error: 'denied' };
    expect(await handleHello({ type: 'widget.hello', token: 'x' }, sender(), deps)).toEqual(no);
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, sender({ id: 9 }), deps)).toEqual(no);
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, sender({ frameId: 0 }), deps)).toEqual(no);
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, sender({ senderUrl: 'chrome-extension://ext/sidepanel.html' }), deps)).toEqual(no);
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, { url: 'chrome-extension://ext/widget.html' }, deps)).toEqual(no);
  });
  it('denies a tab that is no longer eligible (run closed, other origin)', async () => {
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, sender({ url: 'https://other.test/' }), deps)).toEqual({ error: 'denied' });
    settings.activeWalkthroughByWindow = {};
    expect(await handleHello({ type: 'widget.hello', token: 'tok1' }, sender(), deps)).toEqual({ error: 'denied' });
  });
});

describe('Alt+Shift+F routing (routeFill)', () => {
  it('the widget of the active tab takes it: the panel gets nothing (one fill per press)', async () => {
    const out: unknown[] = [];
    const r = await routeFill(5, { broadcast: async (m) => (out.push(m), m.type === 'widget.command' ? { handled: true } : undefined) });
    expect(r).toBe('widget');
    expect(out).toEqual([{ type: 'widget.command', command: 'fill-form', tabId: 5 }]);
  });
  it('no widget answers, or it says no: the panel as before', async () => {
    for (const answer of [undefined, { handled: false }, Promise.reject(new Error('Receiving end does not exist'))]) {
      const out: unknown[] = [];
      const r = await routeFill(5, { broadcast: (m) => (out.push(m), m.type === 'widget.command' ? Promise.resolve(answer) : Promise.reject(new Error('no panel'))) });
      expect(r).toBe('panel');
      expect(out[1]).toEqual({ type: 'panel.command', command: 'fill-form' });
    }
  });
  it('no active tab: straight to the panel', async () => {
    const out: unknown[] = [];
    expect(await routeFill(undefined, { broadcast: async (m) => void out.push(m) })).toBe('panel');
    expect(out).toEqual([{ type: 'panel.command', command: 'fill-form' }]);
  });
});

describe('Alt+Shift+W (toggleWidgetCommand)', () => {
  it('a widget on the page: collapse / expand it', async () => {
    deps.send = async (tabId, msg) => (sent.push({ tabId, msg }), msg.type === 'widget.toggle' ? { ok: true, mounted: true, collapsed: true } : undefined);
    expect(await toggleWidgetCommand({ id: 5, windowId: 1, url: APP }, deps)).toBe('toggled');
    expect(sent).toEqual([{ tabId: 5, msg: { type: 'widget.toggle' } }]);
  });
  it('hidden on this tab (or another origin): shows it there, expanded', async () => {
    session.data[overrideKey(5)] = { value: 'hide', origin: null };
    deps.send = async (tabId, msg) => (sent.push({ tabId, msg }), msg.type === 'widget.toggle' ? { ok: true, mounted: false, collapsed: false } : undefined);
    expect(await toggleWidgetCommand({ id: 5, windowId: 1, url: 'https://other.test/' }, deps)).toBe('shown');
    expect(session.data[overrideKey(5)]).toEqual({ value: 'show', origin: 'https://other.test' });
    expect(sent.map((s) => s.msg.type)).toEqual(['widget.toggle', 'widget.mount', 'widget.toggle']);
    expect(sent[2].msg).toEqual({ type: 'widget.toggle', collapsed: false });
  });
  it('no walkthrough open in the window, or no tab: nothing', async () => {
    deps.send = async () => {
      throw new Error('Receiving end does not exist');
    };
    expect(await toggleWidgetCommand({ id: 7, windowId: 2, url: APP }, deps)).toBe('none');
    expect(session.data[overrideKey(7)]).toBeUndefined();
    expect(await toggleWidgetCommand(undefined, deps)).toBe('none');
  });
});

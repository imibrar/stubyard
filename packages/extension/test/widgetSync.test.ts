// The service worker's widget sync (src/background/widgetSync.ts) with fakes: which tabs get the widget, injection
// only where needed, one token per tab (reused, never re-minted), unmount, forgetting closed tabs, and the hello check.
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetTab, handleHello, routeFill, syncTab, syncTabs, type SyncDeps, toggleWidgetCommand } from '../src/background/widgetSync';
import { CONTENT_VERSION, type ContentRequest } from '../src/shared/protocol';
import { defaultSettings, type Settings } from '../src/shared/settings';
import { TAB_OVERRIDE_KEY, TOKENS_KEY } from '../src/shared/widget';

const memorySession = (init: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = structuredClone(init);
  return {
    data,
    get: async (k: string) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
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
  it('injects the content script, mints a token and mounts on an app page of the run’s window', async () => {
    expect(await syncTab({ id: 5, windowId: 1, url: `${APP}/register` }, deps)).toBe('mounted');
    expect(injected).toEqual([5]);
    expect(sent).toEqual([{ tabId: 5, msg: { type: 'widget.mount', token: 'tok1' } }]);
    expect(session.data[TOKENS_KEY]).toEqual({ '5': 'tok1' });
  });

  it('reuses the tab’s token and a live content script of this version (SPA route change, reload)', async () => {
    await syncTab({ id: 5, windowId: 1, url: `${APP}/a` }, deps);
    await syncTab({ id: 5, windowId: 1, url: `${APP}/b` }, deps);
    expect(injected).toEqual([5]);
    expect(sent.map((s) => s.msg)).toEqual([
      { type: 'widget.mount', token: 'tok1' },
      { type: 'widget.mount', token: 'tok1' },
    ]);
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
    session.data[TAB_OVERRIDE_KEY] = { '5': 'show', '8': 'hide' };
    expect(await syncTab({ id: 5, windowId: 1, url: 'https://idp.test/login' }, deps)).toBe('mounted');
    settings.widgetEnabled = true;
    versions[8] = CONTENT_VERSION;
    expect(await syncTab({ id: 8, windowId: 1, url: APP }, deps)).toBe('unmounted');
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
    session.data[TOKENS_KEY] = { '5': 'a', '6': 'b' };
    session.data[TAB_OVERRIDE_KEY] = { '5': 'hide' };
    await forgetTab(5, deps);
    expect(session.data[TOKENS_KEY]).toEqual({ '6': 'b' });
    expect(session.data[TAB_OVERRIDE_KEY]).toEqual({});
  });
});

describe('handleHello', () => {
  const sender = (o: Partial<{ id: number; windowId: number; url: string; senderUrl: string; frameId: number }> = {}) => ({
    tab: { id: o.id ?? 5, windowId: o.windowId ?? 1, url: o.url ?? `${APP}/register` },
    url: o.senderUrl ?? 'chrome-extension://ext/widget.html#token=tok1',
    frameId: o.frameId ?? 3,
  });
  beforeEach(() => {
    session.data[TOKENS_KEY] = { '5': 'tok1' };
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
    session.data[TAB_OVERRIDE_KEY] = { '5': 'hide' };
    deps.send = async (tabId, msg) => (sent.push({ tabId, msg }), msg.type === 'widget.toggle' ? { ok: true, mounted: false, collapsed: false } : undefined);
    expect(await toggleWidgetCommand({ id: 5, windowId: 1, url: 'https://other.test/' }, deps)).toBe('shown');
    expect(session.data[TAB_OVERRIDE_KEY]).toEqual({ '5': 'show' });
    expect(sent.map((s) => s.msg.type)).toEqual(['widget.toggle', 'widget.mount', 'widget.toggle']);
    expect(sent[2].msg).toEqual({ type: 'widget.toggle', collapsed: false });
  });
  it('no walkthrough open in the window, or no tab: nothing', async () => {
    deps.send = async () => {
      throw new Error('Receiving end does not exist');
    };
    expect(await toggleWidgetCommand({ id: 7, windowId: 2, url: APP }, deps)).toBe('none');
    expect(session.data[TAB_OVERRIDE_KEY]).toBeUndefined();
    expect(await toggleWidgetCommand(undefined, deps)).toBe('none');
  });
});

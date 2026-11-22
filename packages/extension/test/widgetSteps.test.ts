// Phase 1b step controls, rendered with React in happy-dom against a mocked stubyard: login with the shared 2FA wait
// (Fill login stores twoFactorPending first; the widget of the same tab resumes it after a navigation; another view
// only shows "Waiting … in …" and can take it over; never two fills), the email wait and the compact link picker, and
// the copy button's fallback chain.
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedStep, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { CopyButton } from '../src/run/CopyButton';
import { StepHostContext, type StepHost } from '../src/run/host';
import { StepControls } from '../src/sidepanel/steps/StepCard';

const hub = vi.hoisted(() => ({ updateStep: vi.fn(), getWalkthrough: vi.fn(), patchWalkthrough: vi.fn(), addScreenshot: vi.fn(), finishWalkthrough: vi.fn() }));
const auth = vi.hoisted(() => ({ getTotpCode: vi.fn() }));
const msgs = vi.hoisted(() => ({ waitForMessagePath: vi.fn(), getMessage: vi.fn() }));
const tabsApi = vi.hoisted(() => ({ sendToTab: vi.fn(), openUrl: vi.fn() }));
vi.mock('@stubyard/client/walkthroughs', () => hub);
vi.mock('@stubyard/client/authenticators', () => auth);
vi.mock('@stubyard/client/messages', () => msgs);
vi.mock('@stubyard/client/http', () => ({ hubJson: vi.fn(async () => []) }));
vi.mock('../src/sidepanel/tabs', async (orig) => ({ ...(await orig<typeof import('../src/sidepanel/tabs')>()), ...tabsApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = { apiUrl: 'http://hub.test', project: 'p' };
const stepOf = (kind: string, data: Record<string, unknown> = {}) =>
  ({ id: 's1', kind, title: 'Step', intent: '', notes: '', optional: false, screenshot: 'off', position: 0, status: 'active', note: '', data, startedAt: null, finishedAt: null, shots: [], timeoutSec: 60 }) as unknown as WalkthroughStepView;
const walkOf = (s: WalkthroughStepView) => ({ id: 'w1', status: 'active', mode: 'tracked', currentStepId: s.id, vars: {}, warnings: [], actors: {}, storyboard: { name: 'B' }, steps: [s] }) as unknown as WalkthroughView;

const loginResolved = (tf: Record<string, unknown> = { kind: 'totp', selector: '#code', codePath: '/code', label: 'Admin 2FA' }) =>
  ({ step: { id: 's1', kind: 'login' }, warnings: [], text: {}, url: null, username: 'ada@example.test', password: 'pw-1', selectors: { username: '#email', password: '#password' }, actor: { name: 'Ada', role: 'admin' }, twoFactor: tf }) as unknown as ResolvedStep;
const emailResolved = (o: Record<string, unknown> = {}) =>
  ({ step: { id: 's1', kind: 'email' }, warnings: [], text: {}, channel: 'email', user: { email: 'ada@example.test' }, subject: 'Welcome', waitPath: '/api/projects/p/messages/wait?user=u&channel=email', linkPattern: null, linkIndex: null, open: 'same-tab', ...o }) as unknown as ResolvedStep;

// The hub: one walkthrough, PATCHed with a shallow data merge (like the server).
let store: WalkthroughView;
const merge = (data: Record<string, unknown>) => {
  const s = store.steps[0];
  store = { ...store, steps: [{ ...s, data: { ...s.data, ...data } }] };
  return store;
};

let root: Root;
let el: HTMLElement;
let host: StepHost;
let setOuter: ((w: WalkthroughView) => void) | null = null;
function Harness({ resolved, h }: { resolved: ResolvedStep; h: StepHost }) {
  const [w, setW] = useState(store);
  setOuter = setW;
  return createElement(StepHostContext.Provider, { value: h }, createElement(StepControls, { t, w, step: w.steps[0], resolved, apply: setW }));
}
const render = (resolved: ResolvedStep, h: StepHost = host) => act(async () => root.render(createElement(Harness, { resolved, h })));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await flush(2);
  }
};
const btn = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
const click = (label: string) => act(async () => btn(label)!.click());
const setValues = () => tabsApi.sendToTab.mock.calls.filter((c) => c[1].type === 'setValue').map((c) => [c[1].selector, c[1].value]);
const dataPatches = () => hub.updateStep.mock.calls.map((c) => c[3].data as Record<string, unknown>);

beforeEach(() => {
  for (const m of [...Object.values(hub), ...Object.values(auth), ...Object.values(msgs), ...Object.values(tabsApi)]) m.mockReset();
  hub.updateStep.mockImplementation(async (_t, _w, _s, body: { data?: Record<string, unknown> }) => merge(body.data ?? {}));
  hub.getWalkthrough.mockImplementation(async () => store);
  auth.getTotpCode.mockResolvedValue({ code: '123456', validUntil: Date.now() + 20_000, remaining: 20 });
  tabsApi.sendToTab.mockImplementation(async (_tab, req: { type: string }) => (req.type === 'probe' ? { present: true, visible: true, value: '' } : req.type === 'highlight' ? { found: true } : { ok: true }));
  host = { surface: 'widget', compact: true, tab: { id: 3, windowId: 1, url: 'http://app.test/login' }, windowId: 1, target: (p) => ({ apiUrl: t.apiUrl, project: p }), notify: vi.fn(), fillRequest: 0, openWalkthrough: vi.fn(async () => {}), widgetOn: vi.fn(async () => true), openPanel: vi.fn(), setBusy: vi.fn() };
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  setOuter = null;
});

describe('login + 2FA in the widget', () => {
  it('Fill login stores the wait first, fills, then fills the TOTP code once and clears the wait', async () => {
    store = walkOf(stepOf('login'));
    await render(loginResolved());
    expect(el.textContent).not.toContain('Continue in panel');
    await click('Fill login');
    await until(() => setValues().length === 3);
    expect(setValues()).toEqual([['#email', 'ada@example.test'], ['#password', 'pw-1'], ['#code', '123456']]);
    const patches = dataPatches();
    expect(patches[0].twoFactorPending).toMatchObject({ owner: 'widget', tabId: 3, windowId: 1 });
    // The pending wait was stored before anything was typed into the page.
    expect(hub.updateStep.mock.invocationCallOrder[0]).toBeLessThan(tabsApi.sendToTab.mock.invocationCallOrder[0]);
    await until(() => store.steps[0].data.twoFactorFilled === true);
    expect(dataPatches()).toEqual([patches[0], { twoFactorPending: null, twoFactorFilled: true }]);
    expect(store.steps[0].data.twoFactorPending).toBeNull();
    expect(host.setBusy).toHaveBeenCalledWith('2fa', true);
    expect(host.setBusy).toHaveBeenLastCalledWith('2fa', false);
    expect(el.textContent).toContain('Code filled');
  });

  it('a new widget on the next page resumes the wait of its tab (no click) and fills once', async () => {
    store = walkOf(stepOf('login', { twoFactorPending: { id: 'x', owner: 'widget', tabId: 3, windowId: 1, startedAt: Date.now() - 4000, until: Date.now() + 60_000 } }));
    await render(loginResolved());
    await until(() => store.steps[0].data.twoFactorFilled === true);
    expect(setValues()).toEqual([['#code', '123456']]);
    expect(store.steps[0].data.twoFactorPending).toBeNull();
  });

  it('an expired wait is not resumed', async () => {
    store = walkOf(stepOf('login', { twoFactorPending: { id: 'x', owner: 'widget', tabId: 3, windowId: 1, startedAt: Date.now() - 400_000, until: Date.now() - 100_000 } }));
    await render(loginResolved());
    await flush();
    expect(tabsApi.sendToTab).not.toHaveBeenCalled();
    expect(btn('Fill 2FA code')).toBeTruthy();
  });

  it("another view's wait: shows where it runs, never waits as well; Wait here instead takes it over", async () => {
    store = walkOf(stepOf('login', { twoFactorPending: { id: 'p', owner: 'panel', tabId: 3, windowId: 1, startedAt: Date.now(), until: Date.now() + 60_000 } }));
    await render(loginResolved());
    await flush();
    expect(el.textContent).toContain('Waiting for the 2FA code in the side panel');
    expect(tabsApi.sendToTab).not.toHaveBeenCalled();
    expect(btn('Fill 2FA code')).toBeUndefined();
    await click('Wait here instead');
    await until(() => store.steps[0].data.twoFactorFilled === true);
    expect(dataPatches()[0].twoFactorPending).toMatchObject({ owner: 'widget', tabId: 3 });
    expect(setValues()).toEqual([['#code', '123456']]);
  });

  it('a wait taken over elsewhere right before the fill does not fill (never twice)', async () => {
    store = walkOf(stepOf('login'));
    hub.getWalkthrough.mockImplementation(async () => {
      const s = store.steps[0];
      return { ...store, steps: [{ ...s, data: { ...s.data, twoFactorPending: { id: 'other', owner: 'panel', tabId: 3, windowId: 1, startedAt: Date.now() + 1, until: Date.now() + 60_000 } } }] };
    });
    await render(loginResolved());
    await click('Fill 2FA code');
    await until(() => hub.getWalkthrough.mock.calls.length > 0);
    await flush();
    expect(setValues()).toEqual([]);
    expect(store.steps[0].data.twoFactorFilled).toBeUndefined();
  });

  it('stops when another view takes the wait over (a newer pending wait arrives)', async () => {
    store = walkOf(stepOf('login'));
    tabsApi.sendToTab.mockImplementation(async (_tab, req: { type: string }) => (req.type === 'probe' ? { present: false, visible: false, value: null } : { ok: true }));
    await render(loginResolved());
    await click('Fill 2FA code');
    await until(() => !!btn('Cancel 2FA wait'));
    await act(async () => setOuter!(merge({ twoFactorPending: { id: 'newer', owner: 'panel', tabId: 3, windowId: 1, startedAt: Date.now() + 5, until: Date.now() + 60_000 } })));
    await flush();
    expect(btn('Cancel 2FA wait')).toBeUndefined();
    expect(el.textContent).toContain('Waiting for the 2FA code in the side panel');
    // The other view's wait is left alone.
    expect((store.steps[0].data.twoFactorPending as { id: string }).id).toBe('newer');
  });

  it('unmounting (the page navigates) keeps the wait for the next widget; Cancel clears it', async () => {
    store = walkOf(stepOf('login'));
    tabsApi.sendToTab.mockImplementation(async (_tab, req: { type: string }) => (req.type === 'probe' ? { present: false, visible: false, value: null } : { ok: true }));
    await render(loginResolved());
    await click('Fill 2FA code');
    await until(() => !!btn('Cancel 2FA wait'));
    await act(async () => root.unmount());
    await flush();
    expect(store.steps[0].data.twoFactorPending).toMatchObject({ owner: 'widget' });
    root = createRoot(el);
    store = walkOf(stepOf('login'));
    await render(loginResolved());
    await click('Fill 2FA code');
    await until(() => !!btn('Cancel 2FA wait'));
    await click('Cancel 2FA wait');
    await until(() => store.steps[0].data.twoFactorPending === null);
  });

  it('Alt+Shift+F (fillRequest) fills the login', async () => {
    store = walkOf(stepOf('login'));
    await render(loginResolved({ kind: 'none' }));
    await render(loginResolved({ kind: 'none' }), { ...host, fillRequest: 1 });
    await until(() => setValues().length === 2);
    expect(setValues()).toEqual([['#email', 'ada@example.test'], ['#password', 'pw-1']]);
  });
});

describe('login + 2FA in the panel', () => {
  const panel = () => ({ ...host, surface: 'panel' as const, compact: false });
  const widgetWait = () => ({ twoFactorPending: { id: 'w', owner: 'widget', tabId: 3, windowId: 1, startedAt: Date.now(), until: Date.now() + 60_000 } });

  it('a widget wait on a tab that shows the widget: the panel only says so', async () => {
    store = walkOf(stepOf('login', widgetWait()));
    const h = panel();
    await render(loginResolved(), h);
    await flush();
    expect(h.widgetOn).toHaveBeenCalledWith(3);
    expect(el.textContent).toContain('Waiting for the 2FA code in the page widget');
    expect(tabsApi.sendToTab).not.toHaveBeenCalled();
  });

  it('the widget cannot be on that tab (another origin, switched off): the panel takes over and fills', async () => {
    store = walkOf(stepOf('login', widgetWait()));
    const h = { ...panel(), widgetOn: vi.fn(async () => false) };
    await render(loginResolved(), h);
    await until(() => store.steps[0].data.twoFactorFilled === true);
    expect(dataPatches()[0].twoFactorPending).toMatchObject({ owner: 'panel', tabId: 3 });
    expect(setValues()).toEqual([['#code', '123456']]);
  });
});

describe('fills stay on the run’s origins (security review items 1 and 3)', () => {
  const APP_O = 'http://app.test';
  const EVIL = 'http://evil.test';
  const reqs = (type: string) => tabsApi.sendToTab.mock.calls.filter((c) => c[1].type === type).map((c) => c[1] as Record<string, unknown>);
  const fillResolved = () => ({ step: { id: 's1', kind: 'fill' }, warnings: [], text: {}, url: null, dataSet: { name: 'Sign-up' }, entries: [{ key: 'name', value: 'Ada', kind: 'auto' }], formId: null }) as unknown as ResolvedStep;

  it('Fill login passes the checked origin, so the content script types only there', async () => {
    store = walkOf(stepOf('login'));
    await render(loginResolved({ kind: 'none' }), { ...host, appOrigins: [APP_O] });
    await click('Fill login');
    await until(() => setValues().length === 2);
    expect(reqs('setValue').map((r) => r.origin)).toEqual([APP_O, APP_O]);
  });

  it('the widget refuses to fill a login or a form into a page outside the run’s origins and points to the panel', async () => {
    store = walkOf(stepOf('login'));
    const h = { ...host, appOrigins: [APP_O], tab: { id: 3, windowId: 1, url: `${EVIL}/login` } };
    await render(loginResolved(), h);
    await click('Fill login');
    await flush();
    expect(tabsApi.sendToTab).not.toHaveBeenCalled();
    expect(hub.updateStep).not.toHaveBeenCalled(); // no 2FA wait started either
    expect(el.textContent).toContain('is not one of this run’s app origins');
    await click('Open panel');
    expect(h.openPanel).toHaveBeenCalled();
    store = walkOf(stepOf('fill'));
    await render(fillResolved(), h);
    await click('Fill form');
    await flush();
    expect(reqs('fill')).toEqual([]);
  });

  it('the panel asks first; Fill anyway fills there (with that origin), Cancel does nothing', async () => {
    store = walkOf(stepOf('fill'));
    const h = { ...host, surface: 'panel' as const, compact: false, appOrigins: [APP_O], tab: { id: 3, windowId: 1, url: `${EVIL}/form` } };
    await render(fillResolved(), h);
    await click('Fill form');
    await flush();
    expect(reqs('fill')).toEqual([]);
    expect(el.textContent).toContain('Fill the form there anyway?');
    await click('Cancel');
    expect(el.textContent).not.toContain('there anyway?');
    tabsApi.sendToTab.mockResolvedValue({ filled: 1, unmatched: 0, skipped: 0, errors: 0, details: [] });
    await click('Fill form');
    await click('Fill anyway');
    await until(() => reqs('fill').length === 1);
    expect(reqs('fill')[0].origin).toBe(EVIL);
  });

  it('a 2FA wait does not fill on another origin: it pauses and asks; the panel can confirm', async () => {
    let at = EVIL;
    tabsApi.sendToTab.mockImplementation(async (_tab, req: { type: string }) => (req.type === 'probe' ? { present: true, visible: true, value: '', origin: at } : { ok: true }));
    // A widget wait that started on the app, taken over by the panel after the tab left the app (auto take-over).
    store = walkOf(stepOf('login', { twoFactorPending: { id: 'w', owner: 'widget', tabId: 3, windowId: 1, startedAt: Date.now(), until: Date.now() + 60_000, origin: APP_O } }));
    const h = { ...host, surface: 'panel' as const, compact: false, appOrigins: [APP_O], tab: { id: 9, windowId: 1, url: 'http://elsewhere.test/' }, widgetOn: vi.fn(async () => false) };
    await render(loginResolved(), h);
    await until(() => el.textContent!.includes('not filled there by itself'));
    // The take-over kept where the login started (not the panel's own tab).
    expect(dataPatches()[0].twoFactorPending).toMatchObject({ owner: 'panel', tabId: 3, origin: APP_O });
    expect(el.textContent).toContain(EVIL);
    await flush(30);
    expect(setValues()).toEqual([]);
    await click('Fill the code there');
    await until(() => setValues().length === 1);
    expect(reqs('setValue')[0].origin).toBe(EVIL);
    at = APP_O;
  });

  it('a 2FA wait goes on by itself when the tab comes back to where the login started', async () => {
    let at = EVIL;
    tabsApi.sendToTab.mockImplementation(async (_tab, req: { type: string }) => (req.type === 'probe' ? { present: true, visible: true, value: '', origin: at } : { ok: true }));
    store = walkOf(stepOf('login', { twoFactorPending: { id: 'x', owner: 'widget', tabId: 3, windowId: 1, startedAt: Date.now() - 1000, until: Date.now() + 60_000, origin: APP_O } }));
    await render(loginResolved(), { ...host, appOrigins: [APP_O] });
    await until(() => el.textContent!.includes('not filled there by itself'));
    expect(el.textContent).toContain('Wait here instead in the side panel');
    expect(setValues()).toEqual([]);
    at = APP_O;
    await until(() => store.steps[0].data.twoFactorFilled === true, 5000);
    expect(reqs('setValue').map((r) => r.origin)).toEqual([APP_O]);
  });
});

describe('email in the widget', () => {
  const links = Array.from({ length: 8 }, (_, i) => `http://app.test/l/${i + 1}`);
  const message = { id: 'm1', subject: 'Welcome', from: 'app@example.test', createdAt: new Date().toISOString(), bodyText: 'x'.repeat(300), links, otp: '4242' };

  it('waits (stored as emailWaitPending), shows the message, a compact picker of 5 links and "more in the panel"', async () => {
    store = walkOf(stepOf('email'));
    msgs.waitForMessagePath.mockResolvedValue(message);
    msgs.getMessage.mockResolvedValue(message);
    await render(emailResolved());
    await click('Wait for message');
    await until(() => store.steps[0].data.messageId === 'm1');
    expect(dataPatches()[0].emailWaitPending).toMatchObject({ owner: 'widget', tabId: 3 });
    expect(store.steps[0].data.emailWaitPending).toBeNull();
    await flush();
    expect(el.querySelectorAll('input[type=radio]').length).toBe(5);
    expect(el.textContent).toContain('3 more links in the panel');
    expect(el.querySelector('.excerpt')?.textContent?.length).toBe(160);
    await click('Choose in panel');
    expect(host.openPanel).toHaveBeenCalled();
    const radios = el.querySelectorAll<HTMLInputElement>('input[type=radio]');
    await act(async () => radios[1].click());
    await click('Open link');
    expect(tabsApi.openUrl).toHaveBeenCalledWith(3, links[1], 'same-tab');
    await until(() => store.steps[0].data.link === links[1]);
  });

  it('keeps the preselected link in view even when it is further down', async () => {
    store = walkOf(stepOf('email', { messageId: 'm1' }));
    msgs.getMessage.mockResolvedValue(message);
    await render(emailResolved({ linkPattern: '/l/7' }));
    await until(() => el.querySelectorAll('input[type=radio]').length === 5);
    const checked = el.querySelector<HTMLInputElement>('input[type=radio]:checked');
    expect(checked?.parentElement?.getAttribute('title')).toBe(links[6]);
  });

  it("another view's email wait: says so, then shows the message it found", async () => {
    store = walkOf(stepOf('email', { emailWaitPending: { id: 'p', owner: 'panel', tabId: 3, windowId: 1, startedAt: Date.now(), until: Date.now() + 60_000 } }));
    msgs.getMessage.mockResolvedValue(message);
    await render(emailResolved());
    await flush();
    expect(el.textContent).toContain('Waiting for the email in the side panel');
    expect(btn('Wait for message')).toBeUndefined();
    expect(msgs.waitForMessagePath).not.toHaveBeenCalled();
    await act(async () => setOuter!(merge({ emailWaitPending: null, messageId: 'm1', subject: 'Welcome' })));
    await until(() => el.textContent!.includes('3 more links'));
    expect(btn('Wait again')).toBeTruthy();
  });

  it('the panel shows every link', async () => {
    store = walkOf(stepOf('email', { messageId: 'm1' }));
    msgs.getMessage.mockResolvedValue(message);
    await render(emailResolved(), { ...host, surface: 'panel', compact: false, openPanel: undefined });
    await until(() => el.querySelectorAll('input[type=radio]').length === 8);
    expect(el.textContent).not.toContain('more links');
  });
});

describe('copy button (fallback chain)', () => {
  const renderCopy = () => act(async () => root.render(createElement(CopyButton, { text: 'secret-1', what: 'password' })));
  it('the async clipboard first', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderCopy();
    await click('Copy the password');
    await flush();
    expect(writeText).toHaveBeenCalledWith('secret-1');
    expect(el.textContent).toBe('copied');
  });
  it('then execCommand, then the selected text with "Select the text and copy it"', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('blocked'))) }, configurable: true });
    const exec = vi.fn(() => false);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    await renderCopy();
    await click('Copy the password');
    await flush();
    expect(exec).toHaveBeenCalledWith('copy');
    const input = el.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('secret-1');
    expect(input.readOnly).toBe(true);
    expect(el.textContent).toContain('Select the text and copy it');
    exec.mockReturnValue(true);
    await click('done');
    await click('Copy the password');
    await flush();
    expect(el.textContent).toBe('copied');
  });
});

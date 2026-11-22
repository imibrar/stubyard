// Security hardening of the on-page widget (Fable review, phase 3; docs/design/floating-widget.md "Security
// hardening"): the host is a plain div (no custom element, so no attachInternals way into the closed shadow root), the
// page cannot restyle it (opacity, transform, inert, …), synthetic page events do not move or open it, every frame gets
// a fresh token (a dialog move without moveBefore, bfcache, a frame the page navigated away), the frame's click gate
// (IntersectionObserver v2), widget.html's boot check, and the frame link's reconnect count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptWidgetPort, mountedWidget, mountWidget, unmountWidget, type HostDeps, type HostPort } from '../src/content/widget';
import { WIDGET_HOST_ATTR, WIDGET_PORT, type HostToWidget } from '../src/shared/protocol';
import { shouldBoot } from '../src/widget/boot';
import { installClickGate, RECHECK_MS, VISIBLE_MIN_MS, VisibilityGate } from '../src/widget/visibility';

const memoryStorage = () => {
  const data: Record<string, unknown> = {};
  return { get: async (k: string) => (k in data ? { [k]: data[k] } : {}), set: async (items: Record<string, unknown>) => void Object.assign(data, items) };
};
const fakePort = () => {
  const msgs: ((m: unknown) => void)[] = [];
  const discs: (() => void)[] = [];
  return {
    name: WIDGET_PORT,
    sender: { url: 'chrome-extension://ext/widget.html#token=t1' },
    posted: [] as HostToWidget[],
    disconnected: false,
    postMessage(m: HostToWidget) {
      this.posted.push(m);
    },
    disconnect() {
      this.disconnected = true;
      discs.forEach((d) => d());
    },
    onMessage: { addListener: (l: (m: unknown) => void) => void msgs.push(l) },
    onDisconnect: { addListener: (l: () => void) => void discs.push(l) },
    send: (m: unknown) => msgs.forEach((l) => l(m)),
    drop: () => discs.forEach((d) => d()), // the other side went away
  };
};

let mint = 0;
let deps: HostDeps;
const flush = () => new Promise((r) => setTimeout(r, 0));
const src = () => mountedWidget()!.frameElement.getAttribute('src');

beforeEach(() => {
  document.body.innerHTML = '<h1>App</h1>';
  mint = 0;
  deps = { getURL: (p) => `chrome-extension://ext/${p}`, storage: memoryStorage(), mintToken: async () => `t${++mint}`, acceptEvent: () => true };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
});
afterEach(() => {
  vi.useRealTimers();
  unmountWidget();
  document.documentElement.querySelectorAll(`[${WIDGET_HOST_ATTR}]`).forEach((e) => e.remove());
});

describe('the host element (review item 2)', () => {
  it('is a plain div, never a custom element a page could define and upgrade', async () => {
    // A page defines the old tag name and grabs ElementInternals in its constructor (the reviewer's repro).
    let upgraded = 0;
    if (!customElements.get('stubyard-widget')) customElements.define('stubyard-widget', class extends HTMLElement { constructor() { super(); upgraded++; } });
    await mountWidget(deps);
    const host = mountedWidget()!.host;
    expect(host.tagName).toBe('DIV');
    expect(host.hasAttribute(WIDGET_HOST_ATTR)).toBe(true);
    expect(upgraded).toBe(0);
    expect(host.shadowRoot).toBeNull();
    // attachInternals is for custom elements only: on a div it throws (Chrome: NotSupportedError).
    const ai = (host as HTMLElement & { attachInternals?: () => unknown }).attachInternals;
    if (typeof ai === 'function') expect(() => ai.call(host)).toThrow();
  });
});

describe('the page cannot restyle the host (review item 1)', () => {
  it('puts its style back after opacity / transform / clip-path with !important, and drops inert, hidden, class', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const before = w.host.getAttribute('style');
    w.host.style.setProperty('opacity', '0', 'important');
    w.host.style.setProperty('transform', 'translate(-800px, -400px)', 'important');
    w.host.setAttribute('inert', '');
    w.host.setAttribute('hidden', '');
    w.host.className = 'x';
    await flush();
    expect(w.host.getAttribute('style')).toBe(before);
    expect(w.host.style.getPropertyValue('opacity')).toBe('');
    expect(w.host.hasAttribute('inert') || w.host.hasAttribute('hidden') || w.host.hasAttribute('class')).toBe(false);
    expect(w.styleResets).toBeGreaterThan(0);
    w.host.setAttribute('style', 'opacity: 0.01 !important');
    await flush();
    expect(w.host.getAttribute('style')).toBe(before);
  });

  it('keeps its own states through it: hidden on this tab, hidden for a screenshot', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    w.onWidgetMessage({ t: 'hide' });
    w.host.style.removeProperty('display');
    await flush();
    expect(w.host.style.getPropertyValue('display')).toBe('none');
    await mountWidget(deps); // shown again
    expect(w.host.style.getPropertyValue('display')).toBe('block');
    w.setSuspended(true);
    w.host.style.setProperty('visibility', 'visible', 'important');
    await flush();
    expect(w.host.style.getPropertyValue('visibility')).toBe('hidden');
    w.setSuspended(false);
    expect(w.host.style.getPropertyValue('visibility')).toBe('');
  });
});

describe('only real input moves or opens it (isTrusted)', () => {
  it('ignores synthetic clicks, keys and pointer events by default', async () => {
    const { acceptEvent: _drop, ...trusting } = deps;
    await mountWidget(trusting);
    const w = mountedWidget()!;
    w.setCollapsed(true);
    const pill = w.shadow.querySelector('button')!;
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(w.isCollapsed).toBe(true);
    w.setCollapsed(false);
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(w.isCollapsed).toBe(false);
    const box = w.cardBox;
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: box.left + 5, clientY: box.top + 5, pointerId: 1, button: 0 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10, pointerId: 1 }));
    expect(w.cardBox).toEqual(box);
  });
});

describe('a fresh single-use token for every frame (review item 2)', () => {
  it('a remount keeps the frame; a frame without a token (the worker said no) is retried on the next mount', async () => {
    let give = false;
    await mountWidget({ ...deps, mintToken: async () => (give ? `t${++mint}` : null) });
    const w = mountedWidget()!;
    expect(src()).toBeNull();
    give = true;
    await mountWidget({ ...deps, mintToken: async () => `t${++mint}` });
    await flush();
    expect(w.frameLoads).toBe(2);
  });

  it('two mounts at once (tab update events come in pairs) mint one token, so the frame’s hello is not refused', async () => {
    await Promise.all([mountWidget(deps), mountWidget(deps), mountWidget(deps)]);
    expect(mint).toBe(1);
    expect(src()).toContain('token=t1');
    expect(document.querySelectorAll('[data-stubyard-widget]').length).toBe(1);
  });

  it('an unmount while a mount still waits for its token wins', async () => {
    const m = mountWidget(deps);
    unmountWidget();
    expect(await m).toEqual({ ok: true, mounted: false });
    expect(mountedWidget()).toBeNull();
    expect(document.querySelector('[data-stubyard-widget]')).toBeNull();
  });

  it('a dialog move without moveBefore reloads the frame with a new token, and the old token is refused', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const d = document.createElement('dialog');
    document.body.append(d);
    const real = d.matches.bind(d);
    (d as unknown as { matches: (s: string) => boolean }).matches = (s: string) => (s === ':modal' ? d.hasAttribute('open') : real(s));
    d.setAttribute('open', '');
    await flush();
    await flush();
    expect(w.host.parentElement).toBe(d);
    expect(src()).toContain('token=t2');
    const old = fakePort();
    acceptWidgetPort(old as unknown as HostPort, 'chrome-extension://ext/');
    old.send({ t: 'ready', token: 't1' });
    expect(old.disconnected).toBe(true);
    const fresh = fakePort();
    acceptWidgetPort(fresh as unknown as HostPort, 'chrome-extension://ext/');
    fresh.send({ t: 'ready', token: 't2' });
    expect(fresh.disconnected).toBe(false);
  });

  it('a frame the page navigated away (its port dropped and it did not come back) is replaced', async () => {
    await mountWidget({ ...deps, alive: () => true });
    const w = mountedWidget()!;
    const port = fakePort();
    acceptWidgetPort(port as unknown as HostPort, 'chrome-extension://ext/');
    port.send({ t: 'ready', token: 't1' });
    vi.useFakeTimers();
    port.drop();
    vi.advanceTimersByTime(1000);
    expect(w.frameLoads).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(w.frameLoads).toBe(2);
    vi.useRealTimers();
    await flush();
    expect(src()).toContain('token=t2');
  });

  it('a port that reconnects in time keeps the frame', async () => {
    await mountWidget({ ...deps, alive: () => true });
    const w = mountedWidget()!;
    const a = fakePort();
    acceptWidgetPort(a as unknown as HostPort, 'chrome-extension://ext/');
    a.send({ t: 'ready', token: 't1' });
    vi.useFakeTimers();
    a.drop();
    const b = fakePort();
    acceptWidgetPort(b as unknown as HostPort, 'chrome-extension://ext/');
    b.send({ t: 'ready', token: 't1' });
    vi.advanceTimersByTime(5000);
    expect(w.frameLoads).toBe(1);
  });
});

describe('the frame’s click gate (IntersectionObserver v2, review item 1)', () => {
  it('VisibilityGate: allows only after VISIBLE_MIN_MS of being visible; without v2 data it never gates', () => {
    let now = 1000;
    const g = new VisibilityGate(() => now);
    expect(g.allows()).toBe(true); // no v2 entry yet
    g.update(undefined);
    expect(g.allows()).toBe(true);
    g.update(false);
    expect(g.allows()).toBe(false);
    g.update(true);
    now += VISIBLE_MIN_MS - 1;
    expect(g.allows()).toBe(false);
    now += 1;
    expect(g.allows()).toBe(true);
    g.update(true); // still visible: the clock keeps running
    expect(g.allows()).toBe(true);
    g.update(false);
    g.update(true);
    expect(g.allows()).toBe(false);
  });

  type Cb = (e: { isVisible?: boolean; isIntersecting: boolean }[]) => void;
  const fakeIO = () => {
    const made: { cb: Cb; opts: Record<string, unknown>; observed: Element[] }[] = [];
    class IO {
      observed: Element[] = [];
      constructor(public cb: Cb, public opts: Record<string, unknown>) {
        made.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      disconnect() {}
    }
    return { IO, made };
  };

  it('blocks action clicks while hidden (and says so), lets them through once visible long enough', () => {
    document.body.innerHTML = '<button id="done">Done</button><a href="#x" id="lnk">link</a><p id="txt">text</p><input id="note">';
    let now = 0;
    const { IO, made } = fakeIO();
    let blocked = 0;
    const clicked: string[] = [];
    for (const id of ['done', 'lnk', 'txt', 'note']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id));
    const g = installClickGate(window, document.documentElement, () => blocked++, { IO, now: () => now });
    expect(made[0].opts).toMatchObject({ trackVisibility: true, delay: 100 });
    expect(made[0].observed[0]).toBe(document.documentElement);
    made[0].cb([{ isVisible: false, isIntersecting: true }]); // the page set opacity 0 on the host
    document.getElementById('done')!.click();
    document.getElementById('lnk')!.click();
    document.getElementById('txt')!.click();
    document.getElementById('note')!.click();
    expect(clicked).toEqual(['txt', 'note']);
    expect(blocked).toBe(2);
    made[0].cb([{ isVisible: true, isIntersecting: true }]);
    now += 100;
    document.getElementById('done')!.click(); // visible, but only for 100 ms (a quick reveal right under the cursor)
    expect(clicked).toEqual(['txt', 'note']);
    now += VISIBLE_MIN_MS;
    document.getElementById('done')!.click();
    expect(clicked).toEqual(['txt', 'note', 'done']);
    g.dispose();
  });

  it('while it believes the frame hidden, a fresh observer asks again (Chrome can miss the change back)', () => {
    vi.useFakeTimers();
    const { IO, made } = fakeIO();
    const g = installClickGate(window, document.documentElement, () => {}, { IO, now: () => Date.now() });
    made[0].cb([{ isVisible: true, isIntersecting: true }]);
    vi.advanceTimersByTime(RECHECK_MS * 3);
    expect(made).toHaveLength(1); // visible: nothing to ask
    made[0].cb([{ isVisible: false, isIntersecting: true }]);
    vi.advanceTimersByTime(RECHECK_MS);
    expect(made).toHaveLength(2);
    expect(made[1].observed[0]).toBe(document.documentElement);
    made[1].cb([{ isVisible: true, isIntersecting: true }]);
    vi.advanceTimersByTime(RECHECK_MS * 2);
    expect(made).toHaveLength(2);
    expect(g.gate.allows()).toBe(true);
    g.dispose();
  });

  it('an engine without v2 (no isVisible) or without IntersectionObserver is not gated', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    const { IO, made } = fakeIO();
    let n = 0;
    document.getElementById('b')!.addEventListener('click', () => n++);
    const g1 = installClickGate(window, document.documentElement, () => {}, { IO });
    made[0].cb([{ isIntersecting: true }]);
    document.getElementById('b')!.click();
    g1.dispose();
    const g2 = installClickGate(window, document.documentElement, () => {}, { IO: null });
    document.getElementById('b')!.click();
    g2.dispose();
    expect(n).toBe(2);
  });
});

describe('widget.html boot (review item 5)', () => {
  it('loads the app only when framed with a well-formed token fragment', () => {
    const t = crypto.randomUUID();
    expect(shouldBoot(`#token=${t}`, true)).toBe(true);
    expect(shouldBoot(`#token=${t}`, false)).toBe(false); // opened as a page
    expect(shouldBoot('', true)).toBe(false);
    expect(shouldBoot('#token=short', true)).toBe(false);
    expect(shouldBoot('#token=<img src=x>-aaaaaaaaaaaaaaaa', true)).toBe(false);
  });
});

describe('the frame’s link to the host (review item 7)', () => {
  it('the reconnect count starts again after a port is accepted, so it never runs out in a long session', async () => {
    vi.resetModules();
    const ports: ReturnType<typeof fakePort>[] = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { lastError: undefined },
      tabs: {
        connect: () => {
          const p = fakePort();
          ports.push(p);
          return p;
        },
      },
    };
    const { connectHost, MAX_RECONNECTS } = await import('../src/widget/link');
    vi.useFakeTimers();
    const got: unknown[] = [];
    const link = connectHost(3, 'tok', (m) => got.push(m));
    for (let i = 0; i < MAX_RECONNECTS * 3; i++) {
      const p = ports.at(-1)!;
      p.send({ t: 'expanded', expanded: true }); // the host accepted it
      p.drop();
      vi.advanceTimersByTime(800);
    }
    expect(ports.length).toBe(MAX_RECONNECTS * 3 + 1);
    // Without an answer it gives up after MAX_RECONNECTS tries in a row (the last drop above was the first of them).
    for (let i = 0; i < MAX_RECONNECTS + 3; i++) {
      ports.at(-1)!.drop();
      vi.advanceTimersByTime(800);
    }
    expect(ports.length).toBe(MAX_RECONNECTS * 3 + MAX_RECONNECTS);
    link.close();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });
});

// The page host of the on-page widget (src/content/widget.ts) in happy-dom: one host on <html> with a closed shadow
// root and the extension iframe; collapse hides the frame (it is not removed); the Port obeys only its own token;
// drag math with synthetic pointer events; the place is saved on drag end only; unmount leaves nothing; the host is
// invisible to the page scan and page text; screenshots suspend it. Real focus, pointer capture and the top layer are
// checked in headless Chrome (packages/extension/test/widget-spike/widget1a.py), not here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPage } from '../src/content/capture';
import { scanPage } from '../src/content/scan';
import { acceptWidgetPort, mountedWidget, mountWidget, readSaved, resumeWidget, suspendWidget, unmountWidget, type HostDeps, type HostPort } from '../src/content/widget';
import { WIDGET_HOST_ATTR, WIDGET_PORT, type HostToWidget } from '../src/shared/protocol';
import { PLACEMENT_KEY } from '../src/shared/widget';

const memoryStorage = (init: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = structuredClone(init);
  const sets: Record<string, unknown>[] = [];
  return {
    data,
    sets,
    get: async (k: string) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async (items: Record<string, unknown>) => {
      sets.push(structuredClone(items));
      Object.assign(data, structuredClone(items));
    },
  };
};

const fakePort = (url = 'chrome-extension://ext/widget.html#token=t1') => {
  const msgs: ((m: unknown) => void)[] = [];
  const discs: (() => void)[] = [];
  const port = {
    name: WIDGET_PORT,
    sender: { url },
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
  };
  return port as typeof port & HostPort;
};

let storage: ReturnType<typeof memoryStorage>;
let deps: HostDeps;
const flush = () => new Promise((r) => setTimeout(r, 0));
const hostEl = () => document.documentElement.querySelector<HTMLElement>(`[${WIDGET_HOST_ATTR}]`);
const px = (v: string) => Number.parseFloat(v);

beforeEach(() => {
  document.body.innerHTML = '<h1>App page</h1><form><label>Name <input name="name"></label></form>';
  document.documentElement.removeAttribute('dir');
  storage = memoryStorage();
  deps = { getURL: (p) => `chrome-extension://ext/${p}`, storage };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
});
afterEach(() => {
  unmountWidget();
  document.documentElement.querySelectorAll(`[${WIDGET_HOST_ATTR}]`).forEach((e) => e.remove());
});

describe('mount / unmount', () => {
  it('adds one host on <html> with a closed shadow root and the extension frame', async () => {
    expect(await mountWidget('t1', deps)).toEqual({ ok: true, mounted: true });
    const host = hostEl()!;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.shadowRoot).toBeNull(); // closed: the page cannot reach in
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const frame = mountedWidget()!.frameElement;
    expect(frame.getAttribute('src')).toBe('chrome-extension://ext/widget.html#token=t1');
    expect(frame.getAttribute('allow')).toBe('clipboard-write');
    expect(host.style.getPropertyValue('position')).toBe('fixed');
    expect(px(host.style.getPropertyValue('width'))).toBe(0);
  });

  it('is idempotent: mounting again keeps the host and the frame', async () => {
    await mountWidget('t1', deps);
    const frame = mountedWidget()!.frameElement;
    await mountWidget('t1', deps);
    expect(document.documentElement.querySelectorAll(`[${WIDGET_HOST_ATTR}]`)).toHaveLength(1);
    expect(mountedWidget()!.frameElement).toBe(frame);
  });

  it('puts a host the page removed back, and a new token gives a fresh frame', async () => {
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    w.host.remove();
    await mountWidget('t1', deps);
    expect(w.host.isConnected).toBe(true);
    const old = w.frameElement;
    await mountWidget('t2', deps);
    expect(w.frameElement).not.toBe(old);
    expect(w.frameElement.getAttribute('src')).toContain('token=t2');
  });

  it('replaces a stray host of an older script; unmount leaves no node', async () => {
    const stray = document.createElement('div');
    stray.setAttribute(WIDGET_HOST_ATTR, '1');
    document.documentElement.append(stray);
    await mountWidget('t1', deps);
    expect(stray.isConnected).toBe(false);
    unmountWidget();
    expect(hostEl()).toBeNull();
    expect(mountedWidget()).toBeNull();
  });

  it('does not mount in a frame', async () => {
    const win = { top: {}, location: { origin: 'http://x' } } as unknown as Window;
    const doc = { defaultView: win } as unknown as Document;
    expect(await mountWidget('t1', deps, doc)).toEqual({ ok: true, mounted: false });
  });

  it('is invisible to the page scan, page text and the form fill', async () => {
    await mountWidget('t1', deps);
    expect(assertPage({ textPresent: 'stubyard' }).ok).toBe(false);
    expect(scanPage().fields.map((f) => f.key)).toEqual(['name']);
  });

  it('screenshots hide it and show it again', async () => {
    await mountWidget('t1', deps);
    expect((await suspendWidget()).hidden).toBe(1);
    expect(hostEl()!.style.getPropertyValue('visibility')).toBe('hidden');
    resumeWidget();
    expect(hostEl()!.style.getPropertyValue('visibility')).toBe('');
  });
});

describe('placement', () => {
  it('starts at the bottom-right corner, bottom-left on RTL pages', async () => {
    await mountWidget('t1', deps);
    expect(mountedWidget()!.currentPlacement).toEqual({ corner: 'bottom-right', x: 16, y: 16 });
    expect(mountedWidget()!.cardBox.left).toBe(1280 - 340 - 16);
    unmountWidget();
    document.documentElement.setAttribute('dir', 'rtl');
    await mountWidget('t1', deps);
    expect(mountedWidget()!.currentPlacement.corner).toBe('bottom-left');
    expect(mountedWidget()!.cardBox.left).toBe(16);
  });

  it('uses the place saved for this origin', async () => {
    storage.data[PLACEMENT_KEY] = { [location.origin]: { corner: 'top-left', x: 40, y: 50, collapsed: true }, 'http://other.test': { corner: 'top-right', x: 1, y: 1 } };
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    expect(w.currentPlacement).toEqual({ corner: 'top-left', x: 40, y: 50 });
    expect(w.isCollapsed).toBe(true);
    expect(readSaved(storage.data[PLACEMENT_KEY], 'http://nowhere.test')).toEqual({ placement: null, collapsed: false });
  });

  it('drag moves the card, snaps to the nearest corner on release and saves once', async () => {
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    const start = w.cardBox;
    const ev = (type: string, x: number, y: number) => handle.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true }));
    ev('pointerdown', start.left + 10, start.top + 5);
    ev('pointermove', 110, 65);
    ev('pointermove', 130, 85);
    expect(w.cardBox.left).toBe(120);
    expect(w.cardBox.top).toBe(80);
    await flush();
    expect(storage.sets).toHaveLength(0); // nothing saved while dragging
    ev('pointerup', 130, 85);
    await flush();
    expect(w.currentPlacement).toEqual({ corner: 'top-left', x: 120, y: 80 });
    expect(storage.sets).toHaveLength(1);
    expect((storage.data[PLACEMENT_KEY] as Record<string, unknown>)[location.origin]).toEqual({ corner: 'top-left', x: 120, y: 80, collapsed: false });
  });

  it('keeps the card inside on resize; double-click resets to the default corner', async () => {
    storage.data[PLACEMENT_KEY] = { [location.origin]: { corner: 'bottom-right', x: 600, y: 300 } };
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 700 });
    window.dispatchEvent(new Event('resize'));
    expect(w.cardBox.left).toBe(4);
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(w.currentPlacement).toEqual({ corner: 'bottom-right', x: 16, y: 16 });
  });

  it('arrow keys on the handle move it; Esc collapses', async () => {
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    const left = w.cardBox.left;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(w.cardBox.left).toBe(left - 16);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(w.isCollapsed).toBe(true);
  });

  it('a bottom sheet under 480 px: full width, dragged up and down only', async () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    expect(w.cardBox.left).toBe(4);
    expect(w.cardBox.width).toBe(382);
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    const b = w.cardBox;
    const ev = (type: string, x: number, y: number) => handle.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 2, button: 0 }));
    ev('pointerdown', 100, b.top + 5);
    ev('pointermove', 300, b.top - 195);
    expect(w.cardBox.left).toBe(4);
    ev('pointerup', 300, b.top - 195);
    expect(w.currentPlacement.sheetY).toBe(4 + 200);
  });
});

describe('collapse and the port', () => {
  it('collapse hides the card but keeps the frame loaded; the pill expands it', async () => {
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    const frame = w.frameElement;
    w.setCollapsed(true);
    const [card, pill] = Array.from(w.shadow.children) as HTMLElement[];
    expect(card.style.getPropertyValue('display')).toBe('none');
    expect(pill.style.getPropertyValue('display')).toBe('block');
    expect(frame.isConnected).toBe(true);
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    pill.click();
    expect(w.isCollapsed).toBe(false);
    expect(card.style.getPropertyValue('display')).toBe('flex');
  });

  it('obeys a port only after it sent this widget’s token', async () => {
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    const bad = fakePort();
    acceptWidgetPort(bad, 'chrome-extension://ext/');
    bad.send({ t: 'ready', token: 'guess' });
    expect(bad.disconnected).toBe(true);
    bad.send({ t: 'collapse' });
    expect(w.isCollapsed).toBe(false);

    const good = fakePort();
    acceptWidgetPort(good, 'chrome-extension://ext/');
    good.send({ t: 'ready', token: 't1' });
    expect(good.posted).toEqual([{ t: 'expanded', expanded: true }]);
    good.send({ t: 'size', height: 260 });
    expect(px(w.frameElement.style.getPropertyValue('height'))).toBe(260);
    good.send({ t: 'size', height: 5000 }); // capped at 60 % of the viewport
    expect(px(w.frameElement.style.getPropertyValue('height'))).toBe(480 - 18 - 2);
    good.send({ t: 'progress', finished: 2, total: 9, title: 'Open the form' });
    const pill = w.shadow.children[1] as HTMLElement;
    expect(pill.textContent).toBe('2/9');
    expect(pill.getAttribute('aria-label')).toMatch(/2 of 9 steps finished, current: Open the form/);
    good.send({ t: 'collapse' });
    expect(w.isCollapsed).toBe(true);
    expect(good.posted.at(-1)).toEqual({ t: 'expanded', expanded: false });
  });

  it('refuses ports from anything but the extension, and other port names', async () => {
    await mountWidget('t1', deps);
    const page = fakePort('https://evil.test/');
    expect(acceptWidgetPort(page, 'chrome-extension://ext/')).toBe(true);
    expect(page.disconnected).toBe(true);
    const other = { ...fakePort(), name: 'something-else' };
    expect(acceptWidgetPort(other, 'chrome-extension://ext/')).toBe(false);
  });

  it('hide takes it off the screen at once', async () => {
    await mountWidget('t1', deps);
    const port = fakePort();
    acceptWidgetPort(port, 'chrome-extension://ext/');
    port.send({ t: 'ready', token: 't1' });
    port.send({ t: 'hide' });
    expect(hostEl()!.style.getPropertyValue('display')).toBe('none');
  });

  it('a back/forward cache restore gives a fresh frame', async () => {
    await mountWidget('t1', deps);
    const w = mountedWidget()!;
    const old = w.frameElement;
    const e = new Event('pageshow') as Event & { persisted?: boolean };
    Object.defineProperty(e, 'persisted', { value: true });
    window.dispatchEvent(e);
    expect(w.frameElement).not.toBe(old);
    expect(old.isConnected).toBe(false);
    expect(w.frameElement.getAttribute('src')).toContain('token=t1');
  });

  it('nothing takes focus on mount', async () => {
    const input = document.querySelector('input')!;
    input.focus();
    await mountWidget('t1', deps);
    expect(document.activeElement).toBe(input);
    vi.restoreAllMocks();
  });
});

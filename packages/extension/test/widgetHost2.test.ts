// Phase 2 of the page host (src/content/widget.ts) in happy-dom: native modal <dialog> (the host moves in with
// moveBefore and back on close; without moveBefore the frame reloads once), the auto-nudge off a Submit button (never
// saved, off after a manual move), the live region, an orphaned host removing itself after an extension reload, and
// Settings "Reset position" reaching an open page. Real top layer, inertness and focus are checked in headless Chrome
// (packages/extension/test/widget-spike/widget2.py).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountedWidget, mountWidget, placementsChanged, unmountWidget, type HostDeps, type HostPort } from '../src/content/widget';
import { WIDGET_HOST_ATTR, WIDGET_PORT, type HostToWidget } from '../src/shared/protocol';
import { PLACEMENT_KEY } from '../src/shared/widget';

const memoryStorage = () => {
  const data: Record<string, unknown> = {};
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

const fakePort = () => {
  const msgs: ((m: unknown) => void)[] = [];
  const discs: (() => void)[] = [];
  return {
    name: WIDGET_PORT,
    sender: { url: 'chrome-extension://ext/widget.html#token=t1' },
    disconnected: false,
    postMessage(_m: HostToWidget) {},
    disconnect() {
      this.disconnected = true;
      discs.forEach((d) => d());
    },
    onMessage: { addListener: (l: (m: unknown) => void) => void msgs.push(l) },
    onDisconnect: { addListener: (l: () => void) => void discs.push(l) },
    send: (m: unknown) => msgs.forEach((l) => l(m)),
  };
};

let storage: ReturnType<typeof memoryStorage>;
let deps: HostDeps;
let mint = 0;
const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = '<h1>App page</h1>';
  storage = memoryStorage();
  mint = 0;
  deps = { getURL: (p) => `chrome-extension://ext/${p}`, storage, mintToken: async () => `t${++mint}`, acceptEvent: () => true };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
});
afterEach(() => {
  unmountWidget();
  document.documentElement.querySelectorAll(`[${WIDGET_HOST_ATTR}]`).forEach((e) => e.remove());
});

/** A <dialog> that reports :modal while it has the open attribute (happy-dom has no top layer). */
function modalDialog(withMoveBefore: boolean) {
  const d = document.createElement('dialog');
  document.body.append(d);
  const realMatches = d.matches.bind(d);
  (d as unknown as { matches: (sel: string) => boolean }).matches = (sel: string) => (sel === ':modal' ? d.hasAttribute('open') : realMatches(sel));
  const moves: Node[] = [];
  const mb = function (this: Element, node: Node, child: Node | null) {
    moves.push(node);
    this.insertBefore(node, child);
  };
  if (withMoveBefore) {
    (d as unknown as { moveBefore: typeof mb }).moveBefore = mb;
    (document.documentElement as unknown as { moveBefore: typeof mb }).moveBefore = mb;
  } else {
    delete (document.documentElement as unknown as { moveBefore?: unknown }).moveBefore;
  }
  return { d, moves };
}

describe('native modal <dialog>', () => {
  it('moves the host into an opened modal dialog with moveBefore (no frame reload) and back on close', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const { d, moves } = modalDialog(true);
    d.setAttribute('open', '');
    await flush();
    expect(w.host.parentElement).toBe(d);
    expect(w.dialog).toBe(d);
    expect(moves).toContain(w.host);
    expect(w.frameLoads).toBe(1);
    d.removeAttribute('open');
    await flush();
    expect(w.host.parentElement).toBe(document.documentElement);
    expect(w.frameLoads).toBe(1);
  });

  it('without moveBefore it still moves (the frame reloads once each way)', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const { d } = modalDialog(false);
    d.setAttribute('open', '');
    await flush();
    expect(w.host.parentElement).toBe(d);
    expect(w.frameLoads).toBe(2);
    d.removeAttribute('open');
    await flush();
    expect(w.host.parentElement).toBe(document.documentElement);
    expect(w.frameLoads).toBe(3);
  });

  it('a non-modal dialog (show()) and <details open> are ignored', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const d = document.createElement('dialog');
    document.body.append(d);
    d.setAttribute('open', ''); // matches(':modal') is false here
    const det = document.createElement('details');
    document.body.append(det);
    det.setAttribute('open', '');
    await flush();
    expect(w.host.parentElement).toBe(document.documentElement);
  });

  it('follows the topmost of two modal dialogs, and goes home when a dialog is removed while open', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const a = modalDialog(true).d;
    const b = modalDialog(true).d;
    a.setAttribute('open', '');
    await flush();
    b.setAttribute('open', '');
    await flush();
    expect(w.host.parentElement).toBe(b);
    b.removeAttribute('open');
    await flush();
    expect(w.host.parentElement).toBe(a);
    a.remove(); // the page throws the open dialog away (with the host in it)
    await flush();
    await flush();
    expect(w.host.isConnected).toBe(true);
    expect(w.host.parentElement).toBe(document.documentElement);
  });

  it('a dialog already open at mount gets the host at once', async () => {
    const { d } = modalDialog(true);
    d.setAttribute('open', '');
    await mountWidget(deps);
    expect(mountedWidget()!.host.parentElement).toBe(d);
  });
});

describe('auto-nudge off the page buttons', () => {
  const submitAt = (left: number, top: number) => {
    const b = document.createElement('button');
    b.type = 'submit';
    b.textContent = 'Save';
    document.body.append(b);
    b.getBoundingClientRect = () => ({ left, top, right: left + 100, bottom: top + 40, width: 100, height: 40, x: left, y: top, toJSON() {} }) as DOMRect;
    return b;
  };

  it('moves to another corner while a Submit button is under the card; the saved place does not change', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    submitAt(1150, 740);
    w.checkAvoid();
    expect(w.avoiding).toBe(true);
    expect(w.shownPlacement.corner).toBe('bottom-left');
    expect(w.currentPlacement.corner).toBe('bottom-right');
    expect(w.cardBox.left).toBeLessThan(640);
    await flush();
    expect(storage.sets).toHaveLength(0);
  });

  it('goes back when the button is gone; ignores buttons out of view or inside the widget', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const b = submitAt(1150, 740);
    w.checkAvoid();
    b.remove();
    submitAt(1150, 2000); // below the fold
    w.checkAvoid();
    expect(w.avoiding).toBe(false);
    expect(w.shownPlacement.corner).toBe('bottom-right');
  });

  it('the highlighted element counts too', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const div = document.createElement('div');
    div.setAttribute('data-stubyard-target', '1');
    document.body.append(div);
    div.getBoundingClientRect = () => ({ left: 1000, top: 700, right: 1100, bottom: 760, width: 100, height: 60, x: 1000, y: 700, toJSON() {} }) as DOMRect;
    expect(w.avoidRects()).toHaveLength(1);
    w.checkAvoid();
    expect(w.avoiding).toBe(true);
  });

  it('after the tester moves the card by hand, it stays where it was put', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    submitAt(1150, 740);
    w.checkAvoid();
    expect(w.avoiding).toBe(false);
    await mountWidget(deps); // an SPA route change mounts again: the check is back on
    w.checkAvoid();
    expect(w.avoiding).toBe(true);
  });
});

describe('announcements, orphans, Settings reset', () => {
  it('speaks announce messages through a polite live region in the shadow root', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const live = w.shadow.querySelector('[aria-live="polite"]')!;
    expect(live.getAttribute('role')).toBe('status');
    w.onWidgetMessage({ t: 'announce', kind: 'step' });
    await sleep(80);
    expect(w.liveText).toBe('stubyard step updated');
  });

  it('only fixed generic lines reach the page: free text and unknown kinds are not spoken (review item 2)', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    w.onWidgetMessage({ t: 'announce', kind: 'wait-2fa' });
    await sleep(80);
    expect(w.liveText).toBe('stubyard is waiting for the 2FA code');
    w.onWidgetMessage({ t: 'announce', kind: 'Step 2 of 5: Secret title' } as never);
    w.onWidgetMessage({ t: 'announce', text: 'Step 2 of 5: Secret title' } as never);
    w.onWidgetMessage({ t: 'announce', kind: 'toString' } as never);
    w.onWidgetMessage({ t: 'progress', finished: 1, total: 5, title: 'Secret title' } as never);
    await sleep(80);
    expect(w.liveText).toBe('stubyard is waiting for the 2FA code');
    const html = (w.shadow as unknown as { innerHTML: string }).innerHTML;
    expect(html).not.toContain('Secret title');
  });

  it('the pill shows a progress ring and keeps its accessible name', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    w.onWidgetMessage({ t: 'progress', finished: 2, total: 8 });
    const pill = w.shadow.querySelector('button')!;
    expect(pill.style.getPropertyValue('background')).toContain('25%');
    expect(pill.getAttribute('aria-label')).toBe('Open the stubyard step widget: 2 of 8 steps finished');
    expect(pill.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+W');
  });

  it('a host whose extension was reloaded removes itself when its frame port drops', async () => {
    let alive = true;
    await mountWidget({ ...deps, alive: () => alive });
    const w = mountedWidget()!;
    const port = fakePort();
    w.attachPort(port as unknown as HostPort);
    port.send({ t: 'ready', token: 't1' });
    alive = false;
    port.disconnect();
    expect(w.host.isConnected).toBe(false);
    expect(mountedWidget()).toBeNull();
  });

  it('a remount replaces a frame that never connected (its hello was refused), but not a loading one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await mountWidget(deps);
      const w = mountedWidget()!;
      await mountWidget(deps);
      expect(w.frameLoads).toBe(1);
      vi.setSystemTime(Date.now() + 5000);
      await mountWidget(deps);
      expect(w.frameLoads).toBe(2);
      await flush();
      // The old frame's token is dead (single-use, rotated): only the new frame's one is trusted.
      const stale = fakePort();
      w.attachPort(stale as unknown as HostPort);
      stale.send({ t: 'ready', token: 't1' });
      expect(stale.disconnected).toBe(true);
      const port = fakePort();
      w.attachPort(port as unknown as HostPort);
      port.send({ t: 'ready', token: 't2' });
      vi.setSystemTime(Date.now() + 5000);
      await mountWidget(deps);
      expect(w.frameLoads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a port drop with a live runtime keeps the host (the frame reconnects)', async () => {
    await mountWidget({ ...deps, alive: () => true });
    const w = mountedWidget()!;
    const port = fakePort();
    w.attachPort(port as unknown as HostPort);
    port.send({ t: 'ready', token: 't1' });
    port.disconnect();
    expect(w.host.isConnected).toBe(true);
  });

  it('Settings "Reset position" moves an open card back to its default corner', async () => {
    storage.data[PLACEMENT_KEY] = { [location.origin]: { corner: 'top-left', x: 40, y: 40 } };
    await mountWidget(deps);
    const w = mountedWidget()!;
    expect(w.currentPlacement.corner).toBe('top-left');
    placementsChanged({ 'https://other.test': { corner: 'top-left', x: 1, y: 1 } });
    expect(w.currentPlacement).toEqual({ corner: 'bottom-right', x: 16, y: 16 });
  });

  it('drag moves are written at most once per animation frame', async () => {
    await mountWidget(deps);
    const w = mountedWidget()!;
    const handle = w.shadow.querySelector<HTMLElement>('[role=button]')!;
    const card = handle.parentElement!;
    const spy = vi.spyOn(card.style, 'setProperty');
    const ev = (type: string, x: number, y: number) => handle.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true }));
    const b = w.cardBox;
    ev('pointerdown', b.left + 10, b.top + 5);
    spy.mockClear();
    for (let i = 0; i < 20; i++) ev('pointermove', 300 + i, 300 + i);
    const writes = spy.mock.calls.filter((c) => c[0] === 'left').length;
    expect(writes).toBe(1);
    ev('pointerup', 319, 319);
    expect(w.cardBox.left).toBe(319 - 10);
  });
});

// The content script's side of the on-page widget (docs/design/floating-widget.md): the page host.
//  - mount/unmount: one host element on <html> (outside <body>), marked with data-stubyard-widget, with a CLOSED shadow
//    root holding the pill, the drag handle and an <iframe src="chrome-extension://…/widget.html">. The iframe is the
//    widget UI (an extension page: hub calls, credentials and step controls live there, never in the page DOM).
//  - collapse HIDES the card (the frame stays loaded, so a running wait keeps running); only unmount removes it.
//  - drag on the handle (outside the iframe, pointer capture) with corner snap; the place is saved per origin under its
//    own storage key on drag end only; double-click resets it. Under 480 px it is a bottom sheet (vertical drag only).
//  - Esc (in the widget) collapses; nothing here ever handles keys of the page, and nothing takes focus on its own.
//  - suspend/resume: captureClean() hides any widget host for a screenshot and shows it again afterwards.
//  - removeWidgetHosts: a replaced (orphaned) content script's widget is taken off the page.
// All styling goes through element.style (CSSOM), which a page's CSP style-src does not block; no <style> elements.
import {
  type HostToWidget,
  WIDGET_AUTO_RESUME_MS,
  WIDGET_HOST_ATTR,
  WIDGET_PORT,
  type WidgetMountResult,
  type WidgetResumeResult,
  type WidgetSuspendResult,
  type WidgetToHost,
} from '../shared/protocol';
import {
  cardLayout,
  clampPoint,
  defaultPlacement,
  isSheet,
  nudge,
  parsePlacement,
  pillLayout,
  PILL_SIZE,
  PLACEMENT_KEY,
  sheetYFromTop,
  snapToCorner,
  widgetHash,
  type WidgetPlacement,
} from '../shared/widget';

export function widgetHosts(doc: Document = document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(`[${WIDGET_HOST_ATTR}]`));
}

/** Remove every widget host (for example one left behind by a content script from before an extension reload). */
export function removeWidgetHosts(doc: Document = document): number {
  const hosts = widgetHosts(doc);
  for (const h of hosts) h.remove();
  return hosts.length;
}

/** Two animation frames, so the hidden widget is off the next painted frame; a timeout stands in when frames do not come. */
export function nextFrames(n = 2, win: Window = window, maxMs = 150): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const done = setTimeout(resolve, maxMs);
    const tick = () => {
      left -= 1;
      if (left <= 0) {
        clearTimeout(done);
        resolve();
      } else win.requestAnimationFrame(tick);
    };
    if (typeof win.requestAnimationFrame !== 'function') return;
    win.requestAnimationFrame(tick);
  });
}

let autoResume: ReturnType<typeof setTimeout> | null = null;

export async function suspendWidget(doc: Document = document): Promise<WidgetSuspendResult> {
  const hosts = widgetHosts(doc);
  if (!hosts.length) return { ok: true, hidden: 0 };
  for (const h of hosts) h.style.setProperty('visibility', 'hidden', 'important');
  if (autoResume) clearTimeout(autoResume);
  autoResume = setTimeout(() => resumeWidget(doc), WIDGET_AUTO_RESUME_MS);
  await nextFrames(2, doc.defaultView ?? window);
  return { ok: true, hidden: hosts.length };
}

export function resumeWidget(doc: Document = document): WidgetResumeResult {
  if (autoResume) clearTimeout(autoResume);
  autoResume = null;
  for (const h of widgetHosts(doc)) h.style.removeProperty('visibility');
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// The host

/** A Port as the content script sees it (tests pass a fake). */
export interface HostPort {
  name: string;
  sender?: { url?: string; frameId?: number };
  postMessage(m: HostToWidget): void;
  disconnect(): void;
  onMessage: { addListener(l: (m: unknown) => void): void };
  onDisconnect: { addListener(l: () => void): void };
}

export interface HostDeps {
  /** chrome.runtime.getURL */
  getURL: (path: string) => string;
  /** chrome.storage.local (placement per origin); errors are ignored. */
  storage?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
}

interface Saved {
  placement: WidgetPlacement | null;
  collapsed: boolean;
}

const HANDLE_H = 18;
const INITIAL_FRAME_H = 132;

const THEME = {
  light: { card: '#ffffff', line: '#d9dbe0', grip: '#8a8f99', accent: '#0d9488', accentText: '#ffffff', shadow: '0 6px 24px rgba(0,0,0,.18)' },
  dark: { card: '#212226', line: '#3a3c43', grip: '#9a9ea8', accent: '#2dd4bf', accentText: '#0b1513', shadow: '0 6px 24px rgba(0,0,0,.5)' },
};

function css(el: HTMLElement, props: Record<string, string>): void {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
}

/** The direction of the page (for the default corner only: the widget's own chrome stays LTR). */
export function pageIsRtl(doc: Document): boolean {
  const attr = (doc.documentElement.getAttribute('dir') || doc.body?.getAttribute('dir') || '').toLowerCase();
  if (attr === 'rtl') return true;
  if (attr === 'ltr') return false;
  try {
    return (doc.defaultView?.getComputedStyle(doc.documentElement).direction ?? '') === 'rtl';
  } catch {
    return false;
  }
}

export class WidgetHost {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly card: HTMLDivElement;
  private readonly handle: HTMLDivElement;
  private frame: HTMLIFrameElement;
  private readonly pill: HTMLButtonElement;
  private placement: WidgetPlacement;
  private collapsed = false;
  private height = INITIAL_FRAME_H;
  private port: HostPort | null = null;
  private drag: { dx: number; dy: number; id: number } | null = null;
  /** The card's box as last laid out or dragged (kept here, not measured, so the math does not depend on layout). */
  private box = { left: 0, top: 0, width: 0, height: 0 };
  private readonly cleanups: (() => void)[] = [];
  private readonly origin: string;

  constructor(
    private readonly doc: Document,
    private token: string,
    private readonly deps: HostDeps,
    saved: Saved = { placement: null, collapsed: false },
  ) {
    const win = doc.defaultView!;
    this.origin = win.location.origin;
    this.placement = saved.placement ?? defaultPlacement(pageIsRtl(doc));
    this.collapsed = saved.collapsed;

    this.host = doc.createElement('stubyard-widget');
    this.host.setAttribute(WIDGET_HOST_ATTR, '1');
    // A zero-size fixed box: it never covers the page; its children are fixed to the viewport.
    css(this.host, { all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0', overflow: 'visible', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0' });
    this.root = this.host.attachShadow({ mode: 'closed' });

    this.card = doc.createElement('div');
    this.card.setAttribute('role', 'region');
    this.card.setAttribute('aria-label', 'stubyard step widget');
    css(this.card, { position: 'fixed', display: 'flex', 'flex-direction': 'column', 'box-sizing': 'border-box', 'border-radius': '10px', overflow: 'hidden', margin: '0', padding: '0' });

    this.handle = doc.createElement('div');
    this.handle.tabIndex = 0;
    this.handle.setAttribute('role', 'button');
    this.handle.setAttribute('aria-label', 'Move the stubyard widget (drag, or arrow keys; double-click to reset; Esc collapses)');
    this.handle.title = 'Drag to move · double-click to reset';
    css(this.handle, { height: `${HANDLE_H}px`, flex: 'none', cursor: 'grab', 'touch-action': 'none', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'user-select': 'none', outline: 'none' });
    const grip = doc.createElement('span');
    css(grip, { width: '36px', height: '4px', 'border-radius': '2px', display: 'block' });
    this.handle.append(grip);

    this.frame = this.makeFrame();

    this.pill = doc.createElement('button');
    this.pill.type = 'button';
    this.pill.setAttribute('aria-expanded', 'false');
    this.pill.setAttribute('aria-label', 'Open the stubyard step widget');
    this.pill.title = 'stubyard: open the step widget';
    this.pill.textContent = '▸';
    css(this.pill, {
      position: 'fixed', width: `${PILL_SIZE}px`, height: `${PILL_SIZE}px`, 'border-radius': '50%', margin: '0', padding: '0', cursor: 'pointer',
      font: '600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif', 'box-sizing': 'border-box', 'text-align': 'center', 'letter-spacing': '0',
    });

    this.card.append(this.handle, this.frame);
    this.root.append(this.card, this.pill);
    this.applyTheme();

    this.listen(this.pill, 'click', () => this.setCollapsed(false));
    this.listen(this.handle, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen(this.handle, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen(this.handle, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen(this.handle, 'pointercancel', (e) => this.onUp(e as PointerEvent));
    this.listen(this.handle, 'dblclick', () => this.reset());
    this.listen(this.handle, 'keydown', (e) => this.onHandleKey(e as KeyboardEvent));
    this.listen(win, 'resize', () => this.layout());
    // Back/forward cache: the frame's port and stream are dead after a restore; a fresh frame re-attaches.
    this.listen(win, 'pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) this.reloadFrame();
    });
    const mq = win.matchMedia?.('(prefers-color-scheme: dark)');
    if (mq?.addEventListener) {
      const onScheme = () => this.applyTheme();
      mq.addEventListener('change', onScheme);
      this.cleanups.push(() => mq.removeEventListener('change', onScheme));
    }
    doc.documentElement.append(this.host);
    this.layout();
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void) {
    t.addEventListener(type, fn);
    this.cleanups.push(() => t.removeEventListener(type, fn));
  }

  private makeFrame(): HTMLIFrameElement {
    const f = this.doc.createElement('iframe');
    f.setAttribute('allow', 'clipboard-write');
    f.setAttribute('title', 'stubyard step widget');
    f.src = this.deps.getURL('widget.html') + widgetHash(this.token);
    css(f, { border: '0', width: '100%', height: `${this.height}px`, display: 'block', background: 'transparent', 'color-scheme': 'normal', flex: 'none' });
    return f;
  }

  private reloadFrame() {
    const next = this.makeFrame();
    this.port?.disconnect();
    this.port = null;
    this.frame.replaceWith(next);
    this.frame = next;
  }

  private viewport() {
    const de = this.doc.documentElement;
    const win = this.doc.defaultView!;
    return { width: de.clientWidth || win.innerWidth, height: win.innerHeight || de.clientHeight };
  }

  private dark(): boolean {
    return !!this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches;
  }

  private applyTheme() {
    const th = this.dark() ? THEME.dark : THEME.light;
    css(this.card, { background: th.card, border: `1px solid ${th.line}`, 'box-shadow': th.shadow });
    css(this.handle, { background: th.card });
    css(this.handle.firstElementChild as HTMLElement, { background: th.grip });
    css(this.pill, { background: th.accent, color: th.accentText, border: `2px solid ${th.card}`, 'box-shadow': th.shadow });
  }

  /** Position the card (or the sheet) and the pill for the current viewport. */
  layout() {
    const vp = this.viewport();
    const l = cardLayout(this.placement, this.height + HANDLE_H + 2, vp);
    const frameH = Math.max(40, Math.min(this.height, l.maxHeight - HANDLE_H - 2));
    this.box = { left: l.left, top: l.top, width: l.width, height: frameH + HANDLE_H + 2 };
    css(this.frame, { height: `${frameH}px` });
    css(this.card, { left: `${l.left}px`, top: `${l.top}px`, width: `${l.width}px`, display: this.collapsed ? 'none' : 'flex', 'border-radius': l.sheet ? '12px 12px 8px 8px' : '10px' });
    css(this.handle, { cursor: this.drag ? 'grabbing' : l.sheet ? 'ns-resize' : 'grab' });
    const p = pillLayout(this.placement, vp);
    css(this.pill, { left: `${p.left}px`, top: `${p.top}px`, display: this.collapsed ? 'block' : 'none' });
    this.pill.setAttribute('aria-expanded', String(!this.collapsed));
  }

  get isCollapsed() {
    return this.collapsed;
  }
  get currentPlacement(): WidgetPlacement {
    return this.placement;
  }
  get cardBox() {
    return { ...this.box };
  }
  get frameElement(): HTMLIFrameElement {
    return this.frame;
  }
  get shadow(): ShadowRoot {
    return this.root;
  }

  setCollapsed(on: boolean, focusPill = false) {
    if (this.collapsed === on) return;
    this.collapsed = on;
    this.layout();
    this.port?.postMessage({ t: 'expanded', expanded: !on });
    if (on && focusPill) this.pill.focus({ preventScroll: true });
    void this.save();
  }

  setToken(token: string) {
    if (token === this.token) return;
    this.token = token;
    this.reloadFrame();
  }

  /** The iframe's Port: obeyed only after it sent our token. */
  attachPort(port: HostPort) {
    let trusted = false;
    port.onMessage.addListener((raw) => {
      const m = raw as WidgetToHost | null;
      if (!m || typeof m !== 'object') return;
      if (!trusted) {
        if (m.t === 'ready' && m.token === this.token) {
          trusted = true;
          this.port?.disconnect();
          this.port = port;
          port.postMessage({ t: 'expanded', expanded: !this.collapsed });
        } else port.disconnect();
        return;
      }
      this.onWidgetMessage(m);
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null;
    });
  }

  onWidgetMessage(m: WidgetToHost) {
    switch (m.t) {
      case 'size':
        if (typeof m.height === 'number' && m.height > 0 && Math.abs(m.height - this.height) >= 1) {
          this.height = Math.ceil(m.height);
          this.layout();
        }
        return;
      case 'collapse':
        return this.setCollapsed(true, true);
      case 'hide':
        css(this.host, { display: 'none' });
        return;
      case 'progress': {
        const label = m.total ? `${m.finished}/${m.total}` : '▸';
        this.pill.textContent = label;
        this.pill.title = m.title ? `stubyard: ${m.title} (open the step widget)` : 'stubyard: open the step widget';
        this.pill.setAttribute('aria-label', m.total ? `Open the stubyard step widget: ${m.finished} of ${m.total} steps finished${m.title ? `, current: ${m.title}` : ''}` : 'Open the stubyard step widget');
        return;
      }
    }
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.drag = { dx: e.clientX - this.box.left, dy: e.clientY - this.box.top, id: e.pointerId };
    try {
      this.handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events in tests */
    }
    e.preventDefault();
    this.layout();
  }

  private onMove(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const vp = this.viewport();
    const sheet = isSheet(vp.width);
    this.moveTo(clampPoint({ left: sheet ? this.box.left : e.clientX - this.drag.dx, top: e.clientY - this.drag.dy }, this.box, vp));
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    try {
      this.handle.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    this.dropAt();
  }

  private moveTo(pt: { left: number; top: number }) {
    this.box = { ...this.box, ...pt };
    css(this.card, { left: `${pt.left}px`, top: `${pt.top}px` });
  }

  /** Snap the card from where it is now, save, and lay out again. */
  private dropAt() {
    const vp = this.viewport();
    const b = this.box;
    if (isSheet(vp.width)) this.placement = { ...this.placement, sheetY: sheetYFromTop(b.top, b.height, vp) };
    else this.placement = { ...snapToCorner({ left: b.left, top: b.top }, b, vp), ...(this.placement.sheetY !== undefined ? { sheetY: this.placement.sheetY } : {}) };
    this.layout();
    void this.save();
  }

  private onHandleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      return this.setCollapsed(true, true);
    }
    if (e.key === 'Home') {
      e.preventDefault();
      return this.reset();
    }
    const vp = this.viewport();
    if (isSheet(vp.width) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const pt = nudge(this.box, e.key, e.shiftKey, this.box, vp);
    if (!pt) return;
    e.preventDefault();
    this.moveTo(pt);
    this.dropAt();
  }

  /** Back to the default corner (and forget the saved place). */
  reset() {
    this.placement = defaultPlacement(pageIsRtl(this.doc));
    this.layout();
    void this.save(true);
  }

  private async save(forgetPlace = false) {
    const st = this.deps.storage;
    if (!st) return;
    try {
      const all = ((await st.get(PLACEMENT_KEY))[PLACEMENT_KEY] ?? {}) as Record<string, unknown>;
      const next = { ...(all && typeof all === 'object' ? all : {}) } as Record<string, unknown>;
      next[this.origin] = forgetPlace ? { collapsed: this.collapsed } : { ...this.placement, collapsed: this.collapsed };
      await st.set({ [PLACEMENT_KEY]: next });
    } catch {
      /* storage unavailable (extension reloaded): the place is just not remembered */
    }
  }

  destroy() {
    for (const c of this.cleanups.splice(0)) c();
    this.port?.disconnect();
    this.port = null;
    this.host.remove();
  }
}

/** The saved place and collapsed state of an origin. */
export function readSaved(all: unknown, origin: string): Saved {
  const rec = all && typeof all === 'object' ? (all as Record<string, unknown>)[origin] : null;
  return { placement: parsePlacement(rec), collapsed: !!rec && typeof rec === 'object' && (rec as { collapsed?: unknown }).collapsed === true };
}

let current: WidgetHost | null = null;

/** The mounted host of this content script (tests). */
export const mountedWidget = (): WidgetHost | null => current;

/** Show the widget (idempotent: a mounted one keeps its frame; a host taken off by the page is put back). Top frame only. */
export async function mountWidget(token: string, deps: HostDeps, doc: Document = document): Promise<WidgetMountResult> {
  const win = doc.defaultView;
  if (!win || win.top !== win) return { ok: true, mounted: false };
  if (current) {
    current.setToken(token);
    if (!current.host.isConnected) doc.documentElement.append(current.host);
    current.host.style.removeProperty('display');
    current.layout();
    return { ok: true, mounted: true };
  }
  // Another copy's host (an older content script) would double up: take it off first.
  removeWidgetHosts(doc);
  let saved: Saved = { placement: null, collapsed: false };
  try {
    if (deps.storage) saved = readSaved((await deps.storage.get(PLACEMENT_KEY))[PLACEMENT_KEY], win.location.origin);
  } catch {
    /* defaults */
  }
  if (current) return { ok: true, mounted: true }; // a second mount raced this one
  current = new WidgetHost(doc, token, deps, saved);
  return { ok: true, mounted: true };
}

export function unmountWidget(): WidgetMountResult {
  current?.destroy();
  current = null;
  return { ok: true, mounted: false };
}

/** A Port from the widget iframe (chrome.runtime.onConnect): handed to the host, which checks its token. */
export function acceptWidgetPort(port: HostPort, extensionBase: string): boolean {
  if (port.name !== WIDGET_PORT) return false;
  if (!port.sender?.url?.startsWith(extensionBase) || !current) {
    port.disconnect();
    return true;
  }
  current.attachPort(port);
  return true;
}

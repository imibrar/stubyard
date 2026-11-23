// The content script's side of the on-page widget (docs/design/floating-widget.md): the page host.
//  - mount/unmount: one host element on <html> (outside <body>), a plain <div> marked with data-stubyard-widget (never a
//    custom element: a page could define that name and reach the closed shadow root through attachInternals), with a
//    CLOSED shadow root holding the pill, the drag handle and an <iframe src="chrome-extension://…/widget.html#token=…">.
//    The iframe is the widget UI (an extension page: hub calls, credentials and step controls live there, never in the
//    page DOM). Every frame gets a fresh single-use token from the service worker (widget.token).
//  - the host's own style attribute is re-asserted when the page changes it (opacity, transform, …), and only trusted
//    (real user) events move or open it; the frame itself refuses clicks while it is not really visible.
//  - collapse HIDES the card (the frame stays loaded, so a running wait keeps running); only unmount removes it.
//  - drag on the handle (outside the iframe, pointer capture) with corner snap; the place is saved per origin under its
//    own storage key on drag end only; double-click resets it. Under 480 px it is a bottom sheet (vertical drag only).
//  - Esc (in the widget) collapses; nothing here ever handles keys of the page, and nothing takes focus on its own.
//  - suspend/resume: captureClean() hides any widget host for a screenshot and shows it again afterwards.
//  - removeWidgetHosts: a replaced (orphaned) content script's widget is taken off the page.
// All styling goes through element.style (CSSOM), which a page's CSP style-src does not block; no <style> elements.
import {
  HIGHLIGHT_ATTR,
  type HostToWidget,
  WIDGET_AUTO_RESUME_MS,
  WIDGET_HOST_ATTR,
  WIDGET_PORT,
  type WidgetMountResult,
  type WidgetResumeResult,
  type WidgetSuspendResult,
  type WidgetToggleResult,
  type WidgetToHost,
} from '../shared/protocol';
import {
  HOST_ANNOUNCEMENTS,
  isHostAnnouncement,
  avoidPlacement,
  cardLayout,
  clampPoint,
  defaultPlacement,
  isSheet,
  nudge,
  parsePlacement,
  pillAvoidPlacement,
  pillLayout,
  PILL_SIZE,
  PLACEMENT_KEY,
  type Rect,
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
  for (const h of hosts) {
    if (current && h === current.host) current.setSuspended(true);
    else h.style.setProperty('visibility', 'hidden', 'important');
  }
  if (autoResume) clearTimeout(autoResume);
  autoResume = setTimeout(() => resumeWidget(doc), WIDGET_AUTO_RESUME_MS);
  await nextFrames(2, doc.defaultView ?? window);
  return { ok: true, hidden: hosts.length };
}

export function resumeWidget(doc: Document = document): WidgetResumeResult {
  if (autoResume) clearTimeout(autoResume);
  autoResume = null;
  for (const h of widgetHosts(doc)) {
    if (current && h === current.host) current.setSuspended(false);
    else h.style.removeProperty('visibility');
  }
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
  /**
   * False once the extension was reloaded, updated or removed. The frame's port drops then, and a host whose runtime
   * is gone takes itself off the page (no orphaned card, also on pages the new version does not inject into).
   */
  alive?: () => boolean;
  /**
   * A fresh single-use token for a new frame (the service worker's widget.token; null: none, the frame stays empty
   * until the next remount). Tests pass a counter.
   */
  mintToken: () => Promise<string | null>;
  /** Which events of the pill and the handle count (default: only trusted ones, `isTrusted`; tests accept synthetic). */
  acceptEvent?: (e: Event) => boolean;
}

interface Saved {
  placement: WidgetPlacement | null;
  collapsed: boolean;
}

const HANDLE_H = 18;
/** A frame whose port dropped and did not reconnect within this long is replaced (it was navigated away). */
const RECOVER_MS = 2500;
const INITIAL_FRAME_H = 132;
/** How long the page must be still (scroll, click, resize) before the avoid check runs. */
const AVOID_DEBOUNCE_MS = 180;
/** At most this many candidate buttons are measured per avoid check (big pages stay cheap). */
const AVOID_MAX = 40;
/** What the card keeps clear of: the step's highlighted element, the page's submit and primary buttons. */
export const AVOID_SELECTOR = [
  `[${HIGHLIGHT_ATTR}]`,
  'button[type="submit"]',
  'input[type="submit"]',
  'input[type="image"]',
  'form button:not([type])',
  'button[class*="primary" i]',
  'a[class*="primary" i]',
  '[role="button"][class*="primary" i]',
].join(', ');

const FONT = '600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const THEME = {
  light: {
    card: '#ffffff', line: 'rgba(15, 23, 42, 0.12)', grip: '#c3c7cf', gripHover: '#8a8f99', text: '#1c1d21', track: '#e6e8ec', accent: '#0d9488', busy: '#f59e0b',
    shadow: '0 1px 2px rgba(15, 23, 42, 0.06), 0 10px 30px -6px rgba(15, 23, 42, 0.22)',
  },
  dark: {
    card: '#212226', line: 'rgba(255, 255, 255, 0.10)', grip: '#4a4d55', gripHover: '#8a8f99', text: '#e8e9ec', track: '#3a3c43', accent: '#2dd4bf', busy: '#fbbf24',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.5), 0 14px 36px -6px rgba(0, 0, 0, 0.7)',
  },
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

/** Whether a <dialog> is open as a modal (showModal): everything outside it is inert then. */
export function isModalDialog(el: Element): boolean {
  if (el.tagName !== 'DIALOG' || !el.hasAttribute('open') || !el.isConnected) return false;
  try {
    return el.matches(':modal');
  } catch {
    return false;
  }
}

/** Whether an element makes position: fixed children relative to itself (transform, filter, contain, …). */
export function fixedContainer(el: Element): boolean {
  try {
    const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
    const set = (v: string | undefined | null) => !!v && v !== 'none' && v !== 'normal' && v !== 'auto';
    return (
      set(cs.transform) || set(cs.filter) || set(cs.perspective) || set(cs.getPropertyValue('backdrop-filter')) || set(cs.getPropertyValue('container-type')) ||
      /paint|layout|strict|content/.test(cs.contain || '') || /transform|filter|perspective/.test(cs.willChange || '')
    );
  } catch {
    return false;
  }
}

type MoveBefore = (node: Node, child: Node | null) => void;

export class WidgetHost {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly card: HTMLDivElement;
  private readonly handle: HTMLDivElement;
  private frame: HTMLIFrameElement;
  private readonly pill: HTMLButtonElement;
  private readonly live: HTMLDivElement;
  /** The red recording dot on the pill (walkthrough recording on; hollow while paused). */
  private readonly recDot: HTMLDivElement;
  private rec = { on: false, paused: false };
  /** The tester's place (saved per origin). */
  private placement: WidgetPlacement;
  /** Where it is shown now: the tester's place, or another corner while that one would cover a highlighted button. */
  private shown: WidgetPlacement;
  private avoidMoved = false;
  /** Off after the tester moved the card by hand on this page: then it stays where it was put. */
  private avoidOn = true;
  private avoidTimer: ReturnType<typeof setTimeout> | null = null;
  private collapsed = false;
  private busy = false;
  private progress = { finished: 0, total: 0 };
  private progressLabel = { text: '▸', title: '', aria: '' };
  private height = INITIAL_FRAME_H;
  private port: HostPort | null = null;
  private drag: { dx: number; dy: number; id: number } | null = null;
  private pendingMove: { left: number; top: number } | null = null;
  private moveFrame: number | null = null;
  /** The card's box as last laid out or dragged (kept here, not measured, so the math does not depend on layout). */
  private box = { left: 0, top: 0, width: 0, height: 0 };
  private readonly cleanups: (() => void)[] = [];
  private readonly origin: string;
  /** Native modal dialogs open now, in the order they opened (the host lives in the last one). */
  private dialogs: Element[] = [];
  private dialogObserver: MutationObserver | null = null;
  private parentObserver: MutationObserver | null = null;
  private destroyed = false;
  /** How many times the frame had to be reloaded (a move without moveBefore, a bfcache restore): tests and QA. */
  frameLoads = 1;
  /** When the current frame was made: a remount reloads a frame that never connected (its hello was denied). */
  private frameAt = Date.now();
  /** "Hide on this tab" (display: none) and a screenshot in progress (visibility: hidden): part of the host style. */
  private hiddenByWidget = false;
  private suspended = false;
  /** The host's style attribute as last written; anything else (the page's opacity, transform, …) is put back. */
  private hostCss = '';
  private styleObserver: MutationObserver | null = null;
  /** How often the page changed the host's style or attributes and it was put back (tests and QA). */
  styleResets = 0;

  constructor(
    private readonly doc: Document,
    private token: string | null,
    private readonly deps: HostDeps,
    saved: Saved = { placement: null, collapsed: false },
  ) {
    const win = doc.defaultView!;
    this.origin = win.location.origin;
    this.placement = saved.placement ?? defaultPlacement(pageIsRtl(doc));
    this.shown = this.placement;
    this.collapsed = saved.collapsed;

    // A plain div, never a custom element: attachInternals() throws for it, so a page that defines a custom element of
    // the same name cannot get at the closed shadow root (review item 2).
    this.host = doc.createElement('div');
    this.host.setAttribute(WIDGET_HOST_ATTR, '1');
    this.applyHostStyle();
    this.root = this.host.attachShadow({ mode: 'closed' });

    this.card = doc.createElement('div');
    this.card.setAttribute('role', 'region');
    this.card.setAttribute('aria-label', 'stubyard step widget');
    css(this.card, { position: 'fixed', display: 'flex', 'flex-direction': 'column', 'box-sizing': 'border-box', 'border-radius': '12px', overflow: 'hidden', margin: '0', padding: '0' });

    this.handle = doc.createElement('div');
    this.handle.tabIndex = 0;
    this.handle.setAttribute('role', 'button');
    this.handle.setAttribute('aria-roledescription', 'move handle');
    this.handle.setAttribute('aria-label', 'Move the stubyard widget: arrow keys move it, Home puts it back in its corner, Escape collapses it');
    this.handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Home Escape');
    this.handle.title = 'Drag to move · double-click to reset';
    css(this.handle, { height: `${HANDLE_H}px`, flex: 'none', cursor: 'grab', 'touch-action': 'none', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'user-select': 'none', outline: 'none' });
    const grip = doc.createElement('span');
    css(grip, { width: '32px', height: '4px', 'border-radius': '2px', display: 'block' });
    this.handle.append(grip);

    this.frame = this.makeFrame();

    this.pill = doc.createElement('button');
    this.pill.type = 'button';
    this.pill.setAttribute('aria-expanded', 'false');
    this.pill.setAttribute('aria-label', 'Open the stubyard step widget');
    this.pill.setAttribute('aria-keyshortcuts', 'Alt+Shift+W');
    this.pill.title = 'stubyard: open the step widget';
    this.pill.textContent = '▸';
    css(this.pill, {
      position: 'fixed', width: `${PILL_SIZE}px`, height: `${PILL_SIZE}px`, 'border-radius': '50%', margin: '0', padding: '0', cursor: 'pointer', border: '0', outline: 'none',
      font: FONT, 'box-sizing': 'border-box', 'text-align': 'center', 'letter-spacing': '0', 'font-variant-numeric': 'tabular-nums',
    });

    // Screen-reader announcements (step changes, waits): heard also while the card is collapsed.
    this.live = doc.createElement('div');
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');
    css(this.live, { position: 'fixed', width: '1px', height: '1px', margin: '-1px', padding: '0', border: '0', overflow: 'hidden', clip: 'rect(0 0 0 0)', 'clip-path': 'inset(50%)', 'white-space': 'nowrap' });

    this.recDot = doc.createElement('div');
    this.recDot.setAttribute('aria-hidden', 'true');
    css(this.recDot, { position: 'fixed', width: '12px', height: '12px', 'border-radius': '50%', 'box-sizing': 'border-box', 'pointer-events': 'none', display: 'none' });

    this.card.append(this.handle, this.frame);
    this.root.append(this.card, this.pill, this.recDot, this.live);
    this.applyTheme();

    // Only real input moves or opens it (a synthetic event the page dispatched is ignored).
    this.listenTrusted(this.pill, 'click', () => this.setCollapsed(false));
    this.listenTrusted(this.handle, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listenTrusted(this.handle, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listenTrusted(this.handle, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen(this.handle, 'pointercancel', (e) => this.onUp(e as PointerEvent));
    this.listenTrusted(this.handle, 'dblclick', () => this.reset());
    this.listenTrusted(this.handle, 'keydown', (e) => this.onHandleKey(e as KeyboardEvent));
    // Visible focus (CSSOM only: no :focus-visible rule can be added under a strict style-src).
    for (const el of [this.handle, this.pill]) {
      this.listen(el, 'focus', () => this.paintFocus(el, true));
      this.listen(el, 'blur', () => this.paintFocus(el, false));
    }
    this.listen(this.handle, 'pointerenter', () => css(grip, { background: this.th().gripHover }));
    this.listen(this.handle, 'pointerleave', () => css(grip, { background: this.th().grip }));
    this.listen(win, 'resize', () => {
      this.layout();
      this.scheduleAvoid();
    });
    // The avoid check after the page settles (passive; capture also sees scrolling inside page containers).
    const later = () => this.scheduleAvoid();
    this.listen(win, 'scroll', later, { passive: true, capture: true });
    this.listen(win, 'click', later, { passive: true, capture: true });
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
    this.watchHostStyle();
    this.watchDialogs();
    this.layout();
    this.scheduleAvoid(0);
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) {
    t.addEventListener(type, fn, opts);
    this.cleanups.push(() => t.removeEventListener(type, fn, opts));
  }

  private listenTrusted(t: EventTarget, type: string, fn: (e: Event) => void) {
    const accept = this.deps.acceptEvent ?? ((e: Event) => e.isTrusted);
    this.listen(t, type, (e) => {
      if (accept(e)) fn(e);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The host's style (review item 1): written in one place; a page that sets opacity, transform, filter, clip-path, …
  // on it (even with !important) gets it put back at once. The frame's visibility check (IntersectionObserver v2)
  // covers what this cannot see (styles on the page's own elements above or around the host).

  private applyHostStyle() {
    this.host.setAttribute('style', '');
    // A zero-size fixed box: it never covers the page; its children are fixed to the viewport.
    css(this.host, { all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0', overflow: 'visible', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0' });
    if (this.hiddenByWidget) css(this.host, { display: 'none' });
    if (this.suspended) css(this.host, { visibility: 'hidden' });
    this.hostCss = this.host.getAttribute('style') ?? '';
  }

  private watchHostStyle() {
    const MO = this.doc.defaultView?.MutationObserver;
    if (!MO) return;
    this.styleObserver = new MO(() => this.guardHostStyle());
    this.styleObserver.observe(this.host, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert'] });
  }

  /** Put the host's style back and drop attributes the page added (also called directly by tests). */
  guardHostStyle() {
    if (this.destroyed) return;
    let changed = false;
    for (const a of ['class', 'hidden', 'inert']) {
      if (this.host.hasAttribute(a)) {
        this.host.removeAttribute(a);
        changed = true;
      }
    }
    if ((this.host.getAttribute('style') ?? '') !== this.hostCss) {
      this.applyHostStyle();
      changed = true;
    }
    if (changed) this.styleResets += 1;
  }

  /** Hidden for a screenshot (captureClean). */
  setSuspended(on: boolean) {
    this.suspended = on;
    this.applyHostStyle();
  }

  /** "Hide on this tab" from the widget (off) or a new mount (on). */
  setHidden(on: boolean) {
    this.hiddenByWidget = on;
    this.applyHostStyle();
  }

  get isHidden() {
    return this.hiddenByWidget;
  }

  private makeFrame(): HTMLIFrameElement {
    const f = this.doc.createElement('iframe');
    f.setAttribute('allow', 'clipboard-write');
    f.setAttribute('title', 'stubyard step widget');
    if (this.token) f.src = this.deps.getURL('widget.html') + widgetHash(this.token);
    css(f, { border: '0', width: '100%', height: `${this.height}px`, display: 'block', background: 'transparent', 'color-scheme': 'normal', flex: 'none' });
    return f;
  }

  /** A new frame with a new single-use token (bfcache restore, a refused frame, a move that reloaded the frame). */
  reloadFrame(): Promise<void> {
    const old = this.port;
    this.port = null;
    old?.disconnect();
    this.token = null; // the old frame's token is never valid again, here or in the worker
    const next = this.makeFrame();
    this.frame.replaceWith(next);
    this.frame = next;
    this.frameLoads += 1;
    this.frameAt = Date.now();
    return this.deps.mintToken().then(
      (token) => {
        if (this.destroyed || this.frame !== next || !token) return;
        this.token = token;
        next.src = this.deps.getURL('widget.html') + widgetHash(token);
        this.frameAt = Date.now();
      },
      () => {},
    );
  }

  private viewport() {
    const de = this.doc.documentElement;
    const win = this.doc.defaultView!;
    return { width: de.clientWidth || win.innerWidth, height: win.innerHeight || de.clientHeight };
  }

  private dark(): boolean {
    return !!this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches;
  }

  private th() {
    return this.dark() ? THEME.dark : THEME.light;
  }

  private applyTheme() {
    const th = this.th();
    css(this.card, { background: th.card, border: `1px solid ${th.line}`, 'box-shadow': th.shadow, color: th.text });
    css(this.handle, { background: th.card });
    css(this.handle.firstElementChild as HTMLElement, { background: th.grip });
    // The pill is a progress ring: finished steps in the accent colour; amber while a 2FA or email wait runs.
    const pct = this.progress.total ? Math.round((this.progress.finished / this.progress.total) * 100) : 0;
    const ring = this.busy ? `conic-gradient(${th.busy} 0 100%)` : `conic-gradient(${th.accent} 0 ${pct}%, ${th.track} ${pct}% 100%)`;
    css(this.pill, {
      background: `radial-gradient(closest-side, ${th.card} calc(100% - 4px), transparent calc(100% - 3px)), ${ring}`,
      color: th.text,
      'box-shadow': th.shadow,
    });
    // Recording: a solid red dot; paused: a hollow one.
    css(this.recDot, { background: this.rec.paused ? th.card : '#dc2626', border: `2px solid ${this.rec.paused ? '#dc2626' : th.card}` });
    this.paintFocus(this.handle, this.root.activeElement === this.handle);
    this.paintFocus(this.pill, this.root.activeElement === this.pill);
  }

  private paintFocus(el: HTMLElement, on: boolean) {
    let visible = on;
    if (on) {
      try {
        visible = el.matches(':focus-visible');
      } catch {
        /* older engines: show it on any focus */
      }
    }
    const th = this.th();
    if (el === this.handle) css(el, { 'box-shadow': visible ? `inset 0 0 0 2px ${th.accent}` : 'none' });
    else css(el, { outline: visible ? `2px solid ${th.accent}` : 'none', 'outline-offset': '2px' });
  }

  /** Position the card (or the sheet) and the pill for the current viewport. */
  layout() {
    const vp = this.viewport();
    const l = cardLayout(this.shown, this.height + HANDLE_H + 2, vp);
    const frameH = Math.max(40, Math.min(this.height, l.maxHeight - HANDLE_H - 2));
    this.box = { left: l.left, top: l.top, width: l.width, height: frameH + HANDLE_H + 2 };
    css(this.frame, { height: `${frameH}px` });
    css(this.card, { left: `${l.left}px`, top: `${l.top}px`, width: `${l.width}px`, display: this.collapsed ? 'none' : 'flex', 'border-radius': l.sheet ? '14px 14px 10px 10px' : '12px' });
    css(this.handle, { cursor: this.drag ? 'grabbing' : l.sheet ? 'ns-resize' : 'grab' });
    const p = pillLayout(this.shown, vp);
    css(this.pill, { left: `${p.left}px`, top: `${p.top}px`, display: this.collapsed ? 'block' : 'none' });
    css(this.recDot, { left: `${p.left + PILL_SIZE - 11}px`, top: `${p.top - 1}px`, display: this.collapsed && this.rec.on ? 'block' : 'none' });
    this.pill.setAttribute('aria-expanded', String(!this.collapsed));
  }

  get isCollapsed() {
    return this.collapsed;
  }
  /** The tester's place (what is saved). */
  get currentPlacement(): WidgetPlacement {
    return this.placement;
  }
  /** Where it is shown now (another corner while it keeps clear of a button). */
  get shownPlacement(): WidgetPlacement {
    return this.shown;
  }
  get avoiding(): boolean {
    return this.avoidMoved;
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
  get liveText(): string {
    return this.live.textContent ?? '';
  }
  /** The modal dialog the host sits in (null: on <html>). */
  get dialog(): Element | null {
    return this.host.parentElement && this.host.parentElement !== this.doc.documentElement ? this.host.parentElement : null;
  }

  setCollapsed(on: boolean, focusPill = false) {
    if (this.collapsed === on) return;
    this.collapsed = on;
    this.layout();
    this.port?.postMessage({ t: 'expanded', expanded: !on });
    if (on && focusPill) this.pill.focus({ preventScroll: true });
    this.say(on ? 'stubyard widget collapsed' : 'stubyard widget expanded');
    this.scheduleAvoid(0);
    void this.save();
  }

  /** A new mount on the same page (SPA route change): the avoid check runs again, also after a manual move. */
  remounted() {
    // A frame that has not connected after a while was refused (say the tab was opened in another window and then
    // moved into the run's window), or never got a token: give it a fresh frame and token.
    if (!this.port && (Date.now() - this.frameAt > STALE_FRAME_MS || !this.token)) void this.reloadFrame();
    this.avoidOn = true;
    this.syncDialogs();
    this.scheduleAvoid(0);
  }

  /** The iframe's Port: obeyed only after it sent our token. */
  attachPort(port: HostPort) {
    let trusted = false;
    port.onMessage.addListener((raw) => {
      const m = raw as WidgetToHost | null;
      if (!m || typeof m !== 'object') return;
      if (!trusted) {
        if (m.t === 'ready' && !!this.token && m.token === this.token) {
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
      const wasCurrent = this.port === port;
      if (wasCurrent) this.port = null;
      // The extension was reloaded or updated: its frame is dead. Take the card off instead of leaving an orphan.
      if (this.deps.alive && !this.deps.alive()) return this.selfRemove();
      // The frame went away without us (the page navigated our iframe to a page of its own): when it does not come
      // back on its own (the widget reconnects within a second), put a fresh frame there.
      if (wasCurrent) this.scheduleRecover();
    });
  }

  private recoverTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleRecover() {
    if (this.recoverTimer) clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      if (!this.destroyed && !this.port) void this.reloadFrame();
    }, RECOVER_MS);
  }

  /** Speak a line through the live region (cleared first, so the same text is announced again). */
  private say(text: string) {
    this.live.textContent = '';
    if (!text) return;
    const win = this.doc.defaultView;
    const put = () => {
      if (!this.destroyed) this.live.textContent = text.slice(0, 300);
    };
    if (win) win.setTimeout(put, 60);
    else put();
  }

  onWidgetMessage(m: WidgetToHost) {
    switch (m.t) {
      case 'size':
        if (typeof m.height === 'number' && m.height > 0 && Math.abs(m.height - this.height) >= 1) {
          this.height = Math.ceil(m.height);
          this.layout();
          this.scheduleAvoid();
        }
        return;
      case 'collapse':
        return this.setCollapsed(true, true);
      case 'hide':
        return this.setHidden(true);
      case 'progress': {
        // Numbers only: no step title in the page's DOM (review item 2).
        const finished = Math.max(0, m.finished | 0);
        const total = Math.max(0, m.total | 0);
        this.progress = { finished, total };
        this.progressLabel = {
          text: total ? `${finished}/${total}` : '▸',
          title: 'stubyard: open the step widget',
          aria: total ? `Open the stubyard step widget: ${finished} of ${total} steps finished` : 'Open the stubyard step widget',
        };
        return this.paintPill();
      }
      case 'busy':
        this.busy = m.on === true;
        return this.paintPill();
      case 'recording':
        this.rec = { on: m.on === true, paused: m.paused === true };
        this.paintPill();
        return this.layout();
      case 'announce':
        // A fixed, generic line only: the frame cannot make the host write arbitrary text into the page.
        if (isHostAnnouncement(m.kind)) this.say(HOST_ANNOUNCEMENTS[m.kind]);
        return;
    }
  }

  get isBusy() {
    return this.busy;
  }

  /** The pill's label, and while a 2FA or email wait runs in the (collapsed) widget, an amber ring and "waiting". */
  private paintPill() {
    const l = this.progressLabel;
    this.pill.textContent = l.text;
    // Long counts ("12/140") get a smaller font so they fit the ring.
    css(this.pill, { 'font-size': l.text.length > 5 ? '10px' : '12px' });
    this.pill.title = (l.title || 'stubyard: open the step widget') + (this.busy ? ' · waiting for a code or a message' : '');
    const rec = this.rec.on ? (this.rec.paused ? ' · recording paused' : ' · recording') : '';
    this.pill.title += rec;
    this.pill.setAttribute('aria-label', (l.aria || 'Open the stubyard step widget') + (this.busy ? ', waiting for a code or a message' : '') + (rec ? `,${rec.slice(2)}` : ''));
    this.applyTheme();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Drag (pointer capture on the handle; moves are applied at most once per animation frame, writes only)

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
    const pt = clampPoint({ left: sheet ? this.box.left : e.clientX - this.drag.dx, top: e.clientY - this.drag.dy }, this.box, vp);
    const win = this.doc.defaultView;
    if (this.moveFrame !== null) {
      this.pendingMove = pt; // applied at the next frame
      return;
    }
    this.moveTo(pt);
    if (win?.requestAnimationFrame) {
      this.moveFrame = win.requestAnimationFrame(() => {
        this.moveFrame = null;
        if (this.pendingMove) this.moveTo(this.pendingMove);
        this.pendingMove = null;
      });
    }
  }

  private flushMove() {
    if (this.moveFrame !== null) this.doc.defaultView?.cancelAnimationFrame?.(this.moveFrame);
    this.moveFrame = null;
    if (this.pendingMove) this.moveTo(this.pendingMove);
    this.pendingMove = null;
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.flushMove();
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

  /** Snap the card from where it is now, save, and lay out again. The tester's place wins over the avoid check. */
  private dropAt() {
    const vp = this.viewport();
    const b = this.box;
    if (isSheet(vp.width)) this.placement = { ...this.placement, sheetY: sheetYFromTop(b.top, b.height, vp) };
    else this.placement = { ...snapToCorner({ left: b.left, top: b.top }, b, vp), ...(this.placement.sheetY !== undefined ? { sheetY: this.placement.sheetY } : {}) };
    this.avoidOn = false;
    this.avoidMoved = false;
    this.shown = this.placement;
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
    this.shown = this.placement;
    this.avoidOn = true;
    this.avoidMoved = false;
    this.layout();
    this.scheduleAvoid(0);
    void this.save(true);
  }

  /** The saved place changed elsewhere (Settings "Reset position"): follow it. */
  applySaved(saved: Saved) {
    this.placement = saved.placement ?? defaultPlacement(pageIsRtl(this.doc));
    this.shown = this.placement;
    this.avoidOn = true;
    this.avoidMoved = false;
    this.layout();
    this.scheduleAvoid(0);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Keep clear of the page's highlighted, submit and primary buttons (never saved; never during a drag)

  scheduleAvoid(ms = AVOID_DEBOUNCE_MS) {
    if (this.destroyed) return;
    if (this.avoidTimer) clearTimeout(this.avoidTimer);
    this.avoidTimer = setTimeout(() => {
      this.avoidTimer = null;
      this.checkAvoid();
    }, ms);
  }

  /** The boxes of the buttons to keep clear of, in the viewport (at most AVOID_MAX measured). */
  avoidRects(): Rect[] {
    const vp = this.viewport();
    const out: Rect[] = [];
    let n = 0;
    let scope: ParentNode = this.doc;
    const dlg = this.dialog;
    if (dlg) scope = dlg; // inside a modal dialog only its own buttons can be clicked
    for (const el of Array.from(scope.querySelectorAll(AVOID_SELECTOR))) {
      if (n++ >= AVOID_MAX) break;
      if (this.host.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vp.width || r.top >= vp.height) continue;
      out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    return out;
  }

  checkAvoid() {
    if (this.destroyed || this.drag || !this.host.isConnected) return;
    if (!this.avoidOn) return;
    const vp = this.viewport();
    const rects = this.avoidRects();
    const r = this.collapsed ? pillAvoidPlacement(this.placement, vp, rects) : avoidPlacement(this.placement, this.height + HANDLE_H + 2, vp, rects);
    const same = JSON.stringify(r.placement) === JSON.stringify(this.shown);
    this.avoidMoved = r.moved;
    if (same) return;
    this.shown = r.placement;
    this.layout();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Native modal <dialog> (showModal makes everything outside it inert): the host moves into the open dialog with
  // moveBefore (the frame is kept: no reload, a running wait goes on) and back to <html> when it closes. Without
  // moveBefore (Chrome before 133) it is moved anyway; the frame then reloads once each way and resumes its wait from
  // the step data. Inside a dialog the host is a manual popover, so it is drawn above the dialog and is not clipped or
  // shifted by a dialog with a transform.

  private watchDialogs() {
    const MO = this.doc.defaultView?.MutationObserver;
    if (!MO) return;
    this.dialogObserver = new MO((records) => {
      for (const r of records) {
        const t = r.target as Element;
        if (t.tagName === 'DIALOG' && isModalDialog(t) && !this.dialogs.includes(t)) this.dialogs.push(t);
      }
      this.syncDialogs();
    });
    // Only the open attribute is watched (cheap even on large pages).
    this.dialogObserver.observe(this.doc.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    for (const d of Array.from(this.doc.querySelectorAll('dialog[open]'))) if (isModalDialog(d)) this.dialogs.push(d);
    this.syncDialogs();
  }

  /** Put the host in the topmost open modal dialog, or back on <html>. */
  syncDialogs() {
    if (this.destroyed) return;
    this.dialogs = this.dialogs.filter(isModalDialog);
    const target = this.dialogs[this.dialogs.length - 1] ?? this.doc.documentElement;
    if (this.host.parentNode !== target || !this.host.isConnected) this.moveHost(target);
  }

  private moveHost(target: Element) {
    const inside = target !== this.doc.documentElement;
    this.leaveTopLayer();
    const mb = (target as unknown as { moveBefore?: MoveBefore }).moveBefore;
    let moved = false;
    if (typeof mb === 'function' && this.host.isConnected && target.isConnected) {
      try {
        mb.call(target, this.host, null);
        moved = true;
      } catch {
        /* HierarchyRequestError and the like: fall back to a plain move */
      }
    }
    if (!moved) {
      const wasConnected = this.host.isConnected;
      target.append(this.host);
      // The browser reloads a moved iframe, with the token it already used: give it a fresh frame and token instead.
      if (wasConnected) void this.reloadFrame();
    }
    this.parentObserver?.disconnect();
    this.parentObserver = null;
    if (inside) {
      this.enterTopLayer();
      // A dialog removed from the page takes the host with it: put the host back on <html> then.
      const MO = this.doc.defaultView?.MutationObserver;
      const parent = target.parentNode;
      if (MO && parent) {
        this.parentObserver = new MO(() => {
          if (!target.isConnected || !this.host.isConnected) this.syncDialogs();
        });
        this.parentObserver.observe(parent, { childList: true });
      }
    }
    this.say(inside ? 'stubyard widget moved into the dialog' : '');
    this.layout();
    this.scheduleAvoid(0);
  }

  private enterTopLayer() {
    const h = this.host as HTMLElement & { showPopover?: () => void };
    if (typeof h.showPopover !== 'function') return;
    try {
      h.setAttribute('popover', 'manual');
      h.showPopover();
    } catch {
      h.removeAttribute('popover');
    }
  }

  private leaveTopLayer() {
    const h = this.host as HTMLElement & { hidePopover?: () => void };
    if (!h.hasAttribute('popover')) return;
    try {
      h.hidePopover?.();
    } catch {
      /* not showing */
    }
    h.removeAttribute('popover');
  }

  // -------------------------------------------------------------------------------------------------------------

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

  /** The runtime is gone: remove the host and tell the module (mountedWidget() becomes null). */
  private selfRemove() {
    this.destroy();
    if (current === this) current = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.cleanups.splice(0)) c();
    if (this.avoidTimer) clearTimeout(this.avoidTimer);
    if (this.recoverTimer) clearTimeout(this.recoverTimer);
    this.flushMove();
    this.dialogObserver?.disconnect();
    this.parentObserver?.disconnect();
    this.styleObserver?.disconnect();
    this.leaveTopLayer();
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
/** How long a frame may take to say ready before a remount replaces it. */
const STALE_FRAME_MS = 3000;

let mounting: Promise<WidgetMountResult> | null = null;

export async function mountWidget(deps: HostDeps, doc: Document = document): Promise<WidgetMountResult> {
  const win = doc.defaultView;
  if (!win || win.top !== win) return { ok: true, mounted: false };
  // One mount at a time: two that overlap (tab update events come in pairs) would mint two tokens, and the second
  // one (the worker keeps one per tab) would leave the first frame's hello refused.
  if (mounting) {
    await mounting.catch(() => null);
    return mountWidget(deps, doc);
  }
  const run = mountOnce(deps, doc, win);
  mounting = run;
  try {
    return await run;
  } finally {
    if (mounting === run) mounting = null;
  }
}

/** Bumped by unmountWidget: a mount still waiting (storage, token) when the widget is taken off does not put it back. */
let epoch = 0;

async function mountOnce(deps: HostDeps, doc: Document, win: Window): Promise<WidgetMountResult> {
  const at = epoch;
  if (current) {
    if (!current.host.isConnected) doc.documentElement.append(current.host);
    current.setHidden(false);
    current.layout();
    current.remounted();
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
  const token = epoch === at ? await deps.mintToken().catch(() => null) : null;
  if (epoch !== at) return { ok: true, mounted: false };
  current = new WidgetHost(doc, token, deps, saved);
  return { ok: true, mounted: true };
}

/** The saved places changed (Settings "Reset position"): the mounted host follows when its origin's entry is gone. */
export function placementsChanged(all: unknown, doc: Document = document): void {
  if (!current || !doc.defaultView) return;
  const saved = readSaved(all, doc.defaultView.location.origin);
  if (!saved.placement) current.applySaved(saved);
}

/** A step highlighted an element (content/capture.ts): check the avoid rule once its smooth scroll has settled. */
export function highlighted(): void {
  current?.scheduleAvoid(450);
}

/** Alt+Shift+W: collapse or expand a shown widget (never moves focus: the tester may be typing in the page). */
export function toggleWidget(collapsed?: boolean): WidgetToggleResult {
  if (!current || !current.host.isConnected || current.isHidden) return { ok: true, mounted: false, collapsed: false };
  current.setCollapsed(collapsed ?? !current.isCollapsed);
  return { ok: true, mounted: true, collapsed: current.isCollapsed };
}

/** Whether the mounted widget is collapsed to its pill (null: none shown). Video mode collapses it (videoMode.ts). */
export function widgetCollapsed(): boolean | null {
  if (!current || !current.host.isConnected || current.isHidden) return null;
  return current.isCollapsed;
}

export function unmountWidget(): WidgetMountResult {
  epoch += 1;
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

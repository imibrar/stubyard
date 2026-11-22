// Pure rules of the on-page step widget (docs/design/floating-widget.md): where it shows (eligibility), where it
// sits (placement, corner snap, clamping, the bottom sheet), and the storage keys it uses. No chrome.*, no DOM, so
// the service worker, the content host, the widget and the tests share them.
import type { ActiveWalkthrough } from './settings';
import { pageOrigin } from './settings';

// ---------------------------------------------------------------------------------------------------------------
// Storage keys (each one its own key, outside the settings object: review item 10)

/** chrome.storage.local: the saved place of the widget per page origin (written on drag end only). */
export const PLACEMENT_KEY = 'widgetPlacementByOrigin';
/** chrome.storage.local: the first-run hint was dismissed. */
export const HINT_KEY = 'widgetHintSeen';
// chrome.storage.session holds one key PER TAB (security review item 4): the panel, the widget frames and the service
// worker all write these, and a read-modify-write of one shared map lost updates when two of them wrote at once.

/** chrome.storage.session: `widgetToken:<tabId>`, the single-use token of the tab's current widget frame. */
export const TOKEN_KEY_PREFIX = 'widgetToken:';
/** chrome.storage.session: `widgetTabOverride:<tabId>`, the panel's "Show on this tab" or the widget's "Hide on this tab". */
export const OVERRIDE_KEY_PREFIX = 'widgetTabOverride:';
export const tokenKey = (tabId: number): string => TOKEN_KEY_PREFIX + tabId;
export const overrideKey = (tabId: number): string => OVERRIDE_KEY_PREFIX + tabId;
export const isOverrideKey = (k: string): boolean => k.startsWith(OVERRIDE_KEY_PREFIX);
/** The tab id of a per-tab key (null: not one). */
export function tabOfKey(k: string): number | null {
  const m = /^widget(?:Token|TabOverride):(\d+)$/.exec(k);
  return m ? Number(m[1]) : null;
}

export type TabOverride = 'show' | 'hide';
/**
 * A tab's choice as stored. "Show on this tab" is bound to the origin it was given on: when the tab navigates to
 * another origin it no longer applies (review item 1), so a page cannot keep a forced widget after a redirect.
 */
export interface TabOverrideRec {
  value: TabOverride;
  origin: string | null;
}

/** chrome.storage.session, or a fake in tests. `get(null)` reads every key. */
export interface SessionArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const asMap = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, T>) } : {});

/** A stored override (anything malformed is null). */
export function parseOverride(v: unknown): TabOverrideRec | null {
  if (v === 'hide' || v === 'show') return { value: v, origin: null };
  if (!v || typeof v !== 'object') return null;
  const o = v as { value?: unknown; origin?: unknown };
  if (o.value !== 'show' && o.value !== 'hide') return null;
  return { value: o.value, origin: typeof o.origin === 'string' ? pageOrigin(o.origin) : null };
}

/** The override that applies to a page: "Hide" always; "Show" only on the origin it was given on. */
export function effectiveOverride(rec: TabOverrideRec | null | undefined, url: string | null | undefined): TabOverride | null {
  if (!rec) return null;
  if (rec.value === 'hide') return 'hide';
  const origin = pageOrigin(url ?? null);
  return origin && rec.origin === origin ? 'show' : null;
}

/** A "Show on this tab" the tab has navigated away from (it is dropped). */
export const overrideStale = (rec: TabOverrideRec | null | undefined, url: string | null | undefined): boolean => rec?.value === 'show' && effectiveOverride(rec, url) === null;

/** One tab's override. */
export async function readTabOverride(session: SessionArea, tabId: number): Promise<TabOverrideRec | null> {
  const k = overrideKey(tabId);
  const r = await session.get(k).catch(() => ({}) as Record<string, unknown>);
  return parseOverride(r[k]);
}

/** The tokens and the show/hide choices of every tab (one read of the whole area). */
export async function readTabState(session: SessionArea): Promise<{ tokens: Record<string, string>; overrides: Record<string, TabOverrideRec> }> {
  const all = asMap<unknown>(await session.get(null).catch(() => ({}) as Record<string, unknown>));
  const overrides: Record<string, TabOverrideRec> = {};
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    const tab = tabOfKey(k);
    if (tab === null) continue;
    if (k.startsWith(TOKEN_KEY_PREFIX)) {
      if (typeof v === 'string' && v) tokens[String(tab)] = v;
    } else {
      const rec = parseOverride(v);
      if (rec) overrides[String(tab)] = rec;
    }
  }
  return { tokens, overrides };
}

/**
 * Set (or with null clear) a tab's "Show on this tab" / "Hide on this tab" choice: one key per tab, no read first.
 * `url` is the tab's page: "Show" applies on its origin only.
 */
export async function setTabOverride(tabId: number, value: TabOverride | null, session: SessionArea, url?: string | null): Promise<void> {
  if (!value) return session.remove(overrideKey(tabId));
  const rec: TabOverrideRec = { value, origin: pageOrigin(url ?? null) };
  await session.set({ [overrideKey(tabId)]: rec });
}

/** The origins with a saved place (Settings "Saved positions"). */
export function placementOrigins(all: unknown): string[] {
  return Object.keys(asMap<unknown>(all)).filter((k) => pageOrigin(k) === k).sort();
}

/**
 * Settings "Reset position": forget the saved place of one origin (null: of every origin). The collapsed state is
 * forgotten too, so the card comes back open in its default corner.
 */
export function resetPlacements(all: unknown, origin: string | null): Record<string, unknown> {
  if (origin === null) return {};
  const next = asMap<unknown>(all);
  delete next[origin];
  return next;
}

/** The step kinds the widget runs itself: all of them since phase 1b (an unknown future kind points to the panel). */
export const WIDGET_STEP_KINDS: ReadonlySet<string> = new Set(['open', 'logout', 'instruction', 'check', 'capture', 'fill', 'login', 'email']);
export const widgetRunsKind = (kind: string): boolean => WIDGET_STEP_KINDS.has(kind);

/** The step kinds Alt+Shift+F fills (Fill form, Fill login), in the panel and in the widget. */
export const FILL_COMMAND_KINDS: ReadonlySet<string> = new Set(['fill', 'login']);

/**
 * Whether a widget takes an Alt+Shift+F press (widget.command): it is for this widget's tab, the walkthrough is active
 * and its current step (resolved, so the controls are there) is a fill or login step. Otherwise the panel gets it.
 */
export function widgetTakesFill(msg: unknown, me: { tabId: number; stepKind: string | null; resolved: boolean; active: boolean; originOk?: boolean }): boolean | null {
  const m = msg as { type?: unknown; command?: unknown; tabId?: unknown } | null;
  if (!m || m.type !== 'widget.command' || m.command !== 'fill-form') return null; // not a command: not answered
  if (m.tabId !== me.tabId) return null; // another tab's widget answers (or nobody: then the panel)
  // A page outside the run's app origins is filled from the panel only (it asks first): the widget lets it go there.
  return me.active && me.resolved && !!me.stepKind && FILL_COMMAND_KINDS.has(me.stepKind) && me.originOk !== false;
}

/**
 * Whether the widget or the panel may fill credentials or form data into a page without asking (review item 1):
 * the page's origin is one of the run's origins. `origins` undefined means "not known" (a run opened before origins
 * were stored, or a test host): allowed, as before. An empty list allows nothing.
 */
export function originAllowed(url: string | null | undefined, origins: readonly string[] | null | undefined): boolean {
  if (origins === undefined || origins === null) return true;
  const o = pageOrigin(url ?? null);
  return !!o && origins.includes(o);
}

// ---------------------------------------------------------------------------------------------------------------
// Eligibility

export interface EligibilityInput {
  /** The Settings switch "Show the step widget on app pages". */
  enabled: boolean;
  /** The walkthrough open in the tab's window (null: none). */
  active: ActiveWalkthrough | null;
  /** The tab's own choice, if any. */
  override?: TabOverride | null;
  /** The tab's URL. */
  url: string | null | undefined;
  /** 0 for the top frame (the widget never goes into frames). */
  frameId?: number;
  /** Settings "Hidden on these sites": origins where it never shows by itself (phase 2). */
  hiddenOrigins?: readonly string[];
}

export type EligibilityReason = 'ok' | 'shown-on-tab' | 'no-run' | 'hidden-on-tab' | 'hidden-on-site' | 'disabled' | 'not-http' | 'other-origin' | 'no-origins' | 'frame';

/**
 * Whether a tab gets the widget: the top frame of an http(s) page in a window with an open walkthrough, whose origin
 * is the run's origin or one of the project's appOrigins (exact match, port included), with the Settings switch on.
 * "Hide on this tab" always wins; "Show on this tab" (from the panel) shows it on any http(s) page of the window, also
 * with the switch off. A site on the Settings hide list ("Hidden on these sites") shows it only with "Show on this tab".
 * A run opened before origins were stored shows nowhere until the panel backfills them.
 */
export function widgetEligibility(i: EligibilityInput): { show: boolean; reason: EligibilityReason } {
  const no = (reason: EligibilityReason) => ({ show: false, reason });
  if ((i.frameId ?? 0) !== 0) return no('frame');
  if (!i.active) return no('no-run');
  if (i.override === 'hide') return no('hidden-on-tab');
  const origin = pageOrigin(i.url);
  if (!origin) return no('not-http');
  if (i.override === 'show') return { show: true, reason: 'shown-on-tab' };
  if (!i.enabled) return no('disabled');
  if (i.hiddenOrigins?.includes(origin)) return no('hidden-on-site');
  if (!i.active.origins?.length) return no('no-origins');
  if (!i.active.origins.includes(origin)) return no('other-origin');
  return { show: true, reason: 'ok' };
}

export const widgetEligible = (i: EligibilityInput): boolean => widgetEligibility(i).show;

/** The origins a run's widget shows on: the run's origin first, then the project's appOrigins (http(s) only, no duplicates). */
export function runOrigins(runOrigin: string | null | undefined, appOrigins: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const o of [runOrigin, ...(appOrigins ?? [])]) {
    const norm = pageOrigin(o ?? null);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Placement

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export const CORNERS: readonly Corner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

/** Where the card sits: a corner and the distances from that corner's two edges (px). */
export interface WidgetPlacement {
  corner: Corner;
  x: number;
  y: number;
  /** The bottom sheet's distance from the bottom edge (narrow viewports only). */
  sheetY?: number;
}

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  left: number;
  top: number;
}

/** Card width and margins. */
export const CARD_WIDTH = 340;
export const MARGIN = 16;
export const PILL_SIZE = 44;
/** Below this viewport width the card is a bottom sheet (full width minus 8 px, dragged up and down only). */
export const SHEET_BREAKPOINT = 480;
export const SHEET_INSET = 4;
/** The card's height is capped at this share of the viewport (it scrolls inside). */
export const MAX_HEIGHT_SHARE = 0.6;

export const isSheet = (viewportWidth: number): boolean => viewportWidth < SHEET_BREAKPOINT;

/** The first place: bottom-right, or bottom-left on right-to-left pages. */
export function defaultPlacement(rtl: boolean): WidgetPlacement {
  return { corner: rtl ? 'bottom-left' : 'bottom-right', x: MARGIN, y: MARGIN };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A saved placement as stored (anything malformed is null, so the default applies). */
export function parsePlacement(v: unknown): WidgetPlacement | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!CORNERS.includes(p.corner as Corner)) return null;
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
  const x = num(p.x);
  const y = num(p.y);
  if (x === null || y === null) return null;
  const sheetY = num(p.sheetY);
  return { corner: p.corner as Corner, x, y, ...(sheetY !== null ? { sheetY } : {}) };
}

/** The top-left point of a box of `size` placed at `p`, kept inside the viewport (after a resize, too). */
export function placementToPoint(p: WidgetPlacement, size: Size, viewport: Size): Point {
  const right = p.corner.endsWith('right');
  const bottom = p.corner.startsWith('bottom');
  const left = right ? viewport.width - size.width - p.x : p.x;
  const top = bottom ? viewport.height - size.height - p.y : p.y;
  return clampPoint({ left, top }, size, viewport);
}

/** A point kept inside the viewport with a small margin (a box larger than the viewport sticks to the top-left). */
export function clampPoint(pt: Point, size: Size, viewport: Size, margin = SHEET_INSET): Point {
  return {
    left: clamp(pt.left, margin, viewport.width - size.width - margin),
    top: clamp(pt.top, margin, viewport.height - size.height - margin),
  };
}

/**
 * Where a box let go at `pt` snaps: the corner nearest to its centre, keeping its distances from that corner's edges
 * (so it stays where it was dropped, and follows that corner when the window is resized).
 */
export function snapToCorner(pt: Point, size: Size, viewport: Size): WidgetPlacement {
  const c = clampPoint(pt, size, viewport);
  const cx = c.left + size.width / 2;
  const cy = c.top + size.height / 2;
  const right = cx >= viewport.width / 2;
  const bottom = cy >= viewport.height / 2;
  const corner = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as Corner;
  return {
    corner,
    x: Math.round(right ? viewport.width - size.width - c.left : c.left),
    y: Math.round(bottom ? viewport.height - size.height - c.top : c.top),
  };
}

/** Arrow-key move of the handle: 16 px (64 with Shift), clamped. */
export function nudge(pt: Point, key: string, shift: boolean, size: Size, viewport: Size): Point | null {
  const step = shift ? 64 : 16;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const m = d[key];
  if (!m) return null;
  return clampPoint({ left: pt.left + m[0], top: pt.top + m[1] }, size, viewport);
}

export interface Layout {
  sheet: boolean;
  left: number;
  top: number;
  width: number;
  /** The most the card may be tall (it scrolls inside beyond that). */
  maxHeight: number;
}

/** The card's box for a viewport: a corner card, or under 480 px a bottom sheet (full width minus 8 px). */
export function cardLayout(p: WidgetPlacement, height: number, viewport: Size): Layout {
  const maxHeight = Math.max(120, Math.floor(viewport.height * MAX_HEIGHT_SHARE));
  const h = Math.min(height, maxHeight);
  if (isSheet(viewport.width)) {
    const width = Math.max(0, viewport.width - 2 * SHEET_INSET);
    const y = p.sheetY ?? SHEET_INSET;
    const top = clamp(viewport.height - h - y, SHEET_INSET, viewport.height - h - SHEET_INSET);
    return { sheet: true, left: SHEET_INSET, top, width, maxHeight };
  }
  const width = Math.min(CARD_WIDTH, viewport.width - 2 * SHEET_INSET);
  const pt = placementToPoint(p, { width, height: h }, viewport);
  return { sheet: false, ...pt, width, maxHeight };
}

/** The pill's box: at the card's corner (bottom-right in the sheet). */
export function pillLayout(p: WidgetPlacement, viewport: Size): Point {
  const size = { width: PILL_SIZE, height: PILL_SIZE };
  if (isSheet(viewport.width)) return placementToPoint({ corner: 'bottom-right', x: MARGIN / 2, y: MARGIN / 2 }, size, viewport);
  return placementToPoint(p, size, viewport);
}

/** A box on the page (viewport coordinates), e.g. the app's Submit button the card should not cover. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The overlap area of two boxes (0 when they do not touch). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Room kept around a button the card avoids (px). */
export const AVOID_PAD = 8;

const totalOverlap = (box: Rect, avoid: readonly Rect[]) =>
  avoid.reduce((sum, r) => sum + overlapArea(box, { left: r.left - AVOID_PAD, top: r.top - AVOID_PAD, width: r.width + 2 * AVOID_PAD, height: r.height + 2 * AVOID_PAD }), 0);

/** The other corners to try, nearest first: the same edge across, then the other edge, then the diagonal. */
function cornerOrder(c: Corner): Corner[] {
  const [v, h] = c.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const fv = v === 'top' ? 'bottom' : 'top';
  const fh = h === 'left' ? 'right' : 'left';
  return [`${v}-${fh}`, `${fv}-${h}`, `${fv}-${fh}`] as Corner[];
}

/**
 * Where the card goes so it does not cover the page's highlighted or primary buttons (phase 2 auto-nudge): the
 * tester's own place when it covers none of them, else the first other corner (default margins) that covers none,
 * else the one that covers least (ties keep the tester's place). The bottom sheet moves to the top edge instead.
 * The result is never saved: when the button goes away, the card goes back to the tester's place.
 */
export function avoidPlacement(p: WidgetPlacement, height: number, viewport: Size, avoid: readonly Rect[]): { placement: WidgetPlacement; moved: boolean } {
  if (!avoid.length) return { placement: p, moved: false };
  const boxOf = (q: WidgetPlacement): Rect => {
    const l = cardLayout(q, height, viewport);
    return { left: l.left, top: l.top, width: l.width, height: Math.min(height, l.maxHeight) };
  };
  const here = totalOverlap(boxOf(p), avoid);
  if (here === 0) return { placement: p, moved: false };
  if (isSheet(viewport.width)) {
    const top: WidgetPlacement = { ...p, sheetY: Math.max(SHEET_INSET, viewport.height - Math.min(height, cardLayout(p, height, viewport).maxHeight) - SHEET_INSET) };
    return totalOverlap(boxOf(top), avoid) < here ? { placement: top, moved: true } : { placement: p, moved: false };
  }
  let best: { placement: WidgetPlacement; score: number } = { placement: p, score: here };
  for (const corner of cornerOrder(p.corner)) {
    const q: WidgetPlacement = { corner, x: MARGIN, y: MARGIN, ...(p.sheetY !== undefined ? { sheetY: p.sheetY } : {}) };
    const score = totalOverlap(boxOf(q), avoid);
    if (score === 0) return { placement: q, moved: true };
    if (score < best.score) best = { placement: q, score };
  }
  return { placement: best.placement, moved: best.placement !== p };
}

/** The pill's box for the avoid check (it sits at the card's corner). */
export function pillAvoidPlacement(p: WidgetPlacement, viewport: Size, avoid: readonly Rect[]): { placement: WidgetPlacement; moved: boolean } {
  if (!avoid.length || isSheet(viewport.width)) return { placement: p, moved: false };
  const boxOf = (q: WidgetPlacement): Rect => ({ ...pillLayout(q, viewport), width: PILL_SIZE, height: PILL_SIZE });
  if (totalOverlap(boxOf(p), avoid) === 0) return { placement: p, moved: false };
  for (const corner of cornerOrder(p.corner)) {
    const q: WidgetPlacement = { corner, x: MARGIN, y: MARGIN };
    if (totalOverlap(boxOf(q), avoid) === 0) return { placement: q, moved: true };
  }
  return { placement: p, moved: false };
}

/** The sheet's new distance from the bottom after a vertical drag to `top`. */
export function sheetYFromTop(top: number, height: number, viewport: Size): number {
  const t = clamp(top, SHEET_INSET, viewport.height - height - SHEET_INSET);
  return Math.round(viewport.height - height - t);
}

// ---------------------------------------------------------------------------------------------------------------
// Hub offline: the widget retries loading the run with a growing pause (seconds), and at once when the browser is back
// online or the tester presses Retry now.

export const RETRY_DELAYS_S: readonly number[] = [3, 6, 12, 30];
export const retryDelay = (failures: number): number => RETRY_DELAYS_S[Math.min(Math.max(0, failures - 1), RETRY_DELAYS_S.length - 1)];

/** Whether an error text means stubyard could not be reached at all (not an answer with an error status). */
export function unreachable(text: string | null | undefined): boolean {
  return !!text && /failed to fetch|networkerror|network error|load failed|err_connection|fetch failed|econnrefused/i.test(text);
}

/**
 * What the page-side live region (in the host's shadow root) may say: fixed, generic lines only. Step titles and other
 * run text never go into the page's DOM (review item 2); the frame speaks the full text from its own live region.
 */
export const HOST_ANNOUNCEMENTS = {
  step: 'stubyard step updated',
  finished: 'stubyard: all steps are finished',
  'wait-2fa': 'stubyard is waiting for the 2FA code',
  'wait-email': 'stubyard is waiting for the email',
  'wait-end': 'stubyard: the wait has ended',
  offline: 'stubyard is not reachable; the widget keeps retrying',
  online: 'stubyard is reachable again',
} as const;
export type HostAnnouncement = keyof typeof HOST_ANNOUNCEMENTS;
export const isHostAnnouncement = (k: unknown): k is HostAnnouncement => typeof k === 'string' && Object.prototype.hasOwnProperty.call(HOST_ANNOUNCEMENTS, k);

/** What the screen reader hears when the current step changes (null: nothing to say). */
export function stepAnnouncement(prev: string | null, next: { id: string; n: number; total: number; title: string } | null, finished: boolean): string | null {
  if (!next) return prev !== null && finished ? 'All steps are finished.' : null;
  if (prev === null || prev === next.id) return null; // the first step shown on a page load is not announced
  return `Step ${next.n} of ${next.total}: ${next.title}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The widget iframe's URL hash: #token=…

export function widgetHash(token: string): string {
  return `#token=${encodeURIComponent(token)}`;
}
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

/** What a minted token looks like (crypto.randomUUID): widget.html loads its app only for a fragment of this shape. */
export const TOKEN_RE = /^[A-Za-z0-9-]{16,128}$/;
export const tokenLooksValid = (t: string | null | undefined): boolean => !!t && TOKEN_RE.test(t);

/**
 * Whether a widget.hello is genuine: it came from our widget page, inside a tab, with the token minted for that tab's
 * current frame (`expected`: the stored one; it is single-use, so it is gone after the first good hello).
 */
export function helloAllowed(o: { token: unknown; senderUrl: string | undefined; widgetUrl: string; tabId: number | undefined; expected: string | null | undefined }): boolean {
  if (typeof o.token !== 'string' || !o.token || o.tabId === undefined) return false;
  if (!o.senderUrl || o.senderUrl.split('#')[0] !== o.widgetUrl) return false;
  return !!o.expected && o.expected === o.token;
}

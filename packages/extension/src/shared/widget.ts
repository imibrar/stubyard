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
/** chrome.storage.session: the token minted for each tab's widget (checked by widget.hello). */
export const TOKENS_KEY = 'widgetTokens';
/** chrome.storage.session: a per-tab choice from the panel ("Show on this tab") or the widget ("Hide on this tab"). */
export const TAB_OVERRIDE_KEY = 'widgetTabOverride';

export type TabOverride = 'show' | 'hide';

/** chrome.storage.session, or a fake in tests. */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const asMap = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, T>) } : {});

/** The tokens and the show/hide choices of every tab. */
export async function readTabState(session: SessionArea): Promise<{ tokens: Record<string, string>; overrides: Record<string, TabOverride> }> {
  const a = await session.get(TOKENS_KEY).catch(() => ({}) as Record<string, unknown>);
  const b = await session.get(TAB_OVERRIDE_KEY).catch(() => ({}) as Record<string, unknown>);
  const overrides: Record<string, TabOverride> = {};
  for (const [k, v] of Object.entries(asMap<unknown>(b[TAB_OVERRIDE_KEY]))) if (v === 'show' || v === 'hide') overrides[k] = v;
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(asMap<unknown>(a[TOKENS_KEY]))) if (typeof v === 'string' && v) tokens[k] = v;
  return { tokens, overrides };
}

/** Set (or with null clear) a tab's "Show on this tab" / "Hide on this tab" choice. */
export async function setTabOverride(tabId: number, value: TabOverride | null, session: SessionArea): Promise<void> {
  const { overrides } = await readTabState(session);
  if (value) overrides[String(tabId)] = value;
  else delete overrides[String(tabId)];
  await session.set({ [TAB_OVERRIDE_KEY]: overrides });
}

/** The step kinds the widget runs itself in phase 1a; login and email show "Continue in panel" (phase 1b). */
export const WIDGET_STEP_KINDS: ReadonlySet<string> = new Set(['open', 'logout', 'instruction', 'check', 'capture', 'fill']);
export const widgetRunsKind = (kind: string): boolean => WIDGET_STEP_KINDS.has(kind);

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
}

export type EligibilityReason = 'ok' | 'shown-on-tab' | 'no-run' | 'hidden-on-tab' | 'disabled' | 'not-http' | 'other-origin' | 'no-origins' | 'frame';

/**
 * Whether a tab gets the widget: the top frame of an http(s) page in a window with an open walkthrough, whose origin
 * is the run's origin or one of the project's appOrigins (exact match, port included), with the Settings switch on.
 * "Hide on this tab" always wins; "Show on this tab" (from the panel) shows it on any http(s) page of the window, also
 * with the switch off. A run opened before origins were stored shows nowhere until the panel backfills them.
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

/** The sheet's new distance from the bottom after a vertical drag to `top`. */
export function sheetYFromTop(top: number, height: number, viewport: Size): number {
  const t = clamp(top, SHEET_INSET, viewport.height - height - SHEET_INSET);
  return Math.round(viewport.height - height - t);
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

/** Whether a widget.hello is genuine: it came from our widget page, inside a tab, with the token minted for that tab. */
export function helloAllowed(o: { token: unknown; senderUrl: string | undefined; widgetUrl: string; tabId: number | undefined; tokens: Record<string, string> }): boolean {
  if (typeof o.token !== 'string' || !o.token || o.tabId === undefined) return false;
  if (!o.senderUrl || o.senderUrl.split('#')[0] !== o.widgetUrl) return false;
  return o.tokens[String(o.tabId)] === o.token;
}

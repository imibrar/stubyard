// Messages between the side panel and the content script (design §6.4).
// The data types mirror server/src/storyboards/schema.ts (§1.3) by hand: no cross-workspace import.
import type { RecordingConfig } from './recording';

/**
 * Bumped when the content script's message contract changes; `ping` returns it. A content script left on a page by
 * an older build (or by the extension before a reload) is replaced when the new one is injected (content/index.ts).
 */
export const CONTENT_VERSION = '0.7.0';

/** The attribute on the on-page widget's host element (docs/design/floating-widget.md); orphaned hosts are found by it. */
export const WIDGET_HOST_ATTR = 'data-stubyard-widget';
/** Set on the element a step highlights (for its 2 s); the on-page widget moves off it. */
export const HIGHLIGHT_ATTR = 'data-stubyard-target';
/** A suspended widget shows itself again after this long, even when the resume message never comes. */
export const WIDGET_AUTO_RESUME_MS = 1500;

export const FIELD_KINDS = ['auto', 'text', 'select', 'radio', 'checkbox', 'radix-select', 'radix-checkbox', 'radix-radio', 'date', 'otp', 'skip'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** A data-set entry after the server rendered its templates (§3.3). The content script never renders templates. */
export interface RenderedEntry {
  key: string;
  value: string | boolean | string[];
  kind: FieldKind;
  selector?: string;
  label?: string;
}

/** One form field found by a page scan (server `ScannedField`). */
export interface ScannedField {
  key: string;
  id: string | null;
  name: string | null;
  testId: string | null;
  kind: FieldKind;
  inputType: string | null;
  label: string | null;
  placeholder: string | null;
  value: string | boolean | string[] | null;
  options?: { value: string; label: string }[];
  required: boolean;
  visible: boolean;
  formId: string | null;
  duplicateKey: boolean;
}

export type ContentRequest =
  | { type: 'ping' }
  | { type: 'scan'; includeHidden?: boolean }
  /**
   * `origin` (0.6.0): fill only when the page is still on this origin (`location.origin`), else the handler throws. The
   * caller checked the tab's origin; this closes the gap between that check and the fill (a navigation, a redirect).
   */
  | { type: 'fill'; entries: RenderedEntry[]; formId?: string | null; overwrite?: boolean; origin?: string }
  | { type: 'probe'; selector: string }
  /** `secret` (0.7.0): a password or a 2FA code; a walkthrough recording always masks that field. */
  | { type: 'setValue'; selector: string; value: string; origin?: string; secret?: boolean }
  | { type: 'capture'; selector?: string; attribute?: string; textPattern?: string }
  | { type: 'assert'; textPresent?: string; selector?: string; urlMatches?: string }
  | { type: 'highlight'; selector?: string; text?: string }
  /** Hide the on-page widget for a screenshot; answered after two animation frames (none mounted: at once). */
  | { type: 'widget.suspend' }
  | { type: 'widget.resume' }
  /**
   * Show the widget (sent by the service worker; idempotent: a mounted widget keeps its frame). Top frame only. No
   * token any more (0.6.0): the host asks the worker for a fresh single-use one for every frame it makes.
   */
  | { type: 'widget.mount' }
  /** Take the widget off the page. */
  | { type: 'widget.unmount' }
  /** Alt+Shift+W: collapse or expand the widget (`collapsed` given: set it; else toggle). Never moves focus. */
  | { type: 'widget.toggle'; collapsed?: boolean }
  /**
   * Walkthrough recording (0.7.0; shared/recording.ts): record this page for the run, or follow a changed config
   * (step, pause, masks). Idempotent; sent by the service worker to the top frame of the run's app tabs.
   */
  | { type: 'recording.start'; config: RecordingConfig }
  /** Stop recording on this page (the last chunk is sent). */
  | { type: 'recording.stop' };

export interface PingResult { ok: true; version: string; url: string }
export interface ScanResult {
  url: string;
  title: string;
  forms: { formId: string | null; fields: ScannedField[] }[];
  fields: ScannedField[];
  duplicates: string[];
}
export type MatchedBy = 'selector' | 'id' | 'name' | 'testid' | 'label' | 'placeholder' | 'aria-label';
export type FillStatus = 'filled' | 'unmatched' | 'skipped' | 'error';
export interface FillDetail { key: string; status: FillStatus; matchedBy?: MatchedBy; kind?: string; reason?: string }
export interface FillReport { filled: number; unmatched: number; skipped: number; errors: number; details: FillDetail[] }
/** `origin`: the page's `location.origin` (0.6.0), so a wait knows where it would fill. */
export interface ProbeResult { present: boolean; visible: boolean; value: string | null; origin?: string }
export interface SetValueResult { ok: boolean; error?: string }
/** `error` is set when the selector or the pattern is invalid (an extension-side addition to §6.4). */
export interface CaptureResult { value: string | null; matchedText: string | null; error?: string }
export interface AssertResult { ok: boolean; details: string[] }
export interface HighlightResult { found: boolean }
/** `hidden`: how many widget hosts were hidden (0 when none is mounted). */
export interface WidgetSuspendResult { ok: true; hidden: number }
export interface WidgetResumeResult { ok: true }
/** `mounted`: whether a widget is on the page after the request. */
export interface WidgetMountResult { ok: true; mounted: boolean }
/** `mounted`: a widget is on the page (and shown); `collapsed`: its state after the request. */
export interface WidgetToggleResult { ok: true; mounted: boolean; collapsed: boolean }
/** `recording`: rrweb records now (false while paused or after the hub stopped it); `segment`: the segment key. */
export interface RecordingStatusResult { ok: true; recording: boolean; segment: string | null }
/** Returned instead of the normal result when a handler throws. */
export interface ContentError { error: string }

/** The response type for each request type. */
export interface ContentResponseMap {
  ping: PingResult;
  scan: ScanResult;
  fill: FillReport;
  probe: ProbeResult;
  setValue: SetValueResult;
  capture: CaptureResult;
  assert: AssertResult;
  highlight: HighlightResult;
  'widget.suspend': WidgetSuspendResult;
  'widget.resume': WidgetResumeResult;
  'widget.mount': WidgetMountResult;
  'widget.unmount': WidgetMountResult;
  'widget.toggle': WidgetToggleResult;
  'recording.start': RecordingStatusResult;
  'recording.stop': RecordingStatusResult;
}
export type ContentResponse<T extends ContentRequest['type']> = ContentResponseMap[T];

export type PanelMessage = { type: 'panel.command'; command: 'fill-form' };

/**
 * Service worker → the widget iframes (chrome.runtime.sendMessage): Alt+Shift+F goes to the widget of the active tab
 * first. Only the widget of `tabId` answers, with handled: true when it fills (its current step is a fill or login
 * step); otherwise the worker relays panel.command, so one press fills once.
 */
export type WidgetCommand = { type: 'widget.command'; command: 'fill-form'; tabId: number };
export interface WidgetCommandResult { handled: boolean }

// ---------------------------------------------------------------------------------------------------------------
// On-page widget (docs/design/floating-widget.md)

/** The Port the widget iframe opens to its tab's content script (chrome.tabs.connect(tabId, {frameId: 0, name})). */
export const WIDGET_PORT = 'stubyard-widget';

/** Widget iframe → content host, over the port. */
export type WidgetToHost =
  /** First message: the token from the iframe's URL, so the host only obeys its own frame. */
  | { t: 'ready'; token: string }
  /** The card's content height (the host sizes the frame, capped at 60vh). */
  | { t: 'size'; height: number }
  /** Esc or the Collapse button: show the pill (the frame stays loaded, hidden). */
  | { t: 'collapse' }
  /** "Hide on this tab": the widget writes the tab override; the service worker unmounts it. */
  | { t: 'hide' }
  /** For the pill: progress only (no step title: run text never goes into the page's DOM). */
  | { t: 'progress'; finished: number; total: number }
  /** A 2FA or email wait runs in the widget (the collapsed pill shows it). */
  | { t: 'busy'; on: boolean }
  /**
   * A screen-reader announcement (step changes, waits, the hub offline): the host speaks a fixed generic line for it
   * (HOST_ANNOUNCEMENTS in shared/widget.ts) from a live region in its shadow root, so it is heard also while the card
   * is collapsed. The full text (with the step title) is spoken by the frame's own live region.
   */
  | { t: 'announce'; kind: string }
  /** The run records this page (a red dot on the pill; amber-free): on, and paused. Booleans only. */
  | { t: 'recording'; on: boolean; paused: boolean };

/** Content host → widget iframe. */
export type HostToWidget =
  | { t: 'expanded'; expanded: boolean }
  /** The page came back from the back/forward cache: the frame is reloaded. */
  | { t: 'restored' };

/** Widget iframe → service worker (chrome.runtime.sendMessage). */
export type WidgetHello = { type: 'widget.hello'; token: string };
/**
 * Content host (top frame) → service worker: a fresh single-use token for the frame it is about to make. Only a
 * content script of this extension can send it (pages cannot reach chrome.runtime of the extension).
 */
export type WidgetTokenRequest = { type: 'widget.token' };
export type WidgetTokenResult = { token: string } | { error: 'denied' };
export type WidgetHelloResult = { tabId: number; windowId: number; url: string } | { error: 'denied' };

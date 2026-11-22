// Messages between the side panel and the content script (design §6.4).
// The data types mirror server/src/storyboards/schema.ts (§1.3) by hand: no cross-workspace import.

/**
 * Bumped when the content script's message contract changes; `ping` returns it. A content script left on a page by
 * an older build (or by the extension before a reload) is replaced when the new one is injected (content/index.ts).
 */
export const CONTENT_VERSION = '0.5.0';

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
  | { type: 'fill'; entries: RenderedEntry[]; formId?: string | null; overwrite?: boolean }
  | { type: 'probe'; selector: string }
  | { type: 'setValue'; selector: string; value: string }
  | { type: 'capture'; selector?: string; attribute?: string; textPattern?: string }
  | { type: 'assert'; textPresent?: string; selector?: string; urlMatches?: string }
  | { type: 'highlight'; selector?: string; text?: string }
  /** Hide the on-page widget for a screenshot; answered after two animation frames (none mounted: at once). */
  | { type: 'widget.suspend' }
  | { type: 'widget.resume' }
  /** Show the widget (sent by the service worker; idempotent: a mounted widget keeps its frame). Top frame only. */
  | { type: 'widget.mount'; token: string }
  /** Take the widget off the page. */
  | { type: 'widget.unmount' }
  /** Alt+Shift+W: collapse or expand the widget (`collapsed` given: set it; else toggle). Never moves focus. */
  | { type: 'widget.toggle'; collapsed?: boolean };

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
export interface ProbeResult { present: boolean; visible: boolean; value: string | null }
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
  /** For the pill: progress and the current step's title. */
  | { t: 'progress'; finished: number; total: number; title: string }
  /** A 2FA or email wait runs in the widget (the collapsed pill shows it). */
  | { t: 'busy'; on: boolean }
  /**
   * A screen-reader announcement (step changes, waits, the hub offline): the host speaks it from a live region in its
   * shadow root, so it is heard also while the card is collapsed (phase 2).
   */
  | { t: 'announce'; text: string };

/** Content host → widget iframe. */
export type HostToWidget =
  | { t: 'expanded'; expanded: boolean }
  /** The page came back from the back/forward cache: the frame is reloaded. */
  | { t: 'restored' };

/** Widget iframe → service worker (chrome.runtime.sendMessage). */
export type WidgetHello = { type: 'widget.hello'; token: string };
export type WidgetHelloResult = { tabId: number; windowId: number; url: string } | { error: 'denied' };

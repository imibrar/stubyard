// Messages between the side panel and the content script (design §6.4).
// The data types mirror server/src/storyboards/schema.ts (§1.3) by hand: no cross-workspace import.

/** Bumped when the content script's message contract changes; `ping` returns it. */
export const CONTENT_VERSION = '0.1.0';

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
  | { type: 'highlight'; selector?: string; text?: string };

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
}
export type ContentResponse<T extends ContentRequest['type']> = ContentResponseMap[T];

export type PanelMessage = { type: 'panel.command'; command: 'fill-form' };

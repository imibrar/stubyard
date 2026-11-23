// Walkthrough recording, R1 (docs/design/storyboards.md "Recording"): what the content script's recorder, the service
// worker and the views share. The recorder runs rrweb's record() in the content script of the run's app tabs (top
// frame only); the service worker uploads its chunks with the hub URL from the settings (the page never sees it).
import { WIDGET_HOST_ATTR } from './protocol';

/** How often the recorder sends what it has (and on pagehide / visibilitychange). */
export const FLUSH_MS = 5000;
/** A chunk is sent early once it holds this many events. */
export const FLUSH_EVENTS = 2000;
/** Chunks that failed for a network reason are kept for a retry, at most this many (older ones are dropped). */
export const MAX_RETRY_CHUNKS = 12;
/** The rrweb custom event that marks a step change (payload {stepId}); the dashboard player puts markers on it. */
export const STEP_EVENT_TAG = 'stubyard.step';

/** What the service worker tells a tab's recorder (content request recording.start; also sent on every change). */
export interface RecordingConfig {
  project: string;
  walkthroughId: string;
  /** The run's current step: segments are tagged with it and a change adds a step marker. */
  stepId: string | null;
  paused: boolean;
  maskAllInputs: boolean;
  /** Input selectors masked besides passwords (the run's 2FA code fields, one-time-code inputs, …). */
  maskSelectors: string[];
}

/** Content script → service worker: one chunk of a segment. */
export interface RecordingChunkMessage {
  type: 'recording.chunk';
  project: string;
  walkthroughId: string;
  segment: { key: string; url: string; startedAt: string; stepId: string | null };
  seq: number;
  events: unknown[];
  final: boolean;
}

/** The worker's answer: the hub's state (pauses, step changes, a stop at the cap) or why it failed. */
export type RecordingChunkReply =
  | { ok: true; state: { mode: 'off' | 'dom'; paused: boolean; stopped: string | null; currentStepId: string | null; status: string } }
  /** stop: recording must end (413 cap, 409 off, 404 gone, or the run is no longer this tab's); else retry later. */
  | { ok: false; error: string; stop: boolean; status?: number };

/** A view (panel or widget) saw the run change (step, pause, mode): the worker re-syncs the tabs' recorders. */
export type RecordingSyncMessage = { type: 'recording.sync' };

// ---------------------------------------------------------------------------------------------------------------
// Masking and the rrweb options

/** Never recorded: the on-page widget's host (a closed shadow root with the step widget) and anything stubyard marks. */
export const RECORD_BLOCK_SELECTOR = `[${WIDGET_HOST_ATTR}], [data-stubyard-ignore]`;

/** name / id / placeholder words of one-time code fields. */
const OTP_WORDS = /(^|[^a-z])(otp|totp|mfa|2fa|one[-_ ]?time|passcode|pin[-_ ]?code|verification[-_ ]?code|verify[-_ ]?code|auth[-_ ]?code|security[-_ ]?code|sms[-_ ]?code|cvc|cvv|csc)([^a-z]|$)/i;
const SENSITIVE_AUTOCOMPLETE = /\b(one-time-code|current-password|new-password|cc-number|cc-csc)\b/i;

/** Whether an input's value is masked in a recording when not every input is (passwords always are). */
export function isSensitiveInput(el: Element, maskSelectors: readonly string[], marked?: WeakSet<Element>): boolean {
  if (marked?.has(el)) return true;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password' || el.hasAttribute('data-rr-is-password')) return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
  for (const a of ['name', 'id', 'aria-label', 'placeholder', 'data-testid']) {
    const v = el.getAttribute(a);
    if (v && OTP_WORDS.test(v.replace(/([a-z])([A-Z])/g, '$1 $2'))) return true;
  }
  for (const sel of maskSelectors) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* an invalid selector from a recipe: ignore it */
    }
  }
  return false;
}

/** Every input type rrweb can mask; the mask function decides per element (unless every input is masked). */
const TEXT_LIKE = ['color', 'date', 'datetime-local', 'email', 'month', 'number', 'range', 'search', 'tel', 'text', 'time', 'url', 'week', 'textarea', 'select', 'password'] as const;

/** The rrweb record() options for a config (emit is added by the recorder). */
export function recordOptions(cfg: Pick<RecordingConfig, 'maskAllInputs' | 'maskSelectors'>, marked?: WeakSet<Element>) {
  const mask = (text: string) => '*'.repeat(Math.min(text.length, 32));
  return {
    blockSelector: RECORD_BLOCK_SELECTOR,
    maskAllInputs: cfg.maskAllInputs,
    maskInputOptions: Object.fromEntries(TEXT_LIKE.map((k) => [k, true])) as Record<(typeof TEXT_LIKE)[number], boolean>,
    maskInputFn: (text: string, el: HTMLElement) => (cfg.maskAllInputs || isSensitiveInput(el, cfg.maskSelectors, marked) ? mask(text) : text),
    sampling: { mousemove: 50, scroll: 150, input: 'last' as const, media: 800 },
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    recordCrossOriginIframes: false,
    slimDOMOptions: {
      script: true,
      comment: true,
      headFavicon: true,
      headWhitespace: true,
      headMetaSocial: true,
      headMetaRobots: true,
      headMetaHttpEquiv: true,
      headMetaVerification: true,
      headMetaAuthorship: true,
      headMetaDescKeywords: true,
    },
  };
}

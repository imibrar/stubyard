// Walkthrough recording, R1 (docs/design/storyboards.md "Recording"): what the content script's recorder, the service
// worker and the views share. The recorder runs rrweb's record() in the content script of the run's app tabs (top
// frame only); the service worker uploads its chunks with the hub URL from the settings (the page never sees it).
//
// Privacy (security review of R1, docs/drafts/recording-security.md): every input value is masked unless a
// storyboard's unmask list shows it and it does not look sensitive; hidden inputs and the widget are left out;
// contenteditable text is masked; text that looks like a secret (labelled keys and codes, known token shapes, values
// the extension typed) is masked in all page text; URLs lose their query values, fragments and token-like segments.
import { WIDGET_HOST_ATTR } from './protocol';

/** How often the recorder sends what it has (and on pagehide / visibilitychange). */
export const FLUSH_MS = 5000;
/** The recorder's tick: a chunk when one is due, else an empty heartbeat chunk that only reads the hub's state. */
export const HEARTBEAT_MS = 2000;
/** A chunk is sent early once it holds this many events. */
export const FLUSH_EVENTS = 2000;
/** ... or about this many bytes (the hub takes at most 8 MB of NDJSON per chunk). */
export const FLUSH_BYTES = 2 * 1024 * 1024;
/** One event larger than this cannot be uploaded (the hub's chunk cap less room for the JSON around it). */
export const MAX_EVENT_BYTES = 7 * 1024 * 1024;
/** Chunks that failed for a network reason are kept for a retry, at most this many (older ones are dropped). */
export const MAX_RETRY_CHUNKS = 12;
/** The rrweb custom event that marks a step change (payload {stepId}); the dashboard player puts markers on it. */
export const STEP_EVENT_TAG = 'stubyard.step';
/** The rrweb custom event that says why a page was not (fully) recorded (payload {kind, bytes, limit}). */
export const NOTE_EVENT_TAG = 'stubyard.note';

/** What the service worker tells a tab's recorder (content request recording.start; also sent on every change). */
export interface RecordingConfig {
  project: string;
  walkthroughId: string;
  /** The run's current step: segments are tagged with it and a change adds a step marker. */
  stepId: string | null;
  paused: boolean;
  /** Strict masking: every input value (the unmask list does not apply) and all page text. */
  maskAllInputs: boolean;
  /** Inputs that are sensitive besides the built-in checks (the run's 2FA code fields, the storyboard's list, …). */
  maskSelectors: string[];
  /** Inputs shown in clear (every other input value is masked); never applied to sensitive inputs. */
  unmaskSelectors: string[];
  /** Elements whose text is masked (contenteditable ones always are). */
  maskTextSelectors: string[];
  /** Elements left out of the recording (the widget and hidden inputs always are). */
  blockSelectors: string[];
}

/** Content script → service worker: one chunk of a segment (events [] and final false: a heartbeat). */
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
  | { ok: true; state: { mode: 'off' | 'dom' | 'video'; paused: boolean; stopped: string | null; currentStepId: string | null; status: string } }
  /**
   * stop: recording must end (413 cap, 409 off or ended, 404 gone, or the run is no longer this tab's); else retry
   * later. segmentFull: this segment is full, start a new one. tooLarge: the chunk is over the hub's chunk cap.
   */
  | { ok: false; error: string; stop: boolean; status?: number; segmentFull?: boolean; tooLarge?: boolean };

/** A view (panel or widget) saw the run change (step, pause, mode): the worker re-syncs the tabs' recorders. */
export type RecordingSyncMessage = { type: 'recording.sync' };

// ---------------------------------------------------------------------------------------------------------------
// Sensitive inputs

/** What the content script remembers about the page (content/sensitive.ts): fields that held secrets. */
export interface SensitiveMemory {
  /** Marked by the extension (a secret fill), ever a password input, or standing where a password input was. */
  isMarked(el: Element): boolean;
  /** A value the extension typed into a sensitive field (a field holding it is sensitive, page text hides it). */
  isSecretValue(value: string): boolean;
  /** Those values (for page text). */
  secretValues(): readonly string[];
}

/** Never recorded: the on-page widget's host (a closed shadow root), anything stubyard marks, hidden inputs. */
export const RECORD_BLOCK_SELECTOR = `[${WIDGET_HOST_ATTR}], [data-stubyard-ignore], [data-stubyard-block], input[type="hidden" i]`;
/** Text always masked: rich-text editors (contenteditable) and anything an app marks with data-stubyard-mask. */
export const MASK_TEXT_SELECTOR = '[contenteditable]:not([contenteditable="false" i]), [data-stubyard-mask]';

/** Words in a field's name / id / label / placeholder that make it sensitive (after camelCase is split). */
const SENSITIVE_WORDS = new RegExp(
  '(^|[^a-z])(' +
    [
      'otp', 'totp', 'hotp', 'mfa', '2fa', 'one[-_ ]?time', 'passcode', 'pin', 'pin[-_ ]?code', 'pincode',
      '(?:verification|verify|auth|security|sms|confirmation|access)[-_ ]?code', 'cvc', 'cvv', 'cvv2', 'csc', 'cid',
      'card', 'cardnumber', 'card[-_ ]?(?:no|num|number)', 'cc[-_ ]?(?:num|number|no)', 'ccnum', 'credit[-_ ]?card', 'creditcard', 'pan',
      'cc[-_ ]?exp', 'expiry', 'expiration', 'exp[-_ ]?(?:date|month|year|mm|yy)', 'mm[-_ /]?yy',
      'iban', 'bic', 'swift', 'account[-_ ]?(?:no|num|number)', 'routing', 'sort[-_ ]?code', 'ssn', 'social[-_ ]?security', 'tax[-_ ]?id', 'national[-_ ]?id',
      'password', 'passwd', 'pwd', 'pass', 'secret', 'token', 'api[-_ ]?key', 'apikey', 'access[-_ ]?key', 'private[-_ ]?key', 'secret[-_ ]?key', 'key', 'seed', 'mnemonic', 'recovery[-_ ]?code', 'backup[-_ ]?code',
    ].join('|') +
    ')([^a-z]|$)',
  'i',
);
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(\s|$)/i;
const NUMERIC_MODES = new Set(['numeric', 'decimal', 'tel']);

/** "cardNumber" → "card Number"; "otp_code" stays. */
const words = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');

/** Is this CSS selector valid here (a storyboard's lists may hold any text)? */
export function validSelector(sel: string): boolean {
  if (!sel || typeof sel !== 'string') return false;
  try {
    (globalThis.document ?? null)?.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}
const validList = (list: readonly string[] | undefined) => (list ?? []).filter(validSelector);

function matchesAny(el: Element, list: readonly string[]): boolean {
  for (const sel of list) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* an invalid selector from a recipe or a storyboard: ignore it */
    }
  }
  return false;
}

/** -webkit-text-security set on the field (inline, or by the page's CSS): the page shows it as dots. */
function hasTextSecurity(el: Element): boolean {
  const he = el as HTMLElement;
  const inline = he.style?.getPropertyValue?.('-webkit-text-security');
  if (inline && inline !== 'none') return true;
  // The attribute itself too: a style engine that does not know the property drops it from el.style.
  if (/-webkit-text-security\s*:\s*(?!none)[a-z]/i.test(el.getAttribute('style') ?? '')) return true;
  try {
    const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el) as (CSSStyleDeclaration & { webkitTextSecurity?: string }) | undefined;
    const v = cs?.getPropertyValue('-webkit-text-security') || cs?.webkitTextSecurity || '';
    return !!v && v !== 'none';
  } catch {
    return false;
  }
}

/** The texts that describe a field: name, id, labels, placeholder, aria-label, data-testid, autocomplete. */
function describers(el: Element): string[] {
  const out: string[] = [];
  for (const a of ['name', 'id', 'aria-label', 'placeholder', 'data-testid', 'autocomplete', 'title']) {
    const v = el.getAttribute(a);
    if (v) out.push(v);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels).slice(0, 3)) if (l.textContent) out.push(l.textContent.slice(0, 120));
  return out;
}

/**
 * Whether an input is sensitive: its value is masked in every recording (whatever the unmask list says) and shown as
 * dots while video records. Passwords (now or ever), the extension's secret fills, password / code / card / key
 * fields by autocomplete, name, label or placeholder, -webkit-text-security, short numeric code boxes (split OTP),
 * fields holding a value the extension typed as a secret, and the run's mask selectors.
 */
export function isSensitiveInput(el: Element, maskSelectors: readonly string[] = [], mem?: SensitiveMemory): boolean {
  if (mem?.isMarked(el)) return true;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password' || el.hasAttribute('data-rr-is-password')) return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
  for (const v of describers(el)) if (SENSITIVE_WORDS.test(words(v))) return true;
  // Split code boxes and PINs: a short numeric field (maxlength 1 to 8).
  const max = Number(el.getAttribute('maxlength'));
  if (Number.isInteger(max) && max >= 1 && max <= 8) {
    const mode = (el.getAttribute('inputmode') ?? '').toLowerCase();
    const pattern = el.getAttribute('pattern') ?? '';
    if (NUMERIC_MODES.has(mode) || type === 'tel' || type === 'number' || /\\d|\[0-9\]/.test(pattern) || max === 1) return true;
  }
  if (hasTextSecurity(el)) return true;
  const value = (el as HTMLInputElement).value;
  if (mem && typeof value === 'string' && value && mem.isSecretValue(value)) return true;
  return matchesAny(el, maskSelectors);
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets in page text

/** A labelled secret: "Your authenticator key: JBSW…", "API token = sk_…", "Recovery code: 1234-5678". */
const LABELLED = /\b(key|secret|token|password|passcode|passwd|pin|code|codes|seed|otp)(\s*[:=]\s*)([^\s<>"']{4,})/gi;
/** Token shapes: otpauth URIs, JWTs, provider keys, base32 seeds, long hex. */
const TOKEN_SHAPES = [
  /otpauth:\/\/[^\s<>"']+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?=[A-Z2-7]*[2-7])[A-Z2-7]{16,}={0,6}(?![A-Za-z0-9])/g,
  /\b[A-Z2-7]{4}(?:[ -][A-Z2-7]{4}){3,}\b/g,
  /\b[0-9a-fA-F]{32,}\b/g,
];
/** 13 to 19 digits (spaces or dashes between) passing the Luhn check: a card number. */
const DIGIT_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const stars = (s: string) => '*'.repeat(Math.min(s.length, 32));
/** Every character but whitespace as "*" (the layout stays). */
export const starText = (s: string) => s.replace(/\S/g, '*');

/** Text with what looks like a secret masked: values the extension typed, labelled secrets, token shapes, cards. */
export function maskSecretsInText(text: string, secrets: readonly string[] = []): string {
  if (text.length < 4) return text;
  let t = text;
  for (const s of secrets) if (s.length >= 4 && t.includes(s)) t = t.split(s).join(stars(s));
  t = t.replace(LABELLED, (_m, label: string, sep: string, value: string) => label + sep + stars(value));
  for (const re of TOKEN_SHAPES) t = t.replace(re, stars);
  t = t.replace(DIGIT_RUN, (m) => (luhn(m.replace(/\D/g, '')) ? stars(m) : m));
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// URLs (finding 4): the same rules as the hub's redactUrl (server/src/storyboards/recordings.ts).

const SLUG_RE = /^[a-z]+(?:-[a-z0-9]+)*$/;
function tokenish(seg: string): boolean {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    /* keep it */
  }
  if (s.length < 20 || !/\d/.test(s) || !/[A-Za-z]/.test(s)) return /^[0-9a-f]{24,}$/i.test(s);
  return !SLUG_RE.test(s);
}
const redactPath = (p: string) => p.split('/').map((seg) => (seg && tokenish(seg) ? '*' : seg)).join('/');
const redactQuery = (q: string) =>
  q
    .split('&')
    .map((part) => {
      const i = part.indexOf('=');
      if (i < 0) return tokenish(part) ? '*' : part;
      return part.slice(i + 1) === '' ? part : `${part.slice(0, i)}=*`;
    })
    .join('&');
function redactFragment(f: string): string {
  if (!f) return f;
  const q = f.indexOf('?');
  if (q >= 0) return redactPath(f.slice(0, q)) + '?' + redactQuery(f.slice(q + 1));
  if (f.includes('=')) return redactQuery(f);
  return redactPath(f);
}

/** An http(s) URL with query values, fragment values and token-like path segments as "*"; '' for anything else. */
export function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const search = u.search ? '?' + redactQuery(u.search.slice(1)) : '';
  const hash = u.hash ? '#' + redactFragment(u.hash.slice(1)) : '';
  return `${u.protocol}//${u.host}${redactPath(u.pathname)}${search}${hash}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The rrweb options

/** Every input type rrweb can mask; maskInputFn decides per element. */
const TEXT_LIKE = ['color', 'date', 'datetime-local', 'email', 'month', 'number', 'range', 'search', 'tel', 'text', 'time', 'url', 'week', 'textarea', 'select', 'password'] as const;

type MaskCfg = Pick<RecordingConfig, 'maskAllInputs' | 'maskSelectors'> & Partial<Pick<RecordingConfig, 'unmaskSelectors' | 'maskTextSelectors' | 'blockSelectors'>>;

/** The input value as recorded: masked unless the element is unmasked and not sensitive. */
export function maskInputValue(cfg: MaskCfg, text: string, el: Element | null | undefined, mem?: SensitiveMemory): string {
  if (!text) return text;
  if (!el || cfg.maskAllInputs) return stars(text);
  if (isSensitiveInput(el, cfg.maskSelectors, mem) || mem?.isSecretValue(text)) return stars(text);
  if (matchesAny(el, cfg.unmaskSelectors ?? [])) return text;
  return stars(text);
}

/** The rrweb record() options for a config (emit is added by the recorder). */
export function recordOptions(cfg: MaskCfg, mem?: SensitiveMemory) {
  const textSel = [MASK_TEXT_SELECTOR, ...validList(cfg.maskTextSelectors)].join(', ');
  return {
    blockSelector: [RECORD_BLOCK_SELECTOR, ...validList(cfg.blockSelectors)].join(', '),
    maskAllInputs: true,
    maskInputOptions: Object.fromEntries(TEXT_LIKE.map((k) => [k, true])) as Record<(typeof TEXT_LIKE)[number], boolean>,
    maskInputFn: (text: string, el: HTMLElement) => maskInputValue(cfg, text, el, mem),
    // Every text node goes through maskTextFn: masked whole in a contenteditable or a mask-text element (or
    // everywhere when masking is strict), else only what looks like a secret.
    maskTextSelector: '*',
    maskTextFn: (text: string, el: HTMLElement | null) => {
      if (cfg.maskAllInputs) return starText(text);
      try {
        if (el?.closest?.(textSel)) return starText(text);
      } catch {
        return starText(text);
      }
      return maskSecretsInText(text, mem?.secretValues() ?? []);
    },
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

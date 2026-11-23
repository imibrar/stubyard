// Video mode in the page (walkthrough recording R2): a video cannot mask anything afterwards, so while the tab is
// recorded as video every sensitive field shows dots (-webkit-text-security: disc) on screen, also while the tester
// types into it by hand: password inputs (also after a "show password" toggle or a swap for a text input), fields
// the extension filled with a secret, and fields that look like passwords, codes, card numbers or keys
// (shared/recording.ts isSensitiveInput, the same checks as DOM recording, with the run's mask selectors). A
// stylesheet covers what CSS can match before any script runs; the rest is marked per element on focus, on input,
// and when inputs appear or change type (content/sensitive.ts). The on-page widget collapses to its pill so its card
// stays out of the video. Everything is undone when video mode ends. Page text is not masked in a video.
import type { VideoModeResult, WidgetToggleResult } from '../shared/protocol';
import { validSelector } from '../shared/recording';
import type { SensitiveTracker } from './sensitive';

const PROP = '-webkit-text-security';
/** Set on a field while it shows dots for the video (the style is the mask; the attribute says why it is there). */
export const VIDEO_DOTS_ATTR = 'data-stubyard-video-dots';
/** What CSS alone can match (before the per-field checks run). */
export const VIDEO_DOTS_CSS = [
  'input[type="password" i]',
  `[${VIDEO_DOTS_ATTR}]`,
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete~="current-password" i]',
  'input[autocomplete~="new-password" i]',
  'input[autocomplete~="cc-number" i]',
  'input[autocomplete~="cc-csc" i]',
  'input[autocomplete~="cc-exp" i]',
  'input[inputmode="numeric" i][maxlength="1"]',
];

let on = false;
let collapsedByVideo = false;
let maskSelectors: string[] = [];
let tracker: SensitiveTracker | null = null;
let untrack: (() => void) | null = null;
let sheet: CSSStyleSheet | null = null;
const secretFields = new Set<HTMLElement>();
const hidden = new Set<HTMLElement>();
const saved = new WeakMap<HTMLElement, { value: string; priority: string }>();

function hide(el: HTMLElement): void {
  if (saved.has(el) || !el.style) return;
  saved.set(el, { value: el.style.getPropertyValue(PROP), priority: el.style.getPropertyPriority(PROP) });
  el.style.setProperty(PROP, 'disc', 'important');
  el.setAttribute(VIDEO_DOTS_ATTR, '');
  hidden.add(el);
}

function unhide(el: HTMLElement): void {
  const s = saved.get(el);
  if (!s) return;
  saved.delete(el);
  hidden.delete(el);
  el.removeAttribute(VIDEO_DOTS_ATTR);
  if (s.value) el.style.setProperty(PROP, s.value, s.priority);
  else el.style.removeProperty(PROP);
}

const isField = (el: unknown): el is HTMLInputElement | HTMLTextAreaElement => !!el && typeof el === 'object' && ((el as Element).localName === 'input' || (el as Element).localName === 'textarea');

/** Dots on this field when it is sensitive. */
function check(el: unknown): void {
  if (!on || !isField(el)) return;
  if (secretFields.has(el) || (tracker ? tracker.isSensitive(el, maskSelectors) : (el.getAttribute('type') ?? '').toLowerCase() === 'password')) hide(el);
}

const onFocusOrInput = (e: Event) => check(e.target);

function scanAll(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('input, textarea'))) check(el);
}

function addSheet(doc: Document): void {
  try {
    const Sheet = doc.defaultView?.CSSStyleSheet ?? CSSStyleSheet;
    const s = new Sheet();
    for (const sel of [...VIDEO_DOTS_CSS, ...maskSelectors.filter(validSelector)]) {
      try {
        s.insertRule(`${sel} { ${PROP}: disc !important; }`, s.cssRules.length);
      } catch {
        /* a selector this browser does not take */
      }
    }
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, s];
    sheet = s;
  } catch {
    sheet = null; // no constructable stylesheets: the per-field marks still apply
  }
}

function removeSheet(doc: Document): void {
  if (!sheet) return;
  try {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
  } catch {
    /* gone */
  }
  sheet = null;
}

export const videoModeOn = () => on;

/** The page's sensitive-field memory (installContent sets it): video mode asks it which fields to cover. */
export function setVideoTracker(t: SensitiveTracker | null): void {
  tracker = t;
}

/** A field the extension is about to type a secret into: dots now when video is on, and whenever it turns on. */
export function noteSecretField(el: Element | null | undefined): void {
  if (!el || !(el as HTMLElement).style) return;
  secretFields.add(el as HTMLElement);
  if (on) hide(el as HTMLElement);
}

/** Turn video mode on or off. widget: the page's widget host (collapse / expand; isCollapsed: its state now or null). */
export function setVideoMode(next: boolean, widget: { isCollapsed(): boolean | null; toggle(collapsed: boolean): WidgetToggleResult }, opts: { maskSelectors?: string[]; doc?: Document } = {}): VideoModeResult {
  const doc = opts.doc ?? document;
  for (const el of [...secretFields]) if (!el.isConnected) secretFields.delete(el);
  if (next) {
    const sels = (opts.maskSelectors ?? []).filter((s) => typeof s === 'string');
    const changed = sels.join('\n') !== maskSelectors.join('\n');
    maskSelectors = sels;
    if (!on || changed) {
      removeSheet(doc);
      addSheet(doc);
    }
    if (!on) {
      doc.addEventListener('focusin', onFocusOrInput, true);
      doc.addEventListener('input', onFocusOrInput, true);
      untrack = tracker?.onChange((els) => els.forEach(check)) ?? null;
    }
    on = true;
    for (const el of secretFields) hide(el);
    scanAll(doc);
    const c = widget.isCollapsed();
    if (c === false) {
      widget.toggle(true);
      collapsedByVideo = true;
    }
  } else if (on) {
    on = false;
    doc.removeEventListener('focusin', onFocusOrInput, true);
    doc.removeEventListener('input', onFocusOrInput, true);
    untrack?.();
    untrack = null;
    removeSheet(doc);
    for (const el of [...hidden]) unhide(el);
    if (collapsedByVideo && widget.isCollapsed() === true) widget.toggle(false);
    collapsedByVideo = false;
  }
  for (const el of [...hidden]) if (!el.isConnected) hidden.delete(el);
  return { ok: true, on, hidden: on ? hidden.size : 0 };
}

/** Tests: forget everything. */
export function resetVideoMode(doc: Document = document): void {
  doc.removeEventListener('focusin', onFocusOrInput, true);
  doc.removeEventListener('input', onFocusOrInput, true);
  untrack?.();
  untrack = null;
  removeSheet(doc);
  for (const el of [...hidden]) unhide(el);
  secretFields.clear();
  hidden.clear();
  maskSelectors = [];
  on = false;
  collapsedByVideo = false;
}

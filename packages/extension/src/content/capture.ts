// probe / setValue (login and 2FA), capture, assert and highlight handlers (§6.4, §6.7).
import type { AssertResult, CaptureResult, HighlightResult, ProbeResult, SetValueResult } from '../shared/protocol';
import { isDisabled, isValidSelector, isVisible, normText, queryAll, textValueOf } from './dom';
import { fillSelect, fillText } from './fill';

function firstVisible(selector: string): Element | undefined {
  return queryAll(document, selector).find(isVisible);
}

/** "/regex/flags" → RegExp; anything else → null (a plain substring). Throws on an invalid regex. */
export function parseRegex(s: string): RegExp | null {
  const m = /^\/(.+)\/([dgimsuvy]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : null;
}

function pageText(): string {
  const body = document.body;
  if (!body) return '';
  const inner = (body as HTMLElement).innerText;
  return typeof inner === 'string' && inner.trim() ? inner : body.textContent ?? '';
}

export function probe(selector: string): ProbeResult {
  const els = queryAll(document, selector);
  const vis = els.find(isVisible);
  const el = vis ?? els[0];
  return { present: els.length > 0, visible: !!vis, value: el ? textValueOf(el) : null };
}

/** Types a value into the first visible match (login username/password, 2FA code). */
export function setValue(selector: string, value: string): SetValueResult {
  if (!isValidSelector(selector)) return { ok: false, error: 'invalid selector "' + selector + '"' };
  const el = firstVisible(selector);
  if (!el) return { ok: false, error: 'no visible element matches "' + selector + '"' };
  if (isDisabled(el)) return { ok: false, error: '"' + selector + '" is disabled' };
  const r = el instanceof HTMLSelectElement ? fillSelect(el, value, true) : fillText(el, value, true);
  return r.status === 'error' ? { ok: false, error: r.reason } : { ok: true };
}

/** Reads a value from an element (attribute, input value or text), optionally narrowed by a regex (group 1 or the whole match). */
export function capture(o: { selector?: string; attribute?: string; textPattern?: string }): CaptureResult {
  let text: string;
  if (o.selector) {
    if (!isValidSelector(o.selector)) return { value: null, matchedText: null, error: 'invalid selector "' + o.selector + '"' };
    const els = queryAll(document, o.selector);
    const el = els.find(isVisible) ?? els[0];
    if (!el) return { value: null, matchedText: null };
    const raw = o.attribute ? el.getAttribute(o.attribute) : textValueOf(el);
    if (raw === null) return { value: null, matchedText: null };
    text = raw;
    if (!o.textPattern) return { value: normText(raw), matchedText: raw };
  } else {
    text = pageText();
  }
  if (!o.textPattern) return { value: null, matchedText: null, error: 'capture needs selector or textPattern' };
  let re: RegExp;
  try {
    re = parseRegex(o.textPattern) ?? new RegExp(o.textPattern);
  } catch (err) {
    return { value: null, matchedText: null, error: 'invalid textPattern: ' + (err instanceof Error ? err.message : String(err)) };
  }
  const m = re.exec(text);
  if (!m) return { value: null, matchedText: null };
  return { value: (m[1] ?? m[0]).trim(), matchedText: m[0] };
}

/** The step's automatic check: every given condition must hold. */
export function assertPage(o: { textPresent?: string; selector?: string; urlMatches?: string }): AssertResult {
  const details: string[] = [];
  let ok = true;
  if (o.textPresent !== undefined && o.textPresent !== '') {
    const has = normText(pageText()).toLowerCase().includes(normText(o.textPresent).toLowerCase());
    details.push((has ? 'ok: text present: ' : 'failed: text not found: ') + '"' + o.textPresent + '"');
    ok &&= has;
  }
  if (o.selector) {
    const valid = isValidSelector(o.selector);
    const els = valid ? queryAll(document, o.selector) : [];
    const vis = els.some(isVisible);
    details.push(!valid ? 'failed: invalid selector "' + o.selector + '"'
      : vis ? 'ok: element visible: ' + o.selector
        : els.length ? 'failed: element present but hidden: ' + o.selector
          : 'failed: no element matches ' + o.selector);
    ok &&= vis;
  }
  if (o.urlMatches) {
    const href = location.href;
    let hit: boolean;
    try {
      const re = parseRegex(o.urlMatches);
      hit = re ? re.test(href) : href.includes(o.urlMatches);
      details.push((hit ? 'ok: URL matches ' : 'failed: URL ' + href + ' does not match ') + o.urlMatches);
    } catch {
      hit = false;
      details.push('failed: invalid urlMatches regex ' + o.urlMatches);
    }
    ok &&= hit;
  }
  if (!details.length) details.push('nothing to check');
  return { ok, details };
}

const CLICKABLE = 'button, a, [role=button], [role=link], [role=tab], [role=menuitem], label, summary, input[type=submit], input[type=button]';

function findByText(text: string): Element | undefined {
  const want = normText(text).toLowerCase();
  if (!want) return undefined;
  const textOf = (e: Element) => normText(e instanceof HTMLInputElement ? e.value : e.textContent).toLowerCase();
  const clickables = queryAll(document, CLICKABLE).filter(isVisible);
  const exact = clickables.find((e) => textOf(e) === want);
  if (exact) return exact;
  const partial = clickables.find((e) => textOf(e).includes(want));
  if (partial) return partial;
  // the innermost visible element whose text contains it
  if (!document.body) return undefined;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (p && normText(n.textContent).toLowerCase().includes(want) && isVisible(p)) return p;
  }
  return undefined;
}

/** Outlines an element for 2 s and scrolls it into view. Never clicks. */
export function highlight(o: { selector?: string; text?: string }, ms = 2000): HighlightResult {
  const el = (o.selector && isValidSelector(o.selector) ? firstVisible(o.selector) : undefined) ?? (o.text ? findByText(o.text) : undefined);
  if (!el) return { found: false };
  const h = el as HTMLElement;
  const prev = { outline: h.style.outline, outlineOffset: h.style.outlineOffset };
  h.style.outline = '3px solid #f59e0b';
  h.style.outlineOffset = '2px';
  h.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  setTimeout(() => {
    h.style.outline = prev.outline;
    h.style.outlineOffset = prev.outlineOffset;
  }, ms);
  return { found: true };
}

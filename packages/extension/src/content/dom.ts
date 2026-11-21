// DOM helpers shared by match, fill, radix, scan and capture.

/** Trimmed, "*" removed, whitespace collapsed (case kept; compare with `sameText`). */
export function normText(s: string | null | undefined): string {
  return (s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normText(a).toLowerCase() === normText(b).toLowerCase();
}

export function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

/** Attribute-selector string literal. */
export function attrValue(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** querySelectorAll that returns [] for an invalid selector instead of throwing. */
export function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function isValidSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Visible = has client rects, not visibility:hidden, no display:none or [hidden] ancestor, and not itself aria-hidden.
 * Radix's hidden native <select> is aria-hidden, so it never counts as a target.
 */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.getClientRects().length === 0) return false;
  if (el.closest('[hidden]')) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  const own = view.getComputedStyle(el);
  if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
  // getClientRects already covers display:none ancestors in a real browser; the walk keeps DOM shims honest.
  for (let a: Element | null = el; a; a = a.parentElement) {
    if (view.getComputedStyle(a).display === 'none') return false;
  }
  return true;
}

export function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (el.hasAttribute('data-disabled')) return true;
  return !!el.closest('fieldset[disabled]');
}

export function isReadOnly(el: Element): boolean {
  return (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true';
}

/** The text of the label that names this control: label[for], an enclosing label, aria-labelledby, then aria-label. */
export function labelOf(el: Element): string | null {
  const doc = el.ownerDocument;
  if (el.id) {
    const lab = doc.querySelector('label[for=' + attrValue(el.id) + ']');
    if (lab) return normText(lab.textContent) || null;
  }
  const enclosing = el.closest('label');
  if (enclosing) return normText(enclosing.textContent) || null;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
    if (normText(text)) return normText(text);
  }
  const aria = el.getAttribute('aria-label');
  return aria ? normText(aria) || null : null;
}

/** Controls that can sit in a label-scope (§6.5 step 5). */
export const SCOPE_CONTROLS = '[role=radio], [role=checkbox], [role=switch], [role=radiogroup], [role=combobox], input:not([type=hidden]), select, textarea';

/** The nearest ancestor of a label (up to 3 levels) that holds a control. */
export function labelScope(label: Element): Element | null {
  let a: Element | null = label.parentElement;
  for (let i = 0; i < 3 && a; i++, a = a.parentElement) {
    if (queryAll(a, SCOPE_CONTROLS).some((c) => !label.contains(c))) return a;
  }
  return null;
}

/** Sets a value through the prototype setter so React's value tracker sees a change, then fires input + change. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves with the first truthy result of `check`, re-checked on DOM mutations and every 50 ms; null after `timeoutMs`. */
export function waitFor<T>(check: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  const first = check();
  if (first) return Promise.resolve(first);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(tick);
      clearTimeout(timer);
      resolve(v);
    };
    const test = () => {
      const v = check();
      if (v) finish(v);
    };
    const obs = new MutationObserver(test);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const tick = setInterval(test, 50);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export function keydown(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
}

export function textValueOf(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  return normText((el as HTMLElement).innerText ?? el.textContent);
}

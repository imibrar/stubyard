// The fill engine (§6.5). Fills visible fields only, entries one after another. It never submits, never presses Enter
// in text fields and never clicks buttons other than select triggers/options and checkbox/radio controls.
import type { FieldKind, FillDetail, FillReport, RenderedEntry } from '../shared/protocol';
import { isDisabled, isReadOnly, isVisible, labelOf, normText, queryAll, sameText, setNativeValue } from './dom';
import { type DetectedKind, type Target, detectKind, findTarget, formScope } from './match';
import { type RadixTimings, type StepResult, fillRadixSelect } from './radix';

export interface FillOptions { formId?: string | null; overwrite?: boolean; timings?: Partial<RadixTimings> }

const TRUE_WORDS = ['true', 'on', 'yes'];
const FALSE_WORDS = ['false', 'off', 'no', ''];
function isBoolish(v: string): boolean {
  const s = v.trim().toLowerCase();
  return TRUE_WORDS.includes(s) || FALSE_WORDS.includes(s);
}
function truthy(v: RenderedEntry['value']): boolean {
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  return TRUE_WORDS.includes(v.trim().toLowerCase());
}
function toStr(v: RenderedEntry['value']): string {
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
function digits(s: string): string {
  return s.replace(/\D/g, '');
}
function quoteList(items: string[]): string {
  return items.slice(0, 10).map((x) => '"' + x + '"').join(', ') + (items.length > 10 ? ', …' : '');
}

// ---- text / date / otp ----
export function fillText(el: Element, value: string, overwrite: boolean): StepResult {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return { status: 'error', reason: 'not a text field (<' + el.tagName.toLowerCase() + '>)' };
  }
  if (el.value === value) return { status: 'skipped', reason: 'already set' };
  if (!overwrite && el.value !== '') return { status: 'skipped', reason: 'has a value (overwrite is off)' };
  el.focus();
  setNativeValue(el, value);
  el.blur();
  if (el.value !== value) {
    if (digits(value) !== '' && digits(el.value) === digits(value)) return { status: 'filled' };
    return { status: 'error', reason: 'field rewrote the value to "' + el.value + '"' };
  }
  return { status: 'filled' };
}

// ---- native select ----
function findOption(options: HTMLOptionElement[], want: string): HTMLOptionElement | undefined {
  return options.find((o) => o.value === want)
    ?? options.find((o) => normText(o.text) === normText(want))
    ?? options.find((o) => sameText(o.text, want));
}

export function fillSelect(el: Element, value: RenderedEntry['value'], overwrite: boolean): StepResult {
  if (!(el instanceof HTMLSelectElement)) return { status: 'error', reason: 'not a <select> (<' + el.tagName.toLowerCase() + '>)' };
  const options = Array.from(el.options);
  const noOption = (w: string): StepResult => ({ status: 'error', reason: 'no option "' + w + '" (options: ' + quoteList(options.map((o) => normText(o.text))) + ')' });
  if (el.multiple && Array.isArray(value)) {
    const picked: HTMLOptionElement[] = [];
    for (const w of value) {
      const o = findOption(options, w);
      if (!o) return noOption(w);
      picked.push(o);
    }
    if (options.every((o) => o.selected === picked.includes(o))) return { status: 'skipped', reason: 'already set' };
    for (const o of options) o.selected = picked.includes(o);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { status: 'filled' };
  }
  const want = Array.isArray(value) ? (value[0] ?? '') : String(value);
  const opt = findOption(options, want);
  if (!opt) return noOption(want);
  if (el.value === opt.value) return { status: 'skipped', reason: 'already set' };
  if (!overwrite && el.value !== '') return { status: 'skipped', reason: 'has a value (overwrite is off)' };
  setNativeValue(el, opt.value);
  return el.value === opt.value ? { status: 'filled' } : { status: 'error', reason: 'the select did not take "' + want + '"' };
}

// ---- checkboxes and radios (native and Radix) ----
const nativeChecked = (e: Element) => (e as HTMLInputElement).checked;
const ariaChecked = (e: Element) => e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-state') === 'checked';

/** Does this control stand for the wanted option? By its value attribute (not the default "on") or its label text. */
function isOption(el: Element, want: string): boolean {
  const v = el.getAttribute('value');
  if (v !== null && v !== 'on' && sameText(v, want)) return true;
  return sameText(labelOf(el), want);
}
function optionName(el: Element): string {
  const v = el.getAttribute('value');
  return labelOf(el) ?? (v && v !== 'on' ? v : '?');
}

function fillChecks(els: Element[], value: RenderedEntry['value'], checked: (e: Element) => boolean): StepResult {
  const usable = els.filter((e) => !isDisabled(e));
  if (!usable.length) return { status: 'skipped', reason: 'disabled' };
  const asList = Array.isArray(value) || (els.length > 1 && typeof value === 'string' && !isBoolish(value));
  let clicks = 0;
  if (asList) {
    const wanted = Array.isArray(value) ? value : [String(value)];
    const missing = wanted.filter((w) => !els.some((e) => isOption(e, w)));
    if (missing.length) return { status: 'error', reason: 'no option "' + missing[0] + '" (options: ' + quoteList(els.map(optionName)) + ')' };
    for (const e of usable) {
      const desired = wanted.some((w) => isOption(e, w));
      if (checked(e) !== desired) { (e as HTMLElement).click(); clicks++; }
    }
  } else {
    const desired = truthy(value);
    for (const e of usable.slice(0, 1)) {
      if (checked(e) !== desired) { (e as HTMLElement).click(); clicks++; }
    }
  }
  return clicks ? { status: 'filled' } : { status: 'skipped', reason: 'already set' };
}

function fillRadios(els: Element[], value: RenderedEntry['value'], checked: (e: Element) => boolean, overwrite: boolean): StepResult {
  const want = Array.isArray(value) ? (value[0] ?? '') : String(value);
  const hit = els.find((e) => isOption(e, want));
  if (!hit) return { status: 'error', reason: 'no option "' + want + '" (options: ' + quoteList(els.map(optionName)) + ')' };
  if (checked(hit)) return { status: 'skipped', reason: 'already set' };
  if (!overwrite && els.some(checked)) return { status: 'skipped', reason: 'has a value (overwrite is off)' };
  if (isDisabled(hit)) return { status: 'skipped', reason: 'disabled' };
  (hit as HTMLElement).click();
  return { status: 'filled' };
}

function members(t: Target, selector: string, self: (e: Element) => boolean): Element[] {
  if (t.group) return t.group;
  if (t.scope) {
    const inScope = queryAll(t.scope, selector).filter(isVisible);
    if (inScope.length) return inScope;
  }
  return self(t.el) ? [t.el] : [];
}

function radixRadioScope(t: Target): Element {
  if (t.scope) return t.scope;
  if (t.el.getAttribute('role') === 'radiogroup') return t.el;
  return t.el.closest('[role=radiogroup]') ?? t.el.parentElement ?? t.el;
}

const isNative = (type: string) => (e: Element) => e instanceof HTMLInputElement && e.type === type;

// ---- one entry ----
async function fillOne(entry: RenderedEntry, root: ParentNode, o: FillOptions): Promise<FillDetail> {
  const overwrite = o.overwrite ?? true;
  if (entry.kind === 'skip') return { key: entry.key, status: 'skipped', kind: 'skip', reason: 'kind is skip' };
  const m = findTarget(entry, root);
  if ('reason' in m) return { key: entry.key, status: m.reason.startsWith('invalid selector') ? 'error' : 'unmatched', reason: m.reason };
  const kind: DetectedKind | FieldKind = entry.kind === 'auto' ? detectKind(m) : entry.kind;
  const base = { key: entry.key, matchedBy: m.matchedBy, kind };
  if (kind === 'file') return { ...base, status: 'skipped', reason: 'file upload not supported in v1' };
  if (kind === 'contenteditable') return { ...base, status: 'skipped', reason: 'rich-text (contenteditable) fields are not supported in v1' };
  const groupKind = kind === 'radio' || kind === 'checkbox' || kind === 'radix-radio' || kind === 'radix-checkbox';
  if (!groupKind) {
    if (isDisabled(m.el)) return { ...base, status: 'skipped', reason: 'disabled' };
    if (isReadOnly(m.el)) return { ...base, status: 'skipped', reason: 'read-only' };
  }
  let r: StepResult;
  switch (kind) {
    case 'text': case 'date': case 'otp':
      r = fillText(m.el, toStr(entry.value), overwrite);
      break;
    case 'select':
      r = fillSelect(m.el, entry.value, overwrite);
      break;
    case 'checkbox':
      r = fillChecks(members(m, 'input[type=checkbox]', isNative('checkbox')), entry.value, nativeChecked);
      break;
    case 'radio':
      r = fillRadios(members(m, 'input[type=radio]', isNative('radio')), entry.value, nativeChecked, overwrite);
      break;
    case 'radix-checkbox':
      r = fillChecks(members(m, '[role=checkbox], [role=switch]', (e) => ['checkbox', 'switch'].includes(e.getAttribute('role') ?? '')), entry.value, ariaChecked);
      break;
    case 'radix-radio': {
      const radios = queryAll(radixRadioScope(m), '[role=radio]').filter(isVisible);
      r = fillRadios(radios.length ? radios : [m.el], entry.value, ariaChecked, overwrite);
      break;
    }
    case 'radix-select':
      r = await fillRadixSelect(m.el, Array.isArray(entry.value) ? (entry.value[0] ?? '') : String(entry.value), { overwrite, timings: o.timings });
      break;
    default:
      r = { status: 'error', reason: 'unsupported kind "' + kind + '"' };
  }
  return { ...base, status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
}

/** Fills the entries in order and reports each one. */
export async function fillForm(entries: RenderedEntry[], o: FillOptions = {}): Promise<FillReport> {
  const root = formScope(o.formId);
  const details: FillDetail[] = [];
  for (const entry of entries) {
    try {
      details.push(await fillOne(entry, root, o));
    } catch (err) {
      details.push({ key: entry.key, status: 'error', reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const count = (s: FillDetail['status']) => details.filter((d) => d.status === s).length;
  return { filled: count('filled'), unmatched: count('unmatched'), skipped: count('skipped'), errors: count('error'), details };
}

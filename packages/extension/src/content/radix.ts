// Radix/shadcn Select (§6.5 "radix-select"): open the trigger, click the option by visible text, wait for it to close.
import { isVisible, keydown, normText, queryAll, sameText, waitFor } from './dom';

export interface RadixTimings { open: number; listbox: number; close: number }
export const RADIX_TIMINGS: RadixTimings = { open: 300, listbox: 1500, close: 500 };

export interface StepResult { status: 'filled' | 'skipped' | 'error'; reason?: string }

/** The hidden native <select> Radix renders next to the trigger inside a form (value → option text map). */
export function siblingNativeSelect(trigger: Element): HTMLSelectElement | null {
  for (let s = trigger.nextElementSibling; s; s = s.nextElementSibling) {
    if (s instanceof HTMLSelectElement) return s;
    if (s.getAttribute('role') === 'combobox') return null;
  }
  return null;
}

/** The trigger's shown text, or null while it shows its placeholder. */
export function triggerText(trigger: Element): string | null {
  if (trigger.hasAttribute('data-placeholder')) return null;
  return normText(trigger.textContent) || null;
}

function findListbox(trigger: Element, before: Set<Element>): Element | null {
  const doc = trigger.ownerDocument;
  const id = trigger.getAttribute('aria-controls');
  const ctl = id ? doc.getElementById(id) : null;
  if (ctl) {
    const lb = ctl.getAttribute('role') === 'listbox' ? ctl : ctl.querySelector('[role=listbox]');
    if (lb && isVisible(lb)) return lb;
  }
  const fresh = queryAll(doc, '[role=listbox]').filter((l) => !before.has(l) && isVisible(l));
  return fresh.length ? fresh[fresh.length - 1] : null;
}

function pointerDown(el: Element): void {
  const init = { bubbles: true, cancelable: true, button: 0, ctrlKey: false, pointerType: 'mouse' };
  el.dispatchEvent(typeof PointerEvent === 'function' ? new PointerEvent('pointerdown', init) : new MouseEvent('pointerdown', init));
}

function pickOption(options: Element[], labels: string[]): Element | undefined {
  const texts = options.map((o) => normText(o.textContent));
  for (const l of labels) {
    const want = normText(l);
    const i = texts.indexOf(want);
    if (i >= 0) return options[i];
  }
  for (const l of labels) {
    const hit = options.find((o) => sameText(o.textContent, l));
    if (hit) return hit;
  }
  for (const l of labels) {
    const want = normText(l).toLowerCase();
    if (!want) continue;
    const hit = options.find((o) => normText(o.textContent).toLowerCase().startsWith(want));
    if (hit) return hit;
  }
  return undefined;
}

export async function fillRadixSelect(trigger: Element, value: string, o: { overwrite: boolean; timings?: Partial<RadixTimings> }): Promise<StepResult> {
  const t = { ...RADIX_TIMINGS, ...o.timings };
  // 4. candidate labels: the native option text for a value, then the value itself
  const labels: string[] = [];
  const native = siblingNativeSelect(trigger);
  const nativeOpt = native ? Array.from(native.options).find((op) => op.value === value && op.value !== '') : undefined;
  if (nativeOpt && normText(nativeOpt.text)) labels.push(nativeOpt.text);
  labels.push(value);

  // 1. already showing the target
  const shown = triggerText(trigger);
  if (shown !== null && labels.some((l) => sameText(l, shown))) return { status: 'skipped', reason: 'already set' };
  if (!o.overwrite && shown !== null) return { status: 'skipped', reason: 'has a value (overwrite is off)' };

  // 2. open: pointerdown, then keyboard
  const before = new Set(queryAll(trigger.ownerDocument, '[role=listbox]').filter(isVisible));
  const find = () => findListbox(trigger, before);
  pointerDown(trigger);
  let lb = await waitFor(find, t.open);
  if (!lb) {
    (trigger as HTMLElement).focus();
    keydown(trigger, 'Enter');
    lb = await waitFor(find, t.open);
    if (!lb) {
      keydown(trigger, 'ArrowDown');
      // 3. wait for the listbox
      lb = await waitFor(find, t.listbox);
    }
  }
  if (!lb) return { status: 'error', reason: 'the dropdown did not open' };
  const listbox = lb;
  const closed = () => !listbox.isConnected || !isVisible(listbox);

  // 5. the option by visible text
  const options = queryAll(listbox, '[role=option]');
  const opt = pickOption(options, labels);
  if (!opt) {
    // 6. close and report the options
    keydown(listbox, 'Escape');
    await waitFor(closed, t.close);
    const names = options.slice(0, 10).map((x) => '"' + normText(x.textContent) + '"').join(', ');
    return { status: 'error', reason: 'no option "' + value + '" (options: ' + (names || 'none') + (options.length > 10 ? ', …' : '') + ')' };
  }
  if (opt.getAttribute('aria-disabled') === 'true' || opt.hasAttribute('data-disabled')) {
    keydown(listbox, 'Escape');
    await waitFor(closed, t.close);
    return { status: 'error', reason: 'option "' + normText(opt.textContent) + '" is disabled' };
  }
  (opt as HTMLElement).scrollIntoView?.({ block: 'nearest' });
  (opt as HTMLElement).focus();
  (opt as HTMLElement).click();

  // 7. wait for it to close before the next entry; fallback Enter on the focused option
  if (!(await waitFor(closed, t.close))) {
    keydown(opt, 'Enter');
    if (!(await waitFor(closed, t.close))) {
      keydown(listbox, 'Escape');
      return { status: 'error', reason: 'the dropdown stayed open after choosing "' + normText(opt.textContent) + '"' };
    }
  }
  return { status: 'filled' };
}

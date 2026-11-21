// Finds the element for a data entry (§6.5 "Match"). First hit wins, visible elements only.
import type { FieldKind, MatchedBy, RenderedEntry } from '../shared/protocol';
import { SCOPE_CONTROLS, attrValue, cssEscape, isVisible, labelScope, normText, queryAll, sameText } from './dom';

export interface Target {
  /** The control (for groups: the first visible member). */
  el: Element;
  matchedBy: MatchedBy;
  /** Every element of a same-name radio/checkbox group. */
  group?: Element[];
  /** Label-scope container (radio groups and multi-selects without an id). */
  scope?: Element;
}
export type MatchResult = Target | { reason: string };

export const NOT_ON_PAGE = 'not on this page (later wizard step?)';

/** The form named by `formId` (form#id, then form[name]); the document when it is not given or not found. */
export function formScope(formId: string | null | undefined, doc: Document = document): ParentNode {
  if (!formId) return doc;
  return doc.querySelector('form#' + cssEscape(formId)) ?? doc.querySelector('form[name=' + attrValue(formId) + ']') ?? doc;
}

function firstVisible(els: Element[]): Element | undefined {
  return els.find(isVisible);
}

function groupOf(el: Element, root: ParentNode): Element[] | undefined {
  const name = el.getAttribute('name');
  const type = (el as HTMLInputElement).type;
  if (!(el instanceof HTMLInputElement) || !name || (type !== 'radio' && type !== 'checkbox')) return undefined;
  const all = queryAll(root, 'input[name=' + attrValue(name) + ']').filter((e) => (e as HTMLInputElement).type === type && isVisible(e));
  return all.length > 1 || type === 'radio' ? all : undefined;
}

function fromScope(scope: Element, label: Element | null, matchedBy: MatchedBy): Target | null {
  const controls = queryAll(scope, SCOPE_CONTROLS).filter((c) => (!label || !label.contains(c)) && isVisible(c));
  if (!controls.length) return null;
  return { el: controls[0], matchedBy, scope };
}

/** A label-scope target for a label (its `for`, a nested control, or the controls around it). */
function fromLabel(label: HTMLLabelElement, root: ParentNode): Target | null {
  const doc = label.ownerDocument;
  if (label.htmlFor) {
    const byFor = doc.getElementById(label.htmlFor);
    if (byFor) {
      if (!isVisible(byFor)) return null;
      const group = groupOf(byFor, root);
      return { el: byFor, matchedBy: 'label', ...(group ? { group } : {}) };
    }
  }
  const nested = firstVisible(queryAll(label, SCOPE_CONTROLS));
  if (nested) {
    const group = groupOf(nested, root);
    return { el: nested, matchedBy: 'label', ...(group ? { group } : {}) };
  }
  const scope = labelScope(label);
  return scope && isVisible(label) ? fromScope(scope, label, 'label') : null;
}

export function findTarget(entry: Pick<RenderedEntry, 'key' | 'selector'>, root: ParentNode = document): MatchResult {
  const key = entry.key;
  const doc = (root as Node).ownerDocument ?? (root as Document);

  // 1. explicit selector (overrides key matching)
  if (entry.selector) {
    let els: Element[];
    try {
      els = Array.from(root.querySelectorAll(entry.selector));
    } catch {
      return { reason: 'invalid selector "' + entry.selector + '"' };
    }
    const el = firstVisible(els);
    if (!el) return { reason: NOT_ON_PAGE };
    const group = groupOf(el, root);
    return { el, matchedBy: 'selector', ...(group ? { group } : {}) };
  }

  // 2. id
  const byId = firstVisible(queryAll(root, '#' + cssEscape(key)));
  if (byId) {
    const group = groupOf(byId, root);
    return { el: byId, matchedBy: 'id', ...(group ? { group } : {}) };
  }
  // Special rule: a label points at this id but no element has it (FormRenderer radio groups, multi-selects) → label-scope.
  if (!doc.getElementById(key)) {
    for (const label of queryAll(root, 'label[for=' + attrValue(key) + ']')) {
      const scope = isVisible(label) ? labelScope(label) : null;
      const t = scope && fromScope(scope, label, 'label');
      if (t) return t;
    }
  }

  // 3. name (radios: the whole group)
  const byName = firstVisible(queryAll(root, '[name=' + attrValue(key) + ']'));
  if (byName) {
    const group = groupOf(byName, root);
    return { el: byName, matchedBy: 'name', ...(group ? { group } : {}) };
  }

  // 4. data-testid
  const byTestId = firstVisible(queryAll(root, '[data-testid=' + attrValue(key) + ']'));
  if (byTestId) return { el: byTestId, matchedBy: 'testid' };

  // 5. label text, then aria-labelledby
  const want = normText(key).toLowerCase();
  for (const label of queryAll(root, 'label') as HTMLLabelElement[]) {
    if (normText(label.textContent).toLowerCase() !== want) continue;
    const t = fromLabel(label, root);
    if (t) return t;
  }
  for (const el of queryAll(root, '[aria-labelledby]')) {
    const text = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
    if (!sameText(text, key) || !isVisible(el)) continue;
    if (el.getAttribute('role') === 'radiogroup' || el.getAttribute('role') === 'group') {
      const t = fromScope(el, null, 'label');
      if (t) return t;
    }
    return { el, matchedBy: 'label' };
  }

  // 6. placeholder (case-insensitive)
  const byPh = queryAll(root, '[placeholder]').find((e) => sameText(e.getAttribute('placeholder'), key) && isVisible(e));
  if (byPh) return { el: byPh, matchedBy: 'placeholder' };

  // 7. aria-label
  const byAria = queryAll(root, '[aria-label]').find((e) => sameText(e.getAttribute('aria-label'), key) && isVisible(e));
  if (byAria) {
    if (byAria.getAttribute('role') === 'radiogroup') {
      const t = fromScope(byAria, null, 'aria-label');
      if (t) return t;
    }
    return { el: byAria, matchedBy: 'aria-label' };
  }

  return { reason: NOT_ON_PAGE };
}

export type DetectedKind = Exclude<FieldKind, 'auto'> | 'file' | 'contenteditable';

/** Kind detection for `kind: 'auto'` (§6.5). For label-scope targets the scope decides group kinds. */
export function detectKind(t: Pick<Target, 'el' | 'scope'>): DetectedKind {
  const el = t.el;
  const role = el.getAttribute('role');
  // Inputs are typed into even with role=combobox (autocomplete); only non-input triggers are Radix selects.
  if (el instanceof HTMLInputElement) {
    const type = el.type;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (type === 'date' || type === 'datetime-local' || type === 'time' || type === 'month') return 'date';
    return 'text';
  }
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'text';
  if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'radix-select';
  if (role === 'checkbox' || role === 'switch') return 'radix-checkbox';
  if (role === 'radio' || role === 'radiogroup') return 'radix-radio';
  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') return 'contenteditable';
  return 'text';
}

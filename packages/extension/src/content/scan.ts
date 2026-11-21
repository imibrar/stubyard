// Page scan (§6.6): lists the form fields of the page with the keys the fill engine matches on.
import type { FieldKind, ScanResult, ScannedField } from '../shared/protocol';
import { isVisible, labelOf, normText, queryAll } from './dom';
import { detectKind } from './match';
import { siblingNativeSelect, triggerText } from './radix';

const CANDIDATES = [
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])',
  'select', 'textarea', '[role=combobox]', '[role=checkbox]', '[role=switch]', '[role=radiogroup]',
].join(', ');
const MAX_OPTIONS = 400;

type Option = { value: string; label: string };

function formIdOf(el: Element): string | null {
  const f = el.closest('form');
  return f ? f.id || f.getAttribute('name') || null : null;
}

/** Raw label text (before "*" is stripped) says required? */
function labelMarksRequired(el: Element): boolean {
  const lab = (el.id && el.ownerDocument.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]')) || el.closest('label');
  return !!lab && /\*/.test(lab.textContent ?? '');
}

const ariaChecked = (e: Element) => e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-state') === 'checked';
function optionOf(e: Element): Option {
  const v = e.getAttribute('value');
  const label = labelOf(e) ?? '';
  return { value: v && v !== 'on' ? v : label, label };
}

function scanKind(el: Element): FieldKind {
  const k = detectKind({ el });
  return k === 'file' || k === 'contenteditable' ? 'skip' : k;
}

function inputTypeOf(el: Element): string | null {
  if (el instanceof HTMLInputElement) return el.type;
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return el.type;
  return null;
}

function singleField(el: Element, includeHidden: boolean): ScannedField | null {
  const visible = isVisible(el);
  if (!visible && !includeHidden) return null;
  const id = el.id || null;
  const name = el.getAttribute('name');
  const testId = el.getAttribute('data-testid');
  const label = labelOf(el);
  const placeholder = el.getAttribute('placeholder');
  const key = id ?? name ?? testId ?? label ?? placeholder;
  if (!key) return null;
  const kind = scanKind(el);
  let value: ScannedField['value'] = null;
  let options: Option[] | undefined;
  if (el instanceof HTMLSelectElement) {
    options = Array.from(el.options).map((o) => ({ value: o.value, label: normText(o.text) }));
    value = el.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : el.value;
  } else if (el instanceof HTMLInputElement) {
    value = el.type === 'checkbox' ? el.checked : el.type === 'file' ? null : el.value;
  } else if (el instanceof HTMLTextAreaElement) {
    value = el.value;
  } else if (kind === 'radix-checkbox') {
    value = ariaChecked(el);
  } else if (kind === 'radix-select') {
    value = triggerText(el);
    const native = siblingNativeSelect(el);
    if (native) options = Array.from(native.options).filter((o) => o.value !== '').map((o) => ({ value: o.value, label: normText(o.text) }));
  } else if (kind === 'radix-radio') {
    const radios = queryAll(el, '[role=radio]');
    options = radios.map(optionOf);
    const on = radios.find(ariaChecked);
    value = on ? optionOf(on).value : null;
  }
  const required = (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true' || labelMarksRequired(el);
  return {
    key, id, name, testId, kind, inputType: inputTypeOf(el), label, placeholder, value,
    ...(options ? { options: options.slice(0, MAX_OPTIONS) } : {}),
    required, visible, formId: formIdOf(el), duplicateKey: false,
  };
}

/** One field for a group of radios/checkboxes (same name, or the controls around a label whose `for` has no element). */
function groupField(key: string, label: string | null, members: Element[], includeHidden: boolean, keyFrom: { id?: string | null; name?: string | null }): ScannedField | null {
  // a Radix radiogroup counts by its radios
  const flat = members.flatMap((m) => (m.getAttribute('role') === 'radiogroup' ? queryAll(m, '[role=radio]') : [m]));
  if (!flat.length) return null;
  const visible = flat.some(isVisible);
  if (!visible && !includeHidden) return null;
  const first = flat[0];
  const native = first instanceof HTMLInputElement;
  const isRadio = native ? (first as HTMLInputElement).type === 'radio' : first.getAttribute('role') === 'radio';
  const kind: FieldKind = native ? (isRadio ? 'radio' : 'checkbox') : isRadio ? 'radix-radio' : 'radix-checkbox';
  const checked = (e: Element) => (native ? (e as HTMLInputElement).checked : ariaChecked(e));
  const options = flat.map(optionOf);
  const on = flat.filter(checked).map((e) => optionOf(e).value);
  const required = flat.some((e) => (e as HTMLInputElement).required === true || e.getAttribute('aria-required') === 'true')
    || members.some((m) => m.getAttribute('aria-required') === 'true');
  return {
    key, id: keyFrom.id ?? null, name: keyFrom.name ?? null, testId: null, kind, inputType: native ? (first as HTMLInputElement).type : null,
    label, placeholder: null, value: isRadio ? (on[0] ?? null) : on, options: options.slice(0, MAX_OPTIONS),
    required, visible, formId: formIdOf(first), duplicateKey: false,
  };
}

export function scanPage(o: { includeHidden?: boolean } = {}, doc: Document = document): ScanResult {
  const includeHidden = !!o.includeHidden;
  // Labels whose `for` names no element (FormRenderer radio groups and multi-selects): their scope is one field.
  const orphans: { label: HTMLLabelElement; scope: Element }[] = [];
  for (const label of queryAll(doc, 'label[for]') as HTMLLabelElement[]) {
    if (!label.htmlFor || doc.getElementById(label.htmlFor)) continue;
    let a: Element | null = label.parentElement;
    for (let i = 0; i < 3 && a; i++, a = a.parentElement) {
      if (queryAll(a, '[role=radio], [role=checkbox], [role=switch], [role=radiogroup], input[type=radio], input[type=checkbox]').some((c) => !label.contains(c))) {
        orphans.push({ label, scope: a });
        break;
      }
    }
  }
  const orphanOf = (el: Element) => orphans.find((x) => x.scope.contains(el) && !x.label.contains(el));

  type Slot = { kind: 'single'; el: Element } | { kind: 'group'; id: string; members: Element[]; key: string; label: string | null; name?: string };
  const slots: Slot[] = [];
  const groups = new Map<string, Extract<Slot, { kind: 'group' }>>();
  const addToGroup = (id: string, el: Element, init: () => Omit<Extract<Slot, { kind: 'group' }>, 'members' | 'kind' | 'id'>) => {
    let g = groups.get(id);
    if (!g) {
      g = { kind: 'group', id, members: [], ...init() };
      groups.set(id, g);
      slots.push(g);
    }
    g.members.push(el);
  };

  const sameNameCount = new Map<string, number>();
  for (const el of queryAll(doc, 'input[type=checkbox][name]')) {
    const k = (formIdOf(el) ?? '') + '\u0000' + el.getAttribute('name');
    sameNameCount.set(k, (sameNameCount.get(k) ?? 0) + 1);
  }

  for (const el of queryAll(doc, CANDIDATES)) {
    if (el.getAttribute('aria-hidden') === 'true') continue;
    // a radiogroup of native radios is listed through its radios
    if (el.getAttribute('role') === 'radiogroup' && el.querySelector('input[type=radio]')) continue;
    const orphan = !el.id ? orphanOf(el) : undefined;
    if (orphan) {
      addToGroup('label:' + orphan.label.htmlFor, el, () => ({ key: orphan.label.htmlFor, label: normText(orphan.label.textContent) || null }));
      continue;
    }
    const type = el instanceof HTMLInputElement ? el.type : '';
    const name = el.getAttribute('name');
    if (name && (type === 'radio' || (type === 'checkbox' && (sameNameCount.get((formIdOf(el) ?? '') + '\u0000' + name) ?? 0) > 1))) {
      const form = el.closest('form');
      addToGroup(type + ':' + (formIdOf(el) ?? '') + ':' + name, el, () => {
        const legend = el.closest('fieldset')?.querySelector('legend');
        const lab = form?.querySelector('label[for="' + name.replace(/"/g, '\\"') + '"]');
        return { key: name, name, label: normText((legend ?? lab)?.textContent) || null };
      });
      continue;
    }
    slots.push({ kind: 'single', el });
  }

  const fields: ScannedField[] = [];
  for (const s of slots) {
    const f = s.kind === 'single'
      ? singleField(s.el, includeHidden)
      : groupField(s.key, s.label, s.members, includeHidden, { name: s.name ?? null });
    if (f) fields.push(f);
  }

  // duplicates: the same key twice in one form
  const seen = new Map<string, number>();
  for (const f of fields) seen.set((f.formId ?? '') + '\u0000' + f.key, (seen.get((f.formId ?? '') + '\u0000' + f.key) ?? 0) + 1);
  const duplicates: string[] = [];
  for (const f of fields) {
    if ((seen.get((f.formId ?? '') + '\u0000' + f.key) ?? 0) > 1) {
      f.duplicateKey = true;
      if (!duplicates.includes(f.key)) duplicates.push(f.key);
    }
  }

  const forms: ScanResult['forms'] = [];
  for (const f of fields) {
    let g = forms.find((x) => x.formId === f.formId);
    if (!g) forms.push((g = { formId: f.formId, fields: [] }));
    g.fields.push(f);
  }
  return { url: doc.location?.href ?? '', title: doc.title, forms, fields, duplicates };
}

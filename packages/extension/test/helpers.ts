// Test helpers: mount HTML and wire a hand-built imitation of Radix Select / Checkbox / RadioGroup behaviour.

export function mount(html: string): void {
  document.body.innerHTML = html;
}

const setChecked = (el: Element, on: boolean) => {
  el.setAttribute('aria-checked', String(on));
  el.setAttribute('data-state', on ? 'checked' : 'unchecked');
};

/** Radix-like behaviour: checkboxes toggle on click, radios select in their group, selects open on pointerdown/Enter. */
export function wireRadix(doc: Document = document, o: { openOn?: 'pointerdown' | 'keyboard' } = {}): { selected: Record<string, string>; dispose: () => void } {
  const selected: Record<string, string> = {};
  const ac = new AbortController();
  const signal = ac.signal;
  doc.addEventListener('click', (e) => {
    const t = (e.target as Element).closest('[role=checkbox], [role=switch], [role=radio]');
    if (!t) return;
    if (t.getAttribute('role') === 'radio') {
      const group = t.closest('[role=radiogroup]') ?? t.parentElement!;
      group.querySelectorAll('[role=radio]').forEach((r) => setChecked(r, r === t));
    } else {
      setChecked(t, t.getAttribute('aria-checked') !== 'true');
    }
  }, { signal });
  const open = (trigger: HTMLElement) => {
    if (trigger.getAttribute('aria-expanded') === 'true') return;
    const id = trigger.getAttribute('aria-controls')!;
    const native = trigger.parentElement!.querySelector('select');
    const lb = doc.createElement('div');
    lb.id = id;
    lb.setAttribute('role', 'listbox');
    for (const opt of Array.from(native?.options ?? []).filter((x) => x.value)) {
      const item = doc.createElement('div');
      item.setAttribute('role', 'option');
      item.setAttribute('data-value', opt.value);
      item.tabIndex = -1;
      item.innerHTML = '<span>' + opt.text + '</span>';
      item.addEventListener('click', () => {
        trigger.innerHTML = '<span>' + opt.text + '</span>';
        trigger.removeAttribute('data-placeholder');
        trigger.setAttribute('aria-expanded', 'false');
        if (native) native.value = opt.value;
        selected[trigger.id] = opt.value;
        lb.remove();
      });
      lb.appendChild(item);
    }
    lb.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') { lb.remove(); trigger.setAttribute('aria-expanded', 'false'); }
    });
    trigger.setAttribute('aria-expanded', 'true');
    doc.body.appendChild(lb); // a portal
  };
  doc.addEventListener('pointerdown', (e) => {
    if (o.openOn === 'keyboard') return;
    const pe = e as PointerEvent;
    const trigger = (e.target as Element).closest('[role=combobox]') as HTMLElement | null;
    if (trigger && pe.button === 0 && pe.pointerType === 'mouse' && !pe.ctrlKey) open(trigger);
  }, { signal });
  doc.addEventListener('keydown', (e) => {
    const trigger = (e.target as Element).closest?.('[role=combobox]') as HTMLElement | null;
    if (trigger && ['Enter', ' ', 'ArrowDown'].includes((e as KeyboardEvent).key)) open(trigger);
  }, { signal });
  return { selected, dispose: () => ac.abort() };
}

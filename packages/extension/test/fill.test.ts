import { afterEach, describe, expect, it } from 'vitest';
import { fillForm } from '../src/content/fill';
import type { RenderedEntry } from '../src/shared/protocol';
import fixture from './fixtures/form-renderer.html?raw';
import { mount, wireRadix } from './helpers';

const e = (key: string, value: RenderedEntry['value'], extra: Partial<RenderedEntry> = {}): RenderedEntry => ({ key, value, kind: 'auto', ...extra });
const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector(sel) as unknown as T;

/** React's value tracker: an own-property `value` setter remembers the last value set through it; onChange fires
 *  only when the input event sees a DOM value different from the tracked one. */
function installTracker(el: HTMLInputElement | HTMLTextAreaElement) {
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!;
  const state = { tracked: el.value, changes: [] as string[], events: [] as string[] };
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return proto.get!.call(this); },
    set(v: string) { state.tracked = v; proto.set!.call(this, v); },
  });
  el.addEventListener('input', () => {
    state.events.push('input');
    if (el.value !== state.tracked) { state.tracked = el.value; state.changes.push(el.value); }
  });
  el.addEventListener('change', () => state.events.push('change'));
  el.addEventListener('blur', () => state.events.push('blur'));
  return state;
}

describe('text fields', () => {
  it('sets the value through the prototype setter so a React-like tracker sees the change', async () => {
    mount('<input id="first"><textarea id="bio"></textarea>');
    const t1 = installTracker($('#first'));
    const t2 = installTracker($<HTMLTextAreaElement>('#bio'));
    const r = await fillForm([e('first', 'Ada'), e('bio', 'Hello\nworld')]);
    expect(r.filled).toBe(2);
    expect(t1.changes).toEqual(['Ada']);
    expect(t2.changes).toEqual(['Hello\nworld']);
    expect(t1.events).toEqual(['input', 'change', 'blur']);
  });

  it('the shim would miss a plain assignment (sanity check of the test)', () => {
    mount('<input id="first">');
    const el = $('#first');
    const t = installTracker(el);
    el.value = 'Ada';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(t.changes).toEqual([]);
  });

  it('reports a field that rewrites the value, except when the digits are the same', async () => {
    mount('<input id="phone"><input id="upper">');
    $('#phone').addEventListener('input', (ev) => { const i = ev.target as HTMLInputElement; i.value = i.value.replace(/^(\d{3})(\d+)$/, '($1) $2'); });
    $('#upper').addEventListener('input', (ev) => { const i = ev.target as HTMLInputElement; i.value = i.value.toUpperCase(); });
    const r = await fillForm([e('phone', '5551234'), e('upper', 'abc')]);
    expect(r.details[0]).toMatchObject({ status: 'filled' });
    expect(r.details[1]).toMatchObject({ status: 'error', reason: 'field rewrote the value to "ABC"' });
  });

  it('counts an unchanged value as skipped; overwrite:false keeps existing values', async () => {
    mount('<input id="a" value="same"><input id="b" value="old"><input id="c">');
    const r = await fillForm([e('a', 'same'), e('b', 'new'), e('c', 'x')], { overwrite: false });
    expect(r.details.map((d) => d.status)).toEqual(['skipped', 'skipped', 'filled']);
    expect(r.details[0].reason).toBe('already set');
    expect($('#b').value).toBe('old');
  });

  it('stringifies booleans and arrays for text fields; date inputs are typed', async () => {
    mount('<input id="a"><input id="b"><input id="d" type="date">');
    const r = await fillForm([e('a', true), e('b', ['x', 'y']), e('d', '2026-01-31')]);
    expect(r.filled).toBe(3);
    expect($('#b').value).toBe('x, y');
    expect(r.details[2].kind).toBe('date');
  });
});

describe('native select, checkbox, radio', () => {
  it('selects by value, exact text, then case-insensitive text', async () => {
    mount('<select id="s1"><option value="">-</option><option value="sa">Saudi Arabia</option><option value="ae">UAE</option></select><select id="s2"><option value="1">Mr</option><option value="2">Dr</option></select><select id="s3"><option>Yes</option><option>No</option></select>');
    const changes: string[] = [];
    document.addEventListener('change', (ev) => changes.push((ev.target as HTMLSelectElement).id));
    const r = await fillForm([e('s1', 'ae'), e('s2', 'Dr'), e('s3', 'no')]);
    expect(r.filled).toBe(3);
    expect([$<HTMLSelectElement>('#s1').value, $<HTMLSelectElement>('#s2').value, $<HTMLSelectElement>('#s3').value]).toEqual(['ae', '2', 'No']);
    expect(changes).toEqual(['s1', 's2', 's3']);
  });

  it('lists options when none matches', async () => {
    mount('<select id="s"><option>One</option><option>Two</option></select>');
    const r = await fillForm([e('s', 'Three')]);
    expect(r.details[0]).toMatchObject({ status: 'error', reason: 'no option "Three" (options: "One", "Two")' });
  });

  it('toggles checkboxes from booleans and words', async () => {
    mount('<input type="checkbox" id="a"><input type="checkbox" id="b" checked><input type="checkbox" id="c"><input type="checkbox" id="d" checked>');
    const r = await fillForm([e('a', true), e('b', false), e('c', 'yes'), e('d', true)]);
    expect([$('#a').checked, $('#b').checked, $('#c').checked, $('#d').checked]).toEqual([true, false, true, true]);
    expect(r.details.map((d) => d.status)).toEqual(['filled', 'filled', 'filled', 'skipped']);
  });

  it('ticks exactly the listed checkboxes of a same-name group', async () => {
    mount(`<input type="checkbox" name="topics" value="ai" id="t1"><label for="t1">AI</label>
      <input type="checkbox" name="topics" value="web" id="t2" checked><label for="t2">Web</label>
      <input type="checkbox" name="topics" value="ops" id="t3"><label for="t3">Operations</label>`);
    const r = await fillForm([e('topics', ['ai', 'Operations'])]);
    expect(r.details[0]).toMatchObject({ status: 'filled', matchedBy: 'name', kind: 'checkbox' });
    expect([$('#t1').checked, $('#t2').checked, $('#t3').checked]).toEqual([true, false, true]);
  });

  it('clicks the radio matching value or label', async () => {
    mount(`<label><input type="radio" name="size" value="s">Small</label><label><input type="radio" name="size" value="m">Medium</label>
      <input type="radio" name="color" value="red"><input type="radio" name="color" value="blue">`);
    const r = await fillForm([e('size', 'medium'), e('color', 'blue'), e('color', 'green')]);
    expect(r.details.map((d) => d.status)).toEqual(['filled', 'filled', 'error']);
    expect((document.querySelector('input[value=m]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[value=blue]') as HTMLInputElement).checked).toBe(true);
    expect(r.details[2].reason).toContain('no option "green"');
  });
});

describe('skips and report', () => {
  it('skips file, readonly, disabled and kind skip; counts everything', async () => {
    mount('<input id="f" type="file"><input id="ro" readonly><input id="dis" disabled><input id="ok"><input id="sk">');
    const r = await fillForm([e('f', 'x'), e('ro', 'x'), e('dis', 'x'), e('ok', 'x'), e('sk', 'x', { kind: 'skip' }), e('missing', 'x')]);
    expect(r).toMatchObject({ filled: 1, skipped: 4, unmatched: 1, errors: 0 });
    expect(r.details.map((d) => d.reason)).toEqual([
      'file upload not supported in v1', 'read-only', 'disabled', undefined, 'kind is skip', 'not on this page (later wizard step?)',
    ]);
  });

  it('an explicit kind that does not fit the element is an error', async () => {
    mount('<input id="a">');
    const r = await fillForm([e('a', 'x', { kind: 'select' })]);
    expect(r.details[0]).toMatchObject({ status: 'error', kind: 'select' });
  });
});

describe('wizard', () => {
  let radix: ReturnType<typeof wireRadix> | undefined;
  afterEach(() => radix?.dispose());

  it('fills only visible step fields and clicks nothing but role controls', async () => {
    mount(fixture);
    radix = wireRadix();
    const clicked: Element[] = [];
    document.addEventListener('click', (ev) => clicked.push(ev.target as Element), { capture: true });
    let submitted = false;
    document.querySelector('form')!.addEventListener('submit', (ev) => { submitted = true; ev.preventDefault(); });

    const r = await fillForm([
      e('fld-first_name', 'Ada'),
      e('Email', 'ada@example.test'),
      e('fld-title', 'Dr', { kind: 'radix-select' }),
      e('fld-dietary', ['Vegetarian', 'Vegan']),
      e('fld-attending', 'No'),
      e('fld-consent', true),
      e('fld-cv', 'cv.pdf'),
      e('fld-notes', 'later step'),
    ], { formId: 'registration' });

    expect(r).toMatchObject({ filled: 6, skipped: 1, unmatched: 1, errors: 0 });
    expect(r.details.find((d) => d.key === 'fld-notes')).toMatchObject({ status: 'unmatched', reason: 'not on this page (later wizard step?)' });
    expect(submitted).toBe(false);
    for (const el of clicked) expect(el.getAttribute('role'), el.outerHTML).toMatch(/^(checkbox|radio|option|switch)$/);
    expect(clicked.some((el) => el.id === 'next' || el.id === 'submit')).toBe(false);

    expect($('#fld-first_name').value).toBe('Ada');
    expect(document.getElementById('fld-title')!.textContent).toBe('Dr');
    const diet = Array.from(document.querySelectorAll('[role=checkbox]:not(#fld-consent)')).map((c) => c.getAttribute('aria-checked'));
    expect(diet).toEqual(['true', 'false', 'true']);
    expect(document.querySelector('[role=radio][value=No]')!.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById('fld-consent')!.getAttribute('aria-checked')).toBe('true');

    // pressing Fill again is idempotent
    const again = await fillForm([e('fld-first_name', 'Ada'), e('fld-title', 'Dr', { kind: 'radix-select' }), e('fld-dietary', ['Vegetarian', 'Vegan']), e('fld-attending', 'No')]);
    expect(again).toMatchObject({ filled: 0, skipped: 4 });

    // step 2 becomes visible: its fields now fill, step 1 fields are "not on this page"
    (document.querySelector('[data-step="1"]') as HTMLElement).style.display = 'none';
    (document.querySelector('[data-step="2"]') as HTMLElement).style.display = '';
    const step2 = await fillForm([e('fld-first_name', 'Ada'), e('fld-notes', 'hello')]);
    expect(step2.details.map((d) => d.status)).toEqual(['unmatched', 'filled']);
  });
});

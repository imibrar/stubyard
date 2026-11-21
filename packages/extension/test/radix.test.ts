import { afterEach, describe, expect, it } from 'vitest';
import { fillForm } from '../src/content/fill';
import { fillRadixSelect } from '../src/content/radix';
import type { RenderedEntry } from '../src/shared/protocol';
import fixture from './fixtures/form-renderer.html?raw';
import { mount, wireRadix } from './helpers';

const e = (key: string, value: RenderedEntry['value'], kind: RenderedEntry['kind'] = 'auto'): RenderedEntry => ({ key, value, kind });
const fast = { open: 20, listbox: 100, close: 100 };

const twoSelects = `
  <form>
    <div><button type="button" role="combobox" id="title" aria-controls="lb-title" data-placeholder>Choose…</button>
      <select aria-hidden="true"><option value=""></option><option value="dr">Dr</option><option value="mr">Mr</option><option value="prof">Professor</option></select></div>
    <div><button type="button" role="combobox" id="lang" aria-controls="lb-lang" data-placeholder>Choose…</button>
      <select aria-hidden="true"><option value="en">English</option><option value="ar">Arabic</option></select></div>
  </form>`;

let radix: ReturnType<typeof wireRadix> | undefined;
afterEach(() => { radix?.dispose(); radix = undefined; });

describe('radix-select', () => {
  it('opens on pointerdown and clicks the option by visible text', async () => {
    mount(twoSelects);
    radix = wireRadix();
    const r = await fillForm([e('title', 'Dr'), e('lang', 'arabic')]);
    expect(r.details.map((d) => [d.status, d.kind])).toEqual([['filled', 'radix-select'], ['filled', 'radix-select']]);
    expect(radix.selected).toEqual({ title: 'dr', lang: 'ar' });
    expect(document.querySelector('[role=listbox]')).toBeNull();
  });

  it('maps a native-select value to its option text, and matches by prefix last', async () => {
    mount(twoSelects);
    radix = wireRadix();
    await fillForm([e('title', 'mr')]);
    expect(radix.selected.title).toBe('mr');
    await fillForm([e('title', 'Prof')]);
    expect(radix.selected.title).toBe('prof');
  });

  it('falls back to the keyboard when pointerdown does not open it', async () => {
    mount(twoSelects);
    radix = wireRadix(document, { openOn: 'keyboard' });
    const r = await fillRadixSelect(document.getElementById('lang')!, 'English', { overwrite: true, timings: fast });
    expect(r.status).toBe('filled');
    expect(radix.selected.lang).toBe('en');
  });

  it('skips when the trigger already shows the value', async () => {
    mount(twoSelects);
    radix = wireRadix();
    await fillForm([e('title', 'Dr')]);
    const pointers: Event[] = [];
    document.addEventListener('pointerdown', (ev) => pointers.push(ev));
    const r = await fillForm([e('title', 'dr')]);
    expect(r.details[0]).toMatchObject({ status: 'skipped', reason: 'already set' });
    expect(pointers).toHaveLength(0);
  });

  it('closes the list and reports the options when none matches', async () => {
    mount(twoSelects);
    radix = wireRadix();
    const r = await fillForm([e('lang', 'French')], { timings: fast });
    expect(r.details[0]).toMatchObject({ status: 'error', reason: 'no option "French" (options: "English", "Arabic")' });
    expect(document.querySelector('[role=listbox]')).toBeNull();
  });

  it('reports a dropdown that never opens', async () => {
    mount(twoSelects); // not wired
    const r = await fillForm([e('title', 'Dr')], { timings: fast });
    expect(r.details[0]).toMatchObject({ status: 'error', reason: 'the dropdown did not open' });
  });

  it('works on the FormRenderer fixture (trigger id fld-title)', async () => {
    mount(fixture);
    radix = wireRadix();
    const r = await fillForm([e('fld-title', 'Ms')]);
    expect(r.details[0]).toMatchObject({ status: 'filled', matchedBy: 'id', kind: 'radix-select' });
    expect((document.querySelector('select[aria-hidden]') as HTMLSelectElement).value).toBe('ms');
  });
});

describe('radix checkbox and radio', () => {
  it('toggles [role=checkbox][aria-checked] and switches', async () => {
    mount('<button role="checkbox" id="a" aria-checked="false"></button><button role="switch" id="b" aria-checked="true"></button><button role="checkbox" id="c" aria-checked="true"></button>');
    radix = wireRadix();
    const r = await fillForm([e('a', true), e('b', false), e('c', 'yes')]);
    expect(r.details.map((d) => d.status)).toEqual(['filled', 'filled', 'skipped']);
    expect(['a', 'b', 'c'].map((id) => document.getElementById(id)!.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
  });

  it('multi-select in a label scope: ticks by label text, unticks the rest', async () => {
    mount(fixture);
    radix = wireRadix();
    document.querySelectorAll('[role=checkbox]')[1].setAttribute('aria-checked', 'true');
    const r = await fillForm([e('fld-dietary', ['vegan'])]);
    expect(r.details[0]).toMatchObject({ status: 'filled', kind: 'radix-checkbox', matchedBy: 'label' });
    const diet = Array.from(document.querySelectorAll('.grid [role=checkbox]')).map((c) => c.getAttribute('aria-checked'));
    expect(diet).toEqual(['false', 'false', 'true']);
  });

  it('radio group by value or label; unknown option is an error', async () => {
    mount(fixture);
    radix = wireRadix();
    const r = await fillForm([e('Attending in person', 'yes'), e('fld-attending', 'Maybe')]);
    expect(r.details[0]).toMatchObject({ status: 'filled', kind: 'radix-radio' });
    expect(document.querySelector('[role=radio][value=Yes]')!.getAttribute('aria-checked')).toBe('true');
    expect(r.details[1]).toMatchObject({ status: 'error', reason: 'no option "Maybe" (options: "Yes", "No")' });
  });

  it('an id on a radiogroup targets its radios', async () => {
    mount('<div role="radiogroup" id="plan"><button role="radio" value="free" aria-checked="false"></button><button role="radio" value="pro" aria-checked="false"></button></div>');
    radix = wireRadix();
    const r = await fillForm([e('plan', 'pro')]);
    expect(r.details[0]).toMatchObject({ status: 'filled', kind: 'radix-radio' });
    expect(document.querySelector('[value=pro]')!.getAttribute('aria-checked')).toBe('true');
  });
});

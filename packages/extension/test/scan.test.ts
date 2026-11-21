import { describe, expect, it } from 'vitest';
import { scanPage } from '../src/content/scan';
import fixture from './fixtures/form-renderer.html?raw';
import { mount } from './helpers';

describe('scanPage', () => {
  it('lists the FormRenderer fields with fill keys', () => {
    mount(fixture);
    const s = scanPage();
    expect(s.fields.map((f) => [f.key, f.kind])).toEqual([
      ['fld-first_name', 'text'],
      ['fld-email', 'text'],
      ['fld-title', 'radix-select'],
      ['fld-dietary', 'radix-checkbox'],
      ['fld-attending', 'radix-radio'],
      ['fld-consent', 'radix-checkbox'],
      ['fld-cv', 'skip'],
    ]);
    const by = Object.fromEntries(s.fields.map((f) => [f.key, f]));
    expect(by['fld-first_name']).toMatchObject({ id: 'fld-first_name', label: 'First name', placeholder: 'Your first name', required: true, visible: true, formId: 'registration', inputType: 'text', value: '' });
    expect(by['fld-email']).toMatchObject({ required: false, inputType: 'email' });
    expect(by['fld-title']).toMatchObject({ label: 'Title', value: null, required: true });
    expect(by['fld-title'].options).toEqual([{ value: 'dr', label: 'Dr' }, { value: 'mr', label: 'Mr' }, { value: 'ms', label: 'Ms' }]);
    expect(by['fld-dietary']).toMatchObject({ id: null, label: 'Dietary needs', value: [] });
    expect(by['fld-dietary'].options!.map((o) => o.label)).toEqual(['Vegetarian', 'Halal', 'Vegan']);
    expect(by['fld-attending']).toMatchObject({ label: 'Attending in person', value: null, options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] });
    expect(by['fld-consent']).toMatchObject({ label: 'I agree to the terms', value: false, required: true });
    expect(by['fld-cv']).toMatchObject({ inputType: 'file', value: null });
    expect(s.duplicates).toEqual([]);
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0].formId).toBe('registration');
  });

  it('excludes the Radix aria-hidden native select', () => {
    mount(fixture);
    expect(scanPage({ includeHidden: true }).fields.some((f) => f.inputType === 'select-one')).toBe(false);
  });

  it('includeHidden adds hidden wizard fields with visible:false', () => {
    mount(fixture);
    expect(scanPage().fields.find((f) => f.key === 'fld-notes')).toBeUndefined();
    expect(scanPage({ includeHidden: true }).fields.find((f) => f.key === 'fld-notes')).toMatchObject({ visible: false, inputType: 'textarea' });
  });

  it('reads current values', () => {
    mount(fixture);
    (document.getElementById('fld-first_name') as HTMLInputElement).value = 'Ada';
    const t = document.getElementById('fld-title')!;
    t.removeAttribute('data-placeholder');
    t.textContent = 'Dr';
    document.querySelectorAll('.grid [role=checkbox]')[2].setAttribute('aria-checked', 'true');
    document.querySelector('[role=radio][value=No]')!.setAttribute('aria-checked', 'true');
    const by = Object.fromEntries(scanPage().fields.map((f) => [f.key, f.value]));
    expect(by).toMatchObject({ 'fld-first_name': 'Ada', 'fld-title': 'Dr', 'fld-dietary': ['Vegan'], 'fld-attending': 'No' });
  });

  it('groups native radios and same-name checkboxes; reads native selects', () => {
    mount(`<form name="prefs">
      <fieldset><legend>Size</legend><input type="radio" name="size" value="s"><input type="radio" name="size" value="m" checked></fieldset>
      <input type="checkbox" name="tags" value="a" checked><input type="checkbox" name="tags" value="b">
      <input type="checkbox" id="news"><label for="news">Newsletter</label>
      <select name="country"><option value="sa">Saudi Arabia</option><option value="ae" selected>UAE</option></select>
      <input type="submit" value="Go"><input type="hidden" name="csrf" value="x">
    </form>`);
    const s = scanPage();
    expect(s.fields.map((f) => [f.key, f.kind, f.value])).toEqual([
      ['size', 'radio', 'm'],
      ['tags', 'checkbox', ['a']],
      ['news', 'checkbox', false],
      ['country', 'select', 'ae'],
    ]);
    expect(s.fields[0].label).toBe('Size');
    expect(s.fields[2].label).toBe('Newsletter');
    expect(s.fields[3].options).toEqual([{ value: 'sa', label: 'Saudi Arabia' }, { value: 'ae', label: 'UAE' }]);
    expect(s.forms[0].formId).toBe('prefs');
  });

  it('flags keys seen twice in one form', () => {
    mount(`<form id="a"><input id="email"><input id="email"><input name="phone"></form>
      <form id="b"><input name="phone"></form>`);
    const s = scanPage();
    expect(s.duplicates).toEqual(['email']);
    expect(s.fields.filter((f) => f.duplicateKey).map((f) => f.key)).toEqual(['email', 'email']);
    expect(s.forms.map((f) => [f.formId, f.fields.length])).toEqual([['a', 3], ['b', 1]]);
  });
});

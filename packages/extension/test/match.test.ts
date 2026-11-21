import { beforeEach, describe, expect, it } from 'vitest';
import { detectKind, findTarget, formScope, NOT_ON_PAGE, type Target } from '../src/content/match';
import fixture from './fixtures/form-renderer.html?raw';
import { mount } from './helpers';

const hit = (r: ReturnType<typeof findTarget>): Target => {
  if ('reason' in r) throw new Error('unmatched: ' + r.reason);
  return r;
};

describe('findTarget priority', () => {
  const all = `
    <input id="city" data-which="id">
    <input name="city" data-which="name">
    <input data-testid="city" data-which="testid">
    <label for="by-label">City</label><input id="by-label" data-which="label">
    <input placeholder="City" data-which="placeholder">
    <input aria-label="city" data-which="aria">`;

  it('prefers id, then name, testid, label, placeholder, aria-label', () => {
    mount(all);
    const order: [string, string][] = [['id', 'id'], ['name', 'name'], ['testid', 'testid'], ['label', 'label'], ['placeholder', 'placeholder'], ['aria', 'aria-label']];
    for (const [which, by] of order) {
      const t = hit(findTarget({ key: which === 'label' ? 'City' : 'city' }));
      expect(t.el.getAttribute('data-which')).toBe(which);
      expect(t.matchedBy).toBe(by);
      t.el.remove();
      if (which === 'label') document.querySelector('label')!.remove();
    }
    expect(findTarget({ key: 'city' })).toEqual({ reason: NOT_ON_PAGE });
  });

  it('matches label text without "*", whitespace and case', () => {
    mount(fixture);
    const t = hit(findTarget({ key: '  first   NAME ' }));
    expect(t.el.id).toBe('fld-first_name');
    expect(t.matchedBy).toBe('label');
  });

  it('a selector overrides key matching', () => {
    mount('<input id="a"><input class="b">');
    const t = hit(findTarget({ key: 'a', selector: 'input.b' }));
    expect(t.el.className).toBe('b');
    expect(t.matchedBy).toBe('selector');
    expect(findTarget({ key: 'a', selector: '##bad' })).toEqual({ reason: 'invalid selector "##bad"' });
  });

  it('groups same-name native radios', () => {
    mount('<input type="radio" name="size" value="s"><input type="radio" name="size" value="m">');
    const t = hit(findTarget({ key: 'size' }));
    expect(t.matchedBy).toBe('name');
    expect(t.group).toHaveLength(2);
  });
});

describe('label-scope', () => {
  beforeEach(() => mount(fixture));

  it('uses the label scope when the label "for" names no element (radio group)', () => {
    const t = hit(findTarget({ key: 'fld-attending' }));
    expect(t.matchedBy).toBe('label');
    expect(t.el.getAttribute('role')).toBe('radiogroup');
    expect(t.scope?.querySelectorAll('[role=radio]')).toHaveLength(2);
    expect(detectKind(t)).toBe('radix-radio');
  });

  it('finds a multi-select by its label text', () => {
    const t = hit(findTarget({ key: 'Dietary needs' }));
    expect(t.el.getAttribute('role')).toBe('checkbox');
    expect(t.scope?.querySelectorAll('[role=checkbox]')).toHaveLength(3);
  });
});

describe('scoping and visibility', () => {
  it('scopes to form#formId or form[name]', () => {
    mount('<form id="a"><input name="email" data-f="a"></form><form name="b"><input name="email" data-f="b"></form>');
    expect(hit(findTarget({ key: 'email' }, formScope('b'))).el.getAttribute('data-f')).toBe('b');
    expect(hit(findTarget({ key: 'email' }, formScope('a'))).el.getAttribute('data-f')).toBe('a');
    expect(formScope('missing')).toBe(document);
  });

  it('skips invisible elements', () => {
    mount(`
      <div style="display:none"><input id="x" data-v="1"></div>
      <div hidden><input id="x" data-v="2"></div>
      <input id="x" aria-hidden="true" data-v="3">
      <input id="x" style="visibility:hidden" data-v="4">
      <input name="x" data-v="5">`);
    const t = hit(findTarget({ key: 'x' }));
    expect(t.el.getAttribute('data-v')).toBe('5');
    expect(t.matchedBy).toBe('name');
  });

  it('reports hidden wizard fields as not on this page', () => {
    mount(fixture);
    expect(findTarget({ key: 'fld-notes' })).toEqual({ reason: NOT_ON_PAGE });
  });
});

describe('detectKind', () => {
  it('maps element types', () => {
    mount(`<input id="c" type="checkbox"><input id="r" type="radio"><input id="d" type="date"><input id="f" type="file">
      <select id="s"></select><textarea id="t"></textarea><button id="cb" role="combobox"></button>
      <button id="sw" role="switch"></button><div id="ce" contenteditable="true"></div><input id="txt">`);
    const k = (id: string) => detectKind({ el: document.getElementById(id)! });
    expect([k('c'), k('r'), k('d'), k('f'), k('s'), k('t'), k('cb'), k('sw'), k('txt')])
      .toEqual(['checkbox', 'radio', 'date', 'file', 'select', 'text', 'radix-select', 'radix-checkbox', 'text']);
  });
});

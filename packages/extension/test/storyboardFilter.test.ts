import { describe, expect, it } from 'vitest';
import {
  addTag,
  applyFilter,
  countLabel,
  EMPTY_FILTER,
  filterKey,
  isFiltering,
  isTypingTarget,
  parseFilter,
  rowTags,
  tagChips,
  toggleTag,
  visibleChips,
} from '../src/sidepanel/storyboardFilter';

const sb = (name: string, tags: string[] = [], description = '', slug = name.toLowerCase().replace(/ /g, '-')) => ({ name, slug, tags, description });
const list = [
  sb('Sign up', ['onboarding', 'REG-02'], 'New customer confirms the email'),
  sb('Place order', ['orders', 'payments']),
  sb('Reset password', ['onboarding', 'auth']),
  sb('Refund', ['orders', 'payments', 'admin'], 'Admin refunds an order', 'refund-flow'),
  sb('Misc'),
];
const names = (l: { name: string }[]) => l.map((s) => s.name);

describe('applyFilter', () => {
  it('passes everything without a filter', () => {
    expect(applyFilter(list, EMPTY_FILTER)).toEqual(list);
    expect(applyFilter(list, { query: '   ', tags: [] })).toEqual(list);
  });
  it('search: title, slug, description and tags, case-insensitive, every word', () => {
    expect(names(applyFilter(list, { query: 'SIGN', tags: [] }))).toEqual(['Sign up']);
    expect(names(applyFilter(list, { query: 'refund-flow', tags: [] }))).toEqual(['Refund']);
    expect(names(applyFilter(list, { query: 'confirms', tags: [] }))).toEqual(['Sign up']);
    expect(names(applyFilter(list, { query: 'reg-02', tags: [] }))).toEqual(['Sign up']);
    expect(names(applyFilter(list, { query: 'order admin', tags: [] }))).toEqual(['Refund']);
    expect(names(applyFilter(list, { query: '  onboarding   email ', tags: [] }))).toEqual(['Sign up']);
    expect(applyFilter(list, { query: 'nothing', tags: [] })).toEqual([]);
  });
  it('tags: a storyboard needs all selected tags (exact), combined with the search', () => {
    expect(names(applyFilter(list, { query: '', tags: ['orders'] }))).toEqual(['Place order', 'Refund']);
    expect(names(applyFilter(list, { query: '', tags: ['orders', 'admin'] }))).toEqual(['Refund']);
    expect(names(applyFilter(list, { query: '', tags: ['orders', 'auth'] }))).toEqual([]);
    expect(names(applyFilter(list, { query: '', tags: ['Orders'] }))).toEqual([]);
    expect(names(applyFilter(list, { query: 'place', tags: ['orders'] }))).toEqual(['Place order']);
  });
});

describe('tag chips', () => {
  it('most used first (whole list), then by name; counts are of the shown storyboards', () => {
    const all = tagChips(list, list, []);
    expect(all.map((c) => [c.tag, c.count])).toEqual([
      ['onboarding', 2],
      ['orders', 2],
      ['payments', 2],
      ['admin', 1],
      ['auth', 1],
      ['REG-02', 1],
    ]);
    const shown = applyFilter(list, { query: '', tags: ['orders'] });
    expect(tagChips(list, shown, ['orders']).map((c) => [c.tag, c.count, c.selected])).toEqual([
      ['orders', 2, true],
      ['payments', 2, false],
      ['admin', 1, false],
    ]);
  });
  it('keeps a selected tag the list no longer has (count 0) so it can be turned off', () => {
    expect(tagChips(list, [], ['gone']).map((c) => [c.tag, c.count, c.selected])).toEqual([['gone', 0, true]]);
  });
  it('counts a tag once per storyboard', () => {
    const dup = [sb('A', ['x', 'x'])];
    expect(tagChips(dup, dup, [])).toEqual([{ tag: 'x', count: 1, selected: false }]);
  });
  it('visibleChips: the first n plus selected ones further down', () => {
    const chips = 'abcdefghij'.split('').map((tag, i) => ({ tag, count: 1, selected: i === 9 }));
    const v = visibleChips(chips, false, 3);
    expect(v.shown.map((c) => c.tag)).toEqual(['a', 'b', 'c', 'j']);
    expect(v.hidden).toBe(6);
    expect(visibleChips(chips, true, 3)).toEqual({ shown: chips, hidden: 0 });
    expect(visibleChips(chips.slice(0, 3), false, 3).hidden).toBe(0);
  });
  it('toggleTag / addTag', () => {
    expect(toggleTag(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleTag(['a', 'b'], 'a')).toEqual(['b']);
    expect(addTag(['a'], 'a')).toEqual(['a']);
    expect(addTag(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('small helpers', () => {
  it('rowTags: up to 3 and the rest', () => {
    expect(rowTags(['a', 'b'])).toEqual({ shown: ['a', 'b'], rest: [] });
    expect(rowTags(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], rest: ['d', 'e'] });
  });
  it('countLabel and isFiltering', () => {
    expect(countLabel(3, 12, true)).toBe('3 of 12');
    expect(countLabel(12, 12, false)).toBe('12');
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
    expect(isFiltering({ query: ' x ', tags: [] })).toBe(true);
    expect(isFiltering({ query: '', tags: ['a'] })).toBe(true);
  });
  it('filterKey is per hub and project', () => {
    expect(filterKey('http://localhost:4000/', 'hyper')).toBe('storyboardFilter:http://localhost:4000|hyper');
    expect(filterKey('http://a', 'p')).not.toBe(filterKey('http://b', 'p'));
  });
  it('parseFilter accepts only a well-formed filter', () => {
    expect(parseFilter(undefined)).toEqual(EMPTY_FILTER);
    expect(parseFilter('x')).toEqual(EMPTY_FILTER);
    expect(parseFilter({ query: 5, tags: 'a' })).toEqual(EMPTY_FILTER);
    expect(parseFilter({ query: 'abc', tags: ['a', 1, '', 'a', 'b'] })).toEqual({ query: 'abc', tags: ['a', 'b'] });
    expect(parseFilter({ query: 'x'.repeat(500), tags: [] }).query.length).toBe(200);
  });
  it('isTypingTarget: text fields yes, buttons and checkboxes no', () => {
    const el = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      document.body.append(d);
      return d.firstElementChild!;
    };
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(el('<input type="text">'))).toBe(true);
    expect(isTypingTarget(el('<input type="search">'))).toBe(true);
    expect(isTypingTarget(el('<textarea></textarea>'))).toBe(true);
    expect(isTypingTarget(el('<select></select>'))).toBe(true);
    expect(isTypingTarget(el('<input type="checkbox">'))).toBe(false);
    expect(isTypingTarget(el('<button>x</button>'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});

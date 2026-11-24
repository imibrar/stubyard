// Home's storyboard list with the filter (search, tag chips, row tags, empty state, "/" and Esc, remembered filter),
// rendered with React in happy-dom against mocked hub calls and a fake chrome.storage.session.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryboardBrief } from '@stubyard/client/storyboard-types';
import { PanelContext, type PanelState } from '../src/sidepanel/context';

const api = vi.hoisted(() => ({ listStoryboards: vi.fn(), listWalkthroughs: vi.fn(), listCleanup: vi.fn() }));
vi.mock('@stubyard/client/storyboards', () => ({ listStoryboards: api.listStoryboards }));
vi.mock('@stubyard/client/walkthroughs', () => ({ listWalkthroughs: api.listWalkthroughs }));
vi.mock('../src/sidepanel/hub', async (orig) => ({ ...(await orig<object>()), listCleanup: api.listCleanup, addAppOrigin: vi.fn() }));
vi.mock('../src/sidepanel/run', () => ({ quickStartOrOpen: vi.fn() }));

const { HomeScreen } = await import('../src/sidepanel/screens/Home');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sb = (name: string, tags: string[], description = ''): StoryboardBrief =>
  ({ id: name, slug: name.toLowerCase().replace(/ /g, '-'), name, description, tags, preferredMode: 'tracked', version: 1, steps: 3, actors: [], updatedAt: '' }) as StoryboardBrief;
const boards = [
  sb('Sign up', ['onboarding', 'REG-02'], 'confirms the email'),
  sb('Place order', ['orders', 'payments']),
  sb('Reset password', ['onboarding', 'auth']),
  sb('Refund', ['orders', 'payments', 'admin', 'slow']),
];

let store: Record<string, unknown>;
const session = {
  get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
  set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(store, items)),
};
const KEY = 'storyboardFilter:http://hub.test|hyper';

let root: Root;
let host: HTMLElement;
const go = vi.fn();
const panel = {
  settings: { apiUrl: 'http://hub.test' },
  origin: 'http://app.test',
  project: 'hyper',
  ticks: { storyboards: 0, walkthrough: 0, cleanup: 0 },
  target: (project: string) => ({ apiUrl: 'http://hub.test', project }),
  go,
  notify: vi.fn(),
} as unknown as PanelState;

const flush = () => act(async () => {});
async function mount() {
  await act(async () => root.render(createElement(PanelContext.Provider, { value: panel }, createElement(HomeScreen, { match: { status: 'matched', slug: 'hyper' } }))));
  await flush();
}
const $ = <E extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as E | null;
const $$ = (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[];
const rowNames = () => $$('.item-name').map((e) => e.textContent);
const search = () => $<HTMLInputElement>('input[type=search]')!;
const chip = (tag: string) => $$('.sb-tag').find((b) => b.querySelector('.sb-tag-name')?.textContent === tag)!;
const click = (el: HTMLElement) => act(async () => el.click());
async function type(value: string) {
  const input = search();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (target: EventTarget, k: string) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

beforeEach(() => {
  store = {};
  session.get.mockClear();
  session.set.mockClear();
  (globalThis as { chrome?: unknown }).chrome = { storage: { session } };
  api.listStoryboards.mockResolvedValue(boards);
  api.listWalkthroughs.mockResolvedValue([]);
  api.listCleanup.mockResolvedValue({ items: [], counts: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('Home storyboard filter', () => {
  it('lists everything with a count, tag chips with counts, and up to 3 tags per row', async () => {
    await mount();
    expect(rowNames()).toEqual(['Sign up', 'Reset password', 'Place order', 'Refund']);
    expect($('.sb-count')!.textContent).toBe('4');
    expect($$('.sb-tag').map((b) => b.textContent)).toEqual(['onboarding2', 'orders2', 'payments2', 'admin1', 'auth1', 'REG-021', 'slow1']);
    const refund = $$('.rows > li').find((li) => li.textContent?.includes('Refund'))!;
    expect([...refund.querySelectorAll('.row-tag')].map((b) => b.textContent)).toEqual(['orders', 'payments', 'admin']);
    expect(refund.querySelector('.row-tag-more')!.textContent).toBe('+1');
    expect(search().getAttribute('aria-label')).toBe('Search storyboards');
  });

  it('search narrows instantly (every word), shows "x of y", and remembers it', async () => {
    await mount();
    await type('ORDER pay');
    expect(rowNames()).toEqual(['Place order', 'Refund']);
    expect($('.sb-count')!.textContent).toBe('2 of 4');
    expect(store[KEY]).toEqual({ query: 'ORDER pay', tags: [] });
  });

  it('tag chips toggle (all of), row tags add to the filter, and the row click is not triggered', async () => {
    await mount();
    await click(chip('orders'));
    expect(rowNames()).toEqual(['Place order', 'Refund']);
    expect(chip('orders').getAttribute('aria-pressed')).toBe('true');
    const refund = $$('.rows > li').find((li) => li.textContent?.includes('Refund'))!;
    await click([...refund.querySelectorAll<HTMLElement>('.row-tag')].find((b) => b.textContent === 'admin')!);
    expect(go).not.toHaveBeenCalled();
    expect(rowNames()).toEqual(['Refund']);
    expect($('.sb-tags-label')!.textContent).toBe('Tags · all of');
    expect(store[KEY]).toEqual({ query: '', tags: ['orders', 'admin'] });
    await click(chip('orders'));
    expect(rowNames()).toEqual(['Refund']);
    expect(chip('admin').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows "No storyboards match" with a clear action', async () => {
    await mount();
    await type('nothing here');
    expect(rowNames()).toEqual([]);
    expect($('.sb-empty')!.textContent).toContain('No storyboards match “nothing here”');
    await click([...$$('.sb-empty button')][0]);
    expect(rowNames().length).toBe(4);
    expect(search().value).toBe('');
    expect($('.sb-count')!.textContent).toBe('4');
  });

  it('"/" focuses the search when no field has focus; Esc clears the text, then the tags', async () => {
    await mount();
    await key(document.body, '/');
    expect(document.activeElement).toBe(search());
    await click(chip('onboarding'));
    search().focus();
    await type('sign');
    expect(rowNames()).toEqual(['Sign up']);
    await key(search(), 'Escape');
    expect(search().value).toBe('');
    expect(rowNames()).toEqual(['Sign up', 'Reset password']);
    await key(search(), 'Escape');
    expect(rowNames().length).toBe(4);
  });

  it('a "/" typed in another field is left alone', async () => {
    const other = document.createElement('input');
    document.body.append(other);
    await mount();
    other.focus();
    await key(other, '/');
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('restores the remembered filter for the project (a gone tag stays as a chip to turn off)', async () => {
    store[KEY] = { query: '', tags: ['orders', 'gone'] };
    await mount();
    expect(rowNames()).toEqual([]);
    expect(chip('gone').textContent).toBe('gone0');
    await click(chip('gone'));
    expect(rowNames()).toEqual(['Place order', 'Refund']);
    expect($('.sb-count')!.textContent).toBe('2 of 4');
  });

  it('hides the filter for a single storyboard', async () => {
    api.listStoryboards.mockResolvedValue([boards[0]]);
    await mount();
    expect($('input[type=search]')).toBeNull();
    expect(rowNames()).toEqual(['Sign up']);
  });
});

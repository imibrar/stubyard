import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPage, capture, highlight, probe, setValue } from '../src/content/capture';
import { handleRequest } from '../src/content/index';
import { mount } from './helpers';

afterEach(() => vi.useRealTimers());

describe('probe and setValue (login, 2FA)', () => {
  it('probe reports presence, visibility and value', () => {
    mount('<input id="code" value="12"><div id="gone" style="display:none">x</div>');
    expect(probe('#code')).toEqual({ present: true, visible: true, value: '12' });
    expect(probe('#gone')).toEqual({ present: true, visible: false, value: 'x' });
    expect(probe('#nope')).toEqual({ present: false, visible: false, value: null });
  });

  it('setValue types into the first visible match and fires input', () => {
    mount('<input id="email" style="display:none"><input id="email"><input id="password" type="password">');
    const seen: string[] = [];
    document.addEventListener('input', (ev) => seen.push((ev.target as HTMLInputElement).value));
    expect(setValue('#email', 'a@b.test')).toEqual({ ok: true });
    expect(setValue('#password', 'secret')).toEqual({ ok: true });
    expect(seen).toEqual(['a@b.test', 'secret']);
    expect((document.querySelectorAll('#email')[1] as HTMLInputElement).value).toBe('a@b.test');
    expect(setValue('#code', '123456')).toEqual({ ok: false, error: 'no visible element matches "#code"' });
    expect(setValue('[[', 'x').ok).toBe(false);
  });
});

describe('capture', () => {
  it('reads text, value or attribute, with an optional pattern', () => {
    mount('<p id="reg">Registration number: HCE27-A-0042</p><input id="v" value="xyz"><a id="l" href="/r/42">r</a>');
    expect(capture({ textPattern: 'Registration number:\\s*([A-Z0-9]+-[A-Z]-\\d+)' })).toEqual({ value: 'HCE27-A-0042', matchedText: 'Registration number: HCE27-A-0042' });
    expect(capture({ selector: '#reg', textPattern: '/(\\d+)$/' }).value).toBe('0042');
    expect(capture({ selector: '#v' }).value).toBe('xyz');
    expect(capture({ selector: '#l', attribute: 'href' }).value).toBe('/r/42');
    expect(capture({ selector: '#missing' })).toEqual({ value: null, matchedText: null });
    expect(capture({ textPattern: '(' }).error).toMatch(/invalid textPattern/);
  });
});

describe('assert', () => {
  it('checks text, selector and URL', () => {
    mount('<span class="badge">Pending   review</span><div id="hidden" hidden></div>');
    expect(assertPage({ textPresent: 'pending review' })).toEqual({ ok: true, details: ['ok: text present: "pending review"'] });
    expect(assertPage({ textPresent: 'Approved' }).ok).toBe(false);
    expect(assertPage({ selector: '.badge' }).ok).toBe(true);
    const hidden = assertPage({ selector: '#hidden' });
    expect(hidden).toEqual({ ok: false, details: ['failed: element present but hidden: #hidden'] });
    expect(assertPage({ urlMatches: location.pathname }).ok).toBe(true);
    expect(assertPage({ urlMatches: '/^https?:\\/\\/nowhere/' }).ok).toBe(false);
    expect(assertPage({})).toEqual({ ok: true, details: ['nothing to check'] });
  });
});

describe('highlight', () => {
  it('outlines by selector or text for 2 s and never clicks', () => {
    vi.useFakeTimers();
    mount('<button id="go">Create account</button><p>Some <b>other</b> text</p>');
    let clicks = 0;
    document.addEventListener('click', () => clicks++);
    expect(highlight({ text: 'create account' })).toEqual({ found: true });
    const btn = document.getElementById('go')!;
    expect(btn.style.outline).toContain('solid');
    vi.advanceTimersByTime(2000);
    expect(btn.style.outline).toBe('');
    expect(highlight({ text: 'other' })).toEqual({ found: true });
    expect(highlight({ selector: '#nope', text: 'missing words' })).toEqual({ found: false });
    expect(clicks).toBe(0);
  });
});

describe('handleRequest', () => {
  it('answers ping and dispatches by type', async () => {
    mount('<input id="a">');
    expect(await handleRequest({ type: 'ping' })).toMatchObject({ ok: true, version: expect.any(String) });
    expect(await handleRequest({ type: 'fill', entries: [{ key: 'a', value: 'x', kind: 'auto' }] })).toMatchObject({ filled: 1 });
    expect(await handleRequest({ type: 'probe', selector: '#a' })).toEqual({ present: true, visible: true, value: 'x' });
  });
});

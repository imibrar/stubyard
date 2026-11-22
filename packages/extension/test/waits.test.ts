// The shared 2FA / email waits (src/run/waits.ts): the resume state in the step data, and who runs a wait.
import { describe, expect, it } from 'vitest';
import { newPending, ownerLabel, parsePending, pendingOf, supersedes, WAIT_DATA_KEY, waitMayFill, waitRole } from '../src/run/waits';

const NOW = 1_700_000_000_000;
const pw = (o: Partial<ReturnType<typeof newPending>> = {}) => ({ ...newPending({ owner: 'widget', tabId: 3, windowId: 1, now: NOW, ms: 300_000, id: 'a' }), ...o });

describe('parsePending', () => {
  it('reads a stored wait and drops malformed or cleared ones', () => {
    expect(parsePending(pw())).toEqual({ id: 'a', owner: 'widget', tabId: 3, windowId: 1, startedAt: NOW, until: NOW + 300_000, origin: null });
    expect(parsePending(pw({ origin: 'https://app.test' }))?.origin).toBe('https://app.test');
    expect(parsePending({ ...pw(), origin: 5 })?.origin).toBeNull();
    expect(parsePending(null)).toBeNull();
    expect(parsePending({ ...pw(), owner: 'dashboard' })).toBeNull();
    expect(parsePending({ ...pw(), tabId: '3' })).toBeNull();
    expect(parsePending({ ...pw(), id: '' })).toBeNull();
    expect(parsePending([pw()])).toBeNull();
  });
  it('lives under its own step-data key per kind', () => {
    expect(WAIT_DATA_KEY).toEqual({ '2fa': 'twoFactorPending', email: 'emailWaitPending' });
    expect(pendingOf({ twoFactorPending: pw() }, '2fa')?.id).toBe('a');
    expect(pendingOf({ twoFactorPending: pw() }, 'email')).toBeNull();
    expect(pendingOf(undefined, '2fa')).toBeNull();
  });
  it('newPending gets a unique id and a deadline', () => {
    const a = newPending({ owner: 'panel', tabId: 1, windowId: 2, now: NOW, ms: 1000 });
    const b = newPending({ owner: 'panel', tabId: 1, windowId: 2, now: NOW, ms: 1000 });
    expect(a.id).not.toBe(b.id);
    expect(a.until).toBe(NOW + 1000);
  });
});

describe('waitRole', () => {
  const widget = { surface: 'widget' as const, tabId: 3, windowId: 1, runningId: null };
  const panel = { surface: 'panel' as const, tabId: 3, windowId: 1, runningId: null };
  it('none: nothing pending, or past the deadline', () => {
    expect(waitRole(null, widget, NOW)).toBe('none');
    expect(waitRole(pw(), widget, NOW + 300_001)).toBe('none');
  });
  it('mine while this view runs it', () => {
    expect(waitRole(pw(), { ...widget, runningId: 'a' }, NOW)).toBe('mine');
  });
  it('the widget of the same tab resumes its wait after a navigation; other tabs only show it', () => {
    expect(waitRole(pw(), widget, NOW + 5000)).toBe('resume');
    expect(waitRole(pw(), { ...widget, tabId: 4 }, NOW)).toBe('elsewhere');
  });
  it('the panel never runs a widget wait; it resumes its own wait in its own window', () => {
    expect(waitRole(pw(), panel, NOW)).toBe('elsewhere');
    expect(waitRole(pw({ owner: 'panel' }), panel, NOW)).toBe('resume');
    expect(waitRole(pw({ owner: 'panel' }), { ...panel, windowId: 9 }, NOW)).toBe('elsewhere');
    expect(waitRole(pw({ owner: 'panel' }), widget, NOW)).toBe('elsewhere');
  });
});

describe('take-over', () => {
  it('a newer wait supersedes ours; a stale reload (older or none) does not', () => {
    const mine = pw();
    expect(supersedes(pw({ id: 'b', startedAt: NOW + 1 }), mine)).toBe(true);
    expect(supersedes(pw({ id: 'b', startedAt: NOW - 1 }), mine)).toBe(false);
    expect(supersedes(null, mine)).toBe(false);
    expect(supersedes(mine, mine)).toBe(false);
  });
  it('says where another view waits', () => {
    expect(ownerLabel(pw({ owner: 'panel' }), { tabId: 3 })).toBe('the side panel');
    expect(ownerLabel(pw(), { tabId: 3 })).toBe('the page widget');
    expect(ownerLabel(pw(), { tabId: 4 })).toBe("another tab's page widget");
  });
});

describe('where a 2FA wait may fill (waitMayFill, review item 3)', () => {
  const at = (origin: string | null) => pw({ origin });
  it('the origin where the login started, or one of the run’s origins', () => {
    expect(waitMayFill('https://app.test', at('https://app.test'), ['https://other-app.test'])).toBe(true);
    expect(waitMayFill('https://other-app.test', at('https://app.test'), ['https://other-app.test'])).toBe(true);
    expect(waitMayFill('https://evil.test', at('https://app.test'), ['https://other-app.test'])).toBe(false);
    expect(waitMayFill('https://evil.test', at('https://app.test'), undefined)).toBe(false);
    expect(waitMayFill('https://evil.test', at(null), ['https://app.test'])).toBe(false);
  });
  it('an origin the tester confirmed; with nothing known (an older wait, a run without origins) as before', () => {
    expect(waitMayFill('https://evil.test', at('https://app.test'), [], new Set(['https://evil.test']))).toBe(true);
    expect(waitMayFill('https://any.test', at(null), undefined)).toBe(true);
  });
});

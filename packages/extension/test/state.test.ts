import { describe, expect, it } from 'vitest';
import type { WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import type { ScannedField } from '../src/shared/protocol';
import {
  actorHint,
  comparePage,
  currentStep,
  defaultVerdict,
  entriesFromScan,
  fillSummary,
  linkLabel,
  listPathFromWait,
  nextOpenStepId,
  openRequiredSteps,
  progress,
  rankLinks,
  slugify,
  subjectMatches,
  totpDelayMs,
  waitPathAfter,
} from '../src/sidepanel/state';

const step = (id: string, status: WalkthroughStepView['status'], extra: Partial<WalkthroughStepView> = {}): WalkthroughStepView =>
  ({ id, kind: 'instruction', title: id, intent: '', notes: '', optional: false, screenshot: 'off', position: 0, status, note: '', data: {}, startedAt: null, finishedAt: null, shots: [], ...extra }) as WalkthroughStepView;

const walk = (steps: WalkthroughStepView[], currentStepId: string | null = null): WalkthroughView =>
  ({
    id: 'w', key: 'k', label: '', status: 'active', executor: 'human', origin: '', storyboard: { id: 's', slug: 's', name: 'S', version: 1 },
    inputs: [], actors: { admin: { userId: 'u1', name: 'Ada Admin', email: 'ada@x.test', phone: null, role: 'admin', password: 'p', created: false } },
    vars: {}, currentStepId, steps, counts: { pending: 0, active: 0, done: 0, skipped: 0, failed: 0 },
    signoff: { verdict: null, signedOffBy: null, signedOffAt: null, note: '' }, startedAt: '', finishedAt: null, updatedAt: '', warnings: [],
  }) as WalkthroughView;

describe('step navigation', () => {
  const w = walk([step('a', 'done'), step('b', 'active'), step('c', 'pending'), step('gone', 'pending', { data: { removed: true } })], 'b');
  it('progress leaves out removed steps', () => {
    expect(progress(w)).toEqual({ finished: 1, total: 3 });
  });
  it('currentStep follows currentStepId, else the first open step', () => {
    expect(currentStep(w)?.id).toBe('b');
    expect(currentStep({ ...w, currentStepId: null })?.id).toBe('b');
    expect(currentStep(walk([step('a', 'done')]))).toBeNull();
  });
  it('nextOpenStepId moves forward, then wraps', () => {
    expect(nextOpenStepId(w, 'b')).toBe('c');
    expect(nextOpenStepId(w, 'c')).toBe('b');
    expect(nextOpenStepId(walk([step('a', 'active')]), 'a')).toBeNull();
  });
});

describe('verdict and open steps', () => {
  it('fail when a step failed, partial when a required step was skipped or not run, else pass', () => {
    expect(defaultVerdict(walk([step('a', 'done'), step('b', 'failed')]))).toBe('fail');
    expect(defaultVerdict(walk([step('a', 'done'), step('b', 'skipped')]))).toBe('partial');
    expect(defaultVerdict(walk([step('a', 'done'), step('b', 'pending')]))).toBe('partial');
    expect(defaultVerdict(walk([step('a', 'done'), step('b', 'skipped', { optional: true })]))).toBe('pass');
  });
  it('openRequiredSteps ignores optional steps', () => {
    expect(openRequiredSteps(walk([step('a', 'pending'), step('b', 'pending', { optional: true }), step('c', 'done')])).map((s) => s.id)).toEqual(['a']);
  });
  it('actorHint names the actor, not for login steps', () => {
    const w = walk([]);
    expect(actorHint(w, step('x', 'pending', { actor: 'admin' }))).toBe('You should be logged in as Ada Admin (ada@x.test)');
    expect(actorHint(w, step('x', 'pending', { actor: 'admin', kind: 'login' } as Partial<WalkthroughStepView>))).toBeNull();
    expect(actorHint(w, step('x', 'pending'))).toBeNull();
  });
});

describe('email helpers', () => {
  it('subjectMatches: substring (case-insensitive) or /regex/', () => {
    expect(subjectMatches('Your registration is confirmed', 'registration is')).toBe(true);
    expect(subjectMatches('Your registration is confirmed', '/^your reg/i')).toBe(true);
    expect(subjectMatches('Complete your payment', '/^Your/')).toBe(false);
    expect(subjectMatches(null, undefined)).toBe(true);
    expect(subjectMatches('x', '/[/')).toBe(false);
  });
  it('rankLinks puts unsubscribe last and preselects by pattern, index or a lone link', () => {
    const links = ['https://app.test/unsubscribe?u=1', 'https://app.test/confirm?t=abc', 'https://app.test/help'];
    const r = rankLinks(links, '/confirm', null);
    expect(r.links.map((l) => l.url)).toEqual(['https://app.test/confirm?t=abc', 'https://app.test/help', 'https://app.test/unsubscribe?u=1']);
    expect(r.preselected).toBe('https://app.test/confirm?t=abc');
    expect(rankLinks(links, null, 2).preselected).toBe('https://app.test/help');
    expect(rankLinks(links, null, null).preselected).toBeNull();
    expect(rankLinks(['https://a.test/x', 'https://a.test/unsubscribe'], null, null).preselected).toBe('https://a.test/x');
  });
  it('linkLabel is host + path, truncated', () => {
    expect(linkLabel('https://app.test/confirm?t=1#x')).toBe('app.test/confirm?t=1');
    expect(linkLabel(`https://app.test/${'a'.repeat(100)}`, 20)).toHaveLength(20);
  });
  it('waitPathAfter and listPathFromWait keep the filters', () => {
    const p = '/api/projects/p/messages/wait?user=u1&channel=email&since=2026-01-01T00%3A00%3A00.000Z&q=hello&timeout=60';
    expect(waitPathAfter(p, 'm9')).toBe('/api/projects/p/messages/wait?user=u1&channel=email&since=2026-01-01T00%3A00%3A00.000Z&q=hello&timeout=60&after=m9');
    expect(listPathFromWait(`${p}&after=m1`)).toBe('/api/projects/p/messages?user=u1&channel=email&since=2026-01-01T00%3A00%3A00.000Z&q=hello');
  });
});

describe('misc', () => {
  it('totpDelayMs waits for the next period under 4 s', () => {
    expect(totpDelayMs({ remaining: 20, validUntil: 10_000 }, 0)).toBe(0);
    expect(totpDelayMs({ remaining: 3, validUntil: 3_000 }, 0)).toBe(3_250);
  });
  it('fillSummary', () => {
    expect(fillSummary({ filled: 3, unmatched: 1, skipped: 0, errors: 0 })).toBe('3 filled · 1 unmatched · 0 skipped');
    expect(fillSummary({ filled: 0, unmatched: 0, skipped: 0, errors: 2 })).toContain('2 errors');
  });
  it('slugify', () => {
    expect(slugify('Sign-up page — Café!')).toBe('sign-up-page-cafe');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
  });
});

const field = (key: string, extra: Partial<ScannedField> = {}): ScannedField => ({
  key, id: key, name: null, testId: null, kind: 'text', inputType: 'text', label: null, placeholder: null, value: '', required: false, visible: true, formId: null, duplicateKey: false, ...extra,
});

describe('page data', () => {
  const fields = [field('email', { label: 'Email address', value: 'a@b.test' }), field('fld-title', { label: 'Title *', kind: 'radix-select', value: 'Mr' }), field('cv', { kind: 'skip', inputType: 'file' })];
  it('comparePage matches entries by key or label and lists the missing ones', () => {
    const r = comparePage(fields, { entries: [{ key: 'email', value: 'x', kind: 'auto' }, { key: 'title', value: 'Dr', kind: 'auto' }, { key: 'nope', value: '', kind: 'auto' }] });
    expect(r.rows.map((x) => x.entryKey)).toEqual(['email', 'title', null]);
    expect(r.missing).toEqual(['nope']);
    expect(comparePage(fields, null).missing).toEqual([]);
  });
  it('entriesFromScan keeps values and kinds, leaves out unfillable fields', () => {
    expect(entriesFromScan(fields)).toEqual([
      { key: 'email', value: 'a@b.test', kind: 'text', label: 'Email address' },
      { key: 'fld-title', value: 'Mr', kind: 'radix-select', label: 'Title *' },
    ]);
  });
});

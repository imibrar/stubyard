import { describe, expect, it } from 'vitest';
import type { WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import type { ScannedField } from '../src/shared/protocol';
import {
  actorHint,
  comparePage,
  countProgress,
  defaultOrigin,
  currentStep,
  defaultVerdict,
  entriesFromScan,
  fillSummary,
  filterStoryboards,
  groupByFirstTag,
  initialVars,
  isQuickRun,
  linkLabel,
  listPathFromWait,
  missingInputs,
  nextOpenStepId,
  oneTapQuick,
  openRequiredSteps,
  progress,
  quickRows,
  rankLinks,
  slugify,
  startBody,
  startChoices,
  subjectMatches,
  totpDelayMs,
  waitPathAfter,
} from '../src/sidepanel/state';

const step = (id: string, status: WalkthroughStepView['status'], extra: Partial<WalkthroughStepView> = {}): WalkthroughStepView =>
  ({ id, kind: 'instruction', title: id, intent: '', notes: '', optional: false, screenshot: 'off', position: 0, status, note: '', data: {}, startedAt: null, finishedAt: null, shots: [], ...extra }) as WalkthroughStepView;

const walk = (steps: WalkthroughStepView[], currentStepId: string | null = null): WalkthroughView =>
  ({
    id: 'w', key: 'k', label: '', status: 'active', mode: 'tracked', executor: 'human', origin: '', storyboard: { id: 's', slug: 's', name: 'S', version: 1 },
    inputs: [], actors: { admin: { userId: 'u1', name: 'Ada Admin', email: 'ada@x.test', phone: null, role: 'admin', password: 'p', created: false } },
    vars: {}, currentStepId, steps, counts: { pending: 0, active: 0, done: 0, skipped: 0, failed: 0 },
    signoff: { verdict: null, signedOffBy: null, signedOffAt: null, note: '' }, startedAt: '', finishedAt: null, updatedAt: '', warnings: [], cleanupStatus: 'none', cleanupAt: null,
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

describe('quick test vs tracked walkthrough', () => {
  it('startChoices puts the preferred mode first and makes it primary', () => {
    expect(startChoices('quick').map((c) => [c.mode, c.primary])).toEqual([['quick', true], ['tracked', false]]);
    expect(startChoices('tracked').map((c) => [c.mode, c.primary])).toEqual([['tracked', true], ['quick', false]]);
  });
  it('startChoices defaults to tracked first when the storyboard has no preference', () => {
    expect(startChoices(undefined)[0].mode).toBe('tracked');
    expect(startChoices(null)[0].mode).toBe('tracked');
  });
  it('startChoices labels and hints', () => {
    const [q] = startChoices('quick');
    expect(q.label).toBe('Start quick test');
    expect(q.hint).toMatch(/nothing recorded/);
    expect(startChoices('quick')[1].label).toBe('Start tracked walkthrough');
  });
  it('isQuickRun is true only for mode quick', () => {
    expect(isQuickRun({ mode: 'quick' })).toBe(true);
    expect(isQuickRun({ mode: 'tracked' })).toBe(false);
    expect(isQuickRun({})).toBe(false);
  });
  it('quickRows numbers live steps, fills vars, marks done and current', () => {
    const w = {
      ...walk(
        [
          step('a', 'done', { position: 0, title: 'Sign up {{vars.org}}' }),
          step('b', 'active', { position: 1, title: 'Confirm {{vars.missing}}' }),
          step('gone', 'pending', { position: 2, data: { removed: true } }),
          step('c', 'skipped', { position: 3, kind: 'check' }),
        ],
        'b',
      ),
      vars: { org: 'Acme' },
    } as WalkthroughView;
    const rows = quickRows(w, 'b');
    expect(rows.map((r) => [r.id, r.n, r.title, r.done, r.current])).toEqual([
      ['a', 1, 'Sign up Acme', true, false],
      ['b', 2, 'Confirm {{vars.missing}}', false, true],
      ['c', 4, 'c', true, false],
    ]);
    expect(quickRows(w, 'b', 'Confirm (rendered)')[1].title).toBe('Confirm (rendered)');
    expect(quickRows(w, null).some((r) => r.current)).toBe(false);
  });
});

describe('starting a run', () => {
  const inputs = [
    { name: 'company', label: 'Company', required: true, default: 'Acme' },
    { name: 'plan', label: 'Plan', required: true },
    { name: 'note', label: '', required: false },
  ];
  it('initialVars and missingInputs', () => {
    const vars = initialVars(inputs);
    expect(vars).toEqual({ company: 'Acme', plan: '', note: '' });
    expect(missingInputs(inputs, vars)).toEqual(['Plan']);
    expect(missingInputs(inputs, { ...vars, plan: ' pro ' })).toEqual([]);
  });
  it('defaultOrigin prefers the tab when the project lists it', () => {
    expect(defaultOrigin('https://a.test', ['https://b.test', 'https://a.test'])).toBe('https://a.test');
    expect(defaultOrigin('https://x.test', ['https://b.test'])).toBe('https://b.test');
    expect(defaultOrigin('https://x.test', [])).toBe('https://x.test');
    expect(defaultOrigin(null, [])).toBe('');
  });
  it('startBody leaves out blanks', () => {
    expect(startBody({ storyboard: 's', origin: '', label: '  ', vars: { a: 'x', b: ' ' }, actors: { admin: '', buyer: 'u1' }, mode: 'quick' })).toEqual({
      storyboard: 's',
      origin: undefined,
      label: undefined,
      vars: { a: 'x' },
      actors: { buyer: 'u1' },
      mode: 'quick',
    });
  });
  it('oneTapQuick: required inputs need defaults; actors never block', () => {
    const fresh = { key: 'p', label: '', role: 'participant', fresh: true };
    const named = { key: 'a', label: '', role: 'admin', fresh: false, user: 'ada@x.test' };
    const roleOnly = { key: 'b', label: '', role: 'buyer', fresh: false };
    expect(oneTapQuick({ inputs: [inputs[0], inputs[2]], actors: [fresh, named] })).toBe(true);
    expect(oneTapQuick({ inputs, actors: [] })).toBe(false);
    expect(oneTapQuick({ inputs: [], actors: [roleOnly] })).toBe(true);
    expect(oneTapQuick({ inputs: [], actors: [] })).toBe(true);
  });
});

describe('home lists', () => {
  const sb = (name: string, tags: string[] = [], description = '') => ({ name, slug: name.toLowerCase().replace(/ /g, '-'), tags, description });
  const list = [sb('Sign up', ['onboarding'], 'New customer confirms email'), sb('Place order', ['orders']), sb('Reset password', ['onboarding']), sb('Misc')];
  it('countProgress', () => {
    expect(countProgress({ pending: 1, active: 1, done: 3, skipped: 1, failed: 1 })).toEqual({ finished: 5, total: 7 });
  });
  it('filterStoryboards matches every word in name, tags or description', () => {
    expect(filterStoryboards(list, '').length).toBe(4);
    expect(filterStoryboards(list, 'ORDER').map((s) => s.name)).toEqual(['Place order']);
    expect(filterStoryboards(list, 'onboarding email').map((s) => s.name)).toEqual(['Sign up']);
    expect(filterStoryboards(list, 'nothing')).toEqual([]);
  });
  it('groupByFirstTag groups in order, untagged last; flat when nothing is tagged', () => {
    expect(groupByFirstTag(list).map((g) => [g.tag, g.items.map((s) => s.name)])).toEqual([
      ['onboarding', ['Sign up', 'Reset password']],
      ['orders', ['Place order']],
      [null, ['Misc']],
    ]);
    expect(groupByFirstTag([sb('A'), sb('B')])).toEqual([{ tag: null, items: [sb('A'), sb('B')] }]);
    expect(groupByFirstTag([])).toEqual([]);
  });
});

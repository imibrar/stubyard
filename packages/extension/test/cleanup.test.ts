import { describe, expect, it } from 'vitest';
import { StubyardError } from '@stubyard/client/http';
import {
  afterPreview,
  amountText,
  type CleanupConflict,
  type CleanupItem,
  type CleanupResult,
  type CleanupRunRef,
  type CleanupUser,
  cleanupBody,
  cleanupEntryLabel,
  confirmText,
  conflictLines,
  conflictsFromError,
  createdUsers,
  EMPTY_SELECTION,
  isCleanable,
  keptReason,
  pruneSelection,
  resolveConflicts,
  resultSummary,
  runTitle,
  selectionEstimate,
  toggleAll,
  toggleRun,
  toggleUser,
  userChecked,
  userLabel,
} from '../src/sidepanel/cleanup';

const ref = (key: string, extra: Partial<CleanupRunRef> = {}): CleanupRunRef => ({
  id: `w-${key}`, key, label: '', status: 'finished', mode: 'quick', storyboard: { slug: 'signup', name: 'Sign up' }, ...extra,
});

const user = (id: string, extra: Partial<CleanupUser> = {}): CleanupUser => ({
  userId: id, name: '', email: `${id}@x.test`, role: 'member', exists: true, keep: false, messages: 2, usedBy: [], ...extra,
});

const item = (key: string, users: CleanupUser[], extra: Partial<CleanupItem['walkthrough']> = {}): CleanupItem => ({
  walkthrough: { ...ref(key), cleanupStatus: 'pending', cleanupAt: null, startedAt: '2026-11-22T10:00:00Z', finishedAt: '2026-11-22T10:05:00Z', ...extra },
  users,
  vars: {},
  uses: [],
  removable: { users: users.length, messages: users.length * 2, record: true },
  warnings: [],
  lastReport: null,
});

const result = (extra: Partial<CleanupResult> = {}): CleanupResult => ({ dryRun: false, runs: [], conflicts: [], totals: { users: 0, messages: 0, records: 0 }, ...extra });

describe('labels', () => {
  it('runTitle: label, else storyboard name, else key', () => {
    expect(runTitle(ref('K1', { label: ' Ada run ' }))).toBe('Ada run');
    expect(runTitle(ref('K1'))).toBe('Sign up');
    expect(runTitle(ref('K1', { storyboard: null }))).toBe('K1');
  });
  it('userLabel', () => {
    expect(userLabel({ userId: 'u', name: 'Ada', email: 'a@x' })).toBe('Ada (a@x)');
    expect(userLabel({ userId: 'u', name: '', email: 'a@x' })).toBe('a@x');
    expect(userLabel({ userId: 'u', name: '', email: null })).toBe('u');
  });
  it('amountText', () => {
    expect(amountText({ users: 1, messages: 3, record: true })).toBe('1 user · 3 messages · run record');
    expect(amountText({ users: 2, messages: 0, records: 2 })).toBe('2 users · 2 run records');
    expect(amountText({ users: 0, messages: 0, record: false })).toBe('nothing');
  });
  it('the Home entry shows only with pending runs', () => {
    expect(cleanupEntryLabel({ pending: 3, active: 1, cleaned: 0, dismissed: 0 })).toBe('Clean up · 3');
    expect(cleanupEntryLabel({ pending: 0, active: 2, cleaned: 5, dismissed: 1 })).toBeNull();
    expect(cleanupEntryLabel(null)).toBeNull();
  });
  it('keptReason', () => {
    expect(keptReason({ userId: 'u', email: null, reason: 'keep' })).toBe('pinned with Keep');
    expect(keptReason({ userId: 'u', email: null, reason: 'skipped' })).toBe('unchecked by you');
    expect(keptReason({ userId: 'u', email: null, reason: 'used-by', usedBy: [ref('K2'), ref('K3')] })).toBe('still used by K2, K3');
    expect(keptReason({ userId: 'u', email: null, reason: 'used-by-active', usedBy: [ref('K4')] })).toBe('still used by active run K4');
  });
  it('conflictLines name the user and the runs that use it', () => {
    const c: CleanupConflict = { userId: 'u1', email: 'u1@x.test', walkthrough: ref('A'), usedBy: [ref('B', { label: 'Second' })] };
    expect(conflictLines([c])).toEqual(['u1@x.test (from A) is also used by run B (Second)']);
    expect(conflictLines([{ ...c, email: null, usedBy: [ref('B', { storyboard: null }), ref('C', { storyboard: null })] }])).toEqual(['u1 (from A) is also used by runs B, C']);
  });
  it('resultSummary', () => {
    const r = result({
      totals: { users: 2, messages: 4, records: 1 },
      runs: [
        { id: 'a', key: 'A', label: '', mode: 'quick', status: 'cleaned', removed: { users: 2, messages: 4, record: true }, kept: [], vars: {} },
        { id: 'b', key: 'B', label: '', mode: 'tracked', status: 'partial', removed: { users: 0, messages: 0, record: false }, kept: [{ userId: 'u', email: null, reason: 'used-by' }], vars: {} },
      ],
    });
    expect(resultSummary(r)).toBe('Removed 2 users · 4 messages · 1 run record; kept 1 user; 1 run partly cleaned');
  });
});

describe('selection', () => {
  const a = item('A', [user('u1'), user('u2', { messages: 5 }), user('kept', { keep: true }), user('gone', { exists: false })]);
  const b = item('B', [user('u3')]);
  const active = item('C', [user('u4')], { status: 'active' });
  const dismissed = item('D', [user('u5')], { cleanupStatus: 'dismissed' });
  const items = [a, b, active, dismissed];

  it('only pending, non-active runs are cleanable', () => {
    expect(items.map(isCleanable)).toEqual([true, true, false, false]);
  });
  it('a run whose only user is shared with another run is cleanable (the conflict dialog decides)', () => {
    const shared = { ...item('S', [user('s1', { usedBy: [ref('B')] })]), removable: { users: 0, messages: 0, record: false } };
    expect(isCleanable(shared)).toBe(true);
    const keptOnly = { ...item('K', [user('k1', { keep: true }), user('g1', { exists: false })]), removable: { users: 0, messages: 0, record: false } };
    expect(isCleanable(keptOnly)).toBe(false);
  });
  it('toggleRun and toggleUser', () => {
    let s = toggleRun(EMPTY_SELECTION, 'w-A');
    expect(s.runs).toEqual(['w-A']);
    expect(toggleRun(s, 'w-A', true)).toBe(s);
    s = toggleUser(s, 'u1', false);
    expect(userChecked(s, a.users[0])).toBe(false);
    expect(userChecked(toggleUser(s, 'u1'), a.users[0])).toBe(true);
    expect(userChecked(s, a.users[2])).toBe(false); // keep: never checked
    expect(userChecked(s, a.users[3])).toBe(false); // already deleted
    expect(toggleRun(s, 'w-A').runs).toEqual([]);
  });
  it('toggleAll selects the cleanable runs, then clears them', () => {
    const s = toggleAll(EMPTY_SELECTION, items);
    expect(s.runs).toEqual(['w-A', 'w-B']);
    expect(toggleAll(s, items).runs).toEqual([]);
    expect(toggleAll({ runs: ['w-A'], skip: [] }, items).runs).toEqual(['w-A', 'w-B']);
  });
  it('pruneSelection drops runs that left the list', () => {
    const s = { runs: ['w-A', 'w-B', 'w-X'], skip: ['u1'] };
    expect(pruneSelection(s, [a])).toEqual({ runs: ['w-A'], skip: ['u1'] });
    const same = { runs: ['w-A'], skip: [] };
    expect(pruneSelection(same, items)).toBe(same);
  });
  it('selectionEstimate counts checked users and their messages', () => {
    expect(selectionEstimate({ runs: ['w-A', 'w-B'], skip: ['u1'] }, items)).toEqual({ runs: 2, users: 2, messages: 7 });
  });
  it('cleanupBody: selected runs, skipUsers of those runs only, flags only when set', () => {
    const s = { runs: ['w-A'], skip: ['u1', 'u3'] };
    expect(cleanupBody(s, items)).toEqual({ walkthroughs: ['w-A'], skipUsers: ['u1'] });
    expect(cleanupBody({ runs: ['w-B'], skip: ['u1'] }, items, { dryRun: true, onConflict: 'ask' })).toEqual({ walkthroughs: ['w-B'], dryRun: true });
    expect(cleanupBody({ runs: ['w-B'], skip: [] }, items, { onConflict: 'include' })).toEqual({ walkthroughs: ['w-B'], onConflict: 'include' });
  });
});

describe('flow', () => {
  const body = { walkthroughs: ['w-A'], skipUsers: ['u1'] };
  const conflict: CleanupConflict = { userId: 'u2', email: null, walkthrough: ref('A'), usedBy: [ref('B')] };
  it('afterPreview asks about conflicts, else goes on', () => {
    expect(afterPreview(result({ dryRun: true }), body)).toBeNull();
    expect(afterPreview(result({ dryRun: true, conflicts: [conflict] }), body)).toEqual({ kind: 'conflicts', conflicts: [conflict], body });
  });
  it('resolveConflicts sets the choice and drops dryRun', () => {
    expect(resolveConflicts({ ...body, dryRun: true }, 'include')).toEqual({ ...body, onConflict: 'include' });
    expect(resolveConflicts(body, 'keep')).toEqual({ ...body, onConflict: 'keep' });
  });
  it('confirmText names the runs and what goes (also after Clean both)', () => {
    const run = (key: string, label = '', kept = 0) => ({ id: key, key, label, mode: 'quick' as const, status: 'cleaned' as const, removed: { users: 1, messages: 0, record: false }, kept: Array.from({ length: kept }, (_, i) => ({ userId: `k${i}`, email: null, reason: 'keep' as const })), vars: {} });
    expect(confirmText(result({ dryRun: true, runs: [run('A', 'First')], totals: { users: 1, messages: 2, records: 0 } }))).toBe('Clean up First? This deletes 1 user · 2 messages.');
    expect(confirmText(result({ dryRun: true, runs: [run('A'), run('B', '', 1)], totals: { users: 2, messages: 0, records: 1 } }))).toBe('Clean up 2 runs (A, B)? This deletes 2 users · 1 run record. 1 user stays.');
    const many = result({ dryRun: true, runs: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((k) => run(k)), totals: { users: 7, messages: 0, records: 0 } });
    expect(confirmText(many)).toBe('Clean up 7 runs (A, B, C, D, E +2 more)? This deletes 7 users.');
  });
  it('conflictsFromError reads a 409 body', () => {
    expect(conflictsFromError(new StubyardError(409, 'x', undefined, { error: 'x', conflicts: [conflict] }))).toEqual([conflict]);
    expect(conflictsFromError(new StubyardError(409, 'x', { conflicts: [conflict] }, { error: 'x', details: { conflicts: [conflict] } }))).toEqual([conflict]);
    expect(conflictsFromError(new StubyardError(409, 'Walkthrough K is still active', undefined, { error: 'x' }))).toBeNull();
    expect(conflictsFromError(new StubyardError(404, 'x', undefined, { conflicts: [conflict] }))).toBeNull();
    expect(conflictsFromError(new Error('x'))).toBeNull();
  });
  it('createdUsers counts fresh actors', () => {
    const a = { userId: 'u', name: '', email: null, phone: null, role: 'r', password: '' };
    expect(createdUsers({ actors: { x: { ...a, created: true }, y: { ...a, created: false }, z: { ...a, created: true } } })).toBe(2);
    expect(createdUsers({ actors: {} })).toBe(0);
  });
});

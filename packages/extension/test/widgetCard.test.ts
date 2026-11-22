// The widget's card (src/widget/WidgetCard.tsx) rendered with React in happy-dom against a mocked client: the
// tracked footer (Fail opens the note first), login and email controls in the card, the quick footer, and Quick Finish handing
// over to the panel's cleanup when the run created users.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedStep, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { StepHostContext, type StepHost } from '../src/run/host';
import type { RunState } from '../src/run/useRun';
import { WidgetCard, type WidgetUi } from '../src/widget/WidgetCard';

const api = vi.hoisted(() => ({ updateStep: vi.fn(), patchWalkthrough: vi.fn(), finishWalkthrough: vi.fn(), addScreenshot: vi.fn(), getWalkthrough: vi.fn() }));
vi.mock('@stubyard/client/walkthroughs', () => api);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, kind: string, status: WalkthroughStepView['status'] = 'active', position = 0) =>
  ({ id, kind, title: `Step ${id}`, intent: 'Do it.', notes: '', optional: false, screenshot: 'off', position, status, note: '', data: {}, startedAt: null, finishedAt: null, shots: [] }) as unknown as WalkthroughStepView;
const walk = (o: Partial<WalkthroughView> & { steps: WalkthroughStepView[] }): WalkthroughView =>
  ({ id: 'w1', status: 'active', mode: 'tracked', currentStepId: o.steps[0]?.id ?? null, vars: {}, warnings: [], actors: {}, storyboard: { name: 'Board' }, cleanupStatus: 'none', ...o }) as unknown as WalkthroughView;
const resolvedOf = (s: WalkthroughStepView) => ({ step: { id: s.id, kind: s.kind }, warnings: [], text: {} }) as unknown as ResolvedStep;
const runOf = (w: WalkthroughView, apply = vi.fn()): RunState => {
  const s = w.steps.find((x) => x.id === w.currentStepId) ?? null;
  return { w, loadError: null, step: s, resolved: s ? { stepId: s.id, r: resolvedOf(s) } : null, resolveError: null, reresolve: () => {}, apply };
};

let root: Root;
let el: HTMLElement;
let host: StepHost;
let ui: WidgetUi;
const t = { apiUrl: 'http://hub.test', project: 'p' };
const render = (run: RunState) => act(async () => root.render(createElement(StepHostContext.Provider, { value: host }, createElement(WidgetCard, { t, run, ui }))));
const btn = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement;
const click = (label: string) => act(async () => btn(label).click());

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  host = { surface: 'widget', compact: true, tab: { id: 3, windowId: 1, url: 'http://app.test/' }, windowId: 1, target: (p) => ({ apiUrl: 'http://hub.test', project: p }), notify: vi.fn(), fillRequest: 0, openWalkthrough: vi.fn(async () => {}), widgetOn: vi.fn(async () => true) };
  ui = { openPanel: vi.fn(), collapse: vi.fn(), hide: vi.fn() };
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

describe('tracked', () => {
  it('shows the count, title, kind and the tools', async () => {
    await render(runOf(walk({ steps: [step('a', 'instruction'), step('b', 'check', 'pending', 1)] })));
    expect(el.textContent).toContain('1 / 2');
    expect(el.querySelector('.w-title')?.getAttribute('dir')).toBe('auto');
    expect(el.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('stubyard step 1 of 2: Step a');
    await click('Collapse the widget');
    await click('Hide on this tab');
    await click('Open the side panel');
    expect(ui.collapse).toHaveBeenCalled();
    expect(ui.hide).toHaveBeenCalled();
    expect(ui.openPanel).toHaveBeenCalled();
  });

  it('Fail opens the note first, then records failed with it', async () => {
    const w = walk({ steps: [step('a', 'instruction')] });
    api.updateStep.mockResolvedValue(w);
    await render(runOf(w));
    expect(el.querySelector('textarea')).toBeNull();
    await click('Fail');
    expect(api.updateStep).not.toHaveBeenCalled();
    const ta = el.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'broken');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Fail');
    expect(api.updateStep).toHaveBeenCalledWith(t, 'w1', 'a', { status: 'failed', note: 'broken' });
  });

  it('Done records without a note; Next moves the current step', async () => {
    const w = walk({ steps: [step('a', 'instruction'), step('b', 'instruction', 'pending', 1)] });
    api.updateStep.mockResolvedValue(w);
    api.patchWalkthrough.mockResolvedValue(w);
    await render(runOf(w));
    await click('Done');
    expect(api.updateStep).toHaveBeenCalledWith(t, 'w1', 'a', { status: 'done', note: '' });
    await click('Next');
    expect(api.patchWalkthrough).toHaveBeenCalledWith(t, 'w1', { currentStepId: 'b' });
  });

  it('login and email steps run in the widget (no "Continue in panel" since phase 1b)', async () => {
    const login = { step: { id: 'a', kind: 'login' }, warnings: [], text: {}, url: null, username: 'ada@example.test', password: 'pw', selectors: { username: '#u', password: '#p' }, actor: { name: 'Ada', role: 'admin' }, twoFactor: { kind: 'none' } };
    const w = walk({ steps: [step('a', 'login')] });
    await render({ ...runOf(w), resolved: { stepId: 'a', r: login as unknown as ResolvedStep } });
    expect(el.textContent).not.toMatch(/Continue in panel/);
    expect(btn('Fill login')).toBeTruthy();
    expect(el.querySelector('.creds-compact')?.textContent).toContain('ada@example.test');
    expect(btn('Done')).toBeTruthy();
    const email = { step: { id: 'a', kind: 'email' }, warnings: [], text: {}, channel: 'email', user: { email: 'ada@example.test' }, subject: 'Welcome', waitPath: '/w', linkPattern: null, linkIndex: null, open: 'same-tab' };
    const we = walk({ steps: [step('a', 'email')] });
    await render({ ...runOf(we), resolved: { stepId: 'a', r: email as unknown as ResolvedStep } });
    expect(el.textContent).not.toMatch(/Continue in panel/);
    expect(btn('Wait for message')).toBeTruthy();
  });

  it('all steps finished: sign off in the panel', async () => {
    await render(runOf(walk({ steps: [step('a', 'instruction', 'done')], currentStepId: null })));
    expect(el.textContent).toContain('Sign off in the panel');
    expect(btn('Open panel')).toBeTruthy();
  });
});

describe('quick', () => {
  it('action buttons only: Next ✓ and Finish', async () => {
    const w = walk({ mode: 'quick', steps: [step('a', 'instruction')] });
    api.updateStep.mockResolvedValue(w);
    await render(runOf(w));
    expect(btn('Skip')).toBeUndefined();
    expect(btn('Fail')).toBeUndefined();
    await click('Next ✓');
    expect(api.updateStep).toHaveBeenCalledWith(t, 'w1', 'a', { status: 'done' });
  });

  it('Finish closes a run that created nobody', async () => {
    const w = walk({ mode: 'quick', steps: [step('a', 'instruction')] });
    api.finishWalkthrough.mockResolvedValue({ ...w, status: 'finished' });
    await render(runOf(w));
    await click('Finish');
    expect(host.openWalkthrough).toHaveBeenCalledWith(null);
    expect(host.notify).toHaveBeenCalledWith('Quick test finished');
  });

  it('Finish of a run that created users hands over to the panel cleanup', async () => {
    const actors = { new: { name: 'New User', created: true } } as unknown as WalkthroughView['actors'];
    const w = walk({ mode: 'quick', steps: [step('a', 'instruction')], actors });
    const done = { ...w, status: 'finished', cleanupStatus: 'pending' } as WalkthroughView;
    api.finishWalkthrough.mockResolvedValue(done);
    const apply = vi.fn();
    await render(runOf(w, apply));
    await click('Finish');
    expect(apply).toHaveBeenCalledWith(done);
    expect(host.openWalkthrough).not.toHaveBeenCalled();
    await render(runOf(done));
    expect(el.textContent).toContain('It created 1 test user. Clean it up in the panel.');
    expect(btn('Close')).toBeUndefined();
    await click('Open panel');
    expect(ui.openPanel).toHaveBeenCalled();
  });
});

// Class PROvia gaps: the instruction highlight uses the hub's resolved target ({{vars.x}} rendered), and the Start
// screen warns before a storyboard with fresh actors runs in a project without a default password.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedStep, StoryboardView, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { StepHostContext, type StepHost } from '../src/run/host';
import { NoDefaultPassword } from '../src/sidepanel/screens/Start';
import { FALLBACK_PASSWORD, missingDefaultPassword, projectSettingsUrl, stepTarget } from '../src/sidepanel/state';
import { StepControls } from '../src/sidepanel/steps/StepCard';

const tabsApi = vi.hoisted(() => ({ sendToTab: vi.fn(), openUrl: vi.fn() }));
vi.mock('@stubyard/client/walkthroughs', () => ({ updateStep: vi.fn(), getWalkthrough: vi.fn(), patchWalkthrough: vi.fn(), addScreenshot: vi.fn(), finishWalkthrough: vi.fn() }));
vi.mock('@stubyard/client/http', () => ({ hubJson: vi.fn(async () => []) }));
vi.mock('../src/sidepanel/tabs', async (orig) => ({ ...(await orig<typeof import('../src/sidepanel/tabs')>()), ...tabsApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RAW = { selector: '[data-testid="pay-bank-{{vars.regNo}}"]', text: 'Pay {{vars.regNo}}' };
const resolvedOf = (target: ResolvedStep['target'] | undefined) =>
  ({ step: { id: 's1', kind: 'instruction', target: RAW }, warnings: [], text: {}, ...(target === undefined ? {} : { target }) }) as unknown as ResolvedStep;

describe('stepTarget', () => {
  it('prefers the resolved target, falls back to the raw step target for an older hub', () => {
    expect(stepTarget(resolvedOf({ selector: '[data-testid="pay-bank-R-1"]', text: 'Pay R-1' }))).toEqual({ selector: '[data-testid="pay-bank-R-1"]', text: 'Pay R-1' });
    expect(stepTarget(resolvedOf({ selector: '#a', text: null }))).toEqual({ selector: '#a', text: undefined });
    expect(stepTarget(resolvedOf(null))).toBeNull();
    expect(stepTarget(resolvedOf({ selector: null, text: null }))).toBeNull();
    expect(stepTarget(resolvedOf(undefined))).toEqual(RAW);
    expect(stepTarget({ step: { id: 's', kind: 'instruction' } } as unknown as ResolvedStep)).toBeNull();
  });
});

describe('missingDefaultPassword', () => {
  const sb = (actors: Array<{ key: string; label?: string; fresh?: boolean }>) => ({ actors }) as unknown as Pick<StoryboardView, 'actors'>;
  it('lists the fresh actors when the project has no default password', () => {
    expect(missingDefaultPassword(sb([{ key: 'participant', fresh: true }, { key: 'admin' }]), {})).toEqual(['participant']);
    expect(missingDefaultPassword(sb([{ key: 'p', label: 'Participant', fresh: true }]), null)).toEqual(['Participant']);
    expect(missingDefaultPassword(sb([{ key: 'p', fresh: true }]), { defaultPassword: '   ' })).toEqual(['p']);
    expect(missingDefaultPassword(sb([{ key: 'p', fresh: true }]), { defaultPassword: 'Str0ng!Pass' })).toBeNull();
    expect(missingDefaultPassword(sb([{ key: 'admin' }]), {})).toBeNull();
  });
  it('links to the project settings page', () => {
    expect(projectSettingsUrl('http://hub.test:4100/', 'class provia')).toBe('http://hub.test:4100/p/class%20provia/settings');
  });
});

let root: Root;
let el: HTMLElement;
beforeEach(() => {
  tabsApi.sendToTab.mockReset();
  tabsApi.sendToTab.mockImplementation(async (_tab, req: { type: string }) => (req.type === 'highlight' ? { found: true } : { ok: true }));
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

describe('instruction highlight', () => {
  const step = { id: 's1', kind: 'instruction', title: 'Pay', intent: '', notes: '', optional: false, screenshot: 'off', position: 0, status: 'active', note: '', data: {}, startedAt: null, finishedAt: null, shots: [], timeoutSec: 60 } as unknown as WalkthroughStepView;
  const w = { id: 'w1', status: 'active', mode: 'tracked', currentStepId: 's1', vars: { regNo: 'R-1' }, warnings: [], actors: {}, storyboard: { name: 'B' }, steps: [step] } as unknown as WalkthroughView;
  const host = { surface: 'panel', compact: false, tab: { id: 3, windowId: 1, url: 'http://app.test/payments' }, windowId: 1, target: (p: string) => ({ apiUrl: 'http://hub.test', project: p }), notify: vi.fn(), fillRequest: 0, openWalkthrough: vi.fn(async () => {}), widgetOn: vi.fn(async () => true), openPanel: vi.fn(), setBusy: vi.fn() } as unknown as StepHost;
  const render = (resolved: ResolvedStep) =>
    act(async () => root.render(createElement(StepHostContext.Provider, { value: host }, createElement(StepControls, { t: { apiUrl: 'http://hub.test', project: 'p' }, w, step, resolved, apply: () => {} }))));
  const highlight = async () => {
    const b = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Highlight')!;
    await act(async () => b.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    return tabsApi.sendToTab.mock.calls.filter((c) => c[1].type === 'highlight').map((c) => c[1]);
  };

  it('sends the rendered selector and text, not the template', async () => {
    await render(resolvedOf({ selector: '[data-testid="pay-bank-R-1"]', text: 'Pay R-1' }));
    expect(await highlight()).toEqual([{ type: 'highlight', selector: '[data-testid="pay-bank-R-1"]', text: 'Pay R-1' }]);
  });

  it('shows no Highlight button when the resolved target is empty', async () => {
    await render(resolvedOf(null));
    expect([...el.querySelectorAll('button')].some((x) => x.textContent?.trim() === 'Highlight')).toBe(false);
  });
});

describe('Start screen warning', () => {
  it('names the fresh actors, the fallback password, and opens the settings page', async () => {
    const create = vi.fn(async () => ({}));
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { create } };
    await act(async () => root.render(createElement(NoDefaultPassword, { actors: ['participant'], url: 'http://hub.test/p/cp/settings' })));
    const box = el.querySelector('[data-testid="no-default-password"]')!;
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain('participant');
    expect(box.textContent).toContain(FALLBACK_PASSWORD);
    await act(async () => (box.querySelector('button') as HTMLButtonElement).click());
    expect(create).toHaveBeenCalledWith({ url: 'http://hub.test/p/cp/settings' });
  });
});

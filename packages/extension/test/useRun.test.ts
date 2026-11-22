// useRun (the run loader shared by the side panel and the widget) and the StepHost context, rendered with React in
// happy-dom against a mocked @stubyard/client/walkthroughs.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedStep, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { StepHostContext, useStepHost, type StepHost } from '../src/run/host';
import { resolvedFor, useRun, type RunState } from '../src/run/useRun';
import type { HubTarget } from '../src/sidepanel/hub';

const api = vi.hoisted(() => ({ getWalkthrough: vi.fn(), resolveStep: vi.fn() }));
vi.mock('@stubyard/client/walkthroughs', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, status: WalkthroughStepView['status'], position = 0): WalkthroughStepView =>
  ({ id, kind: 'instruction', title: id, intent: '', notes: '', optional: false, screenshot: 'off', position, status, note: '', data: {}, startedAt: null, finishedAt: null, shots: [] }) as unknown as WalkthroughStepView;
const walk = (id: string, steps: WalkthroughStepView[], currentStepId: string | null, status = 'active'): WalkthroughView =>
  ({ id, status, mode: 'tracked', currentStepId, steps, vars: {}, warnings: [] }) as unknown as WalkthroughView;
const resolvedOf = (stepId: string) => ({ step: { id: stepId, kind: 'instruction' }, warnings: [] }) as unknown as ResolvedStep;

let root: Root;
let host: HTMLElement;
let state: RunState;
const t: HubTarget = { apiUrl: 'http://hub.test', project: 'p' };

function Probe(props: { t: HubTarget | null; id: string | null; tick: number }) {
  state = useRun(props.t, props.id, props.tick);
  return null;
}
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const flush = () => act(async () => {});

beforeEach(() => {
  api.getWalkthrough.mockReset();
  api.resolveStep.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('useRun', () => {
  it('does nothing without a run', async () => {
    await render(createElement(Probe, { t: null, id: null, tick: 0 }));
    expect(state.w).toBeNull();
    expect(state.step).toBeNull();
    expect(api.getWalkthrough).not.toHaveBeenCalled();
  });

  it('loads the run, finds the current step and resolves it', async () => {
    api.getWalkthrough.mockResolvedValue(walk('w1', [step('a', 'done'), step('b', 'active', 1)], 'b'));
    api.resolveStep.mockResolvedValue(resolvedOf('b'));
    await render(createElement(Probe, { t, id: 'w1', tick: 0 }));
    await flush();
    expect(api.getWalkthrough).toHaveBeenCalledWith(t, 'w1');
    expect(state.w?.id).toBe('w1');
    expect(state.step?.id).toBe('b');
    expect(api.resolveStep).toHaveBeenCalledWith(t, 'w1', 'b');
    expect(state.resolved?.stepId).toBe('b');
    expect(resolvedFor(state.resolved, 'b')).not.toBeNull();
    expect(resolvedFor(state.resolved, 'a')).toBeNull();
  });

  it('reloads on every tick and resolves again when the current step moved', async () => {
    api.getWalkthrough.mockResolvedValueOnce(walk('w1', [step('a', 'active'), step('b', 'pending', 1)], 'a'));
    api.resolveStep.mockImplementation(async (_t: HubTarget, _id: string, s: string) => resolvedOf(s));
    await render(createElement(Probe, { t, id: 'w1', tick: 0 }));
    await flush();
    expect(state.step?.id).toBe('a');
    api.getWalkthrough.mockResolvedValueOnce(walk('w1', [step('a', 'done'), step('b', 'active', 1)], 'b'));
    await render(createElement(Probe, { t, id: 'w1', tick: 1 }));
    await flush();
    expect(api.getWalkthrough).toHaveBeenCalledTimes(2);
    expect(state.step?.id).toBe('b');
    expect(api.resolveStep).toHaveBeenLastCalledWith(t, 'w1', 'b');
    expect(state.resolved?.stepId).toBe('b');
  });

  it('a new t object with the same project and URL does not reload', async () => {
    api.getWalkthrough.mockResolvedValue(walk('w1', [step('a', 'active')], 'a'));
    api.resolveStep.mockResolvedValue(resolvedOf('a'));
    await render(createElement(Probe, { t, id: 'w1', tick: 0 }));
    await flush();
    await render(createElement(Probe, { t: { ...t }, id: 'w1', tick: 0 }));
    await flush();
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1);
  });

  it('shows load and resolve errors; reresolve retries', async () => {
    api.getWalkthrough.mockRejectedValueOnce(new Error('hub down'));
    await render(createElement(Probe, { t, id: 'w1', tick: 0 }));
    await flush();
    expect(state.loadError).toBe('hub down');
    api.getWalkthrough.mockResolvedValue(walk('w1', [step('a', 'active')], 'a'));
    api.resolveStep.mockRejectedValueOnce(new Error('no actor'));
    await render(createElement(Probe, { t, id: 'w1', tick: 1 }));
    await flush();
    expect(state.loadError).toBeNull();
    expect(state.resolveError).toBe('no actor');
    expect(state.resolved).toBeNull();
    api.resolveStep.mockResolvedValueOnce(resolvedOf('a'));
    await act(async () => state.reresolve());
    await flush();
    expect(state.resolveError).toBeNull();
    expect(state.resolved?.stepId).toBe('a');
  });

  it('apply shows the returned view; a finished run is not resolved', async () => {
    api.getWalkthrough.mockResolvedValue(walk('w1', [step('a', 'active')], 'a'));
    api.resolveStep.mockResolvedValue(resolvedOf('a'));
    await render(createElement(Probe, { t, id: 'w1', tick: 0 }));
    await flush();
    await act(async () => state.apply(walk('w1', [step('a', 'done')], null, 'finished')));
    expect(state.w?.status).toBe('finished');
    expect(api.resolveStep).toHaveBeenCalledTimes(1);
  });

  it('ignores a late answer for a run that is no longer open', async () => {
    let late: (v: WalkthroughView) => void = () => {};
    api.getWalkthrough.mockImplementationOnce(() => new Promise((r) => (late = r)));
    api.getWalkthrough.mockResolvedValueOnce(walk('w2', [step('x', 'active')], 'x'));
    api.resolveStep.mockResolvedValue(resolvedOf('x'));
    await render(createElement(Probe, { t, id: 'w1', tick: 0 }));
    await render(createElement(Probe, { t, id: 'w2', tick: 0 }));
    await flush();
    await act(async () => late(walk('w1', [step('a', 'active')], 'a')));
    expect(state.w?.id).toBe('w2');
  });
});

describe('StepHost', () => {
  it('useStepHost returns the provided host and throws outside one', async () => {
    const h: StepHost = { surface: 'widget', tab: null, windowId: 1, target: (p) => ({ apiUrl: 'x', project: p }), notify: () => {}, fillRequest: 0, openWalkthrough: async () => {}, compact: true };
    let seen: StepHost | null = null;
    const Use = () => {
      seen = useStepHost();
      return null;
    };
    await render(createElement(StepHostContext.Provider, { value: h }, createElement(Use)));
    expect(seen).toBe(h);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let thrown: unknown = null;
    const Bad = () => {
      try {
        useStepHost();
      } catch (e) {
        thrown = e;
      }
      return null;
    };
    await render(createElement(Bad));
    err.mockRestore();
    expect(String(thrown)).toMatch(/outside StepHostContext/);
  });
});

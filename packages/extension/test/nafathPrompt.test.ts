// The fake Nafath prompt (run/NafathPrompt.tsx): which requests it shows, the 2 s polling, choosing a number and
// rejecting, rendered with React in happy-dom against a mocked @stubyard/client/nafath.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NafathRequest } from '@stubyard/client/nafath';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { StepHostContext, type StepHost } from '../src/run/host';
import { actorRequests, NAFATH_POLL_MS, NafathPrompt } from '../src/run/NafathPrompt';
import type { HubTarget } from '../src/sidepanel/hub';

const api = vi.hoisted(() => ({ listNafathRequests: vi.fn(), chooseNafathNumber: vi.fn(), rejectNafathRequest: vi.fn() }));
vi.mock('@stubyard/client/nafath', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor = (userId: string, name: string, missing = false) => ({ userId, name, email: null, phone: null, role: 'r', password: '', created: false, ...(missing ? { missing: true as const } : {}) });
const walk = (status = 'active'): WalkthroughView =>
  ({ id: 'w1', status, actors: { applicant: actor('u1', 'Mohammed'), gone: actor('u3', 'Gone', true) }, steps: [], vars: {} }) as unknown as WalkthroughView;
const req = (id: string, user: string | null, status = 'WAITING', createdAt = '2026-01-01T00:00:00.000Z'): NafathRequest =>
  ({ id, testUserId: user, status, random: '42', choices: ['17', '42', '88'], service: 'Login', createdAt, reason: null }) as unknown as NafathRequest;

const t: HubTarget = { apiUrl: 'http://hub.test', project: 'p' };
let root: Root;
let host: HTMLElement;
const notify = vi.fn();
const stepHost = { surface: 'widget', notify } as unknown as StepHost;

const render = (w: WalkthroughView) => act(async () => root.render(createElement(StepHostContext.Provider, { value: stepHost }, createElement(NafathPrompt, { t, w }))));
const flush = () => act(async () => {});
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  for (const f of Object.values(api)) f.mockReset();
  notify.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('actorRequests', () => {
  it('keeps the WAITING requests of present actors, oldest first', () => {
    const list = [req('b', 'u1', 'WAITING', '2026-01-02T00:00:00.000Z'), req('a', 'u1'), req('c', 'u2'), req('d', null), req('e', 'u1', 'COMPLETED'), req('f', 'u3')];
    expect(actorRequests(walk(), list).map((x) => [x.request.id, x.actor, x.name])).toEqual([
      ['a', 'applicant', 'Mohammed'],
      ['b', 'applicant', 'Mohammed'],
    ]);
  });
});

describe('NafathPrompt', () => {
  it('shows the three numbers and Reject while a request waits, and polls every 2 s', async () => {
    api.listNafathRequests.mockResolvedValue([req('r1', 'u1')]);
    await render(walk());
    await flush();
    expect(api.listNafathRequests).toHaveBeenCalledWith(t, { status: 'WAITING', limit: 50 });
    expect(host.textContent).toContain('Nafath request for Mohammed');
    expect(buttons()).toEqual(['17', '42', '88', 'Reject']);
    api.listNafathRequests.mockResolvedValue([]);
    await act(async () => vi.advanceTimersByTime(NAFATH_POLL_MS));
    await flush();
    expect(api.listNafathRequests).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe('');
  });

  it('chooses a number, notifies and drops the request', async () => {
    api.listNafathRequests.mockResolvedValueOnce([req('r1', 'u1')]).mockResolvedValue([]);
    api.chooseNafathNumber.mockResolvedValue({ ...req('r1', 'u1', 'COMPLETED') });
    await render(walk());
    await flush();
    const n42 = [...host.querySelectorAll('button')].find((b) => b.textContent === '42')!;
    await act(async () => n42.click());
    await flush();
    expect(api.chooseNafathNumber).toHaveBeenCalledWith(t, 'r1', '42');
    expect(notify).toHaveBeenCalledWith('Nafath: approved for Mohammed');
    expect(host.textContent).toBe('');
  });

  it('rejects', async () => {
    api.listNafathRequests.mockResolvedValueOnce([req('r1', 'u1')]).mockResolvedValue([]);
    api.rejectNafathRequest.mockResolvedValue({ ...req('r1', 'u1', 'REJECTED'), reason: 'rejected' });
    await render(walk());
    await flush();
    const reject = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reject')!;
    await act(async () => reject.click());
    await flush();
    expect(api.rejectNafathRequest).toHaveBeenCalledWith(t, 'r1');
    expect(notify).toHaveBeenCalledWith('Nafath: rejected for Mohammed');
  });

  it('does not poll for a walkthrough that is not active', async () => {
    await render(walk('finished'));
    await flush();
    expect(api.listNafathRequests).not.toHaveBeenCalled();
  });
});

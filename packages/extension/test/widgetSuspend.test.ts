// Content side of captureClean: widget.suspend hides every widget host (answered after two frames), widget.resume
// shows them again, and a lost resume is made up for by the auto-resume timer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/content/index';
import { nextFrames, removeWidgetHosts, resumeWidget, suspendWidget, widgetHosts } from '../src/content/widget';
import { WIDGET_AUTO_RESUME_MS, WIDGET_HOST_ATTR } from '../src/shared/protocol';

const addHost = () => {
  const h = document.createElement('div');
  h.setAttribute(WIDGET_HOST_ATTR, '1');
  document.documentElement.append(h);
  return h;
};

afterEach(() => {
  vi.useRealTimers();
  resumeWidget();
  removeWidgetHosts();
});

describe('widget suspend / resume', () => {
  it('answers at once with nothing hidden when no widget is mounted', async () => {
    expect(await suspendWidget()).toEqual({ ok: true, hidden: 0 });
    expect(await handleRequest({ type: 'widget.suspend' })).toEqual({ ok: true, hidden: 0 });
    expect(await handleRequest({ type: 'widget.resume' })).toEqual({ ok: true });
  });
  it('hides the hosts and shows them again', async () => {
    const h = addHost();
    h.style.visibility = 'visible';
    expect(await handleRequest({ type: 'widget.suspend' })).toEqual({ ok: true, hidden: 1 });
    expect(h.style.getPropertyValue('visibility')).toBe('hidden');
    expect(h.style.getPropertyPriority('visibility')).toBe('important');
    await handleRequest({ type: 'widget.resume' });
    expect(h.style.getPropertyValue('visibility')).toBe('');
  });
  it('resumes by itself when the resume message never comes', async () => {
    const h = addHost();
    vi.useFakeTimers();
    const p = suspendWidget();
    await vi.advanceTimersByTimeAsync(200); // frames (or their fallback timeout)
    expect((await p).hidden).toBe(1);
    expect(h.style.getPropertyValue('visibility')).toBe('hidden');
    await vi.advanceTimersByTimeAsync(WIDGET_AUTO_RESUME_MS);
    expect(h.style.getPropertyValue('visibility')).toBe('');
  });
  it('nextFrames waits for n animation frames, or the fallback timeout without frames', async () => {
    const frames: FrameRequestCallback[] = [];
    const win = { requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb) } as unknown as Window;
    let done = false;
    void nextFrames(2, win, 10_000).then(() => (done = true));
    frames.shift()!(0);
    await Promise.resolve();
    expect(done).toBe(false);
    frames.shift()!(0);
    await Promise.resolve();
    expect(done).toBe(true);
    vi.useFakeTimers();
    let late = false;
    void nextFrames(2, {} as Window, 50).then(() => (late = true));
    await vi.advanceTimersByTimeAsync(60);
    expect(late).toBe(true);
  });
  it('removeWidgetHosts takes every host off the page', () => {
    addHost();
    addHost();
    expect(widgetHosts()).toHaveLength(2);
    expect(removeWidgetHosts()).toBe(2);
    expect(widgetHosts()).toHaveLength(0);
  });
});

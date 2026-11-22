// captureClean: suspend the widget, capture, and always resume, even when the capture fails or the tab is silent.
import { describe, expect, it } from 'vitest';
import type { ContentRequest } from '../src/shared/protocol';
import { captureClean, type CaptureCleanDeps } from '../src/sidepanel/tabs';

const fake = (o: { capture?: () => Promise<string>; send?: (msg: ContentRequest) => Promise<unknown> } = {}) => {
  const log: string[] = [];
  const deps: CaptureCleanDeps = {
    send: async (tabId, msg) => {
      log.push(`${msg.type}@${tabId}`);
      return o.send ? o.send(msg) : { ok: true };
    },
    capture: async (windowId) => {
      log.push(`capture@${windowId}`);
      return o.capture ? o.capture() : 'data:image/jpeg;base64,AAA';
    },
    waitMs: 30,
  };
  return { deps, log };
};

describe('captureClean', () => {
  it('suspends, captures, then resumes', async () => {
    const { deps, log } = fake();
    expect(await captureClean(5, 9, deps)).toBe('data:image/jpeg;base64,AAA');
    await Promise.resolve();
    expect(log).toEqual(['widget.suspend@5', 'capture@9', 'widget.resume@5']);
  });
  it('resumes when the capture throws', async () => {
    const { deps, log } = fake({ capture: () => Promise.reject(new Error('capture failed')) });
    await expect(captureClean(5, 9, deps)).rejects.toThrow('capture failed');
    await Promise.resolve();
    expect(log).toEqual(['widget.suspend@5', 'capture@9', 'widget.resume@5']);
  });
  it('captures anyway when the tab has no content script or does not answer', async () => {
    const none = fake({ send: (m) => (m.type === 'widget.suspend' ? Promise.reject(new Error('Receiving end does not exist')) : Promise.reject(new Error('x'))) });
    expect(await captureClean(5, 9, none.deps)).toMatch(/^data:/);
    const silent = fake({ send: (m) => (m.type === 'widget.suspend' ? new Promise(() => {}) : Promise.resolve({ ok: true })) });
    const t0 = Date.now();
    expect(await captureClean(5, 9, silent.deps)).toMatch(/^data:/);
    expect(Date.now() - t0).toBeLessThan(1000);
    await Promise.resolve();
    expect(silent.log).toEqual(['widget.suspend@5', 'capture@9', 'widget.resume@5']);
  });
  it('sends nothing without a tab', async () => {
    const { deps, log } = fake();
    await captureClean(null, 9, deps);
    expect(log).toEqual(['capture@9']);
  });
});

// The content script's re-inject guard: a live instance of the same version is kept (one listener), anything else
// (none, the 0.1.0 string, another version, an orphan whose extension runtime is gone) is replaced, and an orphaned
// widget host is taken off the page.
import { afterEach, describe, expect, it } from 'vitest';
import { installContent, shouldReplace, type ContentInstance, type ContentRuntime } from '../src/content/index';
import { CONTENT_VERSION, WIDGET_HOST_ATTR } from '../src/shared/protocol';

type Listener = Parameters<ContentRuntime['onMessage']['addListener']>[0];
const fakeRuntime = (id = 'ext') => {
  const listeners = new Set<Listener>();
  const rt = {
    id: id as string | undefined,
    onMessage: { addListener: (l: Listener) => void listeners.add(l), removeListener: (l: Listener) => void listeners.delete(l) },
    listeners,
    /** Deliver a message like chrome.runtime does; resolves the first async answer. */
    send: (msg: unknown) =>
      new Promise<unknown>((resolve) => {
        let async = false;
        for (const l of listeners) if (l(msg, {}, resolve)) async = true;
        if (!async) resolve(undefined);
      }),
  };
  return rt;
};

afterEach(() => {
  delete window.__stubyardContent;
  document.documentElement.querySelectorAll(`[${WIDGET_HOST_ATTR}]`).forEach((e) => e.remove());
});

describe('shouldReplace', () => {
  const inst = (version: string, alive: boolean | (() => boolean)): ContentInstance => ({ version, alive: typeof alive === 'function' ? alive : () => alive, dispose: () => {} });
  it('replaces nothing, the 0.1.0 string, other versions and orphans', () => {
    expect(shouldReplace(undefined, '0.2.0')).toBe(true);
    expect(shouldReplace('0.1.0', '0.2.0')).toBe(true);
    expect(shouldReplace('0.2.0', '0.2.0')).toBe(true);
    expect(shouldReplace(inst('0.1.9', true), '0.2.0')).toBe(true);
    expect(shouldReplace(inst('0.2.0', false), '0.2.0')).toBe(true);
    expect(shouldReplace(inst('0.2.0', () => { throw new Error('Extension context invalidated'); }), '0.2.0')).toBe(true);
    expect(shouldReplace({ version: '0.2.0' }, '0.2.0')).toBe(true);
  });
  it('keeps a live instance of the same version', () => {
    expect(shouldReplace(inst('0.2.0', true), '0.2.0')).toBe(false);
  });
});

describe('installContent', () => {
  it('registers one listener that answers ping with the version', async () => {
    const rt = fakeRuntime();
    const a = installContent(window, rt);
    expect(a?.version).toBe(CONTENT_VERSION);
    expect(window.__stubyardContent).toBe(a);
    expect(await rt.send({ type: 'ping' })).toMatchObject({ ok: true, version: CONTENT_VERSION });
    expect(await rt.send({ type: 'unknown' })).toBeUndefined();
  });
  it('injecting twice into a live page keeps the first instance', () => {
    const rt = fakeRuntime();
    const a = installContent(window, rt);
    const b = installContent(window, rt);
    expect(b).toBe(a);
    expect(rt.listeners.size).toBe(1);
  });
  it('replaces an orphan after an extension reload and removes its widget host', async () => {
    const old = fakeRuntime();
    installContent(window, old);
    const host = document.createElement('div');
    host.setAttribute(WIDGET_HOST_ATTR, '1');
    document.documentElement.append(host);
    old.id = undefined; // what Chrome does to an orphaned content script's runtime
    const fresh = fakeRuntime();
    const b = installContent(window, fresh);
    expect(b).not.toBeNull();
    expect(window.__stubyardContent).toBe(b);
    expect(old.listeners.size).toBe(0);
    expect(fresh.listeners.size).toBe(1);
    expect(host.isConnected).toBe(false);
    expect(await fresh.send({ type: 'ping' })).toMatchObject({ version: CONTENT_VERSION });
  });
  it('replaces the 0.1.0 marker (a bare string) and another version', () => {
    window.__stubyardContent = '0.1.0';
    const rt = fakeRuntime();
    expect(installContent(window, rt)?.version).toBe(CONTENT_VERSION);
    const next = fakeRuntime();
    const c = installContent(window, next, '9.9.9');
    expect(c?.version).toBe('9.9.9');
    expect(rt.listeners.size).toBe(0);
    expect(next.listeners.size).toBe(1);
  });
  it('a listener whose runtime died stops itself', async () => {
    const rt = fakeRuntime();
    installContent(window, rt);
    rt.id = undefined;
    expect(await rt.send({ type: 'ping' })).toBeUndefined();
    expect(rt.listeners.size).toBe(0);
  });
  it('mounts and unmounts the widget host through messages; a replaced instance takes its host off', async () => {
    const rt = { ...fakeRuntime(), getURL: (p: string) => `chrome-extension://ext/${p}` };
    installContent(window, rt);
    expect(await rt.send({ type: 'widget.mount', token: 't' })).toEqual({ ok: true, mounted: true });
    expect(document.documentElement.querySelectorAll(`[${WIDGET_HOST_ATTR}]`)).toHaveLength(1);
    expect(await rt.send({ type: 'widget.unmount' })).toEqual({ ok: true, mounted: false });
    expect(document.documentElement.querySelector(`[${WIDGET_HOST_ATTR}]`)).toBeNull();
    await rt.send({ type: 'widget.mount', token: 't' });
    const next = { ...fakeRuntime(), getURL: rt.getURL };
    installContent(window, next, '9.9.9');
    expect(document.documentElement.querySelector(`[${WIDGET_HOST_ATTR}]`)).toBeNull();
  });
  it('does nothing without chrome.runtime', () => {
    expect(installContent(window, undefined)).toBeNull();
    expect(window.__stubyardContent).toBeUndefined();
  });
});

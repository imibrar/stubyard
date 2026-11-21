// Panel → tab plumbing: content-script messages (inject on demand, §6.3/§6.4), navigation, screenshots, permissions.
import type { ContentError, ContentRequest, ContentResponseMap } from '../shared/protocol';
import { originPattern } from '../shared/settings';

export interface TabInfo {
  id: number;
  windowId: number;
  url: string;
  status?: string;
}

export async function activeTab(windowId?: number): Promise<TabInfo | null> {
  const [t] = await chrome.tabs.query(windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId });
  return t?.id !== undefined ? { id: t.id, windowId: t.windowId, url: t.url ?? t.pendingUrl ?? '', status: t.status } : null;
}

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

async function inject(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot access|permission|host/i.test(msg)) throw new Error(`The extension may not access this page. Grant access to its origin in the panel (Page access). (${msg})`);
    throw new Error(`Could not inject the content script: ${msg}`);
  }
}

/**
 * Send one request to the page's content script. When none is listening yet (first use, or after a navigation),
 * inject content.js and retry once. A handler error (`{error}`) is thrown.
 */
export async function sendToTab<R extends ContentRequest>(tabId: number, req: R): Promise<ContentResponseMap[R['type']]> {
  const send = () => chrome.tabs.sendMessage(tabId, req) as Promise<ContentResponseMap[R['type']] | ContentError | undefined>;
  let res: ContentResponseMap[R['type']] | ContentError | undefined;
  try {
    res = await send();
  } catch (err) {
    if (!NO_RECEIVER.test(err instanceof Error ? err.message : String(err))) throw err;
    await inject(tabId);
    res = await send();
  }
  if (res === undefined) throw new Error('The page did not answer (it may be navigating). Try again.');
  if (res && typeof res === 'object' && 'error' in res && typeof res.error === 'string') throw new Error(res.error);
  return res as ContentResponseMap[R['type']];
}

/** Open a URL in the tab, or in a new tab. Resolves when the navigation has started. */
export async function openUrl(tabId: number, url: string, where: 'same-tab' | 'new-tab' = 'same-tab'): Promise<void> {
  if (where === 'new-tab') await chrome.tabs.create({ url });
  else await chrome.tabs.update(tabId, { url });
}

/** Whether two URLs point at the same page (hash and trailing slash ignored). */
export function samePage(a: string, b: string): boolean {
  const clean = (s: string) => {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {
      return s;
    }
  };
  return clean(a) === clean(b);
}

/** A JPEG of the visible part of the window's active tab, as a data URL. */
export function captureScreenshot(windowId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 });
}

export function hasOriginAccess(url: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(url)] });
}

/** Ask for access to an origin; must run in a click handler (user gesture). */
export function requestOriginAccess(url: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPattern(url)] });
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

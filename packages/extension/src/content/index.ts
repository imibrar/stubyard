// Content script entry (built as one IIFE: content.js). Injected on demand by the side panel; idempotent.
// It only does DOM work and answers panel messages: it never calls stubyard and never renders templates.
import { CONTENT_VERSION, type ContentRequest, type ContentResponseMap } from '../shared/protocol';
import { assertPage, capture, highlight, probe, setValue } from './capture';
import { fillForm } from './fill';
import { scanPage } from './scan';
import { removeWidgetHosts, resumeWidget, suspendWidget } from './widget';

export async function handleRequest(req: ContentRequest): Promise<ContentResponseMap[ContentRequest['type']]> {
  switch (req.type) {
    case 'ping': return { ok: true, version: CONTENT_VERSION, url: location.href };
    case 'scan': return scanPage({ includeHidden: req.includeHidden });
    case 'fill': return fillForm(req.entries, { formId: req.formId, overwrite: req.overwrite });
    case 'probe': return probe(req.selector);
    case 'setValue': return setValue(req.selector, req.value);
    case 'capture': return capture(req);
    case 'assert': return assertPage(req);
    case 'highlight': return highlight(req);
    case 'widget.suspend': return suspendWidget();
    case 'widget.resume': return resumeWidget();
  }
}

const TYPES: ReadonlySet<string> = new Set<ContentRequest['type']>(['ping', 'scan', 'fill', 'probe', 'setValue', 'capture', 'assert', 'highlight', 'widget.suspend', 'widget.resume']);

/** The running content script, kept on the (isolated world's) window so a second injection can find it. */
export interface ContentInstance {
  version: string;
  /** False once the extension that injected it was reloaded, updated or removed (its runtime is gone). */
  alive(): boolean;
  /** Stop answering messages. */
  dispose(): void;
}

declare global {
  // 0.1.0 stored the bare version string; it cannot be stopped, but its runtime is dead by the time a new one runs.
  interface Window { __stubyardContent?: ContentInstance | string }
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined;
/** The bit of chrome.runtime the content script uses (tests pass a fake). */
export interface ContentRuntime {
  readonly id?: string;
  onMessage: { addListener(l: Listener): void; removeListener(l: Listener): void };
}

/**
 * Whether a content script already on the page must be replaced by this one: none, a 0.1.0 one (a bare string), a
 * different version, or one whose extension runtime is gone (orphaned by an extension reload or update). A live one
 * of the same version is kept, so injecting twice registers one listener.
 */
export function shouldReplace(prev: unknown, version: string): boolean {
  if (!prev || typeof prev !== 'object') return true;
  const p = prev as Partial<ContentInstance>;
  if (p.version !== version || typeof p.alive !== 'function') return true;
  try {
    return !p.alive();
  } catch {
    return true;
  }
}

/** Register the message listener unless a live instance of this version is already there (then that one is returned). */
export function installContent(win: Window, runtime: ContentRuntime | undefined, version = CONTENT_VERSION): ContentInstance | null {
  if (!runtime?.onMessage) return null;
  const prev = win.__stubyardContent;
  if (!shouldReplace(prev, version)) return prev as ContentInstance;
  if (prev && typeof prev === 'object') {
    try {
      prev.dispose();
    } catch {
      /* an orphan's runtime may throw; it receives nothing anyway */
    }
  }
  // A widget left by the replaced script would sit on the page with a dead runtime: take it off.
  removeWidgetHosts(win.document);
  const alive = () => {
    try {
      return !!runtime.id;
    } catch {
      return false;
    }
  };
  const listener: Listener = (msg, _sender, sendResponse) => {
    if (!alive()) {
      instance.dispose();
      return false;
    }
    if (!msg || typeof msg !== 'object' || !TYPES.has((msg as { type?: string }).type ?? '')) return false;
    handleRequest(msg as ContentRequest).then(sendResponse, (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  };
  const instance: ContentInstance = {
    version,
    alive,
    dispose: () => {
      try {
        runtime.onMessage.removeListener(listener);
      } catch {
        /* runtime gone */
      }
    },
  };
  runtime.onMessage.addListener(listener);
  win.__stubyardContent = instance;
  return instance;
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined') installContent(window, chrome.runtime as unknown as ContentRuntime);

// Content script entry (built as one IIFE: content.js). Injected on demand by the side panel and by the service worker
// (for the on-page widget); idempotent. It only does DOM work and answers extension messages: it never calls stubyard
// and never renders templates. The widget's UI is an extension iframe; this script only hosts it (content/widget.ts).
import { CONTENT_VERSION, type ContentRequest, type ContentResponseMap, type WidgetTokenResult } from '../shared/protocol';
import { assertPage, capture, highlight, probe, setValue } from './capture';
import { fillForm } from './fill';
import { scanPage } from './scan';
import { acceptWidgetPort, highlighted, type HostDeps, type HostPort, mountWidget, placementsChanged, removeWidgetHosts, resumeWidget, suspendWidget, toggleWidget, unmountWidget } from './widget';
import { PLACEMENT_KEY } from '../shared/widget';
import { record as rrwebRecord } from '@rrweb/record';
import type { RecordingChunkMessage, RecordingChunkReply } from '../shared/recording';
import { queryAll, isVisible } from './dom';
import { Recorder, type RrwebRecord } from './recorder';

/** How the widget host reaches chrome.* (set by installContent; tests set their own). */
let hostDeps: HostDeps | null = null;
/** The walkthrough recorder of this page (set by installContent when the runtime can send messages). */
let recorder: Recorder | null = null;

/** The recorder of this page (tests). */
export const pageRecorder = () => recorder;

/** Mark the field a secret was typed into, so a recording masks it whatever it looks like. */
function markSecret(selector: string) {
  try {
    const el = queryAll(document, selector).find(isVisible);
    if (el && recorder) recorder.marked.add(el);
  } catch {
    /* invalid selector: setValue reported it */
  }
}

/**
 * A fill that names the origin it was meant for runs only there (security review items 1 and 3): the page may have
 * navigated or redirected between the caller's check and this message.
 */
export function assertOrigin(expected: string | undefined, actual: string = location.origin): void {
  if (expected !== undefined && expected !== actual) throw new Error(`The page is on ${actual} now, not ${expected}: nothing was filled.`);
}

export async function handleRequest(req: ContentRequest): Promise<ContentResponseMap[ContentRequest['type']]> {
  switch (req.type) {
    case 'ping': return { ok: true, version: CONTENT_VERSION, url: location.href };
    case 'scan': return scanPage({ includeHidden: req.includeHidden });
    case 'fill':
      assertOrigin(req.origin);
      return fillForm(req.entries, { formId: req.formId, overwrite: req.overwrite });
    case 'probe': return { ...probe(req.selector), origin: location.origin };
    case 'setValue': {
      assertOrigin(req.origin);
      // Masked before the value lands, so not even the first input event shows it.
      if (req.secret) markSecret(req.selector);
      return setValue(req.selector, req.value);
    }
    case 'capture': return capture(req);
    case 'assert': return assertPage(req);
    case 'highlight': {
      const r = highlight(req);
      if (r.found) highlighted();
      return r;
    }
    case 'widget.suspend': return suspendWidget();
    case 'widget.resume': return resumeWidget();
    case 'widget.mount': return hostDeps ? mountWidget(hostDeps) : { ok: true, mounted: false };
    case 'widget.unmount': return unmountWidget();
    case 'widget.toggle': return toggleWidget(req.collapsed);
    case 'recording.start': {
      if (!recorder) return { ok: true, recording: false, segment: null };
      const r = recorder.apply(req.config);
      return { ok: true, recording: r.recording, segment: recorder.segmentKey };
    }
    case 'recording.stop':
      recorder?.stop();
      return { ok: true, recording: false, segment: null };
  }
}

const TYPES: ReadonlySet<string> = new Set<ContentRequest['type']>(['ping', 'scan', 'fill', 'probe', 'setValue', 'capture', 'assert', 'highlight', 'widget.suspend', 'widget.resume', 'widget.mount', 'widget.unmount', 'widget.toggle', 'recording.start', 'recording.stop']);

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
type ConnectListener = (port: HostPort) => void;
export interface ContentRuntime {
  readonly id?: string;
  onMessage: { addListener(l: Listener): void; removeListener(l: Listener): void };
  /** The widget iframe's Port comes in here (optional: tests of the message side leave it out). */
  onConnect?: { addListener(l: ConnectListener): void; removeListener(l: ConnectListener): void };
  getURL?: (path: string) => string;
  /** The widget host asks the service worker for a fresh frame token with it (optional in tests). */
  sendMessage?: (msg: unknown) => Promise<unknown>;
}

/** The storage the widget host uses for its placement (chrome.storage.local in a content script). */
export type ContentStorage = HostDeps['storage'];

/** chrome.storage.onChanged: Settings "Reset position" reaches a mounted widget (optional; tests leave it out). */
type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
export interface ContentStorageEvents {
  addListener(l: ChangeListener): void;
  removeListener(l: ChangeListener): void;
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
export function installContent(
  win: Window,
  runtime: ContentRuntime | undefined,
  version = CONTENT_VERSION,
  storage?: ContentStorage,
  storageEvents?: ContentStorageEvents,
  opts: { record?: RrwebRecord } = {},
): ContentInstance | null {
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
  const getURL = runtime.getURL?.bind(runtime);
  const onConnect: ConnectListener = (port) => {
    if (!alive()) return instance.dispose();
    if (getURL) acceptWidgetPort(port, getURL(''));
  };
  const onStorage: ChangeListener = (changes, area) => {
    if (area === 'local' && PLACEMENT_KEY in changes) placementsChanged(changes[PLACEMENT_KEY]?.newValue, win.document);
  };
  const instance: ContentInstance = {
    version,
    alive,
    dispose: () => {
      unmountWidget();
      recorder?.stop();
      recorder = null;
      try {
        runtime.onMessage.removeListener(listener);
        runtime.onConnect?.removeListener(onConnect);
        storageEvents?.removeListener(onStorage);
      } catch {
        /* runtime gone */
      }
    },
  };
  const send = runtime.sendMessage?.bind(runtime);
  const mintToken = async (): Promise<string | null> => {
    if (!send) return null;
    try {
      const r = (await send({ type: 'widget.token' })) as WidgetTokenResult | undefined;
      return r && 'token' in r && typeof r.token === 'string' ? r.token : null;
    } catch {
      return null; // the worker is gone (extension reloaded): no frame
    }
  };
  hostDeps = getURL ? { getURL, storage, alive, mintToken } : null;
  recorder = send
    ? new Recorder({
        record: (opts.record ?? rrwebRecord) as unknown as RrwebRecord,
        win,
        send: async (msg: RecordingChunkMessage) => (alive() ? ((await send(msg)) as RecordingChunkReply | undefined) : undefined),
        onStop: (reason) => console.info('[stubyard] recording stopped:', reason),
      })
    : null;
  runtime.onMessage.addListener(listener);
  runtime.onConnect?.addListener(onConnect);
  storageEvents?.addListener(onStorage);
  win.__stubyardContent = instance;
  return instance;
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installContent(window, chrome.runtime as unknown as ContentRuntime, CONTENT_VERSION, chrome.storage?.local as unknown as ContentStorage, chrome.storage?.onChanged as unknown as ContentStorageEvents);
}

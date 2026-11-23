/**
 * The hub's live event stream (GET /api/stream, Server-Sent Events) over fetch + ReadableStream, so it also runs in
 * MV3 extension service workers, where EventSource does not exist. Reconnects until the signal aborts.
 *
 *   import { subscribe } from '@stubyard/client/stream';
 *   const ac = new AbortController();
 *   subscribe({ project: 'hyper' }, { types: ['walkthrough.changed'], signal: ac.signal, onEvent: (e) => console.log(e.type, e.data) });
 *   ac.abort();
 */
import { apiBase, hubFetchFn, query, type HubTarget } from './http.js';

/** One raw SSE event as parsed from the wire. */
export interface SseEvent {
  /** The `event:` field ("message" when absent). */
  event: string;
  /** The `data:` lines joined with "\n". */
  data: string;
  /** The last `id:` seen (sticky across events, as in EventSource). */
  id: string;
}

export interface SseParser {
  /** Feed the next decoded chunk; complete events are emitted synchronously. */
  push(chunk: string): void;
  /** The stream ended: drop any half-received event (per the SSE spec it is not dispatched). */
  end(): void;
}

/**
 * Incremental SSE parser (WHATWG "event stream interpretation"): lines end in LF, CRLF or CR (also when the CR and
 * LF arrive in different chunks); ":" lines are comments; one leading space after the colon is stripped; several
 * `data:` lines join with "\n"; a blank line dispatches; an event without data is not dispatched; `retry:` with
 * digits only calls onRetry.
 */
export function createSseParser(onEvent: (e: SseEvent) => void, onRetry?: (ms: number) => void): SseParser {
  let buf = '';
  let pendingCr = false; // the previous chunk ended in "\r": a leading "\n" of the next chunk belongs to it
  let data: string[] = [];
  let hasData = false;
  let event = '';
  let lastId = '';

  const line = (l: string) => {
    if (l === '') {
      if (hasData) onEvent({ event: event || 'message', data: data.join('\n'), id: lastId });
      data = [];
      hasData = false;
      event = '';
      return;
    }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      data.push(value);
      hasData = true;
    } else if (field === 'event') event = value;
    else if (field === 'id') {
      if (!value.includes('\0')) lastId = value;
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) onRetry?.(Number(value));
    }
  };

  return {
    push(chunk: string) {
      if (pendingCr && chunk.startsWith('\n')) chunk = chunk.slice(1);
      pendingCr = false;
      buf += chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        line(buf.slice(start, i));
        if (c === 13) {
          if (i + 1 < buf.length) {
            if (buf.charCodeAt(i + 1) === 10) i++;
          } else pendingCr = true;
        }
        start = i + 1;
      }
      buf = buf.slice(start);
    },
    end() {
      buf = '';
      data = [];
      hasData = false;
      event = '';
      pendingCr = false;
    },
  };
}

export interface HubEvent {
  type: string;
  projectId: string | null;
  data: unknown;
}

/**
 * Listen to the hub's events (of one project; with `run`, only that run's messages / logs and run events).
 * `types` filters by event type ("ready" is sent on every (re)connect). Network errors and non-2xx answers go to
 * onError, then it reconnects after `retryMs` (default: the hub's `retry:` hint, else 2000). Stops when `signal` aborts.
 */
export function subscribe(
  t: HubTarget & { run?: string },
  o: { types?: string[]; onEvent: (e: HubEvent) => void; onError?: (err: unknown) => void; signal: AbortSignal; retryMs?: number },
): void {
  const f = hubFetchFn(t);
  const url = `${apiBase(t)}/api/stream${query({ project: t.project, run: t.run })}`;
  const want = o.types?.length ? new Set(o.types) : null;
  let retry = o.retryMs ?? 2000;

  const dispatch = (e: SseEvent) => {
    if (want && !want.has(e.event)) return;
    let payload: unknown = e.data;
    try {
      payload = JSON.parse(e.data);
    } catch {
      /* not JSON: hand over the text */
    }
    const p = payload && typeof payload === 'object' ? (payload as { projectId?: unknown; data?: unknown }) : null;
    const isEnvelope = !!p && 'data' in p;
    try {
      o.onEvent({
        type: e.event,
        projectId: isEnvelope && typeof p!.projectId === 'string' ? p!.projectId : null,
        data: isEnvelope ? p!.data : payload,
      });
    } catch (err) {
      o.onError?.(err);
    }
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (o.signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        o.signal.removeEventListener('abort', done);
        resolve();
      }
      o.signal.addEventListener('abort', done);
    });

  const once = async () => {
    const res = await f(url, { headers: { accept: 'text/event-stream' }, signal: o.signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`stubyard stream answered ${res.status}: ${text}`);
    }
    const parser = createSseParser(dispatch, (ms) => {
      if (o.retryMs === undefined) retry = ms;
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } finally {
      parser.end();
      reader.releaseLock();
    }
  };

  void (async () => {
    while (!o.signal.aborted) {
      try {
        await once();
      } catch (err) {
        if (o.signal.aborted) break;
        o.onError?.(err);
      }
      if (o.signal.aborted) break;
      await wait(retry);
    }
  })();
}

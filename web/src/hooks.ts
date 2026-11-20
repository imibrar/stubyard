import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface HubEvent {
  type: string;
  projectId: string | null;
  data: unknown;
}

type Listener = (e: HubEvent) => void;

const EVENT_TYPES = [
  'project.created', 'project.updated', 'project.deleted', 'project.reset', 'user.changed', 'provider.changed',
  'authenticator.changed', 'rules.changed', 'message.created', 'message.updated', 'log.created', 'log.updated',
  'mocks.changed',
  'webhooks.changed',
  'runs.changed',
  'auth.changed',
  'storage.changed',
  'mcptester.changed',
  'schedules.changed',
];

/**
 * ONE EventSource for the whole app. Browsers allow only ~6 HTTP/1.1 connections per host; one stream per
 * component would starve normal API requests. Listeners filter by project on the client.
 */
const stream = {
  es: null as EventSource | null,
  listeners: new Set<Listener>(),
  status: new Set<(c: boolean) => void>(),
  connected: false,
  slugToId: new Map<string, string>(),
  open() {
    if (this.es) return;
    const es = new EventSource('/api/stream');
    this.es = es;
    const setConnected = (c: boolean) => {
      this.connected = c;
      for (const f of this.status) f(c);
    };
    es.addEventListener('ready', () => setConnected(true));
    es.onerror = () => setConnected(false);
    const onEvent = (ev: MessageEvent) => {
      let payload: { projectId: string | null; data: unknown };
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      const e = { type: ev.type, projectId: payload.projectId, data: payload.data };
      for (const l of this.listeners) l(e);
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, onEvent as EventListener);
  },
  close() {
    if (this.listeners.size || this.status.size) return;
    this.es?.close();
    this.es = null;
    this.connected = false;
  },
};

// A page kept in the back/forward cache would hold its stream open and eat one of the ~6 connections per host:
// close it when the page is hidden for good, reopen when it is restored.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    stream.es?.close();
    stream.es = null;
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && (stream.listeners.size || stream.status.size)) stream.open();
  });
}

/** Tell the event stream which project id belongs to which slug (for per-project filtering). */
export function registerProjectSlugs(projects: { id: string; slug: string }[] | null | undefined): void {
  for (const p of projects ?? []) stream.slugToId.set(p.slug, p.id);
}

/** Subscribe to live hub events (optionally only one project's). `onEvent` is kept fresh without resubscribing. */
export function useHubEvents(project: string | null | undefined, onEvent: (e: HubEvent) => void): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(stream.connected);

  useEffect(() => {
    const listener: Listener = (e) => {
      if (project) {
        const id = stream.slugToId.get(project);
        // Unknown slug→id yet: let it through (an extra reload is harmless).
        if (id && e.projectId !== id && e.projectId !== null) return;
      }
      handler.current(e);
    };
    stream.listeners.add(listener);
    stream.status.add(setConnected);
    stream.open();
    setConnected(stream.connected);
    return () => {
      stream.listeners.delete(listener);
      stream.status.delete(setConnected);
      stream.close();
    };
  }, [project]);

  return connected;
}

/** Fetch JSON with loading/error state and a reload() function. */
export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try {
      const d = await api.get<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** Debounce rapid calls (e.g. many SSE events) into one. */
export function useDebounced(fn: () => void, ms = 150): () => void {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const f = useRef(fn);
  f.current = fn;
  return useCallback(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => f.current(), ms);
  }, [ms]);
}

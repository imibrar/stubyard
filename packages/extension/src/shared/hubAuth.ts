// The API token for a hub with sign-in on (Settings → API token, kept in chrome.storage.local: never synced).
// Every extension context (panel, widget frame, service worker) calls installHubAuth() once: from then on its fetch
// adds Authorization: Bearer <token> to requests for the hub's origin only, so all @stubyard/client calls carry it.
import { StubyardError } from '@stubyard/client/http';
import { loadSettings } from './settings';

export const TOKEN_NEEDED = 'This hub needs a token: create one in the dashboard → API tokens, then paste it in Settings → API token.';

export interface HubAuth {
  /** The hub's origin (from Settings → URL); null when unknown. */
  origin: string | null;
  /** The API token; '' for none. */
  token: string;
}

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
};

export const hubAuthOf = (s: { apiUrl: string; apiToken: string }): HubAuth => ({ origin: originOf(s.apiUrl), token: s.apiToken });

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** The request init with the token added, when the URL is on the hub's origin and no Authorization is set yet. */
export function withHubToken(input: RequestInfo | URL, init: RequestInit | undefined, auth: HubAuth): RequestInit | undefined {
  if (!auth.token || !auth.origin || originOf(urlOf(input)) !== auth.origin) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has('authorization')) return init;
  headers.set('authorization', `Bearer ${auth.token}`);
  return { ...init, headers };
}

/** A fetch that adds the hub token (read through getAuth, so a changed setting applies at once). */
export function wrapFetch(base: typeof fetch, getAuth: () => Promise<HubAuth>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => base(input, withHubToken(input, init, await getAuth()))) as typeof fetch;
}

let installed = false;

/** Patch this context's fetch once; the token and URL follow chrome.storage.local. */
export function installHubAuth(): void {
  if (installed) return;
  installed = true;
  const load = () => loadSettings().then(hubAuthOf, (): HubAuth => ({ origin: null, token: '' }));
  let current = load();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('apiUrl' in changes || 'apiToken' in changes)) current = load();
  });
  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis), () => current);
}

/** The hub refused the call for want of a (valid) token. */
export const needsToken = (err: unknown): boolean => err instanceof StubyardError && err.status === 401;

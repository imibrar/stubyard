/**
 * Host mode for apps that keep the real Elm base URL: with a hosts entry and the stubyard CA, requests to
 * nafath.api.elm.sa or rabet-nafath.api.elm.sa arrive here and become /nafath/_host/… (routes/nafath.ts finds the
 * instance by the APP-ID header; the /nafath-sandbox and /stg prefixes work as on the instance URLs).
 */
export const NAFATH_HOSTS = ['nafath.api.elm.sa', 'rabet-nafath.api.elm.sa'];

export function rewriteNafathHost(req: { url?: string; headers: Record<string, string | string[] | undefined> }): string | null {
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!NAFATH_HOSTS.includes(host)) return null;
  const url = req.url ?? '/';
  // stubyard's own /api/… stays reachable on the host; Nafath's versioned /api/v1/… (and /api/v2/…) paths do not clash.
  if (url.startsWith('/nafath/') || (url.startsWith('/api/') && !/^\/api\/v\d+\//.test(url))) return null;
  return `/nafath/_host${url.startsWith('/') ? url : `/${url}`}`;
}

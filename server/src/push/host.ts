/**
 * Host mode for SDKs that cannot change the Google base URLs (firebase-admin): with a hosts entry and the stubyard CA,
 * requests to the real Google hosts arrive here and become /push/_host/<service>/… (the instance is found from the
 * request: the assertion's iss, the access token, or the Firebase project id in the URL).
 */
const HOSTS: Record<string, string> = {
  'fcm.googleapis.com': 'fcm',
  'iid.googleapis.com': 'iid',
  'oauth2.googleapis.com': 'oauth2',
  'www.googleapis.com': 'oauth2',
};

export function rewritePushHost(req: { url?: string; headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = String(req.headers.host ?? '').toLowerCase();
  const host = raw.replace(/:\d+$/, '');
  const service = HOSTS[host];
  if (!service) return null;
  const url = req.url ?? '/';
  if (url.startsWith('/push/') || url.startsWith('/api/')) return null;
  const path = url.split('?')[0];
  if (service === 'oauth2') {
    if (path === '/token' || path === '/oauth2/v4/token') return '/push/_host/oauth2/token';
    return null;
  }
  if (service === 'iid') return /^\/iid\/v1:batch(Add|Remove)$/.test(path) ? `/push/_host/iid${path}` : null;
  return `/push/_host/fcm${url}`;
}

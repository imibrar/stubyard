/**
 * Host-based gateway URLs for SDKs that cannot take a path prefix (stripe-node: host / port only):
 * <instance>.<project>.pay.<STUBYARD_STORAGE_DOMAIN>/v1/… → /pay/<project>/<instance>/v1/….
 * Must run before the storage host rewrite (which would read "pay" as a project).
 */
export function rewritePayHost(req: { url?: string; headers: Record<string, string | string[] | undefined> }, domain: string | null): string | null {
  if (!domain) return null;
  const raw = String(req.headers.host ?? '').toLowerCase();
  const host = raw.startsWith('[') ? raw : raw.replace(/:\d+$/, '');
  const suffix = `.pay.${domain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const labels = host.slice(0, -suffix.length).split('.');
  if (labels.length !== 2 || !labels[0] || !labels[1]) return null;
  const [instance, project] = labels as [string, string];
  const url = req.url ?? '/';
  if (url.startsWith('/pay/')) return null;
  return `/pay/${project}/${instance}${url.startsWith('/') ? url : '/' + url}`;
}

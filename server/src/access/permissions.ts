/**
 * The permission table: every /api route (method + route pattern), /mcp, /mailpit and the dashboard's storage upload
 * declare the permission they need (teams plan, "Roles"). The access hook (access/hook.ts) enforces it when sign-in
 * is on; a route the table does not cover is refused (default deny), and test/access.e2e.test.ts fails when any
 * registered /api route has no entry, so a new route cannot be forgotten.
 *
 * How a route is looked up:
 *   1. EXACT: [method, route] pairs (HEAD counts as GET).
 *   2. AREAS: the longest area whose route equals the pattern or is a prefix of it at a "/" boundary; GET/HEAD use
 *      `read`, other methods `write`.
 * Areas are kept to one feature each (e.g. /api/projects/:slug/features), never "/api/projects/:slug" as a whole, so a
 * new feature's routes need a new line here.
 */

export type Permission =
  /** No sign-in needed (login, /api/auth/me, /api/system, the CA certificate). */
  | 'public'
  /** Any signed-in account: references, guides, the event stream, project list (filtered per member in T2). */
  | 'authenticated'
  /** The caller's own account: sign out, API tokens. */
  | 'self'
  /** Users, system settings, AI keys, create / delete / import projects, factory reset. */
  | 'instance.admin'
  /** Project settings and members, export. */
  | 'project.settings'
  /** Providers, mocks, webhooks, payments config, storage, LLM mocks, auto-replies, personas, schedules, secrets. */
  | 'project.providers'
  /** Features board: create, edit, reorder, tasks. */
  | 'features.edit'
  /** Features board details and images only (the Designer role). */
  | 'features.details'
  /** Storyboards, login recipes, data sets, page snapshots. */
  | 'storyboards.edit'
  /** Run walkthroughs and test runs, test users, cleanup, simulate payments and messages. */
  | 'walkthroughs.run'
  /** Read anything in the project: inboxes, traffic, walkthroughs, recordings, board. */
  | 'project.view'
  /** Reset a project's captured data. */
  | 'project.reset';

/** How the project a request touches is found, for the per-project membership check of T2. */
export type ProjectScope = 'path' | 'record' | 'none';

export interface RouteAccess {
  permission: Permission;
  /** "path": :slug / :project in the URL; "record": from the row the request names (message, log); "none": instance-wide. */
  scope: ProjectScope;
}

interface Area {
  route: string;
  read: Permission;
  write: Permission;
  scope?: ProjectScope;
}

const B = '/api/projects/:slug';

/** One feature area per line; see the lookup rules above. */
const AREAS: Area[] = [
  // --- Project-scoped (scope "path") ---
  { route: `${B}/runs`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/rules`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/auth`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/auth/:provider/users`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/authenticators`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/auto-replies`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/storage`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/storage-summary`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/storyboards`, read: 'project.view', write: 'storyboards.edit' },
  { route: `${B}/login-recipes`, read: 'project.view', write: 'storyboards.edit' },
  { route: `${B}/data-sets`, read: 'project.view', write: 'storyboards.edit' },
  { route: `${B}/page-snapshots`, read: 'project.view', write: 'storyboards.edit' },
  { route: `${B}/setup`, read: 'project.view', write: 'project.settings' },
  { route: `${B}/schemas`, read: 'project.view', write: 'project.view' },
  { route: `${B}/schedules`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/users`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/providers`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/pins`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/payment-instances`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/payment-rules`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/payments`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/personas`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/personas/threads`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/push`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/push/devices`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/push/notifications`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/nafath`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/nafath/requests`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/messages`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/mocks`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/mcp-tester`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/verifications`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/jobs`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/overview`, read: 'project.view', write: 'project.settings' },
  { route: `${B}/doctor`, read: 'project.view', write: 'project.view' },
  { route: `${B}/lint`, read: 'project.view', write: 'project.view' },
  { route: `${B}/export`, read: 'project.settings', write: 'project.settings' },
  { route: `${B}/webhook-endpoints`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/webhook-templates`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/webhook-sequences`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/walkthroughs`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/llm`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/time`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/chat`, read: 'project.view', write: 'project.providers' },
  { route: `${B}/cleanup`, read: 'project.view', write: 'walkthroughs.run' },
  { route: `${B}/features`, read: 'project.view', write: 'features.edit' },
  // Teams mode: project members (any member reads them, e.g. for the board's assignee picker).
  { route: `${B}/members`, read: 'project.view', write: 'project.settings' },
  // Teams mode: the project's audit log (project admins; read only).
  { route: `${B}/audit`, read: 'project.settings', write: 'project.settings' },

  // --- Instance-wide ---
  { route: '/api/system', read: 'instance.admin', write: 'instance.admin', scope: 'none' },
  { route: '/api/system/ai-providers', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/auth/tokens', read: 'self', write: 'self', scope: 'none' },
  // Teams mode: users and invite links (instance admins).
  { route: '/api/team', read: 'instance.admin', write: 'instance.admin', scope: 'none' },
  // Teams mode: the whole audit log (instance admins; read only).
  { route: '/api/audit', read: 'instance.admin', write: 'instance.admin', scope: 'none' },
  // Reference data and guides (no project data).
  { route: '/api/presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/payment-presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/persona-presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/push-reference', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/auth-presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/auto-reply-presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/storage-presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/rule-presets', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/agent-guide', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/https-guide', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/storyboard-schema', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/schedules', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/mcp-tester', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/lint', read: 'authenticated', write: 'authenticated', scope: 'none' },
  { route: '/api/llm-reference', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/features', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/webhooks', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  // Cross-project reads: the handlers filter the results to the caller's projects ("record": the row's project).
  { route: '/api/storyboards', read: 'authenticated', write: 'instance.admin', scope: 'none' },
  { route: '/api/messages', read: 'project.view', write: 'project.view', scope: 'record' },
  { route: '/api/logs', read: 'project.view', write: 'walkthroughs.run', scope: 'record' },
  // The catch-all that answers 404 for unknown /api routes (signed-in callers only).
  { route: '/api/*', read: 'authenticated', write: 'authenticated', scope: 'none' },
];

type Exact = [method: string, route: string, permission: Permission, scope?: ProjectScope];

const EXACT: Exact[] = [
  // Sign-in itself.
  ['POST', '/api/auth/login', 'public', 'none'],
  ['GET', '/api/auth/me', 'public', 'none'],
  ['POST', '/api/auth/logout', 'self', 'none'],
  ['POST', '/api/auth/password', 'self', 'none'],
  // Teams mode invite links: the token in the body is the credential.
  ['POST', '/api/auth/invite/check', 'public', 'none'],
  ['POST', '/api/auth/invite/accept', 'public', 'none'],
  // Health check (minimal answer when anonymous) and the HTTPS CA certificate (public by nature; phones fetch it).
  ['GET', '/api/system', 'public', 'none'],
  ['GET', '/api/ca.crt', 'public', 'none'],
  // The @stubyard/client npm tarball (open source, no data): `npm i <hub>/api/client.tgz` sends no token.
  ['GET', '/api/client.tgz', 'public', 'none'],
  // Projects.
  ['GET', '/api/projects', 'authenticated', 'none'],
  ['POST', '/api/projects', 'instance.admin', 'none'],
  ['POST', '/api/projects/import', 'instance.admin', 'none'],
  ['GET', B, 'project.view'],
  ['PATCH', B, 'project.settings'],
  ['DELETE', B, 'instance.admin'],
  ['POST', `${B}/reset`, 'project.reset'],
  ['POST', '/api/factory-reset', 'instance.admin', 'none'],
  ['GET', '/api/stream', 'authenticated', 'none'],
  // Secrets inside otherwise readable areas.
  ['GET', `${B}/authenticators/:id/secret`, 'project.providers'],
  ['GET', `${B}/storage/:instance/service-account.json`, 'project.providers'],
  ['GET', `${B}/push/instances/:id/service-account.json`, 'project.providers'],
  ['GET', `${B}/push/instances/:id/apns-key.p8`, 'project.providers'],
  ['GET', `${B}/push/instances/:id/connect`, 'project.providers'],
  // Test actions inside configuration areas.
  ['POST', `${B}/auth/:provider/token`, 'walkthroughs.run'],
  ['POST', `${B}/auth/:provider/code`, 'walkthroughs.run'],
  ['POST', `${B}/personas/:id/assign`, 'walkthroughs.run'],
  ['POST', `${B}/personas/:id/start`, 'walkthroughs.run'],
  ['POST', `${B}/personas/:id/test`, 'walkthroughs.run'],
  ['POST', `${B}/push/reset`, 'walkthroughs.run'],
  ['DELETE', `${B}/llm/calls`, 'walkthroughs.run'],
  // Reads sent as POST (long polls, previews, validation).
  ['POST', `${B}/auto-replies/fires/wait`, 'project.view'],
  ['POST', `${B}/payments/wait`, 'project.view'],
  ['POST', `${B}/personas/threads/wait`, 'project.view'],
  ['POST', `${B}/llm/calls/wait`, 'project.view'],
  ['POST', `${B}/storyboards/validate`, 'project.view'],
  ['POST', `${B}/data-sets/:key/preview`, 'project.view'],
  ['POST', `${B}/users/:id/read`, 'project.view'],
  ['POST', `${B}/runs/:run/verdict`, 'project.view'],
  // Features board: the Designer role may edit details and images.
  ['PATCH', `${B}/features/:ref`, 'features.details'],
  ['POST', `${B}/features/:ref/images`, 'features.details'],
  ['DELETE', `${B}/features/:ref/images/:imageId`, 'features.details'],
  // Members: adding someone needs the list of all users.
  ['GET', `${B}/members/candidates`, 'project.settings'],
];

/** Non-/api paths that need sign-in (dashboard-facing). The storage upload is matched in the hook (access/hook.ts). */
const PROTECTED_OTHER: { route: string; access: RouteAccess }[] = [
  { route: '/mcp', access: { permission: 'authenticated', scope: 'none' } },
  // Mailpit holds every project's mail and cannot be filtered per project: instance admins only. The dashboard's
  // inbox reads mail through /api/messages/:id/mail/… (checked against the message's project) instead.
  { route: '/mailpit', access: { permission: 'instance.admin', scope: 'none' } },
  { route: '/mailpit/*', access: { permission: 'instance.admin', scope: 'none' } },
];

/**
 * Non-/api routes that stay open with sign-in on: called by the app under test (or a third party) with their own
 * per-project keys, exactly as in Open mode. The dashboard's static files are open too (the login page is one of them).
 */
export const OPEN_ROUTE_PREFIXES = ['/mock/', '/hook/', '/auth/', '/storage/', '/pay/', '/llm/', '/push/', '/nafath/'];
export const OPEN_ROUTES = ['/favicon.ico'];

/** The dashboard's storage upload (PUT /storage/<p>/<i>/__hub/objects/…) rides on the open storage route. */
export const STORAGE_ROUTE = '/storage/:project/:instance/*';
export const STORAGE_HUB_ACCESS: RouteAccess = { permission: 'project.providers', scope: 'path' };

const normMethod = (m: string) => (m.toUpperCase() === 'HEAD' ? 'GET' : m.toUpperCase());
const isRead = (m: string) => normMethod(m) === 'GET';

/**
 * The access rule of a registered route: a RouteAccess for /api and protected routes, "open" for app-facing and
 * static routes, or null for an /api route the table does not cover (refused when sign-in is on).
 */
export function routeAccess(method: string, route: string): RouteAccess | 'open' | null {
  if (route === '/api' || route.startsWith('/api/')) {
    const m = normMethod(method);
    const ex = EXACT.find(([em, er]) => em === m && er === route);
    if (ex) return { permission: ex[2], scope: ex[3] ?? 'path' };
    let best: Area | null = null;
    for (const a of AREAS) {
      if ((route === a.route || route.startsWith(`${a.route}/`)) && (!best || a.route.length > best.route.length)) best = a;
    }
    if (!best) return null;
    return { permission: isRead(method) ? best.read : best.write, scope: best.scope ?? 'path' };
  }
  const p = PROTECTED_OTHER.find((x) => x.route === route);
  if (p) return p.access;
  return 'open';
}

/** Whether a non-/api route is one of the known kinds (open app-facing, or protected). Static files are checked apart. */
export function isKnownOtherRoute(route: string): boolean {
  return PROTECTED_OTHER.some((x) => x.route === route) || OPEN_ROUTES.includes(route) || OPEN_ROUTE_PREFIXES.some((p) => route.startsWith(p));
}

/**
 * Roles and their permissions (teams plan, "Roles"). Single admin mode only has "admin"; Teams mode assigns the
 * project roles per membership (project_members). "internal" is stubyard's own app.inject() calls.
 */
export type Role = 'internal' | 'admin' | 'project_admin' | 'project_manager' | 'developer' | 'designer' | 'qa' | 'viewer';

const BASE: Permission[] = ['public', 'authenticated', 'self'];
const ALL: Permission[] = [...BASE, 'instance.admin', 'project.settings', 'project.providers', 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view', 'project.reset'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  internal: new Set(ALL),
  admin: new Set(ALL),
  project_admin: new Set([...BASE, 'project.settings', 'project.providers', 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view', 'project.reset']),
  project_manager: new Set([...BASE, 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view']),
  developer: new Set([...BASE, 'project.providers', 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view']),
  designer: new Set([...BASE, 'features.details', 'project.view']),
  qa: new Set([...BASE, 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view']),
  viewer: new Set([...BASE, 'project.view']),
};

export function allows(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

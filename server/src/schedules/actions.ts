import { HttpError } from '../util.js';

/**
 * Scheduling allowlist: the dashboard API calls a schedule may make later. Paths are stored as the suffix after
 * /api/projects/<slug> (so a project rename keeps working); the full URL is rebuilt at fire time.
 */
export const SCHEDULE_ACTIONS = ['webhook.send', 'webhook.sequence', 'user.reply', 'rule.set', 'rule.clear', 'mock.scenario'] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

interface Allowed {
  action: ScheduleAction;
  method: string;
  re: RegExp;
  example: string;
}

const SEG = '[^/]+';
const ALLOWED: Allowed[] = [
  { action: 'webhook.send', method: 'POST', re: new RegExp(`^/webhook-templates/${SEG}/send$`), example: 'POST /webhook-templates/:id/send' },
  { action: 'webhook.sequence', method: 'POST', re: new RegExp(`^/webhook-sequences/${SEG}/run$`), example: 'POST /webhook-sequences/:id/run' },
  { action: 'user.reply', method: 'POST', re: new RegExp(`^/users/${SEG}/reply$`), example: 'POST /users/:id/reply' },
  { action: 'rule.set', method: 'POST', re: new RegExp(`^/(users|providers)/${SEG}/rules(/preset/${SEG})?$`), example: 'POST /users/:id/rules, /providers/:instance/rules, …/rules/preset/:preset' },
  { action: 'rule.clear', method: 'DELETE', re: new RegExp(`^/(users|providers)/${SEG}/rules$`), example: 'DELETE /users/:id/rules, /providers/:instance/rules' },
  { action: 'rule.clear', method: 'DELETE', re: new RegExp(`^/rules/${SEG}$`), example: 'DELETE /rules/:rule' },
  { action: 'rule.clear', method: 'POST', re: /^\/rules\/reset$/, example: 'POST /rules/reset' },
  { action: 'mock.scenario', method: 'PATCH', re: new RegExp(`^/mocks/${SEG}/active-scenario$`), example: 'PATCH /mocks/:mock/active-scenario' },
];

/** The allowed calls, for error messages and the dashboard. */
export const ALLOWED_CALLS = ALLOWED.map((a) => ({ action: a.action, call: a.example }));

/**
 * Normalise a path given as a suffix ("/webhook-templates/x/send") or a full dashboard API path
 * ("/api/projects/<slug>/webhook-templates/x/send") to the suffix. Query strings and other projects are rejected.
 */
export function toSuffix(slug: string, path: string): string {
  let p = String(path ?? '').trim();
  if (!p) throw new HttpError(400, 'path is required, e.g. "/webhook-templates/<id>/send"');
  if (/[?#]/.test(p)) throw new HttpError(400, 'path must not contain a query string; put parameters in body');
  if (!p.startsWith('/')) p = '/' + p;
  const full = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(p);
  if (full) {
    if (decodeURIComponent(full[1]).toLowerCase() !== slug) throw new HttpError(400, `path points outside project "${slug}"`);
    p = full[2] ?? '/';
  } else if (/^\/(api|mock|hook|auth|storage|run|mcp)(\/|$)/.test(p)) {
    throw new HttpError(400, 'path must be inside the project: a suffix like "/webhook-templates/<id>/send" or "/api/projects/<slug>/…"');
  }
  if (p.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(400, 'path must not contain "." or ".." segments');
  return p.replace(/\/+$/, '');
}

/** The action of an allowed call; 400 listing the allowed calls otherwise. */
export function matchAllowed(method: string, suffix: string): ScheduleAction {
  const m = String(method ?? '').toUpperCase();
  const hit = ALLOWED.find((a) => a.method === m && a.re.test(suffix));
  if (!hit) {
    throw new HttpError(400, `${m || '(no method)'} ${suffix} cannot be scheduled. Allowed: ${ALLOWED.map((a) => a.example).join('; ')}`, { allowed: ALLOWED_CALLS });
  }
  return hit.action;
}

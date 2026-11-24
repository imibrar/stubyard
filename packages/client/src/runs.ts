/**
 * stubyard test-run helpers (anything with a fetch): one isolated run per test worker, its users, report and clock.
 *
 *   import { startRun, withRun } from '@stubyard/client/runs';
 *   const run = await startRun({ project: 'hyper', key: `w${process.env.TEST_WORKER_INDEX}`, users: [{ role: 'customer' }], replace: true });
 *   await page.setExtraHTTPHeaders(run.headers);          // app → stubyard calls carry X-Hub-Run
 *   const customer = run.user('customer');                // minted user of this run
 *   const otp = await run.waitForMessage({ user: customer.email!, channel: 'email' });
 *   const { report } = await run.stop();                   // frozen report; reportHtml() for the HTML page
 *
 *   await withRun({ project: 'hyper' }, async (run) => { … });   // stopped in finally, even when the test throws
 */

import { hubFetchFn } from './http.js';

export interface RunUser {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  whatsapp?: string | null;
  password?: string;
  runId: string | null;
  [k: string]: unknown;
}

export interface RunView {
  id: string;
  key: string;
  label: string;
  status: 'active' | 'stopped';
  startedAt: string;
  stoppedAt: string | null;
  expiresAt: string;
  claims: string[];
  meta: Record<string, unknown>;
  counts: { users: number; messages: number; logs: number; problems: number };
  urls: { mockPrefix: string; hookPrefix: string; smtpUsername: string };
  header: { 'X-Hub-Run': string };
  users?: RunUser[];
  [k: string]: unknown;
}

/** The JSON run report (GET /api/projects/:p/runs/:run/report); see the stubyard agent guide for every field. */
export interface RunReport {
  run: { id: string; key: string; label: string; status: string; startedAt: string; stoppedAt: string | null; durationMs: number; meta: Record<string, unknown> };
  users: { id: string; name: string; role: string; email: string | null; phone: string | null }[];
  messages: { total: number; byChannel: Record<string, number>; byStatus: Record<string, number>; items: Record<string, unknown>[] };
  lint: { messages: number; error: number; warn: number; info: number; byCheck: Record<string, number>; items: Record<string, unknown>[] };
  traffic: { total: number; byOutcome: Record<string, number>; problems: Record<string, unknown>[] };
  rules: { id: string; owner: string; description: string; hits: number }[];
  mocks: { mock: string; scenario: string; hits: number }[];
  storage?: Record<string, unknown>;
  warnings: string[];
}

type Fetch = typeof fetch;

export interface RunTarget {
  /** stubyard API base, default http://localhost:4000. */
  apiUrl?: string;
  project: string;
  /** Custom fetch; default globalThis.fetch. */
  fetch?: Fetch;
  /** API token for a hub with sign-in on; default the STUBYARD_TOKEN environment variable. */
  apiToken?: string;
}

export interface StartRunOptions extends RunTarget {
  /** Run key (lowercase letters, digits, - and _), e.g. "w3"; default a random one. */
  key?: string;
  label?: string;
  /** Auto-stop after this many minutes (default 120). */
  ttlMinutes?: number;
  /** Users minted when the run starts, e.g. [{ role: 'admin' }, { role: 'customer', count: 2 }]. */
  users?: { role?: string; count?: number; name?: string }[];
  /** This run also captures traffic that names no run (one per project). */
  captureUnattributed?: boolean;
  /** Extra strings (emails, phones, order ids) that attribute requests / messages to this run. */
  claims?: string[];
  meta?: Record<string, unknown>;
  /** Stop and purge an active run with the same key first (a crashed worker). */
  replace?: boolean;
}

export interface MintOptions {
  role?: string;
  name?: string;
  count?: number;
  /** false: no email address. */
  email?: boolean;
  /** false: no phone / WhatsApp number. */
  phone?: boolean;
}

export type TimeFeature = 'totp' | 'auth' | 'verify' | 'webhooks';

export interface RunHandle {
  id: string;
  key: string;
  project: string;
  /** The run's users (started + minted), in order. */
  users: RunUser[];
  /** Send with every app → stubyard request (Playwright: page.setExtraHTTPHeaders(run.headers)). */
  headers: { 'X-Hub-Run': string };
  urls: { mockPrefix: string; hookPrefix: string; smtpUsername: string; report: string; reportHtml: string };
  /** The run's index-th user (0-based) with this role; throws when there is none. */
  user(role: string, index?: number): RunUser;
  /** Mint more users into the run (added to `users`). */
  mint(o?: MintOptions): Promise<RunUser[]>;
  report(): Promise<RunReport>;
  /** The report as a self-contained HTML page (save it as a CI artifact). */
  reportHtml(): Promise<string>;
  /** Shift stubyard's clock for one feature inside this run only, e.g. setTimeOffset('auth', '+2h'); 0 clears. */
  setTimeOffset(feature: TimeFeature, offset: string | number): Promise<unknown>;
  /** Long-poll for the newest message of the run to a user (email / phone) on a channel; throws on timeout. */
  waitForMessage(o: { user?: string; channel?: 'email' | 'sms' | 'whatsapp'; to?: string; timeoutMs?: number }): Promise<Record<string, unknown> & { otp?: string | null }>;
  /** Stop the run (frozen report); purge also deletes its users, messages and logs. */
  stop(o?: { purge?: boolean }): Promise<{ run: RunView; report: RunReport; reportHtmlUrl?: string }>;
}

const base = (o: { apiUrl?: string }) => (o.apiUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
const proj = (o: RunTarget) => `${base(o)}/api/projects/${encodeURIComponent(o.project)}`;
const runUrl = (o: RunTarget, run: string) => `${proj(o)}/runs/${encodeURIComponent(run)}`;
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function call<T>(f: Fetch, method: string, url: string, body?: unknown): Promise<T> {
  const res = await f(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`stubyard answered ${res.status} for ${method} ${url}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function getText(f: Fetch, url: string): Promise<string> {
  const res = await f(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`stubyard answered ${res.status} for GET ${url}: ${text}`);
  return text;
}

const fetchOf = (o: { apiUrl?: string; fetch?: Fetch; apiToken?: string }): Fetch => hubFetchFn(o);

/** Start a run and return a handle with its users, header and helpers. */
export async function startRun(o: StartRunOptions): Promise<RunHandle> {
  const f = fetchOf(o);
  const v = await call<RunView>(f, 'POST', `${proj(o)}/runs`, {
    key: o.key,
    label: o.label,
    ttlMinutes: o.ttlMinutes,
    users: o.users,
    captureUnattributed: o.captureUnattributed,
    claims: o.claims,
    meta: o.meta,
    replace: o.replace,
  });
  return handle(o, v, f);
}

function handle(o: RunTarget, v: RunView, f: Fetch): RunHandle {
  const url = runUrl(o, v.id);
  const users: RunUser[] = [...(v.users ?? [])];
  return {
    id: v.id,
    key: v.key,
    project: o.project,
    users,
    headers: { 'X-Hub-Run': v.key },
    urls: { ...v.urls, report: `${url}/report`, reportHtml: `${url}/report.html` },
    user(role: string, index = 0) {
      const r = role.trim().toLowerCase();
      const u = users.filter((x) => x.role === r)[index];
      if (!u) throw new Error(`Run "${v.key}" has no ${r} user #${index} (roles: ${[...new Set(users.map((x) => x.role))].join(', ') || 'none'}); mint one with run.mint({ role: '${r}' })`);
      return u;
    },
    async mint(m: MintOptions = {}) {
      const minted = await call<RunUser[]>(f, 'POST', `${url}/users`, m);
      users.push(...minted);
      return minted;
    },
    report: () => call<RunReport>(f, 'GET', `${url}/report`),
    reportHtml: () => getText(f, `${url}/report.html`),
    setTimeOffset: (feature, offset) => call(f, 'PUT', `${proj(o)}/time${qs({ run: v.id })}`, { offsets: { [feature]: offset } }),
    async waitForMessage(w) {
      const timeoutMs = w.timeoutMs ?? 30_000;
      const res = await f(`${proj(o)}/messages/wait${qs({ run: v.id, user: w.user, channel: w.channel, to: w.to, timeout: Math.ceil(timeoutMs / 1000) })}`);
      const text = await res.text();
      if (!res.ok) throw new Error(res.status === 408 ? `No message for ${w.user ?? w.to ?? 'the run'} within ${timeoutMs} ms` : `stubyard answered ${res.status}: ${text}`);
      return JSON.parse(text);
    },
    stop: (s = {}) => stopRun({ ...o, run: v.id, purge: s.purge, fetch: f }),
  };
}

/** Stop a run by key or id (frozen report); purge also deletes its users, messages and logs. */
export function stopRun(o: RunTarget & { run: string; purge?: boolean }): Promise<{ run: RunView; report: RunReport; reportHtmlUrl?: string }> {
  return call(fetchOf(o), 'POST', `${runUrl(o, o.run)}/stop${qs({ purge: o.purge ? 1 : undefined })}`, {});
}

/** The run report: JSON (default) or the self-contained HTML page as a string. */
export function getRunReport(o: RunTarget & { run: string; format?: 'json' }): Promise<RunReport>;
export function getRunReport(o: RunTarget & { run: string; format: 'html' }): Promise<string>;
export async function getRunReport(o: RunTarget & { run: string; format?: 'json' | 'html' }): Promise<RunReport | string> {
  const f = fetchOf(o);
  if (o.format === 'html') return getText(f, `${runUrl(o, o.run)}/report.html`);
  return call<RunReport>(f, 'GET', `${runUrl(o, o.run)}/report`);
}

/** Start a run, pass it to fn, and stop it in finally (errors from fn are rethrown after the stop). */
export async function withRun<T>(o: StartRunOptions & { purge?: boolean }, fn: (run: RunHandle) => Promise<T> | T): Promise<T> {
  const run = await startRun(o);
  try {
    return await fn(run);
  } finally {
    await run.stop({ purge: o.purge }).catch(() => undefined);
  }
}

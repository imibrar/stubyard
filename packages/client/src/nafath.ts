/**
 * Fake Nafath helpers (browser-safe, fetch only): find the MFA request the app started, then act as the person in
 * the Nafath app (approve, reject or pick one of the three numbers), and set faults for the next requests.
 *
 *   import { waitForNafathRequest, chooseNafathNumber } from '@stubyard/client/nafath';
 *   const t = { project: 'ksa' };
 *   // … the app calls POST /nafath/ksa/main/api/v1/mfa/request …
 *   const r = await waitForNafathRequest(t, { user: 'Mohammed', status: 'WAITING' });   // throws on timeout
 *   await chooseNafathNumber(t, r.id, r.random);          // COMPLETED; the app's /status call sees it
 *   await addNafathFault(t, { fault: 'rejected', user: 'Mohammed', times: 1 });
 */
import { hubJson, projectPath, query, seg, type HubTarget } from './http.js';

export type NafathStatus = 'WAITING' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
export type NafathAutoDecision = 'none' | 'approve' | 'reject' | 'wrong_number' | 'expire';

export interface NafathInstanceConfig {
  callbackUrl: string | null;
  ttlSeconds: number;
  autoDecision: NafathAutoDecision;
  autoDelayMs: number;
  services: string[];
  callbackFields: 'default' | 'compat';
  callbackOnExpired: boolean;
  wrongNumberCooldownSeconds: number;
  statusLagMs: number;
}

/** An instance as the control API shows it (no private keys), with the app-facing URLs. */
export interface NafathInstance {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  preset: 'nafath';
  /** APP-ID / APP-KEY header values the app sends. appKey is only in the create / update answers and GET …/connect. */
  appId: string;
  appKey?: string;
  config: NafathInstanceConfig;
  keys: { kid: string; publicJwk: Record<string, unknown>; status: 'active' | 'retired'; createdAt: string }[];
  strict: boolean;
  enabled: boolean;
  createdAt: string;
  urls: { base: string; request: string; status: string; info: string; jwk: string; sandboxBase: string; stagingBase: string };
}

export interface NafathInstanceInput {
  slug?: string;
  name?: string;
  strict?: boolean;
  enabled?: boolean;
  config?: Partial<NafathInstanceConfig>;
  [k: string]: unknown;
}

export interface NafathCallbackAttempt {
  at: string;
  url: string;
  status: number | null;
  error?: string | null;
  duplicate?: boolean;
}

export interface NafathRequest {
  id: string;
  projectId: string;
  instanceId: string;
  /** null: an unknown national ID accepted in lax mode (unassigned). */
  testUserId: string | null;
  runId: string | null;
  transId: string;
  /** The 2-digit number the app shows; the right one among `choices`. */
  random: string;
  choices: string[];
  nationalId: string;
  service: string | null;
  locale: string | null;
  requestId: string | null;
  status: NafathStatus;
  /** rejected | wrong_number | expired. */
  reason: string | null;
  decidedBy: string | null;
  chosen: string | null;
  /** Signed JWT of a COMPLETED / REJECTED request. */
  token: string | null;
  callback: NafathCallbackAttempt[];
  logId: string | null;
  polls: number;
  createdAt: string;
  expiresAt: string;
  /** Seconds left on the project's auth clock when the server answered (WAITING only, else null). */
  expiresInSeconds?: number | null;
  decidedAt: string | null;
}

export interface NafathRequestFilter {
  /** Test user (id, email, national ID, phone, name or role), or 'unassigned'. */
  user?: string;
  nationalId?: string;
  /** Instance slug or id. */
  instance?: string;
  status?: NafathStatus | NafathStatus[];
  /** Test run key or id. */
  run?: string;
}

export interface WaitForNafathRequestOptions extends NafathRequestFilter {
  /** A request id: only requests newer than it match. */
  after?: string;
  /** Without `after` and `status`: requests of the last this many seconds match (server default 10). */
  lookback?: number;
  /** Overall timeout in ms (default 30000); the helper long-polls in slices of at most 120 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A fault rule (POST …/nafath/faults). */
export interface NafathFaultRule {
  id: string;
  projectId: string;
  runId: string | null;
  instanceId: string | null;
  /** user: test user id. */
  match: { user?: string; nationalId?: string; service?: string };
  /** e.g. rejected, approve:2000, slow:500, down, no_callback. */
  fault: string;
  remaining: number | null;
  hits: number;
  createdAt: string;
}

export interface NafathFaultInput {
  /** rejected[:ms] | approve[:ms] | expired | wrong_number | already_active | down | timeout | slow:<ms> | rate_limit | invalid_credentials | bad_signature | unknown_kid | no_callback | duplicate_callback | none (clears). */
  fault: string;
  user?: string;
  nationalId?: string;
  service?: string;
  instance?: string;
  /** Uses before the rule is spent (default: every request). */
  times?: number;
  /** Test run key or id: the rule applies to that run's requests only. */
  run?: string;
}

export interface NafathCallbackResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  attempt: number;
  logId: string | null;
  skipped?: string;
  retry: { scheduleId: string; inMs: number } | null;
}

const base = (t: HubTarget, suffix = '') => projectPath(t, `/nafath${suffix}`);
const one = (t: HubTarget, id: string, suffix = '') => base(t, `/requests/${seg(id)}${suffix}`);

export function listNafathInstances(t: HubTarget): Promise<NafathInstance[]> {
  return hubJson(t, 'GET', base(t, '/instances'));
}
export function createNafathInstance(t: HubTarget, input: NafathInstanceInput = {}): Promise<NafathInstance> {
  return hubJson(t, 'POST', base(t, '/instances'), input);
}
/** Newest first (default 100, max 500). */
export function listNafathRequests(t: HubTarget, f: NafathRequestFilter & { limit?: number } = {}): Promise<NafathRequest[]> {
  return hubJson(t, 'GET', base(t, `/requests${query({ ...f })}`));
}
export function getNafathRequest(t: HubTarget, id: string): Promise<NafathRequest> {
  return hubJson(t, 'GET', one(t, id));
}

/**
 * The first request matching the filter (oldest of the matches), long-polling until `timeoutMs`. Throws when none
 * arrives in time.
 */
export async function waitForNafathRequest(t: HubTarget, o: WaitForNafathRequestOptions = {}): Promise<NafathRequest> {
  const { timeoutMs = 30_000, signal, ...f } = o;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    const timeout = Math.min(120, Math.max(0, Math.ceil(left / 1000)));
    const r = await hubJson<{ timedOut: boolean; request: NafathRequest | null; cursor: string | null }>(
      t,
      'GET',
      base(t, `/requests/wait${query({ ...f, timeout: String(timeout) })}`),
      undefined,
      { signal },
    );
    if (r.request) return r.request;
    if (Date.now() >= deadline) {
      const what = Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ');
      throw new Error(`No Nafath request${what ? ` (${what})` : ''} in project "${t.project}" within ${timeoutMs} ms`);
    }
  }
}

/** The person approves without picking a number: COMPLETED. */
export function approveNafathRequest(t: HubTarget, id: string): Promise<NafathRequest> {
  return hubJson(t, 'POST', one(t, id, '/approve'), {});
}
/** The person rejects: REJECTED (reason rejected). */
export function rejectNafathRequest(t: HubTarget, id: string): Promise<NafathRequest> {
  return hubJson(t, 'POST', one(t, id, '/reject'), {});
}
/** The person picks one of the three numbers: the right one (`random`) COMPLETES, another REJECTS (wrong_number). */
export function chooseNafathNumber(t: HubTarget, id: string, number: string | number): Promise<NafathRequest> {
  return hubJson(t, 'POST', one(t, id, '/choose'), { number: String(number) });
}
/** Send the callback of a decided request again (a fresh attempt 1). */
export function resendNafathCallback(t: HubTarget, id: string): Promise<NafathCallbackResult> {
  return hubJson(t, 'POST', one(t, id, '/callback/resend'), {});
}

export function listNafathFaults(t: HubTarget, o: { run?: string } = {}): Promise<NafathFaultRule[]> {
  return hubJson(t, 'GET', base(t, `/faults${query({ run: o.run })}`));
}
/** A fault rule for the next matching requests; fault 'none' clears instead (returns {cleared: true}). */
export function addNafathFault(t: HubTarget, input: NafathFaultInput): Promise<NafathFaultRule | { cleared: true }> {
  return hubJson(t, 'POST', base(t, '/faults'), input);
}
/** Removes the project's fault rules (optionally one run's, or one user's). */
export async function clearNafathFaults(t: HubTarget, o: { run?: string; user?: string } = {}): Promise<number> {
  return (await hubJson<{ deleted: number }>(t, 'DELETE', base(t, `/faults${query({ run: o.run, user: o.user })}`))).deleted;
}
export async function deleteNafathFault(t: HubTarget, id: string): Promise<void> {
  await hubJson(t, 'DELETE', base(t, `/faults/${seg(id)}`));
}

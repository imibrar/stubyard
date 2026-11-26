import crypto from 'node:crypto';
import { generateSigningKey } from '../auth/keys.js';
import type { DB } from '../db/index.js';
import type { TestUser, UserRepo } from '../repos/users.js';
import { HttpError, nowIso, SLUG_RE } from '../util.js';
import { nafathClaims, personClaims, signNafathToken } from './claims.js';
import { appliesTo, parseFault, type FaultStage, type NafathFault } from './faults.js';
import { isNationalId } from './national-id.js';
import { NafathRepo, type RequestFilter } from './repo.js';
import { NAFATH_ERRORS, NafathError, nafathConfig, type NafathInstance, type NafathKey, type NafathRequest, type NafathRule, type NafathStatus } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const APP_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** What the service needs from the hub (injected so it runs on a bare DB in unit tests). */
export interface NafathDeps {
  db: DB;
  users: UserRepo;
  /** Publishes 'nafath.changed' (hub: (p, d) => hub.bus.publish({type: 'nafath.changed', projectId: p, data: d})). */
  publish?: (projectId: string, data: unknown) => void;
  /** Milliseconds on the project's auth clock (hub: (p, r) => hub.clock.now(p, 'auth', r)); default Date.now. */
  now?: (projectId: string, runId: string | null) => number;
  /** Token `iss` for an instance (hub: its base URL); default urn:stubyard:nafath:<slug>. */
  issuer?: (instance: NafathInstance) => string | undefined;
}

export interface ProjectRef {
  id: string;
  slug: string;
}

/** Context a fault rule is matched against. */
export interface NafathFaultContext {
  projectId: string;
  instanceId: string;
  runId: string | null;
  userId: string | null;
  nationalId: string | null;
  service: string | null;
}

export interface StartInput {
  nationalId: unknown;
  service?: unknown;
  locale?: string | null;
  requestId?: string | null;
  runId?: string | null;
  appId?: string | null;
  appKey?: string | null;
  /** Header problems the route noticed (e.g. no X-Forwarded-For): added to the warnings. */
  strictHeadersWarnings?: string[];
  logId?: string | null;
}

export interface StartResult {
  transId: string;
  random: string;
  request: NafathRequest;
  /** Problems lax mode let through (shown in the traffic log's resolved.warnings). */
  warnings: string[];
  /** slow:<ms> fault: answer after this delay. */
  delayMs: number;
  fault: string | null;
}

export interface LookupInput {
  nationalId?: unknown;
  transId?: unknown;
  random?: unknown;
  appId?: string | null;
  appKey?: string | null;
}

export interface StatusResult {
  status: NafathStatus;
  request: NafathRequest;
  warnings: string[];
  delayMs: number;
  fault: string | null;
}

export type Decision = 'approve' | 'reject' | 'wrong_number' | 'expire';
export const DECISIONS: Decision[] = ['approve', 'reject', 'wrong_number', 'expire'];

/**
 * The hub side of decisions and callbacks (nafath/callbacks.ts, attached by the routes): delayed decisions through
 * the `nafath.decide` schedule action and callback delivery through `nafath.callback`.
 */
export interface NafathDelivery {
  scheduleDecision(request: NafathRequest, decision: Decision, delayMs: number, decidedBy: string): void;
  callback(request: NafathRequest): void;
}

/** Fake Nafath: instances (APP-ID / APP-KEY, signing keys), MFA transactions, decisions and fault rules. No HTTP here. */
export class NafathService {
  readonly repo: NafathRepo;
  private users: UserRepo;
  private delivery: NafathDelivery | null = null;

  constructor(private deps: NafathDeps) {
    this.repo = new NafathRepo(deps.db);
    this.users = deps.users;
  }

  /** Delayed decisions and callbacks need the hub (schedules, outbound traffic): attached by registerNafathRoutes. */
  attach(delivery: NafathDelivery): void {
    this.delivery = delivery;
  }

  private nowMs(projectId: string, runId: string | null): number {
    return this.deps.now ? this.deps.now(projectId, runId) : Date.now();
  }

  changed(projectId: string, data: unknown): void {
    this.deps.publish?.(projectId, data);
  }

  // ------------------------------------------------------------------ instances

  listInstances(projectId: string): NafathInstance[] {
    return this.repo.listInstances(projectId);
  }

  requireInstance(project: ProjectRef, ref: string): NafathInstance {
    const i = this.repo.instanceBySlug(project.id, ref.toLowerCase()) ?? this.repo.getInstance(ref);
    if (!i || i.projectId !== project.id) throw new HttpError(404, `Nafath instance "${ref}" not found in project ${project.slug}`);
    return i;
  }

  /** Host mode: the instance is found by its APP-ID header. */
  instanceByAppId(appId: string): NafathInstance | null {
    return this.repo.instanceByAppId(appId);
  }

  private uniqueSlug(projectId: string, base: string): string {
    let s = base;
    for (let n = 2; this.repo.instanceBySlug(projectId, s); n++) s = `${base}-${n}`;
    return s;
  }

  private newKey(slug: string): NafathKey {
    const k = generateSigningKey(`stubyard Nafath ${slug}`);
    return { kid: k.kid, privatePem: k.privatePem, publicJwk: k.publicJwk, status: 'active', createdAt: nowIso() };
  }

  private appIdOf(v: unknown, exceptId?: string): string {
    const s = String(v).trim();
    if (!APP_ID_RE.test(s)) throw new HttpError(400, 'appId: 1-120 letters, digits, dots, dashes or underscores');
    const other = this.repo.instanceByAppId(s);
    if (other && other.id !== exceptId) throw new HttpError(409, `APP-ID "${s}" is already used by another Nafath instance (APP-IDs are unique across stubyard)`);
    return s;
  }

  private appKeyOf(v: unknown): string {
    const s = String(v).trim();
    if (!s || s.length > 200 || /\s/.test(s)) throw new HttpError(400, 'appKey: 1-200 characters, no spaces');
    return s;
  }

  /** A new instance with its own APP-ID / APP-KEY and RSA signing key. The project's first one gives every test user a national ID. */
  createInstance(project: ProjectRef, input: J = {}): NafathInstance {
    const slug = input.slug ? String(input.slug).toLowerCase() : this.uniqueSlug(project.id, 'nafath');
    if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug: lowercase letters, digits and dashes (max 48)');
    if (this.repo.instanceBySlug(project.id, slug)) throw new HttpError(409, `Nafath instance "${slug}" already exists`);
    const config = nafathConfig(input.config, null);
    const appId = input.appId ? this.appIdOf(input.appId) : crypto.randomUUID();
    const appKey = input.appKey ? this.appKeyOf(input.appKey) : crypto.randomBytes(16).toString('hex');
    const first = this.repo.listInstances(project.id).length === 0;
    if (first) this.users.ensureNationalIds(project.id);
    const inst = this.repo.insertInstance({
      projectId: project.id,
      slug,
      name: input.name ? String(input.name).slice(0, 120) : 'Nafath',
      appId,
      appKey,
      config,
      keys: [this.newKey(slug)],
      strict: input.strict === true,
      enabled: input.enabled !== false,
    });
    this.changed(project.id, { instance: inst.id, ...(first ? { usersChanged: true } : {}) });
    return inst;
  }

  updateInstance(project: ProjectRef, ref: string, input: J): NafathInstance {
    const cur = this.requireInstance(project, ref);
    const patch: Parameters<NafathRepo['updateInstance']>[1] = {};
    if (input.name !== undefined) patch.name = String(input.name).slice(0, 120);
    if (input.slug !== undefined && input.slug !== cur.slug) {
      const s = String(input.slug).toLowerCase();
      if (!SLUG_RE.test(s)) throw new HttpError(400, 'slug: lowercase letters, digits and dashes (max 48)');
      if (this.repo.instanceBySlug(project.id, s)) throw new HttpError(409, `Nafath instance "${s}" already exists`);
      patch.slug = s;
    }
    if (input.appId !== undefined) patch.appId = this.appIdOf(input.appId, cur.id);
    if (input.appKey !== undefined) patch.appKey = this.appKeyOf(input.appKey);
    if (input.strict !== undefined) patch.strict = input.strict === true;
    if (input.enabled !== undefined) patch.enabled = input.enabled !== false;
    if (input.config !== undefined) patch.config = nafathConfig(input.config, cur.config);
    const next = this.repo.updateInstance(cur.id, patch);
    this.changed(project.id, { instance: cur.id });
    return next;
  }

  /** A new active key; the old one is retired (still in the JWK set) or, with dropOld, removed with every retired key. */
  rotateKeys(project: ProjectRef, ref: string, o: { dropOld?: boolean } = {}): NafathInstance {
    const cur = this.requireInstance(project, ref);
    const old = o.dropOld ? [] : cur.keys.map((k) => ({ ...k, status: 'retired' as const }));
    const next = this.repo.updateInstance(cur.id, { keys: [...old, this.newKey(cur.slug)] });
    this.changed(project.id, { instance: cur.id, rotated: true });
    return next;
  }

  deleteInstance(project: ProjectRef, ref: string): void {
    const cur = this.requireInstance(project, ref);
    this.repo.deleteInstance(cur.id);
    this.changed(project.id, { instance: cur.id, deleted: true });
  }

  /** Instance as the API shows it: private keys are never included. */
  viewInstance(i: NafathInstance) {
    return { ...i, keys: i.keys.map(({ privatePem: _p, ...k }) => k) };
  }

  // ------------------------------------------------------------------ the app-facing MFA API

  /**
   * POST /api/v1/mfa/request. Throws NafathError for an answer other than 200 (strict checks, faults, an active
   * transaction). Lax mode accepts wrong credentials and unknown IDs (unassigned request) and returns warnings.
   */
  startRequest(instance: NafathInstance, input: StartInput): StartResult {
    const warnings = [...(input.strictHeadersWarnings ?? [])];
    const nationalId = String(input.nationalId ?? '').trim();
    if (!nationalId) throw NafathError.of(NAFATH_ERRORS.invalidRequest, 'nationalId is required');
    const service = input.service === undefined || input.service === null || input.service === '' ? null : String(input.service).slice(0, 200);
    const user = this.users.findByNationalId(instance.projectId, nationalId);
    const runId = input.runId ?? user?.runId ?? null;
    const ctx: NafathFaultContext = { projectId: instance.projectId, instanceId: instance.id, runId, userId: user?.id ?? null, nationalId, service };

    if (!instance.enabled) throw NafathError.of(NAFATH_ERRORS.down, `Service Unavailable (Nafath instance "${instance.slug}" is disabled)`);
    const picked = this.pickFault('request', ctx);
    const fault = picked?.fault ?? null;
    const delayMs = this.httpFault(fault);
    this.checkCredentials(instance, input.appId, input.appKey, warnings);

    if (!isNationalId(nationalId)) {
      if (instance.strict) throw NafathError.of(NAFATH_ERRORS.notFound, `National ID ${nationalId} not found`);
      warnings.push(`"${nationalId}" is not a valid national ID / Iqama number (10 digits, 1… or 2…, Luhn check digit)`);
    } else if (!user) {
      if (instance.strict) throw NafathError.of(NAFATH_ERRORS.notFound, `National ID ${nationalId} not found`);
      warnings.push(`No test user has national ID ${nationalId}: the request is unassigned`);
    }
    if (!service) {
      if (instance.strict) throw NafathError.of(NAFATH_ERRORS.invalidRequest, 'service is required');
      warnings.push('No service in the request body');
    } else if (instance.config.services.length && !instance.config.services.includes(service)) {
      if (instance.strict) throw NafathError.of(NAFATH_ERRORS.invalidRequest, `Service "${service}" is not allowed for this APP-ID`);
      warnings.push(`Service "${service}" is not in the instance's services (${instance.config.services.join(', ')})`);
    }

    if (fault?.kind === 'already_active') throw NafathError.of(NAFATH_ERRORS.alreadyActive);
    const active = this.repo.activeFor(instance.id, nationalId);
    if (active && this.refresh(active).status === 'WAITING') throw NafathError.of(NAFATH_ERRORS.alreadyActive);
    const now = this.nowMs(instance.projectId, runId);
    const cooldown = instance.config.wrongNumberCooldownSeconds * 1000;
    if (cooldown) {
      const last = this.repo.lastDecidedFor(instance.id, nationalId);
      if (last?.reason === 'wrong_number' && last.decidedAt && now < Date.parse(last.decidedAt) + cooldown) {
        throw NafathError.of(NAFATH_ERRORS.alreadyActive, 'A wrong number was chosen recently: wait before starting a new transaction');
      }
    }

    const random = String(crypto.randomInt(10, 100));
    let request = this.repo.insertRequest({
      projectId: instance.projectId,
      instanceId: instance.id,
      testUserId: user?.id ?? null,
      runId,
      transId: crypto.randomUUID(),
      random,
      choices: choicesFor(random),
      nationalId,
      service,
      locale: input.locale ? String(input.locale).slice(0, 20) : null,
      requestId: input.requestId ? String(input.requestId).slice(0, 200) : null,
      logId: input.logId ?? null,
      expiresAt: new Date(now + instance.config.ttlSeconds * 1000).toISOString(),
    });
    this.changed(instance.projectId, { request: request.id, status: request.status, user: request.testUserId, created: true });
    request = this.applyDecisionFault(instance, request, picked);
    return { transId: request.transId, random, request, warnings, delayMs, fault: fault?.spec ?? null };
  }

  /** POST /api/v1/mfa/request/status: lazy expiry on the auth clock, poll counter, statusLagMs. */
  status(instance: NafathInstance, input: LookupInput): StatusResult {
    const { request, warnings, delayMs, fault } = this.lookup(instance, input);
    this.repo.countPoll(request.id);
    const fresh = this.refresh(this.repo.getRequest(request.id)!);
    return { status: this.visibleStatus(instance, fresh), request: fresh, warnings, delayMs, fault };
  }

  /** GET /api/v1/mfa/request/info: the person once COMPLETED; otherwise a NafathError (401-033-024 waiting, 400-034-051 expired). */
  info(instance: NafathInstance, input: LookupInput): { status: NafathStatus; transId: string; person: J; request: NafathRequest; warnings: string[]; delayMs: number } {
    const { request, warnings, delayMs } = this.lookup(instance, input);
    const fresh = this.refresh(request);
    const status = this.visibleStatus(instance, fresh);
    if (status === 'WAITING') throw NafathError.of(NAFATH_ERRORS.notApproved);
    if (status === 'EXPIRED') throw NafathError.of(NAFATH_ERRORS.expired);
    if (status === 'REJECTED') throw NafathError.of(NAFATH_ERRORS.notFound, 'The transaction was rejected');
    const user = fresh.testUserId ? this.users.get(fresh.projectId, fresh.testUserId) : null;
    return { status, transId: fresh.transId, person: personClaims(user, fresh.nationalId), request: fresh, warnings, delayMs };
  }

  private lookup(instance: NafathInstance, input: LookupInput): { request: NafathRequest; warnings: string[]; delayMs: number; fault: string | null } {
    const warnings: string[] = [];
    const transId = String(input.transId ?? '').trim();
    const nationalId = String(input.nationalId ?? '').trim();
    const random = String(input.random ?? '').trim();
    const found = transId ? this.repo.requestByTransId(transId) : null;
    const request = found && found.instanceId === instance.id ? found : null;
    const ctx: NafathFaultContext = {
      projectId: instance.projectId,
      instanceId: instance.id,
      runId: request?.runId ?? null,
      userId: request?.testUserId ?? null,
      nationalId: request?.nationalId ?? (nationalId || null),
      service: request?.service ?? null,
    };
    if (!instance.enabled) throw NafathError.of(NAFATH_ERRORS.down, `Service Unavailable (Nafath instance "${instance.slug}" is disabled)`);
    const fault = this.pickFault('status', ctx)?.fault ?? null;
    const delayMs = this.httpFault(fault);
    this.checkCredentials(instance, input.appId, input.appKey, warnings);
    if (!request) throw NafathError.of(NAFATH_ERRORS.notFound);
    for (const [name, given, want] of [['nationalId', nationalId, request.nationalId], ['random', random, request.random]] as const) {
      if (given === want) continue;
      if (instance.strict) throw NafathError.of(NAFATH_ERRORS.notFound);
      warnings.push(given ? `${name} "${given}" does not match the transaction's (${want})` : `No ${name} in the request`);
    }
    return { request, warnings, delayMs, fault: fault?.spec ?? null };
  }

  /** Credentials: strict answers 403, lax notes a warning. `undefined` (not passed) is not checked. */
  private checkCredentials(instance: NafathInstance, appId: string | null | undefined, appKey: string | null | undefined, warnings: string[]): void {
    if (appId === undefined && appKey === undefined) return;
    if (appId === instance.appId && appKey === instance.appKey) return;
    if (instance.strict) throw NafathError.of(NAFATH_ERRORS.invalidCredentials);
    warnings.push(appId !== instance.appId ? `APP-ID ${appId ? `"${appId}"` : '(missing)'} is not this instance's` : 'APP-KEY does not match the instance');
  }

  /** HTTP-level faults: throw for down / rate_limit / invalid_credentials / timeout; the delay of slow:<ms>. */
  private httpFault(f: NafathFault | null): number {
    if (!f) return 0;
    switch (f.kind) {
      case 'down':
        throw NafathError.of(NAFATH_ERRORS.down);
      case 'rate_limit':
        throw NafathError.of(NAFATH_ERRORS.rateLimit);
      case 'invalid_credentials':
        throw NafathError.of(NAFATH_ERRORS.invalidCredentials);
      case 'timeout':
        throw new NafathError(504, 'timeout', 'Held by the timeout fault', true);
      case 'slow':
        return f.arg ?? 0;
      default:
        return 0;
    }
  }

  /** WAITING until statusLagMs after the decision (on the auth clock). */
  private visibleStatus(instance: NafathInstance, r: NafathRequest): NafathStatus {
    const lag = instance.config.statusLagMs;
    if (r.status === 'WAITING' || !lag || !r.decidedAt) return r.status;
    return this.nowMs(r.projectId, r.runId) < Date.parse(r.decidedAt) + lag ? 'WAITING' : r.status;
  }

  /** Lazy expiry: a WAITING request past expires_at (auth clock) becomes EXPIRED, is saved and published. */
  refresh(r: NafathRequest): NafathRequest {
    if (r.status !== 'WAITING' || this.nowMs(r.projectId, r.runId) < Date.parse(r.expiresAt)) return r;
    return this.finish(r, { status: 'EXPIRED', reason: 'expired', decidedBy: 'expiry', decidedAt: r.expiresAt, chosen: null, token: null });
  }

  // ------------------------------------------------------------------ decisions (the "Nafath app")

  /** The person taps a number: the right one approves, a wrong one rejects with reason wrong_number. */
  choose(request: NafathRequest, number: unknown, decidedBy = 'person'): NafathRequest {
    const n = String(number ?? '').trim();
    if (!/^\d{1,3}$/.test(n)) throw new HttpError(400, 'number must be the 2-digit number shown in the app');
    const r = this.requireWaiting(request);
    return this.decide(r, n === r.random ? 'approve' : 'wrong_number', decidedBy, n);
  }

  approve(request: NafathRequest, decidedBy = 'person'): NafathRequest {
    return this.decide(this.requireWaiting(request), 'approve', decidedBy);
  }

  reject(request: NafathRequest, decidedBy = 'person'): NafathRequest {
    return this.decide(this.requireWaiting(request), 'reject', decidedBy);
  }

  /** Ends a WAITING request as EXPIRED now (autoDecision 'expire'). */
  expire(request: NafathRequest, decidedBy = 'auto'): NafathRequest {
    return this.decide(this.requireWaiting(request), 'expire', decidedBy);
  }

  private requireWaiting(request: NafathRequest): NafathRequest {
    const cur = this.repo.getRequest(request.id);
    if (!cur) throw new HttpError(404, `Nafath request "${request.id}" not found`);
    const r = this.refresh(cur);
    if (r.status !== 'WAITING') throw new HttpError(409, `Nafath request is already ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    return r;
  }

  private decide(r: NafathRequest, d: Decision, decidedBy: string, chosen?: string): NafathRequest {
    const instance = this.repo.getInstance(r.instanceId)!;
    const status: NafathStatus = d === 'approve' ? 'COMPLETED' : d === 'expire' ? 'EXPIRED' : 'REJECTED';
    const reason = d === 'approve' ? null : d === 'reject' ? 'rejected' : d === 'wrong_number' ? 'wrong_number' : 'expired';
    const nowMs = this.nowMs(r.projectId, r.runId);
    let token: string | null = null;
    if (status !== 'EXPIRED') {
      const user = r.testUserId ? this.users.get(r.projectId, r.testUserId) : null;
      const f = this.pickFault('decide', this.ctxOf(r))?.fault ?? null;
      const payload = nafathClaims(user, r.nationalId, { ...r, status }, instance, { issuer: this.deps.issuer?.(instance), nowSec: Math.floor(nowMs / 1000) });
      token = signNafathToken(instance, payload, { fault: f?.kind === 'bad_signature' || f?.kind === 'unknown_kid' ? f.kind : null });
    }
    const pick = chosen ?? (d === 'approve' ? r.random : d === 'wrong_number' ? r.choices.find((c) => c !== r.random) ?? null : null);
    return this.finish(r, { status, reason, decidedBy, decidedAt: new Date(nowMs).toISOString(), chosen: pick, token });
  }

  private finish(r: NafathRequest, p: Pick<NafathRequest, 'status' | 'reason' | 'decidedBy' | 'decidedAt' | 'chosen' | 'token'>): NafathRequest {
    const next = this.repo.updateRequest(r.id, p);
    this.changed(next.projectId, { request: next.id, status: next.status, reason: next.reason, user: next.testUserId });
    this.pendingCallback(next);
    return next;
  }

  /** A decision fault matched at request time: decide at once, or (with a delay) leave it to scheduleDecision. */
  private applyDecisionFault(instance: NafathInstance, r: NafathRequest, picked: { fault: NafathFault; rule: NafathRule } | null): NafathRequest {
    const f = picked?.fault;
    const by = picked ? `rule:${picked.rule.id}` : 'auto';
    if (f?.kind === 'approve') return this.scheduleOrDecide(r, 'approve', by, f.arg ?? 0);
    if (f?.kind === 'rejected') return this.scheduleOrDecide(r, 'reject', by, f.arg ?? 0);
    if (f?.kind === 'wrong_number') return this.decide(r, 'wrong_number', by);
    if (f?.kind === 'expired') return this.decide(r, 'expire', by);
    const auto = instance.config.autoDecision;
    return auto === 'none' ? r : this.scheduleOrDecide(r, auto, 'auto', instance.config.autoDelayMs);
  }

  private scheduleOrDecide(r: NafathRequest, d: Decision, by: string, delayMs: number): NafathRequest {
    if (delayMs > 0) {
      this.scheduleDecision(r, d, delayMs, by);
      return r;
    }
    return this.decide(r, d, by);
  }

  /**
   * A decision later (instance autoDecision with autoDelayMs > 0, faults approve:<ms> / rejected:<ms>): delay 0
   * decides now, otherwise the allowlisted `nafath.decide` action is scheduled (it calls decideNow with `decidedBy`,
   * skipping requests no longer WAITING). Without an attached delivery (bare service) nothing is scheduled.
   */
  scheduleDecision(request: NafathRequest, decision: Decision, delayMs: number, decidedBy: string): void {
    if (delayMs <= 0) {
      this.decideNow(request, decision, decidedBy);
      return;
    }
    this.delivery?.scheduleDecision(request, decision, delayMs, decidedBy);
  }

  /** Decide a WAITING request now (409 otherwise): the `nafath.decide` schedule target. */
  decideNow(request: NafathRequest, decision: Decision, decidedBy: string): NafathRequest {
    return this.decide(this.requireWaiting(request), decision, decidedBy);
  }

  /**
   * Called after every terminal transition (COMPLETED, REJECTED, EXPIRED, lazy expiry included): the signed callback
   * goes to config.callbackUrl, EXPIRED only with config.callbackOnExpired. The delivery applies the callback-stage
   * faults (no_callback / duplicate_callback).
   */
  pendingCallback(request: NafathRequest): void {
    if (request.status === 'WAITING' || !this.delivery) return;
    const instance = this.repo.getInstance(request.instanceId);
    if (!instance?.config.callbackUrl) return;
    if (request.status === 'EXPIRED' && !instance.config.callbackOnExpired) return;
    this.delivery.callback(request);
  }

  /** The callback's token: the decision's, or (EXPIRED with callbackOnExpired) a fresh one without person claims. */
  callbackToken(instance: NafathInstance, r: NafathRequest): string {
    if (r.token) return r.token;
    const nowSec = Math.floor(this.nowMs(r.projectId, r.runId) / 1000);
    return signNafathToken(instance, nafathClaims(null, r.nationalId, r, instance, { issuer: this.deps.issuer?.(instance), nowSec }));
  }

  // ------------------------------------------------------------------ requests (control API)

  listRequests(projectId: string, f: RequestFilter = {}): NafathRequest[] {
    return this.repo.listRequests(projectId, f).map((r) => this.refresh(r));
  }

  /** By id or transId. */
  requireRequest(project: ProjectRef, ref: string): NafathRequest {
    const r = this.repo.getRequest(ref) ?? this.repo.requestByTransId(ref);
    if (!r || r.projectId !== project.id) throw new HttpError(404, `Nafath request "${ref}" not found`);
    return this.refresh(r);
  }

  /** The WAITING request of a test user, if any (the card / approve_nafath). */
  waitingFor(projectId: string, testUserId: string): NafathRequest | null {
    return this.listRequests(projectId, { testUserId, status: ['WAITING'], limit: 10 }).find((r) => r.status === 'WAITING') ?? null;
  }

  /** Reset: requests of a user and / or a run (or the whole project) go. */
  resetRequests(project: ProjectRef, f: { testUserId?: string; runId?: string } = {}): number {
    const n = this.repo.deleteRequests(project.id, f);
    this.changed(project.id, { cleared: n });
    return n;
  }

  // ------------------------------------------------------------------ faults

  listFaults(projectId: string, runId?: string | null): NafathRule[] {
    return this.repo.listRules(projectId, { runId });
  }

  /** Add a fault rule ({fault, instance?, user?, nationalId?, service?, times?}); fault "none" clears the matching rules instead (null). */
  addFault(project: ProjectRef, input: J, runId: string | null = null): NafathRule | null {
    const f = parseFault(input.fault);
    const user = input.user ? this.users.requireRef(project.id, String(input.user), runId) : null;
    if (f.kind === 'none') {
      this.clearFaults(project, { runId, testUserId: user?.id });
      return null;
    }
    const inst = input.instance ? this.requireInstance(project, String(input.instance)) : null;
    const match: NafathRule['match'] = {};
    if (user) match.user = user.id;
    if (input.nationalId) match.nationalId = String(input.nationalId).trim();
    if (input.service) match.service = String(input.service);
    let remaining: number | null = null;
    if (input.times !== undefined && input.times !== null && input.times !== '') {
      remaining = Number(input.times);
      if (!Number.isInteger(remaining) || remaining < 1) throw new HttpError(400, 'times must be a whole number ≥ 1 (leave out for every request)');
    }
    const rule = this.repo.insertRule({ projectId: project.id, runId, instanceId: inst?.id ?? null, match, fault: f.spec, remaining });
    this.changed(project.id, { rule: rule.id });
    return rule;
  }

  clearFaults(project: ProjectRef, f: { runId?: string | null; testUserId?: string } = {}): number {
    const n = this.repo.deleteRules(project.id, f);
    this.changed(project.id, { rulesCleared: n });
    return n;
  }

  deleteFault(project: ProjectRef, id: string): void {
    const r = this.repo.getRule(id);
    if (!r || r.projectId !== project.id) throw new HttpError(404, `Nafath fault rule "${id}" not found`);
    this.repo.deleteRule(id);
    this.changed(project.id, { rule: id, deleted: true });
  }

  /** The first matching rule whose fault acts at this stage: run rules first, then project rules; consumes one use. */
  pickFault(stage: FaultStage, ctx: NafathFaultContext): { fault: NafathFault; rule: NafathRule } | null {
    const rules = this.repo.listRules(ctx.projectId).filter((r) => r.remaining !== 0 && (!r.runId || r.runId === ctx.runId));
    rules.sort((a, b) => Number(!a.runId) - Number(!b.runId));
    for (const r of rules) {
      if (r.instanceId && r.instanceId !== ctx.instanceId) continue;
      if (r.match.user && r.match.user !== ctx.userId) continue;
      if (r.match.nationalId && r.match.nationalId !== ctx.nationalId) continue;
      if (r.match.service && r.match.service !== ctx.service) continue;
      let fault: NafathFault;
      try {
        fault = parseFault(r.fault);
      } catch {
        continue;
      }
      if (!appliesTo(fault, stage)) continue;
      this.repo.hitRule(r.id);
      this.changed(ctx.projectId, { rule: r.id, hit: true });
      return { fault, rule: r };
    }
    return null;
  }

  ctxOf(r: NafathRequest): NafathFaultContext {
    return { projectId: r.projectId, instanceId: r.instanceId, runId: r.runId, userId: r.testUserId, nationalId: r.nationalId, service: r.service };
  }

  // ------------------------------------------------------------------ runs, reset, retention

  purgeRun(runId: string): void {
    this.repo.purgeRun(runId);
  }

  /** Project reset: requests go, rule hits → 0; instances and keys stay. */
  resetProject(projectId: string): void {
    this.repo.resetProject(projectId);
    this.changed(projectId, { reset: true });
  }

  purgeOlderThan(projectId: string, cutoffIso: string): number {
    return this.repo.deleteOlderThan(projectId, cutoffIso);
  }

  /** The user a request belongs to (null: unassigned). */
  userOf(r: NafathRequest): TestUser | null {
    return r.testUserId ? this.users.get(r.projectId, r.testUserId) : null;
  }
}

/** The right number plus two distinct decoys (10-99), shuffled. */
function choicesFor(random: string): string[] {
  const set = new Set([random]);
  while (set.size < 3) set.add(String(crypto.randomInt(10, 100)));
  const list = [...set];
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

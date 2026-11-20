import crypto from 'node:crypto';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import { apnsReasonFor } from './faults.js';
import { checkProviderToken } from './jwt.js';
import { pushFinding } from './lint.js';
import { APNS_PUSH_TYPES, APNS_REASONS, LIMITS, type ApnsConfig, type PushDevice, type PushInstance, type PushLintFinding, type PushNotification } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
/** apns-expiration above this (UNIX seconds, year 5138) is out of Date range. */
const MAX_EXPIRATION_SEC = 1e11;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApnsRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  transport: 'h2' | 'h2c' | 'http1';
  /** Connection identity for the token-churn check (the HTTP/2 session). */
  connection?: object;
  logId: string | null;
  /** Project / instance already known (path prefix on the HTTP/1.1 port). */
  project?: Project | null;
  instance?: PushInstance | null;
  /** Explicit run (X-Hub-Run header or /run/<key> prefix, already resolved). */
  run?: Run | null;
  /** A run key not resolved yet (HTTP/2 listener without a project prefix): resolved in the project the request is for. */
  runKey?: string | null;
}

export interface ApnsResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  /** Fault timeout: hold the stream, then reset it. */
  hold?: boolean;
  delayMs?: number;
  projectId: string | null;
  runId: string | null;
  resolved: J;
}

const one = (h: ApnsRequest['headers'], k: string): string | undefined => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Which project / instance an APNs request is for. A real client has no path prefix, so: 1. /push/<project>/<instance>
 * prefix, 2. JWT kid + iss of exactly one APNs instance, 3. the device token in push_devices, 4. the only APNs instance.
 */
export function resolveApnsTarget(hub: Hub, req: ApnsRequest, token: string): { project: Project; instance: PushInstance; via: string } | { error: string } {
  if (req.project && req.instance) return { project: req.project, instance: req.instance, via: 'path' };
  const all = hub.push.repo.allInstances('apns').filter((i) => i.enabled);
  const auth = /^bearer\s+(.+)$/i.exec(one(req.headers, 'authorization') ?? '');
  if (auth) {
    try {
      const [h, p] = auth[1].split('.');
      const kid = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')).kid;
      const iss = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).iss;
      const hits = all.filter((i) => (i.config as ApnsConfig).keyId === kid && (i.config as ApnsConfig).teamId === iss);
      if (hits.length === 1) {
        const project = hub.projects.get(hits[0].projectId);
        if (project) return { project, instance: hits[0], via: 'jwt' };
      }
    } catch {
      /* not a JWT: next rule */
    }
  }
  if (token) {
    const devs = hub.push.repo.devicesByToken(token);
    if (devs.length === 1) {
      const d = devs[0];
      const inst = (d.instanceId && all.find((i) => i.id === d.instanceId)) || (all.filter((i) => i.projectId === d.projectId).length === 1 ? all.find((i) => i.projectId === d.projectId) : undefined);
      const project = hub.projects.get(d.projectId);
      if (inst && project) return { project, instance: inst, via: 'device' };
    }
  }
  if (all.length === 1) {
    const project = hub.projects.get(all[0].projectId);
    if (project) return { project, instance: all[0], via: 'only-instance' };
  }
  return {
    error: all.length
      ? 'Could not tell which stubyard APNs instance this request is for: the token kid/iss matches none (or several), the device token is unknown, and there are several APNs instances. Use the /push/<project>/<instance>/3/device/<token> prefix or the instance key.'
      : 'This stubyard has no APNs instance: add one under Providers → Push.',
  };
}

/** One APNs provider API request (HTTP/2 listener or the HTTP/1.1 /push/<p>/<i>/3/device/<token> route). */
export function handleApns(hub: Hub, req: ApnsRequest): ApnsResult {
  const apnsId = (one(req.headers, 'apns-id') ?? '').toLowerCase();
  const id = UUID_RE.test(apnsId) ? apnsId : crypto.randomUUID();
  const resolved: J = { kind: 'push', provider: 'apns', transport: req.transport === 'http1' ? 'http1 (not real APNs transport)' : req.transport };
  const warnings: string[] = [];
  const lint: PushLintFinding[] = [];
  let projectId: string | null = req.project?.id ?? null;
  let runId: string | null = req.run?.id ?? null;
  const fail = (reason: string, extra: { timestamp?: number; stubyardReason?: string } = {}): ApnsResult => {
    const status = APNS_REASONS[reason]?.status ?? 400;
    const body: J = { reason };
    if (status === 410) body.timestamp = extra.timestamp ?? Date.now();
    const headers: Record<string, string> = { 'apns-id': id, 'content-type': 'application/json' };
    if (extra.stubyardReason) headers['x-stubyard-reason'] = extra.stubyardReason;
    return { status, headers, body: JSON.stringify(body), projectId, runId, resolved: { ...resolved, status: 'rejected', errorCode: reason, auth: { ...(resolved.auth as J), warnings } } };
  };

  if (req.method !== 'POST') return fail('MethodNotAllowed');
  const m = /^\/3\/device(?:\/([^/?]*))?\/?$/.exec(req.path.split('?')[0]);
  if (!m) return fail('BadPath');
  let token: string;
  try {
    token = decodeURIComponent(m[1] ?? '');
  } catch {
    return fail('BadDeviceToken');
  }
  if (!token) return fail('MissingDeviceToken');
  // Duplicate headers (HTTP/2 delivers them as arrays).
  for (const k of ['apns-topic', 'apns-push-type', 'apns-id', 'apns-priority', 'apns-expiration', 'apns-collapse-id', 'authorization']) if (Array.isArray(req.headers[k])) return fail('DuplicateHeaders');

  const target = resolveApnsTarget(hub, req, token);
  if ('error' in target) return fail('InvalidProviderToken', { stubyardReason: target.error });
  const { project, instance: inst } = target;
  projectId = project.id;
  resolved.project = project.slug;
  resolved.instance = inst.slug;
  resolved.resolvedBy = target.via;
  if (req.logId) hub.traffic.update(req.logId, { projectId: project.id });
  if (req.runKey && !req.run) {
    const run = hub.runs.resolver.explicit(project.id, req.runKey);
    if (!run) return fail('BadPath', { stubyardReason: `Unknown run "${req.runKey}" in project ${project.slug} (unknown, stopped or expired)` });
    req = { ...req, run, runKey: null };
    runId = run.id;
  }
  const c = inst.config as ApnsConfig;
  if (c.environment === 'production') lint.push(pushFinding('push.production-env-in-test'));

  // --- provider token
  const authz = one(req.headers, 'authorization');
  const bearer = /^bearer\s+(.+)$/i.exec(authz ?? '')?.[1]?.trim() ?? null;
  resolved.auth = { verified: false, warnings };
  if (!bearer) {
    if (inst.strict) return fail('MissingProviderToken');
    warnings.push('lax: no authorization header, certificate auth assumed (mTLS provider certificates are not simulated)');
  } else {
    const chk = checkProviderToken(bearer, { publicKeyPem: c.publicKeyPem, keyId: c.keyId, teamId: c.teamId });
    resolved.auth = { verified: chk.verified && !chk.reason, warnings };
    if (chk.reason) {
      if (chk.reason === 'ExpiredProviderToken' || inst.strict || !chk.parts) return fail(chk.reason);
      warnings.push(...chk.problems.map((p) => `lax: ${p.message}`));
    }
    // Token churn: a new token for the same connection (or instance) within 20 minutes.
    const now = Date.now();
    const seen = req.connection ? hub.push.apnsTokenSeen.get(req.connection) : hub.push.apnsTokenSeenByInstance.get(inst.id);
    if (seen && seen.token !== bearer && now - seen.firstSeen < LIMITS.apnsTokenMinRefreshSec * 1000) {
      lint.push(pushFinding('push.apns-token-churn', `new provider token after ${Math.round((now - seen.firstSeen) / 1000)} s`));
      if (inst.strict) return fail('TooManyProviderTokenUpdates');
    }
    if (!seen || seen.token !== bearer) {
      const entry = { token: bearer, firstSeen: now };
      if (req.connection) hub.push.apnsTokenSeen.set(req.connection, entry);
      else hub.push.apnsTokenSeenByInstance.set(inst.id, entry);
    }
  }

  // --- headers
  if (one(req.headers, 'apns-id') !== undefined && !UUID_RE.test(apnsId)) return fail('BadMessageId');
  const pushTypeH = one(req.headers, 'apns-push-type');
  if (pushTypeH !== undefined && !(pushTypeH in APNS_PUSH_TYPES)) return fail('InvalidPushType');
  const prioH = one(req.headers, 'apns-priority');
  if (prioH !== undefined && !['10', '5', '1'].includes(prioH)) return fail('BadPriority');
  const expH = one(req.headers, 'apns-expiration');
  // Out of Date range (≥ year 5138) would throw in toISOString: refused like any other bad value.
  if (expH !== undefined && (!/^\d+$/.test(expH) || Number(expH) > MAX_EXPIRATION_SEC)) return fail('BadExpirationDate');
  const collapse = one(req.headers, 'apns-collapse-id');
  if (collapse !== undefined && Buffer.byteLength(collapse) > LIMITS.apnsCollapseIdBytes) return fail('BadCollapseId');
  const topic = one(req.headers, 'apns-topic');
  if (!topic && bearer) return fail('MissingTopic');
  if (!/^[0-9a-fA-F]+$/.test(token)) return fail('BadDeviceToken');
  const base = topic ? baseBundle(topic) : null;
  if (base && c.bundleIds.length && !c.bundleIds.includes(base)) return fail('TopicDisallowed');

  // --- body
  if (!req.body.length) return fail('PayloadEmpty');
  const limit = pushTypeH === 'voip' ? LIMITS.apnsVoipPayloadBytes : LIMITS.apnsPayloadBytes;
  if (req.body.length > limit) return fail('PayloadTooLarge');
  let payload: J;
  try {
    const v = JSON.parse(req.body.toString('utf8'));
    if (!isObj(v)) return fail('PayloadEmpty');
    payload = v;
  } catch {
    return fail('PayloadEmpty', { stubyardReason: 'The body is not a JSON object' });
  }
  const aps = (isObj(payload.aps) ? payload.aps : {}) as J;
  const alert = aps.alert;
  const title = typeof alert === 'string' ? null : isObj(alert) ? strOrNull(alert.title) : null;
  const body = typeof alert === 'string' ? alert : isObj(alert) ? strOrNull(alert.body) : null;
  const contentAvailable = Number(aps['content-available']) === 1;
  const pushType = pushTypeH ?? (contentAvailable && !title && !body ? 'background' : 'alert');
  if (!pushTypeH) lint.push(pushFinding('push.apns-missing-push-type', `assumed ${pushType}`));
  const prio = prioH ?? (pushType === 'background' ? '5' : '10');
  if (pushType === 'background' && (prio !== '5' || !contentAvailable)) {
    lint.push(pushFinding('push.apns-background-priority', `priority ${prio}, content-available ${contentAvailable ? 1 : 0}`));
    if (inst.strict) return fail('BadPriority');
  }
  const suffix = APNS_PUSH_TYPES[pushType] ?? '';
  if (topic && suffix && !topic.endsWith(suffix)) lint.push(pushFinding('push.apns-topic-mismatch', `${pushType} pushes need the topic <bundle id>${suffix}`));
  if (topic && !suffix && topic !== base) lint.push(pushFinding('push.apns-topic-mismatch', `${pushType} pushes go to the bare bundle id`));
  if (req.body.length > LIMITS.nearLimitBytes) lint.push(pushFinding('push.payload-near-limit', `${req.body.length} bytes`));
  const data: J = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'aps'));
  if (!title && !body && !Object.keys(data).length && !contentAvailable) lint.push(pushFinding('push.no-title-or-data'));

  // --- device
  let device: PushDevice | null = hub.push.repo.deviceByToken(project.id, token);
  if (!req.run && device?.runId) runId = hub.runs.resolver.activeById(device.runId)?.id ?? null;
  if (runId && req.logId) {
    const run = hub.runs.repo.get(runId);
    hub.traffic.update(req.logId, { runId });
    hub.traffic.mergeResolved(req.logId, { run: run?.key, runVia: req.run ? 'header' : 'user' });
  }
  const pick = hub.push.pickFault({ projectId: project.id, instanceId: inst.id, runId, token, userId: device?.testUserId ?? null, header: one(req.headers, 'x-hub-scenario') ?? null });
  const headersStored = Object.fromEntries(
    Object.entries(req.headers)
      .filter(([k]) => k.startsWith('apns-') || k === ':path')
      .map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v)]),
  );
  const store = (status: PushNotification['status'], errorCode: string | null) =>
    hub.push.record({
      projectId: project.id,
      instanceId: inst.id,
      deviceId: device?.id ?? null,
      testUserId: device?.testUserId ?? null,
      runId,
      logId: req.logId,
      groupId: null,
      provider: 'apns',
      targetKind: 'token',
      target: token,
      title,
      body,
      image: null,
      data,
      badge: aps.badge === undefined || aps.badge === null ? null : Number(aps.badge),
      sound: typeof aps.sound === 'string' ? aps.sound : isObj(aps.sound) ? strOrNull(aps.sound.name) : null,
      category: strOrNull(aps.category),
      threadId: strOrNull(aps['thread-id']),
      collapseKey: collapse ?? null,
      priority: prio,
      pushType,
      silent: !title && !body,
      expiresAt: expH && expH !== '0' ? new Date(Number(expH) * 1000).toISOString() : null,
      status,
      errorCode,
      providerMessageId: id,
      headers: headersStored,
      raw: payload,
      lint,
    });
  if (pick) {
    resolved.fault = pick.fault.spec;
    if (pick.fault.kind === 'timeout') return { status: 0, headers: {}, body: null, hold: true, projectId, runId, resolved };
    const reason = apnsReasonFor(pick.fault);
    if (reason) {
      const row = store('rejected', reason);
      resolved.notification = row.id;
      return fail(reason);
    }
  }
  if (!device) {
    if (c.unknownTokens === 'reject') return fail('BadDeviceToken');
    device = hub.push.autoDevice(project.id, inst, token, 'ios', req.run?.id ?? null, base);
    lint.push(pushFinding('push.unknown-token'));
  } else {
    if (device.state === 'unregistered') {
      const row = store('rejected', 'Unregistered');
      resolved.notification = row.id;
      return fail('Unregistered', { timestamp: device.unregisteredAt ? Date.parse(device.unregisteredAt) : Date.now() });
    }
    if (base && device.appId && device.appId !== base) {
      const row = store('rejected', 'DeviceTokenNotForTopic');
      resolved.notification = row.id;
      return fail('DeviceTokenNotForTopic');
    }
  }
  const expired = !!expH && expH !== '0' && Number(expH) * 1000 < Date.now();
  const row = store(pick?.fault.kind === 'drop' ? 'dropped' : expired ? 'dropped' : 'delivered', expired ? 'expired' : null);
  const headers: Record<string, string> = { 'apns-id': id };
  if (c.environment === 'sandbox') headers['apns-unique-id'] = crypto.randomUUID();
  return {
    status: 200,
    headers,
    body: null,
    delayMs: pick?.fault.kind === 'slow' ? (pick.fault.arg ?? 0) : undefined,
    projectId,
    runId,
    resolved: { ...resolved, status: row.status, notification: row.id, device: device.id, user: device.testUserId, errorCode: null },
  };
}

/** apns-topic without the push-type suffix (com.acme.app.voip → com.acme.app). */
export function baseBundle(topic: string): string {
  for (const s of Object.values(APNS_PUSH_TYPES).filter(Boolean).sort((a, b) => b.length - a.length)) if (topic.endsWith(s)) return topic.slice(0, -s.length);
  return topic;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

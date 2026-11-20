import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { tagLog } from '../runs/resolver.js';
import { fcmErrorFor, type PushFault } from './faults.js';
import { checkAssertion, FCM_SCOPES } from './jwt.js';
import { pushFinding } from './lint.js';
import { TOPIC_RE } from './service.js';
import { FCM_ERRORS, LIMITS, type FcmConfig, type PushDevice, type PushInstance, type PushLintFinding, type PushNotification, type PushPlatform } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), o);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);

const MESSAGE_FIELDS = ['name', 'data', 'notification', 'android', 'webpush', 'apns', 'fcm_options', 'token', 'topic', 'condition'];
const UNAUTH_MESSAGE =
  'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.';
const TOKEN_RE = /^[A-Za-z0-9_\-:.]{20,4096}$/;

interface FcmErr {
  status: number;
  body: J;
  headers?: Record<string, string>;
  code: string;
}

/** FCM v1 error body: {error: {code, message, status, details: [FcmError, BadRequest?]}}. */
export function fcmError(code: string, message: string, o: { field?: string; retryAfter?: number; noFcmDetail?: boolean } = {}): FcmErr {
  const e = FCM_ERRORS[code] ?? FCM_ERRORS.INTERNAL;
  const details: J[] = [];
  if (!o.noFcmDetail) details.push({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code });
  if (o.field) details.push({ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: o.field, description: message }] });
  if (code === 'QUOTA_EXCEEDED') details.push({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ subject: 'messages', description: 'Sending rate exceeded for this target' }] });
  return { status: e.http, code, body: { error: { code: e.http, message, status: e.status, ...(details.length ? { details } : {}) } }, headers: o.retryAfter !== undefined ? { 'retry-after': String(o.retryAfter) } : undefined };
}

const unauthenticated = (): FcmErr => ({ status: 401, code: 'UNAUTHENTICATED', body: { error: { code: 401, message: UNAUTH_MESSAGE, status: 'UNAUTHENTICATED' } } });

const messageId = () => `0:${Date.now()}${crypto.randomInt(100000, 999999)}%${crypto.randomBytes(8).toString('hex')}`;
const bearerOf = (req: FastifyRequest) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? '').trim());
  return m ? m[1].trim() : null;
};

/** FCM condition: "'a' in topics && ('b' in topics || !('c' in topics))" → evaluator; null on a syntax error. */
export function parseCondition(src: string): { topics: string[]; test: (subscribed: Set<string>) => boolean } | null {
  const tokens: string[] = [];
  const re = /\s*(?:(&&|\|\||!|\(|\))|'([^']*)'\s+in\s+topics|"([^"]*)"\s+in\s+topics)/y;
  let pos = 0;
  const s = src.trim();
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return null;
    tokens.push(m[1] ?? `T:${m[2] ?? m[3]}`);
    pos = re.lastIndex;
    while (pos < s.length && s[pos] === ' ') pos++;
  }
  const topics: string[] = [];
  let i = 0;
  type Node = (set: Set<string>) => boolean;
  const primary = (): Node | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === '!') {
      const inner = primary();
      return inner ? (set) => !inner(set) : null;
    }
    if (t === '(') {
      const e = or();
      if (!e || tokens[i++] !== ')') return null;
      return e;
    }
    if (t.startsWith('T:')) {
      const name = t.slice(2);
      if (!TOPIC_RE.test(name)) return null;
      topics.push(name);
      return (set) => set.has(name);
    }
    return null;
  };
  const and = (): Node | null => {
    let left = primary();
    while (left && tokens[i] === '&&') {
      i++;
      const right = primary();
      if (!right) return null;
      const l = left;
      left = (set) => l(set) && right(set);
    }
    return left;
  };
  const or = (): Node | null => {
    let left = and();
    while (left && tokens[i] === '||') {
      i++;
      const right = and();
      if (!right) return null;
      const l = left;
      left = (set) => l(set) || right(set);
    }
    return left;
  };
  const root = or();
  if (!root || i !== tokens.length) return null;
  return { topics: [...new Set(topics)], test: root };
}

/** Everything of one FCM request that does not depend on the device. */
interface Parsed {
  msg: J;
  validateOnly: boolean;
  target: { kind: 'token' | 'topic' | 'condition'; value: string };
  condition?: ReturnType<typeof parseCondition>;
  size: number;
}

function validate(body: unknown, bodyError: string | undefined): Parsed | FcmErr {
  if (bodyError) return fcmError('INVALID_ARGUMENT', `Invalid JSON payload received. ${bodyError}`, { noFcmDetail: true });
  if (!isObj(body)) return fcmError('INVALID_ARGUMENT', 'Invalid JSON payload received. Expected an object with a "message" field.', { noFcmDetail: true });
  for (const k of Object.keys(body)) if (k !== 'message' && k !== 'validate_only' && k !== 'validateOnly') return fcmError('INVALID_ARGUMENT', `Invalid JSON payload received. Unknown name "${k}": Cannot find field.`, { field: k, noFcmDetail: true });
  const msg = body.message;
  if (!isObj(msg)) return fcmError('INVALID_ARGUMENT', 'Request contains an invalid argument.', { field: 'message' });
  for (const k of Object.keys(msg)) if (!MESSAGE_FIELDS.includes(k)) return fcmError('INVALID_ARGUMENT', `Invalid JSON payload received. Unknown name "${k}" at 'message': Cannot find field.`, { field: `message.${k}`, noFcmDetail: true });
  const targets = (['token', 'topic', 'condition'] as const).filter((k) => msg[k] !== undefined && msg[k] !== null && msg[k] !== '');
  if (targets.length !== 1) return fcmError('INVALID_ARGUMENT', 'Request contains an invalid argument.', { field: 'message', ...{} });
  const checkData = (d: unknown, at: string): FcmErr | null => {
    if (d === undefined) return null;
    if (!isObj(d)) return fcmError('INVALID_ARGUMENT', `Invalid value at '${at}' (type.googleapis.com/google.firebase.fcm.v1.Message.DataEntry), ${JSON.stringify(d)}`, { field: at, noFcmDetail: true });
    const entries = Object.entries(d);
    for (let i = 0; i < entries.length; i++) {
      if (typeof entries[i][1] !== 'string') return fcmError('INVALID_ARGUMENT', `Invalid value at '${at}[${i}].value' (TYPE_STRING), ${JSON.stringify(entries[i][1])}`, { field: `${at}[${i}].value`, noFcmDetail: true });
    }
    return null;
  };
  const dataErr = checkData(msg.data, 'message.data') ?? checkData(get(msg, 'android', 'data'), 'message.android.data') ?? checkData(get(msg, 'webpush', 'data'), 'message.webpush.data');
  if (dataErr) return dataErr;
  const prio = get(msg, 'android', 'priority');
  if (prio !== undefined && prio !== 'NORMAL' && prio !== 'HIGH' && prio !== 'normal' && prio !== 'high')
    return fcmError('INVALID_ARGUMENT', `Invalid value at 'message.android.priority' (type.googleapis.com/google.firebase.fcm.v1.AndroidMessagePriority), ${JSON.stringify(prio)}`, { field: 'message.android.priority', noFcmDetail: true });
  const ttl = get(msg, 'android', 'ttl');
  // protobuf Duration: at most 315,576,000,000 s (beyond that the expiry date is out of range too).
  if (ttl !== undefined && !(typeof ttl === 'string' && /^\d+(\.\d{1,9})?s$/.test(ttl) && parseFloat(ttl) <= 315_576_000_000))
    return fcmError('INVALID_ARGUMENT', `Invalid value at 'message.android.ttl' (type.googleapis.com/google.protobuf.Duration), ${JSON.stringify(ttl)}`, { field: 'message.android.ttl', noFcmDetail: true });
  const apnsExp = get(msg, 'apns', 'headers', 'apns-expiration');
  if (apnsExp !== undefined && !(/^\d+$/.test(String(apnsExp)) && Number(apnsExp) <= 1e11))
    return fcmError('INVALID_ARGUMENT', `Invalid value at 'message.apns.headers[apns-expiration]': ${JSON.stringify(apnsExp)} is not a UNIX time in seconds`, { field: 'message.apns.headers', noFcmDetail: true });
  const kind = targets[0];
  const value = String(msg[kind]);
  const size = Buffer.byteLength(JSON.stringify({ ...msg, token: undefined, topic: undefined, condition: undefined }));
  const parsed: Parsed = { msg, validateOnly: body.validate_only === true || body.validateOnly === true, target: { kind, value }, size };
  if (kind === 'token' && !TOKEN_RE.test(value)) return fcmError('INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token', { field: 'message.token' });
  if (kind === 'topic') {
    const t = value.replace(/^\/topics\//, '');
    if (!TOPIC_RE.test(t)) return fcmError('INVALID_ARGUMENT', 'Request contains an invalid argument.', { field: 'message.topic' });
    parsed.target.value = t;
  }
  if (kind === 'condition') {
    const c = parseCondition(value);
    if (!c) return fcmError('INVALID_ARGUMENT', 'Invalid condition expression provided.', { field: 'message.condition' });
    if (c.topics.length > LIMITS.fcmConditionTopics) return fcmError('INVALID_ARGUMENT', `Invalid condition: at most ${LIMITS.fcmConditionTopics} topics.`, { field: 'message.condition' });
    parsed.condition = c;
  }
  const limit = kind === 'token' ? LIMITS.fcmPayloadBytes : LIMITS.fcmPayloadBytes / 2;
  if (size > limit) return fcmError('INVALID_ARGUMENT', `Message is too big (${size} bytes; the limit is ${limit}${kind === 'token' ? '' : ' for topic messages'}).`, { field: 'message' });
  return parsed;
}

function platformOf(msg: J): PushPlatform {
  if (msg.android) return 'android';
  if (msg.apns && !msg.webpush) return 'ios';
  if (msg.webpush) return 'web';
  return 'android';
}

/** The notification as this device would show it (platform overrides win over message.notification). */
function render(msg: J, platform: PushPlatform) {
  const n = (isObj(msg.notification) ? msg.notification : {}) as J;
  const an = (get(msg, 'android', 'notification') ?? {}) as J;
  const aps = (get(msg, 'apns', 'payload', 'aps') ?? {}) as J;
  const alert = aps.alert;
  const wn = (get(msg, 'webpush', 'notification') ?? {}) as J;
  const apnsHeaders = (get(msg, 'apns', 'headers') ?? {}) as J;
  const webHeaders = (get(msg, 'webpush', 'headers') ?? {}) as J;
  const pick = (...v: unknown[]) => v.map(str).find((x) => x !== null) ?? null;
  const title =
    platform === 'android' ? pick(an.title, n.title) : platform === 'ios' ? pick(isObj(alert) ? alert.title : null, n.title) : pick(wn.title, n.title);
  const body = platform === 'android' ? pick(an.body, n.body) : platform === 'ios' ? pick(isObj(alert) ? alert.body : alert, n.body) : pick(wn.body, n.body);
  const image = pick(platform === 'android' ? an.image : platform === 'ios' ? get(msg, 'apns', 'fcm_options', 'image') : wn.image, n.image);
  const data: J = { ...(isObj(msg.data) ? msg.data : {}), ...(platform === 'android' && isObj(get(msg, 'android', 'data')) ? (get(msg, 'android', 'data') as J) : {}), ...(platform === 'web' && isObj(get(msg, 'webpush', 'data')) ? (get(msg, 'webpush', 'data') as J) : {}) };
  const badgeRaw = platform === 'ios' ? aps.badge : platform === 'android' ? an.notification_count : undefined;
  const sound = pick(platform === 'ios' ? (isObj(aps.sound) ? aps.sound.name : aps.sound) : platform === 'android' ? an.sound : null);
  const collapseKey = pick(platform === 'android' ? get(msg, 'android', 'collapse_key') : platform === 'ios' ? apnsHeaders['apns-collapse-id'] : webHeaders.Topic ?? webHeaders.topic);
  const priority = pick(platform === 'android' ? get(msg, 'android', 'priority') : platform === 'ios' ? apnsHeaders['apns-priority'] : webHeaders.Urgency ?? webHeaders.urgency);
  let expiresAt: string | null = null;
  let expired = false;
  if (platform === 'ios' && apnsHeaders['apns-expiration'] !== undefined) {
    const e = Number(apnsHeaders['apns-expiration']);
    if (e > 0 && e <= 1e11) {
      expiresAt = new Date(e * 1000).toISOString();
      expired = e * 1000 < Date.now();
    }
  }
  const ttl = get(msg, 'android', 'ttl');
  if (platform === 'android' && typeof ttl === 'string') expiresAt = new Date(Date.now() + parseFloat(ttl) * 1000).toISOString();
  const silent = !title && !body;
  return {
    title,
    body,
    image,
    data,
    badge: badgeRaw === undefined || badgeRaw === null ? null : Number(badgeRaw),
    sound,
    category: pick(platform === 'ios' ? aps.category : platform === 'android' ? an.click_action : null),
    threadId: pick(platform === 'ios' ? aps['thread-id'] : platform === 'android' ? an.tag : wn.tag),
    collapseKey,
    priority,
    pushType: platform === 'ios' ? pick(apnsHeaders['apns-push-type']) ?? (silent ? 'background' : 'alert') : silent ? 'data' : 'notification',
    silent,
    expiresAt,
    expired,
  };
}

interface SendCtx {
  hub: Hub;
  req: FastifyRequest;
  project: Project;
  inst: PushInstance;
  warnings: string[];
  lint: PushLintFinding[];
}

/** POST /token: the Google OAuth 2.0 JWT-bearer grant of a service account. */
export function fcmToken(hub: Hub, req: FastifyRequest, project: Project | null, inst: PushInstance | null, origin: string): { status: number; body: J; resolved: J } {
  const b = (isObj(req.body) ? req.body : {}) as J;
  // The assertion is a credential: keep it out of the traffic log body.
  if (req.rawBody && typeof b.assertion === 'string') req.rawBody = Buffer.from(req.rawBody.toString('utf8').replace(/(assertion=)[^&]+/, '$1[redacted]'));
  const grant = String(b.grant_type ?? '');
  if (grant !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return { status: 400, body: { error: 'unsupported_grant_type', error_description: `Invalid grant_type: ${grant}` }, resolved: {} };
  const assertion = String(b.assertion ?? '');
  // Host mode (oauth2.googleapis.com): find the instance by the assertion's iss.
  if (!inst) {
    const iss = String((() => {
      try {
        return JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8')).iss;
      } catch {
        return '';
      }
    })());
    const hits = hub.push.repo.allInstances('fcm').filter((i) => (i.config as FcmConfig).clientEmail === iss);
    if (hits.length !== 1) return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid email or User ID' }, resolved: { reason: hits.length ? 'several instances share this client_email' : 'no FCM instance has this client_email' } };
    inst = hits[0];
    project = hub.projects.get(inst.projectId);
    if (!project) return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid email or User ID' }, resolved: {} };
    origin = '';
  }
  const c = inst.config as FcmConfig;
  const chk = checkAssertion(assertion, { publicKeyPem: c.publicKeyPem, clientEmail: c.clientEmail, tokenUri: origin ? `/push/${project!.slug}/${inst.slug}/token` : 'https://oauth2.googleapis.com/token' });
  if (hub.config && req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project!.id });
  const resolved: J = { kind: 'push', provider: 'fcm', project: project!.slug, instance: inst.slug, step: 'token', auth: { verified: chk.verified, warnings: chk.problems.map((p) => p.message) } };
  if (!chk.parts) return { status: 400, body: { error: 'invalid_grant', error_description: chk.problems[0].message }, resolved };
  if (chk.problems.length && inst.strict) return { status: 400, body: { error: 'invalid_grant', error_description: chk.problems[0].message }, resolved };
  // The assertion is not verified in lax mode: keep what is stored per token small.
  const scopes = chk.scopes.slice(0, LIMITS.fcmTokenMaxScopes).map((s) => s.slice(0, 200));
  const scopeOk = scopes.some((s) => FCM_SCOPES.includes(s));
  const warnings = chk.problems.slice(0, 10).map((p) => `lax: ${p.message.slice(0, 300)}`);
  if (!scopeOk) warnings.push(`scope "${scopes.join(' ').slice(0, 300)}" does not include ${FCM_SCOPES[0]}: real FCM answers 403 for this token`);
  const token = hub.push.issueFcmToken(inst.id, scopes, warnings);
  (resolved.auth as J).warnings = warnings;
  return { status: 200, body: { access_token: token, expires_in: LIMITS.fcmAccessTokenSec, token_type: 'Bearer' }, resolved };
}

/** Bearer check shared by messages:send and the Instance ID API. */
function checkBearer(ctx: SendCtx): FcmErr | null {
  const raw = bearerOf(ctx.req);
  const t = ctx.hub.push.fcmToken(raw);
  if (!t) return unauthenticated();
  ctx.warnings.push(...t.warnings);
  if (t.instanceId !== ctx.inst.id) {
    if (ctx.inst.strict) return unauthenticated();
    ctx.warnings.push('lax: the access token was issued for another FCM instance');
  }
  if (!t.scopes.some((s) => FCM_SCOPES.includes(s)) && ctx.inst.strict) {
    return { status: 403, code: 'PERMISSION_DENIED', body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } } };
  }
  return null;
}

export interface FcmSendResult {
  status: number;
  body: J;
  headers?: Record<string, string>;
  /** Hold the request (fault timeout) or delay it (slow). */
  hold?: boolean;
  delayMs?: number;
  resolved: J;
}

/** POST /v1/projects/<id>/messages:send */
export function fcmSend(hub: Hub, req: FastifyRequest, project: Project, inst: PushInstance, pathProjectId: string): FcmSendResult {
  const ctx: SendCtx = { hub, req, project, inst, warnings: [], lint: [] };
  const c = inst.config as FcmConfig;
  const resolved: J = { kind: 'push', provider: 'fcm', project: project.slug, instance: inst.slug };
  const done = (r: Omit<FcmSendResult, 'resolved'>, extra: J = {}): FcmSendResult => ({ ...r, resolved: { ...resolved, ...extra, auth: { verified: !extra.authFailed, warnings: ctx.warnings } } });
  const authErr = checkBearer(ctx);
  if (authErr) return done({ status: authErr.status, body: authErr.body }, { status: 'rejected', errorCode: authErr.code, authFailed: true });
  if (pathProjectId !== c.fcmProjectId) {
    ctx.lint.push(pushFinding('push.fcm-sender-mismatch', `URL project "${pathProjectId}" ≠ service account project "${c.fcmProjectId}"`));
    if (inst.strict) {
      const e = fcmError('SENDER_ID_MISMATCH', 'SenderId mismatch');
      return done({ status: e.status, body: e.body }, { status: 'rejected', errorCode: e.code });
    }
    ctx.warnings.push(`lax: URL project "${pathProjectId}" is not ${c.fcmProjectId} (real FCM: 403 SENDER_ID_MISMATCH)`);
  }
  const p = validate(req.body, req.bodyError);
  if ('code' in p) return done({ status: p.status, body: p.body, headers: p.headers }, { status: 'rejected', errorCode: p.code });
  const run = req.hubRun ?? null;
  const scenario = String(req.headers['x-hub-scenario'] ?? '') || null;

  // ---- token
  if (p.target.kind === 'token') {
    let device = hub.push.repo.deviceByToken(project.id, p.target.value);
    const runId = run?.id ?? device?.runId ?? null;
    let pick: ReturnType<typeof hub.push.pickFault>;
    try {
      pick = hub.push.pickFault({ projectId: project.id, instanceId: inst.id, runId, token: p.target.value, userId: device?.testUserId ?? null, header: scenario });
    } catch (e) {
      const err = fcmError('INVALID_ARGUMENT', (e as Error).message);
      return done({ status: 400, body: err.body }, { status: 'rejected' });
    }
    const platform = device?.platform ?? platformOf(p.msg);
    const reject = (code: string, message: string, extra: { retryAfter?: number; field?: string } = {}) => {
      const e = fcmError(code, message, extra);
      const row = store(ctx, p, device, runId, 'rejected', code, platform);
      return done({ status: e.status, body: e.body, headers: e.headers }, { status: 'rejected', errorCode: code, notification: row.id, device: device?.id ?? null, fault: pick?.fault.spec });
    };
    if (pick) {
      const r = applyFault(pick.fault);
      if (r === 'hold') return done({ status: 0, body: {}, hold: true }, { fault: pick.fault.spec, faultSource: pick.source });
      if (r && 'code' in r) return reject(r.code, r.message, { retryAfter: r.retryAfter });
    }
    if (!device) {
      if (c.unknownTokens === 'reject') return reject('UNREGISTERED', 'Requested entity was not found.');
      if (!p.validateOnly) {
        device = hub.push.autoDevice(project.id, inst, p.target.value, platform, run?.id ?? null, str(get(p.msg, 'android', 'restricted_package_name')));
        ctx.lint.push(pushFinding('push.unknown-token'));
      }
    } else if (device.state === 'unregistered') return reject('UNREGISTERED', 'Requested entity was not found.');
    const status = p.validateOnly ? 'validated' : pick?.fault.kind === 'drop' ? 'dropped' : undefined;
    const row = store(ctx, p, device, runId, status, null, platform);
    if (req.trafficLogId && runId) tagLog(hub, req.trafficLogId, { run: hub.runs.repo.get(runId), via: run ? 'header' : 'user' });
    return done(
      { status: 200, body: { name: `projects/${c.fcmProjectId}/messages/${p.validateOnly ? 'fake_message_id' : row.providerMessageId}` }, delayMs: pick?.fault.kind === 'slow' ? (pick.fault.arg ?? 0) : undefined },
      { status: row.status, notification: row.id, device: device?.id ?? null, user: device?.testUserId ?? null, fault: pick?.fault.spec },
    );
  }

  // ---- topic / condition fan-out
  const topics = p.target.kind === 'topic' ? [p.target.value] : p.condition!.topics;
  let pick: ReturnType<typeof hub.push.pickFault>;
  try {
    pick = hub.push.pickFault({ projectId: project.id, instanceId: inst.id, runId: run?.id ?? null, topics, header: scenario });
  } catch (e) {
    const err = fcmError('INVALID_ARGUMENT', (e as Error).message);
    return done({ status: 400, body: err.body }, { status: 'rejected' });
  }
  if (pick) {
    const r = applyFault(pick.fault);
    if (r === 'hold') return done({ status: 0, body: {}, hold: true }, { fault: pick.fault.spec });
    if (r && 'code' in r) {
      const e = fcmError(r.code, r.message, { retryAfter: r.retryAfter });
      store(ctx, p, null, run?.id ?? null, 'rejected', r.code, 'android');
      return done({ status: e.status, body: e.body, headers: e.headers }, { status: 'rejected', errorCode: r.code, fault: pick.fault.spec });
    }
  }
  const devices = hub.push.repo
    .listDevices(project.id)
    .filter((d) => d.state === 'active' && (!d.instanceId || d.instanceId === inst.id) && (!run || !d.runId || d.runId === run.id))
    .filter((d) => (p.target.kind === 'topic' ? d.topics.includes(p.target.value) : p.condition!.test(new Set(d.topics))));
  const groupId = crypto.randomUUID();
  const mid = messageId();
  const status = p.validateOnly ? 'validated' : pick?.fault.kind === 'drop' ? 'dropped' : undefined;
  const rows: PushNotification[] = [];
  if (!devices.length || p.validateOnly) rows.push(store(ctx, p, null, run?.id ?? null, p.validateOnly ? 'validated' : 'no_subscribers', null, 'android', groupId, mid));
  else for (const d of devices) rows.push(store(ctx, p, d, run?.id ?? d.runId, status, null, d.platform, groupId, mid));
  return done(
    { status: 200, body: { name: `projects/${c.fcmProjectId}/messages/${p.validateOnly ? 'fake_message_id' : mid}` }, delayMs: pick?.fault.kind === 'slow' ? (pick.fault.arg ?? 0) : undefined },
    { status: rows[0]?.status, group: groupId, recipients: devices.length, fault: pick?.fault.spec },
  );
}

function applyFault(f: PushFault): 'hold' | { code: string; message: string; retryAfter?: number } | null {
  if (f.kind === 'timeout') return 'hold';
  return fcmErrorFor(f);
}

function store(ctx: SendCtx, p: Parsed, device: PushDevice | null, runId: string | null, status: PushNotification['status'] | undefined, errorCode: string | null, platform: PushPlatform, groupId: string | null = null, mid?: string): PushNotification {
  const r = render(p.msg, platform);
  const lint = [...ctx.lint];
  if (p.size > LIMITS.nearLimitBytes) lint.push(pushFinding('push.payload-near-limit', `${p.size} bytes`));
  if (r.silent && !Object.keys(r.data).length) lint.push(pushFinding('push.no-title-or-data'));
  const final = status ?? (r.expired ? 'dropped' : 'delivered');
  return ctx.hub.push.record({
    projectId: ctx.project.id,
    instanceId: ctx.inst.id,
    deviceId: device?.id ?? null,
    testUserId: device?.testUserId ?? null,
    runId,
    logId: ctx.req.trafficLogId ?? null,
    groupId,
    provider: 'fcm',
    targetKind: p.target.kind,
    target: p.target.value,
    title: r.title,
    body: r.body,
    image: r.image,
    data: r.data,
    badge: r.badge,
    sound: r.sound,
    category: r.category,
    threadId: r.threadId,
    collapseKey: r.collapseKey,
    priority: r.priority,
    pushType: r.pushType,
    silent: r.silent,
    expiresAt: r.expiresAt,
    status: final,
    errorCode: errorCode ?? (r.expired && !status ? 'expired' : null),
    providerMessageId: mid ?? messageId(),
    headers: {},
    raw: { message: p.msg, ...(p.validateOnly ? { validate_only: true } : {}) },
    lint,
  });
}

/** POST /iid/v1:batchAdd | :batchRemove (Instance ID server API topic management). */
export function iidBatch(hub: Hub, req: FastifyRequest, project: Project, inst: PushInstance, op: 'add' | 'remove'): { status: number; body: J; resolved: J } {
  const ctx: SendCtx = { hub, req, project, inst, warnings: [], lint: [] };
  const resolved: J = { kind: 'push', provider: 'fcm', project: project.slug, instance: inst.slug, step: `iid.${op}` };
  const authErr = checkBearer(ctx);
  if (authErr) return { status: 401, body: { error: 'Unauthorized' }, resolved: { ...resolved, auth: { verified: false, warnings: ctx.warnings } } };
  if (String(req.headers.access_token_auth ?? '') !== 'true') ctx.warnings.push('header access_token_auth: true is missing (the Instance ID API needs it with OAuth tokens)');
  const b = (isObj(req.body) ? req.body : {}) as J;
  const to = String(b.to ?? '');
  const tokens = Array.isArray(b.registration_tokens) ? b.registration_tokens.map(String) : null;
  const topic = to.replace(/^\/topics\//, '');
  if (!to.startsWith('/topics/') || !TOPIC_RE.test(topic)) return { status: 400, body: { error: 'InvalidParameters: "to" must be /topics/<name>' }, resolved };
  if (!tokens?.length) return { status: 400, body: { error: 'InvalidParameters: registration_tokens is required' }, resolved };
  if (tokens.length > LIMITS.iidBatchTokens) return { status: 400, body: { error: `InvalidParameters: at most ${LIMITS.iidBatchTokens} registration tokens per request` }, resolved };
  const c = inst.config as FcmConfig;
  const results = tokens.map((t) => {
    if (!TOKEN_RE.test(t)) return { error: 'INVALID_ARGUMENT' };
    let d = hub.push.repo.deviceByToken(project.id, t);
    if (!d && c.unknownTokens === 'accept' && op === 'add') d = hub.push.autoDevice(project.id, inst, t, 'android', req.hubRun?.id ?? null, null);
    if (!d || d.state === 'unregistered') return { error: 'NOT_FOUND' };
    const set = new Set(d.topics);
    if (op === 'add') set.add(topic);
    else set.delete(topic);
    hub.push.repo.updateDevice(d.id, { topics: [...set] });
    return {};
  });
  hub.push.changed(project.id, { topics: topic });
  return { status: 200, body: { results }, resolved: { ...resolved, topic, tokens: tokens.length, auth: { verified: true, warnings: ctx.warnings } } };
}

export const LEGACY_HINT =
  'The legacy FCM APIs (HTTP /fcm/send, XMPP) and the batch send endpoint (/batch) were deprecated in June 2023 and shut down by Google from July 2024. Use HTTP v1: POST /v1/projects/<project-id>/messages:send with an OAuth 2.0 access token (one request per message).';


import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import { HttpError, nowIso, trimEnd } from '../util.js';
import { parseFault, type PushFault } from './faults.js';
import { apnsDeviceToken, fcmRegistrationToken, p256KeyPair, publicPemOf, randomId, rsaKeyPair } from './jwt.js';
import { PushRepo, type NotificationFilter } from './repo.js';
import type { ApnsConfig, FcmConfig, PushDevice, PushInstance, PushNotification, PushPlatform, PushRule } from './types.js';
import { LIMITS } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const TOPIC_RE = /^[a-zA-Z0-9\-_.~%]{1,900}$/;
const PLATFORMS: PushPlatform[] = ['ios', 'android', 'web'];
export const EMPTY_CURSOR = '0';

export interface FcmAccessToken {
  instanceId: string;
  expiresAt: number;
  scopes: string[];
  warnings: string[];
}

/** Context a fault rule is matched against. */
export interface FaultContext {
  projectId: string;
  instanceId: string;
  runId: string | null;
  token?: string | null;
  userId?: string | null;
  topics?: string[];
  header?: string | null;
}

/** hub.push: fake FCM HTTP v1 and APNs instances, test devices, the notification inbox and fault rules. */
export class PushService {
  readonly repo: PushRepo;
  /** FCM OAuth access tokens issued by /token (memory only: a restart → 401, clients fetch a new one). */
  readonly fcmTokens = new Map<string, FcmAccessToken>();
  /** APNs provider tokens seen per connection (or per instance for HTTP/1.1): token churn lint / 429. */
  readonly apnsTokenSeen = new WeakMap<object, { token: string; firstSeen: number }>();
  readonly apnsTokenSeenByInstance = new Map<string, { token: string; firstSeen: number }>();
  private emitter = new EventEmitter();

  constructor(private hub: Hub) {
    this.repo = new PushRepo(hub.db);
    this.emitter.setMaxListeners(0);
  }

  // ------------------------------------------------------------------ instances

  listInstances(projectId: string): PushInstance[] {
    return this.repo.listInstances(projectId);
  }

  requireInstance(project: Project, ref: string): PushInstance {
    const i = this.repo.instanceBySlug(project.id, ref.toLowerCase()) ?? this.repo.getInstance(ref);
    if (!i || i.projectId !== project.id) throw new HttpError(404, `Push instance "${ref}" not found in project ${project.slug}`);
    return i;
  }

  private uniqueSlug(projectId: string, base: string): string {
    let s = base;
    for (let n = 2; this.repo.instanceBySlug(projectId, s); n++) s = `${base}-${n}`;
    return s;
  }

  createInstance(project: Project, input: J): PushInstance {
    const preset = String(input.preset ?? '').toLowerCase();
    if (preset !== 'fcm' && preset !== 'apns') throw new HttpError(400, 'preset must be "fcm" (Firebase Cloud Messaging HTTP v1) or "apns" (Apple Push Notification service)');
    let slug = input.slug ? String(input.slug).toLowerCase() : this.uniqueSlug(project.id, preset);
    if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug: lowercase letters, digits and dashes (max 48)');
    if (this.repo.instanceBySlug(project.id, slug)) throw new HttpError(409, `Push instance "${slug}" already exists`);
    const cfg = isObj(input.config) ? input.config : {};
    const config = preset === 'fcm' ? this.fcmConfig(project, cfg, null) : this.apnsConfig(cfg, null);
    const inst = this.repo.insertInstance({
      projectId: project.id,
      slug,
      name: input.name ? String(input.name).slice(0, 120) : preset === 'fcm' ? 'Firebase Cloud Messaging' : 'Apple Push (APNs)',
      preset,
      config,
      strict: input.strict === true,
      enabled: input.enabled !== false,
    });
    this.changed(project.id, { instance: inst.id });
    return inst;
  }

  private unknownTokens(v: unknown, prev: string | undefined): 'accept' | 'reject' {
    if (v === undefined || v === null || v === '') return (prev as 'accept' | 'reject') ?? 'accept';
    if (v !== 'accept' && v !== 'reject') throw new HttpError(400, 'unknownTokens must be "accept" or "reject"');
    return v;
  }

  private fcmConfig(project: Project, c: J, prev: FcmConfig | null): FcmConfig {
    const fcmProjectId = c.fcmProjectId !== undefined ? String(c.fcmProjectId).trim() : (prev?.fcmProjectId ?? `${project.slug}-stubyard`.slice(0, 30));
    if (!/^[a-z0-9-]{3,63}$/.test(fcmProjectId)) throw new HttpError(400, 'config.fcmProjectId: 3-63 lowercase letters, digits and dashes (the Firebase project id)');
    const keys = prev?.privateKeyPem ? { privateKeyPem: prev.privateKeyPem, publicKeyPem: prev.publicKeyPem } : rsaKeyPair();
    return {
      fcmProjectId,
      clientEmail: c.clientEmail ? String(c.clientEmail) : (prev?.clientEmail ?? `firebase-adminsdk-${randomId(5, 'abcdefghijklmnopqrstuvwxyz0123456789')}@${fcmProjectId}.iam.gserviceaccount.com`),
      clientId: prev?.clientId ?? randomId(21, '0123456789'),
      privateKeyId: prev?.privateKeyId ?? crypto.randomBytes(20).toString('hex'),
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
      unknownTokens: this.unknownTokens(c.unknownTokens, prev?.unknownTokens),
    };
  }

  private apnsConfig(c: J, prev: ApnsConfig | null): ApnsConfig {
    const ten = (v: unknown, name: string, fallback: string) => {
      if (v === undefined || v === null || v === '') return fallback;
      const s = String(v).trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(s)) throw new HttpError(400, `config.${name} must be 10 letters / digits (as in the Apple developer account)`);
      return s;
    };
    const bundleIds =
      c.bundleIds === undefined
        ? (prev?.bundleIds ?? [])
        : (Array.isArray(c.bundleIds) ? c.bundleIds : String(c.bundleIds ?? '').split(','))
            .map((s) => String(s).trim())
            .filter(Boolean);
    for (const b of bundleIds) if (!/^[A-Za-z0-9.-]+$/.test(b)) throw new HttpError(400, `config.bundleIds: "${b}" is not a bundle id`);
    const env = c.environment === undefined ? (prev?.environment ?? 'sandbox') : String(c.environment);
    if (env !== 'sandbox' && env !== 'production') throw new HttpError(400, 'config.environment must be "sandbox" or "production"');
    let keys = prev ? { privateKeyPem: prev.privateKeyPem, publicKeyPem: prev.publicKeyPem } : null;
    if (c.publicKeyPem) {
      try {
        keys = { privateKeyPem: null, publicKeyPem: publicPemOf(String(c.publicKeyPem)) };
      } catch (e) {
        throw new HttpError(400, `config.publicKeyPem: ${(e as Error).message}`);
      }
    }
    keys ??= p256KeyPair();
    return {
      teamId: ten(c.teamId, 'teamId', prev?.teamId ?? randomId(10)),
      keyId: ten(c.keyId, 'keyId', prev?.keyId ?? randomId(10)),
      bundleIds,
      environment: env,
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
      unknownTokens: this.unknownTokens(c.unknownTokens, prev?.unknownTokens),
    };
  }

  updateInstance(project: Project, ref: string, input: J): PushInstance {
    const cur = this.requireInstance(project, ref);
    const patch: Parameters<PushRepo['updateInstance']>[1] = {};
    if (input.name !== undefined) patch.name = String(input.name).slice(0, 120);
    if (input.slug !== undefined && input.slug !== cur.slug) {
      const s = String(input.slug).toLowerCase();
      if (!SLUG_RE.test(s)) throw new HttpError(400, 'slug: lowercase letters, digits and dashes (max 48)');
      if (this.repo.instanceBySlug(project.id, s)) throw new HttpError(409, `Push instance "${s}" already exists`);
      patch.slug = s;
    }
    if (input.strict !== undefined) patch.strict = input.strict === true;
    if (input.enabled !== undefined) patch.enabled = input.enabled !== false;
    if (isObj(input.config)) patch.config = cur.preset === 'fcm' ? this.fcmConfig(project, input.config, cur.config as FcmConfig) : this.apnsConfig(input.config, cur.config as ApnsConfig);
    const next = this.repo.updateInstance(cur.id, patch);
    this.changed(project.id, { instance: cur.id });
    return next;
  }

  rotateKey(project: Project, ref: string): PushInstance {
    const cur = this.requireInstance(project, ref);
    const config = { ...cur.config };
    if (cur.preset === 'fcm') Object.assign(config, rsaKeyPair(), { privateKeyId: crypto.randomBytes(20).toString('hex') });
    else Object.assign(config, p256KeyPair(), { keyId: randomId(10) });
    for (const [t, v] of this.fcmTokens) if (v.instanceId === cur.id) this.fcmTokens.delete(t);
    const next = this.repo.updateInstance(cur.id, { config });
    this.changed(project.id, { instance: cur.id, rotated: true });
    return next;
  }

  deleteInstance(project: Project, ref: string): void {
    const cur = this.requireInstance(project, ref);
    this.repo.deleteInstance(cur.id);
    this.changed(project.id, { instance: cur.id, deleted: true });
  }

  /** Instance as shown by the API: private keys are never included (download them on purpose). */
  viewInstance(i: PushInstance, origin?: string) {
    const { privateKeyPem: _k, ...config } = i.config as FcmConfig & ApnsConfig;
    const project = this.hub.projects.get?.(i.projectId) as Project | null | undefined;
    const devices = this.repo.listDevices(i.projectId, { instanceId: i.id }).length;
    return {
      ...i,
      config: { ...config, hasPrivateKey: !!_k },
      devices,
      urls: origin && project ? this.urls(project, i, origin) : undefined,
    };
  }

  /** Base URLs of an instance (FCM: token_uri + send; APNs: the HTTP/2 listener). */
  urls(project: Project, i: PushInstance, origin: string) {
    const o = trimEnd(origin, '/');
    const base = `${o}/push/${project.slug}/${i.slug}`;
    if (i.preset === 'fcm') {
      const c = i.config as FcmConfig;
      return { base, tokenUri: `${base}/token`, send: `${base}/v1/projects/${c.fcmProjectId}/messages:send`, iid: `${base}/iid/v1:batchAdd` };
    }
    const port = this.hub.config.apnsPort;
    const scheme = this.hub.tls ? 'https' : 'http';
    return {
      base,
      apns: port ? `${scheme}://localhost:${port}` : null,
      apnsPort: port || null,
      http2: port ? (this.hub.tls ? 'TLS (stubyard CA), HTTP/2 only' : 'h2c (cleartext HTTP/2, prior knowledge)') : 'disabled (STUBYARD_APNS_PORT=0)',
      http1: `${base}/3/device/<token>`,
    };
  }

  /** Firebase service-account JSON pointing token_uri at this instance. */
  serviceAccount(project: Project, i: PushInstance, origin: string): J {
    if (i.preset !== 'fcm') throw new HttpError(400, 'Only FCM instances have a service account');
    const c = i.config as FcmConfig;
    const urls = this.urls(project, i, origin) as { tokenUri: string };
    const enc = encodeURIComponent(c.clientEmail);
    return {
      type: 'service_account',
      project_id: c.fcmProjectId,
      private_key_id: c.privateKeyId,
      private_key: c.privateKeyPem,
      client_email: c.clientEmail,
      client_id: c.clientId,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: urls.tokenUri,
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${enc}`,
      universe_domain: 'googleapis.com',
    };
  }

  apnsKeyP8(i: PushInstance): { filename: string; pem: string } {
    if (i.preset !== 'apns') throw new HttpError(400, 'Only APNs instances have a .p8 key');
    const c = i.config as ApnsConfig;
    if (!c.privateKeyPem) throw new HttpError(404, 'This instance uses an uploaded public key: stubyard has no private key to download');
    return { filename: `AuthKey_${c.keyId}.p8`, pem: c.privateKeyPem };
  }

  // ------------------------------------------------------------------ devices

  requireDevice(project: Project, ref: string): PushDevice {
    const d = this.repo.getDevice(ref) ?? this.repo.deviceByToken(project.id, ref);
    if (!d || d.projectId !== project.id) throw new HttpError(404, `Push device "${ref.slice(0, 20)}" not found`);
    return d;
  }

  private topicsOf(v: unknown): string[] {
    if (v === undefined || v === null) return [];
    const list = (Array.isArray(v) ? v : String(v).split(',')).map((t) => String(t).trim().replace(/^\/topics\//, '')).filter(Boolean);
    for (const t of list) if (!TOPIC_RE.test(t)) throw new HttpError(400, `Topic "${t}" is not valid: letters, digits and - _ . ~ % only`);
    return [...new Set(list)];
  }

  defaultInstanceFor(projectId: string, platform: PushPlatform): PushInstance | null {
    const list = this.repo.listInstances(projectId);
    if (platform === 'ios') return list.find((i) => i.preset === 'apns') ?? list.find((i) => i.preset === 'fcm') ?? null;
    return list.find((i) => i.preset === 'fcm') ?? null;
  }

  registerDevice(project: Project, input: J, run: Run | null): PushDevice {
    const platform = String(input.platform ?? '').toLowerCase() as PushPlatform;
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'platform must be ios, android or web');
    const inst = input.instance ? this.requireInstance(project, String(input.instance)) : this.defaultInstanceFor(project.id, platform);
    const user = input.user ? this.hub.users.requireRef(project.id, String(input.user), run?.id) : null;
    let token = input.token ? String(input.token).trim() : '';
    if (!token) token = inst?.preset === 'apns' || (!inst && platform === 'ios') ? apnsDeviceToken() : fcmRegistrationToken();
    if (token.length > 4096 || /\s/.test(token)) throw new HttpError(400, 'token: no spaces, at most 4096 characters');
    if (this.repo.deviceByToken(project.id, token)) throw new HttpError(409, 'A device with this token is already registered in the project');
    const appId = input.appId ? String(input.appId) : inst?.preset === 'apns' ? ((inst.config as ApnsConfig).bundleIds[0] ?? null) : null;
    const d = this.repo.insertDevice({
      projectId: project.id,
      testUserId: user?.id ?? null,
      runId: run?.id ?? user?.runId ?? null,
      instanceId: inst?.id ?? null,
      platform,
      token,
      appId,
      name: input.name ? String(input.name).slice(0, 80) : `${user ? user.name + "'s " : ''}${platform === 'ios' ? 'iPhone' : platform === 'android' ? 'Android phone' : 'browser'}`,
      topics: this.topicsOf(input.topics),
      auto: false,
    });
    this.changed(project.id, { device: d.id });
    return d;
  }

  updateDevice(project: Project, ref: string, input: J): PushDevice {
    const d = this.requireDevice(project, ref);
    const patch: Parameters<PushRepo['updateDevice']>[1] = {};
    if (input.user !== undefined) {
      patch.testUserId = input.user ? this.hub.users.requireRef(project.id, String(input.user), d.runId).id : null;
      patch.auto = false;
    }
    if (input.name !== undefined) patch.name = String(input.name).slice(0, 80);
    if (input.appId !== undefined) patch.appId = input.appId ? String(input.appId) : null;
    if (input.instance !== undefined) patch.instanceId = input.instance ? this.requireInstance(project, String(input.instance)).id : null;
    if (input.topics !== undefined) patch.topics = this.topicsOf(input.topics);
    if (input.badge !== undefined) patch.badge = input.badge === null ? null : Number(input.badge);
    if (input.state !== undefined) {
      if (input.state !== 'active' && input.state !== 'unregistered') throw new HttpError(400, 'state must be active or unregistered');
      patch.state = input.state;
      patch.unregisteredAt = input.state === 'unregistered' ? nowIso() : null;
    }
    const next = this.repo.updateDevice(d.id, patch);
    this.changed(project.id, { device: d.id });
    return next;
  }

  setRegistered(project: Project, ref: string, registered: boolean): PushDevice {
    return this.updateDevice(project, ref, { state: registered ? 'active' : 'unregistered' });
  }

  changeTopics(project: Project, ref: string, add: unknown, remove: unknown): PushDevice {
    const d = this.requireDevice(project, ref);
    const plus = this.topicsOf(add);
    const minus = new Set(this.topicsOf(remove));
    const topics = [...new Set([...d.topics, ...plus])].filter((t) => !minus.has(t));
    const next = this.repo.updateDevice(d.id, { topics });
    this.changed(project.id, { device: d.id });
    return next;
  }

  deleteDevice(project: Project, ref: string): void {
    const d = this.requireDevice(project, ref);
    this.repo.deleteDevice(d.id);
    this.changed(project.id, { device: d.id, deleted: true });
  }

  /** The device a push to an unknown token creates when the instance accepts unknown tokens (Unassigned). */
  autoDevice(projectId: string, inst: PushInstance, token: string, platform: PushPlatform, runId: string | null, appId: string | null): PushDevice {
    const d = this.repo.insertDevice({ projectId, testUserId: null, runId, instanceId: inst.id, platform, token, appId, name: `Unknown ${platform} device`, topics: [], auto: true });
    this.changed(projectId, { device: d.id });
    return d;
  }

  viewDevice(d: PushDevice) {
    const user = d.testUserId ? this.hub.users.get(d.projectId, d.testUserId) : null;
    const inst = d.instanceId ? this.repo.getInstance(d.instanceId) : null;
    const run = d.runId ? this.hub.runs.repo.get(d.runId) : null;
    return { ...d, user: user ? { id: user.id, name: user.name, role: user.role } : null, instance: inst ? { id: inst.id, slug: inst.slug, preset: inst.preset } : null, run: run?.key ?? null };
  }

  // ------------------------------------------------------------------ notifications

  record(n: Omit<PushNotification, 'id' | 'createdAt' | 'openedAt'>): PushNotification {
    const row = this.repo.insertNotification({ ...n, raw: clipRaw(n.raw) });
    if (row.deviceId && row.status === 'delivered') {
      if (row.collapseKey) this.repo.collapse(row.deviceId, row.collapseKey, row.id);
      this.repo.updateDevice(row.deviceId, { lastPushAt: row.createdAt, ...(row.badge !== null ? { badge: row.badge } : {}) });
    }
    this.changed(row.projectId, { notification: row.id, status: row.status, user: row.testUserId });
    this.emitter.emit('n', row.projectId);
    return row;
  }

  requireNotification(project: Project, id: string): PushNotification {
    const n = this.repo.getNotification(id);
    if (!n || n.projectId !== project.id) throw new HttpError(404, `Push notification "${id}" not found`);
    return n;
  }

  /** Where a tap on the notification leads (click_action / link / data.url / category). */
  tapTarget(n: PushNotification): { kind: string; value: string } | null {
    const raw = (isObj(n.raw) ? n.raw : {}) as J;
    const msg = (isObj(raw.message) ? raw.message : raw) as J;
    const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), o);
    const candidates: [string, unknown][] = [
      ['click_action', get(msg, 'android', 'notification', 'click_action')],
      ['link', get(msg, 'webpush', 'fcm_options', 'link')],
      ['url', n.data.url ?? n.data.link ?? n.data.deeplink ?? n.data.deep_link],
      ['target-content-id', get(raw, 'aps', 'target-content-id') ?? get(msg, 'apns', 'payload', 'aps', 'target-content-id')],
      ['category', n.category],
    ];
    for (const [kind, v] of candidates) if (typeof v === 'string' && v) return { kind, value: v };
    return null;
  }

  open(project: Project, id: string) {
    const n = this.requireNotification(project, id);
    const at = n.openedAt ?? nowIso();
    if (!n.openedAt) {
      this.repo.updateNotification(n.id, { openedAt: at });
      this.changed(project.id, { notification: n.id, opened: true });
    }
    return { id: n.id, openedAt: at, tap: this.tapTarget(n), data: n.data };
  }

  viewNotification(n: PushNotification, detail = false) {
    const user = n.testUserId ? this.hub.users.get(n.projectId, n.testUserId) : null;
    const device = n.deviceId ? this.repo.getDevice(n.deviceId) : null;
    const inst = n.instanceId ? this.repo.getInstance(n.instanceId) : null;
    const run = n.runId ? this.hub.runs.repo.get(n.runId) : null;
    const base = {
      ...n,
      raw: detail ? n.raw : undefined,
      headers: detail ? n.headers : undefined,
      user: user ? { id: user.id, name: user.name } : null,
      device: device ? { id: device.id, name: device.name, platform: device.platform, token: device.token } : null,
      instance: inst ? { id: inst.id, slug: inst.slug, preset: inst.preset } : null,
      run: run?.key ?? null,
      tap: this.tapTarget(n),
    };
    return base;
  }

  cursor(projectId: string, f: NotificationFilter): string {
    return this.repo.listNotifications(projectId, { ...f, after: undefined, since: undefined, limit: 1 })[0]?.id ?? EMPTY_CURSOR;
  }

  /**
   * Long-poll: resolves when `count` (default 1) notifications match after the cursor, or for `exactly` when that
   * many arrived and no more within settleMs. Always resolves (timedOut true on timeout); oldest first.
   */
  async wait(project: Project, f: NotificationFilter, o: { count?: number; exactly?: number; settleMs?: number; timeoutMs: number }): Promise<{ timedOut: boolean; tooMany?: boolean; notifications: PushNotification[]; cursor: string }> {
    const deadline = Date.now() + o.timeoutMs;
    const want = o.exactly ?? o.count ?? 1;
    const query = () => this.repo.listNotifications(project.id, { ...f, asc: true, limit: 500 });
    const cursorOf = (list: PushNotification[]) => list.at(-1)?.id ?? f.after ?? this.cursor(project.id, f);
    let settleUntil: number | null = null;
    for (;;) {
      const list = query();
      if (o.exactly !== undefined) {
        if (list.length > o.exactly) return { timedOut: false, tooMany: true, notifications: list, cursor: cursorOf(list) };
        if (list.length === o.exactly) settleUntil ??= Date.now() + (o.settleMs ?? 2000);
        if (settleUntil !== null && Date.now() >= settleUntil) return { timedOut: false, notifications: list, cursor: cursorOf(list) };
      } else if (list.length >= want) return { timedOut: false, notifications: list.slice(0, Math.max(want, 1) === 1 ? 1 : list.length), cursor: cursorOf(list) };
      const now = Date.now();
      if (now >= deadline) return { timedOut: list.length < want || (o.exactly !== undefined && list.length !== o.exactly), notifications: list, cursor: cursorOf(list) };
      const until = Math.min(deadline, settleUntil ?? deadline) - now;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.max(10, Math.min(until, 1000)));
        const onN = (pid: string) => pid === project.id && done();
        function done() {
          clearTimeout(t);
          emitter.off('n', onN);
          resolve();
        }
        const emitter = this.emitter;
        emitter.on('n', onN);
      });
    }
  }

  deleteNotifications(project: Project, f: { user?: string; run?: Run | null }): number {
    const n = this.repo.deleteNotifications(project.id, { testUserId: f.user ? this.hub.users.requireRef(project.id, f.user).id : undefined, runId: f.run?.id });
    this.changed(project.id, { cleared: n });
    return n;
  }

  // ------------------------------------------------------------------ faults

  addFault(project: Project, input: J, run: Run | null): PushRule {
    const f = parseFault(input.fault);
    const inst = input.instance ? this.requireInstance(project, String(input.instance)) : null;
    const match: PushRule['match'] = {};
    if (input.token) match.token = String(input.token);
    if (input.user) match.user = this.hub.users.requireRef(project.id, String(input.user), run?.id).id;
    if (input.topic) match.topic = String(input.topic).replace(/^\/topics\//, '');
    let remaining: number | null = null;
    if (input.times !== undefined && input.times !== null && input.times !== '') {
      remaining = Number(input.times);
      if (!Number.isInteger(remaining) || remaining < 1) throw new HttpError(400, 'times must be a whole number ≥ 1 (leave out for every request)');
    }
    const rule = this.repo.insertRule({ projectId: project.id, runId: run?.id ?? null, instanceId: inst?.id ?? null, match, fault: f.spec, remaining });
    this.changed(project.id, { rule: rule.id });
    return rule;
  }

  clearFaults(project: Project, run: Run | null): number {
    const n = this.repo.deleteRules(project.id, run?.id ?? null);
    this.changed(project.id, { rulesCleared: n });
    return n;
  }

  deleteFault(project: Project, id: string): void {
    const r = this.repo.getRule(id);
    if (!r || r.projectId !== project.id) throw new HttpError(404, `Push fault rule "${id}" not found`);
    this.repo.deleteRule(id);
    this.changed(project.id, { rule: id, deleted: true });
  }

  viewRule(r: PushRule) {
    const run = r.runId ? this.hub.runs.repo.get(r.runId) : null;
    const inst = r.instanceId ? this.repo.getInstance(r.instanceId) : null;
    const user = r.match.user ? this.hub.users.get(r.projectId, r.match.user) : null;
    return { ...r, run: run?.key ?? null, instance: inst?.slug ?? null, userName: user?.name ?? null };
  }

  /** The fault for one send: the X-Hub-Scenario header, else the first matching run rule, then project rule. */
  pickFault(ctx: FaultContext): { fault: PushFault; source: 'header' | 'rule'; rule?: PushRule } | null {
    if (ctx.header) {
      const spec = ctx.header.split(',')[0].trim();
      if (spec && spec !== 'none') return { fault: parseFault(spec), source: 'header' };
    }
    const rules = this.repo.listRules(ctx.projectId).filter((r) => r.remaining !== 0 && (!r.runId || r.runId === ctx.runId));
    rules.sort((a, b) => Number(!a.runId) - Number(!b.runId));
    for (const r of rules) {
      if (r.instanceId && r.instanceId !== ctx.instanceId) continue;
      if (r.match.token && r.match.token !== ctx.token) continue;
      if (r.match.user && r.match.user !== ctx.userId) continue;
      if (r.match.topic && !(ctx.topics ?? []).includes(r.match.topic)) continue;
      let fault: PushFault;
      try {
        fault = parseFault(r.fault);
      } catch {
        continue;
      }
      this.repo.hitRule(r.id);
      this.changed(ctx.projectId, { rule: r.id, hit: true });
      return { fault, source: 'rule', rule: r };
    }
    return null;
  }

  // ------------------------------------------------------------------ runs, reset, retention

  /** Nothing to cancel: pushes are answered synchronously. */
  onRunStopped(_runId: string): void {}

  /** A run is purged: its devices, notifications and fault rules go. */
  purgeRun(runId: string): void {
    this.repo.purgeRun(runId);
  }

  /** Project reset: notifications and auto-created devices go; instances, registered devices and topics stay; rule hits → 0. */
  resetProject(projectId: string): void {
    this.repo.resetProject(projectId);
    this.changed(projectId, { reset: true });
  }

  /** Retention: notifications older than the cutoff go (called by maintenance/retention.ts). */
  purgeOlderThan(projectId: string, cutoffIso: string): number {
    return this.repo.deleteOlderThan(projectId, cutoffIso);
  }

  changed(projectId: string, data: unknown): void {
    this.hub.bus.publish({ type: 'push.changed', projectId, data });
  }

  // ------------------------------------------------------------------ FCM access tokens

  issueFcmToken(instanceId: string, scopes: string[], warnings: string[]): string {
    const now = Date.now();
    for (const [t, v] of this.fcmTokens) if (v.expiresAt < now) this.fcmTokens.delete(t);
    // Map order is insertion order: the oldest tokens go first.
    for (const t of this.fcmTokens.keys()) {
      if (this.fcmTokens.size < LIMITS.fcmTokenMaxActive) break;
      this.fcmTokens.delete(t);
    }
    const token = `ya29.stubyard.${crypto.randomBytes(24).toString('base64url')}`;
    this.fcmTokens.set(token, { instanceId, expiresAt: now + LIMITS.fcmAccessTokenSec * 1000, scopes, warnings });
    return token;
  }

  fcmToken(token: string | null): FcmAccessToken | null {
    if (!token) return null;
    const t = this.fcmTokens.get(token);
    if (!t) return null;
    if (t.expiresAt < Date.now()) {
      this.fcmTokens.delete(token);
      return null;
    }
    return t;
  }
}

function clipRaw(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  const s = JSON.stringify(raw);
  if (s.length <= LIMITS.rawBytes) return raw;
  return { truncated: true, size: s.length, text: s.slice(0, LIMITS.rawBytes) };
}

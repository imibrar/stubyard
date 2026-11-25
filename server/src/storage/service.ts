import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { StorageRepo, BUCKET_NAME_RE, type StorageBucket, type StorageInstance, type StorageInstanceConfig, type StorageObject } from '../repos/storage.js';
import { tagLog } from '../runs/resolver.js';
import { HttpError } from '../util.js';
import { corsFor } from './cors.js';
import { gate, HANDLED, maxBytesOf } from './provider-kit.js';
import { parseScenario, pickRule, SIMULATE_ROWS, validateRule, type StorageRuleInput } from './rules.js';
import { parseXml, text as xmlText } from './xml.js';
import { DiskStore, storageRoot, tooLargeFault, type Limits } from './store.js';
import { Counter, FlipByte, ResetAfter, sleep, Throttle } from './streams.js';
import {
  StorageFaultError,
  type InstanceView,
  type PresignInput,
  type PresignResult,
  type Snippet,
  type StorageCtx,
  type StorageEffects,
  type StorageFault,
  type StorageOp,
  type StoragePreset,
  type StorageProtocol,
  type ProtocolError,
} from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Body sizes for the traffic log when the bytes must not be stored (object uploads / downloads). */
    trafficBody?: { reqSize?: number; resSize?: number };
  }
}

// ---------------------------------------------------------------- protocol registry

const PROTOCOLS = new Map<string, StorageProtocol>();
const PRESETS = new Map<string, StoragePreset>();

/**
 * Extension point for provider modules (GCS, Azure Blob, Cloudinary, Supabase): call once at startup, e.g. from a
 * `registerXxx()` function invoked in index.ts next to `registerS3Protocol()`. Presets become creatable instances
 * and requests to their instances are routed to `protocol.handle`.
 */
export function registerStorageProtocol(protocol: StorageProtocol): void {
  PROTOCOLS.set(protocol.id, protocol);
  for (const p of protocol.presets) PRESETS.set(p.id, p);
}

export function storagePresets(): StoragePreset[] {
  return [...PRESETS.values()];
}

export function storagePreset(id: string): StoragePreset | null {
  return PRESETS.get(id) ?? null;
}

const MB = 1024 * 1024;
const ERROR_ACTIONS = new Set(['access_denied', 'slow_down', 'internal_error', 'quota_exceeded', 'expired_url', 'bad_signature', 'not_found']);
const UPLOAD_OPS = new Set(['PutObject', 'PostObject', 'UploadPart', 'UploadPartCopy', 'HubUpload']);

/** Mark raw requests whose "100 Continue" the storage pipeline sends itself. */
const DEFER = Symbol('stubyardDeferContinue');
const CONTINUED = Symbol('stubyardContinued');
type RawWithFlags = http.IncomingMessage & { [DEFER]?: boolean; [CONTINUED]?: boolean };

/** True for /storage/… and /run/<key>/storage/… (and virtual-hosted storage Hosts). */
export function isStorageUrl(url: string | undefined, host?: string, domain?: string | null): boolean {
  const u = url ?? '';
  if (u.startsWith('/storage/') || /^\/run\/[a-z0-9]{1,24}\/storage\//i.test(u)) return true;
  return !!(domain && host && hostOnly(host).endsWith('.' + domain));
}

const hostOnly = (h: string) => h.toLowerCase().replace(/:\d+$/, '');

/**
 * `Expect: 100-continue`: non-storage requests get "100 Continue" at once (Node's default); storage requests only when
 * the pipeline is about to read the body, so a rejected upload is never sent. Install on the HTTP and HTTPS servers.
 */
export function installCheckContinue(server: http.Server, handler: http.RequestListener, domain: string | null = null): void {
  server.on('checkContinue', (req: RawWithFlags, res: http.ServerResponse) => {
    if (isStorageUrl(req.url, req.headers.host, domain)) req[DEFER] = true;
    else res.writeContinue();
    handler(req, res);
  });
}

/** Virtual-hosted style (STUBYARD_STORAGE_DOMAIN): <bucket>.<instance>.<project>.<domain>/<key> → /storage/<project>/<instance>/<bucket>/<key>. */
export function rewriteStorageHost(req: { url?: string; headers: Record<string, string | string[] | undefined> }, domain: string | null): string | null {
  if (!domain) return null;
  const host = hostOnly(String(req.headers.host ?? ''));
  if (!host.endsWith('.' + domain)) return null;
  const labels = host.slice(0, -(domain.length + 1)).split('.');
  if (labels.length < 3) return null;
  const project = labels.pop()!;
  const instance = labels.pop()!;
  const bucket = labels.join('.');
  const url = req.url ?? '/';
  return `/storage/${project}/${instance}/${bucket}${url.startsWith('/') ? url : '/' + url}`;
}

export interface StorageMaintenanceReport {
  uploadsPurged: number;
  objectsExpired: number;
  orphansSwept: number;
  bytes: number;
}

/** File storage simulator: instances, the data plane under /storage/<project>/<instance>/…, maintenance. */
export class StorageService {
  readonly repo: StorageRepo;
  readonly root: string;

  constructor(private hub: Hub) {
    this.repo = new StorageRepo(hub.db);
    this.root = storageRoot(hub.config.dataDir);
    hub.bus.subscribe((e) => {
      if (e.type === 'project.deleted' && e.projectId) this.removeProjectFiles(e.projectId);
    });
  }

  // ---------------------------------------------------------------- presets / instances

  presets() {
    return storagePresets().map((p) => ({ ...p, available: PROTOCOLS.has(p.protocol) }));
  }

  presetOf(i: StorageInstance): StoragePreset {
    const p = storagePreset(i.preset);
    if (!p) throw new HttpError(500, `Storage instance "${i.slug}" uses unknown preset "${i.preset}"`);
    return p;
  }

  protocolOf(i: StorageInstance): StorageProtocol {
    const p = PROTOCOLS.get(this.presetOf(i).protocol);
    if (!p) throw new HttpError(501, `Storage preset "${i.preset}" is not available in this build`);
    return p;
  }

  create(project: Project, b: { preset?: unknown; slug?: unknown; name?: unknown; config?: unknown; enabled?: unknown }): StorageInstance {
    const presetId = String(b.preset ?? 's3').toLowerCase();
    const preset = storagePreset(presetId);
    if (!preset) throw new HttpError(400, `Unknown storage preset "${b.preset}". Use one of: ${storagePresets().map((p) => p.id).join(', ')}`);
    if (!PROTOCOLS.has(preset.protocol)) throw new HttpError(501, `Storage preset "${presetId}" is not available yet`);
    return this.repo.createInstance(project.id, {
      preset: presetId,
      slug: b.slug ? String(b.slug) : this.defaultSlug(project, presetId),
      name: b.name ? String(b.name) : preset.name,
      config: this.cleanConfig(b.config),
      enabled: b.enabled !== false,
    });
  }

  private defaultSlug(project: Project, preset: string): string | undefined {
    return this.repo.getInstance(project.id, preset) ? undefined : preset;
  }

  update(i: StorageInstance, b: { name?: unknown; slug?: unknown; config?: unknown; enabled?: unknown; replaceConfig?: unknown }): StorageInstance {
    const patch = this.cleanConfig(b.config);
    const config = b.replaceConfig === true ? patch : Object.fromEntries(Object.entries({ ...i.config, ...patch }).filter(([, v]) => v !== null));
    return this.repo.updateInstance(i, {
      name: b.name !== undefined ? String(b.name) : undefined,
      slug: b.slug !== undefined ? String(b.slug) : undefined,
      config: config as StorageInstanceConfig,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    });
  }

  private cleanConfig(v: unknown): StorageInstanceConfig {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '"config" must be an object');
    const c = { ...(v as StorageInstanceConfig) };
    if (c.credentials !== undefined && c.credentials !== null) {
      if (!Array.isArray(c.credentials) || c.credentials.some((x) => !x || typeof x.accessKeyId !== 'string' || typeof x.secretAccessKey !== 'string'))
        throw new HttpError(400, '"credentials" must be [{ "accessKeyId": "…", "secretAccessKey": "…" }]');
    }
    for (const k of ['quotaBytes', 'maxObjectBytes', 'maxObjects'] as const) {
      if (c[k] === undefined || c[k] === null) continue;
      const v = typeof c[k] === 'string' && (c[k] as unknown as string).trim() !== '' ? Number(c[k]) : c[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new HttpError(400, `"${k}" must be a non-negative integer (0 or null = no limit)`);
      c[k] = v;
    }
    return c;
  }

  credentials(i: StorageInstance) {
    return i.config.credentials?.length ? i.config.credentials : this.presetOf(i).credentials;
  }

  region(i: StorageInstance): string {
    return i.config.region || this.presetOf(i).region;
  }

  path(project: Project, i: StorageInstance): string {
    return `/storage/${project.slug}/${i.slug}`;
  }

  browserBase(project: Project, i: StorageInstance): string {
    const base = (i.config.browserBaseUrl || this.hub.config.publicUrl || (this.hub.tls ? `https://localhost:${this.hub.config.httpsPort}` : `http://localhost:${this.hub.config.httpPort}`)).replace(/\/+$/, '');
    return /\/storage\//.test(base) ? base : base + this.path(project, i);
  }

  backendBase(project: Project, i: StorageInstance): string {
    return `http://localhost:${this.hub.config.httpPort}${this.path(project, i)}`;
  }

  view(project: Project, i: StorageInstance): InstanceView {
    const preset = this.presetOf(i);
    const usage = this.repo.usage({ instanceId: i.id });
    // The GCS service-account private key is served only by GET …/service-account.json, not in every instance response.
    const { serviceAccount: _sa, ...config } = i.config;
    const v: InstanceView = {
      ...i,
      config,
      presetName: preset.name,
      protocol: preset.protocol,
      urls: {
        backend: this.backendBase(project, i),
        docker: `http://stubyard:${this.hub.config.httpPort}${this.path(project, i)}`,
        browser: this.browserBase(project, i),
      },
      credentials: this.credentials(i),
      ...(Array.isArray(preset.quirks?.credentialLabels) ? { credentialLabels: preset.quirks.credentialLabels as string[] } : {}),
      region: this.region(i),
      snippets: [],
      usage: { ...usage, quotaBytes: Number(i.config.quotaBytes ?? 0), maxObjectBytes: this.maxObjectBytes(i), maxObjects: Number(i.config.maxObjects ?? 0) },
      buckets: this.repo.listBuckets(i.id).length,
    };
    const proto = PROTOCOLS.get(preset.protocol);
    v.snippets = proto ? proto.snippets(v) : [];
    v.simulate = proto ? simulateRows(proto, preset) : [];
    return v;
  }

  bucketView(b: StorageBucket) {
    return { ...b, ...this.repo.bucketStats(b.id), uploads: this.repo.listUploads(b.id).length };
  }

  objectView(project: Project, i: StorageInstance, b: StorageBucket, o: StorageObject) {
    const enc = o.key.split('/').map(encodeURIComponent).join('/');
    const rel = PROTOCOLS.get(this.presetOf(i).protocol)?.objectPath?.(b.name, o.key, i) ?? `/${b.name}/${enc}`;
    return {
      ...o,
      bucket: b.name,
      urls: {
        backend: `${this.backendBase(project, i)}${rel}`,
        browser: `${this.browserBase(project, i)}${rel}`,
        content: `/api/projects/${project.slug}/storage/${i.slug}/buckets/${encodeURIComponent(b.name)}/object/content?key=${encodeURIComponent(o.key)}`,
      },
      public: b.public || o.acl === 'public-read',
    };
  }

  maxObjectBytes(i: StorageInstance): number {
    const own = Number(i.config.maxObjectBytes ?? 0);
    const global = this.hub.config.storageMaxObjectMb * MB;
    return own > 0 ? (global > 0 ? Math.min(own, global) : own) : global > 0 ? global : Number.MAX_SAFE_INTEGER;
  }

  limits(i: StorageInstance): Limits {
    const cfg = this.hub.config;
    const quotas = () => {
      const out: { reason: string; left: number; kind?: 'quotaBytes'; max?: number }[] = [];
      if (cfg.storageMaxMb > 0) out.push({ reason: `STUBYARD_STORAGE_MAX_MB=${cfg.storageMaxMb} (all projects)`, left: cfg.storageMaxMb * MB - this.repo.usage().bytes });
      if (cfg.storageProjectMb > 0) out.push({ reason: `STUBYARD_STORAGE_PROJECT_MB=${cfg.storageProjectMb} (this project)`, left: cfg.storageProjectMb * MB - this.repo.usage({ projectId: i.projectId }).bytes });
      const q = Number(i.config.quotaBytes ?? 0);
      if (q > 0) out.push({ reason: `instance quotaBytes=${q}`, left: q - this.repo.usage({ instanceId: i.id }).bytes, kind: 'quotaBytes' as const, max: q });
      return out;
    };
    const tightest = () => quotas().sort((a, b) => a.left - b.left)[0];
    return {
      maxObjectBytes: this.maxObjectBytes(i),
      maxObjects: Number(i.config.maxObjects ?? 0),
      objectCount: () => this.repo.usage({ instanceId: i.id }).objects,
      remaining: () => Math.max(0, Math.min(Infinity, ...quotas().map((q) => q.left))),
      quotaReason: () => {
        const q = tightest();
        return q ? `quota: ${q.reason}` : 'quota';
      },
      quotaFault: () => {
        const q = tightest();
        return new StorageFaultError({ kind: 'quota_exceeded', reason: q ? `quota: ${q.reason}` : 'quota', limit: q?.kind ? { kind: 'quotaBytes', max: q.max! } : { kind: 'server', max: 0 } });
      },
    };
  }

  store(i: StorageInstance): DiskStore {
    return new DiskStore(i, this.repo, this.root, this.limits(i));
  }

  // ---------------------------------------------------------------- rules (control API)

  addRule(project: Project, i: StorageInstance, input: StorageRuleInput, runId: string | null) {
    const v = validateRule(input);
    let bucketId: string | null = null;
    if (input.bucket) {
      const b = this.repo.getBucket(i.id, String(input.bucket));
      if (!b) throw new HttpError(404, `Bucket "${input.bucket}" not found`);
      bucketId = b.id;
    }
    return this.repo.insertRule({ ...v, projectId: project.id, instanceId: i.id, bucketId, runId });
  }

  // ---------------------------------------------------------------- presign

  presign(project: Project, i: StorageInstance, input: PresignInput): PresignResult {
    const preset = this.presetOf(i);
    return this.protocolOf(i).presign({ hub: this.hub, project, instance: i, preset, bases: { backend: this.backendBase(project, i), browser: this.browserBase(project, i) } }, input);
  }

  // ---------------------------------------------------------------- data plane

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const raw = req.raw as RawWithFlags;
    const url = req.url;
    const q = url.indexOf('?');
    let pathname = q < 0 ? url : url.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
    if (!this.hub.projects.getBySlug(safeDecode(pathname.split('/')[2] ?? '').toLowerCase())) {
      for (const p of PROTOCOLS.values()) {
        const r = p.rootRoute?.(this.hub, pathname, query, req.headers);
        if (typeof r === 'string') {
          pathname = r + pathname;
          break;
        }
        if (r) {
          req.trafficOutcome = 'unmatched';
          reply.status(r.status);
          for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
          if (r.contentType) reply.type(r.contentType);
          return reply.send(req.method === 'HEAD' ? undefined : r.body);
        }
      }
    }
    const m = /^\/storage\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname);
    const resolved: Record<string, unknown> = { kind: 'storage' };
    req.trafficResolved = resolved;
    const s3 = PROTOCOLS.get('s3');
    const notFound = (message: string, hint: string) => {
      req.trafficOutcome = 'unmatched';
      if (s3) {
        const e = s3.errorFor(null, { kind: 'unknown_instance', message: `${message}. ${hint}` });
        reply.status(e.status);
        for (const [k, v] of Object.entries(e.headers ?? {})) reply.header(k, v);
        if (e.contentType) reply.type(e.contentType);
        return reply.send(req.method === 'HEAD' ? undefined : e.body);
      }
      return reply.status(404).send({ error: 'Not found', message, hint });
    };
    if (!m) return notFound(`stubyard has no storage route ${req.method} ${pathname}`, 'Storage URLs look like /storage/<project>/<instance>/<bucket>/<key>.');
    const projectSlug = safeDecode(m[1]).toLowerCase();
    const project = this.hub.projects.getBySlug(projectSlug);
    resolved.project = project?.slug ?? null;
    if (!project) {
      resolved.unknownProject = m[1];
      return notFound(`stubyard has no project "${m[1]}"`, 'Storage URLs look like /storage/<project>/<instance>/… (dashboard → project → Storage).');
    }
    if (req.trafficLogId) this.hub.traffic.update(req.trafficLogId, { projectId: project.id });
    const instance = this.repo.getInstance(project.id, safeDecode(m[2]));
    if (!instance) {
      resolved.unknownInstance = m[2];
      return notFound(
        `Project "${project.slug}" has no storage instance "${m[2]}"`,
        `Create one with POST /api/projects/${project.slug}/storage {"preset":"s3"} or in the dashboard (Storage). Existing: ${this.repo.listInstances(project.id).map((x) => x.slug).join(', ') || 'none'}`,
      );
    }
    const preset = this.presetOf(instance);
    const protocol = PROTOCOLS.get(preset.protocol);
    Object.assign(resolved, { instance: instance.slug, preset: preset.id });
    if (!protocol) return reply.status(501).send({ error: `Storage preset "${preset.id}" is not available in this build` });

    const attribution = this.hub.runs.resolver.forRequest(project.id, req);
    tagLog(this.hub, req.trafficLogId, attribution);
    const explicitRun = req.hubRun ?? null;

    const host = String(req.headers.host ?? `localhost:${this.hub.config.httpPort}`);
    const orig = req.originalUrl ?? req.url;
    const runPrefix = /^\/run\/[a-z0-9]{1,24}(?=\/storage\/)/i.exec(orig)?.[0] ?? '';
    const rest = m[3] ?? '/';
    const requestId = req.trafficLogId ?? crypto.randomBytes(8).toString('hex').toUpperCase();
    const svc = this;
    let effectsMemo: StorageEffects | null | undefined;
    let opGroup: StorageOp = 'any';
    let opName = 'Unknown';
    let target: { bucket?: string; key?: string } = {};

    const ctx: StorageCtx = {
      hub: this.hub,
      project,
      instance,
      preset,
      protocol,
      store: this.store(instance),
      req,
      reply,
      path: rest,
      query,
      explicitRun,
      run: attribution.run,
      runVia: attribution.via,
      requestId,
      strict: instance.config.strict === true,
      warnings: [],
      resolved,
      bases: { request: `${req.protocol}://${host}${runPrefix}${this.path(project, instance)}`, browser: this.browserBase(project, instance) },
      corsHeaders: {},
      setOp(group, name, t = {}) {
        opGroup = group;
        opName = name;
        target = t;
        resolved.op = name;
        if (t.bucket !== undefined) resolved.bucket = t.bucket;
        if (t.key !== undefined) resolved.key = t.key;
      },
      effects(bucket) {
        if (effectsMemo !== undefined) return effectsMemo;
        effectsMemo = svc.effectsFor(ctx, bucket ?? null, opGroup, opName, target.key ?? null);
        return effectsMemo;
      },
      async transport(e) {
        if (!e) return false;
        if (e.action === 'slow' && e.params.delayMs !== undefined) {
          await sleep(Math.min(Number(e.params.delayMs), 600_000));
          return false;
        }
        if (e.action === 'timeout') {
          await svc.hold(ctx);
          return true;
        }
        if (e.action === 'reset' && (e.params.afterBytes === undefined || !UPLOAD_OPS.has(opName))) {
          if (e.params.afterBytes === undefined) {
            svc.destroy(ctx, 'Storage scenario "reset": connection reset');
            return true;
          }
        }
        return false;
      },
      continue() {
        if (raw[DEFER] && !raw[CONTINUED]) {
          raw[CONTINUED] = true;
          reply.raw.writeContinue();
        }
      },
      body(e) {
        ctx.continue();
        let s: Readable = req.raw;
        const eff = e === undefined ? effectsMemo : e;
        if (eff?.action === 'slow' && eff.params.bytesPerSec) s = s.pipe(new Throttle(Number(eff.params.bytesPerSec)));
        if (eff?.action === 'reset' && eff.params.afterBytes !== undefined) {
          s = s.pipe(new ResetAfter(Number(eff.params.afterBytes), () => svc.destroy(ctx, 'Storage scenario "reset": connection reset mid-upload')));
        }
        return s;
      },
      async readSmall(max = MB) {
        ctx.continue();
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req.raw) {
          n += (c as Buffer).length;
          if (n > max) throw new StorageFaultError({ kind: 'invalid_request', message: `Request body larger than ${max} bytes` });
          chunks.push(c as Buffer);
        }
        const buf = Buffer.concat(chunks);
        req.rawBody = buf; // small control bodies are logged as text
        return buf;
      },
      fail(f) {
        const fa = f instanceof StorageFaultError ? f.fault : f;
        return svc.sendFault(ctx, fa);
      },
      sendBody(stream, size, e) {
        req.trafficBody = { ...(req.trafficBody ?? {}), resSize: size };
        const eff = e === undefined ? effectsMemo : e;
        let s: Readable = stream;
        if (eff?.action === 'checksum_mismatch' && size > 0) s = s.pipe(new FlipByte(Math.floor(size / 2)));
        if (eff?.action === 'slow' && eff.params.bytesPerSec) s = s.pipe(new Throttle(Number(eff.params.bytesPerSec)));
        if (eff?.action === 'reset' && eff.params.afterBytes !== undefined) s = s.pipe(new ResetAfter(Number(eff.params.afterBytes), () => svc.destroy(ctx, 'Storage scenario "reset": connection reset mid-download')));
        if (s !== stream) stream.on('error', (err) => s.destroy(err));
        const counter = new Counter();
        s.on('error', (err) => counter.destroy(err));
        return reply.send(s.pipe(counter));
      },
      noteRequestSize(size) {
        req.trafficBody = { ...(req.trafficBody ?? {}), reqSize: size };
        resolved.size = size;
      },
      changed(data) {
        svc.hub.bus.publish({ type: 'storage.changed', projectId: project.id, data: { instance: instance.slug, ...data } });
      },
    };

    // Common headers + CORS (OPTIONS answered here for every protocol).
    for (const [k, v] of Object.entries(protocol.commonHeaders?.(ctx) ?? {})) reply.header(k, v);
    const first = safeDecode(rest.split('/')[1] ?? '');
    const corsBucket = first && first !== '__hub' && !(protocol.reservedSegments ?? []).includes(first) ? this.repo.getBucket(instance.id, first) : null;
    const origin = req.headers.origin as string | undefined;
    if (req.method === 'OPTIONS') {
      ctx.setOp('any', 'Preflight', { bucket: first || undefined });
      const blocked = pickRule(this.repo, { instanceId: instance.id, bucketId: corsBucket?.id ?? null, runId: ctx.run?.id ?? null, op: 'any', key: null, only: ['cors_blocked'] });
      const reqMethod = String(req.headers['access-control-request-method'] ?? '');
      const d = blocked ? { headers: {}, denied: true } : corsFor(corsBucket?.cors ?? null, { origin, method: reqMethod || 'GET', requestHeaders: req.headers['access-control-request-headers'] as string | undefined, preflight: true });
      if (blocked) resolved.rule = { id: blocked.id, action: blocked.action, label: blocked.label };
      if (d.denied || !origin) {
        req.trafficOutcome = blocked ? 'forced_error' : 'rejected';
        return this.sendFault(ctx, { kind: 'cors_blocked', message: 'CORSResponse: This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers are not whitelisted by the resource\'s CORS spec.', status: 403, code: 'AccessForbidden' });
      }
      for (const [k, v] of Object.entries(d.headers)) reply.header(k, v);
      return reply.status(200).send();
    }
    const cors = corsFor(corsBucket?.cors ?? null, { origin, method: req.method, preflight: false });
    if (!cors.denied) {
      ctx.corsHeaders = cors.headers;
      for (const [k, v] of Object.entries(cors.headers)) reply.header(k, v);
      if (cors.warning && corsBucket) ctx.warnings.push(cors.warning);
    }

    try {
      if (first === '__hub') return await this.hubEndpoint(ctx);
      if (!instance.enabled) {
        req.trafficOutcome = 'rejected';
        return this.sendFault(ctx, { kind: 'slow_down', status: 503, code: 'ServiceUnavailable', message: `Storage instance "${instance.slug}" is disabled in stubyard`, reason: 'instance disabled' });
      }
      return await protocol.handle(ctx);
    } catch (err) {
      if (err instanceof StorageFaultError) return this.sendFault(ctx, err.fault);
      const code = (err as { code?: string }).code;
      if (req.raw.destroyed || reply.raw.destroyed || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') {
        req.trafficOutcome = 'network_error';
        if (!reply.sent && !reply.raw.headersSent) {
          reply.raw.destroy();
        }
        return reply;
      }
      req.log.error({ err }, 'storage request failed');
      return this.sendFault(ctx, { kind: 'internal_error', message: 'We encountered an internal error. Please try again.', reason: (err as Error).message });
    } finally {
      if (ctx.warnings.length) resolved.warnings = [...new Set(ctx.warnings)];
    }
  }

  /** Scenario effects: X-Hub-Scenario / hub_scenario, then run, bucket and instance rules. cors_blocked strips CORS headers. */
  private effectsFor(ctx: StorageCtx, bucket: StorageBucket | null, op: StorageOp, opName: string, key: string | null): StorageEffects | null {
    const h = ctx.req.headers['x-hub-scenario'];
    const hv = Array.isArray(h) ? h[0] : h;
    const qv = ctx.query.get('hub_scenario');
    let e: StorageEffects | null = null;
    if (hv || qv) {
      const r = parseScenario(String(hv ?? qv), hv ? 'header' : 'query');
      if (r.unknown.length) ctx.warnings.push(`Unknown scenario ${r.unknown.map((u) => `"${u}"`).join(', ')} ignored`);
      e = r.effects;
      if (e) ctx.resolved.scenario = { source: e.source, action: e.action, params: e.params };
    }
    if (!e) {
      const rule = pickRule(this.repo, { instanceId: ctx.instance.id, bucketId: bucket?.id ?? null, runId: ctx.run?.id ?? null, op, opName, key });
      if (rule) {
        e = { action: rule.action as StorageEffects['action'], params: rule.params, source: 'rule', rule };
        ctx.resolved.rule = { id: rule.id, action: rule.action, label: rule.label, scope: rule.runId ? 'run' : rule.bucketId ? 'bucket' : 'instance' };
        this.hub.bus.publish({ type: 'storage.changed', projectId: ctx.project.id, data: { instance: ctx.instance.slug, rule: rule.id } });
      }
    }
    if (e?.action === 'cors_blocked') {
      for (const k of Object.keys(ctx.corsHeaders)) ctx.reply.removeHeader(k);
      ctx.corsHeaders = {};
      return null;
    }
    if (e && e.action !== 'slow') ctx.req.trafficOutcome = 'forced_error';
    return e;
  }

  /** The native error for an effect that rejects the request (null = the protocol handles it / no error). */
  static effectFault(e: StorageEffects | null, opName: string): StorageFault | null {
    if (!e) return null;
    if (ERROR_ACTIONS.has(e.action)) return { kind: e.action as StorageFault['kind'], reason: `scenario ${e.action}` };
    if (e.action === 'entity_too_large' && e.params.maxBytes === undefined && UPLOAD_OPS.has(opName)) return { kind: 'entity_too_large', reason: 'scenario entity_too_large' };
    if (e.action === 'checksum_mismatch' && UPLOAD_OPS.has(opName)) return { kind: 'bad_digest', message: 'The Content-MD5 or checksum value that you specified did not match what the server received.', reason: 'scenario checksum_mismatch' };
    return null;
  }

  sendFault(ctx: StorageCtx, f: StorageFault): FastifyReply {
    const { req, reply } = ctx;
    if (reply.sent || reply.raw.headersSent) return reply;
    const e = ctx.protocol.errorFor(ctx, f);
    if (!req.trafficOutcome) req.trafficOutcome = e.status >= 500 ? 'forced_error' : 'rejected';
    ctx.resolved.error = { code: f.code ?? f.kind, status: e.status, ...(f.reason ? { reason: f.reason } : {}) };
    reply.status(e.status);
    for (const [k, v] of Object.entries(e.headers ?? {})) reply.header(k, v);
    for (const [k, v] of Object.entries(f.headers ?? {})) reply.header(k, v);
    if (f.reason) reply.header('x-stubyard-reason', f.reason.replace(/[^\x20-\x7e]/g, '?'));
    const raw = req.raw as RawWithFlags;
    // The client is still waiting for "100 Continue": answer and close so the body is never sent.
    if (raw[DEFER] && !raw[CONTINUED]) reply.header('connection', 'close');
    if (e.contentType) reply.type(e.contentType);
    return reply.send(req.method === 'HEAD' ? undefined : e.body);
  }

  private async hold(ctx: StorageCtx): Promise<void> {
    const { req, reply } = ctx;
    const logId = req.trafficLogId;
    req.trafficLogId = undefined;
    reply.hijack();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.hub.config.timeoutHoldMs);
      req.raw.once('close', () => (clearTimeout(t), resolve()));
    });
    req.raw.socket?.destroy();
    if (logId) {
      this.hub.traffic.mergeResolved(logId, ctx.resolved);
      this.hub.traffic.finish(logId, { outcome: 'forced_error', errorType: 'simulated_timeout', errorMessage: 'Storage scenario: no response (timeout)', resStatus: null });
    }
  }

  private destroy(ctx: StorageCtx, message: string): void {
    const { req } = ctx;
    const logId = req.trafficLogId;
    if (logId) {
      req.trafficLogId = undefined;
      this.hub.traffic.mergeResolved(logId, ctx.resolved);
      this.hub.traffic.finish(logId, { outcome: 'forced_error', errorType: 'simulated_reset', errorMessage: message, resStatus: null });
    }
    req.raw.socket?.destroy();
  }

  // ---------------------------------------------------------------- stubyard's own data-plane endpoints

  /** PUT B/__hub/objects/<bucket>/<key>: streamed dashboard upload (the JSON-only /api cannot take files). */
  private async hubEndpoint(ctx: StorageCtx): Promise<unknown> {
    const { req, reply } = ctx;
    const parts = ctx.path.split('/').slice(2); // ['objects', bucket, ...key]
    if (parts[0] !== 'objects' || parts.length < 3) return reply.status(404).send({ error: 'Not found', message: 'stubyard endpoints: PUT …/__hub/objects/<bucket>/<key>' });
    const bucketName = safeDecode(parts[1]);
    const key = parts.slice(2).map(safeDecode).join('/');
    if (!key) return reply.status(400).send({ error: 'Key is required' });
    if (req.method !== 'PUT') return reply.status(405).header('allow', 'PUT').send({ error: 'Use PUT' });
    ctx.setOp('put', 'HubUpload', { bucket: bucketName, key });
    if (!BUCKET_NAME_RE.test(bucketName)) return reply.status(400).send({ error: `Invalid bucket name "${bucketName}"` });
    try {
      const bucket = ctx.store.bucketOrCreate(bucketName);
      // Scenario rules apply to dashboard uploads too (same faults as the SDK path).
      const e = await gate(ctx, bucket, true);
      if (e === HANDLED) return reply;
      // Before "100 Continue" / the body: a full instance refuses at once.
      ctx.store.checkObjectLimit(bucket, key);
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared)) {
        const max = maxBytesOf(e) ?? this.maxObjectBytes(ctx.instance);
        if (declared > max) throw tooLargeFault(max, declared);
        const lim = this.limits(ctx.instance);
        if (declared > lim.remaining()) throw lim.quotaFault();
      }
      const obj = await ctx.store.put(bucket, key, ctx.body(e), {
        maxBytes: maxBytesOf(e),
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        source: 'dashboard',
        runId: ctx.explicitRun?.id ?? null,
        logId: req.trafficLogId ?? null,
      });
      ctx.noteRequestSize(obj.size);
      Object.assign(ctx.resolved, { objectId: obj.id, etag: obj.etag, contentType: obj.contentType });
      ctx.changed({ bucket: bucket.name, key, put: true });
      return reply.status(201).send(this.objectView(ctx.project, ctx.instance, bucket, obj));
    } catch (err) {
      if (err instanceof StorageFaultError) {
        req.trafficOutcome = 'rejected';
        const f = err.fault;
        const native = nativeShape(ctx.protocol.errorFor(ctx, f));
        const simulated = f.reason?.startsWith('scenario ') ?? false;
        const status = simulated ? native.status : f.kind === 'quota_exceeded' || f.kind === 'entity_too_large' ? 413 : f.kind === 'no_such_bucket' ? 404 : 400;
        ctx.resolved.error = { code: f.kind, status, ...(f.reason ? { reason: f.reason } : {}) };
        if (f.reason) reply.header('x-stubyard-reason', f.reason.replace(/[^\x20-\x7e]/g, '?'));
        const raw = req.raw as RawWithFlags;
        if (raw[DEFER] && !raw[CONTINUED]) reply.header('connection', 'close');
        else if (!raw.readableEnded) raw.resume(); // drain, so a browser reads the answer instead of a reset
        const error = simulated ? `Simulated ${ctx.preset.name} error: ${[native.status, native.code].filter(Boolean).join(' ')}${native.message ? ` — ${native.message}` : ''}` : hubUploadMessage(f);
        return reply.status(status).send({ error, code: f.kind, reason: f.reason ?? null, native, ...(f.limit ? { limit: f.limit } : {}) });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  removeProjectFiles(projectId: string): void {
    if (!/^[a-z0-9]+$/i.test(projectId)) return;
    fs.rmSync(path.join(this.root, projectId), { recursive: true, force: true });
  }

  /** Run stopped: its rules go (like message rules). */
  onRunStopped(runId: string): void {
    this.repo.deleteRulesForRun(runId);
  }

  /** Run purged: objects and uploads attributed to it explicitly. */
  purgeRun(runId: string): number {
    const objs = this.hub.db.prepare('SELECT o.id, o.project_id, b.instance_id FROM storage_objects o JOIN storage_buckets b ON b.id = o.bucket_id WHERE o.run_id = ?').all(runId) as { id: string; project_id: string; instance_id: string }[];
    for (const o of objs) {
      this.repo.deleteObjectRow(o.id);
      fs.rmSync(path.join(this.root, o.project_id, o.instance_id, 'objects', o.id.slice(-2), o.id), { force: true });
    }
    const ups = this.hub.db.prepare('SELECT id FROM storage_uploads WHERE run_id = ?').all(runId) as { id: string }[];
    for (const u of ups) this.repo.deleteUpload(u.id);
    this.repo.deleteRulesForRun(runId);
    return objs.length;
  }

  /** Project reset: uploads and run-attributed objects; every object with { all: true }. */
  resetProject(projectId: string, opts: { all?: boolean } = {}): { objects: number; uploads: number } {
    let objects = 0;
    let uploads = 0;
    for (const i of this.repo.listInstances(projectId)) {
      const st = this.store(i);
      for (const b of this.repo.listBuckets(i.id)) {
        for (const u of this.repo.listUploads(b.id)) {
          st.uploads.abort(u);
          uploads++;
        }
        if (opts.all) objects += st.empty(b);
      }
    }
    if (!opts.all) {
      const runObjs = this.hub.db.prepare('SELECT DISTINCT run_id FROM storage_objects WHERE project_id = ? AND run_id IS NOT NULL').all(projectId) as { run_id: string }[];
      for (const r of runObjs) objects += this.purgeRun(r.run_id);
    }
    this.repo.resetHits(projectId);
    if (objects || uploads) this.hub.bus.publish({ type: 'storage.changed', projectId, data: { reset: true, objects, uploads } });
    return { objects, uploads };
  }

  /** Maintenance pass: expired uploads, retention, orphan files (what cascades leave behind). */
  async maintain(now = Date.now()): Promise<StorageMaintenanceReport> {
    const report: StorageMaintenanceReport = { uploadsPurged: 0, objectsExpired: 0, orphansSwept: 0, bytes: 0 };
    for (const u of this.repo.expiredUploads(new Date(now).toISOString())) {
      this.repo.deleteUpload(u.id);
      report.uploadsPurged++;
    }
    const days = this.hub.config.storageRetentionDays;
    if (days > 0) {
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      const old = this.hub.db.prepare('SELECT o.id, o.project_id, b.instance_id FROM storage_objects o JOIN storage_buckets b ON b.id = o.bucket_id WHERE o.updated_at < ?').all(cutoff) as { id: string; project_id: string; instance_id: string }[];
      for (const o of old) {
        this.repo.deleteObjectRow(o.id);
        fs.rmSync(path.join(this.root, o.project_id, o.instance_id, 'objects', o.id.slice(-2), o.id), { force: true });
        report.objectsExpired++;
      }
    }
    report.orphansSwept = this.sweep(now);
    report.bytes = this.repo.usage().bytes;
    return report;
  }

  /** Remove files and directories without a row, older than an hour (in-flight uploads are younger). */
  sweep(now = Date.now(), minAgeMs = 3600_000): number {
    let swept = 0;
    const old = (p: string) => {
      try {
        return now - fs.statSync(p).mtimeMs > minAgeMs;
      } catch {
        return false;
      }
    };
    const rm = (p: string) => {
      fs.rmSync(p, { recursive: true, force: true });
      swept++;
    };
    const ls = (p: string) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    };
    const db = this.hub.db;
    const projectExists = db.prepare('SELECT 1 FROM projects WHERE id = ?');
    const instanceExists = db.prepare('SELECT 1 FROM storage_instances WHERE id = ?');
    const objectExists = db.prepare('SELECT 1 FROM storage_objects WHERE id = ?');
    const uploadExists = db.prepare('SELECT 1 FROM storage_uploads WHERE id = ?');
    for (const pid of ls(this.root)) {
      const pdir = path.join(this.root, pid);
      if (!projectExists.get(pid)) {
        if (old(pdir)) rm(pdir);
        continue;
      }
      for (const iid of ls(pdir)) {
        const idir = path.join(pdir, iid);
        if (iid === 'tmp') {
          for (const f of ls(idir)) if (old(path.join(idir, f))) rm(path.join(idir, f));
          continue;
        }
        if (!instanceExists.get(iid)) {
          if (old(idir)) rm(idir);
          continue;
        }
        const odir = path.join(idir, 'objects');
        for (const shard of ls(odir)) for (const f of ls(path.join(odir, shard))) if (!objectExists.get(f) && old(path.join(odir, shard, f))) rm(path.join(odir, shard, f));
        const udir = path.join(idir, 'uploads');
        for (const u of ls(udir)) if (!uploadExists.get(u) && old(path.join(udir, u))) rm(path.join(udir, u));
      }
    }
    return swept;
  }

  /** The global caps from the environment (0 = no limit), for the dashboard's Limits panel. */
  caps() {
    const c = this.hub.config;
    return { storageMaxMb: c.storageMaxMb, storageProjectMb: c.storageProjectMb, storageMaxObjectMb: c.storageMaxObjectMb, storageRetentionDays: c.storageRetentionDays };
  }

  /** Project-wide totals and the latest files across every storage instance (Overview "Files" card). */
  summary(project: Project, limit = 5) {
    const instances = this.repo.listInstances(project.id);
    const bySlug = new Map(instances.map((i) => [i.id, i]));
    const usage = this.repo.usage({ projectId: project.id });
    const recent = this.repo.recentObjects(project.id, Math.max(1, Math.min(50, limit))).flatMap((o) => {
      const b = this.repo.bucketById(o.bucketId);
      const i = b ? bySlug.get(b.instanceId) : undefined;
      return b && i ? [{ ...this.objectView(project, i, b, o), instance: i.slug, instanceName: i.name }] : [];
    });
    return {
      objects: usage.objects,
      bytes: usage.bytes,
      instances: instances.map((i) => {
        const u = this.repo.usage({ instanceId: i.id });
        return { slug: i.slug, name: i.name, preset: i.preset, enabled: i.enabled, objects: u.objects, bytes: u.bytes, maxObjects: Number(i.config.maxObjects ?? 0), quotaBytes: Number(i.config.quotaBytes ?? 0), buckets: this.repo.listBuckets(i.id).map((b) => b.name) };
      }),
      recent,
      caps: this.caps(),
    };
  }

  /** Byte and object counts for the system page. */
  counts(): { objects: number; bytes: number; instances: number } {
    const u = this.repo.usage();
    return { ...u, instances: (this.hub.db.prepare('SELECT COUNT(*) AS n FROM storage_instances').get() as { n: number }).n };
  }

  /** Sections for the project setup guide. */
  guideSections(project: Project): { id: string; title: string; description: string; instance: string; snippets: Snippet[] }[] {
    return this.repo.listInstances(project.id).map((i) => {
      const v = this.view(project, i);
      const cred = v.credentials[0];
      return {
        id: `storage-${i.slug}`,
        title: `File storage — ${i.name} (fake ${v.presetName})`,
        description:
          'Point the storage SDK at this endpoint (path-style). Backend I/O uses the backend URL; presign with the browser URL when users upload / download directly. ' +
          'Signatures are parsed but not verified unless the instance is strict / verifySignatures, so URLs signed for one host also work on the other.',
        instance: i.slug,
        snippets: [
          { title: 'Endpoint', language: 'text', code: [`Backend (host)    ${v.urls.backend}`, `Backend (Docker)  ${v.urls.docker}`, `Browser           ${v.urls.browser}`, `Region            ${v.region}`, cred ? `Access key        ${cred.accessKeyId}\nSecret key        ${cred.secretAccessKey}` : ''].filter(Boolean).join('\n') },
          ...v.snippets,
        ],
      };
    });
  }
}

/** Status, code and message of a rendered native error (XML Code / Message, GCS reason, Supabase code / error, Cloudinary message). */
export function nativeShape(e: ProtocolError): { status: number; code: string | null; message: string | null } {
  const body = typeof e.body === 'string' ? e.body : e.body ? String(e.body) : '';
  let code: string | null = e.headers?.['x-ms-error-code'] ?? null;
  let message: string | null = null;
  if (body.trimStart().startsWith('<')) {
    try {
      const x = parseXml(body);
      code = xmlText(x, 'Code') ?? code;
      message = xmlText(x, 'Message') ?? null;
    } catch {
      /* not XML after all */
    }
  } else if (body) {
    try {
      const j = JSON.parse(body) as { error?: unknown; code?: unknown; message?: unknown };
      if (j.error && typeof j.error === 'object') {
        const g = j.error as { message?: string; errors?: { reason?: string }[] };
        code = g.errors?.[0]?.reason ?? null;
        message = g.message ?? null;
      } else {
        code = typeof j.code === 'string' ? j.code : typeof j.error === 'string' ? j.error : null;
        message = typeof j.message === 'string' ? j.message : null;
      }
    } catch {
      message = body.slice(0, 200);
    }
  }
  return { status: e.status, code, message: message ? message.split('\n')[0] : null };
}

/** The "Simulate errors" rows that apply to a provider, each with the native error it produces (from the protocol's own table). */
function simulateRows(proto: StorageProtocol, preset: StoragePreset): NonNullable<InstanceView['simulate']> {
  const ctx = { preset, path: '/upload/storage/v1/b/bucket/o', requestId: '', instance: { config: {} }, query: new URLSearchParams(), req: { url: '/', headers: {} } } as unknown as StorageCtx;
  return SIMULATE_ROWS.flatMap((r): NonNullable<InstanceView['simulate']> => {
    const kind = r.action === 'checksum_mismatch' || r.action === 'slow' || r.action === 'reset' ? null : r.action;
    if (!kind) return [{ ...r, error: null }];
    const f: StorageFault = { kind: kind as StorageFault['kind'], ...(kind === 'entity_too_large' ? { limit: { kind: 'maxObjectBytes' as const, max: Number(r.params?.maxBytes ?? MB) } } : {}) };
    let rendered: ProtocolError;
    try {
      rendered = proto.errorFor(ctx, f);
    } catch {
      return [];
    }
    const shape = nativeShape(rendered);
    // A kind missing from the protocol's table falls back to "500 <kind>": that row does not apply.
    if (shape.status === 500 && kind !== 'internal_error' && (shape.code === kind || shape.message === kind)) return [];
    return [{ ...r, error: shape }];
  });
}

/** Plain-language message for a refused dashboard upload (the data-plane protocols render their native errors instead). */
function hubUploadMessage(f: StorageFault): string {
  if (f.limit?.kind === 'maxObjects') return `Limit reached: ${f.limit.max} file${f.limit.max === 1 ? '' : 's'}`;
  if (f.kind === 'quota_exceeded') return 'Storage quota exceeded';
  if (f.kind === 'entity_too_large') return 'File too large';
  if (f.kind === 'no_such_bucket') return 'Bucket not found (autoCreateBuckets is off)';
  return f.message ?? f.kind;
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

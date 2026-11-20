import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import { handleApns } from '../../push/apns.js';
import { FAULT_HELP, PUSH_FAULTS } from '../../push/faults.js';
import { fcmError, fcmSend, fcmToken, iidBatch, LEGACY_HINT } from '../../push/fcm.js';
import { pushFinding, PUSH_LINT_CHECKS } from '../../push/lint.js';
import type { NotificationFilter } from '../../push/repo.js';
import { EMPTY_CURSOR } from '../../push/service.js';
import { APNS_PUSH_TYPES, APNS_REASONS, FCM_ERRORS, LIMITS, type ApnsConfig, type FcmConfig, type PushInstance } from '../../push/types.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string; project: string; instance: string; '*': string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});
const CURSOR_HEADER = 'x-stubyard-cursor';

const originOf = (hub: Hub, req: FastifyRequest) => {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${hub.config.httpPort}`);
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http');
  return `${proto}://${host}`;
};

/**
 * Push notifications: the fake FCM HTTP v1 API (+ OAuth token endpoint, Instance ID topic API) and the HTTP/1.1 form of the
 * APNs provider API under /push/<project>/<instance>/…, and the control API under /api/projects/:slug/push/….
 * The real APNs transport (HTTP/2) is push/apns-server.ts.
 */
export async function registerPushRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.push) return;
  const svc = hub.push;
  const proj = (slug: string) => hub.projects.require(slug);

  // ---------------- the fake provider APIs ----------------
  const fake = async (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
    const path = '/' + (req.params['*'] ?? '');
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    // Host mode (rewritePushHost): /push/_host/<oauth2|fcm|iid>/… → find the instance from the request itself.
    if (req.params.project === '_host') return hostMode(req, reply, req.params.instance, path);
    const project = hub.projects.getBySlug(dec(req.params.project).toLowerCase());
    if (!project) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'push', unknownProject: req.params.project };
      return reply.status(404).send({ error: { code: 404, message: `stubyard has no project "${req.params.project}". Push URLs look like /push/<project>/<instance>/…`, status: 'NOT_FOUND' } });
    }
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });
    const inst = svc.repo.instanceBySlug(project.id, dec(req.params.instance).toLowerCase());
    if (!inst) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'push', project: project.slug, unknownInstance: req.params.instance };
      return reply.status(404).send({ error: { code: 404, message: `Project "${project.slug}" has no push instance "${req.params.instance}" (Providers → Push).`, status: 'NOT_FOUND' } });
    }
    if (!inst.enabled) {
      req.trafficResolved = { kind: 'push', project: project.slug, instance: inst.slug, disabled: true };
      return reply.status(503).send(inst.preset === 'apns' ? { reason: 'ServiceUnavailable' } : fcmError('UNAVAILABLE', 'The push instance is disabled in stubyard.').body);
    }
    return dispatch(req, reply, project, inst, path, originOf(hub, req));
  };

  const dispatch = async (req: FastifyRequest, reply: FastifyReply, project: Project, inst: PushInstance, path: string, origin: string) => {
    if (inst.preset === 'apns') {
      const r = handleApns(hub, {
        method: req.method,
        path,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: req.rawBody ?? Buffer.alloc(0),
        transport: 'http1',
        logId: req.trafficLogId ?? null,
        project,
        instance: inst,
        run: req.hubRun ?? null,
      });
      req.trafficResolved = r.resolved;
      if (r.hold) return holdThenClose(req, reply);
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
      if (r.status !== 200 && r.resolved.fault) req.trafficOutcome = 'forced_error';
      return reply.status(r.status).headers(r.headers).send(r.body ?? '');
    }
    // FCM
    if (req.method !== 'POST') return reply.status(405).send(fcmError('INVALID_ARGUMENT', `Method ${req.method} not allowed`, { noFcmDetail: true }).body);
    if (path === '/token') {
      const r = fcmToken(hub, req, project, inst, origin);
      req.trafficResolved = r.resolved;
      return reply.status(r.status).send(r.body);
    }
    const send = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(path);
    if (send) {
      let fcmProject: string;
      try {
        fcmProject = decodeURIComponent(send[1]);
      } catch {
        return reply.status(400).send(fcmError('INVALID_ARGUMENT', 'Invalid project id in the URL (bad % escape).', { noFcmDetail: true }).body);
      }
      const r = fcmSend(hub, req, project, inst, fcmProject);
      req.trafficResolved = r.resolved;
      if (r.hold) return holdThenClose(req, reply);
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
      if (r.status !== 200 && r.resolved.fault) req.trafficOutcome = 'forced_error';
      return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    }
    const iid = /^\/iid\/v1:batch(Add|Remove)$/.exec(path);
    if (iid) {
      const r = iidBatch(hub, req, project, inst, iid[1] === 'Add' ? 'add' : 'remove');
      req.trafficResolved = r.resolved;
      return reply.status(r.status).send(r.body);
    }
    if (/^\/fcm\/(send|notification)$/.test(path) || path === '/batch') {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'push', provider: 'fcm', project: project.slug, instance: inst.slug, legacy: path, lint: [pushFinding('push.fcm-legacy-api', `${path} is a legacy FCM API`)] };
      return reply.status(404).send({ error: { code: 404, message: `${path} is not served. ${LEGACY_HINT}`, status: 'NOT_FOUND' }, hint: LEGACY_HINT });
    }
    req.trafficOutcome = 'unmatched';
    return reply
      .status(404)
      .send({ error: { code: 404, message: `stubyard's fake FCM has no route ${req.method} ${path}. Served: POST /token, POST /v1/projects/<id>/messages:send, POST /iid/v1:batchAdd, POST /iid/v1:batchRemove.`, status: 'NOT_FOUND' } });
  };

  const holdThenClose = async (req: FastifyRequest, reply: FastifyReply) => {
    req.trafficOutcome = 'forced_error';
    await new Promise((r) => {
      const t = setTimeout(r, hub.config.timeoutHoldMs);
      req.raw.once('close', () => (clearTimeout(t), r(null)));
    });
    reply.raw.destroy();
    return reply;
  };

  const hostMode = async (req: FastifyRequest, reply: FastifyReply, service: string, path: string) => {
    if (service === 'oauth2') {
      const r = fcmToken(hub, req, null, null, '');
      req.trafficResolved = { ...r.resolved, hostMode: true };
      return reply.status(r.status).send(r.body);
    }
    // fcm.googleapis.com / iid.googleapis.com: the instance from the access token (or the project id in the URL).
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim() ?? null;
    const tok = svc.fcmToken(bearer);
    let inst = tok ? svc.repo.getInstance(tok.instanceId) : null;
    const pid = /^\/v1\/projects\/([^/]+)\//.exec(path)?.[1];
    if (!inst && pid) {
      const hits = svc.repo.allInstances('fcm').filter((i) => (i.config as FcmConfig).fcmProjectId === pid);
      if (hits.length === 1) inst = hits[0];
    }
    const project = inst ? hub.projects.get(inst.projectId) : null;
    if (!inst || !project) {
      req.trafficOutcome = 'unmatched';
      return reply.status(401).send({ error: { code: 401, message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.', status: 'UNAUTHENTICATED' } });
    }
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });
    return dispatch(req, reply, project, inst, path, '');
  };

  app.route<{ Params: P }>({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/push/:project/:instance/*', handler: fake });

  // ---------------- control API ----------------
  const b = '/api/projects/:slug/push';
  const run = (req: FastifyRequest, project: Project, active = false) => runParam(hub, req, project, { active });

  app.get('/api/push-reference', async () => ({
    faults: FAULT_HELP,
    faultKinds: PUSH_FAULTS,
    fcmErrors: FCM_ERRORS,
    apnsReasons: APNS_REASONS,
    apnsPushTypes: APNS_PUSH_TYPES,
    limits: LIMITS,
    lint: PUSH_LINT_CHECKS,
    apnsPort: hub.config.apnsPort || null,
    apnsTransport: hub.config.apnsPort ? (hub.tls ? 'h2 (TLS, stubyard CA)' : 'h2c') : 'disabled',
  }));

  app.get<{ Params: P }>(b, async (req) => {
    const project = proj(req.params.slug);
    const origin = originOf(hub, req);
    return {
      instances: svc.listInstances(project.id).map((i) => svc.viewInstance(i, origin)),
      devices: svc.repo.listDevices(project.id).length,
      faults: svc.repo.listRules(project.id).filter((r) => r.remaining !== 0).length,
      unread: svc.repo.unreadCounts(project.id),
      apnsPort: hub.config.apnsPort || null,
    };
  });

  // instances
  app.get<{ Params: P }>(`${b}/instances`, async (req) => {
    const project = proj(req.params.slug);
    return svc.listInstances(project.id).map((i) => svc.viewInstance(i, originOf(hub, req)));
  });
  app.post<{ Params: P }>(`${b}/instances`, async (req, reply) => {
    const project = proj(req.params.slug);
    reply.status(201);
    return svc.viewInstance(svc.createInstance(project, body(req.body)), originOf(hub, req));
  });
  app.get<{ Params: P }>(`${b}/instances/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewInstance(svc.requireInstance(project, req.params.id), originOf(hub, req));
  });
  const patchInstance = async (req: FastifyRequest<{ Params: P }>) => {
    const project = proj(req.params.slug);
    return svc.viewInstance(svc.updateInstance(project, req.params.id, body(req.body)), originOf(hub, req));
  };
  app.patch<{ Params: P }>(`${b}/instances/:id`, patchInstance);
  app.put<{ Params: P }>(`${b}/instances/:id`, patchInstance);
  app.delete<{ Params: P }>(`${b}/instances/:id`, async (req, reply) => {
    svc.deleteInstance(proj(req.params.slug), req.params.id);
    return reply.status(204).send();
  });
  app.post<{ Params: P }>(`${b}/instances/:id/rotate-key`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewInstance(svc.rotateKey(project, req.params.id), originOf(hub, req));
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/instances/:id/service-account.json`, async (req, reply) => {
    const project = proj(req.params.slug);
    const inst = svc.requireInstance(project, req.params.id);
    const sa = svc.serviceAccount(project, inst, originOf(hub, req));
    if (req.query.download !== '0') reply.header('content-disposition', `attachment; filename="${(inst.config as FcmConfig).fcmProjectId}-stubyard-service-account.json"`);
    return sa;
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/instances/:id/apns-key.p8`, async (req, reply) => {
    const project = proj(req.params.slug);
    const k = svc.apnsKeyP8(svc.requireInstance(project, req.params.id));
    if (req.query.download !== '0') reply.header('content-disposition', `attachment; filename="${k.filename}"`);
    return reply.type('application/x-pem-file').send(k.pem);
  });
  app.get<{ Params: P }>(`${b}/instances/:id/connect`, async (req) => {
    const project = proj(req.params.slug);
    return connect(hub, project, svc.requireInstance(project, req.params.id), originOf(hub, req));
  });

  // devices
  app.get<{ Params: P; Querystring: Q }>(`${b}/devices`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    const user = req.query.user && req.query.user !== 'unassigned' ? hub.users.requireRef(project.id, req.query.user, r?.id).id : undefined;
    return svc.repo.listDevices(project.id, { testUserId: user, unassigned: req.query.user === 'unassigned', platform: req.query.platform || undefined, runId: r?.id }).map((d) => svc.viewDevice(d));
  });
  app.post<{ Params: P }>(`${b}/devices`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : run(req, project, true);
    reply.status(201);
    return svc.viewDevice(svc.registerDevice(project, b0, r));
  });
  app.get<{ Params: P }>(`${b}/devices/:id`, async (req) => svc.viewDevice(svc.requireDevice(proj(req.params.slug), req.params.id)));
  const patchDevice = async (req: FastifyRequest<{ Params: P }>) => svc.viewDevice(svc.updateDevice(proj(req.params.slug), req.params.id, body(req.body)));
  app.patch<{ Params: P }>(`${b}/devices/:id`, patchDevice);
  app.put<{ Params: P }>(`${b}/devices/:id`, patchDevice);
  app.delete<{ Params: P }>(`${b}/devices/:id`, async (req, reply) => {
    svc.deleteDevice(proj(req.params.slug), req.params.id);
    return reply.status(204).send();
  });
  app.post<{ Params: P }>(`${b}/devices/:id/unregister`, async (req) => svc.viewDevice(svc.setRegistered(proj(req.params.slug), req.params.id, false)));
  app.post<{ Params: P }>(`${b}/devices/:id/register`, async (req) => svc.viewDevice(svc.setRegistered(proj(req.params.slug), req.params.id, true)));
  app.post<{ Params: P }>(`${b}/devices/:id/topics`, async (req) => {
    const b0 = body(req.body);
    return svc.viewDevice(svc.changeTopics(proj(req.params.slug), req.params.id, b0.add, b0.remove));
  });
  app.get<{ Params: P }>('/api/projects/:slug/users/:id/push-devices', async (req) => {
    const project = proj(req.params.slug);
    const user = hub.users.requireRef(project.id, req.params.id);
    return svc.repo.listDevices(project.id, { testUserId: user.id }).map((d) => svc.viewDevice(d));
  });

  // notifications
  const filterOf = (req: FastifyRequest<{ Querystring: Q }>, project: Project): NotificationFilter => {
    const q = req.query;
    const r = run(req, project);
    const f: NotificationFilter = { runId: r?.id };
    if (q.user === 'unassigned') f.unassigned = true;
    else if (q.user) f.testUserId = hub.users.requireRef(project.id, q.user, r?.id).id;
    if (q.device) f.deviceId = svc.requireDevice(project, q.device).id;
    if (q.provider) f.provider = q.provider;
    if (q.instance) f.instanceId = svc.requireInstance(project, q.instance).id;
    if (q.topic) f.topic = q.topic;
    if (q.status) f.status = q.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (q.contains) f.contains = q.contains;
    if (q.title) f.title = q.title;
    if (q.dataKey) f.dataKey = q.dataKey;
    if (q.after && q.after !== EMPTY_CURSOR) f.after = q.after;
    if (q.since) f.since = q.since;
    return f;
  };
  app.get<{ Params: P; Querystring: Q }>(`${b}/notifications`, async (req, reply) => {
    const project = proj(req.params.slug);
    const f = filterOf(req, project);
    reply.header(CURSOR_HEADER, svc.cursor(project.id, f));
    return svc.repo.listNotifications(project.id, { ...f, limit: req.query.limit ? Number(req.query.limit) : 100 }).map((n) => svc.viewNotification(n));
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/notifications/cursor`, async (req, reply) => {
    const project = proj(req.params.slug);
    const cursor = svc.cursor(project.id, filterOf(req, project));
    reply.header(CURSOR_HEADER, cursor);
    return { cursor };
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/notifications/wait`, async (req, reply) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const f = filterOf(req, project);
    const r = run(req, project);
    if (!q.status) f.status = ['delivered', 'collapsed', 'dropped'];
    // Without a cursor: notifications of the last `lookback` seconds count (default 10), inside a run since its start.
    if (!q.after && !q.since) f.since = r && q.lookback === undefined ? r.startedAt : new Date(Date.now() - Math.max(0, Number(q.lookback ?? 10)) * 1000).toISOString();
    const int = (v: string | undefined, name: string) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} must be a whole number ≥ 1`);
      return n;
    };
    const count = int(q.count, 'count');
    const exactly = int(q.exactly, 'exactly');
    if (count !== undefined && exactly !== undefined) throw new HttpError(400, 'Use either count or exactly, not both');
    const timeoutMs = Math.min(Math.max(Number(q.timeout ?? 30) || 0, 0), 120) * 1000;
    const settleMs = Math.min(Math.max(Number(q.settle ?? 2) || 0, 0), 60) * 1000;
    const res = await svc.wait(project, f, { count, exactly, settleMs, timeoutMs });
    reply.header(CURSOR_HEADER, res.cursor);
    return {
      timedOut: res.timedOut,
      ...(res.tooMany ? { error: `Expected exactly ${exactly} matching push notifications, got ${res.notifications.length}` } : {}),
      notifications: res.notifications.map((n) => svc.viewNotification(n)),
      cursor: res.cursor,
    };
  });
  app.get<{ Params: P }>(`${b}/notifications/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewNotification(svc.requireNotification(project, req.params.id), true);
  });
  app.post<{ Params: P }>(`${b}/notifications/:id/open`, async (req) => svc.open(proj(req.params.slug), req.params.id));
  app.delete<{ Params: P; Querystring: Q }>(`${b}/notifications`, async (req) => {
    const project = proj(req.params.slug);
    return { deleted: svc.deleteNotifications(project, { user: req.query.user || undefined, run: run(req, project) }) };
  });

  // faults
  app.get<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    return svc.repo.listRules(project.id, { runId: r?.id }).map((x) => svc.viewRule(x));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : run(req, project, true);
    reply.status(201);
    return svc.viewRule(svc.addFault(project, b0, r));
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    return { deleted: svc.clearFaults(project, run(req, project)) };
  });
  app.delete<{ Params: P }>(`${b}/faults/:id`, async (req, reply) => {
    svc.deleteFault(proj(req.params.slug), req.params.id);
    return reply.status(204).send();
  });
  app.post<{ Params: P }>(`${b}/reset`, async (req) => {
    const project = proj(req.params.slug);
    svc.resetProject(project.id);
    return { reset: true };
  });
}

/** Per instance: URLs, port and copy-paste snippets for the common SDKs. */
function connect(hub: Hub, project: Project, inst: PushInstance, origin: string) {
  const urls = hub.push.urls(project, inst, origin) as unknown as Record<string, string | number | null>;
  const api = `${origin}/api/projects/${project.slug}/push/instances/${inst.slug}`;
  if (inst.preset === 'fcm') {
    const c = inst.config as FcmConfig;
    return {
      preset: 'fcm',
      urls,
      serviceAccountUrl: `${api}/service-account.json`,
      env: { GOOGLE_APPLICATION_CREDENTIALS: `./${c.fcmProjectId}-stubyard-service-account.json`, FCM_BASE_URL: String(urls.base), FCM_PROJECT_ID: c.fcmProjectId },
      snippets: [
        { title: 'Download the service account', code: `curl -o ${c.fcmProjectId}-stubyard-service-account.json ${api}/service-account.json` },
        {
          title: 'Node (google-auth-library + fetch)',
          code: `import { JWT } from 'google-auth-library';
import sa from './${c.fcmProjectId}-stubyard-service-account.json' with { type: 'json' };

const base = process.env.FCM_BASE_URL ?? 'https://fcm.googleapis.com';
// google-auth-library posts to oauth2.googleapis.com: send it to stubyard's token_uri instead.
const jwt = new JWT({
  email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  transporterOptions: { fetchImplementation: (url, init) => fetch(String(url).replace('https://oauth2.googleapis.com/token', sa.token_uri), init) },
});
const { token } = await jwt.getAccessToken();
await fetch(\`\${base}/v1/projects/\${sa.project_id}/messages:send\`, {
  method: 'POST',
  headers: { authorization: \`Bearer \${token}\`, 'content-type': 'application/json' },
  body: JSON.stringify({ message: { token: deviceToken, notification: { title: 'Hi', body: 'You have a new message' }, data: { chatId: '42' } } }),
});`,
        },
        { title: 'Python (google-auth uses token_uri)', code: `from google.oauth2 import service_account
from google.auth.transport.requests import AuthorizedSession

creds = service_account.Credentials.from_service_account_file('${c.fcmProjectId}-stubyard-service-account.json', scopes=['https://www.googleapis.com/auth/firebase.messaging'])
s = AuthorizedSession(creds)
s.post('${urls.send}', json={'message': {'token': device_token, 'notification': {'title': 'Hi', 'body': 'New message'}}})` },
        { title: 'firebase-admin (host mode)', code: `# firebase-admin has no FCM base URL option: map the Google hosts to stubyard and trust its CA.
# /etc/hosts:   127.0.0.1 fcm.googleapis.com oauth2.googleapis.com iid.googleapis.com
# STUBYARD_TLS_NAMES=fcm.googleapis.com,oauth2.googleapis.com,iid.googleapis.com and NODE_EXTRA_CA_CERTS=<stubyard CA>
# then run stubyard's HTTPS on 443 (or a reverse proxy) and initialize firebase-admin with this service account.` },
        { title: 'curl', code: `TOKEN=$(curl -s ${urls.tokenUri} -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer -d assertion=<signed JWT>)\ncurl ${urls.send} -H "authorization: Bearer <access_token>" -H 'content-type: application/json' \\\n  -d '{"message":{"token":"<device token>","notification":{"title":"Hi","body":"Hello"}}}'` },
      ],
    };
  }
  const c = inst.config as ApnsConfig;
  const port = hub.config.apnsPort;
  const tlsOn = !!hub.tls;
  return {
    preset: 'apns',
    urls,
    keyUrl: `${api}/apns-key.p8`,
    caUrl: `${origin}/api/ca.crt`,
    teamId: c.teamId,
    keyId: c.keyId,
    bundleIds: c.bundleIds,
    env: { APNS_HOST: 'localhost', APNS_PORT: String(port || ''), APNS_TEAM_ID: c.teamId, APNS_KEY_ID: c.keyId, APNS_KEY_FILE: `./AuthKey_${c.keyId}.p8` },
    snippets: [
      { title: 'Download the key', code: `curl -o AuthKey_${c.keyId}.p8 ${api}/apns-key.p8` },
      {
        title: '@parse/node-apn',
        code: `import apn from '@parse/node-apn';

const provider = new apn.Provider({
  token: { key: './AuthKey_${c.keyId}.p8', keyId: '${c.keyId}', teamId: '${c.teamId}' },
  production: false,
  address: 'localhost',
  port: ${port || 2197},
  ${tlsOn ? "ca: [fs.readFileSync('stubyard-ca.pem')], // or rejectUnauthorized: false" : '// stubyard runs without TLS here: node-apn needs TLS, use the /push/… HTTP route or enable TLS'}
});
const note = new apn.Notification({ alert: { title: 'Hi', body: 'New message' }, topic: '${c.bundleIds[0] ?? 'com.example.app'}', pushType: 'alert' });
await provider.send(note, deviceToken);`,
      },
      { title: 'Pushy (Java)', code: `ApnsClient client = new ApnsClientBuilder()
    .setApnsServer("localhost", ${port || 2197})
    .setTrustedServerCertificateChain(new File("stubyard-ca.pem"))
    .setSigningKey(ApnsSigningKey.loadFromPkcs8File(new File("AuthKey_${c.keyId}.p8"), "${c.teamId}", "${c.keyId}"))
    .build();` },
      { title: 'curl (HTTP/2)', code: `curl --http2-prior-knowledge${tlsOn ? '' : ''} ${tlsOn ? `--cacert stubyard-ca.pem https://localhost:${port}` : `http://localhost:${port}`}/3/device/<token> \\\n  -H "authorization: bearer <ES256 JWT>" -H 'apns-topic: ${c.bundleIds[0] ?? 'com.example.app'}' -H 'apns-push-type: alert' \\\n  -d '{"aps":{"alert":{"title":"Hi","body":"Hello"}}}'` },
      { title: 'curl (HTTP/1.1, not real APNs transport)', code: `curl ${urls.http1} -H 'apns-topic: ${c.bundleIds[0] ?? 'com.example.app'}' -d '{"aps":{"alert":"Hello"}}'` },
      { title: 'Python / Rust clients', code: '# PyAPNs2 and a2 have no host option (fixed Apple hosts): map api.sandbox.push.apple.com / api.development.push.apple.com to stubyard in /etc/hosts, add the names to STUBYARD_TLS_NAMES and trust the stubyard CA; run the APNs listener on 443 or use use_alternative_port (2197).' },
    ],
  };
}

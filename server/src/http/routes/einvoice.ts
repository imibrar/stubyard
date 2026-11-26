import crypto from 'node:crypto';
import http from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hostHttpBase } from '../../config.js';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import type { Run } from '../../repos/runs.js';
import { EINVOICE_FAULTS, FAULT_HELP, parseFault } from '../../einvoice/faults.js';
import { EINVOICE_LINT_CHECKS, lintLevel, type EinvoiceLintFinding } from '../../einvoice/lint.js';
import type { InvoiceFilter } from '../../einvoice/repo.js';
import { declaredKinds, ZATCA_ENV_TEMPLATE, ZATCA_ROUTES, type EinvoiceService } from '../../einvoice/service.js';
import { einvoiceEnv, einvoiceSnippets, einvoiceUrls, referenceSnippets } from '../../einvoice/snippets.js';
import { DOC_KINDS, ZATCA_CONFIG_DEFAULTS, ZATCA_ENVS, type Chain, type Csid, type Einvoice, type EinvoiceInstance, type EinvoiceRule, type EinvoiceRuleMatch } from '../../einvoice/types.js';
import { FIRST_PIH } from '../../einvoice/zatca/hash.js';
import { binarySecurityToken } from '../../einvoice/zatca/pki.js';
import { validationResults, type ZatcaEndpoint } from '../../einvoice/zatca/responses.js';
import { ZATCA_RULES } from '../../einvoice/zatca/rules/catalog.js';
import { BREAK_NAMES, BREAKS, demoEgs, sample, type BreakName, type Egs, type InvoiceKind, type InvoiceType } from '../../einvoice/zatca/sample.js';
import { validateInvoice } from '../../einvoice/zatca/validate.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});
const CURSOR_HEADER = 'x-stubyard-cursor';
const ENDPOINTS: readonly ZatcaEndpoint[] = ['compliance', 'compliance_invoices', 'csids', 'csids_renew', 'reporting', 'clearance'];
const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The origin of the instance URLs (view, connect, sample). app.inject() requests (MCP tools) have no real Host
 * (light-my-request sends localhost:80): they get STUBYARD_PUBLIC_URL or the host base (http://localhost:<host port>),
 * the URLs the dashboard shows when it is opened on this machine.
 */
const originOf = (hub: Hub, req: FastifyRequest) => {
  if (!(req.raw instanceof http.IncomingMessage) && !req.headers['x-forwarded-host']) return hub.config.publicUrl || hostHttpBase(hub.config);
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${hub.config.httpPort}`);
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http');
  return `${proto}://${host}`;
};

/** The demo EGS unit of an instance (for POST /sample): memory only, re-created when the instance CA changes. */
interface DemoEgs {
  egs: Egs;
  caCertPem: string;
  csid: Csid;
}

/**
 * E-invoicing control API under /api/projects/:slug/einvoice/… and GET /api/einvoice-reference. Auth and permissions
 * come from the app-wide preHandler (http/app.ts + access/permissions.ts).
 *
 * The service is a parameter because it is not on the hub yet: the wiring slice (S10) calls
 * `registerEinvoiceRoutes(app, hub, hub.einvoice)` next to `registerZatcaApi(app, hub, hub.einvoice)`.
 */
export async function registerEinvoiceRoutes(app: FastifyInstance, hub: Hub, svc: EinvoiceService): Promise<void> {
  const proj = (slug: string) => hub.projects.require(slug);
  const run = (req: FastifyRequest, project: Project, active = false) => runParam(hub, req, project, { active });
  const demo = new Map<string, DemoEgs>();

  const viewInstance = (req: FastifyRequest, project: Project, i: EinvoiceInstance) => ({ ...svc.viewInstance(i), urls: einvoiceUrls(originOf(hub, req), project, i) });
  const slugOf = (project: Project) => {
    const m = new Map(svc.listInstances(project.id).map((i) => [i.id, i.slug]));
    return (id: string | null) => (id ? (m.get(id) ?? null) : null);
  };
  const runKey = (id: string | null) => (id ? (hub.runs.repo.get(id)?.key ?? null) : null);

  const viewInvoice = (inv: Einvoice, instanceSlug: string | null, full = false) => {
    const { xml, clearedXml, ...rest } = inv;
    return { ...rest, instance: instanceSlug, run: runKey(inv.runId), hasXml: !!xml, hasClearedXml: !!clearedXml, ...(full ? { xml, clearedXml } : {}) };
  };
  const viewCsid = (c: Csid, instanceSlug: string | null, full = false) => {
    const { secretHash: _h, certPem, csrPem, ...rest } = c;
    const needed = c.kind === 'compliance' ? declaredKinds(c.invoiceTypes) : [];
    return {
      ...rest,
      instance: instanceSlug,
      run: runKey(c.runId),
      ...(c.kind === 'compliance' ? { progress: { done: needed.filter((k) => c.checks[k]).length, needed: needed.length, kinds: needed } } : {}),
      ...(full ? { certPem, csrPem } : {}),
    };
  };
  const viewChain = (c: Chain, instanceSlug: string | null) => {
    const head = c.lastInvoiceId ? svc.repo.getInvoice(c.lastInvoiceId) : null;
    return { ...c, instance: instanceSlug, lastNumber: head?.number ?? null, next: { icv: (c.lastIcv ?? 0) + 1, pih: c.lastHash ?? FIRST_PIH } };
  };
  const viewRule = (r: EinvoiceRule, instanceSlug: string | null) => ({ ...r, run: runKey(r.runId), instance: instanceSlug });

  const requireInvoice = (project: Project, id: string) => {
    const inv = svc.repo.getInvoice(id);
    if (!inv || inv.projectId !== project.id) throw new HttpError(404, `E-invoice "${id}" not found in project ${project.slug}`);
    return inv;
  };
  const requireCsid = (project: Project, id: string) => {
    const c = svc.repo.getCsid(id);
    if (!c || c.projectId !== project.id) throw new HttpError(404, `CSID "${id}" not found in project ${project.slug}`);
    return c;
  };
  const requireChain = (project: Project, id: string) => {
    const c = svc.repo.getChain(id);
    if (!c || c.projectId !== project.id) throw new HttpError(404, `EGS chain "${id}" not found in project ${project.slug}`);
    return c;
  };
  /** The instance named by `ref`, else the only (or first) instance of the project; null when there is none. */
  const pickInstance = (project: Project, ref: unknown): EinvoiceInstance | null => {
    if (ref !== undefined && ref !== null && ref !== '') return svc.getInstance(project, String(ref));
    return svc.listInstances(project.id)[0] ?? null;
  };

  /** The demo EGS of the instance, with a 'demo' CSID (accepted by reporting / clearance) so its samples can be sent. */
  const demoOf = (project: Project, inst: EinvoiceInstance): DemoEgs => {
    const caCertPem = inst.config.caCertPem;
    const caKeyPem = svc.repo.getInstance(inst.id)?.config.caKeyPem ?? inst.config.caKeyPem;
    if (!caCertPem || !caKeyPem) throw new HttpError(409, `E-invoicing instance "${inst.slug}" has no CA yet`);
    const cur = demo.get(inst.id);
    if (cur && cur.caCertPem === caCertPem && svc.repo.getCsid(cur.csid.id)?.status === 'active') return cur;
    const egs = demoEgs({ keyPem: caKeyPem, certPem: caCertPem }, { template: ZATCA_ENV_TEMPLATE[inst.config.env] });
    for (const old of svc.repo.listCsids(project.id, { instanceId: inst.id, kind: 'demo' })) svc.repo.deleteCsid(old.id);
    const secret = crypto.randomBytes(32).toString('base64');
    const csid = svc.repo.insertCsid({
      projectId: project.id,
      instanceId: inst.id,
      runId: null,
      kind: 'demo',
      requestId: String(crypto.randomInt(1e12, 1e13)),
      parentId: null,
      token: binarySecurityToken(egs.certPem),
      secretHash: sha256hex(secret),
      secret,
      certPem: egs.certPem,
      csrPem: egs.csrPem,
      commonName: 'EGS1-stubyard-demo',
      vatNumber: egs.vat,
      egsSerial: egs.egsSerial,
      orgUnit: 'Riyadh Branch',
      invoiceTypes: '1100',
      env: inst.config.env,
      expiresAt: null,
    });
    const d = { egs, caCertPem, csid };
    demo.set(inst.id, d);
    return d;
  };

  // ---------------- reference ----------------
  app.get('/api/einvoice-reference', async () => ({
    rules: ZATCA_RULES,
    faults: FAULT_HELP,
    faultKinds: EINVOICE_FAULTS,
    lint: EINVOICE_LINT_CHECKS,
    breaks: BREAK_NAMES.map((name) => ({ name, ...BREAKS[name] })),
    envs: ZATCA_ENVS.map((env) => ({ env, csrTemplate: ZATCA_ENV_TEMPLATE[env] })),
    routes: ZATCA_ROUTES,
    docKinds: DOC_KINDS,
    firstPih: FIRST_PIH,
    configDefaults: (({ caKeyPem: _k, caCertPem: _c, ...c }) => c)(ZATCA_CONFIG_DEFAULTS),
    snippets: referenceSnippets(),
  }));

  // ---------------- overview ----------------
  const b = '/api/projects/:slug/einvoice';
  app.get<{ Params: P }>(b, async (req) => {
    const project = proj(req.params.slug);
    const csids = svc.repo.listCsids(project.id, { status: 'active' });
    return {
      instances: svc.listInstances(project.id).map((i) => viewInstance(req, project, i)),
      csids: { active: csids.length, compliance: csids.filter((c) => c.kind === 'compliance').length, production: csids.filter((c) => c.kind === 'production').length },
      chains: svc.repo.listChains(project.id).length,
      faults: svc.repo.listRules(project.id).filter((r) => r.remaining !== 0).length,
      lastInvoiceAt: svc.repo.listInvoices(project.id, { limit: 1 })[0]?.createdAt ?? null,
    };
  });

  // ---------------- instances ----------------
  app.get<{ Params: P }>(`${b}/instances`, async (req) => {
    const project = proj(req.params.slug);
    return svc.listInstances(project.id).map((i) => viewInstance(req, project, i));
  });
  app.post<{ Params: P }>(`${b}/instances`, async (req, reply) => {
    const project = proj(req.params.slug);
    reply.status(201);
    return viewInstance(req, project, svc.createInstance(project, body(req.body)));
  });
  app.get<{ Params: P }>(`${b}/instances/:id`, async (req) => {
    const project = proj(req.params.slug);
    return viewInstance(req, project, svc.getInstance(project, req.params.id));
  });
  const patchInstance = async (req: FastifyRequest<{ Params: P }>) => {
    const project = proj(req.params.slug);
    return viewInstance(req, project, svc.updateInstance(project, req.params.id, body(req.body)));
  };
  app.patch<{ Params: P }>(`${b}/instances/:id`, patchInstance);
  app.put<{ Params: P }>(`${b}/instances/:id`, patchInstance);
  app.delete<{ Params: P }>(`${b}/instances/:id`, async (req, reply) => {
    const project = proj(req.params.slug);
    const inst = svc.getInstance(project, req.params.id);
    svc.deleteInstance(project, inst.id);
    demo.delete(inst.id);
    return reply.status(204).send();
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/instances/:id/otp`, async (req, reply) => {
    const project = proj(req.params.slug);
    const inst = svc.getInstance(project, req.params.id);
    reply.status(201);
    return svc.issueOtp(inst, run(req, project)?.id ?? null);
  });
  app.get<{ Params: P }>(`${b}/instances/:id/connect`, async (req) => {
    const project = proj(req.params.slug);
    const inst = svc.getInstance(project, req.params.id);
    const urls = einvoiceUrls(originOf(hub, req), project, inst);
    return {
      preset: inst.preset,
      env: inst.config.env,
      csrTemplate: ZATCA_ENV_TEMPLATE[inst.config.env],
      urls,
      dotenv: einvoiceEnv(urls, inst.config.env, inst.config.otp),
      firstPih: FIRST_PIH,
      snippets: einvoiceSnippets(urls, inst.config.env, inst.config.otp),
    };
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/instances/:id/ca.pem`, async (req, reply) => {
    const project = proj(req.params.slug);
    const inst = svc.getInstance(project, req.params.id);
    if (!inst.config.caCertPem) throw new HttpError(404, `E-invoicing instance "${inst.slug}" has no CA yet`);
    if (req.query.download !== '0') reply.header('content-disposition', `attachment; filename="${project.slug}-${inst.slug}-zatca-fake-ca.pem"`);
    return reply.type('application/x-pem-file').send(inst.config.caCertPem);
  });

  // ---------------- CSIDs ----------------
  app.get<{ Params: P; Querystring: Q }>(`${b}/csids`, async (req) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const inst = q.instance ? svc.getInstance(project, q.instance) : null;
    const slug = slugOf(project);
    return svc.repo
      .listCsids(project.id, { instanceId: inst?.id, kind: q.kind || undefined, status: q.status || undefined, runId: run(req, project)?.id })
      .map((c) => viewCsid(c, slug(c.instanceId)));
  });
  app.get<{ Params: P }>(`${b}/csids/:id`, async (req) => {
    const project = proj(req.params.slug);
    const c = requireCsid(project, req.params.id);
    return viewCsid(c, slugOf(project)(c.instanceId), true);
  });
  const setCsid = (status: 'revoked' | 'expired') => async (req: FastifyRequest<{ Params: P }>) => {
    const project = proj(req.params.slug);
    const c = requireCsid(project, req.params.id);
    const next = svc.repo.updateCsid(c.id, status === 'expired' ? { status, expiresAt: new Date().toISOString() } : { status });
    svc.changed(project.id, { csid: c.id, status });
    return viewCsid(next, slugOf(project)(c.instanceId));
  };
  app.post<{ Params: P }>(`${b}/csids/:id/revoke`, setCsid('revoked'));
  app.post<{ Params: P }>(`${b}/csids/:id/expire`, setCsid('expired'));

  // ---------------- invoices ----------------
  const filterOf = (req: FastifyRequest<{ Querystring: Q }>, project: Project, r: Run | null): InvoiceFilter => {
    const q = req.query;
    const f: InvoiceFilter = { runId: r?.id };
    if (q.instance) f.instanceId = svc.getInstance(project, q.instance).id;
    if (q.endpoint) {
      if (!ENDPOINTS.includes(q.endpoint as ZatcaEndpoint)) throw new HttpError(400, `endpoint must be one of ${ENDPOINTS.join(', ')}`);
      f.endpoint = q.endpoint;
    }
    if (q.status) f.status = q.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (q.docType) f.docType = q.docType;
    if (q.seller) f.seller = q.seller;
    if (q.number) f.number = q.number;
    if (q.after) f.after = q.after;
    if (q.since) f.since = q.since;
    return f;
  };
  const limitOf = (v: string | undefined, def: number) => {
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a whole number ≥ 1');
    return Math.min(n, 1000);
  };
  app.get<{ Params: P; Querystring: Q }>(`${b}/invoices`, async (req, reply) => {
    const project = proj(req.params.slug);
    const f = filterOf(req, project, run(req, project));
    const list = svc.repo.listInvoices(project.id, { ...f, limit: limitOf(req.query.limit, 100) });
    const newest = f.after ? null : svc.repo.listInvoices(project.id, { ...f, limit: 1 })[0];
    reply.header(CURSOR_HEADER, (newest ?? list[0])?.id ?? f.after ?? '');
    const slug = slugOf(project);
    return list.map((i) => viewInvoice(i, slug(i.instanceId)));
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/invoices/wait`, async (req, reply) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const r = run(req, project);
    const f = filterOf(req, project, r);
    // Without a cursor: invoices of the last `lookback` seconds count (default 10), inside a run since its start.
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
    const want = exactly ?? count ?? 1;
    const deadline = Date.now() + timeoutMs;
    let settleUntil: number | null = null;
    let list: Einvoice[];
    let timedOut = false;
    let tooMany = false;
    let closed = false;
    req.raw.once('close', () => (closed = true));
    for (;;) {
      list = svc.repo.listInvoices(project.id, { ...f, asc: true, limit: 500 });
      if (exactly !== undefined) {
        if (list.length > exactly) {
          tooMany = true;
          break;
        }
        if (list.length === exactly) settleUntil ??= Date.now() + settleMs;
        if (settleUntil !== null && Date.now() >= settleUntil) break;
      } else if (list.length >= want) {
        if (want === 1) list = list.slice(0, 1);
        break;
      }
      if (Date.now() >= deadline || closed) {
        timedOut = list.length < want || (exactly !== undefined && list.length !== exactly);
        break;
      }
      await new Promise((res) => setTimeout(res, Math.max(10, Math.min(200, Math.min(deadline, settleUntil ?? deadline) - Date.now()))));
    }
    const cursor = list.at(-1)?.id ?? f.after ?? '';
    reply.header(CURSOR_HEADER, cursor);
    const slug = slugOf(project);
    return {
      timedOut,
      ...(tooMany ? { error: `Expected exactly ${exactly} matching e-invoices, got ${list.length}` } : {}),
      invoices: list.map((i) => viewInvoice(i, slug(i.instanceId))),
      cursor,
    };
  });
  app.get<{ Params: P }>(`${b}/invoices/:id`, async (req) => {
    const project = proj(req.params.slug);
    const inv = requireInvoice(project, req.params.id);
    const chain = inv.chainId ? svc.repo.getChain(inv.chainId) : null;
    return { ...viewInvoice(inv, slugOf(project)(inv.instanceId), true), chain: chain ? { id: chain.id, vatNumber: chain.vatNumber, egsKey: chain.egsKey, scope: chain.scope } : null };
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/invoices/:id/xml`, async (req, reply) => {
    const project = proj(req.params.slug);
    const inv = requireInvoice(project, req.params.id);
    const cleared = req.query.cleared === '1' || req.query.cleared === 'true';
    const xml = cleared ? inv.clearedXml : inv.xml;
    if (!xml) throw new HttpError(404, cleared ? `E-invoice ${inv.number ?? inv.id} has no cleared XML` : `E-invoice ${inv.number ?? inv.id} has no XML`);
    if (req.query.download === '1') reply.header('content-disposition', `attachment; filename="${(inv.number ?? inv.id).replace(/[^\w.-]/g, '_')}${cleared ? '-cleared' : ''}.xml"`);
    return reply.type('application/xml; charset=utf-8').send(xml);
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/invoices`, async (req) => {
    const project = proj(req.params.slug);
    const inst = req.query.instance ? svc.getInstance(project, req.query.instance) : null;
    const deleted = svc.repo.deleteInvoices(project.id, { runId: run(req, project)?.id, instanceId: inst?.id });
    svc.changed(project.id, { invoicesDeleted: deleted });
    return { deleted };
  });

  // ---------------- chains ----------------
  app.get<{ Params: P; Querystring: Q }>(`${b}/chains`, async (req) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const inst = q.instance ? svc.getInstance(project, q.instance) : null;
    if (q.scope && q.scope !== 'compliance' && q.scope !== 'production') throw new HttpError(400, 'scope must be compliance or production');
    const slug = slugOf(project);
    return svc.repo.listChains(project.id, { instanceId: inst?.id, scope: (q.scope as Chain['scope']) || undefined }).map((c) => viewChain(c, slug(c.instanceId)));
  });
  app.post<{ Params: P }>(`${b}/chains/:id/reset`, async (req) => {
    const project = proj(req.params.slug);
    const c = requireChain(project, req.params.id);
    const next = svc.repo.resetChain(c.id);
    svc.changed(project.id, { chain: c.id, reset: true });
    return viewChain(next, slugOf(project)(c.instanceId));
  });

  // ---------------- faults ----------------
  app.get<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    const slug = slugOf(project);
    return svc.repo.listRules(project.id, { runId: run(req, project)?.id }).map((r) => viewRule(r, slug(r.instanceId)));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : run(req, project, true);
    const f = parseFault(b0.fault);
    const inst = b0.instance ? svc.getInstance(project, String(b0.instance)) : null;
    const match: EinvoiceRuleMatch = {};
    if (b0.endpoint) {
      if (!ENDPOINTS.includes(b0.endpoint as ZatcaEndpoint)) throw new HttpError(400, `endpoint must be one of ${ENDPOINTS.join(', ')}`);
      match.endpoint = b0.endpoint as ZatcaEndpoint;
    }
    if (b0.docType) {
      if (b0.docType !== 'standard' && b0.docType !== 'simplified') throw new HttpError(400, 'docType must be standard or simplified');
      match.docType = b0.docType;
    }
    if (b0.number) match.number = String(b0.number);
    if (b0.seller) match.seller = String(b0.seller);
    if (b0.csid) match.csid = String(b0.csid);
    let remaining: number | null = null;
    if (b0.times !== undefined && b0.times !== null && b0.times !== '') {
      remaining = Number(b0.times);
      if (!Number.isInteger(remaining) || remaining < 1) throw new HttpError(400, 'times must be a whole number ≥ 1 (leave out for every request)');
    }
    const rule = svc.repo.insertRule({ projectId: project.id, runId: r?.id ?? null, instanceId: inst?.id ?? null, match, fault: f.spec, remaining });
    svc.changed(project.id, { rule: rule.id });
    reply.status(201);
    return viewRule(rule, inst?.slug ?? null);
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    const deleted = svc.repo.deleteRules(project.id, run(req, project)?.id ?? null);
    svc.changed(project.id, { rulesCleared: deleted });
    return { deleted };
  });
  app.delete<{ Params: P }>(`${b}/faults/:id`, async (req, reply) => {
    const project = proj(req.params.slug);
    const r = svc.repo.getRule(req.params.id);
    if (!r || r.projectId !== project.id) throw new HttpError(404, `E-invoicing fault rule "${req.params.id}" not found`);
    svc.repo.deleteRule(r.id);
    svc.changed(project.id, { rule: r.id, deleted: true });
    return reply.status(204).send();
  });

  // ---------------- checks ----------------
  app.get<{ Params: P; Querystring: Q }>(`${b}/lint`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    const slug = slugOf(project);
    const invoices = svc.repo.listInvoices(project.id, { runId: r?.id, limit: 500 });
    const findings: (EinvoiceLintFinding & { invoice: string | null; number: string | null; csid: string | null; instance: string | null })[] = [];
    for (const i of invoices) for (const f of i.lint) findings.push({ ...f, invoice: i.id, number: i.number, csid: null, instance: slug(i.instanceId) });
    for (const c of svc.repo.listCsids(project.id, { runId: r?.id })) for (const f of c.lint) findings.push({ ...f, invoice: null, number: null, csid: c.id, instance: slug(c.instanceId) });
    const counts: Record<string, number> = { error: 0, warn: 0, info: 0 };
    const byCheck: Record<string, number> = {};
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
    }
    return { invoices: invoices.length, level: lintLevel(findings), counts, byCheck, findings: findings.slice(0, 200) };
  });

  app.post<{ Params: P }>(`${b}/validate`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const input = typeof b0.xml === 'string' ? b0.xml : typeof b0.invoice === 'string' ? b0.invoice : null;
    if (!input) throw new HttpError(400, 'Send the invoice as xml (XML text or base64) or invoice (base64, as in the ZATCA body)');
    if (b0.endpoint !== undefined && b0.endpoint !== null && !ENDPOINTS.includes(b0.endpoint as ZatcaEndpoint)) throw new HttpError(400, `endpoint must be one of ${ENDPOINTS.join(', ')}`);
    const inst = pickInstance(project, b0.instance);
    const v = validateInvoice({
      xml: input,
      invoiceHash: typeof b0.invoiceHash === 'string' ? b0.invoiceHash : undefined,
      uuid: typeof b0.uuid === 'string' ? b0.uuid : undefined,
      endpoint: (b0.endpoint as ZatcaEndpoint | undefined) ?? null,
      config: inst?.config ?? ZATCA_CONFIG_DEFAULTS,
      chain: null,
      nowMs: hub.clock.now(project.id, 'einvoice', run(req, project)?.id ?? null),
    });
    const results = validationResults(v.findings);
    return {
      instance: inst?.slug ?? null,
      checks: (inst?.config ?? ZATCA_CONFIG_DEFAULTS).checks,
      status: results.status,
      validationResults: results,
      findings: v.findings,
      lint: v.lint,
      lintLevel: lintLevel(v.lint),
      parsed: v.parsed,
      extracted: v.extracted,
    };
  });

  app.post<{ Params: P }>(`${b}/sample`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const inst = pickInstance(project, b0.instance);
    if (!inst) throw new HttpError(409, `Project ${project.slug} has no e-invoicing instance: create one first (Providers → E-invoicing)`);
    const type = (b0.type ?? 'simplified') as InvoiceType;
    if (type !== 'standard' && type !== 'simplified') throw new HttpError(400, 'type must be standard or simplified');
    const kind = String(b0.kind ?? '388') as InvoiceKind;
    if (!['388', '381', '383'].includes(kind)) throw new HttpError(400, 'kind must be 388 (invoice), 381 (credit note) or 383 (debit note)');
    const raw = b0.break === undefined || b0.break === null ? [] : Array.isArray(b0.break) ? b0.break : [b0.break];
    const breaks = raw.map(String);
    const unknown = breaks.filter((x) => !(x in BREAKS));
    if (unknown.length) throw new HttpError(400, `Unknown break ${unknown.join(', ')}. Use: ${BREAK_NAMES.join(', ')}`);
    const icv = b0.icv === undefined || b0.icv === null || b0.icv === '' ? 1 : Number(b0.icv);
    if (!Number.isInteger(icv) || icv < 1) throw new HttpError(400, 'icv must be a whole number ≥ 1');
    const d = demoOf(project, inst);
    const s = sample({
      type,
      kind,
      icv,
      pih: typeof b0.pih === 'string' && b0.pih ? b0.pih : undefined,
      number: typeof b0.number === 'string' && b0.number ? b0.number : `SME${String(icv).padStart(5, '0')}`,
      egs: b0.lang === 'en' ? { ...d.egs, sellerName: d.egs.sellerNameEn } : d.egs,
      issueAt: typeof b0.issueAt === 'string' && b0.issueAt ? b0.issueAt : undefined,
      billingRef: kind !== '388' ? (typeof b0.billingRef === 'string' && b0.billingRef ? b0.billingRef : 'SME00001') : undefined,
      reason: kind !== '388' ? (typeof b0.reason === 'string' && b0.reason ? b0.reason : 'Returned goods') : undefined,
      break: breaks as BreakName[],
    });
    const urls = einvoiceUrls(originOf(hub, req), project, inst);
    return {
      instance: inst.slug,
      type,
      kind,
      breaks,
      expect: s.expect,
      xml: s.xml,
      invoice: Buffer.from(s.xml, 'utf8').toString('base64'),
      invoiceHash: s.invoiceHash,
      uuid: s.uuid,
      endpoint: type === 'standard' ? urls.clearance : urls.reporting,
      egs: { vat: d.egs.vat, egsSerial: d.egs.egsSerial, certPem: d.egs.certPem },
      // The demo CSID (Basic auth) is accepted by reporting and clearance of this instance.
      auth: { binarySecurityToken: d.csid.token, secret: d.csid.secret },
    };
  });

  // ---------------- reset ----------------
  app.post<{ Params: P }>(`${b}/reset`, async (req) => {
    const project = proj(req.params.slug);
    svc.resetProject(project.id);
    return { reset: true };
  });
}

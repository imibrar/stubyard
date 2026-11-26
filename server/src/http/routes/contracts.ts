import type { FastifyInstance } from 'fastify';
import { hostHttpBase, hostHttpsBase } from '../../config.js';
import type { Hub } from '../../hub.js';
import { mockContentHash } from '../../repos/mocks.js';
import { HttpError } from '../../util.js';
import { findOperation } from '../../contracts/openapi.js';
import { SPEC_MODES, SPEC_ROLES, type SpecSummary } from '../../contracts/repo.js';
import { contractSummary } from '../../contracts/report.js';
import type { SpecImportSource } from '../../contracts/service.js';
import { CONTRACT_CHECKS, countIssues, levelOf, type CompiledOperation, type ContractSeverity, type ContractSubject, type SpecMode, type SpecRole } from '../../contracts/types.js';
import { capIssues, validateRequest, validateResponse, type ContractRequest, type ContractResponse } from '../../contracts/validate.js';
import { runParam } from './runs.js';

type P = { slug: string; spec: string };
type Q = Record<string, string | undefined>;
type Obj = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS: readonly ContractSeverity[] = ['error', 'warn', 'info'];
const SUBJECTS: readonly ContractSubject[] = ['mock-request', 'app-response', 'provider-request'];
const REMOVE_MISSING = ['disable', 'delete', 'keep'] as const;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
const flag = (v: unknown): boolean | undefined => (v === undefined || v === null || v === '' ? undefined : v === true || v === 1 || v === '1' || v === 'true');
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!allowed.includes(v as T)) throw new HttpError(400, `${field} must be one of ${allowed.join(', ')}`);
  return v as T;
}

/** The import source from a JSON body: `spec` (or `text`) with the document text, or `url`. */
function sourceOf(b: Obj, required: boolean): SpecImportSource | undefined {
  const text = str(b.spec) ?? str(b.text);
  const url = str(b.url);
  if (text !== undefined && url) throw new HttpError(400, 'Pass either the spec text or a url, not both');
  if (text !== undefined) return { kind: str(b.filename) ? 'upload' : 'inline', text, ...(str(b.filename) ? { filename: str(b.filename) } : {}) };
  if (url) return { kind: 'url', url };
  if (required) throw new HttpError(400, 'Send { "spec": "<OpenAPI JSON or YAML text>" } or { "url": "https://…/openapi.yaml" }');
  return undefined;
}

function lowerHeaders(v: unknown): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) out[k.toLowerCase()] = Array.isArray(x) ? x.map(String) : x === undefined || x === null ? undefined : String(x);
  return out;
}

/** A sample body: strings as-is, anything else as JSON (content type defaults to application/json then). */
function sampleBody(v: unknown, contentType: string | undefined): { body: string | undefined; contentType: string | undefined } {
  if (v === undefined || v === null) return { body: undefined, contentType };
  if (typeof v === 'string') return { body: v, contentType };
  return { body: JSON.stringify(v), contentType: contentType ?? 'application/json' };
}

function queryOf(v: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (typeof v === 'string') {
    for (const [k, x] of new URLSearchParams(v.replace(/^\?/, ''))) {
      const cur = out[k];
      out[k] = cur === undefined ? x : Array.isArray(cur) ? [...cur, x] : [cur, x];
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = Array.isArray(x) ? x.map(String) : String(x);
  }
  return out;
}

/** OpenAPI specs (C1 §5): import / re-import / edit / delete, the operations, ad-hoc checks and the issues summary. */
export async function registerContractRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const S = '/api/projects/:slug/contracts';
  const mockBase = (slug: string) => `${hub.config.publicUrl || (hub.tls ? hostHttpsBase(hub.config) : hostHttpBase(hub.config))}/mock/${slug}/api`;

  /** A spec summary plus its mock count, issues in the last 24 h and where its mocks answer. */
  const listItem = (projectId: string, slug: string, s: SpecSummary) => {
    const issues = contractSummary(hub, projectId, { spec: s.name, since: new Date(Date.now() - DAY_MS).toISOString(), limit: 1 });
    return {
      ...s,
      mocks: hub.mocks.listBySpec(s.id).length,
      issues24h: { checked: issues.checked, withIssues: issues.withIssues, error: issues.error, warn: issues.warn },
      mockBaseUrl: s.role === 'mock' ? mockBase(slug) + s.prefix : null,
    };
  };

  /** The spec's operations, each with the mock generated from it (if any). */
  const operationsOf = (projectId: string, ref: string) => {
    const spec = hub.contracts.get(projectId, ref);
    const mocks = new Map(hub.mocks.listBySpec(spec.id).filter((m) => m.specOperation).map((m) => [m.specOperation!, m]));
    return hub.contracts.compiled(spec).operations.map((op) => {
      const m = mocks.get(op.key);
      return {
        key: op.key,
        method: op.method.toUpperCase(),
        path: op.pathTemplate,
        operationId: op.operationId,
        summary: op.summary,
        tags: op.tags,
        deprecated: op.deprecated,
        mock: m ? { id: m.id, name: m.name, enabled: m.enabled, edited: m.specHash != null && mockContentHash(m) !== m.specHash } : null,
      };
    });
  };

  app.get(`${S}/checks`, async () => CONTRACT_CHECKS);

  app.get<{ Params: P }>(`${S}/specs`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.contracts.list(p.id).map((s) => listItem(p.id, p.slug, s));
  });

  /** Import (or, with an existing name, re-import) a spec. 201 when a spec was created, else 200; dryRun writes nothing. */
  app.post<{ Params: P }>(`${S}/specs`, async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const b = isObj(req.body) ? req.body : {};
    const source = sourceOf(b, true)!;
    const existed = typeof b.name === 'string' && b.name.trim() ? !!hub.contracts.specs.byName(p.id, b.name.trim()) : false;
    const result = await hub.contracts.import(p.id, {
      name: str(b.name),
      source,
      role: oneOf<SpecRole>(b.role, SPEC_ROLES, 'role'),
      prefix: str(b.prefix),
      mode: oneOf<SpecMode>(b.mode, SPEC_MODES, 'mode'),
      options: isObj(b.options) ? b.options : undefined,
      include: isObj(b.include) ? b.include : undefined,
      dryRun: flag(b.dryRun),
      overwriteEdited: flag(b.overwriteEdited),
      removeMissing: oneOf(b.removeMissing, REMOVE_MISSING, 'removeMissing'),
    });
    return reply.status(!result.dryRun && !existed && result.spec.id ? 201 : 200).send(result);
  });

  /** The spec without its document; ?document=1 includes it, ?download=1 sends the document as a JSON file. */
  app.get<{ Params: P; Querystring: Q }>(`${S}/specs/:spec`, async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const { document, ...spec } = hub.contracts.get(p.id, req.params.spec);
    if (flag(req.query.download)) {
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${spec.name}.openapi.json"`)
        .send(JSON.stringify(document, null, 2));
    }
    return { ...listItem(p.id, p.slug, spec), ...(flag(req.query.document) ? { document } : {}), operationList: operationsOf(p.id, spec.id) };
  });

  app.get<{ Params: P }>(`${S}/specs/:spec/operations`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    return operationsOf(p.id, req.params.spec);
  });

  /** mode, prefix, role, options, name (metadata only; mock paths follow a prefix change on the next re-import). */
  app.patch<{ Params: P }>(`${S}/specs/:spec`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = isObj(req.body) ? req.body : {};
    const { document: _d, ...spec } = hub.contracts.update(p.id, req.params.spec, {
      name: str(b.name),
      role: oneOf<SpecRole>(b.role, SPEC_ROLES, 'role'),
      prefix: str(b.prefix),
      mode: oneOf<SpecMode>(b.mode, SPEC_MODES, 'mode'),
      options: isObj(b.options) ? b.options : undefined,
    });
    return listItem(p.id, p.slug, spec);
  });

  /** Re-import: new text or url in the body, else the stored url again, else the stored document. */
  app.post<{ Params: P }>(`${S}/specs/:spec/reimport`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = isObj(req.body) ? req.body : {};
    return hub.contracts.reimport(p.id, req.params.spec, {
      source: sourceOf(b, false),
      overwriteEdited: flag(b.overwriteEdited),
      removeMissing: oneOf(b.removeMissing, REMOVE_MISSING, 'removeMissing'),
      dryRun: flag(b.dryRun),
    });
  });

  /** ?mocks=keep|delete (default keep; ?deleteMocks=1 also deletes). Kept mocks become hand-made mocks. */
  app.delete<{ Params: P; Querystring: Q }>(`${S}/specs/:spec`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    const mocks = oneOf(req.query.mocks, ['keep', 'delete'] as const, 'mocks');
    return hub.contracts.delete(p.id, req.params.spec, { deleteMocks: mocks === 'delete' || flag(req.query.deleteMocks) === true });
  });

  /**
   * Check a sample request and/or response against an operation; nothing is logged.
   * { spec, operation: "GET /users/{id}" | method + path, request?: {path?, params?, query?, headers?, body?, contentType?}, response?: {status, headers?, body?, contentType?} }
   */
  app.post<{ Params: P }>(`${S}/check`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = isObj(req.body) ? req.body : {};
    if (!str(b.spec)) throw new HttpError(400, 'spec (name or id) is required');
    if (!isObj(b.request) && !isObj(b.response)) throw new HttpError(400, 'Send a request and/or a response to check');
    const spec = hub.contracts.get(p.id, str(b.spec)!);
    const compiled = hub.contracts.compiled(spec);
    const rq = isObj(b.request) ? b.request : null;
    const rs = isObj(b.response) ? b.response : null;

    let op: CompiledOperation | undefined;
    let params: Record<string, string> = {};
    const samplePath = str(rq?.path) ?? str(b.path);
    // The sample path may include the spec prefix; operations are relative to it.
    let rel = samplePath?.split('?')[0];
    if (rel && spec.prefix && (rel === spec.prefix || rel.startsWith(spec.prefix + '/'))) rel = rel.slice(spec.prefix.length) || '/';
    if (str(b.operation)) {
      const [m, ...rest] = str(b.operation)!.trim().split(/\s+/);
      const key = `${m.toUpperCase()} ${rest.join(' ')}`;
      op = compiled.byKey.get(key) ?? compiled.operations.find((o) => o.operationId === b.operation);
      if (!op) throw new HttpError(404, `Spec "${spec.name}" has no operation "${b.operation}". Operations: ${compiled.operations.slice(0, 20).map((o) => o.key).join(', ')}`);
      if (rel) {
        const hit = op.regex.exec(rel);
        if (hit) params = Object.fromEntries(op.paramNames.map((n, i) => [n, decodeURIComponent(hit[i + 1] ?? '')]));
      }
    } else {
      const method = str(b.method) ?? str(rq?.method);
      if (!method || !rel) throw new HttpError(400, 'Pass operation ("GET /users/{id}" or an operationId), or method + path');
      const m = findOperation(compiled, method, rel);
      if (!m) throw new HttpError(404, `${method.toUpperCase()} ${rel} is not in the spec "${spec.name}"`);
      if ('methodNotAllowed' in m) throw new HttpError(404, `${method.toUpperCase()} is not allowed on ${rel} by the spec "${spec.name}" (allowed: ${m.methodNotAllowed.join(', ')})`);
      op = m.op;
      params = m.params;
    }
    if (isObj(rq?.params)) params = { ...params, ...Object.fromEntries(Object.entries(rq.params).map(([k, v]) => [k, String(v)])) };

    const result = (side: 'request' | 'response', issues: ReturnType<typeof validateRequest>) => {
      const capped = capIssues(issues);
      return { side, level: levelOf(issues), counts: countIssues(issues), issues: capped.issues, ...(capped.truncated ? { truncated: true } : {}) };
    };
    const out: Obj = { spec: spec.name, operation: { key: op.key, operationId: op.operationId, deprecated: op.deprecated } };
    if (rq) {
      const headers = lowerHeaders(rq.headers);
      const { body, contentType } = sampleBody(rq.body, str(rq.contentType) ?? (headers['content-type'] as string | undefined));
      const creq: ContractRequest = {
        method: op.method.toUpperCase(),
        path: rel ?? op.pathTemplate,
        params,
        query: queryOf(rq.query ?? (samplePath?.includes('?') ? samplePath.slice(samplePath.indexOf('?') + 1) : undefined)),
        headers: contentType ? { ...headers, 'content-type': contentType } : headers,
        body,
        contentType,
      };
      out.request = result('request', validateRequest(compiled, op, creq, spec.options));
    }
    if (rs) {
      const status = Number(rs.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new HttpError(400, 'response.status must be an HTTP status (100-599)');
      const headers = lowerHeaders(rs.headers);
      const { body, contentType } = sampleBody(rs.body, str(rs.contentType) ?? (headers['content-type'] as string | undefined));
      const cres: ContractResponse = { status, headers: contentType ? { ...headers, 'content-type': contentType } : headers, body, contentType };
      out.response = result('response', validateResponse(compiled, op, cres, spec.options));
    }
    return out;
  });

  /** ContractSummary over the project's traffic: ?run= ?since= ?until= ?level= (or minLevel) ?spec= ?subject= ?limit= */
  app.get<{ Params: P; Querystring: Q }>(`${S}/issues`, async (req) => {
    const p = hub.projects.require(req.params.slug);
    const q = req.query;
    const run = runParam(hub, req, p);
    return {
      project: p.slug,
      ...(run ? { run: run.key } : {}),
      ...contractSummary(hub, p.id, {
        runId: run?.id,
        since: q.since || undefined,
        until: q.until || undefined,
        minLevel: oneOf<ContractSeverity>(q.level ?? q.minLevel, LEVELS, 'level'),
        spec: q.spec || undefined,
        subject: oneOf<ContractSubject>(q.subject, SUBJECTS, 'subject'),
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });
}

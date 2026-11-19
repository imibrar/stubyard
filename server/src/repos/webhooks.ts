import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { assertSchema, type JsonSchema } from '../webhooks/schema.js';
import { normalizeSigning, type SigningConfig } from '../webhooks/signing.js';

export const HOOK_METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HookMethod = (typeof HOOK_METHODS)[number];

export interface EndpointResponse {
  status: number;
  headers: Record<string, string>;
  /** Body template (same variables as outbound templates + body/params/query/headers/request). */
  body: string;
  delayMs: number;
  /** Answer 400 with the validation errors instead of the configured response when the schema fails. */
  rejectInvalid: boolean;
}

export interface WebhookEndpoint {
  id: string;
  projectId: string;
  name: string;
  /** Relative to /hook/<project>/, may contain :params and a trailing *. "" = the project root. */
  path: string;
  method: HookMethod;
  schema: JsonSchema | null;
  response: EndpointResponse;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookTemplate {
  id: string;
  projectId: string;
  name: string;
  description: string;
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  signing: SigningConfig;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceStep {
  templateId: string;
  /** Wait this long after the previous step (first step: after starting the run). */
  delayMs: number;
  /** Send this step N times in a row with the identical payload (idempotency test). Default 1. */
  repeat: number;
}

export interface WebhookSequence {
  id: string;
  projectId: string;
  name: string;
  description: string;
  steps: SequenceStep[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_RESPONSE: EndpointResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"received": true}',
  delayMs: 0,
  rejectInvalid: false,
};

const MAX_DELAY_MS = 120_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function headerMap(v: unknown, field: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new HttpError(400, `${field} must be an object of header names to values`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new HttpError(400, `Invalid header name "${k}"`);
    if (x !== null && x !== undefined) out[k] = String(x);
  }
  return out;
}

/** Normalize "/payments/:id/" → "payments/:id". */
export function normalizeHookPath(p: unknown): string {
  const path = s(p).replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  const segs = path === '' ? [] : path.split('/');
  segs.forEach((seg, i) => {
    if (seg === '*' && i === segs.length - 1) return;
    if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) return;
    if (!/^[A-Za-z0-9._~@!$&'()+,;=-]+$/.test(seg)) {
      throw new HttpError(400, `Invalid path segment "${seg}". Use letters, digits, - _ . ~, :params, or a trailing *`);
    }
  });
  return segs.join('/');
}

function parseSchema(v: unknown): JsonSchema | null {
  if (v === undefined || v === null || v === '') return null;
  let schema = v;
  if (typeof v === 'string') {
    try {
      schema = JSON.parse(v);
    } catch (err) {
      throw new HttpError(400, `Schema is not valid JSON: ${(err as Error).message}`);
    }
  }
  try {
    assertSchema(schema);
  } catch (err) {
    throw new HttpError(400, `Invalid JSON Schema: ${(err as Error).message}`);
  }
  return schema as JsonSchema;
}

function parseResponse(v: unknown, base: EndpointResponse = DEFAULT_RESPONSE): EndpointResponse {
  if (v === undefined || v === null) return base;
  if (!isObj(v)) throw new HttpError(400, 'response must be an object { status, headers, body, delayMs }');
  const status = v.status === undefined ? base.status : Number(v.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new HttpError(400, 'response.status must be an HTTP status code (100-599)');
  const delayMs = v.delayMs === undefined ? base.delayMs : Number(v.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new HttpError(400, `response.delayMs must be 0-${MAX_DELAY_MS}`);
  let body = base.body;
  if (v.body !== undefined) body = v.body === null ? '' : typeof v.body === 'string' ? v.body : JSON.stringify(v.body, null, 2);
  return {
    status,
    headers: v.headers === undefined ? base.headers : headerMap(v.headers, 'response.headers'),
    body,
    delayMs: Math.round(delayMs),
    rejectInvalid: v.rejectInvalid === undefined ? base.rejectInvalid : !!v.rejectInvalid,
  };
}

function parseMethod(v: unknown, fallback: HookMethod): HookMethod {
  if (v === undefined || v === null || v === '') return fallback;
  const m = String(v).toUpperCase() as HookMethod;
  if (!HOOK_METHODS.includes(m)) throw new HttpError(400, `method must be one of ${HOOK_METHODS.join(', ')}`);
  return m;
}

function parseUrl(v: unknown): string {
  const u = s(v);
  if (!u) throw new HttpError(400, 'targetUrl is required (your app\'s webhook URL)');
  // Templated URLs (e.g. http://app/hooks/{{data.tenant}}) are checked after rendering.
  if (!u.includes('{{') && !/^https?:\/\/[^\s]+$/i.test(u)) throw new HttpError(400, 'targetUrl must be an http(s) URL');
  return u;
}

function parseSteps(v: unknown, exists: (id: string) => boolean): SequenceStep[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, 'steps must be a non-empty array of { templateId, delayMs, repeat }');
  if (v.length > 50) throw new HttpError(400, 'A sequence can have at most 50 steps');
  return v.map((x, i) => {
    if (!isObj(x)) throw new HttpError(400, `steps[${i}] must be an object`);
    const templateId = s(x.templateId ?? x.template);
    if (!templateId || !exists(templateId)) throw new HttpError(400, `steps[${i}].templateId "${templateId}" is not a template of this project`);
    const delayMs = x.delayMs === undefined ? 0 : Number(x.delayMs);
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 86_400_000) throw new HttpError(400, `steps[${i}].delayMs must be 0-86400000`);
    const repeat = x.repeat === undefined ? 1 : Number(x.repeat);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new HttpError(400, `steps[${i}].repeat must be 1-20`);
    return { templateId, delayMs: Math.round(delayMs), repeat };
  });
}

interface EndpointRow {
  id: string;
  project_id: string;
  name: string;
  path: string;
  method: HookMethod;
  json_schema: string | null;
  response: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}
interface TemplateRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  target_url: string;
  method: string;
  headers: string;
  body_template: string;
  signing: string;
  created_at: string;
  updated_at: string;
}
interface SequenceRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  steps: string;
  created_at: string;
  updated_at: string;
}

const toEndpoint = (r: EndpointRow): WebhookEndpoint => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  path: r.path,
  method: r.method,
  schema: parseJson<JsonSchema | null>(r.json_schema, null),
  response: { ...DEFAULT_RESPONSE, ...parseJson<Partial<EndpointResponse>>(r.response, {}) },
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toTemplate = (r: TemplateRow): WebhookTemplate => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  targetUrl: r.target_url,
  method: r.method,
  headers: parseJson(r.headers, {}),
  bodyTemplate: r.body_template,
  signing: parseJson<SigningConfig>(r.signing, { preset: 'none' }),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toSequence = (r: SequenceRow): WebhookSequence => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  steps: parseJson(r.steps, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function uniqueGuard<T>(fn: () => T, msg: string): T {
  try {
    return fn();
  } catch (err) {
    if (/UNIQUE constraint/i.test((err as Error).message)) throw new HttpError(409, msg);
    throw err;
  }
}

/** Webhook endpoints (inbound), templates (outbound) and sequences, per project. */
export class WebhookRepo {
  constructor(private db: DB) {}

  // ---------- endpoints ----------
  listEndpoints(projectId: string): WebhookEndpoint[] {
    return (this.db.prepare('SELECT * FROM webhook_endpoints WHERE project_id = ? ORDER BY path, method').all(projectId) as unknown as EndpointRow[]).map(toEndpoint);
  }

  getEndpoint(projectId: string, id: string): WebhookEndpoint | null {
    const r = this.db.prepare('SELECT * FROM webhook_endpoints WHERE project_id = ? AND id = ?').get(projectId, id) as EndpointRow | undefined;
    return r ? toEndpoint(r) : null;
  }

  requireEndpoint(projectId: string, id: string): WebhookEndpoint {
    const e = this.getEndpoint(projectId, id);
    if (!e) throw new HttpError(404, `Webhook endpoint "${id}" not found`);
    return e;
  }

  createEndpoint(projectId: string, input: Obj): WebhookEndpoint {
    const path = normalizeHookPath(input.path);
    const method = parseMethod(input.method, 'ANY');
    const schema = parseSchema(input.schema ?? input.jsonSchema);
    const response = parseResponse(input.response);
    const id = newId();
    const now = nowIso();
    uniqueGuard(
      () =>
        this.db
          .prepare('INSERT INTO webhook_endpoints (id, project_id, name, path, method, json_schema, response, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, projectId, s(input.name) || path || '/', path, method, schema === null ? null : JSON.stringify(schema), JSON.stringify(response), input.enabled === false ? 0 : 1, now, now),
      `An endpoint for ${method} /${path} already exists`,
    );
    return this.requireEndpoint(projectId, id);
  }

  updateEndpoint(projectId: string, id: string, patch: Obj): WebhookEndpoint {
    const cur = this.requireEndpoint(projectId, id);
    const path = patch.path === undefined ? cur.path : normalizeHookPath(patch.path);
    const method = parseMethod(patch.method, cur.method);
    const schemaIn = 'schema' in patch ? patch.schema : 'jsonSchema' in patch ? patch.jsonSchema : undefined;
    const schema = schemaIn === undefined ? cur.schema : parseSchema(schemaIn);
    const response = parseResponse(patch.response, cur.response);
    uniqueGuard(
      () =>
        this.db
          .prepare('UPDATE webhook_endpoints SET name = ?, path = ?, method = ?, json_schema = ?, response = ?, enabled = ?, updated_at = ? WHERE id = ?')
          .run(
            patch.name === undefined ? cur.name : s(patch.name) || path || '/',
            path,
            method,
            schema === null ? null : JSON.stringify(schema),
            JSON.stringify(response),
            patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
            nowIso(),
            id,
          ),
      `An endpoint for ${method} /${path} already exists`,
    );
    return this.requireEndpoint(projectId, id);
  }

  deleteEndpoint(projectId: string, id: string): WebhookEndpoint {
    const e = this.requireEndpoint(projectId, id);
    this.db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(id);
    return e;
  }

  /** Find the endpoint for a request path (relative to /hook/<project>/). Exact method beats ANY; literal segments beat :params. */
  matchEndpoint(projectId: string, method: string, relPath: string): { endpoint: WebhookEndpoint; params: Record<string, string> } | null {
    const reqSegs = relPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let best: { endpoint: WebhookEndpoint; params: Record<string, string>; score: number } | null = null;
    for (const e of this.listEndpoints(projectId)) {
      if (!e.enabled) continue;
      if (e.method !== 'ANY' && e.method !== method && !(e.method === 'GET' && method === 'HEAD')) continue;
      const m = matchPath(e.path, reqSegs);
      if (!m) continue;
      const score = m.score * 2 + (e.method === 'ANY' ? 0 : 1);
      if (!best || score > best.score) best = { endpoint: e, params: m.params, score };
    }
    return best ? { endpoint: best.endpoint, params: best.params } : null;
  }

  // ---------- templates ----------
  listTemplates(projectId: string): WebhookTemplate[] {
    return (this.db.prepare('SELECT * FROM webhook_templates WHERE project_id = ? ORDER BY name').all(projectId) as unknown as TemplateRow[]).map(toTemplate);
  }

  getTemplate(projectId: string, ref: string): WebhookTemplate | null {
    const r = this.db.prepare('SELECT * FROM webhook_templates WHERE project_id = ? AND (id = ? OR name = ?) ORDER BY id = ? DESC LIMIT 1').get(projectId, ref, ref, ref) as TemplateRow | undefined;
    return r ? toTemplate(r) : null;
  }

  /** By id only, any project (replays of old logs). */
  getTemplateById(id: string): WebhookTemplate | null {
    const r = this.db.prepare('SELECT * FROM webhook_templates WHERE id = ?').get(id) as TemplateRow | undefined;
    return r ? toTemplate(r) : null;
  }

  requireTemplate(projectId: string, ref: string): WebhookTemplate {
    const t = this.getTemplate(projectId, ref);
    if (!t) throw new HttpError(404, `Webhook template "${ref}" not found`);
    return t;
  }

  createTemplate(projectId: string, input: Obj): WebhookTemplate {
    const name = s(input.name);
    if (!name) throw new HttpError(400, 'Template name is required (e.g. "payment.succeeded")');
    const signing = this.signing(input.signing);
    const id = newId();
    const now = nowIso();
    uniqueGuard(
      () =>
        this.db
          .prepare('INSERT INTO webhook_templates (id, project_id, name, description, target_url, method, headers, body_template, signing, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            id, projectId, name, s(input.description), parseUrl(input.targetUrl ?? input.url), parseOutMethod(input.method, 'POST'),
            JSON.stringify(headerMap(input.headers, 'headers')), bodyText(input.bodyTemplate ?? input.body), JSON.stringify(signing), now, now,
          ),
      `A template named "${name}" already exists`,
    );
    return this.getTemplate(projectId, id)!;
  }

  updateTemplate(projectId: string, ref: string, patch: Obj): WebhookTemplate {
    const cur = this.requireTemplate(projectId, ref);
    const name = patch.name === undefined ? cur.name : s(patch.name);
    if (!name) throw new HttpError(400, 'Template name cannot be empty');
    const bodyIn = patch.bodyTemplate ?? patch.body;
    uniqueGuard(
      () =>
        this.db
          .prepare('UPDATE webhook_templates SET name = ?, description = ?, target_url = ?, method = ?, headers = ?, body_template = ?, signing = ?, updated_at = ? WHERE id = ?')
          .run(
            name,
            patch.description === undefined ? cur.description : s(patch.description),
            patch.targetUrl === undefined && patch.url === undefined ? cur.targetUrl : parseUrl(patch.targetUrl ?? patch.url),
            parseOutMethod(patch.method, cur.method),
            JSON.stringify(patch.headers === undefined ? cur.headers : headerMap(patch.headers, 'headers')),
            bodyIn === undefined ? cur.bodyTemplate : bodyText(bodyIn),
            JSON.stringify(patch.signing === undefined ? cur.signing : this.signing(patch.signing, cur.signing)),
            nowIso(),
            cur.id,
          ),
      `A template named "${name}" already exists`,
    );
    return this.getTemplate(projectId, cur.id)!;
  }

  deleteTemplate(projectId: string, ref: string): WebhookTemplate {
    const t = this.requireTemplate(projectId, ref);
    const used = this.listSequences(projectId).filter((q) => q.steps.some((st) => st.templateId === t.id));
    if (used.length) throw new HttpError(409, `Template "${t.name}" is used by sequence(s): ${used.map((q) => q.name).join(', ')}`);
    this.db.prepare('DELETE FROM webhook_templates WHERE id = ?').run(t.id);
    return t;
  }

  private signing(v: unknown, cur?: SigningConfig): SigningConfig {
    // Keep the stored secret when the client sends the config back without it.
    const merged = cur && v && typeof v === 'object' && (v as Obj).preset === cur.preset && (v as Obj).secret === undefined ? { ...cur, ...(v as Obj) } : v;
    try {
      return normalizeSigning(merged);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  // ---------- sequences ----------
  listSequences(projectId: string): WebhookSequence[] {
    return (this.db.prepare('SELECT * FROM webhook_sequences WHERE project_id = ? ORDER BY name').all(projectId) as unknown as SequenceRow[]).map(toSequence);
  }

  getSequence(projectId: string, ref: string): WebhookSequence | null {
    const r = this.db.prepare('SELECT * FROM webhook_sequences WHERE project_id = ? AND (id = ? OR name = ?) ORDER BY id = ? DESC LIMIT 1').get(projectId, ref, ref, ref) as SequenceRow | undefined;
    return r ? toSequence(r) : null;
  }

  requireSequence(projectId: string, ref: string): WebhookSequence {
    const q = this.getSequence(projectId, ref);
    if (!q) throw new HttpError(404, `Webhook sequence "${ref}" not found`);
    return q;
  }

  createSequence(projectId: string, input: Obj): WebhookSequence {
    const name = s(input.name);
    if (!name) throw new HttpError(400, 'Sequence name is required');
    const steps = parseSteps(this.resolveStepRefs(projectId, input.steps), (id) => !!this.getTemplate(projectId, id));
    const id = newId();
    const now = nowIso();
    uniqueGuard(
      () =>
        this.db
          .prepare('INSERT INTO webhook_sequences (id, project_id, name, description, steps, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, projectId, name, s(input.description), JSON.stringify(steps), now, now),
      `A sequence named "${name}" already exists`,
    );
    return this.getSequence(projectId, id)!;
  }

  updateSequence(projectId: string, ref: string, patch: Obj): WebhookSequence {
    const cur = this.requireSequence(projectId, ref);
    const name = patch.name === undefined ? cur.name : s(patch.name);
    if (!name) throw new HttpError(400, 'Sequence name cannot be empty');
    const steps = patch.steps === undefined ? cur.steps : parseSteps(this.resolveStepRefs(projectId, patch.steps), (id) => !!this.getTemplate(projectId, id));
    uniqueGuard(
      () =>
        this.db
          .prepare('UPDATE webhook_sequences SET name = ?, description = ?, steps = ?, updated_at = ? WHERE id = ?')
          .run(name, patch.description === undefined ? cur.description : s(patch.description), JSON.stringify(steps), nowIso(), cur.id),
      `A sequence named "${name}" already exists`,
    );
    return this.getSequence(projectId, cur.id)!;
  }

  deleteSequence(projectId: string, ref: string): WebhookSequence {
    const q = this.requireSequence(projectId, ref);
    this.db.prepare('DELETE FROM webhook_sequences WHERE id = ?').run(q.id);
    return q;
  }

  /** Steps may name templates by name; store ids. */
  private resolveStepRefs(projectId: string, steps: unknown): unknown {
    if (!Array.isArray(steps)) return steps;
    return steps.map((x) => {
      if (!isObj(x)) return x;
      const ref = s(x.templateId ?? x.template);
      const t = ref ? this.getTemplate(projectId, ref) : null;
      return t ? { ...x, templateId: t.id } : x;
    });
  }

  // ---------- traffic ----------
  /** Recent traffic-log ids whose resolved JSON has `key` = `value` (endpoint hits, template sends…). */
  recentLogIds(projectId: string, key: 'endpointId' | 'templateId' | 'sequenceId', value: string, limit = 25): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM traffic_logs WHERE project_id = ? AND json_extract(resolved, '$.${key}') = ? ORDER BY id DESC LIMIT ?`)
      .all(projectId, value, Math.min(Math.max(limit, 1), 200)) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Hit counts per endpoint: total, invalid, last. */
  endpointStats(projectId: string): Map<string, { hits: number; invalid: number; lastHitAt: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(resolved, '$.endpointId') AS eid, COUNT(*) AS hits,
                SUM(CASE WHEN json_extract(resolved, '$.valid') = 0 THEN 1 ELSE 0 END) AS invalid, MAX(received_at) AS last
         FROM traffic_logs WHERE project_id = ? AND direction = 'inbound' AND json_extract(resolved, '$.endpointId') IS NOT NULL GROUP BY eid`,
      )
      .all(projectId) as { eid: string; hits: number; invalid: number; last: string | null }[];
    return new Map(rows.map((r) => [r.eid, { hits: r.hits, invalid: r.invalid ?? 0, lastHitAt: r.last }]));
  }
}

function parseOutMethod(v: unknown, fallback: string): string {
  if (v === undefined || v === null || v === '') return fallback;
  const m = String(v).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new HttpError(400, 'method must be GET, POST, PUT, PATCH or DELETE');
  return m;
}

function bodyText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/** Match a pattern like "orders/:id/*" against request segments; score = number of literal segments. */
function matchPath(pattern: string, reqSegs: string[]): { params: Record<string, string>; score: number } | null {
  const pat = pattern === '' ? [] : pattern.split('/');
  const params: Record<string, string> = {};
  let score = 0;
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    if (p === '*') {
      params['*'] = reqSegs.slice(i).map(safeDecode).join('/');
      return { params, score };
    }
    const seg = reqSegs[i];
    if (seg === undefined) return null;
    if (p.startsWith(':')) params[p.slice(1)] = safeDecode(seg);
    else if (p === seg || p === safeDecode(seg)) score += 1;
    else return null;
  }
  return reqSegs.length === pat.length ? { params, score: score + 0.5 } : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

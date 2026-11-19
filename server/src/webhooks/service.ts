import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { Job } from '../jobs/scheduler.js';
import { summarize, type TrafficLogSummary } from '../repos/logs.js';
import type { Project } from '../repos/projects.js';
import type { TestUser } from '../repos/users.js';
import type { SequenceStep, WebhookSequence, WebhookTemplate } from '../repos/webhooks.js';
import { sendOutbound, type OutboundResult } from '../traffic/outbound.js';
import { HttpError } from '../util.js';
import { validateSchema, type SchemaError } from './schema.js';
import { sign, signatureHeaders, type SigningConfig } from './signing.js';
import { looksJson, newContext, render } from './template.js';

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Placeholders without a value. */
  missing: string[];
  warnings: string[];
}

export interface SendResult extends OutboundResult {
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  missing: string[];
  warnings: string[];
}

interface SendMeta {
  parentLogId?: string | null;
  user?: TestUser | null;
  sequence?: { id: string; name: string; runId: string; step: number; of: number; repeat?: number; repeats?: number };
}

interface SequenceJob {
  projectId: string;
  sequenceId: string;
  sequenceName: string;
  runId: string;
  steps: SequenceStep[];
  index: number;
  userId: string | null;
  data: unknown;
}

const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'accept-encoding', 'x-hub-request-id', 'upgrade', 'expect']);

const userVars = (u: TestUser | null | undefined) =>
  u ? { id: u.id, name: u.name, email: u.email ?? '', phone: u.phone ?? '', whatsapp: u.whatsapp ?? '', role: u.role } : null;

function findHeader(h: Record<string, string>, name: string): string | undefined {
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

function dropHeaders(h: Record<string, string>, names: string[]): Record<string, string> {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(Object.entries(h).filter(([k]) => !lower.has(k.toLowerCase())));
}

/** Webhooks: inbound endpoints (validate + respond), outbound templates (render + sign + send), sequences, replay. */
export class WebhookService {
  constructor(private hub: Hub) {
    hub.scheduler.register('webhook.sequence', (job) => this.runSequenceJob(job as unknown as Job<SequenceJob>));
  }

  // ---------------- inbound ----------------

  async handleInbound(req: FastifyRequest<{ Params: { project: string; '*'?: string } }>, reply: FastifyReply): Promise<unknown> {
    const hub = this.hub;
    const slug = decodeURIComponent(req.params.project).toLowerCase();
    const project = hub.projects.getBySlug(slug);
    if (!project) return reply.callNotFound();
    const rawPath = req.url.split('?')[0];
    const rel = rawPath.replace(/^\/hook\/[^/]+\/?/, '');
    const match = hub.webhooks.matchEndpoint(project.id, req.method, rel);
    if (!match) return reply.callNotFound();
    const { endpoint, params } = match;
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });

    // Validate
    let errors: SchemaError[] = [];
    if (req.bodyError) errors = [{ path: '', message: req.bodyError }];
    else if (endpoint.schema !== null && endpoint.schema !== true) {
      const body = coerceBody(req.body);
      errors = body === undefined ? [{ path: '', message: 'request body is empty' }] : validateSchema(endpoint.schema, body);
    }
    const valid = errors.length === 0;
    req.trafficResolved = {
      project: project.slug,
      endpoint: endpoint.name,
      endpointId: endpoint.id,
      pattern: `/${endpoint.path}`,
      ...(Object.keys(params).length ? { params } : {}),
      schema: endpoint.schema !== null,
      valid,
      ...(valid ? {} : { errors: errors.slice(0, 20) }),
    };
    if (!valid) req.trafficOutcome = 'invalid';

    const r = endpoint.response;
    if (r.delayMs > 0) await sleep(r.delayMs);

    if (!valid && r.rejectInvalid) {
      return reply.status(400).send({ error: 'Schema validation failed', endpoint: endpoint.name, errors, requestId: req.trafficLogId });
    }

    const body = coerceBody(req.body);
    const ctx = newContext({
      data: body ?? {},
      body: body ?? {},
      params,
      query: req.query ?? {},
      headers: req.headers,
      request: { id: req.trafficLogId ?? '', method: req.method, path: rawPath },
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) headers[k] = render(v, ctx).text;
    const json = looksJson(r.body, findHeader(headers, 'content-type'));
    const text = render(r.body, ctx, { json }).text;
    if (!findHeader(headers, 'content-type') && text && json) headers['content-type'] = 'application/json';
    reply.status(r.status).headers(headers);
    return reply.send(text === '' ? undefined : text);
  }

  // ---------------- outbound ----------------

  /** Render a template into a concrete request (no signing yet). */
  prepare(tpl: WebhookTemplate, opts: { user?: TestUser | null; data?: unknown; runId?: string } = {}): PreparedRequest {
    const ctx = newContext({ user: userVars(opts.user), data: opts.data ?? {} });
    if (opts.runId) ctx.run = { id: opts.runId };
    const missing: string[] = [];
    const warnings: string[] = [];
    const url = render(tpl.targetUrl, ctx);
    missing.push(...url.missing);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(tpl.headers)) {
      const h = render(v, ctx);
      missing.push(...h.missing);
      headers[k] = h.text;
    }
    const json = looksJson(tpl.bodyTemplate, findHeader(headers, 'content-type'));
    const body = render(tpl.bodyTemplate, ctx, { json });
    missing.push(...body.missing);
    if (json && body.text.trim()) {
      try {
        JSON.parse(body.text);
      } catch (err) {
        warnings.push(`Rendered body is not valid JSON: ${(err as Error).message}`);
      }
      if (!findHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    }
    if (!/^https?:\/\/[^\s]+$/i.test(url.text)) throw new HttpError(400, `Target URL "${url.text}" is not an http(s) URL after filling in variables`);
    return { method: tpl.method, url: url.text, headers, body: body.text, missing: [...new Set(missing)], warnings };
  }

  /** Sign (fresh timestamp) and send a prepared request; logged as an outbound entry. */
  async dispatch(project: Project, tpl: WebhookTemplate, req: PreparedRequest, meta: SendMeta = {}): Promise<SendResult> {
    const ts = Math.floor(Date.now() / 1000);
    const headers = { ...dropHeaders(req.headers, signatureHeaders(tpl.signing)), ...sign(tpl.signing, req.body, ts) };
    const seq = meta.sequence;
    const res = await sendOutbound(this.hub.traffic, {
      projectId: project.id,
      parentLogId: meta.parentLogId ?? null,
      method: req.method,
      url: req.url,
      headers,
      body: req.method === 'GET' ? null : req.body,
      purpose: seq ? `webhook sequence "${seq.name}" step ${seq.step}/${seq.of}` : `webhook "${tpl.name}"`,
      resolved: {
        project: project.slug,
        template: tpl.name,
        templateId: tpl.id,
        signing: tpl.signing.preset,
        ...(tpl.signing.preset !== 'none' ? { signedAt: ts } : {}),
        ...(meta.user ? { user: meta.user.name, userId: meta.user.id } : {}),
        ...(seq ? { sequence: seq.name, sequenceId: seq.id, runId: seq.runId, step: seq.step, ...(seq.repeats && seq.repeats > 1 ? { repeat: `${seq.repeat}/${seq.repeats}` } : {}) } : {}),
        ...(req.missing.length ? { missingVariables: req.missing } : {}),
      },
    });
    return { ...res, request: { method: req.method, url: req.url, headers, body: req.body }, missing: req.missing, warnings: req.warnings };
  }

  async send(project: Project, tpl: WebhookTemplate, opts: { user?: TestUser | null; data?: unknown; parentLogId?: string | null } = {}): Promise<SendResult> {
    const prepared = this.prepare(tpl, opts);
    return this.dispatch(project, tpl, prepared, { user: opts.user, parentLogId: opts.parentLogId });
  }

  /** Render without sending (dashboard preview). Signature shown as it would be computed now. */
  preview(tpl: WebhookTemplate, opts: { user?: TestUser | null; data?: unknown } = {}) {
    const p = this.prepare(tpl, opts);
    return { ...p, headers: { ...dropHeaders(p.headers, signatureHeaders(tpl.signing)), ...sign(tpl.signing, p.body) } };
  }

  // ---------------- sequences ----------------

  startSequence(project: Project, seq: WebhookSequence, opts: { user?: TestUser | null; data?: unknown } = {}) {
    const runId = randomUUID();
    const payload: SequenceJob = {
      projectId: project.id,
      sequenceId: seq.id,
      sequenceName: seq.name,
      runId,
      steps: seq.steps,
      index: 0,
      userId: opts.user?.id ?? null,
      data: opts.data ?? {},
    };
    this.hub.scheduler.schedule('webhook.sequence', payload as unknown as Record<string, unknown>, { projectId: project.id, delayMs: seq.steps[0]?.delayMs ?? 0 });
    let at = 0;
    const plan = seq.steps.map((s, i) => {
      at += s.delayMs;
      const t = this.hub.webhooks.getTemplateById(s.templateId);
      return { step: i + 1, template: t?.name ?? s.templateId, templateId: s.templateId, repeat: s.repeat, atMs: at };
    });
    return { runId, sequence: seq.name, sequenceId: seq.id, steps: plan };
  }

  private async runSequenceJob(job: Job<SequenceJob>): Promise<void> {
    const p = job.payload;
    const hub = this.hub;
    const project = hub.projects.get(p.projectId);
    if (!project) return;
    const step = p.steps[p.index];
    if (!step) return;
    const tpl = hub.webhooks.getTemplateById(step.templateId);
    if (tpl) {
      const user = p.userId ? hub.users.get(p.projectId, p.userId) : null;
      // The same rendered payload for every repeat: the duplicate-delivery (idempotency) case.
      const prepared = this.prepare(tpl, { user, data: p.data, runId: p.runId });
      for (let r = 1; r <= step.repeat; r++) {
        await this.dispatch(project, tpl, prepared, {
          user,
          sequence: { id: p.sequenceId, name: p.sequenceName, runId: p.runId, step: p.index + 1, of: p.steps.length, repeat: r, repeats: step.repeat },
        });
      }
    }
    const next = p.index + 1;
    if (next < p.steps.length) {
      hub.scheduler.schedule('webhook.sequence', { ...p, index: next } as unknown as Record<string, unknown>, { projectId: p.projectId, delayMs: p.steps[next].delayMs });
    }
    if (!tpl) throw new Error(`Template ${step.templateId} no longer exists; step ${p.index + 1} skipped`);
  }

  // ---------------- replay ----------------

  async replay(
    logId: string,
    edits: { url?: string; method?: string; headers?: Record<string, string | null>; body?: unknown; resign?: boolean },
  ): Promise<OutboundResult & { parentLogId: string; resigned: boolean; request: { method: string; url: string; headers: Record<string, string>; body: string | null } }> {
    const hub = this.hub;
    const log = hub.logs.get(logId);
    if (!log) throw new HttpError(404, 'Log entry not found');
    if (log.protocol !== 'http') throw new HttpError(400, 'Only HTTP requests can be replayed');

    let url = edits.url?.trim() || '';
    if (!url) {
      if (log.direction === 'outbound') url = log.url ?? '';
      else url = `http://127.0.0.1:${hub.config.httpPort}${log.url ?? '/'}`; // captured inbound: send it to devhub again
    }
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, `Cannot replay to "${url}": not an http(s) URL`);
    const method = (edits.method || log.method || 'POST').toUpperCase();

    let headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(log.reqHeaders ?? {})) {
      if (HOP_BY_HOP.has(k.toLowerCase()) || v === undefined || v === null) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    for (const [k, v] of Object.entries(edits.headers ?? {})) {
      headers = dropHeaders(headers, [k]);
      if (v !== null && v !== undefined) headers[k] = String(v);
    }

    let body: string | null;
    if (edits.body !== undefined) body = edits.body === null ? null : typeof edits.body === 'string' ? edits.body : JSON.stringify(edits.body);
    else {
      if (log.reqTruncated) throw new HttpError(409, 'The captured body was truncated; pass the full body to replay it');
      body = log.reqBody;
    }

    const templateId = typeof log.resolved.templateId === 'string' ? log.resolved.templateId : null;
    const tpl = templateId ? hub.webhooks.getTemplateById(templateId) : null;
    const signing: SigningConfig | null = tpl && tpl.signing.preset !== 'none' ? tpl.signing : null;
    const resign = edits.resign ?? !!signing;
    if (resign && !signing) {
      throw new HttpError(400, templateId ? 'The template that signed this request was deleted or is unsigned; replay with resign: false' : 'This request was not sent from a signed template; replay with resign: false');
    }
    let signedAt: number | undefined;
    if (resign && signing) {
      signedAt = Math.floor(Date.now() / 1000);
      headers = { ...dropHeaders(headers, signatureHeaders(signing)), ...sign(signing, body ?? '', signedAt) };
    }

    const res = await sendOutbound(hub.traffic, {
      projectId: log.projectId,
      parentLogId: log.id,
      method,
      url,
      headers,
      body,
      purpose: `replay of ${log.direction === 'inbound' ? 'received request' : 'sent request'} ${log.id}`,
      resolved: {
        ...(typeof log.resolved.project === 'string' ? { project: log.resolved.project } : {}),
        replayOf: log.id,
        ...(tpl ? { template: tpl.name, templateId: tpl.id } : {}),
        resigned: !!(resign && signing),
        ...(signedAt ? { signedAt } : {}),
        edited: edits.url !== undefined || edits.method !== undefined || edits.headers !== undefined || edits.body !== undefined,
      },
    });
    return { ...res, parentLogId: log.id, resigned: !!(resign && signing), request: { method, url, headers, body } };
  }

  // ---------------- history ----------------

  recent(projectId: string, key: 'endpointId' | 'templateId' | 'sequenceId', value: string, limit = 25): TrafficLogSummary[] {
    return this.hub.webhooks
      .recentLogIds(projectId, key, value, limit)
      .map((id) => this.hub.logs.get(id))
      .filter((l) => l !== null)
      .map((l) => summarize(l));
  }
}

/** Parsed body as JSON-ish value for validation / templates. */
function coerceBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return undefined;
    const text = body.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return body;
}

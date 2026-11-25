import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db/index.js';
import type { Hub } from '../hub.js';
import type { Job } from '../jobs/scheduler.js';
import { getAdapter } from '../providers/adapters/index.js';
import type { Ctx, MockRequest, ParsedSend, ProviderAdapter, TemplateProblem, TemplateRef, WaTemplate } from '../providers/adapters/types.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import { sendOutbound } from '../traffic/outbound.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { flag } from '../verify/deliver.js';

export const TEMPLATE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'] as const;
export const TEMPLATE_QUALITIES = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;

type Row = Record<string, unknown>;

const toTemplate = (r: Row): WaTemplate => ({
  id: String(r.id),
  projectId: String(r.project_id),
  providerInstanceId: String(r.provider_instance_id),
  name: String(r.name),
  language: String(r.language),
  category: String(r.category),
  status: String(r.status),
  components: parseJson<unknown[]>(String(r.components), []),
  reason: r.reason === null ? null : String(r.reason),
  quality: String(r.quality),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/** WhatsApp message templates per provider instance. */
export class WaTemplateRepo {
  constructor(private db: DB) {}

  list(instanceId: string): WaTemplate[] {
    return (this.db.prepare('SELECT * FROM wa_templates WHERE provider_instance_id = ? ORDER BY created_at, name, language').all(instanceId) as Row[]).map(toTemplate);
  }

  get(instanceId: string, id: string): WaTemplate | null {
    const r = this.db.prepare('SELECT * FROM wa_templates WHERE provider_instance_id = ? AND id = ?').get(instanceId, id) as Row | undefined;
    return r ? toTemplate(r) : null;
  }

  byName(instanceId: string, name: string): WaTemplate[] {
    return (this.db.prepare('SELECT * FROM wa_templates WHERE provider_instance_id = ? AND name = ?').all(instanceId, name) as Row[]).map(toTemplate);
  }

  insert(t: Omit<WaTemplate, 'createdAt' | 'updatedAt' | 'reason' | 'quality'>): WaTemplate {
    const now = nowIso();
    this.db
      .prepare('INSERT INTO wa_templates (id, project_id, provider_instance_id, name, language, category, status, components, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.projectId, t.providerInstanceId, t.name, t.language, t.category, t.status, JSON.stringify(t.components ?? []), now, now);
    return this.get(t.providerInstanceId, t.id)!;
  }

  update(instanceId: string, id: string, p: { status?: string; reason?: string | null; quality?: string }): WaTemplate | null {
    const cur = this.get(instanceId, id);
    if (!cur) return null;
    this.db
      .prepare('UPDATE wa_templates SET status = ?, reason = ?, quality = ?, updated_at = ? WHERE provider_instance_id = ? AND id = ?')
      .run(p.status ?? cur.status, p.reason !== undefined ? p.reason : cur.reason, p.quality ?? cur.quality, nowIso(), instanceId, id);
    return this.get(instanceId, id);
  }

  delete(instanceId: string, ids: string[]): number {
    let n = 0;
    for (const id of ids) n += this.db.prepare('DELETE FROM wa_templates WHERE provider_instance_id = ? AND id = ?').run(instanceId, id).changes;
    return n;
  }
}

interface ReviewJob {
  instanceId: string;
  templateId: string;
}

/**
 * WhatsApp template lifecycle: create (PENDING) → approved / rejected (by hand, REST or an automatic review) → status
 * webhook to the app in the vendor's format. Template sends are checked against the instance's templates.
 */
export class WaTemplates {
  readonly repo: WaTemplateRepo;

  constructor(private hub: Hub) {
    this.repo = new WaTemplateRepo(hub.db);
    hub.scheduler.register('wa-template-review', (job) => this.autoReview(job as unknown as Job<ReviewJob>));
  }

  /** The template a send names, from the adapter or extra.templateRef. */
  ref(adapter: ProviderAdapter, parsed: ParsedSend): TemplateRef | null {
    if (adapter.templateRef) return adapter.templateRef(parsed);
    return (parsed.extra?.templateRef as TemplateRef | undefined) ?? null;
  }

  /** Why this template may not be sent (null: it may). */
  check(instance: ProviderInstance, ref: TemplateRef): TemplateProblem | null {
    let t: WaTemplate | null = null;
    if (ref.id) t = this.repo.get(instance.id, ref.id);
    if (!t && ref.name) {
      const same = this.repo.byName(instance.id, ref.name);
      t = same.find((x) => !ref.language || x.language === ref.language) ?? null;
      // The name exists, but not in this language: "does not exist in the translation".
      if (!t && same.length) return 'missing';
    }
    if (!t) return flag(instance.config.enforceTemplates) ? 'missing' : null;
    switch (t.status) {
      case 'APPROVED':
        return null;
      case 'PAUSED':
        return 'paused';
      case 'DISABLED':
        return 'disabled';
      default:
        return 'missing';
    }
  }

  /** Create a template (mock API or dashboard). Automatic review runs a moment later when configured. */
  create(project: Project, instance: ProviderInstance, adapter: ProviderAdapter, input: { name: string; language: string; category: string; components: unknown[] }): WaTemplate {
    const name = input.name.trim();
    const language = input.language.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (!language) throw new HttpError(400, 'language is required');
    if (this.repo.byName(instance.id, name).some((t) => t.language === language)) throw new HttpError(409, `Template "${name}" (${language}) already exists`);
    const category = TEMPLATE_CATEGORIES.includes(input.category.toUpperCase() as never) ? input.category.toUpperCase() : 'UTILITY';
    const t = this.repo.insert({
      id: adapter.templates?.newId() ?? String(Date.now()),
      projectId: project.id,
      providerInstanceId: instance.id,
      name,
      language,
      category,
      status: 'PENDING',
      components: input.components,
    });
    if (this.autoDecision(instance, t)) {
      this.hub.scheduler.schedule('wa-template-review', { instanceId: instance.id, templateId: t.id } satisfies ReviewJob as unknown as Record<string, unknown>, {
        projectId: project.id,
        delayMs: this.hub.config.callbackDelayMs,
      });
    }
    this.changed(project.id, instance);
    return t;
  }

  private autoDecision(instance: ProviderInstance, t: WaTemplate): { status: string; reason: string } | null {
    const pattern = str(instance.config.templateRejectPattern);
    if (pattern) {
      try {
        if (new RegExp(pattern).test(t.name)) return { status: 'REJECTED', reason: 'INVALID_FORMAT' };
      } catch {
        /* bad regex: ignored */
      }
    }
    const review = (str(instance.config.templateReview) ?? 'pending').toLowerCase();
    if (review === 'approve' || review === 'approved') return { status: 'APPROVED', reason: 'NONE' };
    if (review === 'reject' || review === 'rejected') return { status: 'REJECTED', reason: 'INVALID_FORMAT' };
    return null;
  }

  private async autoReview(job: Job<ReviewJob>): Promise<void> {
    const instance = this.hub.providers.getById(job.payload.instanceId);
    const t = instance ? this.repo.get(instance.id, job.payload.templateId) : null;
    if (!instance || !t || t.status !== 'PENDING') return;
    const d = this.autoDecision(instance, t);
    const project = this.hub.projects.get(instance.projectId);
    if (d && project) await this.setStatus(project, instance, t.id, { status: d.status, reason: d.reason });
  }

  /** Approve / reject / pause / disable a template, or change its quality rating; sends the vendor's webhook. */
  async setStatus(project: Project, instance: ProviderInstance, id: string, p: { status?: string | null; reason?: string | null; quality?: string | null }) {
    const cur = this.repo.get(instance.id, id);
    if (!cur) throw new HttpError(404, `Template ${id} not found`);
    const status = p.status ? p.status.toUpperCase() : undefined;
    if (status && !TEMPLATE_STATUSES.includes(status as never)) throw new HttpError(400, `status must be one of ${TEMPLATE_STATUSES.join(', ')}`);
    const quality = p.quality ? p.quality.toUpperCase() : undefined;
    if (quality && !TEMPLATE_QUALITIES.includes(quality as never)) throw new HttpError(400, `quality must be one of ${TEMPLATE_QUALITIES.join(', ')}`);
    const reason = status ? (status === 'REJECTED' ? (p.reason ?? 'INVALID_FORMAT') : status === 'APPROVED' ? 'NONE' : (p.reason ?? null)) : undefined;
    const t = this.repo.update(instance.id, id, { status, reason, quality })!;
    this.changed(project.id, instance);
    const webhooks: unknown[] = [];
    if (status && status !== cur.status) webhooks.push(await this.webhook(project, instance, t, { kind: 'status' }));
    if (quality && quality !== cur.quality) webhooks.push(await this.webhook(project, instance, t, { kind: 'quality', previous: cur.quality }));
    return { template: t, webhooks: webhooks.filter(Boolean) };
  }

  delete(project: Project, instance: ProviderInstance, ids: string[]): number {
    const n = this.repo.delete(instance.id, ids);
    if (n) this.changed(project.id, instance);
    return n;
  }

  private async webhook(project: Project, instance: ProviderInstance, t: WaTemplate, change: { kind: 'status' } | { kind: 'quality'; previous: string }) {
    const adapter = getAdapter(instance.preset);
    const url = str(instance.config.statusCallbackUrl);
    const call = url && adapter?.templates ? adapter.templates.statusWebhook({ project, instance, baseUrl: '' }, t, change, url) : null;
    if (!call) return null;
    const res = await sendOutbound(this.hub.traffic, {
      projectId: project.id,
      method: call.method ?? 'POST',
      url: call.url,
      headers: call.headers,
      body: call.body,
      purpose: change.kind === 'status' ? `template ${t.name} (${t.language}): ${t.status}` : `template ${t.name} (${t.language}) quality: ${t.quality}`,
      resolved: { instance: instance.slug, template: t.name, status: t.status },
    });
    return { kind: change.kind, ok: res.ok, status: res.status, error: res.error, logId: res.logId };
  }

  private changed(projectId: string, instance: ProviderInstance) {
    this.hub.bus.publish({ type: 'provider.changed', projectId, data: { templates: instance.slug } });
  }

  /** The vendor's template management API on /mock/<project>/<instance>/…. */
  async handleMock(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, adapter: ProviderAdapter, mreq: MockRequest, match: { op: string; id?: string | null; name?: string | null }, resolved: Record<string, unknown>) {
    const api = adapter.templates;
    const send = (r: { status: number; body: unknown; headers?: Record<string, string> }) => {
      if (r.status >= 400) req.trafficOutcome = 'invalid';
      return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    };
    if (!api) return send(adapter.notFound(mreq));
    resolved.api = 'whatsapp-templates';
    const inst = ctx.instance;
    switch (match.op) {
      case 'create': {
        const input = api.parseCreate(mreq, ctx);
        if ('error' in input) return send(input.error);
        try {
          const t = this.create(ctx.project, inst, adapter, input);
          resolved.template = { id: t.id, name: t.name, language: t.language };
          return send(api.created(ctx, t));
        } catch (e) {
          if (e instanceof HttpError && e.statusCode === 409) {
            req.trafficOutcome = 'invalid';
            return reply.status(400).send(duplicateError(adapter, input.name, input.language));
          }
          throw e;
        }
      }
      case 'list':
        return send(api.list(ctx, this.repo.list(inst.id), mreq));
      case 'get': {
        const t = match.id ? this.repo.get(inst.id, match.id) : null;
        return send(api.get(ctx, t, match.id ?? ''));
      }
      case 'delete': {
        const all = this.repo.list(inst.id);
        const hit = all.filter((t) => (match.id ? t.id === match.id : false) || (!match.id && match.name ? t.name === match.name : false));
        const n = this.delete(ctx.project, inst, hit.map((t) => t.id));
        resolved.deleted = n;
        return send(api.deleted(ctx, n, match.name ?? match.id ?? ''));
      }
    }
    return send(adapter.notFound(mreq));
  }
}

/** A template with this name and language exists: Meta answers code 100 subcode 2388024; others get the same shape. */
function duplicateError(adapter: ProviderAdapter, name: string, language: string): unknown {
  const message = `Content in this language already exists: a template named "${name}" in ${language} already exists.`;
  if (adapter.preset === 'meta-whatsapp' || adapter.preset === '360dialog')
    return { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 2388024, is_transient: false, error_user_title: 'Content in this language already exists', error_user_msg: message } };
  if (adapter.preset === 'gupshup') return { status: 'error', message: 'Template Already exists with same namespace and elementName and languageCode' };
  return { requestError: { serviceException: { messageId: 'BAD_REQUEST', text: message } } };
}

function str(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

import type { Hub } from '../hub.js';
import type { Project, ProjectSettings } from '../repos/projects.js';
import type { RuleInput, RuleOwner } from '../repos/rules.js';
import { HttpError } from '../util.js';

/**
 * Project configuration export / import ("devhub-project" JSON).
 *
 * The file is built from a list of SECTIONS. Each section exports rows of one kind (users, providers, rules…) and
 * knows how to import them again. Rows keep their original `id` so other sections can refer to them; on import the
 * `ids` map translates old ids to new ones (ctx.ids.set('users', oldId, newId) / ctx.ids.get('users', oldId)).
 *
 * To add a table (e.g. webhook endpoints): append a section to EXPORT_SECTIONS below, or call
 * registerExportSection({...}) from your module. Sections run in array order on import (put a section after the
 * ones it refers to) and are cleared in reverse order in "replace" mode.
 */

export const EXPORT_FORMAT = 'devhub-project';
export const EXPORT_VERSION = 1;

export class IdMap {
  private maps = new Map<string, Map<string, string>>();
  set(kind: string, oldId: string, newId: string): void {
    let m = this.maps.get(kind);
    if (!m) this.maps.set(kind, (m = new Map()));
    m.set(oldId, newId);
  }
  get(kind: string, oldId: string | null | undefined): string | null {
    if (!oldId) return null;
    return this.maps.get(kind)?.get(oldId) ?? null;
  }
}

export interface ExportContext {
  hub: Hub;
  project: Project;
  includeSecrets: boolean;
}

export interface ImportContext extends ExportContext {
  ids: IdMap;
  /** Problems that did not stop the import (e.g. a rule whose user is missing). */
  warnings: string[];
  mode: 'create' | 'replace';
}

export interface ExportSection {
  /** Key in the JSON file. */
  key: string;
  /** Contains secrets: only exported with ?secrets=1. */
  secret?: boolean;
  /** Table with a project_id column; "replace" mode empties it before importing (unless `clear` is given). */
  table?: string;
  export(ctx: ExportContext): unknown[];
  /** Import rows; return how many were created. */
  import(ctx: ImportContext, rows: Record<string, unknown>[]): number;
  clear?(ctx: ImportContext): void;
}

const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

export const EXPORT_SECTIONS: ExportSection[] = [
  {
    key: 'users',
    table: 'test_users',
    export: ({ hub, project }) =>
      hub.users.list(project.id).map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        email: u.email,
        phone: u.phone,
        whatsapp: u.whatsapp,
        marketingOptOut: u.marketingOptOut,
        notes: u.notes,
        password: u.password,
        pinned: u.pinned,
      })),
    import: (ctx, rows) => {
      // Pinned users first, in pin order, so the pinned bar comes back the same.
      const sorted = [...rows].sort((a, b) => (Number(a.pinned) || 1e9) - (Number(b.pinned) || 1e9));
      for (const r of sorted) {
        const u = ctx.hub.users.create(ctx.project.id, {
          name: String(r.name ?? ''),
          role: s(r.role) ?? undefined,
          email: s(r.email),
          phone: s(r.phone),
          whatsapp: r.whatsapp === undefined ? undefined : s(r.whatsapp),
          marketingOptOut: r.marketingOptOut === true,
          notes: String(r.notes ?? ''),
          password: s(r.password),
          pinned: Number(r.pinned) > 0,
        });
        if (r.id) ctx.ids.set('users', String(r.id), u.id);
      }
      return rows.length;
    },
  },
  {
    key: 'providers',
    table: 'provider_instances',
    export: ({ hub, project }) =>
      hub.providers.list(project.id).map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        preset: p.preset,
        channel: p.channel,
        labels: p.labels,
        isDefault: p.isDefault,
        enabled: p.enabled,
        config: p.config,
      })),
    import: (ctx, rows) => {
      for (const r of rows) {
        const p = ctx.hub.providers.create(ctx.project.id, {
          preset: String(r.preset ?? ''),
          slug: s(r.slug) ?? undefined,
          name: s(r.name) ?? undefined,
          labels: Array.isArray(r.labels) ? r.labels.map(String) : undefined,
          isDefault: typeof r.isDefault === 'boolean' ? r.isDefault : undefined,
          enabled: r.enabled !== false,
          config: r.config && typeof r.config === 'object' ? (r.config as Record<string, unknown>) : undefined,
        });
        if (r.id) ctx.ids.set('providers', String(r.id), p.id);
      }
      return rows.length;
    },
  },
  {
    key: 'rules',
    table: 'rules',
    export: ({ hub, project }) =>
      (hub.db.prepare("SELECT id FROM rules WHERE project_id = ? AND run_id IS NULL ORDER BY scope, COALESCE(test_user_id, provider_instance_id), position").all(project.id) as { id: string }[])
        .map((x) => hub.rules.get(x.id)!)
        .map((r) => ({
          scope: r.scope,
          testUserId: r.testUserId,
          providerInstanceId: r.providerInstanceId,
          channel: r.channel,
          action: r.action,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
          delayMs: r.delayMs,
          failRate: r.failRate,
          remainingCount: r.remainingCount,
          skipCount: r.skipCount,
          expiresAt: r.expiresAt,
          label: r.label,
          enabled: r.enabled,
        })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const scope = r.scope === 'instance' ? 'instance' : 'user';
        const userId = ctx.ids.get('users', s(r.testUserId));
        const instId = ctx.ids.get('providers', s(r.providerInstanceId));
        if (scope === 'user' && !userId) {
          ctx.warnings.push(`Skipped a user rule (${r.action}): its test user is not in the file`);
          continue;
        }
        if (scope === 'instance' && !instId) {
          ctx.warnings.push(`Skipped a provider rule (${r.action}): its provider instance is not in the file`);
          continue;
        }
        const owner: RuleOwner = scope === 'user' ? { scope, testUserId: userId } : { scope, providerInstanceId: instId };
        const remaining = r.remainingCount === null || r.remainingCount === undefined ? null : Number(r.remainingCount);
        const input: RuleInput = {
          channel: (s(r.channel) ?? 'all') as RuleInput['channel'],
          action: String(r.action),
          errorCode: s(r.errorCode),
          errorMessage: s(r.errorMessage),
          delayMs: r.delayMs as number | null,
          failRate: r.failRate as number | null,
          count: remaining === null ? null : Math.max(1, remaining),
          after: Number(r.skipCount) || 0,
          until: s(r.expiresAt),
          label: s(r.label),
          enabled: r.enabled !== false && remaining !== 0,
          providerInstanceId: scope === 'user' ? instId : null,
        };
        ctx.hub.rules.add(ctx.project.id, owner, input);
        n++;
      }
      return n;
    },
  },
  {
    key: 'authenticators',
    table: 'authenticators',
    secret: true,
    export: ({ hub, project }) =>
      hub.authenticators.list(project.id).map((a) => {
        const w = hub.authenticators.withSecret(project.id, a.id);
        return { label: a.label, issuer: a.issuer, account: a.account, secret: w.secret, algorithm: a.algorithm, digits: a.digits, period: a.period, testUserId: a.testUserId };
      }),
    import: (ctx, rows) => {
      for (const r of rows) {
        ctx.hub.authenticators.create(ctx.project.id, {
          label: String(r.label ?? ''),
          secret: String(r.secret ?? ''),
          issuer: s(r.issuer),
          account: s(r.account),
          algorithm: s(r.algorithm) ?? undefined,
          digits: r.digits === undefined ? undefined : Number(r.digits),
          period: r.period === undefined ? undefined : Number(r.period),
          testUserId: ctx.ids.get('users', s(r.testUserId)),
        });
      }
      return rows.length;
    },
  },
  {
    key: 'mocks',
    table: 'api_mocks',
    export: ({ hub, project }) =>
      hub.mocks.list(project.id).map((m) => ({
        name: m.name,
        description: m.description,
        method: m.method,
        path: m.path,
        match: m.match,
        scenarios: m.scenarios,
        activeScenario: m.activeScenario,
        enabled: m.enabled,
      })),
    import: (ctx, rows) => {
      for (const r of rows) ctx.hub.mocks.create(ctx.project.id, r as Parameters<Hub['mocks']['create']>[1]);
      return rows.length;
    },
  },
  {
    key: 'webhookEndpoints',
    table: 'webhook_endpoints',
    export: ({ hub, project }) =>
      hub.webhooks.listEndpoints(project.id).map((e) => ({
        name: e.name,
        path: e.path,
        method: e.method,
        schema: e.schema,
        response: e.response,
        enabled: e.enabled,
      })),
    import: (ctx, rows) => {
      for (const r of rows) ctx.hub.webhooks.createEndpoint(ctx.project.id, r);
      return rows.length;
    },
  },
  {
    key: 'webhookTemplates',
    table: 'webhook_templates',
    export: ({ hub, project, includeSecrets }) =>
      hub.webhooks.listTemplates(project.id).map((t) => ({
        name: t.name,
        description: t.description,
        targetUrl: t.targetUrl,
        method: t.method,
        headers: t.headers,
        bodyTemplate: t.bodyTemplate,
        // Signing secrets only with ?secrets=1; without them the preset is kept and the secret must be re-entered.
        signing: includeSecrets ? t.signing : { ...t.signing, secret: undefined, password: undefined },
      })),
    import: (ctx, rows) => {
      for (const r of rows) {
        const signing = (r.signing ?? { preset: 'none' }) as { preset?: string; secret?: string };
        if (signing.preset && signing.preset !== 'none' && !signing.secret) {
          ctx.warnings.push(`Webhook template "${String(r.name)}": signing secret not in the file; set it in the dashboard`);
        }
        ctx.hub.webhooks.createTemplate(ctx.project.id, r);
      }
      return rows.length;
    },
  },
  {
    key: 'webhookSequences',
    table: 'webhook_sequences',
    export: ({ hub, project }) => {
      const names = new Map(hub.webhooks.listTemplates(project.id).map((t) => [t.id, t.name]));
      // Steps refer to templates by name so the file works in another project.
      return hub.webhooks.listSequences(project.id).map((q) => ({
        name: q.name,
        description: q.description,
        steps: q.steps.map((st) => ({ ...st, templateId: names.get(st.templateId) ?? st.templateId })),
      }));
    },
    import: (ctx, rows) => {
      for (const r of rows) ctx.hub.webhooks.createSequence(ctx.project.id, r);
      return rows.length;
    },
  },
];

/** Add a section (e.g. from the webhooks module). `after` puts it right after another section's key. */
export function registerExportSection(section: ExportSection, opts: { after?: string } = {}): void {
  const existing = EXPORT_SECTIONS.findIndex((x) => x.key === section.key);
  if (existing >= 0) EXPORT_SECTIONS.splice(existing, 1);
  const at = opts.after ? EXPORT_SECTIONS.findIndex((x) => x.key === opts.after) : -1;
  if (at >= 0) EXPORT_SECTIONS.splice(at + 1, 0, section);
  else EXPORT_SECTIONS.push(section);
}

export interface ProjectExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  includesSecrets: boolean;
  project: { slug: string; name: string; description: string; settings: ProjectSettings };
  [section: string]: unknown;
}

export function exportProject(hub: Hub, project: Project, opts: { includeSecrets?: boolean } = {}): ProjectExport {
  const ctx: ExportContext = { hub, project, includeSecrets: !!opts.includeSecrets };
  const out: ProjectExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: ctx.includeSecrets,
    project: { slug: project.slug, name: project.name, description: project.description, settings: project.settings },
  };
  for (const sec of EXPORT_SECTIONS) {
    if (sec.secret && !ctx.includeSecrets) continue;
    out[sec.key] = sec.export(ctx);
  }
  return out;
}

export interface ImportOptions {
  /** Target slug (default: the slug in the file). */
  slug?: string | null;
  /** Project name for a new project (default: the name in the file). */
  name?: string | null;
  /** create = new project (409 if the slug exists); replace = overwrite the configuration of an existing project. */
  mode?: 'create' | 'replace';
}

export interface ImportResult {
  project: Project;
  mode: 'create' | 'replace';
  imported: Record<string, number>;
  warnings: string[];
}

export function importProject(hub: Hub, input: unknown, opts: ImportOptions = {}): ImportResult {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      throw new HttpError(400, `The file is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Send the exported project JSON as "json"');
  const file = data as Partial<ProjectExport>;
  if (file.format !== EXPORT_FORMAT) throw new HttpError(400, `Not a devhub project export (expected "format": "${EXPORT_FORMAT}")`);
  if (typeof file.version !== 'number' || file.version > EXPORT_VERSION) throw new HttpError(400, `Unsupported export version ${file.version}; this devhub reads up to ${EXPORT_VERSION}`);
  const meta = (file.project ?? {}) as Partial<ProjectExport['project']>;
  const mode: 'create' | 'replace' = opts.mode === 'replace' ? 'replace' : 'create';
  const slug = (opts.slug ?? meta.slug ?? '').trim().toLowerCase();
  if (!slug) throw new HttpError(400, 'No project slug: pass "slug" or use a file that has project.slug');

  return hub.db.transaction(() => {
    let project: Project;
    if (mode === 'create') {
      project = hub.projects.create({ name: opts.name || meta.name || slug, slug, description: meta.description ?? '', settings: meta.settings ?? {} });
    } else {
      project = hub.projects.require(slug);
      hub.db.prepare('UPDATE projects SET settings = ? WHERE id = ?').run(JSON.stringify(meta.settings ?? {}), project.id);
      project = hub.projects.update(slug, { name: opts.name || meta.name || project.name, description: meta.description ?? project.description });
    }
    const ctx: ImportContext = { hub, project, includeSecrets: true, ids: new IdMap(), warnings: [], mode };
    const present = EXPORT_SECTIONS.filter((sec) => Array.isArray(file[sec.key]));
    if (mode === 'replace') {
      // Sections missing from the file are left as they are.
      for (const sec of [...present].reverse()) {
        if (sec.clear) sec.clear(ctx);
        else if (sec.table) hub.db.prepare(`DELETE FROM ${sec.table} WHERE project_id = ?`).run(project.id);
      }
    }
    const imported: Record<string, number> = {};
    for (const sec of present) {
      try {
        imported[sec.key] = sec.import(ctx, file[sec.key] as Record<string, unknown>[]);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        throw new HttpError(e instanceof HttpError ? e.statusCode : 400, `Import failed in "${sec.key}": ${e.message}`);
      }
    }
    // Every project needs an email instance so SMTP works.
    if (!hub.providers.defaultFor(project.id, 'email')) {
      hub.providers.create(project.id, { preset: 'smtp', slug: hub.providers.get(project.id, 'mail') ? undefined : 'mail', name: 'SMTP', labels: ['transactional'], isDefault: true });
    }
    for (const sec of EXPORT_SECTIONS) if (!present.includes(sec) && !(sec.secret && !file.includesSecrets)) ctx.warnings.push(`The file has no "${sec.key}" section`);
    return { project: hub.projects.get(project.id)!, mode, imported, warnings: ctx.warnings };
  })();
}

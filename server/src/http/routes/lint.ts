import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { LINT_CHECKS, lintMessage, type LintChannel } from '../../lint/checks.js';
import { lintSummary } from '../../lint/report.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string };
type Q = Record<string, string | undefined>;

/** Content checks ("message lint"): the check catalogue, per-project counters and an ad-hoc check endpoint. */
export async function registerLintRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get('/api/lint/checks', async () => LINT_CHECKS);

  /** Counters per severity / check / user plus the newest messages with findings. ?user= ?run= ?since= ?limit= */
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/lint', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p);
    const disabled = new Set(p.settings.lintDisabled ?? []);
    return {
      project: p.slug,
      ...(run ? { run: run.key } : {}),
      checks: LINT_CHECKS.map((c) => ({ ...c, enabled: !disabled.has(c.id) })),
      productionDomains: p.settings.productionDomains ?? [],
      ...lintSummary(hub, p.id, {
        testUserId: req.query.user ? hub.users.requireRef(p.id, req.query.user, run?.id).id : undefined,
        runId: run?.id,
        since: req.query.since || undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    };
  });

  /**
   * Check content without sending it: { channel, subject?, text?, html?, headers?, labels?, fromName?, hasTextPart? }.
   * With ?project= the project's disabled checks and production domains apply.
   */
  app.post<{ Querystring: Q }>('/api/lint/check', async (req) => {
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const channel = String(b.channel ?? 'email') as LintChannel;
    if (!['email', 'sms', 'whatsapp'].includes(channel)) throw new HttpError(400, 'channel must be email, sms or whatsapp');
    const p = req.query.project ? hub.projects.require(req.query.project) : null;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const findings = lintMessage({
      channel,
      subject: str(b.subject),
      text: str(b.text),
      html: str(b.html),
      headers: b.headers && typeof b.headers === 'object' ? (b.headers as Record<string, string>) : null,
      hasTextPart: typeof b.hasTextPart === 'boolean' ? b.hasTextPart : b.html ? !!b.text : undefined,
      fromName: b.fromName === undefined ? undefined : str(b.fromName),
      instanceLabels: Array.isArray(b.labels) ? b.labels.map(String) : [],
      waTemplate: b.template && typeof b.template === 'object' ? (b.template as { name: string; params: (string | null)[] }) : null,
      disabled: p?.settings.lintDisabled ?? [],
      productionDomains: Array.isArray(b.productionDomains) ? b.productionDomains.map(String) : (p?.settings.productionDomains ?? []),
    });
    return { findings };
  });
}

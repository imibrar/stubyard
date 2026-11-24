import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { DEFAULT_FEATURE_LIMITS } from '../../features/service.js';
import { exportProject, importProject } from '../../maintenance/export.js';
import { factoryReset, resetAllRules } from '../../maintenance/retention.js';
import { HttpError } from '../../util.js';

type P = { slug: string };

const FACTORY_RESET_PHRASE = 'DELETE EVERYTHING';

/**
 * Body limit of POST /api/projects/import: an export carries the board's images as base64 data URLs (+33 %), up to the
 * per-project image cap, plus the rest of the configuration. Never below the app-wide limit.
 */
export function importBodyLimit(hub: Hub): number {
  const imageBytes = hub.features?.limits.projectImageBytes ?? DEFAULT_FEATURE_LIMITS.projectImageBytes;
  return Math.max(hub.config.maxEmailBytes, 1024 * 1024, Math.ceil((imageBytes * 4) / 3) + 64 * 1024 * 1024);
}

/** Storage / retention info, maintenance, factory reset, "reset all rules", project export / import. */
export async function registerSystemRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});
  const flag = (v: unknown) => v === true || v === '1' || v === 'true' || v === 'yes';

  app.get('/api/system/storage', async () => {
    const m = hub.maintenance;
    let sqlite: string | null = null;
    try {
      sqlite = (hub.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    } catch {
      /* ignore */
    }
    return {
      ...m.storage(),
      retention: { logRetentionDays: m.retentionDays, maxDbMb: hub.config.maxDbMb, intervalMs: hub.config.maintenanceIntervalMs, ...(hub.access.teams ? { auditRetentionDays: hub.config.auditRetentionDays } : {}) },
      lastRun: m.lastRun,
      versions: { node: process.version, sqlite },
      dataDir: hub.config.dataDir,
    };
  });

  /** Run the clean-up pass now (retention, size limit, auto-reset). */
  app.post('/api/system/maintenance', async () => hub.maintenance.run());

  /** Delete every project, message, email and log. Body: { "confirm": "DELETE EVERYTHING" }. The HTTPS CA is kept. */
  app.post('/api/factory-reset', async (req) => {
    if (body(req.body).confirm !== FACTORY_RESET_PHRASE) {
      throw new HttpError(400, `Factory reset deletes everything. Send { "confirm": "${FACTORY_RESET_PHRASE}" } to proceed.`);
    }
    const r = await factoryReset(hub);
    await hub.access.onFactoryReset(); // Teams mode: users stay, memberships of the deleted projects go
    req.log.warn(r, 'factory reset');
    return { ...r, keptHttpsCa: !!hub.tls };
  });

  /** "Reset all rules": every test user and provider instance of the project goes back to normal delivery. */
  app.post<{ Params: P }>('/api/projects/:slug/rules/reset', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const deleted = resetAllRules(hub, p.id);
    hub.bus.publish({ type: 'rules.changed', projectId: p.id, data: { reset: deleted } });
    return { deleted };
  });

  /** Project configuration as JSON. ?secrets=1 includes authenticator keys; ?images=0 leaves feature images out; ?download=1 sends it as a file. */
  app.get<{ Params: P; Querystring: { secrets?: string; download?: string; images?: string } }>('/api/projects/:slug/export', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const data = exportProject(hub, p, { includeSecrets: flag(req.query.secrets), includeImages: req.query.images !== '0' && req.query.images !== 'false' });
    if (flag(req.query.download)) reply.header('content-disposition', `attachment; filename="stubyard-${p.slug}.json"`);
    return data;
  });

  /** Body: { json: <export>, slug?, name?, mode?: "create" | "replace" }. The export itself may also be sent as the body. */
  app.post('/api/projects/import', { bodyLimit: importBodyLimit(hub) }, async (req, reply) => {
    const b = body(req.body);
    const json = b.json ?? (b.format ? b : undefined);
    if (json === undefined) throw new HttpError(400, 'Send { "json": <exported project>, "slug"?: "...", "mode"?: "create" | "replace" }');
    const mode = b.mode === undefined ? 'create' : String(b.mode);
    if (mode !== 'create' && mode !== 'replace') throw new HttpError(400, 'mode must be "create" or "replace"');
    const r = importProject(hub, json, { slug: b.slug ? String(b.slug) : null, name: b.name ? String(b.name) : null, mode });
    hub.bus.publish({ type: mode === 'create' ? 'project.created' : 'project.updated', projectId: r.project.id, data: r.project });
    for (const t of ['user.changed', 'provider.changed', 'rules.changed', 'authenticator.changed', 'mocks.changed', 'features.changed'] as const) {
      hub.bus.publish({ type: t, projectId: r.project.id, data: { imported: true } });
    }
    return reply.status(mode === 'create' ? 201 : 200).send(r);
  });
}

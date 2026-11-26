import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { EinvoiceService } from '../service.js';
import { httpErrorBody } from './responses.js';

type P = { project: string; instance: string; '*': string };

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The request body for the service: the parsed JSON, else the raw text (the service parses it, or treats it as {}). */
function bodyOf(req: FastifyRequest): unknown {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return b;
  const raw = req.rawBody ?? (Buffer.isBuffer(b) ? b : null);
  return raw && raw.length ? raw.toString('utf8') : null;
}

/**
 * The fake ZATCA Fatoora API under /einvoice/<project>/<instance>/<zatca path> (the real /e-invoicing/<env> segment is
 * accepted after the instance; routeOf picks it up). Every answer comes from `service.handle`; this plugin resolves
 * project + instance, applies the slow / timeout faults (holdMs, close) and fills `req.trafficResolved` for the log.
 *
 * The service is a parameter because it is not on the hub yet: the wiring slice (S10) calls
 * `registerZatcaApi(app, hub, hub.einvoice)` and adds '/einvoice/' to the traffic prefixes and the run hook (so
 * `/run/<key>/einvoice/…` sets req.hubRun).
 */
export async function registerZatcaApi(app: FastifyInstance, hub: Hub, service: EinvoiceService): Promise<void> {
  const handler = async (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
    const path = '/' + (req.params['*'] ?? '');
    const project = hub.projects.getBySlug(dec(req.params.project).toLowerCase());
    if (!project) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'einvoice', unknownProject: req.params.project };
      return reply.status(404).send({ message: `stubyard has no project "${req.params.project}". E-invoicing URLs look like /einvoice/<project>/<instance>/compliance` });
    }
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });
    const inst = service.repo.instanceBySlug(project.id, dec(req.params.instance).toLowerCase());
    if (!inst) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'einvoice', project: project.slug, unknownInstance: req.params.instance };
      return reply.status(404).send({ message: `Project "${project.slug}" has no e-invoicing instance "${req.params.instance}" (Providers → E-invoicing).` });
    }
    const base = { kind: 'einvoice', preset: inst.preset, project: project.slug, instance: inst.slug };
    if (!inst.enabled) {
      req.trafficResolved = { ...base, disabled: true };
      return reply.status(503).send(httpErrorBody(503, 'The e-invoicing instance is disabled in stubyard.'));
    }

    const a = await service.handle(project, inst, {
      method: req.method,
      path,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: bodyOf(req),
      runId: req.hubRun?.id ?? null,
      logId: req.trafficLogId ?? null,
    });
    const inv = a.resolved.invoiceId ? service.repo.getInvoice(a.resolved.invoiceId) : null;
    req.trafficResolved = {
      ...base,
      ...a.resolved,
      status: a.status,
      ...(inv ? { invoiceStatus: inv.status, number: inv.number, docType: inv.docType, typeCode: inv.typeCode } : {}),
    };
    if (!a.resolved.endpoint) req.trafficOutcome = 'unmatched';
    else if (a.resolved.fault && (a.close || a.status >= 300)) req.trafficOutcome = 'forced_error';

    if (a.close) {
      // timeout fault: hold the request (or until the client gives up), then drop the connection without an answer.
      await new Promise((r) => {
        const t = setTimeout(r, a.holdMs ?? hub.config.timeoutHoldMs);
        req.raw.once('close', () => (clearTimeout(t), r(null)));
      });
      reply.raw.destroy();
      return reply;
    }
    if (a.holdMs) await new Promise((r) => setTimeout(r, a.holdMs));
    return reply.status(a.status).headers(a.headers).send(a.body ?? '');
  };

  app.route<{ Params: P }>({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/einvoice/:project/:instance/*', handler });
}

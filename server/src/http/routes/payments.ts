import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import { DECLINE_REASONS, MAGIC_CARDS, MODIFIERS, OPEN, OTHER_TEST_CARDS, OUTCOMES, PAYMENT_STATUSES, toDecimal } from '../../payments/engine.js';
import type { GatewayCtx, Json } from '../../payments/gateway.js';
import { httpUrl, PAYMENT_LINT_CHECKS } from '../../payments/lint.js';
import { pageCsp, renderChallengePage, renderDonePage, renderFormPost, renderOtpPage, renderPayError, renderPayPage, type PageUser } from '../../payments/pages.js';
import type { Payment, PaymentInstance, PaymentMethod } from '../../payments/repo.js';
import { alnum, digits, upper } from '../../payments/common.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; inst: string; id: string; event: string; rule: string };
type Q = Record<string, string | undefined>;
const body = (b: unknown): Json => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as Json) : {});
const str = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === null || s === '' ? null : String(s);
};
const list = (v: unknown): string[] | undefined => {
  const s = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [];
  const out = s.map((x) => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
};

/** Provider refund ids (Stripe re_…, PayTabs TST…, PayPal 17 chars). */
const refundRef = (preset: string) => (preset === 'stripe-checkout' ? `re_3${alnum(24)}` : preset === 'paytabs' ? `TST${digits(13)}` : upper(17));

/**
 * Payments: control API under /api/projects/:slug/payment-instances, /payments, /payment-rules and the fake gateways
 * plus their hosted pages under /pay/<project>/<instance>/… (outside /api: apps call them with form bodies and
 * provider-style auth, browsers post the pages).
 */
export async function registerPaymentRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const svc = hub.payments;
  if (!svc) return;
  const proj = (slug: string) => hub.projects.require(slug);
  const pay = (project: Project, id: string) => svc.repo.require(project.id, id);

  // ---------- reference ----------
  app.get('/api/payment-presets', async () => ({
    presets: svc.presets(),
    statuses: PAYMENT_STATUSES,
    outcomes: OUTCOMES,
    declineReasons: DECLINE_REASONS,
    modifiers: MODIFIERS,
    magicCards: MAGIC_CARDS,
    otherTestCards: OTHER_TEST_CARDS,
    lintChecks: PAYMENT_LINT_CHECKS,
  }));

  // ---------- instances ----------
  const ib = '/api/projects/:slug/payment-instances';
  app.get<{ Params: P; Querystring: Q }>(ib, async (req) => {
    const project = proj(req.params.slug);
    return svc.repo.listInstances(project.id).map((i) => svc.viewInstance(project, i, { secrets: req.query.secrets === '1' }));
  });
  app.post<{ Params: P }>(ib, async (req, reply) => {
    const project = proj(req.params.slug);
    const inst = svc.createInstance(project, body(req.body));
    return reply.status(201).send(svc.viewInstance(project, inst, { secrets: true }));
  });
  app.get<{ Params: P; Querystring: Q }>(`${ib}/:inst`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewInstance(project, svc.repo.requireInstance(project.id, req.params.inst), { secrets: req.query.secrets === '1' });
  });
  app.patch<{ Params: P }>(`${ib}/:inst`, async (req) => {
    const project = proj(req.params.slug);
    const inst = svc.updateInstance(svc.repo.requireInstance(project.id, req.params.inst), body(req.body));
    return svc.viewInstance(project, inst);
  });
  app.delete<{ Params: P }>(`${ib}/:inst`, async (req) => {
    const project = proj(req.params.slug);
    const inst = svc.repo.requireInstance(project.id, req.params.inst);
    svc.repo.deleteInstance(inst.id);
    svc.changed(project.id, { instanceDeleted: inst.slug });
    return { deleted: inst.slug };
  });

  // ---------- payments ----------
  const pb = '/api/projects/:slug/payments';
  const filters = (project: Project, q: Json, req: FastifyRequest) => {
    const run = q.run ? hub.runs.require(project.id, String(q.run)) : runParam(hub, req, project);
    const inst = q.instance ? svc.repo.requireInstance(project.id, String(q.instance)) : null;
    const user = q.user ? hub.users.requireRef(project.id, String(q.user), run?.id) : null;
    const status = list(q.status);
    const bad = status?.find((s) => !(PAYMENT_STATUSES as readonly string[]).includes(s));
    if (bad) throw new HttpError(400, `Unknown status "${bad}". Use ${PAYMENT_STATUSES.join(', ')}`);
    return { status, runId: run?.id, instanceId: inst?.id, testUserId: user?.id, reference: str(q.reference) ?? undefined, after: str(q.after) ?? undefined };
  };
  app.get<{ Params: P; Querystring: Q }>(pb, async (req) => {
    const project = proj(req.params.slug);
    const f = filters(project, req.query as Json, req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const out = [];
    for (const p of svc.repo.list(project.id, { ...f, limit })) out.push(svc.view(await svc.touch(p)));
    return out;
  });
  app.get<{ Params: P; Querystring: Q }>(`${pb}/lint`, async (req) => {
    const project = proj(req.params.slug);
    return svc.lintReport(project, runParam(hub, req, project));
  });
  app.post<{ Params: P }>(`${pb}/wait`, async (req) => {
    const project = proj(req.params.slug);
    const b = body(req.body);
    const f = filters(project, b, req);
    const timeout = Math.min(Math.max(Number(b.timeoutMs ?? 10_000) || 10_000, 0), 60_000);
    const p = await svc.wait(project, f, timeout);
    return { payment: p ? svc.view(p, { detail: true }) : null, timedOut: !p };
  });
  app.get<{ Params: P }>(`${pb}/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.view(await svc.touch(pay(project, req.params.id)), { detail: true });
  });
  app.post<{ Params: P }>(`${pb}/:id/complete`, async (req) => {
    const project = proj(req.params.slug);
    const b = body(req.body);
    const r = await svc.complete(pay(project, req.params.id), {
      via: 'api',
      outcome: str(b.outcome),
      user: str(b.user),
      method: str(b.method),
      card: str(b.card),
      phone: str(b.phone),
      otp: str(b.otp),
    });
    return { ...r, payment: svc.view(r.payment, { detail: true }) };
  });
  app.post<{ Params: P }>(`${pb}/:id/refund`, async (req) => {
    const project = proj(req.params.slug);
    const p = pay(project, req.params.id);
    const b = body(req.body);
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : Number(b.amount);
    if (amount !== null && !Number.isFinite(amount)) throw new HttpError(400, 'amount must be a number in minor units (e.g. 500 = 5.00)');
    const inst = svc.instanceOf(p);
    const r = await svc.refund(p, amount, { providerRef: refundRef(inst.preset), reason: str(b.reason) });
    return { refundId: r.refundId, amount: r.amount, amountFormatted: `${toDecimal(r.amount, p.currency)} ${p.currency}`, payment: svc.view(r.payment, { detail: true }) };
  });
  app.post<{ Params: P }>(`${pb}/:id/expire`, async (req) => {
    const project = proj(req.params.slug);
    const p = await svc.touch(pay(project, req.params.id));
    if (!OPEN.includes(p.status)) throw new HttpError(409, `Payment is ${p.status}; only open payments can be expired`, { status: p.status });
    return svc.view(await svc.expire(p), { detail: true });
  });
  // Schedule target (action payment.webhook) and manual retry.
  app.post<{ Params: P }>(`${pb}/:id/webhooks/:event/deliver`, async (req) => {
    const project = proj(req.params.slug);
    const b = body(req.body);
    const attempt = Math.max(1, Math.min(Number(b.attempt ?? 1) || 1, 10));
    return svc.webhooks.deliver(project, pay(project, req.params.id), req.params.event, attempt);
  });
  app.post<{ Params: P }>(`${pb}/:id/webhooks/resend`, async (req) => {
    const project = proj(req.params.slug);
    const b = body(req.body);
    const ref = str(b.event) ?? str(b.id);
    if (!ref) throw new HttpError(400, 'event is required: a webhook event row id or an event type such as "checkout.session.completed"');
    return svc.webhooks.resend(project, pay(project, req.params.id), ref);
  });

  // ---------- rules ----------
  const rb = '/api/projects/:slug/payment-rules';
  app.get<{ Params: P; Querystring: Q }>(rb, async (req) => {
    const project = proj(req.params.slug);
    const run = runParam(hub, req, project);
    return svc.repo.listRules(project.id, run ? { runId: run.id } : { all: req.query.all === '1' }).map((r) => svc.ruleView(r));
  });
  app.post<{ Params: P }>(rb, async (req, reply) => {
    const project = proj(req.params.slug);
    const b = body(req.body);
    const run = b.run ? hub.runs.requireActive(project.id, String(b.run)) : runParam(hub, req, project, { active: true });
    return reply.status(201).send(svc.ruleView(svc.addRule(project, b, run)));
  });
  /** ?run=<key> (that run's rules), ?instance=, ?user=; nothing: every rule of the project. */
  app.delete<{ Params: P; Querystring: Q }>(rb, async (req) => {
    const project = proj(req.params.slug);
    const run = runParam(hub, req, project);
    const inst = req.query.instance ? svc.repo.requireInstance(project.id, req.query.instance) : null;
    const user = req.query.user ? hub.users.requireRef(project.id, req.query.user, run?.id) : null;
    const n = svc.repo.deleteRules(project.id, { runId: run?.id, instanceId: inst?.id, testUserId: user?.id });
    svc.changed(project.id, { rulesDeleted: n });
    return { deleted: n };
  });
  app.delete<{ Params: P }>(`${rb}/:rule`, async (req) => {
    const project = proj(req.params.slug);
    const r = svc.repo.getRule(req.params.rule);
    if (!r || r.projectId !== project.id) throw new HttpError(404, `Rule "${req.params.rule}" not found`);
    svc.repo.deleteRule(r.id);
    svc.changed(project.id, { rule: r.id });
    return { deleted: r.id };
  });

  // ---------- the fake gateways + hosted pages ----------
  const handler = async (req: FastifyRequest<{ Params: { project: string; instance: string; '*'?: string } }>, reply: FastifyReply) => {
    const slug = req.params.project.toLowerCase();
    const project = hub.projects.getBySlug(slug);
    const logId = req.trafficLogId;
    if (!project) {
      req.trafficResolved = { unknownProject: slug };
      return reply.status(404).send({ error: 'Unknown project', message: `stubyard has no project "${slug}". Payment URLs look like /pay/<project>/<instance>/…` });
    }
    if (logId) hub.traffic.update(logId, { projectId: project.id });
    const inst = svc.repo.getInstance(project.id, req.params.instance);
    if (!inst) {
      req.trafficResolved = { project: project.slug, unknownInstance: req.params.instance };
      return reply.status(404).send({ error: 'Unknown payment provider', message: `Project "${project.slug}" has no payment provider "${req.params.instance}" (Providers → Payments).` });
    }
    const resolved: Json = { project: project.slug, instance: inst.slug, preset: inst.preset };
    req.trafficResolved = resolved;
    if (!inst.enabled) {
      resolved.error = 'provider disabled';
      return reply.status(503).send({ error: 'Payment provider disabled', message: `${inst.slug} is disabled in stubyard` });
    }
    const path = '/' + (req.params['*'] ?? '');
    const pm = /^\/page\/([^/]+)(?:\/(complete|warning))?\/?$/.exec(path);
    if (pm) return pageRoute(req, reply, project, inst, pm[1]!, pm[2] ?? null, resolved);
    const ctx: GatewayCtx = {
      hub,
      svc,
      req,
      reply,
      project,
      inst,
      path,
      query: (req.query ?? {}) as GatewayCtx['query'],
      resolved,
      base: svc.base(project, inst),
      run: req.hubRun ?? null,
    };
    const out = await svc.gateway(inst.preset).route(ctx);
    return out === reply ? reply : out;
  };
  app.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/pay/:project/:instance/*', handler });
  app.route({ method: ['GET', 'HEAD', 'POST'], url: '/pay/:project/:instance', handler });

  const dashboard = (project: Project, p?: Payment) => `${svc.browserRoot()}/p/${project.slug}/payments${p ? `/${p.id}` : ''}`;

  async function pageRoute(req: FastifyRequest, reply: FastifyReply, project: Project, inst: PaymentInstance, id: string, action: string | null, resolved: Json) {
    const html = (status: number, s: string) => reply.status(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', pageCsp(s)).send(s);
    const p0 = svc.repo.get(id);
    if (!p0 || p0.instanceId !== inst.id) {
      resolved.error = 'unknown payment';
      return html(404, renderPayError('Payment not found', `No payment "${id}" on ${inst.slug}.`, dashboard(project)));
    }
    resolved.payment = p0.id;
    resolved.endpoint = action ? `page ${action}` : 'payment page';
    const g = svc.gateway(inst.preset);
    let p = await svc.touch(p0);
    const amount = `${toDecimal(p.amount, p.currency)} ${p.currency}`;
    const fromPost = action !== null;
    const formAction = fromPost ? 'complete' : `${p.id}/complete`;
    const warnAction = fromPost ? 'warning' : `${p.id}/warning`;
    const common = { presetId: inst.preset, presetName: g.name, amount, dashboardUrl: dashboard(project, p) };

    if (action === 'warning') {
      if (req.method !== 'POST') return reply.status(405).send({ error: 'POST only' });
      svc.realCardWarning(p, str(body(req.body).brand));
      return reply.status(204).send();
    }

    const usersFor = (): PageUser[] => {
      const runUsers = p.runId ? hub.users.listForRun(p.runId) : [];
      const project_ = hub.users.list(project.id);
      const seen = new Set<string>();
      const out: PageUser[] = [];
      for (const [u, run] of [...runUsers.map((u) => [u, true] as const), ...project_.map((u) => [u, false] as const)]) {
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        out.push({ id: u.id, name: u.name, email: u.email, phone: u.phone, run });
      }
      return out.slice(0, 200);
    };
    const methodsOf = (): PaymentMethod[] => {
      const allowed = p.providerData.methods as PaymentMethod[] | undefined;
      return allowed?.length ? g.methods.filter((m) => allowed.includes(m)) : g.methods;
    };
    const payPage = (status: number, error: string | null) =>
      html(
        status,
        renderPayPage({
          ...common,
          instance: inst.slug,
          paymentId: p.id,
          providerRef: p.providerRef,
          reference: p.reference,
          description: str((p.request as Json).cart_description) ?? (((p.providerData.lineItems as Json[] | undefined) ?? []).map((li) => String(li.description ?? '')).join(', ') || null),
          email: p.customerEmail,
          methods: methodsOf(),
          method: p.method,
          users: usersFor(),
          userId: p.testUserId,
          forced: svc.peekForced(p, p.testUserId),
          action: formAction,
          warnAction,
          error,
          run: p.runId ? (hub.runs.repo.get(p.runId)?.key ?? null) : null,
          cancellable: true,
        }),
      );
    const done = () => {
      const st = p.status;
      let ret: ReturnType<typeof g.returnTo> = null;
      try {
        ret = g.returnTo(svc, p, inst, ['paid', 'authorized', 'partially_refunded', 'refunded'].includes(st) ? 'success' : st === 'cancelled' ? 'cancelled' : 'failed');
      } catch {
        ret = null; // unparsable stored URL: "no return URL" instead of a 500
      }
      const retUrl = ret?.kind === 'redirect' ? httpUrl(ret.url) : null;
      const t =
        st === 'paid' || st === 'partially_refunded' || st === 'refunded'
          ? { tone: 'ok' as const, title: 'Payment complete', message: 'This payment went through.' }
          : st === 'authorized'
            ? { tone: 'ok' as const, title: inst.preset === 'paypal' ? 'Payment approved' : 'Payment authorised', message: p.providerData.async ? 'The payment is processing; it settles shortly.' : 'The shop captures it next.' }
            : st === 'cancelled'
              ? { tone: 'warn' as const, title: 'Payment cancelled', message: 'The buyer cancelled.' }
              : st === 'expired'
                ? { tone: 'warn' as const, title: 'Session expired', message: 'This payment page has expired.' }
                : st === 'failed'
                  ? { tone: 'bad' as const, title: 'Payment declined', message: svc.declineOf(p).message }
                  : { tone: 'info' as const, title: 'Payment open', message: 'Nothing was chosen (abandoned).' };
      return html(200, renderDonePage({ ...common, ...t, status: st, returnUrl: retUrl, noReturn: !ret || (ret.kind === 'redirect' && !retUrl) }));
    };

    if (!action) {
      if (!(req.method === 'GET' || req.method === 'HEAD')) return reply.status(405).send({ error: 'GET only' });
      if (!OPEN.includes(p.status) && !(p.status === 'failed' && g.retryOnDecline)) return done();
      p = svc.opened(p);
      return payPage(200, p.status === 'failed' ? svc.declineOf(p).message : null);
    }

    // POST …/complete (the page form).
    if (req.method !== 'POST') return reply.status(405).send({ error: 'POST only' });
    const b = body(req.body);
    const carry = { user: str(b.user), method: str(b.method), card_brand: str(b.card_brand), card_last4: str(b.card_last4), card_magic: str(b.card_magic), card_luhn: str(b.card_luhn), card_test: str(b.card_test) };
    const outcome = str(b.outcome);
    if (carry.card_magic === '3ds' && !(outcome ?? '').startsWith('3ds_') && !svc.peekForced(p, p.testUserId)) {
      return html(200, renderChallengePage({ ...common, action: 'complete', carry }));
    }
    const card = carry.card_brand ? { brand: carry.card_brand, last4: carry.card_last4, magicId: carry.card_magic, luhnValid: carry.card_luhn === '1', testCard: carry.card_test === '1' } : null;
    let r;
    try {
      r = await svc.complete(p, { via: 'page', outcome, user: carry.user, method: carry.method, card, phone: str(b.phone), otp: str(b.otp) });
    } catch (e) {
      if (e instanceof HttpError && e.statusCode < 500) {
        p = svc.repo.get(p.id) ?? p;
        if (!OPEN.includes(p.status) && !(p.status === 'failed' && g.retryOnDecline)) return done();
        return payPage(e.statusCode, e.message);
      }
      throw e;
    }
    p = r.payment;
    resolved.outcome = r.outcome;
    if (r.needsOtp) {
      const stc = p.providerData.stc as { phone?: string } | undefined;
      return html(r.otpError ? 400 : 200, renderOtpPage({ ...common, action: 'complete', phone: stc?.phone ?? str(b.phone) ?? '', carry: { outcome, user: carry.user }, error: r.otpError ?? null }));
    }
    if (r.redirect?.kind === 'redirect' && httpUrl(r.redirect.url)) return reply.redirect(r.redirect.url, 303);
    if (r.redirect?.kind === 'post' && httpUrl(r.redirect.url)) return html(200, renderFormPost(r.redirect.url, r.redirect.fields));
    if (p.status === 'failed' && g.retryOnDecline && r.declined) return payPage(402, r.declined.message);
    return done();
  }
}

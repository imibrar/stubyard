import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Json } from '../../payments/gateway.js';
import { PP_KIND, ppList, registerPpJobs, WEBHOOK_JOB } from '../../payments/paypal/billing.js';
import { disputeAction, disputeView, openDispute, resolveDispute, type SellerAction } from '../../payments/paypal/disputes.js';
import { PpError } from '../../payments/paypal/index.js';
import { advanceSubscription, BILL_JOB, billCycle, billJob, changeSubscriptionStatus, queueOutcomes, subscriptionView } from '../../payments/paypal/subscriptions.js';
import type { PaymentToken } from '../../payments/repo.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string };
type Q = Record<string, string | undefined>;
const body = (b: unknown): Json => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as Json) : {});
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** PayPal errors (422 issue …) from the shared state machines, as control-API errors. */
async function ctl<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PpError) {
      const d = ((e.body as Json).details as Json[] | undefined)?.[0];
      throw new HttpError(e.status === 422 ? 409 : e.status, String(d?.description ?? (e.body as Json).message ?? 'PayPal error'), { issue: d?.issue ?? null });
    }
    throw e;
  }
}

/**
 * Control API of PayPal subscriptions and disputes (stubyard side, not PayPal's): list / inspect, bill a cycle now,
 * move a subscription's clock ("advance"), queue billing outcomes, change status as PayPal / the buyer would, open and
 * resolve disputes, play the buyer in a dispute.
 */
export async function registerPaypalExtrasRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const svc = hub.payments;
  if (!svc) return;
  registerPpJobs(hub, { [BILL_JOB]: billJob(hub) });
  void WEBHOOK_JOB;
  const pb = '/api/projects/:slug/payments';
  const proj = (slug: string) => hub.projects.require(slug);
  const find = (projectId: string, kind: (typeof PP_KIND)[keyof typeof PP_KIND], id: string, what: string): PaymentToken => {
    const t = svc.repo.token(id) ?? ppList(svc, projectId, kind).find((x) => x.providerRef === id) ?? null;
    if (!t || t.projectId !== projectId || String(t.kind) !== kind) throw new HttpError(404, `${what} ${id} not found`);
    return t;
  };
  const instOf = (t: PaymentToken) => svc.repo.instanceById(t.instanceId)!;
  const listOf = (projectId: string, kind: (typeof PP_KIND)[keyof typeof PP_KIND], q: Q, run: { id: string } | null) => {
    const inst = q.instance ? svc.repo.requireInstance(projectId, String(q.instance)) : null;
    const status = q.status ? q.status.toUpperCase().split(',') : null;
    return ppList(svc, projectId, kind, { instanceId: inst?.id, runId: run?.id, limit: Math.min(500, Number(q.limit ?? 200) || 200) }).filter((t) => !status || status.includes(t.status));
  };

  // ---------- subscriptions ----------
  app.get<{ Params: P; Querystring: Q }>(`${pb}/subscriptions`, async (req) => {
    const project = proj(req.params.slug);
    return listOf(project.id, PP_KIND.subscription, req.query, runParam(hub, req, project)).map((t) => subscriptionView(svc, t));
  });
  app.get<{ Params: P }>(`${pb}/subscriptions/:id`, async (req) => {
    const project = proj(req.params.slug);
    return subscriptionView(svc, find(project.id, PP_KIND.subscription, req.params.id, 'Subscription'));
  });
  /** Bill the current cycle now (on the subscription clock as it is). Body: {outcome?: "success" | "decline"}. */
  app.post<{ Params: P }>(`${pb}/subscriptions/:id/bill`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.subscription, req.params.id, 'Subscription');
    const b = body(req.body);
    const res = await ctl(() => billCycle(svc, instOf(t), t, { outcome: str(b.outcome), via: 'control' }));
    return { billed: { ...res, payment: res.payment?.id ?? null }, subscription: subscriptionView(svc, svc.repo.token(t.id)!) };
  });
  /** Move the subscription clock: {by: "+30d"} bills every cycle that became due, {cycles: n} jumps n cycles. */
  app.post<{ Params: P }>(`${pb}/subscriptions/:id/advance`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.subscription, req.params.id, 'Subscription');
    const b = body(req.body);
    const res = await ctl(() => advanceSubscription(svc, instOf(t), t, { by: b.by, cycles: b.cycles, outcome: str(b.outcome) }));
    return { billed: res.billed.map((x) => ({ ...x, payment: x.payment?.id ?? null })), clockOffsetMs: res.clockOffsetMs, subscription: subscriptionView(svc, svc.repo.token(t.id)!) };
  });
  /** Outcomes of the next billings, in order: {outcomes: ["decline", "decline", "success"]}. */
  app.post<{ Params: P }>(`${pb}/subscriptions/:id/outcomes`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.subscription, req.params.id, 'Subscription');
    const b = body(req.body);
    const list = Array.isArray(b.outcomes) ? b.outcomes.map(String) : str(b.outcome) ? [String(b.outcome)] : [];
    if (!list.length || list.some((o) => !/^(success|decline|fail)/i.test(o))) throw new HttpError(400, 'outcomes is a list of "success" / "decline"');
    return subscriptionView(svc, queueOutcomes(svc, t, list));
  });
  /** PayPal or the buyer changes the status: {action: "suspend" | "activate" | "cancel", reason?}. */
  app.post<{ Params: P }>(`${pb}/subscriptions/:id/status`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.subscription, req.params.id, 'Subscription');
    const b = body(req.body);
    const action = str(b.action);
    if (action !== 'suspend' && action !== 'activate' && action !== 'cancel') throw new HttpError(400, 'action is suspend, activate or cancel');
    const n = await ctl(() => changeSubscriptionStatus(svc, instOf(t), t, action, str(b.reason) ?? `${action} from stubyard`));
    return subscriptionView(svc, n);
  });
  app.get<{ Params: P; Querystring: Q }>(`${pb}/plans`, async (req) => {
    const project = proj(req.params.slug);
    const run = runParam(hub, req, project);
    const products = new Map(listOf(project.id, PP_KIND.product, { ...req.query, status: undefined }, null).map((t) => [`${t.instanceId}:${t.providerRef}`, t]));
    return listOf(project.id, PP_KIND.plan, req.query, run).map((t) => ({
      id: t.providerRef,
      instance: instOf(t).slug,
      status: t.status,
      name: t.data.name,
      productId: t.data.product_id,
      productName: products.get(`${t.instanceId}:${String(t.data.product_id)}`)?.data.name ?? null,
      currency: t.data.currency,
      cycles: t.data.billing_cycles,
      preferences: t.data.payment_preferences,
      subscriptions: ppList(svc, project.id, PP_KIND.subscription, { instanceId: t.instanceId }).filter((s) => s.data.plan_id === t.providerRef).length,
      createdAt: t.createdAt,
    }));
  });

  // ---------- disputes ----------
  app.get<{ Params: P; Querystring: Q }>(`${pb}/disputes`, async (req) => {
    const project = proj(req.params.slug);
    const payment = str(req.query.payment);
    return listOf(project.id, PP_KIND.dispute, req.query, runParam(hub, req, project))
      .filter((t) => !payment || t.data.disputedPayment === payment)
      .map((t) => disputeView(svc, t));
  });
  app.get<{ Params: P }>(`${pb}/disputes/:id`, async (req) => {
    const project = proj(req.params.slug);
    return disputeView(svc, find(project.id, PP_KIND.dispute, req.params.id, 'Dispute'));
  });
  /** The buyer opens a dispute on a captured PayPal payment: {reason?, amount?, stage?: INQUIRY | CHARGEBACK, message?}. */
  app.post<{ Params: P }>(`${pb}/:id/dispute`, async (req, reply) => {
    const project = proj(req.params.slug);
    const p = svc.repo.require(project.id, req.params.id);
    const b = body(req.body);
    const t = await ctl(() => openDispute(svc, p, { reason: b.reason, amount: b.amount, stage: b.stage, message: b.message, channel: b.channel }));
    return reply.status(201).send(disputeView(svc, t));
  });
  /** PayPal decides: {outcome: "buyer" | "seller" | "cancelled"}. */
  app.post<{ Params: P }>(`${pb}/disputes/:id/resolve`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.dispute, req.params.id, 'Dispute');
    const outcome = str(body(req.body).outcome);
    if (!outcome) throw new HttpError(400, 'outcome is buyer, seller or cancelled');
    return disputeView(svc, await ctl(() => resolveDispute(svc, t, outcome)));
  });
  /** The buyer answers: {action: "accept-offer" | "deny-offer" | "send-message" | "escalate", note?, message?}. */
  app.post<{ Params: P }>(`${pb}/disputes/:id/buyer`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.dispute, req.params.id, 'Dispute');
    const b = body(req.body);
    const action = str(b.action) as SellerAction | null;
    if (!action || !['accept-offer', 'deny-offer', 'send-message', 'escalate'].includes(action)) throw new HttpError(400, 'action is accept-offer, deny-offer, send-message or escalate');
    const input: Json = { note: b.note ?? null, message: b.message ?? b.note ?? null };
    return disputeView(svc, await ctl(() => disputeAction(svc, instOf(t), t, action, input, { actor: 'BUYER' })));
  });
  /** Act as the merchant / PayPal from the dashboard (same rules as the PayPal API): {action, input?: the action's PayPal body}. */
  app.post<{ Params: P }>(`${pb}/disputes/:id/merchant`, async (req) => {
    const project = proj(req.params.slug);
    const t = find(project.id, PP_KIND.dispute, req.params.id, 'Dispute');
    const b = body(req.body);
    const action = str(b.action) as SellerAction | null;
    const ok: SellerAction[] = ['provide-evidence', 'accept-claim', 'make-offer', 'escalate', 'send-message', 'acknowledge-return-item', 'provide-supporting-info', 'adjudicate', 'require-evidence'];
    if (!action || !ok.includes(action)) throw new HttpError(400, `action is one of ${ok.join(', ')}`);
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? (b.input as Json) : {};
    return disputeView(svc, await ctl(() => disputeAction(svc, instOf(t), t, action, input, { actor: action === 'adjudicate' || action === 'require-evidence' ? 'PAYPAL' : 'SELLER' })));
  });
}

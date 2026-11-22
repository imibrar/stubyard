import { OPEN, toDecimal } from '../engine.js';
import type { GatewayCtx, Json } from '../gateway.js';
import { finding, httpUrl } from '../lint.js';
import { displayPhone, pageCsp, renderClosePage, renderFormPost, renderPayError, type PageUser, type PayPageInput } from '../pages.js';
import type { Payment, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import { relFromStep } from './context.js';
import { locate, renderKitPay, stepCommon, type Located } from './dispatch.js';
import { advance, expectStep, FlowError, startFlow } from './flow.js';
import { renderKitBank, renderKitOtp, renderKitResult, renderKitStepError, resultOf } from './pages.js';
import { hostedModeOf, layoutFor } from './registry.js';
import { resolveView } from './view.js';

/**
 * Browser endpoints of the realistic pages, under the hosted page: …/page/<id>/x/<step>.
 * (GET …/page/<id> itself and the classic …/complete stay in routes/payments.ts; paths below /page/<id>/x/ reach the
 * gateway router, which hands them here first: presets.ts.)
 *
 * - POST x/pay     the pay form and the OTP step (the same fields as the classic …/complete)
 * - GET  x/acs     the simulated bank frame inside the 3-D Secure modal
 * - POST x/3ds     the 3-D Secure answer (3ds_success / 3ds_fail); refused unless the challenge step is waiting
 * - POST x/notice  the page reports a hidden test notice: lint pay.test-notice-hidden (never blocks the payment)
 */

const X_RE = /^\/page\/([^/]+)\/x\/(pay|acs|3ds|notice)\/?$/;
const str = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === null || s === '' ? null : String(s);
};
const bodyOf = (b: unknown): Json => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as Json) : {});

export function isExperiencePath(path: string): boolean {
  return X_RE.test(path);
}

export async function experienceRoute(c: GatewayCtx): Promise<unknown> {
  const m = X_RE.exec(c.path)!;
  const id = decodeURIComponent(m[1]!);
  const step = m[2]!;
  const { svc, reply, req, hub } = c;
  const html = (status: number, s: string) => reply.status(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', pageCsp(s)).send(s);
  const dashboard = (p?: Payment) => `${svc.browserRoot()}/p/${c.project.slug}/payments${p ? `/${p.id}` : ''}`;
  const p0 = svc.repo.get(id);
  if (!p0 || p0.instanceId !== c.inst.id) {
    c.resolved.error = 'unknown payment';
    return html(404, renderPayError('Payment not found', `No payment "${id}" on ${c.inst.slug}.`, dashboard()));
  }
  c.resolved.payment = p0.id;
  c.resolved.endpoint = `page x/${step}`;
  const g = svc.gateway(c.inst.preset);
  let p = await svc.touch(p0);
  const hit: Located = locate(p.id) ?? { svc, payment: p, inst: c.inst, merchant: c.project.name, host: null };
  const view = resolveView(c.inst, p);
  const rel = relFromStep(p.id);
  const amount = `${toDecimal(p.amount, p.currency)} ${p.currency}`;
  const common = stepCommon(hit, view, rel, { presetName: g.name, amount, dashboardUrl: dashboard(p), logo: g.logo ?? null });
  const method = req.method.toUpperCase();

  if (step === 'notice') {
    if (method !== 'POST') return reply.status(405).send({ error: 'POST only' });
    const b = bodyOf(req.body);
    const reason = (str(b.reason) ?? 'hidden').replace(/[^a-z-]/gi, '').slice(0, 30) || 'hidden';
    const framed = str(b.framed) === '1';
    svc.addLint(p, [finding('pay.test-notice-hidden', `The stubyard test notice on the payment page was ${reason}${framed ? ' (the page runs in a frame of your app)' : ''}; the payment was not blocked`)]);
    svc.repo.addEvent(p, 'test_notice_hidden', { reason, framed });
    svc.changed(p.projectId, { payment: p.id });
    return reply.status(204).send();
  }

  const usersFor = (): PageUser[] => {
    const runUsers = p.runId ? hub.users.listForRun(p.runId) : [];
    const all = hub.users.list(c.project.id);
    const seen = new Set<string>();
    const out: PageUser[] = [];
    for (const [u, run] of [...runUsers.map((u) => [u, true] as const), ...all.map((u) => [u, false] as const)]) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push({ id: u.id, name: u.name, email: u.email, phone: u.phone, run });
    }
    return out.slice(0, 200);
  };
  const methodsOf = (): PaymentMethod[] => {
    if (g.methodsFor) return g.methodsFor(p);
    const allowed = p.providerData.methods as PaymentMethod[] | undefined;
    return allowed?.length ? g.methods.filter((x) => allowed.includes(x)) : g.methods;
  };
  const input = (error: string | null): PayPageInput => ({
    presetId: c.inst.preset,
    presetName: g.name,
    instance: c.inst.slug,
    paymentId: p.id,
    providerRef: p.providerRef,
    amount,
    reference: p.reference,
    description: str((p.request as Json).cart_description) ?? (((p.providerData.lineItems as Json[] | undefined) ?? []).map((li) => String(li.description ?? '')).join(', ') || null),
    email: p.customerEmail,
    methods: methodsOf(),
    method: p.method,
    users: usersFor(),
    userId: p.testUserId,
    forced: svc.peekForced(p, p.testUserId),
    action: rel.pay,
    warnAction: rel.warning,
    error,
    run: p.runId ? (hub.runs.repo.get(p.runId)?.key ?? null) : null,
    dashboardUrl: dashboard(p),
    cancellable: true,
    embed: false,
    logo: g.logo ?? null,
    phone: str(p.providerData.otpPhone),
    testCards: g.testCards,
  });
  const payPage = (status: number, error: string | null, challenge = false) =>
    html(status, renderKitPay({ input: input(error), payment: p, view, merchant: hit.merchant, host: hit.host, rel, mode: hostedModeOf(c.inst.preset), challenge }));
  const done = () => {
    const st = p.status;
    let ret: ReturnType<typeof g.returnTo> = null;
    try {
      ret = g.returnTo(svc, p, c.inst, ['paid', 'authorized', 'partially_refunded', 'refunded'].includes(st) ? 'success' : st === 'cancelled' ? 'cancelled' : 'failed');
    } catch {
      ret = null;
    }
    if (ret?.kind === 'close') return html(200, renderClosePage({ presetId: c.inst.preset, presetName: g.name, amount, dashboardUrl: dashboard(p), title: st === 'cancelled' ? 'Payment cancelled' : st === 'failed' ? 'Payment declined' : 'Payment approved', message: ret.message }));
    const retUrl = ret?.kind === 'redirect' ? httpUrl(ret.url) : null;
    const r = resultOf(st, { presetId: c.inst.preset, async: !!p.providerData.async, declineMessage: svc.declineOf(p).message });
    return html(200, renderKitResult({ ...common, ...r, status: st, returnUrl: retUrl, noReturn: !ret || (ret.kind === 'redirect' && !retUrl) }));
  };
  const stepError = (e: FlowError) => {
    c.resolved.error = e.message;
    return html(409, renderKitStepError({ ...common, reason: e.reason }));
  };
  const openish = () => OPEN.includes(p.status) || (p.status === 'failed' && g.retryOnDecline);

  /** svc.complete with the page's answers, then the next screen (the classic …/complete logic, kit screens). */
  const run = async (b: Json, carry: Record<string, string | null>, outcome: string | null) => {
    const card = carry.card_brand ? { brand: carry.card_brand, last4: carry.card_last4, magicId: carry.card_magic, luhnValid: carry.card_luhn === '1', testCard: carry.card_test === '1' } : null;
    let r;
    try {
      r = await svc.complete(p, { via: 'page', outcome, user: carry.user, method: carry.method, card, phone: str(b.phone), otp: str(b.otp) });
    } catch (e) {
      if (e instanceof HttpError && e.statusCode < 500) {
        p = svc.repo.get(p.id) ?? p;
        if (!openish()) return done();
        return payPage(e.statusCode, e.message);
      }
      throw e;
    }
    p = r.payment;
    c.resolved.outcome = r.outcome;
    if (r.needsOtp) {
      const stc = p.providerData.stc as { phone?: string } | undefined;
      return html(r.otpError ? 400 : 200, renderKitOtp({ ...common, phoneDisplay: displayPhone(stc?.phone ?? str(b.phone) ?? '', p.currency), method: p.method ?? 'stcpay', carry: { outcome, user: carry.user }, error: r.otpError ?? null }));
    }
    if (r.redirect?.kind === 'redirect' && httpUrl(r.redirect.url)) return reply.redirect(r.redirect.url, 303);
    if (r.redirect?.kind === 'post' && httpUrl(r.redirect.url)) return html(200, renderFormPost(r.redirect.url, r.redirect.fields));
    if (r.redirect?.kind === 'close') return done();
    if (p.status === 'failed' && g.retryOnDecline && r.declined) return payPage(402, r.declined.message);
    return done();
  };

  if (step === 'acs') {
    if (method !== 'GET' && method !== 'HEAD') return reply.status(405).send({ error: 'GET only' });
    try {
      expectStep(p, 'card-3ds', 'challenge');
    } catch (e) {
      if (e instanceof FlowError) return stepError(e);
      throw e;
    }
    return html(200, renderKitBank({ ...common, frame: true }));
  }

  if (method !== 'POST') {
    // A reload of a POST-only step: back to the page.
    return reply.redirect(rel.self, 303);
  }
  const b = bodyOf(req.body);

  if (step === '3ds') {
    let answers: Record<string, string | null>;
    try {
      answers = expectStep(p, 'card-3ds', 'challenge').answers;
    } catch (e) {
      if (e instanceof FlowError) return stepError(e);
      throw e;
    }
    if (!openish()) return done();
    const outcome = str(b.outcome) === '3ds_success' ? '3ds_success' : '3ds_fail';
    p = svc.repo.update(p.id, { providerData: advance(p, 'card-3ds', 'done') });
    svc.repo.addEvent(p, 'step', { flow: 'card-3ds', step: 'challenge', answer: outcome });
    return run(b, answers, outcome);
  }

  // step === 'pay'
  if (!openish()) return done();
  const carry = { user: str(b.user), method: str(b.method), card_brand: str(b.card_brand), card_last4: str(b.card_last4), card_magic: str(b.card_magic), card_luhn: str(b.card_luhn), card_test: str(b.card_test) };
  const outcome = str(b.outcome);
  if (b.otp === undefined && carry.card_magic === '3ds' && !(outcome ?? '').startsWith('3ds_') && !svc.peekForced(p, p.testUserId)) {
    // 3-D Secure challenge: remember the answers on the server, then the provider's modal (Stripe) or the bank page.
    p = svc.repo.update(p.id, { providerData: startFlow(p, 'card-3ds') });
    p = svc.repo.update(p.id, { providerData: advance(p, 'card-3ds', 'challenge', carry) });
    svc.repo.addEvent(p, 'step', { flow: 'card-3ds', step: 'challenge' });
    svc.changed(p.projectId, { payment: p.id });
    if (layoutFor(c.inst.preset) === 'stripe-hosted') return payPage(200, null, true);
    return html(200, renderKitBank({ ...common }));
  }
  return run(b, carry, outcome);
}

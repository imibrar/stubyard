import { OPEN, toDecimal } from '../engine.js';
import type { GatewayCtx, Json } from '../gateway.js';
import { finding, httpUrl } from '../lint.js';
import { displayPhone, pageCsp, renderClosePage, renderFormPost, renderPayError, type PageUser, type PayPageInput } from '../pages.js';
import type { Payment, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import { relFromStep } from './context.js';
import { renderBankPage } from './bank.js';
import type { KitPayCtx } from './context.js';
import { layoutOf, locate, renderKitPay, stepCommon, type Located } from './dispatch.js';
import { advance, expectStep, flowOf, FlowError, startFlow } from './flow.js';
import { tx } from './layout.js';
import { renderKitBank, renderKitOtp, renderKitResult, renderKitStepError, resultOf } from './pages.js';
import { hostedModeOf } from './registry.js';
import { resolveView } from './view.js';
import { t } from './i18n.js';

/**
 * Browser endpoints of the realistic pages, under the hosted page: …/page/<id>/x/<step>.
 * (GET …/page/<id> itself and the classic …/complete stay in routes/payments.ts; paths below /page/<id>/x/ reach the
 * gateway router, which hands them here first: presets.ts.)
 *
 * - POST x/pay     the pay form and the OTP step (the same fields as the classic …/complete)
 * - GET  x/acs     the simulated bank frame inside the 3-D Secure modal
 * - POST x/3ds     the 3-D Secure answer (3ds_success / 3ds_fail / 3ds_cancel: the modal's close button, back to the
 *                  form with the payment still payable); refused unless the challenge step is waiting
 * - POST x/notice  the page reports a hidden test notice: lint pay.test-notice-hidden (never blocks the payment)
 * - POST x/view    lang=en|ar: the page language of this payment (result pages of finished payments honour
 *                  ?stubyard_lang through it: the page posts here and reloads)
 * - POST x/select  a method chosen on the method selection screen (MyFatoorah): that method's screen
 * - GET  x/bank    the simulated KNET / BENEFIT page (after x/pay with a bank method: 303 here); POST answers it
 * - POST x/<step>  a provider's custom steps (PayPal: x/login → x/review; Tabby / Tamara: x/phone → x/otp → …;
 *                  JazzCash / Easypaisa wallets: x/mpin, x/otp), kept in order on the server
 *
 * Provider layouts with a full-page 3-D Secure (threeds "redirect") send x/pay to 303 x/acs, which is then the
 * simulated ACS page itself (not a frame). Test shortcuts (Decline, Cancel, the drawer outcomes) finish the payment
 * from any screen, as on the classic page.
 */

const X_RE = /^\/page\/([^/]+)\/x\/(pay|acs|3ds|notice|view|select|bank|login|review|phone|otp|plan|card|terms|mpin)\/?$/;
const str = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === null || s === '' ? null : String(s);
};
const bodyOf = (b: unknown): Json => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as Json) : {});

export function isExperiencePath(path: string): boolean {
  return X_RE.test(path);
}

/**
 * Hosted pages that refuse to be framed (Checkout.com HPP: X-Frame-Options; APS redirection): opened in an iframe
 * (Sec-Fetch-Dest: iframe), the real page would stay blank. stubyard still serves it and only records
 * pay.hpp-framed (on the payment when the entry named one, else on the instance).
 */
const NO_FRAME: Record<string, RegExp> = { checkout: /^\/(hpp|link)\/[^/]+\/?$/, aps: /^\/FortAPI\/paymentPage$/i };
export function framedEntryLint(c: GatewayCtx): void {
  const re = NO_FRAME[c.inst.preset];
  if (!re || !re.test(c.path)) return;
  // The APS Merchant Page (service_command TOKENIZATION) is meant for an iframe.
  if (c.resolved.endpoint === 'merchant page (TOKENIZATION)') return;
  const dest = c.req.headers['sec-fetch-dest'];
  if ((Array.isArray(dest) ? dest[0] : dest) !== 'iframe') return;
  const f = finding('pay.hpp-framed', `${c.req.method} ${c.path} was loaded in an iframe: the real ${c.inst.preset === 'aps' ? 'APS' : 'Checkout.com'} page refuses to be framed`);
  const p = c.resolved.payment ? c.svc.repo.get(String(c.resolved.payment)) : null;
  if (p) c.svc.addLint(p, [f]);
  else c.svc.addInstanceLint(c.inst, f);
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
  const located: Located = locate(p.id) ?? { svc, payment: p, inst: c.inst, merchant: c.project.name, host: null };
  // The banner names the host this request came to (the browser's own view), not stubyard's configured URL.
  const reqHost = str(req.headers.host);
  const hit: Located = { ...located, host: reqHost && /^[A-Za-z0-9.:[\]-]{1,255}$/.test(reqHost) ? reqHost : located.host };
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

  if (step === 'view') {
    if (method !== 'POST') return reply.status(405).send({ error: 'POST only' });
    const lang = str(bodyOf(req.body).lang)?.toLowerCase();
    if (lang !== 'en' && lang !== 'ar') return reply.status(400).send({ error: 'lang must be en or ar' });
    svc.repo.update(p.id, { providerData: { ...p.providerData, checkoutView: { ...((p.providerData.checkoutView as Json | undefined) ?? {}), locale: lang } } });
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
  const def = layoutOf(c.inst.preset);
  const kctx = (error: string | null, extra: Partial<KitPayCtx> = {}): KitPayCtx => ({ input: input(error), payment: p, view, merchant: hit.merchant, host: hit.host, rel, mode: hostedModeOf(c.inst.preset), ...extra });
  const payPage = (status: number, error: string | null, challenge = false) => html(status, renderKitPay(kctx(error, { challenge })));
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
    const own = def?.doneScreen?.({ payment: p, svc, view, host: hit.host, merchant: hit.merchant, dashboardUrl: dashboard(p), status: st, returnUrl: retUrl, result: r });
    if (own) return html(200, own);
    return html(200, renderKitResult({ ...common, ...r, status: st, returnUrl: retUrl, noReturn: !ret || (ret.kind === 'redirect' && !retUrl), scripts: def?.resultScripts?.(p, svc) }));
  };
  /** The provider's own return page (PayTabs framed targets / countdown), or null for stubyard's default. */
  const providerReturn = (kind: 'post' | 'redirect', url: string, fields: Record<string, string>): string | null => {
    if (!def?.returnPage) return null;
    const r = resultOf(p.status, { presetId: c.inst.preset, async: !!p.providerData.async, declineMessage: svc.declineOf(p).message });
    return def.returnPage({ payment: p, svc, view, host: hit.host, presetName: def.provider, kind, url, fields, status: p.status, result: r });
  };
  const stepError = (e: FlowError) => {
    c.resolved.error = e.message;
    return html(409, renderKitStepError({ ...common, reason: e.reason }));
  };
  const openish = () => OPEN.includes(p.status) || (p.status === 'failed' && g.retryOnDecline);
  /** The enter hook of the custom step the flow just moved into (send the OTP), with the answers so far. */
  const enterStep = (name: string): Payment => {
    const st = def?.steps?.[name];
    if (!st?.enter) return p;
    return st.enter({ svc, payment: p, body: {}, locale: view.locale, answers: flowOf(p)?.answers ?? {} });
  };

  /** svc.complete with the page's answers, then the next screen (the classic …/complete logic, kit screens). */
  const run = async (b: Json, carry: Record<string, string | null>, outcome: string | null) => {
    const card = carry.card_brand ? { brand: carry.card_brand, last4: carry.card_last4, magicId: carry.card_magic, luhnValid: carry.card_luhn === '1', testCard: carry.card_test === '1' } : null;
    let r;
    try {
      // A test shortcut (Decline, Cancel, the drawer outcomes) on a provider's multi-step screens finishes at once: no
      // OTP screen first (the classic page asks for the code before any outcome).
      const quick = !!def?.steps && !!outcome && outcome !== 'success' && !outcome.startsWith('3ds_');
      r = await svc.complete(p, { via: 'page', outcome, user: carry.user, method: carry.method, card, phone: str(b.phone) ?? carry.phone ?? null, otp: quick ? 'auto' : str(b.otp) });
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
      return html(200, renderKitOtp({ ...common, phoneDisplay: displayPhone(stc?.phone ?? str(b.phone) ?? '', p.currency), method: p.method ?? 'stcpay', carry: { outcome, user: carry.user }, error: r.otpError ?? null }));
    }
    if (r.redirect?.kind === 'redirect' && httpUrl(r.redirect.url)) {
      const own = providerReturn('redirect', r.redirect.url, {});
      return own ? html(200, own) : reply.redirect(r.redirect.url, 303);
    }
    if (r.redirect?.kind === 'post' && httpUrl(r.redirect.url)) return html(200, providerReturn('post', r.redirect.url, r.redirect.fields) ?? renderFormPost(r.redirect.url, r.redirect.fields));
    if (r.redirect?.kind === 'close') return done();
    // A decline the buyer may retry: the form again with the message (200: the page itself worked; a 4xx would only
    // put an error in the browser console).
    if (p.status === 'failed' && g.retryOnDecline && r.declined) return payPage(200, r.declined.message);
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
    if (def && def.threeds === 'redirect') return html(200, renderKitBank({ ...common, presetName: def.provider, hint: def.acsHint ? tx(view.locale, def.acsHint) : null, provider: def.provider }));
    return html(200, renderKitBank({ ...common, frame: true }));
  }

  if (step === 'bank' && (method === 'GET' || method === 'HEAD')) {
    if (!openish()) return done();
    let s;
    try {
      s = expectStep(p, 'bank', 'bank');
    } catch (e) {
      if (e instanceof FlowError) return stepError(e);
      throw e;
    }
    return html(200, renderBankPage(kctx(null), def, String(s.answers.method ?? 'knet')));
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
    const answer = str(b.outcome);
    if (answer === '3ds_cancel') {
      // The buyer closed the challenge: no attempt is made; back to the form, the payment stays payable.
      p = svc.repo.update(p.id, { providerData: advance(p, 'card-3ds', 'done') });
      svc.repo.addEvent(p, 'step', { flow: 'card-3ds', step: 'challenge', answer: '3ds_cancel' });
      svc.changed(p.projectId, { payment: p.id });
      return payPage(200, t(view.locale, 'auth3dsCancelled'));
    }
    const outcome = answer === '3ds_success' ? '3ds_success' : '3ds_fail';
    p = svc.repo.update(p.id, { providerData: advance(p, 'card-3ds', 'done') });
    svc.repo.addEvent(p, 'step', { flow: 'card-3ds', step: 'challenge', answer: outcome });
    return run(b, answers, outcome);
  }

  const carryOf = (extra: Record<string, string | null> = {}) => ({ user: str(b.user), method: str(b.method), card_brand: str(b.card_brand), card_last4: str(b.card_last4), card_magic: str(b.card_magic), card_luhn: str(b.card_luhn), card_test: str(b.card_test), ...extra });

  if (step === 'select') {
    if (!openish()) return done();
    const outcome = str(b.outcome);
    if (outcome) return run(b, carryOf(), outcome); // a test shortcut on the selection screen
    const m = str(b.method) as PaymentMethod | null;
    const methods = input(null).methods;
    if (!m || !methods.includes(m)) return html(400, renderKitPay(kctx(`Choose one of: ${methods.join(', ')}`)));
    svc.repo.addEvent(p, 'step', { flow: 'select', step: 'select', method: m });
    if (def?.bankMethods?.includes(m) && !svc.peekForced(p, p.testUserId)) {
      p = svc.repo.update(p.id, { providerData: startFlow(p, 'bank') });
      p = svc.repo.update(p.id, { providerData: advance(p, 'bank', 'bank', carryOf({ method: m })) });
      svc.changed(p.projectId, { payment: p.id });
      return reply.redirect('bank', 303);
    }
    return html(200, renderKitPay(kctx(null, { selected: m })));
  }

  if (step === 'bank') {
    if (!openish()) return done();
    let s;
    try {
      s = expectStep(p, 'bank', 'bank');
    } catch (e) {
      if (e instanceof FlowError) return stepError(e);
      throw e;
    }
    const outcome = str(b.outcome) ?? 'success';
    p = svc.repo.update(p.id, { providerData: advance(p, 'bank', 'done') });
    svc.repo.addEvent(p, 'step', { flow: 'bank', step: 'bank', answer: outcome });
    return run(b, { ...s.answers, user: str(b.user) ?? s.answers.user ?? null }, outcome);
  }

  const custom = def?.steps?.[step];
  if (step !== 'pay') {
    if (!custom || !def?.renderStep) return reply.status(404).send({ error: `No ${step} step on ${g.name} pages` });
    if (!openish()) return done();
    const outcome = str(b.outcome);
    const last = custom.next === 'done';
    const prev = flowOf(p)?.flow === custom.flow ? (flowOf(p)?.answers ?? {}) : {};
    // A test shortcut on an intermediate screen finishes the payment at once (as on the classic page).
    if (outcome && !last) return run(b, { ...prev, ...carryOf({ method: str(b.method) ?? prev.method ?? null }) }, outcome);
    let s;
    try {
      s = expectStep(p, custom.flow, step);
    } catch (e) {
      if (e instanceof FlowError) return stepError(e);
      throw e;
    }
    if (custom.back && str(b.back) === '1') {
      p = svc.repo.update(p.id, { providerData: advance(p, custom.flow, custom.back) });
      svc.repo.addEvent(p, 'step', { flow: custom.flow, step, answer: 'back' });
      return html(200, def.renderStep(kctx(null), custom.back));
    }
    // A test shortcut on the last screen (Decline, the drawer outcomes) skips the answer's checks.
    const shortcut = !!outcome && outcome !== 'success';
    const bad = shortcut ? null : (custom.validate?.(b, view.locale) ?? null);
    if (bad) return html(400, def.renderStep(kctx(null, { stepError: bad }), step));
    const answers = { ...(custom.answers?.(b) ?? {}) };
    const act = shortcut ? null : (custom.act?.({ svc, payment: p, body: b, locale: view.locale, answers: { ...s.answers, ...answers } }) ?? null);
    if (act?.payment) p = act.payment;
    if (act?.error) {
      svc.repo.addEvent(p, 'step', { flow: custom.flow, step, answer: 'retry' });
      return html(200, def.renderStep(kctx(null, { stepError: act.error }), step));
    }
    const all = { ...s.answers, ...answers };
    const finishWith = (o: string) => run(b, { ...all, user: str(b.user) ?? all.user ?? null, method: all.method ?? str(b.method) }, o);
    if (act?.finish) {
      p = svc.repo.update(p.id, { providerData: advance(p, custom.flow, 'done', answers) });
      svc.repo.addEvent(p, 'step', { flow: custom.flow, step, answer: act.finish });
      svc.changed(p.projectId, { payment: p.id });
      return finishWith(act.finish);
    }
    const to = last ? 'done' : (act?.next ?? custom.next);
    p = svc.repo.update(p.id, { providerData: advance(p, custom.flow, to, answers) });
    svc.repo.addEvent(p, 'step', { flow: custom.flow, step });
    svc.changed(p.projectId, { payment: p.id });
    if (last) return finishWith(outcome ?? 'success');
    p = enterStep(to);
    return html(200, def.renderStep(kctx(null), to));
  }

  // step === 'pay'
  if (!openish()) return done();
  const carry = { user: str(b.user), method: str(b.method), card_brand: str(b.card_brand), card_last4: str(b.card_last4), card_magic: str(b.card_magic), card_luhn: str(b.card_luhn), card_test: str(b.card_test) };
  const outcome = str(b.outcome);
  const into = b.otp === undefined && (outcome === null || outcome === 'success') && def?.payInto && def.renderStep && !svc.peekForced(p, p.testUserId) ? def.payInto(carry.method ?? '', b, view.locale, p) : null;
  if (into?.error) return payPage(200, into.error);
  if (into) {
    // The method continues on the provider's own screens (JazzCash mobile account: MPIN, then the OTP).
    p = svc.repo.update(p.id, { providerData: startFlow(p, into.flow) });
    p = svc.repo.update(p.id, { providerData: advance(p, into.flow, into.step, { ...carry, ...(into.answers ?? {}) }) });
    svc.repo.addEvent(p, 'step', { flow: into.flow, step: 'pay', method: carry.method });
    svc.changed(p.projectId, { payment: p.id });
    p = enterStep(into.step);
    return html(200, def!.renderStep!(kctx(null), into.step));
  }
  if (b.otp === undefined && carry.card_magic === '3ds' && !(outcome ?? '').startsWith('3ds_') && !svc.peekForced(p, p.testUserId)) {
    // 3-D Secure challenge: remember the answers on the server, then the provider's modal (Stripe) or the bank page.
    p = svc.repo.update(p.id, { providerData: startFlow(p, 'card-3ds') });
    p = svc.repo.update(p.id, { providerData: advance(p, 'card-3ds', 'challenge', carry) });
    svc.repo.addEvent(p, 'step', { flow: 'card-3ds', step: 'challenge' });
    svc.changed(p.projectId, { payment: p.id });
    if (def?.threeds === 'modal') return payPage(200, null, true);
    if (def) return reply.redirect('acs', 303);
    return html(200, renderKitBank({ ...common }));
  }
  if (b.otp === undefined && def?.bankMethods?.includes(carry.method as PaymentMethod) && (outcome === null || outcome === 'success') && !svc.peekForced(p, p.testUserId)) {
    // KNET / BENEFIT: the buyer continues on the (simulated) bank's page.
    p = svc.repo.update(p.id, { providerData: startFlow(p, 'bank') });
    p = svc.repo.update(p.id, { providerData: advance(p, 'bank', 'bank', carry) });
    svc.repo.addEvent(p, 'step', { flow: 'bank', step: 'bank', method: carry.method });
    svc.changed(p.projectId, { payment: p.id });
    return reply.redirect('bank', 303);
  }
  return run(b, carry, outcome);
}

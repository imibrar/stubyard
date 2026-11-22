import { esc } from '../../auth/pages.js';
import type { Json } from '../gateway.js';
import { OPEN } from '../engine.js';
import type { KitPayCtx } from '../kit/context.js';
import { flowOf, startFlow } from '../kit/flow.js';
import { hostedLayout, pageMethods } from '../kit/hpp.js';
import { t } from '../kit/i18n.js';
import type { ProviderLayout } from '../kit/layout.js';
import { tx } from '../kit/layout.js';
import { payFormParts, providerTitle } from '../kit/pages.js';
import { kitDocument } from '../kit/shell.js';
import type { Payment } from '../repo.js';

/**
 * PayPal redirect approval (the order's "approve" / "payer-action" link, /checkoutnow?token=): log in → review →
 * approve, then back to return_url?token=&PayerID= (or cancel_url) as today; the app captures. The review button is
 * "Pay Now" with user_action PAY_NOW, "Continue" otherwise (the app shows its own review), "Agree & Subscribe" for a
 * subscription. Shipping shows unless shipping_preference is NO_SHIPPING. "Not you?" goes back to the login.
 * The password is never posted (the input has no name); only the email is kept on the server for the review screen.
 * Screens: assumed (PayPal's pages change often; no current screenshots were compared).
 */

const ctxOf = (p: Payment): Json => {
  const r = (p.request ?? {}) as Json;
  const pp = ((r.payment_source as Json | undefined)?.paypal as Json | undefined)?.experience_context as Json | undefined;
  return (pp ?? (r.application_context as Json | undefined) ?? {}) as Json;
};
const isSub = (p: Payment) => !!p.providerData.subscription;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const TX = {
  login: { en: 'Log in to PayPal', ar: 'سجّل الدخول إلى PayPal' },
  email: { en: 'Email or mobile number', ar: 'البريد الإلكتروني أو رقم الجوال' },
  password: { en: 'Password', ar: 'كلمة المرور' },
  logIn: { en: 'Log In', ar: 'تسجيل الدخول' },
  pwHint: { en: 'Any password works: it is not sent.', ar: 'أي كلمة مرور تعمل: لا يتم إرسالها.' },
  badEmail: { en: 'Enter your email or mobile number.', ar: 'أدخل بريدك الإلكتروني أو رقم جوالك.' },
  hi: { en: 'Logged in as', ar: 'تم تسجيل الدخول باسم' },
  notYou: { en: 'Not you?', ar: 'لست أنت؟' },
  payWith: { en: 'Pay with', ar: 'الدفع باستخدام' },
  balance: { en: 'PayPal balance (simulated)', ar: 'رصيد PayPal (محاكاة)' },
  shipTo: { en: 'Ship to', ar: 'الشحن إلى' },
  shipAddr: { en: 'Test Buyer, 1 Test Street, Riyadh', ar: 'مشتري تجريبي، 1 شارع الاختبار، الرياض' },
  payNow: { en: 'Pay Now', ar: 'ادفع الآن' },
  cont: { en: 'Continue', ar: 'متابعة' },
  subscribe: { en: 'Agree & Subscribe', ar: 'موافقة واشتراك' },
  cancelTo: { en: 'Cancel and return to {m}', ar: 'إلغاء والعودة إلى {m}' },
  contNote: { en: 'You will review your order on {m} before paying.', ar: 'ستراجع طلبك على {m} قبل الدفع.' },
};

function shell(c: KitPayCtx, inner: string, action: string, title: string, o: { choice?: string | null }): string {
  const L = c.view.locale;
  const { drawer, quick, script } = payFormParts(c, { requireCard: false, cards: false, choice: o.choice ?? null });
  const err = c.stepError ? `<div class="k-alert" role="alert" data-testid="stubyard-error">${esc(c.stepError)}</div>` : c.input.error ? `<div class="k-alert" role="alert" data-testid="stubyard-error">${esc(c.input.error)}</div>` : '';
  const body = `<form method="post" action="${esc(action)}" id="pay"${c.input.forced ? ' data-forced' : ''} novalidate>${quick}
<main class="k-wrap"><div class="k-card k-hpp k-pp" data-layout="paypal-approval">
<div class="k-head"><div class="k-mono" aria-hidden="true">P</div><h1>${esc(title)}<small>${esc(t(L, 'simulatedBy', { provider: 'PayPal' }))}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(c.input.amount)}</div></div>
<div class="k-sec">${err}${inner}</div>
<div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: 'PayPal' }))}</span></div>
</div></main>${drawer}</form>`;
  return kitDocument({ title: `${title} · ${providerTitle('PayPal')}`, locale: L, body, scripts: [script], banner: { variant: 'full', host: c.host, drawer: true, notice: c.rel.notice } });
}

function cancelLink(c: KitPayCtx): string {
  if (!c.input.cancellable) return '';
  return `<button type="submit" class="k-linkbtn k-ppcancel" name="outcome" value="cancel" formnovalidate data-testid="stubyard-provider-cancel">${esc(tx(c.view.locale, TX.cancelTo).replace('{m}', c.merchant))}</button>`;
}

function renderLogin(c: KitPayCtx): string {
  const L = c.view.locale;
  const email = c.input.email ?? '';
  const inner = `<label class="k-field"><span class="k-lbl">${esc(tx(L, TX.email))}</span><input class="k-input" type="email" name="email" autocomplete="off" dir="ltr" value="${esc(email)}" placeholder="buyer@example.com" data-testid="stubyard-email"></label>
<label class="k-field"><span class="k-lbl">${esc(tx(L, TX.password))}</span><input class="k-input" type="password" id="pp-pw" autocomplete="off" dir="ltr" aria-describedby="pp-pwh" data-testid="stubyard-password"></label><p class="k-hint" id="pp-pwh">${esc(tx(L, TX.pwHint))}</p>
<button type="submit" class="k-paybtn" data-testid="stubyard-login"><span class="k-label">${esc(tx(L, TX.logIn))}</span></button>${cancelLink(c)}`;
  return shell(c, inner, c.rel.x + 'login', tx(L, TX.login), {});
}

function renderReview(c: KitPayCtx): string {
  const L = c.view.locale;
  const p = c.payment;
  const f = flowOf(p);
  const email = String(f?.answers.email ?? c.input.email ?? '');
  const ctx = ctxOf(p);
  const action = str(ctx.user_action)?.toUpperCase();
  const label = isSub(p) ? tx(L, TX.subscribe) : action === 'PAY_NOW' ? tx(L, TX.payNow) : tx(L, TX.cont);
  const ship = !isSub(p) && str(ctx.shipping_preference)?.toUpperCase() !== 'NO_SHIPPING';
  const inner = `<input type="hidden" name="method" value="paypal"><dl class="k-meta" data-testid="stubyard-pp-review"><dt>${esc(tx(L, TX.hi))}</dt><dd dir="ltr">${esc(email)}</dd>
<dt>${esc(tx(L, TX.payWith))}</dt><dd>${esc(tx(L, TX.balance))}</dd>${ship ? `<dt>${esc(tx(L, TX.shipTo))}</dt><dd data-testid="stubyard-pp-ship">${esc(tx(L, TX.shipAddr))}</dd>` : ''}</dl>
<p><button type="submit" class="k-linkbtn" name="back" value="1" formnovalidate data-testid="stubyard-not-you">${esc(tx(L, TX.notYou))}</button></p>
${!isSub(p) && action !== 'PAY_NOW' ? `<p class="k-hint">${esc(tx(L, TX.contNote).replace('{m}', c.merchant))}</p>` : ''}
<button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(label)}</span></button>${cancelLink(c)}`;
  return shell(c, inner, c.rel.x + 'review', str(ctx.brand_name) ?? c.merchant, { choice: (f?.answers.k_outcome as string | undefined) ?? null });
}

/** Card payments (an order created with payment_source.card waiting for 3DS) use the hosted card form. */
const cardPage = hostedLayout({ layout: 'paypal-approval', provider: 'PayPal', cardholder: 'before', methodStyle: 'tabs' }, { threeds: 'redirect' });

export const paypalLayout: ProviderLayout = {
  id: 'paypal-approval',
  provider: 'PayPal',
  threeds: 'redirect',
  renderPay: (c) => {
    if (!c.input.methods.includes('paypal') || !OPEN.includes(c.payment.status)) return cardPage.renderPay(c);
    const f = flowOf(c.payment);
    return f?.flow === 'paypal-approval' && f.step === 'review' ? renderReview(c) : renderLogin(c);
  },
  prepare: (svc, p) => {
    if (!OPEN.includes(p.status)) return p;
    if (!pageMethods(svc, p).includes('paypal')) return cardPage.prepare ? cardPage.prepare(svc, p) : p;
    if (flowOf(p)?.flow === 'paypal-approval') return p;
    return svc.repo.update(p.id, { providerData: startFlow(p, 'paypal-approval') });
  },
  steps: {
    login: {
      flow: 'paypal-approval',
      next: 'review',
      validate: (b, L) => (str(b.email) ? null : tx(L, TX.badEmail)),
      answers: (b) => ({ email: str(b.email), k_outcome: str(b.k_outcome), user: str(b.user), method: 'paypal' }),
    },
    review: { flow: 'paypal-approval', next: 'done', back: 'login' },
  },
  renderStep: (c, step) => (step === 'review' ? renderReview(c) : renderLogin(c)),
};

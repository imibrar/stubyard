import { esc } from '../../auth/pages.js';
import { OPEN, toDecimal } from '../engine.js';
import type { Json } from '../gateway.js';
import type { KitPayCtx } from '../kit/context.js';
import { flowOf, startFlow } from '../kit/flow.js';
import type { Locale } from '../kit/i18n.js';
import { tx, type ProviderLayout, type Txt } from '../kit/layout.js';
import { kitDocument } from '../kit/shell.js';
import { bnplCard, cardAnswers, continueBtn, instalments, otpInput, payBtn, stepShell, type CancelConfirm } from '../kit/steps.js';
import type { Payment } from '../repo.js';
import type { PaymentService } from '../service.js';
import { displayPhone } from '../pages.js';
import { normalizePhone } from '../../util.js';
import { HPP_REJECT_EMAIL, isPrescoringReject } from './index.js';

/**
 * Tabby hosted checkout (web_url), research R3: phone + email → OTP (8888 in the sandbox, or the code in the SMS
 * inbox) → the 4-payment plan → the bank card → back to merchant_urls.success | cancel | failure?payment_id=.
 * - Pre-scoring reject phones (+971500000002 / +966500000002) typed on the first screen, and the HPP reject buyer
 *   otp.rejected@tabby.ai after the OTP, end on "We can't approve this purchase" with "Back to store" (failure URL,
 *   status REJECTED). A session created with a pre-scoring reject phone is rejected at once (as before).
 * - "Back to store" asks for a confirmation, then returns to the cancel URL (status EXPIRED).
 * - The card is bank-card-required in the session; on this page it is a kit card form (digits never posted). A
 *   decline test card declines the payment like the classic page.
 * Statuses, expiry (60 min) and webhooks are those of the API (unchanged). Screens: phone / OTP partial (the test
 * guide documents the inputs and the code), plan / card assumed, the rejection screen and its wording verified.
 */

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const TABBY_TX = {
  phoneTitle: { en: 'Pay in 4. No interest, no fees.', ar: 'قسّمها على 4. بدون فوائد، بدون رسوم.' },
  phoneSub: { en: 'Enter your mobile number and email to continue.', ar: 'أدخل رقم جوالك وبريدك الإلكتروني للمتابعة.' },
  phone: { en: 'Mobile number', ar: 'رقم الجوال' },
  email: { en: 'Email', ar: 'البريد الإلكتروني' },
  cont: { en: 'Continue', ar: 'متابعة' },
  testBuyers: { en: 'Test buyers: otp.success@tabby.ai with +971500000001 / +966500000001 is approved; +971500000002 / +966500000002 is rejected before the code; otp.rejected@tabby.ai is rejected after the code.', ar: 'مشترو الاختبار: otp.success@tabby.ai مع ‎+971500000001 / ‎+966500000001 تتم الموافقة؛ ‎+971500000002 / ‎+966500000002 يُرفض قبل الرمز؛ otp.rejected@tabby.ai يُرفض بعد الرمز.' },
  otpTitle: { en: 'Enter the code', ar: 'أدخل الرمز' },
  otpSent: { en: 'We sent a 4-digit code to {p}.', ar: 'أرسلنا رمزًا من 4 أرقام إلى {p}.' },
  otpHint: { en: 'Sandbox: 8888 works, or use the code in the stubyard SMS inbox.', ar: 'بيئة الاختبار: الرمز 8888 يعمل، أو استخدم الرمز في صندوق رسائل stubyard.' },
  confirm: { en: 'Confirm', ar: 'تأكيد' },
  changeNumber: { en: 'Change number', ar: 'تغيير الرقم' },
  wrong: { en: 'Wrong code, {n} tries left', ar: 'رمز خاطئ، المحاولات المتبقية: {n}' },
  noCode: { en: 'Enter the code.', ar: 'أدخل الرمز.' },
  planTitle: { en: 'Your payment plan', ar: 'خطة الدفع' },
  planSub: { en: '4 interest-free payments, one every month.', ar: '4 دفعات بدون فوائد، دفعة كل شهر.' },
  today: { en: 'Today', ar: 'اليوم' },
  inMonths: { en: 'In {n} month(s)', ar: 'بعد {n} شهر' },
  total: { en: 'Total', ar: 'الإجمالي' },
  cardTitle: { en: 'Pay the first payment', ar: 'ادفع الدفعة الأولى' },
  cardSub: { en: '{a} today, then 3 monthly payments of {b}.', ar: '{a} اليوم، ثم 3 دفعات شهرية بقيمة {b}.' },
  cardLabel: { en: 'Debit or credit card', ar: 'بطاقة مدى أو ائتمانية' },
  pay: { en: 'Pay {a}', ar: 'ادفع {a}' },
  badPhone: { en: 'Enter a valid mobile number.', ar: 'أدخل رقم جوال صحيحًا.' },
  badEmail: { en: 'Enter a valid email.', ar: 'أدخل بريدًا إلكترونيًا صحيحًا.' },
  badCard: { en: 'Enter your card details.', ar: 'أدخل بيانات بطاقتك.' },
  back: { en: 'Back to store', ar: 'العودة إلى المتجر' },
  question: { en: 'Are you sure you want to leave? Your purchase will be cancelled.', ar: 'هل أنت متأكد أنك تريد المغادرة؟ سيتم إلغاء عملية الشراء.' },
  yes: { en: 'Yes, cancel', ar: 'نعم، إلغاء' },
  no: { en: 'Stay', ar: 'البقاء' },
  rejectTitle: { en: "We can't approve this purchase", ar: 'لا يمكننا الموافقة على عملية الشراء هذه' },
  /** The message Tabby asks merchants to show for a rejection (R3). */
  rejectMsg: { en: 'Sorry, Tabby is unable to approve this purchase, please use an alternative payment method for your order.', ar: 'نأسف، تابي غير قادرة على الموافقة على هذه العملية. الرجاء استخدام طريقة دفع أخرى.' },
  /** The message for a buyer who cancelled (R3). */
  cancelMsg: { en: 'You aborted the payment. Please retry or choose another payment method.', ar: 'لقد ألغيت الدفعة. فضلاً حاول مجددًا أو اختر طريقة دفع أخرى.' },
  cancelTitle: { en: 'Payment cancelled', ar: 'تم إلغاء الدفع' },
} satisfies Record<string, Txt>;
const X = TABBY_TX;

const CANCEL: CancelConfirm = { label: X.back, question: X.question, yes: X.yes, no: X.no };
const money = (p: Payment, minor: number) => `${toDecimal(minor, p.currency)} ${p.currency}`;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? ''));
const choiceOf = (p: Payment) => (flowOf(p)?.answers.k_outcome as string | undefined) ?? null;
const shell = (c: KitPayCtx, screen: string, n: number, o: { title: string; sub?: string | null; inner: string; card?: boolean }) =>
  stepShell(c, { layout: 'tabby-hpp', provider: 'Tabby', mono: 'tb', screen, title: o.title, sub: o.sub, action: c.rel.x + screen, inner: o.inner, method: o.card ? 'card' : 'bnpl', card: o.card, stepNo: [n, 4], cancel: CANCEL, choice: choiceOf(c.payment) });

function buyerOf(p: Payment): { phone: string; email: string } {
  const buyer = (((p.request.payment ?? {}) as Json).buyer ?? {}) as Json;
  const f = flowOf(p)?.answers ?? {};
  return { phone: String(f.phone ?? buyer.phone ?? p.providerData.otpPhone ?? ''), email: String(f.email ?? buyer.email ?? p.customerEmail ?? '') };
}

function renderPhone(c: KitPayCtx): string {
  const L = c.view.locale;
  const b = buyerOf(c.payment);
  const inner = `<label class="k-field"><span class="k-lbl">${esc(tx(L, X.phone))}</span><input class="k-input k-num" type="tel" name="phone" dir="ltr" autocomplete="off" value="${esc(b.phone)}" placeholder="+9665XXXXXXXX" required data-testid="stubyard-phone"></label><div class="k-err hide" id="phone-err" role="alert" data-testid="stubyard-phone-error"></div>
<label class="k-field"><span class="k-lbl">${esc(tx(L, X.email))}</span><input class="k-input" type="email" name="email" dir="ltr" autocomplete="off" value="${esc(b.email)}" placeholder="otp.success@tabby.ai" data-testid="stubyard-email"></label>
<p class="k-hint" data-testid="stubyard-test-buyers">${esc(tx(L, X.testBuyers))}</p>${continueBtn(tx(L, X.cont))}`;
  return shell(c, 'phone', 1, { title: tx(L, X.phoneTitle), sub: tx(L, X.phoneSub), inner });
}

function renderOtp(c: KitPayCtx): string {
  const L = c.view.locale;
  const stc = (c.payment.providerData.stc ?? {}) as { phone?: string };
  const phone = displayPhone(stc.phone ?? buyerOf(c.payment).phone, c.payment.currency);
  const inner = `<p data-testid="stubyard-otp-phone">${esc(fill(tx(L, X.otpSent), { p: phone }))}</p>${otpInput(L, { length: 4, hint: tx(L, X.otpHint) })}${continueBtn(tx(L, X.confirm), 'stubyard-otp-submit')}
<p><button type="submit" class="k-linkbtn" name="back" value="1" formnovalidate data-testid="stubyard-change-number">${esc(tx(L, X.changeNumber))}</button></p>`;
  return shell(c, 'otp', 2, { title: tx(L, X.otpTitle), inner });
}

function schedule(L: Locale, p: Payment): string {
  const parts = instalments(p.amount, 4);
  const rows = parts.map((a, i) => `<li data-testid="stubyard-instalment"><span>${esc(i === 0 ? tx(L, X.today) : fill(tx(L, X.inMonths), { n: i }))}</span><b>${esc(money(p, a))}</b></li>`).join('');
  return `<ol class="k-sched" data-testid="stubyard-plan">${rows}<li><span>${esc(tx(L, X.total))}</span><b>${esc(money(p, p.amount))}</b></li></ol>`;
}

function renderPlan(c: KitPayCtx): string {
  const L = c.view.locale;
  return shell(c, 'plan', 3, { title: tx(L, X.planTitle), sub: tx(L, X.planSub), inner: schedule(L, c.payment) + continueBtn(tx(L, X.cont)) });
}

function renderCard(c: KitPayCtx): string {
  const L = c.view.locale;
  const p = c.payment;
  const [first, rest] = instalments(p.amount, 4);
  const inner = `${bnplCard(L, tx(L, X.cardLabel))}${payBtn(fill(tx(L, X.pay), { a: money(p, first!) }))}
<p><button type="submit" class="k-linkbtn" name="back" value="1" formnovalidate data-testid="stubyard-back-step">${esc(tx(L, X.planTitle))}</button></p>`;
  return shell(c, 'card', 4, { title: tx(L, X.cardTitle), sub: fill(tx(L, X.cardSub), { a: money(p, first!), b: money(p, rest!) }), inner, card: true });
}

/** "We can't approve this purchase" / the cancelled screen, with "Back to store" (the failure / cancel URL). */
export function tabbyEndScreen(o: { L: Locale; host: string | null; kind: 'rejected' | 'cancelled'; url: string | null; status: string; merchant: string }): string {
  const L = o.L;
  const rej = o.kind === 'rejected';
  const title = tx(L, rej ? X.rejectTitle : X.cancelTitle);
  const body = `<main class="k-wrap"><div class="k-card k-hpp" data-layout="tabby-hpp" data-screen="${o.kind}"><div class="k-head"><div class="k-mono" aria-hidden="true">tb</div><h1>${esc(o.merchant)}<small>${esc(L === 'ar' ? 'محاكاة Tabby بواسطة stubyard' : 'Tabby, simulated by stubyard')}</small></h1></div>
<div class="k-result" data-testid="stubyard-done" data-status="${esc(o.status)}"><span class="k-icon ${rej ? 'bad' : 'warn'}" aria-hidden="true">${rej ? '!' : '–'}</span><h1 data-testid="stubyard-tabby-${o.kind}">${esc(title)}</h1><p data-testid="stubyard-provider-message">${esc(tx(L, rej ? X.rejectMsg : X.cancelMsg))}</p>
${o.url ? `<a class="k-btn primary wide" href="${esc(o.url)}" data-testid="stubyard-return">${esc(tx(L, X.back))}</a>` : ''}</div></div></main>`;
  return kitDocument({ title, locale: L, body, banner: { variant: 'strip', host: o.host } });
}

const validPhone = (v: string | null) => !!v && v.replace(/\D/g, '').length >= 8 && v.replace(/\D/g, '').length <= 15;

export const tabbyLayout: ProviderLayout = {
  id: 'tabby-hpp',
  provider: 'Tabby',
  threeds: 'redirect',
  renderPay: (c) => {
    const step = flowOf(c.payment)?.flow === 'tabby' ? flowOf(c.payment)!.step : 'phone';
    return step === 'otp' ? renderOtp(c) : step === 'plan' ? renderPlan(c) : step === 'card' ? renderCard(c) : renderPhone(c);
  },
  prepare: (_svc, p) => p,
  steps: {
    phone: {
      flow: 'tabby',
      next: 'otp',
      validate: (b, L) => (!validPhone(str(b.phone)) ? tx(L, X.badPhone) : str(b.email) && !/^[^@\s]+@[^@\s]+$/.test(str(b.email)!) ? tx(L, X.badEmail) : null),
      answers: (b) => ({ phone: str(b.phone), email: str(b.email)?.toLowerCase() ?? null, method: 'bnpl', user: str(b.user), k_outcome: str(b.k_outcome) }),
      act: (x) => {
        if (!isPrescoringReject(String(x.answers.phone ?? ''))) return {};
        // Rejected before the code: no SMS is sent (the stored state says the code step was skipped).
        const phone = normalizePhone(String(x.answers.phone));
        const p = x.svc.repo.update(x.payment.id, { providerData: { ...x.payment.providerData, rejected: true, rejectionReason: 'not_available', stc: { phone, otp: '', tries: 0, verified: true, skipped: 'prescoring' } } });
        return { payment: p, finish: 'decline:generic' };
      },
    },
    otp: {
      flow: 'tabby',
      next: 'plan',
      back: 'phone',
      enter: (x) => x.svc.otpStart(x.payment, String(x.answers.phone ?? ''), 'Tabby', { length: 4 }),
      act: (x) => {
        const r = x.svc.otpCheck(x.payment, str(x.body.otp));
        if (r.result === 'exhausted') return { payment: r.payment, finish: 'decline:generic' };
        if (r.result !== 'ok') return { payment: r.payment, error: !str(x.body.otp) ? tx(x.locale, X.noCode) : fill(tx(x.locale, X.wrong), { n: 3 - Number((r.payment.providerData.stc as { tries?: number } | undefined)?.tries ?? 0) }) };
        const rejected = x.answers.email === HPP_REJECT_EMAIL || x.payment.providerData.testBuyer === 'otp.rejected';
        return rejected ? { payment: r.payment, finish: 'decline:generic' } : { payment: r.payment };
      },
    },
    plan: { flow: 'tabby', next: 'card' },
    card: {
      flow: 'tabby',
      next: 'done',
      back: 'plan',
      validate: (b, L) => (str(b.card_last4) ? null : tx(L, X.badCard)),
      answers: (b) => cardAnswers(b),
    },
  },
  renderStep: (c, step) => (step === 'otp' ? renderOtp(c) : step === 'plan' ? renderPlan(c) : step === 'card' ? renderCard(c) : renderPhone(c)),
  doneScreen: (d) => {
    if (d.status !== 'failed' && d.status !== 'cancelled') return null;
    return tabbyEndScreen({ L: d.view.locale, host: d.host, kind: d.status === 'failed' ? 'rejected' : 'cancelled', url: d.returnUrl, status: d.status, merchant: d.merchant });
  },
  returnPage: (r) => {
    if (r.kind !== 'redirect' || r.status !== 'failed') return null;
    const merchant = r.svc.hub.projects.get(r.payment.projectId)?.name ?? '';
    return tabbyEndScreen({ L: r.view.locale, host: r.host, kind: 'rejected', url: r.url, status: r.status, merchant });
  },
};

/** GET of the page: the flow starts at the phone screen (again after an earlier attempt ended). */
tabbyLayout.prepare = (svc: PaymentService, p: Payment) => {
  if (!OPEN.includes(p.status)) return p;
  const f = flowOf(p);
  if (f?.flow === 'tabby' && f.step !== 'done') return p;
  return svc.repo.update(p.id, { providerData: startFlow(p, 'tabby') });
};


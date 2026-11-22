import { esc } from '../../auth/pages.js';
import { OPEN, toDecimal } from '../engine.js';
import type { Json } from '../gateway.js';
import type { KitPayCtx } from '../kit/context.js';
import { flowOf, startFlow } from '../kit/flow.js';
import type { Locale } from '../kit/i18n.js';
import { tx, type ProviderLayout, type Txt } from '../kit/layout.js';
import { bnplCard, cardAnswers, continueBtn, instalments, otpInput, payBtn, stepShell, type CancelConfirm } from '../kit/steps.js';
import { displayPhone } from '../pages.js';
import type { Payment } from '../repo.js';
import { isTamaraDeclinePhone } from './index.js';

/**
 * Tamara hosted checkout (checkout_url), research R3: phone → Send OTP → OTP (filled in for you in the sandbox) →
 * terms and conditions → plan (split in 2 / 3 / 4, or pay in full) → card → "Pay and Confirm Order" → back to
 * merchant_url.success | failure | cancel?orderId=&paymentStatus= (unchanged). The plan default is the checkout's
 * instalments; the choice is kept with the flow and the payment's events only (the API's order is unchanged).
 * The decline test phones (536422337 / 526422337) decline after the OTP, whether sent with the checkout or typed
 * here. Screens: partial (the order of the screens is described by partner guides; Tamara publishes no screen spec).
 */

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const TAMARA_TX = {
  phoneTitle: { en: 'Enter your phone number', ar: 'أدخل رقم جوالك' },
  phoneSub: { en: 'We will send you a code to verify it is you.', ar: 'سنرسل لك رمزًا للتحقق من هويتك.' },
  phone: { en: 'Phone number', ar: 'رقم الجوال' },
  sendOtp: { en: 'Send OTP', ar: 'إرسال رمز التحقق' },
  testPhones: { en: 'Test phones: 536422337 (KSA) or 526422337 (UAE) are declined; any other number is approved.', ar: 'أرقام الاختبار: 536422337 (السعودية) أو 526422337 (الإمارات) تُرفض؛ أي رقم آخر تتم الموافقة عليه.' },
  otpTitle: { en: 'Verify your number', ar: 'تحقق من رقمك' },
  otpSent: { en: 'Enter the code we sent to {p}.', ar: 'أدخل الرمز الذي أرسلناه إلى {p}.' },
  otpHint: { en: 'Sandbox: the code is filled in for you (123456 also works); it is also in the stubyard SMS inbox.', ar: 'بيئة الاختبار: الرمز مُعبأ لك (123456 يعمل أيضًا)، وهو موجود في صندوق رسائل stubyard.' },
  verify: { en: 'Verify', ar: 'تحقق' },
  changeNumber: { en: 'Change number', ar: 'تغيير الرقم' },
  wrong: { en: 'Wrong code, {n} tries left', ar: 'رمز خاطئ، المحاولات المتبقية: {n}' },
  noCode: { en: 'Enter the code.', ar: 'أدخل الرمز.' },
  termsTitle: { en: 'Terms and conditions', ar: 'الشروط والأحكام' },
  termsText: { en: 'Pay in instalments with no interest and no late fees. Payments are taken from your card on the due dates; you can pay early in the Tamara app (simulated).', ar: 'ادفع على أقساط بدون فوائد وبدون رسوم تأخير. تُخصم الدفعات من بطاقتك في مواعيدها، ويمكنك الدفع مبكرًا عبر تطبيق تمارا (محاكاة).' },
  agree: { en: "I agree to Tamara's terms and conditions and privacy policy", ar: 'أوافق على الشروط والأحكام وسياسة الخصوصية لتمارا' },
  mustAgree: { en: 'Accept the terms and conditions to continue.', ar: 'وافق على الشروط والأحكام للمتابعة.' },
  cont: { en: 'Continue', ar: 'متابعة' },
  planTitle: { en: 'Choose how to pay', ar: 'اختر طريقة الدفع' },
  splitIn: { en: 'Split in {n}', ar: 'قسّمها على {n}' },
  splitSub: { en: '{a} today, then {m} monthly payments of {b}. No interest.', ar: '{a} اليوم، ثم {m} دفعات شهرية بقيمة {b}. بدون فوائد.' },
  full: { en: 'Pay in full', ar: 'ادفع كامل المبلغ' },
  fullSub: { en: '{a} today with your card.', ar: '{a} اليوم ببطاقتك.' },
  badPlan: { en: 'Choose a plan.', ar: 'اختر خطة.' },
  cardTitle: { en: 'Add your card', ar: 'أضف بطاقتك' },
  cardSub: { en: 'Today you pay {a}.', ar: 'تدفع اليوم {a}.' },
  pay: { en: 'Pay and Confirm Order', ar: 'ادفع وأكّد الطلب' },
  changePlan: { en: 'Change plan', ar: 'تغيير الخطة' },
  badPhone: { en: 'Enter a valid phone number.', ar: 'أدخل رقم جوال صحيحًا.' },
  badCard: { en: 'Enter your card details.', ar: 'أدخل بيانات بطاقتك.' },
  back: { en: 'Back to store', ar: 'العودة إلى المتجر' },
  question: { en: 'Cancel this order and go back to the store?', ar: 'هل تريد إلغاء هذا الطلب والعودة إلى المتجر؟' },
  yes: { en: 'Yes, cancel', ar: 'نعم، إلغاء' },
  no: { en: 'Stay', ar: 'البقاء' },
} satisfies Record<string, Txt>;
const X = TAMARA_TX;

const CANCEL: CancelConfirm = { label: X.back, question: X.question, yes: X.yes, no: X.no };
const PLANS = ['2', '3', '4', 'full'] as const;
const money = (p: Payment, minor: number) => `${toDecimal(minor, p.currency)} ${p.currency}`;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? ''));
const answersOf = (p: Payment) => flowOf(p)?.answers ?? {};
const shell = (c: KitPayCtx, screen: string, n: number, o: { title: string; sub?: string | null; inner: string; card?: boolean }) =>
  stepShell(c, { layout: 'tamara-hpp', provider: 'Tamara', mono: 'ta', screen, title: o.title, sub: o.sub, action: c.rel.x + screen, inner: o.inner, method: o.card ? 'card' : 'bnpl', card: o.card, stepNo: [n, 5], cancel: CANCEL, choice: (answersOf(c.payment).k_outcome as string | undefined) ?? null });

/** The plan of the checkout (instalments 2 / 3 / 4; 1 or PAY_NOW: in full), else 3. */
function defaultPlan(p: Payment): string {
  const r = p.request as Json;
  if (String(r.payment_type ?? '').toUpperCase() === 'PAY_NOW' || Number(r.instalments) === 1) return 'full';
  const n = String(r.instalments ?? '3');
  return (PLANS as readonly string[]).includes(n) ? n : '3';
}
const planOf = (p: Payment) => String(answersOf(p).plan ?? defaultPlan(p));
const todayOf = (p: Payment) => (planOf(p) === 'full' ? p.amount : instalments(p.amount, Number(planOf(p)))[0]!);

function renderPhone(c: KitPayCtx): string {
  const L = c.view.locale;
  const p = c.payment;
  const phone = String(answersOf(p).phone ?? (((p.request as Json).consumer ?? {}) as Json).phone_number ?? p.providerData.otpPhone ?? '');
  const inner = `<label class="k-field"><span class="k-lbl">${esc(tx(L, X.phone))}</span><input class="k-input k-num" type="tel" name="phone" dir="ltr" autocomplete="off" value="${esc(phone)}" placeholder="+9665XXXXXXXX" required data-testid="stubyard-phone"></label><div class="k-err hide" id="phone-err" role="alert" data-testid="stubyard-phone-error"></div>
<p class="k-hint" data-testid="stubyard-test-buyers">${esc(tx(L, X.testPhones))}</p>${continueBtn(tx(L, X.sendOtp), 'stubyard-send-otp')}`;
  return shell(c, 'phone', 1, { title: tx(L, X.phoneTitle), sub: tx(L, X.phoneSub), inner });
}

function renderOtp(c: KitPayCtx): string {
  const L = c.view.locale;
  const stc = (c.payment.providerData.stc ?? {}) as { phone?: string; otp?: string; verified?: boolean };
  const phone = displayPhone(stc.phone ?? String(answersOf(c.payment).phone ?? ''), c.payment.currency);
  // Sandbox: the code is filled in (Tamara's sandbox does this); a wrong code typed over it is still checked.
  const inner = `<p data-testid="stubyard-otp-phone">${esc(fill(tx(L, X.otpSent), { p: phone }))}</p>${otpInput(L, { length: 6, value: c.stepError ? null : (stc.otp ?? null), hint: tx(L, X.otpHint) })}${continueBtn(tx(L, X.verify), 'stubyard-otp-submit')}
<p><button type="submit" class="k-linkbtn" name="back" value="1" formnovalidate data-testid="stubyard-change-number">${esc(tx(L, X.changeNumber))}</button></p>`;
  return shell(c, 'otp', 2, { title: tx(L, X.otpTitle), inner });
}

function renderTerms(c: KitPayCtx): string {
  const L = c.view.locale;
  const inner = `<p data-testid="stubyard-terms-text">${esc(tx(L, X.termsText))}</p><label class="k-check"><input type="checkbox" name="terms" value="1" required data-testid="stubyard-terms"> <span>${esc(tx(L, X.agree))}</span></label>${continueBtn(tx(L, X.cont))}`;
  return shell(c, 'terms', 3, { title: tx(L, X.termsTitle), inner });
}

function planOption(L: Locale, p: Payment, v: string, on: boolean): string {
  const label = v === 'full' ? tx(L, X.full) : fill(tx(L, X.splitIn), { n: v });
  let sub: string;
  if (v === 'full') sub = fill(tx(L, X.fullSub), { a: money(p, p.amount) });
  else {
    const parts = instalments(p.amount, Number(v));
    sub = fill(tx(L, X.splitSub), { a: money(p, parts[0]!), m: parts.length - 1, b: money(p, parts[1]!) });
  }
  return `<label class="k-plan"><input type="radio" name="plan" value="${v}"${on ? ' checked' : ''} data-testid="stubyard-plan-${v}"><span><b>${esc(label)}</b><small>${esc(sub)}</small></span></label>`;
}

function renderPlan(c: KitPayCtx): string {
  const L = c.view.locale;
  const cur = planOf(c.payment);
  const inner = `<div class="k-plans" role="radiogroup" aria-label="${esc(tx(L, X.planTitle))}" data-testid="stubyard-plans">${PLANS.map((v) => planOption(L, c.payment, v, v === cur)).join('')}</div>${continueBtn(tx(L, X.cont))}`;
  return shell(c, 'plan', 4, { title: tx(L, X.planTitle), inner });
}

function renderCard(c: KitPayCtx): string {
  const L = c.view.locale;
  const p = c.payment;
  const inner = `${bnplCard(L)}${payBtn(tx(L, X.pay))}<p><button type="submit" class="k-linkbtn" name="back" value="1" formnovalidate data-testid="stubyard-back-step">${esc(tx(L, X.changePlan))}</button></p>`;
  return shell(c, 'card', 5, { title: tx(L, X.cardTitle), sub: fill(tx(L, X.cardSub), { a: money(p, todayOf(p)) }), inner, card: true });
}

const render = (c: KitPayCtx, step: string) =>
  step === 'otp' ? renderOtp(c) : step === 'terms' ? renderTerms(c) : step === 'plan' ? renderPlan(c) : step === 'card' ? renderCard(c) : renderPhone(c);
const validPhone = (v: string | null) => !!v && v.replace(/\D/g, '').length >= 8 && v.replace(/\D/g, '').length <= 15;

export const tamaraLayout: ProviderLayout = {
  id: 'tamara-hpp',
  provider: 'Tamara',
  threeds: 'redirect',
  renderPay: (c) => render(c, flowOf(c.payment)?.flow === 'tamara' ? flowOf(c.payment)!.step : 'phone'),
  prepare: (svc, p) => {
    if (!OPEN.includes(p.status)) return p;
    const f = flowOf(p);
    if (f?.flow === 'tamara' && f.step !== 'done') return p;
    return svc.repo.update(p.id, { providerData: startFlow(p, 'tamara') });
  },
  steps: {
    phone: {
      flow: 'tamara',
      next: 'otp',
      validate: (b, L) => (validPhone(str(b.phone)) ? null : tx(L, X.badPhone)),
      answers: (b) => ({ phone: str(b.phone), method: 'bnpl', user: str(b.user), k_outcome: str(b.k_outcome) }),
    },
    otp: {
      flow: 'tamara',
      next: 'terms',
      back: 'phone',
      enter: (x) => x.svc.otpStart(x.payment, String(x.answers.phone ?? ''), 'Tamara'),
      act: (x) => {
        const r = x.svc.otpCheck(x.payment, str(x.body.otp));
        if (r.result === 'exhausted') return { payment: r.payment, finish: 'decline:generic' };
        if (r.result !== 'ok') return { payment: r.payment, error: !str(x.body.otp) ? tx(x.locale, X.noCode) : fill(tx(x.locale, X.wrong), { n: 3 - Number((r.payment.providerData.stc as { tries?: number } | undefined)?.tries ?? 0) }) };
        return isTamaraDeclinePhone(String(x.answers.phone ?? '')) ? { payment: r.payment, finish: 'decline:generic' } : { payment: r.payment };
      },
    },
    terms: { flow: 'tamara', next: 'plan', validate: (b, L) => (str(b.terms) === '1' ? null : tx(L, X.mustAgree)) },
    plan: {
      flow: 'tamara',
      next: 'card',
      back: 'terms',
      validate: (b, L) => ((PLANS as readonly string[]).includes(String(b.plan ?? '')) ? null : tx(L, X.badPlan)),
      answers: (b) => ({ plan: str(b.plan) }),
      act: (x) => {
        x.svc.repo.addEvent(x.payment, 'tamara_plan', { plan: str(x.body.plan) });
        return {};
      },
    },
    card: {
      flow: 'tamara',
      next: 'done',
      back: 'plan',
      validate: (b, L) => (str(b.card_last4) ? null : tx(L, X.badCard)),
      answers: (b) => cardAnswers(b),
    },
  },
  renderStep: render,
};

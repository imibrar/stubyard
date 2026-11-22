import type { KitPayCtx } from '../kit/context.js';
import { flowOf } from '../kit/flow.js';
import { hostedLayout } from '../kit/hpp.js';
import type { ProviderLayout } from '../kit/layout.js';
import { pkE164, pkMobile, renderWalletOtp, voucherScreen, walletFields, walletOtpAct } from '../kit/wallet.js';
import { toDecimal } from '../engine.js';

/**
 * Easypaisa hosted checkout (Index.jsf / Confirm.jsf; research R3; English only, D11): the method choice, then
 * - Mobile Account: the account number → SMS OTP → confirm (the merchant docs show no MPIN step);
 * - OTC voucher: the payment token and its expiry (72 h), then the redirect with paymentToken;
 * - Card: the kit card form, 3-D Secure on the simulated ACS page.
 * The postBackURL redirect (success, status, desc, orderRefNumber, paymentToken) is unchanged. Screens: assumed.
 */

/** English only (D11): the provider screens ignore the page language switch. */
const en = (c: KitPayCtx): KitPayCtx => (c.view.locale === 'en' ? c : { ...c, view: { ...c.view, locale: 'en' } });

const W = { layout: 'easypaisa-hosted' as const, provider: 'Easypaisa', mono: 'EP' };

const page = hostedLayout(
  {
    layout: 'easypaisa-hosted',
    provider: 'Easypaisa',
    methodStyle: 'list',
    methodsLabel: { en: 'Select payment method', ar: 'Select payment method' },
    methodLabels: { wallet: { en: 'Easypaisa Mobile Account', ar: 'Easypaisa Mobile Account' }, voucher: { en: 'Pay at an Easypaisa shop (OTC)', ar: 'Pay at an Easypaisa shop (OTC)' }, card: { en: 'Credit / Debit Card', ar: 'Credit / Debit Card' } },
    cardholder: 'none',
    payLabel: (_L, amount) => `Proceed to pay ${amount}`,
    walletFields: (c, methods) => walletFields({ label: 'Mobile account number', value: pkMobile(c.payment.providerData.msisdn) ?? null, hint: 'Any 03XXXXXXXXX number; the code arrives in the stubyard SMS inbox.' })(c, methods),
    summary: (c) => [[{ en: 'Order', ar: 'Order' }, c.payment.reference ?? c.payment.providerRef]],
  },
  { threeds: 'redirect' },
);

const onOtp = (c: KitPayCtx) => {
  const f = flowOf(c.payment);
  return f?.flow === 'easypaisa-ma' && f.step === 'otp';
};

export const easypaisaLayout: ProviderLayout = {
  ...page,
  renderPay: (c) => (onOtp(c) ? renderWalletOtp(en(c), W, [2, 2], true) : page.renderPay(en(c))),
  payInto: (method, b) => {
    if (method !== 'wallet') return null;
    const msisdn = pkMobile(b.phone);
    if (!msisdn) return { flow: 'easypaisa-ma', step: 'otp', error: 'Enter your Easypaisa mobile account number (03XXXXXXXXX).' };
    return { flow: 'easypaisa-ma', step: 'otp', answers: { phone: pkE164(msisdn), msisdn, method: 'wallet' } };
  },
  steps: {
    otp: {
      flow: 'easypaisa-ma',
      next: 'done',
      enter: (x) => x.svc.otpStart(x.payment, String(x.answers.phone ?? ''), 'Easypaisa'),
      act: walletOtpAct,
    },
  },
  renderStep: (c) => renderWalletOtp(en(c), W, [2, 2], true),
  returnPage: (r) => {
    const token = r.payment.providerData.paymentToken;
    if (r.kind !== 'redirect' || r.payment.method !== 'voucher' || !token) return null;
    return voucherScreen({ ...W, host: r.host, code: String(token), expiry: r.payment.providerData.tokenExpiry ? String(r.payment.providerData.tokenExpiry).slice(0, 16) : null, amount: `PKR ${toDecimal(r.payment.amount, 'PKR')}`, url: r.url, method: 'get', fields: {}, codeLabel: 'Your payment token' });
  },
};

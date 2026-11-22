import type { KitPayCtx } from '../kit/context.js';
import { flowOf } from '../kit/flow.js';
import { hostedLayout } from '../kit/hpp.js';
import type { ProviderLayout } from '../kit/layout.js';
import { pkE164, pkMobile, renderMpin, renderWalletOtp, stampText, voucherScreen, walletFields, walletOtpAct } from '../kit/wallet.js';
import { toDecimal } from '../engine.js';

/**
 * JazzCash Page Redirection (research R3; English only, D11): the method choice (Mobile Account, Card, Voucher),
 * then
 * - Mobile Account: mobile number + the last 6 digits of the CNIC → MPIN (any 4 digits; never posted) → SMS OTP;
 * - Card: the kit card form, 3-D Secure on the simulated ACS page (full-page redirect);
 * - Voucher (OTC): the voucher number (pp_RetreivalReferenceNo) and its expiry, then the return (code 124, pending;
 *   the IPN follows when it settles).
 * The signed POST back to pp_ReturnURL (pp_SecureHash) is unchanged: this page only draws the screens before it.
 * Screens: assumed (JazzCash publishes no screen spec; the test values 03123456789 / 345678 / MPIN 1234 come from
 * unofficial integration guides).
 */

/** English only (D11): the provider screens ignore the page language switch. */
const en = (c: KitPayCtx): KitPayCtx => (c.view.locale === 'en' ? c : { ...c, view: { ...c.view, locale: 'en' } });

const W = { layout: 'jazzcash-hosted' as const, provider: 'JazzCash', mono: 'JC' };

const page = hostedLayout(
  {
    layout: 'jazzcash-hosted',
    provider: 'JazzCash',
    methodStyle: 'tabs',
    methodsLabel: { en: 'Pay with', ar: 'Pay with' },
    methodLabels: { wallet: { en: 'Mobile Account', ar: 'Mobile Account' }, card: { en: 'Debit / Credit Card', ar: 'Debit / Credit Card' }, voucher: { en: 'Voucher Payment', ar: 'Voucher Payment' } },
    cardholder: 'none',
    payLabel: (_L, amount) => `Pay ${amount}`,
    walletFields: (c, methods) => walletFields({ label: 'Mobile number', value: pkMobile(c.payment.providerData.phone) ?? null, cnic: true, hint: 'Unofficial test values: 03123456789, CNIC 345678, then any MPIN. The code arrives in the stubyard SMS inbox.' })(c, methods),
    summary: (c) => [[{ en: 'Order', ar: 'Order' }, c.payment.reference ?? c.payment.providerRef]],
  },
  { threeds: 'redirect' },
);

const walletStep = (c: KitPayCtx) => {
  const f = flowOf(c.payment);
  return f?.flow === 'jazzcash-wallet' && (f.step === 'mpin' || f.step === 'otp') ? f.step : null;
};

export const jazzcashLayout: ProviderLayout = {
  ...page,
  renderPay: (c0) => {
    const c = en(c0);
    const s = walletStep(c);
    return s === 'mpin' ? renderMpin(c, W, [2, 3]) : s === 'otp' ? renderWalletOtp(c, W, [3, 3], true) : page.renderPay(c);
  },
  payInto: (method, b) => {
    if (method !== 'wallet') return null;
    const msisdn = pkMobile(b.phone);
    if (!msisdn) return { flow: 'jazzcash-wallet', step: 'mpin', error: 'Enter your JazzCash mobile number (03XXXXXXXXX).' };
    if (!/^\d{6}$/.test(String(b.cnic ?? '').trim())) return { flow: 'jazzcash-wallet', step: 'mpin', error: 'Enter the last 6 digits of your CNIC.' };
    // The CNIC is checked for its form only and not kept.
    return { flow: 'jazzcash-wallet', step: 'mpin', answers: { phone: pkE164(msisdn), msisdn, method: 'wallet' } };
  },
  steps: {
    mpin: { flow: 'jazzcash-wallet', next: 'otp' },
    otp: {
      flow: 'jazzcash-wallet',
      next: 'done',
      enter: (x) => x.svc.otpStart(x.payment, String(x.answers.phone ?? ''), 'JazzCash'),
      act: walletOtpAct,
    },
  },
  renderStep: (c0, step) => (step === 'otp' ? renderWalletOtp(en(c0), W, [3, 3], true) : renderMpin(en(c0), W, [2, 3])),
  returnPage: (r) => {
    if (r.kind !== 'post' || r.payment.method !== 'voucher' || r.fields.pp_ResponseCode !== '124') return null;
    return voucherScreen({ ...W, host: r.host, code: r.fields.pp_RetreivalReferenceNo || r.payment.providerRef, expiry: stampText(r.fields.pp_SettlementExpiry), amount: `PKR ${toDecimal(r.payment.amount, 'PKR')}`, url: r.url, method: 'post', fields: r.fields, codeLabel: 'Your voucher number' });
  },
};

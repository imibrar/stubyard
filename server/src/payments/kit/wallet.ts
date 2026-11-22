import { esc } from '../../auth/pages.js';
import type { Json } from '../gateway.js';
import type { PaymentMethod } from '../repo.js';
import type { KitPayCtx } from './context.js';
import { hiddenFields } from './fields.js';
import { kitDocument } from './shell.js';
import { flowOf } from './flow.js';
import { continueBtn, otpInput, stepShell } from './steps.js';
import type { LayoutId } from './registry.js';
import { displayPhone } from '../pages.js';

/**
 * Pakistani mobile-account screens shared by the JazzCash and Easypaisa hosted pages (P3, English only per D11):
 * the mobile number field of the pay screen, the MPIN screen (JazzCash; the MPIN is never posted), the OTP screen
 * and the voucher / token screen before the return. Screens: assumed (no public screen spec).
 */

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 03XXXXXXXXX from a typed number (03…, 3…, +92 3…, 0092 3…), else null. */
export function pkMobile(raw: unknown): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  const local = d.startsWith('0092') ? '0' + d.slice(4) : d.startsWith('92') ? '0' + d.slice(2) : d.startsWith('3') ? '0' + d : d;
  return /^03\d{9}$/.test(local) ? local : null;
}
export const pkE164 = (local: string) => '+92' + local.slice(1);

export function walletFields(o: { label: string; value: string | null; cnic?: boolean; hint: string }): (c: KitPayCtx, methods: PaymentMethod[]) => string {
  return (_c, methods) => {
    if (!methods.includes('wallet')) return '';
    return `<div data-for="wallet"><label class="k-field"><span class="k-lbl">${esc(o.label)}</span><input class="k-input k-num" type="tel" name="phone" dir="ltr" inputmode="numeric" placeholder="03XXXXXXXXX" maxlength="15"${o.value ? ` value="${esc(o.value)}"` : ''} data-testid="stubyard-phone"></label><div class="k-err hide" id="phone-err" role="alert" data-testid="stubyard-phone-error"></div>
${o.cnic ? `<label class="k-field"><span class="k-lbl">CNIC (last 6 digits)</span><input class="k-input k-num" type="text" name="cnic" dir="ltr" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="XXXXXX" data-testid="stubyard-cnic"></label>` : ''}<p class="k-hint" data-testid="stubyard-wallet-hint">${esc(o.hint)}</p></div>`;
  };
}

interface WalletScreen {
  layout: LayoutId;
  provider: string;
  mono: string;
}

export function renderMpin(c: KitPayCtx, w: WalletScreen, n: [number, number]): string {
  const msisdn = String(flowOf(c.payment)?.answers.msisdn ?? '');
  const inner = `<p>Enter the 4-digit MPIN of the ${esc(w.provider)} account <b dir="ltr" data-testid="stubyard-wallet-number">${esc(msisdn)}</b>.</p>
<label class="k-field"><span class="k-lbl">MPIN</span><input class="k-input k-otp" type="password" id="mpin" inputmode="numeric" maxlength="4" autocomplete="off" dir="ltr" aria-describedby="mpin-h" data-testid="stubyard-mpin"></label><p class="k-hint" id="mpin-h">Any 4 digits work (1234 in the unofficial test values): the MPIN is not sent.</p>${continueBtn('Continue')}`;
  return stepShell(c, { layout: w.layout, provider: w.provider, mono: w.mono, screen: 'mpin', title: 'Enter your MPIN', action: c.rel.x + 'mpin', inner, method: 'wallet', stepNo: n });
}

export function renderWalletOtp(c: KitPayCtx, w: WalletScreen, n: [number, number], last: boolean): string {
  const stc = (c.payment.providerData.stc ?? {}) as { phone?: string };
  const inner = `<p data-testid="stubyard-otp-phone">We sent a 6-digit code by SMS to <b dir="ltr">${esc(displayPhone(stc.phone ?? '', c.payment.currency))}</b>.</p>${otpInput('en', { length: 6, hint: 'Find the code in the stubyard SMS inbox. Three wrong codes decline the payment.' })}${
    last ? `<button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-testid="stubyard-otp-submit"><span class="k-spin" aria-hidden="true"></span><span class="k-label">Confirm and pay ${esc(c.input.amount)}</span></button>` : continueBtn('Verify', 'stubyard-otp-submit')
  }`;
  return stepShell(c, { layout: w.layout, provider: w.provider, mono: w.mono, screen: 'otp', title: 'Verify the payment', action: c.rel.x + 'otp', inner, method: 'wallet', stepNo: n });
}

/** The OTP step's act: verify (otpCheck); three wrong codes decline. */
export function walletOtpAct(x: { svc: import('../service.js').PaymentService; payment: import('../repo.js').Payment; body: Json }) {
  const r = x.svc.otpCheck(x.payment, str(x.body.otp));
  if (r.result === 'exhausted') return { payment: r.payment, finish: 'decline:generic' };
  if (r.result !== 'ok') return { payment: r.payment, error: str(x.body.otp) ? (r.message ?? 'Wrong code') : 'Enter the code.' };
  return { payment: r.payment };
}

/** "Pay at a shop" screen before the return (JazzCash voucher: the signed POST; Easypaisa token: the redirect). */
export function voucherScreen(o: { provider: string; mono: string; layout: LayoutId; host: string | null; code: string; expiry: string | null; amount: string; url: string; method: 'post' | 'get'; fields: Record<string, string>; codeLabel: string }): string {
  let action = o.url;
  let fields = o.fields;
  if (o.method === 'get') {
    const u = new URL(o.url);
    fields = { ...Object.fromEntries(u.searchParams), ...o.fields };
    u.search = '';
    action = u.toString();
  }
  const body = `<main class="k-wrap"><form method="${o.method}" action="${esc(action)}" class="k-card k-hpp" data-layout="${o.layout}" data-screen="voucher" data-testid="stubyard-return-form">${hiddenFields(fields)}
<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(o.mono)}</div><h1>${esc(o.provider)}<small>${esc(o.provider)}, simulated by stubyard</small></h1><div class="k-amt">${esc(o.amount)}</div></div>
<div class="k-sec" data-testid="stubyard-done" data-status="pending"><h2 class="k-h2">Pay at a shop to complete your order</h2><p>${esc(o.codeLabel)}:</p><div class="k-voucher" data-testid="stubyard-voucher">${esc(o.code)}</div>
${o.expiry ? `<p class="k-hint" data-testid="stubyard-voucher-expiry">Pay before ${esc(o.expiry)} (Pakistan time). The payment stays pending until it is paid; stubyard settles it as the test outcome says and the notification follows.</p>` : ''}
<button type="submit" class="k-paybtn" data-testid="stubyard-return"><span class="k-label">Continue to the shop</span></button></div>
<div class="k-sec k-foot"><span>No real ${esc(o.provider)} was contacted.</span></div></form></main>`;
  return kitDocument({ title: `Voucher · ${o.provider} (simulated)`, locale: 'en', body, banner: { variant: 'strip', host: o.host } });
}

/** yyyyMMddHHmmss → yyyy-MM-dd HH:mm, else the value as is. */
export const stampText = (s: string | null | undefined) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(String(s ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s ? String(s) : null;
};

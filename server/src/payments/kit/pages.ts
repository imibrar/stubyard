import { esc } from '../../auth/pages.js';
import { statusLabel, t, tMessage, type KitKey, type Locale } from './i18n.js';
import type { KitPayCtx, KitRel } from './context.js';
import { drawerHtml, quickHtml } from './drawer.js';
import { cardFields, formScript, hiddenFields, methodHints, methodTiles, phoneField, scriptJson } from './fields.js';
import { kitDocument } from './shell.js';
import type { CheckoutView } from './view.js';

/**
 * Kit pages of the generic pattern (every gateway without a provider layout yet) plus the screens all realistic
 * flows share: the OTP step, the simulated bank (3-D Secure) page and frame, and the result page.
 */

/**
 * Result pages of finished payments are served without the page-URL overrides (routes/payments.ts answers with the
 * done page first), so ?stubyard_lang=en|ar is applied here: stored through x/view, then one reload.
 */
export const VIEW_SCRIPT = `(function(){try{var l=new URLSearchParams(location.search).get('stubyard_lang');if(l!=='en'&&l!=='ar')return;if(document.documentElement.lang===l)return;var r=document.querySelector('[data-view]');if(!r)return;var k='sy-view:'+location.pathname+':'+l;if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1');fetch(r.getAttribute('data-view'),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'lang='+l}).then(function(x){if(x.ok)location.reload()})}catch(e){}})();`;

export const providerTitle = (name: string) => `${name} (simulated)`;

export function payLabel(L: Locale, presetId: string, amount: string, submitType?: string | null): string {
  if (presetId === 'paypal') return t(L, 'approveAmount', { amount });
  if (submitType === 'book') return `${t(L, 'book')} ${amount}`;
  if (submitType === 'donate') return `${t(L, 'donate')} ${amount}`;
  return t(L, 'payAmount', { amount });
}

/** The shared test shortcuts + drawer + form script of a kit pay form. */
export function payFormParts(c: KitPayCtx, o: { requireCard: boolean; choice?: string | null; cards?: boolean }) {
  const i = c.input;
  const L = c.view.locale;
  const drawer = drawerHtml({ locale: L, users: i.users, userId: i.userId, open: c.view.drawerOpen, selfUrl: c.rel.self, dashboardUrl: i.dashboardUrl, mode: c.mode, timings: c.view.timings, cards: o.cards ?? i.methods.some((m) => m === 'card' || m === 'mada'), choice: o.choice ?? null });
  const quick = quickHtml(L, { cancellable: i.cancellable, forced: i.forced });
  const script = formScript({ locale: L, warnAction: c.rel.warning, testCards: i.testCards, requireCard: o.requireCard, timings: c.view.timings, keepKey: c.payment.id });
  return { drawer, quick, script };
}

/** Monograms of the gateways without a Gateway.logo (two providers must never share one: PayPal / PayTabs). */
const MONO: Record<string, string> = { PayPal: 'PP', PayTabs: 'PT', HyperPay: 'HP', Stripe: 'S', 'Stripe Checkout': 'S' };
export const monoOf = (name: string, logo?: string | null) => (logo ?? MONO[name] ?? name.replace(/[^A-Za-z]/g, '').slice(0, 2)) || '$';

export function renderGenericPay(c: KitPayCtx): string {
  const i = c.input;
  const L = c.view.locale;
  const { drawer, quick, script } = payFormParts(c, { requireCard: true });
  const err = i.error ? `<div class="k-sec"><div class="k-alert" role="alert" data-testid="stubyard-error">${esc(tMessage(L, i.error))}</div></div>` : '';
  const meta = [
    i.description ? `<dt>${esc(t(L, 'forLabel'))}</dt><dd>${esc(i.description)}</dd>` : '',
    `<dt>${esc(t(L, 'reference'))}</dt><dd>${esc(i.providerRef)}</dd>`,
    i.email ? `<dt>${esc(t(L, 'email'))}</dt><dd>${esc(i.email)}</dd>` : '',
    i.run ? `<dt>${esc(t(L, 'run'))}</dt><dd>${esc(i.run)}</dd>` : '',
  ].join('');
  const body = `<form method="post" action="${esc(c.rel.pay)}" id="pay"${i.embed ? ' target="_top"' : ''}${i.forced ? ' data-forced' : ''} novalidate>${quick}
<main class="k-wrap"><div class="k-card" data-layout="generic">
<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(monoOf(i.presetName, i.logo))}</div><h1>${esc(c.merchant)}<small>${esc(t(L, 'simulatedBy', { provider: i.presetName }))}${i.reference ? ` · ${esc(i.reference)}` : ''}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(i.amount)}</div></div>
${err}<div class="k-sec"><dl class="k-meta">${meta}</dl></div>
<div class="k-sec">${methodTiles(L, i.methods, i.method)}${cardFields(L, { methods: i.methods })}${phoneField(L, i.methods, i.phone ?? null)}${methodHints(L, i.methods)}
<button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(payLabel(L, i.presetId, i.amount))}</span></button></div>
<div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: i.presetName }))}</span></div>
</div></main>${drawer}</form>`;
  return kitDocument({ title: `${payLabel(L, i.presetId, i.amount)} · ${providerTitle(i.presetName)}`, locale: L, body, scripts: [script], embed: i.embed, banner: { variant: 'full', host: c.host, drawer: true, notice: c.rel.notice } });
}

/** The step-screen fields of a pay context (OTP, bank and result screens drawn from a pay page context). */
export function commonOf(c: KitPayCtx): KitStepCommon {
  return { view: c.view, presetName: c.input.presetName, merchant: c.merchant, amount: c.input.amount, host: c.host, rel: c.rel, dashboardUrl: c.input.dashboardUrl, logo: c.input.logo ?? null };
}

export interface KitStepCommon {
  view: CheckoutView;
  presetName: string;
  merchant: string;
  amount: string;
  host: string | null;
  rel: KitRel;
  dashboardUrl: string;
  logo?: string | null;
}

const head = (s: KitStepCommon, sub: string, mono?: string, small?: string) =>
  `<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(mono ?? monoOf(s.presetName, s.logo))}</div><h1>${esc(sub)}<small>${esc(s.merchant)} · ${esc(small ?? t(s.view.locale, 'simulatedBy', { provider: s.presetName }))}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(s.amount)}</div></div>`;

/** The OTP step (STC Pay, pay later, wallets): posts to x/pay with the earlier answers. */
export function renderKitOtp(s: KitStepCommon & { phoneDisplay: string; method: string; carry: Record<string, string | null>; error?: string | null; codeLength?: number }): string {
  const L = s.view.locale;
  const title = s.method === 'stcpay' ? `STC Pay · ${t(L, 'verification')}` : `${s.presetName} · ${t(L, 'verification')}`;
  const n = s.codeLength ?? 6;
  const sent = esc(t(L, 'otpSent', { n, phone: '%PHONE%' })).replace('%PHONE%', `<b dir="ltr" data-testid="stubyard-otp-phone">${esc(s.phoneDisplay)}</b>`);
  const body = `<main class="k-wrap"><form method="post" action="${esc(s.rel.pay)}" class="k-card" id="otp">${head(s, title)}${hiddenFields({ ...s.carry, method: s.method })}
<div class="k-sec">${s.error ? `<div class="k-alert" role="alert" data-testid="stubyard-otp-error">${esc(tMessage(L, s.error))}</div>` : ''}
<p>${sent}</p>
<label class="k-field"><span class="k-lbl">${esc(t(L, 'code'))}</span><input class="k-input k-otp" type="text" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="${n}" required autofocus data-testid="stubyard-otp"></label>
<button type="submit" class="k-paybtn" data-testid="stubyard-otp-submit"><span class="k-label">${esc(t(L, 'verifyPay'))}</span></button></div>
<div class="k-sec k-foot"><span>${esc(t(L, 'threeWrong'))}</span><a href="${esc(s.dashboardUrl)}" target="_blank" rel="noopener">${esc(t(L, 'openStubyard'))}</a></div></form></main>`;
  return kitDocument({ title, locale: L, body, banner: { variant: 'strip', host: s.host, notice: s.rel.notice } });
}

/** The simulated bank's 3-D Secure page: full page (generic flows) or the frame inside the provider's modal. */
export function renderKitBank(s: KitStepCommon & { frame?: boolean; hint?: string | null; provider?: string | null }): string {
  const L = s.view.locale;
  const target = s.frame ? ' target="_top"' : '';
  const bank = t(L, 'simulatedBank');
  const body = `<main class="k-wrap"><form method="post" action="${esc(s.rel.threeds)}"${target} class="k-card k-bank" data-testid="stubyard-3ds-bank"${s.provider ? ` data-provider="${esc(s.provider)}"` : ''}>${head(s, t(L, 'auth3ds'), '3DS', t(L, 'bankSim'))}
<div class="k-sec"><p>${esc(t(L, 'acsText', { amount: s.amount, merchant: s.merchant }))}</p>
<label class="k-field"><span class="k-lbl">${esc(t(L, 'acsCode'))}</span><input class="k-input k-num" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12" aria-describedby="acs-h" data-testid="stubyard-3ds-code"></label><p class="k-hint" id="acs-h">${esc(t(L, 'acsCodeHint'))}${s.hint ? ` ${esc(s.hint)}` : ''}</p>
<div class="k-grid2"><button type="submit" class="k-btn primary" name="outcome" value="3ds_success" data-testid="stubyard-3ds-pass">${esc(t(L, 'acsComplete'))}</button>
<button type="submit" class="k-btn bad" name="outcome" value="3ds_fail" data-testid="stubyard-3ds-fail">${esc(t(L, 'acsFail'))}</button></div></div></form></main>`;
  return kitDocument({ title: `${t(L, 'auth3ds')} · ${bank}`, locale: L, body, frame: s.frame, banner: { variant: 'strip', host: s.frame ? null : s.host, notice: s.frame ? null : s.rel.notice } });
}

export type ResultTone = 'ok' | 'bad' | 'warn' | 'info';
export interface ResultView {
  tone: ResultTone;
  title: KitKey;
  messageKey?: KitKey;
  /** A server message (the decline text), translated where the kit knows it. */
  messageText?: string;
}

/** Title / message / tone of the result screen for a payment status (the classic done page's table, localised). */
export function resultOf(status: string, o: { presetId: string; async: boolean; declineMessage: string }): ResultView {
  if (status === 'paid' || status === 'partially_refunded' || status === 'refunded') return { tone: 'ok', title: 'resComplete', messageKey: 'msgComplete' };
  if (status === 'authorized') return { tone: 'ok', title: o.presetId === 'paypal' ? 'resApproved' : 'resAuthorised', messageKey: o.async ? 'msgProcessing' : 'msgCapture' };
  if (status === 'cancelled') return { tone: 'warn', title: 'resCancelled', messageKey: 'msgCancelled' };
  if (status === 'expired') return { tone: 'warn', title: 'resExpired', messageKey: 'msgExpired' };
  if (status === 'failed') return { tone: 'bad', title: 'resDeclined', messageText: o.declineMessage };
  return { tone: 'info', title: 'resOpen', messageKey: 'msgOpen' };
}

const ICON: Record<ResultTone, string> = { ok: '✓', bad: '!', warn: '–', info: 'i' };

export function renderKitResult(s: KitStepCommon & ResultView & { status: string; returnUrl: string | null; noReturn: boolean; scripts?: string[] }): string {
  const L = s.view.locale;
  const message = s.messageKey ? t(L, s.messageKey) : tMessage(L, s.messageText ?? '');
  const body = `<main class="k-wrap"><div class="k-card">${head(s, t(L, s.title))}
<div class="k-result" data-testid="stubyard-done" data-status="${esc(s.status)}" data-view="${esc(s.rel.x)}view"><span class="k-icon ${s.tone}" aria-hidden="true">${ICON[s.tone]}</span><h1>${esc(t(L, s.title))}</h1><p>${esc(message)}</p>
${s.returnUrl ? `<a class="k-btn primary wide" href="${esc(s.returnUrl)}" data-testid="stubyard-return">${esc(t(L, 'returnShop'))}</a>` : s.noReturn ? `<p class="k-hint" data-testid="stubyard-no-return">${esc(t(L, 'noReturn'))}</p>` : ''}</div>
<div class="k-sec k-foot"><span>${esc(t(L, 'status', { s: statusLabel(L, s.status) }))}</span><a href="${esc(s.dashboardUrl)}" target="_blank" rel="noopener">${esc(t(L, 'openStubyard'))}</a></div></div></main>`;
  return kitDocument({ title: t(L, s.title), locale: L, body, scripts: [VIEW_SCRIPT, ...(s.scripts ?? [])], banner: { variant: 'strip', host: s.host } });
}

/**
 * The return to the shop in the kit look: an auto-submitting form (POST, or GET with the URL's query as fields),
 * optionally after a countdown (PayTabs) and into another window (framed pages: _top / _parent). Without JS the
 * button continues. Fast timings (automation) skip the countdown.
 */
export function renderKitReturn(s: { view: CheckoutView; host: string | null; presetName: string; url: string; fields: Record<string, string>; method: 'post' | 'get'; target?: '_top' | '_parent' | null; status: string; result: ResultView; countdownS?: number }): string {
  const L = s.view.locale;
  const { tone, title } = s.result;
  const message = s.result.messageKey ? t(L, s.result.messageKey) : tMessage(L, s.result.messageText ?? '');
  let action = s.url;
  let fields = s.fields;
  if (s.method === 'get') {
    const u = new URL(s.url);
    fields = { ...Object.fromEntries(u.searchParams), ...s.fields };
    u.search = '';
    action = u.toString();
  }
  const n = Math.max(0, Math.min(10, s.countdownS ?? 0));
  const cfg = { n, timings: s.view.timings, text: t(L, 'redirecting', { n: '%N%' }) };
  const script = `(function(){var C=${scriptJson(cfg)};var f=document.getElementById('k-ret');if(!f)return;var fast=C.timings==='fast'||(C.timings==='auto'&&navigator.webdriver===true);var n=fast?0:C.n,el=document.getElementById('k-count');
function tick(){if(n<=0){f.submit();return}if(el)el.textContent=C.text.replace('%N%',String(n));n--;setTimeout(tick,1000)}tick()})();`;
  const body = `<main class="k-wrap"><form method="${s.method}" action="${esc(action)}" id="k-ret" class="k-card"${s.target ? ` target="${s.target}"` : ''} data-testid="stubyard-return-form">${hiddenFields(fields)}
<div class="k-result" data-testid="stubyard-done" data-status="${esc(s.status)}"><span class="k-icon ${tone}" aria-hidden="true">${ICON[tone]}</span><h1>${esc(t(L, title))}</h1><p>${esc(message)}</p>
<p class="k-hint" id="k-count" aria-live="polite">${esc(n ? t(L, 'redirecting', { n }) : t(L, 'returning'))}</p>
<button type="submit" class="k-btn primary wide" data-testid="stubyard-return">${esc(t(L, 'continue'))}</button></div>
<div class="k-sec k-foot"><span>${esc(t(L, 'simulatedBy', { provider: s.presetName }))}</span></div></form></main>`;
  return kitDocument({ title: t(L, title), locale: L, body, scripts: [script], banner: { variant: 'strip', host: s.host } });
}

/** A step that is not available (replay / skip of a flow step). */
export function renderKitStepError(s: KitStepCommon & { reason: 'replay' | 'skip' }): string {
  const L = s.view.locale;
  const title = t(L, s.reason === 'replay' ? 'stepDone' : 'stepNotNow');
  const body = `<main class="k-wrap"><div class="k-card">${head(s, title)}<div class="k-sec"><div class="k-alert" role="alert" data-testid="stubyard-step-error" data-reason="${s.reason}">${esc(title)}</div><p><a class="k-btn" href="${esc(s.rel.self)}">${esc(t(L, 'continue'))}</a></p></div></div></main>`;
  return kitDocument({ title, locale: L, body, banner: { variant: 'strip', host: s.host } });
}

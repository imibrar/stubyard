import { esc } from '../../auth/pages.js';
import { toDecimal } from '../engine.js';
import type { Json } from '../gateway.js';
import type { KitPayCtx } from '../kit/context.js';
import { cardFields, methodHints, methodTiles, scriptJson } from '../kit/fields.js';
import { t, tMessage } from '../kit/i18n.js';
import { payFormParts, payLabel, providerTitle } from '../kit/pages.js';
import type { ProviderLayout } from '../kit/layout.js';
import { kitDocument } from '../kit/shell.js';
import { embeddedCompleteScript, embeddedPayScript } from './js.js';

/**
 * Realistic layout of Stripe hosted Checkout (redirect), after research R1 §1A: a two-column page with the order
 * summary on one side (back arrow to cancel_url, merchant name, "Pay <merchant>", amount, line items, total) and
 * the payment form on the other (email, method choice, card number / expiry / CVC, cardholder name, country, Pay).
 * Declines show "Your card was declined." on the same page (retry); 3-D Secure opens a modal with the simulated
 * bank frame; success and cancel redirect to success_url / cancel_url. Neutral stubyard look: no Stripe logo,
 * colours or fonts, the provider name only as text.
 */

const COUNTRY_BY_CURRENCY: Record<string, string> = { USD: 'US', GBP: 'GB', EUR: 'DE', SAR: 'SA', AED: 'AE', KWD: 'KW', BHD: 'BH', QAR: 'QA', OMR: 'OM', EGP: 'EG', PKR: 'PK', JOD: 'JO' };
const COUNTRIES: [string, string][] = [['US', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['SA', 'Saudi Arabia'], ['AE', 'United Arab Emirates'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['QA', 'Qatar'], ['OM', 'Oman'], ['EG', 'Egypt'], ['JO', 'Jordan'], ['PK', 'Pakistan']];

const BACK_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The 3DS modal's short "contacting your bank" pause (skipped in fast timings / under automation). */
const modalScript = (timings: string) => `(function(){var m=document.getElementById('k-3ds');if(!m)return;var fast=${scriptJson(timings)}==='fast'||(${scriptJson(timings)}==='auto'&&navigator.webdriver===true);var f=m.querySelector('iframe');if(f)f.focus();if(fast)return;m.classList.add('k-wait');setTimeout(function(){m.classList.remove('k-wait')},900)})();`;

export function renderStripeHosted(c: KitPayCtx): string {
  const i = c.input;
  const L = c.view.locale;
  const p = c.payment;
  const pd = p.providerData as Json;
  const money = (minor: number) => `${toDecimal(minor, p.currency)} ${p.currency}`;
  const items = ((pd.lineItems as Json[] | undefined) ?? []).filter((li) => li && typeof li === 'object');
  const { drawer, quick, script } = payFormParts(c, { requireCard: true });

  const back = p.cancelUrl
    ? `<button type="submit" class="k-back" name="outcome" value="cancel" formnovalidate aria-label="${esc(t(L, 'back', { merchant: c.merchant }))}" title="${esc(t(L, 'back', { merchant: c.merchant }))}" data-testid="stubyard-back">${BACK_SVG}</button>`
    : '';
  const lines = items
    .map((li) => {
      const qty = Number(li.quantity ?? 1);
      const total = Number(li.amount_total ?? 0);
      const unit = Number((li.price as Json | undefined)?.unit_amount ?? (qty ? total / qty : total));
      return `<li><div><div class="k-iname">${esc(String(li.description ?? ''))}</div><div class="k-isub">${esc(t(L, 'qty', { n: qty }))}${qty > 1 ? ` · ${esc(t(L, 'each', { amount: money(unit) }))}` : ''}</div></div><div class="k-iamt">${esc(money(total))}</div></li>`;
    })
    .join('');
  const summary = `<section class="k-summary" aria-label="${esc(t(L, 'payMerchant', { merchant: c.merchant }))}">
<div class="k-merchant">${back}<span class="k-mlogo" aria-hidden="true">${esc(c.merchant.slice(0, 1).toUpperCase() || 'S')}</span><span>${esc(c.merchant)}</span><span class="k-pill">${esc(t(L, 'testMode'))}</span></div>
<div class="k-paylabel">${esc(t(L, 'payMerchant', { merchant: c.merchant }))}</div><div class="k-bigamt" data-testid="stubyard-amount">${esc(i.amount)}</div>
${lines ? `<ul class="k-items">${lines}</ul><div class="k-tot"><span>${esc(t(L, 'subtotal'))}</span><span>${esc(i.amount)}</span></div>` : ''}<div class="k-tot k-total"><span>${esc(t(L, 'totalDue'))}</span><span>${esc(i.amount)}</span></div>
</section>`;

  const country = COUNTRY_BY_CURRENCY[p.currency.toUpperCase()] ?? 'US';
  const email = i.email ?? '';
  const err = i.error ? `<div class="k-alert" role="alert" data-testid="stubyard-error">${esc(tMessage(L, i.error))}</div>` : '';
  const submitType = typeof pd.submitType === 'string' ? pd.submitType : null;
  const label = submitType === 'book' ? t(L, 'book') : submitType === 'donate' ? t(L, 'donate') : t(L, 'pay');
  const pane = `<section class="k-pane" data-layout="stripe-hosted">
<label class="k-field"><span class="k-lbl">${esc(t(L, 'email'))}</span><input class="k-input" type="email" id="email" autocomplete="off" dir="ltr" placeholder="email@example.com"${email ? ` value="${esc(email)}" readonly` : ''} data-testid="stubyard-email"></label>
${methodTiles(L, i.methods, i.method, { applepay: t(L, 'walletSim', { wallet: 'Apple Pay' }) })}
${cardFields(L, { methods: i.methods, cardholder: true })}
<div data-for="card"><div class="k-field k-addr"><span class="k-lbl" id="addr-l">${esc(t(L, 'country'))}</span><div class="k-group" role="group" aria-labelledby="addr-l"><select class="k-select" style="border:0;border-radius:0" id="country" aria-label="${esc(t(L, 'country'))}">${COUNTRIES.map(([code, name]) => `<option value="${code}"${code === country ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></div></div></div>
${methodHints(L, i.methods.filter((m) => m !== 'card'))}
${err}
<button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-testid="stubyard-pay" aria-describedby="k-total-a"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(label)}</span></button>
<p class="k-hint" id="k-total-a" style="text-align:center">${esc(payLabel(L, 'stripe-checkout', i.amount, submitType))}</p>
<div class="k-foot"><span>${esc(t(L, 'simulatedBy', { provider: 'Stripe' }))}</span><span>${esc(t(L, 'terms'))}</span><span>${esc(t(L, 'privacy'))}</span></div>
<p class="k-hint" style="text-align:center">${esc(t(L, 'noRealProvider', { provider: 'Stripe' }))}</p>
</section>`;

  const modal = c.challenge
    ? `<div class="k-modal" id="k-3ds" role="dialog" aria-modal="true" aria-labelledby="k-3ds-t" data-testid="stubyard-3ds-modal"><div class="k-mbox"><div class="k-mhead"><span id="k-3ds-t">${esc(t(L, 'auth3ds'))}</span><form method="post" action="${esc(c.rel.threeds)}"><button type="submit" class="k-mx" name="outcome" value="3ds_cancel" aria-label="${esc(t(L, 'close'))}" data-testid="stubyard-3ds-close">×</button></form></div>
<div class="k-loading" aria-live="polite"><span class="k-spin" aria-hidden="true"></span>${esc(t(L, 'contactingBank'))}</div><iframe class="k-acs" src="${esc(c.rel.acs)}" title="${esc(t(L, 'auth3ds'))}" data-testid="stubyard-3ds-frame"></iframe></div></div>`
    : '';
  const body = `<form method="post" action="${esc(c.rel.pay)}" id="pay"${i.forced ? ' data-forced' : ''}${c.challenge ? ' inert' : ''} novalidate>${quick}<div class="k-split">${summary}${pane}</div>${drawer}</form>${modal}`;
  return kitDocument({
    title: `${payLabel(L, 'stripe-checkout', i.amount, submitType)} · ${providerTitle('Stripe')}`,
    locale: L,
    body,
    scripts: [script, ...(c.challenge ? [modalScript(c.view.timings)] : []), ...[embeddedPayScript(p)].filter((s): s is string => !!s)],
    banner: { variant: c.challenge ? 'strip' : 'full', host: c.host, drawer: true, notice: c.rel.notice },
  });
}

/** Stripe hosted Checkout: the P0 layout, 3-D Secure in a modal. */
export const stripeLayout: ProviderLayout = {
  id: 'stripe-hosted',
  provider: 'Stripe',
  threeds: 'modal',
  renderPay: renderStripeHosted,
  // Embedded Checkout (fake Stripe.js initEmbeddedCheckout): the frame tells the page instead of navigating itself.
  returnPage: (r) => {
    const s = r.kind === 'redirect' ? embeddedCompleteScript(r.payment, r.url) : null;
    if (!s) return null;
    const L = r.view.locale;
    const body = `<main class="k-wrap"><div class="k-card"><div class="k-result" data-testid="stubyard-done" data-status="${esc(r.status)}" data-sdk="stripe-embedded"><span class="k-icon ok" aria-hidden="true">✓</span><h1>${esc(t(L, r.result.title))}</h1></div><div class="k-sec k-foot"><span>${esc(t(L, 'simulatedBy', { provider: 'Stripe' }))}</span></div></div></main>`;
    return kitDocument({ title: t(L, r.result.title), locale: L, body, scripts: [s], banner: { variant: 'strip', host: r.host } });
  },
  resultScripts: (p) => {
    const s = embeddedCompleteScript(p, null);
    return s ? [s] : [];
  },
};

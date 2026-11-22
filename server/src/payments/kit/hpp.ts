import { esc } from '../../auth/pages.js';
import { OPEN } from '../engine.js';
import type { Payment, PaymentMethod } from '../repo.js';
import type { PaymentService } from '../service.js';
import { renderBankPage } from './bank.js';
import type { KitPayCtx } from './context.js';
import { cardFields, methodHints, methodTiles, phoneField, scriptJson } from './fields.js';
import { flowOf, startAt } from './flow.js';
import { t, tMessage, type Locale } from './i18n.js';
import { tx, type ProviderLayout, type Txt } from './layout.js';
import { commonOf, payFormParts, providerTitle, renderKitBank } from './pages.js';
import type { LayoutId } from './registry.js';
import { kitDocument } from './shell.js';

/**
 * The redirect hosted-page pattern (P1): one configurable renderer for the single-card provider pages (Checkout.com
 * HPP, PayTabs, APS, Tap, MyFatoorah, Moyasar invoice, Geidea, HyperPay widget) plus the screens the provider opens
 * before or instead of the form: the simulated ACS page (3-D Secure as a full-page redirect, or opened directly for
 * a card the app already sent to the API), the KNET / BENEFIT bank page and the method selection screen.
 * Each provider's experience.ts holds only its configuration and wording. Neutral stubyard look throughout.
 */

export interface HppConfig {
  layout: LayoutId;
  provider: string;
  /** Method choice as tabs (tiles) or a vertical list. */
  methodStyle?: 'tabs' | 'list';
  methodLabels?: Partial<Record<PaymentMethod, Txt>>;
  methodsLabel?: Txt;
  /** Text of the primary button (default "Pay <amount>"). */
  payLabel?: (L: Locale, amount: string, c: KitPayCtx) => string;
  cardholder?: 'before' | 'after' | 'none';
  cardLabel?: Txt;
  /** A "save card" box (display only: nothing is stored). */
  saveCard?: (c: KitPayCtx) => boolean;
  /** Summary rows under the head ([label, value]; empty values are skipped). */
  summary?: (c: KitPayCtx) => [Txt | string, string | null][];
  heading?: (c: KitPayCtx) => string;
  /** A back link above the head (outcome cancel → the provider's cancel / back URL). */
  back?: Txt | null;
  /** A provider Cancel button beside Pay (outcome cancel). */
  cancel?: Txt | null;
  footer?: (Txt | string)[];
  /** Compact page (PayTabs framed mode). */
  compact?: (c: KitPayCtx) => boolean;
  /** A line above the form (HTML, already escaped). */
  topNote?: (c: KitPayCtx) => string | null;
  /** Card brands shown as text above the card form (HyperPay data-brands). */
  brandRow?: (c: KitPayCtx) => string[] | null;
  /** The fields of the OTP methods instead of the kit's mobile number field (JazzCash: mobile number + CNIC). */
  walletFields?: (c: KitPayCtx, methods: PaymentMethod[]) => string;
  /** Extra inline scripts of the pay screen (GeideaCheckout popup / drop-in: the bridge to the merchant page). */
  scripts?: (c: KitPayCtx) => string[];
}

const BACK_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const isCard = (m: string) => m === 'card' || m === 'mada';

/** The short "contacting your bank" pause of the 3-D Secure modal (skipped in fast timings / under automation). */
export const modalScript = (timings: string) => `(function(){var m=document.getElementById('k-3ds');if(!m)return;var fast=${scriptJson(timings)}==='fast'||(${scriptJson(timings)}==='auto'&&navigator.webdriver===true);var f=m.querySelector('iframe');if(f)f.focus();if(fast)return;m.classList.add('k-wait');setTimeout(function(){m.classList.remove('k-wait')},900)})();`;

/** 3-D Secure in a frame over the page (the simulated bank in x/acs; closing it fails the authentication). */
export function threedsModal(c: KitPayCtx): string {
  const L = c.view.locale;
  return `<div class="k-modal" id="k-3ds" role="dialog" aria-modal="true" aria-labelledby="k-3ds-t" data-testid="stubyard-3ds-modal"><div class="k-mbox"><div class="k-mhead"><span id="k-3ds-t">${esc(t(L, 'auth3ds'))}</span><form method="post" action="${esc(c.rel.threeds)}"><button type="submit" class="k-mx" name="outcome" value="3ds_cancel" aria-label="${esc(t(L, 'close'))}" data-testid="stubyard-3ds-close">×</button></form></div>
<div class="k-loading" aria-live="polite"><span class="k-spin" aria-hidden="true"></span>${esc(t(L, 'contactingBank'))}</div><iframe class="k-acs" src="${esc(c.rel.acs)}" title="${esc(t(L, 'auth3ds'))}" data-testid="stubyard-3ds-frame"></iframe></div></div>`;
}

export function renderHpp(c: KitPayCtx, cfg: HppConfig): string {
  const i = c.input;
  const L = c.view.locale;
  const methods = c.selected ? [c.selected] : i.methods;
  const cardMs = methods.filter(isCard);
  const { drawer, quick, script } = payFormParts(c, { requireCard: true });
  const compact = cfg.compact?.(c) ?? false;
  const labels: Partial<Record<string, string>> = Object.fromEntries(Object.entries(cfg.methodLabels ?? {}).map(([k, v]) => [k, tx(L, v as Txt)]));
  const pay = cfg.payLabel ? cfg.payLabel(L, i.amount, c) : t(L, 'payAmount', { amount: i.amount });
  const rows = (cfg.summary?.(c) ?? []).filter(([, v]) => v !== null && v !== '');
  const err = i.error ? `<div class="k-alert" role="alert" data-testid="stubyard-error">${esc(tMessage(L, i.error))}</div>` : '';
  const holder = (cfg.cardholder ?? 'after') !== 'none' && cardMs.length ? `<div data-for="${cardMs.join(' ')}"><label class="k-field"><span class="k-lbl">${esc(t(L, 'cardholder'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(L, 'fullName'))}" data-testid="stubyard-cardholder"></label></div>` : '';
  const save = cfg.saveCard?.(c) && cardMs.length ? `<div data-for="${cardMs.join(' ')}"><label class="k-check"><input type="checkbox" value="1" data-testid="stubyard-save-card"> ${esc(t(L, 'saveCard'))}</label></div>` : '';
  const brands = cfg.brandRow?.(c);
  const brandRow = brands?.length ? `<div class="k-brands" data-testid="stubyard-brands"><span class="k-lbl">${esc(t(L, 'brandsAccepted'))}:</span>${brands.map((b) => `<span class="k-bchip">${esc(b)}</span>`).join('')}</div>` : '';
  const change = c.selected && i.methods.length > 1 ? `<p class="k-change"><a href="${esc(c.rel.self)}" data-testid="stubyard-change-method">${esc(t(L, 'changeMethod'))}</a></p>` : '';
  const back = cfg.back && i.cancellable ? `<div class="k-topbar"><button type="submit" class="k-linkbtn" name="outcome" value="cancel" formnovalidate data-testid="stubyard-back">${BACK_SVG}<span>${esc(tx(L, cfg.back))}</span></button></div>` : '';
  const cancel = cfg.cancel && i.cancellable ? `<button type="submit" class="k-btn k-pcancel" name="outcome" value="cancel" formnovalidate data-testid="stubyard-provider-cancel">${esc(tx(L, cfg.cancel))}</button>` : '';
  const heading = cfg.heading ? cfg.heading(c) : c.merchant;
  const note = cfg.topNote?.(c) ?? '';
  const foot = (cfg.footer ?? []).map((f) => `<span>${esc(tx(L, f))}</span>`).join('');
  const body = `<form method="post" action="${esc(c.rel.pay)}" id="pay"${i.embed ? ' target="_top"' : ''}${i.forced ? ' data-forced' : ''}${c.challenge ? ' inert' : ''} novalidate>${quick}
<main class="k-wrap${compact ? ' k-compact' : ''}"><div class="k-card k-hpp" data-layout="${cfg.layout}" data-screen="${c.selected ? 'method' : 'pay'}">${back}
<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(c.merchant.slice(0, 1).toUpperCase() || 'S')}</div><h1>${esc(heading)}<small>${esc(t(L, 'simulatedBy', { provider: cfg.provider }))}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(i.amount)}</div></div>
${note}${rows.length ? `<div class="k-sec"><dl class="k-meta">${rows.map(([k, v]) => `<dt>${esc(tx(L, k))}</dt><dd>${esc(v ?? '')}</dd>`).join('')}</dl></div>` : ''}
<div class="k-sec">${err}${change}${methodTiles(L, methods, i.method, labels, { list: cfg.methodStyle === 'list', label: cfg.methodsLabel ? tx(L, cfg.methodsLabel) : undefined })}${brandRow}${cfg.cardholder === 'before' ? holder : ''}${cardFields(L, { methods, label: cfg.cardLabel ? tx(L, cfg.cardLabel) : undefined })}${cfg.cardholder === 'before' ? '' : holder}${cfg.walletFields ? cfg.walletFields(c, methods) : phoneField(L, methods, i.phone ?? null, labels)}${methodHints(L, methods)}${save}
<div class="k-actions"><button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(pay)}</span></button>${cancel}</div></div>
<div class="k-sec k-foot">${foot}<span>${esc(t(L, 'noRealProvider', { provider: cfg.provider }))}</span></div>
</div></main>${drawer}</form>${c.challenge ? threedsModal(c) : ''}`;
  return kitDocument({
    title: `${pay} · ${providerTitle(cfg.provider)}`,
    locale: L,
    body,
    scripts: [script, ...(c.challenge ? [modalScript(c.view.timings)] : []), ...(cfg.scripts?.(c) ?? [])],
    embed: i.embed,
    banner: { variant: c.challenge ? 'strip' : 'full', host: c.host, drawer: true, notice: c.rel.notice },
  });
}

/** The method selection screen (MyFatoorah): one button per method, POST x/select. */
export function renderMethodSelect(c: KitPayCtx, cfg: HppConfig): string {
  const i = c.input;
  const L = c.view.locale;
  const { drawer, quick, script } = payFormParts(c, { requireCard: false, cards: false });
  const labels: Partial<Record<string, string>> = Object.fromEntries(Object.entries(cfg.methodLabels ?? {}).map(([k, v]) => [k, tx(L, v as Txt)]));
  const rows = (cfg.summary?.(c) ?? []).filter(([, v]) => v !== null && v !== '');
  const err = i.error ? `<div class="k-alert" role="alert" data-testid="stubyard-error">${esc(tMessage(L, i.error))}</div>` : '';
  const tiles = i.methods.map((m) => `<button type="submit" class="k-tile" name="method" value="${m}" data-testid="stubyard-method-${m}"><span>${esc(labels[m] ?? m)}</span><span class="k-chev" aria-hidden="true">›</span></button>`).join('');
  const body = `<form method="post" action="${esc(c.rel.x + 'select')}" id="pay"${i.forced ? ' data-forced' : ''} novalidate>${quick}
<main class="k-wrap"><div class="k-card k-hpp" data-layout="${cfg.layout}" data-screen="select">
<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(c.merchant.slice(0, 1).toUpperCase() || 'S')}</div><h1>${esc(cfg.heading ? cfg.heading(c) : c.merchant)}<small>${esc(t(L, 'simulatedBy', { provider: cfg.provider }))}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(i.amount)}</div></div>
${rows.length ? `<div class="k-sec"><dl class="k-meta">${rows.map(([k, v]) => `<dt>${esc(tx(L, k))}</dt><dd>${esc(v ?? '')}</dd>`).join('')}</dl></div>` : ''}
<div class="k-sec">${err}<h2 class="k-h2" id="sel-h">${esc(t(L, 'choosePayment'))}</h2><div class="k-tiles" role="group" aria-labelledby="sel-h">${tiles}</div></div>
<div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: cfg.provider }))}</span></div>
</div></main>${drawer}</form>`;
  return kitDocument({ title: `${t(L, 'choosePayment')} · ${providerTitle(cfg.provider)}`, locale: L, body, scripts: [script], banner: { variant: 'full', host: c.host, drawer: true, notice: c.rel.notice } });
}

/**
 * The first screen of a hosted provider page: a pending 3-D Secure challenge (the ACS page, or the modal), a pending
 * bank page, the method selection (when the layout has one and the buyer has not chosen yet) or the pay form.
 */
export function hostedScreen(c: KitPayCtx, def: ProviderLayout, cfg: HppConfig, o: { select?: boolean } = {}): string {
  const f = flowOf(c.payment);
  if (OPEN.includes(c.payment.status)) {
    if (f?.flow === 'card-3ds' && f.step === 'challenge' && !c.challenge) {
      if (def.threeds === 'modal') return renderHpp({ ...c, challenge: true }, cfg);
      return renderKitBank({ ...commonOf(c), presetName: cfg.provider, hint: def.acsHint ? tx(c.view.locale, def.acsHint) : null, provider: cfg.provider });
    }
    if (f?.flow === 'bank' && f.step === 'bank') return renderBankPage(c, def, String(f.answers.method ?? 'knet'));
  }
  if (o.select && !c.selected && c.input.methods.length > 1) return renderMethodSelect(c, cfg);
  return renderHpp(c, cfg);
}

/** A provider layout of the hosted-page pattern from its configuration (the experience files stay thin). */
export function hostedLayout(cfg: HppConfig, o: Omit<ProviderLayout, 'id' | 'provider' | 'renderPay' | 'prepare'> & { select?: boolean; acsDirect?: (p: Payment) => boolean }): ProviderLayout {
  const { select, acsDirect, ...rest } = o;
  const def: ProviderLayout = { id: cfg.layout, provider: cfg.provider, ...rest, renderPay: (c) => hostedScreen(c, def, cfg, { select }) };
  def.prepare = prepareHosted(def, { acsDirect });
  return def;
}

/** The methods the hosted page offers for a payment (the gateway's methodsFor, as the page routes compute it). */
export function pageMethods(svc: PaymentService, p: Payment): PaymentMethod[] {
  const inst = svc.repo.instanceById(p.instanceId);
  if (!inst) return [];
  const g = svc.gateway(inst.preset);
  if (g.methodsFor) return g.methodsFor(p);
  const allowed = p.providerData.methods as PaymentMethod[] | undefined;
  return allowed?.length ? g.methods.filter((x) => allowed.includes(x)) : g.methods;
}

/**
 * GET-time preparation of a hosted page:
 * - a card the app already sent to the API (providerData.apiCard) waits for 3-D Secure: the page is the ACS page;
 * - a single bank method (KNET / BENEFIT: Tap src_kw.knet, MyFatoorah ExecutePayment with KNET): the bank page.
 */
export function prepareHosted(def: ProviderLayout, o: { acsDirect?: (p: Payment) => boolean } = {}): (svc: PaymentService, p: Payment) => Payment {
  return (svc, p) => {
    if (!OPEN.includes(p.status)) return p;
    const f = flowOf(p);
    const methods = pageMethods(svc, p);
    const acs = o.acsDirect ? o.acsDirect(p) : !!p.providerData.apiCard && methods.length > 0 && methods.every(isCard);
    if (acs) {
      if (f?.flow === 'card-3ds' && f.step === 'challenge') return p;
      const out = svc.repo.update(p.id, { providerData: startAt(p, 'card-3ds', 'challenge', { method: methods[0] ?? 'card' }) });
      svc.repo.addEvent(out, 'step', { flow: 'card-3ds', step: 'challenge', direct: true });
      return out;
    }
    if (methods.length === 1 && def.bankMethods?.includes(methods[0]!)) {
      if (f?.flow === 'bank' && f.step === 'bank') return p;
      const out = svc.repo.update(p.id, { providerData: startAt(p, 'bank', 'bank', { method: methods[0]! }) });
      svc.repo.addEvent(out, 'step', { flow: 'bank', step: 'bank', method: methods[0], direct: true });
      return out;
    }
    return p;
  };
}

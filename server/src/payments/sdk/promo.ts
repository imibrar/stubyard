import { esc } from '../../auth/pages.js';
import type { GatewayCtx } from '../gateway.js';
import type { Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { htmlReply } from './wallet.js';

/**
 * Promo widgets (P3): Tabby promo / card, tamara-widget and PayPal Pay Later messages. The scripts draw plain DOM
 * into the merchant's element (styles through element.style, so a merchant CSP without 'unsafe-inline' still works),
 * always with the TEST label inside; "Learn more" opens the provider's info popup, a stubyard page in SY.overlay.
 * Nothing is posted back to the merchant page (the real widgets have no callbacks, except PayPal's onRender / onClick).
 */

/** Browser half: PR.box(host, testid, lang) → the widget box (TEST badge first); PR.more(text, fn) → a link button. */
export const PROMO_RUNTIME = `var PR=(function(){
function box(host,id,l){while(host.firstChild)host.removeChild(host.firstChild);var b=document.createElement('div');b.setAttribute('data-testid',id);b.setAttribute('lang',l);b.dir=l==='ar'?'rtl':'ltr';
b.style.cssText='box-sizing:border-box;max-width:100%;min-width:min(320px,100%);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:start';host.appendChild(b);SY.badge(b,l);return b}
function more(text,fn,id){var a=document.createElement('button');a.type='button';a.textContent=text;a.setAttribute('data-testid',id||'stubyard-promo-more');
a.style.cssText='display:inline;padding:0;margin:0;border:0;background:none;font:inherit;color:inherit;text-decoration:underline;cursor:pointer';a.addEventListener('click',function(e){e.preventDefault();fn()});return a}
function popup(src,title,l){var o=SY.overlay({src:src,title:title,lang:l});o.closeBtn.addEventListener('click',o.close);return o}
function num(v){var n=Number(String(v==null?'':v).replace(/[^0-9.]/g,''));return isFinite(n)&&n>0?n:null}
return{box:box,more:more,popup:popup,num:num}})();`;

/** A promo / widget script reply (cross-origin script, never cached). */
export const jsReply = (c: GatewayCtx, src: string) =>
  c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').header('cross-origin-resource-policy', 'cross-origin').header('access-control-allow-origin', '*').send(src);

export interface PromoInfo {
  provider: string;
  lang: Locale;
  title: string;
  lead?: string | null;
  /** [label, amount] rows of the plan breakdown. */
  plan?: [string, string][];
  sections: { heading: string; items: string[] }[];
  note?: string | null;
}

/** The info popup page ("Learn more" / "More options"): a stubyard page with the TEST strip, no forms, no scripts. */
export function renderPromoInfo(i: PromoInfo): string {
  const L = i.lang;
  const plan = i.plan?.length ? `<ol class="k-sched" data-testid="stubyard-promo-plan">${i.plan.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join('')}</ol>` : '';
  const secs = i.sections.map((s) => `<h2 class="k-h2">${esc(s.heading)}</h2><ol class="k-steps" style="margin:0 0 14px;padding-inline-start:20px">${s.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`).join('');
  const body = `<main class="k-wrap"><div class="k-card" data-testid="stubyard-promo-info" data-provider="${esc(i.provider)}"><div class="k-head"><div class="k-mono" aria-hidden="true">${esc(i.provider.slice(0, 2).toLowerCase())}</div><h1>${esc(i.title)}<small>${esc(L === 'ar' ? `محاكاة ${i.provider} بواسطة stubyard` : `${i.provider}, simulated by stubyard`)}</small></h1></div>
<div class="k-sec">${i.lead ? `<p>${esc(i.lead)}</p>` : ''}${plan}${secs}${i.note ? `<p class="k-hint">${esc(i.note)}</p>` : ''}</div>
<div class="k-sec k-foot"><span>${esc(L === 'ar' ? 'معلومات تجريبية: لا توجد موافقة ائتمانية حقيقية.' : 'Test information: no real credit decision is made.')}</span></div></div></main>`;
  return kitDocument({ title: i.title, locale: L, body, banner: { variant: 'strip', host: null } });
}

export const promoInfoReply = (c: GatewayCtx, i: PromoInfo) => htmlReply(c, 200, renderPromoInfo(i));

/** lang query: ar… → ar, else en. */
export const langOf = (v: unknown): Locale => (String(v ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en');
/** A positive decimal amount from a query value, else null. */
export const amountOf = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n : null;
};
/** An ISO currency code from a query value, else the fallback. */
export const currencyOf = (v: unknown, fb: string) => (/^[A-Za-z]{3}$/.test(String(v ?? '')) ? String(v).toUpperCase() : fb);

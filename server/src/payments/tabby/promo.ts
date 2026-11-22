import type { GatewayCtx } from '../gateway.js';
import { toDecimal, fromDecimal } from '../engine.js';
import { js, SDK_RUNTIME } from '../sdk/runtime.js';
import { amountOf, currencyOf, jsReply, langOf, PROMO_RUNTIME, promoInfoReply, type PromoInfo } from '../sdk/promo.js';
import { renderPromoInfo } from '../sdk/promo.js';
import { htmlReply } from '../sdk/wallet.js';
import type { Locale } from '../kit/i18n.js';

/**
 * Tabby on-site messaging (research R3): tabby-promo.js / tabby-card.js define the same globals as Tabby's scripts,
 * new TabbyPromo({selector, currency, price, lang, source, shouldInheritBg, publicKey, merchantCode}) and
 * new TabbyCard({selector, currency, price, lang, shouldInheritBg, publicKey, merchantCode}); both render into the
 * selector's element (min. width 320 px), take the CSS variables --snippetTextColor / --snippetLinkTextColor and
 * have no callbacks. "Learn more" opens the info popup (/promos/learn-more). The static snippet page
 * /promos/product-page/installments/{en|ar}/?price&currency (the iframe variant) shows the same text.
 * Copy: "4 interest-free payments of AED 500.00. No fees. Learn more" (Tabby's wording changes often: partial).
 */

export const tabbyPromoJs = (cfg: { base: string; publicKey: string; merchantCode: string }) => `/* stubyard fake Tabby promo scripts (tabby-promo.js / tabby-card.js; not the real scripts). */
(function () {
  var CFG = ${js(cfg)};
  if (window.TabbyPromo && window.TabbyPromo.stubyard) return;
  ${SDK_RUNTIME}
  ${PROMO_RUNTIME}
  var BASE = SY.base(new RegExp('/tabby-(promo|card)(.min)?.js$'), CFG.base);
  var T = {
    en: { four: '4 interest-free payments of {a}. No fees. ', plain: 'Split in 4 interest-free payments. No fees. ', more: 'Learn more', card: 'Pay in 4. No interest, no fees.', today: 'Today', m: 'In {n} mo', title: 'Tabby (simulated)' },
    ar: { four: '4 دفعات بدون فوائد بقيمة {a}. بدون رسوم. ', plain: 'قسّمها على 4 دفعات بدون فوائد. بدون رسوم. ', more: 'لمعرفة المزيد', card: 'قسّمها على 4. بدون فوائد، بدون رسوم.', today: 'اليوم', m: 'بعد {n} شهر', title: 'تابي (محاكاة)' }
  };
  function money(v, cur, L) { var s = v.toFixed(cur === 'KWD' ? 3 : 2); return L === 'ar' ? s + ' ' + cur : cur + ' ' + s; }
  function warn(m) { if (window.console) console.warn('stubyard Tabby promo: ' + m); }
  function check(o, kind) {
    if (!o.publicKey) warn('publicKey is required (TABBY_PUBLIC_KEY)');
    else if (CFG.publicKey && o.publicKey !== CFG.publicKey) warn('publicKey does not match this instance (use TABBY_PUBLIC_KEY)');
    if (!o.merchantCode) warn('merchantCode is required');
    if (['AED', 'SAR', 'KWD'].indexOf(String(o.currency || '').toUpperCase()) < 0) warn('currency must be AED, SAR or KWD');
    if (!PR.num(o.price)) warn('price must be a positive amount ("2000.00")');
    if (kind === 'promo' && o.source && o.source !== 'product' && o.source !== 'cart') warn('source must be "product" or "cart"');
  }
  function render(kind, o) {
    var host = SY.el(o.selector);
    if (!host) { warn('selector ' + o.selector + ' matches no element'); return null; }
    check(o, kind);
    var L = SY.lang(o.lang), t = T[L], cur = String(o.currency || 'AED').toUpperCase(), price = PR.num(o.price);
    var b = PR.box(host, kind === 'card' ? 'stubyard-tabby-card' : 'stubyard-tabby-promo', L);
    b.style.color = 'var(--snippetTextColor, #292929)';
    b.style.background = o.shouldInheritBg ? 'transparent' : '#fff';
    b.style.border = '1px solid #d6d6d6'; b.style.borderRadius = '8px'; b.style.padding = '10px 12px';
    var mark = document.createElement('b'); mark.textContent = 'tabby'; mark.style.cssText = 'display:inline-block;margin-inline-end:6px;padding:0 6px;border:1px solid currentColor;border-radius:4px';
    var p = document.createElement('p'); p.style.margin = '0'; p.setAttribute('data-testid', 'stubyard-promo-text');
    if (kind === 'promo') {
      p.appendChild(mark);
      p.appendChild(document.createTextNode(price ? t.four.replace('{a}', money(price / 4, cur, L)) : t.plain));
    } else {
      var h = document.createElement('p'); h.style.cssText = 'margin:0 0 6px;font-weight:600'; h.appendChild(mark); h.appendChild(document.createTextNode(t.card)); b.appendChild(h);
      if (price) {
        var ol = document.createElement('ol'); ol.setAttribute('data-testid', 'stubyard-tabby-card-plan');
        ol.style.cssText = 'list-style:none;margin:0 0 6px;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px';
        for (var i = 0; i < 4; i++) { var li = document.createElement('li'); li.style.cssText = 'font-size:12px;text-align:center'; li.textContent = (i === 0 ? t.today : t.m.replace('{n}', i)) + ' · ' + money(price / 4, cur, L); ol.appendChild(li); }
        b.appendChild(ol);
      }
    }
    var a = PR.more(t.more, function () { PR.popup(BASE + '/promos/learn-more?lang=' + L + '&currency=' + encodeURIComponent(cur) + (price ? '&price=' + price.toFixed(2) : '') + '&kind=' + kind, t.title, L); });
    a.style.color = 'var(--snippetLinkTextColor, #292929)';
    p.appendChild(a); b.appendChild(p);
    return b;
  }
  function TabbyPromo(o) { if (!(this instanceof TabbyPromo)) return new TabbyPromo(o); this.options = o || {}; this.el = render('promo', this.options); }
  function TabbyCard(o) { if (!(this instanceof TabbyCard)) return new TabbyCard(o); this.options = o || {}; this.el = render('card', this.options); }
  TabbyPromo.stubyard = true; TabbyCard.stubyard = true;
  window.TabbyPromo = TabbyPromo; window.TabbyCard = TabbyCard;
})();
`;

const TXT = {
  en: { title: 'Pay in 4 with Tabby', lead: 'Split your purchase into 4 interest-free payments. No fees.', today: 'Today', m: 'In {n} month(s)', how: 'How it works', steps: ['Choose Tabby at checkout', 'Enter your mobile number and the code we send', 'Pay the first payment with your card', 'The rest is taken every month'], note: 'Simulated by stubyard: no credit check, no real Tabby account.', four: '4 interest-free payments of {a}. No fees.', plain: 'Split in 4 interest-free payments. No fees.' },
  ar: { title: 'قسّمها على 4 مع تابي', lead: 'قسّم مشترياتك على 4 دفعات بدون فوائد. بدون رسوم.', today: 'اليوم', m: 'بعد {n} شهر', how: 'كيف تعمل', steps: ['اختر تابي عند الدفع', 'أدخل رقم جوالك والرمز الذي نرسله', 'ادفع الدفعة الأولى ببطاقتك', 'تُخصم بقية الدفعات كل شهر'], note: 'محاكاة من stubyard: لا فحص ائتماني ولا حساب تابي حقيقي.', four: '4 دفعات بدون فوائد بقيمة {a}. بدون رسوم.', plain: 'قسّمها على 4 دفعات بدون فوائد. بدون رسوم.' },
};

function parts(price: number | null, currency: string): number[] | null {
  if (!price) return null;
  const a = fromDecimal(price.toFixed(currency === 'KWD' ? 3 : 2), currency);
  if (!a.ok) return null;
  const q = Math.floor(a.minor / 4);
  return [a.minor - q * 3, q, q, q];
}

function info(L: Locale, price: number | null, currency: string): PromoInfo {
  const t = TXT[L];
  const ps = parts(price, currency);
  const money = (m: number) => (L === 'ar' ? `${toDecimal(m, currency)} ${currency}` : `${currency} ${toDecimal(m, currency)}`);
  return {
    provider: 'Tabby',
    lang: L,
    title: t.title,
    lead: t.lead,
    plan: ps ? ps.map((m, i) => [i === 0 ? t.today : t.m.replace('{n}', String(i)), money(m)] as [string, string]) : [],
    sections: [{ heading: t.how, items: t.steps }],
    note: t.note,
  };
}

/** Promo routes of the Tabby instance (no bearer: the browser loads them). undefined when the path is not one. */
export function tabbyPromoRoute(c: GatewayCtx): unknown {
  const path = c.path.replace(/\/+$/, '');
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD') return undefined;
  if (/^\/(?:[\w.-]+\/)*tabby-(?:promo|card)(?:\.min)?\.js$/.test(path)) {
    c.resolved.endpoint = 'promo script';
    return jsReply(c, tabbyPromoJs({ base: c.base, publicKey: String(c.inst.config.publicKey ?? ''), merchantCode: String(c.inst.config.merchantCode ?? '') }));
  }
  if (path === '/promos/learn-more') {
    c.resolved.endpoint = 'promo info popup';
    return promoInfoReply(c, info(langOf(c.query.lang), amountOf(c.query.price), currencyOf(c.query.currency, 'AED')));
  }
  const st = /^\/promos\/product-page\/installments\/(en|ar)$/.exec(path);
  if (st) {
    // The static snippet (iframe variant): the promo text as a page, Learn more opens the info page.
    c.resolved.endpoint = 'promo snippet';
    const L = langOf(c.query.lang ?? st[1]);
    const cur = currencyOf(c.query.currency, 'AED');
    const ps = parts(amountOf(c.query.price), cur);
    const t = TXT[L];
    const page = renderPromoInfo({ ...info(L, amountOf(c.query.price), cur), title: 'Tabby', lead: ps ? t.four.replace('{a}', L === 'ar' ? `${toDecimal(ps[1]!, cur)} ${cur}` : `${cur} ${toDecimal(ps[1]!, cur)}`) : t.plain, plan: [], sections: [] });
    return htmlReply(c, 200, page);
  }
  return undefined;
}

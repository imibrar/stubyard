import type { GatewayCtx } from '../gateway.js';
import { esc } from '../../auth/pages.js';
import type { Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { js, SDK_RUNTIME } from '../sdk/runtime.js';
import { amountOf, jsReply, langOf, PROMO_RUNTIME, promoInfoReply, type PromoInfo } from '../sdk/promo.js';
import { htmlReply } from '../sdk/wallet.js';

/**
 * Tamara widget v2 (research R3): widget-v2/tamara-widget.js reads window.tamaraWidgetConfig = { lang, country,
 * publicKey, css, style: { fontSize, badgeRatio } } and defines the <tamara-widget type="tamara-summary"
 * amount="250.0" inline-type="2|3" config='{"badgePosition":"right","showExtraContent":""}'> element; a changed
 * amount (or any observed attribute) re-renders it, and window.TamaraWidgetV2.refresh() re-renders every widget
 * (refresh is from partner guides: unverified). The iframe variant is widget-v2/tamara-widget.html?lang&public_key&
 * country&amount&inline_type. "More options" opens the info popup (Your Payment, your Pace; How it works; Why
 * Tamara?). Amounts are whole currency units. The monthly figure assumes 12 monthly payments (the widget copy
 * "Pay SAR 208/mo or in 4 payments" does not say which plan it uses: assumed).
 */

const CURRENCY: Record<string, string> = { SA: 'SAR', AE: 'AED', KW: 'KWD', BH: 'BHD', OM: 'OMR', QA: 'QAR' };
export const tamaraCurrency = (country: unknown) => CURRENCY[String(country ?? 'SA').toUpperCase()] ?? 'SAR';

export const tamaraWidgetJs = (cfg: { base: string; publicKey: string }) => `/* stubyard fake Tamara widget v2 (widget-v2/tamara-widget.js; not the real script). */
(function () {
  var CFG = ${js(cfg)};
  if (window.TamaraWidgetV2 && window.TamaraWidgetV2.stubyard) return;
  ${SDK_RUNTIME}
  ${PROMO_RUNTIME}
  var BASE = SY.base(new RegExp('/widget-v2/tamara-widget(.min)?.js$'), CFG.base);
  var CUR = ${js(CURRENCY)};
  var T = {
    en: { line: 'Pay {c} {m}/mo or in 4 payments. Sharia-compliant. ', plain: 'Split in up to 4 payments. Sharia-compliant. ', more: 'More options', title: 'Tamara (simulated)' },
    ar: { line: 'ادفع {c} {m}/شهريًا أو على 4 دفعات. متوافقة مع الشريعة الإسلامية. ', plain: 'قسّمها على 4 دفعات. متوافقة مع الشريعة الإسلامية. ', more: 'تعرّف على خياراتك', title: 'تمارا (محاكاة)' }
  };
  function warn(m) { if (window.console) console.warn('stubyard Tamara widget: ' + m); }
  function conf() { return window.tamaraWidgetConfig || {}; }
  function parse(s) { if (!s) return {}; try { return JSON.parse(s) || {}; } catch (e) { warn('config is not JSON'); return {}; } }
  var warned = false;
  function render(el) {
    var g = conf(), c = parse(el.getAttribute('config'));
    if (!warned) { warned = true; if (!g.publicKey) warn('tamaraWidgetConfig.publicKey is required (TAMARA_PUBLIC_KEY)'); else if (CFG.publicKey && g.publicKey !== CFG.publicKey) warn('publicKey does not match this instance (use TAMARA_PUBLIC_KEY)'); }
    var L = SY.lang(el.getAttribute('lang') || g.lang), t = T[L];
    var country = String(g.country || 'SA').toUpperCase(), cur = CUR[country] || 'SAR';
    var amount = PR.num(el.getAttribute('amount'));
    var inline = el.getAttribute('inline-type') || '';
    var b = PR.box(el, 'stubyard-tamara-widget', L);
    b.setAttribute('data-type', el.getAttribute('type') || 'tamara-summary');
    b.setAttribute('data-inline-type', inline);
    var st = g.style || {};
    b.style.fontSize = (Number(st.fontSize) > 0 ? Number(st.fontSize) : 14) + 'px';
    if (inline !== '2') { b.style.border = '1px solid #e1e1e1'; b.style.borderRadius = '16px'; b.style.padding = '16px'; b.style.background = '#fff'; }
    var p = document.createElement('p'); p.style.cssText = 'margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px'; p.setAttribute('data-testid', 'stubyard-promo-text');
    var mark = document.createElement('b'); mark.textContent = 'tamara'; mark.setAttribute('data-testid', 'stubyard-tamara-badge');
    var ratio = Number(st.badgeRatio) > 0 ? Number(st.badgeRatio) : 1;
    mark.style.cssText = 'display:inline-block;padding:0 8px;border-radius:999px;border:1px solid currentColor;font-size:' + Math.round(12 * ratio) + 'px';
    var span = document.createElement('span');
    span.textContent = amount ? t.line.replace('{c}', cur).replace('{m}', String(Math.max(1, Math.round(amount / 12)))) : t.plain;
    var a = PR.more(t.more, function () { PR.popup(BASE + '/widget-v2/popup?lang=' + L + '&country=' + country + (amount ? '&amount=' + amount : ''), t.title, L); });
    span.appendChild(a);
    if (c.badgePosition === 'left') { p.appendChild(mark); p.appendChild(span); } else { p.appendChild(span); p.appendChild(mark); }
    b.appendChild(p);
    if (!amount) warn('amount is missing on <tamara-widget>');
  }
  function refresh() { var l = document.querySelectorAll('tamara-widget'); for (var i = 0; i < l.length; i++) render(l[i]); }
  var CE = window.customElements;
  if (CE && !CE.get('tamara-widget')) {
    CE.define('tamara-widget', class extends window.HTMLElement {
      static get observedAttributes() { return ['amount', 'type', 'inline-type', 'config', 'lang']; }
      connectedCallback() { render(this); }
      attributeChangedCallback() { if (this.isConnected) render(this); }
    });
  } else if (!CE) { refresh(); }
  window.TamaraWidgetV2 = { stubyard: true, refresh: refresh };
})();
`;

const TXT = {
  en: { hero: 'Your Payment, your Pace', lead: 'Split your purchase into up to 4 payments with no interest.', plan: 'Payment {n} of 4', how: 'How it works', steps: ['Select a plan at checkout', 'Enter your card details', 'Manage your payments in the Tamara app', 'Get reminders before each payment'], why: 'Why Tamara?', whys: ['No late fees', 'Sharia compliant', '100% buyer protection'], note: 'Simulated by stubyard: no credit check, no real Tamara account. Accepted (simulated): mada, Visa, Mastercard, Apple Pay.' },
  ar: { hero: 'دفعتك، على راحتك', lead: 'قسّم مشترياتك على 4 دفعات بدون فوائد.', plan: 'الدفعة {n} من 4', how: 'كيف تعمل', steps: ['اختر خطة عند الدفع', 'أدخل بيانات بطاقتك', 'أدر دفعاتك عبر تطبيق تمارا', 'احصل على تذكير قبل كل دفعة'], why: 'لماذا تمارا؟', whys: ['بدون رسوم تأخير', 'متوافقة مع الشريعة الإسلامية', 'حماية كاملة للمشتري'], note: 'محاكاة من stubyard: لا فحص ائتماني ولا حساب تمارا حقيقي. المقبول (محاكاة): مدى، فيزا، ماستركارد، Apple Pay.' },
};

function info(L: Locale, amount: number | null, currency: string): PromoInfo {
  const t = TXT[L];
  const whole = amount ? Math.round(amount) : null;
  const q = whole ? Math.floor(whole / 4) : 0;
  const parts = whole ? [whole - q * 3, q, q, q] : [];
  return {
    provider: 'Tamara',
    lang: L,
    title: t.hero,
    lead: t.lead,
    plan: parts.map((v, i) => [t.plan.replace('{n}', String(i + 1)), L === 'ar' ? `${v} ${currency}` : `${currency} ${v}`] as [string, string]),
    sections: [{ heading: t.how, items: t.steps }, { heading: t.why, items: t.whys }],
    note: t.note,
  };
}

/** Widget routes of the Tamara instance (before the API's bearer check). undefined when the path is not one. */
export function tamaraWidgetRoute(c: GatewayCtx): unknown {
  const path = c.path.replace(/\/+$/, '');
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD') return undefined;
  if (/^\/widget-v2\/tamara-widget(?:\.min)?\.js$/.test(path)) {
    c.resolved.endpoint = 'widget script';
    return jsReply(c, tamaraWidgetJs({ base: c.base, publicKey: String(c.inst.config.publicKey ?? '') }));
  }
  if (path === '/widget-v2/popup') {
    c.resolved.endpoint = 'widget info popup';
    return promoInfoReply(c, info(langOf(c.query.lang), amountOf(c.query.amount), tamaraCurrency(c.query.country)));
  }
  if (path === '/widget-v2/tamara-widget.html') {
    // The iframe variant: the widget line as a page; "More options" opens the popup page in a new tab.
    c.resolved.endpoint = 'widget iframe';
    const L = langOf(c.query.lang);
    const amount = amountOf(c.query.amount);
    const cur = tamaraCurrency(c.query.country);
    const line = amount
      ? (L === 'ar' ? `ادفع ${cur} ${Math.max(1, Math.round(amount / 12))}/شهريًا أو على 4 دفعات. متوافقة مع الشريعة الإسلامية.` : `Pay ${cur} ${Math.max(1, Math.round(amount / 12))}/mo or in 4 payments. Sharia-compliant.`)
      : L === 'ar' ? 'قسّمها على 4 دفعات. متوافقة مع الشريعة الإسلامية.' : 'Split in up to 4 payments. Sharia-compliant.';
    const q = new URLSearchParams({ lang: L, country: String(c.query.country ?? 'SA'), ...(amount ? { amount: String(amount) } : {}) });
    const body = `<main style="padding:8px"><div data-testid="stubyard-tamara-widget" data-inline-type="${esc(String(c.query.inline_type ?? ""))}" style="border:1px solid #e1e1e1;border-radius:16px;padding:16px;background:#fff"><p style="margin:0" data-testid="stubyard-promo-text">${esc(line)} <a href="popup?${esc(q.toString())}" target="_blank" rel="noopener" data-testid="stubyard-promo-more">${L === "ar" ? "تعرّف على خياراتك" : "More options"}</a> <b>tamara</b></p></div></main>`;
    return htmlReply(c, 200, kitDocument({ title: 'Tamara widget', locale: L, body, banner: { variant: 'strip', host: null } }));
  }
  return undefined;
}

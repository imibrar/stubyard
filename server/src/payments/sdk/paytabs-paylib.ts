import { esc } from '../../auth/pages.js';
import type { GatewayCtx } from '../gateway.js';
import { renderMerchantDemo } from '../pages.js';
import { cardJs } from './card.js';
import { DEMO_LOG, DEMO_LOG_BOX, demoLang, demoLangLinks, demoResultPage, sendDemo } from './demos.js';
import { js, requestBase, SDK_RUNTIME } from './runtime.js';

/**
 * PayTabs managed form (paylib.js) on the fake (Payments P4b; research R2, support.paytabs.com "Managed form"):
 *
 *   <script src="{base}/payment/js/paylib.js"></script>
 *   <form id="payform" action="/your/server" method="post">
 *     <span id="paymentErrors"></span>
 *     <input type="text" data-paylib="number"> <input data-paylib="expmonth"> <input data-paylib="expyear"> <input data-paylib="cvv">
 *     <input type="submit" value="Place order">
 *   </form>
 *   paylib.inlineForm({ key: '<client key>', form: document.getElementById('payform'), autoSubmit: true,
 *     callback: function (response) { if (response.error) paylib.handleError(document.getElementById('paymentErrors'), response); } });
 *
 * On submit paylib checks the card, gets a payment token, puts it into a hidden "payment_token" field and submits
 * the form; the inputs have no name, so the digits never reach the shop's server. The shop's server sends
 * payment_token in POST /payment/request (tran_class ecom): 3-D Secure → redirect_url (the simulated ACS page, then
 * the signed return as for the hosted page); no 3-D Secure → payment_result at once.
 * Deviation (documented): the real paylib sends the digits from the shop's page to PayTabs (SAQ A-EP). The fake
 * computes the card facts in the page and sends only those (brand, last 4, first 6, expiry, magic id) to stubyard;
 * a Luhn-valid number that is not a test card is cleared and refused there. The TEST label sits at the top of the form.
 */

export const PAYLIB_VERSION = '1.0.0-stubyard';

/** The merchant-page script (window.paylib). */
export function paylibJs(cfg: { base: string; version: string }): string {
  return `/* stubyard fake PayTabs paylib.js ${cfg.version} (not the real PayTabs library). */
(function () {
  if (window.paylib && window.paylib.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = SY.base(/\\/payment\\/js\\/paylib(?:\\.min)?\\.js$/, ${js(cfg.base)});
  var CARDS = { en: (function () { ${cardJs('en')} return SYC; })(), ar: (function () { ${cardJs('ar')} return SYC; })() };
  var MSG = { en: { month: 'The expiry month is invalid.', year: 'The expiry year is invalid.', key: 'The client key is missing or invalid.', failed: 'The card could not be tokenised.', cvv: 'The security code is invalid.' }, ar: { month: 'شهر انتهاء الصلاحية غير صالح.', year: 'سنة انتهاء الصلاحية غير صالحة.', key: 'مفتاح العميل مفقود أو غير صالح.', failed: 'تعذر ترميز البطاقة.', cvv: 'رمز الأمان غير صالح.' } };
  function warn(m) { if (window.console) console.error('[stubyard] paylib: ' + m); }
  function field(form, n) { return form.querySelector('[data-paylib="' + n + '"]'); }
  function inlineForm(o) {
    o = o || {};
    var form = typeof o.form === 'string' ? document.getElementById(o.form) : o.form;
    if (!form || !form.tagName || form.tagName.toLowerCase() !== 'form') throw new Error('paylib.inlineForm: form must be a <form> element');
    var l = SY.lang(), C = CARDS[l], M = MSG[l];
    var num = field(form, 'number'), mon = field(form, 'expmonth'), yr = field(form, 'expyear'), cvv = field(form, 'cvv');
    if (!num || !mon || !yr || !cvv) throw new Error('paylib.inlineForm: the form needs inputs with data-paylib="number", "expmonth", "expyear" and "cvv"');
    [num, mon, yr, cvv].forEach(function (x) { if (x.name) warn('the data-paylib input "' + x.getAttribute('data-paylib') + '" has a name: remove it, or the card details reach your server'); x.setAttribute('autocomplete', 'off'); });
    if (!form.querySelector('[data-testid=stubyard-sdk-badge]')) SY.badge(form, l);
    var busy = false, sending = false;
    function done(r) { if (typeof o.callback === 'function') { try { o.callback(r); } catch (x) { warn(x); } } }
    function err(code, text, f) { done({ error: true, errorCode: code, errorText: text, errors: [{ field: f || null, code: code, msg: text }] }); }
    function check() {
      var d = C.digits(num.value);
      if (!d || d.length < 12) return ['card_number', C.MSG.numIncomplete, 'number'];
      var fa = C.facts(d);
      if (!fa.luhn && !fa.test) return ['card_number', C.MSG.numInvalid, 'number'];
      var m = +C.digits(mon.value); if (!(m >= 1 && m <= 12)) return ['expiry_month', M.month, 'expmonth'];
      var y = C.digits(yr.value); if (y.length === 2) y = '20' + y; y = +y;
      var now = new Date(); if (!(y >= 2000) || y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1)) return ['expiry_year', y && y < now.getFullYear() ? C.MSG.expPast : M.year, 'expyear'];
      if (C.digits(cvv.value).length < (fa.brand === 'amex' ? 4 : 3)) return ['cvv', M.cvv, 'cvv'];
      return null;
    }
    form.addEventListener('submit', function (e) {
      if (sending) return;
      e.preventDefault();
      if (busy) return;
      if (!o.key || !/^C/.test(String(o.key))) { err('client_key', M.key); return; }
      var bad = check();
      if (bad) { err(bad[0], bad[1], bad[2]); return; }
      var d = C.digits(num.value), fa = C.facts(d);
      if (fa.luhn && !fa.test) {
        num.value = ''; cvv.value = '';
        try { fetch(BASE + '/payment/js/card-warning', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'brand=' + encodeURIComponent(fa.brand) }); } catch (x) {}
        err('card_number', C.MSG.realCard, 'number');
        return;
      }
      var y = C.digits(yr.value); if (y.length === 2) y = '20' + y;
      busy = true;
      fetch(BASE + '/payment/js/token', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: String(o.key), card: fa, first_six: d.slice(0, 6), exp_month: +C.digits(mon.value), exp_year: +y }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j || {} }; }); })
        .then(function (res) {
          busy = false;
          if (!res.ok || !res.j.token) { err(res.j.code || 'token_failed', res.j.message || M.failed); return; }
          var h = form.querySelector('input[name=payment_token]');
          if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = 'payment_token'; form.appendChild(h); }
          h.value = res.j.token;
          cvv.value = '';
          done({ error: false, token: res.j.token, card: { brand: fa.brand, last4: fa.last4 } });
          if (o.autoSubmit !== false) { sending = true; HTMLFormElement.prototype.submit.call(form); }
        }, function () { busy = false; err('network', M.failed); });
    }, true);
    return { stubyard: true };
  }
  function handleError(el, response) {
    if (!el) return;
    var r = response || {};
    var text = r.errorText || (r.errors && r.errors.length ? r.errors.map(function (x) { return x.msg; }).join(' ') : 'Error');
    el.textContent = text;
    el.setAttribute('role', 'alert');
    el.setAttribute('data-testid', 'stubyard-paylib-error');
  }
  window.paylib = { inlineForm: inlineForm, handleError: handleError, version: ${js(cfg.version)}, stubyard: true };
})();
`;
}

/** Demo shop: the managed form posts to the shop's server ({base}/demo/pay), which calls /payment/request with payment_token. */
export function paylibDemo(c: GatewayCtx, sub: string, status: (ref: string) => string | null): unknown {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') {
    const ref = typeof c.query.tranRef === 'string' ? c.query.tranRef : '';
    return demoResultPage(c, 'PayTabs demo shop: result', 'PayTabs', `<p>Your server confirms with <code>POST /payment/query {tran_ref: "${esc(ref || '{tranRef}')}"}</code> (server key): status <b data-testid="stubyard-demo-status">${esc((ref && status(ref)) || 'unknown')}</b>. Never trust the browser alone.</p>`);
  }
  const L = demoLang(c);
  const after = `${DEMO_LOG}
paylib.inlineForm({key:${js(String(c.inst.config.clientKey ?? 'CXXXXXXXXX-XXXXXXXXXX-XXXXXXXXXX'))},form:document.getElementById('payform'),autoSubmit:true,callback:function(r){demoLog('callback',r);document.getElementById('paymentErrors').textContent='';if(r.error)paylib.handleError(document.getElementById('paymentErrors'),r)}});`;
  const lbl = (en: string, ar: string) => (L === 'ar' ? ar : en);
  return sendDemo(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر PayTabs التجريبي' : 'PayTabs demo shop',
    presetName: 'PayTabs',
    lang: L,
    html: `<p>Managed form (<code>paylib.inlineForm</code>) for 10.00 SAR: the inputs have no name, paylib adds <code>payment_token</code> and submits to the shop's server, which calls <code>POST /payment/request</code>. Cards: 4111 1111 1111 1111 (paid at once), 4000 0025 0000 3155 (3-D Secure), 4000 0000 0000 0002 (declined).</p>${demoLangLinks(base, L)}
<form id="payform" action="${esc(base)}/demo/pay" method="post" data-testid="stubyard-demo-form">
<span id="paymentErrors" style="color:#b42318;display:block;min-height:1.2em"></span>
<label class="stack"><span>${lbl('Card number', 'رقم البطاقة')}</span><input type="text" data-paylib="number" inputmode="numeric" size="20" data-testid="stubyard-card"></label>
<div class="row"><label class="stack"><span>${lbl('Month', 'الشهر')}</span><input type="text" data-paylib="expmonth" inputmode="numeric" size="2" data-testid="stubyard-exp-month"></label><label class="stack"><span>${lbl('Year', 'السنة')}</span><input type="text" data-paylib="expyear" inputmode="numeric" size="4" data-testid="stubyard-exp-year"></label><label class="stack"><span>CVV</span><input type="text" data-paylib="cvv" inputmode="numeric" size="4" data-testid="stubyard-card-cvc"></label></div>
<input type="hidden" name="lang" value="${L}">
<p><button type="submit" class="btn primary" data-testid="stubyard-demo-pay">${lbl('Place order', 'إتمام الطلب')}</button></p></form>${DEMO_LOG_BOX}`,
    scripts: [{ src: base + '/payment/js/paylib.js' }],
    after,
  }));
}

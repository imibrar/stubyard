import { createHash } from 'node:crypto';

/**
 * The fake HyperPay COPYandPAY widget script (GET /v1/paymentWidgets.js?checkoutId=…). Its bytes are a pure function
 * of the instance base URL, the checkout id and WIDGET_VERSION, so the SRI hash returned by POST /v1/checkouts
 * (integrity=true) matches what the browser later downloads.
 *
 * The script finds form.paymentWidgets, reads its action (the shopperResultUrl) and data-brands, and injects an iframe
 * with the stubyard payment form (…/widget/<checkoutId>?embed=1&brands=…&result=…). Card digits stay inside that
 * stubyard-origin frame. wpwlOptions.onReady is called; other wpwlOptions are logged as ignored.
 */
export const WIDGET_VERSION = '1.0.0-stubyard';

/** A JS string literal that is also safe inside an HTML <script>. */
const lit = (s: string) => JSON.stringify(s).replace(/</g, '\\' + 'u003c');

export function buildWidgetJs(base: string, checkoutId: string): string {
  return `/* stubyard HyperPay COPYandPAY simulator: paymentWidgets.js ${WIDGET_VERSION} */
(function () {
  'use strict';
  var CHECKOUT = ${lit(checkoutId)};
  var FRAME = ${lit(`${base}/widget/${encodeURIComponent(checkoutId)}`)};
  var VERSION = ${lit(WIDGET_VERSION)};
  var HANDLED = { onReady: 1 };
  var frames = [];
  function log(level, msg) { try { console[level]('[stubyard] ' + msg); } catch (e) {} }
  function mount(form) {
    if (form.getAttribute('data-stubyard-mounted')) return;
    form.setAttribute('data-stubyard-mounted', '1');
    var action = form.getAttribute('action') || location.href;
    var result;
    try { result = new URL(action, location.href).href; } catch (e) { result = action; }
    var brands = (form.getAttribute('data-brands') || 'VISA MASTER').replace(/\\s+/g, ' ').trim();
    var frame = document.createElement('iframe');
    frame.src = FRAME + '?embed=1&brands=' + encodeURIComponent(brands) + '&result=' + encodeURIComponent(result);
    frame.title = 'Payment form (stubyard HyperPay simulator)';
    frame.setAttribute('data-testid', 'stubyard-hyperpay-frame');
    frame.setAttribute('allow', 'payment');
    frame.style.cssText = 'display:block;width:100%;max-width:640px;height:600px;border:0;background:transparent';
    form.appendChild(frame);
    frames.push(frame);
  }
  function init() {
    var o = window.wpwlOptions || {};
    var forms = document.querySelectorAll('form.paymentWidgets');
    for (var i = 0; i < forms.length; i++) mount(forms[i]);
    if (!forms.length) log('warn', 'paymentWidgets.js: no <form class="paymentWidgets"> on this page');
    Object.keys(o).forEach(function (k) { if (!HANDLED[k]) log('info', 'wpwlOptions.' + k + ' is ignored by the HyperPay simulator'); });
    if (typeof o.onReady === 'function') { try { o.onReady(); } catch (e) { log('error', 'wpwlOptions.onReady threw: ' + e); } }
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'stubyard-hyperpay' || typeof d.height !== 'number') return;
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === e.source) frames[i].style.height = Math.max(320, Math.min(2000, d.height)) + 'px';
  });
  window.wpwl = {
    stubyard: true,
    version: VERSION,
    checkout: { id: CHECKOUT },
    unload: function () {
      frames.forEach(function (f) { if (f.parentNode) { f.parentNode.removeAttribute('data-stubyard-mounted'); f.parentNode.removeChild(f); } });
      frames = [];
    },
    reloadButton: function () {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
}

/** SRI value of the widget for a checkout: "sha384-" + base64(sha384(exact bytes)). */
export function widgetIntegrity(base: string, checkoutId: string): string {
  return 'sha384-' + createHash('sha384').update(buildWidgetJs(base, checkoutId), 'utf8').digest('base64');
}

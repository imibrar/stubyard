import { esc } from '../../auth/pages.js';
import { OPEN } from '../engine.js';
import type { GatewayCtx, Json } from '../gateway.js';
import { finding } from '../lint.js';
import { t } from '../kit/i18n.js';
import type { ReturnCtx } from '../kit/layout.js';
import type { KitPayCtx } from '../kit/context.js';
import { kitDocument } from '../kit/shell.js';
import type { Payment } from '../repo.js';
import type { PaymentService } from '../service.js';
import { channelOf, checkSdkOrigin, frameBridge, js, sdkCors, SDK_RUNTIME } from '../sdk/runtime.js';
import { htmlReply, renderSdkError } from '../sdk/wallet.js';
import { codeOf, stamp } from './index.js';

/**
 * GeideaCheckout (Checkout JS) on the fake (Payments P2; research R2):
 *
 *   <script src="{base}/hpp/geideaCheckout.min.js"></script>
 *   const payment = new GeideaCheckout(onSuccess, onError, onCancel);
 *   payment.startPayment(sessionId);                    // popup: an overlay iframe over the page
 *   payment.startPayment(sessionId, null, 'checkout');  // drop-in: an iframe inside #checkout
 *
 * The instance's checkoutJsMode "redirect" keeps the old behaviour (startPayment opens the hosted page in the window).
 * Exactly one callback fires per startPayment, with { responseCode, responseMessage, detailedResponseCode,
 * detailedResponseMessage, orderId, reference }: responseCode "000" → onSuccess; the buyer cancelled (Cancel, the
 * overlay's Close) or the session expired while open → onCancel; anything else (decline, unknown / expired /
 * finished session at start) → onError.
 *
 * The frame is the stubyard hosted page (geidea-hpp layout) opened with stubyard_sdk=<channel>&stubyard_origin=…:
 * the server checks the origin (sdkOrigins / appOrigins), keeps it on the payment (providerData.sdkBridge) and the
 * result screen posts { type: 'result', event, data } to that origin only.
 */

export const GEIDEA_SDK_VERSION = '2.0.0-stubyard';

export interface SdkBridge {
  ch: string;
  origin: string;
  mode: 'popup' | 'dropin';
}

export function bridgeOf(p: Payment): SdkBridge | null {
  const b = p.providerData.sdkBridge as SdkBridge | undefined;
  return b && typeof b.ch === 'string' && typeof b.origin === 'string' ? b : null;
}

/** The callback data (the same codes as the return URL and the callback). */
export function sdkData(p: Payment): Json {
  const [code, detailed, msg] = codeOf(p);
  return { responseCode: code, responseMessage: msg, detailedResponseCode: detailed, detailedResponseMessage: code === '000' ? 'The operation was successful' : msg, orderId: p.providerRef, reference: (p.providerData.txId as string | undefined) ?? null, sessionId: p.secondaryRef ?? null };
}

export function sdkEvent(p: Payment): 'success' | 'error' | 'cancel' {
  if (codeOf(p)[0] === '000') return 'success';
  if ((p.status === 'cancelled' && !p.providerData.voided) || p.status === 'expired') return 'cancel';
  return 'error';
}

/** Result screen script: tell the merchant page (exactly once per load; the SDK keeps only the first). */
export function resultPost(svc: PaymentService, p0: Payment): string | null {
  const b = bridgeOf(p0);
  if (!b) return null;
  const p = OPEN.includes(p0.status) ? p0 : stamp(svc, p0);
  return `(function(){${frameBridge({ origin: b.origin, ch: b.ch, source: 'stubyard-geidea' })}SYB.post({type:'result',event:${js(sdkEvent(p))},data:${js(sdkData(p))}});})();`;
}

/** Pay screen script in SDK mode: the overlay's Close asks the page to cancel (the Cancel button). */
export function payBridge(c: KitPayCtx): string[] {
  const b = bridgeOf(c.payment);
  if (!b) return [];
  return [`(function(){${frameBridge({ origin: b.origin, ch: b.ch, source: 'stubyard-geidea' })}SYB.on(function(d){if(d.type!=='cancel')return;var f=document.getElementById('pay');var x=document.querySelector('[data-testid=stubyard-provider-cancel]')||document.querySelector('[data-testid=stubyard-cancel]');if(f){f.removeAttribute('inert');if(x){if(f.requestSubmit)f.requestSubmit(x);else x.click()}}});})();`];
}

/** The SDK's own result screen (instead of the redirect to returnUrl): the kit result card + the post to the page. */
export function sdkReturnPage(svc: PaymentService, r: ReturnCtx): string | null {
  const script = resultPost(svc, r.payment);
  if (!script) return null;
  const L = r.view.locale;
  const tone = r.result.tone;
  const msg = r.result.messageKey ? t(L, r.result.messageKey) : r.result.messageText ?? '';
  const icon = { ok: '✓', bad: '!', warn: '–', info: 'i' }[tone];
  const body = `<main class="k-wrap"><div class="k-card"><div class="k-result" data-testid="stubyard-done" data-status="${esc(r.status)}" data-sdk="geidea"><span class="k-icon ${tone}" aria-hidden="true">${icon}</span><h1>${esc(t(L, r.result.title))}</h1><p>${esc(msg)}</p></div><div class="k-sec k-foot"><span>${esc(t(L, 'simulatedBy', { provider: 'Geidea' }))}</span></div></div></main>`;
  return kitDocument({ title: t(L, r.result.title), locale: L, body, scripts: [script], banner: { variant: 'strip', host: r.host } });
}

/** The /hpp/checkout entry with stubyard_sdk=<channel>: check the origin, remember the bridge. Returns an error reply or null. */
export function attachSdk(c: GatewayCtx, p: Payment): unknown | null {
  const ch = channelOf(c.query.stubyard_sdk);
  if (!ch) return null;
  const mode = c.query.stubyard_mode === 'dropin' ? 'dropin' : 'popup';
  const chk = checkSdkOrigin(c, c.query.stubyard_origin, 'GeideaCheckout (' + c.inst.slug + ')', (f) => c.svc.addLint(p, [f]));
  const L = String((p.request as Json).language ?? 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  if (!chk.ok) return htmlReply(c, chk.reason === 'refused' ? 403 : 400, renderSdkError(L, 'Geidea', chk.reason === 'refused' ? t(L, 'sdkOriginRefused', { origin: chk.origin ?? '?', provider: 'Geidea' }) : 'GeideaCheckout: missing stubyard_origin.'));
  const cv = (p.providerData.checkoutView as Json | undefined) ?? {};
  c.svc.repo.update(p.id, { providerData: { ...p.providerData, sdkBridge: { ch, origin: chk.origin, mode }, checkoutView: { ...cv, ui: 'realistic' } } });
  c.svc.repo.addEvent(p, 'sdk_opened', { sdk: 'GeideaCheckout', mode, origin: chk.origin });
  return null;
}

/** GET /hpp/sdk/sessions/<sessionId>: what startPayment needs to know before it opens anything (CORS for allowed origins). */
export async function sessionState(c: GatewayCtx, sid: string): Promise<unknown> {
  c.resolved.endpoint = 'checkout js session';
  sdkCors(c);
  const p0 = sid ? c.svc.repo.byInstanceRef(c.inst.id, sid) : null;
  if (!p0 || p0.secondaryRef !== sid) {
    c.svc.addInstanceLint(c.inst, finding('pay.geidea-sdk-session', 'startPayment("' + sid.slice(0, 60) + '"): no such session on ' + c.inst.slug));
    return { state: 'unknown', error: { responseCode: '110', responseMessage: 'HPP Integration error', detailedResponseCode: '404', detailedResponseMessage: 'Session not found', orderId: null, reference: null } };
  }
  c.resolved.payment = p0.id;
  const p = await c.svc.touch(p0);
  const language = String((p.request as Json).language ?? 'en');
  if (OPEN.includes(p.status)) return { state: 'open', orderId: p.providerRef, language };
  c.svc.addLint(p, [finding('pay.geidea-sdk-session', 'startPayment() with a session that is ' + p.status + ' (create a new session for every attempt)')]);
  return { state: p.status === 'expired' ? 'expired' : 'finished', language, error: sdkData(stamp(c.svc, p)) };
}

/** The Checkout JS script. mode "redirect": startPayment opens the hosted page in the window (the pre-P2 shim). */
export function geideaCheckoutJs(cfg: { base: string; mode: 'popup' | 'redirect' }): string {
  return `/* stubyard fake Geidea Checkout JS ${GEIDEA_SDK_VERSION} (not the real geideaCheckout.min.js). */
(function () {
  if (window.GeideaCheckout && window.GeideaCheckout.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = SY.base(/\\/hpp\\/geideaCheckout(?:\\.min)?\\.js$/, ${js(cfg.base)});
  var ORIGIN = SY.originOf(BASE);
  var MODE = ${js(cfg.mode)};
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))); return a.join('&'); }
  function err(detailed, msg) { return { responseCode: '110', responseMessage: 'HPP Integration error', detailedResponseCode: detailed, detailedResponseMessage: msg, orderId: null, reference: null }; }
  function GeideaCheckout(onSuccess, onError, onCancel) {
    if (!(this instanceof GeideaCheckout)) return new GeideaCheckout(onSuccess, onError, onCancel);
    this.onSuccess = onSuccess; this.onError = onError; this.onCancel = onCancel;
  }
  GeideaCheckout.prototype.startPayment = function (sessionId, options, container) {
    var self = this, settled = false, ui = null, br = null, timer = null;
    function settle(kind, data) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (br) br.close();
      if (ui) ui.close();
      var cb = kind === 'success' ? self.onSuccess : kind === 'cancel' ? self.onCancel : self.onError;
      if (typeof cb === 'function') { try { cb(data); } catch (e) { if (window.console) console.error(e); } }
    }
    if (!sessionId) { settle('error', err('001', 'sessionId is required')); return; }
    var url = BASE + '/hpp/checkout/?' + encodeURIComponent(sessionId);
    if (MODE === 'redirect') { window.location.href = url; return; }
    fetch(BASE + '/hpp/sdk/sessions/' + encodeURIComponent(sessionId), { credentials: 'omit' }).then(function (r) { return r.json(); }).then(function (s) {
      if (!s || s.state !== 'open') { settle('error', (s && s.error) || err('001', 'Session not usable')); return; }
      var ch = SY.uid(), l = SY.lang(s.language);
      var src = url + '&' + qs({ stubyard_sdk: ch, stubyard_origin: location.origin, stubyard_mode: container ? 'dropin' : 'popup' });
      var title = l === 'ar' ? 'الدفع عبر Geidea (محاكاة)' : 'Geidea checkout (simulated)';
      if (container) {
        var host = typeof container === 'string' ? (document.getElementById(container) || SY.el(container)) : container;
        if (!host) { settle('error', err('001', 'Drop-in container not found: ' + container)); return; }
        var f = SY.frame(src, title, 620);
        f.setAttribute('data-testid', 'stubyard-geidea-frame');
        host.appendChild(f);
        ui = { frame: f, close: function () { if (f.parentNode) f.parentNode.removeChild(f); } };
      } else {
        ui = SY.overlay({ src: src, title: title, lang: l });
        ui.frame.setAttribute('data-testid', 'stubyard-geidea-frame');
        ui.closeBtn.addEventListener('click', function () {
          if (timer) return;
          br.send({ type: 'cancel' });
          // The page answers with the cancelled result; without an answer the SDK still ends with onCancel.
          timer = setTimeout(function () { settle('cancel', { responseCode: '010', responseMessage: 'Transaction Cancelled By User.', detailedResponseCode: '001', detailedResponseMessage: 'Transaction Cancelled By User.', orderId: s.orderId || null, reference: null }); }, 4000);
        });
      }
      br = SY.bridge({ origin: ORIGIN, ch: ch, source: 'stubyard-geidea', win: function () { return ui && ui.frame.contentWindow; } });
      br.on(function (d) {
        if (d.type === 'resize' && container) ui.frame.style.height = Math.min(Math.max(Number(d.height) || 0, 200), 1600) + 'px';
        else if (d.type === 'result' && (d.event === 'success' || d.event === 'error' || d.event === 'cancel')) settle(d.event, d.data || {});
      });
    }, function () { settle('error', err('999', 'stubyard is not reachable')); });
  };
  GeideaCheckout.stubyard = true;
  GeideaCheckout.version = ${js(GEIDEA_SDK_VERSION)};
  window.GeideaCheckout = GeideaCheckout;
})();
`;
}

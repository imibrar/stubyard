import type { Json } from '../gateway.js';
import { asList } from '../common.js';
import { scriptJson } from '../kit/fields.js';
import { hostedLayout } from '../kit/hpp.js';
import { renderKitReturn } from '../kit/pages.js';
import type { Payment } from '../repo.js';

/**
 * PayTabs Hosted Payment Page (POST /payment/request → redirect_url): the cart description and amount, the method
 * choice, card number / expiry / CVC / holder name, Pay and Cancel; 3-D Secure as a full-page redirect; then a short
 * "redirecting" countdown and the auto-submitted POST (or GET with return_using_get) to the return URL (as today).
 * framed: true: the compact page meant for an iframe; framed_return_top / framed_return_parent submit the return into
 * that window; with no return URL the page tells the parent "hppDone" (postMessage to the framed_message_target
 * origin only, never "*" or document.referrer).
 */
const req = (p: Payment) => (p.request ?? {}) as Json;
const truthy = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

export const paytabsLayout = hostedLayout(
  {
    layout: 'paytabs-hpp',
    provider: 'PayTabs',
    methodStyle: 'tabs',
    cardholder: 'after',
    showSingleMethod: (c) => c.input.methods.length === 1 && asList(req(c.payment).payment_methods).length > 0,
    methodLabels: { applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' }, stcpay: { en: 'STC Pay', ar: 'STC Pay' } },
    cancel: { en: 'Cancel', ar: 'إلغاء' },
    compact: (c) => !!c.payment.providerData.framed,
    summary: (c) => (c.payment.providerData.framed ? [] : [
      [{ en: 'Cart', ar: 'السلة' }, c.input.description],
      [{ en: 'Cart ID', ar: 'رقم السلة' }, c.input.reference],
    ]),
  },
  {
    threeds: 'redirect',
    returnPage: (r) => {
      const framed = !!r.payment.providerData.framed;
      // return_using_get on a full page: the plain 303 redirect, as before.
      if (r.kind === 'redirect' && !framed) return null;
      const q = req(r.payment);
      const target = framed ? (truthy(q.framed_return_top) ? '_top' : truthy(q.framed_return_parent) ? '_parent' : null) : null;
      return renderKitReturn({ view: r.view, host: r.host, presetName: r.presetName, url: r.url, fields: r.fields, method: r.kind === 'post' ? 'post' : 'get', target, status: r.status, result: r.result, countdownS: framed ? 0 : 3 });
    },
    resultScripts: (p) => {
      if (!p.providerData.framed || p.returnUrl) return [];
      let origin: string | null = null;
      try {
        const u = new URL(String(req(p).framed_message_target ?? ''));
        if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
      } catch {
        origin = null;
      }
      return origin ? [`(function(){try{if(window.parent&&window.parent!==window)window.parent.postMessage('hppDone',${scriptJson(origin)})}catch(e){}})();`] : [];
    },
  },
);

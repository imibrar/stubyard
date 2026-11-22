import { esc } from '../../auth/pages.js';
import { asString } from '../common.js';
import { OPEN, toDecimal } from '../engine.js';
import type { GatewayCtx, Json } from '../gateway.js';
import { cardFields } from '../kit/fields.js';
import type { Locale } from '../kit/i18n.js';
import { tx } from '../kit/layout.js';
import { kitDocument } from '../kit/shell.js';
import type { Payment } from '../repo.js';
import { cardJs } from '../sdk/card.js';
import { channelOf, checkSdkOrigin, frameBridge, js, requestBase, sdkCors, SDK_RUNTIME } from '../sdk/runtime.js';
import { htmlReply, renderSdkError } from '../sdk/wallet.js';
import { HttpError } from '../../util.js';
import { isEmbedded, piId, sessionSecretOf, StripeError } from './index.js';
import { answer3ds, confirmWith, intentBySecret, pkAuth, returnUrlOf, savePm, type CardFacts } from './intents.js';

/**
 * The fake Stripe.js v3 (Payments P4a; research R1 `1 "Stripe.js"), served by the Stripe instance:
 *
 *   <script src="{base}/js.stripe.com/v3/"></script>            (also …/v3, …/v3/stripe.js, …/<release>/stripe.js)
 *   const stripe = Stripe('pk_test_…');
 *   const elements = stripe.elements({ clientSecret })          // or { mode: 'payment', amount, currency }
 *   elements.create('payment' | 'card' | 'address' | 'linkAuthentication').mount('#el');
 *   await stripe.confirmPayment({ elements, confirmParams: { return_url }, redirect: 'if_required' });
 *   await stripe.confirmCardPayment(clientSecret, { payment_method: { card } });
 *   await stripe.handleNextAction({ clientSecret }); await stripe.retrievePaymentIntent(clientSecret);
 *   const checkout = await stripe.initEmbeddedCheckout({ fetchClientSecret, onComplete }); checkout.mount('#checkout');
 *
 * Every element is a stubyard iframe ({base}/stripe-js/elements/<type>) on stubyard's origin: card digits stay in
 * the frame, which confirms the PaymentIntent itself (POST {base}/stripe-js/confirm with the publishable key, the
 * client secret and the card facts: brand, last 4, magic id). The page and the frames talk with postMessage to the
 * exact origins only (the frame URL's origin= is checked against the instance sdkOrigins / project app origins).
 * 3-D Secure (next_action use_stripe_sdk) opens {base}/stripe-js/3ds/<pi> in a modal over the page; a server-side
 * confirm with return_url gets redirect_to_url to the same page in redirect mode instead.
 * Embedded Checkout is the Stripe hosted page in a frame (/c/pay/<cs>?stubyard_sdk=…), which tells the page when it
 * is complete (onComplete, or the top window goes to return_url with redirect_on_completion "always").
 * The TEST label is inside every component: the strip in the Payment / Address Element and Embedded Checkout frames,
 * the SDK badge in the wrapper of the single-line Card and Link Authentication Elements.
 */

export const STRIPE_JS_VERSION = 'v3-stubyard';
const SRC = 'stubyard-stripe';
const SRC_3DS = 'stubyard-stripe-3ds';
export const SRC_CHECKOUT = 'stubyard-stripe-checkout';
export const ELEMENT_TYPES = ['payment', 'card', 'address', 'linkAuthentication'] as const;
type ElementType = (typeof ELEMENT_TYPES)[number];

const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as string) : '');
const langOf = (v: unknown): Locale => (str(v).toLowerCase().startsWith('ar') ? 'ar' : 'en');
const SCRIPT_RE = /^\/js\.stripe\.com\/(?:v3\/?|v3\/stripe\.js|[a-z0-9.-]{1,40}\/stripe\.js)$/;

const T = {
  frame: { en: 'Secure payment input frame (stubyard simulator)', ar: 'إطار إدخال الدفع (محاكي stubyard)' },
  card: { en: 'Card', ar: 'بطاقة' },
  cardInfo: { en: 'Card information', ar: 'معلومات البطاقة' },
  country: { en: 'Country or region', ar: 'الدولة أو المنطقة' },
  name: { en: 'Full name', ar: 'الاسم الكامل' },
  line1: { en: 'Address line 1', ar: 'العنوان (السطر 1)' },
  line2: { en: 'Address line 2 (optional)', ar: 'العنوان (السطر 2، اختياري)' },
  city: { en: 'City', ar: 'المدينة' },
  postal: { en: 'Postal code', ar: 'الرمز البريدي' },
  email: { en: 'Email', ar: 'البريد الإلكتروني' },
  hint: { en: 'Test cards: 4242 4242 4242 4242 (success), 4000 0000 0000 0002 (declined), 4000 0000 0000 3220 (3-D Secure). Any future expiry and CVC.', ar: 'بطاقات الاختبار: 4242 4242 4242 4242 (نجاح)، 4000 0000 0000 0002 (رفض)، 4000 0000 0000 3220 (التحقق ثلاثي الأبعاد). أي تاريخ مستقبلي وأي رمز.' },
  realCard: { en: 'This looks like a real card. stubyard only accepts test cards: the number was cleared and not sent.', ar: 'يبدو أن هذه بطاقة حقيقية. يقبل stubyard بطاقات الاختبار فقط: تم مسح الرقم ولم يُرسل.' },
  failed: { en: 'Something went wrong. Try again.', ar: 'حدث خطأ. حاول مرة أخرى.' },
  auth: { en: '3D Secure authentication (simulated)', ar: 'التحقق ثلاثي الأبعاد (محاكاة)' },
  authText: { en: 'Your bank asks you to confirm this payment. This is a stubyard test page: no bank is contacted.', ar: 'يطلب منك البنك تأكيد هذه العملية. هذه صفحة اختبار من stubyard: لا يتم الاتصال بأي بنك.' },
  complete: { en: 'Complete authentication', ar: 'إتمام التحقق' },
  fail: { en: 'Fail authentication', ar: 'إفشال التحقق' },
  authDone: { en: 'Authentication finished. You can close this window.', ar: 'انتهى التحقق. يمكنك إغلاق هذه النافذة.' },
  nothing: { en: 'This PaymentIntent is not waiting for 3D Secure authentication.', ar: 'عملية الدفع هذه لا تنتظر التحقق ثلاثي الأبعاد.' },
  merchant: { en: 'Merchant', ar: 'التاجر' },
  amount: { en: 'Amount', ar: 'المبلغ' },
  card4: { en: 'Card', ar: 'البطاقة' },
  refused: { en: 'Stripe.js: %O may not use this stubyard instance (add it to the project app origins or the instance sdkOrigins).', ar: 'Stripe.js: لا يمكن لـ %O استخدام هذا المثيل (أضفه إلى أصول التطبيق في المشروع أو sdkOrigins).' },
  missing: { en: "Stripe.js: missing channel or origin (load the element with stubyard's Stripe.js).", ar: 'Stripe.js: القناة أو الأصل مفقود (حمّل العنصر عبر Stripe.js من stubyard).' },
};

// --------------------------------------------------------------------------------------------------------------
// The merchant-page script (window.Stripe)
// --------------------------------------------------------------------------------------------------------------

export function stripeJs(cfg: { base: string }): string {
  return `/* stubyard fake Stripe.js ${STRIPE_JS_VERSION} (not the real Stripe.js; no card data reaches this page). */
(function () {
  if (window.Stripe && window.Stripe.stubyard) return;
  ${SDK_RUNTIME}
  var FALLBACK = ${js(cfg.base)};
  var BASE = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) {
        var u = new URL(s);
        var i = u.pathname.indexOf('/js.stripe.com/');
        if (u.hostname !== 'js.stripe.com' && i >= 0) return u.origin + u.pathname.slice(0, i);
      }
    } catch (e) {}
    return FALLBACK;
  })();
  var ORIGIN = SY.originOf(BASE);
  var TYPES = ['payment', 'card', 'address', 'linkAuthentication'];
  var PLACEHOLDER = ['expressCheckout', 'paymentRequestButton'];
  var ACTIVE_CHECKOUT = null;
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))); return a.join('&'); }
  function warn(m) { if (window.console) console.warn('[stubyard] Stripe.js: ' + m); }
  function IntegrationError(m) { var e = new Error(m); e.name = 'IntegrationError'; return e; }
  function piOf(cs) { return String(cs || '').split('_secret_')[0]; }
  function validSecret(cs) { return typeof cs === 'string' && /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(cs); }
  function api(s, method, path, params) {
    var url = BASE + path, init = { method: method, credentials: 'omit', headers: {} };
    var p = Object.assign({ key: s._key }, params || {});
    if (method === 'GET') url += '?' + qs(p);
    else { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = qs(p); }
    return fetch(url, init).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }, function () { return { ok: false, j: { error: { type: 'api_connection_error', message: 'stubyard is not reachable.' } } }; });
  }
  function emitter(o) {
    o._h = {};
    o.on = function (ev, fn) { (o._h[ev] = o._h[ev] || []).push(fn); return o; };
    o.off = function (ev, fn) { var l = o._h[ev] || []; o._h[ev] = fn ? l.filter(function (x) { return x !== fn && x._orig !== fn; }) : []; return o; };
    o.once = function (ev, fn) { var w = function (d) { o.off(ev, w); fn(d); }; w._orig = fn; return o.on(ev, w); };
    o._emit = function (ev, d) { (o._h[ev] || []).slice().forEach(function (fn) { try { fn(d); } catch (x) { if (window.console) console.error(x); } }); };
    return o;
  }

  function Stripe(key, opts) {
    if (!(this instanceof Stripe)) return new Stripe(key, opts);
    if (typeof key !== 'string' || !key) throw IntegrationError('Please call Stripe() with your publishable key. You used an empty string.');
    if (/^sk_/.test(key)) throw IntegrationError('You should not use your secret key with Stripe.js. Please pass a publishable key instead.');
    if (!/^pk_/.test(key)) throw IntegrationError('Invalid value for Stripe(): apiKey should be a publishable key (pk_test_…). You specified: ' + key.slice(0, 12) + '.');
    if (/^pk_live_/.test(key)) warn('a live publishable key was given: stubyard refuses live keys, use the instance pk_test_ key.');
    this._key = key;
    this._opts = opts || {};
  }
  var P = Stripe.prototype;
  P._registerWrapper = function () {};
  P.registerAppInfo = function () {};

  // ---- Elements --------------------------------------------------------------------------------------------
  function Elements(s, o) {
    this._s = s; this._o = Object.assign({}, o); this._els = {}; this._submitted = false;
    this._lang = SY.lang(o.locale || s._opts.locale);
    if (o.clientSecret !== undefined && !validSecret(o.clientSecret)) throw IntegrationError('Invalid value for elements(): clientSecret should be the client_secret of a PaymentIntent (pi_…_secret_…). You specified: ' + String(o.clientSecret).slice(0, 30) + '.');
    if (o.clientSecret === undefined && o.mode !== undefined) {
      if (['payment', 'setup', 'subscription'].indexOf(o.mode) < 0) throw IntegrationError('Invalid value for elements(): mode should be one of payment, setup, subscription.');
      if (o.mode !== 'setup' && !(Number(o.amount) >= 0)) throw IntegrationError('Missing value for elements(): amount is required when mode is ' + o.mode + '.');
      if (!o.currency) throw IntegrationError('Missing value for elements(): currency is required in deferred mode.');
    }
  }
  var E = Elements.prototype;
  E.create = function (type, opts) {
    if (TYPES.indexOf(type) < 0 && PLACEHOLDER.indexOf(type) < 0) throw IntegrationError('A valid Element name must be provided. Valid Elements are: ' + TYPES.concat(PLACEHOLDER).join(', ') + '; you passed: ' + type + '. (stubyard does not simulate the split cardNumber / cardExpiry / cardCvc Elements: use card or payment.)');
    if (this._els[type]) throw IntegrationError('Can only create one Element of type ' + type + '.');
    var el = new Element(this, type, opts || {});
    this._els[type] = el;
    return el;
  };
  E.getElement = function (type) { return this._els[type] || null; };
  E.update = function (o) { o = o || {}; Object.assign(this._o, o); if (o.locale) this._lang = SY.lang(o.locale); for (var k in this._els) this._els[k]._send({ type: 'update', options: { amount: this._o.amount, currency: this._o.currency } }); };
  E.fetchUpdates = function () { return Promise.resolve({}); };
  E.submit = function () {
    var self = this, pe = this._els.payment || this._els.card;
    if (!pe || !pe._mounted) return Promise.resolve({ error: { type: 'validation_error', message: 'elements.submit(): no mounted Payment Element.' } });
    return pe._ask({ type: 'validate' }).then(function (d) { if (d.error) return { error: d.error }; self._submitted = true; return {}; });
  };

  function Element(els, type, opts) {
    emitter(this);
    this._els = els; this._type = type; this._opts = opts; this._ch = SY.uid(); this._mounted = false; this._destroyed = false;
    this._pend = {}; this._ready = false; this._queue = []; this._value = null; this._complete = false;
  }
  var EL = Element.prototype;
  EL._send = function (m) { if (!this._br) return; if (this._ready) this._br.send(m); else this._queue.push(m); };
  EL._ask = function (m) {
    var self = this;
    return new Promise(function (res) {
      var id = SY.uid();
      self._pend[id] = res;
      m.id = id;
      self._send(m);
    });
  };
  EL.mount = function (target) {
    if (this._destroyed) throw IntegrationError('This Element has already been destroyed. Please create a new one.');
    var host = SY.el(target);
    if (!host) throw IntegrationError('The selector you specified (' + target + ') applies to no DOM elements that are currently on the page. Make sure the element exists on the page before calling mount().');
    if (this._mounted) throw IntegrationError('This Element is already mounted. Use unmount() before mounting it again.');
    var self = this, els = this._els, l = els._lang, type = this._type;
    var w = document.createElement('div');
    w.className = '__PrivateStripeElement';
    w.setAttribute('data-testid', 'stubyard-stripe-element');
    w.setAttribute('data-type', type);
    w.style.cssText = 'margin:0;padding:0;border:none;display:block;background:transparent;position:relative;opacity:1';
    this._wrap = w;
    host.appendChild(w);
    this._mounted = true;
    if (PLACEHOLDER.indexOf(type) >= 0) {
      SY.badge(w, l);
      var n = document.createElement('div');
      n.setAttribute('data-testid', 'stubyard-stripe-placeholder');
      n.textContent = l === 'ar' ? 'الدفع السريع (Apple Pay / Google Pay / Link) غير محاكى في stubyard.' : 'Express checkout (Apple Pay / Google Pay / Link) is not simulated by stubyard.';
      n.style.cssText = 'font:13px/1.4 system-ui,sans-serif;color:#4a4f59';
      w.appendChild(n);
      setTimeout(function () { self._emit('ready', { elementType: type }); }, 0);
      return;
    }
    if (type === 'card' || type === 'linkAuthentication') SY.badge(w, l);
    var src = BASE + '/stripe-js/elements/' + type + '?' + qs({ ch: this._ch, origin: location.origin, lang: l, amount: els._o.amount, currency: els._o.currency });
    var f = SY.frame(src, l === 'ar' ? 'إطار إدخال الدفع الآمن' : 'Secure payment input frame', type === 'card' || type === 'linkAuthentication' ? 64 : 300);
    f.name = '__privateStripeFrame' + this._ch;
    f.setAttribute('data-testid', 'stubyard-stripe-frame');
    f.setAttribute('allow', 'payment *');
    w.appendChild(f);
    this._frame = f;
    this._br = SY.bridge({ origin: ORIGIN, ch: this._ch, source: ${js(SRC)}, win: function () { return f.contentWindow; } });
    this._br.on(function (d) {
      if (d.type === 'ready') {
        self._ready = true;
        var q = self._queue; self._queue = [];
        q.forEach(function (m) { self._br.send(m); });
        self._emit('ready', { elementType: type });
      } else if (d.type === 'resize') f.style.height = Math.min(Math.max(Number(d.height) || 0, 40), 1600) + 'px';
      else if (d.type === 'change') {
        self._complete = !!d.complete; self._value = d.value || null;
        var ev = { elementType: type, empty: !!d.empty, complete: !!d.complete, error: d.error || undefined };
        if (type === 'card') { ev.brand = d.brand || 'unknown'; ev.value = { postalCode: '' }; }
        else if (type === 'payment') { ev.collapsed = false; ev.value = { type: 'card' }; }
        else if (d.value) ev.value = d.value;
        self._emit('change', ev);
      } else if (d.type === 'focus' || d.type === 'blur' || d.type === 'escape') self._emit(d.type, { elementType: type });
      else if (d.type === 'answer' && d.id && self._pend[d.id]) { var r = self._pend[d.id]; delete self._pend[d.id]; r(d); }
    });
  };
  EL.unmount = function () {
    if (this._br) this._br.close();
    this._br = null; this._ready = false; this._queue = [];
    if (this._wrap && this._wrap.parentNode) this._wrap.parentNode.removeChild(this._wrap);
    this._mounted = false;
  };
  EL.destroy = function () { this.unmount(); this._destroyed = true; if (this._els._els[this._type] === this) delete this._els._els[this._type]; };
  EL.update = function (o) { Object.assign(this._opts, o || {}); this._send({ type: 'update', options: o || {} }); };
  EL.focus = function () { this._send({ type: 'focus' }); };
  EL.blur = function () { this._send({ type: 'blur' }); };
  EL.clear = function () { this._send({ type: 'clear' }); };
  EL.collapse = function () {};
  EL.getValue = function () { return Promise.resolve({ complete: this._complete, isNewAddress: true, value: this._value || {} }); };

  P.elements = function (o) { return new Elements(this, o || {}); };

  // ---- PaymentIntents ----------------------------------------------------------------------------------------
  function pubError(j) { return (j && j.error) || { type: 'api_error', message: 'Unexpected response from stubyard.' }; }
  P.retrievePaymentIntent = function (cs) {
    if (!validSecret(cs)) return Promise.reject(IntegrationError('Invalid value for retrievePaymentIntent: clientSecret should be the client_secret of a PaymentIntent (pi_…_secret_…).'));
    return api(this, 'GET', '/v1/payment_intents/' + encodeURIComponent(piOf(cs)), { client_secret: cs }).then(function (r) { return r.ok ? { paymentIntent: r.j } : { error: pubError(r.j) }; });
  };
  // 3-D Secure in a modal over the page (next_action use_stripe_sdk); resolves with the PaymentIntent afterwards.
  P._authenticate = function (pi, cs) {
    var s = this, na = pi.next_action || {};
    var url = (na.use_stripe_sdk && na.use_stripe_sdk.stripe_js) || (na.redirect_to_url && na.redirect_to_url.url);
    if (!url || SY.originOf(url) !== ORIGIN) return s.retrievePaymentIntent(cs);
    return new Promise(function (res) {
      var ch = SY.uid(), l = SY.lang(s._opts.locale), done = false, timer = null;
      var ov = SY.overlay({ src: url.split('&mode=')[0] + '&' + qs({ mode: 'modal', ch: ch, origin: location.origin, lang: l }), title: l === 'ar' ? 'التحقق ثلاثي الأبعاد (محاكاة)' : '3D Secure authentication (simulated)', lang: l });
      ov.frame.setAttribute('data-testid', 'stubyard-stripe-3ds-frame');
      var br = SY.bridge({ origin: ORIGIN, ch: ch, source: ${js(SRC_3DS)}, win: function () { return ov.frame.contentWindow; } });
      function end() { if (done) return; done = true; if (timer) clearTimeout(timer); br.close(); ov.close(); s.retrievePaymentIntent(cs).then(res); }
      br.on(function (d) { if (d.type === '3ds-done') end(); });
      // Closing the modal fails the authentication, as Stripe.js does.
      ov.closeBtn.addEventListener('click', function () { if (timer) return; br.send({ type: 'cancel' }); timer = setTimeout(end, 4000); });
    });
  };
  // After a confirm: authenticate when asked, then the Stripe.js result shape.
  P._finish = function (r, cs, o) {
    var s = this;
    if (!r.ok) return Promise.resolve({ error: pubError(r.j) });
    var pi = r.j;
    var step = pi.status === 'requires_action' && o.handleActions !== false ? s._authenticate(pi, cs).then(function (x) { return x.paymentIntent ? x.paymentIntent : pi; }) : Promise.resolve(pi);
    return step.then(function (pi) {
      if (pi.status === 'requires_payment_method' && pi.last_payment_error) return { error: Object.assign({}, pi.last_payment_error, { payment_intent: pi }) };
      if (o.returnUrl && o.redirect !== 'if_required' && ['succeeded', 'processing', 'requires_capture'].indexOf(pi.status) >= 0) {
        var u;
        try { u = new URL(o.returnUrl, location.href); } catch (x) { return { paymentIntent: pi }; }
        u.searchParams.set('payment_intent', pi.id);
        u.searchParams.set('payment_intent_client_secret', cs);
        u.searchParams.set('redirect_status', pi.status === 'processing' ? 'pending' : 'succeeded');
        window.location.assign(u.toString());
        return new Promise(function () {});
      }
      return { paymentIntent: pi };
    });
  };
  // A confirm through an element frame (the card digits stay in the frame).
  P._confirmFrame = function (el, cs, params, o) {
    var s = this;
    return el._ask({ type: 'confirm', client_secret: cs, key: s._key, params: params }).then(function (d) { return s._finish({ ok: !d.error, j: d.error ? { error: d.error } : d.paymentIntent }, cs, o); });
  };
  P.confirmPayment = function (o) {
    o = o || {};
    var els = o.elements, cp = o.confirmParams || {}, redirect = o.redirect || 'always';
    if (!els || !(els instanceof Elements)) return Promise.reject(IntegrationError('Invalid value for confirmPayment(): elements should be an Elements group. You specified: ' + typeof els + '.'));
    if (redirect !== 'if_required' && !cp.return_url) return Promise.reject(IntegrationError('stripe.confirmPayment(): the confirmParams.return_url argument is required unless passing redirect: \\'if_required\\'.'));
    var cs = o.clientSecret || els._o.clientSecret;
    if (!cs) return Promise.reject(IntegrationError('stripe.confirmPayment(): the clientSecret argument is required when the Elements group was created without one (deferred mode).'));
    if (!validSecret(cs)) return Promise.reject(IntegrationError('Invalid value for confirmPayment(): clientSecret should be a PaymentIntent client secret. (stubyard does not simulate SetupIntents.)'));
    if (!els._o.clientSecret && !els._submitted) return Promise.resolve({ error: { type: 'invalid_request_error', code: 'elements_submit_required', message: 'elements.submit() must be called before stripe.confirmPayment(). Call elements.submit() as soon as your customer presses pay, prior to any asynchronous work.' } });
    var pe = els._els.payment;
    if (!pe || !pe._mounted) return Promise.reject(IntegrationError('stripe.confirmPayment(): could not find a mounted Payment Element in this Elements group.'));
    var pmd = cp.payment_method_data || {};
    return this._confirmFrame(pe, cs, { return_url: cp.return_url || null, billing_details: pmd.billing_details || null, receipt_email: cp.receipt_email || null }, { returnUrl: cp.return_url, redirect: redirect });
  };
  P.confirmCardPayment = function (cs, data, opts) {
    data = data || {}; opts = opts || {};
    if (!validSecret(cs)) return Promise.reject(IntegrationError('Invalid value for confirmCardPayment: clientSecret should be the client_secret of a PaymentIntent (pi_…_secret_…).'));
    var o = { redirect: 'if_required', handleActions: opts.handleActions };
    var pm = data.payment_method;
    if (pm && typeof pm === 'object' && pm.card instanceof Element) return this._confirmFrame(pm.card, cs, { return_url: data.return_url || null, billing_details: pm.billing_details || null, receipt_email: data.receipt_email || null }, o);
    if (pm && typeof pm === 'object') return Promise.reject(IntegrationError('confirmCardPayment: payment_method.card should be a card Element (raw card data is not accepted by Stripe.js).'));
    var s = this, p = { client_secret: cs };
    if (typeof pm === 'string') p.payment_method = pm;
    if (data.return_url) p.return_url = data.return_url;
    return api(s, 'POST', '/v1/payment_intents/' + encodeURIComponent(piOf(cs)) + '/confirm', p).then(function (r) { return s._finish(r, cs, o); });
  };
  P.handleNextAction = function (o) {
    var s = this, cs = o && o.clientSecret;
    if (!validSecret(cs)) return Promise.reject(IntegrationError('Invalid value for handleNextAction: clientSecret should be a PaymentIntent client secret.'));
    return s.retrievePaymentIntent(cs).then(function (r) {
      if (r.error) return r;
      return s._finish({ ok: true, j: r.paymentIntent }, cs, { redirect: 'if_required' });
    });
  };
  P.handleCardAction = function (cs) { return this.handleNextAction({ clientSecret: cs }); };
  function elementOf(o) {
    if (o instanceof Element) return o;
    if (o && o.card instanceof Element) return o.card;
    if (o && o.elements instanceof Elements) return o.elements._els.payment || o.elements._els.card || null;
    return null;
  }
  P.createPaymentMethod = function (o) {
    o = o || {};
    var el = elementOf(o);
    if (!el || !el._mounted) return Promise.reject(IntegrationError('createPaymentMethod: pass { elements } or { type: \\'card\\', card: cardElement } with a mounted Element.'));
    var billing = o.billing_details || (o.params && o.params.billing_details) || null;
    return el._ask({ type: 'payment_method', key: this._key, billing_details: billing }).then(function (d) { return d.error ? { error: d.error } : { paymentMethod: d.paymentMethod }; });
  };
  P.createToken = function (el, data) {
    if (!(el instanceof Element) || !el._mounted) return Promise.reject(IntegrationError('createToken: pass a mounted card Element.'));
    return el._ask({ type: 'token', key: this._key, billing_details: data || null }).then(function (d) { return d.error ? { error: d.error } : { token: d.token }; });
  };
  function notSimulated(what) { return function () { warn(what + ' is not simulated'); return Promise.resolve({ error: { type: 'invalid_request_error', code: 'stubyard_not_simulated', message: 'stubyard: ' + what + ' is not simulated yet (SetupIntents and saved payment methods come later).' } }); }; }
  P.confirmSetup = notSimulated('stripe.confirmSetup');
  P.confirmCardSetup = notSimulated('stripe.confirmCardSetup');
  P.retrieveSetupIntent = notSimulated('stripe.retrieveSetupIntent');
  P.paymentRequest = function () {
    var pr = emitter({});
    pr.canMakePayment = function () { return Promise.resolve(null); };
    pr.show = function () { warn('paymentRequest.show(): wallets are not simulated (canMakePayment() resolves null)'); };
    pr.update = function () {};
    pr.isShowing = function () { return false; };
    pr.abort = function () {};
    return pr;
  };

  // ---- Embedded Checkout ---------------------------------------------------------------------------------------
  function EmbeddedCheckout(s, cs, o) { this._s = s; this._cs = cs; this._o = o; this._ch = SY.uid(); this._mounted = false; this._destroyed = false; }
  var EC = EmbeddedCheckout.prototype;
  EC.mount = function (target) {
    if (this._destroyed) throw IntegrationError('This Embedded Checkout has been destroyed. Call initEmbeddedCheckout again.');
    var host = SY.el(target);
    if (!host) throw IntegrationError('The selector you specified (' + target + ') applies to no DOM elements that are currently on the page.');
    if (this._mounted) throw IntegrationError('Embedded Checkout is already mounted.');
    var self = this, l = SY.lang(this._s._opts.locale);
    var id = this._cs.split('_secret_')[0];
    var src = BASE + '/c/pay/' + encodeURIComponent(id) + '?' + qs({ client_secret: this._cs, stubyard_sdk: this._ch, stubyard_origin: location.origin, stubyard_mode: 'embedded', stubyard_lang: l === 'ar' ? 'ar' : undefined });
    var w = document.createElement('div');
    w.className = '__PrivateStripeElement';
    w.setAttribute('data-testid', 'stubyard-stripe-embedded-checkout');
    var f = SY.frame(src, l === 'ar' ? 'الدفع المضمّن (محاكاة)' : 'Embedded Checkout (simulated)', 640);
    f.setAttribute('data-testid', 'stubyard-stripe-checkout-frame');
    f.setAttribute('allow', 'payment *');
    w.appendChild(f);
    host.appendChild(w);
    this._wrap = w; this._mounted = true;
    this._br = SY.bridge({ origin: ORIGIN, ch: this._ch, source: ${js(SRC_CHECKOUT)}, win: function () { return f.contentWindow; } });
    this._br.on(function (d) {
      if (d.type === 'resize') f.style.height = Math.min(Math.max(Number(d.height) || 0, 300), 2400) + 'px';
      else if (d.type === 'complete') {
        if (typeof d.redirect === 'string' && /^https?:/.test(d.redirect)) { window.location.assign(d.redirect); return; }
        if (typeof self._o.onComplete === 'function') { try { self._o.onComplete(); } catch (x) { if (window.console) console.error(x); } }
      }
    });
  };
  EC.unmount = function () { if (this._br) this._br.close(); this._br = null; if (this._wrap && this._wrap.parentNode) this._wrap.parentNode.removeChild(this._wrap); this._mounted = false; };
  EC.destroy = function () { this.unmount(); this._destroyed = true; if (ACTIVE_CHECKOUT === this) ACTIVE_CHECKOUT = null; };
  P.initEmbeddedCheckout = function (o) {
    var s = this;
    o = o || {};
    if (ACTIVE_CHECKOUT) return Promise.reject(IntegrationError('You cannot have multiple Embedded Checkout objects. Call destroy() on the existing one first.'));
    if (typeof o.fetchClientSecret !== 'function' && typeof o.clientSecret !== 'string') return Promise.reject(IntegrationError('initEmbeddedCheckout: fetchClientSecret (a function returning a promise of the Checkout Session client_secret) is required.'));
    ACTIVE_CHECKOUT = true;
    var get = typeof o.fetchClientSecret === 'function' ? Promise.resolve().then(o.fetchClientSecret) : Promise.resolve(o.clientSecret);
    return get.then(function (cs) {
      if (typeof cs !== 'string' || !/^cs_(test|live)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(cs)) { ACTIVE_CHECKOUT = null; throw IntegrationError('initEmbeddedCheckout: the client secret should be the client_secret of a Checkout Session created with ui_mode embedded (cs_…_secret_…).'); }
      var ec = new EmbeddedCheckout(s, cs, o);
      ACTIVE_CHECKOUT = ec;
      return ec;
    }, function (e) { ACTIVE_CHECKOUT = null; throw e; });
  };
  P.createEmbeddedCheckoutPage = P.initEmbeddedCheckout;

  Stripe.stubyard = true;
  Stripe.version = 3;
  Stripe.stubyardVersion = ${js(STRIPE_JS_VERSION)};
  window.Stripe = Stripe;
})();
`;
}

// --------------------------------------------------------------------------------------------------------------
// The element frames
// --------------------------------------------------------------------------------------------------------------

/** Remove the kit TEST strip of a single-line frame (its label is the SDK badge in the page wrapper instead). */
const noBanner = (html: string) => html.replace(/<aside class="sy-test[^"]*"[\s\S]*?<\/aside>/, '');

function field(id: string, label: string, o: { type?: string; ac?: string; testid: string; dir?: string; placeholder?: string; value?: string }): string {
  return `<label class="k-field"><span class="k-lbl">${esc(label)}</span><input class="k-input" type="${o.type ?? 'text'}" id="${id}" autocomplete="${o.ac ?? 'off'}"${o.dir ? ` dir="${o.dir}"` : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.value ? ` value="${esc(o.value)}"` : ''} data-testid="${o.testid}"></label>`;
}

/** The frame-side script shared by every element: change events, focus / blur / clear and the answers. */
function frameScript(o: { origin: string; ch: string; type: ElementType; locale: Locale }): string {
  const L = o.locale;
  const msg = { realCard: tx(L, T.realCard), failed: tx(L, T.failed) };
  return `(function(){${frameBridge({ origin: o.origin, ch: o.ch, source: SRC })}
${o.type === 'payment' || o.type === 'card' ? cardJs(L) : 'var SYC=null;'}
var TYPE=${js(o.type)},MSG=${js(msg)};
var pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),err=document.getElementById('card-err');
var inputs=[].slice.call(document.querySelectorAll('input:not([type=hidden]),select'));
if(SYC)SYC.wire(pan,exp,cvc,document.getElementById('card-brand'));
function val(id){var e=document.getElementById(id);return e?String(e.value||'').trim():''}
function cardError(){if(!pan)return null;var bad=SYC.check(pan,exp,cvc);if(!bad)return null;var code=bad[1]===pan?'incomplete_number':bad[1]===exp?'incomplete_expiry':'incomplete_cvc';if(bad[0]===SYC.MSG.numInvalid)code='invalid_number';if(bad[0]===SYC.MSG.expPast)code='invalid_expiry_year_past';return{type:'validation_error',code:code,message:bad[0],el:bad[1]}}
function state(){
 if(TYPE==='address'){var v={name:val('a-name'),address:{line1:val('a-line1'),line2:val('a-line2')||null,city:val('a-city'),postal_code:val('a-postal'),country:val('a-country').toUpperCase()}};return{empty:!v.name&&!v.address.line1,complete:!!(v.name&&v.address.line1&&v.address.city&&v.address.country),value:v}}
 if(TYPE==='linkAuthentication'){var m=val('l-email');return{empty:!m,complete:/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(m),value:{email:m}}}
 var d=SYC.digits(pan.value);return{empty:!d&&!exp.value&&!cvc.value,complete:!cardError(),brand:d?SYC.brand(d):'unknown'}}
var last='';function changed(){var s=state();var k=JSON.stringify(s);if(k===last)return;last=k;SYB.post({type:'change',empty:s.empty,complete:s.complete,value:s.value||null,brand:s.brand})}
inputs.forEach(function(i){i.addEventListener('input',changed);i.addEventListener('change',changed);i.addEventListener('focus',function(){SYB.post({type:'focus'})});i.addEventListener('blur',function(){SYB.post({type:'blur'})});i.addEventListener('keydown',function(e){if(e.key==='Escape')SYB.post({type:'escape'})})});
function show(m,el){if(!err)return;err.textContent=m;err.classList.remove('hide');if(el){el.classList.add('k-bad');try{el.focus()}catch(x){}}}
function hide(){if(!err)return;err.classList.add('hide');err.textContent='';[pan,exp,cvc].forEach(function(x){if(x)x.classList.remove('k-bad')})}
function answer(id,o){o.type='answer';o.id=id;SYB.post(o)}
function facts(){var e=cardError();if(e){show(e.message,e.el);return{error:{type:e.type,code:e.code,message:e.message}}}hide();var fa=SYC.facts(SYC.digits(pan.value));
 if(fa.luhn&&!fa.test){pan.value='';show(MSG.realCard,pan);try{fetch('../card-warning',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brand:fa.brand}),credentials:'omit'})}catch(x){}changed();return{error:{type:'card_error',code:'card_declined',decline_code:'live_mode_test_card',message:MSG.realCard}}}
 return{card:{brand:fa.brand,last4:fa.last4,magicId:fa.magicId,luhn:fa.luhn,test:fa.test}}}
function call(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'omit'}).then(function(r){return r.json()}).catch(function(){return{error:{type:'api_connection_error',message:MSG.failed}}})}
var busy=false;function lock(on){busy=on;inputs.forEach(function(i){i.disabled=on})}
SYB.on(function(d){
 if(d.type==='focus'){var f=inputs[0];if(f)f.focus()}
 else if(d.type==='blur'){if(document.activeElement&&document.activeElement.blur)document.activeElement.blur()}
 else if(d.type==='clear'){inputs.forEach(function(i){if(i.tagName==='INPUT')i.value=''});hide();changed()}
 else if(d.type==='validate'){if(!pan){answer(d.id,{});return}var r=cardError();if(r){show(r.message,r.el);answer(d.id,{error:{type:r.type,code:r.code,message:r.message}})}else{hide();answer(d.id,{})}}
 else if(d.type==='confirm'||d.type==='payment_method'||d.type==='token'){
  if(!pan){answer(d.id,{error:{type:'invalid_request_error',message:'This Element cannot confirm a payment.'}});return}
  if(busy){answer(d.id,{error:{type:'invalid_request_error',message:'A confirm is already in progress.'}});return}
  var f=facts();if(f.error){answer(d.id,{error:f.error});return}
  var p=d.params||{},billing=d.billing_details||p.billing_details||null;lock(true);
  var path=d.type==='confirm'?'../confirm':d.type==='token'?'../tokens':'../payment_methods';
  call(path,{key:d.key,client_secret:d.client_secret,card:f.card,billing_details:billing,return_url:p.return_url||null,receipt_email:p.receipt_email||null}).then(function(j){lock(false);
   if(j&&j.error){if(j.error.type==='card_error'||j.error.type==='validation_error')show(j.error.message);answer(d.id,{error:j.error});return}
   if(d.type==='confirm'){var pi=j.paymentIntent;if(pi&&pi.last_payment_error&&pi.status==='requires_payment_method')show(pi.last_payment_error.message);answer(d.id,{paymentIntent:pi})}
   else if(d.type==='token')answer(d.id,{token:j.token});else answer(d.id,{paymentMethod:j.paymentMethod})})}
});
SYB.post({type:'ready'});changed();
})();`;
}

export function renderElementFrame(o: { type: ElementType; locale: Locale; origin: string; ch: string; amount: string | null }): string {
  const L = o.locale;
  let body = '';
  if (o.type === 'payment') {
    body = `<div class="k-sec" style="padding:8px"><p class="k-lbl" data-testid="stubyard-stripe-method">${esc(tx(L, T.card))}</p>${cardFields(L, { methods: ['card'], label: tx(L, T.cardInfo) })}
${field('p-country', tx(L, T.country), { testid: 'stubyard-stripe-country', dir: 'ltr', value: 'US' })}
<p class="k-hint" data-testid="stubyard-stripe-hint">${esc(tx(L, T.hint))}</p>${o.amount ? `<p class="k-hint" dir="ltr" data-testid="stubyard-amount">${esc(o.amount)}</p>` : ''}</div>`;
  } else if (o.type === 'card') {
    body = `<div style="padding:2px">${cardFields(L, { methods: ['card'], label: tx(L, T.cardInfo) })}</div>`;
  } else if (o.type === 'address') {
    body = `<div class="k-sec" style="padding:8px">${field('a-name', tx(L, T.name), { testid: 'stubyard-stripe-name', ac: 'name' })}${field('a-line1', tx(L, T.line1), { testid: 'stubyard-stripe-line1', ac: 'address-line1' })}${field('a-line2', tx(L, T.line2), { testid: 'stubyard-stripe-line2', ac: 'address-line2' })}<div class="k-grid2">${field('a-city', tx(L, T.city), { testid: 'stubyard-stripe-city', ac: 'address-level2' })}${field('a-postal', tx(L, T.postal), { testid: 'stubyard-stripe-postal', ac: 'postal-code', dir: 'ltr' })}</div>${field('a-country', tx(L, T.country), { testid: 'stubyard-stripe-country', ac: 'country', dir: 'ltr', placeholder: 'US' })}</div>`;
  } else {
    body = `<div style="padding:2px">${field('l-email', tx(L, T.email), { type: 'email', testid: 'stubyard-stripe-email', ac: 'email', dir: 'ltr', placeholder: 'email@example.com' })}</div>`;
  }
  const html = kitDocument({ title: tx(L, T.frame), locale: L, body: `<main class="k-wrap" style="padding:0" data-testid="stubyard-stripe-element-frame" data-type="${o.type}">${body}</main>`, scripts: [frameScript(o)], frame: true, banner: { variant: 'strip' } });
  return o.type === 'card' || o.type === 'linkAuthentication' ? noBanner(html) : html;
}

// --------------------------------------------------------------------------------------------------------------
// 3-D Secure page (modal frame or full-page redirect)
// --------------------------------------------------------------------------------------------------------------

function render3ds(o: { locale: Locale; p: Payment; merchant: string; mode: 'modal' | 'redirect'; bridge: { origin: string; ch: string } | null; state: 'waiting' | 'done' | 'nothing' }): string {
  const L = o.locale;
  const p = o.p;
  const action = (p.providerData.piAction as { card?: CardFacts } | null | undefined) ?? null;
  const card = action?.card ?? (p.cardLast4 ? { brand: p.cardBrand ?? 'card', last4: p.cardLast4 } : null);
  const facts = `<dl class="k-sec" style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0"><dt>${esc(tx(L, T.merchant))}</dt><dd style="margin:0">${esc(o.merchant)}</dd><dt>${esc(tx(L, T.amount))}</dt><dd style="margin:0" dir="ltr" data-testid="stubyard-amount">${esc(toDecimal(p.amount, p.currency) + ' ' + p.currency)}</dd>${card ? `<dt>${esc(tx(L, T.card4))}</dt><dd style="margin:0" dir="ltr">${esc(String(card.brand).toUpperCase())} •••• ${esc(card.last4)}</dd>` : ''}</dl>`;
  const inner =
    o.state !== 'waiting'
      ? `<div class="k-sec"><p data-testid="stubyard-3ds-done" data-state="${o.state}">${esc(tx(L, o.state === 'done' ? T.authDone : T.nothing))}</p></div>`
      : `<form method="post" class="k-sec" id="f3"><p class="k-hint">${esc(tx(L, T.authText))}</p>
<div class="k-actions"><button type="submit" class="k-paybtn" name="answer" value="complete" data-testid="stubyard-3ds-complete"><span class="k-label">${esc(tx(L, T.complete))}</span></button>
<button type="submit" class="k-btn" name="answer" value="fail" id="f3-fail" data-testid="stubyard-3ds-fail">${esc(tx(L, T.fail))}</button></div></form>`;
  const body = `<main class="k-wrap"><div class="k-card" data-testid="stubyard-stripe-3ds" data-mode="${o.mode}"><div class="k-head"><h1>${esc(tx(L, T.auth))}</h1></div>${facts}${inner}</div></main>`;
  const scripts: string[] = [];
  if (o.bridge) {
    const b = frameBridge({ origin: o.bridge.origin, ch: o.bridge.ch, source: SRC_3DS, resize: false });
    scripts.push(
      o.state !== 'waiting'
        ? `(function(){${b}SYB.post({type:'3ds-done'});})();`
        : `(function(){${b}SYB.on(function(d){if(d.type!=='cancel')return;var x=document.getElementById('f3-fail'),f=document.getElementById('f3');if(f&&x){if(f.requestSubmit)f.requestSubmit(x);else x.click()}});})();`,
    );
  }
  return kitDocument({ title: tx(L, T.auth), locale: L, body, scripts, frame: o.mode === 'modal', banner: { variant: o.mode === 'modal' ? 'strip' : 'full' } });
}

async function threeds(c: GatewayCtx, ref: string): Promise<unknown> {
  c.resolved.endpoint = 'stripe.js 3d secure';
  const L = langOf(c.query.lang);
  const mode = c.query.mode === 'redirect' ? 'redirect' : 'modal';
  const p = await intentBySecret(c, str(c.query.client_secret));
  if (piId(p) !== ref) throw new HttpError(404, 'Unknown PaymentIntent');
  let bridge: { origin: string; ch: string } | null = null;
  if (mode === 'modal') {
    const ch = channelOf(c.query.ch);
    const chk = checkSdkOrigin(c, c.query.origin, `Stripe.js 3D Secure (${c.inst.slug})`, (f) => c.svc.addLint(p, [f]));
    if (!ch || !chk.ok) {
      const refused = !chk.ok && chk.reason === 'refused';
      return htmlReply(c, refused ? 403 : 400, renderSdkError(L, tx(L, T.auth), refused ? tx(L, T.refused).replace('%O', chk.origin ?? '?') : tx(L, T.missing)));
    }
    bridge = { origin: chk.origin, ch };
  }
  const merchant = c.project.name;
  const waiting = !!p.providerData.piAction && OPEN.includes(p.status);
  if (c.req.method === 'POST') {
    if (!waiting) return htmlReply(c, 409, render3ds({ locale: L, p, merchant, mode, bridge, state: 'nothing' }));
    const action = p.providerData.piAction as { returnUrl?: string | null };
    const b = (c.req.body && typeof c.req.body === 'object' ? c.req.body : {}) as Json;
    const out = await answer3ds(c, p, str(b.answer) === 'complete');
    if (mode === 'redirect') {
      const status = out.status === 'failed' ? 'failed' : out.providerData.async ? 'pending' : 'succeeded';
      const to = action.returnUrl ? returnUrlOf(out, action.returnUrl, status) : null;
      if (to) return c.reply.redirect(to, 303);
    }
    return htmlReply(c, 200, render3ds({ locale: L, p: out, merchant, mode, bridge, state: 'done' }));
  }
  return htmlReply(c, waiting ? 200 : 409, render3ds({ locale: L, p, merchant, mode, bridge, state: waiting ? 'waiting' : 'nothing' }));
}

// --------------------------------------------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------------------------------------------

function factsOf(v: unknown): CardFacts | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Json;
  const last4 = String(f.last4 ?? '').replace(/\D/g, '').slice(-4);
  if (last4.length !== 4) return null;
  const brand = String(f.brand ?? 'visa').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) || 'visa';
  return { brand, last4, magicId: asString(f.magicId)?.slice(0, 40) ?? null, luhnValid: f.luhn === true, testCard: f.test === true };
}

function billingOf(v: unknown): Json {
  if (!v || typeof v !== 'object') return {};
  const b = v as Json;
  const s = (x: unknown) => (typeof x === 'string' ? x.slice(0, 200) : null);
  const a = (b.address && typeof b.address === 'object' ? b.address : {}) as Json;
  return { name: s(b.name), email: s(b.email), phone: s(b.phone), address: { line1: s(a.line1), line2: s(a.line2), city: s(a.city), postal_code: s(a.postal_code), state: s(a.state), country: s(a.country) } };
}

/** The PaymentIntent as the publishable key sees it (no metadata). */
export const pubIntent = (pi: Json): Json => {
  const { metadata: _m, ...rest } = pi;
  return rest;
};

/** A JSON call from an element frame (stubyard's own origin): Stripe errors as { error }. */
async function frameApi(c: GatewayCtx, fn: (b: Json) => Promise<Json>): Promise<unknown> {
  const b = (c.req.body && typeof c.req.body === 'object' ? c.req.body : {}) as Json;
  try {
    pkAuth(c, b.key);
    return await fn(b);
  } catch (e) {
    if (e instanceof StripeError) {
      c.resolved.error = e.body.message;
      const body = { ...e.body } as Json;
      if (body.payment_intent) body.payment_intent = pubIntent(body.payment_intent as Json);
      return c.reply.status(e.status).send({ error: body });
    }
    throw e;
  }
}

const needCard = (b: Json): CardFacts => {
  const card = factsOf(b.card);
  if (!card) throw new StripeError(400, { type: 'validation_error', code: 'incomplete_number', message: 'Your card number is incomplete.' });
  return card;
};

/**
 * The browser side of the fake Stripe.js: the script, the element frames and their JSON calls, the 3DS page.
 * undefined when the path is none of them.
 */
export async function stripeJsRoute(c: GatewayCtx): Promise<unknown> {
  const { path } = c;
  const m = c.req.method;
  if (SCRIPT_RE.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'stripe.js';
    return c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').header('cross-origin-resource-policy', 'cross-origin').header('access-control-allow-origin', '*').header('x-content-type-options', 'nosniff').send(stripeJs({ base: requestBase(c) }));
  }
  if (!path.startsWith('/stripe-js/')) return undefined;
  if (m === 'OPTIONS') {
    sdkCors(c);
    return c.reply.status(204).send();
  }
  let mm: RegExpExecArray | null;
  if ((mm = /^\/stripe-js\/elements\/([A-Za-z]+)$/.exec(path)) && (m === 'GET' || m === 'HEAD')) {
    const type = mm[1] as ElementType;
    if (!(ELEMENT_TYPES as readonly string[]).includes(type)) throw new HttpError(404, 'Unknown Stripe Element type');
    c.resolved.endpoint = 'stripe.js ' + type + ' element';
    const L = langOf(c.query.lang);
    const ch = channelOf(c.query.ch);
    const chk = checkSdkOrigin(c, c.query.origin, 'Stripe.js (' + c.inst.slug + ')');
    if (!ch || !chk.ok) {
      const refused = !chk.ok && chk.reason === 'refused';
      return htmlReply(c, refused ? 403 : 400, renderSdkError(L, tx(L, T.frame), refused ? tx(L, T.refused).replace('%O', chk.origin ?? '?') : tx(L, T.missing)));
    }
    const cur = str(c.query.currency).toUpperCase();
    const amt = str(c.query.amount);
    const amount = /^[A-Z]{3}$/.test(cur) && /^\d{1,12}$/.test(amt) ? toDecimal(Number(amt), cur) + ' ' + cur : null;
    return htmlReply(c, 200, renderElementFrame({ type, locale: L, origin: chk.origin, ch, amount }));
  }
  if (path === '/stripe-js/confirm' && m === 'POST') {
    c.resolved.endpoint = 'stripe.js confirm';
    return frameApi(c, async (b) => {
      const p0 = await intentBySecret(c, b.client_secret);
      const card = needCard(b);
      const pm = savePm(c, card, billingOf(b.billing_details));
      const email = asString(b.receipt_email);
      const p = c.svc.repo.update(p0.id, { ...(email ? { customerEmail: email.slice(0, 200) } : {}), providerData: { ...p0.providerData, pm: pm.id } });
      const returnUrl = asString(b.return_url);
      const pi = await confirmWith(c, p, card, { returnUrl: returnUrl && /^https?:\/\//.test(returnUrl) ? returnUrl : null, via: 'js' });
      return { paymentIntent: pubIntent(pi) };
    });
  }
  if (path === '/stripe-js/payment_methods' && m === 'POST') {
    c.resolved.endpoint = 'stripe.js create payment method';
    return frameApi(c, async (b) => ({ paymentMethod: savePm(c, needCard(b), billingOf(b.billing_details)) }));
  }
  if (path === '/stripe-js/tokens' && m === 'POST') {
    c.resolved.endpoint = 'stripe.js create token';
    return frameApi(c, async (b) => {
      const card = needCard(b);
      const pm = savePm(c, card, billingOf(b.billing_details), 'tok_1');
      return { token: { id: pm.id, object: 'token', card: { id: 'card_1' + String(pm.id).slice(5), object: 'card', ...(pm.card as Json) }, client_ip: null, created: pm.created, livemode: false, type: 'card', used: false } };
    });
  }
  if (path === '/stripe-js/card-warning' && m === 'POST') {
    c.resolved.endpoint = 'stripe.js card warning';
    return c.reply.status(204).send();
  }
  if ((mm = /^\/stripe-js\/3ds\/([^/]+)$/.exec(path)) && (m === 'GET' || m === 'HEAD' || m === 'POST')) return threeds(c, decodeURIComponent(mm[1]!));
  return undefined;
}

// --------------------------------------------------------------------------------------------------------------
// Embedded Checkout: the hosted page in the SDK frame
// --------------------------------------------------------------------------------------------------------------

export interface StripeBridge {
  ch: string;
  origin: string;
  mode: 'embedded';
}

export function stripeBridgeOf(p: Payment): StripeBridge | null {
  const b = p.providerData.sdkBridge as StripeBridge | undefined;
  return b && b.mode === 'embedded' && typeof b.ch === 'string' && typeof b.origin === 'string' ? b : null;
}

/** /c/pay/<cs>?stubyard_sdk=<channel>: an Embedded Checkout frame. Checks the session, secret and origin; null = go on. */
export function attachEmbedded(c: GatewayCtx, p: Payment): unknown | null {
  const ch = channelOf(c.query.stubyard_sdk);
  if (!ch) return null;
  const L = langOf(c.query.stubyard_lang);
  const title = 'Embedded Checkout';
  if (!isEmbedded(p)) return htmlReply(c, 400, renderSdkError(L, title, 'initEmbeddedCheckout: this Checkout Session was not created with ui_mode=embedded_page (or embedded).'));
  if (str(c.query.client_secret) !== sessionSecretOf(p)) return htmlReply(c, 403, renderSdkError(L, title, 'initEmbeddedCheckout: the client secret does not belong to this Checkout Session.'));
  const chk = checkSdkOrigin(c, c.query.stubyard_origin, 'Stripe Embedded Checkout (' + c.inst.slug + ')', (f) => c.svc.addLint(p, [f]));
  if (!chk.ok) return htmlReply(c, chk.reason === 'refused' ? 403 : 400, renderSdkError(L, title, chk.reason === 'refused' ? tx(L, T.refused).replace('%O', chk.origin ?? '?') : tx(L, T.missing)));
  const cv = (p.providerData.checkoutView as Json | undefined) ?? {};
  c.svc.repo.update(p.id, { providerData: { ...p.providerData, sdkBridge: { ch, origin: chk.origin, mode: 'embedded' }, checkoutView: { ...cv, ui: 'realistic', ...(L === 'ar' ? { locale: 'ar' } : {}) } } });
  c.svc.repo.addEvent(p, 'sdk_opened', { sdk: 'Stripe.js initEmbeddedCheckout', mode: 'embedded', origin: chk.origin });
  return null;
}

/** Inside the Embedded Checkout frame: auto-height and the ready signal. */
export function embeddedPayScript(p: Payment): string | null {
  const b = stripeBridgeOf(p);
  return b ? `(function(){${frameBridge({ origin: b.origin, ch: b.ch, source: SRC_CHECKOUT })}SYB.post({type:'ready'});})();` : null;
}

/** The finished Embedded Checkout: tell the page (onComplete, or the top-window redirect to return_url). */
export function embeddedCompleteScript(p: Payment, redirect: string | null): string | null {
  const b = stripeBridgeOf(p);
  if (!b || !['paid', 'authorized', 'partially_refunded', 'refunded'].includes(p.status)) return null;
  return `(function(){${frameBridge({ origin: b.origin, ch: b.ch, source: SRC_CHECKOUT })}SYB.post({type:'complete',status:${js(p.status)},redirect:${js(redirect)}});})();`;
}

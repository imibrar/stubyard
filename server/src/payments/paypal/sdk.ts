import type { GatewayCtx, Json } from '../gateway.js';
import { asString, bodyOf, header } from '../common.js';
import { OPEN } from '../engine.js';
import { finding } from '../lint.js';
import { pageCsp, renderCardFieldPage } from '../pages.js';
import { checkSdkOrigin, SDK_RUNTIME } from '../sdk/runtime.js';
import { htmlReply, renderSdkError } from '../sdk/wallet.js';
import type { Payment } from '../repo.js';
import { authorizeOrder, challenge, completeCard, liabilityShiftOf } from './expanded.js';
import { captureOrder, createOrder, findOrder, issueAccessToken, orderOf, orderStatus, PpError, unprocessable } from './index.js';
import { vaultPageRoute } from './vault.js';

/**
 * The PayPal JS SDK (v5) on the fake: GET /sdk/js?client-id=…&components=buttons,card-fields serves a small script
 * defining paypal.Buttons and paypal.CardFields. Buttons open the stubyard approval page in a popup (or an overlay
 * iframe when the instance's buttonsMode is "inline") and poll /sdk/orders/<id>/state every second; Card Fields are
 * stubyard iframes that pass only brand / last 4 / magic id to the page. Client endpoints authenticate with the client
 * id (header X-Stubyard-Client-Id), standing in for the real SDK's facilitator token.
 *
 * P2: the buttons are neutral (no PayPal colours or logo) with the TEST notice in the container; without
 * fundingSource the stack is PayPal, Pay Later, Debit or Credit Card (paypal.FUNDING.PAYLATER opens the approval page
 * with funding=paylater, which shows the Pay in 4 / Pay Monthly offers on the review screen). The approval page and
 * the Card Fields frames get the page origin (origin=location.origin): the server checks it against the instance's
 * sdkOrigins / the project's appOrigins and the frames post only to that origin (never "*"); the SDK accepts
 * messages only from stubyard's origin.
 */

export const SDK_VERSION = '5.0.0-stubyard';
const MODES = new Set(['popup', 'inline']);
const LT = '\\' + 'u003c';

function cors(c: GatewayCtx): void {
  c.reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'content-type, x-stubyard-client-id, paypal-request-id').header('access-control-allow-methods', 'GET, POST, OPTIONS').header('cross-origin-resource-policy', 'cross-origin');
}

function clientAuth(c: GatewayCtx): void {
  const id = header(c.req, 'x-stubyard-client-id') ?? asString(c.query['client-id']);
  if (!id || id !== c.inst.config.clientId) throw new PpError(401, { error: 'invalid_client', error_description: 'Client Authentication failed (X-Stubyard-Client-Id does not match the instance client id)' });
}

/** What the SDK's state poll sees. */
export function sdkState(c: GatewayCtx, p: Payment): Json {
  const st = p.status;
  const state = OPEN.includes(st) ? (p.providerData.payerAction ? 'challenge' : 'open') : st === 'failed' ? 'failed' : st === 'cancelled' || st === 'expired' ? 'cancelled' : 'approved';
  const out: Json = { id: p.providerRef, status: orderStatus(p), state };
  if (state === 'approved') {
    out.payerID = p.method === 'card' ? null : String(p.providerData.payerId);
    // Browser-visible: an SDK-scoped token, refused by the server API.
    out.facilitatorAccessToken = issueAccessToken(c.inst.id, 'sdk');
  }
  if (p.method === 'card') out.liabilityShift = liabilityShiftOf(c.svc, p);
  return out;
}

/** The SDK script (exported for the happy-dom contract tests). */
export const clientJs = (cfg: Json) => `/* stubyard fake PayPal JS SDK ${SDK_VERSION} (not the real SDK). */
(function () {
  var CFG = ${JSON.stringify(cfg).replace(/</g, LT)};
  if (window.paypal && window.paypal.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = CFG.base;
  var ORIGIN = SY.originOf(BASE);
  var L = CFG.lang;
  var TXT = { paypal: 'PayPal', paylater: L === 'ar' ? 'ادفع لاحقًا' : 'Pay Later', card: L === 'ar' ? 'بطاقة خصم أو ائتمان' : 'Debit or Credit Card', venmo: 'Venmo', credit: 'PayPal Credit', title: L === 'ar' ? 'PayPal (محاكاة)' : 'PayPal (simulated)' };
  function req(method, path, body) {
    return fetch(BASE + path, { method: method, headers: { 'content-type': 'application/json', 'x-stubyard-client-id': CFG.clientId }, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var d = j && j.details && j.details[0];
          var err = new Error((d && (d.issue + ': ' + d.description)) || (j && (j.message || j.error_description)) || ('HTTP ' + r.status));
          err.status = r.status; err.body = j; throw err;
        }
        return j;
      });
    });
  }
  function el(sel) { return typeof sel === 'string' ? document.querySelector(sel) : sel; }
  function enc(s) { return encodeURIComponent(s); }
  function orderActions(id) {
    return {
      order: {
        capture: function () { return req('POST', '/sdk/orders/' + enc(id) + '/capture', {}); },
        authorize: function () { return req('POST', '/sdk/orders/' + enc(id) + '/authorize', {}); },
        get: function () { return req('GET', '/sdk/orders/' + enc(id)); }
      },
      restart: function () { return Promise.resolve(); },
      redirect: function (u) { window.location.href = u; }
    };
  }
  function overlay(url) {
    var ov = SY.overlay({ src: url, title: TXT.title, lang: L });
    ov.el.setAttribute('data-testid', 'stubyard-paypal-overlay');
    var w = { closedByUser: false, close: ov.close, el: ov.el };
    ov.closeBtn.addEventListener('click', function () { w.closedByUser = true; });
    return w;
  }
  function watch(id, win, wrap, done) {
    var finished = false, busy = false;
    function finish(s) {
      if (finished) return;
      finished = true; clearInterval(t); window.removeEventListener('message', onMsg);
      if (wrap) wrap.close();
      try { if (win && !win.closed) win.close(); } catch (e) {}
      done(s);
    }
    function poll() {
      if (busy || finished) return;
      busy = true;
      var gone = (win && win.closed) || (wrap && wrap.closedByUser);
      req('GET', '/sdk/orders/' + enc(id) + '/state').then(function (s) {
        busy = false;
        if (s.state !== 'open' && s.state !== 'challenge') finish(s);
        else if (gone) finish({ id: id, state: 'closed' });
      }, function () { busy = false; if (gone) finish({ id: id, state: 'closed' }); });
    }
    function onMsg(e) { if (e.origin !== ORIGIN) return; var d = e.data; if (d && d.source === 'stubyard-paypal' && d.orderID === id) poll(); }
    window.addEventListener('message', onMsg);
    var t = setInterval(poll, 1000);
  }
  function Buttons(opts) {
    opts = opts || {};
    function fail(e) { if (opts.onError) opts.onError(e); else if (window.console) console.error('[stubyard] paypal.Buttons', e); }
    function start(funding) {
      var popup = null;
      if (CFG.buttonsMode !== 'inline') { try { popup = window.open('', 'stubyard_paypal', 'width=480,height=720'); } catch (e) { popup = null; } }
      Promise.resolve(opts.onClick ? opts.onClick({ fundingSource: funding }, { resolve: function () { return true; }, reject: function () { return false; } }) : true).then(function (ok) {
        if (ok === false) { if (popup) popup.close(); return; }
        if (!opts.createOrder) throw new Error('paypal.Buttons: createOrder is required');
        return Promise.resolve(opts.createOrder({ paymentSource: funding }, { order: { create: function (body) { return req('POST', '/sdk/orders', body).then(function (o) { return o.id; }); } } })).then(function (id) {
          if (!id) throw new Error('createOrder did not return an order id');
          var url = BASE + '/checkoutnow?token=' + enc(id) + '&sdk=1&origin=' + enc(location.origin) + '&locale=' + (L === 'ar' ? 'ar_SA' : 'en_US') + (funding === 'paylater' ? '&funding=paylater' : '');
          var wrap = null;
          if (popup && !popup.closed) popup.location.href = url; else { popup = null; wrap = overlay(url); }
          watch(id, popup, wrap, function (s) {
            if (s.state === 'approved') {
              var data = { orderID: id, payerID: s.payerID, paymentID: null, facilitatorAccessToken: s.facilitatorAccessToken, paymentSource: funding };
              if (opts.onApprove) Promise.resolve().then(function () { return opts.onApprove(data, orderActions(id)); }).catch(fail);
            } else if (s.state === 'failed') fail(new Error('INSTRUMENT_DECLINED'));
            else if (opts.onCancel) opts.onCancel({ orderID: id });
          });
        });
      }).catch(function (e) { try { if (popup && !popup.closed) popup.close(); } catch (x) {} fail(e); });
    }
    return {
      isEligible: function () { return true; },
      render: function (sel) {
        var host = el(sel);
        if (!host) return Promise.reject(new Error('paypal.Buttons: container not found: ' + sel));
        var wrap = document.createElement('div');
        wrap.setAttribute('data-testid', 'stubyard-paypal-buttons');
        wrap.setAttribute('lang', L); wrap.dir = L === 'ar' ? 'rtl' : 'ltr';
        wrap.style.cssText = 'display:block;box-sizing:border-box;max-width:750px;width:100%;padding:8px;border:1px dashed #8a93a3;border-radius:8px;background:#fafbfc';
        host.appendChild(wrap);
        SY.badge(wrap, L);
        var list = opts.fundingSource ? [opts.fundingSource] : ['paypal', 'paylater', 'card'];
        var btns = [];
        var height = Math.min(Math.max(Number(opts.style && opts.style.height) || 45, 25), 55);
        list.forEach(function (fs, i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('data-testid', i === 0 && fs === (opts.fundingSource || 'paypal') ? 'stubyard-paypal-button' : 'stubyard-paypal-button-' + fs);
          b.setAttribute('data-funding-source', fs);
          b.textContent = TXT[fs] || fs;
          var primary = fs === 'paypal';
          b.style.cssText = 'display:block;width:100%;min-height:' + Math.max(height, 44) + 'px;margin:' + (i ? '8px' : '0') + ' 0 0;padding:6px 12px;border:1px solid ' + (primary ? '#1f2a44' : '#9aa3b2') + ';border-radius:' + (opts.style && opts.style.shape === 'pill' ? '999px' : '6px') + ';background:' + (primary ? '#1f2a44' : '#fff') + ';color:' + (primary ? '#fff' : '#1f2a44') + ';font:700 16px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;cursor:pointer';
          b.addEventListener('click', function () { start(fs); });
          wrap.appendChild(b);
          btns.push(b);
        });
        if (opts.onInit) { try { opts.onInit({}, { enable: function () { btns.forEach(function (b) { b.disabled = false; }); }, disable: function () { btns.forEach(function (b) { b.disabled = true; }); } }); } catch (e) {} }
        return Promise.resolve();
      },
      close: function () { return Promise.resolve(); }
    };
  }
  function CardFields(opts) {
    opts = opts || {};
    var cf = 'cf' + Math.random().toString(36).slice(2, 10);
    var empty = function () { return { isValid: false, isEmpty: true, isPotentiallyValid: true, isFocused: false }; };
    var st = { number: empty(), expiry: empty(), cvv: empty(), name: empty() };
    var frames = {}, card = null, name = '', expiry = '', emitted = null;
    function state() {
      var errs = [];
      if (!st.number.isValid) errs.push('INVALID_NUMBER');
      if (!st.expiry.isValid) errs.push('INVALID_EXPIRY');
      if (!st.cvv.isValid) errs.push('INVALID_CVV');
      if (frames.name && !st.name.isValid) errs.push('INVALID_NAME');
      var brand = (card && card.brand) || 'unknown';
      return { cards: card ? [{ type: brand, niceType: brand.charAt(0).toUpperCase() + brand.slice(1), code: { name: brand === 'amex' ? 'CID' : 'CVV', size: brand === 'amex' ? 4 : 3 } }] : [], emittedBy: emitted, isFormValid: errs.length === 0, errors: errs, fields: { cardNumberField: st.number, cardExpiryField: st.expiry, cardCvvField: st.cvv, cardNameField: st.name } };
    }
    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN) return;
      var d = e.data;
      if (!d || d.source !== 'stubyard-paypal-cf' || d.cf !== cf) return;
      if (d.state) st[d.type] = d.state;
      emitted = d.type;
      if (d.type === 'number' && 'card' in d) card = d.card;
      if (d.realCard) card = null;
      if (d.name !== undefined) name = d.name;
      if (d.expiry !== undefined) expiry = d.expiry;
      var map = { focus: 'onFocus', blur: 'onBlur', change: 'onChange' };
      var cb = opts.inputEvents && opts.inputEvents[map[d.event]];
      if (cb) { try { cb(state()); } catch (x) {} }
    });
    function send(type, cmd) { var f = frames[type]; if (f && f.contentWindow) f.contentWindow.postMessage({ source: 'stubyard-paypal-cf-host', cf: cf, cmd: cmd }, ORIGIN); }
    function field(type) {
      return function (o) {
        o = o || {};
        return {
          render: function (sel) {
            var host = el(sel);
            if (!host) return Promise.reject(new Error('paypal.CardFields: container not found: ' + sel));
            var f = document.createElement('iframe');
            f.src = BASE + '/sdk/card-field?type=' + type + '&cf=' + cf + '&origin=' + enc(location.origin) + '&lang=' + L + (o.placeholder ? '&placeholder=' + enc(o.placeholder) : '');
            f.title = 'stubyard card ' + type;
            f.setAttribute('data-testid', 'stubyard-cf-frame-' + type);
            f.style.cssText = 'display:block;width:100%;height:' + (type === 'number' ? 96 : 64) + 'px;border:0';
            host.appendChild(f); frames[type] = f;
            return Promise.resolve();
          },
          clear: function () { send(type, 'clear'); },
          focus: function () { send(type, 'focus'); },
          close: function () { var f = frames[type]; if (f && f.parentNode) f.parentNode.removeChild(f); delete frames[type]; return Promise.resolve(); }
        };
      };
    }
    function fail(e) { if (opts.onError) opts.onError(e); }
    return {
      isEligible: function () { return true; },
      NumberField: field('number'), ExpiryField: field('expiry'), CVVField: field('cvv'), NameField: field('name'),
      getState: function () { return Promise.resolve(state()); },
      submit: function (extra) {
        var s = state();
        if (!s.isFormValid) { var e = new Error(s.errors.join(', ')); e.errors = s.errors; return Promise.reject(e); }
        if (!opts.createOrder) return Promise.reject(new Error('paypal.CardFields: createOrder is required'));
        var orderId = null;
        return Promise.resolve(opts.createOrder({ paymentSource: 'card' })).then(function (id) {
          orderId = id;
          return req('POST', '/sdk/orders/' + enc(id) + '/confirm-card', { card: card, name: name, expiry: expiry, billingAddress: (extra && extra.billingAddress) || null });
        }).then(function (r) {
          if (r.challengeUrl) return new Promise(function (res) { watch(orderId, null, overlay(r.challengeUrl), res); });
          return r;
        }).then(function (r) {
          if (r.state === 'approved') { var data = { orderID: orderId, liabilityShift: r.liabilityShift || undefined }; return opts.onApprove ? opts.onApprove(data) : data; }
          if (r.state === 'failed') throw new Error(r.liabilityShift === 'NO' ? '3D Secure authentication failed' : 'INSTRUMENT_DECLINED');
          if (opts.onCancel) opts.onCancel({ orderID: orderId });
          return null;
        }).catch(function (e) { fail(e); throw e; });
      }
    };
  }
  var paypal = { stubyard: true, version: CFG.version, FUNDING: { PAYPAL: 'paypal', CARD: 'card', PAYLATER: 'paylater', VENMO: 'venmo', CREDIT: 'credit' }, getFundingSources: function () { return ['paypal', 'paylater', 'card']; }, isFundingEligible: function () { return true; } };
  if (CFG.components.indexOf('buttons') >= 0) paypal.Buttons = Buttons;
  if (CFG.components.indexOf('card-fields') >= 0) paypal.CardFields = CardFields;
  window[CFG.namespace] = paypal;
})();
`;

/** /sdk/… (no bearer): the script, client endpoints, Card Fields iframes, 3DS and vault approval pages. */
export async function sdkRoute(c: GatewayCtx): Promise<unknown> {
  const { path } = c;
  if (!path.startsWith('/sdk/')) return undefined;
  const m = c.req.method;
  cors(c);
  if (m === 'OPTIONS') return c.reply.status(204).send();
  if (path === '/sdk/js' && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'js sdk';
    c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store');
    const id = asString(c.query['client-id']);
    if (!id || id !== c.inst.config.clientId) {
      c.resolved.error = 'client-id does not match';
      // 200 so the browser runs it and the error shows in the console (the real SDK answers 400).
      return c.reply.send(`throw new Error("stubyard PayPal SDK: client-id ${id ? 'does not match this instance' : 'is missing'} (use PAYPAL_CLIENT_ID from the stubyard Connect panel)");\n`);
    }
    const components = String(c.query.components ?? 'buttons').split(',').map((s) => s.trim()).filter(Boolean);
    const ns = /^[A-Za-z_$][\w$]{0,30}$/.test(String(c.query['data-namespace'] ?? '')) ? String(c.query['data-namespace']) : 'paypal';
    const mode = MODES.has(String(c.inst.config.buttonsMode ?? '')) ? String(c.inst.config.buttonsMode) : 'popup';
    return c.reply.send(clientJs({ base: c.base, clientId: id, components, intent: String(c.query.intent ?? 'capture').toUpperCase(), currency: String(c.query.currency ?? 'USD').toUpperCase(), vault: c.query.vault === 'true', buttonsMode: mode, namespace: ns, version: SDK_VERSION, lang: /^ar/i.test(String(c.query.locale ?? '')) ? 'ar' : 'en' }));
  }
  if (path === '/sdk/card-field' && m === 'GET') {
    c.resolved.endpoint = 'card field';
    const cf = /^[a-z0-9]{1,20}$/.test(String(c.query.cf ?? '')) ? String(c.query.cf) : 'cf';
    // The frame posts the card facts only to the page origin the server accepted (no origin: it posts nothing).
    let target: string | null = null;
    if (c.query.origin !== undefined) {
      const chk = checkSdkOrigin(c, c.query.origin, 'PayPal Card Fields (' + c.inst.slug + ')');
      if (!chk.ok) {
        return htmlReply(c, chk.reason === 'refused' ? 403 : 400, renderSdkError(c.query.lang === 'ar' ? 'ar' : 'en', 'PayPal Card Fields', chk.reason === 'refused' ? 'PayPal Card Fields: the page origin ' + (chk.origin ?? '?') + ' is not allowed for this instance (sdkOrigins / appOrigins).' : 'PayPal Card Fields: bad origin.'));
      }
      target = chk.origin;
    }
    const html = renderCardFieldPage({ type: String(c.query.type ?? 'number'), cf, warnAction: `${c.base}/sdk/card-warning`, placeholder: asString(c.query.placeholder)?.slice(0, 40) ?? null, targetOrigin: target });
    return c.reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', pageCsp(html)).send(html);
  }
  if (path === '/sdk/card-warning' && m === 'POST') {
    c.resolved.endpoint = 'card field warning';
    const brand = asString(bodyOf(c.req).brand)?.slice(0, 20) ?? 'card';
    c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', `A real-looking ${brand} number was typed into a Card Fields iframe and cleared in the browser`));
    c.svc.changed(c.project.id, { instance: c.inst.slug });
    return c.reply.status(204).send();
  }
  let mm: RegExpExecArray | null;
  if ((mm = /^\/sdk\/challenge\/([^/]+)$/.exec(path)) && m === 'GET') return challenge(c, decodeURIComponent(mm[1]!));
  const vault = await vaultPageRoute(c);
  if (vault !== undefined || c.reply.sent) return c.reply.sent ? c.reply : vault;

  clientAuth(c);
  if (path === '/sdk/orders' && m === 'POST') {
    const body = await createOrder(c, bodyOf(c.req));
    const p = c.svc.repo.byInstanceRef(c.inst.id, String(body.id));
    if (p) {
      const lint = p.lint.filter((f) => f.check !== 'pay.no-idempotency-key');
      c.svc.repo.update(p.id, { lint, providerData: { ...p.providerData, sdk: true, clientCreated: true } });
      c.svc.addLint(c.svc.repo.get(p.id)!, [finding('pay.paypal-client-side-create', 'The order was created in the browser (actions.order.create): amount and items come from the client')]);
    }
    return c.reply.status(201).send(body);
  }
  if ((mm = /^\/sdk\/orders\/([^/]+)(\/state|\/capture|\/authorize|\/confirm-card)?$/.exec(path))) {
    const id = decodeURIComponent(mm[1]!);
    const op = mm[2] ?? '';
    if (!op && m === 'GET') {
      c.resolved.endpoint = 'get order (client)';
      return orderOf(c.svc, await findOrder(c, id), c.inst);
    }
    if (op === '/state' && m === 'GET') {
      c.resolved.endpoint = 'order state (sdk poll)';
      return sdkState(c, await findOrder(c, id));
    }
    if (op === '/capture' && m === 'POST') return captureOrder(c, id);
    if (op === '/authorize' && m === 'POST') return authorizeOrder(c, id);
    if (op === '/confirm-card' && m === 'POST') {
      c.resolved.endpoint = 'card fields confirm';
      let p = await findOrder(c, id);
      if (!OPEN.includes(p.status)) throw unprocessable('ORDER_ALREADY_COMPLETED', `The order is ${orderStatus(p)}; Card Fields cannot pay it again.`);
      const b = bodyOf(c.req);
      const card = (b.card as Json | null) ?? null;
      if (!card || !card.last4) throw unprocessable('CARD_FIELDS_INCOMPLETE', 'No card from the Card Fields iframes.');
      if (card.test !== true) {
        c.svc.realCardWarning(p, asString(card.brand));
        throw unprocessable('CARD_NUMBER_NOT_A_TEST_CARD', 'stubyard only accepts test card numbers; nothing was stored.');
      }
      const ex = /^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/.exec(String(b.expiry ?? '').trim());
      const expiry = ex ? `${ex[2]!.length === 2 ? '20' + ex[2] : ex[2]}-${ex[1]!.padStart(2, '0')}` : null;
      const info = { brand: String(card.brand ?? 'visa').slice(0, 20), last4: String(card.last4).replace(/\D/g, '').slice(-4), magicId: asString(card.magicId), name: asString(b.name)?.slice(0, 80) ?? null, expiry };
      const sca = String(((p.providerData.cardFields as Json | undefined)?.sca as string | undefined) ?? 'SCA_WHEN_REQUIRED');
      p = c.svc.repo.update(p.id, { method: 'card', cardBrand: info.brand, cardLast4: info.last4, providerData: { ...p.providerData, sdk: true, methods: ['card'], card: info, sca } });
      if (sca === 'SCA_ALWAYS' || info.magicId === '3ds') {
        p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, payerAction: true } });
        c.svc.repo.addEvent(p, 'payer_action_required', { reason: '3ds', sca, via: 'card-fields' });
        c.svc.changed(p.projectId, { payment: p.id });
        return { ...sdkState(c, p), challengeUrl: `${c.base}/sdk/challenge/${p.id}` };
      }
      await completeCard(c.svc, p, info, 'page');
      return sdkState(c, c.svc.repo.get(p.id)!);
    }
  }
  throw new PpError(404, { name: 'RESOURCE_NOT_FOUND', message: `${m} ${path} is not part of the stubyard JS SDK.`, details: [], links: [] });
}

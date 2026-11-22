import { esc } from '../../auth/pages.js';
import { alnum } from '../common.js';
import type { GatewayCtx, Json } from '../gateway.js';
import type { Locale } from '../kit/i18n.js';
import { renderMerchantDemo } from '../pages.js';
import { js, requestBase, stubyardOrigins } from './runtime.js';

/**
 * Demo merchant pages for the P2 SDKs (GET {instance}/demo, ?lang=ar for Arabic). Each is a plain shop page on
 * stubyard's origin that loads the fake SDK the way an app would and prints every callback, so the SDK can be tried
 * without writing an app. /demo/result is the return / callback page.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const langOf = (c: GatewayCtx): Locale => (str(c.query.lang).toLowerCase().startsWith('ar') ? 'ar' : 'en');

/**
 * The demo's CSP also allows stubyard's other origin for this request (the configured browser URL vs the host the
 * page was opened on, e.g. 127.0.0.1 vs localhost): SDK scripts and frames may come from either.
 */
export function demoCsp(c: GatewayCtx, csp: string): string {
  const extra = stubyardOrigins(c).join(' ');
  if (!extra) return csp;
  return csp
    .split('; ')
    .map((d) => (/^(script-src|frame-src|child-src|connect-src) /.test(d) ? `${d} ${extra}` : d))
    .join('; ');
}

function send(c: GatewayCtx, d: { html: string; csp: string }): unknown {
  d = { ...d, csp: demoCsp(c, d.csp) };
  return c.reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', d.csp).header('x-content-type-options', 'nosniff').send(d.html);
}

/** The printing helper every demo uses: demoLog(label, value) into #demo-log. */
const LOG = "function demoLog(label,v){var o=document.getElementById('demo-log');var line=label+(v===undefined?'':': '+(typeof v==='string'?v:JSON.stringify(v)));o.textContent=(o.textContent?o.textContent+'\\n':'')+line;}";
const logBox = '<pre data-testid="stubyard-demo-log" id="demo-log" aria-live="polite" style="white-space:pre-wrap;overflow-wrap:anywhere;min-height:3em"></pre>';
const langLinks = (base: string, L: Locale) => `<p class="row"><a class="btn" href="${esc(base)}/demo${L === 'ar' ? '' : '?lang=ar'}">${L === 'ar' ? 'English' : 'العربية'}</a><a class="btn" href="${esc(base)}/demo${L === 'ar' ? '?lang=ar' : ''}">${L === 'ar' ? 'طلب جديد' : 'New order'}</a></p>`;

function resultPage(c: GatewayCtx, title: string, preset: string, extra: string): unknown {
  const base = requestBase(c);
  const q: Json = {};
  for (const [k, v] of Object.entries(c.query)) if (typeof v === 'string') q[k] = v.slice(0, 200);
  return send(c, renderMerchantDemo({ title, presetName: preset, lang: langOf(c), html: `<p>The query the shop's return page got:</p><pre data-testid="stubyard-demo-result">${esc(JSON.stringify(q, null, 2))}</pre>${extra}<p><a class="btn" href="${esc(base)}/demo">Start another payment</a></p>` }));
}

/** Moyasar Form: Moyasar.init with every callback. */
export function moyasarDemo(c: GatewayCtx, sub: string): unknown {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') {
    const id = str(c.query.id);
    const p = id ? c.svc.repo.byInstanceRef(c.inst.id, id) : null;
    return resultPage(c, 'Moyasar demo shop: result', 'Moyasar', `<p>Your server confirms with <code>GET /v1/payments/${esc(id || '{id}')}</code> (secret key): status <b data-testid="stubyard-demo-status">${esc(p?.status ?? 'unknown')}</b>. Never trust the query alone.</p>`);
  }
  const L = langOf(c);
  const cfg = { element: '.mysr-form', amount: 1000, currency: 'SAR', description: 'stubyard demo order', publishable_api_key: String(c.inst.config.publishableKey ?? ''), callback_url: base + '/demo/result', methods: ['creditcard', 'stcpay', 'applepay'], supported_networks: ['visa', 'mastercard', 'mada'], language: L, metadata: { order: 'demo-' + alnum(6).toLowerCase() } };
  const after = `${LOG}
Moyasar.init(Object.assign(${js(cfg)},{
 on_initiating:function(){demoLog('on_initiating');return true},
 on_completed:function(p){demoLog('on_completed',{id:p.id,status:p.status,source:p.source&&p.source.type});return Promise.resolve()},
 on_failure:function(e){demoLog('on_failure',e)},
 on_redirect:function(url){demoLog('on_redirect',url);window.location.href=url}
}));`;
  return send(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر Moyasar التجريبي' : 'Moyasar demo shop',
    presetName: 'Moyasar',
    lang: L,
    html: `<p>${L === 'ar' ? 'نموذج Moyasar (<code>Moyasar.init</code>) بمبلغ 10.00 ريال. البطاقة 4111 1111 1111 1111 (تحويل إلى 3-D Secure)، أو STC Pay (الرمز في صندوق رسائل stubyard)، أو ورقة Apple Pay المحاكاة.' : 'Moyasar Form (<code>Moyasar.init</code>) for 10.00 SAR. Card 4111 1111 1111 1111 (3-D Secure redirect), STC Pay (code in the stubyard inbox) or the simulated Apple Pay sheet.'}</p>${langLinks(base, L)}<div class="mysr-form"></div>${logBox}`,
    scripts: [{ src: base + '/mpf/moyasar.js' }],
    after,
  }));
}

/** GeideaCheckout: a fresh session per page load; popup and drop-in buttons. */
export async function geideaDemo(c: GatewayCtx, sub: string, session: (b: Json) => Promise<unknown>, sign: (b: Json) => string): Promise<unknown> {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') return resultPage(c, 'Geidea demo shop: result', 'Geidea', '<p>Your server checks the signature and fetches the order (<code>GET /pgw/api/v1/direct/order/{orderId}</code>).</p>');
  const L = langOf(c);
  const b: Json = { amount: 25, currency: 'SAR', merchantReferenceId: 'demo-' + alnum(8).toLowerCase(), timestamp: new Date().toISOString(), language: L, returnUrl: base + '/demo/result' };
  b.signature = sign(b);
  const res = (await session(b)) as Json;
  const sid = String(((res.session as Json | undefined) ?? {}).id ?? '');
  c.resolved.endpoint = 'demo' + sub;
  const after = `${LOG}
var SID=${js(sid)};
function pay(dropin){var g=new GeideaCheckout(function(d){demoLog('onSuccess',d)},function(d){demoLog('onError',d)},function(d){demoLog('onCancel',d)});demoLog('startPayment',dropin?'drop-in':'popup');g.startPayment(SID,null,dropin?'gd-dropin':undefined)}
document.getElementById('gd-popup').addEventListener('click',function(){pay(false)});
document.getElementById('gd-drop').addEventListener('click',function(){pay(true)});`;
  return send(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر Geidea التجريبي' : 'Geidea demo shop',
    presetName: 'Geidea',
    lang: L,
    html: `<p>${L === 'ar' ? 'الجلسة' : 'Session'} <code data-testid="stubyard-demo-session">${esc(sid)}</code> ${L === 'ar' ? '(25.00 ريال، أُنشئت على الخادم لهذه الصفحة). <code>new GeideaCheckout(onSuccess, onError, onCancel).startPayment(sessionId)</code>؛ تُدفع الجلسة مرة واحدة: ابدأ طلبًا جديدًا للمحاولة مجددًا.' : '(25.00 SAR, created on the server for this page). <code>new GeideaCheckout(onSuccess, onError, onCancel).startPayment(sessionId)</code>; a session pays once: start a new order to try again.'}</p>${langLinks(base, L)}<p class="row"><button type="button" class="btn primary" id="gd-popup" data-testid="stubyard-demo-popup">${L === 'ar' ? 'ادفع (نافذة منبثقة)' : 'Pay (popup)'}</button><button type="button" class="btn" id="gd-drop" data-testid="stubyard-demo-dropin">${L === 'ar' ? 'ادفع (مضمَّن)' : 'Pay (drop-in)'}</button></p><div id="gd-dropin"></div>${logBox}`,
    scripts: [{ src: base + '/hpp/geideaCheckout.min.js' }],
    after,
  }));
}

/** PayPal Buttons (PayPal, Pay Later, card) and Card Fields. */
export function paypalDemo(c: GatewayCtx): unknown {
  c.resolved.endpoint = 'demo';
  const base = requestBase(c);
  const L = langOf(c);
  const clientId = String(c.inst.config.clientId ?? '');
  const order = { intent: 'CAPTURE', purchase_units: [{ reference_id: 'demo-' + alnum(6).toLowerCase(), amount: { currency_code: 'USD', value: '12.00' } }] };
  const after = `${LOG}
var ORDER=${js(order)},CID=${js(clientId)},BASE=${js(base)};
paypal.Buttons({
 createOrder:function(d,actions){demoLog('createOrder',d.paymentSource);return actions.order.create(ORDER)},
 onApprove:function(d,actions){demoLog('onApprove',{orderID:d.orderID,payerID:d.payerID,paymentSource:d.paymentSource});return actions.order.capture().then(function(r){demoLog('captured',r.status)})},
 onCancel:function(d){demoLog('onCancel',d)},
 onError:function(e){demoLog('onError',String(e&&e.message||e))}
}).render('#pp-buttons');
var cf=paypal.CardFields({
 createOrder:function(){return fetch(BASE+'/sdk/orders',{method:'POST',headers:{'content-type':'application/json','x-stubyard-client-id':CID},body:JSON.stringify(ORDER)}).then(function(r){return r.json()}).then(function(o){demoLog('card order',o.id);return o.id})},
 onApprove:function(d){demoLog('CardFields onApprove',d)},
 onError:function(e){demoLog('CardFields onError',String(e&&e.message||e))}
});
cf.NameField().render('#cf-name');cf.NumberField().render('#cf-number');cf.ExpiryField().render('#cf-expiry');cf.CVVField().render('#cf-cvv');
document.getElementById('cf-pay').addEventListener('click',function(){cf.submit().catch(function(e){demoLog('submit',String(e&&e.message||e))})});`;
  return send(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر PayPal التجريبي' : 'PayPal demo shop',
    presetName: 'PayPal',
    lang: L,
    html: `<p>${L === 'ar' ? 'حزمة PayPal JS بمبلغ 12.00 دولار: <code>paypal.Buttons</code> (PayPal، الدفع لاحقًا، البطاقة) و<code>paypal.CardFields</code> (جرّب 4111 1111 1111 1111).' : 'PayPal JS SDK for 12.00 USD: <code>paypal.Buttons</code> (PayPal, Pay Later, card) and <code>paypal.CardFields</code> (try 4111 1111 1111 1111).'}</p>${langLinks(base, L)}<div id="pp-buttons"></div><h2 style="font-size:16px;margin:16px 0 4px">${L === 'ar' ? 'حقول البطاقة' : 'Card Fields'}</h2><div id="cf-name"></div><div id="cf-number"></div><div class="row" style="flex-wrap:wrap"><div id="cf-expiry" style="flex:1 1 140px;min-width:0"></div><div id="cf-cvv" style="flex:1 1 140px;min-width:0"></div></div><p><button type="button" class="btn primary" id="cf-pay" data-testid="stubyard-demo-cf-pay">${L === 'ar' ? 'ادفع بالبطاقة' : 'Pay with card'}</button></p>${logBox}`,
    scripts: [{ src: `${base}/sdk/js?client-id=${encodeURIComponent(clientId)}&components=buttons,card-fields&currency=USD&locale=${L === 'ar' ? 'ar_SA' : 'en_US'}` }],
    after,
  }));
}

/** The demo helpers, shared with the P4b SDK demos (sdk/checkout-flow.ts, sdk/tap-card.ts, …). */
export { send as sendDemo, LOG as DEMO_LOG, logBox as DEMO_LOG_BOX, langLinks as demoLangLinks, resultPage as demoResultPage, langOf as demoLang };

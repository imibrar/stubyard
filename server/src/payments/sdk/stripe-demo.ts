import { esc } from '../../auth/pages.js';
import { alnum } from '../common.js';
import type { GatewayCtx, Json } from '../gateway.js';
import type { Locale } from '../kit/i18n.js';
import { tx } from '../kit/layout.js';
import { renderMerchantDemo } from '../pages.js';
import { DEMO_LOG, DEMO_LOG_BOX, sendDemo } from './demos.js';
import { js, requestBase } from './runtime.js';

/**
 * The Stripe.js demo shop (Payments P4a): GET {stripe instance}/demo?mode=payment|card|deferred|embedded (&lang=ar).
 * A plain merchant page on stubyard's origin that loads the fake Stripe.js like an app would:
 * - payment: a PaymentIntent created on the "server" per page load, the Link Authentication + Payment Elements,
 *   confirmPayment with return_url (the redirect goes to /demo/result);
 * - card: the Card Element and confirmCardPayment (no redirect);
 * - deferred: elements({ mode, amount, currency }), elements.submit(), then POST /demo/intent creates the intent and
 *   confirmPayment({ clientSecret, redirect: 'if_required' });
 * - embedded: a Checkout Session with ui_mode=embedded_page and initEmbeddedCheckout (return_url → /demo/result).
 * /demo/result shows the query and the status the server reads back with the secret key.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const MODES = ['payment', 'card', 'deferred', 'embedded'] as const;
type Mode = (typeof MODES)[number];
const AMOUNT = 2000;
const CURRENCY = 'usd';

const T = {
  title: { en: 'Stripe demo shop', ar: 'متجر Stripe التجريبي' },
  payment: { en: 'Payment Element', ar: 'عنصر الدفع' },
  card: { en: 'Card Element', ar: 'عنصر البطاقة' },
  deferred: { en: 'Deferred intent', ar: 'إنشاء لاحق' },
  embedded: { en: 'Embedded Checkout', ar: 'الدفع المضمّن' },
  pay: { en: 'Pay 20.00 USD', ar: 'ادفع 20.00 USD' },
  intro: { en: 'Fake Stripe.js (js.stripe.com/v3 served by stubyard) for a 20.00 USD order. Cards: 4242 4242 4242 4242 (success), 4000 0000 0000 0002 (declined), 4000 0000 0000 3220 (3-D Secure modal).', ar: 'Stripe.js مزيف (js.stripe.com/v3 من stubyard) لطلب بقيمة 20.00 USD. البطاقات: 4242 4242 4242 4242 (نجاح)، 4000 0000 0000 0002 (رفض)، 4000 0000 0000 3220 (التحقق ثلاثي الأبعاد).' },
  lang: { en: 'العربية', ar: 'English' },
  result: { en: 'Stripe demo shop: result', ar: 'متجر Stripe التجريبي: النتيجة' },
};

function langOf(c: GatewayCtx): Locale {
  return str(c.query.lang).toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

function nav(base: string, L: Locale, mode: Mode): string {
  const q = (m: Mode, l: Locale) => base + '/demo?mode=' + m + (l === 'ar' ? '&lang=ar' : '');
  const links = MODES.map((m) => '<a class="btn" href="' + esc(q(m, L)) + '"' + (m === mode ? ' aria-current="page"' : '') + ' data-testid="stubyard-demo-mode-' + m + '">' + esc(tx(L, T[m])) + '</a>').join('');
  return '<p class="row">' + links + '<a class="btn" href="' + esc(q(mode, L === 'ar' ? 'en' : 'ar')) + '">' + esc(tx(L, T.lang)) + '</a></p>';
}

export interface StripeDemoHooks {
  /** POST /v1/payment_intents with the instance secret key (the shop's server). */
  intent(b: Json): Promise<Json>;
  /** POST /v1/checkout/sessions (ui_mode embedded_page). */
  session(b: Json): Promise<Json>;
  /** GET of a payment intent / session for the result page. */
  status(ref: string): string | null;
}

export async function stripeDemo(c: GatewayCtx, sub: string, h: StripeDemoHooks): Promise<unknown> {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  const L = langOf(c);
  const order = () => 'demo-' + alnum(6).toLowerCase();
  if (sub === '/intent') {
    if (c.req.method !== 'POST') return c.reply.status(405).send({ error: 'POST only' });
    const pi = await h.intent({ amount: AMOUNT, currency: CURRENCY, metadata: { order_id: order() }, description: 'stubyard demo order' });
    return { clientSecret: pi.client_secret };
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.reply.status(405).send({ error: 'GET only' });
  if (sub === '/result') {
    const q: Json = {};
    for (const [k, v] of Object.entries(c.query)) if (typeof v === 'string') q[k] = v.slice(0, 200);
    const ref = str(c.query.payment_intent) || str(c.query.session_id);
    const st = ref ? h.status(ref) : null;
    return sendDemo(c, renderMerchantDemo({ title: tx(L, T.result), presetName: 'Stripe', lang: L, html: '<p>The query the shop\'s return page got:</p><pre data-testid="stubyard-demo-result">' + esc(JSON.stringify(q, null, 2)) + '</pre><p>Your server reads the status back with the secret key (<code>GET /v1/payment_intents/:id</code> or <code>GET /v1/checkout/sessions/:id</code>): <b data-testid="stubyard-demo-status">' + esc(st ?? 'unknown') + '</b>. Never trust the query alone.</p><p><a class="btn" href="' + esc(base) + '/demo">Start another payment</a></p>' }));
  }
  if (sub !== '') return c.reply.status(404).send({ error: 'Unknown demo page' });
  const mode: Mode = (MODES as readonly string[]).includes(str(c.query.mode)) ? (str(c.query.mode) as Mode) : 'payment';
  const pk = String(c.inst.config.publishableKey ?? '');
  const ret = base + '/demo/result' + (L === 'ar' ? '?lang=ar' : '');
  const stripeCfg = { pk, locale: L, ret, pay: tx(L, T.pay) };
  let html = '<p>' + esc(tx(L, T.intro)) + '</p>' + nav(base, L, mode);
  let after = DEMO_LOG + '\nvar C=' + js(stripeCfg) + ';var stripe=Stripe(C.pk,{locale:C.locale});';
  const payBtn = '<button type="button" class="btn primary" id="demo-pay" data-testid="stubyard-demo-pay">' + esc(tx(L, T.pay)) + '</button>';
  if (mode === 'payment' || mode === 'card') {
    const pi = await h.intent({ amount: AMOUNT, currency: CURRENCY, metadata: { order_id: order() }, description: 'stubyard demo order', automatic_payment_methods: { enabled: 'true' } });
    after += 'var CS=' + js(pi.client_secret) + ';';
    if (mode === 'payment') {
      html += '<div id="link-auth"></div><div id="payment-element"></div>' + payBtn;
      after += "var elements=stripe.elements({clientSecret:CS,locale:C.locale});var link=elements.create('linkAuthentication');link.mount('#link-auth');var pe=elements.create('payment',{layout:'tabs'});pe.on('ready',function(){demoLog('ready','payment')});pe.on('change',function(e){demoLog('change',{complete:e.complete,empty:e.empty})});pe.mount('#payment-element');"
        + "document.getElementById('demo-pay').addEventListener('click',function(){demoLog('confirmPayment');stripe.confirmPayment({elements:elements,confirmParams:{return_url:C.ret}}).then(function(r){demoLog('result',r.error?{error:r.error.message,code:r.error.code}:{status:r.paymentIntent.status})})});";
    } else {
      html += '<div id="card-element"></div>' + payBtn;
      after += "var elements=stripe.elements({locale:C.locale});var card=elements.create('card');card.on('change',function(e){demoLog('change',{complete:e.complete,brand:e.brand})});card.mount('#card-element');"
        + "document.getElementById('demo-pay').addEventListener('click',function(){demoLog('confirmCardPayment');stripe.confirmCardPayment(CS,{payment_method:{card:card,billing_details:{name:'Demo Buyer'}}}).then(function(r){demoLog('result',r.error?{error:r.error.message,code:r.error.code}:{id:r.paymentIntent.id,status:r.paymentIntent.status})})});";
    }
  } else if (mode === 'deferred') {
    html += '<div id="payment-element"></div>' + payBtn;
    after += "var elements=stripe.elements({mode:'payment',amount:" + AMOUNT + ",currency:'" + CURRENCY + "',locale:C.locale});elements.create('payment').mount('#payment-element');"
      + "document.getElementById('demo-pay').addEventListener('click',function(){elements.submit().then(function(s){if(s.error){demoLog('submit error',s.error.message);return}demoLog('POST /demo/intent');return fetch(location.pathname.replace(/\\/?$/,'/intent'),{method:'POST'}).then(function(r){return r.json()}).then(function(j){return stripe.confirmPayment({elements:elements,clientSecret:j.clientSecret,confirmParams:{return_url:C.ret},redirect:'if_required'})}).then(function(r){demoLog('result',r.error?{error:r.error.message,code:r.error.code}:{id:r.paymentIntent.id,status:r.paymentIntent.status})})})});";
  } else {
    const s = await h.session({ ui_mode: 'embedded_page', mode: 'payment', return_url: base + '/demo/result?session_id={CHECKOUT_SESSION_ID}' + (L === 'ar' ? '&lang=ar' : ''), client_reference_id: order(), line_items: [{ price_data: { currency: CURRENCY, unit_amount: AMOUNT, product_data: { name: 'stubyard demo order' } }, quantity: 1 }] });
    html += '<div id="checkout" data-testid="stubyard-demo-checkout"></div>';
    after += 'var CS=' + js(s.client_secret) + ";stripe.initEmbeddedCheckout({fetchClientSecret:function(){return Promise.resolve(CS)},onComplete:function(){demoLog('onComplete')}}).then(function(ec){ec.mount('#checkout');demoLog('mounted')},function(e){demoLog('error',e.message)});";
  }
  html += DEMO_LOG_BOX;
  return sendDemo(c, renderMerchantDemo({ title: tx(L, T.title), presetName: 'Stripe', lang: L, html, scripts: [{ src: base + '/js.stripe.com/v3/' }], after }));
}

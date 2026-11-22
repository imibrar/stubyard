import { esc } from '../../auth/pages.js';
import { asString, bodyOf } from '../common.js';
import { currencyDigits, toDecimal } from '../engine.js';
import type { GatewayCtx, Json } from '../gateway.js';
import { cardFields, methodTiles } from '../kit/fields.js';
import { t, type Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import type { PaymentMethod } from '../repo.js';
import { cardJs } from '../sdk/card.js';
import { channelOf, checkSdkOrigin, frameBridge, js, SDK_RUNTIME } from '../sdk/runtime.js';
import { htmlReply, renderSdkError } from '../sdk/wallet.js';
import { authKey, createPayment, MOYASAR_TEST_CARDS, type FormCard } from './index.js';

/**
 * Moyasar Form (mpf) on the fake (Payments P2; research R2):
 *
 *   <link rel="stylesheet" href="{base}/mpf/moyasar.css"><script src="{base}/mpf/moyasar.js"></script>
 *   <div class="mysr-form"></div>
 *   Moyasar.init({ element: '.mysr-form', amount: 1000, currency: 'SAR', description, publishable_api_key,
 *     callback_url, methods: ['creditcard', 'applepay', 'stcpay'], supported_networks, language, metadata,
 *     on_initiating, on_completed, on_failure, on_redirect, apple_pay: { label } });
 *
 * The form is a stubyard iframe ({base}/mpf/form) with the TEST notice. Card digits stay in the frame; it creates
 * the payment itself (POST {base}/mpf/payments with the publishable key and the card facts only), so no card data
 * reaches the merchant page or its server. The page side runs the callbacks:
 * - on_initiating() before anything is created: false stops, an object overrides amount / currency / description /
 *   metadata / callback_url / given_id; it may return a promise;
 * - on_completed(payment) once the payment exists (before the 3-D Secure redirect); a rejected promise stops;
 * - on_failure(error) when the payment cannot be created;
 * - on_redirect(url) takes over every redirect (3-D Secure transaction_url, callback_url?id&status&message).
 * Credit card: 3-D Secure as a full redirect to source.transaction_url, then callback_url?id=&status=&message=.
 * STC Pay: mobile → OTP (stubyard SMS inbox) in the form → callback_url. Apple Pay: the stubyard wallet sheet →
 * source applepay (paid or failed at once) → callback_url.
 */

export const MPF_VERSION = '1.14.0-stubyard';
const METHODS = ['creditcard', 'applepay', 'stcpay'] as const;
type FormMethod = (typeof METHODS)[number];
const TO_KIT: Record<FormMethod, PaymentMethod> = { creditcard: 'card', applepay: 'applepay', stcpay: 'stcpay' };

const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as string) : '');

export const MPF_CSS = '/* stubyard fake Moyasar Form styles: the form itself is an iframe. */\n.mysr-form{display:block;width:100%;max-width:100%;box-sizing:border-box}\n.mysr-form iframe{display:block;width:100%;border:0}\n';

/** The merchant-page script (window.Moyasar). */
export function mpfJs(cfg: { base: string; version: string }): string {
  return `/* stubyard fake Moyasar Form ${cfg.version} (not the real Moyasar library). */
(function () {
  if (window.Moyasar && window.Moyasar.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = SY.base(/\\/mpf\\/(?:[\\w.-]+\\/)*moyasar(?:\\.min)?\\.js$/, ${js(cfg.base)});
  var ORIGIN = SY.originOf(BASE);
  var OVERRIDE = ['amount', 'currency', 'description', 'metadata', 'callback_url', 'given_id'];
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))); return a.join('&'); }
  function warn(m) { if (window.console) console.error('[stubyard] Moyasar: ' + m); }
  function init(o) {
    o = o || {};
    var host = SY.el(o.element || '.mysr-form');
    if (!host) throw new Error('Moyasar: element not found: ' + (o.element || '.mysr-form'));
    if (!o.publishable_api_key) throw new Error('Moyasar: publishable_api_key is required');
    if (!(Number(o.amount) > 0) || Math.floor(Number(o.amount)) !== Number(o.amount)) throw new Error('Moyasar: amount must be a positive integer in the smallest currency unit (100 = 1.00 SAR)');
    if (!o.callback_url) warn('callback_url is missing: card payments will fail (it is required)');
    var l = SY.lang(o.language);
    var methods = (o.methods && o.methods.length ? o.methods : ['creditcard', 'applepay', 'stcpay']).filter(function (m) { return ['creditcard', 'applepay', 'stcpay'].indexOf(m) >= 0; });
    var cfg = { amount: Number(o.amount), currency: String(o.currency || 'SAR').toUpperCase(), description: o.description || '', callback_url: o.callback_url || '', metadata: o.metadata || null, given_id: o.given_id || null, apple_pay_label: (o.apple_pay && o.apple_pay.label) || o.description || '' };
    var ch = SY.uid();
    while (host.firstChild) host.removeChild(host.firstChild);
    if (host.classList) host.classList.add('mysr-form');
    var src = BASE + '/mpf/form?' + qs({ ch: ch, origin: location.origin, lang: l, key: o.publishable_api_key, amount: cfg.amount, currency: cfg.currency, methods: methods.join(','), networks: (o.supported_networks || ['visa', 'mastercard', 'mada']).join(',') });
    var f = SY.frame(src, l === 'ar' ? 'نموذج دفع Moyasar (محاكاة)' : 'Moyasar payment form (simulated)', 380);
    f.setAttribute('data-testid', 'stubyard-moyasar-frame');
    if (o.fixed_width !== false) f.style.maxWidth = '360px';
    host.appendChild(f);
    var br = SY.bridge({ origin: ORIGIN, ch: ch, source: 'stubyard-moyasar', win: function () { return f.contentWindow; } });
    function fail(e) { var m = String((e && e.message) || e || 'error'); if (o.on_failure) { try { o.on_failure(m); } catch (x) { warn(x); } } else warn(m); }
    function go(url) { if (o.on_redirect) { try { o.on_redirect(url); } catch (x) { warn(x); } } else window.location.href = url; }
    function wallet(d) {
      var wch = SY.uid();
      var ov = SY.overlay({ src: BASE + '/stubyard-sdk/wallet?' + qs({ wallet: d.wallet, amount: d.amount, label: cfg.apple_pay_label, ch: wch, origin: location.origin, lang: l }), title: (l === 'ar' ? 'Apple Pay (محاكاة)' : 'Apple Pay (simulated)'), lang: l, sheet: true });
      var wb = SY.bridge({ origin: ORIGIN, ch: wch, source: 'stubyard-wallet', win: function () { return ov.frame.contentWindow; } });
      var over = false;
      function end(m) { if (over) return; over = true; wb.close(); ov.close(); br.send({ type: 'wallet-result', result: m.result, card: m.card || null }); }
      wb.on(function (m) { if (m.type === 'wallet') end(m); });
      ov.closeBtn.addEventListener('click', function () { end({ result: 'cancelled' }); });
    }
    br.on(function (d) {
      if (d.type === 'ready') br.send({ type: 'config', config: cfg });
      else if (d.type === 'resize') f.style.height = Math.min(Math.max(Number(d.height) || 0, 120), 1400) + 'px';
      else if (d.type === 'initiating') {
        Promise.resolve().then(function () { return o.on_initiating ? o.on_initiating() : undefined; }).then(function (r) {
          if (r === false) { br.send({ type: 'initiating-result', ok: false }); return; }
          if (r && typeof r === 'object') OVERRIDE.forEach(function (k) { if (k in r) cfg[k] = r[k]; });
          br.send({ type: 'initiating-result', ok: true, config: cfg });
        }, function (e) { br.send({ type: 'initiating-result', ok: false }); fail(e); });
      } else if (d.type === 'completed') {
        Promise.resolve().then(function () { return o.on_completed ? o.on_completed(d.payment) : undefined; }).then(function () { br.send({ type: 'completed-ack', ok: true }); }, function (e) { br.send({ type: 'completed-ack', ok: false }); fail(e); });
      } else if (d.type === 'failure') fail(d.error);
      else if (d.type === 'redirect' && typeof d.url === 'string' && /^https?:/.test(d.url)) go(d.url);
      else if (d.type === 'wallet') wallet(d);
    });
  }
  window.Moyasar = { init: init, version: ${js(cfg.version)}, stubyard: true };
})();
`;
}

/** The form frame. */
export function renderMpfFrame(o: { locale: Locale; origin: string; ch: string; key: string; amount: number; currency: string; methods: FormMethod[]; networks: string[] }): string {
  const L = o.locale;
  const amountText = toDecimal(o.amount, o.currency) + ' ' + o.currency;
  const kitMethods = o.methods.map((m) => TO_KIT[m]);
  const labels = { card: L === 'ar' ? 'بطاقة' : 'Card', applepay: t(L, 'walletSim', { wallet: 'Apple Pay' }), stcpay: 'STC Pay' };
  const card = o.methods.includes('creditcard')
    ? `<div data-for="card"><label class="k-field"><span class="k-lbl">${esc(t(L, 'formName'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(L, 'fullName'))}" data-testid="stubyard-cardholder"></label></div>${cardFields(L, { methods: ['card'] })}
<div data-for="card"><button type="submit" class="k-paybtn" id="mf-pay" data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(t(L, 'formPay', { amount: amountText }))}</span></button></div>`
    : '';
  const apple = o.methods.includes('applepay')
    ? `<div data-for="applepay"><p class="k-hint">${esc(t(L, 'walletHint'))}</p><button type="button" class="k-paybtn" id="mf-apple" data-testid="stubyard-applepay"><span class="k-label">${esc(t(L, 'walletPayWith', { wallet: 'Apple Pay' }))}</span></button></div>`
    : '';
  const stc = o.methods.includes('stcpay')
    ? `<div data-for="stcpay"><div id="stc-1"><label class="k-field"><span class="k-lbl">${esc(t(L, 'stcMobile'))}</span><input class="k-input" type="tel" id="stc-mobile" inputmode="tel" autocomplete="off" placeholder="05XXXXXXXX" dir="ltr" data-testid="stubyard-phone"></label><button type="button" class="k-paybtn" id="mf-stc" data-testid="stubyard-stc-pay"><span class="k-label">${esc(t(L, 'formPay', { amount: amountText }))}</span></button></div>
<div id="stc-2" class="hide"><p class="k-hint" id="stc-prompt"></p><label class="k-field"><span class="k-lbl">${esc(t(L, 'code'))}</span><input class="k-input" type="text" id="stc-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" data-testid="stubyard-otp"></label><button type="button" class="k-paybtn" id="mf-otp" data-testid="stubyard-otp-submit"><span class="k-label">${esc(t(L, 'stcVerify'))}</span></button><p class="k-hint">${esc(t(L, 'threeWrong'))}</p></div></div>`
    : '';
  const body = `<main class="k-wrap" style="padding:0"><form class="k-card" id="mf" novalidate data-testid="stubyard-moyasar-form" data-layout="moyasar-form">
<div class="k-sec">${methodTiles(L, kitMethods, kitMethods[0] ?? 'card', labels)}
<div class="k-alert hide" role="alert" id="mf-err" data-testid="stubyard-form-error"></div>
${card}${apple}${stc}
</div><div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: 'Moyasar' }))}</span></div></form></main>`;
  const msg = { name: t(L, 'formNameErr'), mobile: t(L, 'stcMobileErr'), prompt: t(L, 'stcOtpPrompt', { phone: '%P%' }), cancelled: t(L, 'walletCancelled'), failed: t(L, 'paymentFailed'), network: L === 'ar' ? 'شبكة البطاقة غير مقبولة.' : 'This card network is not accepted.', wrong: L === 'ar' ? 'رمز خاطئ. حاول مرة أخرى.' : 'Wrong code. Try again.' };
  const script = `(function(){${frameBridge({ origin: o.origin, ch: o.ch, source: 'stubyard-moyasar' })}
${cardJs(L, MOYASAR_TEST_CARDS)}
var C=${js({ key: o.key, networks: o.networks, amountText, msg, warn: 'card-warning' })};
var cfg=null,pend=null,payment=null,busy=false,waitCfg=[];
var f=document.getElementById('mf'),err=document.getElementById('mf-err'),pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),cname=document.getElementById('cname');
SYC.wire(pan,exp,cvc,document.getElementById('card-brand'));
function sel(){var r=f.querySelector('input[name=method]:checked');if(r)return r.value;var h=f.querySelector('input[name=method]');return h?h.value:'card'}
function sync(){var m=sel();f.querySelectorAll('[data-for]').forEach(function(el){el.classList.toggle('hide',el.getAttribute('data-for').split(' ').indexOf(m)<0)})}
f.querySelectorAll('input[name=method]').forEach(function(r){r.addEventListener('change',function(){sync();hide()})});sync();
function show(m,el){err.textContent=m;err.classList.remove('hide');if(el){el.classList.add('k-bad');try{el.focus()}catch(e){}}}
function hide(){err.classList.add('hide');err.textContent='';[pan,exp,cvc,cname].forEach(function(x){if(x)x.classList.remove('k-bad')})}
function lock(on){busy=on;f.querySelectorAll('button').forEach(function(b){b.disabled=on;if(b.classList.contains('k-paybtn'))b.classList.toggle('k-busy',on)})}
SYB.on(function(d){
 if(d.type==='config'){cfg=d.config;var w=waitCfg;waitCfg=[];w.forEach(function(fn){fn()})}
 else if(d.type==='initiating-result'){var r=pend;pend=null;if(r)r(d)}
 else if(d.type==='completed-ack'){if(d.ok)next();else lock(false)}
 else if(d.type==='wallet-result'){walletDone(d)}
});
SYB.post({type:'ready'});
function ready(fn){if(cfg)fn();else waitCfg.push(fn)}
function initiate(){return new Promise(function(res){pend=res;SYB.post({type:'initiating'})})}
function create(source){var b={publishable_api_key:C.key,amount:cfg.amount,currency:cfg.currency,description:cfg.description,callback_url:cfg.callback_url,metadata:cfg.metadata,source:source};if(cfg.given_id)b.given_id=cfg.given_id;
 return fetch('payments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),credentials:'omit'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})}
function apiError(j){if(!j)return C.msg.failed;var e=j.errors,parts=[];if(e&&typeof e==='object')for(var k in e)parts.push(k+' '+[].concat(e[k]).join(', '));return(j.message||C.msg.failed)+(parts.length?': '+parts.join('; '):'')}
function failed(m){lock(false);show(m);SYB.post({type:'failure',error:m})}
function created(res){if(!res.ok){failed(apiError(res.j));return}payment=res.j;SYB.post({type:'completed',payment:payment})}
function cb(p){try{var u=new URL(cfg.callback_url);u.searchParams.set('id',p.id);u.searchParams.set('status',p.status);u.searchParams.set('message',p.message||'');return u.toString()}catch(e){return null}}
function next(){var p=payment;if(!p)return;
 if(p.source&&p.source.type==='stcpay'&&p.status==='initiated'){document.getElementById('stc-1').classList.add('hide');document.getElementById('stc-2').classList.remove('hide');document.getElementById('stc-prompt').textContent=C.msg.prompt.replace('%P%',p.source.mobile||'');lock(false);var o=document.getElementById('stc-otp');if(o)o.focus();return}
 if(p.status==='initiated'&&p.source&&p.source.transaction_url){SYB.post({type:'redirect',url:p.source.transaction_url});return}
 var u=cb(p);if(u)SYB.post({type:'redirect',url:u});else{lock(false);if(p.status==='failed')show((p.source&&p.source.message)||C.msg.failed)}}
function start(source){ready(function(){initiate().then(function(r){if(!r.ok){lock(false);return}if(r.config)cfg=r.config;create(source).then(created,function(){failed(C.msg.failed)})})})}
f.addEventListener('submit',function(e){e.preventDefault();if(busy)return;hide();
 var nm=(cname&&cname.value||'').trim();if(!/^\\S+(\\s+\\S+)+$/.test(nm)){show(C.msg.name,cname);return}
 var bad=SYC.check(pan,exp,cvc);if(bad){show(bad[0],bad[1]);return}
 var d=SYC.digits(pan.value),fa=SYC.facts(d),ex=SYC.exp(exp.value);
 if(fa.luhn&&!fa.test){pan.value='';show(SYC.MSG.realCard,pan);try{fetch(C.warn,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(fa.brand)})}catch(x){}return}
 var net=fa.brand==='mastercard'?['mastercard','master']:[fa.brand];if(C.networks.length&&fa.brand!=='unknown'&&!net.some(function(n){return C.networks.indexOf(n)>=0})){show(C.msg.network,pan);return}
 pan.value='';cvc.value='';lock(true);
 start({type:'creditcard',name:nm,month:ex.month,year:ex.year,card:fa})});
var ap=document.getElementById('mf-apple');if(ap)ap.addEventListener('click',function(){if(busy)return;hide();lock(true);ready(function(){initiate().then(function(r){if(!r.ok){lock(false);return}if(r.config)cfg=r.config;SYB.post({type:'wallet',wallet:'applepay',amount:C.amountText})})})});
function walletDone(d){if(d.result!=='authorized'||!d.card){lock(false);show(C.msg.cancelled);return}var tok='stubyard_wallet_'+Math.random().toString(36).slice(2,14);create({type:'applepay',token:tok,card:{brand:String(d.card.brand||'visa'),last4:String(d.card.last4||''),magicId:d.card.magicId||null,luhn:true,test:true}}).then(created,function(){failed(C.msg.failed)})}
var sp=document.getElementById('mf-stc');if(sp)sp.addEventListener('click',function(){if(busy)return;hide();var mo=document.getElementById('stc-mobile');var v=(mo.value||'').replace(/[\\s-]/g,'');if(!/^(05\\d{8}|\\+?9665\\d{8})$/.test(v)){show(C.msg.mobile,mo);return}lock(true);start({type:'stcpay',mobile:v})});
var op=document.getElementById('mf-otp');if(op)op.addEventListener('click',function(){if(busy||!payment)return;hide();var o=document.getElementById('stc-otp');var v=(o.value||'').trim();if(!/^\\d{4,6}$/.test(v)){show(C.msg.failed,o);return}lock(true);
 fetch('../checkout/'+encodeURIComponent(payment.id)+'?otp_value='+encodeURIComponent(v),{method:'POST',credentials:'omit'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(res){if(!res.ok){lock(false);o.value='';show(apiError(res.j),o);return}payment=res.j;if(payment.status==='initiated'){lock(false);o.value='';show(C.msg.wrong,o);return}var u=cb(payment);if(u)SYB.post({type:'redirect',url:u});else lock(false)},function(){failed(C.msg.failed)})});
})();`;
  return kitDocument({ title: t(L, 'sdkFrameTitle', { provider: 'Moyasar' }), locale: L, body, scripts: [script], frame: true, banner: { variant: 'strip' } });
}

/** /mpf/… routes, or undefined when the path is not one of them. */
export async function mpfRoute(c: GatewayCtx): Promise<unknown> {
  const { path } = c;
  const m = c.req.method;
  if (!path.startsWith('/mpf/')) return undefined;
  if (/^\/mpf\/(?:[\w.-]+\/)*moyasar(?:\.min)?\.js$/.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'moyasar form js';
    return c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').header('cross-origin-resource-policy', 'cross-origin').send(mpfJs({ base: c.base, version: MPF_VERSION }));
  }
  if (/^\/mpf\/(?:[\w.-]+\/)*moyasar(?:\.min)?\.css$/.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'moyasar form css';
    return c.reply.type('text/css; charset=utf-8').header('cache-control', 'no-store').header('cross-origin-resource-policy', 'cross-origin').send(MPF_CSS);
  }
  if (path === '/mpf/form' && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'moyasar form frame';
    const L: Locale = str(c.query.lang).toLowerCase().startsWith('ar') ? 'ar' : 'en';
    const ch = channelOf(c.query.ch);
    const chk = checkSdkOrigin(c, c.query.origin, 'Moyasar Form (' + c.inst.slug + ')');
    const title = t(L, 'sdkFrameTitle', { provider: 'Moyasar' });
    if (!ch || !chk.ok) {
      const refused = !chk.ok && chk.reason === 'refused';
      return htmlReply(c, refused ? 403 : 400, renderSdkError(L, title, refused ? t(L, 'sdkOriginRefused', { origin: chk.origin ?? '?', provider: 'Moyasar' }) : "Moyasar Form: missing channel or origin (load the form with stubyard's moyasar.js)."));
    }
    const cur = str(c.query.currency).toUpperCase();
    const currency = /^[A-Z]{3}$/.test(cur) && currencyDigits(cur) !== null ? cur : 'SAR';
    const amount = /^\d{1,12}$/.test(str(c.query.amount)) ? Number(str(c.query.amount)) : 0;
    const methods = str(c.query.methods).split(',').filter((x): x is FormMethod => (METHODS as readonly string[]).includes(x));
    const networks = str(c.query.networks).toLowerCase().split(',').map((x) => x.trim()).filter((x) => /^[a-z]{2,12}$/.test(x));
    return htmlReply(c, 200, renderMpfFrame({ locale: L, origin: chk.origin, ch, key: str(c.query.key).slice(0, 80), amount, currency, methods: methods.length ? [...new Set(methods)] : ['creditcard'], networks }));
  }
  if (path === '/mpf/payments' && m === 'POST') {
    // From the form frame (stubyard's origin: no CORS). The card arrives as facts, never as digits.
    const b = { ...bodyOf(c.req) } as Json;
    authKey(c, String(b.publishable_api_key ?? ''), true);
    delete b.publishable_api_key;
    const src = b.source && typeof b.source === 'object' ? { ...(b.source as Json) } : null;
    let card: FormCard | null = null;
    if (src && src.card && typeof src.card === 'object') {
      const f = src.card as Json;
      card = { brand: String(f.brand ?? 'visa').slice(0, 20), last4: String(f.last4 ?? '').replace(/\D/g, '').slice(-4), magicId: asString(f.magicId)?.slice(0, 40) ?? null, luhn: f.luhn === true, test: f.test === true };
    }
    if (src) {
      delete src.card;
      delete src.number;
      delete src.cvc;
      b.source = src;
    }
    c.resolved.endpoint = 'moyasar form payment';
    return createPayment(c, b, { card });
  }
  if (path === '/mpf/card-warning' && m === 'POST') {
    c.resolved.endpoint = 'moyasar form card warning';
    return c.reply.status(204).send();
  }
  return undefined;
}

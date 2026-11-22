import { esc } from '../../auth/pages.js';
import type { GatewayCtx, GatewayTestCard, Json } from '../gateway.js';
import { cardFields } from '../kit/fields.js';
import { t, type Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { renderMerchantDemo } from '../pages.js';
import { cardJs } from './card.js';
import { DEMO_LOG, DEMO_LOG_BOX, demoLang, demoLangLinks, demoResultPage, sendDemo } from './demos.js';
import { frameBridge, js, requestBase, SDK_RUNTIME } from './runtime.js';

/**
 * Checkout.com Flow (checkout-web-components) on the fake (Payments P4b; research R2):
 *
 *   server: POST {base}/payment-sessions {amount, currency, reference, billing, success_url, failure_url, metadata}
 *           → { id: "ps_…", payment_session_secret: "pss_…", payment_session_token, _links }
 *   page:   <script src="{base}/checkout-web-components/index.js"></script>
 *           const checkout = await CheckoutWebComponents({ publicKey, environment: 'sandbox', paymentSession, locale,
 *             appearance, componentOptions, translations, onReady, onChange, onError, onPaymentCompleted, handleSubmit });
 *           const flow = checkout.create('flow'); flow.mount('#flow-container');   // or create('card')
 *
 * The component is a stubyard iframe ({base}/flow/frame) with the TEST notice. Card digits stay in the frame: it
 * turns the card into session_data on stubyard (POST {base}/flow/session-data, card facts only) and the page submits
 * it: by default itself (POST {base}/flow/submit with the payment session secret), or through the merchant's
 * handleSubmit(component, { session_data }), whose server calls POST /payment-sessions/{id}/submit.
 * Submit answers { id: "pay_…", status: "Approved" | "Declined" | "Action Required", type: "card", action? }.
 * Approved → onPaymentCompleted(component, response); Declined → onError(component, error); Action Required
 * (3-D Secure) → a full-page redirect to the simulated ACS, then success_url / failure_url with cko-payment-id.
 * Component methods: mount, unmount, isValid, isAvailable, submit, tokenize, update.
 */

export const FLOW_VERSION = '1.0.0-stubyard';
export type FlowComponent = 'flow' | 'card';

/** The merchant-page script (window.CheckoutWebComponents). */
export function flowJs(cfg: { base: string; version: string }): string {
  return `/* stubyard fake Checkout.com Flow (checkout-web-components) ${cfg.version} (not the real library). */
(function () {
  if (window.CheckoutWebComponents && window.CheckoutWebComponents.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = SY.base(/\\/checkout-web-components\\/(?:[\\w.-]+\\/)*index(?:\\.min)?\\.js$/, ${js(cfg.base)});
  var ORIGIN = SY.originOf(BASE);
  var TYPES = ['flow', 'card'];
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))); return a.join('&'); }
  function warn(m) { if (window.console) console.error('[stubyard] CheckoutWebComponents: ' + m); }
  function CheckoutError(type, code, message, details) { var e = new Error(message); e.name = 'CheckoutError'; e.type = type; e.code = code; e.details = details || null; return e; }
  function jsonOf(r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j || {} }; }); }
  function CheckoutWebComponents(o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var ps = o.paymentSession || {};
      function bad(code, m) { var e = CheckoutError('Integration', code, m); if (o.onError) { try { o.onError(null, e); } catch (x) { warn(x); } } reject(e); }
      if (!o.publicKey || !/^pk_/.test(String(o.publicKey))) return bad('public_key_invalid', 'publicKey is required (pk_sbox_…)');
      if (!ps.id || !/^ps_/.test(String(ps.id)) || !ps.payment_session_secret) return bad('payment_session_invalid', 'paymentSession must be the POST /payment-sessions response (id, payment_session_secret, payment_session_token)');
      if (o.environment && o.environment !== 'sandbox') warn('environment "' + o.environment + '": stubyard only simulates the sandbox');
      fetch(BASE + '/flow/payment-sessions/' + encodeURIComponent(ps.id) + '?' + qs({ key: o.publicKey }), { credentials: 'omit' }).then(jsonOf).then(function (res) {
        if (!res.ok) return bad((res.j.error_codes && res.j.error_codes[0]) || 'payment_session_invalid', 'The payment session could not be loaded (' + res.status + ')');
        resolve(make(o, ps, res.j));
      }, function () { bad('network_error', 'stubyard could not be reached at ' + BASE); });
    });
  }
  function make(o, ps, info) {
    var l = SY.lang(o.locale);
    function create(type, copts) {
      copts = copts || {};
      if (TYPES.indexOf(type) < 0 && ['applepay', 'googlepay', 'paypal'].indexOf(type) < 0) throw CheckoutError('Integration', 'component_type_invalid', 'Unknown component type: ' + type);
      var supported = TYPES.indexOf(type) >= 0;
      function opt(k) { return copts[k] !== undefined ? copts[k] : o[k]; }
      var st = { valid: false, frame: null, br: null, pending: {}, n: 0 };
      var comp = { type: type, name: type, stubyard: true };
      function fire(k) { var f = opt(k); if (!f) return; var a = Array.prototype.slice.call(arguments, 1); try { return f.apply(null, [comp].concat(a)); } catch (x) { warn(x); } }
      function fail(e) { if (opt('onError')) fire('onError', e); else warn(e.message); }
      function tell(m) { if (st.br) st.br.send(m); }
      function handle(r) {
        if (!r || typeof r !== 'object' || !r.status) { tell({ type: 'done', ok: false }); fail(CheckoutError('Submit', 'submit_response_invalid', 'handleSubmit must resolve to the POST /payment-sessions/{id}/submit response')); return; }
        if (r.status === 'Action Required' && r.action && typeof r.action.url === 'string' && /^https?:/.test(r.action.url)) { tell({ type: 'done', ok: true, pending: true }); window.location.href = r.action.url; return; }
        if (r.status === 'Approved') { tell({ type: 'done', ok: true }); fire('onPaymentCompleted', r); return; }
        tell({ type: 'done', ok: false, declined: r.status === 'Declined' });
        fail(CheckoutError('Submit', r.status === 'Declined' ? 'payment_declined' : 'payment_failed', r.status === 'Declined' ? 'The payment was declined' : 'The payment failed (' + r.status + ')', r));
      }
      function submitData(sd) {
        var p = opt('handleSubmit')
          ? Promise.resolve().then(function () { return opt('handleSubmit')(comp, { session_data: sd }); })
          : fetch(BASE + '/flow/submit', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment_session_id: ps.id, payment_session_secret: ps.payment_session_secret, session_data: sd }) }).then(jsonOf).then(function (res) { if (!res.ok && !res.j.status) throw CheckoutError('Request', (res.j.error_codes && res.j.error_codes[0]) || 'request_failed', 'Submit failed (' + res.status + ')', res.j); return res.j; });
        p.then(handle, function (e) { tell({ type: 'done', ok: false }); fail(e && e.name === 'CheckoutError' ? e : CheckoutError('Submit', 'submit_failed', String((e && e.message) || e))); });
      }
      comp.mount = function (sel) {
        if (!supported) { warn(type + ' is not simulated by stubyard: isAvailable() resolves false'); return comp; }
        var host = SY.el(sel);
        if (!host) throw CheckoutError('Integration', 'mount_element_missing', 'Element not found: ' + sel);
        if (st.frame) comp.unmount();
        var ch = SY.uid();
        var co = (o.componentOptions && o.componentOptions[type]) || {};
        var src = BASE + '/flow/frame?' + qs({ ch: ch, origin: location.origin, lang: l, session: ps.id, key: o.publicKey, component: type, pay: opt('showPayButton') === false ? '0' : '1', name: co.displayCardholderName && co.displayCardholderName !== 'hidden' ? '1' : '0' });
        var f = SY.frame(src, l === 'ar' ? 'نموذج دفع Checkout.com (محاكاة)' : 'Checkout.com payment form (simulated)', 360);
        f.setAttribute('data-testid', 'stubyard-cko-flow-frame');
        host.appendChild(f);
        st.frame = f;
        var br = st.br = SY.bridge({ origin: ORIGIN, ch: ch, source: 'stubyard-cko-flow', win: function () { return f.contentWindow; } });
        br.on(function (d) {
          if (d.type === 'ready') { br.send({ type: 'config', appearance: o.appearance || null }); fire('onReady'); }
          else if (d.type === 'resize') f.style.height = Math.min(Math.max(Number(d.height) || 0, 120), 1400) + 'px';
          else if (d.type === 'change') { st.valid = !!d.valid; fire('onChange'); }
          else if (d.type === 'submit' && typeof d.session_data === 'string') submitData(d.session_data);
          else if (d.type === 'error') fail(CheckoutError(String(d.errorType || 'Submit'), String(d.code || 'error'), String(d.message || 'error')));
          else if (d.type === 'tokenized') { var pr = st.pending[d.id]; if (!pr) return; delete st.pending[d.id]; if (d.data) pr[0]({ data: d.data }); else pr[1](CheckoutError('Tokenization', String(d.code || 'tokenization_failed'), String(d.message || 'Tokenization failed'))); }
        });
        return comp;
      };
      comp.unmount = function () { if (st.br) st.br.close(); if (st.frame && st.frame.parentNode) st.frame.parentNode.removeChild(st.frame); st.frame = null; st.br = null; st.valid = false; return comp; };
      comp.isValid = function () { return st.valid; };
      comp.isAvailable = function () { return Promise.resolve(supported); };
      comp.submit = function () { if (!st.br) { warn('submit() before mount()'); return; } st.br.send({ type: 'submit-request' }); };
      comp.tokenize = function () { return new Promise(function (res, rej) { if (!st.br) { rej(CheckoutError('Integration', 'not_mounted', 'tokenize() before mount()')); return; } var id = 't' + (++st.n); st.pending[id] = [res, rej]; st.br.send({ type: 'tokenize', id: id }); }); };
      comp.update = function (u) { u = u || {}; for (var k in u) copts[k] = u[k]; tell({ type: 'update', options: { showPayButton: opt('showPayButton') !== false } }); return comp; };
      return comp;
    }
    return { create: create, paymentSession: { id: ps.id, amount: info.amount, currency: info.currency }, stubyard: true };
  }
  CheckoutWebComponents.stubyard = true;
  CheckoutWebComponents.version = ${js(cfg.version)};
  window.CheckoutWebComponents = CheckoutWebComponents;
})();
`;
}

/** The Flow component frame. */
export function renderFlowFrame(o: { locale: Locale; origin: string; ch: string; key: string; session: string; amountText: string; component: FlowComponent; showPay: boolean; cardholder: boolean; testCards: GatewayTestCard[] }): string {
  const L = o.locale;
  const ar = L === 'ar';
  const name = o.cardholder ? `<label class="k-field"><span class="k-lbl">${esc(t(L, 'cardholder'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(L, 'fullName'))}" data-testid="stubyard-cardholder"></label>` : '';
  const head = o.component === 'flow' ? `<div class="k-lbl" data-testid="stubyard-cko-flow-method">${esc(ar ? 'بطاقة ائتمان أو خصم' : 'Credit or debit card')}</div>` : '';
  const body = `<main class="k-wrap" style="padding:0"><form class="k-card" id="fl" novalidate data-testid="stubyard-cko-flow" data-layout="checkout-flow" data-component="${o.component}">
<div class="k-sec">${head}<div class="k-alert hide" role="alert" id="fl-err" data-testid="stubyard-form-error"></div>
${cardFields(L, { methods: ['card'] })}${name}
<button type="submit" class="k-paybtn${o.showPay ? '' : ' hide'}" id="fl-pay" data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(t(L, 'formPay', { amount: o.amountText }))}</span></button>
</div><div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: 'Checkout.com' }))}</span></div></form></main>`;
  const msg = { failed: t(L, 'paymentFailed'), declined: ar ? 'تم رفض الدفع. جرّب بطاقة أخرى.' : 'The payment was declined. Try another card.', name: t(L, 'formNameErr') };
  const script = `(function(){${frameBridge({ origin: o.origin, ch: o.ch, source: 'stubyard-cko-flow' })}
${cardJs(L, o.testCards)}
var C=${js({ key: o.key, session: o.session, msg })};
var f=document.getElementById('fl'),err=document.getElementById('fl-err'),pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),cname=document.getElementById('cname'),btn=document.getElementById('fl-pay');
SYC.wire(pan,exp,cvc,document.getElementById('card-brand'));
var busy=false,valid=null;
function show(m,el){err.textContent=m;err.classList.remove('hide');if(el){el.classList.add('k-bad');try{el.focus()}catch(e){}}}
function hide(){err.classList.add('hide');err.textContent='';[pan,exp,cvc,cname].forEach(function(x){if(x)x.classList.remove('k-bad')})}
function lock(on){busy=on;btn.disabled=on;btn.classList.toggle('k-busy',on)}
function check(){return SYC.check(pan,exp,cvc)}
function changed(){var v=!check();if(v!==valid){valid=v;SYB.post({type:'change',valid:v})}}
[pan,exp,cvc].forEach(function(x){x.addEventListener('input',changed)});
function facts(){var bad=check();if(bad){show(bad[0],bad[1]);return null}
 if(cname&&!/^\\S+(\\s+\\S+)+$/.test((cname.value||'').trim())){show(C.msg.name,cname);return null}
 var d=SYC.digits(pan.value),fa=SYC.facts(d),ex=SYC.exp(exp.value);
 if(fa.luhn&&!fa.test){pan.value='';valid=null;changed();show(SYC.MSG.realCard,pan);try{fetch('card-warning',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(fa.brand)})}catch(x){}return null}
 fa.bin=d.slice(0,6);return{card:fa,expiry_month:ex.month,expiry_year:ex.year,name:cname?(cname.value||'').trim():null}}
function post(path,b){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,j:j||{}}})})}
function body(x){return{session:C.session,key:C.key,card:x.card,expiry_month:x.expiry_month,expiry_year:x.expiry_year,name:x.name}}
function submit(){if(busy)return;hide();var x=facts();if(!x)return;lock(true);
 post('session-data',body(x)).then(function(res){
  if(!res.ok||!res.j.session_data){lock(false);show(C.msg.failed);SYB.post({type:'error',errorType:'Submit',code:(res.j.error_codes||[])[0]||'session_data_failed',message:C.msg.failed});return}
  cvc.value='';SYB.post({type:'submit',session_data:res.j.session_data})},function(){lock(false);show(C.msg.failed)})}
f.addEventListener('submit',function(e){e.preventDefault();submit()});
SYB.on(function(d){
 if(d.type==='config'){var a=d.appearance||{};if(a.colorAction){btn.style.background=String(a.colorAction);btn.style.borderColor=String(a.colorAction)}if(a.colorBackground)document.body.style.background=String(a.colorBackground);if(a.colorPrimary)f.style.color=String(a.colorPrimary);if(a.borderRadius){var r=[].concat(a.borderRadius)[0];if(r)f.querySelectorAll('.k-input,.k-paybtn').forEach(function(el){el.style.borderRadius=String(r)})}}
 else if(d.type==='submit-request')submit();
 else if(d.type==='done'){if(d.pending)return;lock(false);if(!d.ok){show(d.declined?C.msg.declined:C.msg.failed);pan.value='';valid=null;changed()}}
 else if(d.type==='update'){if(d.options)btn.classList.toggle('hide',d.options.showPayButton===false)}
 else if(d.type==='tokenize'){var id=d.id;hide();var x=facts();if(!x){SYB.post({type:'tokenized',id:id,code:'card_invalid',message:'The card details are not valid'});return}
  post('tokens',body(x)).then(function(res){if(res.ok)SYB.post({type:'tokenized',id:id,data:res.j});else SYB.post({type:'tokenized',id:id,code:(res.j.error_codes||[])[0]||'tokenization_failed',message:'Tokenization failed'})},function(){SYB.post({type:'tokenized',id:id,code:'network_error',message:'Tokenization failed'})})}
});
SYB.post({type:'ready'});changed();
})();`;
  return kitDocument({ title: t(L, 'sdkFrameTitle', { provider: 'Checkout.com' }), locale: L, body, scripts: [script], frame: true, banner: { variant: 'strip' } });
}

/** Demo shop: a payment session per page load, then Flow. */
export async function flowDemo(c: GatewayCtx, sub: string, session: (b: Json) => Promise<Json>, status: (id: string) => string | null): Promise<unknown> {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') {
    const id = typeof c.query['cko-payment-id'] === 'string' ? (c.query['cko-payment-id'] as string) : '';
    return demoResultPage(c, 'Checkout.com demo shop: result', 'Checkout.com', `<p>Your server confirms with <code>GET /payments/${esc(id || '{cko-payment-id}')}</code> (secret key): status <b data-testid="stubyard-demo-status">${esc((id && status(id)) || 'unknown')}</b>. Never trust the query alone.</p>`);
  }
  const L = demoLang(c);
  const s = await session({ amount: 1500, currency: 'SAR', reference: 'demo-' + Math.random().toString(36).slice(2, 8), billing: { address: { country: 'SA' } }, customer: { email: 'demo@example.com', name: 'Demo Buyer' }, success_url: base + '/demo/result', failure_url: base + '/demo/result?failed=1', metadata: { source: 'stubyard demo' } });
  c.resolved.endpoint = 'demo' + sub;
  const cfg = { publicKey: String(c.inst.config.publicKey ?? ''), environment: 'sandbox', locale: L, paymentSession: s, appearance: { colorAction: '#186aff', borderRadius: ['8px'] } };
  const after = `${DEMO_LOG}
var CFG=${js(cfg)},RESULT=${js(base + '/demo/result')},flow=null;
CheckoutWebComponents(Object.assign(CFG,{
 onReady:function(){demoLog('onReady')},
 onChange:function(c){demoLog('onChange',{valid:c.isValid()})},
 onPaymentCompleted:function(c,r){demoLog('onPaymentCompleted',r);setTimeout(function(){location.href=RESULT+'?cko-payment-id='+encodeURIComponent(r.id)},600)},
 onError:function(c,e){demoLog('onError',{type:e.type,code:e.code,message:e.message})}
})).then(function(checkout){demoLog('CheckoutWebComponents ready',checkout.paymentSession);flow=checkout.create('flow');flow.mount('#flow-container')},function(e){demoLog('init failed',e.message)});
document.getElementById('cko-tok').addEventListener('click',function(){if(flow)flow.tokenize().then(function(t){demoLog('tokenize',t.data)},function(e){demoLog('tokenize error',e.message)})});`;
  return sendDemo(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر Checkout.com التجريبي' : 'Checkout.com demo shop',
    presetName: 'Checkout.com',
    lang: L,
    html: `<p>Flow (<code>CheckoutWebComponents</code>) for 15.00 SAR, payment session <code data-testid="stubyard-demo-session">${esc(String(s.id ?? ''))}</code> (created on the server for this page). Cards: 4242 4242 4242 4242 (approved), 4243 7542 7170 0719 (3-D Secure redirect), 4539 4679 8710 9256 (declined).</p>${demoLangLinks(base, L)}<div id="flow-container"></div><p class="row"><button type="button" class="btn" id="cko-tok" data-testid="stubyard-demo-tokenize">Tokenize only</button></p>${DEMO_LOG_BOX}`,
    scripts: [{ src: base + '/checkout-web-components/index.js' }],
    after,
  }));
}

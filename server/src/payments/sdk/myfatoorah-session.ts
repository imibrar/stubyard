import { esc } from '../../auth/pages.js';
import type { GatewayCtx, GatewayTestCard, Json } from '../gateway.js';
import { cardFields, methodTiles } from '../kit/fields.js';
import { t, type Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { renderMerchantDemo } from '../pages.js';
import type { PaymentMethod } from '../repo.js';
import { cardJs } from './card.js';
import { DEMO_LOG, DEMO_LOG_BOX, demoLang, demoLangLinks, demoResultPage, sendDemo } from './demos.js';
import { frameBridge, js, requestBase, SDK_RUNTIME } from './runtime.js';

/**
 * MyFatoorah embedded payment (session.js) on the fake (Payments P4b; research R2, docs.myfatoorah.com/docs/embedded-payment):
 *
 *   server: POST /v2/InitiateSession → { Data: { SessionId, CountryCode } }
 *   page:   <script src="{base}/payment/v1/session.js"></script>
 *           myfatoorah.init({ sessionId, countryCode, currencyCode, amount, containerId, paymentOptions: ['Card',
 *             'ApplePay', 'GooglePay', 'STCPay'], language, callback });
 *           callback({ isSuccess, sessionId, paymentCompleted: false, paymentType, cardBrand, error? })
 *   server: POST /v2/ExecutePayment { SessionId, InvoiceValue, CallBackUrl, ErrorUrl } → { Data: { PaymentURL } }
 *
 * The form is a stubyard iframe ({base}/payment/v1/frame) with the TEST notice; card digits stay in it (it posts the
 * card facts to {base}/payment/v1/submit). PaymentURL: card → the simulated 3-D Secure page (open it in the window or
 * in an iframe: framed, the last page posts JSON.stringify({ sender: 'MF-3DSecure', url }) to the page's origin, which
 * then navigates to url); Apple Pay / Google Pay → paid at once, PaymentURL is CallBackUrl?paymentId=…; STC Pay → the
 * OTP page. shouldHandlePaymentUrl and the encrypted paymentData (v3) are not simulated.
 */

export const MF_SESSION_VERSION = '1.0.0-stubyard';
export const MF_OPTIONS = ['Card', 'ApplePay', 'GooglePay', 'STCPay'] as const;
export type MfOption = (typeof MF_OPTIONS)[number];

/** The merchant-page script (window.myfatoorah). */
export function mfSessionJs(cfg: { base: string; version: string }): string {
  return `/* stubyard fake MyFatoorah session.js ${cfg.version} (not the real MyFatoorah library). */
(function () {
  if (window.myfatoorah && window.myfatoorah.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = SY.base(/\\/payment\\/(?:[\\w.-]+\\/)*session(?:\\.min)?\\.js$/, ${js(cfg.base)});
  var ORIGIN = SY.originOf(BASE);
  var OPTIONS = ['Card', 'ApplePay', 'GooglePay', 'STCPay'];
  var cur = null;
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))); return a.join('&'); }
  function warn(m) { if (window.console) console.error('[stubyard] myfatoorah: ' + m); }
  function init(o) {
    o = o || {};
    if (!o.sessionId) throw new Error('myfatoorah.init: sessionId is required (POST /v2/InitiateSession)');
    if (typeof o.callback !== 'function') throw new Error('myfatoorah.init: callback is required');
    var host = SY.el(o.containerId ? (typeof o.containerId === 'string' ? document.getElementById(o.containerId) : o.containerId) : null);
    if (!host) throw new Error('myfatoorah.init: containerId not found: ' + o.containerId);
    if (o.shouldHandlePaymentUrl) warn('shouldHandlePaymentUrl is not simulated: call ExecutePayment on your server and open PaymentURL');
    var opts = (o.paymentOptions && o.paymentOptions.length ? o.paymentOptions : ['Card']).filter(function (x) { return OPTIONS.indexOf(x) >= 0; });
    var l = SY.lang(o.language);
    var ch = SY.uid();
    while (host.firstChild) host.removeChild(host.firstChild);
    var src = BASE + '/payment/v1/frame?' + qs({ ch: ch, origin: location.origin, lang: l, session: o.sessionId, country: o.countryCode, currency: o.currencyCode, amount: o.amount, options: opts.join(',') });
    var f = SY.frame(src, l === 'ar' ? 'نموذج دفع MyFatoorah (محاكاة)' : 'MyFatoorah payment form (simulated)', 340);
    f.setAttribute('data-testid', 'stubyard-mf-frame');
    host.appendChild(f);
    var br = SY.bridge({ origin: ORIGIN, ch: ch, source: 'stubyard-mf', win: function () { return f.contentWindow; } });
    var waiting = null;
    function wallet(d) {
      var wch = SY.uid();
      var name = d.wallet === 'googlepay' ? 'Google Pay' : 'Apple Pay';
      var ov = SY.overlay({ src: BASE + '/stubyard-sdk/wallet?' + qs({ wallet: d.wallet, amount: d.amount, label: o.merchantName || '', ch: wch, origin: location.origin, lang: l }), title: name + (l === 'ar' ? ' (محاكاة)' : ' (simulated)'), lang: l, sheet: true });
      var wb = SY.bridge({ origin: ORIGIN, ch: wch, source: 'stubyard-wallet', win: function () { return ov.frame.contentWindow; } });
      var over = false;
      function end(m) { if (over) return; over = true; wb.close(); ov.close(); br.send({ type: 'wallet-result', wallet: d.wallet, result: m.result, card: m.card || null }); }
      wb.on(function (m) { if (m.type === 'wallet') end(m); });
      ov.closeBtn.addEventListener('click', function () { end({ result: 'cancelled' }); });
    }
    br.on(function (d) {
      if (d.type === 'resize') f.style.height = Math.min(Math.max(Number(d.height) || 0, 120), 1400) + 'px';
      else if (d.type === 'wallet') wallet(d);
      else if (d.type === 'callback' && d.response && typeof d.response === 'object') {
        var w = waiting; waiting = null;
        if (w) w[d.response.isSuccess ? 0 : 1](d.response);
        try { o.callback(d.response); } catch (x) { warn(x); }
      }
    });
    cur = { br: br, frame: f, setWait: function (w) { waiting = w; } };
    return cur;
  }
  /** Submit the form from the page (a button outside the frame); resolves / rejects with the callback response. */
  function submit() {
    return new Promise(function (res, rej) { if (!cur) { rej({ isSuccess: false, error: 'myfatoorah.init first' }); return; } cur.setWait([res, rej]); cur.br.send({ type: 'submit' }); });
  }
  window.myfatoorah = { init: init, submit: submit, version: ${js(cfg.version)}, stubyard: true };
})();
`;
}

/** MyFatoorah's documented test card (docs.myfatoorah.com/docs/test-cards) on top of the stubyard ones. */
const MF_TEST_CARDS: GatewayTestCard[] = [{ number: '5123450000000008', brand: 'mastercard', magicId: null, label: 'Mastercard (MyFatoorah test card)' }];

const OPT_KIT: Record<MfOption, PaymentMethod> = { Card: 'card', ApplePay: 'applepay', GooglePay: 'wallet', STCPay: 'stcpay' };

/** The embedded form frame. */
export function renderMfSessionFrame(o: { locale: Locale; origin: string; ch: string; session: string; amountText: string; options: MfOption[] }): string {
  const L = o.locale;
  const ar = L === 'ar';
  const kit = o.options.map((x) => OPT_KIT[x]);
  const labels: Partial<Record<string, string>> = { card: ar ? 'بطاقة' : 'Card', applepay: t(L, 'walletSim', { wallet: 'Apple Pay' }), wallet: t(L, 'walletSim', { wallet: 'Google Pay' }), stcpay: 'STC Pay' };
  const pay = (id: string, testid: string, label: string) => `<button type="${id === 'mf-pay' ? 'submit' : 'button'}" class="k-paybtn" id="${id}" data-testid="${testid}"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(label)}</span></button>`;
  const parts = [
    o.options.includes('Card') ? `<div data-for="card"><label class="k-field"><span class="k-lbl">${esc(t(L, 'cardholder'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(L, 'fullName'))}" data-testid="stubyard-cardholder"></label></div>${cardFields(L, { methods: ['card'] })}<div data-for="card">${pay('mf-pay', 'stubyard-pay', t(L, 'formPay', { amount: o.amountText }))}</div>` : '',
    o.options.includes('ApplePay') ? `<div data-for="applepay"><p class="k-hint">${esc(t(L, 'walletHint'))}</p>${pay('mf-apple', 'stubyard-applepay', t(L, 'walletPayWith', { wallet: 'Apple Pay' }))}</div>` : '',
    o.options.includes('GooglePay') ? `<div data-for="wallet"><p class="k-hint">${esc(t(L, 'walletHint'))}</p>${pay('mf-google', 'stubyard-googlepay', t(L, 'walletPayWith', { wallet: 'Google Pay' }))}</div>` : '',
    o.options.includes('STCPay') ? `<div data-for="stcpay"><label class="k-field"><span class="k-lbl">${esc(t(L, 'stcMobile'))}</span><input class="k-input" type="tel" id="stc-mobile" inputmode="tel" autocomplete="off" placeholder="05XXXXXXXX" dir="ltr" data-testid="stubyard-phone"></label>${pay('mf-stc', 'stubyard-stc-pay', t(L, 'formPay', { amount: o.amountText }))}<p class="k-hint">${esc(ar ? 'يصلك رمز التحقق في الخطوة التالية (صندوق رسائل stubyard).' : 'The code comes on the next page (stubyard inbox).')}</p></div>` : '',
  ].join('');
  const body = `<main class="k-wrap" style="padding:0"><form class="k-card" id="mf" novalidate data-testid="stubyard-mf-form" data-layout="myfatoorah-session">
<div class="k-sec">${methodTiles(L, kit, kit[0] ?? 'card', labels)}
<div class="k-alert hide" role="alert" id="mf-err" data-testid="stubyard-form-error"></div>
${parts}
</div><div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: 'MyFatoorah' }))}</span></div></form></main>`;
  const msg = { name: t(L, 'formNameErr'), mobile: t(L, 'stcMobileErr'), cancelled: t(L, 'walletCancelled'), failed: t(L, 'paymentFailed') };
  const script = `(function(){${frameBridge({ origin: o.origin, ch: o.ch, source: 'stubyard-mf' })}
${cardJs(L, MF_TEST_CARDS)}
var C=${js({ session: o.session, amountText: o.amountText, msg })};
var f=document.getElementById('mf'),err=document.getElementById('mf-err'),pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),cname=document.getElementById('cname'),busy=false;
if(pan)SYC.wire(pan,exp,cvc,document.getElementById('card-brand'));
function sel(){var r=f.querySelector('input[name=method]:checked');if(r)return r.value;var h=f.querySelector('input[name=method]');return h?h.value:'card'}
function sync(){var m=sel();f.querySelectorAll('[data-for]').forEach(function(el){el.classList.toggle('hide',el.getAttribute('data-for').split(' ').indexOf(m)<0)})}
f.querySelectorAll('input[name=method]').forEach(function(r){r.addEventListener('change',function(){sync();hide()})});sync();
function show(m,el){err.textContent=m;err.classList.remove('hide');if(el){el.classList.add('k-bad');try{el.focus()}catch(e){}}}
function hide(){err.classList.add('hide');err.textContent='';[pan,exp,cvc,cname].forEach(function(x){if(x)x.classList.remove('k-bad')})}
function lock(on){busy=on;f.querySelectorAll('button').forEach(function(b){b.disabled=on;b.classList.toggle('k-busy',on)})}
function answer(r){SYB.post({type:'callback',response:r})}
function send(b){lock(true);b.session=C.session;fetch('submit',{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){lock(false);if(!r.ok||!j.isSuccess){show(j.error||C.msg.failed);answer({isSuccess:false,sessionId:C.session,error:j.error||C.msg.failed});return}if(pan){pan.value='';cvc.value=''}answer(j)})},function(){lock(false);show(C.msg.failed);answer({isSuccess:false,sessionId:C.session,error:C.msg.failed})})}
function card(){if(busy)return;hide();var nm=(cname&&cname.value||'').trim();if(!nm){show(C.msg.name,cname);return}
 var bad=SYC.check(pan,exp,cvc);if(bad){show(bad[0],bad[1]);return}
 var d=SYC.digits(pan.value),fa=SYC.facts(d);
 if(fa.luhn&&!fa.test){pan.value='';show(SYC.MSG.realCard,pan);try{fetch('card-warning',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(fa.brand)})}catch(x){}return}
 send({paymentType:'Card',card:fa,name:nm})}
function submit(){var m=sel();if(m==='card')card();else if(m==='stcpay')stc();else if(m==='applepay')wallet('applepay');else if(m==='wallet')wallet('googlepay')}
f.addEventListener('submit',function(e){e.preventDefault();card()});
function wallet(w){if(busy)return;hide();lock(true);SYB.post({type:'wallet',wallet:w,amount:C.amountText})}
function stc(){if(busy)return;hide();var mo=document.getElementById('stc-mobile');var v=(mo.value||'').replace(/[\\s-]/g,'');if(!/^(05\\d{8}|\\+?9665\\d{8})$/.test(v)){show(C.msg.mobile,mo);return}send({paymentType:'STCPay',mobile:v})}
var ap=document.getElementById('mf-apple');if(ap)ap.addEventListener('click',function(){wallet('applepay')});
var gp=document.getElementById('mf-google');if(gp)gp.addEventListener('click',function(){wallet('googlepay')});
var sp=document.getElementById('mf-stc');if(sp)sp.addEventListener('click',stc);
SYB.on(function(d){
 if(d.type==='submit')submit();
 else if(d.type==='wallet-result'){lock(false);if(d.result!=='authorized'||!d.card){show(C.msg.cancelled);answer({isSuccess:false,sessionId:C.session,error:C.msg.cancelled});return}
  send({paymentType:d.wallet==='googlepay'?'GooglePay':'ApplePay',card:{brand:String(d.card.brand||'visa'),last4:String(d.card.last4||''),magicId:d.card.magicId||null,luhn:true,test:true}})}
});
})();`;
  return kitDocument({ title: t(L, 'sdkFrameTitle', { provider: 'MyFatoorah' }), locale: L, body, scripts: [script], frame: true, banner: { variant: 'strip' } });
}

/** Demo shop: InitiateSession on the server, session.js, then ExecutePayment (POST {base}/demo/execute) and PaymentURL in an iframe. */
export async function mfSessionDemo(c: GatewayCtx, sub: string, session: () => Json, status: (paymentId: string) => string | null): Promise<unknown> {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') {
    const id = typeof c.query.paymentId === 'string' ? c.query.paymentId : '';
    return demoResultPage(c, 'MyFatoorah demo shop: result', 'MyFatoorah', `<p>Your server confirms with <code>POST /v2/GetPaymentStatus {Key: "${esc(id || '{paymentId}')}", KeyType: "PaymentId"}</code>: invoice status <b data-testid="stubyard-demo-status">${esc((id && status(id)) || 'unknown')}</b>. Never trust the query alone.</p>`);
  }
  const L = demoLang(c);
  const s = session();
  c.resolved.endpoint = 'demo' + sub;
  const cfg = { sessionId: String(s.SessionId ?? ''), countryCode: String(s.CountryCode ?? 'KWT'), currencyCode: String(s.Currency ?? 'KWD'), amount: String(s.Amount ?? '5.000'), containerId: 'mf-embedded', paymentOptions: ['Card', 'ApplePay', 'GooglePay', 'STCPay'], language: L, shouldHandlePaymentUrl: false };
  const after = `${DEMO_LOG}
var CFG=${js(cfg)},EXEC=${js(base + '/demo/execute')},STUB=${js(new URL(base).origin)};
window.addEventListener('message',function(e){if(e.origin!==STUB)return;var d;try{d=typeof e.data==='string'?JSON.parse(e.data):e.data}catch(x){return}if(!d||d.sender!=='MF-3DSecure')return;demoLog('MF-3DSecure message',d.url);location.href=d.url});
myfatoorah.init(Object.assign(CFG,{callback:function(r){demoLog('callback',r);if(!r.isSuccess)return;
 fetch(EXEC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({SessionId:r.sessionId,lang:CFG.language})}).then(function(x){return x.json()}).then(function(j){var u=j.Data&&j.Data.PaymentURL;demoLog('ExecutePayment (shop server)',j.IsSuccess?{InvoiceId:j.Data.InvoiceId,PaymentURL:u}:j);if(!u)return;
  if(r.paymentType==='Card'){var fr=document.getElementById('mf-3ds');fr.src=u;fr.hidden=false;demoLog('PaymentURL opened in an iframe (3-D Secure)')}else location.href=u})}}));`;
  return sendDemo(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر MyFatoorah التجريبي' : 'MyFatoorah demo shop',
    presetName: 'MyFatoorah',
    lang: L,
    html: `<p>Embedded payment (<code>myfatoorah.init</code>), session <code data-testid="stubyard-demo-session">${esc(cfg.sessionId)}</code> (InitiateSession on the server) for ${esc(cfg.amount)} ${esc(cfg.currencyCode)}. Card 5123 4500 0000 0008, the simulated Apple Pay / Google Pay sheet or STC Pay. Card payments open PaymentURL in the iframe below; its last page posts MF-3DSecure to this page.</p>${demoLangLinks(base, L)}<div id="mf-embedded"></div><iframe id="mf-3ds" title="3-D Secure" hidden style="width:100%;height:520px;border:1px solid #d6dae1;border-radius:8px" data-testid="stubyard-demo-3ds"></iframe>${DEMO_LOG_BOX}`,
    scripts: [{ src: base + '/payment/v1/session.js' }],
    after,
  }));
}

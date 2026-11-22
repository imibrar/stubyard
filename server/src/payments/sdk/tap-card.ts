import { esc } from '../../auth/pages.js';
import type { GatewayCtx, GatewayTestCard } from '../gateway.js';
import { cardFields } from '../kit/fields.js';
import { t, type Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { renderMerchantDemo } from '../pages.js';
import { cardJs } from './card.js';
import { DEMO_LOG, DEMO_LOG_BOX, demoLang, demoLangLinks, demoResultPage, sendDemo } from './demos.js';
import { frameBridge, js, requestBase, SDK_RUNTIME } from './runtime.js';

/**
 * Tap Card SDK v2 (Web Card SDK) on the fake (Payments P4b; research R2, developers.tap.company/docs/card-sdk-web-v2):
 *
 *   <script src="{base}/card-sdk/index.js"></script>
 *   const { renderTapCard, tokenize, Theme, Currencies, Direction, Edges, Locale } = window.CardSDK;
 *   const { unmount } = renderTapCard('card-sdk-id', { publicKey, merchant: { id }, transaction: { amount, currency },
 *     customer, acceptance: { supportedBrands, supportedCards }, fields: { cardHolder }, addons: { displayPaymentBrands,
 *     loader, saveCard }, interface: { locale, theme, edges, direction }, onReady, onFocus, onBinIdentification,
 *     onValidInput, onInvalidInput, onError, onSuccess, onChangeSaveCardLater });
 *   tokenize();   // → onSuccess({ id: "tok_…", card: { first_six, last_four, brand, … } }) or onError
 *
 * The card form is a stubyard iframe ({base}/card-sdk/frame) with the TEST notice. Digits stay in the frame: it posts
 * the card facts (brand, last 4, first 6, expiry, magic id, the no-3-D-Secure flag of Tap's test cards) to
 * {base}/card-sdk/tokens, which creates the same single-use tok_ as POST /v2/tokens. The merchant server charges it
 * (POST /v2/charges source.id tok_…): 3-D Secure opens the simulated ACS page through transaction.url.
 * Also resetCardInputs, saveCard, updateCardConfiguration, updateTheme and loadSavedCard (logs: saved cards are not simulated).
 */

export const TAP_CARD_SDK_VERSION = '1.0.2-stubyard';

/** The merchant-page script (window.CardSDK). */
export function tapCardJs(cfg: { base: string; version: string }): string {
  return `/* stubyard fake Tap Card SDK v2 ${cfg.version} (not the real Tap library). */
(function () {
  if (window.CardSDK && window.CardSDK.stubyard) return;
  ${SDK_RUNTIME}
  var BASE = SY.base(/\\/card-sdk\\/(?:[\\w.-]+\\/)*index(?:\\.min)?\\.js$/, ${js(cfg.base)});
  var ORIGIN = SY.originOf(BASE);
  var Theme = { LIGHT: 'light', DARK: 'dark', DYNAMIC: 'dynamic' };
  var Currencies = { SAR: 'SAR', KWD: 'KWD', AED: 'AED', QAR: 'QAR', BHD: 'BHD', OMR: 'OMR', EGP: 'EGP', JOD: 'JOD', USD: 'USD', EUR: 'EUR', GBP: 'GBP' };
  var Direction = { LTR: 'ltr', RTL: 'rtl', DYNAMIC: 'dynamic' };
  var Edges = { STRAIGHT: 'straight', CURVED: 'curved' };
  var Locale = { EN: 'en', AR: 'ar', DYNAMIC: 'dynamic' };
  var cur = null;
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))); return a.join('&'); }
  function warn(m) { if (window.console) console.error('[stubyard] Tap CardSDK: ' + m); }
  function call(cfg, k, v) { if (cfg && typeof cfg[k] === 'function') { try { cfg[k](v); } catch (x) { warn(x); } } }
  function renderTapCard(id, config) {
    config = config || {};
    var host = typeof id === 'string' ? (document.getElementById(id) || SY.el(id)) : id;
    if (!host) throw new Error('Tap CardSDK: element not found: ' + id);
    if (!config.publicKey || !/^pk_/.test(String(config.publicKey))) { var e0 = { code: 'invalid_public_key', message: 'publicKey is required (pk_test_…)' }; call(config, 'onError', e0); throw new Error('Tap CardSDK: ' + e0.message); }
    if (cur) cur.unmount();
    var tx = config.transaction || {}, ui = config['interface'] || {}, acc = config.acceptance || {}, add = config.addons || {}, fields = config.fields || {};
    var loc = ui.locale === 'dynamic' ? SY.lang() : SY.lang(ui.locale || 'en');
    var ch = SY.uid();
    while (host.firstChild) host.removeChild(host.firstChild);
    var src = BASE + '/card-sdk/frame?' + qs({ ch: ch, origin: location.origin, lang: loc, key: config.publicKey, amount: tx.amount, currency: tx.currency, brands: (acc.supportedBrands || []).join(','), cards: acc.supportedCards || 'ALL', holder: fields.cardHolder === false ? '0' : '1', save: add.saveCard ? '1' : '0', logos: add.displayPaymentBrands === false ? '0' : '1', theme: ui.theme || 'light', edges: ui.edges || 'curved', dir: ui.direction || 'dynamic', merchant: (config.merchant && config.merchant.id) || '' });
    var f = SY.frame(src, loc === 'ar' ? 'بطاقة Tap (محاكاة)' : 'Tap card form (simulated)', 230);
    f.setAttribute('data-testid', 'stubyard-tap-card-frame');
    host.appendChild(f);
    var br = SY.bridge({ origin: ORIGIN, ch: ch, source: 'stubyard-tap-card', win: function () { return f.contentWindow; } });
    var me = { config: config, br: br, frame: f, host: host, id: id };
    br.on(function (d) {
      if (d.type === 'ready') call(config, 'onReady');
      else if (d.type === 'resize') f.style.height = Math.min(Math.max(Number(d.height) || 0, 120), 1200) + 'px';
      else if (d.type === 'focus') call(config, 'onFocus');
      else if (d.type === 'bin') call(config, 'onBinIdentification', d.data);
      else if (d.type === 'valid') call(config, 'onValidInput', d.data);
      else if (d.type === 'invalid') call(config, 'onInvalidInput', d.data);
      else if (d.type === 'save-later') call(config, 'onChangeSaveCardLater', !!d.value);
      else if (d.type === 'success') call(config, 'onSuccess', d.data);
      else if (d.type === 'error') call(config, 'onError', d.error);
    });
    me.unmount = function () { br.close(); if (f.parentNode) f.parentNode.removeChild(f); if (cur === me) cur = null; };
    cur = me;
    return { unmount: me.unmount };
  }
  function need(fn) { if (!cur) { warn(fn + '() before renderTapCard()'); return null; } return cur; }
  function tokenize() { var c = need('tokenize'); if (c) c.br.send({ type: 'tokenize' }); }
  function saveCard() { var c = need('saveCard'); if (c) c.br.send({ type: 'tokenize', save: true }); }
  function resetCardInputs() { var c = need('resetCardInputs'); if (c) c.br.send({ type: 'reset' }); }
  function updateTheme(theme) { var c = need('updateTheme'); if (c) c.br.send({ type: 'theme', theme: String(theme || 'light') }); }
  function updateCardConfiguration(config) { var c = need('updateCardConfiguration'); if (!c) return; var next = {}; for (var k in c.config) next[k] = c.config[k]; for (var j in (config || {})) next[j] = config[j]; renderTapCard(c.host, next); }
  function loadSavedCard(cardId) { warn('loadSavedCard(' + cardId + '): saved cards are not simulated by stubyard'); var c = need('loadSavedCard'); if (c) call(c.config, 'onError', { code: 'not_simulated', message: 'Saved cards are not simulated by stubyard' }); }
  window.CardSDK = { renderTapCard: renderTapCard, tokenize: tokenize, saveCard: saveCard, resetCardInputs: resetCardInputs, updateTheme: updateTheme, updateCardConfiguration: updateCardConfiguration, loadSavedCard: loadSavedCard, Theme: Theme, Currencies: Currencies, Direction: Direction, Edges: Edges, Locale: Locale, version: ${js(cfg.version)}, stubyard: true };
})();
`;
}

/** Tap's brand names (acceptance.supportedBrands) → the kit brand. */
const BRANDS: Record<string, string> = { VISA: 'visa', MASTERCARD: 'mastercard', AMERICAN_EXPRESS: 'amex', MADA: 'mada', OMANNET: 'visa' };

/** The card form frame. */
export function renderTapCardFrame(o: { locale: Locale; origin: string; ch: string; key: string; brands: string[]; holder: boolean; save: boolean; logos: boolean; theme: string; edges: string; dir: string; testCards: GatewayTestCard[]; noThreeDs: string[] }): string {
  const L = o.locale;
  const ar = L === 'ar';
  const kit = [...new Set(o.brands.map((b) => BRANDS[b]).filter((x): x is string => !!x))];
  const logos = o.logos ? `<p class="k-hint" data-testid="stubyard-tap-brands" dir="ltr">${esc((o.brands.length ? o.brands : ['VISA', 'MASTERCARD', 'MADA', 'AMERICAN_EXPRESS']).join(' · '))}</p>` : '';
  const holder = o.holder ? `<label class="k-field"><span class="k-lbl">${esc(t(L, 'cardholder'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(L, 'fullName'))}" data-testid="stubyard-cardholder"></label>` : '';
  const save = o.save ? `<label class="k-check"><input type="checkbox" id="tc-save" data-testid="stubyard-tap-save"> <span>${esc(ar ? 'احفظ البطاقة لاستخدامها لاحقاً' : 'Save card for later')}</span></label>` : '';
  const body = `<main class="k-wrap" style="padding:0"><form class="k-card" id="tc" novalidate data-testid="stubyard-tap-card" data-layout="tap-card-sdk" data-theme="${esc(o.theme)}">
<div class="k-sec">${logos}<div class="k-alert hide" role="alert" id="tc-err" data-testid="stubyard-form-error"></div>
${cardFields(L, { methods: ['card'] })}${holder}${save}
</div><div class="k-sec k-foot"><span>${esc(t(L, 'noRealProvider', { provider: 'Tap' }))}</span></div></form></main>`;
  const msg = { failed: t(L, 'paymentFailed'), brand: ar ? 'نوع البطاقة غير مقبول.' : 'This card brand is not accepted.', name: t(L, 'formNameErr') };
  const script = `(function(){${frameBridge({ origin: o.origin, ch: o.ch, source: 'stubyard-tap-card' })}
${cardJs(L, o.testCards)}
var C=${js({ key: o.key, brands: kit, no3ds: o.noThreeDs, msg, theme: o.theme, edges: o.edges, dir: o.dir })};
var f=document.getElementById('tc'),err=document.getElementById('tc-err'),pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),cname=document.getElementById('cname'),save=document.getElementById('tc-save');
SYC.wire(pan,exp,cvc,document.getElementById('card-brand'));
var busy=false,valid=null,lastBin='';
function theme(th){var dark=th==='dark'||(th==='dynamic'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);f.style.background=dark?'#1d1f24':'';f.style.color=dark?'#f2f4f7':'';f.setAttribute('data-theme',th)}
theme(C.theme);if(C.edges==='straight')f.querySelectorAll('.k-input,.k-group').forEach(function(el){el.style.borderRadius='0'});if(C.dir==='ltr'||C.dir==='rtl')document.documentElement.dir=C.dir;
function show(m,el){err.textContent=m;err.classList.remove('hide');if(el){el.classList.add('k-bad');try{el.focus()}catch(e){}}}
function hide(){err.classList.add('hide');err.textContent='';[pan,exp,cvc,cname].forEach(function(x){if(x)x.classList.remove('k-bad')})}
function brandOk(b){return !C.brands.length||b==='unknown'||C.brands.indexOf(b)>=0}
function state(){var d=SYC.digits(pan.value);var bad=SYC.check(pan,exp,cvc);var fa=d?SYC.facts(d):null;if(bad&&bad[0]===SYC.MSG.expPast&&fa&&fa.test)bad=null;if(!bad&&fa&&!brandOk(fa.brand))bad=[C.msg.brand,pan];return{bad:bad,fa:fa,d:d}}
function changed(){var s=state();var v=!s.bad;if(v!==valid){valid=v;SYB.post({type:v?'valid':'invalid',data:{valid:v,card_brand:s.fa?s.fa.brand.toUpperCase():null}})}
 var bin=s.d.length>=6?s.d.slice(0,6):'';if(bin&&bin!==lastBin&&s.fa){lastBin=bin;SYB.post({type:'bin',data:{bin:bin,card_brand:s.fa.brand==='amex'?'AMERICAN_EXPRESS':s.fa.brand.toUpperCase(),card_scheme:s.fa.brand==='mada'?'MADA':s.fa.brand.toUpperCase(),bank:null,country:null,card_type:s.fa.brand==='mada'?'DEBIT':'CREDIT'}})}if(!bin)lastBin=''}
[pan,exp,cvc].forEach(function(x){x.addEventListener('input',changed);x.addEventListener('focus',function(){SYB.post({type:'focus'})})});
if(save)save.addEventListener('change',function(){SYB.post({type:'save-later',value:save.checked})});
function fail(code,m){SYB.post({type:'error',error:{code:code,message:m}})}
function tokenize(saveIt){if(busy)return;hide();var s=state();if(s.bad){show(s.bad[0],s.bad[1]);SYB.post({type:'invalid',data:{valid:false,error:s.bad[0]}});fail('invalid_card',s.bad[0]);return}
 if(cname&&!(cname.value||'').trim()){show(C.msg.name,cname);fail('invalid_card_holder',C.msg.name);return}
 var fa=s.fa,ex=SYC.exp(exp.value);
 if(fa.luhn&&!fa.test){pan.value='';valid=null;changed();show(SYC.MSG.realCard,pan);try{fetch('card-warning',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(fa.brand)})}catch(x){}fail('invalid_card',SYC.MSG.realCard);return}
 busy=true;var b={key:C.key,card:fa,first_six:s.d.slice(0,6),exp_month:ex.month,exp_year:ex.year,name:cname?(cname.value||'').trim():null,no3ds:C.no3ds.indexOf(s.d)>=0,save_card:!!(saveIt||(save&&save.checked))};
 fetch('tokens',{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){busy=false;if(r.ok&&j.id){cvc.value='';SYB.post({type:'success',data:j})}else{show(C.msg.failed);fail((j.errors&&j.errors[0]&&j.errors[0].code)||'tokenization_failed',(j.errors&&j.errors[0]&&j.errors[0].description)||C.msg.failed)}})},function(){busy=false;show(C.msg.failed);fail('network_error',C.msg.failed)})}
f.addEventListener('submit',function(e){e.preventDefault();tokenize(false)});
SYB.on(function(d){
 if(d.type==='tokenize')tokenize(!!d.save);
 else if(d.type==='reset'){pan.value='';exp.value='';cvc.value='';if(cname)cname.value='';hide();valid=null;lastBin='';changed()}
 else if(d.type==='theme')theme(String(d.theme||'light'));
});
SYB.post({type:'ready'});
})();`;
  return kitDocument({ title: t(L, 'sdkFrameTitle', { provider: 'Tap' }), locale: L, body, scripts: [script], frame: true, banner: { variant: 'strip' } });
}

/** Demo shop: renderTapCard, tokenize, then the shop's server charges the token (POST {base}/demo/charge). */
export function tapCardDemo(c: GatewayCtx, sub: string, status: (id: string) => string | null): unknown {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') {
    const id = typeof c.query.tap_id === 'string' ? c.query.tap_id : '';
    return demoResultPage(c, 'Tap demo shop: result', 'Tap', `<p>Your server confirms with <code>GET /v2/charges/${esc(id || '{tap_id}')}</code> (secret key): status <b data-testid="stubyard-demo-status">${esc((id && status(id)) || 'unknown')}</b>. Never trust the query alone.</p>`);
  }
  const L = demoLang(c);
  const cfg = { publicKey: String(c.inst.config.publishableKey ?? ''), merchant: { id: 'demo-merchant' }, transaction: { amount: 12, currency: 'SAR' }, customer: { name: [{ lang: L, first: 'Demo', last: 'Buyer' }], nameOnCard: 'Demo Buyer', editable: true, contact: { email: 'demo@example.com' } }, acceptance: { supportedBrands: ['AMERICAN_EXPRESS', 'VISA', 'MASTERCARD', 'MADA'], supportedCards: 'ALL' }, fields: { cardHolder: true }, addons: { displayPaymentBrands: true, loader: true, saveCard: true }, interface: { locale: L, theme: 'light', edges: 'curved', direction: 'dynamic' } };
  const after = `${DEMO_LOG}
var CFG=${js(cfg)},CHARGE=${js(base + '/demo/charge')};
var sdk=window.CardSDK;
sdk.renderTapCard('card-sdk-id',Object.assign(CFG,{
 onReady:function(){demoLog('onReady')},
 onFocus:function(){demoLog('onFocus')},
 onBinIdentification:function(d){demoLog('onBinIdentification',d)},
 onValidInput:function(d){demoLog('onValidInput',d)},
 onInvalidInput:function(d){demoLog('onInvalidInput',d)},
 onChangeSaveCardLater:function(v){demoLog('onChangeSaveCardLater',v)},
 onError:function(e){demoLog('onError',e)},
 onSuccess:function(tok){demoLog('onSuccess',{id:tok.id,card:tok.card&&{brand:tok.card.brand,last_four:tok.card.last_four}});
  fetch(CHARGE,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:tok.id,lang:CFG['interface'].locale})}).then(function(r){return r.json()}).then(function(ch){demoLog('charge (shop server)',{id:ch.id,status:ch.status});if(ch.transaction&&ch.transaction.url&&ch.status==='INITIATED')location.href=ch.transaction.url;else if(ch.redirect&&ch.redirect.url)setTimeout(function(){location.href=ch.redirect.url+(ch.redirect.url.indexOf('?')<0?'?':'&')+'tap_id='+encodeURIComponent(ch.id)},600)})}
}));
document.getElementById('tap-pay').addEventListener('click',function(){demoLog('tokenize()');sdk.tokenize()});
document.getElementById('tap-reset').addEventListener('click',function(){sdk.resetCardInputs()});
document.getElementById('tap-dark').addEventListener('click',function(){sdk.updateTheme(sdk.Theme.DARK)});`;
  return sendDemo(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر Tap التجريبي' : 'Tap demo shop',
    presetName: 'Tap',
    lang: L,
    html: `<p>Tap Card SDK v2 (<code>CardSDK.renderTapCard</code>) for 12.00 SAR. Cards: 4508 7500 1574 1019 (3-D Secure), 4012 0000 3333 0026 (no 3-D Secure), expiry 01/39; 05/22 declines.</p>${demoLangLinks(base, L)}<div id="card-sdk-id"></div><p class="row"><button type="button" class="btn primary" id="tap-pay" data-testid="stubyard-demo-pay">Pay 12.00 SAR</button><button type="button" class="btn" id="tap-reset">Reset</button><button type="button" class="btn" id="tap-dark">Dark theme</button></p>${DEMO_LOG_BOX}`,
    scripts: [{ src: base + '/card-sdk/index.js' }],
    after,
  }));
}

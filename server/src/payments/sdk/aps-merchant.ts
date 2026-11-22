import { esc } from '../../auth/pages.js';
import type { GatewayCtx } from '../gateway.js';
import { cardFields } from '../kit/fields.js';
import { t, type Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { renderMerchantDemo } from '../pages.js';
import { cardJs } from './card.js';
import { DEMO_LOG, DEMO_LOG_BOX, demoLang, demoLangLinks, demoResultPage, sendDemo } from './demos.js';
import { js, requestBase } from './runtime.js';

/**
 * Amazon Payment Services Merchant Page (iframe, classic; research R2, paymentservices-reference.payfort.com
 * "Merchant Page"). The shop's page posts a signed form into an iframe:
 *
 *   <iframe name="aps-mp"></iframe>
 *   <form action="{base}/FortAPI/paymentPage" method="post" target="aps-mp">
 *     service_command=TOKENIZATION, access_code, merchant_identifier, merchant_reference, language, return_url,
 *     [token_name], signature </form>
 *
 * The iframe shows the stubyard card form (TEST label inside). On submit the card facts (never the digits) go to
 * stubyard, which answers the signed TOKENIZATION response; the frame posts it to return_url (inside the iframe, as
 * APS does): response_code 18000, status 18, token_name, card_number (masked), expiry_date, card_bin,
 * card_holder_name, signature. The shop's server then sends command PURCHASE (or AUTHORIZATION) with token_name to
 * /FortAPI/paymentApi: 3ds_url (status 20, response_code 20064) to open in the top window, or the result at once
 * with check_3ds NO. Merchant Page 2.0 (the shop's own inputs) is not simulated.
 */

/** The card form inside the shop's iframe (the answer of POST /FortAPI/paymentPage with service_command TOKENIZATION). */
export function renderApsMerchantPage(o: { locale: Locale; session: string; merchant: string; holder: string | null }): string {
  const L = o.locale;
  const ar = L === 'ar';
  const body = `<main class="k-wrap" style="padding:0"><form class="k-card" id="mp" novalidate data-testid="stubyard-aps-merchant-page" data-layout="aps-merchant-page">
<div class="k-sec"><p class="k-hint" dir="ltr" data-testid="stubyard-aps-brands">VISA · MASTERCARD · MADA · AMEX</p><div class="k-alert hide" role="alert" id="mp-err" data-testid="stubyard-form-error"></div>
${cardFields(L, { methods: ['card'] })}<label class="k-field"><span class="k-lbl">${esc(t(L, 'cardholder'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(L, 'fullName'))}" value="${esc(o.holder ?? '')}" data-testid="stubyard-cardholder"></label>
<button class="k-btn k-paybtn" type="submit" id="mp-pay" data-testid="stubyard-pay">${esc(ar ? 'متابعة' : 'Continue')}</button>
</div><div class="k-sec k-foot"><span>${esc(o.merchant)}</span><span>${esc(t(L, 'noRealProvider', { provider: 'Amazon Payment Services' }))}</span></div></form></main>`;
  const msg = { failed: t(L, 'paymentFailed'), name: t(L, 'formNameErr') };
  const script = `(function(){
${cardJs(L)}
var C=${js({ session: o.session, msg })};
var f=document.getElementById('mp'),err=document.getElementById('mp-err'),pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),cname=document.getElementById('cname'),btn=document.getElementById('mp-pay');
SYC.wire(pan,exp,cvc,document.getElementById('card-brand'));
var busy=false;
function show(m,el){err.textContent=m;err.classList.remove('hide');if(el){el.classList.add('k-bad');try{el.focus()}catch(e){}}}
function hide(){err.classList.add('hide');err.textContent='';[pan,exp,cvc,cname].forEach(function(x){x.classList.remove('k-bad')})}
f.addEventListener('submit',function(e){e.preventDefault();if(busy)return;hide();
 var d=SYC.digits(pan.value),fa=d?SYC.facts(d):null,bad=SYC.check(pan,exp,cvc);if(bad&&bad[0]===SYC.MSG.expPast&&fa&&fa.test)bad=null;
 if(bad){show(bad[0],bad[1]);return}
 if(!(cname.value||'').trim()){show(C.msg.name,cname);return}
 if(fa.luhn&&!fa.test){pan.value='';cvc.value='';show(SYC.MSG.realCard,pan);try{fetch('merchantPage/card-warning',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(fa.brand)})}catch(x){}return}
 var ex=SYC.exp(exp.value);busy=true;btn.disabled=true;btn.classList.add('k-busy');
 fetch('merchantPage/token',{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',body:JSON.stringify({session:C.session,card:fa,first_six:d.slice(0,6),exp_month:ex.month,exp_year:ex.year,name:(cname.value||'').trim()})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
  if(!r.ok||!j.url||!j.fields){busy=false;btn.disabled=false;btn.classList.remove('k-busy');show(j.message||C.msg.failed);return}
  pan.value='';cvc.value='';
  var g=document.createElement('form');g.method='post';g.action=j.url;g.setAttribute('data-testid','stubyard-aps-return');
  Object.keys(j.fields).forEach(function(k){var i=document.createElement('input');i.type='hidden';i.name=k;i.value=j.fields[k];g.appendChild(i)});
  document.body.appendChild(g);HTMLFormElement.prototype.submit.call(g)})},function(){busy=false;btn.disabled=false;btn.classList.remove('k-busy');show(C.msg.failed)})});
})();`;
  return kitDocument({ title: t(L, 'sdkFrameTitle', { provider: 'Amazon Payment Services' }), locale: L, body, scripts: [script], frame: true, banner: { variant: 'strip' } });
}

/**
 * Demo shop: the shop's page posts the signed TOKENIZATION form into the iframe; its return_url ({base}/demo/return)
 * charges the token on the shop's server and opens 3ds_url in the top window.
 */
export function apsMerchantDemo(c: GatewayCtx, sub: string, o: { form: (base: string, lang: Locale) => Record<string, string>; status: (fort: string) => string | null }): unknown {
  c.resolved.endpoint = 'demo' + sub;
  const base = requestBase(c);
  if (sub === '/result') {
    const fort = typeof c.query.fort_id === 'string' ? c.query.fort_id : '';
    return demoResultPage(c, 'APS demo shop: result', 'Amazon Payment Services', `<p>Your server confirms with <code>POST /FortAPI/paymentApi {query_command: "CHECK_STATUS", fort_id: "${esc(fort || '{fort_id}')}"}</code>: <b data-testid="stubyard-demo-status">${esc((fort && o.status(fort)) || 'unknown')}</b>. Never trust the browser alone.</p>`);
  }
  const L = demoLang(c);
  const fields = o.form(base, L);
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return sendDemo(c, renderMerchantDemo({
    title: L === 'ar' ? 'متجر Amazon Payment Services التجريبي' : 'Amazon Payment Services demo shop',
    presetName: 'Amazon Payment Services',
    lang: L,
    html: `<p>Merchant Page (iframe) for 100.00 SAR: the shop's server signed the <code>service_command=TOKENIZATION</code> form below, the page posts it into the iframe; the card form answers <code>token_name</code> at the return URL, where the shop's server sends <code>PURCHASE</code> with it and opens <code>3ds_url</code>. Cards: 4242 4242 4242 4242 (approved after 3-D Secure), 4000 0000 0000 0002 (declined).</p>${demoLangLinks(base, L)}
<form id="mp-form" action="${esc(base)}/FortAPI/paymentPage" method="post" target="aps-mp" data-testid="stubyard-demo-form">${inputs}</form>
<iframe name="aps-mp" title="Amazon Payment Services" style="width:100%;max-width:480px;height:430px;border:1px solid #d0d5dd;border-radius:8px" data-testid="stubyard-aps-merchant-frame"></iframe>${DEMO_LOG_BOX}`,
    scripts: [],
    after: `${DEMO_LOG}
demoLog('TOKENIZATION form',${js(Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'signature')))});
HTMLFormElement.prototype.submit.call(document.getElementById('mp-form'));`,
  }));
}

/** The return_url page of the demo (inside the iframe): open 3ds_url, or the result, in the top window. */
export function apsMerchantDemoNext(c: GatewayCtx, url: string): unknown {
  c.resolved.endpoint = 'demo return';
  const L = demoLang(c);
  return sendDemo(c, renderMerchantDemo({
    title: 'Amazon Payment Services demo shop',
    presetName: 'Amazon Payment Services',
    lang: L,
    html: `<p>Token received; the shop's server sent PURCHASE. <a href="${esc(url)}" target="_top" data-testid="stubyard-demo-next">Continue</a></p>`,
    scripts: [],
    after: `window.top.location.href=${js(url)};`,
  }));
}

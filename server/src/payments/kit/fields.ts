import { esc } from '../../auth/pages.js';
import { MADA_BINS, MAGIC_CARDS, OTHER_TEST_CARDS } from '../engine.js';
import type { GatewayTestCard } from '../gateway.js';
import type { PaymentMethod } from '../repo.js';
import { methodLabel, t, type Locale } from './i18n.js';

/**
 * Checkout kit field primitives (server-rendered HTML) and the form script. The card number, expiry and CVC
 * inputs have no name: the script derives brand / last 4 / magic id / Luhn / test-card facts into hidden fields,
 * so the digits never reach stubyard (the classic page's rule). A Luhn-valid number that is not a test card is
 * cleared and reported (pay.real-card-entered).
 */

/** Methods with an OTP step (code by SMS to the stubyard inbox). */
export const OTP_METHODS: readonly string[] = ['stcpay', 'bnpl', 'wallet'];

export function hiddenFields(fields: Record<string, string | null | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
}

export interface KitUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  run: boolean;
}

/** Test user picker (name=user, testid stubyard-user), grouped like the classic page. */
export function userSelect(locale: Locale, users: KitUser[], userId: string | null): string {
  if (!users.length) return '';
  const opt = (u: KitUser) => `<option value="${esc(u.id)}"${u.id === userId ? ' selected' : ''}${u.phone ? ' data-phone="1"' : ''}>${esc(u.name)}${u.email ? ` · ${esc(u.email)}` : u.phone ? ` · ${esc(u.phone)}` : ''}</option>`;
  const run = users.filter((u) => u.run);
  const others = users.filter((u) => !u.run);
  return `<label class="k-field"><span class="k-lbl">${esc(t(locale, 'testUser'))}</span><select class="k-select" name="user" data-testid="stubyard-user"><option value="">${esc(t(locale, 'none'))}</option>${run.length ? `<optgroup label="${esc(t(locale, 'thisRun'))}">${run.map(opt).join('')}</optgroup>` : ''}${others.length ? `<optgroup label="${esc(t(locale, 'projectUsers'))}">${others.map(opt).join('')}</optgroup>` : ''}</select></label>`;
}

/** Method tiles (radios name=method, testids stubyard-method-<m>); a single method is a hidden field. */
export function methodTiles(locale: Locale, methods: PaymentMethod[], selected: PaymentMethod | null, labels: Partial<Record<string, string>> = {}, o: { list?: boolean; label?: string } = {}): string {
  if (methods.length <= 1) return hiddenFields({ method: methods[0] ?? 'card' });
  const cur = selected && methods.includes(selected) ? selected : methods[0];
  return `<div class="k-field"><span class="k-lbl" id="pm-l">${esc(o.label ?? t(locale, 'paymentMethod'))}</span><div class="k-methods${o.list ? ' k-mlist' : ''}" role="radiogroup" aria-labelledby="pm-l">${methods
    .map((m) => `<label class="k-method"><input type="radio" name="method" value="${m}"${m === cur ? ' checked' : ''} data-testid="stubyard-method-${m}">${esc(labels[m] ?? methodLabel(locale, m))}</label>`)
    .join('')}</div></div>`;
}

/** Card number + expiry + CVC in one group, with the brand badge and the inline error. */
export function cardFields(locale: Locale, o: { methods: PaymentMethod[]; cardholder?: boolean; label?: string }): string {
  const cardMethods = o.methods.filter((m) => m === 'card' || m === 'mada');
  if (!cardMethods.length) return '';
  return `<div data-for="${cardMethods.join(' ')}"><div class="k-field"><span class="k-lbl" id="ci-l">${esc(o.label ?? t(locale, 'cardInfo'))}</span>
<div class="k-group" role="group" aria-labelledby="ci-l"><div class="k-pan"><input class="k-input" type="text" id="pan" inputmode="numeric" autocomplete="off" maxlength="23" placeholder="1234 1234 1234 1234" aria-label="${esc(t(locale, 'cardNumber'))}" data-testid="stubyard-card"><span class="k-brand hide" id="card-brand" aria-hidden="true"></span></div>
<div class="k-row"><input class="k-input" type="text" id="exp" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="${esc(t(locale, 'expiry'))}" aria-label="${esc(t(locale, 'expiryLabel'))}" data-testid="stubyard-card-expiry"><input class="k-input" type="text" id="cvc" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="${esc(t(locale, 'cvc'))}" aria-label="${esc(t(locale, 'cvc'))}" data-testid="stubyard-card-cvc"></div></div>
<div class="k-hint" id="card-info" aria-live="polite"></div><div class="k-err hide" id="card-err" role="alert" data-testid="stubyard-card-error"></div></div>
${o.cardholder ? `<label class="k-field"><span class="k-lbl">${esc(t(locale, 'cardholder'))}</span><input class="k-input" type="text" id="cname" autocomplete="off" placeholder="${esc(t(locale, 'fullName'))}" data-testid="stubyard-cardholder"></label>` : ''}
${hiddenFields({ card_brand: '', card_last4: '', card_magic: '', card_luhn: '', card_test: '' })}</div>`;
}

/** Mobile number of the OTP methods (name=phone, testid stubyard-phone). */
export function phoneField(locale: Locale, methods: PaymentMethod[], phone: string | null, labels: Partial<Record<string, string>> = {}): string {
  const otp = methods.filter((m) => OTP_METHODS.includes(m));
  if (!otp.length) return '';
  const label = otp.length === 1 && otp[0] === 'stcpay' ? `${labels.stcpay ?? 'STC Pay'} · ${t(locale, 'mobile')}` : t(locale, 'mobile');
  return `<div data-for="${otp.join(' ')}"><label class="k-field"><span class="k-lbl">${esc(label)}</span><input class="k-input k-num" type="tel" name="phone" dir="ltr" placeholder="${otp.includes('stcpay') ? '05XXXXXXXX' : '+9665XXXXXXXX'}"${phone ? ` value="${esc(phone)}"` : ''} data-testid="stubyard-phone"></label><div class="k-err hide" id="phone-err" role="alert" data-testid="stubyard-phone-error"></div><p class="k-hint">${esc(t(locale, 'otpHint'))}</p></div>`;
}

/** Short hints for methods without fields (voucher, KNET / BENEFIT, wallets). */
export function methodHints(locale: Locale, methods: PaymentMethod[]): string {
  const out: string[] = [];
  if (methods.includes('voucher')) out.push(`<div data-for="voucher"><p class="k-hint">${esc(t(locale, 'voucherHint'))}</p></div>`);
  const plain = methods.filter((m) => ['knet', 'benefit', 'paypal'].includes(m));
  if (plain.length) out.push(`<div data-for="${plain.join(' ')}"><p class="k-hint">${esc(t(locale, 'noDigitsHint'))}</p></div>`);
  if (methods.includes('applepay')) out.push(`<div data-for="applepay"><p class="k-hint">${esc(t(locale, 'walletHint'))}</p></div>`);
  return out.join('');
}

export interface FormScriptOpts {
  locale: Locale;
  warnAction: string;
  testCards?: GatewayTestCard[];
  /** Ask for a complete card (number, expiry, CVC) when Pay is pressed with a card method. */
  requireCard: boolean;
  /** auto: fast when navigator.webdriver is true (automation), else realistic. */
  timings: 'auto' | 'realistic' | 'fast';
  /** Processing delay of the Pay button in realistic timings (ms, kept at or below 1 s). */
  delayMs?: number;
}

/** JSON for an inline script: "<" never closes the script element. */
export const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\x3c');

/** The kit form script (form#pay): card facts, validation, real-card refusal, OTP phone check, Pay spinner. */
export function formScript(o: FormScriptOpts): string {
  const extra = o.testCards ?? [];
  const cfg = {
    warn: o.warnAction,
    otp: OTP_METHODS,
    magic: [...MAGIC_CARDS.map((c) => ({ n: c.number, id: c.id, b: c.brand })), ...extra.filter((c) => c.magicId).map((c) => ({ n: c.number, id: c.magicId, b: c.brand }))],
    other: [...OTHER_TEST_CARDS.map((c) => ({ n: c.number, b: c.brand })), ...extra.filter((c) => !c.magicId).map((c) => ({ n: c.number, b: c.brand }))],
    mada: MADA_BINS,
    require: o.requireCard,
    timings: o.timings,
    delay: Math.min(1000, Math.max(0, o.delayMs ?? 700)),
    msg: {
      numIncomplete: t(o.locale, 'errNumIncomplete'),
      numInvalid: t(o.locale, 'errNumInvalid'),
      expIncomplete: t(o.locale, 'errExpIncomplete'),
      expPast: t(o.locale, 'errExpPast'),
      cvcIncomplete: t(o.locale, 'errCvcIncomplete'),
      realCard: t(o.locale, 'errRealCard'),
      phone: t(o.locale, 'errPhone'),
      processing: t(o.locale, 'processing'),
      fast: t(o.locale, 'timingsFast'),
    },
  };
  return `(function(){var C=${scriptJson(cfg)};
var f=document.getElementById('pay');if(!f)return;
var fast=C.timings==='fast'||(C.timings==='auto'&&navigator.webdriver===true);
if(fast){document.documentElement.classList.add('k-fast');var tn=document.getElementById('k-timings');if(tn)tn.textContent=C.msg.fast}
function luhn(d){var s=0,alt=false;for(var i=d.length-1;i>=0;i--){var n=+d[i];if(alt){n*=2;if(n>9)n-=9}s+=n;alt=!alt}return d.length>=12&&s%10===0}
function brand(d){if(C.mada.some(function(b){return d.indexOf(b)===0}))return'mada';if(/^4/.test(d))return'visa';if(/^(5[1-5]|2[2-7])/.test(d))return'mastercard';if(/^3[47]/.test(d))return'amex';if(/^(6011|65)/.test(d))return'discover';if(/^35/.test(d))return'jcb';return'unknown'}
var pan=document.getElementById('pan'),exp=document.getElementById('exp'),cvc=document.getElementById('cvc'),err=document.getElementById('card-err'),info=document.getElementById('card-info'),bl=document.getElementById('card-brand');
function digits(el){return el?el.value.replace(/\\D/g,''):''}
function sel(){var m=f.querySelector('input[name=method]:checked')||f.querySelector('input[type=hidden][name=method]');return m?m.value:'card'}
function sync(){var m=sel();document.querySelectorAll('[data-for]').forEach(function(el){el.classList.toggle('hide',el.getAttribute('data-for').split(' ').indexOf(m)<0)})}
f.querySelectorAll('input[name=method]').forEach(function(r){r.addEventListener('change',sync)});sync();
function clearErr(){if(err){err.classList.add('hide');err.textContent=''}[pan,exp,cvc].forEach(function(x){if(x)x.classList.remove('k-bad')})}
function showErr(m,el){if(err){err.textContent=m;err.classList.remove('hide')}if(el){el.classList.add('k-bad');el.focus()}}
function fmt(d){var b=brand(d);if(b==='amex')return(d.slice(0,4)+' '+d.slice(4,10)+' '+d.slice(10,15)).trim();return d.slice(0,19).replace(/(\\d{4})(?=\\d)/g,'$1 ')}
document.querySelectorAll('[data-card]').forEach(function(b){b.addEventListener('click',function(){if(!pan)return;var r=f.querySelector('input[name=method][value=card]');if(r&&!r.checked){r.checked=true;sync()}pan.value=fmt(b.getAttribute('data-card'));pan.dispatchEvent(new Event('input'));var y=(new Date().getFullYear()+3)%100;if(exp&&!exp.value)exp.value='12 / '+(y<10?'0':'')+y;if(cvc&&!cvc.value)cvc.value=brand(b.getAttribute('data-card'))==='amex'?'1234':'123';var d=document.getElementById('k-drawer');if(d&&window.matchMedia('(max-width:600px)').matches)d.open=false;pan.focus()})});
if(pan)pan.addEventListener('input',function(){var d=digits(pan);var mc=C.magic.find(function(c){return c.n===d});var p=pan.selectionStart===pan.value.length;var nv=fmt(d);if(nv!==pan.value&&p)pan.value=nv;var b=d.length>=1?brand(d):'';if(bl){bl.textContent=b&&b!=='unknown'?b:'';bl.classList.toggle('hide',!b||b==='unknown')}if(info)info.textContent=mc?('test card: '+mc.id):'';clearErr()});
if(exp)exp.addEventListener('input',function(e){var d=digits(exp).slice(0,4);if(d.length===1&&+d>1)d='0'+d;var v=d.length>2?d.slice(0,2)+' / '+d.slice(2):d;if(e.inputType!=='deleteContentBackward'&&d.length===2)v=d+' / ';exp.value=v;clearErr()});
if(cvc)cvc.addEventListener('input',function(){cvc.value=digits(cvc).slice(0,4);clearErr()});
var payBtn=f.querySelector('[data-k-pay]');
f.querySelectorAll('input[name=k_outcome]').forEach(function(r){r.addEventListener('change',function(){if(payBtn&&r.checked)payBtn.value=r.value})});var ck=f.querySelector('input[name=k_outcome]:checked');if(payBtn&&ck&&ck.value!=='success')payBtn.value=ck.value;
function check(){var d=digits(pan);if(!d||d.length<12)return[C.msg.numIncomplete,pan];var mc=C.magic.some(function(c){return c.n===d})||C.other.some(function(c){return c.n===d});if(!luhn(d)&&!mc)return[C.msg.numInvalid,pan];
 var m=/^(\\d{2})\\s*\\/\\s*(\\d{2})$/.exec(exp?exp.value.trim():'');if(exp&&!m)return[C.msg.expIncomplete,exp];if(m){var mo=+m[1],yr=2000+(+m[2]),now=new Date();if(mo<1||mo>12)return[C.msg.expIncomplete,exp];if(yr<now.getFullYear()||(yr===now.getFullYear()&&mo<now.getMonth()+1))return[C.msg.expPast,exp]}
 var cl=brand(d)==='amex'?4:3;if(cvc&&digits(cvc).length<cl)return[C.msg.cvcIncomplete,cvc];return null}
var busy=false;
f.addEventListener('submit',function(e){
  if(busy){e.preventDefault();return}
  var s=e.submitter,isPay=!!(s&&s.hasAttribute('data-k-pay')),ov=s&&s.name==='outcome'?s.value:'';var m=sel();
  var ph=f.querySelector('input[name=phone]'),pe=document.getElementById('phone-err');
  if(ph&&pe&&C.otp.indexOf(m)>=0&&ov!=='cancel'){var us=f.querySelector('select[name=user]'),uo=us&&us.selectedOptions[0];
    if(!ph.value.trim()&&!(uo&&uo.getAttribute('data-phone'))){e.preventDefault();pe.textContent=C.msg.phone;pe.classList.remove('hide');ph.focus();return}pe.classList.add('hide')}
  var set=function(n,v){var el=f.querySelector('input[name='+n+']');if(el)el.value=v};
  if(pan&&(m==='card'||m==='mada')){
    var d=digits(pan);
    if(isPay&&C.require&&!f.hasAttribute('data-forced')){var bad=check();if(bad){e.preventDefault();showErr(bad[0],bad[1]);return}}
    if(!d){set('card_brand','');set('card_last4','');set('card_magic','');set('card_luhn','');set('card_test','')}
    else{var mc=C.magic.find(function(c){return c.n===d}),oc=C.other.find(function(c){return c.n===d});var b=mc?mc.b:oc?oc.b:brand(d),lv=luhn(d),test=!!(mc||oc);
      if(lv&&!test){e.preventDefault();pan.value='';showErr(C.msg.realCard,pan);try{fetch(C.warn,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(b)})}catch(x){}return}
      set('card_brand',b);set('card_last4',d.slice(-4));set('card_magic',mc?mc.id:'');set('card_luhn',lv?'1':'0');set('card_test',test?'1':'0')}
    pan.value='';if(exp)exp.value='';if(cvc)cvc.value=''}
  if(isPay&&!fast&&C.delay>0){e.preventDefault();busy=true;s.classList.add('k-busy');s.setAttribute('aria-busy','true');var l=s.querySelector('.k-label');if(l)l.textContent=C.msg.processing;var h=document.createElement('input');h.type='hidden';h.name=s.name;h.value=s.value;f.appendChild(h);setTimeout(function(){f.submit()},C.delay);return}
  busy=true;
});
window.addEventListener('pageshow',function(ev){if(ev.persisted){busy=false;if(payBtn){payBtn.classList.remove('k-busy');payBtn.removeAttribute('aria-busy')}}});
})();`;
}

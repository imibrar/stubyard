import { MADA_BINS, MAGIC_CARDS, OTHER_TEST_CARDS } from '../engine.js';
import type { GatewayTestCard } from '../gateway.js';
import { t, type Locale } from '../kit/i18n.js';
import { js } from './runtime.js';

/**
 * Card checks inside SDK frames (Moyasar Form): defines SYC with digits(), fmt(), brand(), check(pan, exp, cvc),
 * facts(digits) and wire(pan, exp, cvc, brandEl). facts() is all that ever leaves the frame: brand, last 4, the
 * magic id and the Luhn / test flags. A Luhn-valid number that is not a test card is "real": cleared, never sent.
 */
export function cardJs(L: Locale, extra: GatewayTestCard[] = []): string {
  const magic = MAGIC_CARDS.map((c) => ({ n: c.number, id: c.id, b: c.brand }));
  const known = [...OTHER_TEST_CARDS.map((c) => ({ n: c.number, b: c.brand, id: null as string | null })), ...extra.map((c) => ({ n: c.number, b: c.brand, id: c.magicId ?? null }))];
  const msg = { numIncomplete: t(L, 'errNumIncomplete'), numInvalid: t(L, 'errNumInvalid'), expIncomplete: t(L, 'errExpIncomplete'), expPast: t(L, 'errExpPast'), cvcIncomplete: t(L, 'errCvcIncomplete'), realCard: t(L, 'errRealCard') };
  return `var SYC=(function(){var MAGIC=${js(magic)},KNOWN=${js(known)},MADA=${js(MADA_BINS)},MSG=${js(msg)};
function digits(v){return String(v||'').replace(/\\D/g,'')}
function luhn(d){var s=0,alt=false;for(var i=d.length-1;i>=0;i--){var n=+d[i];if(alt){n*=2;if(n>9)n-=9}s+=n;alt=!alt}return d.length>=12&&s%10===0}
function brand(d){if(MADA.some(function(b){return d.indexOf(b)===0}))return'mada';if(/^4/.test(d))return'visa';if(/^(5[1-5]|2[2-7])/.test(d))return'mastercard';if(/^3[47]/.test(d))return'amex';return'unknown'}
function fmt(d){if(brand(d)==='amex')return(d.slice(0,4)+' '+d.slice(4,10)+' '+d.slice(10,15)).trim();return d.slice(0,19).replace(/(\\d{4})(?=\\d)/g,'$1 ')}
function find(d){var m=MAGIC.find(function(c){return c.n===d});if(m)return{b:m.b,id:m.id};var k=KNOWN.find(function(c){return c.n===d});return k?{b:k.b,id:k.id}:null}
function facts(d){var f=find(d);return{brand:f?f.b:brand(d),last4:d.slice(-4),magicId:f?f.id:null,luhn:luhn(d),test:!!f}}
function exp(v){var m=/^(\\d{2})\\s*\\/\\s*(\\d{2})$/.exec(String(v||'').trim());if(!m)return null;var mo=+m[1],yr=2000+(+m[2]);if(mo<1||mo>12)return null;return{month:mo,year:yr}}
function check(pan,ex,cvc){var d=digits(pan.value);if(!d||d.length<12)return[MSG.numIncomplete,pan];if(!luhn(d)&&!find(d))return[MSG.numInvalid,pan];var e=exp(ex.value);if(!e)return[MSG.expIncomplete,ex];var now=new Date();if(e.year<now.getFullYear()||(e.year===now.getFullYear()&&e.month<now.getMonth()+1))return[MSG.expPast,ex];if(digits(cvc.value).length<(brand(d)==='amex'?4:3))return[MSG.cvcIncomplete,cvc];return null}
function wire(pan,ex,cvc,b){if(pan)pan.addEventListener('input',function(){var d=digits(pan.value);var at=pan.selectionStart===pan.value.length;var nv=fmt(d);if(nv!==pan.value&&at)pan.value=nv;var br=d?brand(d):'';if(b){b.textContent=br&&br!=='unknown'?br:'';b.classList.toggle('hide',!br||br==='unknown')}});
if(ex)ex.addEventListener('input',function(e){var d=digits(ex.value).slice(0,4);if(d.length===1&&+d>1)d='0'+d;var v=d.length>2?d.slice(0,2)+' / '+d.slice(2):d;if(e.inputType!=='deleteContentBackward'&&d.length===2)v=d+' / ';ex.value=v});
if(cvc)cvc.addEventListener('input',function(){cvc.value=digits(cvc.value).slice(0,4)})}
return{digits:digits,luhn:luhn,brand:brand,fmt:fmt,facts:facts,exp:exp,check:check,wire:wire,MSG:MSG}})();`;
}

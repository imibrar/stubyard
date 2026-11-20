import { createHash } from 'node:crypto';
import { esc } from '../auth/pages.js';
import { MADA_BINS, MAGIC_CARDS, OTHER_TEST_CARDS, OUTCOMES } from './engine.js';
import type { GatewayTestCard } from './gateway.js';
import type { PaymentMethod } from './repo.js';

/**
 * Server-rendered hosted payment pages (Stripe Checkout / PayTabs HPP / PayPal approval stand-ins): outcome page,
 * STC Pay OTP, 3-D Secure challenge, done page and the auto-submitting return form. Same look as the login pages.
 * The card number field has no name: a small script derives brand / last 4 / test-card facts and clears it, so the
 * digits never reach stubyard.
 */

const CSS = `
:root{--bg:#f5f6f8;--panel:#fff;--panel-2:#f2f4f7;--panel-3:#e9ecf1;--border:#e2e5ea;--border-strong:#cfd4dc;--text:#15171c;--muted:#5d6471;--faint:#8f96a3;
--accent:#4f46e5;--accent-soft:#eef0ff;--accent-text:#3730a3;--ok:#15803d;--ok-soft:#e7f6ec;--warn:#b45309;--warn-soft:#fdf3e3;--bad:#b91c1c;--bad-soft:#fdeceb;
--radius:8px;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c10;--panel:#111318;--panel-2:#171a21;--panel-3:#1e222b;--border:#23272f;--border-strong:#323843;--text:#e7e9ee;--muted:#9ba2ae;--faint:#656c78;
--accent:#7c83ff;--accent-soft:rgba(124,131,255,.14);--accent-text:#b9bdff;--ok:#4ade80;--ok-soft:rgba(74,222,128,.12);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.12);--bad:#f87171;--bad-soft:rgba(248,113,113,.12);color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:32px 16px}
.wrap{width:100%;max-width:600px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.head{padding:18px 20px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.logo{width:38px;height:38px;border-radius:9px;background:var(--accent-soft);color:var(--accent-text);display:grid;place-items:center;font-weight:700;flex:none}
h1{font-size:17px;margin:0;line-height:1.3;flex:1;min-width:0}h1 small{display:block;font-size:12.5px;color:var(--muted);font-weight:400}
.amt{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.sec{padding:14px 20px;border-bottom:1px solid var(--border)}.sec:last-child{border-bottom:0}
.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px}.meta dt{color:var(--muted)}.meta dd{margin:0;font-family:var(--mono);word-break:break-all}
.label{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:0 0 8px}
.banner{border-radius:var(--radius);padding:10px 12px;font-size:13px;border:1px solid transparent}
.banner.warn{background:var(--warn-soft);color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.banner.bad{background:var(--bad-soft);color:var(--bad)}.banner.ok{background:var(--ok-soft);color:var(--ok)}.banner.info{background:var(--accent-soft);color:var(--accent-text)}
.banner b{display:block;margin-bottom:2px}
button{font:inherit;color:inherit;cursor:pointer}
.btn{background:var(--panel-2);border:1px solid var(--border-strong);border-radius:var(--radius);padding:9px 14px;min-height:44px;text-align:center}
.btn:hover,.btn:focus-visible{border-color:var(--accent);outline:none}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.btn.danger{color:var(--bad)}.btn.wide{width:100%}
a.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;color:inherit;text-decoration:none;font-weight:500;line-height:1.2;box-sizing:border-box}a.btn:hover{color:var(--accent-text)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.tabs{display:flex;flex-wrap:wrap;gap:6px}
.tab{display:flex;align-items:center;gap:6px;border:1px solid var(--border-strong);border-radius:999px;padding:6px 14px;min-height:40px;cursor:pointer;background:var(--panel-2)}
.tab input{margin:0}.tab:has(input:checked){border-color:var(--accent);background:var(--accent-soft);color:var(--accent-text)}
input[type=text],input[type=tel],select{font:inherit;color:inherit;background:var(--panel-2);border:1px solid var(--border-strong);border-radius:var(--radius);padding:9px 11px;min-height:44px;width:100%}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}.field span{font-size:12.5px;color:var(--muted)}
.hint{font-size:12px;color:var(--faint)}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-family:var(--mono);font-size:11.5px;background:var(--panel-3);border:1px solid var(--border);border-radius:999px;padding:3px 9px;cursor:pointer;min-height:30px}
.chip:hover{border-color:var(--accent)}
details summary{cursor:pointer;color:var(--muted);font-size:12.5px;padding:6px 0}
.outs .btn{font-family:var(--mono);font-size:12px}
.foot{padding:12px 20px;color:var(--faint);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 12px;justify-content:space-between}
.foot a{color:var(--accent-text)}
.otp{font-family:var(--mono);font-size:22px;letter-spacing:.3em;text-align:center}
.hide{display:none!important}
@media (max-width:480px){body{padding:12px 8px}.head,.sec{padding:12px 14px}.amt{font-size:19px}}
body.embed{padding:0;background:transparent;min-height:0}body.embed .wrap{max-width:none}body.embed .foot a{display:none}
.mono{font-family:var(--mono)}pre{font:12px/1.5 var(--mono);background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;overflow:auto;max-height:60vh;margin:0}
.demo-slot{min-height:44px}.demo-log{font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word}
`;

/**
 * Content-Security-Policy for a rendered page: only its own inline scripts (by SHA-256 hash) run, so a javascript:
 * URL in a link or form action never does; forms may post to the page itself or to an http(s) return URL.
 */
export function pageCsp(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`);
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self' http: https:",
    "base-uri 'none'",
  ].join('; ');
}

/** Embedded pages (HyperPay widget iframe) tell the parent their height so it can size the frame. */
const EMBED_SCRIPT = "(function(){function h(){try{parent.postMessage({source:'stubyard-hyperpay',height:document.documentElement.scrollHeight},'*')}catch(e){}}window.addEventListener('load',h);window.addEventListener('resize',h);new MutationObserver(h).observe(document.body,{subtree:true,childList:true,attributes:true});h()})();";

/** Inline icon (the dashboard's favicon.svg) so hosted pages never request /favicon.ico (img-src allows data:). */
export const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#4f46e5"/><path d="M9 11h14v10H9z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M9 11l7 6 7-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>';
export const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

/** Dialling codes by payment currency (the Gulf / regional gateways settle in the local currency). */
const DIAL_BY_CURRENCY: Record<string, string> = { SAR: '966', AED: '971', KWD: '965', BHD: '973', QAR: '974', OMR: '968', EGP: '20', JOD: '962', PKR: '92' };

/** The OTP phone as people read it. Stored numbers are "+" + digits, which turns a local "0555…" into "+0555…":
 *  a local number (leading 0, or a short national one) gets the currency's country code when known, else shows as entered. */
export function displayPhone(phone: string, currency?: string | null): string {
  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  const dial = currency ? DIAL_BY_CURRENCY[currency.toUpperCase()] : undefined;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('0')) return dial ? `+${dial} ${digits.slice(1)}` : digits;
  if (digits.length <= 9) return dial ? `+${dial} ${digits}` : digits;
  return '+' + digits;
}

export function page(title: string, body: string, script = '', opts: { embed?: boolean } = {}): string {
  const js = [script, opts.embed ? EMBED_SCRIPT : ''].filter(Boolean).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>${FAVICON}<style>${CSS}</style></head><body${opts.embed ? ' class="embed"' : ''}><main class="wrap">${body}</main>${js ? `<script>${js}</script>` : ''}</body></html>`;
}

export interface PageUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  run: boolean;
}

export interface PayPageInput {
  presetId: string;
  presetName: string;
  instance: string;
  paymentId: string;
  providerRef: string;
  amount: string;
  reference: string | null;
  description: string | null;
  email: string | null;
  methods: PaymentMethod[];
  method: PaymentMethod | null;
  users: PageUser[];
  userId: string | null;
  forced: { outcome: string; via: string } | null;
  action: string;
  warnAction: string;
  error: string | null;
  run: string | null;
  dashboardUrl: string;
  cancellable: boolean;
  /** Inside the HyperPay widget iframe: compact, forms submit to the top window. */
  embed?: boolean;
  /** Head logo of gateways without a built-in one (Gateway.logo). */
  logo?: string | null;
  /** Prefilled phone of the OTP methods (bnpl / wallet: the buyer phone of the create request). */
  phone?: string | null;
  /** The gateway's own test cards (accepted without the real-card warning). */
  testCards?: GatewayTestCard[];
}

const METHOD_LABEL: Record<string, string> = { card: 'Card', mada: 'mada', stcpay: 'STC Pay', applepay: 'Apple Pay', paypal: 'PayPal', knet: 'KNET', benefit: 'BENEFIT', bnpl: 'Pay later', wallet: 'Mobile wallet', voucher: 'Voucher / over the counter' };
/** Methods with an OTP step (code by SMS to the stubyard inbox). */
export const OTP_METHODS: readonly string[] = ['stcpay', 'bnpl', 'wallet'];
const LOGO: Record<string, string> = { 'stripe-checkout': 'S', paytabs: 'PT', paypal: 'PP', hyperpay: 'HP' };

function head(i: { presetId: string; presetName: string; amount: string; reference?: string | null; sub?: string; logo?: string | null }): string {
  return `<div class="head"><div class="logo" aria-hidden="true">${esc(LOGO[i.presetId] ?? i.logo ?? '$')}</div><h1>${esc(i.sub ?? 'Pay')}<small>Fake ${esc(i.presetName)} · stubyard${i.reference ? ` · ${esc(i.reference)}` : ''}</small></h1><div class="amt" data-testid="stubyard-amount">${esc(i.amount)}</div></div>`;
}

function hidden(fields: Record<string, string | null | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
}

const CARD_SCRIPT = (warnAction: string, extra: GatewayTestCard[] = []) => `
(function(){
var MAGIC=${JSON.stringify([...MAGIC_CARDS.map((c) => ({ n: c.number, id: c.id, b: c.brand })), ...extra.filter((c) => c.magicId).map((c) => ({ n: c.number, id: c.magicId, b: c.brand }))])};
var OTHER=${JSON.stringify([...OTHER_TEST_CARDS.map((c) => ({ n: c.number, b: c.brand })), ...extra.filter((c) => !c.magicId).map((c) => ({ n: c.number, b: c.brand }))])};
var MADA=${JSON.stringify(MADA_BINS)};
function luhn(d){var s=0,alt=false;for(var i=d.length-1;i>=0;i--){var n=+d[i];if(alt){n*=2;if(n>9)n-=9}s+=n;alt=!alt}return d.length>=12&&s%10===0}
function brand(d){if(MADA.some(function(b){return d.indexOf(b)===0}))return'mada';if(/^4/.test(d))return'visa';if(/^(5[1-5]|2[2-7])/.test(d))return'mastercard';if(/^3[47]/.test(d))return'amex';if(/^(6011|65)/.test(d))return'discover';if(/^35/.test(d))return'jcb';return'unknown'}
var f=document.getElementById('pay');if(!f)return;
var OTP=${JSON.stringify(OTP_METHODS)};
var pan=document.getElementById('pan'),err=document.getElementById('card-err'),info=document.getElementById('card-info');
function sel(){var m=f.querySelector('input[name=method]:checked')||f.querySelector('input[type=hidden][name=method]');return m?m.value:'card'}
function sync(){var m=sel();document.querySelectorAll('[data-for]').forEach(function(el){el.classList.toggle('hide',el.getAttribute('data-for').split(' ').indexOf(m)<0)})}
f.querySelectorAll('input[name=method]').forEach(function(r){r.addEventListener('change',sync)});sync();
document.querySelectorAll('[data-card]').forEach(function(b){b.addEventListener('click',function(){pan.value=b.getAttribute('data-card');pan.dispatchEvent(new Event('input'))})});
if(pan)pan.addEventListener('input',function(){var d=pan.value.replace(/\\D/g,'');var mc=MAGIC.find(function(c){return c.n===d});info.textContent=d.length>=4?(brand(d)+(mc?' · test card: '+mc.id:'')):'';err.classList.add('hide')});
f.addEventListener('submit',function(e){
  var m=sel();
  var ph=f.querySelector('input[name=phone]'),pe=document.getElementById('phone-err');
  if(ph&&pe&&OTP.indexOf(m)>=0){var us=f.querySelector('select[name=user]'),uo=us&&us.selectedOptions[0];
    if(!ph.value.trim()&&!(uo&&uo.getAttribute('data-phone'))){e.preventDefault();pe.textContent='Enter a mobile number (or pick a test user with a phone) to get the one-time code.';pe.classList.remove('hide');ph.focus();return}
    pe.classList.add('hide')}
  if(!pan||(m!=='card'&&m!=='mada'))return;
  var d=pan.value.replace(/\\D/g,'');
  var set=function(n,v){var el=f.querySelector('input[name='+n+']');el.value=v};
  if(!d){set('card_brand','');set('card_last4','');set('card_magic','');set('card_luhn','');set('card_test','');return}
  var mc=MAGIC.find(function(c){return c.n===d}),oc=OTHER.find(function(c){return c.n===d});
  var b=mc?mc.b:oc?oc.b:brand(d),lv=luhn(d),test=!!(mc||oc);
  if(lv&&!test){e.preventDefault();pan.value='';err.textContent='That looks like a real card number. It was cleared and not sent. Use a test card such as 4242 4242 4242 4242.';err.classList.remove('hide');
    try{fetch(${JSON.stringify(warnAction)},{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(b)})}catch(x){}return}
  set('card_brand',b);set('card_last4',d.slice(-4));set('card_magic',mc?mc.id:'');set('card_luhn',lv?'1':'0');set('card_test',test?'1':'0');pan.value='';
});
})();`;

export function renderPayPage(i: PayPageInput): string {
  const runUsers = i.users.filter((u) => u.run);
  const others = i.users.filter((u) => !u.run);
  const userOpt = (u: PageUser) => `<option value="${esc(u.id)}"${u.id === i.userId ? ' selected' : ''}${u.phone ? ' data-phone="1"' : ''}>${esc(u.name)}${u.email ? ` · ${esc(u.email)}` : u.phone ? ` · ${esc(u.phone)}` : ''}</option>`;
  const users = i.users.length
    ? `<label class="field"><span>Test user</span><select name="user" data-testid="stubyard-user"><option value="">(none)</option>${runUsers.length ? `<optgroup label="This run">${runUsers.map(userOpt).join('')}</optgroup>` : ''}${others.length ? `<optgroup label="Project users">${others.map(userOpt).join('')}</optgroup>` : ''}</select></label>`
    : '';
  const methodTabs = i.methods.length > 1
    ? `<div class="field"><span>Pay with</span><div class="tabs" role="radiogroup">${i.methods
        .map((m, k) => `<label class="tab"><input type="radio" name="method" value="${m}"${(i.method ?? i.methods[0]) === m || (!i.method && k === 0) ? ' checked' : ''} data-testid="stubyard-method-${m}">${esc(METHOD_LABEL[m] ?? m)}</label>`)
        .join('')}</div></div>`
    : hidden({ method: i.methods[0] ?? 'card' });
  const cardMethods = i.methods.filter((m) => m === 'card' || m === 'mada');
  const card = cardMethods.length
    ? `<div data-for="${cardMethods.join(' ')}"><label class="field"><span>Card number (test cards only, optional)</span><input type="text" id="pan" inputmode="numeric" autocomplete="off" placeholder="4242 4242 4242 4242" data-testid="stubyard-card"></label>
<div class="hint" id="card-info" aria-live="polite"></div><div class="banner bad hide" id="card-err" role="alert" data-testid="stubyard-card-error"></div>
<div class="chips" style="margin:6px 0 10px">${MAGIC_CARDS.map((c) => `<button type="button" class="chip" data-card="${c.number}" title="${esc(c.label)}">${esc(c.id)}</button>`).join('')}</div>
${hidden({ card_brand: '', card_last4: '', card_magic: '', card_luhn: '', card_test: '' })}</div>`
    : '';
  const otpMethods = i.methods.filter((m) => OTP_METHODS.includes(m));
  const stc = otpMethods.length
    ? `<div data-for="${otpMethods.join(' ')}"><label class="field"><span>${otpMethods.length === 1 && otpMethods[0] === 'stcpay' ? 'STC Pay mobile number' : 'Mobile number'}</span><input type="tel" name="phone" placeholder="${otpMethods.includes('stcpay') ? '05XXXXXXXX or +9665XXXXXXXX' : '+9665XXXXXXXX'}"${i.phone ? ` value="${esc(i.phone)}"` : ''} data-testid="stubyard-phone"></label><div class="banner bad hide" id="phone-err" role="alert" data-testid="stubyard-phone-error"></div><div class="hint">A one-time code goes to the stubyard SMS inbox (empty: the selected test user's phone).</div></div>`
    : '';
  const voucher = i.methods.includes('voucher') ? '<div data-for="voucher"><div class="hint">Voucher: the payment stays pending until it is paid at the counter (it settles after the settle delay, or POST …/payments/&lt;id&gt;/complete).</div></div>' : '';
  const forced = i.forced
    ? `<div class="sec"><div class="banner info" data-testid="stubyard-forced"><b>Outcome set by ${esc(i.forced.via)}: ${esc(i.forced.outcome)}</b>Any button below continues with that outcome.</div><div class="row" style="margin-top:10px"><button type="submit" class="btn primary wide" name="outcome" value="success" data-testid="stubyard-continue">Continue</button></div></div>`
    : '';
  const more = OUTCOMES.filter((o) => !['success', 'decline', 'cancel'].includes(o));
  const body = `<form method="post" action="${esc(i.action)}" class="card" id="pay"${i.embed ? ' target="_top"' : ''}>
${head({ presetId: i.presetId, presetName: i.presetName, amount: i.amount, reference: i.reference, logo: i.logo })}
${i.error ? `<div class="sec"><div class="banner bad" role="alert" data-testid="stubyard-error">${esc(i.error)}</div></div>` : ''}
${forced}
<div class="sec"><dl class="meta">${i.description ? `<dt>For</dt><dd>${esc(i.description)}</dd>` : ''}<dt>Reference</dt><dd>${esc(i.providerRef)}</dd>${i.email ? `<dt>Email</dt><dd>${esc(i.email)}</dd>` : ''}${i.run ? `<dt>Run</dt><dd>${esc(i.run)}</dd>` : ''}</dl></div>
<div class="sec">${users}${methodTabs}${card}${stc}${voucher}</div>
<div class="sec"><p class="label">Result</p><div class="grid">
<button type="submit" class="btn primary" name="outcome" value="success" data-testid="stubyard-pay">${i.presetId === 'paypal' ? 'Approve' : 'Pay'} ${esc(i.amount)}</button>
<button type="submit" class="btn danger" name="outcome" value="decline" data-testid="stubyard-decline">Decline</button>
${i.cancellable ? '<button type="submit" class="btn" name="outcome" value="cancel" data-testid="stubyard-cancel">Cancel and return</button>' : ''}
</div>
<details><summary>More outcomes</summary><div class="grid outs">${more.map((o) => `<button type="submit" class="btn" name="outcome" value="${o}" data-testid="stubyard-outcome-${o}">${o}</button>`).join('')}${['insufficient_funds', 'expired_card', 'incorrect_cvc', 'processing_error'].map((r) => `<button type="submit" class="btn" name="outcome" value="decline:${r}" data-testid="stubyard-outcome-decline-${r}">decline:${r}</button>`).join('')}</div></details></div>
<div class="foot"><span>Nothing here talks to the real ${esc(i.presetName)}. Card digits never leave this page.</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div>
</form>`;
  return page(`Pay ${i.amount} – Fake ${i.presetName}`, body, CARD_SCRIPT(i.warnAction, i.testCards), { embed: i.embed });
}

export function renderOtpPage(i: { presetId: string; presetName: string; amount: string; action: string; phone: string; carry: Record<string, string | null>; error?: string | null; dashboardUrl: string; method?: string; logo?: string | null; codeLength?: number; currency?: string | null }): string {
  const method = i.method ?? 'stcpay';
  const title = method === 'stcpay' ? 'STC Pay verification' : `${i.presetName} verification`;
  return page(
    title,
    `<form method="post" action="${esc(i.action)}" class="card">${head({ ...i, sub: title })}
${hidden({ ...i.carry, method, phone: i.phone })}
<div class="sec">${i.error ? `<div class="banner bad" role="alert" data-testid="stubyard-otp-error" style="margin-bottom:10px">${esc(i.error)}</div>` : ''}
<p>We sent a ${i.codeLength ?? 6}-digit code by SMS to <b data-testid="stubyard-otp-phone">${esc(displayPhone(i.phone, i.currency))}</b>. Find it in the stubyard SMS inbox.</p>
<label class="field"><span>Code</span><input type="text" name="otp" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="${i.codeLength ?? 6}" required autofocus data-testid="stubyard-otp"></label>
<button type="submit" class="btn primary wide" data-testid="stubyard-otp-submit">Verify and pay</button></div>
<div class="foot"><span>Three wrong codes decline the payment.</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div></form>`,
  );
}

export function renderChallengePage(i: { presetId: string; presetName: string; amount: string; action: string; carry: Record<string, string | null>; dashboardUrl: string; logo?: string | null }): string {
  return page(
    '3-D Secure',
    `<form method="post" action="${esc(i.action)}" class="card">${head({ ...i, sub: '3-D Secure challenge' })}
${hidden(i.carry)}
<div class="sec"><p>Your bank asks you to confirm this payment (simulated 3-D Secure).</p>
<div class="grid"><button type="submit" class="btn primary" name="outcome" value="3ds_success" data-testid="stubyard-3ds-pass">Complete authentication</button>
<button type="submit" class="btn danger" name="outcome" value="3ds_fail" data-testid="stubyard-3ds-fail">Fail authentication</button></div></div>
<div class="foot"><span>stubyard 3-D Secure simulator</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div></form>`,
  );
}

export function renderDonePage(i: { presetId: string; presetName: string; amount: string; status: string; tone: 'ok' | 'bad' | 'warn' | 'info'; title: string; message: string; returnUrl?: string | null; noReturn?: boolean; dashboardUrl: string; logo?: string | null }): string {
  return page(
    i.title,
    `<div class="card">${head({ ...i, sub: i.title })}
<div class="sec"><div class="banner ${i.tone}" data-testid="stubyard-done" data-status="${esc(i.status)}"><b>${esc(i.title)}</b>${esc(i.message)}</div></div>
${i.returnUrl ? `<div class="sec"><a class="btn primary wide" style="display:block;text-decoration:none" href="${esc(i.returnUrl)}" data-testid="stubyard-return">Return to the shop</a></div>` : i.noReturn ? '<div class="sec hint" data-testid="stubyard-no-return">No return URL: the request had none, or it is not an absolute http(s) URL.</div>' : ''}
<div class="foot"><span>Status: ${esc(i.status)}</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div></div>`,
  );
}

/** PayTabs-style return: an auto-submitting form POST (works without JS through the button). */
export function renderFormPost(action: string, fields: Record<string, string>): string {
  return page(
    'Returning…',
    `<form method="post" action="${esc(action)}" class="card" id="f">${hidden(fields)}<div class="head"><h1>Returning to the shop…<small>stubyard payment simulator</small></h1></div><div class="sec"><button type="submit" class="btn primary" data-testid="stubyard-return">Continue</button></div></form>`,
    "document.getElementById('f').submit()",
  );
}

export function renderPayError(title: string, message: string, dashboardUrl?: string): string {
  return page(
    title,
    `<div class="card"><div class="head"><div class="logo" aria-hidden="true">!</div><h1>${esc(title)}<small>stubyard payment simulator</small></h1></div><div class="sec"><div class="banner bad" data-testid="stubyard-error">${esc(message)}</div></div>${dashboardUrl ? `<div class="foot"><a href="${esc(dashboardUrl)}">Open stubyard</a></div>` : ''}</div>`,
  );
}

// ---------------- Payments 1b: merchant demo, SDK close page, card fields, vault approval ----------------

/**
 * A merchant demo page (GET /pay/<p>/<i>/demo): like the hosted pages, but it may load stubyard's own scripts
 * (paymentWidgets.js, the PayPal SDK) and frame stubyard pages. Returns the HTML and its CSP.
 */
export function renderMerchantDemo(i: { title: string; presetName: string; html: string; inline?: string; scripts?: { src: string; integrity?: string; crossorigin?: string }[] }): { html: string; csp: string } {
  const tags = (i.scripts ?? []).map((s) => `<script src="${esc(s.src)}"${s.integrity ? ` integrity="${esc(s.integrity)}"` : ''}${s.crossorigin ? ` crossorigin="${esc(s.crossorigin)}"` : ''}></script>`).join('');
  const body = `<div class="card"><div class="head"><div class="logo" aria-hidden="true">D</div><h1>${esc(i.title)}<small>Demo merchant page · fake ${esc(i.presetName)} · stubyard</small></h1></div><div class="sec stack">${i.html}</div></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(i.title)}</title>${FAVICON}<style>${CSS}</style>${i.inline ? `<script>${i.inline}</script>` : ''}</head><body><main class="wrap">${body}</main>${tags}</body></html>`;
  const csp = pageCsp(html)
    .replace(/script-src ([^;]+)/, (_m, v: string) => `script-src 'self' ${v === "'none'" ? '' : v}`.trim())
    .concat("; frame-src 'self'; child-src 'self'");
  return { html, csp };
}

/** End of a JS SDK popup / overlay: tell the opener (or the parent frame) and close. */
export function renderClosePage(i: { presetId: string; presetName: string; amount: string; title: string; message: Record<string, unknown>; dashboardUrl: string }): string {
  const msg = JSON.stringify(i.message).replace(/</g, '\\' + 'u003c');
  return page(
    i.title,
    `<div class="card">${head({ ...i, sub: i.title })}<div class="sec"><div class="banner ok" data-testid="stubyard-sdk-done" data-state="${esc(String(i.message.state ?? ''))}"><b>${esc(i.title)}</b>You can close this window; the shop continues.</div></div><div class="foot"><span>stubyard JS SDK simulator</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div></div>`,
    `(function(){var m=${msg};var t=window.opener||(window.parent!==window?window.parent:null);try{if(t)t.postMessage(m,'*')}catch(e){}setTimeout(function(){try{window.close()}catch(e){}},80)})();`,
  );
}

const FIELD_LABEL: Record<string, string> = { number: 'Card number', expiry: 'Expiry (MM/YY)', cvv: 'Security code', name: 'Name on card' };

/**
 * One PayPal Card Fields iframe (…/sdk/card-field?type=number|expiry|cvv|name&cf=<id>). The number frame posts only
 * {brand, last4, magicId, luhn, test} to the parent page; digits never leave the frame. A real-looking number is
 * cleared and reported (pay.real-card-entered).
 */
export function renderCardFieldPage(i: { type: string; cf: string; warnAction: string; placeholder?: string | null }): string {
  const type = FIELD_LABEL[i.type] ? i.type : 'number';
  const ph = i.placeholder ?? (type === 'number' ? '4242 4242 4242 4242' : type === 'expiry' ? 'MM/YY' : type === 'cvv' ? '123' : 'Jane Jones');
  const mode = type === 'name' ? 'text' : 'numeric';
  const script = `(function(){
var TYPE=${JSON.stringify(type)},CF=${JSON.stringify(i.cf)},WARN=${JSON.stringify(i.warnAction)};
var MAGIC=${JSON.stringify(MAGIC_CARDS.map((c) => ({ n: c.number, id: c.id, b: c.brand })))};
var OTHER=${JSON.stringify(OTHER_TEST_CARDS.map((c) => ({ n: c.number, b: c.brand })))};
var MADA=${JSON.stringify(MADA_BINS)};
function luhn(d){var s=0,alt=false;for(var i=d.length-1;i>=0;i--){var n=+d[i];if(alt){n*=2;if(n>9)n-=9}s+=n;alt=!alt}return d.length>=12&&s%10===0}
function brand(d){if(MADA.some(function(b){return d.indexOf(b)===0}))return'mada';if(/^4/.test(d))return'visa';if(/^(5[1-5]|2[2-7])/.test(d))return'mastercard';if(/^3[47]/.test(d))return'amex';if(/^(6011|65)/.test(d))return'discover';if(/^35/.test(d))return'jcb';return'unknown'}
var el=document.getElementById('f'),err=document.getElementById('err'),focused=false,real=false;
function post(extra){var m={source:'stubyard-paypal-cf',cf:CF,type:TYPE,state:state()};for(var k in extra)m[k]=extra[k];try{parent.postMessage(m,'*')}catch(e){}}
function state(){var v=el.value.trim(),d=v.replace(/\\D/g,''),ok=false,pot=true;
 if(TYPE==='number'){var known=MAGIC.some(function(c){return c.n===d})||OTHER.some(function(c){return c.n===d});ok=luhn(d)&&known;pot=d.length<12||ok}
 else if(TYPE==='expiry'){var m=/^(\\d{1,2})\\s*\\/?\\s*(\\d{2}|\\d{4})$/.exec(v);if(m){var mo=+m[1],yr=+m[2];if(yr<100)yr+=2000;var now=new Date();ok=mo>=1&&mo<=12&&(yr>now.getFullYear()||(yr===now.getFullYear()&&mo>=now.getMonth()+1))}pot=ok||v.length<5}
 else if(TYPE==='cvv'){ok=/^\\d{3,4}$/.test(d)&&d.length===v.length;pot=ok||v.length<3}
 else{ok=v.length>=2;pot=true}
 return{isValid:ok,isEmpty:!v,isPotentiallyValid:pot,isFocused:focused}}
function card(){var d=el.value.replace(/\\D/g,'');var mc=MAGIC.find(function(c){return c.n===d}),oc=OTHER.find(function(c){return c.n===d});return{brand:mc?mc.b:oc?oc.b:brand(d),last4:d.slice(-4),magicId:mc?mc.id:null,luhn:luhn(d),test:!!(mc||oc)}}
el.addEventListener('focus',function(){focused=true;post({event:'focus'})});
el.addEventListener('blur',function(){focused=false;
 if(TYPE==='number'){var c=card();if(c.luhn&&!c.test){el.value='';err.textContent='That looks like a real card number. It was cleared and not sent. Use a test card such as 4242 4242 4242 4242.';err.classList.remove('hide');real=true;try{fetch(WARN,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'brand='+encodeURIComponent(c.brand)})}catch(x){}post({event:'blur',realCard:true,card:null});return}}
 post({event:'blur'})});
el.addEventListener('input',function(){err.classList.add('hide');var extra={event:'change'};if(TYPE==='number'){var d=el.value.replace(/\\D/g,'');extra.card=d.length>=4?card():null}if(TYPE==='name')extra.name=el.value.trim();if(TYPE==='expiry')extra.expiry=el.value.trim();post(extra)});
window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='stubyard-paypal-cf-host'||d.cf!==CF)return;if(d.cmd==='clear'){el.value='';post({event:'change',card:null})}if(d.cmd==='focus')el.focus();if(d.cmd==='state')post({event:'state',card:TYPE==='number'&&el.value?card():null,name:TYPE==='name'?el.value.trim():undefined,expiry:TYPE==='expiry'?el.value.trim():undefined})});
post({event:'ready'});
})();`;
  return page(
    FIELD_LABEL[type]!,
    `<label class="field" style="margin:0"><span class="hide">${esc(FIELD_LABEL[type]!)}</span><input type="text" id="f" inputmode="${mode}" autocomplete="off" placeholder="${esc(ph)}" aria-label="${esc(FIELD_LABEL[type]!)}" data-testid="stubyard-cf-${type}"></label><div class="banner bad hide" id="err" role="alert" style="margin-top:6px" data-testid="stubyard-cf-error"></div>`,
    script,
    { embed: false },
  ).replace('<body>', '<body style="padding:0;background:transparent;min-height:0;display:block">');
}

/** PayPal vault without purchase: the buyer approves saving PayPal as a payment method. */
export function renderVaultApprovePage(i: { presetId: string; presetName: string; action: string; email: string; dashboardUrl: string }): string {
  return page(
    'Save PayPal for future payments',
    `<form method="post" action="${esc(i.action)}" class="card">${head({ presetId: i.presetId, presetName: i.presetName, amount: '', sub: 'Save PayPal for future payments' })}
<div class="sec"><p>The shop asks to save <b>${esc(i.email)}</b> as a payment method (PayPal vault, no payment now).</p>
<div class="grid"><button type="submit" class="btn primary" name="decision" value="approve" data-testid="stubyard-vault-approve">Agree and continue</button>
<button type="submit" class="btn" name="decision" value="cancel" data-testid="stubyard-vault-cancel">Cancel and return</button></div></div>
<div class="foot"><span>stubyard PayPal vault simulator</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div></form>`,
  );
}

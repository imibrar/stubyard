import { createHash } from 'node:crypto';
import { esc } from '../auth/pages.js';
import { MADA_BINS, MAGIC_CARDS, OTHER_TEST_CARDS, OUTCOMES } from './engine.js';
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

export function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main class="wrap">${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
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
}

const METHOD_LABEL: Record<string, string> = { card: 'Card', mada: 'mada', stcpay: 'STC Pay', applepay: 'Apple Pay', paypal: 'PayPal' };
const LOGO: Record<string, string> = { 'stripe-checkout': 'S', paytabs: 'PT', paypal: 'PP' };

function head(i: { presetId: string; presetName: string; amount: string; reference?: string | null; sub?: string }): string {
  return `<div class="head"><div class="logo" aria-hidden="true">${esc(LOGO[i.presetId] ?? '$')}</div><h1>${esc(i.sub ?? 'Pay')}<small>Fake ${esc(i.presetName)} · stubyard${i.reference ? ` · ${esc(i.reference)}` : ''}</small></h1><div class="amt" data-testid="stubyard-amount">${esc(i.amount)}</div></div>`;
}

function hidden(fields: Record<string, string | null | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
}

const CARD_SCRIPT = (warnAction: string) => `
(function(){
var MAGIC=${JSON.stringify(MAGIC_CARDS.map((c) => ({ n: c.number, id: c.id, b: c.brand })))};
var OTHER=${JSON.stringify(OTHER_TEST_CARDS.map((c) => ({ n: c.number, b: c.brand })))};
var MADA=${JSON.stringify(MADA_BINS)};
function luhn(d){var s=0,alt=false;for(var i=d.length-1;i>=0;i--){var n=+d[i];if(alt){n*=2;if(n>9)n-=9}s+=n;alt=!alt}return d.length>=12&&s%10===0}
function brand(d){if(MADA.some(function(b){return d.indexOf(b)===0}))return'mada';if(/^4/.test(d))return'visa';if(/^(5[1-5]|2[2-7])/.test(d))return'mastercard';if(/^3[47]/.test(d))return'amex';if(/^(6011|65)/.test(d))return'discover';if(/^35/.test(d))return'jcb';return'unknown'}
var f=document.getElementById('pay');if(!f)return;
var pan=document.getElementById('pan'),err=document.getElementById('card-err'),info=document.getElementById('card-info');
function sel(){var m=f.querySelector('input[name=method]:checked');return m?m.value:'card'}
function sync(){var m=sel();document.querySelectorAll('[data-for]').forEach(function(el){el.classList.toggle('hide',el.getAttribute('data-for').split(' ').indexOf(m)<0)})}
f.querySelectorAll('input[name=method]').forEach(function(r){r.addEventListener('change',sync)});sync();
document.querySelectorAll('[data-card]').forEach(function(b){b.addEventListener('click',function(){pan.value=b.getAttribute('data-card');pan.dispatchEvent(new Event('input'))})});
if(pan)pan.addEventListener('input',function(){var d=pan.value.replace(/\\D/g,'');var mc=MAGIC.find(function(c){return c.n===d});info.textContent=d.length>=4?(brand(d)+(mc?' · test card: '+mc.id:'')):'';err.classList.add('hide')});
f.addEventListener('submit',function(e){
  var m=sel();if(!pan||(m!=='card'&&m!=='mada'))return;
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
  const userOpt = (u: PageUser) => `<option value="${esc(u.id)}"${u.id === i.userId ? ' selected' : ''}>${esc(u.name)}${u.email ? ` · ${esc(u.email)}` : u.phone ? ` · ${esc(u.phone)}` : ''}</option>`;
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
  const stc = i.methods.includes('stcpay')
    ? `<div data-for="stcpay"><label class="field"><span>STC Pay mobile number</span><input type="tel" name="phone" placeholder="05XXXXXXXX or +9665XXXXXXXX" data-testid="stubyard-phone"></label><div class="hint">A one-time code goes to the stubyard SMS inbox (empty: the selected test user's phone).</div></div>`
    : '';
  const forced = i.forced
    ? `<div class="sec"><div class="banner info" data-testid="stubyard-forced"><b>Outcome set by ${esc(i.forced.via)}: ${esc(i.forced.outcome)}</b>Any button below continues with that outcome.</div><div class="row" style="margin-top:10px"><button type="submit" class="btn primary wide" name="outcome" value="success" data-testid="stubyard-continue">Continue</button></div></div>`
    : '';
  const more = OUTCOMES.filter((o) => !['success', 'decline', 'cancel'].includes(o));
  const body = `<form method="post" action="${esc(i.action)}" class="card" id="pay">
${head({ presetId: i.presetId, presetName: i.presetName, amount: i.amount, reference: i.reference })}
${i.error ? `<div class="sec"><div class="banner bad" role="alert" data-testid="stubyard-error">${esc(i.error)}</div></div>` : ''}
${forced}
<div class="sec"><dl class="meta">${i.description ? `<dt>For</dt><dd>${esc(i.description)}</dd>` : ''}<dt>Reference</dt><dd>${esc(i.providerRef)}</dd>${i.email ? `<dt>Email</dt><dd>${esc(i.email)}</dd>` : ''}${i.run ? `<dt>Run</dt><dd>${esc(i.run)}</dd>` : ''}</dl></div>
<div class="sec">${users}${methodTabs}${card}${stc}</div>
<div class="sec"><p class="label">Result</p><div class="grid">
<button type="submit" class="btn primary" name="outcome" value="success" data-testid="stubyard-pay">${i.presetId === 'paypal' ? 'Approve' : 'Pay'} ${esc(i.amount)}</button>
<button type="submit" class="btn danger" name="outcome" value="decline" data-testid="stubyard-decline">Decline</button>
${i.cancellable ? '<button type="submit" class="btn" name="outcome" value="cancel" data-testid="stubyard-cancel">Cancel and return</button>' : ''}
</div>
<details><summary>More outcomes</summary><div class="grid outs">${more.map((o) => `<button type="submit" class="btn" name="outcome" value="${o}" data-testid="stubyard-outcome-${o}">${o}</button>`).join('')}${['insufficient_funds', 'expired_card', 'incorrect_cvc', 'processing_error'].map((r) => `<button type="submit" class="btn" name="outcome" value="decline:${r}" data-testid="stubyard-outcome-decline-${r}">decline:${r}</button>`).join('')}</div></details></div>
<div class="foot"><span>Nothing here talks to the real ${esc(i.presetName)}. Card digits never leave this page.</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div>
</form>`;
  return page(`Pay ${i.amount} – Fake ${i.presetName}`, body, CARD_SCRIPT(i.warnAction));
}

export function renderOtpPage(i: { presetId: string; presetName: string; amount: string; action: string; phone: string; carry: Record<string, string | null>; error?: string | null; dashboardUrl: string }): string {
  return page(
    'STC Pay verification',
    `<form method="post" action="${esc(i.action)}" class="card">${head({ ...i, sub: 'STC Pay verification' })}
${hidden({ ...i.carry, method: 'stcpay', phone: i.phone })}
<div class="sec">${i.error ? `<div class="banner bad" role="alert" data-testid="stubyard-otp-error" style="margin-bottom:10px">${esc(i.error)}</div>` : ''}
<p>We sent a 6-digit code by SMS to <b>${esc(i.phone)}</b>. Find it in the stubyard SMS inbox.</p>
<label class="field"><span>Code</span><input type="text" name="otp" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus data-testid="stubyard-otp"></label>
<button type="submit" class="btn primary wide" data-testid="stubyard-otp-submit">Verify and pay</button></div>
<div class="foot"><span>Three wrong codes decline the payment.</span><a href="${esc(i.dashboardUrl)}">Open stubyard</a></div></form>`,
  );
}

export function renderChallengePage(i: { presetId: string; presetName: string; amount: string; action: string; carry: Record<string, string | null>; dashboardUrl: string }): string {
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

export function renderDonePage(i: { presetId: string; presetName: string; amount: string; status: string; tone: 'ok' | 'bad' | 'warn' | 'info'; title: string; message: string; returnUrl?: string | null; noReturn?: boolean; dashboardUrl: string }): string {
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

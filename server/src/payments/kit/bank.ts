import { esc } from '../../auth/pages.js';
import type { KitPayCtx } from './context.js';
import { hiddenFields, scriptJson } from './fields.js';
import { t } from './i18n.js';
import type { BankRule, ProviderLayout, Txt } from './layout.js';
import { tx } from './layout.js';
import { payFormParts, providerTitle } from './pages.js';
import { kitDocument } from './shell.js';

/**
 * Simulated bank pages of the redirect methods (research R2: Tap "KNET: pure redirect; the bank page asks for the
 * card number, expiry and PIN", BENEFIT likewise; MyFatoorah and APS send KNET to the same kind of page).
 * The page is stubyard's own ("KNET (simulated)"): no bank or scheme logos. Card number and PIN inputs have no
 * name, so they are never posted; a documented test card (MyFatoorah's test-cards page) maps to its outcome in the
 * browser and only that outcome is sent. Submit = success, Cancel = cancel without JS.
 */

const NAMES: Record<string, Txt> = {
  knet: { en: 'KNET (simulated)', ar: 'كي نت (محاكاة)' },
  benefit: { en: 'BENEFIT (simulated)', ar: 'بنفت (محاكاة)' },
};

const bankScript = (rules: BankRule[]) => `(function(){var R=${scriptJson(rules)};var f=document.getElementById('pay');if(!f)return;
f.addEventListener('submit',function(e){var s=e.submitter;if(!s||!s.hasAttribute('data-k-bank'))return;
var n=document.getElementById('bnum'),m=document.getElementById('bmon'),y=document.getElementById('byear'),pin=document.getElementById('bpin');
var d=n?n.value.replace(/\\D/g,''):'',exp=(m?m.value:'')+'/'+(y?y.value:''),hit=null;
for(var i=0;i<R.length;i++){if(R[i].number===d){hit=R[i];break}}
if(hit)s.value=(!hit.expiry||hit.expiry===exp)?hit.outcome:(hit.otherExpiry||'decline');
if(n)n.value='';if(pin)pin.value='';},true);})();`;

export function renderBankPage(c: KitPayCtx, def: ProviderLayout | null, method: string): string {
  const i = c.input;
  const L = c.view.locale;
  const kind = method === 'benefit' ? 'benefit' : 'knet';
  const name = tx(L, NAMES[kind]!);
  const rules = def?.bankRules?.(method as 'knet') ?? [];
  const { drawer, quick, script } = payFormParts(c, { requireCard: false, cards: false });
  const year = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, k) => String(k + 1).padStart(2, '0'));
  const years = Array.from({ length: 12 }, (_, k) => String((year + k) % 100).padStart(2, '0'));
  const sel = (id: string, label: string, opts: string[]) => `<label class="k-field"><span class="k-lbl">${esc(label)}</span><select class="k-select" id="${id}" aria-label="${esc(label)}">${opts.map((o) => `<option value="${o}">${o}</option>`).join('')}</select></label>`;
  const ruleList = rules.length
    ? `<details class="k-rules" data-testid="stubyard-bank-rules"><summary>${esc(t(L, 'bankTestCards'))}</summary><ul>${rules.map((r) => `<li><span class="mono" dir="ltr">${esc(r.number.replace(/(\d{4})(?=\d)/g, '$1 '))}${r.expiry ? ` · ${esc(r.expiry)}` : ''}</span> → ${esc(r.label)}</li>`).join('')}</ul></details>`
    : `<p class="k-hint">${esc(t(L, 'bankNoRules'))}</p>`;
  const body = `<form method="post" action="${esc(c.rel.x + 'bank')}" id="pay"${i.forced ? ' data-forced' : ''} novalidate>${quick}
<main class="k-wrap"><div class="k-card k-bankpage" data-layout="bank-${kind}" data-testid="stubyard-bank-page" data-bank="${kind}">${hiddenFields({ method: kind })}
<div class="k-head"><div class="k-mono" aria-hidden="true">${kind === 'knet' ? 'KN' : 'BN'}</div><h1>${esc(name)}<small>${esc(t(L, 'simulatedBank'))}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(i.amount)}</div></div>
<div class="k-sec"><dl class="k-meta"><dt>${esc(t(L, 'merchantLbl'))}</dt><dd>${esc(c.merchant)}</dd><dt>${esc(t(L, 'amountLbl'))}</dt><dd>${esc(i.amount)}</dd><dt>${esc(t(L, 'reference'))}</dt><dd>${esc(i.providerRef)}</dd></dl></div>
<div class="k-sec">${kind === 'knet' ? sel('kbank', t(L, 'selectBank'), [1, 2, 3].map((n) => t(L, 'testBank', { n }))) : ''}
<label class="k-field"><span class="k-lbl">${esc(t(L, 'cardNumber'))}</span><input class="k-input k-num" type="text" id="bnum" inputmode="numeric" autocomplete="off" maxlength="23" dir="ltr" data-testid="stubyard-bank-card"></label>
<div class="k-field"><span class="k-lbl">${esc(t(L, 'cardExpired'))}</span><div class="k-row2">${sel('bmon', t(L, 'month'), months)}${sel('byear', t(L, 'year'), years)}</div></div>
${kind === 'benefit' ? `<label class="k-field"><span class="k-lbl">${esc(t(L, 'cardholder'))}</span><input class="k-input" type="text" id="bname" autocomplete="off"></label>` : ''}
<label class="k-field"><span class="k-lbl">${esc(t(L, 'pin'))}</span><input class="k-input k-num" type="password" id="bpin" inputmode="numeric" autocomplete="off" maxlength="${kind === 'knet' ? 4 : 6}" dir="ltr" data-testid="stubyard-bank-pin"></label>
${ruleList}
<div class="k-grid2"><button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-k-bank data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(kind === 'knet' ? t(L, 'submit') : t(L, 'pay'))}</span></button>
<button type="submit" class="k-btn" name="outcome" value="cancel" formnovalidate data-testid="stubyard-bank-cancel">${esc(t(L, 'cancel'))}</button></div>
<p class="k-hint">${esc(t(L, 'bankNote', { name }))}</p></div>
<div class="k-sec k-foot"><span>${esc(t(L, 'simulatedBy', { provider: def?.provider ?? i.presetName }))}</span></div>
</div></main>${drawer}</form>`;
  return kitDocument({ title: `${name} · ${providerTitle(def?.provider ?? i.presetName)}`, locale: L, body, scripts: [bankScript(rules), script], banner: { variant: 'strip', host: c.host, drawer: true, notice: c.rel.notice } });
}

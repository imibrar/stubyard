import { esc } from '../../auth/pages.js';
import { t } from '../kit/i18n.js';
import type { ReturnCtx } from '../kit/layout.js';
import { kitDocument } from '../kit/shell.js';
import { js } from './runtime.js';

/**
 * The return after the PaymentURL of an embedded-session payment. Framed (the shop opened PaymentURL in an iframe):
 * post JSON.stringify({ sender: 'MF-3DSecure', url }) to the shop's origin (the one the session frame was opened
 * from) and let it navigate; else replace the window with the return URL. Null for other payments.
 */
export function mfSessionReturnPage(r: ReturnCtx): string | null {
  const s = r.payment.providerData.mfSession as { origin?: unknown } | undefined;
  if (!s || r.kind !== 'redirect') return null;
  const origin = typeof s.origin === 'string' && /^https?:\/\/[^/\s]+$/.test(s.origin) ? s.origin : null;
  const L = r.view.locale;
  const tone = r.result.tone;
  const icon = { ok: '✓', bad: '!', warn: '–', info: 'i' }[tone];
  const body = `<main class="k-wrap"><div class="k-card"><div class="k-result" data-testid="stubyard-done" data-status="${esc(r.status)}" data-sdk="myfatoorah-session"><span class="k-icon ${tone}" aria-hidden="true">${icon}</span><h1>${esc(t(L, r.result.title))}</h1><p>${esc(t(L, 'returning'))}</p><p><a class="k-btn" href="${esc(r.url)}" target="_top" data-testid="stubyard-return">${esc(t(L, 'returnShop'))}</a></p></div><div class="k-sec k-foot"><span>${esc(t(L, 'simulatedBy', { provider: 'MyFatoorah' }))}</span></div></div></main>`;
  const script = `(function(){var U=${js(r.url)},O=${js(origin)};var framed=window.parent&&window.parent!==window;if(framed&&O){try{window.parent.postMessage(JSON.stringify({sender:'MF-3DSecure',url:U}),O)}catch(e){}return}if(!framed)setTimeout(function(){location.replace(U)},400)})();`;
  return kitDocument({ title: t(L, r.result.title), locale: L, body, scripts: [script], banner: { variant: 'strip', host: r.host } });
}

import { esc } from '../../auth/pages.js';
import { MAGIC_CARDS } from '../engine.js';
import type { GatewayCtx } from '../gateway.js';
import { pageCsp } from '../pages.js';
import { t, type Locale } from '../kit/i18n.js';
import { kitDocument } from '../kit/shell.js';
import { channelOf, checkSdkOrigin, frameBridge, js } from './runtime.js';

/**
 * The simulated wallet sheet (Apple Pay / Google Pay / STC Pay style), shared by the fake SDKs:
 * GET <instance base>/stubyard-sdk/wallet?wallet=applepay|googlepay|stcpay&amount=…&label=…&ch=…&origin=…&lang=…
 * A neutral bottom sheet (no wallet logos, colours or fonts) with the TEST notice, the merchant and amount, a test
 * card "in the wallet" (its magic id decides the result) and Confirm / Cancel. It posts
 * {source:'stubyard-wallet', ch, type:'wallet', result:'authorized'|'cancelled', card:{brand,last4,magicId}} to the
 * page's origin only. Nothing is charged here: the SDK creates the payment afterwards.
 */

export const WALLETS = { applepay: 'Apple Pay', googlepay: 'Google Pay', stcpay: 'STC Pay' } as const;
export type Wallet = keyof typeof WALLETS;

/** Cards a wallet sheet offers: the magic cards without 3-D Secure (wallet payments are already authenticated). */
export const WALLET_CARDS = MAGIC_CARDS.filter((c) => c.id !== '3ds').map((c) => ({ brand: c.brand, last4: c.number.slice(-4), magicId: c.id, label: c.label }));

export function renderWalletSheet(o: { wallet: Wallet; amount: string; label: string; locale: Locale; origin: string; ch: string }): string {
  const L = o.locale;
  const name = WALLETS[o.wallet];
  const stc = o.wallet === 'stcpay';
  const cards = stc ? '' : `<fieldset class="k-sec" style="border:0;margin:0"><legend class="k-lbl">${esc(t(L, 'walletCard'))}</legend>${WALLET_CARDS.map((c, i) => `<label class="k-radio"><input type="radio" name="card" value="${esc(c.magicId)}"${i === 0 ? ' checked' : ''} data-brand="${esc(c.brand)}" data-last4="${esc(c.last4)}" data-testid="stubyard-wallet-card-${esc(c.magicId)}"><span><span dir="ltr">${esc(c.brand.toUpperCase())} •••• ${esc(c.last4)}</span><small>${esc(c.label)}</small></span></label>`).join('')}</fieldset>`;
  const body = `<main class="k-wrap" style="padding:8px"><div class="k-card" data-testid="stubyard-wallet" data-wallet="${o.wallet}">
<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(name.split(' ').map((w) => w[0]).join(''))}</div><h1>${esc(t(L, 'walletTitle', { wallet: name }))}<small>${esc(o.label)}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(o.amount)}</div></div>
${cards}<div class="k-sec"><p class="k-hint">${esc(t(L, 'walletNoSheet'))}</p>
<div class="k-actions"><button type="button" class="k-paybtn" id="ok" data-testid="stubyard-wallet-confirm"><span class="k-label">${esc(t(L, stc ? 'walletStcApprove' : 'walletApprove'))}</span></button>
<button type="button" class="k-btn" id="no" data-testid="stubyard-wallet-cancel">${esc(t(L, 'cancel'))}</button></div></div></div></main>`;
  const script = `(function(){${frameBridge({ origin: o.origin, ch: o.ch, source: 'stubyard-wallet' })}
var done=false;function fin(m){if(done)return;done=true;m.type='wallet';SYB.post(m)}
document.getElementById('ok').addEventListener('click',function(){var r=document.querySelector('input[name=card]:checked');fin({result:'authorized',wallet:${js(o.wallet)},card:r?{brand:r.getAttribute('data-brand'),last4:r.getAttribute('data-last4'),magicId:r.value}:null})});
document.getElementById('no').addEventListener('click',function(){fin({result:'cancelled',wallet:${js(o.wallet)}})});
document.addEventListener('keydown',function(e){if(e.key==='Escape')fin({result:'cancelled',wallet:${js(o.wallet)}})});
SYB.on(function(d){if(d.type==='cancel')fin({result:'cancelled',wallet:${js(o.wallet)}})});})();`;
  return kitDocument({ title: t(L, 'walletTitle', { wallet: name }), locale: L, body, scripts: [script], frame: true, banner: { variant: 'full' } });
}

/** An error page inside an SDK frame (bad origin / channel): visible, posts nothing. */
export function renderSdkError(L: Locale, title: string, message: string): string {
  return kitDocument({ title, locale: L, body: `<main class="k-wrap" style="padding:8px"><div class="k-card"><div class="k-sec"><div class="k-alert" role="alert" data-testid="stubyard-sdk-error">${esc(message)}</div></div></div></main>`, frame: true, banner: { variant: 'full' } });
}

export const htmlReply = (c: GatewayCtx, status: number, html: string) => c.reply.status(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', pageCsp(html)).send(html);

const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as string) : '');

/** GET /stubyard-sdk/wallet (any gateway instance). */
export function walletRoute(c: GatewayCtx): unknown {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.reply.status(405).send({ error: 'GET only' });
  c.resolved.endpoint = 'sdk wallet sheet';
  const L: Locale = str(c.query.lang).toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const w = str(c.query.wallet) as Wallet;
  const wallet: Wallet = w in WALLETS ? w : 'applepay';
  const ch = channelOf(c.query.ch);
  const chk = checkSdkOrigin(c, c.query.origin, `The ${WALLETS[wallet]} sheet (${c.inst.slug})`);
  if (!ch || !chk.ok) return htmlReply(c, chk.ok ? 400 : 403, renderSdkError(L, t(L, 'walletTitle', { wallet: WALLETS[wallet] }), chk.ok ? 'Missing or bad channel (ch).' : t(L, 'sdkOriginRefused', { origin: chk.origin ?? '?', provider: WALLETS[wallet] })));
  const amount = str(c.query.amount).slice(0, 40) || '—';
  const label = str(c.query.label).slice(0, 80) || c.project.name;
  return htmlReply(c, 200, renderWalletSheet({ wallet, amount, label, locale: L, origin: chk.origin, ch }));
}

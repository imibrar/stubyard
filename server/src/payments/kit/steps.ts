import { esc } from '../../auth/pages.js';
import type { KitPayCtx } from './context.js';
import { cardFields, hiddenFields } from './fields.js';
import { t, tMessage, type Locale } from './i18n.js';
import { tx, type Txt } from './layout.js';
import { payFormParts, providerTitle } from './pages.js';
import type { LayoutId } from './registry.js';
import { kitDocument } from './shell.js';

/**
 * The screens of the multi-step provider pages (P3: Tabby, Tamara, the JazzCash / Easypaisa wallets): one card per
 * step with the provider's name as plain text, the step's form (POST x/<step>), the test shortcuts and the drawer.
 * Continue buttons carry no outcome (only the last screen's pay button does), so the drawer's outcome choice is
 * applied at the end of the flow, not on the first click.
 */

/** "Back to store" with a confirmation (outcome cancel only after "Yes, cancel"). */
export interface CancelConfirm {
  label: Txt;
  question: Txt;
  yes: Txt;
  no: Txt;
}

export interface StepShell {
  layout: LayoutId;
  provider: string;
  /** The provider monogram (plain text, no logo). */
  mono: string;
  /** Screen id (data-screen): phone, otp, plan, card, … */
  screen: string;
  title: string;
  sub?: string | null;
  /** POST target: c.rel.x + step. */
  action: string;
  inner: string;
  /** The method posted with the form (bnpl, wallet; card on a card screen: the form script reads the card). */
  method: string;
  /** A card form on this screen (the form script derives the card facts and asks for a complete card). */
  card?: boolean;
  /** "Step 2 of 4". */
  stepNo?: [number, number] | null;
  cancel?: CancelConfirm | null;
  /** The drawer's outcome choice kept from an earlier screen. */
  choice?: string | null;
  footer?: string[];
}

const KEEP_SCRIPT = "(function(){document.querySelectorAll('[data-k-keep]').forEach(function(b){b.addEventListener('click',function(){var d=b.closest('details');if(d)d.open=false})})})();";

export function cancelConfirm(L: Locale, c: KitPayCtx, o: CancelConfirm | null | undefined): string {
  if (!o || !c.input.cancellable) return '';
  return `<details class="k-confirm" data-testid="stubyard-cancel-confirm-box"><summary data-testid="stubyard-provider-cancel">${esc(tx(L, o.label))}</summary><div role="group" aria-label="${esc(tx(L, o.label))}"><p>${esc(tx(L, o.question))}</p><div class="k-actions"><button type="submit" class="k-btn" name="outcome" value="cancel" formnovalidate data-testid="stubyard-cancel-confirm">${esc(tx(L, o.yes))}</button><button type="button" class="k-btn primary" data-k-keep data-testid="stubyard-cancel-keep">${esc(tx(L, o.no))}</button></div></div></details>`;
}

export function stepShell(c: KitPayCtx, o: StepShell): string {
  const L = c.view.locale;
  const { drawer, quick, script } = payFormParts(c, { requireCard: !!o.card, cards: !!o.card, choice: o.choice ?? null });
  const msg = c.stepError ?? (c.input.error ? tMessage(L, c.input.error) : null);
  const err = msg ? `<div class="k-alert" role="alert" data-testid="stubyard-error">${esc(msg)}</div>` : '';
  const no = o.stepNo ? `<p class="k-stepno" data-testid="stubyard-step-no">${esc(L === 'ar' ? `الخطوة ${o.stepNo[0]} من ${o.stepNo[1]}` : `Step ${o.stepNo[0]} of ${o.stepNo[1]}`)}</p>` : '';
  const foot = (o.footer ?? []).map((f) => `<span>${esc(f)}</span>`).join('');
  const body = `<form method="post" action="${esc(o.action)}" id="pay"${c.input.forced ? ' data-forced' : ''} novalidate>${quick}
<main class="k-wrap"><div class="k-card k-hpp" data-layout="${o.layout}" data-screen="${esc(o.screen)}" data-testid="stubyard-screen-${esc(o.screen)}">
<div class="k-head"><div class="k-mono" aria-hidden="true">${esc(o.mono)}</div><h1>${esc(c.merchant)}<small>${esc(t(L, 'simulatedBy', { provider: o.provider }))}</small></h1><div class="k-amt" data-testid="stubyard-amount">${esc(c.input.amount)}</div></div>
<div class="k-sec">${no}<h2 class="k-h2">${esc(o.title)}</h2>${o.sub ? `<p class="k-sub">${esc(o.sub)}</p>` : ''}${err}${hiddenFields({ method: o.method })}${o.inner}${cancelConfirm(L, c, o.cancel)}</div>
<div class="k-sec k-foot">${foot}<span>${esc(t(L, 'noRealProvider', { provider: o.provider }))}</span></div>
</div></main>${drawer}</form>`;
  return kitDocument({ title: `${o.title} · ${providerTitle(o.provider)}`, locale: L, body, scripts: [script, KEEP_SCRIPT], banner: { variant: 'full', host: c.host, drawer: true, notice: c.rel.notice } });
}

/** A primary continue button (no outcome: the flow moves on). */
export const continueBtn = (label: string, testid = 'stubyard-continue-step') => `<button type="submit" class="k-paybtn" data-testid="${testid}"><span class="k-label">${esc(label)}</span></button>`;

/** The last screen's pay button (outcome success; the drawer's choice replaces it). */
export const payBtn = (label: string) => `<button type="submit" class="k-paybtn" name="outcome" value="success" data-k-pay data-testid="stubyard-pay"><span class="k-spin" aria-hidden="true"></span><span class="k-label">${esc(label)}</span></button>`;

/** The OTP input of a step screen (name otp; never kept on the server). */
export function otpInput(L: Locale, o: { length: number; value?: string | null; hint?: string | null }): string {
  return `<label class="k-field"><span class="k-lbl">${esc(L === 'ar' ? 'رمز التحقق' : 'Verification code')}</span><input class="k-input k-otp" type="text" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="${o.length}" dir="ltr"${o.value ? ` value="${esc(o.value)}"` : ''} required autofocus data-testid="stubyard-otp"></label>${o.hint ? `<p class="k-hint" data-testid="stubyard-otp-hint">${esc(o.hint)}</p>` : ''}`;
}

/** The card form of a BNPL card screen (the digits stay in the browser, as on every kit page). */
export const bnplCard = (L: Locale, label?: string) => cardFields(L, { methods: ['card'], label });

/** Facts of the posted card (brand / last 4 / magic id / Luhn / test flag), kept as flow answers. */
export const cardAnswers = (b: Record<string, unknown>) => {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { card_brand: s(b.card_brand), card_last4: s(b.card_last4), card_magic: s(b.card_magic), card_luhn: s(b.card_luhn), card_test: s(b.card_test) };
};

/** Equal instalments: the first takes the rounding remainder (as Tabby's session does). */
export function instalments(amount: number, n: number): number[] {
  const part = Math.floor(amount / n);
  return [amount - part * (n - 1), ...Array.from({ length: n - 1 }, () => part)];
}

import type { Json } from '../gateway.js';
import type { Payment, PaymentMethod } from '../repo.js';
import type { PaymentService } from '../service.js';
import type { KitPayCtx } from './context.js';
import type { FlowName } from './flow.js';
import type { Locale } from './i18n.js';
import type { ResultView } from './pages.js';
import type { LayoutId } from './registry.js';
import type { CheckoutView } from './view.js';

/**
 * A provider layout of the realistic hosted page (one per <gateway>/experience.ts, collected in dispatch.ts).
 * The layout draws the screens; the step endpoints (kit/router.ts) keep the order of the screens on the server and
 * hand every answer to svc.complete, so outcomes, return URLs and webhooks are exactly those of the classic page.
 */

/** A provider string in both page languages (provider wording lives in the experience file, not in i18n.ts). */
export type Txt = { en: string; ar: string };
export const tx = (L: Locale, s: Txt | string): string => (typeof s === 'string' ? s : s[L] || s.en);

/**
 * A documented test card of a simulated bank page (KNET / BENEFIT). The page maps the typed card (and expiry) to an
 * outcome in the browser; only the outcome is posted, never the digits or the PIN.
 */
export interface BankRule {
  number: string;
  /** MM/YY the card needs for `outcome`; another expiry gives `otherExpiry`. Absent: any expiry. */
  expiry?: string;
  outcome: string;
  otherExpiry?: string;
  label: string;
}

/** A custom step of a multi-step flow (POST …/x/<name>), e.g. PayPal login → review. */
export interface CustomStep {
  flow: FlowName;
  /** The next step, or "done" (the answers go to svc.complete). */
  next: string;
  /** A "back" answer (back=1) returns to this step. */
  back?: string;
  /** A message when the answer is not acceptable (the step is shown again, 400). */
  validate?(b: Json, L: Locale): string | null;
  /** Non-secret answers kept on the server for the next steps (never passwords or digits). */
  answers?(b: Json): Record<string, string | null>;
}

export interface ReturnCtx {
  payment: Payment;
  view: CheckoutView;
  host: string | null;
  presetName: string;
  kind: 'post' | 'redirect';
  url: string;
  fields: Record<string, string>;
  status: string;
  result: ResultView;
}

export interface ProviderLayout {
  id: LayoutId;
  /** The provider's name as plain text ("Checkout.com"): no logos, colours or fonts. */
  provider: string;
  /** Where 3-D Secure appears: a modal / frame over the page, or a full-page redirect to the simulated ACS. */
  threeds: 'modal' | 'redirect';
  /** The layout also draws the embedded (widget iframe) page. */
  embedOk?: boolean;
  renderPay(c: KitPayCtx): string;
  /** GET of the page: start the flow the first screen needs (PayPal login, an ACS / bank page opened directly). */
  prepare?(svc: PaymentService, p: Payment): Payment;
  /** Methods paid on a simulated bank page (POST x/pay → 303 x/bank). */
  bankMethods?: PaymentMethod[];
  bankRules?(method: PaymentMethod): BankRule[];
  /** Custom steps (POST x/<name>) and their screens. */
  steps?: Record<string, CustomStep>;
  renderStep?(c: KitPayCtx, step: string): string;
  /** A line on the simulated ACS page (the sandbox password the provider is known for, marked unverified). */
  acsHint?: Txt;
  /** The return page (PayTabs: framed targets and the countdown). null: stubyard's default return. */
  returnPage?(r: ReturnCtx): string | null;
  /** Extra inline scripts on the result screen right after the payment finished (PayTabs hppDone). */
  resultScripts?(p: Payment): string[];
}

import { HttpError } from '../util.js';

/**
 * Payments engine (pure, no I/O): the payment state machine, outcome strings and modifiers, the outcome
 * precedence (resolveOutcome), magic test cards / amounts and currency precision. Gateways (stripe/, paytabs/,
 * paypal/) translate these generic states into their own vocabulary.
 */

export const PAYMENT_STATUSES = ['created', 'pending', 'requires_action', 'authorized', 'paid', 'failed', 'cancelled', 'expired', 'partially_refunded', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_EVENTS = ['open', 'challenge', 'authorize', 'capture', 'fail', 'cancel', 'expire', 'retry', 'void', 'refund_partial', 'refund_full'] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

/** Final states: nothing happens to them any more (refunds aside). */
export const TERMINAL: readonly PaymentStatus[] = ['failed', 'cancelled', 'expired', 'refunded'];
/** States in which the buyer has not finished yet (the hosted page is still usable). */
export const OPEN: readonly PaymentStatus[] = ['created', 'pending', 'requires_action'];

/** Allowed transitions: event → (from → to). */
const TABLE: Record<PaymentEvent, Partial<Record<PaymentStatus, PaymentStatus>>> = {
  open: { created: 'pending', pending: 'pending' },
  challenge: { created: 'requires_action', pending: 'requires_action' },
  authorize: { created: 'authorized', pending: 'authorized', requires_action: 'authorized' },
  capture: { authorized: 'paid' },
  fail: { created: 'failed', pending: 'failed', requires_action: 'failed', authorized: 'failed' },
  cancel: { created: 'cancelled', pending: 'cancelled', requires_action: 'cancelled' },
  expire: { created: 'expired', pending: 'expired', requires_action: 'expired', failed: 'expired' },
  retry: { failed: 'pending', cancelled: 'pending' },
  void: { authorized: 'cancelled' },
  refund_partial: { paid: 'partially_refunded', partially_refunded: 'partially_refunded' },
  refund_full: { paid: 'refunded', partially_refunded: 'refunded' },
};

/** Next status for an event; 409 when the event is not allowed in this state. */
export function transition(status: PaymentStatus, event: PaymentEvent): PaymentStatus {
  const to = TABLE[event]?.[status];
  if (!to) throw new HttpError(409, `Payment is ${status}; "${event}" is not possible in this state`, { status, event });
  return to;
}

export function canTransition(status: PaymentStatus, event: PaymentEvent): boolean {
  return !!TABLE[event]?.[status];
}

// ---------------- outcomes ----------------

export const OUTCOMES = ['success', 'decline', 'cancel', 'abandon', '3ds_success', '3ds_fail', 'pending_then_success'] as const;
export type OutcomeBase = (typeof OUTCOMES)[number];
export const DECLINE_REASONS = ['generic', 'insufficient_funds', 'expired_card', 'incorrect_cvc', 'processing_error'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];
export const MODIFIERS = ['no_webhook', 'duplicate_webhook', 'webhook_delay', 'no_redirect', 'slow'] as const;

export interface Outcome {
  base: OutcomeBase;
  reason: DeclineReason | null;
  noWebhook: boolean;
  duplicateWebhook: boolean;
  webhookDelayMs: number | null;
  noRedirect: boolean;
  slowMs: number | null;
}

/**
 * "decline:insufficient_funds, no_webhook, webhook_delay=2000" → Outcome. A string with only modifiers
 * ("no_webhook") keeps base = success. Unknown words → 400.
 */
export function parseOutcome(raw: string): Outcome {
  const out: Outcome = { base: 'success', reason: null, noWebhook: false, duplicateWebhook: false, webhookDelayMs: null, noRedirect: false, slowMs: null };
  let sawBase = false;
  for (const part of String(raw ?? '').split(/[,\s+]+/).filter(Boolean)) {
    const [nameRaw, arg] = part.split(/[=:]/, 2) as [string, string | undefined];
    const name = nameRaw.trim().toLowerCase().replace(/-/g, '_');
    if ((OUTCOMES as readonly string[]).includes(name)) {
      if (sawBase) throw new HttpError(400, `Outcome "${raw}" names more than one outcome`);
      sawBase = true;
      out.base = name as OutcomeBase;
      if (name === 'decline') {
        const r = (arg ?? 'generic').toLowerCase();
        if (!(DECLINE_REASONS as readonly string[]).includes(r)) throw new HttpError(400, `Unknown decline reason "${r}". Use ${DECLINE_REASONS.join(', ')}`);
        out.reason = r as DeclineReason;
      }
      continue;
    }
    const ms = () => {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 0 || n > 600_000) throw new HttpError(400, `${name} needs a delay in ms (0-600000), e.g. ${name}=2000`);
      return Math.round(n);
    };
    if (name === 'no_webhook') out.noWebhook = true;
    else if (name === 'duplicate_webhook') out.duplicateWebhook = true;
    else if (name === 'no_redirect') out.noRedirect = true;
    else if (name === 'webhook_delay') out.webhookDelayMs = ms();
    else if (name === 'slow') out.slowMs = arg === undefined ? 2000 : ms();
    else throw new HttpError(400, `Unknown payment outcome "${part}". Outcomes: ${OUTCOMES.join(', ')} (decline:<reason>); modifiers: ${MODIFIERS.join(', ')}`);
  }
  return out;
}

/** Canonical text of an outcome (what is stored on the payment). */
export function formatOutcome(o: Outcome): string {
  const parts = [o.base === 'decline' ? `decline:${o.reason ?? 'generic'}` : o.base];
  if (o.noWebhook) parts.push('no_webhook');
  if (o.duplicateWebhook) parts.push('duplicate_webhook');
  if (o.webhookDelayMs !== null) parts.push(`webhook_delay=${o.webhookDelayMs}`);
  if (o.noRedirect) parts.push('no_redirect');
  if (o.slowMs !== null) parts.push(`slow=${o.slowMs}`);
  return parts.join(',');
}

/** Validates and normalises an outcome string (400 on unknown words). */
export const normalizeOutcome = (raw: string): string => formatOutcome(parseOutcome(raw));

/** Where the outcome came from, in precedence order. */
export type OutcomeVia = 'header' | 'run rule' | 'user rule' | 'instance rule' | 'magic card' | 'magic amount' | 'page' | 'api' | 'default';
/** Levels 1-4 force the outcome: the hosted page only offers "Continue". */
export const FORCED_VIA: readonly OutcomeVia[] = ['header', 'run rule', 'user rule', 'instance rule'];

export interface OutcomeContext {
  /** 1: X-Hub-Payment-Outcome / PayPal-Mock-Response on the create call (stored on the payment). */
  header?: string | null;
  /** 2-4: rule pickers; each is only called when every level above it had nothing (so only the winner is consumed). */
  runRule?: () => string | null;
  userRule?: () => string | null;
  instanceRule?: () => string | null;
  /** 5: magic card (outcome of the test card number) or magic amount. */
  magicCard?: string | null;
  magicAmount?: string | null;
  /** 6: the button clicked on the page / the outcome given to the API. */
  click?: string | null;
  clickVia?: 'page' | 'api';
  /** 7: the instance default (success when unset). */
  defaultOutcome?: string | null;
}

/** First hit wins: header, run rule, user rule, instance rule, magic card / amount, page click / API, default. */
export function resolveOutcome(c: OutcomeContext): { outcome: string; via: OutcomeVia } {
  if (c.header) return { outcome: normalizeOutcome(c.header), via: 'header' };
  const run = c.runRule?.();
  if (run) return { outcome: normalizeOutcome(run), via: 'run rule' };
  const user = c.userRule?.();
  if (user) return { outcome: normalizeOutcome(user), via: 'user rule' };
  const inst = c.instanceRule?.();
  if (inst) return { outcome: normalizeOutcome(inst), via: 'instance rule' };
  if (c.magicCard) return { outcome: normalizeOutcome(c.magicCard), via: 'magic card' };
  if (c.magicAmount) return { outcome: normalizeOutcome(c.magicAmount), via: 'magic amount' };
  if (c.click) return { outcome: normalizeOutcome(c.click), via: c.clickVia ?? 'page' };
  return { outcome: normalizeOutcome(c.defaultOutcome || 'success'), via: 'default' };
}

// ---------------- magic cards ----------------

export interface MagicCard {
  number: string;
  id: string;
  brand: string;
  /** Outcome the card forces; '3ds' = a challenge whose result the page (or 3ds_success on the API) decides. */
  outcome: string;
  label: string;
}

/** Test cards (Stripe-style numbers). Their outcome applies at level 5. */
export const MAGIC_CARDS: MagicCard[] = [
  { number: '4242424242424242', id: 'success', brand: 'visa', outcome: 'success', label: 'Succeeds' },
  { number: '4000000000000002', id: 'decline', brand: 'visa', outcome: 'decline:generic', label: 'Declined (generic)' },
  { number: '4000000000009995', id: 'insufficient_funds', brand: 'visa', outcome: 'decline:insufficient_funds', label: 'Declined: insufficient funds' },
  { number: '4000000000000069', id: 'expired_card', brand: 'visa', outcome: 'decline:expired_card', label: 'Declined: expired card' },
  { number: '4000000000000127', id: 'incorrect_cvc', brand: 'visa', outcome: 'decline:incorrect_cvc', label: 'Declined: incorrect CVC' },
  { number: '4000000000000119', id: 'processing_error', brand: 'visa', outcome: 'decline:processing_error', label: 'Declined: processing error' },
  { number: '4000002500003155', id: '3ds', brand: 'visa', outcome: '3ds', label: '3D Secure challenge' },
];

/** Other well-known public test numbers: accepted (no "real card" warning), outcome left to the click / default. */
export const OTHER_TEST_CARDS: { number: string; brand: string }[] = [
  { number: '4111111111111111', brand: 'visa' },
  { number: '4012001036983332', brand: 'visa' },
  { number: '5555555555554444', brand: 'mastercard' },
  { number: '5200828282828210', brand: 'mastercard' },
  { number: '5498383801606532', brand: 'mastercard' },
  { number: '5200000000000007', brand: 'mastercard' },
  { number: '5200000000000114', brand: 'mastercard' },
  { number: '2223003122003222', brand: 'mastercard' },
  { number: '378282246310005', brand: 'amex' },
  { number: '371449635398431', brand: 'amex' },
];

/** A sample of mada BIN prefixes (Saudi debit scheme). Cards starting with one report brand "mada". */
export const MADA_BINS = [
  '440647', '440795', '446404', '457865', '968208', '457997', '474491', '636120', '417633', '468540', '468541', '468542', '468543', '968201',
  '446393', '409201', '458456', '484783', '462220', '455708', '410621', '455036', '486094', '486095', '486096', '504300', '440533', '489318',
  '489319', '445564', '968211', '410685', '406996', '432328', '428671', '428672', '428673', '968206', '446672', '543357', '434107', '431361',
  '604906', '521076', '588848', '968202', '535825', '529415', '543085', '524130', '554180', '549760', '968209', '524514', '529741', '537767',
  '535989', '536023', '513213', '520058', '558563', '588850', '585265', '588982', '589005', '508160', '531095', '530906', '532013', '968204',
  '422817', '422818', '422819', '428331', '483010', '483011', '483012', '589206', '968207', '419593', '439954', '407197', '407395',
];

export function luhnValid(pan: string): boolean {
  const d = pan.replace(/\D/g, '');
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function cardBrand(pan: string): string {
  const d = pan.replace(/\D/g, '');
  if (MADA_BINS.some((b) => d.startsWith(b))) return 'mada';
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(d)) return 'discover';
  if (/^35/.test(d)) return 'jcb';
  return 'unknown';
}

export const magicCardById = (id: string | null | undefined) => (id ? MAGIC_CARDS.find((c) => c.id === id) ?? null : null);
export const isTestCard = (pan: string) => {
  const d = pan.replace(/\D/g, '');
  return MAGIC_CARDS.some((c) => c.number === d) || OTHER_TEST_CARDS.some((c) => c.number === d);
};

/** What a card number tells devhub. The full number is never returned or stored. */
export function describeCard(pan: string): { brand: string; last4: string; magicId: string | null; luhnValid: boolean; testCard: boolean } {
  const d = pan.replace(/\D/g, '');
  const magic = MAGIC_CARDS.find((c) => c.number === d);
  const other = OTHER_TEST_CARDS.find((c) => c.number === d);
  return { brand: magic?.brand ?? other?.brand ?? cardBrand(d), last4: d.slice(-4), magicId: magic?.id ?? null, luhnValid: luhnValid(d), testCard: !!(magic || other) };
}

/** Magic amounts (opt-in per instance) on the last two minor-unit digits: .02 decline, .05 insufficient, .12 3DS fail, .99 pending. */
export function magicAmountOutcome(amountMinor: number): string | null {
  const tail = Math.abs(Math.round(amountMinor)) % 100;
  return tail === 2 ? 'decline:generic' : tail === 5 ? 'decline:insufficient_funds' : tail === 12 ? '3ds_fail' : tail === 99 ? 'pending_then_success' : null;
}

// ---------------- currencies ----------------

/** ISO 4217 minor-unit digits of the currencies devhub knows. */
export const CURRENCY_DIGITS: Record<string, number> = {
  SAR: 2, AED: 2, QAR: 2, EGP: 2, MAD: 2, USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SGD: 2, HKD: 2, CNY: 2, INR: 2, PKR: 2,
  TRY: 2, ZAR: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, RON: 2, MXN: 2, BRL: 2, MYR: 2, THB: 2, PHP: 2, IDR: 2, NGN: 2, KES: 2,
  LBP: 2, ILS: 2, BDT: 2, LKR: 2, RUB: 2, UAH: 2,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, IQD: 3, TND: 3, LYD: 3,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, XOF: 0, XAF: 0, UGX: 0, PYG: 0, RWF: 0,
};

export const currencyDigits = (c: string): number | null => CURRENCY_DIGITS[String(c ?? '').toUpperCase()] ?? null;

/** Minor units → decimal string ("12.50" SAR, "1.250" KWD, "1250" JPY). Unknown currencies use 2 digits. */
export function toDecimal(minor: number, currency: string): string {
  const d = currencyDigits(currency) ?? 2;
  const neg = minor < 0;
  const s = String(Math.abs(Math.round(minor))).padStart(d + 1, '0');
  const v = d ? `${s.slice(0, -d)}.${s.slice(-d)}` : s;
  return neg ? `-${v}` : v;
}

/** Decimal input (number or string) → minor units, with how many digits it had (for the precision check). */
export function fromDecimal(v: unknown, currency: string): { minor: number; digits: number; ok: boolean } {
  const str = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) return { minor: NaN, digits: 0, ok: false };
  const d = currencyDigits(currency) ?? 2;
  const [, frac = ''] = str.split('.');
  const minor = Math.round(Number(str) * 10 ** d);
  return { minor, digits: frac.length, ok: Number.isFinite(minor) };
}

export function formatMoney(minor: number, currency: string): string {
  return `${toDecimal(minor, currency)} ${String(currency).toUpperCase()}`;
}

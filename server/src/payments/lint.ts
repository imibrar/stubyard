import type { LintFinding } from './repo.js';

/**
 * Payment integration checks ("would fail or hurt in production"). Own list, separate from the message content
 * checks in lint/checks.ts. Findings are stored on the payment (lint / lint_level) or, for requests that never
 * became a payment (a live key), kept per instance in memory.
 */
export const PAYMENT_LINT_CHECKS = [
  { id: 'pay.live-key', severity: 'error', title: 'Live key used', description: 'A live secret key (sk_live_…) reached stubyard: never put production credentials in a test setup.' },
  { id: 'pay.amount-zero', severity: 'error', title: 'Zero or negative amount', description: 'The amount is 0 or negative; real gateways reject it.' },
  { id: 'pay.amount-precision', severity: 'warn', title: 'Wrong decimal places', description: 'The amount has more decimals than the currency allows (SAR 2, KWD 3, JPY 0) or is not an integer in minor units.' },
  { id: 'pay.currency-unknown', severity: 'error', title: 'Unknown currency', description: 'The currency is not an ISO 4217 code stubyard knows.' },
  { id: 'pay.return-url-missing-or-bad', severity: 'error', title: 'Return URL missing or invalid', description: 'No success / return URL, or one that is not an absolute http(s) URL.' },
  { id: 'pay.no-webhook-url', severity: 'warn', title: 'No webhook URL', description: 'The instance has no webhook / callback URL: your app never hears about async results (refunds, pending payments, a closed tab).' },
  { id: 'pay.webhook-rejected', severity: 'warn', title: 'Webhook rejected', description: 'Your app answered a payment webhook with a non-2xx status (the gateway retries).' },
  { id: 'pay.no-idempotency-key', severity: 'info', title: 'No idempotency key', description: 'Create / capture calls without Idempotency-Key (Stripe) or PayPal-Request-Id: a network retry could charge twice.' },
  { id: 'pay.capture-before-approve', severity: 'error', title: 'Capture before approval', description: 'The app captured an order the buyer had not approved yet.' },
  { id: 'pay.double-capture', severity: 'error', title: 'Double capture', description: 'The app tried to capture an already captured payment.' },
  { id: 'pay.refund-exceeds', severity: 'error', title: 'Refund exceeds amount', description: 'The refund is larger than what is left to refund.' },
  { id: 'pay.no-reference', severity: 'warn', title: 'No order reference', description: 'No client_reference_id / metadata / reference_id / custom_id: hard to match the payment to your order.' },
  { id: 'pay.paypal-signature-never-verified', severity: 'warn', title: 'PayPal webhook never verified', description: 'PayPal webhooks were delivered but your app never called /v1/notifications/verify-webhook-signature.' },
  { id: 'pay.real-card-entered', severity: 'error', title: 'Real card number entered', description: 'A Luhn-valid card number that is not a test card was typed on the payment page (it was cleared in the browser; stubyard never received the digits).' },
] as const;

export type PaymentCheckId = (typeof PAYMENT_LINT_CHECKS)[number]['id'];

export function finding(check: PaymentCheckId, message: string): LintFinding {
  const c = PAYMENT_LINT_CHECKS.find((x) => x.id === check)!;
  return { check, severity: c.severity, message };
}

/** Findings merged without duplicates (same check + message). */
export function mergeFindings(a: LintFinding[], b: LintFinding[]): LintFinding[] {
  const out = [...a];
  for (const f of b) if (!out.some((x) => x.check === f.check && x.message === f.message)) out.push(f);
  return out;
}

/** The URL when it is an absolute http(s) URL, else null (never throws). */
export function httpUrl(u: unknown): string | null {
  if (u === undefined || u === null || u === '') return null;
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' || x.protocol === 'https:' ? String(u) : null;
  } catch {
    return null;
  }
}

/** For an optional URL param at create: null when absent or fine, else why it is rejected. */
export function rejectUrl(u: unknown): string | null {
  return u === undefined || u === null || u === '' ? null : badUrl(u);
}

/** A URL a gateway can redirect the buyer to (absolute http / https). */
export function badUrl(u: unknown): string | null {
  if (u === undefined || u === null || u === '') return 'missing';
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return `not http(s): ${String(u)}`;
    return null;
  } catch {
    return `not an absolute URL: ${String(u)}`;
  }
}

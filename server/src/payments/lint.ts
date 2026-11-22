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
  { id: 'pay.stripe-raw-card-data', severity: 'warn', title: 'Raw card data sent to Stripe', description: 'A card number / CVC was sent to the Stripe API (payment_method_data[card]): the real API refuses it by default. Use Stripe.js or test PaymentMethods (pm_card_visa).' },
  { id: 'pay.paypal-signature-never-verified', severity: 'warn', title: 'PayPal webhook never verified', description: 'PayPal webhooks were delivered but your app never called /v1/notifications/verify-webhook-signature.' },
  { id: 'pay.test-notice-hidden', severity: 'warn', title: 'Test notice hidden', description: 'The "TEST · stubyard simulator" notice of a payment page was hidden, cropped or moved off the page (for example a frame of your app that is too small, or CSS that covers it). The payment still went on; make the notice visible, because testers rely on it.' },
  { id: 'pay.hpp-framed', severity: 'warn', title: 'Hosted page framed', description: 'The provider\'s hosted payment page was opened inside an iframe (Sec-Fetch-Dest: iframe). Checkout.com\'s Hosted Payments Page and APS redirection refuse to be framed (X-Frame-Options / frame-ancestors), so the real page would stay blank: redirect the whole window instead. stubyard still shows the page.' },
  { id: 'pay.real-card-entered', severity: 'error', title: 'Real card number entered', description: 'A Luhn-valid card number that is not a test card was typed on the payment page (it was cleared in the browser; stubyard never received the digits), or sent to a gateway API (refused with 422 / 400).' },
  { id: 'pay.hyperpay-mada-entity', severity: 'error', title: 'mada on the wrong entity', description: 'HyperPay: a mada payment must be prepared with the mada entityId (and VISA / MASTER with the card entityId). The checkout used the other one.' },
  { id: 'pay.hyperpay-no-integrity', severity: 'warn', title: 'Widget without SRI', description: 'HyperPay: the checkout was prepared without integrity=true, or paymentWidgets.js was loaded without integrity + crossorigin="anonymous" (PCI DSS v4 script integrity).' },
  { id: 'pay.hyperpay-result-never-queried', severity: 'warn', title: 'Payment result never queried', description: 'HyperPay: the shopper came back to shopperResultUrl but your app never called GET {resourcePath} (/v1/checkouts/{id}/payment) to learn the result.' },
  { id: 'pay.hyperpay-result-overpolled', severity: 'warn', title: 'Payment status polled too often', description: 'HyperPay allows two payment-status requests per minute per checkout; your app asked more often.' },
  { id: 'pay.hyperpay-mada-missing-fields', severity: 'warn', title: 'mada checkout without required fields', description: 'HyperPay KSA: mada checkouts should carry merchantTransactionId, customer.email, customer.givenName / surname and billing.street1 / city / state / country / postcode.' },
  { id: 'pay.hyperpay-testmode-with-mada', severity: 'error', title: 'testMode on a mada checkout', description: 'HyperPay: do not send testMode=EXTERNAL / INTERNAL for mada (and never in production).' },
  { id: 'pay.paypal-client-side-create', severity: 'info', title: 'Order created in the browser', description: 'PayPal JS SDK: createOrder used actions.order.create() (client side). Create orders on your server so the amount cannot be changed by the buyer.' },
  { id: 'pay.paypal-approve-without-capture', severity: 'warn', title: 'Approved but never captured', description: 'PayPal: the buyer approved the order (onApprove) but your app never captured or authorized it.' },
  { id: 'pay.paypal-capture-without-liability-check', severity: 'info', title: 'Card captured without a 3-D Secure check', description: 'PayPal card payment with 3-D Secure: your app captured without reading payment_source.card.authentication_result (GET the order and check liability_shift first).' },
  { id: 'pay.moyasar-amount-unit', severity: 'warn', title: 'Amount in the wrong unit', description: 'Moyasar: amounts are integers in the smallest unit (100 = 1.00 SAR). An amount below one major unit usually means major units were sent.' },
  { id: 'pay.moyasar-card-on-server', severity: 'warn', title: 'Card number through your server', description: 'Moyasar: a creditcard source was posted with the secret key, so card data went through your backend. Use Moyasar Form / the publishable key from the browser, or a token.' },
  { id: 'pay.moyasar-payment-not-fetched', severity: 'warn', title: 'Payment never fetched', description: 'Moyasar: the payment finished but your app never called GET /v1/payments/:id; the callback_url query (status=paid) is not proof of payment.' },
  { id: 'pay.tap-redirect-missing', severity: 'error', title: 'No redirect URL', description: 'Tap: redirect.url is required for KNET, mada and 3-D Secure charges (error 1110 / 1111).' },
  { id: 'pay.tap-charge-not-retrieved', severity: 'warn', title: 'Charge never retrieved', description: 'Tap: the buyer came back with tap_id but your app never called GET /v2/charges/:id (or verified the hashstring of a webhook) to learn the status.' },
  { id: 'pay.tabby-not-captured', severity: 'warn', title: 'Tabby payment not captured', description: 'Tabby: the payment is AUTHORIZED but was never captured (POST /api/v2/payments/:id/captures); uncaptured payments are not paid out.' },
  { id: 'pay.tabby-amount-format', severity: 'warn', title: 'Amount not a decimal string', description: 'Tabby: payment.amount (and the order amounts) are strings with up to 2 decimals ("100.00"), not numbers or minor units.' },
  { id: 'pay.tamara-not-authorised', severity: 'warn', title: 'Tamara order not authorised', description: 'Tamara: the order was approved but your app never called POST /orders/:id/authorise (it expires after 72 hours without it).' },
  { id: 'pay.checkout-amount-invalid', severity: 'error', title: 'Amount invalid for the currency', description: 'Checkout.com: amounts are minor units; for 3-decimal currencies (KWD, BHD, OMR, JOD, IQD, LYD, TND) the last digit must be 0 (amount_invalid).' },
  { id: 'pay.checkout-key-without-bearer', severity: 'info', title: 'Secret key without Bearer', description: 'Checkout.com: send "Authorization: Bearer sk_sbox_…". A bare key only works for the previous (ABC) key format.' },
  { id: 'pay.aps-signature', severity: 'error', title: 'APS signature mismatch', description: 'Amazon Payment Services: a request\'s signature did not match (SHA-256 / SHA-512 / HMAC of the sorted name=value pairs wrapped in the SHA request phrase); APS answers 00008.' },
  { id: 'pay.aps-amount-unit', severity: 'warn', title: 'APS amount not in minor units', description: 'Amazon Payment Services: amount must be an integer in minor units (SAR 10.00 → 1000, KWD 1.000 → 1000); a decimal point or a tiny value usually means the major unit was sent.' },
  { id: 'pay.myfatoorah-items-mismatch', severity: 'warn', title: 'InvoiceItems do not add up', description: 'MyFatoorah: the sum of InvoiceItems (UnitPrice × Quantity) differs from InvoiceValue; the real API rejects the request.' },
  { id: 'pay.myfatoorah-status-never-checked', severity: 'warn', title: 'Payment status never checked', description: 'MyFatoorah: the buyer came back with ?paymentId= but your app never called GetPaymentStatus before trusting the result.' },
  { id: 'pay.geidea-signature', severity: 'error', title: 'Geidea signature mismatch', description: 'Geidea: the create-session or refund signature did not match (base64 HMAC-SHA256 with the API password).' },
  { id: 'pay.geidea-callback-not-https', severity: 'warn', title: 'Geidea callback URL not HTTPS', description: 'Geidea only calls HTTPS callback URLs; an http:// callbackUrl works in stubyard but not against the real gateway.' },
  { id: 'pay.jazzcash-secure-hash', severity: 'error', title: 'JazzCash pp_SecureHash mismatch', description: 'JazzCash: pp_SecureHash did not match (HMAC-SHA256 with the integrity salt over the salt and the sorted pp_ values joined with &); JazzCash answers 110.' },
  { id: 'pay.jazzcash-amount', severity: 'error', title: 'JazzCash amount or currency', description: 'JazzCash: pp_Amount must be PKR in paisa (rupees × 100, digits only); other currencies and decimal amounts are refused.' },
  { id: 'pay.jazzcash-never-inquired', severity: 'warn', title: 'JazzCash status never inquired', description: 'JazzCash: a transaction ended but your app never called PaymentInquiry/Inquire; the return form alone is not proof of payment.' },
  { id: 'pay.easypaisa-hash', severity: 'error', title: 'Easypaisa merchantHashedReq invalid', description: 'Easypaisa: merchantHashedReq did not decrypt with the hash key (AES/ECB/PKCS5Padding, base64) or did not match the posted fields.' },
  { id: 'pay.sdk-origin-unlisted', severity: 'info', title: 'SDK used from an unlisted origin', description: 'A stubyard fake SDK (Moyasar Form, GeideaCheckout, PayPal Buttons / Card Fields) ran on a page whose origin is not in the instance\'s SDK origins (config sdkOrigins) or the project\'s app origins. stubyard allowed it because no list is set; set one so only your app can use the frames, as the real providers bind publishable keys to domains.' },
  { id: 'pay.sdk-origin-refused', severity: 'error', title: 'SDK refused for this origin', description: 'A stubyard fake SDK frame was opened from an origin that is not in the instance\'s SDK origins (config sdkOrigins) or the project\'s app origins: the frame showed an error and posted nothing. Add the origin, or load the page from an allowed origin.' },
  { id: 'pay.geidea-sdk-session', severity: 'warn', title: 'GeideaCheckout with an unusable session', description: 'Geidea: startPayment() was called with an unknown, expired (15 min) or finished session id; onError fired. Create a new session for every payment attempt.' },
  { id: 'pay.easypaisa-ipn-not-fetched', severity: 'warn', title: 'Easypaisa IPN details never fetched', description: 'Easypaisa: the IPN was delivered but your app never fetched its url= parameter (or called inquire-transaction): the IPN call itself carries no status.' },
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

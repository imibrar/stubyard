// Provider contract (C1 §4): the Stripe API as the fake Stripe serves it (payments/stripe/index.ts, intents.ts).
// Hand-written from the Stripe API reference (https://docs.stripe.com/api, API version 2024-06-20 and later), not a
// vendored spec: only the endpoints stubyard simulates and the params a server integration sends. Bodies are
// form-encoded with bracket notation; top-level params are closed (additionalProperties: false, decision 5), as
// Stripe answers "Received unknown parameter" for anything else.

import type { JsonSchema } from '../../webhooks/schema.js';
import type { ContractIssue } from '../types.js';
import type { ProviderContract, ProviderOperation } from './index.js';

const SOURCE = 'https://docs.stripe.com/api';

const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
const open: JsonSchema = { type: 'object' };
const anyArray: JsonSchema = { type: 'array' };
/** Three-letter ISO code, lowercase (Stripe's reference: "in lowercase"). */
const currency: JsonSchema = { type: 'string', pattern: '^[a-z]{3}$' };
/** Smallest currency unit, a positive integer. */
const amount: JsonSchema = { type: 'integer', exclusiveMinimum: 0 };
const metadata: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } };
const expand: JsonSchema = { type: 'array', items: { type: 'string' } };
const strings: JsonSchema = { type: 'array', items: { type: 'string' } };
const enumOf = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });

const captureMethod = enumOf('automatic', 'automatic_async', 'manual');
const setupFutureUsage = enumOf('off_session', 'on_session');

/** A closed form body. */
const body = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties: { ...properties, expand },
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const listQuery = (extra: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: 'object',
  properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, starting_after: str, ending_before: str, expand, ...extra },
});
const expandQuery: JsonSchema = { type: 'object', properties: { expand } };

const priceData: JsonSchema = {
  type: 'object',
  required: ['currency'],
  properties: {
    currency,
    unit_amount: { type: 'integer', minimum: 0 },
    unit_amount_decimal: str,
    product: str,
    product_data: { type: 'object', required: ['name'], properties: { name: str, description: str, images: strings, metadata, tax_code: str }, additionalProperties: false },
    recurring: open,
    tax_behavior: enumOf('exclusive', 'inclusive', 'unspecified'),
  },
  additionalProperties: false,
};

const lineItem: JsonSchema = {
  type: 'object',
  properties: { price: str, price_data: priceData, quantity: { type: 'integer', minimum: 1 }, adjustable_quantity: open, tax_rates: strings, dynamic_tax_rates: strings },
  additionalProperties: false,
};

const intentShared: Record<string, JsonSchema> = {
  description: str,
  metadata,
  payment_method: str,
  payment_method_types: strings,
  payment_method_data: open,
  payment_method_options: open,
  receipt_email: str,
  setup_future_usage: setupFutureUsage,
  shipping: open,
  statement_descriptor: str,
  statement_descriptor_suffix: str,
};

const op = (method: string, path: string, operationId: string, parts: Partial<Pick<ProviderOperation, 'query' | 'body'>> = {}): ProviderOperation => ({
  method,
  path,
  operationId,
  encoding: 'form',
  ...parts,
  source: SOURCE,
});

const operations: ProviderOperation[] = [
  // Checkout Sessions
  op('POST', '/v1/checkout/sessions', 'PostCheckoutSessions', {
    body: body({
      mode: enumOf('payment', 'setup', 'subscription'),
      ui_mode: enumOf('hosted', 'embedded', 'embedded_page', 'custom'),
      success_url: str,
      cancel_url: str,
      return_url: str,
      redirect_on_completion: enumOf('always', 'if_required', 'never'),
      line_items: { type: 'array', items: lineItem },
      currency,
      client_reference_id: str,
      customer: str,
      customer_email: str,
      customer_creation: enumOf('always', 'if_required'),
      customer_update: open,
      metadata,
      payment_intent_data: { type: 'object', properties: { metadata, capture_method: captureMethod, setup_future_usage: setupFutureUsage, description: str, receipt_email: str } },
      payment_method_types: strings,
      payment_method_options: open,
      payment_method_collection: enumOf('always', 'if_required'),
      payment_method_configuration: str,
      locale: str,
      submit_type: enumOf('auto', 'book', 'donate', 'pay', 'subscribe'),
      expires_at: { type: 'integer' },
      allow_promotion_codes: bool,
      discounts: anyArray,
      billing_address_collection: enumOf('auto', 'required'),
      shipping_address_collection: open,
      shipping_options: anyArray,
      phone_number_collection: open,
      tax_id_collection: open,
      automatic_tax: open,
      consent_collection: open,
      custom_fields: anyArray,
      custom_text: open,
      invoice_creation: open,
      after_expiration: open,
      saved_payment_method_options: open,
      setup_intent_data: open,
      subscription_data: open,
    }),
  }),
  op('GET', '/v1/checkout/sessions', 'GetCheckoutSessions', { query: listQuery({ payment_intent: str, customer: str, status: enumOf('complete', 'expired', 'open'), created: open }) }),
  op('GET', '/v1/checkout/sessions/{session}', 'GetCheckoutSessionsSession', { query: expandQuery }),
  op('GET', '/v1/checkout/sessions/{session}/line_items', 'GetCheckoutSessionsSessionLineItems', { query: listQuery() }),
  op('POST', '/v1/checkout/sessions/{session}/expire', 'PostCheckoutSessionsSessionExpire', { body: body({}) }),

  // PaymentIntents
  op('POST', '/v1/payment_intents', 'PostPaymentIntents', {
    body: body(
      {
        ...intentShared,
        amount,
        currency,
        capture_method: captureMethod,
        confirm: bool,
        confirmation_method: enumOf('automatic', 'manual'),
        customer: str,
        automatic_payment_methods: { type: 'object', required: ['enabled'], properties: { enabled: bool, allow_redirects: enumOf('always', 'never') }, additionalProperties: false },
        return_url: str,
        off_session: { type: ['boolean', 'string'] },
        error_on_requires_action: bool,
        mandate: str,
        mandate_data: open,
        on_behalf_of: str,
        transfer_data: open,
        transfer_group: str,
        application_fee_amount: { type: 'integer', minimum: 0 },
        use_stripe_sdk: bool,
      },
      ['amount', 'currency'],
    ),
  }),
  op('GET', '/v1/payment_intents', 'GetPaymentIntents', { query: listQuery({ customer: str, created: open }) }),
  op('GET', '/v1/payment_intents/{intent}', 'GetPaymentIntentsIntent', { query: { type: 'object', properties: { expand, client_secret: str } } }),
  op('POST', '/v1/payment_intents/{intent}', 'PostPaymentIntentsIntent', {
    body: body({
      ...intentShared,
      amount,
      currency,
      capture_method: captureMethod,
      customer: str,
      transfer_data: open,
      transfer_group: str,
      application_fee_amount: { type: 'integer', minimum: 0 },
    }),
  }),
  op('POST', '/v1/payment_intents/{intent}/confirm', 'PostPaymentIntentsIntentConfirm', {
    body: body({
      ...intentShared,
      capture_method: captureMethod,
      return_url: str,
      off_session: { type: ['boolean', 'string'] },
      error_on_requires_action: bool,
      mandate: str,
      mandate_data: open,
      use_stripe_sdk: bool,
    }),
  }),
  op('POST', '/v1/payment_intents/{intent}/capture', 'PostPaymentIntentsIntentCapture', {
    body: body({
      amount_to_capture: amount,
      metadata,
      final_capture: bool,
      statement_descriptor: str,
      statement_descriptor_suffix: str,
      application_fee_amount: { type: 'integer', minimum: 0 },
      transfer_data: open,
    }),
  }),
  op('POST', '/v1/payment_intents/{intent}/cancel', 'PostPaymentIntentsIntentCancel', {
    body: body({ cancellation_reason: enumOf('abandoned', 'duplicate', 'fraudulent', 'requested_by_customer') }),
  }),
  op('GET', '/v1/payment_methods/{payment_method}', 'GetPaymentMethodsPaymentMethod', { query: expandQuery }),

  // Charges, refunds, events
  op('GET', '/v1/charges/{charge}', 'GetChargesCharge', { query: expandQuery }),
  op('POST', '/v1/refunds', 'PostRefunds', {
    body: body({
      payment_intent: str,
      charge: str,
      amount,
      reason: enumOf('duplicate', 'fraudulent', 'requested_by_customer'),
      metadata,
      refund_application_fee: bool,
      reverse_transfer: bool,
      instructions_email: str,
      origin: enumOf('customer_balance'),
    }),
  }),
  op('GET', '/v1/refunds/{refund}', 'GetRefundsRefund', { query: expandQuery }),
  op('GET', '/v1/events/{id}', 'GetEventsId', { query: expandQuery }),
];

/** "/line_items/0/price_data/currency" → "line_items[0][price_data][currency]". */
function paramOf(i: ContractIssue): string | undefined {
  if (i.where !== 'body') return i.name;
  const parts = (i.pointer ?? '').split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length) return undefined;
  return parts[0] + parts.slice(1).map((p) => `[${p}]`).join('');
}

/** The first error as Stripe's invalid_request_error (Stripe reports one error per request). */
function strictError(issues: ContractIssue[]): { status: number; body: unknown } {
  const first = issues.find((i) => i.severity === 'error') ?? issues[0];
  const param = first ? paramOf(first) : undefined;
  let code: string | undefined;
  let message: string;
  if (!first) message = 'Invalid request.';
  else if (first.check === 'contract.content-type') {
    message = 'Invalid request (check that your POST content type is application/x-www-form-urlencoded).';
  } else if (first.check === 'contract.unknown-param' || /unexpected property/.test(first.message)) {
    code = 'parameter_unknown';
    message = `Received unknown parameter: ${param}`;
  } else if (/missing required property|is required/.test(first.message)) {
    code = 'parameter_missing';
    message = `Missing required param: ${param}.`;
  } else if (/integer|must be >/.test(first.message)) {
    code = 'parameter_invalid_integer';
    message = /integer/.test(first.message) ? `Invalid integer: ${first.actual ?? ''}` : `Invalid ${param}: ${first.message.replace(/^\S+\s+/, '')}`;
  } else {
    message = `Invalid ${param ?? 'request'}: ${first.message.replace(/^\/\S*\s+/, '')}`;
  }
  return {
    status: 400,
    body: { error: { type: 'invalid_request_error', ...(code ? { code } : {}), message, ...(param ? { param } : {}), doc_url: `${SOURCE}/errors` } },
  };
}

export const stripeContract: ProviderContract = {
  preset: 'stripe-checkout',
  title: 'Stripe API',
  version: '2024-06-20',
  operations,
  closed: true,
  // Secret-key (server) calls only: Stripe.js's own publishable-key calls come from the fake SDK, not the app.
  skip: (req) => !req.headers.authorization,
  strictError,
};

// Provider contract (C1 §4): the PayPal REST API as the fake PayPal serves it (payments/paypal/index.ts, expanded.ts,
// subscriptions.ts, disputes.ts). Hand-written from the PayPal API reference (https://developer.paypal.com/api/rest/,
// Orders v2, Payments v2, Subscriptions v1, Disputes v1), not a vendored spec: only the endpoints stubyard simulates
// and the fields a server integration sends. Bodies are JSON and open (PayPal ignores fields it does not know);
// the OAuth token call is form-encoded. The JS SDK's own browser calls (/sdk/…) are not covered.
//
// Card data: payment_source.card is left as a plain object, so a card number or security_code never lands in an
// issue's `actual` (the validator masks card-like digit runs but does not know "security_code").

import { alnum } from '../../payments/common.js';
import type { JsonSchema } from '../../webhooks/schema.js';
import type { ContractIssue } from '../types.js';
import type { ProviderContract, ProviderOperation } from './index.js';

const SOURCE = 'https://developer.paypal.com/api/rest/';

const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
const open: JsonSchema = { type: 'object' };
const uri: JsonSchema = { type: 'string', format: 'uri' };
const dateTime: JsonSchema = { type: 'string', format: 'date-time' };
const enumOf = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });
const strLen = (max: number, min = 1): JsonSchema => ({ type: 'string', minLength: min, maxLength: max });

/** ISO 4217, three upper-case letters. */
const currencyCode: JsonSchema = { type: 'string', pattern: '^[A-Z]{3}$' };
/** PayPal money: { currency_code, value } with value a decimal string ("10.00", "1000"). */
const decimal: JsonSchema = { type: 'string', pattern: '^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$', maxLength: 32 };
const moneyProps = { currency_code: currencyCode, value: decimal };
const money: JsonSchema = { type: 'object', required: ['currency_code', 'value'], properties: moneyProps };
const experienceContext: JsonSchema = {
  type: 'object',
  properties: {
    return_url: uri,
    cancel_url: uri,
    brand_name: strLen(127),
    locale: str,
    landing_page: enumOf('LOGIN', 'GUEST_ONLY', 'NO_PREFERENCE'),
    shipping_preference: enumOf('GET_FROM_FILE', 'NO_SHIPPING', 'SET_PROVIDED_ADDRESS'),
    user_action: enumOf('CONTINUE', 'PAY_NOW'),
    payment_method_preference: enumOf('UNRESTRICTED', 'IMMEDIATE_PAYMENT_REQUIRED'),
  },
};

const purchaseUnit: JsonSchema = {
  type: 'object',
  required: ['amount'],
  properties: {
    reference_id: strLen(256),
    description: strLen(127),
    custom_id: strLen(255),
    invoice_id: strLen(127),
    soft_descriptor: strLen(22),
    amount: { type: 'object', required: ['currency_code', 'value'], properties: { ...moneyProps, breakdown: open } },
    payee: open,
    payment_instruction: open,
    items: { type: 'array', items: { type: 'object', required: ['name', 'quantity', 'unit_amount'], properties: { name: strLen(127), quantity: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' }, unit_amount: money, tax: money, sku: strLen(127), category: enumOf('DIGITAL_GOODS', 'PHYSICAL_GOODS', 'DONATION') } } },
    shipping: open,
  },
};

const json = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const pageQuery = (extra: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: 'object',
  properties: { page_size: { type: 'integer', minimum: 1, maximum: 20 }, page: { type: 'integer', minimum: 1, maximum: 100000 }, total_required: bool, ...extra },
});

const op = (method: string, path: string, operationId: string, parts: Partial<Pick<ProviderOperation, 'query' | 'body' | 'encoding'>> = {}): ProviderOperation => ({
  method,
  path,
  operationId,
  encoding: 'json',
  ...parts,
  source: SOURCE,
});

const captureBody = json({ invoice_id: strLen(127), note_to_payer: strLen(255), final_capture: bool, soft_descriptor: strLen(22), amount: money, payment_instruction: open });
const reasonBody = (required: boolean) => json({ reason: strLen(128) }, required ? ['reason'] : []);

const operations: ProviderOperation[] = [
  // OAuth 2.0
  op('POST', '/v1/oauth2/token', 'OAuth2Token', {
    encoding: 'form',
    body: { type: 'object', required: ['grant_type'], properties: { grant_type: enumOf('client_credentials', 'refresh_token', 'authorization_code'), refresh_token: str, code: str, response_type: str, target_customer_id: str } },
  }),

  // Orders v2
  op('POST', '/v2/checkout/orders', 'orders.create', {
    body: json(
      {
        intent: enumOf('CAPTURE', 'AUTHORIZE'),
        purchase_units: { type: 'array', minItems: 1, maxItems: 10, items: purchaseUnit },
        payment_source: {
          type: 'object',
          properties: {
            paypal: { type: 'object', properties: { experience_context: experienceContext, email_address: { type: 'string', format: 'email' }, vault_id: str, attributes: open } },
            card: open,
            token: open,
            venmo: open,
            apple_pay: open,
            google_pay: open,
          },
        },
        payer: open,
        application_context: experienceContext,
      },
      ['intent', 'purchase_units'],
    ),
  }),
  op('GET', '/v2/checkout/orders/{id}', 'orders.get', { query: { type: 'object', properties: { fields: str } } }),
  op('POST', '/v2/checkout/orders/{id}/capture', 'orders.capture', { body: json({ payment_source: open }) }),
  op('POST', '/v2/checkout/orders/{id}/authorize', 'orders.authorize', { body: json({ payment_source: open }) }),

  // Payments v2
  op('GET', '/v2/payments/authorizations/{authorization_id}', 'authorizations.get'),
  op('POST', '/v2/payments/authorizations/{authorization_id}/capture', 'authorizations.capture', { body: captureBody }),
  op('POST', '/v2/payments/authorizations/{authorization_id}/void', 'authorizations.void'),
  op('POST', '/v2/payments/authorizations/{authorization_id}/reauthorize', 'authorizations.reauthorize', { body: json({ amount: money }) }),
  op('GET', '/v2/payments/captures/{capture_id}', 'captures.get'),
  op('POST', '/v2/payments/captures/{capture_id}/refund', 'captures.refund', {
    body: json({ amount: money, custom_id: strLen(127), invoice_id: strLen(127), note_to_payer: strLen(255), payment_instruction: open }),
  }),
  op('GET', '/v2/payments/refunds/{refund_id}', 'refunds.get'),

  // Catalog products, billing plans, subscriptions (v1)
  op('POST', '/v1/catalogs/products', 'products.create', {
    body: json(
      { id: { type: 'string', minLength: 6, maxLength: 50 }, name: strLen(127), description: strLen(256), type: enumOf('PHYSICAL', 'DIGITAL', 'SERVICE'), category: str, image_url: uri, home_url: uri },
      ['name', 'type'],
    ),
  }),
  op('GET', '/v1/catalogs/products', 'products.list', { query: pageQuery() }),
  op('GET', '/v1/catalogs/products/{product_id}', 'products.get'),
  op('POST', '/v1/billing/plans', 'plans.create', {
    body: json(
      {
        product_id: strLen(50, 6),
        name: strLen(127),
        status: enumOf('CREATED', 'INACTIVE', 'ACTIVE'),
        description: strLen(127),
        billing_cycles: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            required: ['frequency', 'tenure_type', 'sequence'],
            properties: {
              frequency: { type: 'object', required: ['interval_unit'], properties: { interval_unit: enumOf('DAY', 'WEEK', 'MONTH', 'YEAR'), interval_count: { type: 'integer', minimum: 1, maximum: 365 } } },
              tenure_type: enumOf('REGULAR', 'TRIAL'),
              sequence: { type: 'integer', minimum: 1, maximum: 99 },
              total_cycles: { type: 'integer', minimum: 0, maximum: 999 },
              pricing_scheme: { type: 'object', properties: { fixed_price: money, pricing_model: enumOf('VOLUME', 'TIERED'), tiers: { type: 'array' } } },
            },
          },
        },
        payment_preferences: {
          type: 'object',
          properties: { auto_bill_outstanding: bool, setup_fee: money, setup_fee_failure_action: enumOf('CONTINUE', 'CANCEL'), payment_failure_threshold: { type: 'integer', minimum: 0, maximum: 999 } },
        },
        taxes: { type: 'object', required: ['percentage'], properties: { percentage: decimal, inclusive: bool } },
        quantity_supported: bool,
      },
      ['product_id', 'name', 'billing_cycles', 'payment_preferences'],
    ),
  }),
  op('GET', '/v1/billing/plans', 'plans.list', { query: pageQuery({ product_id: str, plan_ids: str }) }),
  op('GET', '/v1/billing/plans/{id}', 'plans.get'),
  op('POST', '/v1/billing/plans/{id}/activate', 'plans.activate'),
  op('POST', '/v1/billing/plans/{id}/deactivate', 'plans.deactivate'),
  op('POST', '/v1/billing/subscriptions', 'subscriptions.create', {
    body: json(
      {
        plan_id: strLen(50, 3),
        start_time: dateTime,
        quantity: { type: 'string', pattern: '^[1-9][0-9]{0,31}$' },
        shipping_amount: money,
        subscriber: open,
        auto_renewal: bool,
        custom_id: strLen(127),
        plan: open,
        application_context: experienceContext,
      },
      ['plan_id'],
    ),
  }),
  op('GET', '/v1/billing/subscriptions/{id}', 'subscriptions.get', { query: { type: 'object', properties: { fields: str } } }),
  op('POST', '/v1/billing/subscriptions/{id}/cancel', 'subscriptions.cancel', { body: reasonBody(true) }),
  op('POST', '/v1/billing/subscriptions/{id}/suspend', 'subscriptions.suspend', { body: reasonBody(true) }),
  op('POST', '/v1/billing/subscriptions/{id}/activate', 'subscriptions.activate', { body: reasonBody(false) }),
  op('POST', '/v1/billing/subscriptions/{id}/capture', 'subscriptions.capture', {
    body: json({ note: strLen(128), capture_type: enumOf('OUTSTANDING_BALANCE'), amount: money }, ['note', 'capture_type', 'amount']),
  }),
  op('GET', '/v1/billing/subscriptions/{id}/transactions', 'subscriptions.transactions', {
    query: { type: 'object', required: ['start_time', 'end_time'], properties: { start_time: dateTime, end_time: dateTime } },
  }),

  // Disputes (v1)
  op('GET', '/v1/customer/disputes', 'disputes.list', {
    query: { type: 'object', properties: { start_time: dateTime, disputed_transaction_id: str, page_size: { type: 'integer', minimum: 1, maximum: 50 }, next_page_token: str, dispute_state: str, update_time_before: dateTime, update_time_after: dateTime } },
  }),
  op('GET', '/v1/customer/disputes/{id}', 'disputes.get'),
];

const DESCRIPTION: Record<string, string> = {
  MISSING_REQUIRED_PARAMETER: 'A required field / parameter is missing.',
  INVALID_PARAMETER_VALUE: 'The value of a field is invalid.',
  INVALID_PARAMETER_SYNTAX: 'The value of a field does not conform to the expected format.',
  INVALID_STRING_LENGTH: 'The value of a field is either too short or too long.',
  INVALID_ARRAY_MIN_ITEMS: 'The number of items in an array parameter is too small.',
  INVALID_ARRAY_MAX_ITEMS: 'The number of items in an array parameter is too large.',
  INVALID_INTEGER_MIN_VALUE: 'The integer value of a field is too small.',
  INVALID_INTEGER_MAX_VALUE: 'The integer value of a field is too large.',
  MALFORMED_REQUEST_JSON: 'The request JSON is not well formed.',
};

/** PayPal's issue code for one contract issue. */
function issueOf(i: ContractIssue): string {
  const m = i.message;
  if (i.check === 'contract.content-type' || /not valid JSON/.test(m)) return 'MALFORMED_REQUEST_JSON';
  if (i.check === 'contract.body-missing' || /missing required property|is required/.test(m)) return 'MISSING_REQUIRED_PARAMETER';
  if (/must be one of|must be "/.test(m)) return 'INVALID_PARAMETER_VALUE';
  if (/characters/.test(m)) return 'INVALID_STRING_LENGTH';
  if (/at least \d+ items/.test(m)) return 'INVALID_ARRAY_MIN_ITEMS';
  if (/at most \d+ items/.test(m)) return 'INVALID_ARRAY_MAX_ITEMS';
  if (/must be >/.test(m)) return 'INVALID_INTEGER_MIN_VALUE';
  if (/must be </.test(m)) return 'INVALID_INTEGER_MAX_VALUE';
  return 'INVALID_PARAMETER_SYNTAX';
}

const debugId = () => alnum(13).toLowerCase();

/** PayPal answers 400 INVALID_REQUEST with every schema problem in `details` (the OAuth call: an OAuth error). */
function strictError(issues: ContractIssue[], o: ProviderOperation): { status: number; body: unknown } {
  const errors = issues.filter((i) => i.severity === 'error');
  if (o.operationId === 'OAuth2Token') {
    const grant = errors.find((i) => i.pointer === '/grant_type' && !/missing required/.test(i.message));
    return { status: 400, body: grant ? { error: 'unsupported_grant_type', error_description: `Grant Type is not supported: ${grant.actual ?? ''}` } : { error: 'invalid_request', error_description: 'grant_type is null or empty' } };
  }
  const details = errors.map((i) => {
    const issue = issueOf(i);
    const location = i.where === 'query' ? 'query' : i.where === 'path' ? 'path' : i.where === 'header' || i.where === 'content-type' ? 'header' : 'body';
    const field = i.where === 'body' ? i.pointer || '/' : i.name ?? (i.where === 'content-type' ? 'Content-Type' : '/');
    return { field, ...(i.actual !== undefined && issue !== 'MISSING_REQUIRED_PARAMETER' ? { value: i.actual } : {}), location, issue, description: DESCRIPTION[issue] };
  });
  return {
    status: 400,
    body: {
      name: 'INVALID_REQUEST',
      message: 'Request is not well-formed, syntactically incorrect, or violates schema.',
      debug_id: debugId(),
      details,
      links: [{ href: 'https://developer.paypal.com/api/rest/reference/orders/v2/errors/#INVALID_REQUEST', rel: 'information_link', encType: 'application/json' }],
    },
  };
}

export const paypalContract: ProviderContract = {
  preset: 'paypal',
  title: 'PayPal REST API',
  version: 'v2',
  operations,
  // The fake JS SDK's browser calls (/sdk/…) are stubyard's own, not the app's.
  skip: (req) => req.path.startsWith('/sdk/'),
  strictError,
};

// Provider contract (C1 §4): the Moyasar API v1 as the fake Moyasar serves it (payments/moyasar/index.ts). Hand-written
// from the Moyasar API reference (https://docs.moyasar.com/api), not a vendored spec: payments (create, fetch, list,
// refund, capture, void) and invoices (create, fetch, list, cancel). Webhook registration is not covered.
//
// Moyasar takes JSON or form bodies; the contract describes the JSON one and form-encoded requests are skipped (the
// fake still checks them). Card data: source.number errors carry the masked number only and source.cvc is a secret
// name for the validator, so neither value lands in an issue's `actual`.

import type { JsonSchema } from '../../webhooks/schema.js';
import type { ContractIssue } from '../types.js';
import type { ProviderContract, ProviderOperation } from './index.js';

const SOURCE = 'https://docs.moyasar.com/api';

const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: ['boolean', 'string'], enum: [true, false, 'true', 'false'] };
const uri: JsonSchema = { type: 'string', format: 'uri' };
const metadata: JsonSchema = { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } };
/** Smallest currency unit (halalas for SAR), a positive integer. */
const amount: JsonSchema = { type: 'integer', exclusiveMinimum: 0 };
/** ISO 4217, three upper-case letters (Moyasar's default is SAR). */
const currency: JsonSchema = { type: 'string', pattern: '^[A-Z]{3}$' };
const intOrDigits = (min: number, max: number, digits: string): JsonSchema => ({
  anyOf: [
    { type: 'integer', minimum: min, maximum: max },
    { type: 'string', pattern: digits },
  ],
});

const SOURCE_TYPES = ['creditcard', 'token', 'applepay', 'stcpay', 'samsungpay'];
const whenType = (type: string, then: JsonSchema): JsonSchema => ({ if: { type: 'object', required: ['type'], properties: { type: { const: type } } }, then });

const paymentSource: JsonSchema = {
  type: 'object',
  required: ['type'],
  properties: { type: { type: 'string', enum: SOURCE_TYPES }, manual: bool, '3ds': bool, statement_descriptor: str },
  allOf: [
    whenType('creditcard', {
      required: ['name', 'number', 'month', 'year', 'cvc'],
      properties: {
        name: { type: 'string', minLength: 1 },
        number: { type: 'string', pattern: '^[0-9 ]{12,23}$' },
        month: intOrDigits(1, 12, '^(0?[1-9]|1[0-2])$'),
        year: intOrDigits(2000, 9999, '^[0-9]{2,4}$'),
        cvc: intOrDigits(0, 9999, '^[0-9]{3,4}$'),
      },
    }),
    whenType('token', { required: ['token'], properties: { token: { type: 'string', pattern: '^token_' } } }),
    whenType('applepay', { required: ['token'], properties: { token: str } }),
    whenType('samsungpay', { required: ['token'], properties: { token: str } }),
    whenType('stcpay', { required: ['mobile'], properties: { mobile: { type: 'string', pattern: '^(\\+?966|0)?5[0-9]{8}$' }, cashier: str, branch: str } }),
  ],
};

const op = (method: string, path: string, operationId: string, parts: Partial<Pick<ProviderOperation, 'query' | 'body'>> = {}): ProviderOperation => ({
  method,
  path,
  operationId,
  encoding: 'json',
  ...parts,
  source: SOURCE,
});

const listQuery = (extra: Record<string, JsonSchema> = {}): JsonSchema => ({ type: 'object', properties: { page: { type: 'integer', minimum: 1 }, id: str, status: str, ...extra } });
const amountBody: JsonSchema = { type: 'object', properties: { amount } };

const operations: ProviderOperation[] = [
  op('POST', '/v1/payments', 'CreatePayment', {
    body: {
      type: 'object',
      required: ['amount', 'source'],
      properties: {
        amount,
        currency,
        description: str,
        callback_url: uri,
        given_id: { type: 'string', format: 'uuid' },
        metadata,
        apply_coupon: bool,
        source: paymentSource,
      },
      // creditcard and token payments go through 3-D Secure: Moyasar needs the callback_url to return to.
      allOf: [{ if: { type: 'object', required: ['source'], properties: { source: { type: 'object', required: ['type'], properties: { type: { enum: ['creditcard', 'token'] } } } } }, then: { required: ['callback_url'] } }],
    },
  }),
  op('GET', '/v1/payments', 'ListPayments', { query: listQuery({ created: str, updated: str }) }),
  op('GET', '/v1/payments/{id}', 'FetchPayment'),
  op('POST', '/v1/payments/{id}/refund', 'RefundPayment', { body: { type: 'object', properties: { amount, description: str } } }),
  op('POST', '/v1/payments/{id}/capture', 'CapturePayment', { body: amountBody }),
  op('POST', '/v1/payments/{id}/void', 'VoidPayment'),

  op('POST', '/v1/invoices', 'CreateInvoice', {
    body: {
      type: 'object',
      required: ['amount', 'currency', 'description'],
      properties: { amount, currency, description: { type: 'string', minLength: 1 }, callback_url: uri, success_url: uri, back_url: uri, expired_at: { type: 'string', format: 'date-time' }, metadata },
    },
  }),
  op('GET', '/v1/invoices', 'ListInvoices', { query: listQuery() }),
  op('GET', '/v1/invoices/{id}', 'FetchInvoice'),
  op('PUT', '/v1/invoices/{id}/cancel', 'CancelInvoice'),
];

/** "/source/number" → "source.number" (Moyasar's error keys). */
function fieldOf(i: ContractIssue): string {
  if (i.where !== 'body') return i.name ?? (i.where === 'content-type' ? 'content_type' : 'base');
  const parts = (i.pointer ?? '').split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  return parts.length ? parts.join('.') : 'base';
}

/** One issue as a Moyasar validation message ("is required", "must be an integer"). */
function messageOf(i: ContractIssue): string {
  const m = i.message;
  if (i.check === 'contract.content-type') return 'must be application/json';
  if (/not valid JSON/.test(m)) return 'is not valid JSON';
  if (i.check === 'contract.body-missing' || /missing required property|is required/.test(m)) return 'is required';
  if (/must be integer/.test(m)) return 'must be an integer';
  if (/must be > 0/.test(m)) return 'must be greater than 0';
  if (/must be one of/.test(m) || /must be a valid|must match pattern|allowed shape/.test(m)) return 'is invalid';
  return m.replace(/^\/\S*\s+/, '');
}

/** Moyasar answers 400 "Validation Failed" with the messages per field. */
function strictError(issues: ContractIssue[]): { status: number; body: unknown } {
  const errors: Record<string, string[]> = {};
  for (const i of issues) {
    if (i.severity !== 'error') continue;
    const f = fieldOf(i);
    const msg = messageOf(i);
    const list = (errors[f] ??= []);
    if (!list.includes(msg)) list.push(msg);
  }
  return { status: 400, body: { type: 'invalid_request_error', message: 'Validation Failed', errors } };
}

export const moyasarContract: ProviderContract = {
  preset: 'moyasar',
  title: 'Moyasar API',
  version: 'v1',
  operations,
  // Form-encoded bodies are valid Moyasar requests too; the contract covers the JSON form.
  skip: (req) => /x-www-form-urlencoded|multipart\//i.test(req.contentType ?? ''),
  strictError,
};

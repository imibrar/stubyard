import { createHmac } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bodyOf, digits, header } from '../common.js';
import { currencyDigits, formatMoney, fromDecimal, normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';

/**
 * Fake MyFatoorah API v2 under /pay/<project>/<instance>/…: SendPayment (invoice link, optional e-mail / SMS to the
 * test user's inbox), InitiatePayment (method list), ExecutePayment (method-specific payment URL), GetPaymentStatus,
 * MakeRefund, GetRefundStatus, the invoice / payment pages, the browser return to CallBackUrl / ErrorUrl with
 * ?paymentId= and webhooks v1 (default) or v2 with the "MyFatoorah-Signature" header (base64 HMAC-SHA256).
 */

class MfError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: { Name: string; Error: string }[] | null = null,
  ) {
    super(message);
  }
}
const invalid = (name: string, error: string) => new MfError(400, 'Invalid data', [{ Name: name, Error: error }]);

export const MF_COUNTRIES: Record<string, { currency: string; methods: PaymentMethod[] }> = {
  KWT: { currency: 'KWD', methods: ['knet', 'card', 'applepay'] },
  SAU: { currency: 'SAR', methods: ['mada', 'card', 'applepay', 'stcpay'] },
  ARE: { currency: 'AED', methods: ['card', 'applepay'] },
  QAT: { currency: 'QAR', methods: ['card', 'applepay'] },
  BHR: { currency: 'BHD', methods: ['benefit', 'card', 'applepay'] },
  OMN: { currency: 'OMR', methods: ['card', 'applepay'] },
  JOD: { currency: 'JOD', methods: ['card', 'applepay'] },
  EGY: { currency: 'EGP', methods: ['card', 'applepay'] },
};
const countryOf = (inst: PaymentInstance) => (MF_COUNTRIES[String(inst.config.country ?? '').toUpperCase()] ? String(inst.config.country).toUpperCase() : 'KWT');

/** InitiatePayment methods: id, code, English name, stubyard method (kn / vm / ap are in MyFatoorah's samples). */
export const MF_METHODS: { id: number; code: string; en: string; ar: string; method: PaymentMethod; gateway: string }[] = [
  { id: 1, code: 'kn', en: 'KNET', ar: 'كي نت', method: 'knet', gateway: 'KNET' },
  { id: 2, code: 'vm', en: 'VISA/MASTER', ar: 'فيزا / ماستر', method: 'card', gateway: 'VISA/MASTER' },
  { id: 6, code: 'md', en: 'MADA', ar: 'مدى', method: 'mada', gateway: 'MADA' },
  { id: 5, code: 'b', en: 'Benefit', ar: 'بنفت', method: 'benefit', gateway: 'BENEFIT' },
  { id: 11, code: 'ap', en: 'Apple Pay', ar: 'أبل الدفع', method: 'applepay', gateway: 'Apple Pay' },
  { id: 14, code: 'stc', en: 'STC Pay', ar: 'STC Pay', method: 'stcpay', gateway: 'STC Pay' },
];
const methodInfo = (m: PaymentMethod | null) => MF_METHODS.find((x) => x.method === m) ?? MF_METHODS[1]!;

/** base64(HMAC-SHA256(secret, text)). */
const hmac64 = (secret: string, text: string) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(text, 'utf8')).digest('base64');
const pairText = (pairs: [string, unknown][]) => pairs.map(([k, v]) => k + '=' + (v === null || v === undefined ? '' : String(v))).join(',');

/** Webhook v1 signature: the Data properties sorted by name, "Name=value" joined by ",", null → "", base64 HMAC-SHA256. */
export function myfatoorahSignatureV1(data: Record<string, unknown>, secret: string, opts: { exclude?: string[] } = {}): string {
  const keys = Object.keys(data)
    .filter((k) => !(opts.exclude ?? []).includes(k) && (data[k] === null || typeof data[k] !== 'object'))
    .sort();
  return hmac64(secret, pairText(keys.map((k) => [k, data[k]])));
}

/** Webhook v2 signature: the documented dotted keys in the documented order (payment or refund event). */
export function myfatoorahSignatureV2(body: { Event: { Code: number }; Data: Record<string, any> }, secret: string): string {
  const d = body.Data;
  const pairs: [string, unknown][] =
    body.Event.Code === 2
      ? [
          ['Refund.Id', d.Refund?.Id],
          ['Refund.Status', d.Refund?.Status],
          ['Amount.ValueInBaseCurrency', d.Amount?.ValueInBaseCurrency],
          ['ReferencedInvoice.Id', d.ReferencedInvoice?.Id],
        ]
      : [
          ['Invoice.Id', d.Invoice?.Id],
          ['Invoice.Status', d.Invoice?.Status],
          ['Transaction.Status', d.Transaction?.Status],
          ['Transaction.PaymentId', d.Transaction?.PaymentId],
          ['Invoice.ExternalIdentifier', d.Invoice?.ExternalIdentifier],
        ];
  return hmac64(secret, pairText(pairs));
}

/** ddMMyyyyHHmmss (MyFatoorah webhook v1 dates). */
function mfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + p(d.getUTCMonth() + 1) + d.getUTCFullYear() + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

function invoiceStatus(p: Payment): string {
  if (['paid', 'partially_refunded', 'refunded'].includes(p.status)) return 'Paid';
  if (p.status === 'cancelled' || p.status === 'expired') return 'Canceled';
  return 'Pending';
}
/** InvoiceTransactions[].TransactionStatus (MyFatoorah really serves "Succss"). */
function txStatus(p: Payment): string | null {
  if (['paid', 'partially_refunded', 'refunded'].includes(p.status)) return 'Succss';
  if (p.status === 'authorized') return p.providerData.async ? 'InProgress' : 'Succss';
  if (p.status === 'failed') return 'Failed';
  if (p.status === 'cancelled') return 'Canceled';
  return p.method ? 'InProgress' : null;
}
/** Webhook TransactionStatus (SUCCESS / FAILED / CANCELED / AUTHORIZE). */
function hookStatus(p: Payment): string {
  if (p.status === 'authorized' && !p.providerData.async && p.providerData.autoCapture === false) return 'AUTHORIZE';
  if (p.status === 'failed') return 'FAILED';
  if (p.status === 'cancelled' || p.status === 'expired') return 'CANCELED';
  return 'SUCCESS';
}

/** Decline reasons → ErrorCode / Error of the failed transaction (MF001 / MF006 are MyFatoorah's; the rest are stubyard's). */
export const MF_ERRORS: Record<string, [string, string]> = {
  generic: ['MF020', 'Transaction declined'],
  insufficient_funds: ['MF002', 'Insufficient funds'],
  expired_card: ['MF003', 'Expired card'],
  incorrect_cvc: ['MF004', 'Invalid card details'],
  processing_error: ['MF005', 'Processing error'],
  authentication_failed: ['MF001', '3DS authentication failed'],
  otp_failed: ['MF001', '3DS authentication failed'],
  cancelled: ['MF006', 'Transaction canceled'],
};

function stamp(svc: PaymentService, p0: Payment): Payment {
  const cur = svc.repo.get(p0.id) ?? p0;
  const keep = (d: Json) => ({ ...p0, providerData: { ...p0.providerData, ...d } });
  if (cur.providerData.paymentId || !p0.method) return keep(cur.providerData);
  return keep(svc.repo.update(cur.id, { providerData: { ...cur.providerData, paymentId: '1002' + digits(14), transactionId: digits(12), referenceId: digits(12), trackId: mfDate(new Date().toISOString()).slice(0, 8) + '_' + digits(6), authorizationId: alnum(6).toUpperCase() } }).providerData);
}

function transactionOf(p: Payment): Json | null {
  const st = txStatus(p);
  if (!st || !p.providerData.paymentId) return null;
  const m = methodInfo(p.method);
  const err = p.status === 'failed' ? MF_ERRORS[String(p.providerData.declineReason ?? 'generic')] ?? MF_ERRORS.generic! : p.status === 'cancelled' ? MF_ERRORS.cancelled! : null;
  const card = ['card', 'mada', 'applepay'].includes(String(p.method)) ? { NameOnCard: 'test test', Number: (p.method === 'mada' ? '446404' : '512345') + 'xxxxxx' + (p.cardLast4 ?? '0008'), Token: null, PanHash: null, ExpiryMonth: '01', ExpiryYear: '39', Brand: p.method === 'mada' ? 'Mada' : p.cardBrand === 'visa' ? 'Visa' : 'Master', Issuer: 'stubyard', IssuerCountry: 'KWT', FundingMethod: 'credit' } : null;
  return {
    TransactionDate: p.updatedAt.slice(0, 19),
    PaymentGateway: m.gateway,
    ReferenceId: String(p.providerData.referenceId ?? ''),
    TrackId: String(p.providerData.trackId ?? ''),
    TransactionId: String(p.providerData.transactionId ?? ''),
    PaymentId: String(p.providerData.paymentId),
    AuthorizationId: st === 'Succss' ? String(p.providerData.authorizationId ?? '') : '',
    TransactionStatus: st,
    TransationValue: toDecimal(p.amount, p.currency),
    CustomerServiceCharge: '0.000',
    TotalServiceCharge: '0.000',
    DueValue: toDecimal(p.amount, p.currency),
    PaidCurrency: p.currency,
    PaidCurrencyValue: toDecimal(p.amount, p.currency),
    VatAmount: '0.000',
    Currency: p.currency,
    Error: err ? err[1] : null,
    CardNumber: card ? card.Number : null,
    ErrorCode: err ? err[0] : '',
    ECI: card ? '05' : null,
    Card: card,
  };
}

/** GetPaymentStatus Data. */
function statusData(p: Payment): Json {
  const r = p.request as Json;
  const tx = transactionOf(p);
  return {
    InvoiceId: Number(p.providerRef),
    InvoiceStatus: invoiceStatus(p),
    InvoiceReference: String(p.providerData.invoiceReference ?? ''),
    CustomerReference: p.reference ?? '',
    CreatedDate: p.createdAt.slice(0, 19),
    ExpiryDate: p.expiresAt ? new Date(p.expiresAt).toUTCString() : '',
    InvoiceValue: Number(toDecimal(p.amount, p.currency)),
    Comments: asString(r.Comments),
    CustomerName: asString(r.CustomerName) ?? '',
    CustomerMobile: asString(r.CustomerMobile) ?? '',
    CustomerEmail: p.customerEmail ?? '',
    UserDefinedField: asString(r.UserDefinedField),
    InvoiceDisplayValue: toDecimal(p.amount, p.currency) + ' ' + p.currency,
    DueDeposit: 0,
    DepositStatus: 'Not Deposited',
    InvoiceItems: Array.isArray(r.InvoiceItems) ? r.InvoiceItems : [],
    InvoiceTransactions: tx ? [tx] : [],
    Suppliers: [],
  };
}

function lintCreate(c: GatewayCtx, b: Json, amountMinor: number, currency: string, valueKey: string): LintFinding[] {
  const out: LintFinding[] = [];
  if (amountMinor <= 0) out.push(finding('pay.amount-zero', valueKey + ' is ' + String(b[valueKey])));
  const cb = badUrl(b.CallBackUrl);
  if (cb) out.push(finding('pay.return-url-missing-or-bad', 'CallBackUrl ' + cb));
  if (!asString(b.CustomerReference) && !asString(b.UserDefinedField)) out.push(finding('pay.no-reference', 'No CustomerReference / UserDefinedField: hard to match the payment to your order'));
  if (Array.isArray(b.InvoiceItems) && b.InvoiceItems.length) {
    let sum = 0;
    for (const it of b.InvoiceItems as Json[]) {
      const u = fromDecimal(it.UnitPrice, currency);
      sum += (u.ok ? u.minor : 0) * Number(it.Quantity ?? 1);
    }
    if (sum !== amountMinor) out.push(finding('pay.myfatoorah-items-mismatch', 'InvoiceItems add up to ' + formatMoney(sum, currency) + ' but ' + valueKey + ' is ' + formatMoney(amountMinor, currency) + ' (MyFatoorah rejects this)'));
  }
  void c;
  return out;
}

function presetOutcome(c: GatewayCtx): string | null {
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (!forced) return null;
  try {
    return normalizeOutcome(forced);
  } catch (e) {
    throw new HttpError(400, 'X-Hub-Payment-Outcome: ' + (e as Error).message);
  }
}

function auth(c: GatewayCtx): void {
  const h = header(c.req, 'authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw new MfError(401, 'Authorization has been denied for this request.');
  const t = m[1]!;
  if (c.inst.config.strictKeys ? t !== c.inst.config.apiToken : t !== c.inst.config.apiToken && t.length < 20) throw new MfError(401, 'Authorization has been denied for this request.');
}

function moneyOf(b: Json, key: string, currency: string): number {
  if (b[key] === undefined || b[key] === null || b[key] === '') throw invalid(key, 'The ' + key + ' field is required.');
  const amt = fromDecimal(b[key], currency);
  if (!amt.ok) throw invalid(key, 'Invalid ' + key);
  if (amt.minor <= 0) throw invalid(key, key === 'InvoiceValue' ? 'Invoice value must be more than 0' : key + ' must be more than 0');
  return amt.minor;
}

function currencyOf(c: GatewayCtx, b: Json, key: string): string {
  const cur = (asString(b[key]) ?? MF_COUNTRIES[countryOf(c.inst)]!.currency).toUpperCase();
  if (!['KWD', 'SAR', 'BHD', 'AED', 'QAR', 'OMR', 'JOD', 'EGP', 'USD', 'EUR'].includes(cur) || currencyDigits(cur) === null) {
    c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', key + ' "' + cur + '" is not a MyFatoorah currency'));
    throw invalid(key, 'Invalid currency ' + cur);
  }
  return cur;
}

function urlCheck(b: Json): void {
  for (const k of ['CallBackUrl', 'ErrorUrl', 'WebhookUrl']) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '' && badUrl(b[k])) throw invalid(k, 'The ' + k + ' must be a valid URL.');
  }
}

function createInvoice(c: GatewayCtx, b: Json, opts: { valueKey: string; methods: PaymentMethod[]; gatewayId?: number }): Payment {
  urlCheck(b);
  const currency = currencyOf(c, b, 'DisplayCurrencyIso');
  const amount = moneyOf(b, opts.valueKey, currency);
  const key = alnum(40);
  const exp = asString(b.ExpiryDate) ? Date.parse(String(b.ExpiryDate)) : NaN;
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: String(1_000_000 + Number(digits(7))),
    secondaryRef: key,
    amount,
    currency,
    reference: asString(b.CustomerReference) ?? asString(b.UserDefinedField),
    customerEmail: asString(b.CustomerEmail),
    returnUrl: asString(b.CallBackUrl),
    cancelUrl: asString(b.ErrorUrl),
    callbackUrl: asString(b.WebhookUrl),
    presetOutcome: presetOutcome(c),
    request: b,
    providerData: { methods: opts.methods, invoiceKey: key, invoiceReference: new Date().getUTCFullYear() + digits(6), gatewayId: opts.gatewayId ?? null, autoCapture: (b.ProcessingDetails as Json | undefined)?.AutoCapture !== false, country: countryOf(c.inst) },
    idempotencyKey: null,
    lint: lintCreate(c, b, amount, currency, opts.valueKey),
    expiresAt: Number.isFinite(exp) && exp > Date.now() ? new Date(exp).toISOString() : new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
  });
  c.resolved.payment = p.id;
  return p;
}

const ok = (Message: string, Data: unknown) => ({ IsSuccess: true, Message, ValidationErrors: null, Data });

async function sendPayment(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'SendPayment';
  if (!asString(b.CustomerName)) throw invalid('CustomerName', 'The CustomerName field is required.');
  const opt = (asString(b.NotificationOption) ?? '').toUpperCase();
  if (!['LNK', 'EML', 'SMS', 'ALL'].includes(opt)) throw invalid('NotificationOption', 'The NotificationOption field is required (LNK, EML, SMS or ALL).');
  if ((opt === 'EML' || opt === 'ALL') && !asString(b.CustomerEmail)) throw invalid('CustomerEmail', 'CustomerEmail is required for NotificationOption ' + opt);
  if ((opt === 'SMS' || opt === 'ALL') && !asString(b.CustomerMobile)) throw invalid('CustomerMobile', 'CustomerMobile is required for NotificationOption ' + opt);
  const p = createInvoice(c, b, { valueKey: 'InvoiceValue', methods: MF_COUNTRIES[countryOf(c.inst)]!.methods });
  const url = c.base + '/' + countryOf(c.inst) + '/ie/' + p.secondaryRef;
  const sent: string[] = [];
  const text = 'Dear ' + String(b.CustomerName) + ', please pay ' + formatMoney(p.amount, p.currency) + ': ' + url;
  if (opt === 'EML' || opt === 'ALL') {
    c.hub.messageService.capture({ project: c.project, instance: null, channel: 'email', from: 'MyFatoorah <noreply@myfatoorah.com>', to: String(b.CustomerEmail), subject: 'Invoice ' + p.providerRef, text, status: 'delivered', logId: p.logId, runId: p.runId, testUserId: p.testUserId ?? undefined, metadata: { payment: p.id } });
    sent.push('email');
  }
  if (opt === 'SMS' || opt === 'ALL') {
    const cc = (asString(b.MobileCountryCode) ?? '+965').replace(/^\+?/, '+');
    c.hub.messageService.capture({ project: c.project, instance: null, channel: 'sms', from: 'MyFatoorah', to: cc + String(b.CustomerMobile).replace(/^0+/, ''), text, status: 'delivered', logId: p.logId, runId: p.runId, testUserId: p.testUserId ?? undefined, metadata: { payment: p.id } });
    sent.push('sms');
  }
  if (sent.length) c.svc.repo.addEvent(p, 'invoice_sent', { channels: sent });
  return ok('Invoice Created Successfully!', { InvoiceId: Number(p.providerRef), InvoiceURL: url, CustomerReference: p.reference ?? '', UserDefinedField: asString(b.UserDefinedField) });
}

function initiatePayment(c: GatewayCtx, b: Json): unknown {
  c.resolved.endpoint = 'InitiatePayment';
  const currency = currencyOf(c, b, 'CurrencyIso');
  const amount = moneyOf(b, 'InvoiceAmount', currency);
  const allowed = MF_COUNTRIES[countryOf(c.inst)]!.methods;
  return ok('Initiated Successfully!', {
    PaymentMethods: MF_METHODS.filter((m) => allowed.includes(m.method)).map((m) => ({
      PaymentMethodId: m.id,
      PaymentMethodAr: m.ar,
      PaymentMethodEn: m.en,
      PaymentMethodCode: m.code,
      IsDirectPayment: false,
      ServiceCharge: 0,
      TotalAmount: Number(toDecimal(amount, currency)),
      CurrencyIso: currency,
      ImageUrl: 'https://demo.myfatoorah.com/imgs/payment-methods/' + m.code + '.png',
      IsEmbeddedSupported: m.method === 'card',
      PaymentCurrencyIso: currency,
    })),
  });
}

function executePayment(c: GatewayCtx, b: Json): unknown {
  c.resolved.endpoint = 'ExecutePayment';
  if (b.SessionId) throw invalid('SessionId', 'stubyard does not simulate the embedded payment session: send PaymentMethodId');
  const id = Number(b.PaymentMethodId);
  const m = MF_METHODS.find((x) => x.id === id);
  if (!m || !MF_COUNTRIES[countryOf(c.inst)]!.methods.includes(m.method)) throw invalid('PaymentMethodId', 'Invalid PaymentMethodId ' + String(b.PaymentMethodId) + ' (call InitiatePayment for the list)');
  const p = createInvoice(c, b, { valueKey: 'InvoiceValue', methods: [m.method], gatewayId: m.id });
  const url = c.base + '/En/' + countryOf(c.inst) + '/PayInvoice/Checkout?invoiceKey=' + p.secondaryRef + '&paymentGatewayId=' + m.id;
  return ok('Invoice Created Successfully!', { InvoiceId: Number(p.providerRef), IsDirectPayment: false, PaymentURL: url, CustomerReference: p.reference ?? '', UserDefinedField: asString(b.UserDefinedField), RecurringId: '' });
}

function byKey(c: GatewayCtx, b: Json, types: string[]): Payment {
  const key = asString(b.Key);
  const type = asString(b.KeyType) ?? '';
  if (!key) throw invalid('Key', 'The Key field is required.');
  if (!types.includes(type)) throw invalid('KeyType', 'KeyType must be ' + types.join(' or '));
  const p =
    type === 'InvoiceId'
      ? c.svc.repo.byInstanceRef(c.inst.id, key)
      : type === 'PaymentId'
        ? c.svc.repo.byDataRef(c.inst.id, 'paymentId', key)
        : c.svc.repo.list(c.project.id, { instanceId: c.inst.id, reference: key, limit: 1 })[0] ?? null;
  if (!p) throw invalid('Key', 'Invalid ' + type);
  c.resolved.payment = p.id;
  return p;
}

async function getPaymentStatus(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'GetPaymentStatus';
  const p = await c.svc.touch(byKey(c, b, ['InvoiceId', 'PaymentId', 'CustomerReference']));
  c.svc.repo.addEvent(p, 'status_queried', { via: 'GetPaymentStatus', keyType: b.KeyType });
  return ok('', statusData(p));
}

async function makeRefund(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'MakeRefund';
  const p = byKey(c, b, ['InvoiceId', 'PaymentId']);
  const amount = moneyOf(b, 'Amount', p.currency);
  const refundId = Number(digits(6)) + 100000;
  try {
    const r = await c.svc.refund(p, amount, { providerRef: String(refundId), reason: asString(b.Comment) });
    return ok('Refund processed successfully', { Key: String(b.Key), RefundId: refundId, RefundReference: new Date().getUTCFullYear() + digits(6), RefundInvoiceId: Number(digits(7)), Amount: Number(toDecimal(r.amount, p.currency)), Comment: asString(b.Comment) ?? '', ExternalIdentifier: asString(b.ExternalIdentifier) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw invalid('Amount', e.message);
    throw e;
  }
}

function getRefundStatus(c: GatewayCtx, b: Json): unknown {
  c.resolved.endpoint = 'GetRefundStatus';
  const key = asString(b.Key);
  const type = asString(b.KeyType) ?? '';
  if (!key) throw invalid('Key', 'The Key field is required.');
  let p: Payment | null = null;
  let only: string | null = null;
  if (type === 'RefundId') {
    const hit = c.svc.repo.refundByRef(c.project.id, key);
    if (hit && hit.payment.instanceId === c.inst.id) [p, only] = [hit.payment, key];
  } else p = byKey(c, b, ['InvoiceId', 'PaymentId']);
  if (!p) throw invalid('Key', 'Invalid ' + type);
  const list = c.svc.repo.refunds(p.id).filter((r) => !only || r.providerRef === only);
  return ok('', { RefundStatusResult: list.map((r) => ({ RefundId: Number(r.providerRef), RefundStatus: r.status === 'succeeded' ? 'Refunded' : 'Pending', InvoiceId: Number(p!.providerRef), Amount: Number(toDecimal(r.amount, p!.currency)), RefundReference: '' })) });
}

function pagePath(c: GatewayCtx, p: Payment): string {
  return '../'.repeat(Math.max(c.path.split('/').length - 2, 0)) + 'page/' + p.id;
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  let mm: RegExpExecArray | null;
  if ((mm = /^\/[A-Za-z]{3}\/ie\/([A-Za-z0-9]+)$/.exec(path)) && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, mm[1]!);
    if (!p) throw new HttpError(404, 'Unknown invoice link');
    c.resolved.endpoint = 'invoice page';
    c.resolved.payment = p.id;
    return c.reply.redirect(pagePath(c, p), 302);
  }
  if (/^\/[A-Za-z]{2}\/[A-Za-z]{3}\/PayInvoice\/Checkout$/i.test(path) && (m === 'GET' || m === 'HEAD')) {
    const p = asString(c.query.invoiceKey) ? c.svc.repo.byInstanceRef(c.inst.id, String(c.query.invoiceKey)) : null;
    if (!p) throw new HttpError(404, 'Unknown invoiceKey');
    c.resolved.endpoint = 'payment page';
    c.resolved.payment = p.id;
    return c.reply.redirect(pagePath(c, p), 302);
  }
  if (m !== 'POST' || !path.startsWith('/v2/')) throw new MfError(404, 'No HTTP resource was found that matches the request URI (' + m + ' ' + path + '). stubyard simulates POST /v2/SendPayment, InitiatePayment, ExecutePayment, GetPaymentStatus, MakeRefund, GetRefundStatus.');
  auth(c);
  const b = bodyOf(req);
  switch (path.slice(4).toLowerCase()) {
    case 'sendpayment':
      return sendPayment(c, b);
    case 'initiatepayment':
      return initiatePayment(c, b);
    case 'executepayment':
      return executePayment(c, b);
    case 'getpaymentstatus':
      return getPaymentStatus(c, b);
    case 'makerefund':
      return makeRefund(c, b);
    case 'getrefundstatus':
      return getRefundStatus(c, b);
  }
  throw new MfError(404, 'No HTTP resource was found that matches the request URI (POST ' + path + ').');
}

/** Webhook bodies (v1 / v2) for TransactionsStatusChanged (1) and RefundStatusChanged (2). */
function webhookBody(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): Json {
  const v2 = String(inst.config.webhookVersion ?? '1') === '2';
  const r = p.request as Json;
  const now = new Date().toISOString();
  const country = String(p.providerData.country ?? countryOf(inst));
  const m = methodInfo(p.method);
  const amount = toDecimal(p.amount, p.currency);
  if (type === 'RefundStatusChanged') {
    const ref = svc.repo.refunds(p.id).at(-1);
    const refundAmount = ref ? toDecimal(ref.amount, p.currency) : '0';
    if (v2) {
      return {
        Event: { Code: 2, Name: 'REFUND_STATUS_CHANGED', CountryIsoCode: country, CreationDate: now, Reference: 'WH-' + digits(9) },
        Data: {
          Refund: { Id: String(ref?.providerRef ?? ''), Reference: '', Status: 'REFUNDED', InvoiceId: p.providerRef, CreationDate: ref?.createdAt ?? now, RefundDate: now, RRN: digits(12), Comment: '', VendorComment: '' },
          Amount: { BaseCurrency: p.currency, ValueInBaseCurrency: refundAmount, DisplayCurrency: p.currency, ValueInDisplayCurrency: refundAmount, PayCurrency: p.currency, ValueInPayCurrency: refundAmount },
          ReferencedInvoice: { Id: p.providerRef, PaymentId: String(p.providerData.paymentId ?? '') },
        },
      };
    }
    return {
      EventType: 2,
      Event: 'RefundStatusChanged',
      DateTime: mfDate(now),
      CountryIsoCode: country,
      Data: { RefundId: Number(ref?.providerRef ?? 0), RefundReference: '', CreatedDate: mfDate(ref?.createdAt ?? now), RefundStatus: 'REFUNDED', Amount: Number(refundAmount), Comments: '', InvoiceId: Number(p.providerRef), GatewayReference: { PaymentId: String(p.providerData.paymentId ?? ''), ReferenceId: String(p.providerData.referenceId ?? '') } },
    };
  }
  if (v2) {
    return {
      Event: { Code: 1, Name: 'PAYMENT_STATUS_CHANGED', CountryIsoCode: country, CreationDate: now, Reference: 'WH-' + digits(9) },
      Data: {
        Invoice: { Id: p.providerRef, Status: invoiceStatus(p) === 'Paid' ? 'PAID' : 'PENDING', Reference: String(p.providerData.invoiceReference ?? ''), CreationDate: p.createdAt, ExpirationDate: p.expiresAt, UserDefinedField: asString(r.UserDefinedField), ExternalIdentifier: asString(r.ExternalIdentifier), MetaData: null },
        Transaction: {
          Id: String(p.providerData.transactionId ?? ''),
          Status: hookStatus(p),
          PaymentMethod: m.gateway,
          PaymentId: String(p.providerData.paymentId ?? ''),
          ReferenceId: String(p.providerData.referenceId ?? ''),
          TrackId: String(p.providerData.trackId ?? ''),
          AuthorizationId: String(p.providerData.authorizationId ?? ''),
          TransactionDate: now,
          ECI: '05',
          Error: p.status === 'failed' ? { Code: (MF_ERRORS[String(p.providerData.declineReason ?? 'generic')] ?? MF_ERRORS.generic!)[0], Message: (MF_ERRORS[String(p.providerData.declineReason ?? 'generic')] ?? MF_ERRORS.generic!)[1] } : null,
        },
        Customer: { Name: asString(r.CustomerName) ?? '', Mobile: asString(r.CustomerMobile) ?? '', Email: p.customerEmail ?? '' },
        Amount: { BaseCurrency: p.currency, ValueInBaseCurrency: amount, ServiceCharge: '0', ServiceChargeVAT: '0', ReceivableAmount: amount, DisplayCurrency: p.currency, ValueInDisplayCurrency: amount, PayCurrency: p.currency, ValueInPayCurrency: amount },
        Suppliers: [],
      },
    };
  }
  return {
    EventType: 1,
    Event: 'TransactionsStatusChanged',
    DateTime: mfDate(now),
    CountryIsoCode: country,
    Data: {
      InvoiceId: Number(p.providerRef),
      InvoiceReference: String(p.providerData.invoiceReference ?? ''),
      CreatedDate: mfDate(p.createdAt),
      CustomerReference: p.reference ?? '',
      CustomerName: asString(r.CustomerName) ?? '',
      CustomerMobile: asString(r.CustomerMobile) ?? '',
      CustomerEmail: p.customerEmail ?? '',
      TransactionStatus: hookStatus(p),
      PaymentMethod: m.gateway,
      UserDefinedField: asString(r.UserDefinedField),
      ReferenceId: String(p.providerData.referenceId ?? ''),
      TrackId: String(p.providerData.trackId ?? ''),
      PaymentId: String(p.providerData.paymentId ?? ''),
      AuthorizationId: String(p.providerData.authorizationId ?? ''),
      InvoiceValueInBaseCurrency: amount,
      BaseCurrency: p.currency,
      InvoiceValueInDisplayCurreny: amount,
      DisplayCurrency: p.currency,
      InvoiceValueInPayCurrency: amount,
      PayCurrency: p.currency,
    },
  };
}

export const myfatoorahGateway: Gateway = {
  preset: 'myfatoorah',
  name: 'MyFatoorah',
  description: 'API v2: SendPayment (invoice link by e-mail / SMS), InitiatePayment + ExecutePayment, GetPaymentStatus, MakeRefund; webhooks v1 / v2 with MyFatoorah-Signature; KNET, cards, mada, BENEFIT, Apple Pay, STC Pay.',
  available: true,
  note: 'The embedded payment (SessionId) and API v3 are not simulated.',
  kind: 'hpp',
  methods: ['knet', 'card', 'mada', 'benefit', 'applepay', 'stcpay'],
  logo: 'MF',
  slugBase: 'myfatoorah',
  webhookToCallbackUrl: true,
  magicOtps: ['1234'],
  otpSender: 'STC Pay',
  fields: [
    { key: 'apiToken', label: 'API token', secret: true, hint: 'Authorization: Bearer <token>' },
    { key: 'webhookSecret', label: 'Webhook secret key', secret: true, hint: 'Signs webhooks (MyFatoorah-Signature); empty: no signature header' },
    { key: 'country', label: 'Country', hint: 'KWT, SAU, ARE, QAT, BHR, OMN, JOD or EGY: default currency and methods' },
    { key: 'webhookVersion', label: 'Webhook version', hint: '1 (default) or 2' },
    { key: 'webhookUrl', label: 'Webhook URL', hint: 'Used when ExecutePayment sends no WebhookUrl' },
  ],
  defaults: () => ({ apiToken: 'rLtt6JWvbUHDDhsZnfpAhpYk4dxYDQkbcPTyGaKp2TYqQgG7FGZ5Th_WD53Oq8Ebz6A53njUoo1w3pjU1D4vs_' + alnum(40), webhookSecret: alnum(44), country: 'KWT', webhookVersion: '1', webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: () => true,
  retryOnDecline: false,
  entryPath: (p) => '/' + String(p.providerData.country ?? 'KWT') + '/ie/' + String(p.secondaryRef ?? p.providerData.invoiceKey ?? ''),
  refundRef: () => String(Number(digits(6)) + 100000),
  methodsFor: (p) => {
    const allowed = (p.providerData.methods as PaymentMethod[] | undefined) ?? [];
    return allowed.length ? allowed : MF_COUNTRIES[String(p.providerData.country ?? 'KWT')]?.methods ?? ['card'];
  },
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof MfError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ IsSuccess: false, Message: e.message, ValidationErrors: e.errors, Data: null });
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        c.resolved.error = e.message;
        return c.reply.status(e.statusCode).send({ IsSuccess: false, Message: e.message, ValidationErrors: null, Data: null });
      }
      throw e;
    }
  },
  afterComplete: (svc, p) => {
    stamp(svc, p);
  },
  returnTo: (svc, p0, _inst, kind) => {
    const p = stamp(svc, p0);
    const target = kind === 'success' ? httpUrl(p.returnUrl) : httpUrl(p.cancelUrl) ?? httpUrl(p.returnUrl);
    if (!target) return null;
    const u = new URL(target);
    u.searchParams.set('paymentId', String(p.providerData.paymentId ?? ''));
    u.searchParams.set('Id', String(p.providerData.paymentId ?? ''));
    return { kind: 'redirect', url: u.toString() };
  },
  events: (_p, point) => {
    if (['paid', 'settled', 'failed', 'cancelled'].includes(point)) return ['TransactionsStatusChanged'];
    if (point === 'refunded') return ['RefundStatusChanged'];
    return [];
  },
  buildEvent: (svc, p0, inst, type) => {
    const p = stamp(svc, p0);
    const body = webhookBody(svc, p, inst, type);
    const secret = String(inst.config.webhookSecret ?? '');
    const headers: Record<string, string> = {};
    if (secret) {
      headers['MyFatoorah-Signature'] =
        'Event' in body && typeof body.Event === 'object'
          ? myfatoorahSignatureV2(body as never, secret)
          : myfatoorahSignatureV1(body.Data as Json, secret, { exclude: type === 'RefundStatusChanged' ? ['GatewayReference'] : [] });
    }
    return { url: p.callbackUrl ?? inst.config.webhookUrl ?? null, body: JSON.stringify(body), headers, eventId: p.providerRef + ':' + type + ':' + (type === 'RefundStatusChanged' ? svc.repo.refunds(p.id).length : hookStatus(p)), signing: null };
  },
  shape: (_svc, p) => statusData(p),
  providerStatus: (p) => invoiceStatus(p) + (txStatus(p) ? ' / ' + txStatus(p) : ''),
  lateLint: (svc, p) => {
    if (['created', 'pending', 'requires_action', 'expired'].includes(p.status)) return [];
    if (svc.repo.events(p.id).some((e) => e.type === 'status_queried')) return [];
    return [finding('pay.myfatoorah-status-never-checked', 'Invoice ' + p.providerRef + ' finished but GetPaymentStatus was never called: the paymentId on the CallBackUrl is not proof of payment')];
  },
  connect: (inst, urls) => ({
    env: { MYFATOORAH_API_KEY: String(inst.config.apiToken ?? ''), MYFATOORAH_BASE_URL: urls.backend, MYFATOORAH_BASE_URL_LOCAL: urls.backendLocal, MYFATOORAH_WEBHOOK_SECRET: String(inst.config.webhookSecret ?? '') },
    notes: [
      'Use MYFATOORAH_BASE_URL instead of https://apitest.myfatoorah.com (POST {base}/v2/SendPayment, /v2/InitiatePayment, /v2/ExecutePayment, /v2/GetPaymentStatus, /v2/MakeRefund) with "Authorization: Bearer <API key>".',
      'The browser comes back to CallBackUrl (ErrorUrl on failure) with ?paymentId=…: call GetPaymentStatus with KeyType PaymentId before you fulfil the order.',
      'Webhooks carry MyFatoorah-Signature (base64 HMAC-SHA256 with the webhook secret). Instance config webhookVersion "2" switches to the v2 body and signing list.',
      'SendPayment with EML / SMS / ALL puts the invoice link into the stubyard inbox of that e-mail / phone.',
    ],
    snippets: [
      {
        title: 'Verify a v1 webhook (Node)',
        lang: 'js',
        code: [
          "const crypto = require('node:crypto');",
          'function v1Signature(data, secret) {',
          "  const text = Object.keys(data).filter((k) => data[k] === null || typeof data[k] !== 'object').sort().map((k) => k + '=' + (data[k] ?? '')).join(',');",
          "  return crypto.createHmac('sha256', secret).update(text).digest('base64');",
          '}',
          "const ok = v1Signature(req.body.Data, process.env.MYFATOORAH_WEBHOOK_SECRET) === req.headers['myfatoorah-signature'];",
        ].join('\n'),
      },
      {
        title: 'Verify a v1 webhook (C#)',
        lang: 'csharp',
        code: [
          'var data = (JObject)body["Data"];',
          'var text = string.Join(",", data.Properties().Where(p => p.Value.Type != JTokenType.Object).OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => $"{p.Name}={(p.Value.Type == JTokenType.Null ? "" : p.Value.ToString())}"));',
          'using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));',
          'var ok = Convert.ToBase64String(h.ComputeHash(Encoding.UTF8.GetBytes(text))) == Request.Headers["MyFatoorah-Signature"];',
        ].join('\n'),
      },
    ],
  }),
};

/** Types and helpers of the payments API (/api/projects/:slug/payment-instances, /payments, /payment-rules). */
import { api } from './api';

export type PaymentStatus = 'created' | 'pending' | 'requires_action' | 'authorized' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'partially_refunded' | 'refunded';
export type PaymentPresetId = 'stripe-checkout' | 'paytabs' | 'paypal' | 'hyperpay';

export const payBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;

export interface PaymentField {
  key: string;
  label: string;
  secret?: boolean;
  hint?: string;
}

export interface PaymentPreset {
  id: PaymentPresetId;
  name: string;
  description: string;
  available: boolean;
  note: string | null;
  kind: string;
  methods: string[];
  fields: PaymentField[];
}

export interface MagicCard {
  number: string;
  id: string;
  brand: string;
  outcome: string;
  label: string;
}

export interface PaymentReference {
  presets: PaymentPreset[];
  statuses: PaymentStatus[];
  outcomes: string[];
  declineReasons: string[];
  modifiers: string[];
  magicCards: MagicCard[];
  otherTestCards: { number: string; brand: string }[];
  lintChecks: { id: string; severity: 'error' | 'warn' | 'info'; title: string; description: string }[];
}

export interface PaymentInstance {
  id: string;
  projectId: string;
  slug: string;
  preset: PaymentPresetId;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  presetName: string;
  methods: string[];
  fields: PaymentField[];
  urls: { browser: string; backend: string; backendLocal: string };
  connect: { env: Record<string, string>; notes: string[]; snippets?: { title: string; lang: string; code: string }[] };
  counts: Record<string, number>;
  activeRules: number;
  problems: string[];
  createdAt: string;
}

export interface LintFinding {
  check: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

export interface PaymentEvent {
  id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Payment {
  id: string;
  instance: string;
  preset: PaymentPresetId;
  kind: string;
  providerRef: string;
  secondaryRef: string | null;
  status: PaymentStatus;
  providerStatus: string;
  amount: number;
  amountFormatted: string;
  currency: string;
  refunded: number;
  reference: string | null;
  customerEmail: string | null;
  returnUrl: string | null;
  cancelUrl: string | null;
  callbackUrl: string | null;
  presetOutcome: string | null;
  outcome: string | null;
  outcomeVia: string | null;
  method: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  lint: LintFinding[];
  lintLevel: 'error' | 'warn' | 'info' | null;
  logId: string | null;
  runId: string | null;
  run: string | null;
  user: { id: string; name: string; email: string | null } | null;
  pageUrl: string;
  entryUrl: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  events?: PaymentEvent[];
  refunds?: { id: string; providerRef: string; amount: number; status: string; createdAt: string }[];
  /** Saved payment methods created with this payment (PayPal store_in_vault). */
  tokens?: PaymentToken[];
  providerData?: Record<string, unknown>;
  provider?: unknown;
  request?: unknown;
}

/** A PayPal vault setup / payment token (no card digits: brand, last 4, expiry). */
export interface PaymentToken {
  id: string;
  instanceId: string;
  runId: string | null;
  kind: 'setup' | 'payment';
  providerRef: string;
  customerId: string | null;
  status: string;
  source: 'card' | 'paypal';
  cardBrand: string | null;
  cardLast4: string | null;
  expiry: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A PayPal authorization (intent AUTHORIZE) as stubyard keeps it on the payment. */
export interface PaymentAuthorization {
  id: string;
  status: string;
  amount: number;
  captures: { id: string; amount: number; final: boolean; at: string; status: string }[];
  capturedAmount: number;
  expiration: string;
  honorExpiration: string;
  previous: string[];
}

export const listPaymentTokens = (slug: string, q: { instance?: string; customer?: string; kind?: string } = {}) =>
  api.get<PaymentToken[]>(`${payBase(slug)}/payments/tokens?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()}`);

export interface PaymentRule {
  id: string;
  instance: string | null;
  user: { id: string; name: string } | null;
  run: string | null;
  level: 'run' | 'user' | 'instance';
  outcome: string;
  remaining: number | null;
  skipCount: number;
  hits: number;
  expiresAt: string | null;
  label: string | null;
  active: boolean;
  createdAt: string;
}

export interface PaymentLintReport {
  payments: number;
  level: 'error' | 'warn' | 'info' | null;
  counts: Record<string, number>;
  byCheck: Record<string, number>;
  findings: (LintFinding & { payment: string | null; instance: string })[];
}

export interface DeliverResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  attempt: number;
  eventType: string;
  eventId: string;
  logId: string | null;
  retry: { scheduleId: string | null; inMs: number } | null;
}

export const STATUS_KIND: Record<PaymentStatus, string> = {
  created: '',
  pending: 'accent',
  requires_action: 'warn',
  authorized: 'accent',
  paid: 'ok',
  failed: 'bad',
  cancelled: 'warn',
  expired: '',
  partially_refunded: 'warn',
  refunded: '',
};

export const LINT_KIND: Record<string, string> = { error: 'bad', warn: 'warn', info: 'accent' };

/** Common outcomes offered by "Complete as…" and the rule form. */
export const QUICK_OUTCOMES = [
  'success',
  'decline',
  'decline:insufficient_funds',
  'decline:expired_card',
  'decline:incorrect_cvc',
  'decline:processing_error',
  '3ds_success',
  '3ds_fail',
  'pending_then_success',
  'cancel',
  'abandon',
];

const digitsOf = (currency: string) => (['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF'].includes(currency) ? 0 : ['KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'LYD', 'TND'].includes(currency) ? 3 : 2);

/** 1250 + USD → "12.50 USD". */
export const fmtMinor = (minor: number, currency: string): string => `${(minor / 10 ** digitsOf(currency)).toFixed(digitsOf(currency))} ${currency}`;

export const toMinor = (decimal: string, currency: string): number | null => {
  const digits = digitsOf(currency);
  const s = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 10 ** digits);
};

export const createPaymentInstance = (slug: string, preset: string, body: { slug?: string; name?: string; config?: Record<string, unknown> }) =>
  api.post<PaymentInstance>(`${payBase(slug)}/payment-instances`, { preset, ...body });

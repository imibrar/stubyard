// round4-core: done
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import type { SigningConfig } from '../webhooks/signing.js';
import type { LintFinding, Payment, PaymentInstance, PaymentInstanceConfig, PaymentKind, PaymentMethod, PaymentPresetId } from './repo.js';
import type { PaymentService } from './service.js';

export type Json = Record<string, unknown>;

/**
 * A provider's documented test card (round 4). Accepted on the hosted page and the API without the real-card warning;
 * magicId is the engine magic card whose outcome it forces (null: the click / default decides); code / message are the
 * provider's response for it (shown by the gateway).
 */
export interface GatewayTestCard {
  number: string;
  brand: string;
  magicId: string | null;
  label?: string;
  code?: string;
}

/** Moments of a payment's life that can send webhooks. */
export type LifecyclePoint = 'approved' | 'authorized' | 'paid' | 'pending' | 'settled' | 'failed' | 'cancelled' | 'expired' | 'refunded';

/** One request to a fake gateway API under /pay/<project>/<instance>/…. */
export interface GatewayCtx {
  hub: Hub;
  svc: PaymentService;
  req: FastifyRequest;
  reply: FastifyReply;
  project: Project;
  inst: PaymentInstance;
  /** Path after /pay/<project>/<instance>, without the query ("/v1/checkout/sessions"). */
  path: string;
  query: Record<string, string | string[] | undefined>;
  /** Traffic-log "resolved" fields of this request (gateways add endpoint, payment, warnings…). */
  resolved: Json;
  /** Browser base of the instance: https://localhost:4443/pay/<project>/<instance>. */
  base: string;
  run: Run | null;
}

/** Where the buyer's browser goes after the hosted page. */
export type ReturnSpec =
  | { kind: 'redirect'; url: string }
  | { kind: 'post'; url: string; fields: Record<string, string> }
  /** JS SDK popups / overlays: post the message to the opener (or parent frame) and close. */
  | { kind: 'close'; url: null; message: Json };

export interface BuiltEvent {
  url: string | null;
  body: string;
  eventId: string;
  signing: SigningConfig | null;
  /** Extra request headers sent with this body (HyperPay: X-Initialization-Vector / X-Authentication-Tag, text/plain). */
  headers?: Record<string, string>;
  /** Readable form of an encrypted body, kept on the timeline only. */
  plain?: string;
  /** HTTP method of the delivery (default POST). GET sends no body and appends query to the URL (Easypaisa IPN). */
  method?: 'POST' | 'GET';
  /** Query parameters appended to url (GET deliveries). */
  query?: Record<string, string>;
}

export interface Gateway {
  preset: PaymentPresetId;
  name: string;
  description: string;
  available: boolean;
  note?: string;
  kind: PaymentKind;
  methods: PaymentMethod[];
  /** Instance config fields shown in the dashboard: key, label, secret?. */
  fields: { key: string; label: string; secret?: boolean; hint?: string }[];
  /** Fresh credentials / defaults for a new instance. */
  defaults(): PaymentInstanceConfig;
  /** A successful page completes the payment (Stripe, PayTabs sale) or only approves it for an API capture (PayPal, PayTabs auth). */
  capturesOnApprove(p: Payment): boolean;
  /** A decline leaves the hosted page usable (Stripe Checkout): the buyer may try again. */
  retryOnDecline: boolean;
  /** Path of the hosted payment page entry (relative to the instance base). */
  entryPath(p: Payment): string;
  route(c: GatewayCtx): Promise<unknown>;
  returnTo(svc: PaymentService, p: Payment, inst: PaymentInstance, kind: 'success' | 'failed' | 'cancelled'): ReturnSpec | null;
  events(p: Payment, point: LifecyclePoint): string[];
  buildEvent(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): BuiltEvent;
  /** The payment as the provider's API shows it (session, transaction, order). */
  shape(svc: PaymentService, p: Payment, inst: PaymentInstance): unknown;
  /** Status in the provider's vocabulary. */
  providerStatus(p: Payment): string;
  /** Base URLs / env for the "Connect" section. */
  connect(inst: PaymentInstance, urls: { browser: string; backend: string; backendLocal: string }): { env: Record<string, string>; notes: string[]; snippets?: { title: string; lang: string; code: string }[] };
  /** The hosted page was opened (query of the page URL): gateways read widget parameters (brands, result URL). */
  pageOpen?(svc: PaymentService, p: Payment, query: Record<string, string | undefined>): Payment;
  /** After an outcome was applied (page or API complete): gateway-specific checks (HyperPay mada entity). */
  afterComplete?(svc: PaymentService, p: Payment, inst: PaymentInstance): void;
  // ---- round 4 (all optional; existing gateways keep the old behaviour) ----
  /** 2-3 letters in the hosted page head (default: the built-in logo of the preset, else "$"). */
  logo?: string;
  /** Default instance slug (default: the preset id). */
  slugBase?: string;
  /** A provider refund id for refunds made from the dashboard / control API / MCP. */
  refundRef?(): string;
  /** Methods the hosted page offers for this payment (default: providerData.methods ∩ methods, else methods). */
  methodsFor?(p: Payment): PaymentMethod[];
  /** Webhooks go to the payment's callbackUrl (from the create request) when it has one: no "no webhook URL" lint then. */
  webhookToCallbackUrl?: boolean;
  /** Codes accepted on the OTP step besides the one sent by SMS (bnpl / wallet / stcpay), e.g. Tabby's 8888. */
  magicOtps?: string[];
  /** SMS sender of the OTP for bnpl / wallet (default: the gateway name). */
  otpSender?: string;
  /** Findings that need time to pass (computed in the lint report for payments untouched for 30 s). */
  lateLint?(svc: PaymentService, p: Payment, inst: PaymentInstance): LintFinding[];
  /** The provider's own test cards (page chips are still the engine magic cards). */
  testCards?: GatewayTestCard[];
  /** Approve-only pages (kind order) where a decline rejects at the page (Tabby / Tamara), instead of failing the later capture (PayPal). */
  declineOnApprove?: boolean;
}

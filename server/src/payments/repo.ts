import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import type { PaymentStatus } from './engine.js';

/** Payments tables (migrations 16, 18): instances, payments, their timeline events, refunds, outcome rules and vault tokens. */

export const PAYMENT_PRESET_IDS = ['stripe-checkout', 'paytabs', 'paypal', 'hyperpay'] as const;
export type PaymentPresetId = (typeof PAYMENT_PRESET_IDS)[number];
export type PaymentKind = 'checkout_session' | 'hpp' | 'order';
export type PaymentMethod = 'card' | 'mada' | 'stcpay' | 'applepay' | 'paypal';
export const PAYMENT_METHODS: PaymentMethod[] = ['card', 'mada', 'stcpay', 'applepay', 'paypal'];
type Json = Record<string, unknown>;

export interface LintFinding {
  check: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

export interface PaymentInstanceConfig {
  /** Stripe: sk_test_… / pk_test_… / whsec_…; PayTabs: profileId + serverKey; PayPal: clientId / clientSecret / webhookId. */
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
  profileId?: string;
  serverKey?: string;
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  /** PayPal: self-signed cert + key the webhooks are signed with. */
  certPem?: string;
  privateKeyPem?: string;
  /** Where stubyard sends the provider's webhooks (Stripe / PayPal; PayTabs IPN = default callback). */
  webhookUrl?: string;
  webhookDelayMs?: number;
  /** Delay until a pending_then_success payment settles. */
  settleDelayMs?: number;
  defaultOutcome?: string;
  magicAmounts?: boolean;
  /** Check the API key / credentials exactly (default: any test key is accepted). */
  strictKeys?: boolean;
  /** HyperPay: Bearer access token, entity ids (card / mada) and the 64-hex AES-256-GCM webhook key. */
  accessToken?: string;
  entityId?: string;
  madaEntityId?: string;
  webhookKey?: string;
  /** PayPal JS SDK: approval in a popup (default) or an in-page iframe overlay (runners that block popups). */
  buttonsMode?: 'popup' | 'inline';
  [k: string]: unknown;
}

export interface PaymentInstance {
  id: string;
  projectId: string;
  slug: string;
  preset: PaymentPresetId;
  name: string;
  config: PaymentInstanceConfig;
  enabled: boolean;
  createdAt: string;
}

export interface Payment {
  id: string;
  projectId: string;
  instanceId: string;
  runId: string | null;
  testUserId: string | null;
  kind: PaymentKind;
  providerRef: string;
  secondaryRef: string | null;
  status: PaymentStatus;
  amount: number;
  currency: string;
  reference: string | null;
  customerEmail: string | null;
  returnUrl: string | null;
  cancelUrl: string | null;
  callbackUrl: string | null;
  refunded: number;
  presetOutcome: string | null;
  outcome: string | null;
  outcomeVia: string | null;
  method: PaymentMethod | null;
  cardBrand: string | null;
  cardLast4: string | null;
  request: Json;
  providerData: Json;
  idempotencyKey: string | null;
  lint: LintFinding[];
  lintLevel: 'error' | 'warn' | 'info' | null;
  logId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentEventRow {
  id: string;
  paymentId: string;
  projectId: string;
  seq: number;
  type: string;
  data: Json;
  createdAt: string;
}

export interface PaymentRefund {
  id: string;
  paymentId: string;
  providerRef: string;
  amount: number;
  status: string;
  createdAt: string;
}

export interface PaymentRule {
  id: string;
  projectId: string;
  instanceId: string | null;
  testUserId: string | null;
  runId: string | null;
  outcome: string;
  params: Json;
  remaining: number | null;
  skipCount: number;
  hits: number;
  expiresAt: string | null;
  label: string | null;
  active: boolean;
  createdAt: string;
}

/** A vault token (PayPal v3 setup / payment token). No card number is ever stored: brand, last 4, expiry only. */
export interface PaymentToken {
  id: string;
  projectId: string;
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
  data: Json;
  createdAt: string;
  updatedAt: string;
}

const toToken = (r: Json): PaymentToken => ({
  id: String(r.id),
  projectId: String(r.project_id),
  instanceId: String(r.instance_id),
  runId: r.run_id === null || r.run_id === undefined ? null : String(r.run_id),
  kind: r.kind as PaymentToken['kind'],
  providerRef: String(r.provider_ref),
  customerId: r.customer_id === null || r.customer_id === undefined ? null : String(r.customer_id),
  status: String(r.status),
  source: r.source as PaymentToken['source'],
  cardBrand: r.card_brand === null || r.card_brand === undefined ? null : String(r.card_brand),
  cardLast4: r.card_last4 === null || r.card_last4 === undefined ? null : String(r.card_last4),
  expiry: r.expiry === null || r.expiry === undefined ? null : String(r.expiry),
  data: parseJson<Json>(r.data as string, {}),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const LEVEL: Record<string, number> = { error: 3, warn: 2, info: 1 };
export const lintLevelOf = (l: LintFinding[]): LintFinding['severity'] | null =>
  l.reduce<LintFinding['severity'] | null>((a, f) => (!a || LEVEL[f.severity]! > LEVEL[a]! ? f.severity : a), null);

/** Request bodies are clipped before they are stored. */
const REQUEST_CLIP = 16 * 1024;
export function clipJson(v: unknown): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Buffer.isBuffer(v)) return {};
  const t = JSON.stringify(v);
  return t.length > REQUEST_CLIP ? { truncated: true, text: t.slice(0, REQUEST_CLIP) } : (v as Json);
}

const toInstance = (r: Json): PaymentInstance => ({
  id: String(r.id),
  projectId: String(r.project_id),
  slug: String(r.slug),
  preset: r.preset as PaymentPresetId,
  name: String(r.name),
  config: parseJson<PaymentInstanceConfig>(r.config as string, {}),
  enabled: !!r.enabled,
  createdAt: String(r.created_at),
});

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const toPayment = (r: Json): Payment => ({
  id: String(r.id),
  projectId: String(r.project_id),
  instanceId: String(r.instance_id),
  runId: str(r.run_id),
  testUserId: str(r.test_user_id),
  kind: r.kind as PaymentKind,
  providerRef: String(r.provider_ref),
  secondaryRef: str(r.secondary_ref),
  status: r.status as PaymentStatus,
  amount: Number(r.amount),
  currency: String(r.currency),
  reference: str(r.reference),
  customerEmail: str(r.customer_email),
  returnUrl: str(r.return_url),
  cancelUrl: str(r.cancel_url),
  callbackUrl: str(r.callback_url),
  refunded: Number(r.refunded ?? 0),
  presetOutcome: str(r.preset_outcome),
  outcome: str(r.outcome),
  outcomeVia: str(r.outcome_via),
  method: str(r.method) as PaymentMethod | null,
  cardBrand: str(r.card_brand),
  cardLast4: str(r.card_last4),
  request: parseJson<Json>(r.request as string, {}),
  providerData: parseJson<Json>(r.provider_data as string, {}),
  idempotencyKey: str(r.idempotency_key),
  lint: parseJson<LintFinding[]>(r.lint as string, []),
  lintLevel: str(r.lint_level) as Payment['lintLevel'],
  logId: str(r.log_id),
  expiresAt: str(r.expires_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toRule = (r: Json): PaymentRule => ({
  id: String(r.id),
  projectId: String(r.project_id),
  instanceId: str(r.instance_id),
  testUserId: str(r.test_user_id),
  runId: str(r.run_id),
  outcome: String(r.outcome),
  params: parseJson<Json>(r.params as string, {}),
  remaining: r.remaining === null || r.remaining === undefined ? null : Number(r.remaining),
  skipCount: Number(r.skip_count ?? 0),
  hits: Number(r.hits ?? 0),
  expiresAt: str(r.expires_at),
  label: str(r.label),
  active: !!r.active,
  createdAt: String(r.created_at),
});

/** Columns a patch may set, camelCase → column. */
const COLS: Record<string, string> = {
  runId: 'run_id', testUserId: 'test_user_id', providerRef: 'provider_ref', secondaryRef: 'secondary_ref', status: 'status', amount: 'amount', currency: 'currency',
  reference: 'reference', customerEmail: 'customer_email', returnUrl: 'return_url', cancelUrl: 'cancel_url', callbackUrl: 'callback_url', refunded: 'refunded',
  presetOutcome: 'preset_outcome', outcome: 'outcome', outcomeVia: 'outcome_via', method: 'method', cardBrand: 'card_brand', cardLast4: 'card_last4',
  request: 'request', providerData: 'provider_data', idempotencyKey: 'idempotency_key', lint: 'lint', lintLevel: 'lint_level', logId: 'log_id', expiresAt: 'expires_at',
};

export type NewPayment = Omit<Payment, 'id' | 'createdAt' | 'updatedAt' | 'refunded' | 'lintLevel' | 'outcome' | 'outcomeVia' | 'method' | 'cardBrand' | 'cardLast4'> &
  Partial<Pick<Payment, 'outcome' | 'outcomeVia' | 'method' | 'cardBrand' | 'cardLast4'>>;

export interface PaymentFilter {
  status?: string[];
  instanceId?: string;
  testUserId?: string;
  runId?: string;
  reference?: string;
  limit?: number;
  after?: string;
}

export class PaymentRepo {
  constructor(private db: DB) {}

  // ---------- instances ----------
  listInstances(projectId: string): PaymentInstance[] {
    return (this.db.prepare('SELECT * FROM payment_instances WHERE project_id = ? ORDER BY created_at, slug').all(projectId) as Json[]).map(toInstance);
  }
  getInstance(projectId: string, ref: string): PaymentInstance | null {
    const r = this.db.prepare('SELECT * FROM payment_instances WHERE project_id = ? AND (slug = ? OR id = ?)').get(projectId, ref.toLowerCase(), ref) as Json | undefined;
    return r ? toInstance(r) : null;
  }
  instanceById(id: string): PaymentInstance | null {
    const r = this.db.prepare('SELECT * FROM payment_instances WHERE id = ?').get(id) as Json | undefined;
    return r ? toInstance(r) : null;
  }
  requireInstance(projectId: string, ref: string): PaymentInstance {
    const i = this.getInstance(projectId, ref);
    if (!i) throw new HttpError(404, `Payment provider "${ref}" not found`);
    return i;
  }
  createInstance(projectId: string, i: { slug: string; preset: PaymentPresetId; name: string; config: PaymentInstanceConfig; enabled?: boolean }): PaymentInstance {
    if (this.getInstance(projectId, i.slug)) throw new HttpError(409, `A payment provider "${i.slug}" already exists in this project`);
    const id = newId();
    const now = nowIso();
    this.db
      .prepare('INSERT INTO payment_instances (id, project_id, slug, preset, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, i.slug, i.preset, i.name, JSON.stringify(i.config), i.enabled !== false, now, now);
    return this.instanceById(id)!;
  }
  updateInstance(id: string, patch: { name?: string; config?: PaymentInstanceConfig; enabled?: boolean }): PaymentInstance {
    const cur = this.instanceById(id);
    if (!cur) throw new HttpError(404, 'Payment provider not found');
    this.db
      .prepare('UPDATE payment_instances SET name = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? cur.name, JSON.stringify(patch.config ?? cur.config), patch.enabled ?? cur.enabled, nowIso(), id);
    return this.instanceById(id)!;
  }
  deleteInstance(id: string): void {
    this.db.prepare('DELETE FROM payment_instances WHERE id = ?').run(id);
  }

  // ---------- payments ----------
  insert(p: NewPayment): Payment {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO payments (id, project_id, instance_id, run_id, test_user_id, kind, provider_ref, secondary_ref, status, amount, currency, reference,
         customer_email, return_url, cancel_url, callback_url, preset_outcome, request, provider_data, idempotency_key, lint, lint_level, log_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, p.projectId, p.instanceId, p.runId, p.testUserId, p.kind, p.providerRef, p.secondaryRef, p.status, p.amount, p.currency, p.reference,
        p.customerEmail, p.returnUrl, p.cancelUrl, p.callbackUrl, p.presetOutcome, JSON.stringify(p.request ?? {}), JSON.stringify(p.providerData ?? {}),
        p.idempotencyKey, JSON.stringify(p.lint ?? []), lintLevelOf(p.lint ?? []), p.logId, p.expiresAt, now, now,
      );
    return this.get(id)!;
  }
  get(id: string): Payment | null {
    const r = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Json | undefined;
    return r ? toPayment(r) : null;
  }
  require(projectId: string, id: string): Payment {
    const p = this.get(id) ?? this.byRef(projectId, id);
    if (!p || p.projectId !== projectId) throw new HttpError(404, `Payment "${id}" not found`);
    return p;
  }
  /** By provider reference (cs_test_…, TST…, PayPal order id) or secondary ref (pi_…, capture id) in a project. */
  byRef(projectId: string, ref: string): Payment | null {
    const r = this.db.prepare('SELECT * FROM payments WHERE project_id = ? AND (provider_ref = ? OR secondary_ref = ?) ORDER BY created_at DESC LIMIT 1').get(projectId, ref, ref) as Json | undefined;
    return r ? toPayment(r) : null;
  }
  byInstanceRef(instanceId: string, ref: string): Payment | null {
    const r = this.db.prepare('SELECT * FROM payments WHERE instance_id = ? AND (provider_ref = ? OR secondary_ref = ?) ORDER BY created_at DESC LIMIT 1').get(instanceId, ref, ref) as Json | undefined;
    return r ? toPayment(r) : null;
  }
  /** A PayPal capture id: the order's first capture (providerData.captureId) or a later partial capture of its authorization. */
  byCaptureId(instanceId: string, id: string): Payment | null {
    const r = this.db
      .prepare(
        `SELECT * FROM payments WHERE instance_id = ? AND (json_extract(provider_data, '$.captureId') = ?
           OR EXISTS (SELECT 1 FROM json_each(provider_data, '$.authorization.captures') c WHERE json_extract(c.value, '$.id') = ?)) LIMIT 1`,
      )
      .get(instanceId, id, id) as Json | undefined;
    return r ? toPayment(r) : null;
  }
  /** A PayPal authorization id (current or an earlier one replaced by reauthorize). */
  byAuthorizationId(instanceId: string, id: string): Payment | null {
    const r = this.db
      .prepare(
        `SELECT * FROM payments WHERE instance_id = ? AND (json_extract(provider_data, '$.authorization.id') = ?
           OR EXISTS (SELECT 1 FROM json_each(provider_data, '$.authorization.previous') a WHERE a.value = ?)) LIMIT 1`,
      )
      .get(instanceId, id, id) as Json | undefined;
    return r ? toPayment(r) : null;
  }
  /** Search provider_data for an id (charge, capture or refund ids live there). */
  byDataRef(instanceId: string, key: string, value: string): Payment | null {
    const r = this.db.prepare(`SELECT * FROM payments WHERE instance_id = ? AND json_extract(provider_data, ?) = ? LIMIT 1`).get(instanceId, `$.${key}`, value) as Json | undefined;
    return r ? toPayment(r) : null;
  }
  update(id: string, patch: Partial<Payment>): Payment {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLS[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'request' || k === 'providerData' || k === 'lint' ? JSON.stringify(v ?? (k === 'lint' ? [] : {})) : v);
      if (k === 'lint') {
        sets.push('lint_level = ?');
        vals.push(lintLevelOf((v as LintFinding[]) ?? []));
      }
    }
    sets.push('updated_at = ?');
    vals.push(nowIso());
    this.db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id)!;
  }
  list(projectId: string, f: PaymentFilter = {}): Payment[] {
    const where = ['project_id = ?'];
    const vals: unknown[] = [projectId];
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      vals.push(...f.status);
    }
    if (f.instanceId) (where.push('instance_id = ?'), vals.push(f.instanceId));
    if (f.testUserId) (where.push('test_user_id = ?'), vals.push(f.testUserId));
    if (f.runId) (where.push('run_id = ?'), vals.push(f.runId));
    if (f.reference) (where.push('(reference = ? OR provider_ref = ?)'), vals.push(f.reference, f.reference));
    if (f.after) (where.push('updated_at > ?'), vals.push(f.after));
    const limit = Math.min(Math.max(Number(f.limit ?? 100) || 100, 1), 500);
    return (this.db.prepare(`SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`).all(...vals) as Json[]).map(toPayment);
  }
  /** Open payments past their expiry. */
  expiredOpen(now: string): Payment[] {
    return (this.db.prepare("SELECT * FROM payments WHERE status IN ('created','pending','requires_action') AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as Json[]).map(toPayment);
  }
  deleteForProject(projectId: string): number {
    return this.db.prepare('DELETE FROM payments WHERE project_id = ?').run(projectId).changes;
  }
  deleteForRun(runId: string): number {
    return this.db.prepare('DELETE FROM payments WHERE run_id = ?').run(runId).changes;
  }

  // ---------- events ----------
  addEvent(p: Payment, type: string, data: Json = {}): PaymentEventRow {
    const id = newId();
    const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM payment_events WHERE payment_id = ?').get(p.id) as { n: number }).n);
    this.db.prepare('INSERT INTO payment_events (id, payment_id, project_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, p.id, p.projectId, seq, type, JSON.stringify(data), nowIso());
    return this.event(id)!;
  }
  event(id: string): PaymentEventRow | null {
    const r = this.db.prepare('SELECT * FROM payment_events WHERE id = ?').get(id) as Json | undefined;
    return r ? { id: String(r.id), paymentId: String(r.payment_id), projectId: String(r.project_id), seq: Number(r.seq), type: String(r.type), data: parseJson<Json>(r.data as string, {}), createdAt: String(r.created_at) } : null;
  }
  events(paymentId: string): PaymentEventRow[] {
    return (this.db.prepare('SELECT id FROM payment_events WHERE payment_id = ? ORDER BY seq').all(paymentId) as { id: string }[]).map((r) => this.event(r.id)!);
  }
  /** Webhook deliveries of a project whose data.<key> equals value (PayPal transmission ids). */
  findDelivered(projectId: string, key: string, value: string): PaymentEventRow | null {
    const r = this.db.prepare("SELECT id FROM payment_events WHERE project_id = ? AND type = 'webhook_delivered' AND json_extract(data, ?) = ? LIMIT 1").get(projectId, `$.${key}`, value) as { id: string } | undefined;
    return r ? this.event(r.id) : null;
  }
  countEvents(projectId: string, type: string, instanceId?: string): number {
    const sql = instanceId
      ? 'SELECT COUNT(*) AS n FROM payment_events e JOIN payments p ON p.id = e.payment_id WHERE e.project_id = ? AND e.type = ? AND p.instance_id = ?'
      : 'SELECT COUNT(*) AS n FROM payment_events WHERE project_id = ? AND type = ?';
    return Number((this.db.prepare(sql).get(...(instanceId ? [projectId, type, instanceId] : [projectId, type])) as { n: number }).n);
  }

  // ---------- refunds ----------
  addRefund(p: Payment, providerRef: string, amount: number, status: string): PaymentRefund {
    const id = newId();
    this.db.prepare('INSERT INTO payment_refunds (id, payment_id, provider_ref, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, p.id, providerRef, amount, status, nowIso());
    return this.refunds(p.id).find((r) => r.id === id)!;
  }
  refunds(paymentId: string): PaymentRefund[] {
    return (this.db.prepare('SELECT * FROM payment_refunds WHERE payment_id = ? ORDER BY created_at').all(paymentId) as Json[]).map((r) => ({
      id: String(r.id), paymentId: String(r.payment_id), providerRef: String(r.provider_ref), amount: Number(r.amount), status: String(r.status), createdAt: String(r.created_at),
    }));
  }
  refundByRef(projectId: string, ref: string): { refund: PaymentRefund; payment: Payment } | null {
    const r = this.db.prepare('SELECT r.payment_id FROM payment_refunds r JOIN payments p ON p.id = r.payment_id WHERE p.project_id = ? AND r.provider_ref = ?').get(projectId, ref) as { payment_id: string } | undefined;
    if (!r) return null;
    const payment = this.get(r.payment_id)!;
    return { payment, refund: this.refunds(payment.id).find((x) => x.providerRef === ref)! };
  }

  // ---------- vault tokens ----------
  addToken(t: Omit<PaymentToken, 'id' | 'createdAt' | 'updatedAt'>): PaymentToken {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare('INSERT INTO payment_tokens (id, project_id, instance_id, run_id, kind, provider_ref, customer_id, status, source, card_brand, card_last4, expiry, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.projectId, t.instanceId, t.runId, t.kind, t.providerRef, t.customerId, t.status, t.source, t.cardBrand, t.cardLast4, t.expiry, JSON.stringify(t.data ?? {}), now, now);
    return this.token(id)!;
  }
  token(id: string): PaymentToken | null {
    const r = this.db.prepare('SELECT * FROM payment_tokens WHERE id = ?').get(id) as Json | undefined;
    return r ? toToken(r) : null;
  }
  tokenByRef(instanceId: string, ref: string, kind?: PaymentToken['kind']): PaymentToken | null {
    const r = (kind
      ? this.db.prepare('SELECT * FROM payment_tokens WHERE instance_id = ? AND provider_ref = ? AND kind = ? LIMIT 1').get(instanceId, ref, kind)
      : this.db.prepare('SELECT * FROM payment_tokens WHERE instance_id = ? AND provider_ref = ? LIMIT 1').get(instanceId, ref)) as Json | undefined;
    return r ? toToken(r) : null;
  }
  updateToken(id: string, patch: Partial<Pick<PaymentToken, 'status' | 'customerId' | 'data' | 'cardBrand' | 'cardLast4' | 'expiry'>>): PaymentToken {
    const cur = this.token(id);
    if (!cur) throw new HttpError(404, 'Token not found');
    const n = { ...cur, ...patch };
    this.db
      .prepare('UPDATE payment_tokens SET status = ?, customer_id = ?, data = ?, card_brand = ?, card_last4 = ?, expiry = ?, updated_at = ? WHERE id = ?')
      .run(n.status, n.customerId, JSON.stringify(n.data ?? {}), n.cardBrand, n.cardLast4, n.expiry, nowIso(), id);
    return this.token(id)!;
  }
  listTokens(projectId: string, f: { instanceId?: string; customerId?: string; runId?: string; kind?: string; limit?: number } = {}): PaymentToken[] {
    const where = ['project_id = ?'];
    const vals: unknown[] = [projectId];
    if (f.instanceId) (where.push('instance_id = ?'), vals.push(f.instanceId));
    if (f.customerId) (where.push('customer_id = ?'), vals.push(f.customerId));
    if (f.runId) (where.push('run_id = ?'), vals.push(f.runId));
    if (f.kind) (where.push('kind = ?'), vals.push(f.kind));
    const limit = Math.min(Math.max(Number(f.limit ?? 100) || 100, 1), 500);
    return (this.db.prepare(`SELECT * FROM payment_tokens WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`).all(...vals) as Json[]).map(toToken);
  }
  deleteTokensForProject(projectId: string): number {
    return this.db.prepare('DELETE FROM payment_tokens WHERE project_id = ?').run(projectId).changes;
  }
  deleteTokensForRun(runId: string): number {
    return this.db.prepare('DELETE FROM payment_tokens WHERE run_id = ?').run(runId).changes;
  }

  // ---------- rules ----------
  listRules(projectId: string, f: { runId?: string | null; all?: boolean } = {}): PaymentRule[] {
    const rows = f.all
      ? this.db.prepare('SELECT * FROM payment_rules WHERE project_id = ? ORDER BY created_at').all(projectId)
      : f.runId
        ? this.db.prepare('SELECT * FROM payment_rules WHERE project_id = ? AND (run_id IS NULL OR run_id = ?) ORDER BY created_at').all(projectId, f.runId)
        : this.db.prepare('SELECT * FROM payment_rules WHERE project_id = ? AND run_id IS NULL ORDER BY created_at').all(projectId);
    return (rows as Json[]).map(toRule);
  }
  getRule(id: string): PaymentRule | null {
    const r = this.db.prepare('SELECT * FROM payment_rules WHERE id = ?').get(id) as Json | undefined;
    return r ? toRule(r) : null;
  }
  addRule(projectId: string, r: { instanceId: string | null; testUserId: string | null; runId: string | null; outcome: string; params?: Json; remaining: number | null; skipCount: number; expiresAt: string | null; label: string | null }): PaymentRule {
    const id = newId();
    this.db
      .prepare('INSERT INTO payment_rules (id, project_id, instance_id, test_user_id, run_id, outcome, params, remaining, skip_count, hits, expires_at, label, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)')
      .run(id, projectId, r.instanceId, r.testUserId, r.runId, r.outcome, JSON.stringify(r.params ?? {}), r.remaining, r.skipCount, r.expiresAt, r.label, nowIso());
    return this.getRule(id)!;
  }
  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM payment_rules WHERE id = ?').run(id);
  }
  deleteRules(projectId: string, f: { runId?: string | null; instanceId?: string; testUserId?: string }): number {
    const where = ['project_id = ?'];
    const vals: unknown[] = [projectId];
    if (f.runId !== undefined) f.runId === null ? where.push('run_id IS NULL') : (where.push('run_id = ?'), vals.push(f.runId));
    if (f.instanceId) (where.push('instance_id = ?'), vals.push(f.instanceId));
    if (f.testUserId) (where.push('test_user_id = ?'), vals.push(f.testUserId));
    return this.db.prepare(`DELETE FROM payment_rules WHERE ${where.join(' AND ')}`).run(...vals).changes;
  }
  deleteRulesForRun(runId: string): number {
    return this.db.prepare('DELETE FROM payment_rules WHERE run_id = ?').run(runId).changes;
  }
  resetRuleHits(projectId: string): void {
    this.db.prepare('UPDATE payment_rules SET hits = 0 WHERE project_id = ?').run(projectId);
  }
  skipRule(id: string): void {
    this.db.prepare('UPDATE payment_rules SET skip_count = skip_count - 1 WHERE id = ? AND skip_count > 0').run(id);
  }
  /** One use: hits + 1, remaining − 1 (deactivated at 0). */
  consumeRule(id: string): void {
    this.db.prepare('UPDATE payment_rules SET hits = hits + 1, remaining = CASE WHEN remaining IS NULL THEN NULL ELSE remaining - 1 END WHERE id = ?').run(id);
    this.db.prepare('UPDATE payment_rules SET active = 0 WHERE id = ? AND remaining IS NOT NULL AND remaining <= 0').run(id);
  }
}

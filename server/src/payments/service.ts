import { randomInt } from 'node:crypto';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import type { TestUser } from '../repos/users.js';
import { HttpError, normalizePhone, slugify, SLUG_RE, trimEnd } from '../util.js';
import {
  FORCED_VIA,
  OPEN,
  describeCard,
  formatMoney,
  isRefundOutcome,
  magicAmountOutcome,
  magicCardById,
  normalizeOutcome,
  normalizeRefundOutcome,
  parseOutcome,
  parseRefundOutcome,
  resolveOutcome,
  transition,
  type Outcome,
  type OutcomeVia,
  type PaymentEvent,
  type PaymentStatus,
  type RefundOutcome,
} from './engine.js';
import { retriesOnDecline, type EventCtx, type Gateway, type GatewayCtx, type Json, type LifecyclePoint, type ReturnSpec } from './gateway.js';
import { finding, mergeFindings } from './lint.js';
import { asString, fixedBrowserBase, maskCardFields } from './common.js';
import { OTP_METHODS } from './pages.js';
import { registerPageSource } from './kit/dispatch.js';
import { experiencesOf } from './kit/registry.js';
import { cleanExperienceConfig } from './kit/view.js';
import { normalizeSdkOrigins } from './sdk/runtime.js';
import { GATEWAYS } from './presets.js';
import {
  PAYMENT_METHODS,
  PAYMENT_PRESET_IDS,
  PaymentRepo,
  lintLevelOf,
  type LintFinding,
  type NewPayment,
  type Payment,
  type PaymentInstance,
  type PaymentInstanceConfig,
  type PaymentMethod,
  type PaymentPresetId,
  type PaymentRule,
} from './repo.js';
import { PaymentWebhooks } from './webhooks.js';
import { hostHttpBase, hostHttpsBase } from '../config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';

/** The origin the /pay request being served came in on (for browserBaseUrl "request-host"). */
const requestOrigins = new AsyncLocalStorage<string>();

/** Scheme + Host of a request (X-Forwarded-Proto, else the socket / trust-proxy protocol), or null when the Host header is not a plain host[:port]. */
export function requestOriginOf(req: FastifyRequest): string | null {
  const host = String(req.headers.host ?? '');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) return null;
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
  return `${fwd === 'http' || fwd === 'https' ? fwd : req.protocol}://${host}`;
}

/** What the hosted page / POST …/complete sends. */
export interface CompleteInput {
  outcome?: string | null;
  via: 'page' | 'api';
  user?: string | null;
  method?: string | null;
  /** Page: what the browser derived from the number; API: a test card number or a magic card id. */
  card?: { brand?: string | null; last4?: string | null; magicId?: string | null; luhnValid?: boolean; testCard?: boolean } | string | null;
  phone?: string | null;
  otp?: string | null;
}

export interface CompleteResult {
  payment: Payment;
  outcome: string | null;
  via: OutcomeVia | null;
  forced: boolean;
  redirect: ReturnSpec | null;
  redirectUrl: string | null;
  /** STC Pay: an OTP was sent by SMS; the page asks for it. */
  needsOtp?: boolean;
  otpError?: string;
  /** Decline shown on the page (gateways that keep the buyer on the page, i.e. Stripe). */
  declined?: { code: string; message: string } | null;
}

export const DECLINE_MESSAGES: Record<string, string> = {
  generic: 'Your card was declined.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
  incorrect_cvc: "Your card's security code is incorrect.",
  processing_error: 'An error occurred while processing your card. Try again in a little bit.',
  authentication_failed: 'We are unable to authenticate your payment method.',
  otp_failed: 'The verification code was entered wrongly too many times.',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LINT_PER_INSTANCE = 50;

/** Payments 1a: fake Stripe Checkout, PayTabs and PayPal Standard (hub.payments). */
export class PaymentService {
  readonly repo: PaymentRepo;
  readonly webhooks: PaymentWebhooks;
  /** Findings of requests that never became a payment (live key, bad auth), per instance. */
  private instanceLint = new Map<string, LintFinding[]>();

  constructor(readonly hub: Hub) {
    this.repo = new PaymentRepo(hub.db);
    this.webhooks = new PaymentWebhooks(this);
    registerPageSource(this);
  }

  gateway(preset: string): Gateway {
    const g = GATEWAYS.find((x) => x.preset === preset);
    if (!g) throw new HttpError(400, `Unknown payment preset "${preset}". Use ${PAYMENT_PRESET_IDS.join(', ')}`);
    return g;
  }

  presets() {
    return GATEWAYS.map((g) => ({ id: g.preset, name: g.name, description: g.description, available: g.available, note: g.note ?? null, kind: g.kind, methods: g.methods, fields: g.fields, logo: g.logo ?? null, slugBase: g.slugBase ?? (g.preset === 'stripe-checkout' ? 'stripe' : g.preset), webhookToCallbackUrl: !!(g.webhookToCallbackUrl || g.preset === 'paytabs'), experiences: experiencesOf(g.preset) }));
  }

  // ---------------- URLs ----------------

  /**
   * The origin the browser is sent to (hosted pages, 3-D Secure, SDK and return URLs). Every gateway builds them
   * through base() / entryUrl() / urls(), so this is the one place that decides: the instance's browserBaseUrl
   * (an http(s) URL, or "request-host" = the origin of the /pay request being served), then STUBYARD_PUBLIC_URL,
   * then the host-published stubyard address.
   */
  browserRoot(inst?: PaymentInstance): string {
    const c = this.hub.config;
    if (inst) {
      const fixed = fixedBrowserBase(inst);
      if (fixed) return fixed;
      if (inst.config.browserBaseUrl === 'request-host') {
        const o = requestOrigins.getStore();
        if (o) return o;
      }
    }
    return c.publicUrl || (this.hub.tls ? hostHttpsBase(c) : hostHttpBase(c));
  }
  /** Run fn (a /pay request handler) with the request's origin known to browserRoot() for "request-host" instances. */
  withRequest<T>(req: FastifyRequest, fn: () => T): T {
    const o = requestOriginOf(req);
    return o ? requestOrigins.run(o, fn) : fn();
  }
  instancePath(project: Project, inst: PaymentInstance): string {
    return `/pay/${project.slug}/${inst.slug}`;
  }
  base(project: Project, inst: PaymentInstance): string {
    return this.browserRoot(inst) + this.instancePath(project, inst);
  }
  pageUrl(project: Project, inst: PaymentInstance, p: Payment): string {
    return `${this.base(project, inst)}/page/${p.id}`;
  }
  entryUrl(project: Project, inst: PaymentInstance, p: Payment): string {
    return this.base(project, inst) + this.gateway(inst.preset).entryPath(p);
  }
  urls(project: Project, inst: PaymentInstance) {
    const path = this.instancePath(project, inst);
    return { browser: this.browserRoot(inst) + path, backend: `https://stubyard:${this.hub.config.httpsPort}${path}`, backendLocal: hostHttpBase(this.hub.config) + path };
  }

  // ---------------- instances ----------------

  createInstance(project: Project, b: Json): PaymentInstance {
    const preset = String(b.preset ?? '') as PaymentPresetId;
    const g = this.gateway(preset);
    if (!g.available) throw new HttpError(400, `The ${g.name} simulator is not available: ${g.note ?? ''}`);
    const existing = this.repo.listInstances(project.id).map((i) => i.slug);
    const base = g.slugBase ?? (preset === 'stripe-checkout' ? 'stripe' : preset);
    let slug = b.slug ? slugify(String(b.slug)) : base;
    if (!b.slug) for (let n = 2; existing.includes(slug); n++) slug = `${base}-${n}`;
    if (!SLUG_RE.test(slug)) throw new HttpError(400, `Invalid slug "${slug}"`);
    // New instances get the realistic checkout pages; an instance without the key (created before, or imported
    // from an old export: export.ts) stays on the classic page.
    const config = this.cleanConfig({ ...g.defaults(), experience: 'realistic', ...((b.config as Json) ?? {}) });
    const inst = this.repo.createInstance(project.id, { slug, preset, name: b.name ? String(b.name) : g.name, config, enabled: b.enabled !== false });
    this.changed(project.id, { instance: inst.slug, created: true });
    return inst;
  }

  updateInstance(inst: PaymentInstance, b: Json): PaymentInstance {
    const patch: { name?: string; config?: PaymentInstanceConfig; enabled?: boolean } = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.config && typeof b.config === 'object') {
      // null removes a key; secrets sent as "" are ignored (the dashboard never sees them).
      const merged: Json = { ...inst.config };
      for (const [k, v] of Object.entries(b.config as Json)) {
        if (v === null) delete merged[k];
        // A masked registry sent back unchanged (a view round-trip) keeps the stored secrets.
        else if (k === 'webhooks' && JSON.stringify(v) === JSON.stringify(this.maskedHooks(inst.config.webhooks))) continue;
        else if (v === '' && this.gateway(inst.preset).fields.some((f) => f.key === k && f.secret)) continue;
        else merged[k] = v;
      }
      patch.config = this.cleanConfig(merged);
    }
    const out = this.repo.updateInstance(inst.id, patch);
    this.changed(inst.projectId, { instance: inst.slug, updated: true });
    return out;
  }

  private cleanConfig(c: Json): PaymentInstanceConfig {
    const out = { ...c } as PaymentInstanceConfig;
    for (const k of ['webhookDelayMs', 'settleDelayMs'] as const) {
      if (out[k] === undefined || out[k] === null || (out[k] as unknown) === '') continue;
      const n = Number(out[k]);
      if (!Number.isFinite(n) || n < 0 || n > 600_000) throw new HttpError(400, `${k} must be 0-600000 ms`);
      out[k] = Math.round(n);
    }
    if (out.defaultOutcome) out.defaultOutcome = normalizeOutcome(String(out.defaultOutcome));
    if (out.webhookUrl === '') delete out.webhookUrl;
    if (out.browserBaseUrl !== undefined) {
      const v = typeof out.browserBaseUrl === 'string' ? out.browserBaseUrl.trim() : '';
      if (!v) delete out.browserBaseUrl;
      else if (v === 'request-host') out.browserBaseUrl = v;
      else {
        let u: URL | null = null;
        try {
          u = new URL(v);
        } catch {
          /* rejected below */
        }
        if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new HttpError(400, 'browserBaseUrl must be an http(s) URL (e.g. http://localhost:5500) or "request-host"');
        out.browserBaseUrl = trimEnd(v, '/');
      }
    }
    cleanExperienceConfig(out);
    // P2 SDK frames: the merchant origins allowed to embed them (array, or a comma / newline separated string).
    if (out.sdkOrigins !== undefined) {
      const list = normalizeSdkOrigins(out.sdkOrigins);
      if (list.length) out.sdkOrigins = list;
      else delete out.sdkOrigins;
    }
    if (out.checkoutJsMode !== undefined && out.checkoutJsMode !== 'popup' && out.checkoutJsMode !== 'redirect') throw new HttpError(400, 'checkoutJsMode must be "popup" or "redirect"');
    // C1 §4 provider contracts: contract (contractMode is an alias, stored as contract: never kept, so when present
    // it was just sent and wins over the stored value); true means "strict".
    if (out.contractMode !== undefined) out.contract = out.contractMode;
    delete out.contractMode;
    if (out.contract !== undefined) {
      if (out.contract === true) out.contract = 'strict';
      if (out.contract !== 'off' && out.contract !== 'report' && out.contract !== 'strict') throw new HttpError(400, 'contract must be "off", "report" or "strict" (true means "strict")');
    }
    return out;
  }

  /** Registered webhooks (Moyasar / Tabby / Tamara registries in config.webhooks) with their secrets masked. */
  maskedHooks(hooks: unknown): unknown {
    if (!Array.isArray(hooks)) return hooks;
    const mask = (v: unknown) => {
      const s = String(v ?? '');
      return s === '' ? '' : s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '…';
    };
    return hooks.map((h) => {
      if (!h || typeof h !== 'object') return h;
      const o = { ...(h as Json) };
      if (o.shared_secret !== undefined) o.shared_secret = mask(o.shared_secret); // Moyasar
      if (o.header && typeof o.header === 'object') o.header = { ...(o.header as Json), value: mask((o.header as Json).value) }; // Tabby
      if (o.headers && typeof o.headers === 'object') o.headers = Object.fromEntries(Object.entries(o.headers as Json).map(([k, v]) => [k, mask(v)])); // Tamara
      return o;
    });
  }

  viewInstance(project: Project, inst: PaymentInstance, opts: { secrets?: boolean } = {}) {
    const g = this.gateway(inst.preset);
    const config: Json = { ...inst.config };
    const secretKeys = g.fields.filter((f) => f.secret).map((f) => f.key);
    for (const k of [...secretKeys, 'privateKeyPem']) {
      if (opts.secrets || config[k] === undefined) continue;
      const v = String(config[k]);
      config[k] = k === 'privateKeyPem' ? '(hidden)' : v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : '…';
    }
    if (!opts.secrets && config.webhooks !== undefined) config.webhooks = this.maskedHooks(config.webhooks);
    const urls = this.urls(project, inst);
    const counts = this.hub.db.prepare('SELECT status, COUNT(*) AS n FROM payments WHERE instance_id = ? GROUP BY status').all(inst.id) as { status: string; n: number }[];
    const rules = this.repo.listRules(project.id, { all: true }).filter((r) => r.instanceId === inst.id && r.active).length;
    return {
      ...inst,
      config,
      presetName: g.name,
      methods: g.methods,
      fields: g.fields,
      urls,
      connect: g.connect(inst, urls),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      activeRules: rules,
      problems: this.instanceProblems(inst),
    };
  }

  instanceProblems(inst: PaymentInstance): string[] {
    const out: string[] = [];
    if (!inst.enabled) out.push(`${inst.slug} is disabled (503)`);
    const toCallback = inst.preset === 'paytabs' || !!GATEWAYS.find((g) => g.preset === inst.preset)?.webhookToCallbackUrl;
    const registered = Array.isArray(inst.config.webhooks) && inst.config.webhooks.length > 0;
    if (!toCallback && !inst.config.webhookUrl && !registered) out.push(`${inst.slug}: no webhook URL`);
    return out;
  }

  // ---------------- payments ----------------

  /**
   * The test user the payment page preselects: the payment's own (customer email, an earlier choice on the page),
   * else the user an active walkthrough acts as now (storyboards: the one named in metadata.stubyard_walkthrough /
   * metadata.walkthrough, else the one whose app origin matches the payment's return URLs, else the most recent).
   */
  pageUserId(p: Payment): string | null {
    if (p.testUserId) return p.testUserId;
    const wt = this.hub.walkthroughs;
    if (!wt) return null;
    const originOf = (u: string | null | undefined) => {
      try {
        return u ? new URL(u).origin : null;
      } catch {
        return null;
      }
    };
    const origins = [p.returnUrl, p.cancelUrl, p.callbackUrl].map(originOf).filter((x): x is string => !!x && x !== 'null');
    const meta = (p.request as Json | null)?.metadata;
    const named = meta && typeof meta === 'object' && !Array.isArray(meta) ? ((meta as Json).stubyard_walkthrough ?? (meta as Json).walkthrough) : null;
    try {
      return wt.activeUserFor(p.projectId, { origins, walkthrough: typeof named === 'string' ? named : null })?.userId ?? null;
    } catch {
      return null;
    }
  }

  /** Run of a gateway request: explicit (header / prefix), the customer's run user, a claim, the default run. */
  attribute(c: GatewayCtx, email: string | null): { run: Run | null; user: TestUser | null } {
    const user = email ? this.hub.users.findByEmail(c.project.id, email.trim().toLowerCase()) : null;
    if (c.run) return { run: c.run, user };
    const userRun = this.hub.runs.resolver.activeById(user?.runId);
    if (userRun) return { run: userRun, user };
    return { run: this.hub.runs.resolver.forRequest(c.project.id, c.req).run, user };
  }

  create(c: GatewayCtx, i: Omit<NewPayment, 'projectId' | 'instanceId' | 'runId' | 'testUserId' | 'logId' | 'status'> & { status?: PaymentStatus }): Payment {
    const { run, user } = this.attribute(c, i.customerEmail);
    const lint = [...i.lint];
    const g = this.gateway(c.inst.preset);
    const toCallback = c.inst.preset === 'paytabs' || !!g.webhookToCallbackUrl;
    const registered = Array.isArray(c.inst.config.webhooks) && c.inst.config.webhooks.length > 0;
    if (!c.inst.config.webhookUrl && !registered && !(toCallback && i.callbackUrl)) {
      lint.push(finding('pay.no-webhook-url', c.inst.preset === 'paytabs' ? 'No callback URL in the request and no IPN URL on the instance' : toCallback ? 'No notification / callback URL in the request and no webhook URL on the instance' : `Instance "${c.inst.slug}" has no webhook URL; set one in Providers → Payments`));
    }
    const p = this.repo.insert({
      ...i,
      // Card fields a client sent to the API (it should not) are never stored in clear.
      request: maskCardFields(i.request),
      status: i.status ?? 'created',
      lint,
      projectId: c.project.id,
      instanceId: c.inst.id,
      runId: run?.id ?? null,
      testUserId: user?.id ?? null,
      logId: c.req.trafficLogId ?? null,
    });
    this.repo.addEvent(p, 'created', { amount: p.amount, currency: p.currency, reference: p.reference, presetOutcome: p.presetOutcome, run: run?.key ?? null, kind: g.kind });
    if (c.req.trafficLogId) {
      if (run) this.hub.traffic.update(c.req.trafficLogId, { runId: run.id });
      this.hub.traffic.mergeResolved(c.req.trafficLogId, { payment: p.id, ...(run ? { run: run.key } : {}) });
    }
    this.changed(p.projectId, { payment: p.id, created: true });
    return p;
  }

  /** Lazy expiry: an open payment past expires_at becomes expired when it is next looked at. */
  async touch(p: Payment): Promise<Payment> {
    if (OPEN.includes(p.status) && p.expiresAt && p.expiresAt <= new Date().toISOString()) return this.expire(p, 'timeout');
    return p;
  }

  instanceOf(p: Payment): PaymentInstance {
    const i = this.repo.instanceById(p.instanceId);
    if (!i) throw new HttpError(404, 'Payment provider not found');
    return i;
  }

  view(p: Payment, opts: { detail?: boolean } = {}) {
    const inst = this.instanceOf(p);
    const project = this.hub.projects.get(p.projectId)!;
    const g = this.gateway(inst.preset);
    const run = p.runId ? this.hub.runs.repo.get(p.runId) : null;
    const user = p.testUserId ? this.hub.users.get(p.projectId, p.testUserId) : null;
    const providerData = { ...p.providerData };
    if (providerData.stc && typeof providerData.stc === 'object') providerData.stc = { ...(providerData.stc as Json), otp: undefined };
    const base = {
      ...p,
      providerData,
      instance: inst.slug,
      preset: inst.preset,
      amountFormatted: formatMoney(p.amount, p.currency),
      providerStatus: g.providerStatus(p),
      pageUrl: this.pageUrl(project, inst, p),
      entryUrl: this.entryUrl(project, inst, p),
      run: run?.key ?? null,
      user: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null,
    };
    if (!opts.detail) return base;
    const tokens = this.repo.listTokens(p.projectId, { instanceId: p.instanceId, limit: 500 }).filter((t) => t.data.paymentId === p.id);
    return { ...base, events: this.repo.events(p.id), refunds: this.repo.refunds(p.id), tokens, provider: g.shape(this, p, inst) };
  }

  /** The hosted page was opened. */
  opened(p: Payment): Payment {
    if (p.status !== 'created') return p;
    const out = this.setStatus(p, 'open');
    this.repo.addEvent(out, 'page_opened', {});
    this.changed(p.projectId, { payment: p.id });
    return out;
  }

  private setStatus(p: Payment, ev: PaymentEvent, patch: Partial<Payment> = {}): Payment {
    const to = transition(p.status, ev);
    const out = this.repo.update(p.id, { ...patch, status: to });
    if (to !== p.status) this.repo.addEvent(out, 'status', { from: p.status, to, event: ev });
    return out;
  }

  addLint(p: Payment, findings: LintFinding[]): Payment {
    if (!findings.length) return p;
    const lint = mergeFindings(p.lint, findings);
    return lint.length === p.lint.length ? p : this.repo.update(p.id, { lint });
  }

  addInstanceLint(inst: PaymentInstance, f: LintFinding): void {
    const cur = this.instanceLint.get(inst.id) ?? [];
    if (!cur.some((x) => x.check === f.check && x.message === f.message)) cur.unshift(f);
    this.instanceLint.set(inst.id, cur.slice(0, LINT_PER_INSTANCE));
  }

  // ---------------- outcomes ----------------

  private ruleMatches(r: PaymentRule, p: Payment, userId: string | null, level: 'run' | 'user' | 'instance', now: string, refund = false): boolean {
    if (!r.active || (r.expiresAt && r.expiresAt <= now)) return false;
    // "refund:…" rules force refunds only; the others force payments only.
    if (isRefundOutcome(r.outcome) !== refund) return false;
    if (r.remaining !== null && r.remaining <= 0) return false;
    if (r.instanceId && r.instanceId !== p.instanceId) return false;
    if (level === 'run') return !!p.runId && r.runId === p.runId && (!r.testUserId || r.testUserId === userId);
    if (r.runId) return false;
    if (level === 'user') return !!userId && r.testUserId === userId;
    return !r.testUserId;
  }

  /** First matching rule of one level; consumed (count / skip) unless peeking. */
  private pickRule(p: Payment, userId: string | null, level: 'run' | 'user' | 'instance', consume: boolean, refund = false): string | null {
    const now = new Date().toISOString();
    const rules = this.repo.listRules(p.projectId, { runId: p.runId }).filter((r) => this.ruleMatches(r, p, userId, level, now, refund));
    // Rules of this instance before project-wide ones.
    rules.sort((a, b) => Number(!a.instanceId) - Number(!b.instanceId));
    for (const r of rules) {
      if (r.skipCount > 0) {
        if (consume) this.repo.skipRule(r.id);
        continue;
      }
      if (consume) this.repo.consumeRule(r.id);
      return r.outcome;
    }
    return null;
  }

  /**
   * How a new refund of this payment ends: the gateway's per-request value (header), then run / user / instance
   * "refund:…" rules, else succeeded. Peek first (consume false) and consume only once the refund was created.
   */
  refundOutcome(p: Payment, header: string | null | undefined, consume = true): { outcome: RefundOutcome; via: OutcomeVia } {
    if (header) return { outcome: parseRefundOutcome(header), via: 'header' };
    for (const [level, via] of [['run', 'run rule'], ['user', 'user rule'], ['instance', 'instance rule']] as const) {
      const hit = this.pickRule(p, p.testUserId, level, consume, true);
      if (hit) return { outcome: parseRefundOutcome(hit), via };
    }
    return { outcome: { base: 'succeeded', reason: null }, via: 'default' };
  }

  /** The outcome levels 1-4 force for this payment (without consuming rules), for the page banner. */
  peekForced(p: Payment, userId: string | null): { outcome: string; via: OutcomeVia } | null {
    const r = resolveOutcome({
      header: p.presetOutcome,
      runRule: () => this.pickRule(p, userId, 'run', false),
      userRule: () => this.pickRule(p, userId, 'user', false),
      instanceRule: () => this.pickRule(p, userId, 'instance', false),
    });
    return FORCED_VIA.includes(r.via) ? r : null;
  }

  private resolveUser(p: Payment, ref: string | null | undefined): TestUser | null {
    if (ref) return this.hub.users.requireRef(p.projectId, ref, p.runId);
    return p.testUserId ? this.hub.users.get(p.projectId, p.testUserId) : null;
  }

  private cardOf(input: CompleteInput['card'], g?: Gateway): { brand: string | null; last4: string | null; magicId: string | null; real: boolean } {
    if (!input) return { brand: null, last4: null, magicId: null, real: false };
    if (typeof input === 'string') {
      const s = input.trim();
      const byId = magicCardById(s);
      if (byId) return { brand: byId.brand, last4: byId.number.slice(-4), magicId: byId.id, real: false };
      const own = g?.testCards?.find((c) => c.number === s.replace(/\D/g, ''));
      if (own) return { brand: own.brand, last4: own.number.slice(-4), magicId: own.magicId, real: false };
      const d = describeCard(s);
      if (s.replace(/\D/g, '').length < 12) throw new HttpError(400, `card must be a test card number or a magic card id (success, decline, insufficient_funds, expired_card, incorrect_cvc, processing_error, 3ds)`);
      return { brand: d.brand, last4: d.last4, magicId: d.magicId, real: d.luhnValid && !d.testCard };
    }
    const magic = magicCardById(input.magicId ?? null);
    const last4 = input.last4 ? String(input.last4).replace(/\D/g, '').slice(-4) || null : null;
    return { brand: input.brand ? String(input.brand).slice(0, 20) : magic?.brand ?? null, last4, magicId: magic?.id ?? null, real: input.luhnValid === true && input.testCard === false };
  }

  /** A Luhn-valid non-test number was typed on the page: recorded without any digits. */
  realCardWarning(p: Payment, brand: string | null): Payment {
    const out = this.addLint(p, [finding('pay.real-card-entered', `A real-looking ${brand ?? 'card'} number was typed on the payment page and cleared in the browser`)]);
    this.repo.addEvent(out, 'warning', { check: 'pay.real-card-entered', brand });
    this.changed(p.projectId, { payment: p.id });
    return out;
  }

  // ---------------- STC Pay ----------------

  private sendOtp(p: Payment, phone: string, sender = 'STC Pay', length = 6): Payment {
    const project = this.hub.projects.get(p.projectId)!;
    const otp = String(randomInt(0, 10 ** length)).padStart(length, '0');
    this.hub.messageService.capture({
      project,
      instance: null,
      channel: 'sms',
      from: sender,
      to: phone,
      text: `${sender}: your verification code is ${otp}. Do not share it. Payment ${formatMoney(p.amount, p.currency)}${p.reference ? ` (${p.reference})` : ''}.`,
      otp,
      status: 'delivered',
      logId: p.logId,
      runId: p.runId,
      testUserId: p.testUserId ?? undefined,
    });
    const out = this.repo.update(p.id, { providerData: { ...p.providerData, stc: { phone, otp, tries: 0, verified: false, sentAt: new Date().toISOString() } } });
    this.repo.addEvent(out, 'otp_sent', { phone, channel: 'sms' });
    return out;
  }

  /**
   * The OTP screen of a multi-step page flow (Tabby / Tamara / JazzCash / Easypaisa): send the code to `phone`. It is
   * the same providerData.stc state complete() reads, so the final complete() skips a code that is already verified.
   * A code already sent to the same phone is kept unless resend is set.
   */
  otpStart(p: Payment, phone: string, sender: string, o: { resend?: boolean; length?: number } = {}): Payment {
    const n = normalizePhone(phone);
    if (!n) throw new HttpError(400, 'A mobile number is required');
    const stc = (p.providerData.stc ?? null) as { phone?: string; verified?: boolean; failed?: boolean } | null;
    if (stc && stc.phone === n && !stc.failed && !o.resend) return p;
    const out = this.sendOtp(p, n, sender, o.length ?? 6);
    this.changed(p.projectId, { payment: p.id });
    return out;
  }

  /**
   * A code typed on a flow's OTP screen: ok (verified), wrong (tries left; "Wrong code, N tries left") or exhausted
   * (the third wrong code: complete() then declines the payment with otp_failed, as on the classic OTP screen).
   */
  otpCheck(p: Payment, code: string | null): { payment: Payment; result: 'ok' | 'wrong' | 'exhausted' | 'missing'; message: string | null } {
    const g = this.gateway(this.instanceOf(p).preset);
    const cur = (p.providerData.stc ?? null) as { phone: string; otp: string; tries: number; verified: boolean; failed?: boolean } | null;
    if (!cur) return { payment: p, result: 'missing', message: 'No code was sent yet' };
    if (cur.verified) return { payment: p, result: 'ok', message: null };
    if (cur.failed) return { payment: p, result: 'exhausted', message: null };
    const otp = String(code ?? '').trim();
    if (!otp) return { payment: p, result: 'wrong', message: 'Enter the code' };
    if (otp === cur.otp || (g.magicOtps ?? []).includes(otp)) {
      const out = this.repo.update(p.id, { providerData: { ...p.providerData, stc: { ...cur, verified: true } } });
      this.repo.addEvent(out, 'otp_verified', { auto: false });
      this.changed(p.projectId, { payment: p.id });
      return { payment: out, result: 'ok', message: null };
    }
    const tries = cur.tries + 1;
    const out = this.repo.update(p.id, { providerData: { ...p.providerData, stc: { ...cur, tries, ...(tries >= 3 ? { failed: true } : {}) } } });
    this.repo.addEvent(out, 'otp_wrong', { tries });
    this.changed(p.projectId, { payment: p.id });
    if (tries >= 3) return { payment: out, result: 'exhausted', message: null };
    return { payment: out, result: 'wrong', message: `Wrong code, ${3 - tries} tr${3 - tries === 1 ? 'y' : 'ies'} left` };
  }

  // ---------------- complete ----------------

  async complete(p0: Payment, input: CompleteInput): Promise<CompleteResult> {
    let p = await this.touch(p0);
    const inst = this.instanceOf(p);
    const g = this.gateway(inst.preset);
    if (p.status === 'failed' && retriesOnDecline(g, p)) {
      if (g.beforeRetry) p = g.beforeRetry(this, p, inst);
      p = this.setStatus(p, 'retry');
    }
    if (!OPEN.includes(p.status)) throw new HttpError(409, `Payment is ${p.status}; only open payments (created, pending, requires_action) can be completed`, { status: p.status });

    const user = this.resolveUser(p, input.user);
    const method = (input.method ? String(input.method).toLowerCase() : p.method ?? g.methods[0]) as PaymentMethod;
    if (!PAYMENT_METHODS.includes(method) || !g.methods.includes(method)) throw new HttpError(400, `Method "${method}" is not offered by ${g.name} (use ${g.methods.join(', ')})`);
    // A card the app already sent to the gateway API (Moyasar / Checkout.com / Tap) counts when the page sends none.
    const cardIn = input.card ?? ((p.providerData.apiCard as CompleteInput['card'] | undefined) ?? null);
    const card = method === 'card' || method === 'mada' ? this.cardOf(cardIn, g) : { brand: null, last4: null, magicId: null, real: false };
    if (card.real) {
      this.realCardWarning(p, card.brand);
      throw new HttpError(400, 'That looks like a real card number. stubyard only accepts test cards (e.g. 4242 4242 4242 4242); nothing was stored.');
    }
    const patch: Partial<Payment> = { method, testUserId: user?.id ?? p.testUserId };
    if (user?.runId && !p.runId) patch.runId = this.hub.runs.resolver.activeById(user.runId)?.id ?? null;
    if (method === 'card' || method === 'mada') Object.assign(patch, { cardBrand: method === 'mada' ? 'mada' : card.brand, cardLast4: card.last4 });
    if (method === 'applepay') Object.assign(patch, { cardBrand: card.brand ?? 'visa', cardLast4: card.last4 ?? '1111' });
    if (method === 'knet' || method === 'benefit') Object.assign(patch, { cardBrand: method, cardLast4: null });
    p = this.repo.update(p.id, patch);
    if (p.status === 'created') p = this.setStatus(p, 'open');

    // STC Pay, pay later (bnpl) and mobile wallets: OTP by SMS first (the page asks for it; the API accepts otp "auto").
    let forcedOutcome: string | null = null;
    if (OTP_METHODS.includes(method)) {
      const label = method === 'stcpay' ? 'STC Pay' : (g.otpSender ?? g.name);
      const stc = (p.providerData.stc ?? null) as { phone: string; otp: string; tries: number; verified: boolean; failed?: boolean } | null;
      const phone = normalizePhone(input.phone ?? stc?.phone ?? user?.phone ?? asString(p.providerData.otpPhone) ?? null);
      if (!phone) throw new HttpError(400, `${label} needs a mobile number (phone) or a test user with a phone`);
      let cur = stc && stc.phone === phone ? stc : null;
      if (!cur) {
        p = this.sendOtp(p, phone, label);
        cur = p.providerData.stc as typeof cur;
      }
      const otp = input.otp === undefined || input.otp === null ? (input.via === 'api' ? 'auto' : null) : String(input.otp).trim();
      if (!cur!.verified && cur!.failed) {
        // Three wrong codes on a flow's OTP screen (otpCheck): declined as on the classic OTP screen.
        forcedOutcome = 'decline:generic';
        p = this.repo.update(p.id, { providerData: { ...p.providerData, declineReason: 'otp_failed' } });
      } else if (!cur!.verified) {
        if (otp === null || otp === '') {
          this.changed(p.projectId, { payment: p.id });
          return { payment: p, outcome: null, via: null, forced: false, redirect: null, redirectUrl: null, needsOtp: true };
        }
        if (otp === 'auto' || otp === cur!.otp || (g.magicOtps ?? []).includes(otp)) {
          p = this.repo.update(p.id, { providerData: { ...p.providerData, stc: { ...cur!, verified: true } } });
          this.repo.addEvent(p, 'otp_verified', { auto: otp === 'auto' });
        } else {
          const tries = cur!.tries + 1;
          p = this.repo.update(p.id, { providerData: { ...p.providerData, stc: { ...cur!, tries } } });
          this.repo.addEvent(p, 'otp_wrong', { tries });
          if (tries < 3) {
            this.changed(p.projectId, { payment: p.id });
            if (input.via === 'api') throw new HttpError(400, `Wrong ${label} code (${3 - tries} tr${3 - tries === 1 ? 'y' : 'ies'} left)`);
            return { payment: p, outcome: null, via: null, forced: false, redirect: null, redirectUrl: null, needsOtp: true, otpError: `Wrong code, ${3 - tries} tr${3 - tries === 1 ? 'y' : 'ies'} left` };
          }
          forcedOutcome = 'decline:generic';
          p = this.repo.update(p.id, { providerData: { ...p.providerData, declineReason: 'otp_failed' } });
        }
      }
    }

    // Outcome: header, run rule, user rule, instance rule, magic card / amount, click / API, default.
    const magic = magicCardById(card.magicId);
    const r = forcedOutcome
      ? { outcome: forcedOutcome, via: 'page' as OutcomeVia }
      : resolveOutcome({
          header: p.presetOutcome,
          runRule: () => this.pickRule(p, p.testUserId, 'run', true),
          userRule: () => this.pickRule(p, p.testUserId, 'user', true),
          instanceRule: () => this.pickRule(p, p.testUserId, 'instance', true),
          magicCard: magic ? (magic.outcome === '3ds' ? (input.outcome && /^3ds_/.test(input.outcome) ? input.outcome : '3ds_success') : magic.outcome) : null,
          magicAmount: inst.config.magicAmounts ? magicAmountOutcome(p.amount) : null,
          click: input.outcome || null,
          clickVia: input.via,
          defaultOutcome: inst.config.defaultOutcome ?? null,
        });
    // Voucher (pay at the counter): a plain success is "pending, then paid" unless a rule / header / magic value said otherwise.
    if (method === 'voucher' && (r.via === 'page' || r.via === 'api' || r.via === 'default') && r.outcome.split(',')[0] === 'success') {
      r.outcome = normalizeOutcome(['pending_then_success', ...r.outcome.split(',').slice(1)].join(','));
    }
    const o = parseOutcome(r.outcome);
    if (o.slowMs) await sleep(o.slowMs);
    p = this.repo.update(p.id, { outcome: r.outcome, outcomeVia: r.via });
    this.repo.addEvent(p, 'outcome', { outcome: r.outcome, via: r.via, user: user?.id ?? p.testUserId, method, brand: p.cardBrand, last4: p.cardLast4 });

    const res = await this.apply(p, inst, g, o);
    g.afterComplete?.(this, this.repo.get(p.id)!, inst);
    const fresh = this.repo.get(p.id)!;
    let redirect: ReturnSpec | null = null;
    if (!o.noRedirect && o.base !== 'abandon' && res.kind) {
      try {
        redirect = g.returnTo(this, fresh, inst, res.kind);
      } catch {
        redirect = null; // a stored return URL that no longer parses: the done page says so
      }
    }
    if (o.noRedirect) this.repo.addEvent(fresh, 'no_redirect', {});
    this.changed(p.projectId, { payment: p.id, outcome: r.outcome });
    const declined = res.kind === 'failed' ? this.declineOf(fresh) : null;
    return {
      payment: this.repo.get(p.id)!,
      outcome: r.outcome,
      via: r.via,
      forced: FORCED_VIA.includes(r.via),
      redirect,
      redirectUrl: redirect?.url ?? null,
      declined,
    };
  }

  declineOf(p: Payment): { code: string; message: string } {
    const reason = String(p.providerData.declineReason ?? 'generic');
    return { code: reason, message: DECLINE_MESSAGES[reason] ?? DECLINE_MESSAGES.generic! };
  }

  /** State changes + webhooks for one outcome; kind = where the browser goes. */
  private async apply(p: Payment, inst: PaymentInstance, g: Gateway, o: Outcome): Promise<{ kind: 'success' | 'failed' | 'cancelled' | null }> {
    const points: LifecyclePoint[] = [];
    let settle = false;
    let kind: 'success' | 'failed' | 'cancelled' | null = null;
    const captures = g.capturesOnApprove(p);
    let cur = p;
    const data = (extra: Json) => ({ ...cur.providerData, ...extra });
    switch (o.base) {
      case 'success':
      case '3ds_success':
      case 'pending_then_success': {
        if (o.base === '3ds_success') {
          cur = this.setStatus(cur, 'challenge');
          this.repo.addEvent(cur, '3ds', { result: 'authenticated' });
        }
        const async = o.base === 'pending_then_success';
        if (captures) {
          cur = this.setStatus(cur, 'authorize', { providerData: data({ async }) });
          if (async) {
            points.push('pending');
            settle = true;
          } else {
            cur = this.setStatus(cur, 'capture');
            points.push('paid');
          }
        } else {
          cur = this.setStatus(cur, 'authorize', { providerData: data({ pendingOnCapture: async }) });
          points.push('approved');
        }
        kind = 'success';
        break;
      }
      case 'decline':
      case '3ds_fail': {
        const reason = o.base === '3ds_fail' ? 'authentication_failed' : String(cur.providerData.declineReason ?? o.reason ?? 'generic');
        if (o.base === '3ds_fail') {
          cur = this.setStatus(cur, 'challenge');
          this.repo.addEvent(cur, '3ds', { result: 'failed' });
        }
        if (captures || o.base === '3ds_fail' || reason === 'otp_failed' || g.declineOnApprove) {
          cur = this.setStatus(cur, 'fail', { providerData: data({ declineReason: reason }) });
          this.repo.addEvent(cur, 'declined', { reason });
          points.push('failed');
          kind = 'failed';
        } else {
          // PayPal / auth-only: the buyer approves; the capture call is what fails.
          cur = this.setStatus(cur, 'authorize', { providerData: data({ captureDecline: reason }) });
          points.push('approved');
          kind = 'success';
        }
        break;
      }
      case 'cancel':
        cur = this.setStatus(cur, 'cancel');
        points.push('cancelled');
        kind = 'cancelled';
        break;
      case 'abandon':
        this.repo.addEvent(cur, 'abandoned', {});
        break;
    }
    for (const pt of points) await this.webhooks.emit(this.repo.get(cur.id)!, inst, pt, o);
    if (settle) await this.webhooks.scheduleSettle(this.repo.get(cur.id)!, inst, o);
    return { kind };
  }

  /**
   * API capture (PayPal capture, PayTabs / HyperPay capture). Errors are returned as data for the gateway to shape.
   * amount (minor units, default: all of it) below the payment amount is a partial capture; unless final, more captures
   * may follow while the payment is already paid (PayPal authorizations: PARTIALLY_CAPTURED).
   */
  async capture(
    p0: Payment,
    opts: { idempotencyKey?: string | null; mock?: string | null; amount?: number | null; final?: boolean } = {},
  ): Promise<{ payment: Payment; error: null | 'not_approved' | 'already_captured' | 'declined' | 'amount_exceeds'; reason?: string; amount?: number }> {
    let p = await this.touch(p0);
    const inst = this.instanceOf(p);
    if (!opts.idempotencyKey) p = this.addLint(p, [finding('pay.no-idempotency-key', 'Capture without an idempotency key (PayPal-Request-Id)')]);
    const captured0 = Number(p.providerData.capturedAmount ?? 0);
    if (p.status === 'paid' && p.providerData.partialCapture === true) {
      const amt = opts.amount === null || opts.amount === undefined ? p.amount - captured0 : Math.round(opts.amount);
      if (!(amt > 0) || captured0 + amt > p.amount) return { payment: p, error: 'amount_exceeds' };
      const capturedAmount = captured0 + amt;
      p = this.repo.update(p.id, { providerData: { ...p.providerData, capturedAmount, partialCapture: !(opts.final || capturedAmount >= p.amount) } });
      this.repo.addEvent(p, 'captured', { amount: amt, partial: true, total: capturedAmount, final: !p.providerData.partialCapture });
      await this.webhooks.emit(p, inst, 'paid', p.outcome ? parseOutcome(p.outcome) : null);
      this.changed(p.projectId, { payment: p.id });
      return { payment: this.repo.get(p.id)!, error: null, amount: amt };
    }
    if (['paid', 'partially_refunded', 'refunded'].includes(p.status) || (p.status === 'authorized' && p.providerData.captured)) {
      p = this.addLint(p, [finding('pay.double-capture', 'The order was captured twice')]);
      this.repo.addEvent(p, 'capture_rejected', { error: 'already_captured' });
      this.changed(p.projectId, { payment: p.id });
      return { payment: p, error: 'already_captured' };
    }
    if (p.status !== 'authorized') {
      p = this.addLint(p, [finding('pay.capture-before-approve', `Capture while the payment was ${p.status} (the buyer had not approved it)`)]);
      this.repo.addEvent(p, 'capture_rejected', { error: 'not_approved', status: p.status });
      this.changed(p.projectId, { payment: p.id });
      return { payment: p, error: 'not_approved' };
    }
    const amt = opts.amount === null || opts.amount === undefined ? p.amount : Math.round(opts.amount);
    if (!(amt > 0) || amt > p.amount) return { payment: p, error: 'amount_exceeds' };
    const partial = amt < p.amount && !opts.final;
    const mockDecline = opts.mock ? parseOutcome(opts.mock) : null;
    const decline = p.providerData.captureDecline ? String(p.providerData.captureDecline) : mockDecline?.base === 'decline' ? mockDecline.reason ?? 'generic' : null;
    const o = p.outcome ? parseOutcome(p.outcome) : null;
    if (decline) {
      p = this.setStatus(p, 'fail', { providerData: { ...p.providerData, declineReason: decline } });
      this.repo.addEvent(p, 'declined', { reason: decline, at: 'capture' });
      await this.webhooks.emit(p, inst, 'failed', o);
      this.changed(p.projectId, { payment: p.id });
      return { payment: this.repo.get(p.id)!, error: 'declined', reason: decline };
    }
    if (p.providerData.pendingOnCapture) {
      p = this.repo.update(p.id, { providerData: { ...p.providerData, async: true, captured: true, capturedAmount: amt } });
      this.repo.addEvent(p, 'captured', { pending: true, amount: amt });
      await this.webhooks.emit(p, inst, 'pending', o);
      await this.webhooks.scheduleSettle(p, inst, o);
    } else {
      p = this.setStatus(p, 'capture', { providerData: { ...p.providerData, captured: true, capturedAmount: amt, ...(partial ? { partialCapture: true } : {}) } });
      this.repo.addEvent(p, 'captured', amt === p.amount ? {} : { amount: amt, partial, final: !partial });
      await this.webhooks.emit(p, inst, 'paid', o);
    }
    this.changed(p.projectId, { payment: p.id });
    return { payment: this.repo.get(p.id)!, error: null, amount: amt };
  }

  /**
   * Authorize an approved payment without capturing it (PayPal intent AUTHORIZE: POST /v2/checkout/orders/{id}/authorize).
   * The engine status stays "authorized"; data (the provider's authorization: id, status, expiry…) goes to
   * providerData.authorization. A decline outcome fails here instead of at capture.
   */
  async authorize(p0: Payment, opts: { data: Json; mock?: string | null }): Promise<{ payment: Payment; error: null | 'not_approved' | 'already_authorized' | 'declined'; reason?: string }> {
    let p = await this.touch(p0);
    const inst = this.instanceOf(p);
    if (p.providerData.authorization) return { payment: p, error: 'already_authorized' };
    if (p.status !== 'authorized') {
      p = this.addLint(p, [finding('pay.capture-before-approve', `Authorize while the payment was ${p.status} (the buyer had not approved it)`)]);
      this.repo.addEvent(p, 'authorize_rejected', { error: 'not_approved', status: p.status });
      this.changed(p.projectId, { payment: p.id });
      return { payment: p, error: 'not_approved' };
    }
    const mockDecline = opts.mock ? parseOutcome(opts.mock) : null;
    const decline = p.providerData.captureDecline ? String(p.providerData.captureDecline) : mockDecline?.base === 'decline' ? mockDecline.reason ?? 'generic' : null;
    const o = p.outcome ? parseOutcome(p.outcome) : null;
    if (decline) {
      p = this.setStatus(p, 'fail', { providerData: { ...p.providerData, declineReason: decline } });
      this.repo.addEvent(p, 'declined', { reason: decline, at: 'authorize' });
      await this.webhooks.emit(p, inst, 'failed', o);
      this.changed(p.projectId, { payment: p.id });
      return { payment: this.repo.get(p.id)!, error: 'declined', reason: decline };
    }
    p = this.repo.update(p.id, { providerData: { ...p.providerData, authorization: opts.data } });
    this.repo.addEvent(p, 'authorized', { authorization: opts.data.id ?? null });
    await this.webhooks.emit(p, inst, 'authorized', o);
    this.changed(p.projectId, { payment: p.id });
    return { payment: this.repo.get(p.id)!, error: null };
  }

  /** pending_then_success: the async payment settles (from the scheduled settle webhook). */
  settle(p: Payment): Payment {
    if (p.status !== 'authorized' || !p.providerData.async) return p;
    const out = this.setStatus(p, 'capture', { providerData: { ...p.providerData, async: false, settled: true } });
    this.repo.addEvent(out, 'settled', {});
    this.changed(p.projectId, { payment: p.id });
    return out;
  }

  /** Refund (amount in minor units, default: what is left). Throws 400 (exceeds) / 409 (not paid) with lint. */
  async refund(p0: Payment, amount: number | null, opts: { providerRef: string; status?: string; reason?: string | null; providerData?: Json }): Promise<{ payment: Payment; refundId: string; amount: number }> {
    let p = p0;
    const inst = this.instanceOf(p);
    if (p.status !== 'paid' && p.status !== 'partially_refunded') throw new HttpError(409, `Payment is ${p.status}; only paid payments can be refunded`, { status: p.status });
    // A partial capture can only be refunded up to what was captured.
    const capturedTotal = p.providerData.capturedAmount === undefined || p.providerData.capturedAmount === null ? p.amount : Number(p.providerData.capturedAmount);
    const left = capturedTotal - p.refunded;
    const amt = amount === null || amount === undefined ? left : Math.round(amount);
    if (!(amt > 0)) throw new HttpError(400, 'Refund amount must be positive');
    if (amt > left) {
      p = this.addLint(p, [finding('pay.refund-exceeds', `Refund of ${formatMoney(amt, p.currency)} exceeds the ${formatMoney(left, p.currency)} left`)]);
      this.changed(p.projectId, { payment: p.id });
      throw new HttpError(400, `Refund amount (${formatMoney(amt, p.currency)}) is greater than the amount left to refund (${formatMoney(left, p.currency)})`, { code: 'amount_too_large', left });
    }
    const refunded = p.refunded + amt;
    p = this.setStatus(p, refunded >= capturedTotal && p.providerData.partialCapture !== true ? 'refund_full' : 'refund_partial', { refunded, ...(opts.providerData ? { providerData: { ...p.providerData, ...opts.providerData } } : {}) });
    const r = this.repo.addRefund(p, opts.providerRef, amt, opts.status ?? 'succeeded');
    this.repo.addEvent(p, 'refunded', { refund: r.providerRef, amount: amt, reason: opts.reason ?? null, ...(r.status !== 'succeeded' ? { refundStatus: r.status } : {}) });
    const ctx: EventCtx = { refund: r.providerRef, refundStatus: r.status };
    await this.webhooks.emit(p, inst, 'refunded', p.outcome ? parseOutcome(p.outcome) : null, ctx);
    this.changed(p.projectId, { payment: p.id, refunded: amt });
    return { payment: this.repo.get(p.id)!, refundId: r.providerRef, amount: amt };
  }

  /**
   * A pending (or not yet failed) refund resolves (from its scheduled settle webhook). A failed refund gives its amount
   * back: the payment's refunded total goes down and the status back to paid / partially_refunded. Idempotent.
   */
  settleRefund(p0: Payment, providerRef: string, to: { status: 'succeeded' | 'failed'; failureReason?: string | null }): Payment {
    let p = this.repo.get(p0.id) ?? p0;
    const r = this.repo.refunds(p.id).find((x) => x.providerRef === providerRef);
    if (!r || r.status === to.status || r.status === 'failed') return p;
    const before = p.status;
    this.repo.setRefundStatus(p.id, providerRef, to.status);
    if (to.status === 'failed') {
      const refunded = Math.max(0, p.refunded - r.amount);
      const status: PaymentStatus = refunded > 0 ? 'partially_refunded' : 'paid';
      const extras = (p.providerData.refunds as Record<string, Json> | undefined) ?? {};
      const providerData = { ...p.providerData, refunds: { ...extras, [providerRef]: { ...(extras[providerRef] ?? {}), failureReason: to.failureReason ?? null } } };
      p = this.repo.update(p.id, { refunded, status, providerData });
      if (status !== before) this.repo.addEvent(p, 'status', { from: before, to: status, event: 'refund_failed' });
      this.repo.addEvent(p, 'refund_failed', { refund: providerRef, amount: r.amount, failureReason: to.failureReason ?? null });
    } else {
      this.repo.addEvent(p, 'refund_settled', { refund: providerRef, amount: r.amount });
    }
    this.changed(p.projectId, { payment: p.id });
    return p;
  }

  async expire(p: Payment, why: 'api' | 'timeout' = 'api'): Promise<Payment> {
    const inst = this.instanceOf(p);
    const out = this.setStatus(p, 'expire');
    this.repo.addEvent(out, 'expired', { why });
    await this.webhooks.emit(out, inst, 'expired', null);
    this.changed(p.projectId, { payment: p.id });
    return this.repo.get(p.id)!;
  }

  /** Authorised but not captured → voided (PayTabs void, HyperPay RV, PayPal authorization void). webhook: send the "cancelled" events. */
  async voidPayment(p: Payment, opts: { webhook?: boolean } = {}): Promise<Payment> {
    const out = this.setStatus(p, 'void', { providerData: { ...p.providerData, voided: true } });
    this.repo.addEvent(out, 'voided', {});
    if (opts.webhook) await this.webhooks.emit(out, this.instanceOf(out), 'cancelled', null);
    this.changed(p.projectId, { payment: p.id });
    return this.repo.get(p.id)!;
  }

  // ---------------- rules ----------------

  ruleView(r: PaymentRule) {
    const inst = r.instanceId ? this.repo.instanceById(r.instanceId) : null;
    const user = r.testUserId ? this.hub.users.get(r.projectId, r.testUserId) : null;
    const run = r.runId ? this.hub.runs.repo.get(r.runId) : null;
    return { ...r, instance: inst?.slug ?? null, user: user ? { id: user.id, name: user.name } : null, run: run?.key ?? null, level: r.runId ? 'run' : r.testUserId ? 'user' : 'instance' };
  }

  addRule(project: Project, b: Json, run: Run | null): PaymentRule {
    if (!b.outcome) throw new HttpError(400, 'outcome is required, e.g. "decline:insufficient_funds"');
    const outcome = isRefundOutcome(String(b.outcome)) ? normalizeRefundOutcome(String(b.outcome)) : normalizeOutcome(String(b.outcome));
    const inst = b.instance ? this.repo.requireInstance(project.id, String(b.instance)) : null;
    const user = b.user ? this.hub.users.requireRef(project.id, String(b.user), run?.id) : null;
    const count = b.count === undefined || b.count === null || b.count === '' ? null : Number(b.count);
    if (count !== null && !(Number.isInteger(count) && count >= 1)) throw new HttpError(400, 'count must be a whole number >= 1');
    const after = b.after ? Number(b.after) : 0;
    if (!(Number.isInteger(after) && after >= 0)) throw new HttpError(400, 'after must be a whole number >= 0');
    const minutes = b.minutes ? Number(b.minutes) : null;
    if (minutes !== null && !(minutes > 0)) throw new HttpError(400, 'minutes must be positive');
    const r = this.repo.addRule(project.id, {
      instanceId: inst?.id ?? null,
      testUserId: user?.id ?? null,
      runId: run?.id ?? null,
      outcome,
      remaining: count,
      skipCount: after,
      expiresAt: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
      label: b.label ? String(b.label).slice(0, 200) : null,
    });
    this.changed(project.id, { rule: r.id });
    return r;
  }

  // ---------------- waiting ----------------

  /** Long-poll: the newest payment matching the filters (status default: any final or approved state). */
  async wait(project: Project, f: { status?: string[]; instanceId?: string; testUserId?: string; runId?: string; reference?: string; after?: string }, timeoutMs: number): Promise<Payment | null> {
    const find = () => this.repo.list(project.id, { ...f, limit: 1 })[0] ?? null;
    const hit = find();
    if (hit) return hit;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: Payment | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve(v);
      };
      const unsub = this.hub.bus.subscribe((e) => {
        if (e.type !== 'payments.changed' || e.projectId !== project.id) return;
        const p = find();
        if (p) finish(p);
      });
      const timer = setTimeout(() => finish(find()), timeoutMs);
    });
  }

  // ---------------- lint report ----------------

  lintReport(project: Project, run: Run | null) {
    const payments = this.repo.list(project.id, { runId: run?.id, limit: 500 });
    const findings: (LintFinding & { payment: string | null; instance: string })[] = [];
    const instances = this.repo.listInstances(project.id);
    const slugOf = (id: string) => instances.find((i) => i.id === id)?.slug ?? '?';
    for (const p of payments) for (const f of p.lint) findings.push({ ...f, payment: p.id, instance: slugOf(p.instanceId) });
    for (const inst of instances) {
      for (const f of this.instanceLint.get(inst.id) ?? []) findings.push({ ...f, payment: null, instance: inst.slug });
      if (inst.preset === 'paypal') {
        const delivered = this.repo.countEvents(project.id, 'webhook_delivered', inst.id);
        const verified = this.repo.countEvents(project.id, 'paypal_signature_verified', inst.id);
        if (delivered > 0 && verified === 0) {
          findings.push({ ...finding('pay.paypal-signature-never-verified', `${delivered} PayPal webhook(s) delivered by ${inst.slug}, but verify-webhook-signature was never called`), payment: null, instance: inst.slug });
        }
      }
    }
    // Payments 1b: findings that need time to pass (30 s grace after the buyer step).
    const now = Date.now();
    for (const p of payments) {
      const inst = instances.find((i) => i.id === p.instanceId);
      if (!inst || now - Date.parse(p.updatedAt) < 30_000) continue;
      if (inst.preset === 'paypal' && p.status === 'authorized' && !p.providerData.captured && !p.providerData.authorization && !p.providerData.async) {
        findings.push({ ...finding('pay.paypal-approve-without-capture', `Order ${p.providerRef} was approved but never ${p.providerData.intent === 'AUTHORIZE' ? 'authorized' : 'captured'} (onApprove should call your server)`), payment: p.id, instance: inst.slug });
      }
      const late = this.gateway(inst.preset).lateLint?.(this, p, inst) ?? [];
      for (const f of late) findings.push({ ...f, payment: p.id, instance: inst.slug });
      if (inst.preset === 'hyperpay' && !OPEN.includes(p.status) && p.status !== 'expired' && !this.repo.events(p.id).some((e) => e.type === 'status_queried')) {
        findings.push({ ...finding('pay.hyperpay-result-never-queried', `Checkout ${p.providerRef} finished but GET {resourcePath} was never called: the shopper's return is not proof of payment`), payment: p.id, instance: inst.slug });
      }
    }
    const bySeverity = { error: 0, warn: 0, info: 0 } as Record<string, number>;
    const byCheck: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
    }
    return { payments: payments.length, level: lintLevelOf(findings), counts: bySeverity, byCheck, findings: findings.slice(0, 200) };
  }

  // ---------------- lifecycle hooks ----------------

  /** RunService.stop(): the run's rules go. */
  onRunStopped(runId: string): void {
    const n = this.repo.deleteRulesForRun(runId);
    if (n) this.hub.bus.publish({ type: 'payments.changed', projectId: null, data: { runStopped: runId, rules: n } });
  }

  /** RunService.purge(): the run's payments (and vault tokens) go. */
  purgeRun(runId: string): number {
    this.repo.deleteTokensForRun(runId);
    return this.repo.deleteForRun(runId);
  }

  /** Project reset: payments deleted, rule hit counters back to 0. */
  resetProject(projectId: string): number {
    const n = this.repo.deleteForProject(projectId);
    this.repo.deleteTokensForProject(projectId);
    this.repo.resetRuleHits(projectId);
    for (const i of this.repo.listInstances(projectId)) this.instanceLint.delete(i.id);
    this.changed(projectId, { reset: n });
    return n;
  }

  changed(projectId: string, data: unknown): void {
    this.hub.bus.publish({ type: 'payments.changed', projectId, data });
  }
}

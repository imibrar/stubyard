import { parseOffset } from '../../clock/clock.js';
import type { Hub } from '../../hub.js';
import type { Job } from '../../jobs/scheduler.js';
import { HttpError } from '../../util.js';
import { asString, decodeRef, header, IdempotencyCache, upper } from '../common.js';
import { currencyDigits, fromDecimal, toDecimal } from '../engine.js';
import type { GatewayCtx, Json, LifecyclePoint, ReturnSpec } from '../gateway.js';
import { finding, httpUrl, rejectUrl } from '../lint.js';
import type { Payment, PaymentInstance, PaymentToken } from '../repo.js';
import type { PaymentService } from '../service.js';
import { debugId, PP_KIND, ppAdd, ppError, ppFind, ppList, ppSave, ppTime, sendPpEvent } from './billing.js';
import { invalidRequest, PpError } from './index.js';

/**
 * PayPal Subscriptions on the fake: Catalog Products v1 (/v1/catalogs/products), Billing Plans v1 and Subscriptions v1
 * (/v1/billing/plans, /v1/billing/subscriptions). A new subscription is APPROVAL_PENDING with an "approve" link to the
 * stubyard PayPal page (an approval payment carries the first charge: setup fee + first cycle); approving activates it
 * and returns the buyer to return_url?subscription_id=…&ba_token=…&token=…. Later cycles are billed by a durable job
 * at next_billing_time on the subscription's own clock (data.clockOffsetMs, moved by the control API "advance"), each
 * cycle a payment row (kind order, providerData.subscription) with PAYMENT.SALE.COMPLETED, or a declined one with
 * BILLING.SUBSCRIPTION.PAYMENT.FAILED (payment_failure_threshold reached → SUSPENDED). Only PayPal wallet
 * subscriptions are simulated (no card subscriptions, no plan_override tiers validation beyond the basics).
 */

export const BILL_JOB = 'paypal.subscription.bill';
const idem = new Map<string, IdempotencyCache>();
const DAY = 86_400_000;

type Money = { currency_code: string; value: string };
const money = (minor: number, cur: string): Money => ({ currency_code: cur, value: toDecimal(minor, cur) });

function parseMoney(v: unknown, field: string, currency?: string | null): { minor: number; currency: string } {
  const m = (v ?? {}) as Json;
  const cur = (asString(m.currency_code) ?? '').toUpperCase();
  if (!cur || currencyDigits(cur) === null) throw invalidRequest(`${field}/currency_code`, cur ? 'INVALID_PARAMETER_VALUE' : 'MISSING_REQUIRED_PARAMETER', cur ? 'Currency code is not supported.' : 'A required field / parameter is missing.');
  if (currency && cur !== currency) throw ppError(422, 'CURRENCY_MISMATCH', `All amounts must use the same currency (${currency}).`, { field });
  const a = fromDecimal(m.value, cur);
  if (!a.ok || a.minor < 0) throw invalidRequest(`${field}/value`, 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
  if (a.digits > (currencyDigits(cur) ?? 2)) throw invalidRequest(`${field}/value`, 'DECIMAL_PRECISION', 'If the currency supports decimals, only two decimal place precision is supported.');
  return { minor: a.minor, currency: cur };
}

const preferFull = (c: GatewayCtx) => /return=representation/i.test(header(c.req, 'prefer') ?? '');
const apiOf = (svc: PaymentService, inst: PaymentInstance) => svc.urls(svc.hub.projects.get(inst.projectId)!, inst).backend;
const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** page / page_size / total_required of the list endpoints. */
function paging(c: GatewayCtx, max: number, def: number) {
  const size = c.query.page_size === undefined ? def : Number(c.query.page_size);
  const page = c.query.page === undefined ? 1 : Number(c.query.page);
  if (!Number.isInteger(size) || size < 1 || size > max) throw invalidRequest('page_size', 'INVALID_PARAMETER_VALUE', `page_size must be 1 to ${max}.`);
  if (!Number.isInteger(page) || page < 1) throw invalidRequest('page', 'INVALID_PARAMETER_VALUE', 'page must be a positive integer.');
  return { size, page, total: String(c.query.total_required ?? '') === 'true' };
}
function pageOf<T>(list: T[], p: { size: number; page: number; total: boolean }, href: string): { items: T[]; extra: Json } {
  const items = list.slice((p.page - 1) * p.size, p.page * p.size);
  const pages = Math.max(1, Math.ceil(list.length / p.size));
  const links: Json[] = [{ href: `${href}?page_size=${p.size}&page=${p.page}`, rel: 'self', method: 'GET' }];
  if (p.page < pages) links.push({ href: `${href}?page_size=${p.size}&page=${p.page + 1}`, rel: 'next', method: 'GET' });
  if (p.page > 1) links.push({ href: `${href}?page_size=${p.size}&page=${p.page - 1}`, rel: 'prev', method: 'GET' });
  return { items, extra: { ...(p.total ? { total_items: list.length, total_pages: pages } : {}), links } };
}

/** JSON Patch (RFC 6902) on a copy of the resource; only the listed paths. */
function applyPatch(raw: unknown, target: Json, allowed: Record<string, (v: unknown, op: string) => void>): void {
  if (!Array.isArray(raw) || !raw.length) throw invalidRequest('/', 'MISSING_REQUEST_BODY', 'The request body is a JSON Patch array: [{"op":"replace","path":"/description","value":"…"}].');
  for (const [i, o] of (raw as Json[]).entries()) {
    const op = asString(o?.op);
    const path = asString(o?.path) ?? '';
    if (!op || !['add', 'replace', 'remove'].includes(op)) throw invalidRequest(`/${i}/op`, 'UNSUPPORTED_PATCH_OPERATION', 'The operation is not supported (add, replace, remove).');
    const set = allowed[path];
    if (!set) throw invalidRequest(`/${i}/path`, 'INVALID_PATCH_PATH', `The path ${path || '(none)'} cannot be patched. Patchable here: ${Object.keys(allowed).join(', ')}.`);
    set(op === 'remove' ? undefined : o.value, op);
  }
  void target;
}

// ---------------------------------------------------------------- products

const PRODUCT_TYPES = ['PHYSICAL', 'DIGITAL', 'SERVICE'];

function productOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, full = true): Json {
  const api = apiOf(svc, inst);
  const d = t.data;
  const self = { href: `${api}/v1/catalogs/products/${t.providerRef}`, rel: 'self', method: 'GET' };
  if (!full) return clean({ id: t.providerRef, name: d.name, description: d.description, create_time: d.create_time, links: [self] });
  return clean({ id: t.providerRef, name: d.name, description: d.description, type: d.type, category: d.category, image_url: d.image_url, home_url: d.home_url, create_time: d.create_time, update_time: d.update_time, links: [self, { href: self.href, rel: 'edit', method: 'PATCH' }] });
}

function urlField(v: unknown, field: string): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  if (!httpUrl(s)) throw invalidRequest(field, 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format (an http(s) URL).');
  return s;
}

async function productsRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const { svc, inst, path } = c;
  const m = c.req.method;
  if (path === '/v1/catalogs/products' && m === 'POST') {
    c.resolved.endpoint = 'create product';
    const name = asString(b.name);
    if (!name) throw invalidRequest('/name', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    const type = (asString(b.type) ?? 'PHYSICAL').toUpperCase();
    if (!PRODUCT_TYPES.includes(type)) throw invalidRequest('/type', 'INVALID_PARAMETER_VALUE', 'type must be PHYSICAL, DIGITAL or SERVICE.');
    const id = asString(b.id) ?? `PROD-${upper(17)}`;
    if (!/^[A-Za-z0-9_-]{6,50}$/.test(id)) throw invalidRequest('/id', 'INVALID_PARAMETER_SYNTAX', 'id must be 6 to 50 characters (letters, digits, - and _).');
    if (ppFind(svc, inst, PP_KIND.product, id)) throw ppError(422, 'DUPLICATE_RESOURCE_IDENTIFIER', 'A product with this id already exists.', { api: 'catalog', field: '/id' });
    const now = ppTime();
    const t = ppAdd(svc, inst, PP_KIND.product, { ref: id, status: 'ACTIVE', runId: c.run?.id ?? null, data: clean({ name, description: asString(b.description), type, category: asString(b.category), image_url: urlField(b.image_url, '/image_url'), home_url: urlField(b.home_url, '/home_url'), create_time: now, update_time: now }) });
    await sendPpEvent(svc, inst, t, { type: 'CATALOG.PRODUCT.CREATED', resourceType: 'product', resourceVersion: '1.0', summary: 'A product has been created.', resource: productOf(svc, inst, t) });
    svc.changed(inst.projectId, { paypal: 'product', id });
    return c.reply.status(201).send(productOf(svc, inst, t));
  }
  if (path === '/v1/catalogs/products' && m === 'GET') {
    c.resolved.endpoint = 'list products';
    const pg = paging(c, 20, 10);
    const all = ppList(svc, inst.projectId, PP_KIND.product, { instanceId: inst.id }).reverse();
    const { items, extra } = pageOf(all, pg, `${apiOf(svc, inst)}/v1/catalogs/products`);
    return { products: items.map((t) => productOf(svc, inst, t, false)), ...extra };
  }
  const mm = /^\/v1\/catalogs\/products\/([^/]+)$/.exec(path);
  if (!mm) return undefined;
  const t = ppFind(svc, inst, PP_KIND.product, decodeRef(mm[1]!));
  if (!t) throw ppError(404, 'INVALID_RESOURCE_ID', 'The specified resource ID does not exist.', { api: 'catalog' });
  if (m === 'GET') {
    c.resolved.endpoint = 'get product';
    return productOf(svc, inst, t);
  }
  if (m === 'PATCH') {
    c.resolved.endpoint = 'update product';
    const d = { ...t.data };
    const setter = (k: string, f?: (v: unknown) => unknown) => (v: unknown) => (d[k] = v === undefined ? undefined : f ? f(v) : String(v));
    applyPatch(c.req.body, d, {
      '/description': setter('description'),
      '/category': setter('category'),
      '/image_url': setter('image_url', (v) => urlField(v, '/image_url')),
      '/home_url': setter('home_url', (v) => urlField(v, '/home_url')),
    });
    d.update_time = ppTime();
    const n = svc.repo.updateToken(t.id, { data: d });
    await sendPpEvent(svc, inst, n, { type: 'CATALOG.PRODUCT.UPDATED', resourceType: 'product', resourceVersion: '1.0', summary: 'A product has been updated.', resource: productOf(svc, inst, n) });
    svc.changed(inst.projectId, { paypal: 'product', id: t.providerRef });
    return c.reply.status(204).send();
  }
  return undefined;
}

// ---------------------------------------------------------------- plans

interface Cycle {
  frequency: { interval_unit: string; interval_count: number };
  tenure_type: 'TRIAL' | 'REGULAR';
  sequence: number;
  total_cycles: number;
  pricing_scheme?: Json;
}

const UNITS = ['DAY', 'WEEK', 'MONTH', 'YEAR'];
const MAX_COUNT: Record<string, number> = { DAY: 365, WEEK: 52, MONTH: 12, YEAR: 1 };

function parsePricing(v: unknown, field: string, currency: { cur: string | null }): Json {
  const ps = (v ?? {}) as Json;
  const now = ppTime();
  if (ps.fixed_price) {
    const fp = parseMoney(ps.fixed_price, `${field}/fixed_price`, currency.cur);
    currency.cur = fp.currency;
    return { version: 1, fixed_price: money(fp.minor, fp.currency), create_time: now, update_time: now };
  }
  if (Array.isArray(ps.tiers) && ps.tiers.length) {
    const model = (asString(ps.pricing_model) ?? 'VOLUME').toUpperCase();
    if (model !== 'VOLUME' && model !== 'TIERED') throw ppError(422, 'INVALID_PRICING_MODEL', 'pricing_model must be VOLUME or TIERED.', { field: `${field}/pricing_model` });
    const tiers = (ps.tiers as Json[]).map((t, i) => {
      const a = parseMoney(t.amount, `${field}/tiers/${i}/amount`, currency.cur);
      currency.cur = a.currency;
      return clean({ starting_quantity: String(t.starting_quantity ?? '1'), ending_quantity: asString(t.ending_quantity), amount: money(a.minor, a.currency) });
    });
    return { version: 1, pricing_model: model, tiers, create_time: now, update_time: now };
  }
  throw invalidRequest(`${field}`, 'MISSING_REQUIRED_PARAMETER', 'pricing_scheme needs fixed_price (or tiers with pricing_model).');
}

function parseCycles(v: unknown, currency: { cur: string | null }): Cycle[] {
  if (!Array.isArray(v) || !v.length) throw invalidRequest('/billing_cycles', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (v.length > 12) throw invalidRequest('/billing_cycles', 'INVALID_ARRAY_MAX_ITEMS', 'At most 12 billing cycles.');
  const out = (v as Json[]).map((raw, i): Cycle => {
    const f = `/billing_cycles/${i}`;
    const fr = (raw.frequency ?? {}) as Json;
    const unit = (asString(fr.interval_unit) ?? '').toUpperCase();
    if (!UNITS.includes(unit)) throw invalidRequest(`${f}/frequency/interval_unit`, unit ? 'INVALID_PARAMETER_VALUE' : 'MISSING_REQUIRED_PARAMETER', 'interval_unit must be DAY, WEEK, MONTH or YEAR.');
    const count = fr.interval_count === undefined ? 1 : Number(fr.interval_count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT[unit]!) throw invalidRequest(`${f}/frequency/interval_count`, 'INVALID_INTEGER_MAX_VALUE', `interval_count for ${unit} is 1 to ${MAX_COUNT[unit]}.`);
    const tenure = (asString(raw.tenure_type) ?? '').toUpperCase();
    if (tenure !== 'TRIAL' && tenure !== 'REGULAR') throw invalidRequest(`${f}/tenure_type`, tenure ? 'INVALID_PARAMETER_VALUE' : 'MISSING_REQUIRED_PARAMETER', 'tenure_type must be TRIAL or REGULAR.');
    const seq = Number(raw.sequence);
    if (!Number.isInteger(seq) || seq < 1 || seq > 99) throw invalidRequest(`${f}/sequence`, raw.sequence === undefined ? 'MISSING_REQUIRED_PARAMETER' : 'INVALID_PARAMETER_VALUE', 'sequence must be an integer from 1.');
    const total = raw.total_cycles === undefined ? 1 : Number(raw.total_cycles);
    if (!Number.isInteger(total) || total < 0 || total > 999) throw invalidRequest(`${f}/total_cycles`, 'INVALID_INTEGER_MAX_VALUE', 'total_cycles is 0 (infinite, REGULAR only) to 999.');
    if (total === 0 && tenure === 'TRIAL') throw ppError(422, 'INVALID_BILLING_CYCLE_SEQUENCE', 'A TRIAL cycle cannot be infinite (total_cycles 0).', { field: `${f}/total_cycles` });
    const cyc: Cycle = { frequency: { interval_unit: unit, interval_count: count }, tenure_type: tenure, sequence: seq, total_cycles: total };
    if (raw.pricing_scheme) cyc.pricing_scheme = parsePricing(raw.pricing_scheme, `${f}/pricing_scheme`, currency);
    else if (tenure === 'REGULAR') throw invalidRequest(`${f}/pricing_scheme`, 'MISSING_REQUIRED_PARAMETER', 'A REGULAR billing cycle needs a pricing_scheme.');
    return cyc;
  });
  out.sort((a, b) => a.sequence - b.sequence);
  const seqs = out.map((x) => x.sequence);
  if (new Set(seqs).size !== seqs.length || seqs.some((s, i) => s !== i + 1)) throw ppError(422, 'INVALID_BILLING_CYCLE_SEQUENCE', 'Billing cycle sequences must be 1, 2, 3… without gaps or repeats.');
  const firstRegular = out.findIndex((x) => x.tenure_type === 'REGULAR');
  if (firstRegular < 0) throw ppError(422, 'INVALID_BILLING_CYCLE_SEQUENCE', 'A plan needs one REGULAR billing cycle.');
  if (out.slice(firstRegular).some((x) => x.tenure_type === 'TRIAL')) throw ppError(422, 'INVALID_BILLING_CYCLE_SEQUENCE', 'TRIAL cycles come before the REGULAR cycle.');
  if (out.slice(0, -1).some((x) => x.total_cycles === 0)) throw ppError(422, 'INVALID_BILLING_CYCLE_SEQUENCE', 'Only the last cycle can be infinite (total_cycles 0).');
  return out;
}

function parsePrefs(v: unknown, currency: { cur: string | null }): Json {
  const p = (v ?? {}) as Json;
  const out: Json = { auto_bill_outstanding: p.auto_bill_outstanding === undefined ? true : p.auto_bill_outstanding === true || p.auto_bill_outstanding === 'true', setup_fee_failure_action: (asString(p.setup_fee_failure_action) ?? 'CANCEL').toUpperCase(), payment_failure_threshold: p.payment_failure_threshold === undefined ? 0 : Number(p.payment_failure_threshold) };
  if (!['CONTINUE', 'CANCEL'].includes(String(out.setup_fee_failure_action))) throw invalidRequest('/payment_preferences/setup_fee_failure_action', 'INVALID_PARAMETER_VALUE', 'setup_fee_failure_action must be CONTINUE or CANCEL.');
  const th = Number(out.payment_failure_threshold);
  if (!Number.isInteger(th) || th < 0 || th > 999) throw invalidRequest('/payment_preferences/payment_failure_threshold', 'INVALID_INTEGER_MAX_VALUE', 'payment_failure_threshold is 0 to 999.');
  if (p.setup_fee) {
    const f = parseMoney(p.setup_fee, '/payment_preferences/setup_fee', currency.cur);
    currency.cur = f.currency;
    out.setup_fee = money(f.minor, f.currency);
  }
  return out;
}

function planOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, full = true): Json {
  const api = apiOf(svc, inst);
  const d = t.data;
  const self = `${api}/v1/billing/plans/${t.providerRef}`;
  const links: Json[] = [{ href: self, rel: 'self', method: 'GET', encType: 'application/json' }, { href: self, rel: 'edit', method: 'PATCH', encType: 'application/json' }];
  if (t.status === 'ACTIVE') links.push({ href: `${self}/deactivate`, rel: 'self', method: 'POST', encType: 'application/json' });
  else links.push({ href: `${self}/activate`, rel: 'self', method: 'POST', encType: 'application/json' });
  const base = { id: t.providerRef, product_id: d.product_id, name: d.name, status: t.status, description: d.description, usage_type: 'LICENSED', create_time: d.create_time };
  if (!full) return clean({ ...base, links });
  return clean({ ...base, billing_cycles: d.billing_cycles, payment_preferences: d.payment_preferences, taxes: d.taxes, quantity_supported: d.quantity_supported === true, update_time: d.update_time, links });
}

const planEvent = (svc: PaymentService, inst: PaymentInstance, t: PaymentToken, type: string, summary: string) =>
  sendPpEvent(svc, inst, t, { type, resourceType: 'plan', resourceVersion: '2.0', summary, resource: planOf(svc, inst, t) });

async function plansRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const { svc, inst, path } = c;
  const m = c.req.method;
  if (path === '/v1/billing/plans' && m === 'POST') {
    c.resolved.endpoint = 'create plan';
    const productId = asString(b.product_id);
    if (!productId) throw invalidRequest('/product_id', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    if (!ppFind(svc, inst, PP_KIND.product, productId)) throw invalidRequest('/product_id', 'INVALID_PARAMETER_VALUE', `Product ${productId} does not exist (create it with POST /v1/catalogs/products).`);
    const name = asString(b.name);
    if (!name) throw invalidRequest('/name', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    if (!b.payment_preferences) throw invalidRequest('/payment_preferences', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    const status = (asString(b.status) ?? 'ACTIVE').toUpperCase();
    if (!['CREATED', 'INACTIVE', 'ACTIVE'].includes(status)) throw invalidRequest('/status', 'INVALID_PARAMETER_VALUE', 'status must be CREATED, INACTIVE or ACTIVE.');
    const currency = { cur: null as string | null };
    const cycles = parseCycles(b.billing_cycles, currency);
    const prefs = parsePrefs(b.payment_preferences, currency);
    const taxes = b.taxes ? clean({ percentage: String((b.taxes as Json).percentage ?? '0'), inclusive: (b.taxes as Json).inclusive === undefined ? true : (b.taxes as Json).inclusive === true }) : undefined;
    if (taxes && !(Number(taxes.percentage) >= 0 && Number(taxes.percentage) <= 100)) throw invalidRequest('/taxes/percentage', 'INVALID_PARAMETER_VALUE', 'percentage is 0 to 100.');
    const now = ppTime();
    const t = ppAdd(svc, inst, PP_KIND.plan, { ref: `P-${upper(24)}`, status, runId: c.run?.id ?? null, data: clean({ product_id: productId, name, description: asString(b.description), billing_cycles: cycles, payment_preferences: prefs, taxes, quantity_supported: b.quantity_supported === true, currency: currency.cur, create_time: now, update_time: now }) });
    await planEvent(svc, inst, t, 'BILLING.PLAN.CREATED', 'A billing plan was created.');
    if (status === 'ACTIVE') await planEvent(svc, inst, t, 'BILLING.PLAN.ACTIVATED', 'A billing plan was activated.');
    svc.changed(inst.projectId, { paypal: 'plan', id: t.providerRef });
    return c.reply.status(201).send(planOf(svc, inst, t, preferFull(c)));
  }
  if (path === '/v1/billing/plans' && m === 'GET') {
    c.resolved.endpoint = 'list plans';
    const pg = paging(c, 20, 10);
    const product = asString(c.query.product_id);
    const ids = asString(c.query.plan_ids)?.split(',');
    const all = ppList(svc, inst.projectId, PP_KIND.plan, { instanceId: inst.id })
      .reverse()
      .filter((t) => (!product || t.data.product_id === product) && (!ids || ids.includes(t.providerRef)));
    const { items, extra } = pageOf(all, pg, `${apiOf(svc, inst)}/v1/billing/plans`);
    return { plans: items.map((t) => planOf(svc, inst, t, preferFull(c))), ...extra };
  }
  const mm = /^\/v1\/billing\/plans\/([^/]+)(?:\/(activate|deactivate|update-pricing-schemes))?$/.exec(path);
  if (!mm) return undefined;
  const t = ppFind(svc, inst, PP_KIND.plan, decodeRef(mm[1]!));
  if (!t) throw ppError(404, 'INVALID_RESOURCE_ID', 'Requested resource ID was not found.');
  const action = mm[2];
  if (!action && m === 'GET') {
    c.resolved.endpoint = 'get plan';
    return planOf(svc, inst, t);
  }
  if (!action && m === 'PATCH') {
    c.resolved.endpoint = 'update plan';
    if (t.status === 'INACTIVE') throw ppError(422, 'PLAN_STATUS_INACTIVE', 'The plan is INACTIVE; activate it before updating.');
    const d = { ...t.data, payment_preferences: { ...((t.data.payment_preferences as Json) ?? {}) }, taxes: t.data.taxes ? { ...(t.data.taxes as Json) } : undefined } as Json;
    const prefs = d.payment_preferences as Json;
    const cur = { cur: (t.data.currency as string | null) ?? null };
    applyPatch(c.req.body, d, {
      '/description': (v) => (d.description = v === undefined ? undefined : String(v)),
      '/name': (v) => (d.name = v === undefined ? d.name : String(v)),
      '/payment_preferences/auto_bill_outstanding': (v) => (prefs.auto_bill_outstanding = v === true || v === 'true'),
      '/payment_preferences/payment_failure_threshold': (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 999) throw invalidRequest('/payment_preferences/payment_failure_threshold', 'INVALID_PARAMETER_VALUE', 'payment_failure_threshold is 0 to 999.');
        prefs.payment_failure_threshold = n;
      },
      '/payment_preferences/setup_fee': (v) => {
        if (v === undefined) delete prefs.setup_fee;
        else {
          const f = parseMoney(v, '/payment_preferences/setup_fee', cur.cur);
          prefs.setup_fee = money(f.minor, f.currency);
        }
      },
      '/payment_preferences/setup_fee_failure_action': (v) => {
        const s = String(v ?? '').toUpperCase();
        if (!['CONTINUE', 'CANCEL'].includes(s)) throw invalidRequest('/payment_preferences/setup_fee_failure_action', 'INVALID_PARAMETER_VALUE', 'CONTINUE or CANCEL.');
        prefs.setup_fee_failure_action = s;
      },
      '/taxes/percentage': (v) => (d.taxes = { ...((d.taxes as Json | undefined) ?? { inclusive: true }), percentage: String(v ?? '0') }),
    });
    d.update_time = ppTime();
    const n = svc.repo.updateToken(t.id, { data: clean(d) });
    await planEvent(svc, inst, n, 'BILLING.PLAN.UPDATED', 'A billing plan was updated.');
    svc.changed(inst.projectId, { paypal: 'plan', id: t.providerRef });
    return c.reply.status(204).send();
  }
  if (m !== 'POST' || !action) return undefined;
  if (action === 'activate' || action === 'deactivate') {
    c.resolved.endpoint = `${action} plan`;
    const ok = action === 'activate' ? t.status === 'CREATED' || t.status === 'INACTIVE' : t.status === 'ACTIVE';
    if (!ok) throw ppError(422, 'PLAN_STATUS_INVALID', `Invalid plan status for ${action} action; plan status is ${t.status}.`);
    const n = ppSave(svc, t, { status: action === 'activate' ? 'ACTIVE' : 'INACTIVE', data: { update_time: ppTime() } });
    await planEvent(svc, inst, n, action === 'activate' ? 'BILLING.PLAN.ACTIVATED' : 'BILLING.PLAN.DEACTIVATED', `A billing plan was ${action}d.`);
    svc.changed(inst.projectId, { paypal: 'plan', id: t.providerRef });
    return c.reply.status(204).send();
  }
  // update-pricing-schemes
  c.resolved.endpoint = 'update plan pricing';
  const list = b.pricing_schemes;
  if (!Array.isArray(list) || !list.length) throw invalidRequest('/pricing_schemes', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  const cycles = ((t.data.billing_cycles as Cycle[]) ?? []).map((x) => ({ ...x }));
  const cur = { cur: (t.data.currency as string | null) ?? null };
  for (const [i, raw] of (list as Json[]).entries()) {
    const seq = Number(raw.billing_cycle_sequence);
    const cyc = cycles.find((x) => x.sequence === seq);
    if (!cyc) throw ppError(422, 'INVALID_BILLING_CYCLE_SEQUENCE', `The plan has no billing cycle ${raw.billing_cycle_sequence}.`, { field: `/pricing_schemes/${i}/billing_cycle_sequence` });
    const ps = parsePricing(raw.pricing_scheme, `/pricing_schemes/${i}/pricing_scheme`, cur);
    cyc.pricing_scheme = { ...ps, version: Number((cyc.pricing_scheme as Json | undefined)?.version ?? 0) + 1, create_time: (cyc.pricing_scheme as Json | undefined)?.create_time ?? ps.create_time };
  }
  const n = ppSave(svc, t, { data: { billing_cycles: cycles, update_time: ppTime() } });
  await planEvent(svc, inst, n, 'BILLING.PLAN.PRICING-CHANGE.ACTIVATED', 'A price change for the plan was activated.');
  svc.changed(inst.projectId, { paypal: 'plan', id: t.providerRef });
  return c.reply.status(204).send();
}

// ---------------------------------------------------------------- subscriptions: state

interface CycleState extends Cycle {
  completed: number;
}

/** The subscription's own clock: real time + data.clockOffsetMs (control API "advance"). */
export const subNow = (t: PaymentToken) => Date.now() + Number(t.data.clockOffsetMs ?? 0);

function addFrequency(fromMs: number, f: { interval_unit: string; interval_count: number }): number {
  const d = new Date(fromMs);
  const n = f.interval_count || 1;
  if (f.interval_unit === 'DAY') return fromMs + n * DAY;
  if (f.interval_unit === 'WEEK') return fromMs + 7 * n * DAY;
  if (f.interval_unit === 'MONTH') d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.getTime();
}

/** Subscription quantity range (create and revise). */
const MAX_QUANTITY = 32;
/** At most this many cycles are billed by one "advance"; data.payments keeps the newest MAX_SUB_PAYMENTS ids. */
export const MAX_ADVANCE_CYCLES = 120;
const MAX_SUB_PAYMENTS = 500;
/** Floor of the billing job delay, so a subscription whose next_billing_time is in the past cannot bill back to back. */
const MIN_BILL_DELAY_MS = 1000;

const cyclesOf = (t: PaymentToken) => ((t.data.cycles as CycleState[] | undefined) ?? []).map((x) => ({ ...x }));
const currentCycle = (cs: CycleState[]) => cs.find((x) => x.total_cycles === 0 || x.completed < x.total_cycles) ?? null;

function planFor(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): PaymentToken | null {
  return ppFind(svc, inst, PP_KIND.plan, String(t.data.plan_id));
}

/** Pricing of a cycle: the subscription's plan override for that sequence, else the plan's current scheme. */
function pricingOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, seq: number): Json | null {
  const ov = ((t.data.plan_override as Json | undefined)?.billing_cycles as Json[] | undefined)?.find((x) => Number(x.sequence) === seq);
  if (ov?.pricing_scheme) return ov.pricing_scheme as Json;
  const plan = planFor(svc, inst, t);
  return ((plan?.data.billing_cycles as Cycle[] | undefined)?.find((x) => x.sequence === seq)?.pricing_scheme as Json | undefined) ?? null;
}

function prefsOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): Json {
  const plan = planFor(svc, inst, t);
  return { ...((plan?.data.payment_preferences as Json | undefined) ?? {}), ...(((t.data.plan_override as Json | undefined)?.payment_preferences as Json | undefined) ?? {}) };
}

/** The amount one cycle bills: price × quantity (quantity_supported), + shipping, + tax when not inclusive. */
function cycleAmount(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, seq: number): number {
  const ps = pricingOf(svc, inst, t, seq);
  const cur = String(t.data.currency);
  const plan = planFor(svc, inst, t);
  // 1-32 as validated on create / revise; clamped so a bad stored value cannot make the TIERED loop below run long.
  const qty = plan?.data.quantity_supported ? Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(t.data.quantity ?? 1)) || 1)) : 1;
  let unit = 0;
  let amount = 0;
  if (ps?.fixed_price) {
    unit = fromDecimal((ps.fixed_price as Json).value, cur).minor;
    amount = unit * qty;
  } else if (Array.isArray(ps?.tiers)) {
    const tiers = (ps!.tiers as Json[]).map((x) => ({ from: Number(x.starting_quantity ?? 1), to: x.ending_quantity === undefined ? Infinity : Number(x.ending_quantity), price: fromDecimal((x.amount as Json).value, cur).minor }));
    if (String(ps!.pricing_model) === 'TIERED') {
      for (let q = 1; q <= qty; q++) amount += (tiers.find((x) => q >= x.from && q <= x.to) ?? tiers.at(-1)!).price;
    } else amount = (tiers.find((x) => qty >= x.from && qty <= x.to) ?? tiers.at(-1)!).price * qty;
  }
  if (amount > 0 && t.data.shipping_amount) amount += fromDecimal((t.data.shipping_amount as Json).value, cur).minor;
  const taxes = plan?.data.taxes as Json | undefined;
  if (amount > 0 && taxes && taxes.inclusive === false) amount += Math.round((amount * Number(taxes.percentage ?? 0)) / 100);
  return amount;
}

function setupFeeOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): number {
  const fee = prefsOf(svc, inst, t).setup_fee as Json | undefined;
  return fee ? fromDecimal(fee.value, String(t.data.currency)).minor : 0;
}

// ---------------------------------------------------------------- subscriptions: views

function subLinks(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): Json[] {
  const api = apiOf(svc, inst);
  const self = `${api}/v1/billing/subscriptions/${t.providerRef}`;
  const out: Json[] = [];
  if (t.status === 'APPROVAL_PENDING') {
    const p = t.data.approval_payment ? svc.repo.get(String(t.data.approval_payment)) : null;
    if (p) out.push({ href: svc.entryUrl(svc.hub.projects.get(inst.projectId)!, inst, p), rel: 'approve', method: 'GET' });
  }
  out.push({ href: self, rel: 'edit', method: 'PATCH' }, { href: self, rel: 'self', method: 'GET' });
  if (t.status === 'ACTIVE') out.push({ href: `${self}/cancel`, rel: 'cancel', method: 'POST' }, { href: `${self}/suspend`, rel: 'suspend', method: 'POST' }, { href: `${self}/capture`, rel: 'capture', method: 'POST' });
  if (t.status === 'SUSPENDED') out.push({ href: `${self}/cancel`, rel: 'cancel', method: 'POST' }, { href: `${self}/activate`, rel: 'activate', method: 'POST' }, { href: `${self}/capture`, rel: 'capture', method: 'POST' });
  return out;
}

export function subscriptionOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, fields: string[] = ['last_failed_payment']): Json {
  const d = t.data;
  const cur = String(d.currency);
  const out: Json = {
    status: t.status,
    ...(d.status_change_note ? { status_change_note: d.status_change_note } : {}),
    status_update_time: d.status_update_time ?? d.create_time,
    id: t.providerRef,
    plan_id: d.plan_id,
    start_time: d.start_time,
    quantity: String(d.quantity ?? '1'),
    ...(d.shipping_amount ? { shipping_amount: d.shipping_amount } : {}),
    subscriber: d.subscriber ?? {},
    create_time: d.create_time,
    ...(d.custom_id ? { custom_id: d.custom_id } : {}),
    plan_overridden: !!d.plan_override,
  };
  if (t.status !== 'APPROVAL_PENDING' && t.status !== 'APPROVED') {
    const cycles = cyclesOf(t);
    const bi: Json = {
      outstanding_balance: money(Number(d.outstanding ?? 0), cur),
      cycle_executions: cycles.map((x) => ({
        tenure_type: x.tenure_type,
        sequence: x.sequence,
        cycles_completed: x.completed,
        cycles_remaining: x.total_cycles === 0 ? 0 : Math.max(0, x.total_cycles - x.completed),
        current_pricing_scheme_version: Number((pricingOf(svc, inst, t, x.sequence) ?? {}).version ?? 1),
        total_cycles: x.total_cycles,
      })),
      failed_payments_count: Number(d.failed_count ?? 0),
    };
    const lp = d.last_payment as { amount: number; time: string } | undefined;
    if (lp) bi.last_payment = { amount: money(lp.amount, cur), time: lp.time };
    if (t.status === 'ACTIVE' && d.next_billing_time) bi.next_billing_time = d.next_billing_time;
    if (d.final_payment_time) bi.final_payment_time = d.final_payment_time;
    const lf = d.last_failed as { amount: number; time: string; reason_code: string } | undefined;
    if (lf && fields.includes('last_failed_payment')) bi.last_failed_payment = { amount: money(lf.amount, cur), time: lf.time, reason_code: lf.reason_code };
    out.billing_info = bi;
  }
  if (fields.includes('plan')) {
    const plan = planFor(svc, inst, t);
    if (plan) out.plan = planOf(svc, inst, plan);
  }
  out.update_time = d.update_time ?? d.create_time;
  out.links = subLinks(svc, inst, t);
  return out;
}

const subEvent = (svc: PaymentService, inst: PaymentInstance, t: PaymentToken, type: string, summary: string) => {
  const fresh = svc.repo.token(t.id) ?? t;
  return sendPpEvent(svc, inst, fresh, { type, resourceType: 'subscription', resourceVersion: '2.0', summary, resource: subscriptionOf(svc, inst, fresh, ['last_failed_payment']) });
};

/** Control API / dashboard view of one subscription. */
export function subscriptionView(svc: PaymentService, t: PaymentToken): Json {
  const inst = svc.repo.instanceById(t.instanceId)!;
  const plan = planFor(svc, inst, t);
  const product = plan ? ppFind(svc, inst, PP_KIND.product, String(plan.data.product_id)) : null;
  const cur = String(t.data.currency);
  const payments = ((t.data.payments as string[] | undefined) ?? []).map((id) => svc.repo.get(id)).filter((p): p is Payment => !!p);
  const approval = t.data.approval_payment ? svc.repo.get(String(t.data.approval_payment)) : null;
  const cycle = currentCycle(cyclesOf(t));
  const project = svc.hub.projects.get(t.projectId)!;
  return {
    id: t.providerRef,
    tokenId: t.id,
    instance: inst.slug,
    status: t.status,
    planId: t.data.plan_id,
    planName: plan?.data.name ?? null,
    productName: product?.data.name ?? null,
    quantity: t.data.quantity ?? '1',
    customId: t.data.custom_id ?? null,
    subscriber: t.data.subscriber ?? {},
    currency: cur,
    nextAmount: cycle && t.status === 'ACTIVE' ? toDecimal(cycleAmount(svc, inst, t, cycle.sequence), cur) : null,
    nextBillingTime: t.status === 'ACTIVE' ? (t.data.next_billing_time ?? null) : null,
    clockOffsetMs: Number(t.data.clock_offset_ms ?? t.data.clockOffsetMs ?? 0),
    now: ppTime(subNow(t)),
    cycles: cyclesOf(t).map((x) => ({ sequence: x.sequence, tenureType: x.tenure_type, completed: x.completed, total: x.total_cycles, frequency: `${x.frequency.interval_count} ${x.frequency.interval_unit}` })),
    failedCount: Number(t.data.failed_count ?? 0),
    failureThreshold: Number(prefsOf(svc, inst, t).payment_failure_threshold ?? 0),
    outstanding: toDecimal(Number(t.data.outstanding ?? 0), cur),
    approvalUrl: t.status === 'APPROVAL_PENDING' && approval ? svc.entryUrl(project, inst, approval) : null,
    approvalPayment: approval?.id ?? null,
    payments: payments.map((p) => ({ id: p.id, saleId: saleIdOf(p), status: p.status, amount: toDecimal(p.amount, p.currency), currency: p.currency, cycle: p.providerData.cycle ?? null, createdAt: p.createdAt })),
    webhooks: (t.data.webhooks as Json[] | undefined) ?? [],
    run: t.runId ? (svc.hub.runs.repo.get(t.runId)?.key ?? null) : null,
    statusNote: t.data.status_change_note ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resource: subscriptionOf(svc, inst, t, ['last_failed_payment', 'plan']),
  };
}

// ---------------------------------------------------------------- sales (one payment row per billed cycle)

export const saleIdOf = (p: Payment) => String(p.providerData.saleId ?? p.providerRef);

function saleState(p: Payment): string {
  if (p.status === 'refunded') return 'refunded';
  if (p.status === 'partially_refunded') return 'partially_refunded';
  if (p.status === 'failed') return 'denied';
  if (p.status === 'paid') return 'completed';
  return 'pending';
}

export function saleOf(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const api = apiOf(svc, inst);
  const id = saleIdOf(p);
  const fee = p.amount > 0 ? Math.min(p.amount, Math.round(p.amount * 0.0349) + 49) : 0;
  return clean({
    id,
    state: saleState(p),
    amount: { total: toDecimal(p.amount, p.currency), currency: p.currency, details: { subtotal: toDecimal(p.amount, p.currency) } },
    payment_mode: 'INSTANT_TRANSFER',
    protection_eligibility: 'ELIGIBLE',
    protection_eligibility_type: 'ITEM_NOT_RECEIVED_ELIGIBLE,UNAUTHORIZED_PAYMENT_ELIGIBLE',
    transaction_fee: { value: toDecimal(fee, p.currency), currency: p.currency },
    billing_agreement_id: p.providerData.subscription,
    custom: p.reference ?? undefined,
    create_time: ppTime(Date.parse(p.createdAt)),
    update_time: ppTime(Date.parse(p.updatedAt)),
    links: [
      { href: `${api}/v1/payments/sale/${id}`, rel: 'self', method: 'GET' },
      { href: `${api}/v1/payments/sale/${id}/refund`, rel: 'refund', method: 'POST' },
    ],
  });
}

function saleRefundOf(svc: PaymentService, p: Payment, inst: PaymentInstance, r: { providerRef: string; amount: number; createdAt: string }): Json {
  const api = apiOf(svc, inst);
  return {
    id: r.providerRef,
    state: 'completed',
    amount: { total: toDecimal(r.amount, p.currency), currency: p.currency },
    sale_id: saleIdOf(p),
    create_time: ppTime(Date.parse(r.createdAt)),
    update_time: ppTime(Date.parse(r.createdAt)),
    links: [
      { href: `${api}/v1/payments/refund/${r.providerRef}`, rel: 'self', method: 'GET' },
      { href: `${api}/v1/payments/sale/${saleIdOf(p)}`, rel: 'sale', method: 'GET' },
    ],
  };
}

/** Webhook resource of PAYMENT.SALE.* (called from paypal/index.ts eventResource). */
export function saleEventResource(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): { resource: Json; resourceType: string; resourceVersion: string; summary: string } {
  if (type === 'PAYMENT.SALE.REFUNDED') {
    const r = svc.repo.refunds(p.id).at(-1);
    return { resource: r ? saleRefundOf(svc, p, inst, r) : saleOf(svc, p, inst), resourceType: 'refund', resourceVersion: '1.0', summary: `A ${toDecimal(r?.amount ?? p.amount, p.currency)} ${p.currency} sale payment was refunded` };
  }
  return { resource: saleOf(svc, p, inst), resourceType: 'sale', resourceVersion: '1.0', summary: `Payment completed for ${toDecimal(p.amount, p.currency)} ${p.currency}` };
}

/** Lifecycle events of subscription payments (approval charge and cycles): sales, not orders / captures. */
export function subscriptionPaymentEvents(p: Payment, point: LifecyclePoint): string[] {
  if (point === 'paid' || point === 'settled') return p.amount > 0 && !p.providerData.subscriptionRevision ? ['PAYMENT.SALE.COMPLETED'] : [];
  if (point === 'refunded') return ['PAYMENT.SALE.REFUNDED'];
  return [];
}

export function subscriptionPaymentStatus(p: Payment): string {
  if (p.providerData.subscriptionApproval && ['created', 'pending', 'requires_action'].includes(p.status)) return 'APPROVAL_PENDING';
  if (p.providerData.subscriptionRevision) return p.status === 'paid' ? 'REVISION APPROVED' : 'REVISION PENDING';
  return `sale ${saleState(p)}`;
}

/** The PayPal page went back to the shop: return_url / cancel_url with subscription_id, ba_token and token. */
export function subscriptionReturn(p: Payment, kind: 'success' | 'failed' | 'cancelled'): ReturnSpec | null {
  const target = httpUrl(kind === 'cancelled' ? p.cancelUrl : p.returnUrl);
  if (!target) return null;
  const u = new URL(target);
  u.searchParams.set('subscription_id', String(p.providerData.subscription));
  u.searchParams.set('ba_token', p.providerRef);
  u.searchParams.set('token', String(p.providerData.ecToken ?? p.providerRef));
  return { kind: 'redirect', url: u.toString() };
}

function insertSale(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, f: { amount: number; ok: boolean; cycle: CycleState | null; note: string }): Payment {
  const approval = t.data.approval_payment ? svc.repo.get(String(t.data.approval_payment)) : null;
  const saleId = upper(17);
  const sub = (t.data.subscriber ?? {}) as Json;
  const p = svc.repo.insert({
    projectId: inst.projectId,
    instanceId: inst.id,
    runId: t.runId,
    testUserId: approval?.testUserId ?? null,
    kind: 'order',
    providerRef: saleId,
    secondaryRef: t.providerRef,
    status: f.ok ? 'paid' : 'failed',
    amount: f.amount,
    currency: String(t.data.currency),
    reference: asString(t.data.custom_id) ?? t.providerRef,
    customerEmail: asString(sub.email_address) ?? approval?.customerEmail ?? null,
    returnUrl: null,
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: null,
    request: { subscription_id: t.providerRef, plan_id: t.data.plan_id, note: f.note },
    providerData: { subscription: t.providerRef, saleId, sale: true, payerId: sub.payer_id ?? null, merchantId: approval?.providerData.merchantId ?? upper(13), methods: ['paypal'], ...(f.cycle ? { cycle: { sequence: f.cycle.sequence, tenure_type: f.cycle.tenure_type, number: f.cycle.completed + 1 } } : {}), ...(f.ok ? {} : { declineReason: 'generic' }) },
    idempotencyKey: null,
    lint: [],
    logId: null,
    expiresAt: null,
    method: 'paypal',
    outcome: f.ok ? 'success' : 'decline:generic',
    outcomeVia: 'subscription',
  });
  svc.repo.addEvent(p, 'created', { amount: p.amount, currency: p.currency, reference: p.reference, kind: 'order', subscription: t.providerRef, note: f.note });
  svc.repo.addEvent(p, 'outcome', { outcome: p.outcome, via: 'subscription', method: 'paypal' });
  return p;
}

// ---------------------------------------------------------------- subscriptions: lifecycle

/** Outcome of the next billing: explicit, then the queued ones (control API), then the instance default. */
function billOutcome(inst: PaymentInstance, t: PaymentToken, explicit: string | null | undefined): { ok: boolean; queue: string[] } {
  const queue = [...((t.data.next_outcomes as string[] | undefined) ?? [])];
  const raw = explicit ?? queue.shift() ?? asString(inst.config.defaultOutcome) ?? 'success';
  return { ok: !/^(decline|fail)/i.test(String(raw).trim()), queue };
}

function setStatus(t: PaymentToken, status: string, note?: string | null): { status: string; data: Json } {
  return { status, data: { status_update_time: ppTime(subNow(t)), update_time: ppTime(subNow(t)), ...(note !== undefined ? { status_change_note: note ?? undefined } : {}) } };
}

/** (Re)schedule the next billing job at next_billing_time on the subscription clock; cancels the old one. */
export function scheduleBilling(svc: PaymentService, t0: PaymentToken): PaymentToken {
  const t = svc.repo.token(t0.id) ?? t0;
  if (t.data.job_id) svc.hub.scheduler.cancel(String(t.data.job_id));
  const seq = Number(t.data.seq ?? 0) + 1;
  if (t.status !== 'ACTIVE' || !t.data.next_billing_time) return ppSave(svc, t, { data: { seq, job_id: null } });
  const delayMs = Math.max(0, Date.parse(String(t.data.next_billing_time)) - subNow(t));
  const jobId = svc.hub.scheduler.schedule(BILL_JOB, { token: t.id, seq }, { projectId: t.projectId, delayMs: Math.max(delayMs, MIN_BILL_DELAY_MS) });
  return ppSave(svc, t, { data: { seq, job_id: jobId } });
}

interface BillResult {
  payment: Payment | null;
  ok: boolean;
  amount: number;
  status: string;
  events: string[];
}

/**
 * Bill the current cycle now (job at next_billing_time, control API "bill" / "advance", capture of the outstanding
 * balance excluded). All state changes happen before the first await so a racing job sees the new seq.
 */
export async function billCycle(svc: PaymentService, inst: PaymentInstance, t0: PaymentToken, opts: { outcome?: string | null; via: string }): Promise<BillResult> {
  const t = svc.repo.token(t0.id) ?? t0;
  if (t.status !== 'ACTIVE') throw new HttpError(409, `Subscription ${t.providerRef} is ${t.status}; only ACTIVE subscriptions are billed`, { status: t.status });
  const cycles = cyclesOf(t);
  const cyc = currentCycle(cycles);
  const events: string[] = [];
  if (!cyc) {
    const n = ppSave(svc, t, setStatus(t, 'EXPIRED'));
    scheduleBilling(svc, n);
    await subEvent(svc, inst, n, 'BILLING.SUBSCRIPTION.EXPIRED', 'A billing agreement has expired.');
    return { payment: null, ok: true, amount: 0, status: 'EXPIRED', events: ['BILLING.SUBSCRIPTION.EXPIRED'] };
  }
  const due = Date.parse(String(t.data.next_billing_time ?? ppTime(subNow(t))));
  const price = cycleAmount(svc, inst, t, cyc.sequence);
  const prefs = prefsOf(svc, inst, t);
  const outcome = billOutcome(inst, t, opts.outcome);
  let outstanding = Number(t.data.outstanding ?? 0);
  let failed = Number(t.data.failed_count ?? 0);
  let payment: Payment | null = null;
  const data: Json = { next_outcomes: outcome.queue };
  let amount = 0;
  if (price > 0) {
    if (outcome.ok) {
      amount = price + (prefs.auto_bill_outstanding === false ? 0 : outstanding);
      payment = insertSale(svc, inst, t, { amount, ok: true, cycle: cyc, note: `cycle ${cyc.sequence}/${cyc.completed + 1} (${opts.via})` });
      if (prefs.auto_bill_outstanding !== false) outstanding = 0;
      failed = 0;
      data.last_payment = { amount, time: ppTime(subNow(t)) };
    } else {
      amount = price;
      payment = insertSale(svc, inst, t, { amount, ok: false, cycle: cyc, note: `cycle ${cyc.sequence}/${cyc.completed + 1} declined (${opts.via})` });
      outstanding += price;
      failed += 1;
      data.last_failed = { amount: price, time: ppTime(subNow(t)), reason_code: 'PAYMENT_DENIED' };
    }
    data.payments = [...((t.data.payments as string[] | undefined) ?? []), payment.id].slice(-MAX_SUB_PAYMENTS);
  }
  cyc.completed += 1;
  const idx = cycles.findIndex((x) => x.sequence === cyc.sequence);
  cycles[idx] = cyc;
  const more = currentCycle(cycles);
  Object.assign(data, { cycles, outstanding, failed_count: failed, update_time: ppTime(subNow(t)) });
  let status = 'ACTIVE';
  if (more) data.next_billing_time = ppTime(addFrequency(due, cyc.frequency));
  else {
    data.next_billing_time = null;
    data.final_payment_time = ppTime(subNow(t));
    status = 'EXPIRED';
  }
  const threshold = Number(prefs.payment_failure_threshold ?? 0);
  if (!outcome.ok && price > 0) {
    events.push('BILLING.SUBSCRIPTION.PAYMENT.FAILED');
    if (threshold > 0 && failed >= threshold && status === 'ACTIVE') {
      status = 'SUSPENDED';
      data.status_change_note = `Suspended after ${failed} failed payment${failed === 1 ? '' : 's'} (payment_failure_threshold ${threshold})`;
    }
  }
  let n = ppSave(svc, t, { data });
  if (status !== 'ACTIVE') n = ppSave(svc, n, setStatus(n, status, status === 'SUSPENDED' ? String(data.status_change_note) : undefined));
  if (status === 'SUSPENDED') events.push('BILLING.SUBSCRIPTION.SUSPENDED');
  if (status === 'EXPIRED') events.push('BILLING.SUBSCRIPTION.EXPIRED');
  n = scheduleBilling(svc, n);
  if (payment) svc.repo.addEvent(payment, 'subscription_billed', { subscription: t.providerRef, ok: outcome.ok, amount, via: opts.via, status });
  // Awaits from here on.
  if (payment && outcome.ok) await svc.webhooks.emit(payment, inst, 'paid', null);
  for (const e of events) await subEvent(svc, inst, n, e, e.endsWith('PAYMENT.FAILED') ? 'Subscription payment failed.' : e.endsWith('SUSPENDED') ? 'A billing agreement was suspended.' : 'A billing agreement has expired.');
  svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef, billed: true });
  return { payment, ok: outcome.ok, amount, status, events: payment && outcome.ok ? ['PAYMENT.SALE.COMPLETED', ...events] : events };
}

/** How many cycles would be due at subscription-clock time `at` (stops counting past `limit`). */
function cyclesDueBy(t: PaymentToken, at: number, limit: number): number {
  if (t.status !== 'ACTIVE' || !t.data.next_billing_time) return 0;
  const cycles = cyclesOf(t);
  let due = Date.parse(String(t.data.next_billing_time));
  let n = 0;
  while (n <= limit && !Number.isNaN(due) && due <= at) {
    const cyc = currentCycle(cycles);
    if (!cyc) break;
    n++;
    cyc.completed += 1;
    due = addFrequency(due, cyc.frequency);
  }
  return n;
}

/**
 * Control API: move the subscription clock (by "+30d" or by whole cycles) and bill every cycle that became due. A "by"
 * that would leave more than MAX_ADVANCE_CYCLES cycles due is refused (400) before the clock moves.
 */
export async function advanceSubscription(svc: PaymentService, inst: PaymentInstance, t0: PaymentToken, opts: { by?: unknown; cycles?: unknown; outcome?: string | null }): Promise<{ billed: BillResult[]; clockOffsetMs: number }> {
  let t = svc.repo.token(t0.id) ?? t0;
  const billed: BillResult[] = [];
  if (opts.by !== undefined && opts.by !== null && opts.by !== '') {
    const ms = parseOffset(opts.by);
    if (ms <= 0) throw new HttpError(400, 'by must move the clock forward, e.g. "+30d"');
    const due = cyclesDueBy(t, subNow(t) + ms, MAX_ADVANCE_CYCLES);
    if (due > MAX_ADVANCE_CYCLES) {
      throw invalidRequest('/by', 'INVALID_PARAMETER_VALUE', `Advancing by ${String(opts.by)} would make more than ${MAX_ADVANCE_CYCLES} billing cycles due; advance in smaller steps (at most ${MAX_ADVANCE_CYCLES} cycles per call).`);
    }
    t = ppSave(svc, t, { data: { clockOffsetMs: Number(t.data.clockOffsetMs ?? 0) + ms } });
    for (let i = 0; i < MAX_ADVANCE_CYCLES && t.status === 'ACTIVE' && t.data.next_billing_time && Date.parse(String(t.data.next_billing_time)) <= subNow(t); i++) {
      billed.push(await billCycle(svc, inst, t, { outcome: i === 0 ? opts.outcome : null, via: 'advance' }));
      t = svc.repo.token(t.id)!;
    }
  } else {
    const n = opts.cycles === undefined || opts.cycles === null || opts.cycles === '' ? 1 : Number(opts.cycles);
    if (!Number.isInteger(n) || n < 1 || n > MAX_ADVANCE_CYCLES) throw new HttpError(400, `cycles must be 1 to ${MAX_ADVANCE_CYCLES}`);
    for (let i = 0; i < n; i++) {
      if (t.status !== 'ACTIVE') {
        if (!billed.length) throw new HttpError(409, `Subscription ${t.providerRef} is ${t.status}; only ACTIVE subscriptions are billed`, { status: t.status });
        break;
      }
      const next = t.data.next_billing_time ? Date.parse(String(t.data.next_billing_time)) : subNow(t);
      const need = next - subNow(t);
      if (need > 0) t = ppSave(svc, t, { data: { clockOffsetMs: Number(t.data.clockOffsetMs ?? 0) + need } });
      billed.push(await billCycle(svc, inst, t, { outcome: opts.outcome, via: 'advance' }));
      t = svc.repo.token(t.id)!;
    }
  }
  scheduleBilling(svc, svc.repo.token(t.id)!);
  return { billed, clockOffsetMs: Number(svc.repo.token(t.id)!.data.clockOffsetMs ?? 0) };
}

/** Status change from the PayPal side (control API / dashboard: the buyer cancels in their account, PayPal suspends). */
export async function changeSubscriptionStatus(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, action: 'suspend' | 'activate' | 'cancel', reason: string | null): Promise<PaymentToken> {
  const allowed = action === 'activate' ? ['SUSPENDED'] : action === 'suspend' ? ['ACTIVE'] : ['ACTIVE', 'SUSPENDED', 'APPROVED'];
  if (!allowed.includes(t.status)) throw ppError(422, 'SUBSCRIPTION_STATUS_INVALID', `Invalid subscription status for ${action} action; subscription status should be ${allowed.join(' or ').toLowerCase()}.`);
  const status = action === 'activate' ? 'ACTIVE' : action === 'suspend' ? 'SUSPENDED' : 'CANCELLED';
  let n = ppSave(svc, t, setStatus(t, status, reason));
  if (action === 'activate') {
    // Missed cycles while suspended are not billed: the next one is due from the subscription clock now.
    const next = n.data.next_billing_time ? Date.parse(String(n.data.next_billing_time)) : 0;
    if (next && next < subNow(n)) {
      const cyc = currentCycle(cyclesOf(n));
      n = ppSave(svc, n, { data: { next_billing_time: cyc ? ppTime(addFrequency(subNow(n), cyc.frequency)) : null } });
    }
  }
  n = scheduleBilling(svc, n);
  const type = action === 'activate' ? 'BILLING.SUBSCRIPTION.ACTIVATED' : action === 'suspend' ? 'BILLING.SUBSCRIPTION.SUSPENDED' : 'BILLING.SUBSCRIPTION.CANCELLED';
  await subEvent(svc, inst, n, type, action === 'activate' ? 'Subscription activated.' : action === 'suspend' ? 'A billing agreement was suspended.' : 'A billing agreement was cancelled.');
  svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef });
  return svc.repo.token(n.id)!;
}

/**
 * The buyer finished the PayPal page of a subscription (gateway afterComplete, sync): activate it (the approval charge
 * was cycle 1 unless start_time is later) or apply an approved revision. Webhooks go out without blocking the page.
 */
export function subscriptionApproved(svc: PaymentService, p: Payment, inst: PaymentInstance): void {
  const t = ppFind(svc, inst, PP_KIND.subscription, String(p.providerData.subscription));
  if (!t) return;
  if (!['paid', 'failed'].includes(p.status)) return; // cancelled / abandoned: stays APPROVAL_PENDING
  const user = p.testUserId ? svc.hub.users.get(p.projectId, p.testUserId) : null;
  const prev = (t.data.subscriber ?? {}) as Json;
  const names = (user?.name ?? ([((prev.name as Json | undefined)?.given_name as string | undefined) ?? 'John', ((prev.name as Json | undefined)?.surname as string | undefined) ?? 'Doe'].join(' '))).split(' ');
  const subscriber = clean({ ...prev, name: { given_name: names[0] ?? 'John', surname: names.slice(1).join(' ') || 'Doe' }, email_address: user?.email ?? prev.email_address ?? p.customerEmail ?? 'sb-buyer@personal.example.com', payer_id: p.providerData.payerId });

  if (p.providerData.subscriptionRevision) {
    if (p.status !== 'paid') return;
    const rev = (t.data.pending_revision ?? null) as Json | null;
    if (!rev || rev.payment !== p.id) return;
    const patch: Json = { pending_revision: null, update_time: ppTime(subNow(t)) };
    if (rev.plan_id) {
      const plan = ppFind(svc, inst, PP_KIND.plan, String(rev.plan_id));
      if (plan) {
        patch.plan_id = plan.providerRef;
        patch.cycles = ((plan.data.billing_cycles as Cycle[]) ?? []).map((x) => ({ ...x, completed: 0 }));
        patch.plan_override = null;
      }
    }
    if (rev.quantity) patch.quantity = rev.quantity;
    if (rev.shipping_amount) patch.shipping_amount = rev.shipping_amount;
    const n = ppSave(svc, t, { data: patch });
    void subEvent(svc, inst, n, 'BILLING.SUBSCRIPTION.UPDATED', 'A billing agreement was updated.').catch(() => undefined);
    svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef });
    return;
  }

  if (t.status !== 'APPROVAL_PENDING') return;
  const now = subNow(t);
  const start = Date.parse(String(t.data.start_time ?? ppTime(now)));
  const cycles = cyclesOf(t);
  const data: Json = { subscriber, approved_at: ppTime(now), customerId: subscriber.payer_id };
  const prefs = prefsOf(svc, inst, t);
  const fee = setupFeeOf(svc, inst, t);
  let status = 'ACTIVE';
  let note: string | undefined;
  const failedFirst = p.status === 'failed';
  if (start > now + 60_000) {
    data.next_billing_time = ppTime(start);
    if (failedFirst && fee > 0) {
      data.outstanding = fee;
      data.failed_count = 1;
      data.last_failed = { amount: fee, time: ppTime(now), reason_code: 'PAYMENT_DENIED' };
    }
  } else {
    const cyc = currentCycle(cycles);
    if (cyc) {
      cyc.completed += 1;
      data.next_billing_time = currentCycle(cycles) ? ppTime(addFrequency(Math.min(start, now) > 0 ? Math.max(start, now - 60_000) : now, cyc.frequency)) : null;
      if (!currentCycle(cycles)) {
        data.final_payment_time = ppTime(now);
        status = 'EXPIRED';
      }
    }
    data.cycles = cycles;
    if (failedFirst) {
      data.outstanding = p.amount;
      data.failed_count = 1;
      data.last_failed = { amount: p.amount, time: ppTime(now), reason_code: 'PAYMENT_DENIED' };
    } else if (p.amount > 0) data.last_payment = { amount: p.amount, time: ppTime(now) };
  }
  if (failedFirst && fee > 0 && prefs.setup_fee_failure_action !== 'CONTINUE') {
    status = 'CANCELLED';
    note = 'The setup fee payment failed (setup_fee_failure_action CANCEL)';
  }
  data.payments = [...((t.data.payments as string[] | undefined) ?? []), p.id];
  let n = ppSave(svc, t, { data, customerId: String(subscriber.payer_id ?? '') || null });
  n = ppSave(svc, n, setStatus(n, status, note));
  n = scheduleBilling(svc, n);
  svc.repo.addEvent(p, 'subscription_approved', { subscription: t.providerRef, status });
  const events = status === 'CANCELLED' ? ['BILLING.SUBSCRIPTION.CANCELLED'] : ['BILLING.SUBSCRIPTION.ACTIVATED', ...(failedFirst ? ['BILLING.SUBSCRIPTION.PAYMENT.FAILED'] : []), ...(status === 'EXPIRED' ? ['BILLING.SUBSCRIPTION.EXPIRED'] : [])];
  void (async () => {
    for (const e of events) await subEvent(svc, inst, n, e, e.endsWith('ACTIVATED') ? 'Subscription activated.' : e.endsWith('FAILED') ? 'Subscription payment failed.' : e.endsWith('EXPIRED') ? 'A billing agreement has expired.' : 'A billing agreement was cancelled.');
  })().catch(() => undefined);
  svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef, approved: true });
}

/** The approval charge (page): setup fee + the first cycle when it starts now. */
function approvalCharge(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): number {
  const start = Date.parse(String(t.data.start_time));
  const fee = setupFeeOf(svc, inst, t);
  if (start > subNow(t) + 60_000) return fee;
  const cyc = currentCycle(cyclesOf(t));
  return fee + (cyc ? cycleAmount(svc, inst, t, cyc.sequence) : 0);
}

function approvalPayment(c: GatewayCtx, t: PaymentToken, amount: number, f: { revision?: boolean; returnUrl: string | null; cancelUrl: string | null; description: string; email: string | null }): Payment {
  let preset: string | null = null;
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (forced) preset = forced;
  return c.svc.create(c, {
    kind: 'order',
    providerRef: `BA-${upper(17)}`,
    secondaryRef: t.providerRef,
    amount,
    currency: String(t.data.currency),
    reference: asString(t.data.custom_id) ?? t.providerRef,
    customerEmail: f.email,
    returnUrl: f.returnUrl,
    cancelUrl: f.cancelUrl,
    callbackUrl: null,
    presetOutcome: preset,
    request: { subscription_id: t.providerRef, plan_id: t.data.plan_id, cart_description: f.description },
    providerData: { subscription: t.providerRef, ...(f.revision ? { subscriptionRevision: true } : { subscriptionApproval: true }), saleId: upper(17), ecToken: `EC-${upper(17)}`, payerId: upper(13), merchantId: upper(13), methods: ['paypal'], intent: 'CAPTURE' },
    idempotencyKey: header(c.req, 'paypal-request-id'),
    lint: [],
    expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  });
}

// ---------------------------------------------------------------- subscriptions: API

function requireSub(c: GatewayCtx, id: string): PaymentToken {
  const t = ppFind(c.svc, c.inst, PP_KIND.subscription, id);
  if (!t) throw ppError(404, 'INVALID_RESOURCE_ID', 'The specified resource ID does not exist.');
  c.resolved.subscription = t.providerRef;
  return t;
}

function readReason(b: Json, required: boolean): string | null {
  const r = asString(b.reason);
  if (!r && required) throw invalidRequest('/reason', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (r && r.length > 128) throw invalidRequest('/reason', 'INVALID_STRING_MAX_LENGTH', 'reason is at most 128 characters.');
  return r;
}

async function subscriptionsRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const { svc, inst, path } = c;
  const m = c.req.method;
  if (path === '/v1/billing/subscriptions' && m === 'POST') {
    c.resolved.endpoint = 'create subscription';
    const planId = asString(b.plan_id);
    if (!planId) throw invalidRequest('/plan_id', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    const plan = ppFind(svc, inst, PP_KIND.plan, planId);
    if (!plan) throw invalidRequest('/plan_id', 'INVALID_PARAMETER_VALUE', `Plan ${planId} does not exist.`);
    if (plan.status !== 'ACTIVE') throw ppError(422, 'PLAN_STATUS_INVALID', `Invalid plan status for create action; plan status should be active (it is ${plan.status}).`);
    const qty = asString(b.quantity);
    if (qty && qty !== '1' && !plan.data.quantity_supported) throw ppError(422, 'SUBSCRIPTION_CANNOT_HAVE_QUANTITY', 'The plan does not support quantity (quantity_supported false).');
    if (qty && !(Number.isInteger(Number(qty)) && Number(qty) >= 1 && Number(qty) <= MAX_QUANTITY)) throw invalidRequest('/quantity', 'INVALID_PARAMETER_VALUE', `quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    const ctx = (b.application_context ?? {}) as Json;
    for (const k of ['return_url', 'cancel_url'] as const) {
      const why = rejectUrl(ctx[k]);
      if (why) {
        svc.addInstanceLint(inst, finding('pay.return-url-missing-or-bad', `subscription ${k} ${why}`));
        throw invalidRequest(`/application_context/${k}`, 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
      }
    }
    const currency = String(plan.data.currency ?? 'USD');
    const startRaw = asString(b.start_time);
    if (startRaw && Number.isNaN(Date.parse(startRaw))) throw invalidRequest('/start_time', 'INVALID_PARAMETER_SYNTAX', 'start_time must be an RFC 3339 date-time.');
    const now = Date.now();
    if (startRaw && Date.parse(startRaw) < now - DAY) throw ppError(422, 'INVALID_START_TIME', 'start_time cannot be in the past.', { field: '/start_time' });
    const shipping = b.shipping_amount ? parseMoney(b.shipping_amount, '/shipping_amount', currency) : null;
    let override: Json | null = null;
    if (b.plan && typeof b.plan === 'object') {
      const cur = { cur: currency as string | null };
      const ov = b.plan as Json;
      override = clean({
        billing_cycles: Array.isArray(ov.billing_cycles) ? (ov.billing_cycles as Json[]).map((x, i) => ({ sequence: Number(x.sequence), ...(x.pricing_scheme ? { pricing_scheme: parsePricing(x.pricing_scheme, `/plan/billing_cycles/${i}/pricing_scheme`, cur) } : {}), ...(x.total_cycles !== undefined ? { total_cycles: Number(x.total_cycles) } : {}) })) : undefined,
        payment_preferences: ov.payment_preferences ? parsePrefs({ ...(plan.data.payment_preferences as Json), ...(ov.payment_preferences as Json) }, cur) : undefined,
      });
    }
    const subIn = (b.subscriber ?? {}) as Json;
    const email = asString(subIn.email_address);
    const id = `I-${upper(12)}`;
    const created = ppTime(now);
    const cycles = ((plan.data.billing_cycles as Cycle[]) ?? []).map((x) => {
      const ovTotal = ((override?.billing_cycles as Json[] | undefined) ?? []).find((o) => Number(o.sequence) === x.sequence)?.total_cycles;
      return { ...x, ...(ovTotal !== undefined ? { total_cycles: Number(ovTotal) } : {}), completed: 0 };
    });
    let t = ppAdd(svc, inst, PP_KIND.subscription, {
      ref: id,
      status: 'APPROVAL_PENDING',
      runId: c.run?.id ?? null,
      customerId: null,
      data: clean({
        plan_id: planId,
        quantity: qty ?? '1',
        custom_id: asString(b.custom_id),
        shipping_amount: shipping ? money(shipping.minor, currency) : undefined,
        subscriber: clean({ name: subIn.name, email_address: email, shipping_address: subIn.shipping_address }),
        application_context: clean({ brand_name: asString(ctx.brand_name), user_action: asString(ctx.user_action), return_url: asString(ctx.return_url), cancel_url: asString(ctx.cancel_url), shipping_preference: asString(ctx.shipping_preference) }),
        plan_override: override ?? undefined,
        start_time: startRaw ? ppTime(Date.parse(startRaw)) : created,
        create_time: created,
        status_update_time: created,
        update_time: created,
        currency,
        cycles,
        outstanding: 0,
        failed_count: 0,
        clockOffsetMs: 0,
        seq: 0,
        payments: [],
      }),
    });
    if (!asString(ctx.return_url)) svc.addInstanceLint(inst, finding('pay.return-url-missing-or-bad', `subscription ${id} has no application_context.return_url: the buyer stays on the PayPal page after approving`));
    const amount = approvalCharge(svc, inst, t);
    const ap = approvalPayment(c, t, amount, { returnUrl: asString(ctx.return_url), cancelUrl: asString(ctx.cancel_url), description: `Subscribe: ${String(plan.data.name)}`, email });
    t = ppSave(svc, t, { data: { approval_payment: ap.id, ba_token: ap.providerRef } });
    await subEvent(svc, inst, t, 'BILLING.SUBSCRIPTION.CREATED', 'A billing agreement was created.');
    svc.changed(inst.projectId, { paypal: 'subscription', id });
    const full = subscriptionOf(svc, inst, t, []);
    const out = preferFull(c) ? full : { id: full.id, plan_id: full.plan_id, status: full.status, status_update_time: full.status_update_time, start_time: full.start_time, quantity: full.quantity, create_time: full.create_time, plan_overridden: full.plan_overridden, links: full.links };
    return c.reply.status(201).send(out);
  }
  if (path === '/v1/billing/subscriptions' && m === 'GET') {
    c.resolved.endpoint = 'list subscriptions';
    const pg = paging(c, 20, 10);
    const plans = asString(c.query.plan_ids)?.split(',');
    const statuses = asString(c.query.statuses)?.toUpperCase().split(',');
    const after = asString(c.query.created_after);
    const before = asString(c.query.created_before);
    const all = ppList(svc, inst.projectId, PP_KIND.subscription, { instanceId: inst.id })
      .reverse()
      .filter((t) => (!plans || plans.includes(String(t.data.plan_id))) && (!statuses || statuses.includes(t.status)) && (!after || String(t.data.create_time) >= after) && (!before || String(t.data.create_time) <= before));
    const { items, extra } = pageOf(all, pg, `${apiOf(svc, inst)}/v1/billing/subscriptions`);
    return { subscriptions: items.map((t) => subscriptionOf(svc, inst, t, [])), ...extra };
  }
  const mm = /^\/v1\/billing\/subscriptions\/([^/]+)(?:\/(revise|suspend|cancel|activate|capture|transactions))?$/.exec(path);
  if (!mm) return undefined;
  const t = requireSub(c, decodeRef(mm[1]!));
  const action = mm[2];
  if (!action && m === 'GET') {
    c.resolved.endpoint = 'get subscription';
    const fields = (asString(c.query.fields) ?? '').split(',').map((s) => s.trim());
    if (!t.data.read_after_approval && t.status !== 'APPROVAL_PENDING') ppSave(svc, t, { data: { read_after_approval: true } });
    return subscriptionOf(svc, inst, svc.repo.token(t.id)!, fields);
  }
  if (!action && m === 'PATCH') {
    c.resolved.endpoint = 'update subscription';
    if (!['ACTIVE', 'SUSPENDED'].includes(t.status)) throw ppError(422, 'SUBSCRIPTION_STATUS_INVALID', 'Invalid subscription status for update action; subscription status should be active or suspended.');
    const d: Json = {};
    const cur = String(t.data.currency);
    const ov = { ...((t.data.plan_override as Json | undefined) ?? {}) };
    const ovPrefs = { ...((ov.payment_preferences as Json | undefined) ?? {}) };
    applyPatch(c.req.body, d, {
      '/custom_id': (v) => (d.custom_id = v === undefined ? null : String(v)),
      '/shipping_amount': (v) => (d.shipping_amount = v === undefined ? null : money(parseMoney(v, '/shipping_amount', cur).minor, cur)),
      '/billing_info/outstanding_balance': (v) => {
        const a = parseMoney(v, '/billing_info/outstanding_balance', cur);
        if (a.minor > Number(t.data.outstanding ?? 0)) throw ppError(422, 'AMOUNT_GREATER_THAN_OUTSTANDING_BALANCE', 'The new outstanding balance cannot be more than the current one.');
        d.outstanding = a.minor;
      },
      '/subscriber/shipping_address': (v) => (d.subscriber = { ...((t.data.subscriber as Json) ?? {}), shipping_address: v }),
      '/plan/payment_preferences/payment_failure_threshold': (v) => (ovPrefs.payment_failure_threshold = Number(v)),
      '/plan/payment_preferences/auto_bill_outstanding': (v) => (ovPrefs.auto_bill_outstanding = v === true || v === 'true'),
      '/start_time': () => {
        throw ppError(422, 'SUBSCRIPTION_STATUS_INVALID', 'start_time can only change before the subscription is active.');
      },
    });
    if (Object.keys(ovPrefs).length) d.plan_override = { ...ov, payment_preferences: { ...((ov.payment_preferences as Json | undefined) ?? {}), ...ovPrefs } };
    d.update_time = ppTime(subNow(t));
    const n = ppSave(svc, t, { data: d });
    await subEvent(svc, inst, n, 'BILLING.SUBSCRIPTION.UPDATED', 'A billing agreement was updated.');
    svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef });
    return c.reply.status(204).send();
  }
  if (action === 'transactions' && m === 'GET') {
    c.resolved.endpoint = 'list subscription transactions';
    const st = asString(c.query.start_time);
    const et = asString(c.query.end_time);
    if (!st) throw invalidRequest('start_time', 'MISSING_REQUIRED_PARAMETER', 'start_time is required.');
    if (!et) throw invalidRequest('end_time', 'MISSING_REQUIRED_PARAMETER', 'end_time is required.');
    if (Number.isNaN(Date.parse(st)) || Number.isNaN(Date.parse(et))) throw invalidRequest(Number.isNaN(Date.parse(st)) ? 'start_time' : 'end_time', 'INVALID_PARAMETER_SYNTAX', 'Use an RFC 3339 date-time.');
    const from = Date.parse(st);
    const to = Date.parse(et);
    const offset = Number(t.data.clockOffsetMs ?? 0);
    const sub = (t.data.subscriber ?? {}) as Json;
    const rows = ((t.data.payments as string[] | undefined) ?? [])
      .map((id) => svc.repo.get(id))
      .filter((p): p is Payment => !!p && p.amount > 0)
      // Times on the subscription clock (cycles billed by "advance" are in its future).
      .map((p) => ({ p, at: Date.parse(p.createdAt) + (p.providerData.subscriptionApproval ? 0 : offset) }))
      .filter((x) => x.at >= from && x.at <= to)
      .map(({ p, at }) => {
        const fee = p.status === 'failed' ? 0 : Math.min(p.amount, Math.round(p.amount * 0.0349) + 49);
        return {
          status: p.status === 'paid' ? 'COMPLETED' : p.status === 'failed' ? 'DECLINED' : p.status === 'refunded' ? 'REFUNDED' : p.status === 'partially_refunded' ? 'PARTIALLY_REFUNDED' : 'PENDING',
          id: saleIdOf(p),
          amount_with_breakdown: { gross_amount: money(p.amount, p.currency), fee_amount: money(fee, p.currency), net_amount: money(p.amount - fee, p.currency) },
          payer_name: sub.name ?? { given_name: 'John', surname: 'Doe' },
          payer_email: sub.email_address ?? p.customerEmail ?? 'sb-buyer@personal.example.com',
          time: ppTime(at),
        };
      });
    return { transactions: rows, total_items: rows.length, total_pages: 1, links: [{ href: `${apiOf(svc, inst)}/v1/billing/subscriptions/${t.providerRef}/transactions?start_time=${encodeURIComponent(st)}&end_time=${encodeURIComponent(et)}`, rel: 'SELF', method: 'GET' }] };
  }
  if (m !== 'POST' || !action) return undefined;
  if (action === 'suspend' || action === 'cancel' || action === 'activate') {
    c.resolved.endpoint = `${action} subscription`;
    const reason = readReason(b, action !== 'activate');
    await changeSubscriptionStatus(svc, inst, t, action, reason);
    return c.reply.status(204).send();
  }
  if (action === 'capture') {
    c.resolved.endpoint = 'capture subscription balance';
    if (!['ACTIVE', 'SUSPENDED'].includes(t.status)) throw ppError(422, 'SUBSCRIPTION_STATUS_INVALID', 'Invalid subscription status for capture action; subscription status should be active or suspended.');
    if (!asString(b.note)) throw invalidRequest('/note', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    if (asString(b.capture_type) !== 'OUTSTANDING_BALANCE') throw invalidRequest('/capture_type', b.capture_type ? 'INVALID_PARAMETER_VALUE' : 'MISSING_REQUIRED_PARAMETER', 'capture_type must be OUTSTANDING_BALANCE.');
    if (!b.amount) throw invalidRequest('/amount', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    const cur = String(t.data.currency);
    const a = parseMoney(b.amount, '/amount', cur);
    const outstanding = Number(t.data.outstanding ?? 0);
    if (outstanding <= 0) throw ppError(422, 'ZERO_OUTSTANDING_BALANCE', 'Current outstanding balance should be greater than zero.');
    if (a.minor > outstanding) throw ppError(422, 'AMOUNT_GREATER_THAN_OUTSTANDING_BALANCE', 'Capture amount must be less than or equal to the outstanding balance.');
    const { ok } = billOutcome(inst, t, header(c.req, 'x-hub-payment-outcome'));
    const p = insertSale(svc, inst, t, { amount: a.minor, ok, cycle: null, note: `outstanding balance capture: ${String(b.note)}` });
    const data: Json = { payments: [...((t.data.payments as string[] | undefined) ?? []), p.id].slice(-MAX_SUB_PAYMENTS), update_time: ppTime(subNow(t)) };
    if (ok) Object.assign(data, { outstanding: outstanding - a.minor, last_payment: { amount: a.minor, time: ppTime(subNow(t)) }, failed_count: outstanding - a.minor > 0 ? Number(t.data.failed_count ?? 0) : 0 });
    else Object.assign(data, { last_failed: { amount: a.minor, time: ppTime(subNow(t)), reason_code: 'PAYMENT_DENIED' } });
    const n = ppSave(svc, t, { data });
    if (ok) await svc.webhooks.emit(p, inst, 'paid', null);
    else await subEvent(svc, inst, n, 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'Subscription payment failed.');
    svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef, payment: p.id });
    const fee = ok ? Math.min(p.amount, Math.round(p.amount * 0.0349) + 49) : 0;
    const sub = (n.data.subscriber ?? {}) as Json;
    return c.reply.status(202).send({ status: ok ? 'COMPLETED' : 'DECLINED', id: saleIdOf(p), amount_with_breakdown: { gross_amount: money(p.amount, cur), fee_amount: money(fee, cur), net_amount: money(p.amount - fee, cur) }, payer_name: sub.name ?? {}, payer_email: sub.email_address ?? null, time: ppTime(subNow(n)) });
  }
  if (action === 'revise') {
    c.resolved.endpoint = 'revise subscription';
    if (!['ACTIVE', 'SUSPENDED'].includes(t.status)) throw ppError(422, 'SUBSCRIPTION_STATUS_INVALID', 'Invalid subscription status for revise action; subscription status should be active or suspended.');
    const planId = asString(b.plan_id);
    const qty = asString(b.quantity);
    if (!planId && !qty && !b.shipping_amount) throw invalidRequest('/plan_id', 'MISSING_REQUIRED_PARAMETER', 'plan_id, quantity or shipping_amount is required.');
    if (qty && !(Number.isInteger(Number(qty)) && Number(qty) >= 1 && Number(qty) <= MAX_QUANTITY)) throw invalidRequest('/quantity', 'INVALID_PARAMETER_VALUE', `quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    const cur = String(t.data.currency);
    const target = planId ? ppFind(svc, inst, PP_KIND.plan, planId) : planFor(svc, inst, t);
    if (qty && qty !== '1' && target && !target.data.quantity_supported) throw ppError(422, 'SUBSCRIPTION_CANNOT_HAVE_QUANTITY', 'The plan does not support quantity (quantity_supported false).');
    if (planId) {
      const plan = target;
      if (!plan) throw ppError(404, 'INVALID_RESOURCE_ID', `Plan ${planId} does not exist.`);
      if (plan.status !== 'ACTIVE') throw ppError(422, 'PLAN_STATUS_INVALID', 'The new plan must be ACTIVE.');
      const old = planFor(svc, inst, t);
      if (old && old.data.product_id !== plan.data.product_id) throw ppError(422, 'PLAN_PRODUCT_NOT_COMPATIBLE', 'The new plan must belong to the same product.');
      if (String(plan.data.currency) !== cur) throw ppError(422, 'CURRENCY_MISMATCH', 'The new plan uses another currency.');
    }
    const shipping = b.shipping_amount ? money(parseMoney(b.shipping_amount, '/shipping_amount', cur).minor, cur) : null;
    const ctx = (b.application_context ?? {}) as Json;
    const appCtx = (t.data.application_context ?? {}) as Json;
    const ap = approvalPayment(c, t, 0, { revision: true, returnUrl: asString(ctx.return_url) ?? asString(appCtx.return_url), cancelUrl: asString(ctx.cancel_url) ?? asString(appCtx.cancel_url), description: `Change subscription ${t.providerRef}`, email: asString((t.data.subscriber as Json | undefined)?.email_address) });
    ppSave(svc, t, { data: { pending_revision: clean({ plan_id: planId, quantity: qty, shipping_amount: shipping, payment: ap.id }) } });
    svc.changed(inst.projectId, { paypal: 'subscription', id: t.providerRef });
    const project = svc.hub.projects.get(inst.projectId)!;
    return c.reply.status(200).send(clean({ plan_id: planId ?? t.data.plan_id, quantity: qty ?? t.data.quantity ?? '1', shipping_amount: shipping ?? undefined, plan_overridden: false, links: [{ href: svc.entryUrl(project, inst, ap), rel: 'approve', method: 'GET' }] }));
  }
  return undefined;
}

// ---------------------------------------------------------------- v1 sales

async function salesRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const mm = /^\/v1\/payments\/sale\/([^/]+)(\/refund)?$/.exec(c.path);
  if (!mm) return undefined;
  const p = c.svc.repo.byDataRef(c.inst.id, 'saleId', decodeRef(mm[1]!));
  if (!p || !p.providerData.subscription || p.providerData.subscriptionRevision || p.amount <= 0 || ['created', 'pending', 'requires_action'].includes(p.status)) throw new PpError(404, { name: 'INVALID_RESOURCE_ID', message: 'Requested resource ID was not found.', information_link: 'https://developer.paypal.com/docs/api/payments/v1/#errors', debug_id: debugId() });
  c.resolved.payment = p.id;
  if (!mm[2] && c.req.method === 'GET') {
    c.resolved.endpoint = 'get sale';
    return saleOf(c.svc, p, c.inst);
  }
  if (mm[2] && c.req.method === 'POST') {
    c.resolved.endpoint = 'refund sale';
    if (p.status !== 'paid' && p.status !== 'partially_refunded') throw new PpError(400, { name: 'TRANSACTION_REFUSED', message: `The sale is ${saleState(p)}; it cannot be refunded.`, information_link: 'https://developer.paypal.com/docs/api/payments/v1/#errors', debug_id: debugId() });
    const amt = (b.amount ?? null) as Json | null;
    let minor: number | null = null;
    if (amt) {
      if (String(amt.currency ?? '').toUpperCase() !== p.currency) throw new PpError(400, { name: 'VALIDATION_ERROR', message: 'Invalid request - see details', details: [{ field: 'amount.currency', issue: 'Currency does not match the sale' }], debug_id: debugId() });
      const a = fromDecimal(amt.total, p.currency);
      if (!a.ok) throw new PpError(400, { name: 'VALIDATION_ERROR', message: 'Invalid request - see details', details: [{ field: 'amount.total', issue: 'Currency amount must be non-negative number' }], debug_id: debugId() });
      minor = a.minor;
    }
    try {
      const out = await c.svc.refund(p, minor, { providerRef: upper(17), reason: asString(b.description) ?? asString(b.reason) });
      const r = c.svc.repo.refunds(p.id).find((x) => x.providerRef === out.refundId)!;
      return c.reply.status(201).send(saleRefundOf(c.svc, out.payment, c.inst, r));
    } catch (e) {
      if (e instanceof HttpError && (e.details as Json | undefined)?.code === 'amount_too_large') throw new PpError(400, { name: 'TRANSACTION_REFUSED', message: 'Refund amount exceeds the amount left on the sale.', debug_id: debugId() });
      throw e;
    }
  }
  return undefined;
}

/** Buyer approval of a subscription (or a revision): /webapps/billing/subscriptions?ba_token=BA-… (no bearer). */
export function subscriptionPageRoute(c: GatewayCtx): unknown {
  if (c.path !== '/webapps/billing/subscriptions' || !(c.req.method === 'GET' || c.req.method === 'HEAD')) return undefined;
  const ba = asString(c.query.ba_token);
  const p = ba ? c.svc.repo.byInstanceRef(c.inst.id, ba) : null;
  if (!p || !p.providerData.subscription) throw new HttpError(404, 'Unknown PayPal subscription approval (ba_token)');
  c.resolved.endpoint = 'subscription approval page';
  c.resolved.payment = p.id;
  // Relative: keeps the host form (<instance>.<project>.pay.<domain>) and the /pay/<project>/<instance> form alike.
  return c.reply.redirect(`../../page/${p.id}`, 302);
}

/** /v1/catalogs/products, /v1/billing/plans, /v1/billing/subscriptions, /v1/payments/sale (bearer already checked). */
export async function subscriptionsApiRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const p = c.path;
  if (!(p.startsWith('/v1/catalogs/products') || p.startsWith('/v1/billing/') || p.startsWith('/v1/payments/sale/'))) return undefined;
  const key = c.req.method === 'POST' ? header(c.req, 'paypal-request-id') : null;
  const cache = idem.get(c.inst.id) ?? new IdempotencyCache();
  idem.set(c.inst.id, cache);
  if (key) {
    const hit = cache.get(`${p}:${key}`);
    if (hit) {
      c.resolved.idempotentReplay = true;
      return c.reply.status(hit.status).send(hit.body);
    }
  }
  const out = p.startsWith('/v1/catalogs/') ? await productsRoute(c, b) : p.startsWith('/v1/billing/plans') ? await plansRoute(c, b) : p.startsWith('/v1/billing/subscriptions') ? await subscriptionsRoute(c, b) : await salesRoute(c, b);
  if (out === undefined && !c.reply.sent) throw new PpError(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID', description: `${c.req.method} ${p} is not simulated by stubyard.` }], message: 'The specified resource does not exist.', debug_id: debugId(), links: [] });
  if (key && c.reply.statusCode < 300 && (p.endsWith('/products') || p.endsWith('/plans') || p.endsWith('/subscriptions'))) {
    const body = out === c.reply ? null : out;
    if (body) cache.set(`${p}:${key}`, key, c.reply.statusCode, body);
  }
  return out;
}

/** Durable job: bill at next_billing_time (stale seq / not ACTIVE / not due on the subscription clock → no-op or reschedule). */
export function billJob(hub: Hub) {
  return async (job: Job): Promise<void> => {
    const svc = hub.payments;
    if (!svc) return;
    const pl = job.payload as { token?: string; seq?: number };
    const t = pl.token ? svc.repo.token(pl.token) : null;
    if (!t || t.status !== 'ACTIVE' || Number(t.data.seq ?? 0) !== Number(pl.seq)) return;
    const inst = svc.repo.instanceById(t.instanceId);
    if (!inst) return;
    const next = Date.parse(String(t.data.next_billing_time ?? ''));
    if (Number.isNaN(next)) return;
    if (next - subNow(t) > 1000) {
      scheduleBilling(svc, t);
      return;
    }
    await billCycle(svc, inst, t, { via: 'schedule' });
  };
}

/** Control-API outcome queue: the next billings decline / succeed in this order (consumed per billed cycle). */
export function queueOutcomes(svc: PaymentService, t: PaymentToken, outcomes: string[]): PaymentToken {
  return ppSave(svc, t, { data: { next_outcomes: [...((t.data.next_outcomes as string[] | undefined) ?? []), ...outcomes].slice(0, 50) } });
}

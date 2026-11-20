import type { GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, header, upper } from '../common.js';
import { describeCard } from '../engine.js';
import { finding, httpUrl, rejectUrl } from '../lint.js';
import { pageCsp, renderVaultApprovePage } from '../pages.js';
import type { Payment, PaymentInstance, PaymentToken } from '../repo.js';
import type { PaymentService } from '../service.js';
import { sendOutbound } from '../../traffic/outbound.js';
import { sign } from '../../webhooks/signing.js';
import { bodyOf } from '../common.js';
import { certUrlOf, invalidRequest, notFound, unprocessable } from './index.js';

/**
 * PayPal Vault v3 on the fake: setup tokens (card: approved at once; PayPal: buyer approval page), payment tokens
 * (create from an approved setup token, list by customer, get, delete), vault_id on orders (no buyer step) and
 * store_in_vault ON_SUCCESS at capture / authorize. VAULT.PAYMENT-TOKEN.CREATED / .DELETED webhooks are signed like
 * the other PayPal events. No card digits are stored: brand, last 4, expiry and the magic card id only.
 */

const newCustomer = () => `customer_${String(Date.now()).slice(-6)}${alnum(4).toLowerCase()}`;

function setupTokenOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): Json {
  const project = svc.hub.projects.get(t.projectId)!;
  const api = svc.urls(project, inst).backend;
  const out: Json = {
    id: t.providerRef,
    customer: { id: t.customerId },
    status: t.status,
    payment_source: t.source === 'card' ? { card: cardOf(t) } : { paypal: { usage_type: 'MERCHANT', customer_type: 'CONSUMER', ...(t.data.email ? { email_address: t.data.email, payer_id: t.data.payerId } : {}) } },
    links: [
      { href: `${api}/v3/vault/setup-tokens/${t.providerRef}`, rel: 'self', method: 'GET', encType: 'application/json' },
      { href: `${api}/v3/vault/payment-tokens`, rel: 'confirm', method: 'POST', encType: 'application/json' },
    ],
  };
  if (t.status === 'PAYER_ACTION_REQUIRED') (out.links as Json[]).push({ href: `${svc.base(project, inst)}/sdk/vault/approve/${t.providerRef}`, rel: 'approve', method: 'GET' });
  return out;
}

const cardOf = (t: PaymentToken): Json => ({ brand: String(t.cardBrand ?? 'visa').toUpperCase().replace('MASTERCARD', 'MASTERCARD'), last_digits: t.cardLast4, expiry: t.expiry, ...(t.data.name ? { name: t.data.name } : {}) });

export function paymentTokenOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): Json {
  const project = svc.hub.projects.get(t.projectId)!;
  const api = svc.urls(project, inst).backend;
  return {
    id: t.providerRef,
    customer: { id: t.customerId },
    payment_source: t.source === 'card' ? { card: cardOf(t) } : { paypal: { email_address: t.data.email ?? 'sb-buyer@personal.example.com', payer_id: t.data.payerId ?? null, usage_type: 'MERCHANT' } },
    links: [
      { href: `${api}/v3/vault/payment-tokens/${t.providerRef}`, rel: 'self', method: 'GET', encType: 'application/json' },
      { href: `${api}/v3/vault/payment-tokens/${t.providerRef}`, rel: 'delete', method: 'DELETE', encType: 'application/json' },
    ],
  };
}

/** Send a VAULT.* webhook (no payment involved: directly, PayPal-signed). */
async function tokenWebhook(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, type: 'VAULT.PAYMENT-TOKEN.CREATED' | 'VAULT.PAYMENT-TOKEN.DELETED'): Promise<void> {
  const url = inst.config.webhookUrl;
  const project = svc.hub.projects.get(t.projectId)!;
  if (!url) return;
  const api = svc.urls(project, inst).backend;
  const id = `WH-${upper(17)}-${upper(17)}`;
  const body = JSON.stringify({
    id,
    event_version: '1.0',
    create_time: new Date().toISOString(),
    resource_type: 'payment_token',
    resource_version: '3.0',
    event_type: type,
    summary: type.endsWith('CREATED') ? 'A payment token has been created.' : 'A payment token has been deleted.',
    resource: type.endsWith('CREATED') ? paymentTokenOf(svc, inst, t) : { id: t.providerRef },
    links: [{ href: `${api}/v1/notifications/webhooks-events/${id}`, rel: 'self', method: 'GET' }],
  });
  const sig = inst.config.privateKeyPem && inst.config.webhookId ? sign({ preset: 'paypal', privateKey: inst.config.privateKeyPem, webhookId: inst.config.webhookId, certUrl: certUrlOf(svc, inst) }, body) : {};
  const res = await sendOutbound(svc.hub.traffic, {
    projectId: t.projectId,
    parentLogId: null,
    url,
    headers: { 'content-type': 'application/json', ...sig },
    body,
    purpose: 'payment webhook',
    runId: t.runId,
    resolved: { kind: 'payment-webhook', instance: inst.slug, event: type, eventId: id, token: t.providerRef },
  });
  svc.repo.updateToken(t.id, { data: { ...svc.repo.token(t.id)!.data, webhooks: [...(((svc.repo.token(t.id)!.data.webhooks as Json[] | undefined) ?? []).slice(-9)), { type, eventId: id, status: res.status, ok: res.ok, at: new Date().toISOString() }] } });
  svc.changed(t.projectId, { token: t.providerRef });
}

function createPaymentToken(svc: PaymentService, inst: PaymentInstance, f: { source: 'card' | 'paypal'; customerId: string | null; runId: string | null; brand?: string | null; last4?: string | null; expiry?: string | null; data: Json }): PaymentToken {
  return svc.repo.addToken({
    projectId: inst.projectId,
    instanceId: inst.id,
    runId: f.runId,
    kind: 'payment',
    providerRef: alnum(8).toLowerCase(),
    customerId: f.customerId ?? newCustomer(),
    status: 'ACTIVE',
    source: f.source,
    cardBrand: f.brand ?? null,
    cardLast4: f.last4 ?? null,
    expiry: f.expiry ?? null,
    data: f.data,
  });
}

/** store_in_vault ON_SUCCESS: after a successful capture / authorization, save the payment method. */
export async function vaultOnSuccess(c: GatewayCtx, p: Payment): Promise<Payment> {
  const want = p.providerData.storeInVault as { customerId: string | null } | undefined;
  if (!want || p.providerData.vault) return p;
  if (p.status === 'failed') return p;
  const card = (p.providerData.card as Json | undefined) ?? {};
  const t = createPaymentToken(c.svc, c.inst, {
    source: p.method === 'card' ? 'card' : 'paypal',
    customerId: want.customerId,
    runId: p.runId,
    brand: p.method === 'card' ? p.cardBrand : null,
    last4: p.method === 'card' ? p.cardLast4 : null,
    expiry: p.method === 'card' ? ((card.expiry as string | null) ?? null) : null,
    data: { paymentId: p.id, orderId: p.providerRef, magicId: card.magicId ?? null, name: card.name ?? null, email: p.method === 'card' ? null : (p.customerEmail ?? 'sb-buyer@personal.example.com'), payerId: p.providerData.payerId ?? null, via: 'store_in_vault' },
  });
  const out = c.svc.repo.update(p.id, { providerData: { ...p.providerData, vault: { id: t.providerRef, status: 'VAULTED', customer: { id: t.customerId } } } });
  c.svc.repo.addEvent(out, 'vaulted', { token: t.providerRef, customer: t.customerId });
  await tokenWebhook(c.svc, c.inst, t, 'VAULT.PAYMENT-TOKEN.CREATED');
  c.svc.changed(p.projectId, { payment: p.id });
  return c.svc.repo.get(p.id)!;
}

/** payment_source.<card|paypal>.attributes.vault of the order. */
export const vaultAttributes = (p: Payment): Json | null => (p.providerData.vault as Json | undefined) ?? (p.providerData.storeInVault && p.status !== 'failed' ? { status: 'APPROVED' } : null);

/** Buyer approval of a PayPal setup token (pages; no bearer). Undefined when the path is not one. */
export async function vaultPageRoute(c: GatewayCtx): Promise<unknown> {
  const mm = /^\/sdk\/vault\/approve\/([^/]+)$/.exec(c.path);
  if (!mm) return undefined;
  const t = c.svc.repo.tokenByRef(c.inst.id, decodeURIComponent(mm[1]!), 'setup');
  if (!t) throw notFound('Unknown setup token.');
  c.resolved.endpoint = 'vault approval page';
  const project = c.project;
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const html = renderVaultApprovePage({ presetId: 'paypal', presetName: 'PayPal', action: `${c.base}/sdk/vault/approve/${t.providerRef}`, email: String(t.data.email ?? 'sb-buyer@personal.example.com'), dashboardUrl: `${c.svc.browserRoot()}/` });
    return c.reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', pageCsp(html)).send(html);
  }
  if (c.req.method !== 'POST') return undefined;
  const b = bodyOf(c.req);
  const approve = String(b.decision ?? '') === 'approve';
  const next = c.svc.repo.updateToken(t.id, { status: approve ? 'APPROVED' : 'CANCELLED', data: { ...t.data, payerId: t.data.payerId ?? upper(13), email: t.data.email ?? 'sb-buyer@personal.example.com', decidedAt: new Date().toISOString() } });
  c.svc.changed(project.id, { token: t.providerRef });
  const target = httpUrl(approve ? (t.data.returnUrl as string | undefined) : (t.data.cancelUrl as string | undefined));
  if (!target) {
    const html = renderVaultApprovePage({ presetId: 'paypal', presetName: 'PayPal', action: '#', email: String(next.data.email), dashboardUrl: `${c.svc.browserRoot()}/` }).replace('Save PayPal for future payments</h1>', approve ? 'Approved (no return_url)</h1>' : 'Cancelled (no cancel_url)</h1>');
    return c.reply.type('text/html; charset=utf-8').header('content-security-policy', pageCsp(html)).send(html);
  }
  const u = new URL(target);
  u.searchParams.set('approval_token_id', t.providerRef);
  u.searchParams.set('approval_session_id', alnum(17).toUpperCase());
  return c.reply.redirect(u.toString(), 303);
}

/** /v3/vault/… (bearer already checked). Undefined when the path is not one of these. */
export async function vaultRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const { path } = c;
  const m = c.req.method;
  const { svc, inst } = c;
  if (path === '/v3/vault/setup-tokens' && m === 'POST') {
    c.resolved.endpoint = 'create setup token';
    const ps = (b.payment_source as Json | undefined) ?? {};
    const customerId = asString((b.customer as Json | undefined)?.id) ?? newCustomer();
    if (ps.card) {
      const card = ps.card as Json;
      const digits = String(card.number ?? '').replace(/\D/g, '');
      if (!digits) throw invalidRequest('/payment_source/card/number', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
      const d = describeCard(digits);
      if (d.luhnValid && !d.testCard) {
        svc.addInstanceLint(inst, finding('pay.real-card-entered', `A real-looking ${d.brand} number was sent to /v3/vault/setup-tokens (masked in stubyard, not stored)`));
        throw unprocessable('CARD_NUMBER_NOT_A_TEST_CARD', 'stubyard only accepts test card numbers; nothing was stored.');
      }
      if (!d.luhnValid || digits.length < 12) throw invalidRequest('/payment_source/card/number', 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
      const expiry = asString(card.expiry);
      if (!expiry || !/^\d{4}-(0[1-9]|1[0-2])$/.test(expiry)) throw invalidRequest('/payment_source/card/expiry', 'INVALID_PARAMETER_SYNTAX', 'Card expiry must be YYYY-MM.');
      const t = svc.repo.addToken({ projectId: inst.projectId, instanceId: inst.id, runId: c.run?.id ?? null, kind: 'setup', providerRef: upper(17), customerId, status: 'APPROVED', source: 'card', cardBrand: d.brand, cardLast4: d.last4, expiry, data: { magicId: d.magicId, name: asString(card.name) } });
      svc.changed(inst.projectId, { token: t.providerRef });
      return c.reply.status(201).send(setupTokenOf(svc, inst, t));
    }
    if (ps.paypal) {
      const pp = ps.paypal as Json;
      const ctx = (pp.experience_context as Json | undefined) ?? {};
      for (const k of ['return_url', 'cancel_url'] as const) {
        const why = rejectUrl(ctx[k]);
        if (why) {
          svc.addInstanceLint(inst, finding('pay.return-url-missing-or-bad', `setup token ${k} ${why}`));
          throw invalidRequest(`/payment_source/paypal/experience_context/${k}`, 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
        }
      }
      const t = svc.repo.addToken({ projectId: inst.projectId, instanceId: inst.id, runId: c.run?.id ?? null, kind: 'setup', providerRef: upper(17), customerId, status: 'PAYER_ACTION_REQUIRED', source: 'paypal', cardBrand: null, cardLast4: null, expiry: null, data: { returnUrl: ctx.return_url, cancelUrl: ctx.cancel_url, description: asString(pp.description) } });
      svc.changed(inst.projectId, { token: t.providerRef });
      return c.reply.status(201).send(setupTokenOf(svc, inst, t));
    }
    throw invalidRequest('/payment_source', 'MISSING_REQUIRED_PARAMETER', 'payment_source.card or payment_source.paypal is required.');
  }
  let mm: RegExpExecArray | null;
  if ((mm = /^\/v3\/vault\/setup-tokens\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'get setup token';
    const t = svc.repo.tokenByRef(inst.id, decodeURIComponent(mm[1]!), 'setup');
    if (!t) throw notFound();
    return setupTokenOf(svc, inst, t);
  }
  if (path === '/v3/vault/payment-tokens' && m === 'POST') {
    c.resolved.endpoint = 'create payment token';
    const tok = ((b.payment_source as Json | undefined)?.token as Json | undefined) ?? {};
    const id = asString(tok.id);
    if (!id) throw invalidRequest('/payment_source/token/id', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
    if (asString(tok.type) !== 'SETUP_TOKEN') throw invalidRequest('/payment_source/token/type', 'INVALID_PARAMETER_VALUE', 'type must be SETUP_TOKEN.');
    const setup = svc.repo.tokenByRef(inst.id, id, 'setup');
    if (!setup) throw notFound('The specified setup token does not exist.');
    if (setup.data.paymentToken) {
      const existing = svc.repo.tokenByRef(inst.id, String(setup.data.paymentToken), 'payment');
      if (existing) return c.reply.status(200).send(paymentTokenOf(svc, inst, existing));
    }
    if (setup.status !== 'APPROVED') throw unprocessable('SETUP_TOKEN_NOT_APPROVED', `The setup token is ${setup.status}; the buyer has to approve it first (rel "approve" link).`);
    const t = createPaymentToken(svc, inst, { source: setup.source, customerId: setup.customerId, runId: setup.runId ?? c.run?.id ?? null, brand: setup.cardBrand, last4: setup.cardLast4, expiry: setup.expiry, data: { magicId: setup.data.magicId ?? null, name: setup.data.name ?? null, email: setup.data.email ?? null, payerId: setup.data.payerId ?? null, setupToken: setup.providerRef, via: 'setup_token' } });
    svc.repo.updateToken(setup.id, { data: { ...setup.data, paymentToken: t.providerRef } });
    await tokenWebhook(svc, inst, t, 'VAULT.PAYMENT-TOKEN.CREATED');
    return c.reply.status(201).send(paymentTokenOf(svc, inst, svc.repo.token(t.id)!));
  }
  if (path === '/v3/vault/payment-tokens' && m === 'GET') {
    c.resolved.endpoint = 'list payment tokens';
    const customer = asString(c.query.customer_id);
    if (!customer) throw invalidRequest('customer_id', 'MISSING_REQUIRED_PARAMETER', 'customer_id is required.');
    const list = svc.repo.listTokens(inst.projectId, { instanceId: inst.id, customerId: customer, kind: 'payment', limit: 100 }).filter((t) => t.status !== 'DELETED');
    return { customer: { id: customer }, payment_tokens: list.map((t) => paymentTokenOf(svc, inst, t)), total_items: list.length, total_pages: 1, links: [] };
  }
  if ((mm = /^\/v3\/vault\/payment-tokens\/([^/]+)$/.exec(path))) {
    const t = svc.repo.tokenByRef(inst.id, decodeURIComponent(mm[1]!), 'payment');
    if (!t || t.status === 'DELETED') throw notFound();
    if (m === 'GET') {
      c.resolved.endpoint = 'get payment token';
      return paymentTokenOf(svc, inst, t);
    }
    if (m === 'DELETE') {
      c.resolved.endpoint = 'delete payment token';
      const d = svc.repo.updateToken(t.id, { status: 'DELETED', data: { ...t.data, deletedAt: new Date().toISOString() } });
      await tokenWebhook(svc, inst, d, 'VAULT.PAYMENT-TOKEN.DELETED');
      return c.reply.status(204).send();
    }
  }
  return undefined;
}

/** payment_source.paypal.vault_id / card.vault_id of an order: the saved token (422 when unknown). */
export function vaultToken(c: GatewayCtx, id: string, source: 'card' | 'paypal'): PaymentToken {
  const t = c.svc.repo.tokenByRef(c.inst.id, id, 'payment');
  if (!t || t.status === 'DELETED' || t.source !== source) throw unprocessable('INVALID_RESOURCE_ID', 'Specified resource ID (vault_id) does not exist. Please check the resource ID and try again.');
  return t;
}
export const hasIdTokenRequest = (b: Json) => String(b.response_type ?? '') === 'id_token';

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { decryptHyperpayWebhook, encryptHyperpayWebhook, HYPERPAY_RESULTS, hyperpayResultClass } from '../src/payments/hyperpay/index.js';
import { buildWidgetJs, widgetIntegrity } from '../src/payments/hyperpay/widget.js';

// Payments 1b: HyperPay COPYandPAY, PayPal JS SDK (Buttons / Card Fields), cards + 3DS, AUTHORIZE, Vault v3, migration 18.

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let hub: Hub;
let close: () => Promise<void>;
let base: string;
let dataDir: string;
let appServer: http.Server;
let appUrl: string;
type Hit = { path: string; body: string; headers: http.IncomingHttpHeaders; method: string };
const received: Hit[] = [];

async function call<T = any>(method: string, p: string, opts: { json?: unknown; form?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = opts.form;
  }
  const r = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}
const api = <T = any>(method: string, p: string, json?: unknown) => call<T>(method, p, json === undefined ? {} : { json });
async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
  return JSON.parse(r.body.result.content[0].text);
};
const form = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const hitsAt = (p: string) => received.filter((r) => r.path === p);
/** The inbound traffic row of the latest request to a URL path, once its response was logged. */
const trafficRow = (urlPath: string) =>
  waitFor(() => hub.db.prepare("SELECT res_status, outcome, resolved FROM traffic_logs WHERE direction = 'inbound' AND url LIKE ? AND outcome != 'pending' ORDER BY received_at DESC, rowid DESC LIMIT 1").get(`%${urlPath}`) as { res_status: number; outcome: string; resolved: string } | undefined);

const PJ = '/api/projects/shop1b';
const HP = '/pay/shop1b/hyperpay';
const PP = '/pay/shop1b/paypal';
let hp: { accessToken: string; entityId: string; madaEntityId: string; webhookKey: string };
let pp: { clientId: string; clientSecret: string };
let ppToken = '';

/** A Luhn-valid number that is not a published test card (generated here, not a real card). */
function fakeRealPan(): string {
  const body = '49162039178825';
  for (let d = 0; d <= 9; d++) {
    const n = body + d;
    let sum = 0;
    for (let i = 0; i < n.length; i++) {
      let x = Number(n[n.length - 1 - i]);
      if (i % 2 === 1) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
    }
    if (sum % 10 === 0) return n;
  }
  throw new Error('unreachable');
}

const hpAuth = () => ({ authorization: `Bearer ${hp.accessToken}` });
async function prepare(extra: Record<string, string | number> = {}, headers: Record<string, string> = {}) {
  const r = await call('POST', `${HP}/v1/checkouts`, { form: form({ entityId: hp.entityId, amount: '92.00', currency: 'SAR', paymentType: 'DB', merchantTransactionId: `order-${Math.random().toString(36).slice(2, 8)}`, shopperResultUrl: `${appUrl}/hp-result`, integrity: 'true', ...extra }), headers: { ...hpAuth(), ...headers } });
  expect(r.status, r.text).toBe(200);
  return r.body as { id: string; integrity?: string; result: { code: string } };
}
const payOf = async (ref: string) => (await api('GET', `${PJ}/payments/${encodeURIComponent(ref)}`)).body;
const complete = (id: string, body: Record<string, unknown>) => api('POST', `${PJ}/payments/${id}/complete`, body);
const status = (checkoutId: string, entityId = hp.entityId) => call('GET', `${HP}/v1/checkouts/${checkoutId}/payment?entityId=${entityId}`, { headers: hpAuth() });

const ppHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ppToken}`, 'paypal-request-id': `r-${Math.random()}`, ...extra });
const ppPost = (p: string, json: unknown, extra: Record<string, string> = {}) => call('POST', PP + p, { json, headers: ppHeaders(extra) });
const ppGet = (p: string) => call('GET', PP + p, { headers: { authorization: `Bearer ${ppToken}` } });
const unit = (value = '30.00') => [{ reference_id: 'o1', custom_id: 'c1', amount: { currency_code: 'USD', value } }];
const ppOrder = async (body: Record<string, unknown>, extra: Record<string, string> = {}) => {
  const r = await ppPost('/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: unit(), ...body }, { prefer: 'return=representation', ...extra });
  expect(r.status, r.text).toBe(201);
  return r.body;
};
const lintChecks = async () => ((await api('GET', `${PJ}/payments/lint`)).body.findings as { check: string; payment: string | null }[]).map((f) => f.check);

describe('payments 1b', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-pay1b-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    hub.scheduler.start(30);
    close = async () => {
      await hub.scheduler.stop();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body, headers: req.headers, method: req.method ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Shop 1b', slug: 'shop1b', generateUsers: { admins: 1, customers: 1 } })).status).toBe(201);
    const h = await api('POST', `${PJ}/payment-instances`, { preset: 'hyperpay', config: { webhookUrl: `${appUrl}/hp`, webhookDelayMs: 0 } });
    expect(h.status, h.text).toBe(201);
    expect(h.body.slug).toBe('hyperpay');
    hp = h.body.config;
    expect(hp.webhookKey).toMatch(/^[0-9A-F]{64}$/);
    const p = await api('POST', `${PJ}/payment-instances`, { preset: 'paypal', config: { webhookUrl: `${appUrl}/pp`, webhookDelayMs: 0 } });
    expect(p.status, p.text).toBe(201);
    pp = p.body.config;
    const t = await call('POST', `${PP}/v1/oauth2/token`, { form: 'grant_type=client_credentials', headers: { authorization: 'Basic ' + Buffer.from(`${pp.clientId}:${pp.clientSecret}`).toString('base64') } });
    expect(t.status, t.text).toBe(200);
    ppToken = t.body.access_token;
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('migration 18', () => {
    it('rebuilds payment_instances without the preset CHECK and keeps every row', () => {
      const db = new DB(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const m of [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version < 18)) {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      }
      // Fill a row generically: given values, NOT NULL columns without default get a placeholder.
      const seed = (table: string, values: Record<string, unknown>) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
        const row: Record<string, unknown> = {};
        for (const c of cols) {
          if (c.name in values) row[c.name] = values[c.name];
          else if (c.notnull && c.dflt_value === null) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : c.name.endsWith('_at') ? new Date().toISOString() : /data|config|lint|request|meta/i.test(c.name) ? '{}' : `${c.name}-x`;
        }
        const keys = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] as never));
      };
      seed('projects', { id: 'p1', slug: 'old', name: 'Old' });
      seed('payment_instances', { id: 'i1', project_id: 'p1', slug: 'pp', preset: 'paypal', config: '{"clientId":"x"}' });
      seed('payments', { id: 'pay1', project_id: 'p1', instance_id: 'i1', kind: 'order', provider_ref: 'ORDER1', status: 'paid', amount: 1234, currency: 'USD' });
      seed('payment_events', { id: 'e1', payment_id: 'pay1', project_id: 'p1', type: 'status' });
      seed('payment_rules', { id: 'r1', project_id: 'p1', instance_id: 'i1', outcome: 'success' });
      expect(() => seed('payment_instances', { id: 'i2', project_id: 'p1', slug: 'hp', preset: 'hyperpay' })).toThrow(/CHECK/);

      migrate(db);
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(count('payment_instances')).toBe(1);
      expect(count('payments')).toBe(1);
      expect(count('payment_events')).toBe(1);
      expect(count('payment_rules')).toBe(1);
      expect((db.prepare("SELECT config FROM payment_instances WHERE id = 'i1'").get() as { config: string }).config).toContain('clientId');
      expect((db.prepare("SELECT amount FROM payments WHERE id = 'pay1'").get() as { amount: number }).amount).toBe(1234);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys)).toBe(1);
      seed('payment_instances', { id: 'i2', project_id: 'p1', slug: 'hp', preset: 'hyperpay' });
      seed('payment_tokens', { id: 't1', project_id: 'p1', instance_id: 'i2', kind: 'payment', provider_ref: 'abc', status: 'ACTIVE', source: 'card' });
      // Cascades still work after the rebuild.
      db.exec("DELETE FROM projects WHERE id = 'p1'");
      expect(count('payments')).toBe(0);
      expect(count('payment_tokens')).toBe(0);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBeGreaterThanOrEqual(18);
      db.close();
    });
  });

  describe('HyperPay COPYandPAY', () => {
    it('webhook decryption insists on a full 16-byte GCM tag (also in the published snippet)', async () => {
      const key = 'A'.repeat(64);
      const e = encryptHyperpayWebhook(key, '{"type":"PAYMENT"}');
      expect(decryptHyperpayWebhook(key, e.body, e.iv, e.tag)).toBe('{"type":"PAYMENT"}');
      expect(() => decryptHyperpayWebhook(key, e.body, e.iv, e.tag.slice(0, 8))).toThrow(/32 hex/);
      expect(() => decryptHyperpayWebhook(key, e.body, e.iv, e.tag.slice(0, 30) + 'zz')).toThrow(/32 hex/);
      const snippets = JSON.stringify((await api('GET', `${PJ}/payment-instances`)).body);
      expect(snippets).toContain('authTagLength: 16');
    });

    it('result codes fall into their published pattern classes', () => {
      const R = HYPERPAY_RESULTS;
      expect(hyperpayResultClass(R.success.code)).toBe('success');
      expect(hyperpayResultClass('000.000.000')).toBe('success');
      for (const r of [R.pending, R.checkoutCreated]) expect(hyperpayResultClass(r.code)).toBe('pending');
      for (const r of [R.generic, R.insufficient_funds, R.incorrect_cvc, R.expired_card, R.authentication_failed, R.cancelled, R.processing_error, R.invalidAuth, R.invalidParam, R.noSession, R.cannotCapture, R.cannotRefund, R.cannotReverse]) {
        expect(hyperpayResultClass(r.code), r.code).toBe('rejected');
      }
    });

    it('rejects a wrong bearer and a foreign entity with 800.900.300; bad params with 200.300.404', async () => {
      const a = await call('POST', `${HP}/v1/checkouts`, { form: form({ entityId: hp.entityId, amount: '1.00', currency: 'SAR', paymentType: 'DB' }), headers: { authorization: 'Bearer nope' } });
      expect(a.status).toBe(401);
      expect(a.body.result.code).toBe('800.900.300');
      const e = await call('POST', `${HP}/v1/checkouts`, { form: form({ entityId: 'ff'.repeat(16), amount: '1.00', currency: 'SAR', paymentType: 'DB' }), headers: hpAuth() });
      expect(e.status).toBe(401);
      const b = await call('POST', `${HP}/v1/checkouts`, { form: form({ entityId: hp.entityId, amount: 'abc', currency: 'SAR', paymentType: 'DB', shopperResultUrl: `${appUrl}/r` }), headers: hpAuth() });
      expect(b.status).toBe(400);
      expect(b.body.result.code).toBe('200.300.404');
      expect(b.body.result.parameterErrors[0].name).toBe('amount');
    });

    it('prepare → SRI widget → embedded page → shopperResultUrl → status → encrypted webhook', async () => {
      const co = await prepare();
      expect(co.result.code).toBe('000.200.100');
      expect(co.id).toMatch(/^[0-9A-F]{32}\.uat01-vm-tx0\d$/);
      expect(co.integrity).toMatch(/^sha384-/);
      const w = await fetch(`${base}${HP}/v1/paymentWidgets.js?checkoutId=${co.id}`, { headers: { origin: appUrl, 'sec-fetch-mode': 'cors' } });
      const bytes = Buffer.from(await w.arrayBuffer());
      expect(w.status).toBe(200);
      expect(w.headers.get('access-control-allow-origin')).toBe('*');
      expect(w.headers.get('content-type')).toContain('javascript');
      expect('sha384-' + createHash('sha384').update(bytes).digest('base64')).toBe(co.integrity);
      // Deterministic: the same bytes every time (the integrity was computed at prepare time).
      const project = hub.projects.require('shop1b');
      const wbase = hub.payments!.base(project, hub.payments!.repo.requireInstance(project.id, 'hyperpay'));
      expect(buildWidgetJs(wbase, co.id)).toBe(bytes.toString('utf8'));
      expect(widgetIntegrity(wbase, co.id)).toBe(co.integrity);

      const frame = await call('GET', `${HP}/widget/${co.id}?embed=1&brands=VISA%20MASTER&result=${encodeURIComponent(appUrl + '/hp-result')}`);
      expect(frame.status).toBe(302);
      const loc = frame.headers.get('location')!;
      const pg = await call('GET', new URL(loc, `${base}${HP}/widget/x`).pathname + new URL(loc, base).search);
      expect(pg.status).toBe(200);
      expect(pg.text).toContain('class="embed"');
      expect(pg.text).toContain('target="_top"');
      const p = await payOf(co.id);
      expect(p.preset).toBe('hyperpay');

      const done = await complete(p.id, { card: 'success' });
      expect(done.status, done.text).toBe(200);
      const ret = new URL(done.body.redirectUrl);
      expect(ret.origin + ret.pathname).toBe(`${appUrl}/hp-result`);
      expect(ret.searchParams.get('id')).toBe(co.id);
      expect(ret.searchParams.get('resourcePath')).toBe(`/v1/checkouts/${co.id}/payment`);

      const st = await status(co.id);
      expect(st.status, st.text).toBe(200);
      expect(st.body.result.code).toBe('000.100.110');
      expect(st.body.paymentType).toBe('DB');
      expect(st.body.paymentBrand).toBe('VISA');
      expect(st.body.card.last4Digits).toBe('4242');
      expect(st.body.amount).toBe('92.00');
      const paymentId = st.body.id as string;
      expect(paymentId).toMatch(/^[0-9a-f]{32}$/);

      const hit = await waitFor(() => hitsAt('/hp').find((h) => h.body && decryptHyperpayWebhook(hp.webhookKey, h.body, String(h.headers['x-initialization-vector']), String(h.headers['x-authentication-tag'])).includes(paymentId)));
      expect(hit.headers['content-type']).toContain('text/plain');
      expect(hit.body).toMatch(/^[0-9A-F]+$/);
      const ev = JSON.parse(decryptHyperpayWebhook(hp.webhookKey, hit.body, String(hit.headers['x-initialization-vector']), String(hit.headers['x-authentication-tag'])));
      expect(ev.type).toBe('PAYMENT');
      expect(ev.payload.result.code).toBe('000.100.110');
      expect(ev.payload.id).toBe(paymentId);

      const q = await call('GET', `${HP}/v1/query/${paymentId}?entityId=${hp.entityId}`, { headers: hpAuth() });
      expect(q.status, q.text).toBe(200);
      expect(q.body.result.code).toBe('000.100.110');
    });

    it('a decline is HTTP 400 with its code; status of an unknown checkout is 200.300.404', async () => {
      const co = await prepare();
      const p = await payOf(co.id);
      await complete(p.id, { card: 'insufficient_funds' });
      const st = await status(co.id);
      expect(st.status).toBe(400);
      expect(st.body.result.code).toBe('800.100.155');
      expect(hyperpayResultClass(st.body.result.code)).toBe('rejected');
      const none = await status('0123456789ABCDEF0123456789ABCDEF.uat01-vm-tx01');
      expect(none.status).toBe(400);
      expect(none.body.result.code).toBe('200.300.404');
      const open = await status((await prepare()).id);
      expect(open.body.result.code).toBe('000.200.000');
    });

    it('PA → CP (partial) → RF; PA → RV', async () => {
      const co = await prepare({ paymentType: 'PA', amount: '50.00' });
      const p = await payOf(co.id);
      await complete(p.id, { card: 'success' });
      const st = await status(co.id);
      expect(st.body.paymentType).toBe('PA');
      expect(st.body.result.code).toBe('000.100.110');
      const pid = st.body.id;
      const cp = await call('POST', `${HP}/v1/payments/${pid}`, { form: form({ entityId: hp.entityId, paymentType: 'CP', amount: '30.00', currency: 'SAR' }), headers: hpAuth() });
      expect(cp.status, cp.text).toBe(200);
      expect(cp.body.result.code).toBe('000.100.110');
      expect(cp.body.referencedId).toBe(pid);
      expect((await payOf(co.id)).status).toBe('paid');
      const again = await call('POST', `${HP}/v1/payments/${pid}`, { form: form({ entityId: hp.entityId, paymentType: 'CP', amount: '10.00', currency: 'SAR' }), headers: hpAuth() });
      expect(again.status).toBe(400);
      expect(again.body.result.code).toBe('700.400.100');
      const rf = await call('POST', `${HP}/v1/payments/${pid}`, { form: form({ entityId: hp.entityId, paymentType: 'RF', amount: '5.00', currency: 'SAR' }), headers: hpAuth() });
      expect(rf.status, rf.text).toBe(200);
      expect((await payOf(co.id)).status).toBe('partially_refunded');

      const co2 = await prepare({ paymentType: 'PA' });
      await complete((await payOf(co2.id)).id, { card: 'success' });
      const pid2 = (await status(co2.id)).body.id;
      const rv = await call('POST', `${HP}/v1/payments/${pid2}`, { form: form({ entityId: hp.entityId, paymentType: 'RV' }), headers: hpAuth() });
      expect(rv.status, rv.text).toBe(200);
      expect((await payOf(co2.id)).status).toBe('cancelled');
    });

    it('lints: mada fields / testMode / wrong entity, over-polling, widget without SRI', async () => {
      const mada = await prepare({ entityId: hp.madaEntityId, testMode: 'EXTERNAL', merchantTransactionId: '' });
      const pm = await payOf(mada.id);
      const checks = (pm.lint as { check: string }[]).map((f) => f.check);
      expect(checks).toContain('pay.hyperpay-mada-missing-fields');
      expect(checks).toContain('pay.hyperpay-testmode-with-mada');

      const card = await prepare();
      const pc = await payOf(card.id);
      await complete(pc.id, { method: 'mada' });
      expect(((await payOf(card.id)).lint as { check: string }[]).map((f) => f.check)).toContain('pay.hyperpay-mada-entity');
      for (let i = 0; i < 3; i++) await status(card.id);
      expect(((await payOf(card.id)).lint as { check: string }[]).map((f) => f.check)).toContain('pay.hyperpay-result-overpolled');

      const noSri = await prepare({ integrity: 'false' });
      expect(noSri.integrity).toBeUndefined();
      await fetch(`${base}${HP}/v1/paymentWidgets.js?checkoutId=${noSri.id}`, { headers: { 'sec-fetch-mode': 'no-cors' } });
      expect(((await payOf(noSri.id)).lint as { check: string }[]).map((f) => f.check)).toContain('pay.hyperpay-no-integrity');
    });

    it('the demo page prepares a checkout and loads the widget with SRI', async () => {
      const d = await call('GET', `${HP}/demo`);
      expect(d.status).toBe(200);
      expect(d.text).toContain('class="paymentWidgets"');
      expect(d.text).toMatch(/integrity="sha384-[^"]+" crossorigin="anonymous"/);
      expect(d.headers.get('content-security-policy')).toContain("frame-src 'self'");
      // The widget comes from the origin the demo was opened on (not a fixed https://localhost:4443) and matches its SRI hash.
      const [, src, sri] = /<script src="([^"]+)" integrity="([^"]+)"/.exec(d.text)!;
      const srcUrl = src!.replace(/&amp;/g, '&');
      expect(srcUrl.startsWith(`${base}${HP}/v1/paymentWidgets.js`), srcUrl).toBe(true);
      expect(d.text).toContain(`action="${base}${HP}/demo/result"`);
      const js = await fetch(srcUrl, { headers: { 'sec-fetch-mode': 'cors', origin: base } });
      const bytes = await js.text();
      expect(sri).toBe('sha384-' + createHash('sha384').update(bytes, 'utf8').digest('base64'));
      expect(bytes).toContain(`${base}${HP}/widget/`);
    });
  });

  describe('PayPal JS SDK', () => {
    it('serves the SDK for the instance client id, an error script otherwise, and answers CORS preflights', async () => {
      const js = await call('GET', `${PP}/sdk/js?client-id=${pp.clientId}&components=buttons,card-fields`);
      expect(js.status).toBe(200);
      expect(js.headers.get('access-control-allow-origin')).toBe('*');
      expect(js.text).toContain('paypal.Buttons = Buttons');
      expect(js.text).toContain('paypal.CardFields = CardFields');
      const bad = await call('GET', `${PP}/sdk/js?client-id=wrong`);
      expect(bad.text).toMatch(/^throw new Error/);
      const pre = await call('OPTIONS', `${PP}/sdk/orders`, { headers: { origin: 'http://shop.example', 'access-control-request-method': 'POST' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-headers')).toContain('x-stubyard-client-id');
    });

    it('Buttons flow over raw HTTP: client create → popup approval → close page → state poll → capture', async () => {
      const ch = { 'x-stubyard-client-id': pp.clientId };
      const c = await call('POST', `${PP}/sdk/orders`, { json: { intent: 'CAPTURE', purchase_units: unit('12.00') }, headers: ch });
      expect(c.status, c.text).toBe(201);
      const id = c.body.id as string;
      const unauth = await call('GET', `${PP}/sdk/orders/${id}/state`);
      expect(unauth.status).toBe(401);
      expect((await call('GET', `${PP}/sdk/orders/${id}/state`, { headers: ch })).body.state).toBe('open');
      const open = await call('GET', `${PP}/checkoutnow?token=${id}&sdk=1`);
      expect(open.status).toBe(302);
      const p = await payOf(id);
      expect((p.lint as { check: string }[]).map((f) => f.check)).toContain('pay.paypal-client-side-create');
      const page = await call('POST', `${PP}/page/${p.id}/complete`, { form: form({ outcome: 'success', method: 'paypal' }) });
      expect(page.status).toBe(200);
      expect(page.text).toContain('stubyard-sdk-done');
      expect(page.text).toContain('stubyard-paypal');
      const st = (await call('GET', `${PP}/sdk/orders/${id}/state`, { headers: ch })).body;
      expect(st.state).toBe('approved');
      expect(st.payerID).toBeTruthy();
      expect(st.facilitatorAccessToken).toMatch(/^A21AA/);
      // The browser-visible token is SDK-scoped: the server API refuses it (a server token still works).
      const viaSdk = await call('GET', `${PP}/v2/checkout/orders/${id}`, { headers: { authorization: `Bearer ${st.facilitatorAccessToken}` } });
      expect(viaSdk.status).toBe(401);
      expect(viaSdk.text).toContain('JS SDK');
      expect((await call('GET', `${PP}/v2/checkout/orders/${id}`, { headers: { authorization: `Bearer ${ppToken}` } })).status).toBe(200);
      const cap = await call('POST', `${PP}/sdk/orders/${id}/capture`, { json: {}, headers: ch });
      expect(cap.status, cap.text).toBe(201);
      expect(cap.body.status).toBe('COMPLETED');
    });

    it('Card Fields: iframe page, confirm without digits, SCA_ALWAYS challenge, liability shift', async () => {
      const order = await ppOrder({ payment_source: { card: { attributes: { verification: { method: 'SCA_ALWAYS' } } } } });
      expect(order.status).toBe('CREATED');
      const f = await call('GET', `${PP}/sdk/card-field?type=number&cf=abc123`);
      expect(f.status).toBe(200);
      expect(f.headers.get('content-security-policy')).toContain('sha256-');
      expect(f.text).toContain('stubyard-cf-number');
      const ch = { 'x-stubyard-client-id': pp.clientId };
      const real = await call('POST', `${PP}/sdk/orders/${order.id}/confirm-card`, { json: { card: { brand: 'visa', last4: '1234', test: false } }, headers: ch });
      expect(real.status).toBe(422);
      const conf = await call('POST', `${PP}/sdk/orders/${order.id}/confirm-card`, { json: { card: { brand: 'visa', last4: '4242', magicId: 'success', luhn: true, test: true }, expiry: '12/30', name: 'Jane' }, headers: ch });
      expect(conf.status, conf.text).toBe(200);
      expect(conf.body.state).toBe('challenge');
      const chal = await call('GET', new URL(conf.body.challengeUrl).pathname);
      expect(chal.status).toBe(200);
      const p = await payOf(order.id);
      await call('POST', `${PP}/page/${p.id}/complete`, { form: form({ outcome: '3ds_success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' }) });
      const st = (await call('GET', `${PP}/sdk/orders/${order.id}/state`, { headers: ch })).body;
      expect(st.state).toBe('approved');
      expect(st.liabilityShift).toBe('POSSIBLE');
      const full = (await ppGet(`/v2/checkout/orders/${order.id}`)).body;
      expect(full.payment_source.card.last_digits).toBe('4242');
      expect(full.payment_source.card.expiry).toBe('2030-12');
      expect(full.payment_source.card.authentication_result.liability_shift).toBe('POSSIBLE');
    });
  });

  describe('PayPal Expanded', () => {
    it('server-side card: approved at once, capture; a decline is a 201 with a DECLINED capture', async () => {
      const ok = await ppOrder({ payment_source: { card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Jane Jones' } } });
      expect(ok.status).toBe('APPROVED');
      expect(ok.payment_source.card.brand).toBe('VISA');
      const cap = await ppPost(`/v2/checkout/orders/${ok.id}/capture`, {});
      expect(cap.status, cap.text).toBe(201);
      expect(cap.body.purchase_units[0].payments.captures[0].status).toBe('COMPLETED');
      const bad = await ppOrder({ payment_source: { card: { number: '4000000000000002', expiry: '2030-12' } } });
      const dc = await ppPost(`/v2/checkout/orders/${bad.id}/capture`, {});
      expect(dc.status, dc.text).toBe(201);
      expect(dc.body.purchase_units[0].payments.captures[0].status).toBe('DECLINED');
      expect(dc.body.purchase_units[0].payments.captures[0].processor_response.response_code).toBe('0500');
    });

    it('a real-looking number is refused (422) and flagged; no PAN is stored anywhere', async () => {
      const pan = fakeRealPan();
      const r = await ppPost('/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: unit(), payment_source: { card: { number: pan, expiry: '2030-12' } } });
      expect(r.status).toBe(422);
      expect(await lintChecks()).toContain('pay.real-card-entered');
      await ppOrder({ payment_source: { card: { number: '5555555555554444', expiry: '2031-01', security_code: '999' } } });
      await new Promise((res) => setTimeout(res, 200));
      const tables = (hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      for (const t of tables) {
        // Response bodies of the hosted pages list the public test cards: only what was received / stored counts.
        const rows = (hub.db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('res'))));
        const dump = JSON.stringify(rows);
        expect(dump.includes(pan), t).toBe(false);
        const at = dump.indexOf('5555555555554444');
        expect(at, `${t}: ${dump.slice(Math.max(0, at - 300), at + 100)}`).toBe(-1);
      }
      const files = fs.readdirSync(dataDir, { recursive: true }).map(String);
      for (const f of files) {
        const full = path.join(dataDir, f);
        if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8').includes('5555555555554444'), f).toBe(false);
      }
    });

    it('3D Secure: PAYER_ACTION_REQUIRED, challenge success / failure, capture without a liability check is flagged', async () => {
      const o = await ppOrder({ payment_source: { card: { number: '4000002500003155', expiry: '2030-12', experience_context: { return_url: `${appUrl}/ok`, cancel_url: `${appUrl}/no` } } } });
      expect(o.status).toBe('PAYER_ACTION_REQUIRED');
      const link = (o.links as { rel: string; href: string }[]).find((l) => l.rel === 'payer-action')!;
      expect(link.href).toContain('/sdk/challenge/');
      expect((await call('GET', new URL(link.href).pathname)).status).toBe(200);
      const p = await payOf(o.id);
      const done = await call('POST', `${PP}/page/${p.id}/complete`, { form: form({ outcome: '3ds_success', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' }) });
      expect(done.status).toBe(303);
      expect(done.headers.get('location')).toContain(`${appUrl}/ok?token=${o.id}`);
      const cap = await ppPost(`/v2/checkout/orders/${o.id}/capture`, {});
      expect(cap.status, cap.text).toBe(201);
      expect(cap.body.payment_source.card.authentication_result).toMatchObject({ liability_shift: 'POSSIBLE', three_d_secure: { enrollment_status: 'Y', authentication_status: 'Y' } });
      expect(((await payOf(o.id)).lint as { check: string }[]).map((f) => f.check)).toContain('pay.paypal-capture-without-liability-check');

      const f = await ppOrder({ payment_source: { card: { number: '4000002500003155', expiry: '2030-12' } } });
      const pf = await payOf(f.id);
      await call('POST', `${PP}/page/${pf.id}/complete`, { form: form({ outcome: '3ds_fail', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' }) });
      const got = (await ppGet(`/v2/checkout/orders/${f.id}`)).body;
      expect(got.payment_source.card.authentication_result.liability_shift).toBe('NO');
      expect((await payOf(f.id)).status).toBe('failed');
    });

    it('intent AUTHORIZE: authorize, partial captures, refund, void after capture refused', async () => {
      const o = await ppOrder({ intent: 'AUTHORIZE', purchase_units: unit('30.00') });
      const wrong = await ppPost(`/v2/checkout/orders/${o.id}/capture`, {});
      expect(wrong.status).toBe(422);
      expect(wrong.body.details[0].issue).toBe('ACTION_DOES_NOT_MATCH_INTENT');
      const p = await payOf(o.id);
      await complete(p.id, { method: 'paypal' });
      const a = await ppPost(`/v2/checkout/orders/${o.id}/authorize`, {});
      expect(a.status, a.text).toBe(201);
      expect(a.body.status).toBe('COMPLETED');
      const auth = a.body.purchase_units[0].payments.authorizations[0];
      expect(auth.status).toBe('CREATED');
      await waitFor(() => hitsAt('/pp').find((h) => h.body.includes('PAYMENT.AUTHORIZATION.CREATED') && h.body.includes(auth.id)));
      const c1 = await ppPost(`/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: 'USD', value: '10.00' }, final_capture: false }, { prefer: 'return=representation' });
      expect(c1.status, c1.text).toBe(201);
      expect(c1.body.amount.value).toBe('10.00');
      expect(c1.body.final_capture).toBe(false);
      expect((await ppGet(`/v2/payments/authorizations/${auth.id}`)).body.status).toBe('PARTIALLY_CAPTURED');
      const over = await ppPost(`/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: 'USD', value: '25.00' } });
      expect(over.status).toBe(422);
      expect(over.body.details[0].issue).toBe('MAX_CAPTURE_AMOUNT_EXCEEDED');
      const c2 = await ppPost(`/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: 'USD', value: '20.00' }, final_capture: true });
      expect(c2.status, c2.text).toBe(201);
      // The traffic row matches the wire reply (a sent reply awaited as a thenable used to fall through to a 404).
      const capRow = await trafficRow(`/v2/payments/authorizations/${auth.id}/capture`);
      expect([capRow.res_status, capRow.outcome]).toEqual([201, 'ok']);
      expect(JSON.parse(capRow.resolved).error).toBeUndefined();
      expect((await ppGet(`/v2/payments/authorizations/${auth.id}`)).body.status).toBe('CAPTURED');
      const order = (await ppGet(`/v2/checkout/orders/${o.id}`)).body;
      expect(order.intent).toBe('AUTHORIZE');
      expect(order.purchase_units[0].payments.captures).toHaveLength(2);
      const v = await ppPost(`/v2/payments/authorizations/${auth.id}/void`, {});
      expect(v.status).toBe(422);
      expect(v.body.details[0].issue).toBe('PREVIOUSLY_CAPTURED');
      const rf = await ppPost(`/v2/payments/captures/${c1.body.id}/refund`, { amount: { currency_code: 'USD', value: '5.00' } });
      expect(rf.status, rf.text).toBe(201);
      expect((await ppGet(`/v2/payments/captures/${c1.body.id}`)).body.id).toBe(c1.body.id);
    });

    it('reauthorize then void: new authorization id, old one refused, VOIDED webhook', async () => {
      const o = await ppOrder({ intent: 'AUTHORIZE' });
      await complete((await payOf(o.id)).id, { method: 'paypal' });
      const auth = (await ppPost(`/v2/checkout/orders/${o.id}/authorize`, {})).body.purchase_units[0].payments.authorizations[0];
      const re = await ppPost(`/v2/payments/authorizations/${auth.id}/reauthorize`, {}, { prefer: 'return=representation' });
      expect(re.status, re.text).toBe(201);
      expect(re.body.id).not.toBe(auth.id);
      const old = await ppPost(`/v2/payments/authorizations/${auth.id}/capture`, {});
      expect(old.status).toBe(422);
      const v = await ppPost(`/v2/payments/authorizations/${re.body.id}/void`, {});
      expect(v.status).toBe(204);
      expect((await payOf(o.id)).status).toBe('cancelled');
      expect((await ppGet(`/v2/payments/authorizations/${re.body.id}`)).body.status).toBe('VOIDED');
      await waitFor(() => hitsAt('/pp').find((h) => h.body.includes('PAYMENT.AUTHORIZATION.VOIDED') && h.body.includes(re.body.id)));
    });
  });

  describe('computed lints', () => {
    it('flags a HyperPay result never queried and a PayPal order approved but never captured (after 30 s)', async () => {
      const co = await prepare();
      await complete((await payOf(co.id)).id, { card: 'success' });
      const o = await ppOrder({});
      await complete((await payOf(o.id)).id, { method: 'paypal' });
      const old = new Date(Date.now() - 60_000).toISOString();
      hub.db.prepare('UPDATE payments SET updated_at = ? WHERE provider_ref IN (?, ?)').run(old, co.id, o.id);
      const checks = await lintChecks();
      expect(checks).toContain('pay.hyperpay-result-never-queried');
      expect(checks).toContain('pay.paypal-approve-without-capture');
    });
  });

  describe('PayPal Vault v3', () => {
    it('card setup token → payment token → vault_id order; list, delete, webhooks', async () => {
      const s = await ppPost('/v3/vault/setup-tokens', { payment_source: { card: { number: '4242424242424242', expiry: '2030-11', security_code: '123', name: 'Jane' } } });
      expect(s.status, s.text).toBe(201);
      expect(s.body.status).toBe('APPROVED');
      const t = await ppPost('/v3/vault/payment-tokens', { payment_source: { token: { id: s.body.id, type: 'SETUP_TOKEN' } } });
      expect(t.status, t.text).toBe(201);
      expect(t.body.payment_source.card.last_digits).toBe('4242');
      for (const u of ['/v3/vault/setup-tokens', '/v3/vault/payment-tokens']) {
        const row = await trafficRow(u);
        expect([row.res_status, row.outcome], u).toEqual([201, 'ok']);
        expect(JSON.parse(row.resolved).error, u).toBeUndefined();
      }
      const customer = t.body.customer.id as string;
      await waitFor(() => hitsAt('/pp').find((h) => h.body.includes('VAULT.PAYMENT-TOKEN.CREATED') && h.body.includes(t.body.id)));
      const o = await ppOrder({ payment_source: { card: { vault_id: t.body.id } } });
      expect(o.status).toBe('APPROVED');
      expect((await ppPost(`/v2/checkout/orders/${o.id}/capture`, {})).status).toBe(201);
      const list = await ppGet(`/v3/vault/payment-tokens?customer_id=${customer}`);
      expect(list.body.payment_tokens.map((x: { id: string }) => x.id)).toContain(t.body.id);
      const ctl = await api('GET', `${PJ}/payments/tokens?instance=paypal`);
      expect(ctl.body.some((x: { providerRef: string }) => x.providerRef === t.body.id)).toBe(true);
      expect(JSON.stringify(ctl.body)).not.toContain('4242424242424242');
      const del = await call('DELETE', `${PP}/v3/vault/payment-tokens/${t.body.id}`, { headers: { authorization: `Bearer ${ppToken}` } });
      expect(del.status).toBe(204);
      expect((await ppGet(`/v3/vault/payment-tokens/${t.body.id}`)).status).toBe(404);
      await waitFor(() => hitsAt('/pp').find((h) => h.body.includes('VAULT.PAYMENT-TOKEN.DELETED')));
    });

    it('PayPal setup token needs buyer approval; store_in_vault ON_SUCCESS saves at capture', async () => {
      const s = await ppPost('/v3/vault/setup-tokens', { payment_source: { paypal: { usage_type: 'MERCHANT', experience_context: { return_url: `${appUrl}/vault-ok`, cancel_url: `${appUrl}/vault-no` } } } });
      expect(s.status, s.text).toBe(201);
      expect(s.body.status).toBe('PAYER_ACTION_REQUIRED');
      const early = await ppPost('/v3/vault/payment-tokens', { payment_source: { token: { id: s.body.id, type: 'SETUP_TOKEN' } } });
      expect(early.status).toBe(422);
      const approve = (s.body.links as { rel: string; href: string }[]).find((l) => l.rel === 'approve')!;
      expect((await call('GET', new URL(approve.href).pathname)).status).toBe(200);
      const ok = await call('POST', new URL(approve.href).pathname, { form: 'decision=approve' });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toContain(`approval_token_id=${s.body.id}`);
      const t = await ppPost('/v3/vault/payment-tokens', { payment_source: { token: { id: s.body.id, type: 'SETUP_TOKEN' } } });
      expect(t.status, t.text).toBe(201);
      const o = await ppOrder({ payment_source: { paypal: { vault_id: t.body.id } } });
      expect(o.status).toBe('APPROVED');

      const sv = await ppOrder({ payment_source: { card: { number: '4242424242424242', expiry: '2030-12', attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } } } });
      const cap = await ppPost(`/v2/checkout/orders/${sv.id}/capture`, {});
      expect(cap.status, cap.text).toBe(201);
      expect(cap.body.payment_source.card.attributes.vault).toMatchObject({ status: 'VAULTED' });
      const detail = await mcp('get_payment', { project: 'shop1b', payment: sv.id });
      expect(detail.tokens.length).toBe(1);
    });

    it('id_token for returning payers', async () => {
      const t = await call('POST', `${PP}/v1/oauth2/token`, { form: 'grant_type=client_credentials&response_type=id_token&target_customer_id=customer_1', headers: { authorization: 'Basic ' + Buffer.from(`${pp.clientId}:${pp.clientSecret}`).toString('base64') } });
      expect(t.status).toBe(200);
      expect(String(t.body.id_token).split('.')).toHaveLength(3);
    });
  });
});

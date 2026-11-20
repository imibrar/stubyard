import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { inferSchema, validateSchema } from '../src/webhooks/schema.js';
import { newContext, render } from '../src/webhooks/template.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

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

const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');

describe('webhook schema + templates (unit)', () => {
  it('infers types, required keys, nested objects/arrays and formats', () => {
    const sample = {
      id: 'evt_1',
      amount: 12.5,
      count: 3,
      paid: true,
      email: 'a@b.test',
      created: '2026-11-19T10:00:00Z',
      day: '2026-11-19',
      link: 'https://example.test/x',
      meta: null,
      customer: { id: 'c1', tags: ['a', 'b'] },
      items: [{ sku: 'x', qty: 1 }, { sku: 'y', qty: 2.5, note: 'n' }],
    };
    const s = inferSchema(sample) as any;
    expect(s.type).toBe('object');
    expect(s.required).toEqual(Object.keys(sample));
    expect(s.properties.amount).toEqual({ type: 'number' });
    expect(s.properties.count).toEqual({ type: 'integer' });
    expect(s.properties.paid).toEqual({ type: 'boolean' });
    expect(s.properties.email).toEqual({ type: 'string', format: 'email' });
    expect(s.properties.created.format).toBe('date-time');
    expect(s.properties.day.format).toBe('date');
    expect(s.properties.link.format).toBe('uri');
    expect(s.properties.customer.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(s.properties.items.items.required).toEqual(['sku', 'qty']);
    expect(s.properties.items.items.properties.qty).toEqual({ type: 'number' });
    expect(validateSchema(s, sample)).toEqual([]);
    const errs = validateSchema(s, { ...sample, amount: 'x', email: 'nope', customer: { tags: [1] } });
    expect(errs.map((e) => e.path)).toEqual(expect.arrayContaining(['/amount', '/email', '/customer/id', '/customer/tags/0']));
  });

  it('renders variables with JSON escaping', () => {
    const ctx = newContext({ user: { name: 'O"Brien', email: 'o@x.test' }, data: { order: { id: 7, items: [{ sku: 's1' }] } } });
    const r = render('{"n":"{{user.name}}","id":{{data.order.id}},"sku":"{{data.items[0].sku}}","o":{{data.order}},"u":"{{uuid}}","u2":"{{uuid}}","x":"{{nope}}"}', ctx, { json: true });
    const out = JSON.parse(r.text);
    expect(out.n).toBe('O"Brien');
    expect(out.id).toBe(7);
    expect(out.o).toEqual({ id: 7, items: [{ sku: 's1' }] });
    expect(out.u).toBe(out.u2);
    expect(out.sku).toBe('');
    expect(r.missing).toEqual(['data.items[0].sku', 'nope']);
  });
});

describe.skipIf(!haveMailpit)('webhooks end-to-end', () => {
  let running: RunningHub;
  let base: string;
  let dataDir: string;
  let appServer: http.Server;
  let appUrl: string;
  const received: { path: string; headers: http.IncomingHttpHeaders; body: string; at: number }[] = [];

  async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const r = await fetch(base + p, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: r.status, body: parsed as T, headers: r.headers };
  }

  async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const finished = (id: string) => waitFor(async () => {
    const l = await api('GET', `/api/logs/${id}`);
    return l.body.outcome !== 'pending' ? l.body : null;
  });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-hooks-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body, at: Date.now() });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    base = `http://127.0.0.1:${httpPort}`;
    const p = await api('POST', '/api/projects', { name: 'Hooks', generateUsers: { admins: 1, customers: 2 } });
    expect(p.status).toBe(201);
  });

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let endpointId: string;
  let validLogId: string;

  it('receives webhooks on a configured endpoint and validates them against its schema', async () => {
    const schema = {
      type: 'object',
      required: ['amount', 'currency'],
      properties: { amount: { type: 'number', minimum: 0 }, currency: { type: 'string', enum: ['USD', 'PKR'] } },
    };
    const e = await api('POST', '/api/projects/hooks/webhook-endpoints', {
      name: 'Payments',
      path: '/payments/:id',
      method: 'POST',
      schema,
      response: { status: 201, headers: { 'x-from': 'stubyard' }, body: '{"ok":true,"id":"{{params.id}}","amount":{{body.amount}}}' },
    });
    expect(e.status).toBe(201);
    expect(e.body.urls.https).toMatch(/\/hook\/hooks\/payments\/:id$/);
    endpointId = e.body.id;

    const ok = await api('POST', '/hook/hooks/payments/pay_1', { amount: 10, currency: 'USD' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ok: true, id: 'pay_1', amount: 10 });
    expect(ok.headers.get('x-from')).toBe('stubyard');
    validLogId = ok.headers.get('x-hub-request-id')!;
    const log = await finished(validLogId);
    expect(log.outcome).toBe('ok');
    expect(log.projectId).toBeTruthy();
    expect(log.resolved).toMatchObject({ endpoint: 'Payments', endpointId, valid: true, params: { id: 'pay_1' } });

    const bad = await api('POST', '/hook/hooks/payments/pay_2', { amount: -1, currency: 'EUR' });
    expect(bad.status).toBe(201); // configured response, but marked invalid
    const badLog = await finished(bad.headers.get('x-hub-request-id')!);
    expect(badLog.outcome).toBe('invalid');
    expect(badLog.resolved.valid).toBe(false);
    expect(badLog.resolved.errors.map((x: any) => x.path).sort()).toEqual(['/amount', '/currency']);

    const broken = await api('POST', '/hook/hooks/payments/pay_3', '{not json');
    const brokenLog = await finished(broken.headers.get('x-hub-request-id')!);
    expect(brokenLog.outcome).toBe('invalid');
    expect(brokenLog.resolved.errors[0].message).toMatch(/Invalid JSON/);

    // rejectInvalid answers 400 with the errors
    await api('PATCH', `/api/projects/hooks/webhook-endpoints/${endpointId}`, { response: { rejectInvalid: true } });
    const rejected = await api('POST', '/hook/hooks/payments/pay_4', { amount: 'x' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.errors.length).toBeGreaterThan(0);

    const hits = await api('GET', `/api/projects/hooks/webhook-endpoints/${endpointId}/hits`);
    expect(hits.body).toHaveLength(4);
    expect(hits.body.map((h: any) => h.resolved.valid)).toEqual([false, false, false, true]);
    const list = await api('GET', '/api/projects/hooks/webhook-endpoints');
    expect(list.body[0].stats).toMatchObject({ hits: 4, invalid: 3 });
  });

  it('keeps answering unknown hooks with a logged 404', async () => {
    const r = await api('POST', '/hook/hooks/nope', { a: 1 });
    expect(r.status).toBe(404);
    expect(r.body.hint).toMatch(/Webhooks/);
    const log = await finished(r.headers.get('x-hub-request-id')!);
    expect(log.outcome).toBe('unmatched');
    expect(log.projectId).toBeTruthy();
    // wrong method on a known path
    const g = await api('GET', '/hook/hooks/payments/pay_1');
    expect(g.status).toBe(404);
    const u = await api('POST', '/hook/nobody/x', {});
    expect(u.status).toBe(404);
    expect((await finished(u.headers.get('x-hub-request-id')!)).resolved.unknownProject).toBe('nobody');
  });

  it('infers a schema from a sample', async () => {
    const r = await api('POST', '/api/projects/hooks/schemas/infer', { sample: { id: 'x', email: 'a@b.test', n: 1, at: '2026-01-01T00:00:00Z' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      type: 'object',
      required: ['id', 'email', 'n', 'at'],
      properties: { email: { type: 'string', format: 'email' }, n: { type: 'integer' }, at: { format: 'date-time' } },
    });
  });

  let stripeLogId: string;

  it('sends templated, HMAC-signed webhooks as a test user', async () => {
    const t = await api('POST', '/api/projects/hooks/webhook-templates', {
      name: 'user.updated',
      targetUrl: `${appUrl}/hmac`,
      headers: { 'X-Event-Id': '{{uuid}}' },
      bodyTemplate: '{"id":"{{uuid}}","email":"{{user.email}}","role":"{{user.role}}","order":"{{data.order.id}}","amount":{{faker.amount}},"at":"{{now}}"}',
      signing: { preset: 'hmac', secret: 'shh', header: 'X-Hub-Signature-256', prefix: 'sha256=' },
    });
    expect(t.status).toBe(201);
    const users = await api('GET', '/api/projects/hooks/users');
    const admin = users.body.find((u: any) => u.role === 'admin');
    const r = await api('POST', `/api/projects/hooks/webhook-templates/${t.body.id}/send`, { asUser: 'admin', data: { order: { id: 'o-9' } } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.logId).toBeTruthy();
    const got = received.find((x) => x.path === '/hmac')!;
    const body = JSON.parse(got.body);
    expect(body).toMatchObject({ email: admin.email, role: 'admin', order: 'o-9' });
    expect(typeof body.amount).toBe('number');
    expect(got.headers['x-event-id']).toBe(body.id);
    expect(got.headers['x-hub-signature-256']).toBe(`sha256=${hmac('shh', got.body)}`);
    const log = await finished(r.body.logId);
    expect(log.direction).toBe('outbound');
    expect(log.resolved).toMatchObject({ template: 'user.updated', templateId: t.body.id, signing: 'hmac', userId: admin.id });
  });

  it('signs Stripe-style (t=…,v1=…)', async () => {
    const t = await api('POST', '/api/projects/hooks/webhook-templates', {
      name: 'payment_intent.succeeded',
      targetUrl: `${appUrl}/stripe`,
      bodyTemplate: '{"id":"evt_{{uuid}}","type":"payment_intent.succeeded","data":{"object":{"amount":{{data.amount}}}}}',
      signing: { preset: 'stripe', secret: 'whsec_test' },
    });
    const r = await api('POST', `/api/projects/hooks/webhook-templates/${t.body.id}/send`, { data: { amount: 4200 } });
    expect(r.body.ok).toBe(true);
    stripeLogId = r.body.logId;
    const got = received.filter((x) => x.path === '/stripe').at(-1)!;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(got.headers['stripe-signature']));
    expect(m).toBeTruthy();
    expect(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(5);
    expect(m![2]).toBe(hmac('whsec_test', `${m![1]}.${got.body}`));
    expect(JSON.parse(got.body).data.object.amount).toBe(4200);
  });

  it('runs sequences in order with delays and repeats (durable scheduler)', async () => {
    const mk = (name: string) =>
      api('POST', '/api/projects/hooks/webhook-templates', {
        name,
        targetUrl: `${appUrl}/seq`,
        bodyTemplate: `{"event":"${name}","payment":"{{run.id}}","eventId":"{{uuid}}"}`,
        signing: { preset: 'hmac', secret: 'k' },
      });
    const pending = await mk('payment.pending');
    const success = await mk('payment.success');
    const seq = await api('POST', '/api/projects/hooks/webhook-sequences', {
      name: 'pay flow',
      steps: [
        { template: 'payment.pending', delayMs: 0 },
        { templateId: success.body.id, delayMs: 600, repeat: 2 },
      ],
    });
    expect(seq.status).toBe(201);
    expect(seq.body.steps[0].templateId).toBe(pending.body.id);
    const t0 = Date.now();
    const run = await api('POST', `/api/projects/hooks/webhook-sequences/${seq.body.id}/run`, {});
    expect(run.status).toBe(202);
    expect(run.body.steps.map((s: any) => s.template)).toEqual(['payment.pending', 'payment.success']);
    const got = await waitFor(() => {
      const s = received.filter((x) => x.path === '/seq');
      return s.length >= 3 ? s : null;
    }, 8000);
    const bodies = got.map((g) => JSON.parse(g.body));
    expect(bodies.map((b) => b.event)).toEqual(['payment.pending', 'payment.success', 'payment.success']);
    expect(new Set(bodies.map((b) => b.payment)).size).toBe(1); // run.id shared
    expect(bodies[1].eventId).toBe(bodies[2].eventId); // repeat = identical payload (idempotency test)
    expect(bodies[0].eventId).not.toBe(bodies[1].eventId);
    expect(got[1].at - got[0].at).toBeGreaterThanOrEqual(550);
    expect(got[0].at - t0).toBeLessThan(1500);
    for (const g of got) expect(g.headers['x-signature']).toBe(`sha256=${hmac('k', g.body)}`);
    const results = await waitFor(async () => {
      const r = await api('GET', `/api/projects/hooks/webhook-sequences/${seq.body.id}/results`);
      return r.body.length === 3 ? r.body : null;
    });
    expect(results.map((l: any) => l.resolved.step)).toEqual([2, 2, 1]);
  });

  it('replays a sent webhook (re-signed) and a captured inbound request, linked by parentLogId', async () => {
    const before = received.filter((x) => x.path === '/stripe').length;
    const r = await api('POST', `/api/logs/${stripeLogId}/replay`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, parentLogId: stripeLogId, resigned: true });
    const log = await finished(r.body.logId);
    expect(log.parentLogId).toBe(stripeLogId);
    expect(log.resolved.replayOf).toBe(stripeLogId);

    // edited body → signature matches the new body
    const edited = await api('POST', `/api/logs/${stripeLogId}/replay`, { body: { id: 'evt_edited', type: 'payment_intent.succeeded' } });
    expect(edited.body.ok).toBe(true);
    const got = received.filter((x) => x.path === '/stripe');
    expect(got.length).toBe(before + 2);
    const last = got.at(-1)!;
    expect(JSON.parse(last.body).id).toBe('evt_edited');
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(last.headers['stripe-signature']))!;
    expect(m[2]).toBe(hmac('whsec_test', `${m[1]}.${last.body}`));

    // without re-signing, the old signature is kept
    const raw = await api('POST', `/api/logs/${stripeLogId}/replay`, { resign: false });
    expect(raw.body.resigned).toBe(false);
    expect(received.at(-1)!.headers['stripe-signature']).toBe(got[before - 1].headers['stripe-signature']);

    // captured inbound request → sent to stubyard again (endpoint answers 201)
    const inbound = await api('POST', `/api/logs/${validLogId}/replay`, {});
    expect(inbound.body).toMatchObject({ ok: true, status: 201, parentLogId: validLogId, resigned: false });
    expect((await finished(inbound.body.logId)).parentLogId).toBe(validLogId);

    // to another URL with a different body
    const fwd = await api('POST', `/api/logs/${validLogId}/replay`, { url: `${appUrl}/forwarded`, body: '{"amount":1,"currency":"PKR"}' });
    expect(fwd.body.ok).toBe(true);
    expect(received.at(-1)!).toMatchObject({ path: '/forwarded', body: '{"amount":1,"currency":"PKR"}' });

    // resign on an unsigned capture is refused
    expect((await api('POST', `/api/logs/${validLogId}/replay`, { resign: true })).status).toBe(400);
  });

  it('lists endpoint URLs in the setup guide and validates config', async () => {
    const g = await api('GET', '/api/projects/hooks/setup');
    const s = g.body.sections.find((x: any) => x.id === 'webhooks');
    expect(s.snippets[1].code).toContain('/hook/hooks/payments/:id');
    expect((await api('POST', '/api/projects/hooks/webhook-endpoints', { path: 'x', schema: '{bad' })).status).toBe(400);
    expect((await api('POST', '/api/projects/hooks/webhook-endpoints', { path: 'payments/:id', method: 'POST' })).status).toBe(409);
    expect((await api('POST', '/api/projects/hooks/webhook-templates', { name: 'n', targetUrl: 'x', signing: { preset: 'stripe' } })).status).toBe(400);
    expect((await api('DELETE', '/api/projects/hooks/webhook-templates/payment.pending')).status).toBe(409); // used by a sequence
  });

  it('exports and imports webhook endpoints, templates and sequences', async () => {
    const before = {
      endpoints: (await api('GET', '/api/projects/hooks/webhook-endpoints')).body.length,
      templates: (await api('GET', '/api/projects/hooks/webhook-templates')).body,
      sequences: (await api('GET', '/api/projects/hooks/webhook-sequences')).body,
    };
    expect(before.endpoints).toBeGreaterThan(0);
    expect(before.sequences.length).toBeGreaterThan(0);

    const noSecrets = await api('GET', '/api/projects/hooks/export');
    const signed = noSecrets.body.webhookTemplates.find((t: any) => t.signing?.preset && t.signing.preset !== 'none');
    expect(signed).toBeTruthy();
    expect(signed.signing.secret).toBeUndefined();
    expect(noSecrets.body.webhookSequences[0].steps[0].templateId).toBe(before.templates.find((t: any) => t.id === before.sequences[0].steps[0].templateId).name);

    const exp = await api('GET', '/api/projects/hooks/export?secrets=1');
    const imp = await api('POST', '/api/projects/import', { json: exp.body, slug: 'hooks-copy', mode: 'create' });
    expect(imp.status).toBeLessThan(300);
    expect((await api('GET', '/api/projects/hooks-copy/webhook-endpoints')).body).toHaveLength(before.endpoints);
    const copiedTemplates = (await api('GET', '/api/projects/hooks-copy/webhook-templates')).body;
    expect(copiedTemplates.map((t: any) => t.name).sort()).toEqual(before.templates.map((t: any) => t.name).sort());
    const copiedSeq = (await api('GET', '/api/projects/hooks-copy/webhook-sequences')).body[0];
    // Steps point at the copied templates, not the originals.
    expect(copiedTemplates.map((t: any) => t.id)).toContain(copiedSeq.steps[0].templateId);
    expect(copiedTemplates.find((t: any) => t.name === signed.name).signing.secret).toBeTruthy();
  });
});

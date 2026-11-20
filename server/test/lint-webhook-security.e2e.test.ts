import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

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

const SECRET = 'whsec_lint_test';
const HMAC_SECRET = 'hmac_secret';

/** A webhook handler that does everything right (Stripe-style verification, size limit, JSON only, idempotent). */
function goodApp(): http.Server {
  const seen = new Set<string>();
  return http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (Number(req.headers['content-length'] ?? 0) > 100 * 1024) {
      req.resume();
      return reply(413, { error: 'too large' });
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const header = String(req.headers['stripe-signature'] ?? '');
      const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
      if (!parts.t || !parts.v1) return reply(400, { error: 'missing signature' });
      const expected = createHmac('sha256', SECRET).update(`${parts.t}.${raw}`).digest('hex');
      if (expected.length !== parts.v1.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) return reply(400, { error: 'bad signature' });
      if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return reply(400, { error: 'timestamp outside tolerance' });
      if (!/application\/json/.test(String(req.headers['content-type']))) return reply(415, { error: 'json only' });
      let event: { id?: string };
      try {
        event = JSON.parse(raw);
      } catch {
        return reply(400, { error: 'invalid json' });
      }
      if (event.id && seen.has(event.id)) return reply(200, { received: true, duplicate: true });
      if (event.id) seen.add(event.id);
      return reply(200, { received: true });
    });
  });
}

/** A handler that trusts everything (and crashes on bad JSON). */
function sloppyApp(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } catch {
        res.writeHead(500).end('TypeError: cannot read properties of undefined');
      }
    });
  });
}

describe.skipIf(!haveMailpit)('content lint + webhook security suite (e2e)', () => {
  let running: RunningHub;
  let base: string;
  let smtpPort: number;
  let dataDir: string;
  let good: http.Server;
  let sloppy: http.Server;
  let goodUrl: string;
  let sloppyUrl: string;

  async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
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
    return { status: r.status, body: parsed as T };
  }
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream' });
    expect(r.body.result.isError).toBeUndefined();
    return JSON.parse(r.body.result.content[0].text);
  };
  const mailer = (user: string) => nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user, pass: 'x' } });
  async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const listen = async (s: http.Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-lint-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
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
      callbackDelayMs: 50,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    good = goodApp();
    sloppy = sloppyApp();
    goodUrl = await listen(good);
    sloppyUrl = await listen(sloppy);
    expect((await api('POST', '/api/projects', { name: 'Lint', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);
    await api('POST', '/api/projects/lint/providers', { preset: 'smtp', slug: 'marketing', name: 'Marketing SMTP', labels: ['marketing'] });
    await api('POST', '/api/projects/lint/providers', { preset: 'twilio', slug: 'sms' });
    await api('POST', '/api/projects/lint/providers', { preset: 'meta-whatsapp', slug: 'wa' });
  });

  afterAll(async () => {
    good?.close();
    sloppy?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const user = async (ref: string) => (await api('GET', `/api/projects/lint/users/${ref}`)).body;

  // ------------------------------------------------------------------ lint

  it('lints an SMS: placeholder + UCS-2 caused by a curly quote', async () => {
    const c1 = await user('customer1');
    const body = new URLSearchParams({ To: c1.phone, From: '+15550001111', Body: 'Hi {{name}}, your code is 482913. We’ll never ask for it.' }).toString();
    const r = await api('POST', '/mock/lint/sms/2010-04-01/Accounts/ACtest/Messages.json', body, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(201);
    const [m] = (await api('GET', '/api/projects/lint/messages?user=customer1&channel=sms')).body;
    expect(m.lint.map((f: any) => f.check)).toEqual(['placeholder', 'sms-encoding']);
    expect(m.lint[0]).toMatchObject({ severity: 'error', excerpt: '{{name}}' });
    expect(m.lint[1].message).toContain('’ (U+2019)');
  });

  it('lints marketing email headers from SMTP, and a clean transactional email has no findings', async () => {
    const c2 = await user('customer2');
    await mailer('lint.marketing').sendMail({ from: 'news@shop.example.org', to: c2.email, subject: 'Big sale', text: 'Sale! http://localhost:3000/sale', html: '<p>Sale!</p>' });
    await mailer('lint.marketing').sendMail({
      from: '"Shop" <news@shop.example.org>',
      to: c2.email,
      subject: 'Big sale 2',
      text: 'Sale! https://shop.example.org/sale',
      html: '<p>Sale!</p>',
      headers: { 'List-Unsubscribe': '<https://shop.example.org/u?c=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    await mailer('lint').sendMail({ from: '"Shop" <auth@shop.example.org>', to: c2.email, subject: 'Your code', html: '<p>Your code is 123456</p>' });
    const msgs = await waitFor(async () => {
      const l = (await api('GET', '/api/projects/lint/messages?user=customer2&channel=email')).body;
      return l.length >= 3 ? l : null;
    });
    const bySubject = Object.fromEntries(msgs.map((m: any) => [m.subject, m.lint.map((f: any) => f.check)]));
    expect(bySubject['Big sale']).toEqual(expect.arrayContaining(['email-unsubscribe', 'link-local', 'email-from-name']));
    expect(bySubject['Big sale 2']).toEqual([]);
    // HTML only: mailparser invents a text part, stubyard still sees there was none.
    expect(bySubject['Your code']).toEqual(['email-text-part']);
  });

  it('lints WhatsApp templates with empty parameters', async () => {
    const c1 = await user('customer1');
    const r = await api('POST', '/mock/lint/wa/v21.0/123456/messages', {
      messaging_product: 'whatsapp',
      to: c1.whatsapp.replace('+', ''),
      type: 'template',
      template: { name: 'order_ready', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ali' }, { type: 'text', text: '' }] }] },
    });
    expect(r.status).toBe(200);
    const [m] = (await api('GET', '/api/projects/lint/messages?user=customer1&channel=whatsapp')).body;
    expect(m.lint).toEqual([expect.objectContaining({ check: 'wa-template-params', severity: 'error' })]);
  });

  it('filters messages by lint level and summarises per user / check', async () => {
    const errors = (await api('GET', '/api/projects/lint/messages?lint=error')).body;
    expect(errors.length).toBe(3); // SMS placeholder, marketing email, WhatsApp template
    expect(errors.every((m: any) => m.lint.some((f: any) => f.severity === 'error'))).toBe(true);
    const warns = (await api('GET', '/api/projects/lint/messages?lint=warn')).body;
    expect(warns.length).toBe(4); // + HTML without text part
    expect((await api('GET', '/api/projects/lint/messages?lint=bogus')).status).toBe(400);

    const s = (await api('GET', '/api/projects/lint/lint')).body;
    expect(s.totals).toMatchObject({ messages: 5, withFindings: 4, error: 3, warn: 1, info: 0 });
    expect(s.byCheck.find((c: any) => c.check === 'email-unsubscribe').count).toBe(1);
    const c1id = (await user('customer1')).id;
    const c1 = s.byUser.find((u: any) => u.testUserId === c1id);
    expect(c1).toMatchObject({ error: 2 });
    expect(s.checks.every((c: any) => c.enabled)).toBe(true);
    const one = (await api('GET', '/api/projects/lint/lint?user=customer2')).body;
    expect(one.totals).toMatchObject({ messages: 3, withFindings: 2 });
  });

  it('honours disabled checks and production domains from the project settings', async () => {
    expect((await api('PATCH', '/api/projects/lint', { settings: { lintDisabled: ['sms-encoding'], productionDomains: ['shop.example.org'] } })).status).toBe(200);
    expect((await api('PATCH', '/api/projects/lint', { settings: { productionDomains: 'nope' } })).status).toBe(400);
    const c1 = await user('customer1');
    const body = new URLSearchParams({ To: c1.phone, From: '+15550001111', Body: 'Track: https://shop.example.org/o/1 — thanks' }).toString();
    await api('POST', '/mock/lint/sms/2010-04-01/Accounts/ACtest/Messages.json', body, { 'content-type': 'application/x-www-form-urlencoded' });
    const [m] = (await api('GET', '/api/projects/lint/messages?user=customer1&channel=sms&limit=1')).body;
    expect(m.lint.map((f: any) => f.check)).toEqual(['link-production']);
    const s = (await api('GET', '/api/projects/lint/lint')).body;
    expect(s.checks.find((c: any) => c.id === 'sms-encoding').enabled).toBe(false);
    // Ad-hoc check uses the same settings
    const adhoc = (await api('POST', '/api/lint/check?project=lint', { channel: 'sms', text: 'Hi %s – https://shop.example.org' })).body;
    expect(adhoc.findings.map((f: any) => f.check)).toEqual(['placeholder', 'link-production']);
  });

  it('exposes findings over MCP (get_messages, lint_report)', async () => {
    const msgs = await mcp('get_messages', { project: 'lint', lint: 'error' });
    expect(msgs.length).toBe(3);
    expect(msgs[0].lint.length).toBeGreaterThan(0);
    const report = await mcp('lint_report', { project: 'lint', user: 'customer2' });
    expect(report.totals.withFindings).toBe(2);
    expect(report.recent[0].findings.length).toBeGreaterThan(0);
    const adhoc = await mcp('lint_report', { project: 'lint', channel: 'email', subject: 'Hi', text: 'Hello undefined' });
    expect(adhoc.findings.map((f: any) => f.check)).toContain('leaked-value');
  });

  it('summarises lint in test-run reports', async () => {
    const run = (await api('POST', '/api/projects/lint/runs', { key: 'r1', users: [{ role: 'customer' }] })).body;
    const u = run.users[0];
    await mailer('lint+r1').sendMail({ from: '"Shop" <a@shop.example.org>', to: u.email, subject: 'Hello', text: 'Hello [object Object]' });
    await waitFor(async () => (await api('GET', '/api/projects/lint/messages?run=r1')).body.length > 0);
    const rep = (await api('GET', '/api/projects/lint/runs/r1/report')).body;
    expect(rep.lint).toMatchObject({ messages: 1, error: 1, byCheck: { 'leaked-value': 1 } });
    expect(rep.messages.items[0].lint).toBe('error');
    expect(rep.warnings.join(' ')).toContain('content errors');
  });

  // ------------------------------------------------------------------ webhook security

  const tpl = async (name: string, targetUrl: string, signing: unknown) => {
    const r = await api('POST', '/api/projects/lint/webhook-templates', {
      name,
      targetUrl,
      bodyTemplate: '{"id":"evt_{{uuid}}","type":"' + name + '","data":{"amount":{{faker.amount}}}}',
      signing,
    });
    expect(r.status).toBe(201);
    return r.body;
  };
  const check = async (name: string) => {
    const r = await api('POST', `/api/projects/lint/webhook-templates/${encodeURIComponent(name)}/security-check`, { gapMs: 0 });
    expect(r.status).toBe(200);
    return r.body;
  };
  const verdicts = (r: any) => Object.fromEntries(r.variants.map((v: any) => [v.id, v.verdict]));

  it('a correct handler passes every variant', async () => {
    await tpl('payment.pending', `${goodUrl}/stripe`, { preset: 'stripe', secret: SECRET });
    await tpl('payment.succeeded', `${goodUrl}/stripe`, { preset: 'stripe', secret: SECRET });
    await api('POST', '/api/projects/lint/webhook-sequences', { name: 'pay', steps: [{ template: 'payment.pending' }, { template: 'payment.succeeded', delayMs: 100 }] });
    const r = await check('payment.succeeded');
    expect(r.baselineFailed).toBe(false);
    expect(verdicts(r)).toEqual({
      baseline: 'pass',
      'bad-signature': 'pass',
      'wrong-secret': 'pass',
      'missing-signature': 'pass',
      'tampered-body': 'pass',
      'stale-10m': 'pass',
      'stale-1h': 'pass',
      'future-10m': 'pass',
      replay: 'info',
      'out-of-order': 'info',
      oversized: 'pass',
      'malformed-json': 'pass',
      'wrong-content-type': 'pass',
    });
    expect(r.summary).toMatchObject({ fail: 0, warn: 0, pass: 11, info: 2 });
    const replay = r.variants.find((v: any) => v.id === 'replay');
    expect(replay.note).toContain('answer differs'); // the app answered {"duplicate":true}
    expect(r.variants.find((v: any) => v.id === 'out-of-order').description).toContain('"payment.succeeded" before "payment.pending"');
    // Each variant links to its traffic-log entry
    const log = (await api('GET', `/api/logs/${r.variants.find((v: any) => v.id === 'bad-signature').logId}`)).body;
    expect(log).toMatchObject({ direction: 'outbound', resStatus: 400, resolved: { securityCheck: 'bad-signature', template: 'payment.succeeded' } });
    // Latest result is stored
    expect((await api('GET', '/api/projects/lint/webhook-templates/payment.succeeded/security-check')).body.id).toBe(r.id);
  });

  it('a handler that trusts everything fails the signature variants (and crashes on bad JSON)', async () => {
    await tpl('sloppy.event', `${sloppyUrl}/hook`, { preset: 'hmac', secret: HMAC_SECRET, timestampHeader: 'X-Timestamp' });
    const r = await mcp('webhook_security_check', { project: 'lint', template: 'sloppy.event' });
    const v = verdicts(r);
    expect(v).toMatchObject({
      baseline: 'pass',
      'bad-signature': 'fail',
      'wrong-secret': 'fail',
      'missing-signature': 'fail',
      'tampered-body': 'fail',
      'stale-10m': 'fail',
      'future-10m': 'fail',
      replay: 'info',
      'out-of-order': 'skipped',
      oversized: 'warn',
      'malformed-json': 'warn',
      'wrong-content-type': 'info',
    });
    expect(r.variants.find((x: any) => x.id === 'malformed-json').note).toContain('5xx');
    expect(r.summary.fail).toBe(7);
  });

  it('stops after a failed baseline, and skips signature variants for unsigned templates', async () => {
    await tpl('wrong.secret', `${goodUrl}/stripe`, { preset: 'stripe', secret: 'whsec_other' });
    const r = await check('wrong.secret');
    expect(r.baselineFailed).toBe(true);
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]).toMatchObject({ id: 'baseline', verdict: 'fail', status: 400 });

    await tpl('unsigned', `${sloppyUrl}/hook`, { preset: 'none' });
    const u = await check('unsigned');
    expect(verdicts(u)).toMatchObject({ baseline: 'pass', 'bad-signature': 'skipped', 'tampered-body': 'skipped', 'stale-10m': 'skipped' });
    expect(u.notes.join(' ')).toContain('unsigned');
    expect((await api('GET', '/api/projects/lint/webhook-templates/nope/security-check')).status).toBe(404);
  });
});

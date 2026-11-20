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
import { decodeJwt } from '../src/auth/jwt.js';
import { totp } from '../src/totp/totp.js';
import { formatOffset, parseOffset } from '../src/clock/clock.js';
import { renderRunReportHtml } from '../src/runs/report-html.js';

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

let running: RunningHub;
let base: string;
let dataDir: string;
let smtpPort: number;
let appServer: http.Server;
let appUrl: string;
const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const isForm = body instanceof URLSearchParams;
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isForm ? body.toString() : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const TW = '/mock/hyper/twilio';
const basic = { authorization: 'Basic ' + Buffer.from('AC' + 'a'.repeat(32) + ':token').toString('base64') };
const tw = (method: string, p: string, body?: Record<string, string>) => api(method, TW + p, body ? new URLSearchParams(body) : undefined, basic);
const setTime = (offsets: Record<string, unknown>, run?: string) => api('PUT', `/api/projects/hyper/time${run ? `?run=${run}` : ''}`, { offsets });
const clearTime = () => api('DELETE', '/api/projects/hyper/time');
const SECRET = 'JBSWY3DPEHPK3PXP';
const TP = { secret: SECRET, algorithm: 'SHA1' as const, digits: 6, period: 30 };

describe('clock offset parsing', () => {
  it('parses units, signs and limits', () => {
    expect(parseOffset('+2h')).toBe(7_200_000);
    expect(parseOffset('-90s')).toBe(-90_000);
    expect(parseOffset('1d')).toBe(86_400_000);
    expect(parseOffset('1h30m')).toBe(5_400_000);
    expect(parseOffset('5min')).toBe(300_000);
    expect(parseOffset(1500)).toBe(1500);
    expect(parseOffset(0)).toBe(0);
    expect(parseOffset(null)).toBe(0);
    expect(() => parseOffset('soon')).toThrow();
    expect(() => parseOffset('90')).toThrow();
    expect(() => parseOffset('11y')).toThrow();
    expect(formatOffset(7_200_000)).toBe('+2h');
    expect(formatOffset(-90_000)).toBe('-1m30s');
  });

  it('renders an escaped, self-contained page', () => {
    const html = renderRunReportHtml(
      {
        run: { id: 'r1', key: 'k1', label: '<b>lbl</b>', status: 'stopped', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:01:00.000Z', durationMs: 60_000, meta: { ci: 'x"y' } },
        users: [],
        messages: { total: 0, byChannel: {}, byStatus: {}, items: [] },
        lint: { messages: 0, error: 0, warn: 0, info: 0, byCheck: {}, items: [] },
        traffic: { total: 0, byOutcome: {}, problems: [] },
        rules: [],
        mocks: [],
        warnings: ['<img src=x onerror=alert(1)>'],
      },
      { project: { slug: 'p', name: 'P & Q' }, version: '1.0', generatedAt: '2026-01-01T00:02:00.000Z' },
    );
    expect(html).toContain('&lt;b&gt;lbl&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('P &amp; Q');
    expect(html).not.toMatch(/<script|<link|src="http/i);
    expect(html).toContain('prefers-color-scheme:dark');
  });
});

describe.skipIf(!haveMailpit)('HTML run reports and per-feature time offsets', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-report-time-test-'));
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
      callbackDelayMs: 150,
      timeoutHoldMs: 400,
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Hyper', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);
    expect((await api('POST', '/api/projects/hyper/providers', { preset: 'twilio', slug: 'twilio' })).status).toBe(201);
    expect((await api('POST', '/api/projects/hyper/auth', { preset: 'oidc' })).status).toBe(201);
  });

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('HTML report: users, messages, problems, escaped subject, content type and download header; frozen after stop', async () => {
    const started = await api('POST', '/api/projects/hyper/runs', { key: 'rep', label: 'report run', users: [{ role: 'customer' }] });
    expect(started.status).toBe(201);
    const u = started.body.users[0];
    const mail = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'hyper+rep', pass: 'x' } });
    await mail.sendMail({ from: 'app@hyper.test', to: u.email, subject: '<script>alert("x")</script> Your code', text: 'Your code is 482913' });
    await waitFor(async () => (await api('GET', '/api/projects/hyper/runs/rep/report')).body.messages.total >= 1);
    // A problem request inside the run (no mock matches).
    expect((await api('POST', '/run/rep/mock/hyper/api/nothing-here', {})).status).toBeGreaterThanOrEqual(400);
    await waitFor(async () => (await api('GET', '/api/projects/hyper/runs/rep/report')).body.traffic.problems.length >= 1);

    const r = await api('GET', '/api/projects/hyper/runs/rep/report.html');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-disposition')).toBeNull();
    const html = r.text;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Run <code>rep</code>');
    expect(html).toContain(u.email);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Your code');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('482913');
    expect(html).toContain('id="traffic"');
    expect(html).toContain('/run/rep/mock/hyper/api/nothing-here');

    const alias = await api('GET', '/api/projects/hyper/runs/rep/report?format=html');
    expect(alias.headers.get('content-type')).toMatch(/^text\/html/);
    expect((await api('GET', '/api/projects/hyper/runs/rep/report?format=xml')).status).toBe(400);
    expect((await api('GET', '/api/projects/hyper/runs/rep/report')).body.run.key).toBe('rep'); // JSON unchanged
    const dl = await api('GET', '/api/projects/hyper/runs/rep/report.html?download=1');
    expect(dl.headers.get('content-disposition')).toBe('attachment; filename="stubyard-run-rep.html"');

    const stop = await api('POST', '/api/projects/hyper/runs/rep/stop');
    expect(stop.body.reportHtmlUrl).toBe(`/api/projects/hyper/runs/${started.body.id}/report.html`);
    const frozen = await api('GET', stop.body.reportHtmlUrl);
    expect(frozen.status).toBe(200);
    expect(frozen.text).toContain('>stopped<');
    expect(frozen.text).toContain(u.email);
    expect((await api('GET', '/api/projects/hyper/runs/nope/report.html')).status).toBe(404);
  });

  it('offsets: PUT merges, GET shows effective times, DELETE clears; bad input is 400', async () => {
    const put = await setTime({ auth: '+2h', totp: '-30s' });
    expect(put.status).toBe(200);
    expect(put.body.offsets).toEqual({ auth: 7_200_000, totp: -30_000 });
    expect(put.body.active).toEqual({ auth: '+2h', totp: '-30s' });
    const g = (await api('GET', '/api/projects/hyper/time')).body;
    expect(Date.parse(g.effective.auth) - Date.parse(g.serverTime)).toBe(7_200_000);
    expect(g.effective.verify).toBe(g.serverTime);
    expect((await setTime({ totp: 0 })).body.offsets).toEqual({ auth: 7_200_000 });
    expect((await api('PUT', '/api/projects/hyper/time', { feature: 'verify', offset: '5m' })).body.offsets).toEqual({ auth: 7_200_000, verify: 300_000 });
    expect((await setTime({ auth: 'later' })).status).toBe(400);
    expect((await setTime({ clock: '+1h' })).status).toBe(400);
    expect((await setTime({ auth: '+11y' })).status).toBe(400);
    expect((await api('PUT', '/api/projects/hyper/time', {})).status).toBe(400);
    // Kept by a project reset? (not cleared by settings PATCH of other fields)
    await api('PATCH', '/api/projects/hyper', { settings: { emailDomain: 'hyper.test' } });
    expect((await api('GET', '/api/projects/hyper/time')).body.offsets.auth).toBe(7_200_000);
    const del = await clearTime();
    expect(del.body.offsets).toEqual({});
    expect((await api('GET', '/api/projects/hyper')).body.settings?.timeOffsets ?? (await api('GET', '/api/projects/hyper')).body.project?.settings?.timeOffsets).toBeUndefined();
  });

  it('totp: codes follow the offset; serverTime stays real', async () => {
    const a = await api('POST', '/api/projects/hyper/authenticators', { label: 'Admin 2FA', secret: SECRET });
    expect(a.status).toBe(201);
    await setTime({ totp: '+1h' });
    const before = Date.now();
    const c = (await api('GET', '/api/projects/hyper/authenticators/code?label=Admin%202FA')).body;
    const after = Date.now();
    const expected = [totp(TP, before + 3_600_000).code, totp(TP, after + 3_600_000).code];
    expect(expected).toContain(c.code);
    expect(c.offsetMs).toBe(3_600_000);
    const list = (await api('GET', '/api/projects/hyper/authenticators')).body;
    expect(Math.abs(list.serverTime - Date.now())).toBeLessThan(5000);
    expect(list.offsetMs).toBe(3_600_000);
    expect([totp(TP, list.serverTime + 3_600_000).code, totp(TP, Date.now() + 3_600_000).code]).toContain(list.items[0].current.code);
    await clearTime();
  });

  it('auth: -2h mints an already-expired id_token; +2h expires a code issued before', async () => {
    await setTime({ auth: '-2h' });
    const t = (await api('POST', '/api/projects/hyper/auth/oidc/token', { user: 'admin' })).body;
    const claims = decodeJwt(t.id_token)!.payload as { iat: number; exp: number };
    expect(claims.exp).toBeLessThan(Date.now() / 1000);
    expect(Math.abs(claims.iat - (Date.now() / 1000 - 7200))).toBeLessThan(10);
    await clearTime();

    const REDIRECT = 'http://localhost:3000/callback';
    const code = (await api('POST', '/api/projects/hyper/auth/oidc/code', { user: 'admin', redirectUri: REDIRECT, clientId: 'app' })).body;
    expect(code.code).toBeTruthy();
    await setTime({ auth: '+2h' });
    const provider = (await api('GET', '/api/projects/hyper/auth')).body.find((p: any) => p.slug === 'oidc');
    const tokenUrl = new URL(provider.urls.backend.token);
    const ex = await api('POST', tokenUrl.pathname, new URLSearchParams({ grant_type: 'authorization_code', code: code.code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 'secret' }));
    expect(ex.status).toBe(400);
    expect(ex.body.error).toBe('invalid_grant');
    expect(String(ex.body.error_description)).toMatch(/expired/);
    await clearTime();
  });

  it('verify: a pending Twilio Verify code looks expired at check time with +11m', async () => {
    const svc = await tw('POST', '/v2/Services', { FriendlyName: 'Hyper' });
    expect(svc.status).toBe(201);
    const admin = (await api('GET', '/api/projects/hyper/users/admin')).body;
    const v = await tw('POST', `/v2/Services/${svc.body.sid}/Verifications`, { To: admin.phone, Channel: 'sms' });
    expect(v.status).toBe(201);
    const m = await waitFor(async () => (await api('GET', `/api/projects/hyper/messages?user=admin&channel=sms&limit=1`)).body[0]);
    await setTime({ verify: '+11m' });
    const check = await tw('POST', `/v2/Services/${svc.body.sid}/VerificationCheck`, { VerificationSid: v.body.sid, Code: m.otp });
    expect(check.body.status).not.toBe('approved');
    expect(check.status).toBe(404);
    await clearTime();
    // Without the offset a fresh code is approved.
    const v2 = await tw('POST', `/v2/Services/${svc.body.sid}/Verifications`, { To: admin.phone, Channel: 'sms' });
    const m2 = await waitFor(async () => {
      const x = (await api('GET', `/api/projects/hyper/messages?user=admin&channel=sms&limit=1`)).body[0];
      return x && x.id !== m.id ? x : null;
    });
    expect((await tw('POST', `/v2/Services/${svc.body.sid}/VerificationCheck`, { VerificationSid: v2.body.sid, Code: m2.otp })).body.status).toBe('approved');
  });

  it('webhooks: the signed timestamp is shifted', async () => {
    const t = await api('POST', '/api/projects/hyper/webhook-templates', {
      name: 'payment_intent.succeeded',
      targetUrl: `${appUrl}/stripe`,
      bodyTemplate: '{"type":"payment_intent.succeeded"}',
      signing: { preset: 'stripe', secret: 'whsec_test' },
    });
    expect(t.status).toBe(201);
    await setTime({ webhooks: '-10m' });
    const r = await api('POST', `/api/projects/hyper/webhook-templates/${t.body.id}/send`, {});
    expect(r.body.ok).toBe(true);
    const got = received.filter((x) => x.path === '/stripe').at(-1)!;
    const ts = Number(/^t=(\d+),/.exec(String(got.headers['stripe-signature']))![1]);
    expect(Math.abs(ts - (Date.now() / 1000 - 600))).toBeLessThan(10);
    await clearTime();
  });

  it('run override beats the project offset, does not leak, ends with the run; report warns', async () => {
    await setTime({ totp: '+1h' });
    const run = await api('POST', '/api/projects/hyper/runs', { key: 'tt' });
    expect(run.status).toBe(201);
    const o = await setTime({ totp: '-1h', auth: '+5m' }, 'tt');
    expect(o.status).toBe(200);
    expect(o.body.run).toMatchObject({ key: 'tt', offsets: { totp: -3_600_000, auth: 300_000 } });
    expect(o.body.offsets).toEqual({ totp: 3_600_000 }); // project unchanged
    expect(o.body.effectiveOffsets).toMatchObject({ totp: -3_600_000, auth: 300_000 });

    const scoped = (await api('GET', '/api/projects/hyper/authenticators/code?label=Admin%202FA&run=tt')).body;
    expect(scoped.offsetMs).toBe(-3_600_000);
    const plain = (await api('GET', '/api/projects/hyper/authenticators/code?label=Admin%202FA')).body;
    expect(plain.offsetMs).toBe(3_600_000);
    expect((await api('GET', '/api/projects/hyper/time')).body.effectiveOffsets.auth).toBe(0);

    const report = (await api('GET', '/api/projects/hyper/runs/tt/report')).body;
    expect(report.warnings.some((w: string) => w.startsWith('Clock offsets active:') && w.includes('auth +5m') && w.includes('totp -1h'))).toBe(true);
    await api('POST', '/api/projects/hyper/runs/tt/stop');
    const after = (await api('GET', '/api/projects/hyper/time?run=tt')).body;
    expect(after.run.offsets).toEqual({});
    expect(after.effectiveOffsets.totp).toBe(3_600_000);
    expect((await setTime({ totp: 0 }, 'tt')).status).toBe(409);
    expect((await setTime({ totp: 0 }, 'zz')).status).toBe(404);
    await clearTime();
  });

  it('MCP: set_time_offset and get_time_offsets', async () => {
    const call = async (name: string, args: Record<string, unknown>) =>
      (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools;
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['set_time_offset', 'get_time_offsets']));
    expect(tools.find((t: any) => t.name === 'get_time_offsets').annotations.readOnlyHint).toBe(true);
    const set = await call('set_time_offset', { project: 'hyper', feature: 'auth', offset: '+2h' });
    expect(set.isError).toBeFalsy();
    expect(set.structuredContent.offsets).toEqual({ auth: 7_200_000 });
    const got = await call('get_time_offsets', { project: 'hyper' });
    expect(got.structuredContent.active).toEqual({ auth: '+2h' });
    const bad = await call('set_time_offset', { project: 'hyper', feature: 'auth', offset: 'tomorrow' });
    expect(bad.isError).toBe(true);
    await call('set_time_offset', { project: 'hyper', feature: 'auth', offset: 0 });
    expect((await call('get_time_offsets', { project: 'hyper' })).structuredContent.offsets).toEqual({});
  });
});

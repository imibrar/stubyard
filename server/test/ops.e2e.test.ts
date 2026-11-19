/** Phase 5.5b: outbound allowlist + insecure TLS, DEVHUB_SEED, /api/agent-guide, doctor, new MCP tools. */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_OUTBOUND_ALLOW, loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { seedProjects } from '../src/maintenance/seed.js';
import { checkOutboundUrl, configureOutbound } from '../src/traffic/outbound.js';

const MAILPIT_BIN = process.env.DEVHUB_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
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

describe('outbound allowlist', () => {
  const allowed = [
    'http://localhost:3000/x',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://host.docker.internal:3000/cb',
    'http://app:8080/hook',
    'https://myapp.test/cb',
    'http://printer.local',
    'http://svc.internal',
    'http://10.1.2.3',
    'http://172.20.0.5:80',
    'http://192.168.1.10',
  ];
  it.each(allowed)('allows %s', async (u) => {
    expect((await checkOutboundUrl(u, DEFAULT_OUTBOUND_ALLOW)).allowed).toBe(true);
  });
  it.each(['http://8.8.8.8/x', 'http://172.32.0.1', 'http://11.0.0.1', 'ftp://localhost/x', 'not a url'])('blocks %s', async (u) => {
    const r = await checkOutboundUrl(u, DEFAULT_OUTBOUND_ALLOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('"*" disables the check, extra entries extend it', async () => {
    expect((await checkOutboundUrl('http://8.8.8.8', ['*'])).allowed).toBe(true);
    expect((await checkOutboundUrl('http://8.8.8.8', [...DEFAULT_OUTBOUND_ALLOW, '8.8.8.0/24'])).allowed).toBe(true);
    expect((await checkOutboundUrl('https://staging.example.com', [...DEFAULT_OUTBOUND_ALLOW, '*.example.com'])).allowed).toBe(true);
  });
});

describe.skipIf(!haveMailpit)('ops end-to-end', () => {
  let running: RunningHub;
  let dataDir: string;
  let base: string;
  let httpPort: number;
  let httpsPort: number;
  let appServer: http.Server;
  let appUrl: string;
  const received: string[] = [];

  async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T; text: string; headers: Headers }> {
    const r = await fetch(base + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T, text, headers: r.headers };
  }

  /** GET with a chosen Host header (fetch does not allow setting it). */
  function getWithHost(p: string, host: string): Promise<{ status: number; text: string; type: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: httpPort, path: p, headers: { host } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t, type: String(res.headers['content-type']) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  const mcp = async (method: string, params: unknown = {}) => (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params })).body.result;
  const tool = async (name: string, args: unknown) => {
    const r = await mcp('tools/call', { name, arguments: args });
    return { ...r, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-ops-test-'));
    const seedDir = path.join(dataDir, 'seed');
    fs.mkdirSync(seedDir);
    const seedFile = {
      format: 'devhub-project',
      version: 1,
      project: { slug: 'seeded', name: 'Seeded', description: 'from DEVHUB_SEED', settings: {} },
      users: [{ id: 'u1', name: 'Admin', role: 'admin', email: 'admin@seeded.test', phone: '+15550000001' }],
    };
    fs.writeFileSync(path.join(seedDir, 'a.json'), JSON.stringify(seedFile));
    fs.writeFileSync(path.join(seedDir, 'broken.json'), '{nope');
    const ports = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    [httpPort, httpsPort] = ports;
    running = await startHub(
      loadConfig({
        host: '127.0.0.1',
        httpPort,
        httpsPort,
        smtpPort: ports[2],
        dataDir,
        webDir: path.join(dataDir, 'no-web'),
        mailpitBin: MAILPIT_BIN,
        mailpitUrl: `http://127.0.0.1:${ports[3]}`,
        mailpitSmtpHost: '127.0.0.1',
        mailpitSmtpPort: ports[4],
        spawnMailpit: true,
        logLevel: 'silent',
        callbackDelayMs: 100,
        seedPath: seedDir,
        outboundAllow: DEFAULT_OUTBOUND_ALLOW,
        outboundInsecureTls: [],
      }),
      { logger: pino({ level: 'silent' }) },
    );
    base = `http://127.0.0.1:${httpPort}`;
    appServer = http.createServer((req, res) => {
      received.push(req.url ?? '');
      res.writeHead(req.method === 'HEAD' ? 405 : 200).end('ok');
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Ops', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);
  });

  afterAll(async () => {
    configureOutbound({ allow: DEFAULT_OUTBOUND_ALLOW, insecureTls: [] });
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('DEVHUB_SEED imports missing projects at boot and skips existing ones', async () => {
    expect(running.seed?.find((r) => r.slug === 'seeded')?.status).toBe('created');
    expect(running.seed?.find((r) => r.file.endsWith('broken.json'))?.status).toBe('failed');
    const users = (await api('GET', '/api/projects/seeded/users')).body;
    expect(users.map((u: any) => u.email)).toContain('admin@seeded.test');
    const again = seedProjects(running.hub, path.join(dataDir, 'seed'));
    expect(again.find((r) => r.slug === 'seeded')?.status).toBe('skipped');
  });

  it('refuses to call hosts outside the allowlist and logs blocked_by_allowlist', async () => {
    const t = await api('POST', '/api/projects/ops/webhook-templates', { name: 'prod', targetUrl: 'http://8.8.8.8/webhook', body: '{}' });
    expect(t.status).toBe(201);
    const r = await api('POST', '/api/projects/ops/webhook-templates/prod/send', {});
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/^blocked_by_allowlist/);
    const log = (await api('GET', `/api/logs/${r.body.logId}`)).body;
    expect(log.errorType).toBe('blocked_by_allowlist');
    expect(log.errorMessage).toMatch(/DEVHUB_OUTBOUND_ALLOW/);
  });

  it('calls self-signed HTTPS only when insecure TLS is enabled for the host', async () => {
    // devhub's own HTTPS port: its certificate comes from devhub's CA, which plain Node does not trust.
    const t = await api('POST', '/api/projects/ops/webhook-templates', { name: 'tls', targetUrl: `https://localhost:${httpsPort}/hook/ops/anything`, body: '{}' });
    expect(t.status).toBe(201);
    const strict = (await api('POST', '/api/projects/ops/webhook-templates/tls/send', {})).body;
    expect(strict.status).toBeNull();
    expect((await api('GET', `/api/logs/${strict.logId}`)).body.errorMessage).toMatch(/DEVHUB_OUTBOUND_INSECURE_TLS/);
    configureOutbound({ insecureTls: ['localhost'] });
    try {
      const loose = (await api('POST', '/api/projects/ops/webhook-templates/tls/send', {})).body;
      expect(loose.status).toBe(404); // reached devhub: no such webhook endpoint
    } finally {
      configureOutbound({ insecureTls: [] });
    }
  });

  it('serves the agent guide with the caller’s host and ports', async () => {
    const plain = await getWithHost('/api/agent-guide', `localhost:${httpPort}`);
    expect(plain.status).toBe(200);
    expect(plain.type).toContain('text/markdown');
    expect(plain.text).toContain(`http://localhost:${httpPort}/api/projects`);
    // Tunnel: 14000 → devhub. HTTPS and SMTP shift by the same offset unless given explicitly.
    const off = 14000 - httpPort;
    const tunnel = await getWithHost('/api/agent-guide', 'localhost:14000');
    expect(tunnel.text).toContain('http://localhost:14000/api/projects');
    expect(tunnel.text).toContain(`https://localhost:${httpsPort + off}`);
    expect(tunnel.text).not.toMatch(/localhost:4000\b/);
    const explicit = await getWithHost('/api/agent-guide?https_port=14443&smtp_port=11025', 'localhost:14000');
    expect(explicit.text).toContain('https://localhost:14443');
    expect(explicit.text).toContain('`11025`');
    const raw = await getWithHost('/api/agent-guide?raw=1', 'localhost:14000');
    expect(raw.text).toContain('http://localhost:4000/api');
  });

  it('doctor probes configured URLs and explains failures', async () => {
    const closed = await freePort();
    await api('POST', '/api/projects/ops/providers', { preset: 'twilio', slug: 'tw', config: { statusCallbackUrl: `${appUrl}/sms/status` } });
    await api('POST', '/api/projects/ops/providers', { preset: 'vonage', slug: 'vg', config: { statusCallbackUrl: `http://127.0.0.1:${closed}/dlr` } });
    const r = await api('GET', '/api/projects/ops/doctor');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.ok).toBe(false);
    const byUrl = (u: string) => d.checks.find((c: any) => c.url === u);
    expect(['ok', 'warn']).toContain(byUrl(`${appUrl}/sms/status`).status);
    expect(byUrl(`${appUrl}/sms/status`).steps.map((s: any) => s.step)).toEqual(['allowlist', 'dns', 'tcp', 'http']);
    const refused = byUrl(`http://127.0.0.1:${closed}/dlr`);
    expect(refused.status).toBe('fail');
    expect(refused.hint).toMatch(/ECONNREFUSED/);
    const blocked = byUrl('http://8.8.8.8/webhook');
    expect(blocked.status).toBe('fail');
    expect(blocked.message).toMatch(/allowlist/);
    expect(d.checks.find((c: any) => c.kind === 'mailpit').status).toBe('ok');
    expect(d.checks.find((c: any) => c.kind === 'tls').status).toBe('ok');
  });

  it('MCP: new tools are listed and work', async () => {
    const names = (await mcp('tools/list')).tools.map((t: any) => t.name);
    for (const n of ['doctor', 'list_webhooks', 'send_webhook', 'run_webhook_sequence', 'list_api_mocks', 'set_mock_scenario', 'list_providers', 'set_provider_config', 'create_project', 'generate_users', 'export_project', 'wait_for_message']) {
      expect(names).toContain(n);
    }
    const created = await tool('create_project', { name: 'Agent Made', roles: [{ role: 'sales', count: 2 }] });
    expect(created.isError).toBeFalsy();
    expect(created.json.project.slug).toBe('agent-made');
    expect(created.json.users.filter((u: any) => u.role === 'sales')).toHaveLength(2);

    const providers = (await tool('list_providers', { project: 'ops' })).json.providers;
    const tw = providers.find((p: any) => p.slug === 'tw');
    expect(tw.urls.https).toBe(`https://localhost:${httpsPort}/mock/ops/tw`);
    expect(providers.find((p: any) => p.preset === 'smtp').urls.smtpUsername).toBe('ops.mail');

    const set = await tool('set_provider_config', { project: 'ops', instance: 'vg', config: { statusCallbackUrl: `${appUrl}/vonage` } });
    expect(set.json.config.statusCallbackUrl).toBe(`${appUrl}/vonage`);

    await api('POST', '/api/projects/ops/webhook-endpoints', { path: 'payments', method: 'POST' });
    await api('POST', '/hook/ops/payments', { id: 1 });
    const hooks = (await tool('list_webhooks', { project: 'ops', hits: 3 })).json;
    expect(hooks.endpoints[0].url).toBe('/hook/ops/payments');
    expect(hooks.endpoints[0].recentHits.length).toBeGreaterThan(0);
    expect(hooks.templates.map((t: any) => t.name)).toContain('prod');

    await api('POST', '/api/projects/ops/webhook-templates', { name: 'ok', targetUrl: `${appUrl}/wh`, body: '{"a":1}' });
    const sent = await tool('send_webhook', { project: 'ops', template: 'ok' });
    expect(sent.json.ok).toBe(true);
    expect(received).toContain('/wh');

    const doc = await tool('doctor', { project: 'ops' });
    expect(doc.json.checks.length).toBeGreaterThan(2);
    const exp = await tool('export_project', { project: 'agent-made' });
    expect(exp.json.format).toBe('devhub-project');
    const missing = await tool('set_mock_scenario', { project: 'ops', mock: 'nope', scenario: 'x' });
    expect(missing.isError).toBe(true);
  });
});

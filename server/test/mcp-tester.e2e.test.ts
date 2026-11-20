import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { pino } from 'pino';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHub } from '../src/index.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { runMcpChecks, schemaProblems } from '../src/mcptester/checks.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A well-behaved MCP server built with the official SDK (tools, image result, resource, template, prompt, logging, progress). */
function buildGoodServer(): McpServer {
  const server = new McpServer({ name: 'good-server', version: '1.2.3' }, { capabilities: { logging: {} }, instructions: 'Use add for sums.' });
  server.registerTool(
    'add',
    {
      title: 'Add numbers',
      description: 'Adds two numbers and returns the sum.',
      inputSchema: { a: z.number().describe('First number'), b: z.number().describe('Second number') },
      outputSchema: { sum: z.number() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ a, b }, extra) => {
      const token = extra._meta?.progressToken;
      if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 1 } });
      await server.server.sendLoggingMessage({ level: 'info', data: `adding ${a}+${b}` }, extra.sessionId);
      return { content: [{ type: 'text', text: JSON.stringify({ sum: a + b }) }], structuredContent: { sum: a + b } };
    },
  );
  server.registerTool('pixel', { description: 'Returns a 1x1 PNG image.', inputSchema: {} }, async () => ({ content: [{ type: 'image', data: PNG_1PX, mimeType: 'image/png' }] }));
  server.registerTool('fail_softly', { description: 'Always fails with isError.', inputSchema: { reason: z.string().describe('Why') } }, async ({ reason }) => ({ content: [{ type: 'text', text: `failed: ${reason}` }], isError: true }));
  server.registerResource('readme', 'docs://readme', { title: 'Readme', mimeType: 'text/markdown', description: 'Project readme' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Hello' }] }));
  server.registerResource('user', new ResourceTemplate('users://{id}/profile', { list: undefined }), { title: 'User profile', mimeType: 'application/json' }, async (uri, { id }) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id }) }],
  }));
  server.registerPrompt('greet', { title: 'Greeting', description: 'Greets someone', argsSchema: { name: z.string().describe('Name') } }, ({ name }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${name}` } }],
  }));
  return server;
}

/** Stateful Streamable HTTP server (sessions), records the Mcp-Session-Id headers it receives; /expire drops all sessions. */
function goodStreamableApp() {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const seenSessionHeaders: string[] = [];
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/expire') {
      for (const t of transports.values()) await t.close();
      transports.clear();
      return res.writeHead(200).end('ok');
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid) seenSessionHeaders.push(sid);
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      if (sid) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      if (req.method !== 'POST' || !isInitializeRequest(body)) return res.writeHead(400).end('{"error":"no session"}');
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, t) });
      t.onclose = () => t.sessionId && transports.delete(t.sessionId);
      await buildGoodServer().connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, body);
  });
  return { srv, seenSessionHeaders, transports };
}

/** Legacy HTTP+SSE server (2024-11-05 transport): GET /sse + POST /messages?sessionId=… */
function legacySseApp() {
  const transports = new Map<string, SSEServerTransport>();
  return http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/sse') {
      const t = new SSEServerTransport('/messages', res);
      transports.set(t.sessionId, t);
      res.on('close', () => transports.delete(t.sessionId));
      await buildGoodServer().connect(t);
      return;
    }
    if (req.method === 'POST' && u.pathname === '/messages') {
      const t = transports.get(u.searchParams.get('sessionId') ?? '');
      if (!t) return res.writeHead(404).end('unknown session');
      return t.handlePostMessage(req, res);
    }
    // Streamable HTTP POST attempts get 405 so "auto" falls back to SSE.
    res.writeHead(405).end();
  });
}

/**
 * A hand-written server that breaks the rules on purpose (the SDK would refuse to send most of this):
 * SSE responses with a priming event, bad tool name, missing description, broken schema, required typo,
 * outputSchema without structuredContent, a tool that throws (JSON-RPC error), accepts unknown tools,
 * contradicting annotations, listChanged notification without the capability. Requires a Bearer token.
 */
function badApp() {
  const seenAuth: string[] = [];
  const tools = [
    { name: 'get weather!', description: 'Weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
    { name: 'no_description', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Query' } } } },
    { name: 'broken_schema', description: 'Schema is wrong', inputSchema: { type: 'string', properties: { x: { type: 'strng' } } } },
    { name: 'required_typo', description: 'Required lists a missing property', inputSchema: { type: 'object', properties: { email: { type: 'string', description: 'E-mail' } }, required: ['emial'] } },
    { name: 'stats', description: 'Returns stats', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
    { name: 'explode', description: 'Throws', inputSchema: { type: 'object' } },
    { name: 'wipe', description: 'Deletes everything', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: 'wipe', description: 'Duplicate', inputSchema: { type: 'object' } },
  ];
  const answer = (msg: any) => {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bad-server' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools });
      case 'tools/call':
        if (msg.params.name === 'stats') return ok({ content: [{ type: 'text', text: 'count is 3' }] });
        if (msg.params.name === 'explode') return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'TypeError: x is undefined' } };
        return ok({ content: [{ type: 'text', text: `called ${msg.params.name}` }] });
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
  const srv = http.createServer(async (req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== 'Bearer s3cret-token-1234') return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    if (req.method === 'GET') return res.writeHead(405).end();
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (msg.id === undefined) return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'bad-session-1' });
    res.write('id: 1\ndata: \n\n'); // priming event
    if (msg.method === 'tools/list') res.write(`id: 2\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
    res.end(`id: 3\ndata: ${JSON.stringify(answer(msg))}\n\n`);
  });
  return { srv, seenAuth };
}

const listen = async (s: http.Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
};

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

describe('MCP tester (e2e)', () => {
  let hub: Hub;
  let close: () => Promise<void>;
  let base: string;
  let dataDir: string;
  const good = goodStreamableApp();
  const legacy = legacySseApp();
  const bad = badApp();
  let goodUrl: string;
  let legacyUrl: string;
  let badUrl: string;

  async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T };
  }
  const mt = (p: string) => `/api/projects/mcp/mcp-tester${p}`;
  const mcpTool = async (name: string, args: Record<string, unknown>) => {
    const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
    return JSON.parse(r.body.result.content[0].text);
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-mcpt-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await hub.mcpTester.closeAll();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    goodUrl = `${await listen(good.srv)}/mcp`;
    legacyUrl = `${await listen(legacy)}/sse`;
    badUrl = `${await listen(bad.srv)}/mcp`;
    expect((await api('POST', '/api/projects', { name: 'MCP', slug: 'mcp' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    for (const s of [good.srv, legacy, bad.srv]) {
      s.closeAllConnections();
      s.close();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let goodTarget: any;
  let goodSession: string;

  it('saves a target and masks header values in list responses', async () => {
    const r = await api('POST', mt('/targets'), { name: 'good', url: goodUrl, headers: { Authorization: 'Bearer abcdefgh12345678', 'X-Env': 'dev' } });
    expect(r.status).toBe(201);
    goodTarget = r.body;
    expect(goodTarget.headers.Authorization).toBe('Bearer ••••5678');
    expect(goodTarget.headers['X-Env']).toBe('••••••••');
    expect(JSON.stringify((await api('GET', mt(''))).body)).not.toContain('abcdefgh12345678');
    // Sending the masked value back keeps the stored secret.
    await api('PATCH', mt(`/targets/${goodTarget.id}`), { headers: { ...goodTarget.headers, 'X-New': 'v' } });
    expect(hub.mcpTester.repo.requireTarget(hub.projects.require('mcp').id, goodTarget.id).headers).toEqual({ Authorization: 'Bearer abcdefgh12345678', 'X-Env': 'dev', 'X-New': 'v' });
    expect((await api('POST', mt('/targets'), { name: 'x', url: 'stdio://foo' })).status).toBe(400);
  });

  it('connects over Streamable HTTP: server info, capabilities, instructions, session header, clean checks', async () => {
    const r = await api('POST', mt(`/targets/${goodTarget.id}/connect`), {});
    expect(r.status).toBe(200);
    const s = r.body.session;
    goodSession = s.id;
    expect(s.transport).toBe('streamable');
    expect(s.protocolVersion).toBe('2025-11-25');
    expect(s.serverInfo).toMatchObject({ name: 'good-server', version: '1.2.3' });
    expect(s.instructions).toBe('Use add for sums.');
    expect(s.capabilities).toHaveProperty('tools');
    expect(s.capabilities).toHaveProperty('resources');
    expect(s.mcpSessionId).toMatch(/[0-9a-f-]{36}/);
    // Every request after initialize carried the session id.
    expect(good.seenSessionHeaders.length).toBeGreaterThan(2);
    expect(new Set(good.seenSessionHeaders)).toEqual(new Set([s.mcpSessionId]));
    const checks = r.body.checks;
    expect(checks.summary.error).toBe(0);
    expect(checks.summary.warn).toBe(0);
    expect(checks.stats.tools).toBe(3);
    expect(checks.stats.toolTokens).toBeGreaterThan(50);
  });

  it('lists tools, resources, templates and prompts', async () => {
    const tools = (await api('GET', mt(`/sessions/${goodSession}/tools`))).body.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(['add', 'fail_softly', 'pixel']);
    const add = tools.find((t: any) => t.name === 'add');
    expect(add.annotations).toMatchObject({ readOnlyHint: true });
    expect(add.outputSchema).toBeTruthy();
    expect((await api('GET', mt(`/sessions/${goodSession}/resources`))).body.resources[0]).toMatchObject({ uri: 'docs://readme', name: 'readme' });
    expect((await api('GET', mt(`/sessions/${goodSession}/resource-templates`))).body.resourceTemplates[0]).toMatchObject({ uriTemplate: 'users://{id}/profile' });
    expect((await api('GET', mt(`/sessions/${goodSession}/prompts`))).body.prompts[0]).toMatchObject({ name: 'greet' });
  });

  it('calls tools: structuredContent validated, progress and logging notifications, image, isError', async () => {
    const r = (await api('POST', mt(`/sessions/${goodSession}/call`), { name: 'add', arguments: { a: 2, b: 40 } })).body;
    expect(r.kind).toBe('result');
    expect(r.result.structuredContent).toEqual({ sum: 42 });
    expect(r.validation).toEqual({ hasOutputSchema: true, hasStructured: true, errors: [] });
    expect(r.progress).toHaveLength(1);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const img = (await api('POST', mt(`/sessions/${goodSession}/call`), { name: 'pixel', arguments: {} })).body;
    expect(img.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(img.contentProblems).toEqual([]);
    const soft = (await api('POST', mt(`/sessions/${goodSession}/call`), { name: 'fail_softly', arguments: { reason: 'nope' } })).body;
    expect(soft).toMatchObject({ kind: 'result', isError: true });
    const unknown = (await api('POST', mt(`/sessions/${goodSession}/call`), { name: 'nope', arguments: {} })).body;
    expect(['rpc_error', 'result']).toContain(unknown.kind);
    const log = (await api('GET', mt(`/sessions/${goodSession}/log`))).body;
    const methods = log.entries.map((e: any) => `${e.dir}:${e.kind}:${e.method ?? ''}`);
    expect(methods).toContain('out:request:initialize');
    expect(methods).toContain('in:response:initialize');
    expect(methods).toContain('out:notification:notifications/initialized');
    expect(methods).toContain('in:notification:notifications/progress');
    expect(methods).toContain('in:notification:notifications/message');
    const resp = log.entries.find((e: any) => e.kind === 'response' && e.method === 'tools/call');
    expect(resp.durationMs).toBeGreaterThanOrEqual(0);
    expect(resp.size).toBeGreaterThan(10);
    expect(log.serverLogs.some((l: any) => l.data === 'adding 2+40')).toBe(true);
    // Each POST is in devhub's traffic log too (outbound, purpose "MCP tester"), with the Authorization header masked.
    const traffic = await api('GET', '/api/logs?project=mcp&direction=outbound&limit=200');
    const entries = (traffic.body.items ?? traffic.body) as any[];
    expect(entries.some((e) => e.url === goodUrl)).toBe(true);
    const detail = (await api('GET', `/api/logs/${entries.find((e) => e.url === goodUrl).id}`)).body;
    expect(detail.resolved.purpose).toBe('MCP tester');
    expect(JSON.stringify(detail.reqHeaders)).not.toContain('abcdefgh12345678');
  });

  it('reads resources (static and template) and gets prompts', async () => {
    const r = (await api('POST', mt(`/sessions/${goodSession}/read`), { uri: 'docs://readme' })).body;
    expect(r.result.contents[0].text).toBe('# Hello');
    const t = (await api('POST', mt(`/sessions/${goodSession}/read`), { uri: 'users://7/profile' })).body;
    expect(JSON.parse(t.result.contents[0].text)).toEqual({ id: '7' });
    const p = (await api('POST', mt(`/sessions/${goodSession}/prompt`), { name: 'greet', arguments: { name: 'Ada' } })).body;
    expect(p.result.messages[0].content.text).toBe('Say hello to Ada');
    expect((await api('POST', mt(`/sessions/${goodSession}/ping`))).body.ok).toBe(true);
  });

  it('starts a new MCP session when the server ends it (HTTP 404 with Mcp-Session-Id)', async () => {
    const before = (await api('GET', mt(`/sessions/${goodSession}`))).body.mcpSessionId;
    await fetch(goodUrl.replace('/mcp', '/expire'));
    const r = (await api('POST', mt(`/sessions/${goodSession}/call`), { name: 'add', arguments: { a: 1, b: 1 } })).body;
    expect(r.result.structuredContent).toEqual({ sum: 2 });
    const after = (await api('GET', mt(`/sessions/${goodSession}`))).body;
    expect(after.mcpSessionId).not.toBe(before);
    expect(after.stats.sessionReinits).toBe(1);
  });

  it('saved calls: run-all gives a pass/fail table and stores the last result', async () => {
    const add = (body: unknown) => api('POST', mt(`/targets/${goodTarget.id}/saved`), body);
    expect((await add({ name: 'sum', tool: 'add', arguments: { a: 1, b: 2 }, expect: { contains: '3' } })).status).toBe(201);
    await add({ name: 'wrong expectation', tool: 'add', arguments: { a: 1, b: 2 }, expect: { contains: '999' } });
    await add({ name: 'error path', tool: 'fail_softly', arguments: { reason: 'x' }, expect: { isError: true, contains: 'failed: x' } });
    await add({ name: 'unexpected error', tool: 'fail_softly', arguments: { reason: 'y' } });
    const r = (await api('POST', mt(`/targets/${goodTarget.id}/run-saved`), {})).body;
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.results.map((x: any) => [x.name, x.pass])).toEqual([
      ['sum', true],
      ['wrong expectation', false],
      ['error path', true],
      ['unexpected error', false],
    ]);
    expect(r.results[1].failures[0]).toContain('does not contain "999"');
    expect(r.results[3].failures[0]).toContain('isError: true');
    const saved = (await api('GET', mt(`/targets/${goodTarget.id}/saved`))).body;
    expect(saved[0].lastResult.pass).toBe(true);
    // The same through devhub's MCP tool.
    const viaMcp = await mcpTool('mcp_tester_run_saved', { project: 'mcp', target: 'good' });
    expect(viaMcp).toMatchObject({ passed: 2, failed: 2 });
  });

  it('flags a bad server precisely (names, descriptions, schemas, structuredContent, JSON-RPC errors, list_changed) and sends custom headers', async () => {
    const c = await api('POST', mt('/connect'), { url: badUrl, headers: { Authorization: 'Bearer s3cret-token-1234' } });
    expect(c.status).toBe(200);
    const sid = c.body.session.id;
    expect(c.body.session.mcpSessionId).toBe('bad-session-1');
    // A tool with outputSchema that returns no structuredContent, and a tool that throws.
    const stats = (await api('POST', mt(`/sessions/${sid}/call`), { name: 'stats', arguments: {} })).body;
    expect(stats.validation).toMatchObject({ hasOutputSchema: true, hasStructured: false });
    const boom = (await api('POST', mt(`/sessions/${sid}/call`), { name: 'explode', arguments: {} })).body;
    expect(boom).toMatchObject({ kind: 'rpc_error', rpcError: { code: -32603 } });
    const rep = (await api('POST', mt(`/sessions/${sid}/checks`))).body;
    const by = (check: string, subject?: string) => rep.findings.filter((f: any) => f.check === check && (subject === undefined || f.subject === subject));
    expect(by('tool-name', 'get weather!')[0]).toMatchObject({ severity: 'warn' });
    expect(by('tool-name-duplicate', 'wipe')[0]).toMatchObject({ severity: 'error' });
    expect(by('tool-description', 'no_description')[0]).toMatchObject({ severity: 'warn' });
    expect(by('input-schema', 'broken_schema').length).toBeGreaterThanOrEqual(2);
    expect(by('schema-required', 'required_typo')[0].message).toContain('emial');
    expect(by('property-description', 'get weather!')[0]).toMatchObject({ severity: 'info' });
    expect(by('structured-content', 'stats')[0]).toMatchObject({ severity: 'error' });
    expect(by('error-handling', 'explode')[0]).toMatchObject({ severity: 'warn' });
    expect(by('error-handling').some((f: any) => f.message.includes('does not exist'))).toBe(true);
    expect(by('tool-annotations', 'wipe')[0]).toMatchObject({ severity: 'warn' });
    expect(by('server-info')[0].message).toContain('version');
    expect(by('list-changed')[0]).toMatchObject({ severity: 'warn' });
    // Not flagged: valid names / descriptions / schemas of the other tools.
    expect(by('tool-name', 'required_typo')).toEqual([]);
    expect(by('input-schema', 'required_typo')).toEqual([]);
    expect(rep.summary.error).toBeGreaterThanOrEqual(4);
    expect(new Set(bad.seenAuth)).toEqual(new Set(['Bearer s3cret-token-1234']));
    // Without the header: a clear connect error.
    const unauth = await api('POST', mt('/connect'), { url: badUrl });
    expect(unauth.status).toBe(502);
    expect(unauth.body.error).toContain('401');
  });

  it('supports the legacy HTTP+SSE transport (auto-detected)', async () => {
    const c = await api('POST', mt('/connect'), { url: legacyUrl });
    expect(c.status).toBe(200);
    expect(c.body.session.transport).toBe('sse');
    expect(c.body.session.serverInfo.name).toBe('good-server');
    const r = (await api('POST', mt(`/sessions/${c.body.session.id}/call`), { name: 'add', arguments: { a: 5, b: 6 } })).body;
    expect(r.result.structuredContent).toEqual({ sum: 11 });
    expect(c.body.checks.summary.error).toBe(0);
  });

  it("connects to devhub's own /mcp as a one-click target (and through the MCP tools)", async () => {
    const c = await api('POST', mt('/connect'), { self: true });
    expect(c.status).toBe(200);
    expect(c.body.session.serverInfo.name).toBe('devhub');
    expect(c.body.session.protocolVersion).toBe('2025-06-18');
    expect(c.body.checks.findings.filter((f: any) => f.severity === 'error')).toEqual([]);
    const tools = (await api('GET', mt(`/sessions/${c.body.session.id}/tools`))).body.tools.map((t: any) => t.name);
    expect(tools).toContain('mcp_tester_connect');
    const r = (await api('POST', mt(`/sessions/${c.body.session.id}/call`), { name: 'list_projects', arguments: {} })).body;
    expect(r.kind).toBe('result');
    expect(r.result.content[0].text).toContain('"mcp"');
    // Agent flow: connect + call through devhub's MCP tools, with a saved target.
    const viaMcp = await mcpTool('mcp_tester_connect', { project: 'mcp', self: true });
    expect(viaMcp.server.name).toBe('devhub');
    expect(viaMcp.tools.length).toBeGreaterThan(10);
    const call = await mcpTool('mcp_tester_call', { project: 'mcp', session: viaMcp.session, tool: 'list_projects', arguments: {} });
    expect(call.kind).toBe('result');
    const checks = await mcpTool('mcp_tester_checks', { project: 'mcp', target: 'good' });
    expect(checks.summary.error).toBe(0);
  });

  it('respects the outbound allowlist', async () => {
    const r = await api('POST', mt('/connect'), { url: 'https://mcp.example.com/mcp' });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('blocked_by_allowlist');
  });

  it('exports targets without header secrets and imports them again', async () => {
    const ex = (await api('GET', '/api/projects/mcp/export')).body;
    expect(ex.mcpTargets[0]).toMatchObject({ name: 'good', headers: { Authorization: '', 'X-Env': '', 'X-New': '' }, headersMasked: true });
    expect(ex.mcpSavedCalls).toHaveLength(4);
    expect(JSON.stringify(ex)).not.toContain('abcdefgh12345678');
    const withSecrets = (await api('GET', '/api/projects/mcp/export?secrets=1')).body;
    expect(withSecrets.mcpTargets[0].headers.Authorization).toBe('Bearer abcdefgh12345678');
    const im = await api('POST', '/api/projects/import', { json: ex, slug: 'mcp-copy', name: 'MCP copy' });
    expect(im.status).toBeLessThan(300);
    const copy = (await api('GET', '/api/projects/mcp-copy/mcp-tester')).body;
    expect(copy.targets[0]).toMatchObject({ name: 'good', savedCalls: 4 });
  });

  it('closes sessions on disconnect', async () => {
    expect((await api('DELETE', mt(`/sessions/${goodSession}`))).status).toBe(204);
    expect((await api('GET', mt(`/sessions/${goodSession}`))).status).toBe(404);
  });
});

describe('MCP checks (unit)', () => {
  it('schemaProblems accepts normal schemas and rejects broken ones', () => {
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'integer' } } }, required: ['a'] })).toEqual([]);
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'strng' } } })[0]).toContain('unknown type');
    expect(schemaProblems({ type: 'object', required: 'a' })[0]).toContain('required');
  });

  it('flags the token cost of a huge tool list and non-portable names only as info', () => {
    const tools = Array.from({ length: 30 }, (_, i) => ({ name: `tool.${i}`, description: 'x'.repeat(1500), inputSchema: { type: 'object' } }));
    const rep = runMcpChecks({ init: { serverInfo: { name: 'a', version: '1' }, capabilities: { tools: {} } }, protocolVersion: '2025-06-18', initMs: 10, ping: { ok: true, ms: 1 }, lists: { tools: { items: tools }, resources: undefined, resourceTemplates: undefined, prompts: undefined }, calls: [], notifications: {}, invalidMessages: 0 });
    expect(rep.findings.find((f) => f.check === 'tool-list-size')?.severity).toBe('warn');
    expect(rep.findings.filter((f) => f.check === 'tool-name').every((f) => f.severity === 'info')).toBe(true);
    expect(rep.stats.toolTokens).toBeGreaterThan(10_000);
  });

  it('protocol version: unknown is an error, 2024-11-05 is info', () => {
    const run = (v: string) => runMcpChecks({ init: { serverInfo: { name: 'a', version: '1' } }, protocolVersion: v, initMs: 1, ping: null, lists: { tools: undefined, resources: undefined, resourceTemplates: undefined, prompts: undefined }, calls: [], notifications: {}, invalidMessages: 0 }).findings;
    expect(run('2099-01-01')[0]).toMatchObject({ check: 'protocol-version', severity: 'error' });
    expect(run('2024-11-05')[0]).toMatchObject({ check: 'protocol-version', severity: 'info' });
    expect(run('2025-11-25')).toEqual([]);
  });
});

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { pino } from 'pino';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __setModelFactoryForTests } from '../src/chat/engine.js';
import { egressFetch, type ResolvedProvider } from '../src/chat/keys.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/** Chat v1 end to end with a scripted mock model (no network, no real keys). */

const STORED_KEY = 'sk-test-STOREDSECRET1234';
const ENV_KEY = 'sk-ant-ENVSECRET9999';
const LOCAL_KEY = 'sk-local-LOCALSECRET5678';

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
let calcServer: http.Server;
let calcUrl: string;
let modelsServer: http.Server;
let modelsUrl: string;
const modelsAuth: string[] = [];
const logLines: string[] = [];

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
  return JSON.parse(r.body.result.content[0].text);
};

// ------------------------------------------------------------------ scripted mock model
type Step = { text?: string; tools?: { name: string; input: Record<string, unknown> }[]; error?: string };
let script: (call: number, prompt: unknown[]) => Step = () => ({ text: 'ok' });
const calls: { prompt: unknown[]; tools: string[]; cfg: ResolvedProvider; modelId: string }[] = [];
const usage = { inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };

function mockModel(cfg: ResolvedProvider, modelId: string) {
  let n = 0;
  const record = (o: { prompt: unknown; tools?: { name: string }[] }) => {
    calls.push({ prompt: o.prompt as unknown[], tools: (o.tools ?? []).map((t) => t.name), cfg, modelId });
    return script(n++, o.prompt as unknown[]);
  };
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async (o) => {
      const s = record(o as never);
      if (s.error) throw new Error(s.error);
      const content = s.tools?.length
        ? s.tools.map((t, i) => ({ type: 'tool-call' as const, toolCallId: `c${calls.length}_${i}`, toolName: t.name, input: JSON.stringify(t.input) }))
        : [{ type: 'text' as const, text: s.text ?? '' }];
      return { content, finishReason: { unified: s.tools?.length ? ('tool-calls' as const) : ('stop' as const), raw: undefined }, usage, warnings: [] };
    },
    doStream: async (o) => {
      const s = record(o as never);
      if (s.error) throw new Error(s.error);
      const chunks: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (s.tools?.length) s.tools.forEach((t, i) => chunks.push({ type: 'tool-call', toolCallId: `c${calls.length}_${i}`, toolName: t.name, input: JSON.stringify(t.input) }));
      else {
        chunks.push({ type: 'text-start', id: 't1' });
        for (const w of (s.text ?? '').split(/(?<= )/)) chunks.push({ type: 'text-delta', id: 't1', delta: w });
        chunks.push({ type: 'text-end', id: 't1' });
      }
      chunks.push({ type: 'finish', finishReason: { unified: s.tools?.length ? 'tool-calls' : 'stop', raw: undefined }, usage });
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

/** POST …/stream and return the parsed UI message chunks. */
async function stream(conv: string, text: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/api/projects/chat/chat/conversations/${conv}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { id: `u${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }, ...extra }),
  });
  const raw = await r.text();
  const chunks = raw
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)) as Record<string, any>);
  return { status: r.status, headers: r.headers, raw, chunks };
}

const waitFor = async <T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

function buildCalc(): McpServer {
  const s = new McpServer({ name: 'calc', version: '1.0.0' });
  s.registerTool('add', { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  s.registerTool('boom', { description: 'Always fails', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'kaboom' }], isError: true }));
  return s;
}

describe('AI chat v1', () => {
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = ENV_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.STUBYARD_OPENAI_API_KEY;
    __setModelFactoryForTests(mockModel);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-chat-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'trace', maintenanceIntervalMs: 0 });
    const sink = new Writable({ write: (c, _e, cb) => (logLines.push(String(c)), cb()) });
    const logger = pino({ level: 'trace' }, sink);
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger });
    const { app } = await buildApp(hub, logger);
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await hub.mcpTester.closeAll();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;

    calcServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST') return void res.writeHead(405).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const srv = buildCalc();
      res.on('close', () => void srv.close());
      await srv.connect(t);
      await t.handleRequest(req, res, body);
    });
    await new Promise<void>((r) => calcServer.listen(0, '127.0.0.1', () => r()));
    calcUrl = `http://127.0.0.1:${(calcServer.address() as net.AddressInfo).port}/mcp`;

    modelsServer = http.createServer((req, res) => {
      modelsAuth.push(String(req.headers.authorization ?? ''));
      if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }] }));
      if (req.url === '/v1/redir/models') return void res.writeHead(302, { location: 'http://localhost:9/v1/models' }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => modelsServer.listen(0, '127.0.0.1', () => r()));
    modelsUrl = `http://127.0.0.1:${(modelsServer.address() as net.AddressInfo).port}/v1`;

    expect((await api('POST', '/api/projects', { name: 'Chat', slug: 'chat', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);
    expect((await api('POST', '/api/projects', { name: 'Other', slug: 'other', generateUsers: { customers: 1 } })).status).toBe(201);
  });

  afterAll(async () => {
    __setModelFactoryForTests(null);
    delete process.env.ANTHROPIC_API_KEY;
    calcServer?.close();
    modelsServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    script = () => ({ text: 'ok' });
  });

  it('AI providers: keys are write-only, env wins over stored, env rows are read-only', async () => {
    const c = await api('POST', '/api/system/ai-providers', { name: 'oa', kind: 'openai', apiKey: STORED_KEY });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'oa', kind: 'openai', hasKey: true, source: 'stored', keyHint: '••••1234' });
    expect(JSON.stringify(c.body)).not.toContain(STORED_KEY);

    // A stored Anthropic provider with its own key: ANTHROPIC_API_KEY (env) wins.
    const an = await api('POST', '/api/system/ai-providers', { name: 'claude', kind: 'anthropic', apiKey: 'sk-ant-stored-0000' });
    expect(an.body).toMatchObject({ source: 'env', envVar: 'ANTHROPIC_API_KEY', keyHint: '••••9999' });
    expect(hub.chat.providers.resolve(hub.chat.providers.require('claude')).apiKey).toBe(ENV_KEY);

    const list = await api('GET', '/api/system/ai-providers');
    const names = list.body.providers.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['oa', 'claude', 'env:anthropic']));
    expect(names).not.toContain('env:openai');
    const envRow = list.body.providers.find((p: { name: string }) => p.name === 'env:anthropic');
    expect(envRow).toMatchObject({ env: true, source: 'env', hasKey: true });
    expect(JSON.stringify(list.body)).not.toContain(STORED_KEY);
    expect(JSON.stringify(list.body)).not.toContain(ENV_KEY);
    expect((await api('PATCH', '/api/system/ai-providers/env:anthropic', { enabled: false })).status).toBe(400);
    expect((await api('DELETE', '/api/system/ai-providers/env:anthropic')).status).toBe(400);
    expect((await api('POST', '/api/system/ai-providers', { name: 'env:x', kind: 'openai' })).status).toBe(400);
    expect((await api('POST', '/api/system/ai-providers', { name: 'bad', kind: 'cohere' })).status).toBe(400);
    expect((await api('POST', '/api/system/ai-providers', { name: 'nourl', kind: 'openai-compatible', preset: 'custom' })).status).toBe(400);

    // PATCH without apiKey keeps it; apiKey '' clears it.
    expect((await api('PATCH', '/api/system/ai-providers/claude', { enabled: true })).status).toBe(200);
    const tmp = await api('POST', '/api/system/ai-providers', { name: 'tmp', kind: 'openai', apiKey: 'sk-tmp-abcd' });
    expect((await api('PATCH', `/api/system/ai-providers/${tmp.body.id}`, { name: 'tmp2' })).body).toMatchObject({ name: 'tmp2', hasKey: true });
    expect((await api('PATCH', `/api/system/ai-providers/${tmp.body.id}`, { apiKey: '' })).body).toMatchObject({ hasKey: false, keyHint: null });
    expect((await api('DELETE', `/api/system/ai-providers/${tmp.body.id}`)).body).toEqual({ deleted: true });
  });

  it('provider test call and model list (through the pinned egress fetch)', async () => {
    script = () => ({ text: 'OK' });
    const t = await api('POST', '/api/system/ai-providers/oa/test', { model: 'gpt-mock' });
    expect(t.body).toMatchObject({ ok: true, text: 'OK', model: 'gpt-mock' });
    expect(calls[0].cfg.apiKey).toBe(STORED_KEY);
    expect((await api('POST', '/api/system/ai-providers/oa/test', {})).status).toBe(400);

    const local = await api('POST', '/api/system/ai-providers', { name: 'local', kind: 'openai-compatible', preset: 'custom', baseUrl: modelsUrl, apiKey: LOCAL_KEY });
    expect(local.status).toBe(201);
    const m = await api('GET', '/api/system/ai-providers/local/models');
    expect(m.status).toBe(200);
    expect(m.body.models.map((x: { id: string }) => x.id)).toEqual(['alpha', 'zeta']);
    expect(modelsAuth.at(-1)).toBe(`Bearer ${LOCAL_KEY}`);
  });

  it('egressFetch refuses every host but the provider base URL host', async () => {
    const f = egressFetch({ name: 'oa', baseUrl: 'https://api.openai.com/v1' });
    await expect(f('https://evil.example/steal')).rejects.toThrow(/blocked .*evil\.example.*api\.openai\.com/);
    await expect(f('https://api.openai.com.evil.example/v1/x')).rejects.toThrow(/blocked/);
    const g = egressFetch({ name: 'local', baseUrl: modelsUrl });
    expect((await g(`${modelsUrl}/models`)).status).toBe(200);
  });

  it('streams a reply (UI message stream) and persists both messages with tokens', async () => {
    const a = await api('POST', '/api/projects/chat/chat/agents', { name: 'Helper', provider: 'oa', model: 'gpt-mock', instructions: 'Be brief.', tools: { builtin: false } });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ slug: 'helper', maxSteps: 10, providerOk: true });
    const conv = await api('POST', '/api/projects/chat/chat/conversations', { agent: 'helper' });
    expect(conv.status).toBe(201);
    script = () => ({ text: 'Hello there world' });
    const s = await stream(conv.body.id, 'Hi!');
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toContain('text/event-stream');
    expect(s.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const deltas = s.chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('');
    expect(deltas).toBe('Hello there world');
    expect(s.chunks.find((c) => c.type === 'start')?.messageId).toBeTruthy();
    expect(calls[0].modelId).toBe('gpt-mock');

    const got = await waitFor(async () => {
      const r = await api('GET', `/api/projects/chat/chat/conversations/${conv.body.id}`);
      return r.body.messages.length === 2 ? r.body : null;
    });
    expect(got.title).toBe('Hi!');
    expect(got.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Hi!' }] });
    const asst = got.messages[1];
    expect(asst).toMatchObject({ role: 'assistant', provider: 'oa', model: 'gpt-mock', tokensIn: 7, tokensOut: 5, finishReason: 'stop', steps: 1, error: null });
    expect(asst.id).toBe(s.chunks.find((c) => c.type === 'start')?.messageId);
    expect(asst.parts.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('')).toBe('Hello there world');
    expect(got).toMatchObject({ tokensIn: 7, tokensOut: 5 });

    // Second turn: the history comes from the database (system + user + assistant + user).
    script = () => ({ text: 'Again' });
    await stream(conv.body.id, 'And again?');
    const prompt = calls.at(-1)!.prompt as { role: string }[];
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    await waitFor(async () => (await api('GET', `/api/projects/chat/chat/conversations/${conv.body.id}`)).body.messages.length === 4);
    const list = await api('GET', '/api/projects/chat/chat/conversations');
    expect(list.body[0]).toMatchObject({ id: conv.body.id, messages: 4, tokensIn: 14, tokensOut: 10, agent: { slug: 'helper' } });
  });

  it('errors before the stream are JSON 4xx; provider errors arrive in the stream with keys scrubbed', async () => {
    const conv = await api('POST', '/api/projects/chat/chat/conversations', {});
    let s = await stream(conv.body.id, 'x');
    expect(s.status).toBe(400);
    expect(JSON.parse(s.raw).error).toMatch(/no agent/);
    await api('POST', '/api/projects/chat/chat/agents', { name: 'Ghost', provider: 'missing', model: 'm' });
    s = await stream(conv.body.id, 'x', { agent: 'ghost' });
    expect(s.status).toBe(400);
    expect(JSON.parse(s.raw).error).toMatch(/AI provider "missing" not found/);
    s = await stream(conv.body.id, 'x', { agent: 'helper', message: { role: 'user', parts: 'nope' } });
    expect(s.status).toBe(400);
    expect((await stream('nope', 'x', { agent: 'helper' })).status).toBe(404);

    script = () => ({ error: `401 Unauthorized: Incorrect API key provided: ${STORED_KEY} (Authorization: Bearer ${STORED_KEY})` });
    s = await stream(conv.body.id, 'boom', { agent: 'helper' });
    expect(s.status).toBe(200);
    const err = s.chunks.find((c) => c.type === 'error');
    expect(err?.errorText).toContain('Incorrect API key');
    expect(err?.errorText).not.toContain(STORED_KEY);
    const got = await waitFor(async () => {
      const r = await api('GET', `/api/projects/chat/chat/conversations/${conv.body.id}`);
      return r.body.messages.find((m: { role: string }) => m.role === 'assistant');
    });
    expect(got.error).toContain('••••');
    expect(got.error).not.toContain(STORED_KEY);
  });

  it('tool loop against an MCP server through an MCP tester target (errors come back as text)', async () => {
    expect((await api('POST', '/api/projects/chat/mcp-tester/targets', { name: 'Calc', url: calcUrl })).status).toBe(201);
    const a = await api('POST', '/api/projects/chat/chat/agents', { name: 'Calc agent', slug: 'calc', provider: 'oa', model: 'gpt-mock', tools: { builtin: false, targets: [{ target: 'Calc', tools: '*' }] } });
    expect(a.status).toBe(201);
    const tl = await api('GET', '/api/projects/chat/chat/agents/calc/tools');
    expect(tl.body.errors).toEqual([]);
    expect(tl.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(['calc__add', 'calc__boom']);
    expect(tl.body.tools[0]).toMatchObject({ source: 'target', target: 'Calc' });
    expect(tl.body.tools[0].sessionId).toMatch(/^mt_/);

    script = (n) => (n === 0 ? { tools: [{ name: 'calc__add', input: { a: 2, b: 3 } }, { name: 'calc__boom', input: {} }] } : { text: 'The sum is 5.' });
    const conv = await api('POST', '/api/projects/chat/chat/conversations', { agent: 'calc' });
    const s = await stream(conv.body.id, 'What is 2+3?');
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.sort()).toEqual(['calc__add', 'calc__boom']);
    const outputs = s.chunks.filter((c) => c.type === 'tool-output-available');
    expect(outputs.map((c) => c.output).sort()).toEqual(['5', 'Error: kaboom']);
    // The model saw both tool results in the second step.
    expect(JSON.stringify(calls[1].prompt)).toContain('Error: kaboom');
    const got = await waitFor(async () => (await api('GET', `/api/projects/chat/chat/conversations/${conv.body.id}`)).body.messages[1]);
    expect(got.steps).toBe(2);
    const toolParts = got.parts.filter((p: { type: string }) => p.type === 'dynamic-tool');
    expect(toolParts.map((p: { toolName: string; state: string }) => [p.toolName, p.state])).toEqual(
      expect.arrayContaining([
        ['calc__add', 'output-available'],
        ['calc__boom', 'output-available'],
      ]),
    );
    // The exchange is in the MCP tester session log, tagged "chat".
    const session = hub.mcpTester.sessionsOf(hub.projects.require('chat').id)[0];
    expect(session.client.log.some((e: { source?: string; method?: string }) => e.source === 'chat' && e.method === 'tools/call')).toBe(true);

    // A missing target is a per-target error, not a failure of the whole list.
    await api('PATCH', '/api/projects/chat/chat/agents/calc', { tools: { builtin: false, targets: [{ target: 'Calc', tools: ['add'] }, { target: 'Nope' }] } });
    const tl2 = await api('GET', '/api/projects/chat/chat/agents/calc/tools');
    expect(tl2.body.tools.map((t: { name: string }) => t.name)).toEqual(['calc__add']);
    expect(tl2.body.errors).toEqual([{ target: 'Nope', error: 'MCP target "Nope" not found' }]);
    await api('PATCH', '/api/projects/chat/chat/agents/calc', { tools: { builtin: false, targets: [{ target: 'Calc', tools: '*' }] } });
  });

  it('stubyard__ tools are read-only, project-scoped and forced to the agent project', async () => {
    const a = await api('POST', '/api/projects/chat/chat/agents', { name: 'Hub agent', slug: 'hub', provider: 'oa', model: 'gpt-mock' });
    expect(a.body.tools).toEqual({ builtin: true, targets: [] });
    const tl = await api('GET', '/api/projects/chat/chat/agents/hub/tools');
    const names: string[] = tl.body.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.every((n) => n.startsWith('stubyard__'))).toBe(true);
    expect(names).toContain('stubyard__list_test_users');
    expect(names).toContain('stubyard__list_chat_agents');
    for (const bad of ['stubyard__list_projects', 'stubyard__create_project', 'stubyard__ask_agent', 'stubyard__set_user_scenario', 'stubyard__run_saved_prompts']) expect(names).not.toContain(bad);
    for (const t of tl.body.tools) {
      expect(t.inputSchema.properties.project).toBeUndefined();
      expect(t.inputSchema.required ?? []).not.toContain('project');
    }
    const listed = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    for (const n of names) expect(listed.find((t) => t.name === n.replace('stubyard__', ''))?.annotations?.readOnlyHint).toBe(true);

    // The model asks for another project: the agent's own project is used anyway.
    script = (n) => (n === 0 ? { tools: [{ name: 'stubyard__list_test_users', input: { project: 'other' } }] } : { text: 'done' });
    const r = await mcp('ask_agent', { project: 'chat', agent: 'hub', prompt: 'Who are the users?' });
    expect(r.toolCalls).toHaveLength(1);
    expect(String(r.toolCalls[0].output)).toContain('@chat.test');
    expect(String(r.toolCalls[0].output)).not.toContain('@other.test');

    // Allowlist by name.
    await api('PATCH', '/api/projects/chat/chat/agents/hub', { tools: { builtin: ['list_test_users', 'stubyard__get_messages'] } });
    const tl2 = await api('GET', '/api/projects/chat/chat/agents/hub/tools');
    expect(tl2.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(['stubyard__get_messages', 'stubyard__list_test_users']);
  });

  it('caps the tool loop at maxSteps (max 25)', async () => {
    expect((await api('POST', '/api/projects/chat/chat/agents', { name: 'Big', provider: 'oa', model: 'm', maxSteps: 26 })).status).toBe(400);
    expect((await api('POST', '/api/projects/chat/chat/agents', { name: 'Hot', provider: 'oa', model: 'm', temperature: 3 })).status).toBe(400);
    const a = await api('POST', '/api/projects/chat/chat/agents', { name: 'Loop', provider: 'oa', model: 'gpt-mock', maxSteps: 3, maxOutputTokens: 100, tools: { builtin: false, targets: [{ target: 'Calc', tools: ['add'] }] } });
    expect(a.body).toMatchObject({ maxSteps: 3, maxOutputTokens: 100 });
    script = () => ({ tools: [{ name: 'calc__add', input: { a: 1, b: 1 } }] });
    const r = await mcp('ask_agent', { project: 'chat', agent: 'loop', prompt: 'loop forever' });
    expect(calls).toHaveLength(3);
    expect(r.steps).toBe(3);
    expect(r.finishReason).toBe('tool-calls');
    expect(r.toolCalls).toHaveLength(3);

    calls.length = 0;
    const conv = await api('POST', '/api/projects/chat/chat/conversations', { agent: 'loop' });
    await stream(conv.body.id, 'loop');
    expect(calls).toHaveLength(3);
    const m = await waitFor(async () => (await api('GET', `/api/projects/chat/chat/conversations/${conv.body.id}`)).body.messages[1]);
    expect(m).toMatchObject({ steps: 3, finishReason: 'tool-calls' });
  });

  it('saved prompts: deterministic expectations pass / fail, results stored', async () => {
    const ok = await api('POST', '/api/projects/chat/chat/prompts', {
      agent: 'calc',
      name: 'adds',
      prompt: 'What is 2+3?',
      expectations: { contains: ['SUM'], notContains: ['sorry'], matches: '/sum is \\d+/i', toolCalled: ['add'], toolNotCalled: ['boom'], maxSteps: 2, maxTokens: 100, finishReason: 'stop' },
    });
    expect(ok.status).toBe(201);
    const bad = await api('POST', '/api/projects/chat/chat/prompts', { agent: 'calc', name: 'no tools', prompt: 'Just talk', expectations: { toolNotCalled: ['calc__add'], notContains: ['sum'] } });
    expect(bad.status).toBe(201);
    expect((await api('POST', '/api/projects/chat/chat/prompts', { agent: 'calc', prompt: 'x', expectations: { matches: '([' } })).status).toBe(400);
    expect((await api('POST', '/api/projects/chat/chat/prompts', { agent: 'calc', prompt: '' })).status).toBe(400);

    script = (n) => (n % 2 === 0 ? { tools: [{ name: 'calc__add', input: { a: 2, b: 3 } }] } : { text: 'The sum is 5.' });
    const one = await api('POST', `/api/projects/chat/chat/prompts/${ok.body.id}/run`);
    expect(one.body.passed).toBe(true);
    expect(one.body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(one.body.toolCalls[0]).toMatchObject({ name: 'calc__add', output: '5' });

    const all = await api('POST', '/api/projects/chat/chat/prompts/run', { agent: 'calc' });
    expect(all.body).toMatchObject({ passed: 1, failed: 1 });
    const failed = all.body.results.find((r: { name: string }) => r.name === 'no tools');
    expect(failed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id).sort()).toEqual(['notContains:sum', 'toolNotCalled:calc__add']);
    const stored = (await api('GET', '/api/projects/chat/chat/prompts?agent=calc')).body.find((p: { name: string }) => p.name === 'no tools');
    expect(stored.lastResult).toMatchObject({ passed: false });
    expect(stored.lastRunAt).toBeTruthy();
  });

  it('MCP tools: list_chat_agents, ask_agent, run_saved_prompts', async () => {
    const listed = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as { name: string; annotations?: Record<string, unknown> }[];
    const byName = new Map(listed.map((t) => [t.name, t]));
    expect(byName.get('list_chat_agents')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.has('ask_agent')).toBe(true);
    expect(byName.has('run_saved_prompts')).toBe(true);
    expect([...byName.keys()].some((n) => /provider_key|api_key/.test(n))).toBe(false);

    const agents = await mcp('list_chat_agents', { project: 'chat' });
    expect(agents.agents.map((x: { slug: string }) => x.slug)).toEqual(expect.arrayContaining(['helper', 'calc', 'hub', 'loop']));
    expect(agents.agents.find((x: { slug: string }) => x.slug === 'ghost').providerOk).toBe(false);

    script = () => ({ text: 'Pong.' });
    const asked = await mcp('ask_agent', { project: 'chat', agent: 'helper', prompt: 'Ping?' });
    expect(asked).toMatchObject({ text: 'Pong.', steps: 1, usage: { inputTokens: 7, outputTokens: 5 }, error: null });
    const conv = await api('GET', `/api/projects/chat/chat/conversations/${asked.conversation}`);
    expect(conv.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    // Continue the same conversation.
    script = () => ({ text: 'Pong again.' });
    const again = await mcp('ask_agent', { project: 'chat', agent: 'helper', prompt: 'Ping?', conversation: asked.conversation });
    expect(again.conversation).toBe(asked.conversation);
    expect((calls.at(-1)!.prompt as unknown[]).length).toBe(4);

    script = (n) => (n % 2 === 0 ? { tools: [{ name: 'calc__add', input: { a: 2, b: 3 } }] } : { text: 'The sum is 5.' });
    const run = await mcp('run_saved_prompts', { project: 'chat', ids: ['adds'] });
    expect(run).toMatchObject({ passed: 1, failed: 0 });
    expect(run.results[0]).toMatchObject({ name: 'adds', passed: true, toolCalls: ['calc__add'] });
    await expect(mcp('ask_agent', { project: 'chat', agent: 'nobody', prompt: 'x' })).rejects.toThrow(/not found/);
  });

  it('export / import agents and prompts; reset clears conversations', async () => {
    const ex = await api('GET', '/api/projects/chat/export?secrets=1');
    expect(ex.body.chatAgents.map((a: { slug: string }) => a.slug)).toEqual(expect.arrayContaining(['helper', 'calc']));
    expect(ex.body.chatPrompts.length).toBe(2);
    expect(ex.body.conversations).toBeUndefined();
    const im = await api('POST', '/api/projects/import', { ...ex.body, project: { ...ex.body.project, name: 'Chat copy', slug: 'chat-copy' } });
    expect(im.status).toBeLessThan(300);
    const copied = await api('GET', '/api/projects/chat-copy/chat/agents');
    expect(copied.body.map((a: { slug: string }) => a.slug)).toEqual(expect.arrayContaining(['helper', 'calc']));
    expect((await api('GET', '/api/projects/chat-copy/chat/prompts')).body.map((p: { name: string }) => p.name).sort()).toEqual(['adds', 'no tools']);

    expect((await api('GET', '/api/projects/chat/chat/conversations')).body.length).toBeGreaterThan(0);
    await api('POST', '/api/projects/chat/reset', {});
    expect((await api('GET', '/api/projects/chat/chat/conversations')).body).toEqual([]);
    expect((await api('GET', '/api/projects/chat/chat/agents')).body.length).toBeGreaterThan(0);
  });

  it('changing the base URL host clears the stored key and header values (unless sent again)', async () => {
    const c = await api('POST', '/api/system/ai-providers', { name: 'mover', kind: 'openai-compatible', preset: 'custom', baseUrl: modelsUrl, apiKey: 'sk-mover-KEEP1111', headers: { 'x-secret': 'hdr-secret-123456' } });
    expect(c.body).toMatchObject({ hasKey: true, headerNames: ['x-secret'] });
    // Same host, other path: kept.
    const same = await api('PATCH', '/api/system/ai-providers/mover', { baseUrl: `${modelsUrl}/sub`, headers: c.body.headers });
    expect(same.body).toMatchObject({ hasKey: true, headerNames: ['x-secret'] });
    expect(hub.chat.providers.require('mover').headers['x-secret']).toBe('hdr-secret-123456');
    // Other host: key and (masked, sent back) header values are gone.
    const moved = await api('PATCH', '/api/system/ai-providers/mover', { baseUrl: 'https://attacker.example/v1', headers: c.body.headers });
    expect(moved.body).toMatchObject({ hasKey: false, keyHint: null, headerNames: [] });
    expect(hub.chat.providers.require('mover').apiKey).toBeNull();
    // A key sent with the host change is kept.
    const withKey = await api('PATCH', '/api/system/ai-providers/mover', { baseUrl: modelsUrl, apiKey: 'sk-mover-NEW22222', headers: { 'x-plain': 'v' } });
    expect(withKey.body).toMatchObject({ hasKey: true, keyHint: '••••2222', headerNames: ['x-plain'] });
    await api('DELETE', '/api/system/ai-providers/mover');
  });

  it('environment keys apply only to the kind default host', async () => {
    const proxy = await api('POST', '/api/system/ai-providers', { name: 'claude-proxy', kind: 'anthropic', baseUrl: 'https://proxy.example/v1' });
    expect(proxy.status).toBe(201);
    expect(proxy.body).toMatchObject({ hasKey: false, source: null, envVar: null });
    expect(hub.chat.providers.resolve(hub.chat.providers.require('claude-proxy')).apiKey).toBeNull();
    const stored = await api('PATCH', '/api/system/ai-providers/claude-proxy', { apiKey: 'sk-ant-proxy-3333' });
    expect(stored.body).toMatchObject({ source: 'stored', keyHint: '••••3333' });
    expect(hub.chat.providers.resolve(hub.chat.providers.require('claude-proxy')).apiKey).toBe('sk-ant-proxy-3333');
    // Default host (explicit or implicit): the environment key wins.
    const def = await api('PATCH', '/api/system/ai-providers/claude-proxy', { baseUrl: 'https://api.anthropic.com/v1' });
    expect(def.body).toMatchObject({ source: 'env', envVar: 'ANTHROPIC_API_KEY' });
    await api('DELETE', '/api/system/ai-providers/claude-proxy');
  });

  it('egressFetch does not follow redirects (model list too)', async () => {
    const g = egressFetch({ name: 'local', baseUrl: modelsUrl });
    await expect(g(`${modelsUrl}/redir/models`)).rejects.toThrow();
    await api('POST', '/api/system/ai-providers', { name: 'redir', kind: 'openai-compatible', preset: 'custom', baseUrl: `${modelsUrl}/redir`, apiKey: 'sk-redir-4444' });
    const m = await api('GET', '/api/system/ai-providers/redir/models');
    expect(m.status).toBe(502);
    expect(JSON.stringify(m.body)).not.toContain('sk-redir-4444');
    await api('DELETE', '/api/system/ai-providers/redir');
  });

  it('stubyard__ tools come from an explicit allowlist (no mcp_tester_checks, no export_project)', async () => {
    const tl = await api('GET', '/api/projects/chat/chat/builtin-tools');
    const names: string[] = tl.body.tools.map((t: { tool: string }) => t.tool);
    for (const bad of ['mcp_tester_checks', 'mcp_tester_connect', 'mcp_tester_call', 'export_project', 'get_request', 'get_file_url', 'list_projects']) expect(names).not.toContain(bad);
    const { BUILTIN_TOOLS } = await import('../src/chat/tools.js');
    expect(names.every((n) => BUILTIN_TOOLS.has(n))).toBe(true);
    expect(names).toContain('get_traffic');
    const listed = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(listed.find((t) => t.name === 'mcp_tester_checks')?.annotations?.readOnlyHint).toBe(false);
    // An agent allowlisting an excluded tool by name still does not get it.
    await api('POST', '/api/projects/chat/chat/agents', { name: 'Sneaky', provider: 'oa', model: 'gpt-mock', tools: { builtin: ['mcp_tester_checks', 'export_project', 'list_test_users'] } });
    const st = await api('GET', '/api/projects/chat/chat/agents/sneaky/tools');
    expect(st.body.tools.map((t: { name: string }) => t.name)).toEqual(['stubyard__list_test_users']);
  });

  it('a conversation deleted while the reply streams is not recreated and nothing crashes', async () => {
    const conv = await api('POST', '/api/projects/chat/chat/conversations', { agent: 'helper' });
    const projectId = hub.projects.require('chat').id;
    script = () => {
      hub.chat.repo.deleteConversation(projectId, conv.body.id);
      return { text: 'too late' };
    };
    const s = await stream(conv.body.id, 'hello?');
    expect(s.status).toBe(200);
    expect(s.chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe('too late');
    await new Promise((r) => setTimeout(r, 100));
    expect((await api('GET', `/api/projects/chat/chat/conversations/${conv.body.id}`)).status).toBe(404);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(conv.body.id) as { n: number }).n).toBe(0);
    // The server still answers.
    expect((await api('GET', '/api/projects/chat/chat/conversations')).status).toBe(200);
  });

  it('no key in any API response, export, database row (except ai_providers) or log line', async () => {
    const bodies = [
      await api('GET', '/api/system/ai-providers'),
      await api('GET', '/api/system/ai-providers/oa'),
      await api('GET', '/api/projects/chat/chat/agents'),
      await api('GET', '/api/projects/chat/chat/conversations'),
      await api('GET', '/api/projects/chat/export?secrets=1'),
      await api('GET', '/api/projects/chat/export'),
    ].map((r) => JSON.stringify(r.body));
    const tables = (hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'ai_providers'").all() as { name: string }[]).map((t) => t.name);
    const dump = tables.map((t) => JSON.stringify(hub.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
    for (const key of [STORED_KEY, ENV_KEY, LOCAL_KEY]) {
      for (const b of bodies) expect(b).not.toContain(key);
      expect(dump).not.toContain(key);
      expect(logLines.join('')).not.toContain(key);
    }
    expect(logLines.length).toBeGreaterThan(0);
  });

  it('factory reset deletes AI providers', async () => {
    expect((await api('GET', '/api/system/ai-providers')).body.providers.filter((p: { env: boolean }) => !p.env).length).toBeGreaterThan(0);
    const r = await api('POST', '/api/factory-reset', { confirm: 'DELETE EVERYTHING' });
    expect(r.status).toBe(200);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM ai_providers').get() as { n: number }).n).toBe(0);
    const list = (await api('GET', '/api/system/ai-providers')).body.providers;
    expect(list.every((p: { env: boolean; mock?: boolean }) => p.env || p.mock)).toBe(true);
  });
});

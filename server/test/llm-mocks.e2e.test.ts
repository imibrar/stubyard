import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { requestHash, normalizeRequest } from '../src/llmmocks/normalize.js';

/** LLM API mocks end to end: OpenAI chat / Responses / embeddings and Anthropic Messages, streamed and not, faults, runs. */

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
const P = 'bot';
const API = `/api/projects/${P}/llm`;
const OA = `/llm/${P}/openai/v1`;
const AN = `/llm/${P}/anthropic/v1`;
const CLIENT_KEY = 'sk-test-CLIENTSECRETKEY987654';

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

async function llm(p: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}`, 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* stream or broken */
  }
  return { status: r.status, text, json, headers: r.headers };
}

/** Strict SSE parser: every block is "event: x" (optional) + exactly one "data: …" line, blocks end with a blank line. */
function sse(text: string, o: { named: boolean }): { event: string | null; data: string }[] {
  expect(text.endsWith('\n\n')).toBe(true);
  const blocks = text.slice(0, -2).split('\n\n');
  return blocks.map((b) => {
    const lines = b.split('\n');
    if (o.named) {
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^event: [a-z_.]+$/);
      expect(lines[1].startsWith('data: ')).toBe(true);
      return { event: lines[0].slice(7), data: lines[1].slice(6) };
    }
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('data: ')).toBe(true);
    return { event: null, data: lines[0].slice(6) };
  });
}

const chatBody = (text: string, extra: Record<string, unknown> = {}) => ({ model: 'gpt-5-mini', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: text }], ...extra });
const anthropicBody = (text: string, extra: Record<string, unknown> = {}) => ({ model: 'claude-sonnet-4-5', max_tokens: 256, system: 'Be brief.', messages: [{ role: 'user', content: text }], ...extra });

describe('LLM API mocks', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-llm-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', timeoutHoldMs: 300, maintenanceIntervalMs: 0 });
    const logger = pino({ level: 'silent' });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger });
    const { app } = await buildApp(hub, logger);
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await hub.mcpTester.closeAll();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Bot', slug: P })).status).toBe(201);
    // Fast streams in tests.
    expect((await api('PUT', `${API}/settings`, { defaultChunk: { size: 5, delayMs: 0 } })).status).toBe(200);
  });
  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('connect gives base URLs and snippets; models list for both providers', async () => {
    const c = await api('GET', `${API}/connect`);
    expect(c.body.openai.baseUrl).toBe(`${base}/llm/${P}/openai/v1`);
    expect(c.body.anthropic.baseUrl).toBe(`${base}/llm/${P}/anthropic`);
    expect(c.body.snippets.length).toBeGreaterThan(3);
    const om = await fetch(`${base}${OA}/models`).then((r) => r.json());
    expect(om.object).toBe('list');
    expect(om.data[0]).toMatchObject({ object: 'model', owned_by: 'stubyard' });
    const one = await fetch(`${base}${OA}/models/gpt-9-test`).then((r) => r.json());
    expect(one.id).toBe('gpt-9-test');
    const am = await fetch(`${base}${AN}/models`).then((r) => r.json());
    expect(am.has_more).toBe(false);
    expect(am.data[0]).toMatchObject({ type: 'model' });
    expect(am.first_id).toBe(am.data[0].id);
  });

  it('unmatched: provider-shaped 404 listing the misses; unknown project and endpoint', async () => {
    const r = await llm(`${OA}/chat/completions`, chatBody('nothing scripted'));
    expect(r.status).toBe(404);
    expect(r.json.error).toMatchObject({ type: 'invalid_request_error', code: 'stubyard_no_mock' });
    expect(r.headers.get('x-request-id')).toMatch(/^req_/);
    const a = await llm(`${AN}/messages`, anthropicBody('nothing'));
    expect(a.status).toBe(404);
    expect(a.json).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
    expect(a.json.request_id).toBe(a.headers.get('request-id'));
    const unk = await llm('/llm/nope/openai/v1/chat/completions', chatBody('x'));
    expect(unk.status).toBe(404);
    expect(unk.json.error.message).toContain('no project "nope"');
    const ep = await llm(`${OA}/audio/speech`, {});
    expect(ep.status).toBe(404);
    expect(ep.json.error.message).toContain('does not simulate');
  });

  it('OpenAI chat: non-stream shape and estimated usage', async () => {
    const m = await api('POST', `${API}/mocks`, { name: 'hello', match: { lastUser: { contains: 'hello' } }, responses: [{ text: 'Hi there! You said: {{lastUser}}' }] });
    expect(m.status).toBe(201);
    const r = await llm(`${OA}/chat/completions`, chatBody('hello world'));
    expect(r.status).toBe(200);
    const b = r.json;
    expect(b).toMatchObject({ object: 'chat.completion', model: 'gpt-5-mini' });
    expect(b.id).toMatch(/^chatcmpl-/);
    expect(b.choices[0]).toMatchObject({ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'Hi there! You said: hello world', refusal: null } });
    expect(b.choices[0].message.tool_calls).toBeUndefined();
    // ceil(chars / 4): "Be brief." + "hello world" = 20 chars → 5; reply 31 chars → 8
    expect(b.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 });
  });

  it('OpenAI chat: stream with include_usage (strict SSE)', async () => {
    const r = await llm(`${OA}/chat/completions`, chatBody('hello stream', { stream: true, stream_options: { include_usage: true } }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const ev = sse(r.text, { named: false });
    expect(ev[ev.length - 1].data).toBe('[DONE]');
    const chunks = ev.slice(0, -1).map((e) => JSON.parse(e.data));
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(1);
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks[0].choices[0]).toMatchObject({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null, logprobs: null });
    const last = chunks[chunks.length - 1];
    expect(last.choices).toEqual([]);
    expect(last.usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
    const body = chunks.slice(0, -1);
    expect(body.every((c) => c.usage === null)).toBe(true);
    expect(body[body.length - 1].choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' });
    const text = body.map((c) => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hi there! You said: hello stream');
    expect(body.length).toBeGreaterThan(4); // chunk size 5
  });

  it('OpenAI Responses: non-stream and stream event order (strict SSE)', async () => {
    const nb = await llm(`${OA}/responses`, { model: 'gpt-5', instructions: 'Be brief.', input: 'hello responses' });
    expect(nb.status).toBe(200);
    expect(nb.json).toMatchObject({ object: 'response', status: 'completed', model: 'gpt-5', instructions: 'Be brief.' });
    expect(nb.json.id).toMatch(/^resp_/);
    expect(nb.json.output[0]).toMatchObject({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi there! You said: hello responses', annotations: [] }] });
    expect(nb.json.usage).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number), total_tokens: expect.any(Number) });

    const r = await llm(`${OA}/responses`, { model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello again' }] }], stream: true });
    const ev = sse(r.text, { named: true });
    const data = ev.map((e) => JSON.parse(e.data));
    ev.forEach((e, i) => expect(data[i].type).toBe(e.event));
    data.forEach((d, i) => expect(d.sequence_number).toBe(i));
    const types = [...new Set(data.map((d) => d.type))];
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const deltas = data.filter((d) => d.type === 'response.output_text.delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('Hi there! You said: hello again');
    expect(deltas[0].logprobs).toEqual([]);
    expect(data[data.length - 1].response.output[0].content[0].text).toBe('Hi there! You said: hello again');
    expect(r.text).not.toContain('[DONE]');
  });

  it('Anthropic Messages: non-stream and stream (strict SSE)', async () => {
    const nb = await llm(`${AN}/messages`, anthropicBody('hello claude'));
    expect(nb.status).toBe(200);
    expect(nb.json).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'Hi there! You said: hello claude' }] });
    expect(nb.json.id).toMatch(/^msg_01/);
    expect(nb.json.usage).toMatchObject({ input_tokens: 6, output_tokens: 8 });
    expect(nb.headers.get('request-id')).toBeTruthy();

    const r = await llm(`${AN}/messages`, anthropicBody('hello stream', { stream: true }));
    const ev = sse(r.text, { named: true });
    const data = ev.map((e) => JSON.parse(e.data));
    ev.forEach((e, i) => expect(data[i].type).toBe(e.event));
    expect(data[0]).toMatchObject({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: expect.any(Number) } } });
    expect(data[1]).toMatchObject({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    expect(data[2].type).toBe('ping');
    const tail = data.slice(-3).map((d) => d.type);
    expect(tail).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    expect(data[data.length - 2]).toMatchObject({ delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: expect.any(Number) } });
    const text = data.filter((d) => d.type === 'content_block_delta').map((d) => d.delta.text).join('');
    expect(text).toBe('Hi there! You said: hello stream');
  });

  it('tool-call round trip: OpenAI chat (stream) and Anthropic', async () => {
    await api('POST', `${API}/mocks`, { name: 'weather call', match: { hasTool: 'get_weather', turn: 0 }, responses: [{ toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] }] });
    await api('POST', `${API}/mocks`, { name: 'weather answer', match: { toolResult: { name: 'get_weather', contains: 'sunny' } }, responses: [{ text: 'It is sunny in Paris.' }] });
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
    const first = await llm(`${OA}/chat/completions`, { model: 'gpt-5', messages: [{ role: 'user', content: 'Weather in Paris?' }], tools, stream: true });
    const chunks = sse(first.text, { named: false }).filter((e) => e.data !== '[DONE]').map((e) => JSON.parse(e.data));
    const tc = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(tc[0]).toMatchObject({ index: 0, type: 'function', function: { name: 'get_weather', arguments: '' } });
    expect(tc[0].id).toMatch(/^call_/);
    const args = tc.map((t: any) => t.function.arguments).join('');
    expect(JSON.parse(args)).toEqual({ city: 'Paris' });
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
    const second = await llm(`${OA}/chat/completions`, {
      model: 'gpt-5',
      tools,
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: null, tool_calls: [{ id: tc[0].id, type: 'function', function: { name: 'get_weather', arguments: args } }] },
        { role: 'tool', tool_call_id: tc[0].id, content: '{"forecast":"sunny"}' },
      ],
    });
    expect(second.json.choices[0].message.content).toBe('It is sunny in Paris.');

    const aTools = [{ name: 'get_weather', input_schema: { type: 'object' } }];
    const a1 = await llm(`${AN}/messages`, { model: 'claude-haiku-4-5', max_tokens: 100, tools: aTools, messages: [{ role: 'user', content: 'Weather?' }] });
    expect(a1.json.stop_reason).toBe('tool_use');
    const use = a1.json.content.find((c: any) => c.type === 'tool_use');
    expect(use).toMatchObject({ name: 'get_weather', input: { city: 'Paris' } });
    expect(use.id).toMatch(/^toolu_01/);
    const a2 = await llm(`${AN}/messages`, {
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      tools: aTools,
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: a1.json.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'sunny, 24C' }] },
      ],
    });
    expect(a2.json.content[0].text).toBe('It is sunny in Paris.');
    // Anthropic stream tool_use: input_json_delta fragments
    const a3 = await llm(`${AN}/messages`, { model: 'claude-haiku-4-5', max_tokens: 100, tools: aTools, stream: true, messages: [{ role: 'user', content: 'Weather?' }] });
    const d3 = sse(a3.text, { named: true }).map((e) => JSON.parse(e.data));
    const start = d3.find((d) => d.type === 'content_block_start');
    expect(start.content_block).toMatchObject({ type: 'tool_use', name: 'get_weather', input: {} });
    const json = d3.filter((d) => d.delta?.type === 'input_json_delta').map((d) => d.delta.partial_json).join('');
    expect(JSON.parse(json)).toEqual({ city: 'Paris' });
    expect(d3.find((d) => d.type === 'message_delta').delta.stop_reason).toBe('tool_use');
    // Responses: function_call item
    const r3 = await llm(`${OA}/responses`, { model: 'gpt-5', input: 'Weather?', tools: [{ type: 'function', name: 'get_weather', parameters: {} }], stream: true });
    const d4 = sse(r3.text, { named: true }).map((e) => JSON.parse(e.data));
    const added = d4.find((d) => d.type === 'response.output_item.added');
    expect(added.item).toMatchObject({ type: 'function_call', name: 'get_weather', arguments: '' });
    expect(JSON.parse(d4.find((d) => d.type === 'response.function_call_arguments.done').arguments)).toEqual({ city: 'Paris' });
    const r4 = await llm(`${OA}/responses`, {
      model: 'gpt-5',
      tools: [{ type: 'function', name: 'get_weather', parameters: {} }],
      input: [{ role: 'user', content: 'Weather?' }, { type: 'function_call', call_id: added.item.call_id, name: 'get_weather', arguments: '{"city":"Paris"}' }, { type: 'function_call_output', call_id: added.item.call_id, output: 'sunny' }],
    });
    expect(r4.json.output[0].content[0].text).toBe('It is sunny in Paris.');
  });

  it('usage override, sequence mode and times (remaining)', async () => {
    await api('POST', `${API}/mocks`, { name: 'seq', match: { lastUser: { equals: 'count' } }, mode: 'sequence', responses: [{ text: 'one', usage: { input: 100, output: 7 } }, { text: 'two' }] });
    const a = await llm(`${OA}/chat/completions`, chatBody('count'));
    expect(a.json.choices[0].message.content).toBe('one');
    expect(a.json.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 });
    const b = await llm(`${OA}/chat/completions`, chatBody('count'));
    const c = await llm(`${OA}/chat/completions`, chatBody('count'));
    expect([b.json.choices[0].message.content, c.json.choices[0].message.content]).toEqual(['two', 'two']);

    const lim = await api('POST', `${API}/mocks`, { name: 'twice', match: { lastUser: { equals: 'limited' } }, times: 2, responses: [{ text: 'ok' }] });
    expect(lim.body.remaining).toBe(2);
    expect((await llm(`${OA}/chat/completions`, chatBody('limited'))).status).toBe(200);
    expect((await llm(`${OA}/chat/completions`, chatBody('limited'))).status).toBe(200);
    const third = await llm(`${OA}/chat/completions`, chatBody('limited'));
    expect(third.status).toBe(404);
    expect(third.json.error.stubyard.mocks.find((m: any) => m.name === 'twice').reason).toContain('used up');
  });

  it('faults via X-Hub-Scenario: rate_limit, error, overloaded, auth, context_length', async () => {
    const rl = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'rate_limit:2' });
    expect(rl.status).toBe(429);
    expect(rl.headers.get('retry-after')).toBe('2');
    expect(rl.headers.get('retry-after-ms')).toBe('2000');
    expect(rl.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    expect(rl.json.error).toMatchObject({ code: 'rate_limit_exceeded' });
    const arl = await llm(`${AN}/messages`, anthropicBody('hello'), { 'x-hub-scenario': 'rate_limit' });
    expect(arl.status).toBe(429);
    expect(arl.json.error.type).toBe('rate_limit_error');
    expect(arl.headers.get('anthropic-ratelimit-requests-remaining')).toBe('0');
    expect((await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'error:502' })).status).toBe(502);
    const e500 = await llm(`${AN}/messages`, anthropicBody('hello'), { 'x-hub-scenario': 'error' });
    expect(e500.status).toBe(500);
    expect(e500.json.error.type).toBe('api_error');
    const ov = await llm(`${AN}/messages`, anthropicBody('hello'), { 'x-hub-scenario': 'overloaded' });
    expect(ov.status).toBe(529);
    expect(ov.json.error.type).toBe('overloaded_error');
    const ovo = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'overloaded' });
    expect(ovo.status).toBe(503);
    expect(ovo.json.error).toMatchObject({ type: 'service_unavailable_error', code: 'server_is_overloaded' });
    const au = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'auth' });
    expect(au.status).toBe(401);
    expect(au.json.error.code).toBe('invalid_api_key');
    expect((await llm(`${AN}/messages`, anthropicBody('hello'), { 'x-hub-scenario': 'auth' })).json.error.type).toBe('authentication_error');
    const cl = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'context_length' });
    expect(cl.status).toBe(400);
    expect(cl.json.error).toMatchObject({ code: 'context_length_exceeded', param: 'messages', type: 'invalid_request_error' });
    const acl = await llm(`${AN}/messages`, anthropicBody('hello'), { 'x-hub-scenario': 'context_length' });
    expect(acl.json.error.message).toContain('prompt is too long');
  });

  it('faults: timeout, drop, slow, malformed, cut, stream_error', async () => {
    await expect(llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'timeout' })).rejects.toThrow();
    await expect(llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'drop' })).rejects.toThrow();
    const t0 = Date.now();
    const slow = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'slow:250' });
    expect(slow.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    const mal = await llm(`${OA}/chat/completions`, chatBody('hello', { stream: true }), { 'x-hub-scenario': 'malformed' });
    const bad = mal.text
      .split('\n\n')
      .filter(Boolean)
      .map((b) => b.slice(6))
      .filter((d) => d !== '[DONE]')
      .filter((d) => {
        try {
          JSON.parse(d);
          return false;
        } catch {
          return true;
        }
      });
    expect(bad).toHaveLength(1);
    const malJson = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-scenario': 'malformed' });
    expect(malJson.status).toBe(200);
    expect(malJson.json).toBeNull();
    // cut: the connection closes after 2 frames, no [DONE]
    let cutText = '';
    try {
      const r = await fetch(`${base}${OA}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-scenario': 'cut:2' }, body: JSON.stringify(chatBody('hello', { stream: true })) });
      const reader = r.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        cutText += Buffer.from(value).toString('utf8');
      }
    } catch {
      /* terminated */
    }
    expect(cutText.split('\n\n').filter(Boolean)).toHaveLength(2);
    expect(cutText).not.toContain('[DONE]');
    const se = await llm(`${AN}/messages`, anthropicBody('hello', { stream: true }), { 'x-hub-scenario': 'stream_error:3' });
    const evs = sse(se.text, { named: true });
    expect(evs).toHaveLength(4);
    expect(evs[3].event).toBe('error');
    expect(JSON.parse(evs[3].data)).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  });

  it('fault rules (set_llm_fault via MCP) with times, then normal again; calls are logged', async () => {
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
      return JSON.parse(r.body.result.content[0].text);
    };
    const f = await mcp('set_llm_fault', { project: P, fault: 'rate_limit:1', provider: 'anthropic', times: 1 });
    expect(f).toMatchObject({ kind: 'fault', fault: 'rate_limit:1', remaining: 1 });
    expect((await llm(`${OA}/chat/completions`, chatBody('hello'))).status).toBe(200); // other provider
    expect((await llm(`${AN}/messages`, anthropicBody('hello'))).status).toBe(429);
    expect((await llm(`${AN}/messages`, anthropicBody('hello'))).status).toBe(200);
    const calls = await mcp('list_llm_calls', { project: P, limit: 3 });
    expect(calls.map((c: any) => c.mode)).toEqual(['mock', 'fault', 'mock']);
    expect(calls[1]).toMatchObject({ provider: 'anthropic', fault: 'rate_limit:1', status: 429 });
    const set = await mcp('set_llm_mock', { project: P, name: 'mcp mock', match: { lastUser: { contains: 'via mcp' } }, text: 'scripted by MCP' });
    expect(set.responses[0].text).toBe('scripted by MCP');
    const after = new Date().toISOString();
    const waiting = mcp('wait_for_llm_call', { project: P, contains: 'via mcp', after, timeout_seconds: 5 });
    await new Promise((r) => setTimeout(r, 150));
    await llm(`${OA}/chat/completions`, chatBody('ping via mcp'));
    const w = await waiting;
    expect(w.timedOut).toBe(false);
    expect(w.call).toMatchObject({ mode: 'mock', reply: 'scripted by MCP', lastUser: 'ping via mcp' });
    expect((await mcp('list_llm_mocks', { project: P })).some((m: any) => m.name === 'mcp mock')).toBe(true);
    await mcp('delete_llm_mock', { project: P, id: set.id });
    await mcp('set_llm_fault', { project: P, fault: 'none' });
  });

  it('run isolation: run-scoped mock via header and /run/<key>/ prefix; dropped when the run stops', async () => {
    const run = await api('POST', `/api/projects/${P}/runs`, { key: 'w1' });
    expect(run.status).toBe(201);
    const rm = await api('POST', `${API}/mocks?run=w1`, { name: 'run hello', match: { lastUser: { contains: 'hello' } }, responses: [{ text: 'hello from run w1' }] });
    expect(rm.body.run).toBe('w1');
    const viaHeader = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-run': 'w1' });
    expect(viaHeader.json.choices[0].message.content).toBe('hello from run w1');
    const viaPrefix = await llm(`/run/w1${OA}/chat/completions`, chatBody('hello'));
    expect(viaPrefix.json.choices[0].message.content).toBe('hello from run w1');
    const plain = await llm(`${OA}/chat/completions`, chatBody('hello'));
    expect(plain.json.choices[0].message.content).toBe('Hi there! You said: hello');
    const calls = await api('GET', `${API}/calls?run=w1`);
    expect(calls.body).toHaveLength(2);
    expect(calls.body.every((c: any) => c.run === 'w1')).toBe(true);
    const unknown = await llm(`${OA}/chat/completions`, chatBody('hello'), { 'x-hub-run': 'nope' });
    expect(unknown.status).toBe(404);
    await api('POST', `/api/projects/${P}/runs/w1/stop`, { purge: true });
    expect(hub.llm.repo.getMock(hub.projects.getBySlug(P)!.id, rm.body.id)).toBeNull();
    expect((await api('GET', `${API}/calls?run=w1`)).body).toHaveLength(0);
  });

  it('embeddings: deterministic unit vectors, base64 (float32 LE) and float', async () => {
    const a = await llm(`${OA}/embeddings`, { model: 'text-embedding-3-small', input: ['alpha', 'beta'], encoding_format: 'base64' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ object: 'list', model: 'text-embedding-3-small', usage: { prompt_tokens: 3, total_tokens: 3 } });
    const dec = (s: string) => {
      const b = Buffer.from(s, 'base64');
      return Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
    };
    const v0 = dec(a.json.data[0].embedding);
    expect(v0).toHaveLength(1536);
    expect(Math.abs(Math.sqrt(v0.reduce((n, x) => n + x * x, 0)) - 1)).toBeLessThan(1e-4);
    const f = await llm(`${OA}/embeddings`, { model: 'text-embedding-3-small', input: 'alpha', dimensions: 1536 });
    expect(f.json.data[0].embedding).toHaveLength(1536);
    f.json.data[0].embedding.slice(0, 10).forEach((x: number, i: number) => expect(x).toBeCloseTo(v0[i], 5));
    expect(dec(a.json.data[1].embedding)[0]).not.toBeCloseTo(v0[0], 5);
    const small = await llm(`${OA}/embeddings`, { model: 'x', input: 'alpha', dimensions: 64 });
    expect(small.json.data[0].embedding).toHaveLength(64);
  });

  it('count_tokens, validation errors, anthropic-version warning, previous_response_id', async () => {
    const ct = await llm(`${AN}/messages/count_tokens`, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '12345678' }] });
    expect(ct.json).toEqual({ input_tokens: 2 });
    const noMax = await llm(`${AN}/messages`, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello' }] });
    expect(noMax.status).toBe(400);
    expect(noMax.json.error).toMatchObject({ type: 'invalid_request_error', message: 'max_tokens: Field required' });
    const noModel = await llm(`${OA}/chat/completions`, { messages: [{ role: 'user', content: 'x' }] });
    expect(noModel.status).toBe(400);
    expect(noModel.json.error.param).toBe('model');
    const prev = await llm(`${OA}/responses`, { model: 'gpt-5', input: 'x', previous_response_id: 'resp_123' });
    expect(prev.status).toBe(400);
    expect(prev.json.error.code).toBe('previous_response_not_found');
    const r = await fetch(`${base}${AN}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(anthropicBody('hello')) });
    expect(r.status).toBe(200);
    const logId = r.headers.get('x-hub-request-id')!;
    const log = await api('GET', `/api/logs/${logId}`);
    expect(log.body.resolved).toMatchObject({ kind: 'llm', provider: 'anthropic', endpoint: 'messages', mode: 'mock' });
    expect(log.body.resolved.warnings[0]).toContain('anthropic-version');
  });

  it('fallback echo / text', async () => {
    await api('PUT', `${API}/settings`, { fallback: 'echo' });
    const e = await llm(`${AN}/messages`, anthropicBody('unscripted question'));
    expect(e.json.content[0].text).toBe('Echo: unscripted question');
    await api('PUT', `${API}/settings`, { fallback: 'text', fallbackText: 'canned' });
    const t = await llm(`${OA}/chat/completions`, chatBody('unscripted', { stream: true }));
    const text = sse(t.text, { named: false }).filter((x) => x.data !== '[DONE]').map((x) => JSON.parse(x.data).choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('canned');
    const calls = await api('GET', `${API}/calls?mode=fallback&limit=2`);
    expect(calls.body).toHaveLength(2);
    await api('PUT', `${API}/settings`, { fallback: 'error' });
  });

  it('streamed traffic rows are complete and no client key is stored anywhere', async () => {
    const r = await llm(`${OA}/chat/completions`, chatBody('hello secret check', { stream: true }), { 'x-api-key': CLIENT_KEY });
    const id = r.headers.get('x-hub-request-id')!;
    const log = await api('GET', `/api/logs/${id}`);
    expect(log.body.outcome).toBe('ok');
    expect(log.body.resStatus).toBe(200);
    expect(log.body.resBody).toContain('data: [DONE]');
    expect(log.body.resolved).toMatchObject({ kind: 'llm', mode: 'mock', mock: 'hello', tokens: { input: expect.any(Number) } });
    const dump = JSON.stringify([
      hub.db.prepare('SELECT * FROM traffic_logs').all(),
      hub.db.prepare('SELECT * FROM llm_calls').all(),
      hub.db.prepare('SELECT * FROM llm_mocks').all(),
    ]);
    expect(dump).not.toContain(CLIENT_KEY);
    expect(dump).toContain('hello secret check');
  });

  it('request hash ignores provider ids and format; reorder; project reset clears calls', async () => {
    const a = normalizeRequest('openai', 'chat', { model: 'm', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{"b":1,"a":2}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'r' }] });
    const b = normalizeRequest('openai', 'responses', { model: 'm', input: [{ role: 'user', content: 'q' }, { type: 'function_call', call_id: 'x', name: 't', arguments: '{"a":2,"b":1}' }, { type: 'function_call_output', call_id: 'x', output: 'r' }] });
    expect(requestHash(a)).toBe(requestHash(b));
    const list = (await api('GET', `${API}/mocks`)).body as any[];
    const ids = list.map((m) => m.id).reverse();
    const re = await api('POST', `${API}/mocks/reorder`, { ids });
    expect(re.body.map((m: any) => m.id)).toEqual(ids);
    expect((await api('GET', `${API}/calls`)).body.length).toBeGreaterThan(0);
    await api('POST', `/api/projects/${P}/reset`, {});
    expect((await api('GET', `${API}/calls`)).body).toHaveLength(0);
    expect(((await api('GET', `${API}/mocks`)).body as any[]).every((m) => m.hits === 0)).toBe(true);
  });

  it('export / import carries mocks and settings', async () => {
    await api('PUT', `${API}/settings`, { fallback: 'echo', models: ['my-model'] });
    const ex = await api('GET', `/api/projects/${P}/export`);
    expect(ex.body.llmMocks.length).toBeGreaterThan(3);
    expect(ex.body.llmSettings[0].models).toEqual(['my-model']);
    const imp = await api('POST', '/api/projects/import', { json: ex.body, slug: 'bot2', name: 'Bot 2' });
    expect(imp.status).toBeLessThan(300);
    const m2 = await api('GET', '/api/projects/bot2/llm/mocks');
    expect(m2.body.length).toBe(ex.body.llmMocks.length);
    expect((await api('GET', '/api/projects/bot2/llm/settings')).body.fallback).toBe('echo');
    const models = await fetch(`${base}/llm/bot2/openai/v1/models`).then((r) => r.json());
    expect(models.data.map((m: any) => m.id)).toContain('my-model');
  });

  it('raw replies are validated at create; a broken stored raw reply still ends the stream and its log row', async () => {
    const raw = { provider: 'openai', endpoint: 'chat', stream: true, status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n' };
    for (const bad of [{ ...raw, body: '' }, { ...raw, body: '  ' }, { ...raw, status: 'x' }, { ...raw, status: 99 }, { ...raw, provider: 'gemini' }, { ...raw, stream: 'yes' }, 'not an object']) {
      const r = await api('POST', `${API}/mocks`, { name: 'bad raw', match: { lastUser: 'rawcheck-bad' }, responses: [{ raw: bad }] });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await api('POST', `${API}/mocks`, { name: 'raw ok', match: { lastUser: { equals: 'rawcheck' } }, fault: 'malformed', responses: [{ raw }] });
    expect(ok.status).toBe(201);
    // A row written before validation existed (or edited in the DB): empty body + malformed fault.
    const stored = JSON.parse((hub.db.prepare('SELECT responses FROM llm_mocks WHERE id = ?').get(ok.body.id) as { responses: string }).responses);
    stored[0].raw.body = '';
    hub.db.prepare('UPDATE llm_mocks SET responses = ? WHERE id = ?').run(JSON.stringify(stored), ok.body.id);
    const r = await llm(`${OA}/chat/completions`, { model: 'gpt-5-mini', stream: true, messages: [{ role: 'user', content: 'rawcheck' }] });
    expect(r.status).toBe(200);
    const id = r.headers.get('x-hub-request-id');
    expect(id).toBeTruthy();
    const row = hub.db.prepare('SELECT outcome FROM traffic_logs WHERE id = ?').get(id) as { outcome: string };
    expect(row.outcome).not.toBe('pending');
    await api('DELETE', `${API}/mocks/${ok.body.id}`);
  });
});

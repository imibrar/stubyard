import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { egressFetch } from '../src/chat/keys.js';
import { canonFromReply } from '../src/llmmocks/assemble.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/** Record-to-mock against an in-test fake upstream (no real network, no real keys). */

const UP_KEY = 'sk-up-UPSTREAMSECRET4242';
const UP_ANT_KEY = 'sk-ant-UPSTREAMSECRET7777';
const CLIENT_KEY = 'sk-client-CLIENTSECRET1111';

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
let upstream: http.Server;
let upUrl: string;
const hits: { path: string; headers: http.IncomingHttpHeaders; body: any; raw: string }[] = [];
const sent = new Map<string, string>();
const P = 'rec';
const API = `/api/projects/${P}/llm`;

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
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}`, 'x-api-key': CLIENT_KEY, ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* stream */
  }
  return { status: r.status, text, json, headers: r.headers };
}

const lastUser = (b: any): string => {
  const m = [...(b.messages ?? [])].reverse().find((x: any) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((c: any) => c.text ?? '').join('');
};

function fakeUpstream(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
  const body = raw ? JSON.parse(raw) : {};
  hits.push({ path: req.url ?? '', headers: req.headers, body, raw });
  const q = lastUser(body);
  const send = (status: number, type: string, text: string) => {
    sent.set(q, text);
    res.writeHead(status, { 'content-type': type, 'x-request-id': 'req_upstream1' }).end(text);
  };
  if (q.includes('redirect')) return void res.writeHead(302, { location: 'http://localhost:9/steal' }).end();
  if (q.includes('nullparts')) return send(200, 'application/json', JSON.stringify({ id: 'chatcmpl-ODD', object: 'chat.completion', choices: [null], content: [null], usage: null }));
  if (q.includes('fail429')) return send(429, 'application/json', JSON.stringify({ error: { message: 'slow down', type: 'requests', param: null, code: 'rate_limit_exceeded' } }));
  const answer = `Upstream says: ${q}`;
  if (req.url === '/v1/chat/completions') {
    if (body.stream) {
      const id = 'chatcmpl-UP1';
      const c = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] })}\n\n`;
      return send(200, 'text/event-stream', c({ role: 'assistant', content: '' }) + c({ content: answer.slice(0, 7) }) + c({ content: answer.slice(7) }) + c({}, 'stop') + 'data: [DONE]\n\n');
    }
    return send(200, 'application/json', JSON.stringify({ id: 'chatcmpl-UP2', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer, refusal: null }, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } }));
  }
  if (req.url === '/v1/messages') {
    const ev = (t: string, d: object) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
    if (body.stream) {
      return send(
        200,
        'text/event-stream; charset=utf-8',
        ev('message_start', { message: { id: 'msg_01UP', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1 } } }) +
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          ev('ping', {}) +
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.slice(0, 5) } }) +
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.slice(5) } }) +
          ev('content_block_stop', { index: 0 }) +
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }) +
          ev('message_stop', {}),
      );
    }
    return send(200, 'application/json', JSON.stringify({ id: 'msg_01UP2', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 9, output_tokens: 6 } }));
  }
  res.writeHead(404).end('{}');
}

describe('canonFromReply on odd provider bodies', () => {
  it('skips null / non-object list items instead of throwing', () => {
    expect(canonFromReply('chat', false, JSON.stringify({ choices: [null] }))).toMatchObject({ text: '' });
    expect(canonFromReply('chat', false, JSON.stringify({ choices: [{ message: { content: 'hi', tool_calls: [null, 3] } }] }))).toMatchObject({ text: 'hi' });
    expect(canonFromReply('messages', false, JSON.stringify({ content: [null, 'x', { type: 'text', text: 'ok' }] }))).toMatchObject({ text: 'ok' });
    expect(canonFromReply('responses', false, JSON.stringify({ output: [null, { type: 'message', content: [null] }] }))).toMatchObject({ text: '' });
    expect(canonFromReply('chat', true, 'data: {"choices":[null,{"delta":null}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[null,{"index":1e9}]}}]}\n\n')).toMatchObject({ text: '' });
    expect(canonFromReply('messages', true, 'data: {"type":"content_block_start","index":-1,"content_block":null}\n\n')).toMatchObject({ text: '' });
  });
});

describe('LLM record-to-mock', () => {
  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.STUBYARD_OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-llm-rec-'));
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
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => fakeUpstream(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Rec', slug: P })).status).toBe(201);
    expect((await api('POST', '/api/system/ai-providers', { name: 'up-openai', kind: 'openai-compatible', preset: 'custom', baseUrl: `${upUrl}/v1`, apiKey: UP_KEY })).status).toBeLessThan(300);
    expect((await api('POST', '/api/system/ai-providers', { name: 'up-claude', kind: 'anthropic', baseUrl: `${upUrl}/v1`, apiKey: UP_ANT_KEY, headers: { 'x-extra': 'hello-header' } })).status).toBeLessThan(300);
    await api('PUT', `${API}/settings`, { defaultChunk: { size: 4, delayMs: 0 } });
  });
  afterAll(async () => {
    await close?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses Google and unknown providers; one active recording per kind', async () => {
    expect((await api('POST', `${API}/recordings`, { provider: 'nope' })).status).toBe(404);
    await api('POST', '/api/system/ai-providers', { name: 'gem', kind: 'google', apiKey: 'g-key-1234567890' });
    const g = await api('POST', `${API}/recordings`, { provider: 'gem' });
    expect(g.status).toBe(400);
    expect(g.body.error).toContain('Google');
    const r = await api('POST', `${API}/recordings`, { provider: 'up-openai', name: 'first' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'openai', mode: 'new', status: 'active' });
    expect((await api('POST', `${API}/recordings`, { provider: 'up-openai' })).status).toBe(409);
  });

  it('forwards with the stored key (client key dropped) and tees the reply unchanged', async () => {
    const q = { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'What is 2+2?' }] };
    const r = await llm(`/llm/${P}/openai/v1/chat/completions`, q);
    expect(r.status).toBe(200);
    expect(r.text).toBe(sent.get('What is 2+2?'));
    const h = hits[hits.length - 1];
    expect(h.path).toBe('/v1/chat/completions');
    expect(h.headers.authorization).toBe(`Bearer ${UP_KEY}`);
    expect(h.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(h.headers)).not.toContain(CLIENT_KEY);
    expect(h.raw).toBe(JSON.stringify(q));
    const mocks = (await api('GET', `${API}/mocks`)).body as any[];
    expect(mocks).toHaveLength(1);
    expect(mocks[0]).toMatchObject({ source: 'recorded', provider: 'openai', match: { endpoint: 'chat', model: 'gpt-5-mini', lastUser: { equals: 'What is 2+2?' }, turn: 0 } });
    expect(mocks[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks[0].responses[0]).toMatchObject({ text: 'Upstream says: What is 2+2?', usage: { input: 11, output: 22 } });
    const calls = (await api('GET', `${API}/calls`)).body as any[];
    expect(calls[0]).toMatchObject({ mode: 'record', status: 200, tokensIn: 11, tokensOut: 22 });
  });

  it('streams are tee\'d and reassembled', async () => {
    const r = await llm(`/llm/${P}/openai/v1/chat/completions`, { model: 'gpt-5-mini', stream: true, messages: [{ role: 'user', content: 'Tell a story' }] });
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.text).toBe(sent.get('Tell a story'));
    const m = ((await api('GET', `${API}/mocks`)).body as any[]).find((x) => x.match.lastUser?.equals === 'Tell a story');
    expect(m.responses[0]).toMatchObject({ text: 'Upstream says: Tell a story', stopReason: 'stop' });
    expect(m.responses[0].raw).toMatchObject({ provider: 'openai', endpoint: 'chat', stream: true, status: 200 });
  });

  it('upstream errors are relayed, not saved; redirects to another host are blocked', async () => {
    const before = ((await api('GET', `${API}/mocks`)).body as any[]).length;
    const e = await llm(`/llm/${P}/openai/v1/chat/completions`, { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'please fail429' }] });
    expect(e.status).toBe(429);
    expect(e.json.error.code).toBe('rate_limit_exceeded');
    const red = await llm(`/llm/${P}/openai/v1/chat/completions`, { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'redirect me' }] });
    expect(red.status).toBe(502);
    expect(red.json.error.message).toContain('could not reach the recording provider');
    expect(red.text).not.toContain(UP_KEY);
    expect(((await api('GET', `${API}/mocks`)).body as any[]).length).toBe(before);
    await expect(egressFetch({ name: 'up', baseUrl: `${upUrl}/v1` })('http://example.invalid/v1/chat/completions')).rejects.toThrow(/blocked/);
  });

  it('after stop: replays exactly, also for an equivalent Responses request and in stream mode', async () => {
    const stop = await api('POST', `${API}/recordings/stop`);
    expect(stop.body[0].status).toBe('stopped');
    expect(stop.body[0].calls).toBe(2);
    const n = hits.length;
    const r = await llm(`/llm/${P}/openai/v1/chat/completions`, { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'What is 2+2?' }] });
    expect(r.text).toBe(sent.get('What is 2+2?')); // raw bytes, same provider + endpoint + mode
    const resp = await llm(`/llm/${P}/openai/v1/responses`, { model: 'gpt-5-mini', input: [{ role: 'user', content: 'What is 2+2?' }] });
    expect(resp.json.output[0].content[0].text).toBe('Upstream says: What is 2+2?');
    const st = await llm(`/llm/${P}/openai/v1/chat/completions`, { model: 'gpt-5-mini', stream: true, messages: [{ role: 'user', content: 'What is 2+2?' }] });
    const text = st.text
      .split('\n\n')
      .filter((b) => b.startsWith('data: {'))
      .map((b) => JSON.parse(b.slice(6)).choices[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Upstream says: What is 2+2?');
    expect(hits.length).toBe(n); // upstream not called
    const calls = (await api('GET', `${API}/calls?limit=3`)).body as any[];
    expect(calls.every((c) => c.mode === 'mock')).toBe(true);
  });

  it('Anthropic: x-api-key + stored headers upstream, stream recorded and replayed byte for byte', async () => {
    const rec = await api('POST', `${API}/recordings`, { provider: 'up-claude', mode: 'all' });
    expect(rec.body.kind).toBe('anthropic');
    const body = { model: 'claude-haiku-4-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'Hi Claude' }] };
    const r = await llm(`/llm/${P}/anthropic/v1/messages`, body, { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2024' });
    expect(r.text).toBe(sent.get('Hi Claude'));
    const h = hits[hits.length - 1];
    expect(h.path).toBe('/v1/messages');
    expect(h.headers['x-api-key']).toBe(UP_ANT_KEY);
    expect(h.headers.authorization).toBeUndefined();
    expect(h.headers['anthropic-version']).toBe('2023-06-01');
    expect(h.headers['anthropic-beta']).toBe('tools-2024');
    expect(h.headers['x-extra']).toBe('hello-header');
    const m = ((await api('GET', `${API}/mocks`)).body as any[]).find((x) => x.provider === 'anthropic');
    expect(m.responses[0]).toMatchObject({ text: 'Upstream says: Hi Claude', stopReason: 'stop', usage: { input: 9, output: 6 } });
    await api('POST', `${API}/recordings/${rec.body.id}/stop`);
    const n = hits.length;
    const again = await llm(`/llm/${P}/anthropic/v1/messages`, body, { 'anthropic-version': '2023-06-01' });
    expect(again.text).toBe(sent.get('Hi Claude'));
    expect(hits.length).toBe(n);
    // Non-stream request for the same conversation: synthesized from the canonical reply.
    const ns = await llm(`/llm/${P}/anthropic/v1/messages`, { ...body, stream: false }, { 'anthropic-version': '2023-06-01' });
    expect(ns.json.content[0].text).toBe('Upstream says: Hi Claude');
  });

  it('while recording: browser requests from other pages are refused, nothing forwarded carries CORS', async () => {
    const rec = await api('POST', `${API}/recordings`, { provider: 'up-openai', mode: 'new', maxCalls: 50 });
    expect(rec.status).toBe(201);
    const n = hits.length;
    const q = (t: string) => ({ model: 'gpt-5-mini', messages: [{ role: 'user', content: t }] });
    const evil = await llm(`/llm/${P}/openai/v1/chat/completions`, q('browser 1'), { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.json.error.message).toContain('cross-site');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const nul = await llm(`/llm/${P}/openai/v1/chat/completions`, q('browser 2'), { origin: 'null' });
    expect(nul.status).toBe(403);
    const sfs = await llm(`/llm/${P}/openai/v1/chat/completions`, q('browser 3'), { 'sec-fetch-site': 'cross-site' });
    expect(sfs.status).toBe(403);
    expect(hits.length).toBe(n);
    // stubyard's own pages (allowed hosts) and servers still record; the forwarded reply has no CORS headers.
    const own = await llm(`/llm/${P}/openai/v1/chat/completions`, q('from the dashboard'), { origin: 'http://localhost:4000', 'sec-fetch-site': 'same-site' });
    expect(own.status).toBe(200);
    expect(own.headers.get('access-control-allow-origin')).toBeNull();
    expect(hits.length).toBe(n + 1);
    // An odd upstream body (choices: [null]) is relayed unchanged and does not break the reply or the log row.
    const odd = await llm(`/llm/${P}/openai/v1/chat/completions`, q('nullparts please'));
    expect(odd.status).toBe(200);
    expect(odd.json.choices).toEqual([null]);
    const oddRow = hub.db.prepare("SELECT outcome FROM traffic_logs WHERE id = ?").get(odd.headers.get('x-hub-request-id')) as { outcome: string };
    expect(oddRow.outcome).toBe('ok');
    // Unknown project: no CORS either.
    const unk = await fetch(`${base}/llm/no-such-project/openai/v1/chat/completions`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(unk.status).toBe(404);
    expect(unk.headers.get('access-control-allow-origin')).toBeNull();
    await api('POST', `${API}/recordings/${rec.body.id}/stop`);
  });

  it('recordings stop by themselves after maxCalls or ttlMinutes', async () => {
    expect((await api('POST', `${API}/recordings`, { provider: 'up-openai', maxCalls: 0 })).status).toBe(400);
    expect((await api('POST', `${API}/recordings`, { provider: 'up-openai', ttlMinutes: 99999 })).status).toBe(400);
    const def = await api('POST', `${API}/recordings`, { provider: 'up-openai' });
    expect(def.body).toMatchObject({ maxCalls: 200, ttlMinutes: 60, forwarded: 0, callsLeft: 200 });
    await api('POST', `${API}/recordings/${def.body.id}/stop`);
    expect((await api('GET', `${API}/recordings`)).body.find((r: any) => r.id === def.body.id).stopReason).toBe('manual');

    const rec = await api('POST', `${API}/recordings`, { provider: 'up-openai', maxCalls: 2, ttlMinutes: 5 });
    expect(rec.body).toMatchObject({ maxCalls: 2, ttlMinutes: 5, callsLeft: 2 });
    const n = hits.length;
    const q = (t: string) => ({ model: 'gpt-5-mini', messages: [{ role: 'user', content: t }] });
    expect((await llm(`/llm/${P}/openai/v1/chat/completions`, q('limit one'))).status).toBe(200);
    expect((await api('GET', `${API}/recordings`)).body.find((r: any) => r.id === rec.body.id)).toMatchObject({ status: 'active', forwarded: 1, callsLeft: 1 });
    expect((await llm(`/llm/${P}/openai/v1/chat/completions`, q('limit two'))).status).toBe(200);
    const after = (await api('GET', `${API}/recordings`)).body.find((r: any) => r.id === rec.body.id);
    expect(after).toMatchObject({ status: 'stopped', stopReason: 'max-calls', forwarded: 2 });
    const third = await llm(`/llm/${P}/openai/v1/chat/completions`, q('limit three'));
    expect(third.status).toBe(404); // no mock, no recording: the usual "no mock matches"
    expect(hits.length).toBe(n + 2);

    const ttl = await api('POST', `${API}/recordings`, { provider: 'up-openai', ttlMinutes: 1 });
    expect(ttl.status).toBe(201);
    hub.db.prepare('UPDATE llm_recordings SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), ttl.body.id);
    expect((await llm(`/llm/${P}/openai/v1/chat/completions`, q('too late'))).status).toBe(404);
    expect(hits.length).toBe(n + 2);
    expect((await api('GET', `${API}/recordings`)).body.find((r: any) => r.id === ttl.body.id)).toMatchObject({ status: 'stopped', stopReason: 'expired' });
  });

  it('a provider disabled during a recording is not used (502)', async () => {
    const list = (await api('GET', '/api/system/ai-providers')).body as any[];
    const up = (Array.isArray(list) ? list : (list as any).providers).find((p: any) => p.name === 'up-openai');
    const rec = await api('POST', `${API}/recordings`, { provider: 'up-openai' });
    expect(rec.status).toBe(201);
    expect((await api('PATCH', `/api/system/ai-providers/${up.id}`, { enabled: false })).status).toBeLessThan(300);
    const n = hits.length;
    const r = await llm(`/llm/${P}/openai/v1/chat/completions`, { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'while disabled' }] });
    expect(r.status).toBe(502);
    expect(r.json.error.message).toContain('disabled');
    expect(hits.length).toBe(n);
    await api('POST', `${API}/recordings/${rec.body.id}/stop`);
    await api('PATCH', `/api/system/ai-providers/${up.id}`, { enabled: true });
  });

  it('LLM credential headers are redacted in the traffic log also under an unrecognised run prefix', async () => {
    const key = 'k'.repeat(30); // too long for a run key: the URL is not rewritten
    await fetch(`${base}/run/${key}/llm/${P}/openai/v1/models`, { headers: { authorization: `Bearer ${CLIENT_KEY}`, 'x-api-key': CLIENT_KEY } });
    const row = hub.db.prepare('SELECT req_headers FROM traffic_logs WHERE url LIKE ? ORDER BY received_at DESC').get(`/run/${key}/llm/%`) as { req_headers: string } | undefined;
    expect(row).toBeTruthy();
    const h = JSON.parse(row!.req_headers);
    expect(h.authorization).toMatch(/^Bearer .*••••/);
    expect(h['x-api-key']).toContain('••••');
    // Other traffic keeps its headers (replay needs them; signature headers stay visible).
    await fetch(`${base}/mock/${P}/whatever`, { headers: { authorization: 'Bearer plain-mock-token-123456', 'stripe-signature': 't=1,v1=abc' } });
    const mrow = hub.db.prepare("SELECT req_headers FROM traffic_logs WHERE url = ? ORDER BY received_at DESC").get(`/mock/${P}/whatever`) as { req_headers: string };
    expect(JSON.parse(mrow.req_headers)).toMatchObject({ authorization: 'Bearer plain-mock-token-123456', 'stripe-signature': 't=1,v1=abc' });
  });

  it('no key in any row, log or error', async () => {
    const dump = JSON.stringify([
      hub.db.prepare('SELECT * FROM traffic_logs').all(),
      hub.db.prepare('SELECT * FROM llm_calls').all(),
      hub.db.prepare('SELECT * FROM llm_mocks').all(),
      hub.db.prepare('SELECT * FROM llm_recordings').all(),
    ]);
    for (const k of [UP_KEY, UP_ANT_KEY, CLIENT_KEY]) expect(dump).not.toContain(k);
    expect(dump).toContain('Upstream says');
  });
});

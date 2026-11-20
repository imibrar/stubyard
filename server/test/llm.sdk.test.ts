import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { dynamicTool, embed, generateText, isStepCount, jsonSchema, streamText } from 'ai';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/** The installed Vercel AI SDK providers (strict parsers of each wire format) against the LLM mocks. */

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
const P = 'sdk';

const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

describe('LLM mocks with the AI SDK', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-llm-sdk-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
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
    await post('/api/projects', { name: 'SDK', slug: P });
    await fetch(`${base}/api/projects/${P}/llm/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultChunk: { size: 3, delayMs: 0 } }) });
    await post(`/api/projects/${P}/llm/mocks`, { name: 'call tool', match: { hasTool: 'add', turn: 0 }, responses: [{ toolCalls: [{ name: 'add', arguments: { a: 2, b: 3 } }] }] });
    await post(`/api/projects/${P}/llm/mocks`, { name: 'tool answer', match: { toolResult: { name: 'add' } }, responses: [{ text: 'The sum is 5.' }] });
    await post(`/api/projects/${P}/llm/mocks`, { name: 'hello', match: { lastUser: { contains: 'hello' } }, responses: [{ text: 'Hello from the mock, {{model}}!' }] });
  });
  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const openai = () => createOpenAI({ baseURL: `${base}/llm/${P}/openai/v1`, apiKey: 'sk-test' });
  const anthropic = () => createAnthropic({ baseURL: `${base}/llm/${P}/anthropic/v1`, apiKey: 'sk-ant-test' });
  const models = () => [
    ['openai chat', openai().chat('gpt-5-mini')],
    ['openai responses', openai().responses('gpt-5-mini')],
    ['anthropic', anthropic()('claude-sonnet-4-5')],
  ] as const;

  it('generateText and streamText for all three formats', async () => {
    for (const [label, model] of models()) {
      const g = await generateText({ model, prompt: 'hello there', maxRetries: 0 });
      expect(g.text, label).toBe(`Hello from the mock, ${label === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5-mini'}!`);
      expect(g.usage.inputTokens, label).toBeGreaterThan(0);
      expect(g.usage.outputTokens, label).toBeGreaterThan(0);
      const s = streamText({ model, prompt: 'hello stream', maxRetries: 0 });
      expect(await s.text, label).toContain('Hello from the mock');
      expect(await s.finishReason, label).toBe('stop');
    }
  });

  it('tool loop for all three formats', async () => {
    for (const [label, model] of models()) {
      const calls: unknown[] = [];
      const r = await generateText({
        model,
        prompt: 'What is 2 + 3?',
        maxRetries: 0,
        stopWhen: isStepCount(3),
        tools: {
          add: dynamicTool({
            description: 'Add two numbers',
            inputSchema: jsonSchema({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }),
            execute: async (input) => {
              calls.push(input);
              const { a, b } = input as { a: number; b: number };
              return String(a + b);
            },
          }),
        },
      });
      expect(calls, label).toEqual([{ a: 2, b: 3 }]);
      expect(r.text, label).toBe('The sum is 5.');
      expect(r.steps.length, label).toBe(2);
    }
  });

  it('embeddings (the SDK asks for float)', async () => {
    const e = await embed({ model: openai().embedding('text-embedding-3-small'), value: 'stubyard', maxRetries: 0 });
    expect(e.embedding).toHaveLength(1536);
  });

  it('SDK errors surface the provider error shape', async () => {
    await expect(generateText({ model: anthropic()('claude-sonnet-4-5'), prompt: 'nothing scripted', maxRetries: 0 })).rejects.toThrow(/No LLM mock/);
  });
});

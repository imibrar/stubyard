import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeAccess } from '../src/access/permissions.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { VERSION } from '../src/http/routes/api.js';
import { mcpToolAccess } from '../src/http/routes/mcp.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/**
 * Storyboard → Playwright spec (A1 part 2): GET /storyboards/:slug/export?format=playwright returns the spec as a
 * download, the MCP tool export_storyboard_playwright returns the same text, unknown storyboards are 404, and the route
 * and tool have the access of the other storyboard reads. (The generator itself: playwright-export.unit.test.ts.)
 */

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
let app: FastifyInstance;
let base: string;
let dataDir: string;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; headers: Headers; text: string }> {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const ok = async (method: string, p: string, body?: unknown, status = 200) => {
  const r = await api(method, p, body);
  expect(r.status, `${method} ${p}: ${r.text}`).toBe(status);
  return r;
};
let rpcId = 0;
const callTool = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return JSON.parse(r.text).result as { content: { type: string; text: string }[]; isError?: boolean };
};

const P = 'pwx';
const PB = `/api/projects/${P}`;
const ORIGIN = 'http://app.test:3184';

describe('storyboard Playwright export', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-pw-export-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    base = `http://127.0.0.1:${httpPort}`;
    await ok('POST', '/api/projects', { name: 'Playwright export', slug: P }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN] } });
    await ok('PUT', `${PB}/data-sets/signup`, { slug: 'signup', name: 'Sign-up', entries: [{ key: 'email', value: '{{user.email}}', kind: 'text' }, { key: 'plan', value: 'Gold', kind: 'radix-select' }] }, 201);
    await ok(
      'PUT',
      `${PB}/storyboards/signup`,
      {
        slug: 'signup',
        name: 'Sign up',
        actors: [{ key: 'participant', role: 'participant', fresh: true }],
        steps: [
          { id: 'open', kind: 'open', title: 'Open the register page', intent: 'Start registration', url: '/register' },
          { id: 'form', kind: 'fill', title: 'Fill the form', intent: 'Create the account', dataSet: 'signup' },
          { id: 'done', kind: 'check', title: 'Welcome', intent: 'See the welcome', expect: 'Welcome shows', assert: { textPresent: 'Welcome' } },
        ],
      },
      201,
    );
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET …/storyboards/:slug/export?format=playwright returns the spec as a download', async () => {
    const r = await ok('GET', `${PB}/storyboards/signup/export?format=playwright`);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="signup.spec.ts"');
    expect(r.text).toContain(`// Sign up: storyboard "signup" version 1 of project "${P}" as a Playwright test.`);
    expect(r.text).toContain(`// Exported from stubyard ${VERSION} on `);
    expect(r.text).toContain(`const APP_URL = process.env.APP_URL ?? "${ORIGIN}";`);
    expect(r.text).toContain(`project: "${P}"`);
    expect(r.text).toContain(`const RUNNER = { name: 'playwright-export', version: "${VERSION}" };`);
    expect(r.text).toContain('await run.step("form", "fill", "Fill the form", async (r) => {');
    // The data set's fields are explicit lines; its values are not in the file.
    expect(r.text).toContain('if ("email" in v) await field(form, r, "email").fill(str(v["email"]));');
    expect(r.text).toContain('// plan: radix-select. TODO');
    expect(r.text).not.toContain('{{user.email}}');
    expect(r.text).not.toContain('Gold');
    // format defaults to playwright; others are refused.
    expect((await ok('GET', `${PB}/storyboards/signup/export`)).text).toContain("from '@playwright/test'");
    const bad = await api('GET', `${PB}/storyboards/signup/export?format=cypress`);
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('supported: playwright');
  });

  it('keeps the bundle export at /storyboards/export', async () => {
    const r = await ok('GET', `${PB}/storyboards/export`);
    expect(JSON.parse(r.text)).toMatchObject({ format: 'stubyard-storyboards', storyboards: [{ slug: 'signup' }] });
  });

  it('answers 404 for an unknown storyboard or project', async () => {
    const r = await api('GET', `${PB}/storyboards/nope/export?format=playwright`);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text).error).toContain('Storyboard "nope" not found');
    expect((await api('GET', '/api/projects/nope/storyboards/signup/export?format=playwright')).status).toBe(404);
  });

  it('export_storyboard_playwright returns the same spec text; unknown storyboards fail', async () => {
    const res = await callTool('export_storyboard_playwright', { project: P, storyboard: 'signup' });
    expect(res.isError).toBeFalsy();
    const rest = (await ok('GET', `${PB}/storyboards/signup/export?format=playwright`)).text;
    // Same text up to the export time in the header.
    const noDate = (s: string) => s.replace(/ on \d{4}-\d\d-\d\dT[\d:.]+Z\./, '');
    expect(noDate(res.content[0].text)).toBe(noDate(rest));
    const missing = await callTool('export_storyboard_playwright', { project: P, storyboard: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/^stubyard answered 404: Storyboard "nope" not found/);
  });

  it('has the access of the other storyboard reads', () => {
    const read = routeAccess('GET', '/api/projects/:slug/storyboards/:key');
    expect(read).toMatchObject({ permission: 'project.view' });
    expect(routeAccess('GET', '/api/projects/:slug/storyboards/:key/export')).toEqual(read);
    expect(mcpToolAccess(app).get('export_storyboard_playwright')).toEqual(mcpToolAccess(app).get('get_storyboard'));
  });
});

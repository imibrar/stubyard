import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeAccess } from '../src/access/permissions.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { mcpToolAccess, staleCompositeRoutes } from '../src/http/routes/mcp.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import type { Run } from '../src/repos/runs.js';
import { renderVerdictJunit, xmlEscape } from '../src/runs/junit.js';
import type { RunVerdict } from '../src/runs/verdict.js';

// A2 slice S3: the verdict / JUnit routes, stop?settle=, and the check_run / set_run_expectations MCP tools.
// No Mailpit needed: SMS only (an in-memory hub like runs-verdict.e2e.test.ts).

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
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let close: () => Promise<void>;
let base: string;
let dataDir: string;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const isForm = body instanceof URLSearchParams;
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isForm ? body.toString() : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
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

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const P = '/api/projects/hyper';
const sms = (key: string, to: string, body: string) =>
  api('POST', `/run/${key}/mock/hyper/sms/2010-04-01/Accounts/ACtest/Messages.json`, new URLSearchParams({ To: to, From: '+15550001111', Body: body }));

let projectId = '';
const runOf = (key: string) => hub.runs.require(projectId, key);
const messagesIn = (run: Run) => (hub.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id = ?').get(run.id) as { n: number }).n;
const item = (v: RunVerdict, id: string) => v.items.find((i) => i.id === id)!;

async function startRun(key: string, extra: Record<string, unknown> = {}): Promise<{ run: Run; users: any[] }> {
  const r = await api('POST', `${P}/runs`, { key, users: [{ role: 'customer' }], ...extra });
  expect(r.status, r.text).toBe(201);
  return { run: runOf(key), users: r.body.users };
}

/** Parses XML strictly (any error or warning throws) and returns the document. */
function parseXml(xml: string) {
  return new DOMParser({
    onError: (level: string, msg: string) => {
      throw new Error(`XML ${level}: ${msg}`);
    },
  }).parseFromString(xml, 'text/xml');
}

async function mcp(name: string, args: Record<string, unknown>) {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.body.result as { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
}

describe('run verdict API, JUnit and MCP (A2 S3)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-verdict-api-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, callbackDelayMs: 100 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    hub.scheduler.start(30);
    close = async () => {
      await hub.scheduler.stop();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    const project = await api('POST', '/api/projects', { name: 'Hyper' });
    expect(project.status).toBe(201);
    projectId = project.body.id;
    expect((await api('POST', `${P}/providers`, { preset: 'twilio', slug: 'sms' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET verdict: live on an active run; assert=1 answers 200 on pass and 422 otherwise; bad settle / format are 400', async () => {
    const { users } = await startRun('a1', { expectations: [{ kind: 'message', channel: 'sms', to: 'customer', otp: true, count: 1 }] });
    expect((await sms('a1', users[0].phone, 'Your code is 482913')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('a1')) >= 1);

    const live = await api<RunVerdict>('GET', `${P}/runs/a1/verdict`);
    expect(live.status, live.text).toBe(200);
    expect(live.body).toMatchObject({ verdict: 'pass', frozen: false, run: { key: 'a1', status: 'active' } });
    expect(item(live.body, 'e1').status).toBe('pass');
    expect((await api('GET', `${P}/runs/a1/verdict?assert=1&settle=1`)).status).toBe(200);

    expect((await sms('a1', '+15550009999', 'Hello stranger')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('a1')) >= 2);
    const failed = await api<RunVerdict>('GET', `${P}/runs/a1/verdict?assert=1`);
    expect(failed.status).toBe(422);
    expect(failed.body.verdict).toBe('fail');
    expect(item(failed.body, 'default:unassignedMessages').status).toBe('fail');
    expect((await api('GET', `${P}/runs/a1/verdict`)).status).toBe(200); // no assert: 200 with the failing verdict

    expect((await api('GET', `${P}/runs/a1/verdict?settle=soon`)).status).toBe(400);
    expect((await api('GET', `${P}/runs/a1/verdict?settle=-1`)).status).toBe(400);
    expect((await api('GET', `${P}/runs/a1/verdict?format=yaml`)).status).toBe(400);
    expect((await api('GET', `${P}/runs/nope/verdict`)).status).toBe(404);
    await hub.runs.stop(runOf('a1'), { purge: true });
  });

  it('POST verdict: ad-hoc expectations (doc or bare array) are evaluated and not saved; invalid ones are 400 with the path', async () => {
    const { users } = await startRun('h1', { expectations: [{ kind: 'message', channel: 'sms', count: 1 }] });
    expect((await sms('h1', users[0].phone, 'One message')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('h1')) >= 1);
    const saved = (await api('GET', `${P}/runs/h1/expectations`)).body;

    const adhoc = await api<RunVerdict>('POST', `${P}/runs/h1/verdict`, { items: [{ kind: 'message', channel: 'sms', count: 3 }], defaults: false, settle: 0 });
    expect(adhoc.status, adhoc.text).toBe(200);
    expect(adhoc.body.verdict).toBe('fail');
    expect(adhoc.body.items.map((i) => [i.id, i.status])).toEqual([['e1', 'fail']]);
    expect(item(adhoc.body, 'e1').message).toContain('expected exactly 3');

    const bare = await api<RunVerdict>('POST', `${P}/runs/h1/verdict?assert=1`, [{ kind: 'message', channel: 'sms', count: 1 }]);
    expect(bare.status, bare.text).toBe(200);
    expect(bare.body.verdict).toBe('pass');
    expect((await api('POST', `${P}/runs/h1/verdict?assert=1`, { items: [{ kind: 'message', count: 0 }] })).status).toBe(422);

    const bad = await api('POST', `${P}/runs/h1/verdict`, { items: [{ kind: 'message' }, { kind: 'message', count: -1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.details.issues[0].path).toBe('items[1].count');

    // Nothing was saved.
    expect((await api('GET', `${P}/runs/h1/expectations`)).body).toEqual(saved);
    expect(runOf('h1').expectations).toEqual(saved);

    // Also on a stopped run (its data still there).
    await hub.runs.stop(runOf('h1'));
    const after = await api<RunVerdict>('POST', `${P}/runs/h1/verdict`, [{ kind: 'message', channel: 'sms', count: 2 }]);
    expect(after.status, after.text).toBe(200);
    expect(after.body).toMatchObject({ verdict: 'fail', run: { status: 'stopped' } });
    await hub.runs.purge(runOf('h1'));
  });

  it('stop?settle= waits for queued work, answers verdictUrl / junitUrl, and the frozen verdict is served after purge', async () => {
    const { users } = await startRun('s1', { expectations: [{ kind: 'message', channel: 'sms', status: 'delivered', count: 1 }] });
    expect((await api('POST', `${P}/users/customer/rules?run=s1`, { channel: 'sms', action: 'delay', delayMs: 600, count: 1 })).status).toBe(201);
    expect((await sms('s1', users[0].phone, 'Soon')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('s1')) >= 1);
    expect((await api<RunVerdict>('GET', `${P}/runs/s1/verdict`)).body.verdict).toBe('pending');

    const t0 = Date.now();
    const stopped = await api('POST', `${P}/runs/s1/stop?settle=5&purge=1`);
    expect(stopped.status, stopped.text).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    const runUrl = `${P}/runs/${stopped.body.run.id}`;
    expect(stopped.body).toMatchObject({ verdictUrl: `${runUrl}/verdict`, junitUrl: `${runUrl}/report.junit.xml`, reportHtmlUrl: `${runUrl}/report.html` });
    expect(stopped.body.report.verdict).toMatchObject({ verdict: 'pass', frozen: true });
    expect(stopped.body.run.verdict).toBe('pass');
    // The run row and the frozen report agree on the stop time.
    expect(stopped.body.run.stoppedAt).toBe(stopped.body.report.run.stoppedAt);
    expect(stopped.body.report.verdict.run.stoppedAt).toBe(stopped.body.run.stoppedAt);

    const frozen = await api<RunVerdict>('GET', stopped.body.verdictUrl);
    expect(frozen.status).toBe(200);
    expect(frozen.body).toEqual(stopped.body.report.verdict);
    expect((await api('GET', `${stopped.body.verdictUrl}?assert=1`)).status).toBe(200);
    const junit = await api('GET', stopped.body.junitUrl);
    expect(junit.status).toBe(200);
    expect(parseXml(junit.text).getElementsByTagName('testcase').length).toBe(frozen.body.items.length);

    // stop with a body settle on a run whose delivery is stuck: settle caps the wait, the verdict still freezes.
    await startRun('s2');
    expect((await api('POST', `${P}/runs/s2/stop`, { settle: 'later' })).status).toBe(400);
    expect(runOf('s2').status).toBe('active');
    expect((await api('POST', `${P}/runs/s2/stop`, { settle: 0, purge: true })).status).toBe(200);
  });

  it('JUnit: well-formed with escaping, failure / skipped / system-out per status, the download header and both paths', async () => {
    const tricky = `quote "x" & <y> 'z'\u0001`;
    const { users } = await startRun('j1', {
      expectations: [
        { name: tricky, kind: 'message', channel: 'sms', contains: 'a<b&"c"', count: 1 },
        { kind: 'message', channel: 'sms', count: 1 },
        { kind: 'message', channel: 'email', count: 1, severity: 'warn' },
      ],
    });
    expect((await sms('j1', users[0].phone, 'Plain text')).status).toBe(201);
    expect((await sms('j1', '+15550009999', 'Nobody <here> & "there"')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('j1')) >= 2);

    const r = await api('GET', `${P}/runs/j1/report.junit.xml?download=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="stubyard-run-j1.junit.xml"');
    expect(r.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(r.text).not.toContain('\u0001');

    const doc = parseXml(r.text);
    const suites = doc.getElementsByTagName('testsuite');
    expect(suites.length).toBe(1);
    expect(suites[0].getAttribute('name')).toBe('stubyard run j1 (hyper)');
    const cases = Array.from(doc.getElementsByTagName('testcase'));
    const v = (await api<RunVerdict>('GET', `${P}/runs/j1/verdict`)).body;
    expect(cases.length).toBe(v.items.length);
    expect(suites[0].getAttribute('tests')).toBe(String(v.items.length));
    expect(suites[0].getAttribute('failures')).toBe(String(v.counts.fail));
    const props = Object.fromEntries(Array.from(doc.getElementsByTagName('property')).map((p) => [p.getAttribute('name'), p.getAttribute('value')]));
    expect(props).toMatchObject({ 'run.key': 'j1', 'run.status': 'active', verdict: 'fail' });

    const first = cases[0];
    expect(first.getAttribute('name')).toBe(`quote "x" & <y> 'z'`);
    expect(first.getAttribute('classname')).toBe('stubyard.hyper.j1.message');
    const failure = first.getElementsByTagName('failure')[0];
    expect(failure.getAttribute('type')).toBe('expectation');
    expect(failure.getAttribute('message')).toContain('a<b&"c"');
    expect(cases[1].getElementsByTagName('failure').length).toBe(1); // 1 SMS to the customer + 1 unassigned: 2 SMS overall
    expect(item(v, 'e2')).toMatchObject({ status: 'fail', actual: 2 });
    expect(cases[2].getElementsByTagName('system-out')[0].textContent).toMatch(/^warning: /);
    const unassigned = cases.find((c) => c.getAttribute('name') === item(v, 'default:unassignedMessages').name)!;
    expect(unassigned.getAttribute('classname')).toBe('stubyard.hyper.j1.default');
    expect(unassigned.getElementsByTagName('failure')[0].textContent).toContain('+15550009999');

    // /junit is the same document; no download header without download=1.
    const alias = await api('GET', `${P}/runs/j1/junit`);
    expect(alias.status).toBe(200);
    expect(alias.headers.get('content-disposition')).toBeNull();
    expect(parseXml(alias.text).getElementsByTagName('testcase').length).toBe(cases.length);
    // verdict?format=junit with assert=1: 422 and still XML.
    const asserted = await api('GET', `${P}/runs/j1/verdict?format=junit&assert=1`);
    expect(asserted.status).toBe(422);
    expect(asserted.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    parseXml(asserted.text);
    await hub.runs.stop(runOf('j1'), { purge: true });
  });

  it('renderVerdictJunit: pending items are skipped; xmlEscape escapes the five characters and drops invalid ones', () => {
    expect(xmlEscape(`&<>"'\u0000\u001f￾ ok \u{1F600}`)).toBe('&amp;&lt;&gt;&quot;&apos; ok \u{1F600}');
    const v: RunVerdict = {
      run: { id: 'r1', key: 'k1', status: 'active', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: null },
      verdict: 'pending',
      summary: 'pending',
      counts: { pass: 1, fail: 0, warn: 0, pending: 1 },
      items: [
        { id: 'e1', name: 'waits', kind: 'message', source: 'declared', status: 'pending', expected: 'exactly 1', actual: 0, message: 'waiting', evidence: [] },
        { id: 'default:lintErrors', name: 'no lint errors', kind: 'lint', source: 'default', status: 'pass', expected: 'none', actual: 0, message: 'ok', evidence: [] },
      ],
      evaluatedAt: '2026-01-01T00:00:02.500Z',
      frozen: false,
      notes: ['a note'],
    };
    const doc = parseXml(renderVerdictJunit(v, { project: 'my shop' }));
    const suite = doc.getElementsByTagName('testsuite')[0];
    expect(suite.getAttribute('time')).toBe('2.500');
    expect(suite.getAttribute('skipped')).toBe('1');
    const cases = doc.getElementsByTagName('testcase');
    expect(cases[0].getElementsByTagName('skipped')[0].getAttribute('message')).toBe('waiting');
    expect(cases[1].getAttribute('classname')).toBe('stubyard.my_shop.k1.default');
    expect(cases[1].childNodes.length).toBe(0);
  });

  it('MCP: check_run (run’s own, ad hoc, junit, wait_seconds), set_run_expectations, start_run expectations, stop_run settle_seconds', async () => {
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as { name: string; inputSchema: any; annotations?: any }[];
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    expect(byName('check_run').annotations).toEqual({ readOnlyHint: true });
    expect(Object.keys(byName('start_run').inputSchema.properties)).toContain('expectations');
    expect(Object.keys(byName('stop_run').inputSchema.properties)).toContain('settle_seconds');

    const started = await mcp('start_run', { project: 'hyper', key: 'mc', users: [{ role: 'customer' }], expectations: [{ kind: 'message', channel: 'sms', count: 1 }] });
    expect(started.isError, started.content[0].text).toBeUndefined();
    expect(started.structuredContent.expectations).toEqual({ items: 1 });
    expect((await sms('mc', started.structuredContent.users[0].phone, 'Hi there')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('mc')) >= 1);

    const own = await mcp('check_run', { project: 'hyper', run: 'mc', wait_seconds: 1 });
    expect(own.isError).toBeUndefined();
    expect(own.structuredContent).toMatchObject({ verdict: 'pass', run: { key: 'mc' } });
    expect(own.structuredContent.items[0]).toMatchObject({ id: 'e1', status: 'pass' });

    const adhoc = await mcp('check_run', { project: 'hyper', run: 'mc', expectations: [{ kind: 'message', channel: 'sms', count: 2 }] });
    expect(adhoc.structuredContent.verdict).toBe('fail');
    expect(runOf('mc').expectations.items).toHaveLength(1); // ad hoc: nothing saved

    const junit = await mcp('check_run', { project: 'hyper', run: 'mc', junit: true });
    expect(junit.isError).toBeUndefined();
    expect(junit.structuredContent).toBeUndefined();
    expect(parseXml(junit.content[0].text).getElementsByTagName('testsuite')[0].getAttribute('name')).toBe('stubyard run mc (hyper)');

    const bad = await mcp('check_run', { project: 'hyper', run: 'mc', expectations: [{ kind: 'nope' }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^stubyard answered 400/);

    const appended = await mcp('set_run_expectations', { project: 'hyper', run: 'mc', items: [{ kind: 'message', channel: 'email', count: 0 }], append: true });
    expect(appended.isError, appended.content[0].text).toBeUndefined();
    expect(appended.structuredContent.items).toHaveLength(2);
    const replaced = await mcp('set_run_expectations', { project: 'hyper', run: 'mc', items: [{ kind: 'message', channel: 'sms', count: 3 }], defaults: false });
    expect(replaced.structuredContent).toEqual({ items: [{ kind: 'message', channel: 'sms', count: 3 }], defaults: false });
    const now = await mcp('check_run', { project: 'hyper', run: 'mc' });
    expect(now.structuredContent.verdict).toBe('fail');
    expect(now.structuredContent.items.map((i: any) => i.id)).toEqual(['e1']);

    const stopped = await mcp('stop_run', { project: 'hyper', run: 'mc', settle_seconds: 1, purge: true });
    expect(stopped.isError, stopped.content[0].text).toBeUndefined();
    expect(stopped.structuredContent).toMatchObject({ run: { status: 'stopped', verdict: 'fail' }, verdictUrl: expect.stringMatching(/\/verdict$/) });
    const frozen = await mcp('check_run', { project: 'hyper', run: 'mc' });
    expect(frozen.structuredContent).toMatchObject({ verdict: 'fail', frozen: true });
    expect((await mcp('set_run_expectations', { project: 'hyper', run: 'mc', items: [] })).isError).toBe(true); // 409 once stopped
  });

  it('access: the verdict routes read with project.view; check_run is read-only, set_run_expectations needs walkthroughs.run', () => {
    expect(routeAccess('GET', '/api/projects/:slug/runs/:run/verdict')).toEqual({ permission: 'project.view', scope: 'path' });
    expect(routeAccess('POST', '/api/projects/:slug/runs/:run/verdict')).toEqual({ permission: 'project.view', scope: 'path' });
    expect(routeAccess('GET', '/api/projects/:slug/runs/:run/report.junit.xml')).toEqual({ permission: 'project.view', scope: 'path' });
    expect(routeAccess('GET', '/api/projects/:slug/runs/:run/junit')).toEqual({ permission: 'project.view', scope: 'path' });
    expect(routeAccess('POST', '/api/projects/:slug/runs/:run/stop')).toMatchObject({ permission: 'walkthroughs.run' });
    const access = mcpToolAccess(app);
    const perm = (n: string) => (access.get(n) as { permission: string }).permission;
    expect(perm('check_run')).toBe('project.view');
    expect(perm('set_run_expectations')).toBe('walkthroughs.run');
    expect(perm('stop_run')).toBe('walkthroughs.run');
    expect(staleCompositeRoutes()).toEqual([]);
  });
});

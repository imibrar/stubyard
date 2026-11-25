import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allows, routeAccess } from '../src/access/permissions.js';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

/**
 * Agent runs (feature A1, part 1): a walkthrough with executor "agent" driven end to end through the MCP tools
 * start_walkthrough / resolve_step / report_step / finish_walkthrough, with an email the "app" sends over SMTP,
 * a failed step with a screenshot, the agent verdict vs a person's sign-off, the executor filter, and human runs
 * unchanged.
 */

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
const ok = async <T = any>(method: string, p: string, body?: unknown, status = 200): Promise<T> => {
  const r = await api<T>(method, p, body);
  expect(r.status, `${method} ${p}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};

let rpcId = 0;
const callTool = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.body.result as { content: { type: string; text: string }[]; isError?: boolean };
};
const mcp = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res = await callTool(name, args);
  expect(res.isError, `${name}: ${res.content[0].text}`).toBeFalsy();
  return JSON.parse(res.content[0].text);
};
const mcpError = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await callTool(name, args);
  expect(res.isError, `${name} should fail`).toBe(true);
  return res.content[0].text;
};

const mailer = () => nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true });

const P = 'agent';
const PB = `/api/projects/${P}`;
const W = `${PB}/walkthroughs`;
const ORIGIN = 'http://app.test:3184';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const upsert = async (p: string, input: unknown) => ok('PUT', p, input, (await api('GET', p)).status === 200 ? 200 : 201);

const SIGNUP = {
  slug: 'signup',
  name: 'Sign up and confirm',
  inputs: [{ name: 'event', label: 'Event code', required: true }],
  actors: [
    { key: 'participant', role: 'participant', fresh: true },
    { key: 'admin', role: 'admin' },
  ],
  steps: [
    { id: 'open', kind: 'open', title: 'Open the register page', intent: 'Start registration', url: '/register/{{vars.event}}' },
    { id: 'form', kind: 'fill', title: 'Fill the sign-up form', intent: 'Create the account', dataSet: 'signup' },
    { id: 'confirm', kind: 'email', actor: 'participant', title: 'Confirm the email', intent: 'Open the link', match: { subject: 'Confirm' }, link: { pattern: '/confirm' } },
    { id: 'regno', kind: 'capture', title: 'Note the registration number', intent: 'Capture it', var: 'regNo', textPattern: 'Registration number: (\\S+)' },
    { id: 'admin-login', kind: 'login', actor: 'admin', title: 'Admin login', intent: 'Sign in as admin' },
    { id: 'find', kind: 'check', title: 'Find the registration', intent: 'Look up {{vars.regNo}}', expect: 'The registration is listed', assert: { textPresent: '{{vars.regNo}}' } },
    { id: 'bye', kind: 'logout', title: 'Log out', intent: 'End the session' },
  ],
};

describe.skipIf(!haveMailpit)('agent walkthroughs', () => {
  let admin: any;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-wt-agent-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      apnsPort: 0,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    await ok('POST', '/api/projects', { name: 'Agent runs', slug: P, generateUsers: { admins: 1 } }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN] } });
    admin = await ok('GET', `${PB}/users/admin`);
    await ok('POST', `${PB}/authenticators`, { label: 'Admin 2FA', secret: 'JBSWY3DPEHPK3PXP', testUserId: admin.id }, 201);
    await upsert(`${PB}/login-recipes/participant`, { role: 'participant', loginUrl: '/login' });
    await upsert(`${PB}/login-recipes/admin`, { role: 'admin', loginUrl: '/staff/login', twoFactor: { kind: 'totp' } });
    await upsert(`${PB}/data-sets/signup`, {
      slug: 'signup',
      name: 'Sign-up',
      match: { urlPattern: '/register/**' },
      entries: [
        { key: 'email', value: '{{user.email}}' },
        { key: 'event', value: '{{vars.event}}' },
      ],
    });
    await upsert(`${PB}/storyboards/signup`, SIGNUP);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the agent-run tools, each needing a project', async () => {
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })).body.result.tools as { name: string; inputSchema: any }[];
    for (const n of ['start_walkthrough', 'resolve_step', 'report_step', 'finish_walkthrough']) {
      const t = tools.find((x) => x.name === n);
      expect(t, n).toBeTruthy();
      expect(t!.inputSchema.required).toContain('project');
    }
    expect(tools.find((x) => x.name === 'report_step')!.inputSchema.properties.status.enum).toEqual(['done', 'failed', 'skipped']);
  });

  it('runs a storyboard through MCP: start, fill, email link, capture, TOTP login, failed step with a screenshot, finish fail', async () => {
    const start = await mcp('start_walkthrough', { project: P, storyboard: 'signup', label: 'agent pilot', inputs: { event: 'E1' }, runner: { name: 'playwright-mcp', version: '1.2' } });
    expect(start).toMatchObject({ status: 'active', mode: 'tracked', executor: 'agent', runner: { name: 'playwright-mcp', version: '1.2' }, currentStepId: 'open', origin: ORIGIN, vars: { event: 'E1' } });
    expect(start.steps.map((s: any) => s.id)).toEqual(['open', 'form', 'confirm', 'regno', 'admin-login', 'find', 'bye']);
    const part = start.actors.participant;
    // The agent logs in itself: actors come with their passwords.
    expect(part).toMatchObject({ created: true, role: 'participant', email: `participant.${start.key}@agent.test`, password: 'Password123!' });
    expect(start.step).toMatchObject({ step: { id: 'open', kind: 'open' }, url: `${ORIGIN}/register/E1`, text: { intent: 'Start registration' } });
    expect(start.step.todo).toMatch(/Open `url`/);
    expect(start.step.report).toContain('report_step');
    const wt = start.key as string;

    // open → done: the next step (fill) comes back resolved.
    const r1 = await mcp('report_step', { project: P, walkthrough: wt, step: 'open', status: 'done' });
    expect(r1.walkthrough).toMatchObject({ currentStepId: 'form', counts: { done: 1 } });
    expect(r1.next).toMatchObject({ step: { id: 'form', kind: 'fill' }, dataSet: { slug: 'signup' } });
    expect(Object.fromEntries(r1.next.entries.map((e: any) => [e.key, e.value]))).toEqual({ email: part.email, event: 'E1' });

    // fill → done; the email step is returned without waiting.
    const r2 = await mcp('report_step', { project: P, walkthrough: wt, step: 'form', status: 'done', data: { filled: 2 } });
    expect(r2.next).toMatchObject({ step: { id: 'confirm', kind: 'email' }, channel: 'email', message: null, code: null, link: null });

    // The app sends the confirmation mail (code and link); resolve_step waits for it and picks the link.
    await mailer().sendMail({ from: 'noreply@app.test', to: part.email, subject: 'Confirm your account', text: `Your code is 482913. Confirm: ${ORIGIN}/confirm?t=abc or ${ORIGIN}/unsubscribe` });
    const email = await mcp('resolve_step', { project: P, walkthrough: wt, wait_seconds: 10 });
    expect(email).toMatchObject({ step: { id: 'confirm' }, link: `${ORIGIN}/confirm?t=abc`, code: '482913', message: { subject: 'Confirm your account', otp: '482913' } });
    expect(email.message.links).toContain(`${ORIGIN}/confirm?t=abc`);
    // What arrived is recorded on the step, as the extension does.
    const afterEmail = await ok('GET', `${W}/${wt}`);
    expect(afterEmail.steps[2].data).toMatchObject({ messageId: email.message.id, subject: 'Confirm your account', link: `${ORIGIN}/confirm?t=abc` });

    const r3 = await mcp('report_step', { project: P, walkthrough: wt, step: 'confirm', status: 'done' });
    expect(r3.next).toMatchObject({ step: { id: 'regno', kind: 'capture' }, var: 'regNo' });
    expect(r3.next.report).toContain('value');

    // capture → the value becomes a var; the TOTP login comes with a current code.
    const r4 = await mcp('report_step', { project: P, walkthrough: wt, step: 'regno', status: 'done', value: 'E1-R-0042' });
    expect(r4.next).toMatchObject({ step: { id: 'admin-login', kind: 'login' }, username: admin.email, password: 'Password123!', url: `${ORIGIN}/staff/login`, twoFactor: { kind: 'totp', label: 'Admin 2FA' } });
    expect(r4.next.twoFactor.code).toMatch(/^\d{6}$/);
    expect(typeof r4.next.twoFactor.remaining).toBe('number');

    const r5 = await mcp('report_step', { project: P, walkthrough: wt, step: 'admin-login', status: 'done' });
    expect(r5.next).toMatchObject({ step: { id: 'find', kind: 'check' }, text: { intent: 'Look up E1-R-0042' }, assert: { textPresent: 'E1-R-0042' } });

    // check → failed, with a note and a screenshot.
    const r6 = await mcp('report_step', { project: P, walkthrough: wt, step: 'find', status: 'failed', note: 'not listed', screenshot: png });
    expect(r6.reported).toMatchObject({ step: 'find', status: 'failed', screenshot: { bytes: expect.any(Number) } });
    expect(r6.warnings).toEqual([]);
    expect(r6.next).toMatchObject({ step: { id: 'bye', kind: 'logout' } });
    const failed = (await ok('GET', `${W}/${wt}`)).steps.find((s: any) => s.id === 'find');
    expect(failed).toMatchObject({ status: 'failed', note: 'not listed' });
    expect(failed.shots).toHaveLength(1);

    // A bad status names the step statuses; an incomplete finish without allowIncomplete lists the open step.
    expect(await mcpError('report_step', { project: P, walkthrough: wt, step: 'bye', status: 'passed' })).toMatch(/done, failed, skipped/);
    expect(await mcpError('finish_walkthrough', { project: P, walkthrough: wt })).toMatch(/409.*bye/s);

    // finish: the default verdict follows the results (a failed step → fail); it is the agent's, not a sign-off.
    const fin = await mcp('finish_walkthrough', { project: P, walkthrough: wt, note: 'check failed', allowIncomplete: true });
    expect(fin).toMatchObject({ status: 'finished', executor: 'agent', signoff: { verdict: 'fail', verdictBy: 'agent', signedOffBy: null, signedOffAt: null, note: 'check failed' } });
    expect(fin.counts).toMatchObject({ done: 5, failed: 1, skipped: 1 });

    const sum = await mcp('get_walkthrough_result', { project: P, id: wt });
    expect(sum.walkthrough).toMatchObject({ executor: 'agent', runner: { name: 'playwright-mcp', version: '1.2' }, verdict: 'fail' });
    expect(sum.actors.participant.password).toBe('***');
    expect((await api('GET', `${W}/${wt}/summary.html`)).body).toContain('agent (playwright-mcp 1.2)');

    // A person signs it off later (REST, from the dashboard): verdictBy human; only once.
    expect((await api('POST', `${W}/${wt}/signoff`, {})).status).toBe(400);
    const signed = await ok('POST', `${W}/${wt}/signoff`, { signedOffBy: 'QA Lead', note: 'confirmed the bug' });
    expect(signed.signoff).toMatchObject({ verdict: 'fail', verdictBy: 'human', signedOffBy: 'QA Lead', note: 'confirmed the bug' });
    expect(signed.signoff.signedOffAt).toBeTruthy();
    expect((await api('POST', `${W}/${wt}/signoff`, { signedOffBy: 'Other' })).status).toBe(409);
  });

  it('resolve_step without a step after the last report says to finish; finished runs refuse it', async () => {
    const start = await mcp('start_walkthrough', { project: P, storyboard: 'signup', inputs: { event: 'E2' } });
    expect(start.runner).toBeNull();
    for (const id of ['open', 'form', 'confirm', 'regno', 'admin-login', 'find']) await mcp('report_step', { project: P, walkthrough: start.id, step: id, status: 'skipped' });
    const last = await mcp('report_step', { project: P, walkthrough: start.id, step: 'bye', status: 'done' });
    expect(last).toMatchObject({ next: null, done: true });
    expect((await mcp('resolve_step', { project: P, walkthrough: start.id })).done).toBe(true);
    const fin = await mcp('finish_walkthrough', { project: P, walkthrough: start.id, verdict: 'pass' });
    expect(fin.signoff).toMatchObject({ verdict: 'pass', verdictBy: 'agent', signedOffBy: null });
    expect(await mcpError('resolve_step', { project: P, walkthrough: start.id })).toMatch(/finished/);
  });

  it('REST: executor and runner validation; an agent finish takes no signedOffBy', async () => {
    expect((await api('POST', W, { storyboard: 'signup', vars: { event: 'X' }, executor: 'robot' })).status).toBe(400);
    expect((await api('POST', W, { storyboard: 'signup', vars: { event: 'X' }, runner: { name: 'x' } })).status).toBe(400); // runner without executor agent
    expect((await api('POST', W, { storyboard: 'signup', vars: { event: 'X' }, executor: 'agent', runner: { name: '' } })).status).toBe(400);
    const v = await ok('POST', W, { storyboard: 'signup', vars: { event: 'X' }, executor: 'agent', runner: { name: 'script' } }, 201);
    expect(v).toMatchObject({ executor: 'agent', runner: { name: 'script', version: null }, recording: { mode: 'off' } });
    const signed = await api('POST', `${W}/${v.id}/finish`, { verdict: 'pass', signedOffBy: 'me', allowIncomplete: true });
    expect(signed.status).toBe(400);
    expect(signed.body.error).toMatch(/signs it off later/);
    expect((await api('POST', `${W}/${v.id}/finish`, { allowIncomplete: true })).status).toBe(400); // tracked: a verdict is required
    // Still active: no sign-off yet.
    expect((await api('POST', `${W}/${v.id}/signoff`, { signedOffBy: 'QA' })).status).toBe(409);
    // A refresh keeps the runner.
    expect((await ok('POST', `${W}/${v.id}/refresh`, {})).runner).toEqual({ name: 'script', version: null });
    await ok('POST', `${W}/${v.id}/abandon`, {});
  });

  it('human runs are unchanged; the list filters by executor', async () => {
    const h = await ok('POST', W, { storyboard: 'signup', vars: { event: 'H' } }, 201);
    expect(h).toMatchObject({ executor: 'human', runner: null });
    expect((await api('POST', `${W}/${h.id}/finish`, { verdict: 'pass', allowIncomplete: true })).status).toBe(400); // signedOffBy required
    const fin = await ok('POST', `${W}/${h.id}/finish`, { verdict: 'pass', signedOffBy: 'QA', allowIncomplete: true });
    expect(fin.signoff).toMatchObject({ verdict: 'pass', verdictBy: 'human', signedOffBy: 'QA' });
    expect((await api('POST', `${W}/${h.id}/signoff`, { signedOffBy: 'QA' })).status).toBe(409); // human runs sign off at finish

    const all = (await ok('GET', W)) as any[];
    const agents = (await ok('GET', `${W}?executor=agent`)) as any[];
    const humans = (await ok('GET', `${W}?executor=human`)) as any[];
    expect(agents.length).toBeGreaterThanOrEqual(3);
    expect(agents.every((w) => w.executor === 'agent')).toBe(true);
    expect(humans.map((w) => w.id)).toEqual([h.id]);
    expect(agents.length + humans.length).toBe(all.length);
    expect(agents.find((w) => w.runner?.name === 'playwright-mcp')).toBeTruthy();
    expect((await api('GET', `${W}?executor=robot`)).status).toBe(400);
    const viaMcp = (await mcp('list_walkthroughs', { project: P, executor: 'human' })) as any[];
    expect(viaMcp.map((w) => w.id)).toEqual([h.id]);
  });

  it('access: the agent-run calls need walkthroughs.run (not a viewer), like a human run', () => {
    const B = '/api/projects/:slug/walkthroughs';
    for (const [m, r] of [
      ['POST', B],
      ['POST', `${B}/:id/steps/:stepId/resolve`],
      ['PATCH', `${B}/:id/steps/:stepId`],
      ['POST', `${B}/:id/steps/:stepId/shots`],
      ['POST', `${B}/:id/finish`],
      ['POST', `${B}/:id/signoff`],
    ] as const) {
      expect(routeAccess(m, r), `${m} ${r}`).toMatchObject({ permission: 'walkthroughs.run' });
    }
    for (const role of ['admin', 'project_admin', 'project_manager', 'developer', 'qa'] as const) expect(allows(role, 'walkthroughs.run'), role).toBe(true);
    for (const role of ['viewer', 'designer'] as const) expect(allows(role, 'walkthroughs.run'), role).toBe(false);
  });
});

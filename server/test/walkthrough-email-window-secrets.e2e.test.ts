import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { looksSecret, maskVars, secretVarNames } from '../src/storyboards/secrets.js';

/**
 * Agent e2e kit gaps 3 and 11 (docs/plans/agent-e2e-kit.md §2):
 * 3. an email step's default window starts at the last earlier step that is not a check (a check between the action
 *    that sends the mail and the email step no longer hides it); explicit `since` wins; email_after_check warning.
 * 11. secret walkthrough vars (capture.secret, or a secret-looking name / value) are masked in summaries; the view
 *    lists them in secretVars and keeps the raw value for the steps that use it.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const P = 'wsec';
const PB = `/api/projects/${P}`;
const W = `${PB}/walkthroughs`;
const ORIGIN = 'http://app.test:3183';

const CHECKED = {
  name: 'Submit, check, then mail',
  actors: [{ key: 'participant', role: 'participant', fresh: true }],
  steps: [
    { id: 'open', kind: 'open', title: 'Open', intent: 'Open the form', url: '/register' },
    { id: 'submit', kind: 'instruction', title: 'Submit', intent: 'Submit the form (the app sends the mail)' },
    { id: 'verify', kind: 'check', title: 'Thank-you page', intent: 'Look at the page', expect: 'Thanks is shown' },
    { id: 'mail', kind: 'email', actor: 'participant', title: 'Confirm', intent: 'The confirmation', match: { subject: 'Confirm' }, open: 'none' },
    { id: 'mail-again', kind: 'email', actor: 'participant', title: 'Again', intent: 'Explicit since', match: { subject: 'Confirm' }, open: 'none', since: 'open' },
  ],
};

const SECRETS = {
  name: 'Captured secrets',
  actors: [{ key: 'participant', role: 'participant', fresh: true }],
  steps: [
    { id: 'seed', kind: 'capture', title: 'Seed', intent: 'Flagged secret', var: 'seed', selector: '#seed', secret: true },
    { id: 'totp', kind: 'capture', title: 'TOTP key', intent: 'Secret by name', var: 'totpSecret', selector: '#totp' },
    { id: 'key', kind: 'capture', title: 'Key', intent: 'Base32 value', var: 'enrolKey', selector: '#key' },
    { id: 'uri', kind: 'capture', title: 'URI', intent: 'otpauth value', var: 'qr', selector: '#qr' },
    { id: 'regno', kind: 'capture', title: 'Reg no', intent: 'Not secret', var: 'regNo', selector: '#reg' },
    { id: 'use', kind: 'check', title: 'Use it', intent: 'Runner needs the raw value', expect: 'Seed shown', assert: { textPresent: '{{vars.seed}}' } },
  ],
};

describe('secret var detection', () => {
  it('flags names, otpauth URIs and base32 keys; not ordinary values', () => {
    for (const n of ['totpSecret', 'password', 'apiToken', 'otpKey', 'otp_key', 'OTPKEY']) expect(looksSecret(n, 'x'), n).toBe(true);
    expect(looksSecret('qr', 'otpauth://totp/App:me?secret=JBSWY3DPEHPK3PXP')).toBe(true);
    expect(looksSecret('k', 'JBSWY3DPEHPK3PXP')).toBe(true);
    expect(looksSecret('k', 'JBSW Y3DP EHPK 3PXP')).toBe(true);
    expect(looksSecret('k', 'JBSWY3DPEHPK3PXP====')).toBe(true);
    expect(looksSecret('k', 'JBSWY3DPEHPK3PX')).toBe(false); // 15 chars
    expect(looksSecret('regNo', 'HCE27-R-00435')).toBe(false);
    expect(looksSecret('k', 'jbswy3dpehpk3pxp')).toBe(false); // base32 keys are upper case
    expect(looksSecret('k', undefined)).toBe(false);
  });

  it('secretVarNames adds capture.secret; maskVars masks only those', () => {
    const steps = SECRETS.steps as any;
    const vars = { seed: 'abc', totpSecret: 'x', regNo: 'R-1' };
    expect(secretVarNames(steps, vars)).toEqual(['seed', 'totpSecret']);
    expect(maskVars(vars, ['seed', 'totpSecret'])).toEqual({ seed: '***', totpSecret: '***', regNo: 'R-1' });
  });
});

describe.skipIf(!haveMailpit)('walkthrough email window and secret vars', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-wsec-'));
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
    await ok('POST', '/api/projects', { name: 'Window and secrets', slug: P }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN] } });
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('warns email_after_check for an email step right after a check without since', async () => {
    const res = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...CHECKED } });
    expect(res.errors).toEqual([]);
    const w = res.warnings.filter((x: any) => x.code === 'email_after_check');
    expect(w).toEqual([expect.objectContaining({ path: 'steps[3]', code: 'email_after_check', expected: ['submit'] })]);
    expect(w[0].message).toContain('since');
    // With since: no warning.
    const withSince = { ...CHECKED, steps: CHECKED.steps.map((s) => (s.id === 'mail' ? { ...s, since: 'submit' } : s)) };
    const res2 = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...withSince } });
    expect(res2.warnings.map((x: any) => x.code)).not.toContain('email_after_check');
  });

  it('action → check → email: the window starts at the action, so the mail sent before the check is seen; since wins', async () => {
    await ok('PUT', `${PB}/storyboards/checked`, { slug: 'checked', ...CHECKED }, 201);
    const v = await ok('POST', W, { storyboard: 'checked', origin: ORIGIN }, 201);
    const R = (step: string) => ok('POST', `${W}/${v.id}/steps/${step}/resolve`, {});
    const done = (step: string) => ok('PATCH', `${W}/${v.id}/steps/${step}`, { status: 'done' });
    const to = v.actors.participant.email as string;
    const user = v.actors.participant.userId as string;
    await R('open');
    await done('open');
    await sleep(30);
    await R('submit');
    await sleep(30);
    // The action sends the mail; it arrives before the check step starts.
    await nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true }).sendMail({ from: 'noreply@app.test', to, subject: 'Confirm your registration', text: 'Thanks.' });
    for (let i = 0; i < 100; i++) {
      if ((await ok('GET', `${PB}/messages?user=${user}&channel=email`)).length) break;
      await sleep(50);
    }
    await done('submit');
    await sleep(30);
    await R('verify');
    await done('verify');
    await sleep(30);

    const view = await ok('GET', `${W}/${v.id}`);
    const started = (id: string) => view.steps.find((s: any) => s.id === id).startedAt as string;
    const mail = await R('mail');
    const since = new URL(mail.waitPath, base).searchParams.get('since');
    expect(since).toBe(started('submit'));
    expect(since).not.toBe(started('verify'));
    expect((await ok('GET', mail.waitPath.replace('/messages/wait', '/messages'))).map((m: any) => m.subject)).toContain('Confirm your registration');
    expect((await ok('GET', mail.waitPath)).subject).toBe('Confirm your registration');
    await done('mail');

    // An explicit since still wins over the default.
    const again = await R('mail-again');
    expect(new URL(again.waitPath, base).searchParams.get('since')).toBe(started('open'));
  });

  it('secret vars: listed in secretVars, raw in the view and resolve, masked in summary JSON and HTML', async () => {
    await ok('PUT', `${PB}/storyboards/secrets`, { slug: 'secrets', ...SECRETS }, 201);
    const v = await ok('POST', W, { storyboard: 'secrets', origin: ORIGIN }, 201);
    const values: Record<string, [string, string]> = {
      seed: ['seed', 'plain-seed-value'],
      totp: ['totpSecret', 'abc123'],
      key: ['enrolKey', 'JBSWY3DPEHPK3PXP'],
      uri: ['qr', 'otpauth://totp/App:me?secret=JBSWY3DPEHPK3PXQ'],
      regno: ['regNo', 'HCE27-R-00435'],
    };
    for (const [step, [, value]] of Object.entries(values)) {
      await ok('POST', `${W}/${v.id}/steps/${step}/resolve`, {});
      await ok('PATCH', `${W}/${v.id}/steps/${step}`, { status: 'done', value });
    }

    const view = await ok('GET', `${W}/${v.id}`);
    expect(view.secretVars).toEqual(['enrolKey', 'qr', 'seed', 'totpSecret']);
    expect(view.vars).toMatchObject({ seed: 'plain-seed-value', totpSecret: 'abc123', regNo: 'HCE27-R-00435' });
    // Runners still get the raw value.
    const use = await ok('POST', `${W}/${v.id}/steps/use/resolve`, {});
    expect(use.assert.textPresent).toBe('plain-seed-value');

    const sum = await ok('GET', `${W}/${v.id}/summary`);
    expect(sum.vars).toEqual({ seed: '***', totpSecret: '***', enrolKey: '***', qr: '***', regNo: 'HCE27-R-00435' });
    const data = Object.fromEntries(sum.steps.map((s: any) => [s.id, s.data.value]));
    expect(data).toMatchObject({ seed: '***', totp: '***', key: '***', uri: '***', regno: 'HCE27-R-00435' });

    const html = (await api<string>('GET', `${W}/${v.id}/summary.html`)).body;
    for (const [name, [, value]] of Object.entries(values)) {
      if (name === 'regno') expect(html).toContain(value);
      else expect(html, name).not.toContain(value.replace(/&/g, '&amp;'));
    }
    expect(html).not.toContain('JBSWY3DPEHPK3PXQ');
  });
});

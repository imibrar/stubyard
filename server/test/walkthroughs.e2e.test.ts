import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Hub } from '../src/hub.js';
import { startHub, type RunningHub } from '../src/index.js';
import type { WalkthroughServiceImpl } from '../src/storyboards/walkthroughs.js';

/**
 * Walkthroughs (docs/design/storyboards.md §3.7, Slice 2) end to end: a full hub with Mailpit and the SMTP front, so
 * an email step's waitPath sees a mail the "app" sends to the fresh actor over SMTP.
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
let hub: Hub;
let base: string;
let dataDir: string;
let smtpPort: number;

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let parsed: unknown = buf;
  if (!/^image\//.test(r.headers.get('content-type') ?? '')) {
    parsed = buf.toString('utf8');
    try {
      parsed = JSON.parse(parsed as string);
    } catch {
      /* text */
    }
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

const ok = async <T = any>(method: string, p: string, body?: unknown, status = 200): Promise<T> => {
  const r = await api<T>(method, p, body);
  expect(r.status, `${method} ${p}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};

const mailer = () => nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true });

const P = 'wt';
const PB = `/api/projects/${P}`;
const W = `${PB}/walkthroughs`;
const ORIGIN = 'http://app.test:3183';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const png = `data:image/png;base64,${PNG_1PX}`;

// --- Authoring data through Slice 1's REST routes (PUT is an upsert: 201 when new, 200 after) ---
const upsert = async (p: string, input: unknown) => ok('PUT', p, input, (await api('GET', p)).status === 200 ? 200 : 201);
const putRecipe = (role: string, input: unknown) => upsert(`${PB}/login-recipes/${role}`, input);
const putDataSet = (slug: string, input: unknown) => upsert(`${PB}/data-sets/${slug}`, input);
const putStoryboard = (slug: string, input: unknown) => upsert(`${PB}/storyboards/${slug}`, input);

const REGISTER = {
  name: 'Event registration',
  inputs: [{ name: 'event', label: 'Event code', required: true }, { name: 'track', label: 'Track', default: 'main' }],
  actors: [
    { key: 'participant', role: 'participant', fresh: true },
    { key: 'admin', role: 'admin' },
  ],
  steps: [
    { id: 'open', kind: 'open', title: 'Open the register page', intent: 'Start registration', url: '/register/{{vars.event}}?u={{unique}}' },
    { id: 'signup', kind: 'fill', title: 'Fill the sign-up form', intent: 'Create the account', dataSet: 'signup' },
    { id: 'confirm', kind: 'email', actor: 'participant', title: 'Confirm the email', intent: 'Open the link', match: { subject: 'Confirm', text: '{{vars.event}}' }, link: { pattern: '/confirm' } },
    { id: 'regno', kind: 'capture', title: 'Note the registration number', intent: 'Capture it', var: 'regNo', textPattern: 'Registration number: (\\S+)' },
    { id: 'admin-login', kind: 'login', actor: 'admin', title: 'Admin login', intent: 'Sign in as admin' },
    { id: 'find', kind: 'check', title: 'Find the registration', intent: 'Look up {{vars.regNo}}', expect: 'The registration is listed', assert: { textPresent: '{{vars.regNo}}' } },
    { id: 'tour', kind: 'instruction', title: 'Look around', intent: 'Optional', optional: true },
    { id: 'bye', kind: 'logout', title: 'Log out', intent: 'End the session' },
  ],
};

describe.skipIf(!haveMailpit)('walkthroughs', () => {
  let admin: any;
  let customer: any;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-walkthroughs-'));
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
    hub = running.hub;
    base = `http://127.0.0.1:${httpPort}`;
    await ok('POST', '/api/projects', { name: 'Walkthroughs', slug: P, generateUsers: { admins: 1, customers: 2 } }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN] } });
    admin = await ok('GET', `${PB}/users/admin`);
    customer = await ok('GET', `${PB}/users/customer`);
    await ok('POST', `${PB}/authenticators`, { label: 'Admin 2FA', secret: 'JBSWY3DPEHPK3PXP', testUserId: admin.id }, 201);

    await putRecipe('participant', { role: 'participant', loginUrl: '/auth/person/login', logoutUrl: '/logout' });
    await putRecipe('admin', { role: 'admin', loginUrl: '/auth/staff/login', fields: { submit: 'button[type=submit]' }, twoFactor: { kind: 'totp' } });
    await putRecipe('customer', { role: 'customer', loginUrl: '{{app.origin}}/login', twoFactor: { kind: 'email-otp', selector: '#otp', subject: 'code' } });
    await putDataSet('signup', {
      slug: 'signup',
      name: 'Sign-up',
      match: { urlPattern: '/register/**', formId: 'signup-form' },
      entries: [
        { key: 'email', value: '{{user.email}}' },
        { key: 'firstName', value: '{{fake.firstName}}' },
        { key: 'phone', value: '{{fake.phone}}' },
        { key: 'ref', value: 'REF-{{fake.digits:6}}' },
        { key: 'terms', value: true, kind: 'checkbox' },
        { key: 'interests', value: ['{{vars.track}}', 'news'] },
      ],
    });
    await putStoryboard('register', { slug: 'register', ...REGISTER });
    await putStoryboard('otp-login', {
      slug: 'otp-login',
      name: 'Customer login with an emailed code',
      actors: [{ key: 'buyer', role: 'customer' }],
      steps: [{ id: 'in', kind: 'login', actor: 'buyer', title: 'Log in', intent: 'Sign in with the emailed code' }],
    });
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('start: required inputs (400), unknown storyboard (404), unknown actor override (400)', async () => {
    const missing = await api('POST', W, { storyboard: 'register' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('event');
    expect(missing.body.details.missing).toEqual(['event']);
    expect((await api('POST', W, { storyboard: 'register', vars: { event: '  ' } })).status).toBe(400);
    expect((await api('POST', W, {})).status).toBe(400);
    expect((await api('POST', W, { storyboard: 'nope', vars: { event: 'X' } })).status).toBe(404);
    expect((await api('POST', W, { storyboard: 'register', vars: { event: 'X' }, actors: { ghost: 'admin' } })).status).toBe(400);
    expect((await api('POST', W, { storyboard: 'register', vars: { event: 'X' }, actors: { admin: 'nobody@nowhere.test' } })).status).toBe(400);
    expect((await api('POST', W, { storyboard: 'register', vars: { event: 1 } })).status).toBe(400);
    // Nothing was created by the failed starts.
    expect(await ok('GET', W)).toEqual([]);
    expect(((await ok('GET', `${PB}/users`)) as any[]).some((u) => u.role === 'participant')).toBe(false);
  });

  it('runs a walkthrough: fresh + existing actors, resolve per kind, captures, SMTP email, TOTP, finish rules', async () => {
    const v = await ok('POST', W, { storyboard: 'register', vars: { event: 'HCE27' }, label: 'pilot' }, 201);
    expect(v).toMatchObject({ label: 'pilot', status: 'active', executor: 'human', origin: ORIGIN, currentStepId: 'open', vars: { event: 'HCE27', track: 'main' } });
    expect(v.key).toMatch(/^[a-z0-9]{6}$/);
    expect(v.storyboard).toMatchObject({ slug: 'register', name: 'Event registration', version: 1 });
    expect(v.steps.map((s: any) => s.id)).toEqual(['open', 'signup', 'confirm', 'regno', 'admin-login', 'find', 'tour', 'bye']);
    expect(v.counts).toEqual({ pending: 8, active: 0, done: 0, skipped: 0, failed: 0 });
    const part = v.actors.participant;
    expect(part).toMatchObject({ created: true, role: 'participant', email: `participant.${v.key}@wt.test`, password: 'Password123!' });
    expect(part.phone).toMatch(/^\+92300\d{7}$/);
    expect(part.name).toMatch(/^\S+ \S+$/);
    expect(v.actors.admin).toMatchObject({ created: false, userId: admin.id, email: admin.email });
    const fresh = await ok('GET', `${PB}/users/${part.userId}`);
    expect(fresh.notes).toBe(`Created by walkthrough ${v.key} (register)`);
    expect(fresh.runId).toBeNull();
    // By key too.
    expect((await ok('GET', `${W}/${v.key}`)).id).toBe(v.id);
    const R = (step: string) => ok('POST', `${W}/${v.id}/steps/${step}/resolve`, {});

    // open: relative URL gets the walkthrough origin; the step becomes active.
    const open = await R('open');
    expect(open).toMatchObject({ url: `${ORIGIN}/register/HCE27?u=${v.key}`, actor: { key: 'participant', userId: part.userId }, warnings: [] });
    const afterOpen = await ok('GET', `${W}/${v.id}`);
    expect(afterOpen.steps[0]).toMatchObject({ status: 'active' });
    expect(afterOpen.steps[0].startedAt).toBeTruthy();
    await ok('PATCH', `${W}/${v.id}/steps/open`, { status: 'done' });

    // fill: entries rendered for the step actor (default = previous step's), identical on a second resolve.
    const fill = await R('signup');
    expect(fill).toMatchObject({ url: null, formId: 'signup-form', dataSet: { slug: 'signup', name: 'Sign-up' }, warnings: [] });
    const byKey = Object.fromEntries(fill.entries.map((e: any) => [e.key, e.value]));
    expect(byKey.email).toBe(part.email);
    expect(byKey.terms).toBe(true);
    expect(byKey.interests).toEqual(['main', 'news']);
    expect(byKey.ref).toMatch(/^REF-\d{6}$/);
    expect((await R('signup')).entries).toEqual(fill.entries);
    const filled = await ok('PATCH', `${W}/${v.id}/steps/signup`, { status: 'done', data: { fill: { filled: 6, unmatched: [] } }, note: 'all good' });
    expect(filled.currentStepId).toBe('confirm');
    expect(filled.steps[1]).toMatchObject({ status: 'done', note: 'all good', data: { fill: { filled: 6, unmatched: [] } } });
    expect(filled.steps[1].finishedAt).toBeTruthy();

    // The app sends the confirmation mail while the sign-up step is done, before the email step is opened.
    await mailer().sendMail({ from: 'noreply@app.test', to: part.email, subject: 'Confirm your account', text: `Welcome to HCE27. Confirm: ${ORIGIN}/confirm?t=abc` });
    const email = await R('confirm');
    expect(email).toMatchObject({ channel: 'email', user: { id: part.userId, email: part.email }, subject: 'Confirm', linkPattern: '/confirm', linkIndex: null, open: 'same-tab' });
    expect(email.waitPath).toContain(`/api/projects/${P}/messages/wait?user=${part.userId}&channel=email&since=`);
    expect(email.waitPath).toContain('&q=HCE27');
    const msg = await ok('GET', email.waitPath);
    expect(msg).toMatchObject({ channel: 'email', subject: 'Confirm your account', testUserId: part.userId });
    expect(msg.links).toContain(`${ORIGIN}/confirm?t=abc`);
    // A re-resolve keeps the same window.
    expect((await R('confirm')).waitPath).toBe(email.waitPath);
    await ok('PATCH', `${W}/${v.id}/steps/confirm`, { status: 'done', data: { email: { messageId: msg.id, link: msg.links[0] } } });

    // capture: value → vars, used by a later resolve.
    const cap = await R('regno');
    expect(cap).toMatchObject({ var: 'regNo', selector: null, textPattern: 'Registration number: (\\S+)', required: true });
    expect((await api('PATCH', `${W}/${v.id}/steps/open`, { value: 'x' })).status).toBe(400); // value only on capture steps
    const captured = await ok('PATCH', `${W}/${v.id}/steps/regno`, { status: 'done', value: 'HCE27-R-00435' });
    expect(captured.vars.regNo).toBe('HCE27-R-00435');
    expect(captured.steps[3].data.value).toBe('HCE27-R-00435');

    // login with TOTP: codePath answers a real code.
    const login = await R('admin-login');
    expect(login).toMatchObject({
      url: `${ORIGIN}/auth/staff/login`,
      actor: { key: 'admin', userId: admin.id },
      username: admin.email,
      password: 'Password123!',
      selectors: { username: '#email', password: '#password', submit: 'button[type=submit]' },
      twoFactor: { kind: 'totp', selector: '#code', label: 'Admin 2FA' },
    });
    expect(login.twoFactor.codePath).toMatch(new RegExp(`^/api/projects/${P}/authenticators/[a-z0-9]+/code$`));
    const code = await ok('GET', login.twoFactor.codePath);
    expect(code.code).toMatch(/^\d{6}$/);
    await ok('PATCH', `${W}/${v.id}/steps/admin-login`, { status: 'done', data: { login: { twoFactorFilled: true } } });

    // check: the captured var is rendered; the actor is still admin (previous step's).
    const check = await R('find');
    expect(check).toMatchObject({ expect: 'The registration is listed', assert: { textPresent: 'HCE27-R-00435', selector: null, urlMatches: null }, actor: { key: 'admin' } });
    expect(check.text.intent).toBe('Look up HCE27-R-00435');
    await ok('PATCH', `${W}/${v.id}/steps/find`, { status: 'failed', note: 'not listed on page 1' });

    // logout: url from the admin recipe (none) → null.
    expect((await R('bye')).url).toBeNull();
    // a PATCH of vars (null deletes)
    expect((await ok('PATCH', `${W}/${v.id}`, { vars: { extra: 'x', track: null } })).vars).toEqual({ event: 'HCE27', regNo: 'HCE27-R-00435', extra: 'x' });
    expect((await api('PATCH', `${W}/${v.id}`, { currentStepId: 'nope' })).status).toBe(400);

    // finish rules: "bye" is active (required) → 409; optional "tour" alone would not block.
    const blocked = await api('POST', `${W}/${v.id}/finish`, { verdict: 'partial', signedOffBy: 'QA Lead' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.incomplete).toEqual(['bye']);
    expect((await api('POST', `${W}/${v.id}/finish`, { verdict: 'maybe', signedOffBy: 'QA' })).status).toBe(400);
    expect((await api('POST', `${W}/${v.id}/finish`, { verdict: 'pass', signedOffBy: '' })).status).toBe(400);
    await ok('PATCH', `${W}/${v.id}/steps/bye`, { status: 'done' });
    const done = await ok('POST', `${W}/${v.id}/finish`, { verdict: 'partial', signedOffBy: 'QA Lead', note: 'regNo not found in list' });
    expect(done).toMatchObject({ status: 'finished', currentStepId: null, signoff: { verdict: 'partial', signedOffBy: 'QA Lead', note: 'regNo not found in list' } });
    expect(done.steps.find((s: any) => s.id === 'tour')).toMatchObject({ status: 'skipped', note: 'not run' });
    expect(done.counts).toEqual({ pending: 0, active: 0, done: 6, skipped: 1, failed: 1 });
    expect((await api('POST', `${W}/${v.id}/finish`, { verdict: 'pass', signedOffBy: 'QA' })).status).toBe(409);
    expect((await api('POST', `${W}/${v.id}/steps/open/resolve`, {})).status).toBe(409);

    // reopen clears the sign-off; allowIncomplete marks open required steps skipped.
    const re = await ok('POST', `${W}/${v.id}/reopen`, {});
    expect(re).toMatchObject({ status: 'active', finishedAt: null, signoff: { verdict: null, signedOffBy: null, signedOffAt: null } });
    await ok('PATCH', `${W}/${v.id}/steps/bye`, { status: 'pending' });
    const forced = await ok('POST', `${W}/${v.id}/finish`, { verdict: 'fail', signedOffBy: 'QA Lead', allowIncomplete: true });
    expect(forced.steps.find((s: any) => s.id === 'bye')).toMatchObject({ status: 'skipped', note: 'not run' });

    // list + summary JSON
    const list = await ok('GET', `${W}?storyboard=register`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: v.id, status: 'finished', verdict: 'fail', storyboard: { slug: 'register' } });
    expect(await ok('GET', `${W}?status=active`)).toEqual([]);
    expect((await api('GET', `${W}?status=bogus`)).status).toBe(400);
    const sum = await ok('GET', `${W}/${v.id}/summary`);
    expect(sum.walkthrough).toMatchObject({ id: v.id, key: v.key, verdict: 'fail' });
    expect(sum.steps).toHaveLength(8);
    expect(sum.steps[1]).toMatchObject({ id: 'signup', title: 'Fill the sign-up form', kind: 'fill', status: 'done', shots: 0 });
    expect(sum.actors.participant.password).toBe('***');
    expect(sum.vars.regNo).toBe('HCE27-R-00435');
    expect(sum.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('login with an emailed code: waitPath after the resolve cursor returns the OTP (existing actor by override)', async () => {
    // An old code mail must not count.
    await mailer().sendMail({ from: 'noreply@app.test', to: customer.email, subject: 'Your code', text: 'Your login code is 111111' });
    const second = (await ok('GET', `${PB}/users`) as any[]).find((u) => u.role === 'customer' && u.id !== customer.id);
    const v = await ok('POST', W, { storyboard: 'otp-login', actors: { buyer: second.email } }, 201);
    expect(v.actors.buyer).toMatchObject({ userId: second.id, created: false });
    const login = await ok('POST', `${W}/${v.id}/steps/in/resolve`, {});
    expect(login.url).toBe(`${ORIGIN}/login`);
    expect(login.twoFactor).toMatchObject({ kind: 'email-otp', selector: '#otp' });
    expect(login.twoFactor.waitPath).toMatch(new RegExp(`^/api/projects/${P}/messages/wait\\?user=${second.id}&channel=email&otp=1&after=[^&]+&q=code&timeout=60$`));
    await mailer().sendMail({ from: 'noreply@app.test', to: second.email, subject: 'Your code', text: 'Your login code is 482913' });
    const msg = await ok('GET', login.twoFactor.waitPath);
    expect(msg.otp).toBe('482913');
    expect(msg.testUserId).toBe(second.id);

    // Default actor (no override): first user with the role.
    const v2 = await ok('POST', W, { storyboard: 'otp-login' }, 201);
    expect(v2.actors.buyer.userId).toBe(customer.id);
    await ok('DELETE', `${W}/${v2.id}`);
    await ok('DELETE', `${W}/${v.id}`);
  });

  it('refresh: new steps are added, removed ones kept with data.removed', async () => {
    const v = await ok('POST', W, { storyboard: 'register', vars: { event: 'R1' } }, 201);
    await ok('PATCH', `${W}/${v.id}/steps/open`, { status: 'done' });
    const steps = REGISTER.steps.filter((s) => s.id !== 'tour').concat([{ id: 'extra', kind: 'instruction', title: 'New step', intent: 'Added later' } as any]);
    await putStoryboard('register', { slug: 'register', ...REGISTER, steps });
    expect((await ok('GET', `${W}/${v.id}`)).warnings.some((w: string) => w.includes('changed since'))).toBe(true);
    const r = await ok('POST', `${W}/${v.id}/refresh`, {});
    expect(r.storyboard.version).toBe(2);
    expect(r.steps.map((s: any) => s.id)).toEqual(['open', 'signup', 'confirm', 'regno', 'admin-login', 'find', 'bye', 'extra', 'tour']);
    expect(r.steps[0].status).toBe('done');
    expect(r.steps.find((s: any) => s.id === 'extra').status).toBe('pending');
    expect(r.steps.find((s: any) => s.id === 'tour').data.removed).toBe(true);
    expect(r.warnings).toEqual([]);
    await putStoryboard('register', { slug: 'register', ...REGISTER });
    await ok('DELETE', `${W}/${v.id}?users=1`);
  });

  it('screenshots: upload, read back, caps → 413, delete; summary.html inlines them under a strict CSP', async () => {
    const svc = hub.walkthroughs as WalkthroughServiceImpl;
    const v = await ok('POST', W, { storyboard: 'register', vars: { event: 'SHOT' }, label: '<script>alert(1)</script>' }, 201);
    const S = `${W}/${v.id}/steps/open/shots`;
    const shot = await ok('POST', S, { dataUrl: png }, 201);
    expect(shot.bytes).toBe(Buffer.from(PNG_1PX, 'base64').length);
    const img = await api('GET', `${W}/${v.id}/shots/${shot.id}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.compare(img.body as Buffer, Buffer.from(PNG_1PX, 'base64'))).toBe(0);
    expect((await ok('GET', `${W}/${v.id}`)).steps[0].shots).toEqual([{ id: shot.id, bytes: shot.bytes, createdAt: expect.any(String) }]);

    expect((await api('POST', S, { dataUrl: 'data:image/gif;base64,R0lGOD' })).status).toBe(400);
    expect((await api('POST', `${W}/${v.id}/steps/nope/shots`, { dataUrl: png })).status).toBe(404);
    // > 600 KB each
    const big = await api('POST', S, { dataUrl: `data:image/jpeg;base64,${Buffer.alloc(700 * 1024, 1).toString('base64')}` });
    expect(big.status).toBe(413);
    expect(big.body.error).toContain('600 KB');
    // per walkthrough and per project caps (lowered for the test)
    try {
      svc.caps = { ...svc.caps, shotsPerWalkthrough: 2 };
      await ok('POST', S, { dataUrl: png }, 201);
      const third = await api('POST', S, { dataUrl: png });
      expect(third.status).toBe(413);
      expect(third.body.error).toContain('at most 2');
      svc.caps = { ...svc.caps, shotsPerWalkthrough: 40, projectBytes: shot.bytes * 2 + 10 };
      expect((await api('POST', S, { dataUrl: png })).status).toBe(413);
    } finally {
      svc.caps = { shotBytes: 600 * 1024, shotsPerWalkthrough: 40, projectBytes: 50 * 1024 * 1024 };
    }

    const html = await api('GET', `${W}/${v.id}/summary.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('content-security-policy')).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(html.body).toContain(`src="data:image/png;base64,${PNG_1PX}"`);
    expect(html.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.body).not.toContain('<script>');
    expect(html.body).not.toContain('Password123!');

    await ok('DELETE', `${W}/${v.id}/shots/${shot.id}`);
    expect((await api('GET', `${W}/${v.id}/shots/${shot.id}`)).status).toBe(404);
    expect((await api('DELETE', `${W}/${v.id}/shots/${shot.id}`)).status).toBe(404);
    expect((await ok('GET', `${W}/${v.id}/summary`)).steps[0].shots).toBe(1);
    await ok('DELETE', `${W}/${v.id}?users=1`);
  });

  it('delete ?users=1 removes the fresh users; without it they stay', async () => {
    const a = await ok('POST', W, { storyboard: 'register', vars: { event: 'D1' } }, 201);
    const b = await ok('POST', W, { storyboard: 'register', vars: { event: 'D2' } }, 201);
    expect(await ok('DELETE', `${W}/${a.id}?users=1`)).toEqual({ deleted: a.id, users: 1, kept: [] });
    expect((await api('GET', `${PB}/users/${a.actors.participant.userId}`)).status).toBe(404);
    expect((await api('GET', `${PB}/users/${admin.id}`)).status).toBe(200); // existing actors never go
    // A run with test data to clean up needs users=1 or force=1; force leaves the data.
    expect((await api('DELETE', `${W}/${b.key}`)).status).toBe(409);
    expect(await ok('DELETE', `${W}/${b.key}?force=1`)).toEqual({ deleted: b.id, users: 0, kept: [] });
    expect((await api('GET', `${PB}/users/${b.actors.participant.userId}`)).status).toBe(200);
    expect((await api('GET', `${W}/${a.id}`)).status).toBe(404);
  });

  it('quick test runs: mode on start, hidden from the default list and lastWalkthrough, no screenshots, finish without sign-off', async () => {
    expect((await api('POST', W, { storyboard: 'otp-login', mode: 'fast' })).status).toBe(400);
    const tracked = await ok('POST', W, { storyboard: 'otp-login' }, 201);
    expect(tracked.mode).toBe('tracked');
    const q = await ok('POST', W, { storyboard: 'otp-login', mode: 'quick', label: 'smoke' }, 201);
    expect(q).toMatchObject({ mode: 'quick', status: 'active', label: 'smoke', currentStepId: 'in', signoff: { verdict: null } });
    // Started later than the tracked run, so only the mode filter keeps it out of lastWalkthrough.
    hub.db.prepare('UPDATE walkthroughs SET started_at = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), q.id);

    // List: tracked by default; mode=quick / all; bad mode 400.
    const ids = (list: any[]) => list.map((x) => x.id).sort();
    const def = await ok('GET', `${W}?storyboard=otp-login`);
    expect(ids(def)).toEqual([tracked.id]);
    expect(def[0].mode).toBe('tracked');
    expect(ids(await ok('GET', `${W}?storyboard=otp-login&mode=tracked`))).toEqual([tracked.id]);
    const quick = await ok('GET', `${W}?storyboard=otp-login&mode=quick`);
    expect(ids(quick)).toEqual([q.id]);
    expect(quick[0]).toMatchObject({ mode: 'quick', label: 'smoke' });
    expect(ids(await ok('GET', `${W}?storyboard=otp-login&mode=all`))).toEqual([tracked.id, q.id].sort());
    expect((await api('GET', `${W}?mode=bogus`)).status).toBe(400);

    // The storyboard brief's lastWalkthrough ignores the quick run.
    const brief = ((await ok('GET', `${PB}/storyboards`)) as any[]).find((x) => x.slug === 'otp-login');
    expect(brief.preferredMode).toBe('tracked');
    expect(brief.lastWalkthrough.id).toBe(tracked.id);

    // No screenshots on a quick run.
    const shot = await api('POST', `${W}/${q.id}/steps/in/shots`, { dataUrl: png });
    expect(shot.status).toBe(409);
    expect(shot.body.error).toBe("Quick test runs don't keep screenshots");
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM walkthrough_shots WHERE walkthrough_id = ?').get(q.id) as { n: number }).n).toBe(0);

    // Resolve and step PATCH work as on a tracked run (the extension marks steps done to move on).
    expect((await ok('POST', `${W}/${q.id}/steps/in/resolve`, {})).twoFactor.kind).toBe('email-otp');
    const stepped = await ok('PATCH', `${W}/${q.id}/steps/in`, { status: 'done' });
    expect(stepped).toMatchObject({ currentStepId: null, counts: { done: 1 } });
    const fin = await ok('POST', `${W}/${q.id}/finish`, {});
    expect(fin).toMatchObject({ status: 'finished', mode: 'quick', signoff: { verdict: null, signedOffBy: '', note: '' } });
    expect(fin.finishedAt).toBeTruthy();

    // Open steps are skipped without allowIncomplete; a verdict may still be given.
    const q2 = await ok('POST', W, { storyboard: 'otp-login', mode: 'quick' }, 201);
    expect((await api('POST', `${W}/${q2.id}/finish`, { verdict: 'maybe' })).status).toBe(400);
    const fin2 = await ok('POST', `${W}/${q2.id}/finish`, { verdict: 'pass', note: 'looked fine' });
    expect(fin2.steps[0]).toMatchObject({ status: 'skipped', note: 'not run' });
    expect(fin2.signoff).toMatchObject({ verdict: 'pass', signedOffBy: '', note: 'looked fine' });

    // Summary and report work for quick runs.
    expect((await ok('GET', `${W}/${q.id}/summary`)).walkthrough).toMatchObject({ id: q.id, mode: 'quick', verdict: null, status: 'finished' });
    expect((await api('GET', `${W}/${q.id}/summary.html`)).status).toBe(200);

    // Tracked runs keep their rules.
    expect((await api('POST', `${W}/${tracked.id}/finish`, {})).status).toBe(400);
    expect((await api('POST', `${W}/${tracked.id}/finish`, { verdict: 'pass', signedOffBy: 'QA' })).status).toBe(409);
    expect((await api('POST', `${W}/${tracked.id}/finish`, { verdict: 'pass' })).status).toBe(400);

    for (const id of [tracked.id, q.id, q2.id]) await ok('DELETE', `${W}/${id}`);
  });

  it('maintenance no longer deletes quick test runs (cleanup is manual)', async () => {
    const quick = await ok('POST', W, { storyboard: 'otp-login', mode: 'quick' }, 201);
    await ok('POST', `${W}/${quick.id}/finish`, {});
    const report = await hub.maintenance.run(Date.now() + 25 * 3_600_000);
    expect(report.error).toBeUndefined();
    expect('quickRunsPurged' in report).toBe(false);
    expect((await api('GET', `${W}/${quick.id}`)).status).toBe(200);
    await ok('DELETE', `${W}/${quick.id}`);
  });

  it('retention purges non-active walkthroughs past the cutoff (and their shots); reset removes the rest', async () => {
    const active = await ok('POST', W, { storyboard: 'register', vars: { event: 'KEEP' } }, 201);
    const old = await ok('POST', W, { storyboard: 'register', vars: { event: 'OLD' } }, 201);
    await ok('POST', `${W}/${old.id}/steps/open/shots`, { dataUrl: png }, 201);
    await ok('POST', `${W}/${old.id}/abandon`, { note: 'gave up' });
    expect((await ok('GET', `${W}/${old.id}`)).signoff.note).toBe('gave up');
    // Its fresh user is test data still to clean up: retention skips it until it is cleaned or dismissed.
    expect((await ok('GET', `${W}/${old.id}`)).cleanupStatus).toBe('pending');
    expect((await hub.maintenance.run(Date.now() + 400 * 86_400_000)).error).toBeUndefined();
    expect((await api('GET', `${W}/${old.id}`)).status).toBe(200);
    await ok('POST', `${W}/${old.id}/cleanup/dismiss`, { note: 'keep the user' });
    const report = await hub.maintenance.run(Date.now() + 400 * 86_400_000);
    expect(report.error).toBeUndefined();
    expect(report.walkthroughsPurged).toBeGreaterThanOrEqual(1);
    expect((await api('GET', `${W}/${old.id}`)).status).toBe(404);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM walkthrough_shots WHERE walkthrough_id = ?').get(old.id) as { n: number }).n).toBe(0);
    expect((await api('GET', `${W}/${active.id}`)).status).toBe(200);

    await ok('POST', `${PB}/reset`, {});
    expect(await ok('GET', W)).toEqual([]);
    expect((await api('GET', `${PB}/users/${active.actors.participant.userId}`)).status).toBe(200); // fresh users stay
  });
});

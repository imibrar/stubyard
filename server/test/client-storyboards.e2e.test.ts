/**
 * The browser-safe @stubyard/client helpers (packages/client/src: http, users, messages, authenticators, stream,
 * storyboards, walkthroughs) against a real hub over HTTP (no Mailpit: SMS only): author a storyboard, start a
 * walkthrough, resolve → update every step (TOTP login via codePath, fill, capture, check with the captured var,
 * SMS waitPath), finish, summary; the event stream sees walkthrough.changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

let hub: Hub;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let dataDir: string;
let apiUrl: string;
// Dynamic import: the client lives in the packages/client workspace (outside this tsconfig's rootDir).
let c: any;
let t: { apiUrl: string; project: string };

const ORIGIN = 'http://app.client-sb.test:3183';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

async function j<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(apiUrl + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T };
}

const storyboard = {
  slug: 'client-flow',
  name: 'Client flow',
  description: 'Driven by @stubyard/client',
  actors: [
    { key: 'admin', role: 'admin' },
    { key: 'guest', role: 'participant', fresh: true },
  ],
  steps: [
    { id: 'open', kind: 'open', title: 'Open the sign-up page', intent: 'Start at the sign-up form', actor: 'guest', url: '/register' },
    { id: 'signup', kind: 'fill', title: 'Fill the sign-up form', intent: 'Register the guest', actor: 'guest', dataSet: 'signup' },
    { id: 'reg', kind: 'capture', title: 'Note the registration number', intent: 'Keep it for the admin', var: 'regNo', selector: '#reg-no' },
    { id: 'admin-login', kind: 'login', title: 'Admin signs in', intent: 'Sign in with 2FA', actor: 'admin' },
    { id: 'find', kind: 'check', title: 'Find the registration', intent: 'The admin sees it', expect: 'The registration is listed', assert: { textPresent: '{{vars.regNo}}' } },
    { id: 'sms', kind: 'email', title: 'Admin gets the SMS', intent: 'The app texts the admin', actor: 'admin', channel: 'sms', match: { text: 'approved' } },
    { id: 'wrap', kind: 'instruction', title: 'Look around', intent: 'Anything else', optional: true },
  ],
};

describe('@stubyard/client storyboards + walkthroughs', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-client-sb-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, allowedHosts: [] });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    apiUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    c = await import(new URL('../../packages/client/src/index.ts', import.meta.url).pathname);
    t = { apiUrl, project: 'client-sb' };

    expect((await j('POST', '/api/projects', { name: 'Client SB', generateUsers: { admins: 1 } })).status).toBe(201);
    expect((await j('PATCH', '/api/projects/client-sb', { settings: { appOrigins: [ORIGIN] } })).status).toBe(200);
    expect((await j('POST', '/api/projects/client-sb/providers', { preset: 'twilio', slug: 'sms' })).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('users / messages / authenticators helpers', async () => {
    const users = await c.listUsers(t);
    const admin = users.find((u: any) => u.role === 'admin');
    expect(admin?.password).toBeTruthy();
    const one = await c.getUser(t, 'admin');
    expect(one.id).toBe(admin.id);
    expect(one).toHaveProperty('inbox');
    expect(await c.latestMessage(t, 'admin')).toBeNull();
    await expect(c.latestMessage(t, 'nobody@nowhere.test')).rejects.toMatchObject({ name: 'StubyardError', status: 404 });
    expect(typeof (await c.messageCursor(t, { user: admin.id, channel: 'sms' }))).toBe('string');

    const created = await j('POST', '/api/projects/client-sb/authenticators', { label: 'Admin 2FA', secret: TOTP_SECRET, testUserId: admin.id });
    expect(created.status).toBe(201);
    const byUser = await c.getTotpCodeBy(t, { user: 'admin' });
    expect(byUser.label).toBe('Admin 2FA');
    expect(byUser.code).toMatch(/^\d{6}$/);
    const byPath = await c.getTotpCode(t, `/api/projects/client-sb/authenticators/${created.body.id}/code`);
    expect(byPath.id).toBe(created.body.id);
    expect([byUser.code, byUser.nextCode]).toContain(byPath.code);

    // hubFetch: errors carry status + details; allow lets a status through.
    await expect(c.hubFetch(t, 'GET', '/api/projects/nope')).rejects.toMatchObject({ status: 404 });
    expect((await c.hubFetch(t, 'GET', '/api/projects/nope', undefined, { allow: [404] })).status).toBe(404);
  });

  it('authoring: origin match, recipe, data set, validate, upsert (idempotent), list, snapshots, export / import', async () => {
    const m = await c.matchProjects({ apiUrl }, ORIGIN);
    expect(m.projects.map((p: any) => p.slug)).toContain('client-sb');
    expect((await c.matchProjects({ apiUrl }, 'http://other.test')).projects).toEqual([]);

    const recipe = await c.upsertLoginRecipe(t, { role: 'admin', loginUrl: '/login', twoFactor: { kind: 'totp', selector: '#otp' } });
    expect(recipe.role).toBe('admin');
    expect((await c.listLoginRecipes(t)).map((r: any) => r.role)).toEqual(['admin']);

    await c.upsertDataSet(t, {
      slug: 'signup',
      name: 'Sign-up',
      match: { urlPattern: '/register' },
      entries: [
        { key: 'email', value: '{{user.email}}' },
        { key: 'name', value: '{{user.name}}' },
        { key: 'terms', value: true, kind: 'checkbox' },
      ],
    });
    expect((await c.getDataSet(t, 'signup')).entries).toHaveLength(3);
    const byUrl = await c.listDataSets(t, { url: `${ORIGIN}/register` });
    expect(byUrl.map((d: any) => d.slug)).toEqual(['signup']);

    const broken = { ...storyboard, steps: [...storyboard.steps, { kind: 'fill', title: 'x', intent: 'x', dataSet: 'missing' }] };
    const v = await c.validateStoryboard(t, broken);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e: any) => e.code)).toContain('missing_data_set');
    await expect(c.upsertStoryboard(t, broken)).rejects.toMatchObject({ status: 400, details: { errors: expect.any(Array) } });

    const sb = await c.upsertStoryboard(t, storyboard);
    expect(sb.steps.map((s: any) => s.id)).toEqual(storyboard.steps.map((s) => s.id));
    expect((await c.upsertStoryboard(t, storyboard)).version).toBe(sb.version);
    expect((await c.validateStoryboard(t, { slug: 'client-flow' })).ok).toBe(true);
    expect((await c.getStoryboard(t, 'client-flow')).name).toBe('Client flow');
    expect((await c.listStoryboards(t)).map((b: any) => b.slug)).toEqual(['client-flow']);

    const snap = await c.savePageSnapshot(t, {
      url: `${ORIGIN}/register`,
      fields: [{ key: 'email', id: 'email', name: 'email', testId: null, kind: 'text', inputType: 'email', label: 'Email', placeholder: null, value: '', required: true, visible: true, formId: null }],
      source: 'extension',
    });
    expect(snap.id).toBeTruthy();
    expect((await c.listPageSnapshots(t)).map((s: any) => s.id)).toContain(snap.id);

    const bundle = await c.exportBundle(t, { storyboards: ['client-flow'] });
    expect(bundle.format).toBe('stubyard-storyboards');
    expect(bundle.storyboards.map((s: any) => s.slug)).toEqual(['client-flow']);
    const dry = await c.importBundle(t, bundle, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.unchanged.storyboards).toContain('client-flow');
  });

  it('walkthrough: start → resolve → update every step → finish, with stream events', async () => {
    const events: any[] = [];
    const ac = new AbortController();
    c.subscribe(t, { types: ['walkthrough.changed'], onEvent: (e: any) => events.push(e), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 200)); // let the stream connect

    try {
      let w = await c.startWalkthrough(t, { storyboard: 'client-flow', origin: ORIGIN, label: 'client run' });
      expect(w.status).toBe('active');
      expect(w.steps).toHaveLength(storyboard.steps.length);
      expect(w.actors.guest.created).toBe(true);
      expect(w.actors.admin.created).toBe(false);
      expect((await c.listWalkthroughs(t, { storyboard: 'client-flow' })).map((b: any) => b.id)).toContain(w.id);

      const open = await c.resolveStep(t, w.id, 'open');
      expect(open.url).toBe(`${ORIGIN}/register`);
      w = await c.updateStep(t, w.id, 'open', { status: 'done' });

      const fill = await c.resolveStep(t, w.id, 'signup');
      expect(fill.dataSet.slug).toBe('signup');
      const email = fill.entries.find((e: any) => e.key === 'email');
      expect(email.value).toBe(w.actors.guest.email);
      expect((await c.resolveStep(t, w.id, 'signup')).entries).toEqual(fill.entries); // stable on re-resolve
      w = await c.updateStep(t, w.id, 'signup', { status: 'done', data: { filled: 3, unmatched: [] } });
      expect(w.steps.find((s: any) => s.id === 'signup').data.filled).toBe(3);

      const cap = await c.resolveStep(t, w.id, 'reg');
      expect(cap.var).toBe('regNo');
      w = await c.updateStep(t, w.id, 'reg', { status: 'done', value: 'HCE27-0042' });
      expect(w.vars.regNo).toBe('HCE27-0042');

      const login = await c.resolveStep(t, w.id, 'admin-login');
      expect(login.url).toBe(`${ORIGIN}/login`);
      expect(login.username).toBe(w.actors.admin.email);
      expect(login.twoFactor.kind).toBe('totp');
      const code = await c.getTotpCode(t, login.twoFactor.codePath);
      expect(code.code).toMatch(/^\d{6}$/);
      w = await c.updateStep(t, w.id, 'admin-login', { status: 'done', data: { twoFactorFilled: true } });

      const check = await c.resolveStep(t, w.id, 'find');
      expect(check.assert.textPresent).toBe('HCE27-0042');
      w = await c.updateStep(t, w.id, 'find', { status: 'done', data: { assertion: { present: true } } });

      const sms = await c.resolveStep(t, w.id, 'sms');
      expect(sms.channel).toBe('sms');
      const phone = w.actors.admin.phone;
      expect(phone).toBeTruthy();
      const waiting = c.waitForMessagePath(t, sms.waitPath);
      const sent = await fetch(`${apiUrl}/mock/client-sb/sms/2010-04-01/Accounts/ACtest/Messages.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: phone, From: '+15550001111', Body: 'Your registration was approved' }).toString(),
      });
      expect(sent.status).toBeLessThan(300);
      const msg = await waiting;
      expect(msg?.bodyText).toContain('approved');
      expect((await c.getMessage(t, msg.id)).id).toBe(msg.id);
      expect((await c.latestMessage(t, 'admin', { channel: 'sms' }))?.message.id).toBe(msg.id);
      w = await c.updateStep(t, w.id, 'sms', { status: 'done', data: { messageId: msg.id } });

      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const shot = await c.addScreenshot(t, w.id, 'sms', png);
      expect(shot.bytes).toBeGreaterThan(0);

      w = await c.patchWalkthrough(t, w.id, { label: 'client run (renamed)' });
      expect(w.label).toBe('client run (renamed)');

      // The optional instruction step is still pending: finishing is allowed.
      w = await c.finishWalkthrough(t, w.id, { verdict: 'pass', signedOffBy: 'QA bot', note: 'all good' });
      expect(w.status).toBe('finished');
      expect(w.signoff.verdict).toBe('pass');
      expect((await c.getWalkthrough(t, w.key)).id).toBe(w.id);

      const summary = await c.getWalkthroughSummary(t, w.id);
      expect(summary.steps.find((s: any) => s.id === 'sms').shots).toBe(1);
      const url = c.summaryUrl(t, w.id);
      expect(url).toBe(`${apiUrl}/api/projects/client-sb/walkthroughs/${w.id}/summary.html`);
      expect((await fetch(url)).status).toBe(200);

      const deadline = Date.now() + 2000;
      while (!events.some((e) => e.data?.status === 'finished') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.type === 'walkthrough.changed' && typeof e.projectId === 'string')).toBe(true);

      // abandon on a fresh one
      const w2 = await c.startWalkthrough(t, { storyboard: 'client-flow', origin: ORIGIN });
      expect((await c.abandonWalkthrough(t, w2.id, 'not needed')).status).toBe('abandoned');
    } finally {
      ac.abort();
    }
  });

  it('quick test run: start with mode, listWalkthroughs mode filter, finish without a sign-off', async () => {
    const q = await c.startWalkthrough(t, { storyboard: 'client-flow', origin: ORIGIN, mode: 'quick' });
    expect(q.mode).toBe('quick');
    expect((await c.listWalkthroughs(t, { storyboard: 'client-flow' })).map((b: any) => b.id)).not.toContain(q.id);
    expect((await c.listWalkthroughs(t, { storyboard: 'client-flow', mode: 'quick' })).map((b: any) => b.id)).toEqual([q.id]);
    expect((await c.listWalkthroughs(t, { storyboard: 'client-flow', mode: 'all' })).map((b: any) => b.id)).toContain(q.id);
    await expect(c.addScreenshot(t, q.id, 'open', 'data:image/png;base64,iVBORw0KGgo=')).rejects.toMatchObject({ status: 409 });
    const done = await c.finishWalkthrough(t, q.id, {});
    expect(done).toMatchObject({ status: 'finished', mode: 'quick', signoff: { verdict: null, signedOffBy: '' } });
    expect((await c.listStoryboards(t)).find((s: any) => s.slug === 'client-flow')).toMatchObject({ preferredMode: 'tracked' });
  });
});

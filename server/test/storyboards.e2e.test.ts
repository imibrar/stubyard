import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { HubEvent } from '../src/events.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/** Storyboards authoring (docs/design/storyboards.md §3.1–3.6, Slice 1): every route, validation codes, bundles, export. */

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
const events: HubEvent[] = [];

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T };
}

const P = 'sb';
const A = `/api/projects/${P}`;
const ok = <T = any>(r: { status: number; body: T }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const codes = (list: { code: string; path: string }[]) => list.map((i) => `${i.code} @ ${i.path}`);

const adminRecipe = { role: 'admin', name: 'Staff login', loginUrl: '/admin/login', twoFactor: { kind: 'totp', authenticator: 'Admin key' }, logoutUrl: '/logout' };
const participantRecipe = { role: 'participant', loginUrl: '/login' };
const signUp = {
  slug: 'sign-up',
  name: 'Sign-up form',
  match: { urlPattern: '/register/*' },
  entries: [
    { key: 'email', value: '{{user.email}}' },
    { key: 'password', value: 'Secret#1' },
    { key: 'confirmPassword', value: '{{user.password}}' },
    { key: 'firstName', value: '{{fake.firstName}}' },
    { key: 'pinCodes', value: ['1234', '{{fake.digits:4}}'] },
    { key: 'terms', value: true, kind: 'checkbox' },
  ],
};
const step = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, title: `${kind} step`, intent: `Do the ${kind} step.`, ...extra });
const story = {
  slug: 'register',
  name: 'Register for an event',
  tags: ['pilot'],
  inputs: [{ name: 'event', label: 'Event code', default: 'HCE27' }],
  actors: [
    { key: 'participant', role: 'participant', fresh: true },
    { key: 'admin', role: 'admin', user: 'admin@sb.test' },
  ],
  steps: [
    step('open', { url: '/register/{{vars.event}}' }),
    step('fill', { dataSet: 'sign-up' }),
    step('capture', { var: 'regNo', textPattern: 'Registration number: (\\S+)' }),
    step('logout'),
    step('login', { actor: 'admin' }),
    step('open', { url: '/admin/registrations?q={{vars.regNo}}' }),
    step('check', { expect: 'The registration is listed', assert: { textPresent: '{{vars.regNo}}' } }),
  ],
};

describe('storyboards authoring', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-storyboards-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    hub.bus.subscribe((e) => events.push(e));
    ok(await api('POST', '/api/projects', { name: 'Storyboards', slug: P, settings: { roles: ['admin', 'participant'], defaultPassword: 'Pw#12345' } }), 201);
    const admin = ok(await api('POST', `${A}/users`, { name: 'Admin', role: 'admin', email: 'admin@sb.test', phone: '+15550000001', password: 'AdminPw!1' }), 201);
    ok(await api('POST', `${A}/users`, { name: 'Pat Participant', role: 'participant', email: 'pat@sb.test', phone: '+15550000002' }), 201);
    ok(await api('POST', `${A}/authenticators`, { label: 'Admin key', secret: 'JBSWY3DPEHPK3PXP', testUserId: admin.id }), 201);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('discovery: schema document and origin match', async () => {
    const doc = ok(await api('GET', '/api/storyboard-schema'));
    expect(Object.keys(doc.schemas).sort()).toEqual(['Actor', 'Bundle', 'DataEntry', 'DataSet', 'LoginRecipe', 'PageSnapshot', 'Step', 'Storyboard']);
    expect(doc.schemas.Storyboard.type).toBe('object');
    expect(doc.stepKinds).toContain('capture');
    expect(doc.fieldKinds).toContain('radix-select');
    expect(doc.variables.map((v: any) => v.name)).toContain('unique');

    expect(ok(await api('GET', '/api/storyboards/match?origin=http://localhost:3183'))).toEqual({ origin: 'http://localhost:3183', projects: [] });
    expect((await api('GET', '/api/storyboards/match')).status).toBe(400);
    expect((await api('GET', '/api/storyboards/match?origin=nope')).status).toBe(400);
    ok(await api('PATCH', A, { settings: { appOrigins: ['http://LocalHost:3183/'] } }));
    const m = ok(await api('GET', `/api/storyboards/match?origin=${encodeURIComponent('http://localhost:3183/register/x?y=1')}`));
    expect(m).toEqual({ origin: 'http://localhost:3183', projects: [{ slug: P, name: 'Storyboards', storyboards: 0 }] });
  });

  it('login recipes: upsert (201 / 200), idempotent, list with user counts, validation paths, delete', async () => {
    const created = await api('PUT', `${A}/login-recipes/admin`, adminRecipe);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ role: 'admin', loginUrl: '/admin/login', fields: { username: '#email', password: '#password' }, twoFactor: { kind: 'totp', selector: '#code', authenticator: 'Admin key' }, users: 1 });
    const again = ok(await api('PUT', `${A}/login-recipes/admin`, adminRecipe));
    expect(again.updatedAt).toBe(created.body.updatedAt);
    expect(ok(await api('PUT', `${A}/login-recipes/participant`, participantRecipe), 201).role).toBe('participant');

    const list = ok(await api('GET', `${A}/login-recipes`));
    expect(list.map((r: any) => [r.role, r.users])).toEqual([
      ['admin', 1],
      ['participant', 1],
    ]);
    expect(ok(await api('GET', `${A}/login-recipes/participant`)).loginUrl).toBe('/login');
    expect((await api('GET', `${A}/login-recipes/nobody`)).status).toBe(404);

    const mismatch = await api('PUT', `${A}/login-recipes/admin`, { ...adminRecipe, role: 'staff' });
    expect(mismatch.status).toBe(400);
    expect(codes(mismatch.body.details.errors)).toEqual(['schema @ role']);
    const bad = await api('PUT', `${A}/login-recipes/admin`, { loginUrl: 5, twoFactor: { kind: 'email-otp' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Login recipe is invalid (2 problems)');
    expect(bad.body.details.errors.map((e: any) => e.path).sort()).toEqual(['loginUrl', 'twoFactor.selector']);

    ok(await api('PUT', `${A}/login-recipes/temp`, { loginUrl: '/t' }), 201);
    expect(ok(await api('DELETE', `${A}/login-recipes/temp`))).toEqual({ deleted: 'temp' });
    expect((await api('DELETE', `${A}/login-recipes/temp`)).status).toBe(404);
  });

  it('data sets: upsert, duplicate keys, url match, patch, reserved slug', async () => {
    const c = await api('PUT', `${A}/data-sets/sign-up`, signUp);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ slug: 'sign-up', usedBy: [], match: { urlPattern: '/register/*' } });
    expect(c.body.entries[0]).toEqual({ key: 'email', value: '{{user.email}}', kind: 'auto' });
    expect((await api('PUT', `${A}/data-sets/sign-up`, signUp)).status).toBe(200);

    const dup = await api('PUT', `${A}/data-sets/dup`, { slug: 'dup', name: 'Dup', entries: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] });
    expect(dup.status).toBe(400);
    expect(codes(dup.body.details.errors)).toEqual(['schema @ entries[1].key']);
    const reserved = await api('PUT', `${A}/data-sets/from-snapshot`, { name: 'X', entries: [] });
    expect(reserved.status).toBe(400);

    ok(await api('PUT', `${A}/data-sets/admin-search`, { name: 'Admin search', match: { urlPattern: '/admin/**' }, entries: [{ key: 'q', value: 'x' }] }), 201);
    ok(await api('PUT', `${A}/data-sets/anywhere`, { name: 'Anywhere', entries: [{ key: 'note', value: 'n' }] }), 201);
    const forReg = ok(await api('GET', `${A}/data-sets?url=${encodeURIComponent('http://localhost:3183/register/HCE27')}`));
    expect(forReg.map((d: any) => [d.slug, d.matchScore])).toEqual([
      ['sign-up', 10],
      ['anywhere', 0],
    ]);
    expect(ok(await api('GET', `${A}/data-sets`)).map((d: any) => d.slug)).toEqual(['admin-search', 'anywhere', 'sign-up']);

    const patched = ok(await api('PATCH', `${A}/data-sets/admin-search`, { description: 'Search box', upsertEntries: [{ key: 'q', value: '{{vars.regNo}}' }, { key: 'status', value: 'Pending', kind: 'radix-select' }], removeKeys: [] }));
    expect(patched.description).toBe('Search box');
    expect(patched.entries).toEqual([
      { key: 'q', value: '{{vars.regNo}}', kind: 'auto' },
      { key: 'status', value: 'Pending', kind: 'radix-select' },
    ]);
    const removed = ok(await api('PATCH', `${A}/data-sets/admin-search`, { removeKeys: ['status'] }));
    expect(removed.entries.map((e: any) => e.key)).toEqual(['q']);
    const badPatch = await api('PATCH', `${A}/data-sets/admin-search`, { upsertEntries: [{ value: 'no key' }] });
    expect(badPatch.status).toBe(400);
    expect(codes(badPatch.body.details.errors)).toEqual(['schema @ upsertEntries[0].key']);
    expect((await api('PATCH', `${A}/data-sets/missing`, { name: 'x' })).status).toBe(404);
    expect((await api('GET', `${A}/data-sets/missing`)).status).toBe(404);
  });

  it('page snapshots: save, list by url, get, from-snapshot, delete', async () => {
    const field = (key: string, extra: Record<string, unknown> = {}) => ({
      key, id: key, name: key, testId: null, kind: 'text', inputType: 'text', label: key.toUpperCase(), placeholder: null, value: null, required: false, visible: true, formId: 'reg', ...extra,
    });
    const snap = ok(
      await api('POST', `${A}/page-snapshots`, {
        url: 'http://localhost:3183/register/HCE27',
        urlPattern: '/register/*',
        title: 'Register',
        formId: 'reg',
        source: 'extension',
        fields: [field('email'), field('country', { kind: 'radix-select', value: 'Pakistan' }), field('hidden', { visible: false }), field('terms', { kind: 'checkbox' })],
      }),
      201,
    );
    expect(snap).toMatchObject({ id: expect.any(String), urlPattern: '/register/*', fields: expect.any(Array), source: 'extension' });
    ok(await api('POST', `${A}/page-snapshots`, { url: 'http://localhost:3183/admin/registrations', fields: [field('q')] }), 201);
    const bad = await api('POST', `${A}/page-snapshots`, { url: 'not a url', fields: [{ key: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.details.errors.map((e: any) => e.path)).toContain('url');
    expect(bad.body.details.errors.map((e: any) => e.path)).toContain('fields[0].kind');

    const all = ok(await api('GET', `${A}/page-snapshots`));
    expect(all).toHaveLength(2);
    expect(all.find((s: any) => s.id === snap.id)).toMatchObject({ fields: 4, source: 'extension', title: 'Register', formId: 'reg' });
    const other = all.find((s: any) => s.id !== snap.id);
    const reg = ok(await api('GET', `${A}/page-snapshots?url=${encodeURIComponent('http://localhost:3183/register/OTHER')}`));
    expect(reg.map((s: any) => s.id)).toEqual([snap.id]);
    const adm = ok(await api('GET', `${A}/page-snapshots?url=${encodeURIComponent('http://localhost:3183/admin/registrations/')}&limit=5`));
    expect(adm).toHaveLength(1);
    expect(ok(await api('GET', `${A}/page-snapshots/${snap.id}`)).fields[1].value).toBe('Pakistan');

    const ds = ok(await api('POST', `${A}/data-sets/from-snapshot`, { snapshot: snap.id, slug: 'from-scan', name: 'From scan', values: { email: '{{user.email}}' } }), 201);
    expect(ds.match).toEqual({ urlPattern: '/register/*', formId: 'reg' });
    expect(ds.entries).toEqual([
      { key: 'email', value: '{{user.email}}', kind: 'text', label: 'EMAIL' },
      { key: 'country', value: 'Pakistan', kind: 'radix-select', label: 'COUNTRY' },
      { key: 'terms', value: false, kind: 'checkbox', label: 'TERMS' },
    ]);
    const allFields = ok(await api('POST', `${A}/data-sets/from-snapshot`, { snapshot: snap.id, slug: 'from-scan-all', name: 'All', include: 'all' }), 201);
    expect(allFields.entries).toHaveLength(4);
    expect((await api('POST', `${A}/data-sets/from-snapshot`, { snapshot: snap.id, slug: 'from-scan', name: 'Again' })).status).toBe(409);
    expect((await api('POST', `${A}/data-sets/from-snapshot`, { snapshot: 'nope', slug: 'x', name: 'X' })).status).toBe(404);
    const badReq = await api('POST', `${A}/data-sets/from-snapshot`, { snapshot: snap.id, slug: 'Bad Slug' });
    expect(badReq.status).toBe(400);
    expect(badReq.body.details.errors.map((e: any) => e.path).sort()).toEqual(['name', 'slug']);
    ok(await api('DELETE', `${A}/data-sets/from-scan-all`));

    expect(ok(await api('DELETE', `${A}/page-snapshots/${other.id}`))).toEqual({ deleted: other.id });
    expect((await api('GET', `${A}/page-snapshots/${other.id}`)).status).toBe(404);
    expect((await api('DELETE', `${A}/page-snapshots/${other.id}`)).status).toBe(404);
  });

  it('storyboards: create, step ids, idempotent PUT, version bump, list, get by id', async () => {
    events.length = 0;
    const c = await api('PUT', `${A}/storyboards/register`, story);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const v = c.body;
    expect(v).toMatchObject({ slug: 'register', version: 1, refs: { dataSets: ['sign-up'], roles: ['participant', 'admin'], vars: { captured: ['regNo'], inputs: ['event'] } } });
    expect(v.steps.map((s: any) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    expect(v.steps[0]).toMatchObject({ notes: '', optional: false, screenshot: 'offer' });
    expect(v.warnings).toEqual([]);
    expect(events.filter((e) => e.type === 'storyboards.changed').map((e) => e.data)).toEqual([{ kind: 'storyboard', slug: 'register' }]);

    events.length = 0;
    const same = ok(await api('PUT', `${A}/storyboards/register`, story));
    expect(same.version).toBe(1);
    expect(same.updatedAt).toBe(v.updatedAt);
    expect(events.filter((e) => e.type === 'storyboards.changed')).toEqual([]);
    // The GET body (ids, defaults, server fields) PUT back is the same content too.
    const got = ok(await api('GET', `${A}/storyboards/register`));
    expect(ok(await api('PUT', `${A}/storyboards/register`, got)).version).toBe(1);

    const changed = ok(await api('PUT', `${A}/storyboards/register`, { ...story, description: 'Pilot flow' }));
    expect(changed.version).toBe(2);
    expect(ok(await api('PUT', `${A}/storyboards/register`, { ...story, description: 'Pilot flow' })).version).toBe(2);

    // Explicit ids stay; missing ones skip the taken numbers.
    const ids = ok(await api('PUT', `${A}/storyboards/ids`, { ...story, slug: 'ids', tags: [], steps: [step('instruction', { id: 's2' }), step('instruction'), step('instruction')] }), 201);
    expect(ids.steps.map((s: any) => s.id)).toEqual(['s2', 's3', 's4']);

    const list = ok(await api('GET', `${A}/storyboards`));
    expect(list.map((s: any) => s.slug)).toEqual(['ids', 'register']);
    expect(list[1]).toMatchObject({ slug: 'register', version: 2, steps: 7, tags: ['pilot'], actors: [{ key: 'participant', role: 'participant', fresh: true }, { key: 'admin', role: 'admin', fresh: false }] });
    expect(list[1].lastWalkthrough).toBeUndefined();
    expect(ok(await api('GET', `${A}/storyboards?tag=pilot`)).map((s: any) => s.slug)).toEqual(['register']);
    expect(ok(await api('GET', `${A}/storyboards/${v.id}`)).slug).toBe('register');
    expect((await api('GET', `${A}/storyboards/nope`)).status).toBe(404);

    const match = ok(await api('GET', '/api/storyboards/match?origin=http://localhost:3183'));
    expect(match.projects[0].storyboards).toBe(2);
    expect(ok(await api('GET', `${A}/data-sets/sign-up`)).usedBy).toEqual(['register']);
  });

  it('storyboards: schema errors and reference validation with codes and paths', async () => {
    const schemaBad = await api('PUT', `${A}/storyboards/bad`, { ...story, slug: undefined, steps: [step('open'), step('teleport')] });
    expect(schemaBad.status).toBe(400);
    expect(schemaBad.body.details.errors.every((e: any) => e.code === 'schema')).toBe(true);
    expect(schemaBad.body.details.errors.map((e: any) => e.path)).toContain('steps[0].url');
    expect(schemaBad.body.details.errors.map((e: any) => e.path)).toContain('steps[1].kind');
    const slugMismatch = await api('PUT', `${A}/storyboards/bad`, { ...story, slug: 'other' });
    expect(codes(slugMismatch.body.details.errors)).toEqual(['schema @ slug']);

    const broken = {
      slug: 'broken',
      name: 'Broken',
      actors: [
        { key: 'participant', role: 'participant', fresh: true },
        { key: 'ghost', role: 'nobody' },
        { key: 'pat', role: 'participant', user: 'nobody@sb.test' },
        { key: 'participant', role: 'admin' },
      ],
      steps: [
        step('open', { id: 'a', url: '/x/{{vars.later}}' }),
        step('fill', { id: 'a', dataSet: 'nope' }),
        step('login', { actor: 'ghost' }),
        step('instruction', { actor: 'stranger' }),
        step('capture', { var: 'later', selector: '#n' }),
        step('check', { expect: 'z', assert: { textPresent: '{{vars.never}} {{bogus.thing}} {{users.who.email}}' } }),
        step('login', { actor: 'participant', recipe: 'admin-2fa' }),
      ],
    };
    const v = ok(await api('POST', `${A}/storyboards/validate`, { storyboard: broken }));
    expect(v.ok).toBe(false);
    expect(codes(v.errors).sort()).toEqual(
      [
        'schema @ actors[3].key',
        'duplicate_step_id @ steps[1].id',
        'missing_user @ actors[1].user',
        'missing_user @ actors[2].user',
        'var_used_before_capture @ steps[0].url',
        'missing_data_set @ steps[1].dataSet',
        'missing_login_recipe @ steps[2].recipe',
        'unknown_actor @ steps[3].actor',
        'var_not_captured @ steps[5].assert.textPresent',
        'unknown_variable @ steps[5].assert.textPresent',
        'unknown_variable @ steps[5].assert.textPresent',
        'missing_login_recipe @ steps[6].recipe',
      ].sort(),
    );
    expect(v.errors.find((e: any) => e.code === 'unknown_actor').expected).toEqual(['participant', 'ghost', 'pat', 'participant']);
    expect(v.errors.find((e: any) => e.code === 'missing_data_set').expected).toEqual(expect.arrayContaining(['sign-up', 'admin-search']));
    expect(codes(v.warnings)).toEqual(['unknown_role @ actors[1].role']);
    expect(v.refs.dataSets).toEqual(['nope']);

    const put = await api('PUT', `${A}/storyboards/broken`, broken);
    expect(put.status).toBe(400);
    expect(put.body.error).toBe(`Storyboard is invalid (${v.errors.length} problems)`);
    expect(put.body.details.errors).toEqual(v.errors);
    expect(put.body.details.warnings).toEqual(v.warnings);
    expect((await api('GET', `${A}/storyboards/broken`)).status).toBe(404);

    // missing_authenticator: a totp recipe naming a label that does not exist, and a user with no linked key.
    ok(await api('PUT', `${A}/login-recipes/participant`, { ...participantRecipe, twoFactor: { kind: 'totp' } }));
    const totp = ok(await api('POST', `${A}/storyboards/validate`, { storyboard: { ...story, steps: [...story.steps, step('login', { actor: 'participant' })], actors: [story.actors[0], story.actors[1], { key: 'pat', role: 'participant', user: 'pat@sb.test' }] } }));
    expect(codes(totp.errors)).toEqual([]);
    expect(codes(totp.warnings)).toEqual(['missing_authenticator @ loginRecipes[participant].twoFactor.authenticator']); // fresh actor: warning
    const pat = ok(await api('POST', `${A}/storyboards/validate`, { storyboard: { ...story, steps: [...story.steps, step('login', { actor: 'pat' })], actors: [...story.actors, { key: 'pat', role: 'participant', user: 'pat@sb.test' }] } }));
    expect(codes(pat.errors)).toEqual(['missing_authenticator @ loginRecipes[participant].twoFactor.authenticator']);
    ok(await api('PUT', `${A}/login-recipes/participant`, { ...participantRecipe, twoFactor: { kind: 'totp', authenticator: 'Nope key' } }));
    const label = ok(await api('POST', `${A}/storyboards/validate`, { storyboard: story }));
    expect(codes(label.errors)).toEqual([]); // the participant logs in nowhere in `story`
    const label2 = ok(await api('POST', `${A}/storyboards/validate`, { storyboard: { ...story, steps: [...story.steps, step('login', { actor: 'participant' })] } }));
    expect(label2.errors[0]).toMatchObject({ code: 'missing_authenticator', path: 'loginRecipes[participant].twoFactor.authenticator', expected: ['Admin key'] });
    ok(await api('PUT', `${A}/login-recipes/participant`, participantRecipe));

    // validate by slug; neither → 400; unknown slug → 404
    const bySlug = ok(await api('POST', `${A}/storyboards/validate`, { slug: 'register' }));
    expect(bySlug).toMatchObject({ ok: true, errors: [], warnings: [], refs: { dataSets: ['sign-up'] } });
    expect((await api('POST', `${A}/storyboards/validate`, {})).status).toBe(400);
    expect((await api('POST', `${A}/storyboards/validate`, { slug: 'nope' })).status).toBe(404);
    expect((await api('PUT', `${A}/storyboards/export`, { ...story, slug: 'export' })).status).toBe(400);
  });

  it('warnings: no app origins, relative URLs, passwords, unknown roles (a bare project)', async () => {
    ok(await api('POST', '/api/projects', { name: 'Bare', slug: 'bare' }), 201);
    ok(await api('POST', '/api/projects/bare/users', { name: 'Root', role: 'admin', email: 'root@bare.test' }), 201);
    ok(await api('PUT', '/api/projects/bare/login-recipes/admin', { loginUrl: '/login' }), 201);
    const r = ok(
      await api('POST', '/api/projects/bare/storyboards/validate', {
        storyboard: { slug: 'b', name: 'B', actors: [{ key: 'admin', role: 'admin' }], steps: [step('open', { url: '/home' }), step('login', { actor: 'admin', url: 'https://x.test/login' })] },
      }),
    );
    expect(r.ok).toBe(true);
    expect(codes(r.warnings)).toEqual(['no_app_origins @ project.appOrigins', 'relative_url_no_origin @ steps[0].url', 'no_password @ actors[0]']);
    // GET shows the issues that exist now (a reference removed later shows up here).
    ok(await api('PUT', '/api/projects/bare/storyboards/b', { slug: 'b', name: 'B', actors: [{ key: 'admin', role: 'admin' }], steps: [step('login', { actor: 'admin' })] }), 201);
    ok(await api('DELETE', '/api/projects/bare/login-recipes/admin?force=1'));
    expect(codes(ok(await api('GET', '/api/projects/bare/storyboards/b')).warnings)).toContain('missing_login_recipe @ steps[0].recipe');
  });

  it('data set preview: actor users, fresh placeholder, deterministic fake values', async () => {
    const r = ok(await api('POST', `${A}/data-sets/sign-up/preview`, {}));
    // Default: the first storyboard using it (register) and the actor of its fill step (the fresh participant).
    expect(r.entries[0]).toEqual({ key: 'email', value: 'participant.preview@sb.test', kind: 'auto' });
    expect(r.entries[2].value).toBe('Pw#12345');
    expect(r.entries[5]).toEqual({ key: 'terms', value: true, kind: 'checkbox' });
    expect(r.warnings).toEqual([]);
    const again = ok(await api('POST', `${A}/data-sets/sign-up/preview`, {}));
    expect(again.entries[3].value).toBe(r.entries[3].value);
    const admin = ok(await api('POST', `${A}/data-sets/sign-up/preview`, { storyboard: 'register', actor: 'admin' }));
    expect(admin.entries[0].value).toBe('admin@sb.test');
    expect(admin.entries[2].value).toBe('AdminPw!1');
    const byRef = ok(await api('POST', `${A}/data-sets/admin-search/preview`, { actor: 'pat@sb.test' }));
    expect(byRef.entries).toEqual([{ key: 'q', value: '', kind: 'auto' }]);
    expect(byRef.warnings[0]).toMatch(/vars\.regNo/);
    expect((await api('POST', `${A}/data-sets/sign-up/preview`, { storyboard: 'register', actor: 'nobody' })).status).toBe(400);
    expect((await api('POST', `${A}/data-sets/sign-up/preview`, { storyboard: 'nope' })).status).toBe(404);
  });

  it('duplicate and delete (409 for used recipes and data sets unless force)', async () => {
    const d = await api('POST', `${A}/storyboards/register/duplicate`, { slug: 'register-copy' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ slug: 'register-copy', name: 'Register for an event (copy)', version: 1 });
    expect(d.body.steps.map((s: any) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    expect((await api('POST', `${A}/storyboards/register/duplicate`, { slug: 'register-copy' })).status).toBe(409);
    expect((await api('POST', `${A}/storyboards/nope/duplicate`, { slug: 'x' })).status).toBe(404);
    expect((await api('POST', `${A}/storyboards/register/duplicate`, { slug: 'Bad' })).status).toBe(400);

    const used = await api('DELETE', `${A}/login-recipes/admin`);
    expect(used.status).toBe(409);
    expect(used.body.details.usedBy).toEqual(['register', 'register-copy']);
    const usedDs = await api('DELETE', `${A}/data-sets/sign-up`);
    expect(usedDs.status).toBe(409);
    expect(ok(await api('DELETE', `${A}/storyboards/register-copy`))).toEqual({ deleted: 'register-copy' });
    expect((await api('GET', `${A}/storyboards/register-copy`)).status).toBe(404);
    expect((await api('DELETE', `${A}/storyboards/register-copy`)).status).toBe(404);
    ok(await api('PUT', `${A}/data-sets/doomed`, { name: 'Doomed', entries: [] }), 201);
    ok(await api('PUT', `${A}/storyboards/doomed`, { ...story, slug: 'doomed', steps: [step('fill', { dataSet: 'doomed' })] }), 201);
    expect((await api('DELETE', `${A}/data-sets/doomed`)).status).toBe(409);
    expect(ok(await api('DELETE', `${A}/data-sets/doomed?force=1`))).toEqual({ deleted: 'doomed' });
    ok(await api('DELETE', `${A}/storyboards/doomed`));
  });

  it('bundle export: referenced items, users, masking, secrets', async () => {
    const all = ok(await api('GET', `${A}/storyboards/export`));
    expect(all.format).toBe('stubyard-storyboards');
    expect(all.version).toBe(1);
    expect(all.project).toEqual({ appOrigins: ['http://localhost:3183'], roles: ['admin', 'participant'] });
    expect(all.storyboards.map((s: any) => s.slug)).toEqual(['ids', 'register']);
    expect(all.dataSets.map((d: any) => d.slug)).toEqual(['admin-search', 'anywhere', 'from-scan', 'sign-up']);
    expect(all.loginRecipes.map((r: any) => r.role)).toEqual(['admin', 'participant']);
    expect(all.users).toEqual([{ email: 'admin@sb.test', name: 'Admin', role: 'admin', phone: '+15550000001' }]);
    const su = all.dataSets.find((d: any) => d.slug === 'sign-up');
    expect(su.entries.map((e: any) => e.value)).toEqual(['{{user.email}}', '***', '{{user.password}}', '{{fake.firstName}}', ['***', '{{fake.digits:4}}'], true]);
    expect(all.storyboards[1].id).toBeUndefined();
    expect(all.storyboards[1].steps[0].id).toBe('s1');

    const named = ok(await api('GET', `${A}/storyboards/export?storyboards=register&secrets=1`));
    expect(named.storyboards.map((s: any) => s.slug)).toEqual(['register']);
    expect(named.dataSets.map((d: any) => d.slug)).toEqual(['sign-up']);
    expect(named.loginRecipes.map((r: any) => r.role)).toEqual(['admin', 'participant']);
    expect(named.users[0].password).toBe('AdminPw!1');
    expect(named.project.defaultPassword).toBe('Pw#12345');
    expect(named.dataSets[0].entries[1].value).toBe('Secret#1');
    expect((await api('GET', `${A}/storyboards/export?storyboards=nope`)).status).toBe(404);
  });

  it('bundle import: dry run, create, idempotent re-import, masked values kept, create-only, replace', async () => {
    const bundle = ok(await api('GET', `${A}/storyboards/export?storyboards=register&secrets=1`));
    ok(await api('POST', '/api/projects', { name: 'Target', slug: 'tgt' }), 201);
    const T = '/api/projects/tgt';
    ok(await api('POST', `${T}/authenticators`, { label: 'Admin key', secret: 'JBSWY3DPEHPK3PXP' }), 201); // the admin recipe names it
    events.length = 0;
    const dry = ok(await api('POST', `${T}/storyboards/import`, { bundle, dryRun: true }));
    expect(dry).toMatchObject({
      ok: true,
      dryRun: true,
      created: { users: ['admin@sb.test'], loginRecipes: ['admin', 'participant'], dataSets: ['sign-up'], storyboards: ['register'] },
      updated: { users: [], loginRecipes: [], dataSets: [], storyboards: [] },
      skipped: [],
    });
    expect((await api('GET', `${T}/storyboards/register`)).status).toBe(404);
    expect(ok(await api('GET', `${T}/users`))).toEqual([]);
    expect(ok(await api('GET', T)).settings.appOrigins).toBeUndefined();
    expect(events.filter((e) => e.type === 'storyboards.changed')).toEqual([]);

    const real = ok(await api('POST', `${T}/storyboards/import`, { bundle }));
    expect(real.dryRun).toBe(false);
    expect(real.created).toEqual(dry.created);
    expect(real.warnings).toEqual([]);
    const sb = ok(await api('GET', `${T}/storyboards/register`));
    expect(sb.version).toBe(1);
    expect(ok(await api('GET', T)).settings).toMatchObject({ appOrigins: ['http://localhost:3183'], roles: ['admin', 'participant'], defaultPassword: 'Pw#12345' });
    expect(events.filter((e) => e.type === 'storyboards.changed').length).toBe(4);
    expect(events.some((e) => e.type === 'user.changed')).toBe(true);

    const again = ok(await api('POST', `${T}/storyboards/import`, { bundle }));
    expect(again.created).toEqual({ users: [], loginRecipes: [], dataSets: [], storyboards: [] });
    expect(again.unchanged).toEqual({ users: ['admin@sb.test'], loginRecipes: ['admin', 'participant'], dataSets: ['sign-up'], storyboards: ['register'] });
    expect(ok(await api('GET', `${T}/storyboards/register`)).version).toBe(1);

    // A masked export re-imported keeps the stored secret values.
    const masked = ok(await api('GET', `${A}/storyboards/export?storyboards=register`));
    const m = ok(await api('POST', `${T}/storyboards/import`, { bundle: masked }));
    expect(m.unchanged.dataSets).toEqual(['sign-up']);
    expect(m.warnings).toEqual([]);
    expect(ok(await api('GET', `${T}/data-sets/sign-up`)).entries[1].value).toBe('Secret#1');
    // … and into an empty project it warns.
    ok(await api('POST', '/api/projects', { name: 'Masked', slug: 'msk' }), 201);
    ok(await api('POST', '/api/projects/msk/authenticators', { label: 'Admin key', secret: 'JBSWY3DPEHPK3PXP' }), 201);
    const mw = ok(await api('POST', '/api/projects/msk/storyboards/import', { bundle: masked }));
    expect(codes(mw.warnings)).toEqual(expect.arrayContaining(['masked_value @ dataSets[0].entries[1].value', 'masked_value @ dataSets[0].entries[4].value']));

    // Changed content: updated + version bump.
    const changed = { ...bundle, storyboards: [{ ...bundle.storyboards[0], description: 'v2' }] };
    const up = ok(await api('POST', `${T}/storyboards/import`, { bundle: changed, mode: 'upsert' }));
    expect(up.updated.storyboards).toEqual(['register']);
    expect(ok(await api('GET', `${T}/storyboards/register`)).version).toBe(2);

    // create-only: existing items are skipped with their path.
    const co = ok(await api('POST', `${T}/storyboards/import`, { bundle: { ...bundle, storyboards: [{ ...bundle.storyboards[0], description: 'v3' }] }, mode: 'create-only' }));
    expect(co.skipped.map((s: any) => s.path)).toEqual(['users[0]', 'loginRecipes[0]', 'loginRecipes[1]', 'dataSets[0]', 'storyboards[0]']);
    expect(ok(await api('GET', `${T}/storyboards/register`)).description).toBe('v2');

    // replace: what the bundle lacks goes; what it has stays (same id).
    ok(await api('PUT', `${T}/data-sets/extra`, { name: 'Extra', entries: [] }), 201);
    const before = ok(await api('GET', `${T}/storyboards/register`));
    const rep = ok(await api('POST', `${T}/storyboards/import`, { bundle, mode: 'replace' }));
    expect(rep.updated.storyboards).toEqual(['register']);
    expect((await api('GET', `${T}/data-sets/extra`)).status).toBe(404);
    const after = ok(await api('GET', `${T}/storyboards/register`));
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(3);
    expect((await api('POST', `${T}/storyboards/import`, { bundle, mode: 'merge' })).status).toBe(400);
    expect((await api('POST', `${T}/storyboards/import`, {})).status).toBe(400);
  });

  it('bundle import: validation as a whole with prefixed paths, and transactional rollback', async () => {
    ok(await api('POST', '/api/projects', { name: 'Roll', slug: 'roll' }), 201);
    const R = '/api/projects/roll';
    ok(await api('POST', `${R}/users`, { name: 'Taken', role: 'admin', email: 'taken@roll.test', phone: '+15559990000' }), 201);

    const schemaBad = await api('POST', `${R}/storyboards/import`, { bundle: { format: 'stubyard-storyboards', version: 1, storyboards: [{ ...story, steps: [step('open')] }] } });
    expect(schemaBad.status).toBe(400);
    expect(schemaBad.body.error).toMatch(/^Bundle is invalid/);
    expect(schemaBad.body.details.errors.map((e: any) => e.path)).toEqual(['storyboards[0].steps[0].url']);
    expect((await api('POST', `${R}/storyboards/import`, { bundle: { format: 'nope', version: 1 } })).status).toBe(400);

    // Cross-references are satisfied by DB ∪ bundle; what is missing is listed with the bundle path.
    const refs = await api('POST', `${R}/storyboards/import`, {
      bundle: {
        format: 'stubyard-storyboards',
        version: 1,
        project: { appOrigins: ['http://localhost:9999', 'nope'] },
        users: [{ email: 'admin@sb.test', name: 'Admin', role: 'admin' }],
        loginRecipes: [participantRecipe, participantRecipe],
        storyboards: [story, { ...story, slug: 'second', steps: [step('fill', { dataSet: 'sign-up' })] }],
      },
    });
    expect(refs.status).toBe(400);
    expect(codes(refs.body.details.errors).sort()).toEqual(
      [
        'schema @ loginRecipes[1].role',
        'schema @ project.appOrigins[1]',
        'missing_data_set @ storyboards[0].steps[1].dataSet',
        'missing_login_recipe @ storyboards[0].steps[4].recipe',
        'missing_data_set @ storyboards[1].steps[0].dataSet',
      ].sort(),
    );
    expect(ok(await api('GET', `${R}/users`)).map((u: any) => u.email)).toEqual(['taken@roll.test']);

    // A write that fails inside the transaction (phone already taken) rolls back the settings and the earlier user.
    const fail = await api('POST', `${R}/storyboards/import`, {
      bundle: {
        format: 'stubyard-storyboards',
        version: 1,
        project: { appOrigins: ['http://localhost:9999'] },
        users: [
          { email: 'first@roll.test', name: 'First', role: 'admin', phone: '+15559990001' },
          { email: 'second@roll.test', name: 'Second', role: 'admin', phone: '+15559990000' },
        ],
        loginRecipes: [adminRecipe],
      },
    });
    expect(fail.status).toBe(409);
    expect(fail.body.error).toMatch(/^Import failed at users\[1\]: /);
    expect(fail.body.details.errors[0].path).toBe('users[1]');
    expect(ok(await api('GET', `${R}/users`)).map((u: any) => u.email)).toEqual(['taken@roll.test']);
    expect(ok(await api('GET', R)).settings.appOrigins).toBeUndefined();
    expect(ok(await api('GET', `${R}/login-recipes`))).toEqual([]);
    // The same failure in a dry run is reported too.
    expect((await api('POST', `${R}/storyboards/import`, { bundle: { format: 'stubyard-storyboards', version: 1, users: [{ email: 'x@roll.test', name: 'X', role: 'admin', phone: '+15559990000' }] }, dryRun: true })).status).toBe(409);
  });

  it('project reset: page snapshots go, authoring stays', async () => {
    ok(await api('POST', `${A}/page-snapshots`, { url: 'http://localhost:3183/x', fields: [] }), 201);
    expect(ok(await api('GET', `${A}/page-snapshots`)).length).toBeGreaterThan(0);
    ok(await api('POST', `${A}/reset`, {}));
    expect(ok(await api('GET', `${A}/page-snapshots`))).toEqual([]);
    expect(ok(await api('GET', `${A}/storyboards`)).length).toBe(2);
    expect(ok(await api('GET', `${A}/data-sets`)).length).toBeGreaterThan(0);
    expect(ok(await api('GET', `${A}/login-recipes`)).length).toBe(2);
  });

  it('project export / import round trip (masked without secrets)', async () => {
    const plain = ok(await api('GET', `${A}/export`));
    expect(Object.keys(plain).indexOf('loginRecipes')).toBe(Object.keys(plain).indexOf('users') + 1);
    expect(plain.loginRecipes.map((r: any) => r.role)).toEqual(['admin', 'participant']);
    expect(plain.storyboards.map((s: any) => s.slug)).toEqual(['ids', 'register']);
    expect(plain.dataSets.find((d: any) => d.slug === 'sign-up').entries[1].value).toBe('***');
    const full = ok(await api('GET', `${A}/export?secrets=1`));
    expect(full.dataSets.find((d: any) => d.slug === 'sign-up').entries[1].value).toBe('Secret#1');

    const imp = ok(await api('POST', '/api/projects/import', { json: full, slug: 'copy' }), 201);
    expect(imp.imported).toMatchObject({ loginRecipes: 2, dataSets: 4, storyboards: 2 });
    const strip = (x: any) => {
      const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = x;
      return rest;
    };
    for (const kind of ['storyboards/register', 'data-sets/sign-up', 'login-recipes/admin']) {
      const a = ok(await api('GET', `${A}/${kind}`));
      const b = ok(await api('GET', `/api/projects/copy/${kind}`));
      expect(strip(b), kind).toEqual({ ...strip(a), ...(kind.startsWith('storyboards') ? { version: 1 } : {}) });
    }

    const imp2 = ok(await api('POST', '/api/projects/import', { json: plain, slug: 'copy2' }), 201);
    expect(imp2.warnings.join('\n')).toMatch(/Data set "sign-up": masked values/);
    // Existing slugs are skipped with a warning (replace mode clears first, so nothing is skipped there).
    const rep = ok(await api('POST', '/api/projects/import', { json: full, slug: 'copy', mode: 'replace' }));
    expect(rep.imported.storyboards).toBe(2);
  });
});

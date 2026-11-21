import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { GUIDE_TOPICS } from '../src/storyboards/guide.js';
import { CLASS_PROVIA_PILOT, describeStoryboards, exampleOf, exampleSchemaOf, OBJECT_NAMES, ontologyDrift, VALIDATION_CODES } from '../src/storyboards/ontology.js';
import { Bundle } from '../src/storyboards/schema.js';

/**
 * Storyboards over MCP (docs/design/storyboards.md §4, Slice 3): the Class PROvia pilot is built purely through MCP
 * JSON-RPC calls on a fresh hub (the authenticator secret is the only REST setup), then validated, re-run for
 * idempotency, imported / exported as a bundle, and read back after a REST-driven walkthrough.
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
let close: () => Promise<void>;
let base: string;
let dataDir: string;

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
const rpc = async (method: string, params: unknown = {}) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params });
  expect(r.status).toBe(200);
  return r.body;
};
const callTool = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.result as { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
};
/** A tool call that must succeed: its parsed JSON (or the text when it is not JSON). */
const mcp = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res = await callTool(name, args);
  const text = res.content[0].text;
  expect(res.isError, `${name}: ${text}`).toBeFalsy();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
/** A tool call that must fail: its error text. */
const mcpError = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await callTool(name, args);
  expect(res.isError, `${name} should fail`).toBe(true);
  return res.content[0].text;
};

const P = 'classprovia';
const PB = `/api/projects/${P}`;
const PILOT = CLASS_PROVIA_PILOT;
const PILOT_SB = PILOT.storyboards[0];
const signUp = PILOT.dataSets.find((d) => d.slug === 'person-sign-up')!;
const eventReg = PILOT.dataSets.find((d) => d.slug === 'event-registration')!;

const TOOL_NAMES = [
  'describe_storyboards',
  'storyboard_guide',
  'set_app_origins',
  'upsert_test_user',
  'list_authenticators',
  'upsert_login_recipe',
  'list_login_recipes',
  'delete_login_recipe',
  'upsert_data_set',
  'patch_data_set_entries',
  'list_data_sets',
  'get_data_set',
  'delete_data_set',
  'preview_data_set',
  'save_page_snapshot',
  'list_page_snapshots',
  'get_page_snapshot',
  'data_set_from_snapshot',
  'upsert_storyboard',
  'validate_storyboard',
  'list_storyboards',
  'get_storyboard',
  'delete_storyboard',
  'import_storyboard_bundle',
  'export_storyboard_bundle',
  'list_walkthroughs',
  'get_walkthrough_result',
];

/** Fields of the sign-up page as an agent pastes them from the page source. */
const SIGN_UP_FIELDS = [
  { key: 'email', id: 'email', inputType: 'email', label: 'Email', required: true },
  { key: 'password', id: 'password', inputType: 'password', label: 'Password', required: true },
  { key: 'confirmPassword', id: 'confirmPassword', inputType: 'password', label: 'Confirm password', required: true },
  { key: 'title', id: 'title', kind: 'radix-select', label: 'Title', options: [{ value: 'dr', label: 'Dr' }, { value: 'mr', label: 'Mr' }] },
  { key: 'firstName', id: 'firstName', label: 'First name', required: true },
  { key: 'lastName', id: 'lastName', label: 'Last name', required: true },
  { key: 'phone', id: 'phone', inputType: 'tel', label: 'Phone' },
  { key: 'nationality', id: 'nationality', label: 'Nationality' },
  { key: 'country', id: 'country', label: 'Country' },
  { key: 'organisationName', id: 'organisationName', label: 'Organisation' },
  { key: 'jobTitle', id: 'jobTitle', label: 'Job title' },
  { key: 'preferredLanguage', id: 'preferredLanguage', kind: 'radix-select', label: 'Preferred language' },
  { key: 'newsletter', id: 'newsletter', inputType: 'checkbox', kind: 'checkbox', visible: false },
];
const SIGN_UP_VALUES = Object.fromEntries(signUp.entries.map((e) => [e.key, e.value as string]));

/** Steps 2-8 of the Slice 3 list (the project exists). Returns the statuses each upsert reported. */
async function buildPilot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out.origins = (await mcp('set_app_origins', { project: P, origins: ['http://localhost:3183/'], roles: ['admin', 'participant'] })).status;
  const admin = await mcp('upsert_test_user', { project: P, email: 'admin@classprovia.test', name: 'Class PROvia admin', role: 'admin', notes: PILOT.users[0].notes });
  out.user = admin.status;
  out.recipes = [];
  for (const recipe of PILOT.loginRecipes) (out.recipes as unknown[]).push((await mcp('upsert_login_recipe', { project: P, recipe })).status);
  const snap = await mcp('save_page_snapshot', { project: P, url: '/auth/person/register', title: 'Create your account', fields: SIGN_UP_FIELDS });
  expect(snap).toMatchObject({ url: 'http://localhost:3183/auth/person/register', urlPattern: '/auth/person/register', fields: SIGN_UP_FIELDS.length });
  const fromSnap = await mcp('data_set_from_snapshot', { project: P, snapshot: snap.id, slug: 'person-sign-up', name: signUp.name, values: SIGN_UP_VALUES });
  out.fromSnapshot = fromSnap.status;
  out.snapshotDataSet = fromSnap.dataSet;
  out.eventReg = (await mcp('upsert_data_set', { project: P, dataSet: eventReg })).status;
  const sb = await mcp('upsert_storyboard', { project: P, storyboard: PILOT_SB });
  out.storyboard = { status: sb.status, version: sb.version, steps: sb.steps, errors: sb.warnings.filter((w: any) => w.code !== 'no_password') };
  return out;
}

const BROKEN = {
  slug: 'broken',
  name: 'Broken on purpose',
  actors: [{ key: 'admin', role: 'admin', user: 'admin@classprovia.test' }],
  steps: [
    { id: 'open', kind: 'open', title: 'Open', intent: 'Open the registration.', url: '/admin/registrations/{{vars.regNo}}' },
    { id: 'fill', kind: 'fill', title: 'Fill', intent: 'Fill a form that does not exist.', dataSet: 'no-such-form' },
    { id: 'click', kind: 'instruction', actor: 'ghost', title: 'Click', intent: 'Someone who is not an actor clicks.' },
    { id: 'login', kind: 'login', actor: 'admin', recipe: 'auditor', title: 'Log in', intent: 'Log in with a recipe that does not exist.' },
  ],
};

describe('storyboards over MCP', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-storyboards-mcp-'));
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
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists every storyboard tool and points to describe_storyboards in the instructions', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result.instructions).toContain('To author manual test walkthroughs, call describe_storyboards first.');
    const tools = (await rpc('tools/list')).result.tools as { name: string; inputSchema: any; annotations?: any }[];
    const names = tools.map((t) => t.name);
    for (const n of TOOL_NAMES) expect(names, n).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools.filter((x) => TOOL_NAMES.includes(x.name) && !['describe_storyboards', 'storyboard_guide'].includes(x.name))) expect(t.inputSchema.required, t.name).toContain('project');
    expect(tools.find((t) => t.name === 'get_walkthrough_result')!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('describe_storyboards: overview with relations, build order, enums, variables and every validation code', async () => {
    const d = await mcp('describe_storyboards', {});
    expect(d.objects.map((o: any) => o.name)).toEqual(OBJECT_NAMES);
    for (const n of ['project', 'role', 'loginRecipe', 'testUser', 'authenticator', 'storyboard', 'actor', 'input', 'step', 'step.open', 'step.login', 'step.logout', 'step.fill', 'step.email', 'step.instruction', 'step.capture', 'step.check', 'dataSet', 'dataEntry', 'pageSnapshot', 'templateVariables', 'walkthrough', 'agentRun']) {
      expect(OBJECT_NAMES, n).toContain(n);
    }
    expect(d.relations).toContainEqual(expect.objectContaining({ from: 'step(fill).dataSet', to: 'dataSet.slug', mustExistFirst: true }));
    expect(d.relations.some((r: any) => r.from === 'agentRun' && /RESERVED/.test(r.note))).toBe(true);
    expect(d.buildOrder.length).toBeGreaterThan(5);
    expect(d.enums.stepKinds).toEqual(['open', 'login', 'logout', 'fill', 'email', 'instruction', 'capture', 'check']);
    expect(d.enums.fieldKinds).toContain('radix-select');
    expect(d.enums.twoFactorKinds).toEqual(['none', 'totp', 'email-otp', 'sms-otp']);
    expect(d.enums.walkthroughStatus).toEqual(['active', 'finished', 'abandoned']);
    expect(d.variables.map((v: any) => v.name)).toContain('unique');
    expect(d.validationCodes.map((c: any) => c.code).sort()).toEqual(Object.keys(VALIDATION_CODES).sort());
    for (const c of d.validationCodes) expect(c.meaning && c.fix && c.severity, c.code).toBeTruthy();
  });

  it('describe_storyboards {object}: fields, jsonSchema and a valid example for every object; docs match the schemas', async () => {
    expect(ontologyDrift()).toEqual([]);
    for (const name of OBJECT_NAMES) {
      const o = await mcp('describe_storyboards', { object: name });
      expect(o.name).toBe(name);
      expect(o.is.length, name).toBeGreaterThan(20);
      expect(o.jsonSchema && typeof o.jsonSchema === 'object', name).toBe(true);
      expect(o.example, name).toBeDefined();
      expect(Array.isArray(o.pitfalls), name).toBe(true);
      expect(o.fields.length, name).toBeGreaterThan(0);
      for (const f of o.fields) expect(f.rules, `${name}.${f.name}`).toBeTruthy();
      const schema = exampleSchemaOf(name);
      if (schema) {
        const r = schema.safeParse(exampleOf(name));
        expect(r.success, `${name} example: ${JSON.stringify(r.error?.issues)}`).toBe(true);
      }
    }
    const email = await mcp('describe_storyboards', { object: 'step.email' });
    expect(email.fields.find((f: any) => f.name === 'actor')).toMatchObject({ required: true, refersTo: 'storyboard.actors[].key' });
    expect(email.fields.find((f: any) => f.name === 'open')).toMatchObject({ default: 'same-tab', enum: ['same-tab', 'new-tab', 'none'] });
    expect(email.fields.map((f: any) => f.name)).toContain('link.pattern');
    const ds = await mcp('describe_storyboards', { object: 'dataSet' });
    expect(ds.pitfalls.join('\n')).toMatch(/Radix selects: kind radix-select; value = visible option text/);
    expect(ds.pitfalls.join('\n')).toMatch(/\{\{unique\}\}/);
    expect((await mcp('describe_storyboards', { object: 'step.fill' })).pitfalls.join('\n')).toMatch(/fill never clicks Next\/Submit: add an instruction step after it/);
    expect((await mcp('describe_storyboards', { object: 'storyboard' })).example).toEqual(PILOT_SB);
    expect((await mcp('describe_storyboards', { object: 'templateVariables' })).fields.map((f: any) => f.name)).toContain('{{fake.phone}}');
    expect(await mcpError('describe_storyboards', { object: 'nope' })).toMatch(/Unknown object "nope"/);
  });

  it('storyboard_guide: the topic list and every topic as markdown', async () => {
    const list = await mcp('storyboard_guide', {});
    for (const t of GUIDE_TOPICS) expect(list).toContain(`\`${t}\``);
    for (const t of ['business-flow', 'forms', 'login', 'email', 'variables', 'multi-step-forms', 'checklist']) {
      const md = await mcp('storyboard_guide', { topic: t });
      expect(typeof md).toBe('string');
      expect(md.startsWith('# '), t).toBe(true);
    }
    expect(await mcp('storyboard_guide', { topic: 'business-flow' })).toMatch(/logout.*\+.*login/);
    expect(await mcpError('storyboard_guide', { topic: 'nope' })).toMatch(/Unknown topic/);
  });

  it('docs/examples/classprovia-storyboards.json is the pilot and passes the bundle schema', () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/examples/classprovia-storyboards.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(json).toEqual(PILOT);
    expect(Bundle.safeParse(json).success).toBe(true);
  });

  it('builds the Class PROvia pilot through MCP, validates a broken storyboard, and re-runs idempotently', async () => {
    // 1. Project.
    const created = await mcp('create_project', { name: 'Class PROvia', slug: P });
    expect(created.project.slug).toBe(P);
    // Before origins: a relative snapshot URL cannot be resolved.
    expect(await mcpError('save_page_snapshot', { project: P, url: '/x', fields: [{ key: 'a' }] })).toMatch(/no appOrigins/);
    // A bad origin is refused by REST and the message reaches the agent.
    expect(await mcpError('set_app_origins', { project: P, origins: ['localhost:3183/path'] })).toMatch(/stubyard answered 400: .*appOrigins\[0\]/);
    // 2. The authenticator is the one REST step (its secret is test data a human would enter).
    await ok('POST', `${PB}/authenticators`, { label: 'Class PROvia admin 2FA', secret: 'JBSWY3DPEHPK3PXP' }, 201);
    expect(await mcp('list_authenticators', { project: P })).toEqual([expect.objectContaining({ label: 'Class PROvia admin 2FA', testUserId: null })]);

    // 2-8.
    const first = await buildPilot();
    expect(first).toMatchObject({ origins: 'updated', user: 'created', recipes: ['created', 'created'], fromSnapshot: 'created', eventReg: 'created' });
    expect(first.storyboard).toEqual({ status: 'created', version: 1, steps: PILOT_SB.steps.length, errors: [] });
    const fromSnap = first.snapshotDataSet as any;
    expect(fromSnap.match).toEqual({ urlPattern: '/auth/person/register' });
    // Only visible fields; keys, kinds and labels from the snapshot; values from `values`.
    expect(fromSnap.entries.map((e: any) => e.key)).toEqual(signUp.entries.map((e) => e.key));
    expect(fromSnap.entries.find((e: any) => e.key === 'title')).toEqual({ key: 'title', value: 'Dr', kind: 'radix-select', label: 'Title' });
    expect(fromSnap.entries.find((e: any) => e.key === 'email')).toMatchObject({ value: '{{user.email}}', kind: 'auto' });

    const project = await ok('GET', PB);
    expect(project.settings).toMatchObject({ appOrigins: ['http://localhost:3183'], roles: ['admin', 'participant'] });

    // Read tools.
    expect((await mcp('list_login_recipes', { project: P })).map((r: any) => r.role).sort()).toEqual(['admin', 'participant']);
    const sets = await mcp('list_data_sets', { project: P, url: 'http://localhost:3183/register/HCE27' });
    expect(sets.map((d: any) => d.slug)).toEqual(['event-registration']);
    expect(sets[0]).toMatchObject({ entries: eventReg.entries.length, usedBy: ['registration-approval'] });
    expect((await mcp('get_data_set', { project: P, slug: 'event-registration' })).entries).toHaveLength(eventReg.entries.length);
    const snaps = await mcp('list_page_snapshots', { project: P });
    expect(snaps[0]).toMatchObject({ source: 'agent', fields: SIGN_UP_FIELDS.length });
    expect((await mcp('get_page_snapshot', { project: P, id: snaps[0].id })).fields[3]).toMatchObject({ key: 'title', kind: 'radix-select', name: null, visible: true, options: [{ value: 'dr', label: 'Dr' }, { value: 'mr', label: 'Mr' }] });
    const preview = await mcp('preview_data_set', { project: P, slug: 'person-sign-up' });
    expect(preview.entries.find((e: any) => e.key === 'email').value).toBe('participant.preview@classprovia.test');
    expect(preview.entries.find((e: any) => e.key === 'organisationName').value).toBe('Flow Test Org preview');
    expect(preview.warnings).toEqual([]);
    expect(await mcp('list_storyboards', { project: P, tag: 'REG-02' })).toEqual([expect.objectContaining({ slug: 'registration-approval', version: 1, steps: 21 })]);
    expect((await mcp('get_storyboard', { project: P, slug: 'registration-approval' })).refs).toMatchObject({ dataSets: ['person-sign-up', 'event-registration'], vars: { captured: ['regNo'], inputs: ['event'] } });

    // 7. A deliberately broken storyboard: every issue with its code and path.
    const v = await mcp('validate_storyboard', { project: P, storyboard: BROKEN });
    expect(v.ok).toBe(false);
    const issues = v.errors.map((e: any) => `${e.code} ${e.path}`);
    expect(issues).toEqual(expect.arrayContaining(['var_not_captured steps[0].url', 'missing_data_set steps[1].dataSet', 'unknown_actor steps[2].actor', 'missing_login_recipe steps[3].recipe']));
    expect(v.errors.find((e: any) => e.code === 'missing_data_set').expected.sort()).toEqual(['event-registration', 'person-sign-up']);
    expect(v.errors.find((e: any) => e.code === 'unknown_actor').expected).toEqual(['admin']);
    expect(v.errors.find((e: any) => e.code === 'missing_login_recipe').expected.sort()).toEqual(['admin', 'participant']);
    // The same through a write: the 400 text carries every issue as JSON.
    const err = await mcpError('upsert_storyboard', { project: P, storyboard: BROKEN });
    expect(err).toMatch(/^stubyard answered 400: Storyboard is invalid \(4 problems\)\n/);
    const details = JSON.parse(err.slice(err.indexOf('\n') + 1));
    expect(details.errors.map((e: any) => e.path)).toEqual(expect.arrayContaining(['steps[0].url', 'steps[1].dataSet', 'steps[2].actor', 'steps[3].recipe']));
    expect(await mcpError('get_storyboard', { project: P, slug: 'broken' })).toMatch(/stubyard answered 404/);
    // Saved by slug validates too; a schema error names the field.
    expect((await mcp('validate_storyboard', { project: P, slug: 'registration-approval' })).ok).toBe(true);
    const schema = await mcp('validate_storyboard', { project: P, storyboard: { ...BROKEN, steps: [{ kind: 'capture', title: 'x', intent: 'x', var: 'n' }] } });
    expect(schema.errors).toEqual([expect.objectContaining({ code: 'schema', path: 'steps[0].selector' })]);

    // 9. The whole sequence again: nothing changes.
    const again = await buildPilot();
    expect(again).toMatchObject({ origins: 'unchanged', user: 'unchanged', recipes: ['unchanged', 'unchanged'], fromSnapshot: 'exists', eventReg: 'unchanged' });
    expect(again.storyboard).toEqual({ status: 'unchanged', version: 1, steps: PILOT_SB.steps.length, errors: [] });
    expect((await ok('GET', `${PB}/data-sets/person-sign-up`)).updatedAt).toBe(fromSnap.updatedAt);

    // patch_data_set_entries: merge by key, remove, unchanged on a no-op.
    const patched = await mcp('patch_data_set_entries', { project: P, slug: 'event-registration', upsert: [{ key: 'fld-extra', value: 'x' }] });
    expect(patched.status).toBe('updated');
    expect(patched.dataSet.entries.at(-1)).toEqual({ key: 'fld-extra', value: 'x', kind: 'auto' });
    expect((await mcp('patch_data_set_entries', { project: P, slug: 'event-registration', remove: ['fld-extra'] })).status).toBe('updated');
    expect((await mcp('patch_data_set_entries', { project: P, slug: 'event-registration', remove: ['fld-extra'] })).status).toBe('unchanged');

    // A changed storyboard bumps the version; changing it back bumps it again.
    const changed = await mcp('upsert_storyboard', { project: P, storyboard: { ...PILOT_SB, tags: ['registration'] } });
    expect(changed).toMatchObject({ status: 'updated', version: 2 });
    expect(await mcp('upsert_storyboard', { project: P, storyboard: PILOT_SB })).toMatchObject({ status: 'updated', version: 3 });

    // Deletes are guarded while storyboards use the item.
    expect(await mcpError('delete_data_set', { project: P, slug: 'event-registration' })).toMatch(/^stubyard answered 409: .*used by storyboard registration-approval.*\n[\s\S]*"usedBy"/);
    expect(await mcpError('delete_login_recipe', { project: P, role: 'admin' })).toMatch(/stubyard answered 409/);
  });

  it('imports the example bundle (dry run, then for real) and exports it back', async () => {
    // Validation as a whole: a broken bundle lists issues with collection-prefixed paths.
    const bad = await mcpError('import_storyboard_bundle', { project: P, bundle: { format: 'stubyard-storyboards', version: 1, storyboards: [BROKEN] }, dry_run: true });
    expect(bad).toMatch(/^stubyard answered 400: Bundle is invalid/);
    expect(bad).toContain('"path": "storyboards[0].steps[1].dataSet"');

    const before = await ok('GET', `${PB}/data-sets/person-sign-up`);
    const dry = await mcp('import_storyboard_bundle', { project: P, bundle: JSON.stringify(PILOT), dry_run: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    // The from-snapshot data set (labels, description) differs from the example; everything else is already there.
    expect(dry.updated).toEqual({ users: [], loginRecipes: [], dataSets: ['person-sign-up'], storyboards: [] });
    expect(dry.unchanged).toEqual({ users: ['admin@classprovia.test'], loginRecipes: ['participant', 'admin'], dataSets: ['event-registration'], storyboards: ['registration-approval'] });
    expect((await ok('GET', `${PB}/data-sets/person-sign-up`)).updatedAt).toBe(before.updatedAt);

    const real = await mcp('import_storyboard_bundle', { project: P, bundle: PILOT });
    expect(real).toMatchObject({ ok: true, dryRun: false, updated: { dataSets: ['person-sign-up'] } });
    expect((await mcp('import_storyboard_bundle', { project: P, bundle: PILOT })).updated).toEqual({ users: [], loginRecipes: [], dataSets: [], storyboards: [] });

    // 11. Export = the example (with its defaults filled in), modulo order.
    const exported = await mcp('export_storyboard_bundle', { project: P });
    const want = Bundle.parse(PILOT);
    const byKey = <T extends Record<string, unknown>>(list: T[], k: string) => [...list].sort((a, b) => String(a[k]).localeCompare(String(b[k])));
    expect(exported.format).toBe('stubyard-storyboards');
    expect(exported.project).toEqual(want.project);
    expect(exported.users).toEqual(want.users);
    expect(byKey(exported.loginRecipes, 'role')).toEqual(byKey(want.loginRecipes, 'role'));
    expect(byKey(exported.dataSets, 'slug')).toEqual(byKey(want.dataSets, 'slug'));
    expect(exported.storyboards).toEqual(want.storyboards);
    // Named export: the storyboard and only what it references.
    const named = await mcp('export_storyboard_bundle', { project: P, storyboards: ['registration-approval'] });
    expect(named.dataSets.map((d: any) => d.slug).sort()).toEqual(['event-registration', 'person-sign-up']);
    expect(await mcpError('export_storyboard_bundle', { project: P, storyboards: ['nope'] })).toMatch(/stubyard answered 404/);
  });

  it('reads a REST-driven walkthrough back with get_walkthrough_result and list_walkthroughs', async () => {
    const w = await ok('POST', `${PB}/walkthroughs`, { storyboard: 'registration-approval', label: 'pilot run' }, 201);
    expect(w.vars).toEqual({ event: 'HCE27' });
    expect(w.actors.participant).toMatchObject({ created: true, email: `participant.${w.key}@classprovia.test` });
    expect(w.actors.admin).toMatchObject({ created: false, email: 'admin@classprovia.test' });
    const W = `${PB}/walkthroughs/${w.id}`;
    const login = await ok('POST', `${W}/steps/admin-login/resolve`, {});
    expect(login.twoFactor).toMatchObject({ kind: 'totp', selector: '#code', label: 'Class PROvia admin 2FA' });
    expect(login.url).toBe('http://localhost:3183/auth/staff-user/login');
    await ok('PATCH', `${W}/steps/signup-open`, { status: 'done' });
    await ok('PATCH', `${W}/steps/reg-no`, { status: 'done', value: 'HCE27-P-0042' });
    await ok('PATCH', `${W}/steps/pending-check`, { status: 'failed', note: 'Badge said Approved straight away' });
    await ok('POST', `${W}/finish`, { verdict: 'partial', signedOffBy: 'QA', note: 'stopped early', allowIncomplete: true });

    const list = await mcp('list_walkthroughs', { project: P, storyboard: 'registration-approval' });
    expect(list).toEqual([expect.objectContaining({ key: w.key, status: 'finished', verdict: 'partial' })]);
    expect(await mcp('list_walkthroughs', { project: P, status: 'active' })).toEqual([]);

    const r = await mcp('get_walkthrough_result', { project: P, id: w.key });
    expect(r.walkthrough).toMatchObject({ id: w.id, status: 'finished', verdict: 'partial', storyboard: { slug: 'registration-approval', version: 3 } });
    expect(r.vars).toEqual({ event: 'HCE27', regNo: 'HCE27-P-0042' });
    expect(r.steps.find((s: any) => s.id === 'reg-no')).toMatchObject({ status: 'done', data: { value: 'HCE27-P-0042' } });
    expect(r.steps.find((s: any) => s.id === 'pending-check')).toMatchObject({ status: 'failed', note: 'Badge said Approved straight away' });
    expect(r.steps.find((s: any) => s.id === 'approve')).toMatchObject({ status: 'skipped' });
    expect(r.actors.participant.password).toBe('***');
    expect(r.signoff).toMatchObject({ verdict: 'partial', signedOffBy: 'QA' });
    expect(await mcpError('get_walkthrough_result', { project: P, id: 'nope' })).toMatch(/stubyard answered 404/);
  });

  it('preferredMode through upsert_storyboard / list_storyboards; list_walkthroughs leaves quick runs out unless asked', async () => {
    const quickSb = { ...PILOT_SB, slug: 'quick-approval', preferredMode: 'quick' };
    const up = await mcp('upsert_storyboard', { project: P, storyboard: quickSb });
    expect(up).toMatchObject({ status: 'created', version: 1, storyboard: { preferredMode: 'quick' } });
    expect(await mcp('upsert_storyboard', { project: P, storyboard: quickSb })).toMatchObject({ status: 'unchanged', version: 1 });
    expect((await mcp('get_storyboard', { project: P, slug: 'quick-approval' })).preferredMode).toBe('quick');
    const list = await mcp('list_storyboards', { project: P });
    expect(list.find((x: any) => x.slug === 'quick-approval').preferredMode).toBe('quick');
    expect(list.find((x: any) => x.slug === 'registration-approval').preferredMode).toBe('tracked');
    expect(await mcpError('upsert_storyboard', { project: P, storyboard: { ...quickSb, preferredMode: 'fast' } })).toContain('"path": "preferredMode"');
    const exported = await mcp('export_storyboard_bundle', { project: P, storyboards: ['quick-approval'] });
    expect(exported.storyboards[0].preferredMode).toBe('quick');

    const q = await ok('POST', `${PB}/walkthroughs`, { storyboard: 'quick-approval', mode: 'quick' }, 201);
    expect(q.mode).toBe('quick');
    expect(await mcp('list_walkthroughs', { project: P, storyboard: 'quick-approval' })).toEqual([]);
    expect(await mcp('list_walkthroughs', { project: P, storyboard: 'quick-approval', mode: 'all' })).toEqual([expect.objectContaining({ key: q.key, mode: 'quick' })]);
    expect((await mcp('get_walkthrough_result', { project: P, id: q.key })).walkthrough).toMatchObject({ mode: 'quick', status: 'active' });
    expect((await mcp('describe_storyboards', {})).enums.runMode).toEqual(['tracked', 'quick']);
    expect(await mcp('storyboard_guide', { topic: 'checklist' })).toMatch(/preferredMode/);
    await ok('DELETE', `${PB}/walkthroughs/${q.id}?users=1`);
    await ok('DELETE', `${PB}/storyboards/quick-approval`);
  });
});

// The overview is plain data: make sure it serialises (no zod objects leak into the MCP answer).
it('describeStoryboards() is JSON-serialisable', () => {
  expect(() => JSON.stringify(describeStoryboards())).not.toThrow();
  for (const n of OBJECT_NAMES) expect(JSON.parse(JSON.stringify(describeStoryboards(n))).name).toBe(n);
});

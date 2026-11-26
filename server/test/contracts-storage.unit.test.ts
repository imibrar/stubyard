import { beforeEach, describe, expect, it } from 'vitest';
import { SpecRepo, normalizeSpecPrefix } from '../src/contracts/repo.js';
import { openDb, type DB } from '../src/db/index.js';
import { MockRepo, mockContentHash } from '../src/repos/mocks.js';
import { ProjectRepo } from '../src/repos/projects.js';
import { WebhookRepo } from '../src/repos/webhooks.js';

let db: DB;
let projectId: string;
let otherProjectId: string;
let specs: SpecRepo;
let mocks: MockRepo;
let hooks: WebhookRepo;

const doc = { openapi: '3.1.0', info: { title: 'CRM', version: '1.0' }, paths: { '/users': { get: {} } } };
const spec = (over: Record<string, unknown> = {}) => ({ name: 'crm', openapiVersion: '3.1.0', title: 'CRM', apiVersion: '1.0', document: doc, hash: 'h1', operations: 1, ...over });

beforeEach(() => {
  db = openDb(':memory:');
  const projects = new ProjectRepo(db);
  projectId = projects.create({ name: 'Hyper' }).id;
  otherProjectId = projects.create({ name: 'Other' }).id;
  specs = new SpecRepo(db);
  mocks = new MockRepo(db);
  hooks = new WebhookRepo(db);
});

describe('SpecRepo', () => {
  it('creates with defaults, reads by id/name and lists without the document', () => {
    const s = specs.create(projectId, spec({ prefix: 'crm/', source: { kind: 'url', url: 'https://x.test/openapi.json' } }));
    expect(s).toMatchObject({
      name: 'crm', role: 'mock', mode: 'report', prefix: '/crm', openapiVersion: '3.1.0', title: 'CRM', apiVersion: '1.0',
      source: { kind: 'url', url: 'https://x.test/openapi.json' }, warnings: [], operations: 1, hash: 'h1',
      options: { unknownParams: 'ignore', unknownFields: 'ignore', checkAuth: true, include: {} },
    });
    expect(s.document).toEqual(doc);
    expect(specs.get(s.id)?.name).toBe('crm');
    expect(specs.byName(projectId, 'crm')?.id).toBe(s.id);
    expect(specs.byName(otherProjectId, 'crm')).toBeNull();
    expect(specs.require(projectId, 'crm').id).toBe(s.id);
    expect(specs.require(projectId, s.id).id).toBe(s.id);
    expect(() => specs.require(projectId, 'nope')).toThrow(/not found/);
    const list = specs.list(projectId);
    expect(list).toHaveLength(1);
    expect('document' in list[0]).toBe(false);
    expect(specs.list(projectId, { withDocument: true })[0].document).toEqual(doc);
  });

  it('strict mode defaults the unknown checks to warn', () => {
    const s = specs.create(projectId, spec({ mode: 'strict', options: { checkAuth: false, include: { tags: ['users', ' '] } } }));
    expect(s.options).toEqual({ unknownParams: 'warn', unknownFields: 'warn', checkAuth: false, include: { tags: ['users'] } });
  });

  it('validates name, role, mode and options', () => {
    expect(() => specs.create(projectId, spec({ name: '' }))).toThrow(/name is required/);
    expect(() => specs.create(projectId, spec({ name: 'Bad Name' }))).toThrow(/lowercase/);
    expect(() => specs.create(projectId, spec({ role: 'server' }))).toThrow(/role/);
    expect(() => specs.create(projectId, spec({ mode: 'loud' }))).toThrow(/mode/);
    expect(() => specs.create(projectId, spec({ options: { unknownParams: 'error' } }))).toThrow(/unknownParams/);
    expect(() => specs.create(projectId, spec({ prefix: '/users/:id' }))).toThrow(/prefix segment/);
  });

  it('normalises prefixes', () => {
    expect(normalizeSpecPrefix('')).toBe('');
    expect(normalizeSpecPrefix('/')).toBe('');
    expect(normalizeSpecPrefix(undefined)).toBe('');
    expect(normalizeSpecPrefix('crm')).toBe('/crm');
    expect(normalizeSpecPrefix(' /crm//v1/ ')).toBe('/crm/v1');
    expect(() => normalizeSpecPrefix('/a b')).toThrow();
  });

  it('enforces unique names per project and unique prefixes among mock specs', () => {
    specs.create(projectId, spec({ prefix: '/crm' }));
    expect(() => specs.create(projectId, spec({ prefix: '/other' }))).toThrow(/already exists/);
    expect(() => specs.create(projectId, spec({ name: 'crm2', prefix: 'crm/' }))).toThrow(/prefix/);
    // Same name and prefix in another project, and an app spec with the same prefix, are fine.
    expect(() => specs.create(otherProjectId, spec({ prefix: '/crm' }))).not.toThrow();
    const app = specs.create(projectId, spec({ name: 'app', role: 'app', prefix: '/crm' }));
    // Turning the app spec into a mock spec on the same prefix conflicts.
    expect(() => specs.update(app.id, { role: 'mock' })).toThrow(/prefix/);
    let status = 0;
    try {
      specs.create(projectId, spec({ name: 'crm3', prefix: '/crm' }));
    } catch (err) {
      status = (err as { statusCode: number }).statusCode;
    }
    expect(status).toBe(409);
  });

  it('updates fields, keeps the rest and bumps updated_at', async () => {
    const s = specs.create(projectId, spec({ prefix: '/crm', options: { unknownFields: 'warn' } }));
    await new Promise((r) => setTimeout(r, 5));
    const u = specs.update(s.id, { mode: 'strict', prefix: 'crm/v2', options: { checkAuth: false }, warnings: ['w1'], operations: 3, hash: 'h2', document: { openapi: '3.1.0', paths: {} } });
    expect(u).toMatchObject({ mode: 'strict', prefix: '/crm/v2', warnings: ['w1'], operations: 3, hash: 'h2', name: 'crm', title: 'CRM' });
    // Options merge with the stored ones.
    expect(u.options).toEqual({ unknownParams: 'ignore', unknownFields: 'warn', checkAuth: false, include: {} });
    expect(u.document).toEqual({ openapi: '3.1.0', paths: {} });
    expect(u.updatedAt > s.updatedAt).toBe(true);
    expect(u.createdAt).toBe(s.createdAt);
    specs.create(projectId, spec({ name: 'billing', prefix: '/billing' }));
    expect(() => specs.update(s.id, { name: 'billing' })).toThrow(/already exists/);
    expect(() => specs.update(s.id, { prefix: '/billing' })).toThrow(/prefix/);
    expect(specs.update(s.id, { name: 'crm-renamed' }).name).toBe('crm-renamed');
    expect(() => specs.update('missing', { mode: 'off' })).toThrow(/not found/);
  });

  it('delete unlinks mocks instead of deleting them', () => {
    const s = specs.create(projectId, spec());
    const m = mocks.create(projectId, { path: '/users', method: 'GET', specId: s.id, specOperation: 'GET /users', specHash: 'x' });
    specs.delete(s.id);
    expect(specs.get(s.id)).toBeNull();
    expect(mocks.get(m.id)?.specId).toBeNull();
  });
});

describe('mock spec link', () => {
  it('defaults to null and round-trips through create, update and setSpecLink', () => {
    const s = specs.create(projectId, spec());
    const plain = mocks.create(projectId, { path: '/plain' });
    expect(plain).toMatchObject({ specId: null, specOperation: null, specHash: null });

    const m = mocks.create(projectId, { path: '/users/:id', method: 'GET', specId: s.id, specOperation: 'GET /users/{id}', specHash: 'abc' });
    expect(m).toMatchObject({ specId: s.id, specOperation: 'GET /users/{id}', specHash: 'abc' });
    // A normal edit keeps the link.
    expect(mocks.update(projectId, m.id, { description: 'edited' })).toMatchObject({ specId: s.id, specHash: 'abc' });
    expect(mocks.listBySpec(s.id).map((x) => x.id)).toEqual([m.id]);

    mocks.setSpecLink(plain.id, { specId: s.id, specOperation: 'GET /plain', specHash: 'def' });
    expect(mocks.listBySpec(s.id).map((x) => x.id)).toEqual([plain.id, m.id]);
    expect(mocks.setSpecLink(m.id, null)).toMatchObject({ specId: null, specOperation: null, specHash: null });
    expect(mocks.listBySpec(s.id).map((x) => x.id)).toEqual([plain.id]);
    expect(() => mocks.setSpecLink('missing', null)).toThrow(/not found/);
  });

  it('contentHash is stable across key order and changes with content', () => {
    const m = mocks.create(projectId, {
      path: '/users', method: 'GET', description: 'List users',
      scenarios: [{ name: '200 OK', status: 200, headers: { 'content-type': 'application/json', 'x-a': '1' }, body: '[]' }],
    });
    const h = mocks.contentHash(m);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(mockContentHash(m)).toBe(h);
    const reordered = {
      scenarios: [{ behaviour: 'respond' as const, delayMs: 0, body: '[]', headers: { 'x-a': '1', 'content-type': 'application/json' }, status: 200, name: '200 OK' }],
      description: 'List users', path: '/users', method: 'GET',
    };
    expect(mockContentHash(reordered)).toBe(h);
    // Fields outside the generated content do not count.
    expect(mocks.contentHash(mocks.update(projectId, m.id, { enabled: false, name: 'renamed' }))).toBe(h);
    // Edits to generated content do.
    expect(mocks.contentHash(mocks.update(projectId, m.id, { description: 'Edited' }))).not.toBe(h);
    expect(mockContentHash({ ...reordered, scenarios: [{ ...reordered.scenarios[0], status: 201 }] })).not.toBe(h);
    expect(mockContentHash({ ...reordered, path: '/users/' + 'x' })).not.toBe(h);
  });
});

describe('webhook template contract', () => {
  const base = { name: 'payment.succeeded', targetUrl: 'http://app.test/hooks' };

  it('defaults to null and accepts {spec, operation?}', () => {
    expect(hooks.createTemplate(projectId, base).contract).toBeNull();
    const t = hooks.createTemplate(projectId, { ...base, name: 't2', contract: { spec: ' crm ', operation: 'post /webhooks/payment' } });
    expect(t.contract).toEqual({ spec: 'crm', operation: 'POST /webhooks/payment' });
    expect(hooks.updateTemplate(projectId, t.id, { description: 'x' }).contract).toEqual(t.contract);
    expect(hooks.updateTemplate(projectId, t.id, { contract: { spec: 'billing' } }).contract).toEqual({ spec: 'billing' });
    expect(hooks.updateTemplate(projectId, t.id, { contract: null }).contract).toBeNull();
  });

  it('rejects malformed contracts with 400', () => {
    const bad = [
      'crm',
      [],
      {},
      { spec: '' },
      { spec: 5 },
      { spec: 'x'.repeat(121) },
      { spec: 'crm', operation: 'users' },
      { spec: 'crm', operation: 5 },
      { spec: 'crm', operation: 'POST /' + 'a'.repeat(300) },
      { spec: 'crm', extra: 1 },
    ];
    for (const contract of bad) {
      let status = 0;
      try {
        hooks.createTemplate(projectId, { ...base, contract });
      } catch (err) {
        status = (err as { statusCode: number }).statusCode;
      }
      expect(status, JSON.stringify(contract)).toBe(400);
    }
    const t = hooks.createTemplate(projectId, base);
    expect(() => hooks.updateTemplate(projectId, t.id, { contract: { spec: '' } })).toThrow(/contract.spec/);
  });
});

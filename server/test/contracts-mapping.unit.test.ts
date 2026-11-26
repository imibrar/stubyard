// OpenAPI contracts (C1): spec → mocks mapping and example generation. Fixtures are hand-built CompiledSpecs, so this
// suite does not depend on the loader (contracts/openapi.ts).
import { describe, expect, it } from 'vitest';
import { exampleFor, generateFromSchema } from '../src/contracts/examples.js';
import {
  mockContentHash, nameFor, planReimport, specToMocks, toMockPath, type ExistingSpecMock, type SpecMock,
} from '../src/contracts/mapping.js';
import type { CompiledOperation, CompiledSpec, SpecDocument } from '../src/contracts/types.js';
import { matchPath, renderTemplate } from '../src/mocks/match.js';

type OpDef = Partial<CompiledOperation> & { responses?: Record<string, unknown> };

function op(method: string, pathTemplate: string, def: OpDef = {}): CompiledOperation {
  const paramNames = [...pathTemplate.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
  return {
    key: `${method.toUpperCase()} ${pathTemplate}`,
    method: method.toUpperCase(),
    pathTemplate,
    regex: /^$/,
    paramNames,
    parameters: [],
    requestBody: null,
    responses: { '200': { description: 'OK' } },
    security: [],
    deprecated: false,
    operationId: null,
    summary: null,
    tags: [],
    ...def,
  };
}

function compiled(operations: CompiledOperation[], components: SpecDocument['components'] = {}): CompiledSpec {
  const document: SpecDocument = { openapi: '3.1.0', info: { title: 'Pets', version: '1' }, paths: {}, components };
  return {
    spec: {
      id: 'spec1', projectId: 'p1', name: 'pets', role: 'mock', prefix: '/v1', mode: 'report', openapiVersion: '3.1.0',
      title: 'Pets', apiVersion: '1', source: { kind: 'inline' }, document,
      options: { unknownParams: 'ignore', unknownFields: 'ignore', checkAuth: false, include: {} },
      warnings: [], operations: operations.length, hash: 'h', createdAt: '', updatedAt: '',
    },
    operations,
    byKey: new Map(operations.map((o) => [o.key, o])),
    warnings: [],
  };
}

const json = (schema: unknown, extra: Record<string, unknown> = {}) => ({ content: { 'application/json': { schema, ...extra } } });
const tplCtx = (params: Record<string, string> = {}) => ({ params, query: {}, headers: {}, body: undefined, method: 'GET', path: '/' });

describe('exampleFor precedence', () => {
  const root = { components: { schemas: { Pet: { type: 'object', example: { from: 'schema' }, properties: { a: { type: 'string' } } } } } };
  const schema = { $ref: '#/components/schemas/Pet' };

  it('media example → first examples[*].value → schema example → generated', () => {
    expect(exampleFor({ schema, example: { from: 'media' }, examples: { x: { value: { from: 'examples' } } } }, undefined, { root })).toEqual({ value: { from: 'media' }, source: 'example' });
    expect(exampleFor({ schema, examples: { x: { value: { from: 'x' } }, y: { value: { from: 'y' } } } }, undefined, { root })).toEqual({ value: { from: 'x' }, source: 'examples' });
    expect(exampleFor({ schema }, undefined, { root })).toEqual({ value: { from: 'schema' }, source: 'schema-example' });
    expect(exampleFor({ schema: { type: 'object', properties: { a: { type: 'string' } } } }, undefined, { root })).toEqual({ value: { a: 'string' }, source: 'generated' });
  });

  it('resolves $ref examples (components/examples)', () => {
    const r = { components: { examples: { Rex: { value: { name: 'Rex' } } } } };
    expect(exampleFor({ examples: { rex: { $ref: '#/components/examples/Rex' } } }, undefined, { root: r }).value).toEqual({ name: 'Rex' });
  });
});

describe('generateFromSchema', () => {
  const root = {
    components: {
      schemas: {
        Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, parent: { $ref: '#/components/schemas/Node' } } },
        Base: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
  };

  it('prefers const, enum, default, examples[0], example', () => {
    const g = (s: unknown) => generateFromSchema(s, { root });
    expect(g({ type: 'string', const: 'c', default: 'd' })).toBe('c');
    expect(g({ type: 'string', enum: ['a', 'b'], default: 'd' })).toBe('a');
    expect(g({ type: 'integer', default: 7 })).toBe(7);
    expect(g({ type: 'string', examples: ['e1', 'e2'] })).toBe('e1');
    expect(g({ type: 'string', example: 'ex' })).toBe('ex');
  });

  it('formats and types', () => {
    const v = generateFromSchema(
      {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, at: { type: 'string', format: 'date-time' }, mail: { type: 'string', format: 'email' },
          link: { type: 'string', format: 'uri' }, s: { type: 'string' }, n: { type: 'integer', minimum: 5 }, f: { type: 'number' },
          b: { type: 'boolean' }, list: { type: 'array', items: { type: 'integer' } }, maybe: { type: ['null', 'string'] },
        },
      },
      { root },
    );
    expect(v).toEqual({
      id: '{{uuid}}', at: '{{now}}', mail: 'user@example.test', link: 'https://example.test/x', s: 'string', n: 5, f: 0, b: true, list: [0], maybe: 'string',
    });
  });

  it('allOf is merged, oneOf / anyOf take the first branch', () => {
    expect(generateFromSchema({ allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { name: { type: 'string' } } }] }, { root })).toEqual({ id: '{{uuid}}', name: 'string' });
    expect(generateFromSchema({ oneOf: [{ type: 'integer' }, { type: 'string' }] }, { root })).toBe(0);
    expect(generateFromSchema({ anyOf: [{ type: 'boolean' }, { type: 'string' }] }, { root })).toBe(true);
  });

  it('a cyclic schema terminates (the cycle is left out)', () => {
    expect(generateFromSchema({ $ref: '#/components/schemas/Node' }, { root })).toEqual({ name: 'string', children: [] });
  });

  it('depth cap: deeper values are left out', () => {
    let s: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 10; i++) s = { type: 'object', properties: { x: s } };
    const v = generateFromSchema(s, { root });
    let depth = 0;
    let cur = v as Record<string, unknown>;
    while (cur && typeof cur === 'object' && 'x' in cur) {
      cur = cur.x as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBe(6);
    expect(cur).toEqual({});
  });

  it('a string property named like a path param becomes {{params.<name>}} (not inside arrays)', () => {
    const v = generateFromSchema(
      { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, count: { type: 'integer' }, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } },
      { root, pathParams: ['id', 'count'] },
    );
    expect(v).toEqual({ id: '{{params.id}}', count: 0, items: [{ id: 'string' }] });
  });

  it('an empty schema gives null', () => {
    expect(generateFromSchema({}, { root })).toBeNull();
  });
});

describe('specToMocks', () => {
  it('converts paths and orders literal-first', () => {
    expect(toMockPath('/v1', '/users/{id}')).toBe('/v1/users/:id');
    expect(toMockPath('', '/files/{name}.{ext}')).toBe('/files/*.*');
    expect(toMockPath('/', '/')).toBe('/');
    const { mocks } = specToMocks(
      compiled([op('get', '/users/{id}'), op('get', '/users/me'), op('get', '/users'), op('get', '/users/{id}/posts'), op('get', '/files/{name}.{ext}')]),
      { specName: 'pets', prefix: '/v1' },
    );
    expect(mocks.map((m) => m.path)).toEqual(['/v1/files/*.*', '/v1/users', '/v1/users/me', '/v1/users/:id', '/v1/users/:id/posts']);
    expect(matchPath('/v1/users/:id', '/v1/users/42')).toEqual({ id: '42' });
    expect(matchPath('/v1/files/*.*', '/v1/files/report.pdf')).not.toBeNull();
  });

  it('names, description, specOperation, specHash', () => {
    const { mocks } = specToMocks(
      compiled([op('get', '/pets/{id}', { operationId: 'getPet', summary: 'Get a pet' }), op('delete', '/pets/{id}', { deprecated: true })]),
      { specName: 'pets', prefix: '' },
    );
    const [a, b] = mocks;
    expect(a).toMatchObject({ name: 'getPet', method: 'GET', description: 'Get a pet · from spec pets', specOperation: 'GET /pets/{id}' });
    expect(b).toMatchObject({ name: 'DELETE /pets/{id}', description: 'from spec pets (deprecated)' });
    expect(a.specHash).toBe(mockContentHash(a));
    expect(nameFor({ operationId: 'getPet', method: 'GET', pathTemplate: '/x' }, 'pets', (n) => n === 'getPet')).toBe('pets · getPet');
    expect(nameFor({ operationId: null, method: 'get', pathTemplate: '/x' }, 'pets', () => false)).toBe('GET /x');
  });

  it('scenarios per code: status text, 2XX → 200, 4XX → 400, default (500), named examples, lowest 2xx active', () => {
    const named = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`ex${i}`, { value: { n: i } }]));
    const o = op('post', '/pets/{id}', {
      responses: {
        default: { description: 'Error', ...json({ type: 'object', properties: { error: { type: 'string' } } }) },
        '404': { description: 'Missing' },
        '4XX': { description: 'Client error' },
        '2XX': { description: 'Any success' },
        '201': { description: 'Created', headers: { Location: { example: '/pets/1' }, 'X-None': { schema: { type: 'string' } } }, ...json({ type: 'object', properties: { id: { type: 'string' } } }) },
        '202': { description: 'Accepted', content: { 'application/json': { examples: named } } },
      },
    });
    const { mocks } = specToMocks(compiled([o]), { specName: 'pets', prefix: '' });
    const m = mocks[0];
    expect(m.scenarios.map((s) => [s.name, s.status])).toEqual([
      ['2XX (200)', 200],
      ['201 Created', 201],
      ['202 Accepted', 202],
      ['202 · ex0', 202], ['202 · ex1', 202], ['202 · ex2', 202], ['202 · ex3', 202], ['202 · ex4', 202],
      ['4XX (400)', 400],
      ['404 Not Found', 404],
      ['default (500)', 500],
    ]);
    expect(m.activeScenario).toBe('2XX (200)');
    const created = m.scenarios[1];
    expect(created.headers).toEqual({ Location: '/pets/1', 'content-type': 'application/json' });
    expect(JSON.parse(created.body)).toEqual({ id: '{{params.id}}' });
    expect(renderTemplate(created.body, tplCtx({ id: 'p-7' }))).toContain('"id": "p-7"');
    expect(JSON.parse(m.scenarios[2].body)).toEqual({ n: 0 });
    expect(JSON.parse(m.scenarios[4].body)).toEqual({ n: 1 });
    expect(m.scenarios[9]).toMatchObject({ body: '', headers: {} });
    expect(m.scenarios.every((s) => s.delayMs === 0 && s.behaviour === 'respond')).toBe(true);
  });

  it('active is the lowest exact 2xx; no 2xx → the first scenario', () => {
    const a = specToMocks(compiled([op('get', '/a', { responses: { '204': { description: 'x' }, '200': { description: 'ok' } } })]), { specName: 's', prefix: '' });
    expect(a.mocks[0].activeScenario).toBe('200 OK');
    const b = specToMocks(compiled([op('get', '/b', { responses: { '404': { description: 'x' } } })]), { specName: 's', prefix: '' });
    expect(b.mocks[0].activeScenario).toBe('404 Not Found');
  });

  it('resolves response $refs and prefers application/json; text bodies stay raw', () => {
    const o = op('get', '/doc', {
      responses: {
        '200': { $ref: '#/components/responses/Doc' },
        '400': { description: 'bad', content: { 'text/plain': { example: 'nope' } } },
      },
    });
    const { mocks } = specToMocks(
      compiled([o], { responses: { Doc: { description: 'ok', content: { 'text/html': { example: '<p>' }, 'application/problem+json': { example: { a: 1 } }, 'application/json': { example: { b: 2 } } } } } }),
      { specName: 's', prefix: '' },
    );
    expect(mocks[0].scenarios[0]).toMatchObject({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ b: 2 }, null, 2) });
    expect(mocks[0].scenarios[1]).toMatchObject({ headers: { 'content-type': 'text/plain' }, body: 'nope' });
  });

  it('include filters (tags, path globs, operations) and the cap', () => {
    const ops = [
      op('get', '/pets', { tags: ['pets'], operationId: 'listPets' }),
      op('post', '/pets', { tags: ['pets'] }),
      op('get', '/store/orders', { tags: ['store'] }),
      op('get', '/users/{id}', { tags: ['Users'] }),
    ];
    const names = (include: object) => specToMocks(compiled(ops), { specName: 's', prefix: '', include }).mocks.map((m) => m.specOperation);
    expect(names({ tags: ['users'] })).toEqual(['GET /users/{id}']);
    expect(names({ paths: ['/pets*'] })).toEqual(['GET /pets', 'POST /pets']);
    expect(names({ operations: ['listPets', 'get /store/orders'] })).toEqual(['GET /pets', 'GET /store/orders']);
    expect(names({ tags: ['pets'], paths: ['/store/*'] })).toEqual([]);
    expect(() => specToMocks(compiled(ops), { specName: 's', prefix: '', cap: 3 })).toThrow(/spec has 4 operations; pass include\.tags\/paths/);
    expect(() => specToMocks(compiled(ops), { specName: 's', prefix: '', cap: 3 })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(specToMocks(compiled(ops), { specName: 's', prefix: '', cap: 3, include: { tags: ['pets'] } }).mocks).toHaveLength(2);
  });

  it('skips methods a mock cannot have, and keeps duplicate operationIds unique', () => {
    const { mocks, warnings } = specToMocks(
      compiled([op('trace', '/a'), op('get', '/a', { operationId: 'dup' }), op('get', '/b', { operationId: 'dup' })]),
      { specName: 's', prefix: '' },
    );
    expect(mocks.map((m) => m.name)).toEqual(['dup', 'dup (2)']);
    expect(warnings.some((w) => w.includes('TRACE'))).toBe(true);
  });
});

describe('mockContentHash', () => {
  const base = { method: 'get', path: '/a/', description: 'd', scenarios: [{ name: 'OK', status: 200, headers: { b: '1', a: '2' }, body: '{}', delayMs: 0, behaviour: 'respond' as const }] };
  it('is stable over method case, trailing slash, header order and scenario defaults', () => {
    const h = mockContentHash(base);
    expect(mockContentHash({ ...base, method: 'GET', path: '/a', scenarios: [{ ...base.scenarios[0], headers: { a: '2', b: '1' } }] })).toBe(h);
    expect(mockContentHash({ ...base, scenarios: [{ name: 'OK', headers: { a: '2', b: '1' }, body: '{}' }] })).toBe(h);
  });
  it('changes with body, status, description, path', () => {
    const h = mockContentHash(base);
    expect(mockContentHash({ ...base, description: 'x' })).not.toBe(h);
    expect(mockContentHash({ ...base, path: '/b' })).not.toBe(h);
    expect(mockContentHash({ ...base, scenarios: [{ ...base.scenarios[0], body: '[]' }] })).not.toBe(h);
    expect(mockContentHash({ ...base, scenarios: [{ ...base.scenarios[0], status: 201 }] })).not.toBe(h);
  });
});

describe('planReimport', () => {
  const spec = (body: string) =>
    compiled([
      op('get', '/same', { responses: { '200': { description: 'ok', ...json({ type: 'string' }) } } }),
      op('get', '/changed', { responses: { '200': { description: 'ok', content: { 'application/json': { example: body } } }, '404': { description: 'x' } } }),
      op('get', '/edited', { responses: { '200': { description: 'ok', content: { 'application/json': { example: body } } } } }),
      op('get', '/new'),
    ]);
  const v1 = specToMocks(spec('v1'), { specName: 's', prefix: '' }).mocks.filter((m) => m.specOperation !== 'GET /new');
  const v2 = specToMocks(spec('v2'), { specName: 's', prefix: '' }).mocks;
  const existingFrom = (mocks: SpecMock[], edits: Record<string, Partial<ExistingSpecMock>> = {}): ExistingSpecMock[] =>
    mocks.map((m, i) => ({
      id: `m${i}`, specOperation: m.specOperation, specHash: m.specHash, currentHash: m.specHash, enabled: true, activeScenario: m.activeScenario, description: m.description,
      ...edits[m.specOperation],
    }));
  const gone: ExistingSpecMock = { id: 'old', specOperation: 'GET /gone', specHash: 'x', currentHash: 'x', enabled: true, activeScenario: '200 OK', description: 'from spec s' };

  it('create / update / kept / removed with edit detection by hash', () => {
    const existing = [
      ...existingFrom(v1, { 'GET /edited': { currentHash: 'edited-by-user' }, 'GET /changed': { activeScenario: '404 Not Found', enabled: false } }),
      gone,
    ];
    const plan = planReimport(existing, v2);
    expect(plan.create.map((m) => m.specOperation)).toEqual(['GET /new']);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]).toMatchObject({ specOperation: 'GET /changed', overwritten: false });
    expect(plan.update[0].mock.activeScenario).toBe('404 Not Found');
    expect(plan.update[0].mock).not.toHaveProperty('enabled');
    expect(plan.kept).toEqual([{ id: existing.find((e) => e.specOperation === 'GET /edited')!.id, specOperation: 'GET /edited', reason: 'edited' }]);
    expect(plan.unchanged.map((u) => u.specOperation)).toEqual(['GET /same']);
    expect(plan.removed).toEqual([{ id: 'old', specOperation: 'GET /gone', action: 'disable', patch: { enabled: false, description: 'from spec s (removed from spec)' } }]);
  });

  it('overwriteEdited replaces edited mocks; the active scenario falls back when it no longer exists', () => {
    const existing = existingFrom(v1, { 'GET /edited': { currentHash: 'edited', activeScenario: 'Custom' } });
    const plan = planReimport(existing, v2, { overwriteEdited: true });
    const edited = plan.update.find((u) => u.specOperation === 'GET /edited')!;
    expect(edited.overwritten).toBe(true);
    expect(edited.mock.activeScenario).toBe('200 OK');
    expect(plan.kept).toEqual([]);
  });

  it('a mock with no stored hash counts as edited', () => {
    const existing = existingFrom(v1, { 'GET /changed': { specHash: null } });
    expect(planReimport(existing, v2).kept.map((k) => k.specOperation)).toEqual(['GET /changed']);
  });

  it('removeMissing: delete / keep, and the suffix is not added twice', () => {
    expect(planReimport([gone], [], { removeMissing: 'delete' }).removed).toEqual([{ id: 'old', specOperation: 'GET /gone', action: 'delete' }]);
    expect(planReimport([gone], [], { removeMissing: 'keep' }).removed).toEqual([{ id: 'old', specOperation: 'GET /gone', action: 'keep' }]);
    const again = planReimport([{ ...gone, description: 'from spec s (removed from spec)' }], []);
    expect(again.removed[0].patch?.description).toBe('from spec s (removed from spec)');
  });

  it('mocks without a spec operation are ignored', () => {
    const plan = planReimport([{ ...gone, specOperation: null }], v2);
    expect(plan.removed).toEqual([]);
    expect(plan.create).toHaveLength(4);
  });
});

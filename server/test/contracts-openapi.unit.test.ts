// OpenAPI import (C1): parsing, 3.0 normalization, $ref handling, operation compilation and matching, readOnly views.
import { describe, expect, it } from 'vitest';
import {
  compareOperations,
  compileSpec,
  deref,
  findOperation,
  normalizeSpec,
  parseSpecText,
  requestView,
  responseView,
  specHash,
  SpecError,
  templateToRegex,
} from '../src/contracts/openapi.js';
import { validateSchema } from '../src/webhooks/schema.js';

const minimal31 = { openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: {} };

describe('parseSpecText', () => {
  it('detects JSON and YAML', () => {
    expect(parseSpecText(`  ${JSON.stringify(minimal31)}`)).toMatchObject({ format: 'json', openapiVersion: '3.1.0' });
    const y = parseSpecText('openapi: 3.0.3\ninfo:\n  title: Y\n  version: "2"\npaths: {}\n');
    expect(y).toMatchObject({ format: 'yaml', openapiVersion: '3.0.3' });
    expect(y.document.info).toEqual({ title: 'Y', version: '2' });
  });

  it('accepts 3.0 and 3.1, rejects Swagger 2 and other versions', () => {
    expect(parseSpecText('openapi: "3.0.0"\npaths: {}').openapiVersion).toBe('3.0.0');
    expect(parseSpecText('openapi: 3.1.1\npaths: {}').openapiVersion).toBe('3.1.1');
    expect(() => parseSpecText('swagger: "2.0"\npaths: {}')).toThrow('Swagger 2.0: convert to OpenAPI 3 first (e.g. converter.swagger.io)');
    expect(() => parseSpecText('openapi: 4.0.0')).toThrow(/not supported/);
    expect(() => parseSpecText('info: {}')).toThrow(/"openapi" field is missing/);
  });

  it('gives a readable SpecError for bad input', () => {
    const errOf = (text: string) => {
      try {
        parseSpecText(text);
      } catch (e) {
        return e as SpecError;
      }
      throw new Error('expected a throw');
    };
    expect(errOf('{"openapi": ')).toBeInstanceOf(SpecError);
    expect(errOf('{"openapi": ').statusCode).toBe(400);
    expect(errOf('{"openapi": ').message).toMatch(/^The spec is not valid JSON/);
    expect(errOf('a: 1\na: 2').message).toMatch(/^The spec is not valid YAML/);
    expect(errOf('just text').message).toMatch(/must be a JSON or YAML object/);
    expect(errOf('').message).toBe('The spec is empty');
    expect(errOf(`openapi: 3.1.0\nx: "${'a'.repeat(10 * 1024 * 1024)}"`).statusCode).toBe(413);
  });

  it('resolves YAML anchors and aliases but refuses an alias bomb', () => {
    const doc = parseSpecText('openapi: 3.1.0\nx-base: &base {type: string}\ncomponents:\n  schemas:\n    A: *base\n    B: *base\n').document;
    expect((doc.components as any).schemas.B).toEqual({ type: 'string' });
    const bomb = [
      'openapi: 3.1.0',
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
    ].join('\n');
    expect(() => parseSpecText(bomb)).toThrow(SpecError);
  });
});

describe('normalizeSpec', () => {
  const doc30 = {
    openapi: '3.0.3',
    paths: {
      '/x': {
        get: {
          parameters: [{ name: 'q', in: 'query', schema: { type: 'integer', minimum: 1, exclusiveMinimum: true, example: 5 } }],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' }, example: { name: 'Rex' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: 'object',
          xml: { name: 'pet' },
          externalDocs: { url: 'https://x.test' },
          properties: {
            name: { type: 'string', nullable: true },
            kind: { type: 'string', enum: ['cat', 'dog'], nullable: true },
            age: { type: 'number', maximum: 30, exclusiveMaximum: false },
            owner: { nullable: true, allOf: [{ $ref: '#/components/schemas/Owner' }], description: 'who' },
            example: { type: 'string' },
          },
          discriminator: { propertyName: 'kind' },
        },
        Owner: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  };

  it('converts 3.0 nullable and boolean exclusive* and drops schema-only annotations', () => {
    const input = structuredClone(doc30);
    const { document, warnings } = normalizeSpec(input);
    expect(input).toEqual(doc30); // pure
    expect(warnings).toEqual([]);
    const pet = (document.components as any).schemas.Pet;
    expect(pet.xml).toBeUndefined();
    expect(pet.externalDocs).toBeUndefined();
    expect(pet.discriminator).toEqual({ propertyName: 'kind' });
    expect(pet.properties.name).toEqual({ type: ['string', 'null'] });
    expect(pet.properties.kind).toEqual({ type: ['string', 'null'], enum: ['cat', 'dog', null] });
    expect(pet.properties.age).toEqual({ type: 'number', maximum: 30 });
    expect(pet.properties.owner).toEqual({ description: 'who', anyOf: [{ allOf: [{ $ref: '#/components/schemas/Owner' }] }, { type: 'null' }] });
    expect(pet.properties.example).toEqual({ type: 'string' }); // a property named "example" is not the keyword
    const q = (document.paths as any)['/x'].get.parameters[0].schema;
    expect(q).toEqual({ type: 'integer', exclusiveMinimum: 1, examples: [5] });
    // the media-type example is kept for mock generation
    expect((document.paths as any)['/x'].get.responses['200'].content['application/json'].example).toEqual({ name: 'Rex' });
    expect(validateSchema(pet.properties.kind, null)).toEqual([]);
    expect(validateSchema(q, 1)).toHaveLength(1);
  });

  it('warns once per unsupported keyword and for external or broken refs', () => {
    const { document, warnings } = normalizeSpec({
      openapi: '3.1.0',
      paths: {
        '/a': {
          get: {
            parameters: [{ $ref: 'common.yaml#/components/parameters/Page' }],
            responses: { '200': { $ref: '#/components/responses/Missing' } },
          },
        },
      },
      components: {
        schemas: {
          A: { type: 'object', unevaluatedProperties: false },
          B: { type: 'object', unevaluatedProperties: false, dependentSchemas: { x: { required: ['y'] } } },
          C: { $ref: 'https://example.test/c.json' },
        },
      },
    });
    expect(warnings).toEqual([
      'External $ref "common.yaml#/components/parameters/Page" is not supported; treated as {}',
      '$ref "#/components/responses/Missing" does not resolve; treated as {}',
      'Schema keyword "unevaluatedProperties" is not checked',
      'Schema keyword "dependentSchemas" is not checked',
      'External $ref "https://example.test/c.json" is not supported; treated as {}',
    ]);
    expect((document.components as any).schemas.C).toEqual({});
    expect((document.paths as any)['/a'].get.parameters).toEqual([{}]);
  });

  it('keeps 3.1 type arrays and drops stray 3.0 keywords with a warning', () => {
    const { document, warnings } = normalizeSpec({
      openapi: '3.1.0',
      components: { schemas: { N: { type: ['string', 'null'], exclusiveMinimum: 3 }, M: { type: 'string', nullable: true } } },
    });
    expect((document.components as any).schemas).toEqual({ N: { type: ['string', 'null'], exclusiveMinimum: 3 }, M: { type: 'string' } });
    expect(warnings).toHaveLength(1);
  });
});

const api = parseSpecText(`
openapi: 3.0.3
info: {title: Users, version: "1.0"}
security: [{bearer: []}]
paths:
  /users/{id}:
    parameters:
      - $ref: '#/components/parameters/Id'
      - {name: X-Trace, in: header, schema: {type: string}}
    get:
      operationId: getUser
      tags: [users]
      parameters:
        - {name: x-trace, in: header, required: true, schema: {type: string}}
      responses:
        '200': {$ref: '#/components/responses/User'}
    delete:
      deprecated: true
      security: []
      responses: {'204': {description: gone}}
  /users/me:
    get:
      summary: Me
      responses: {'200': {$ref: '#/components/responses/User'}}
  /users:
    post:
      requestBody: {$ref: '#/components/requestBodies/NewUser'}
      responses: {'201': {description: created}}
  /files/{name}.{ext}:
    get: {responses: {'200': {description: file}}}
components:
  parameters:
    Id: {name: id, in: path, required: true, schema: {type: integer}}
  headers:
    Rate: {schema: {type: integer}}
  responses:
    User:
      description: a user
      headers: {X-Rate: {$ref: '#/components/headers/Rate'}}
      content: {application/json: {schema: {$ref: '#/components/schemas/User'}}}
  requestBodies:
    NewUser:
      required: true
      content: {application/json: {schema: {$ref: '#/components/schemas/User'}}}
  schemas:
    User:
      type: object
      required: [id, name, password]
      properties:
        id: {type: integer, readOnly: true}
        name: {type: string}
        password: {type: string, writeOnly: true}
        manager: {$ref: '#/components/schemas/User'}
        reports: {type: array, items: {$ref: '#/components/schemas/User'}}
`);
const norm = normalizeSpec(api.document).document;

describe('compileSpec', () => {
  const compiled = compileSpec(norm);

  it('compiles every path x method, literal-first', () => {
    expect(compiled.operations.map((o) => o.key)).toEqual([
      'GET /users/me',
      'GET /files/{name}.{ext}', // a segment mixing text and a param counts half
      'DELETE /users/{id}',
      'GET /users/{id}',
      'POST /users',
    ]);
    expect(compiled.byKey.get('GET /users/{id}')?.operationId).toBe('getUser');
    expect(compiled.spec.title).toBe('Users');
    expect(compiled.warnings).toEqual([]);
  });

  it('merges path-level parameters (operation wins) and resolves local refs', () => {
    const get = compiled.byKey.get('GET /users/{id}')!;
    expect(get.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'x-trace', in: 'header', required: true, schema: { type: 'string' } },
    ]);
    const res = get.responses['200'] as any;
    expect(res.description).toBe('a user');
    expect(res.headers['X-Rate']).toEqual({ schema: { type: 'integer' } });
    expect(compiled.byKey.get('POST /users')!.requestBody).toMatchObject({ required: true });
    expect(get.security).toEqual([{ bearer: [] }]);
    expect(get.tags).toEqual(['users']);
    const del = compiled.byKey.get('DELETE /users/{id}')!;
    expect(del).toMatchObject({ security: [], deprecated: true, operationId: null });
    expect(del.parameters.map((p) => p.name)).toEqual(['id', 'X-Trace']);
    expect(compiled.byKey.get('GET /users/me')!.summary).toBe('Me');
  });

  it('compiles a cyclic schema that validates against the document', () => {
    const schema = (compiled.byKey.get('GET /users/{id}')!.responses['200'] as any).content['application/json'].schema;
    const ok = { id: 1, name: 'a', password: 'p', manager: { id: 2, name: 'b', password: 'q', reports: [] } };
    expect(validateSchema(schema, ok, 50, { root: norm })).toEqual([]);
    expect(validateSchema(schema, { id: 1, name: 'a', password: 'p', reports: [{ id: 'x', name: 'c', password: 'r' }] }, 50, { root: norm })).toEqual([
      { path: '/reports/0/id', message: 'must be integer (got string)' },
    ]);
  });

  it('accepts a SpecRecord and dereferences with a cycle guard', () => {
    const fromRecord = compileSpec({ ...compiled.spec, name: 'crm' });
    expect(fromRecord.spec.name).toBe('crm');
    const warnings: string[] = [];
    const loop = { components: { parameters: { A: { $ref: '#/components/parameters/B' }, B: { $ref: '#/components/parameters/A' } } } };
    expect(deref(loop, { $ref: '#/components/parameters/A' }, warnings)).toEqual({});
    expect(warnings).toEqual(['$ref cycle at "#/components/parameters/A"; treated as {}']);
  });
});

describe('paths and matching', () => {
  it('converts templates to regexes, including {a}.{ext}', () => {
    const t = templateToRegex('/files/{name}.{ext}');
    expect(t.paramNames).toEqual(['name', 'ext']);
    expect(t.regex.exec('/files/report.tar.gz')?.slice(1)).toEqual(['report.tar', 'gz']);
    expect(t.regex.test('/files/report')).toBe(false);
    expect(t.regex.test('/files/a/b.c')).toBe(false);
    const u = templateToRegex('/v1.0/users/{user-id}');
    expect(u.regex.test('/v1.0/users/7/')).toBe(true);
    expect(u.regex.test('/v1x0/users/7')).toBe(false);
    expect(templateToRegex('/').regex.test('/')).toBe(true);
  });

  it('orders literal paths first', () => {
    const ops = ['/users/{id}', '/users/me', '/users/{id}/posts', '/{any}'].map((p) => ({ pathTemplate: p, key: `GET ${p}` }));
    expect(ops.sort(compareOperations).map((o) => o.pathTemplate)).toEqual(['/users/{id}/posts', '/users/me', '/users/{id}', '/{any}']);
  });

  it('finds operations, decodes params and reports method-not-allowed', () => {
    const compiled = compileSpec(norm);
    const me = findOperation(compiled, 'get', '/users/me?x=1');
    expect(me && 'op' in me && me.op.key).toBe('GET /users/me');
    const byId = findOperation(compiled, 'GET', '/users/a%20b');
    expect(byId).toMatchObject({ op: { key: 'GET /users/{id}' }, params: { id: 'a b' } });
    // /users/me only has GET, but DELETE falls through to /users/{id}
    expect(findOperation(compiled, 'DELETE', '/users/me')).toMatchObject({ op: { key: 'DELETE /users/{id}' }, params: { id: 'me' } });
    expect(findOperation(compiled, 'PUT', '/users/5')).toEqual({ methodNotAllowed: ['DELETE', 'GET'] });
    expect(findOperation(compiled, 'GET', '/files/a.json')).toMatchObject({ params: { name: 'a', ext: 'json' } });
    expect(findOperation(compiled, 'GET', '/nope')).toBeNull();
  });
});

describe('readOnly / writeOnly views', () => {
  const user = { $ref: '#/components/schemas/User' };

  it('a request view does not require readOnly properties, a response view not writeOnly ones', () => {
    const req = requestView(user, norm);
    expect(validateSchema(req, { name: 'a', password: 'p' })).toEqual([]);
    expect(validateSchema(req, { name: 'a' })).toEqual([{ path: '/password', message: 'missing required property "password"' }]);
    // nested through the cyclic $ref, too
    expect(validateSchema(req, { name: 'a', password: 'p', manager: { name: 'b', password: 'q' } })).toEqual([]);
    const res = responseView(user, norm);
    expect(validateSchema(res, { id: 1, name: 'a' })).toEqual([]);
    expect(validateSchema(res, { name: 'a' })).toEqual([{ path: '/id', message: 'missing required property "id"' }]);
    // the document itself is unchanged
    expect(validateSchema(user, { name: 'a', password: 'p' }, 50, { root: norm })).toHaveLength(1);
  });

  it('memoizes per schema object', () => {
    expect(requestView(user, norm)).toBe(requestView(user, norm));
  });
});

describe('specHash', () => {
  it('ignores key order', () => {
    expect(specHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(specHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(specHash({ a: 1 })).not.toBe(specHash({ a: 2 }));
    expect(specHash(norm)).toMatch(/^[0-9a-f]{64}$/);
  });
});

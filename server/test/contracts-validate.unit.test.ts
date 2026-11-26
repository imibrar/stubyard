// OpenAPI contract validator (C1): request params, auth, bodies, unknown fields, responses, masking and the cap.
import { describe, expect, it } from 'vitest';
import { compileSpec, findOperation, normalizeSpec, parseSpecText } from '../src/contracts/openapi.js';
import { MAX_CONTRACT_ISSUES, type CompiledSpec, type ContractIssue } from '../src/contracts/types.js';
import {
  capIssues,
  maskActual,
  mediaTypeMatches,
  validateRequest,
  validateResponse,
  type ContractRequest,
  type ValidateContractOptions,
} from '../src/contracts/validate.js';

const spec = compileSpec(
  normalizeSpec(
    parseSpecText(`
openapi: 3.0.3
info: {title: Shop, version: "1"}
components:
  securitySchemes:
    bearer: {type: http, scheme: bearer}
    basic: {type: http, scheme: basic}
    key: {type: apiKey, in: header, name: X-Api-Key}
    qkey: {type: apiKey, in: query, name: api_key}
  schemas:
    Base:
      type: object
      required: [id, name]
      properties:
        id: {type: integer, readOnly: true}
        name: {type: string}
    User:
      allOf:
        - $ref: '#/components/schemas/Base'
        - type: object
          required: [password]
          properties:
            password: {type: string, writeOnly: true}
            email: {type: string, format: email}
            old: {type: string, deprecated: true}
    Cat:
      type: object
      required: [kind, meow]
      properties: {kind: {type: string}, meow: {type: boolean}}
    Dog:
      type: object
      required: [kind]
      properties: {kind: {type: string}, bark: {type: boolean}}
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
paths:
  /items/{id}:
    get:
      parameters:
        - {name: id, in: path, required: true, schema: {type: integer}}
        - {name: limit, in: query, schema: {type: integer, maximum: 100}}
        - {name: active, in: query, schema: {type: boolean}}
        - {name: tags, in: query, schema: {type: array, items: {type: string}}}
        - {name: ids, in: query, explode: false, schema: {type: array, items: {type: integer}}}
        - {name: filter, in: query, style: deepObject, schema: {type: object, properties: {min: {type: number}, max: {type: number}}}}
        - {name: X-Request-Id, in: header, required: true, schema: {type: string}}
        - {name: session, in: cookie, schema: {type: string, minLength: 5}}
        - {name: old, in: query, deprecated: true, schema: {type: string}}
      responses:
        '200':
          description: ok
          headers:
            X-Rate-Limit: {required: true, schema: {type: integer}}
          content:
            application/json:
              schema: {$ref: '#/components/schemas/User'}
        4XX:
          description: client error
          content:
            application/problem+json:
              schema: {type: object, required: [title], properties: {title: {type: string}}}
        default:
          description: other
  /users:
    post:
      security: [{bearer: []}, {key: [], qkey: []}]
      requestBody:
        required: true
        content:
          application/json:
            schema: {$ref: '#/components/schemas/User'}
          application/x-www-form-urlencoded:
            schema: {$ref: '#/components/schemas/User'}
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: {$ref: '#/components/schemas/User'}
  /pets:
    post:
      security: [{basic: []}, {}]
      requestBody:
        content:
          application/*:
            schema: {$ref: '#/components/schemas/Pet'}
      responses:
        '200': {description: ok}
  /legacy:
    get:
      deprecated: true
      responses:
        '200': {description: ok}
`).document,
  ).document,
);

const lenient: ValidateContractOptions = { unknownParams: 'ignore', unknownFields: 'ignore', checkAuth: false };

function req(method: string, url: string, extra: Partial<ContractRequest> = {}): ContractRequest {
  const [path, qs = ''] = url.split('?');
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const hit = findOperation(spec, method, path);
  return { method, path, params: hit && 'op' in hit ? hit.params : {}, query, headers: {}, body: undefined, contentType: undefined, ...extra };
}

function check(r: ContractRequest, opts: ValidateContractOptions = lenient, s: CompiledSpec = spec): ContractIssue[] {
  const hit = findOperation(s, r.method, r.path);
  if (!hit || !('op' in hit)) throw new Error('no operation');
  return validateRequest(s, hit.op, r, opts);
}

const checks = (issues: ContractIssue[]) => issues.map((i) => i.check);
const hdr = { 'x-request-id': 'r1' };
const goodUser = { name: 'Ann', password: 'pw' };
const json = (body: unknown, headers: Record<string, string> = {}): Partial<ContractRequest> => ({
  body: JSON.stringify(body),
  contentType: 'application/json',
  headers: { authorization: 'Bearer abc', ...headers },
});

describe('validateRequest: parameters', () => {
  it('coerces path, query, header and cookie values by type', () => {
    expect(check(req('GET', '/items/7?limit=10&active=true&tags=a&tags=b&ids=1,2,3&filter[min]=1.5', { headers: { ...hdr, cookie: 'session=abcdef' } }))).toEqual([]);
  });

  it('reports a wrong type with the raw value', () => {
    const issues = check(req('GET', '/items/abc?limit=x&active=yes&ids=1,b', { headers: hdr }));
    expect(issues.map((i) => [i.check, i.where, i.name])).toEqual([
      ['contract.param', 'path', 'id'],
      ['contract.param', 'query', 'limit'],
      ['contract.param', 'query', 'active'],
      ['contract.param', 'query', 'ids'],
    ]);
    expect(issues[0]).toMatchObject({ severity: 'error', side: 'request', actual: 'abc' });
    expect(issues[0].message).toMatch(/must be integer/);
    expect(issues[3]).toMatchObject({ pointer: '/1', actual: 'b' });
  });

  it('checks bounds after coercion and deepObject members', () => {
    const issues = check(req('GET', '/items/1?limit=500&filter[max]=abc', { headers: hdr }));
    expect(issues.map((i) => i.name)).toEqual(['limit', 'filter']);
    expect(issues[0].message).toMatch(/<= 100/);
    expect(issues[1]).toMatchObject({ pointer: '/max', actual: 'abc' });
  });

  it('reports a missing required header (case-insensitive) and keeps cookie values out of actual', () => {
    expect(check(req('GET', '/items/1', { headers: { 'x-request-id': 'r' } }))).toEqual([]);
    const issues = check(req('GET', '/items/1', { headers: { cookie: 'session=ab' } }));
    expect(issues.map((i) => [i.where, i.name])).toEqual([
      ['header', 'X-Request-Id'],
      ['cookie', 'session'],
    ]);
    expect(issues[0].message).toBe('Header parameter "X-Request-Id" is required');
    expect(issues[1].actual).toBeUndefined();
  });

  it('warns on a deprecated param and a deprecated operation', () => {
    expect(checks(check(req('GET', '/items/1?old=1', { headers: hdr })))).toEqual(['contract.deprecated']);
    expect(check(req('GET', '/legacy'))[0]).toMatchObject({ check: 'contract.deprecated', where: 'operation', severity: 'warn' });
  });

  it('ignores unknown query params by default and warns when asked', () => {
    const r = req('GET', '/items/1?limit=1&extra=1&filter[min]=2', { headers: hdr });
    expect(check(r)).toEqual([]);
    const issues = check(r, { ...lenient, unknownParams: 'warn' });
    expect(issues).toEqual([expect.objectContaining({ check: 'contract.unknown-param', severity: 'warn', where: 'query', name: 'extra' })]);
  });
});

describe('validateRequest: auth', () => {
  const body = { body: JSON.stringify(goodUser), contentType: 'application/json' };

  it('checks presence of any alternative only when checkAuth is on', () => {
    expect(check(req('POST', '/users', body))).toEqual([]);
    const on = { ...lenient, checkAuth: true };
    const issues = check(req('POST', '/users', body), on);
    expect(issues).toEqual([expect.objectContaining({ check: 'contract.auth-missing', severity: 'warn', where: 'auth' })]);
    expect(issues[0].message).toMatch(/bearer Authorization header or API key header "X-Api-Key" \+ API key query "api_key"/);
    expect(check(req('POST', '/users', { ...body, headers: { authorization: 'Bearer t0k3n' } }), on)).toEqual([]);
    // Both parts of the AND requirement are needed.
    expect(checks(check(req('POST', '/users', { ...body, headers: { 'x-api-key': 'k' } }), on))).toEqual(['contract.auth-missing']);
    expect(check(req('POST', '/users?api_key=k', { ...body, headers: { 'x-api-key': 'k' } }), { ...on, unknownParams: 'warn' })).toEqual([]);
    // Wrong scheme does not count.
    expect(checks(check(req('POST', '/users', { ...body, headers: { authorization: 'Basic eDp5' } }), on))).toEqual(['contract.auth-missing']);
  });

  it('accepts anonymous access when {} is an alternative', () => {
    expect(check(req('POST', '/pets'), { ...lenient, checkAuth: true })).toEqual([]);
  });

  it('never puts credential values in actual', () => {
    const issues = check(req('POST', '/users', { ...body, headers: { authorization: 'Token secret-value' } }), { ...lenient, checkAuth: true });
    expect(JSON.stringify(issues)).not.toContain('secret-value');
  });
});

describe('validateRequest: bodies', () => {
  it('requires a body when the spec says so', () => {
    expect(check(req('POST', '/users'))).toEqual([expect.objectContaining({ check: 'contract.body-missing', where: 'body', severity: 'error' })]);
    expect(check(req('POST', '/pets'))).toEqual([]);
  });

  it('accepts a valid JSON body, with readOnly id not required', () => {
    expect(check(req('POST', '/users', json(goodUser)))).toEqual([]);
    expect(check(req('POST', '/users', { ...json(goodUser), contentType: 'application/json; charset=utf-8' }))).toEqual([]);
  });

  it('reports schema errors with a JSON pointer', () => {
    const issues = check(req('POST', '/users', json({ name: 5, email: 'nope' })));
    expect(issues.map((i) => [i.check, i.pointer])).toEqual([
      ['contract.body', '/name'],
      ['contract.body', '/password'],
      ['contract.body', '/email'],
    ]);
    expect(issues[0]).toMatchObject({ actual: '5', message: '/name must be string (got number)' });
    expect(issues[1].actual).toBeUndefined();
  });

  it('reports invalid JSON as a body issue', () => {
    const issues = check(req('POST', '/users', { body: '{"name":', contentType: 'application/json' }));
    expect(issues).toEqual([expect.objectContaining({ check: 'contract.body', where: 'body' })]);
    expect(issues[0].message).toMatch(/^Body is not valid JSON/);
  });

  it('reports an undeclared content type', () => {
    const issues = check(req('POST', '/users', { body: 'x', contentType: 'text/plain' }));
    expect(issues).toEqual([expect.objectContaining({ check: 'contract.content-type', where: 'content-type', actual: 'text/plain' })]);
    expect(issues[0].expected).toBe('application/json, application/x-www-form-urlencoded');
    expect(checks(check(req('POST', '/users', { body: '{}' })))).toEqual(['contract.content-type']);
  });

  it('matches wildcards and +json', () => {
    expect(mediaTypeMatches('application/*', 'application/xml')).toBe(true);
    expect(mediaTypeMatches('*/*', 'text/csv')).toBe(true);
    expect(mediaTypeMatches('application/json', 'application/vnd.api+json')).toBe(true);
    expect(mediaTypeMatches('application/json', 'text/plain')).toBe(false);
    expect(check(req('POST', '/users', { ...json(goodUser), contentType: 'application/merge-patch+json' }))).toEqual([]);
    expect(check(req('POST', '/pets', { body: JSON.stringify({ kind: 'dog' }), contentType: 'application/json' }))).toEqual([]);
  });

  it('parses and coerces a form body', () => {
    expect(check(req('POST', '/users', { body: 'name=Ann&password=pw&email=a%40b.co', contentType: 'application/x-www-form-urlencoded' }))).toEqual([]);
    const issues = check(req('POST', '/users', { body: 'name=Ann', contentType: 'application/x-www-form-urlencoded' }));
    expect(issues.map((i) => i.pointer)).toEqual(['/password']);
  });

  it('warns on a readOnly field sent and a deprecated field', () => {
    const issues = check(req('POST', '/users', json({ ...goodUser, id: 3, old: 'x' })));
    expect(issues.map((i) => [i.check, i.severity, i.pointer])).toEqual([
      ['contract.read-only', 'warn', '/id'],
      ['contract.deprecated', 'warn', '/old'],
    ]);
  });

  it('oneOf is lenient by default, strict on request', () => {
    // {kind, meow} matches both Cat and Dog (Dog allows extra properties).
    const r = req('POST', '/pets', { body: JSON.stringify({ kind: 'cat', meow: true }), contentType: 'application/json' });
    expect(check(r)).toEqual([]);
    expect(check(r, { ...lenient, oneOf: 'strict' }).map((i) => i.message)).toEqual(['Body matches more than one allowed shape']);
  });
});

describe('validateRequest: unknown fields', () => {
  it('is off by default and follows allOf when on', () => {
    const r = req('POST', '/users', json({ ...goodUser, nickname: 'x' }));
    expect(check(r)).toEqual([]);
    const issues = check(r, { ...lenient, unknownFields: 'warn' });
    expect(issues).toEqual([expect.objectContaining({ check: 'contract.unknown-field', severity: 'warn', pointer: '/nickname', name: 'nickname' })]);
    // name (from Base, via allOf) and password (second member) are declared: no false positives.
    expect(check(req('POST', '/users', json(goodUser)), { ...lenient, unknownFields: 'warn' })).toEqual([]);
  });

  it('stays quiet under oneOf', () => {
    const r = req('POST', '/pets', { body: JSON.stringify({ kind: 'dog', bark: true, extra: 1 }), contentType: 'application/json' });
    expect(check(r, { ...lenient, unknownFields: 'warn' })).toEqual([]);
  });
});

describe('validateResponse', () => {
  const op = (key: string) => spec.byKey.get(key)!;
  const res = (status: number, body: unknown, headers: Record<string, string> = {}, contentType = 'application/json') => ({
    status,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    contentType,
  });

  it('accepts a matching response, with writeOnly password not required', () => {
    expect(validateResponse(spec, op('GET /items/{id}'), res(200, { id: 1, name: 'A' }, { 'X-Rate-Limit': '10' }), lenient)).toEqual([]);
  });

  it('reports a body mismatch and a missing / invalid required header', () => {
    const issues = validateResponse(spec, op('GET /items/{id}'), res(200, { name: 'A' }), lenient);
    expect(issues.map((i) => [i.check, i.side, i.where])).toEqual([
      ['contract.response-header', 'response', 'header'],
      ['contract.response-body', 'response', 'body'],
    ]);
    expect(issues[1].pointer).toBe('/id');
    const bad = validateResponse(spec, op('GET /items/{id}'), res(200, { id: 1, name: 'A' }, { 'x-rate-limit': 'lots' }), lenient);
    expect(bad).toEqual([expect.objectContaining({ check: 'contract.response-header', name: 'X-Rate-Limit', actual: 'lots' })]);
  });

  it('falls back to the NXX range, then default', () => {
    const o = op('GET /items/{id}');
    expect(validateResponse(spec, o, res(404, { title: 'Not found' }, {}, 'application/problem+json'), lenient)).toEqual([]);
    expect(checks(validateResponse(spec, o, res(422, {}, {}, 'application/problem+json'), lenient))).toEqual(['contract.response-body']);
    expect(validateResponse(spec, o, res(500, 'boom', {}, 'text/plain'), lenient)).toEqual([]);
  });

  it('reports an undeclared status', () => {
    const issues = validateResponse(spec, op('POST /users'), res(200, goodUser), lenient);
    expect(issues).toEqual([expect.objectContaining({ check: 'contract.response-status', where: 'status', actual: '200', expected: '201' })]);
  });

  it('reports a content type mismatch and invalid JSON', () => {
    expect(validateResponse(spec, op('POST /users'), res(201, '<x/>', {}, 'text/html'), lenient)).toEqual([
      expect.objectContaining({ check: 'contract.content-type', side: 'response', actual: 'text/html' }),
    ]);
    expect(checks(validateResponse(spec, op('POST /users'), res(201, '{bad'), lenient))).toEqual(['contract.response-body']);
  });
});

describe('actual values and the cap', () => {
  it('masks card-like digit runs, keeps short numbers, and clips to 80 chars', () => {
    expect(maskActual('4242424242424242')).toBe('************4242');
    expect(maskActual('card 4242 4242 4242 4242 ok')).toBe('card **** **** **** 4242 ok');
    expect(maskActual('order 123456')).toBe('order 123456');
    expect(maskActual({ n: 5 })).toBe('{"n":5}');
    const long = maskActual('x'.repeat(200))!;
    expect(long.length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
    expect(maskActual(undefined)).toBeUndefined();
  });

  it('masks card numbers in body issues and hides secret-looking fields', () => {
    const issues = check(req('POST', '/users', json({ name: 4111111111111111, password: 12345 })));
    expect(issues.find((i) => i.pointer === '/name')?.actual).toBe('************1111');
    expect(issues.find((i) => i.pointer === '/password')?.actual).toBeUndefined();
  });

  it('keeps apiKey values out of actual', () => {
    const withKey = compileSpec(
      normalizeSpec(
        parseSpecText(`
openapi: 3.1.0
components:
  securitySchemes: {k: {type: apiKey, in: header, name: X-Key}}
paths:
  /a:
    get:
      parameters: [{name: X-Key, in: header, schema: {type: string, minLength: 40}}]
      responses: {'200': {description: ok}}
`).document,
      ).document,
    );
    const issues = check(req('GET', '/a', { headers: { 'x-key': 'super-secret' } }), lenient, withKey);
    expect(issues).toHaveLength(1);
    expect(issues[0].actual).toBeUndefined();
  });

  it('caps issues at MAX_CONTRACT_ISSUES, errors first', () => {
    const qs = Array.from({ length: 60 }, (_, i) => `u${i}=1`).join('&');
    const issues = check(req('GET', `/items/x?${qs}`, { headers: hdr }), { ...lenient, unknownParams: 'warn' });
    expect(issues).toHaveLength(61);
    const capped = capIssues(issues);
    expect(capped.truncated).toBe(true);
    expect(capped.issues).toHaveLength(MAX_CONTRACT_ISSUES);
    expect(capped.issues[0]).toMatchObject({ check: 'contract.param', name: 'id' });
    expect(capIssues(issues.slice(0, 3)).truncated).toBe(false);
  });
});

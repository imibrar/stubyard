// validateSchema's 4th `opts` argument (used by OpenAPI contracts): $ref root, lenient oneOf + discriminator, the regex
// cache, the long-string pattern skip, and numeric formats. Webhook behaviour without opts must stay the same.
import { describe, expect, it } from 'vitest';
import { validateSchema, type JsonSchema } from '../src/webhooks/schema.js';

const spec = {
  openapi: '3.1.0',
  components: {
    schemas: {
      Node: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } },
      },
      Cat: { type: 'object', required: ['kind', 'lives'], properties: { kind: { const: 'Cat' }, lives: { type: 'integer' } } },
      Dog: { type: 'object', required: ['kind', 'bark'], properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } },
      Pet: {
        oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
        discriminator: { propertyName: 'kind' },
      },
      MappedPet: {
        oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
        discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
      },
    },
  },
};

describe('root', () => {
  it('resolves $ref against the whole document, including a cyclic tree node', () => {
    const tree = { name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] };
    const opts = { root: spec };
    expect(validateSchema({ $ref: '#/components/schemas/Node' }, tree, 50, opts)).toEqual([]);
    expect(validateSchema({ $ref: '#/components/schemas/Node' }, { name: 'a', children: [{ children: [] }] }, 50, opts)).toEqual([
      { path: '/children/0/name', message: 'missing required property "name"' },
    ]);
  });

  it('stays safe on a self-referencing $ref', () => {
    const root = { components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } } };
    expect(validateSchema({ $ref: '#/components/schemas/Loop' }, 1, 50, { root })).toEqual([]);
  });

  it('without root, $ref still resolves against the schema itself', () => {
    expect(() => validateSchema({ $ref: '#/components/schemas/Node' }, {})).toThrow(/not found/);
  });
});

describe('oneOf', () => {
  const overlap: JsonSchema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };

  it('strict (default) reports overlapping matches, lenient passes them', () => {
    expect(validateSchema(overlap, 3)).toEqual([{ path: '', message: 'matches more than one allowed shape' }]);
    expect(validateSchema(overlap, 3, 50, { oneOf: 'strict' })).toEqual([{ path: '', message: 'matches more than one allowed shape' }]);
    expect(validateSchema(overlap, 3, 50, { oneOf: 'lenient' })).toEqual([]);
    expect(validateSchema(overlap, 'x', 50, { oneOf: 'lenient' })).toHaveLength(1);
  });

  const lenient = { root: spec, oneOf: 'lenient' as const };

  it('discriminator picks the branch by #/components/schemas/<value> and reports its errors', () => {
    const pet: JsonSchema = { $ref: '#/components/schemas/Pet' };
    expect(validateSchema(pet, { kind: 'Cat', lives: 9 }, 50, lenient)).toEqual([]);
    expect(validateSchema(pet, { kind: 'Dog', bark: 'loud' }, 50, lenient)).toEqual([{ path: '/bark', message: 'must be boolean (got string)' }]);
    expect(validateSchema(pet, { kind: 'Cat' }, 50, lenient)).toEqual([{ path: '/lives', message: 'missing required property "lives"' }]);
  });

  it('discriminator uses mapping, and an unknown value is an error', () => {
    const pet: JsonSchema = { $ref: '#/components/schemas/MappedPet' };
    expect(validateSchema(pet, { kind: 'dog', bark: true }, 50, lenient)).toEqual([]);
    expect(validateSchema(pet, { kind: 'dog', bark: 1 }, 50, lenient)).toEqual([{ path: '/bark', message: 'must be boolean (got number)' }]);
    expect(validateSchema(pet, { kind: 'fish' }, 50, lenient)).toEqual([{ path: '/kind', message: 'discriminator value "fish" does not match any allowed shape' }]);
    expect(validateSchema(pet, {}, 50, lenient)).toEqual([{ path: '/kind', message: 'missing discriminator property "kind"' }]);
    for (const kind of ['constructor', '__proto__', 'toString'])
      expect(validateSchema({ $ref: '#/components/schemas/Pet' }, { kind }, 50, lenient)).toEqual([
        { path: '/kind', message: `discriminator value "${kind}" does not match any allowed shape` },
      ]);
  });
});

describe('pattern', () => {
  it('gives the same results on repeated (cached) use', () => {
    const s: JsonSchema = { type: 'string', pattern: '^ab+$' };
    for (let i = 0; i < 3; i++) {
      expect(validateSchema(s, 'abbb')).toEqual([]);
      expect(validateSchema(s, 'ac')).toEqual([{ path: '', message: 'must match pattern ^ab+$' }]);
    }
  });

  it('an invalid pattern still reports as before', () => {
    expect(validateSchema({ type: 'string', pattern: '(' }, 'x')).toEqual([{ path: '', message: 'schema has an invalid pattern (' }]);
  });

  it('skips pattern on strings over 10000 chars and records a note', () => {
    const notes: string[] = [];
    const s: JsonSchema = { type: 'object', properties: { x: { type: 'string', pattern: '^a+$' } } };
    expect(validateSchema(s, { x: 'b'.repeat(10_001) }, 50, { notes })).toEqual([]);
    expect(notes).toEqual(['pattern not checked at /x (string over 10000 chars)']);
    expect(validateSchema(s, { x: 'b'.repeat(10_000) })).toEqual([{ path: '/x', message: 'must match pattern ^a+$' }]);
    expect(validateSchema(s, { x: 'b'.repeat(10_001) })).toEqual([]); // no notes array: still fine
  });
});

describe('numeric formats', () => {
  it('int32 range', () => {
    const s: JsonSchema = { type: 'integer', format: 'int32' };
    expect(validateSchema(s, 2147483647)).toEqual([]);
    expect(validateSchema(s, -2147483648)).toEqual([]);
    expect(validateSchema(s, 2147483648)).toEqual([{ path: '', message: 'must be a valid int32 (-2147483648..2147483647)' }]);
    expect(validateSchema(s, -2147483649)).toHaveLength(1);
  });

  it('int64 is checked against the safe-integer range', () => {
    const s: JsonSchema = { type: 'integer', format: 'int64' };
    expect(validateSchema(s, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(validateSchema(s, -Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(validateSchema(s, 2 ** 53)).toHaveLength(1);
    expect(validateSchema(s, -(2 ** 53))).toHaveLength(1);
  });

  it('float and double are no-ops', () => {
    expect(validateSchema({ type: 'number', format: 'float' }, 1e300)).toEqual([]);
    expect(validateSchema({ type: 'number', format: 'double' }, -0.5)).toEqual([]);
  });

  it('string formats are unchanged', () => {
    expect(validateSchema({ type: 'string', format: 'uuid' }, 'nope')).toEqual([{ path: '', message: 'must be a valid uuid' }]);
    expect(validateSchema({ type: 'string', format: 'int32' }, 'x')).toEqual([]);
  });
});

describe('existing behaviour', () => {
  it('a simple schema gives the same errors as before', () => {
    const s: JsonSchema = {
      type: 'object',
      required: ['id', 'amount'],
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 3 }, amount: { type: 'integer', minimum: 1 }, tags: { type: 'array', items: { enum: ['a', 'b'] } } },
    };
    expect(validateSchema(s, { id: 'x', amount: 0, tags: ['c'], extra: 1 })).toEqual([
      { path: '/id', message: 'must have at least 3 characters' },
      { path: '/amount', message: 'must be >= 1' },
      { path: '/tags/0', message: 'must be one of "a", "b"' },
      { path: '/extra', message: 'unexpected property "extra"' },
    ]);
    expect(validateSchema(s, { amount: 5 })).toEqual([{ path: '/id', message: 'missing required property "id"' }]);
  });
});

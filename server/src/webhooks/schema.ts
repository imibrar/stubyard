/**
 * A small JSON Schema validator (the commonly used subset of draft-07 / 2020-12) and a schema inferrer.
 * No dependency: webhook payloads only need types, required, nested objects/arrays, enums, formats and bounds.
 */

export type JsonSchema = Record<string, unknown> | boolean;

export interface SchemaError {
  /** JSON pointer into the payload, e.g. "/data/object/amount" ("" = the whole body). */
  path: string;
  message: string;
}

const FORMATS: Record<string, (s: string) => boolean> = {
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  time: (s) => /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(s),
  uri: (s) => /^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(s),
  url: (s) => /^https?:\/\/[^\s]+$/i.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  ipv4: (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
  hostname: (s) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s),
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** Validate `value` against `schema`. Returns an empty list when valid. */
export function validateSchema(schema: JsonSchema, value: unknown, maxErrors = 50): SchemaError[] {
  const errors: SchemaError[] = [];
  const root = schema;

  const resolveRef = (ref: string): JsonSchema => {
    if (!ref.startsWith('#')) throw new Error(`Only local $ref values are supported (got "${ref}")`);
    let cur: unknown = root;
    for (const part of ref.slice(1).split('/').filter(Boolean)) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    }
    if (cur === undefined) throw new Error(`$ref "${ref}" not found`);
    return cur as JsonSchema;
  };

  const check = (s: JsonSchema, v: unknown, path: string, out: SchemaError[], depth: number): void => {
    if (out.length >= maxErrors || depth > 64) return;
    if (s === true) return;
    if (s === false) return void out.push({ path, message: 'is not allowed here' });
    if (!s || typeof s !== 'object') return;
    const add = (message: string, p = path) => out.length < maxErrors && out.push({ path: p, message });

    if (typeof s.$ref === 'string') check(resolveRef(s.$ref), v, path, out, depth + 1);

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => matchesType(v, t))) {
        add(`must be ${types.join(' or ')} (got ${typeOf(v) === 'integer' ? 'number' : typeOf(v)})`);
        return; // the other keywords would only add noise
      }
    }
    if (s.const !== undefined && !deepEqual(v, s.const)) add(`must be ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) add(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);

    if (typeof v === 'string') {
      if (typeof s.minLength === 'number' && [...v].length < s.minLength) add(`must have at least ${s.minLength} characters`);
      if (typeof s.maxLength === 'number' && [...v].length > s.maxLength) add(`must have at most ${s.maxLength} characters`);
      if (typeof s.pattern === 'string') {
        let re: RegExp | null = null;
        try {
          re = new RegExp(s.pattern, 'u');
        } catch {
          add(`schema has an invalid pattern ${s.pattern}`);
        }
        if (re && !re.test(v)) add(`must match pattern ${s.pattern}`);
      }
      if (typeof s.format === 'string' && FORMATS[s.format] && !FORMATS[s.format](v)) add(`must be a valid ${s.format}`);
    }

    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) add(`must be >= ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) add(`must be <= ${s.maximum}`);
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) add(`must be > ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) add(`must be < ${s.exclusiveMaximum}`);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0 && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) add(`must be a multiple of ${s.multipleOf}`);
    }

    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) add(`must have at least ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) add(`must have at most ${s.maxItems} items`);
      if (s.uniqueItems === true) {
        for (let i = 0; i < v.length; i++) {
          if (v.slice(0, i).some((x) => deepEqual(x, v[i]))) {
            add('must not contain duplicate items');
            break;
          }
        }
      }
      const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as JsonSchema[]) : Array.isArray(s.items) ? (s.items as JsonSchema[]) : [];
      prefix.forEach((ps, i) => i < v.length && check(ps, v[i], `${path}/${i}`, out, depth + 1));
      const rest = Array.isArray(s.items) ? s.additionalItems : s.items;
      if (rest !== undefined && !Array.isArray(rest)) for (let i = prefix.length; i < v.length; i++) check(rest as JsonSchema, v[i], `${path}/${i}`, out, depth + 1);
      if (s.contains !== undefined && !v.some((x) => validateSub(s.contains as JsonSchema, x))) add('must contain at least one matching item');
    }

    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!(k in obj)) add(`missing required property "${k}"`, `${path}/${esc(k)}`);
      const keys = Object.keys(obj);
      if (typeof s.minProperties === 'number' && keys.length < s.minProperties) add(`must have at least ${s.minProperties} properties`);
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) add(`must have at most ${s.maxProperties} properties`);
      const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, JsonSchema>).map(([p, ps]) => [new RegExp(p, 'u'), ps] as const);
      for (const k of keys) {
        let matched = false;
        if (k in props) {
          matched = true;
          check(props[k], obj[k], `${path}/${esc(k)}`, out, depth + 1);
        }
        for (const [re, ps] of patterns) {
          if (re.test(k)) {
            matched = true;
            check(ps, obj[k], `${path}/${esc(k)}`, out, depth + 1);
          }
        }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) add(`unexpected property "${k}"`, `${path}/${esc(k)}`);
          else check(s.additionalProperties as JsonSchema, obj[k], `${path}/${esc(k)}`, out, depth + 1);
        }
      }
      if (s.propertyNames !== undefined) for (const k of keys) if (!validateSub(s.propertyNames as JsonSchema, k)) add(`property name "${k}" is not allowed`);
      if (s.dependentRequired && typeof s.dependentRequired === 'object') {
        for (const [k, deps] of Object.entries(s.dependentRequired as Record<string, string[]>)) {
          if (k in obj) for (const d of deps) if (!(d in obj)) add(`"${d}" is required when "${k}" is present`);
        }
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) check(sub, v, path, out, depth + 1);
    if (Array.isArray(s.anyOf)) {
      const results = (s.anyOf as JsonSchema[]).map((sub) => collect(sub, v, path, depth));
      if (!results.some((r) => r.length === 0)) add(`must match at least one allowed shape (${bestHint(results)})`);
    }
    if (Array.isArray(s.oneOf)) {
      const results = (s.oneOf as JsonSchema[]).map((sub) => collect(sub, v, path, depth));
      const n = results.filter((r) => r.length === 0).length;
      if (n === 0) add(`must match exactly one allowed shape (${bestHint(results)})`);
      else if (n > 1) add('matches more than one allowed shape');
    }
    if (s.not !== undefined && collect(s.not as JsonSchema, v, path, depth).length === 0) add('must not match the "not" schema');
    if (s.if !== undefined) {
      const ok = collect(s.if as JsonSchema, v, path, depth).length === 0;
      if (ok && s.then !== undefined) check(s.then as JsonSchema, v, path, out, depth + 1);
      if (!ok && s.else !== undefined) check(s.else as JsonSchema, v, path, out, depth + 1);
    }
  };

  const collect = (s: JsonSchema, v: unknown, path: string, depth: number) => {
    const out: SchemaError[] = [];
    check(s, v, path, out, depth + 1);
    return out;
  };
  const validateSub = (s: JsonSchema, v: unknown) => collect(s, v, '', 0).length === 0;
  const bestHint = (results: SchemaError[][]) => {
    const best = [...results].sort((a, b) => a.length - b.length)[0];
    return best?.[0] ? `${best[0].path || '/'} ${best[0].message}` : 'no match';
  };

  check(schema, value, '', errors, 0);
  return errors;
}

/** Throws a readable error when a schema is not usable (bad $ref, invalid regex…). */
export function assertSchema(schema: unknown): asserts schema is JsonSchema {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('A JSON Schema must be an object (or true/false)');
  const walk = (s: unknown): void => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) return s.forEach(walk);
    const o = s as Record<string, unknown>;
    if (typeof o.pattern === 'string') new RegExp(o.pattern, 'u');
    if (o.patternProperties && typeof o.patternProperties === 'object') for (const p of Object.keys(o.patternProperties)) new RegExp(p, 'u');
    for (const v of Object.values(o)) walk(v);
  };
  walk(schema);
  // Exercise $refs once.
  validateSchema(schema as JsonSchema, undefined);
}

// ---------------- inference ----------------

function stringFormat(s: string): string | undefined {
  if (FORMATS.uuid(s)) return 'uuid';
  if (FORMATS.email(s)) return 'email';
  if (/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/.test(s) && FORMATS['date-time'](s)) return 'date-time';
  if (FORMATS.date(s)) return 'date';
  if (/^(https?|ftp|wss?):\/\/[^\s]+$/i.test(s)) return 'uri';
  return undefined;
}

type S = Record<string, unknown>;

function inferValue(v: unknown): S {
  const t = typeOf(v);
  if (t === 'null') return { type: 'null' };
  if (t === 'string') {
    const f = stringFormat(v as string);
    return f ? { type: 'string', format: f } : { type: 'string' };
  }
  if (t === 'integer') return { type: 'integer' };
  if (t === 'number') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'array') {
    const items = (v as unknown[]).map(inferValue);
    return items.length ? { type: 'array', items: items.reduce(merge) } : { type: 'array' };
  }
  const obj = v as Record<string, unknown>;
  const properties: Record<string, S> = {};
  for (const [k, x] of Object.entries(obj)) properties[k] = inferValue(x);
  return { type: 'object', properties, required: Object.keys(obj) };
}

function typesOf(s: S): string[] {
  return s.type === undefined ? [] : Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
}

/** Merge two inferred schemas (e.g. different items of one array). */
function merge(a: S, b: S): S {
  const ta = typesOf(a);
  const tb = typesOf(b);
  let types = [...new Set([...ta, ...tb])];
  if (types.includes('number') && types.includes('integer')) types = types.filter((t) => t !== 'integer');
  const out: S = { type: types.length === 1 ? types[0] : types };
  // Keep a string format only when every string seen had it (a null on one side does not count).
  const sa = ta.includes('string');
  const sb = tb.includes('string');
  const f = sa && sb ? (a.format === b.format ? a.format : undefined) : sa ? a.format : sb ? b.format : undefined;
  if (f) out.format = f;
  if (types.includes('object')) {
    const pa = (a.properties ?? {}) as Record<string, S>;
    const pb = (b.properties ?? {}) as Record<string, S>;
    const props: Record<string, S> = {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) props[k] = pa[k] && pb[k] ? merge(pa[k], pb[k]) : (pa[k] ?? pb[k]);
    out.properties = props;
    const ra = ta.includes('object') ? ((a.required ?? []) as string[]) : null;
    const rb = tb.includes('object') ? ((b.required ?? []) as string[]) : null;
    out.required = ra && rb ? ra.filter((k) => rb.includes(k)) : (ra ?? rb ?? []);
  }
  if (types.includes('array')) {
    const ia = a.items as S | undefined;
    const ib = b.items as S | undefined;
    if (ia || ib) out.items = ia && ib ? merge(ia, ib) : (ia ?? ib);
  }
  return out;
}

/** Generate a JSON Schema from a sample payload. */
export function inferSchema(sample: unknown, title?: string): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...(title ? { title } : {}), ...inferValue(sample) };
}

// OpenAPI contract checks (C1): parse an uploaded spec (JSON or YAML), normalize OAS 3.0 schemas to the validator's
// dialect, resolve local $refs, and compile the operations into path regexes for request matching.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { HttpError } from '../util.js';
import type { JsonSchema } from '../webhooks/schema.js';
import type { CompiledOperation, CompiledSpec, SpecDocument, SpecParameter, SpecRecord } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Largest spec document accepted (UTF-8 bytes). */
export const SPEC_MAX_BYTES = 10 * 1024 * 1024;

/** Path item keys that are operations, in OpenAPI order. */
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** A spec that cannot be imported: the message is meant for the user. */
export class SpecError extends HttpError {
  constructor(message: string, statusCode = 400) {
    super(statusCode, message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing

export interface ParsedSpec {
  /** The raw document (not normalized yet). */
  document: Obj;
  /** The `openapi` field, e.g. "3.0.3". */
  openapiVersion: string;
  format: 'json' | 'yaml';
}

/** Parse spec text: JSON when the first non-space character is `{`, YAML otherwise. Only OpenAPI 3.0.x / 3.1.x pass. */
export function parseSpecText(text: string): ParsedSpec {
  if (typeof text !== 'string' || !text.trim()) throw new SpecError('The spec is empty');
  if (Buffer.byteLength(text, 'utf8') > SPEC_MAX_BYTES) throw new SpecError(`The spec is larger than ${SPEC_MAX_BYTES / 1024 / 1024} MB`, 413);
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const format = src.trimStart().startsWith('{') ? 'json' : 'yaml';
  let doc: unknown;
  try {
    doc = format === 'json' ? JSON.parse(src) : parseYaml(src, { maxAliasCount: 100, uniqueKeys: true, merge: true });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
    throw new SpecError(`The spec is not valid ${format === 'json' ? 'JSON' : 'YAML'}: ${msg}`);
  }
  if (!isObj(doc)) throw new SpecError('The spec must be a JSON or YAML object');
  if (doc.swagger !== undefined) throw new SpecError('Swagger 2.0: convert to OpenAPI 3 first (e.g. converter.swagger.io)');
  const v = doc.openapi;
  if (typeof v !== 'string') throw new SpecError('Not an OpenAPI document: the "openapi" field is missing');
  if (!/^3\.[01]\.\d+(-[\w.]+)?$/.test(v)) throw new SpecError(`OpenAPI ${v} is not supported (only 3.0.x and 3.1.x)`);
  return { document: doc, openapiVersion: v, format };
}

// ---------------------------------------------------------------------------------------------------------------
// $ref helpers

/** Resolve a local JSON pointer ("#/components/schemas/User") against `doc`; undefined when it does not resolve. */
export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  let cur: unknown = doc;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    let key: string;
    try {
      key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    cur = cur && typeof cur === 'object' && Object.hasOwn(cur, key) ? (cur as Obj)[key] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Follow a `$ref` chain (parameters, requestBodies, responses, headers, path items) to the object it names. A cycle,
 * an external ref or a missing target gives a warning and `{}`. A node without `$ref` is returned as is.
 */
export function deref(doc: unknown, node: unknown, warnings?: string[]): Obj {
  const seen = new Set<string>();
  let cur = node;
  while (isObj(cur) && typeof cur.$ref === 'string') {
    const ref = cur.$ref;
    if (!ref.startsWith('#')) return warn(warnings, `External $ref "${ref}" is not supported; treated as {}`);
    if (seen.has(ref)) return warn(warnings, `$ref cycle at "${ref}"; treated as {}`);
    seen.add(ref);
    const next = resolvePointer(doc, ref);
    if (next === undefined) return warn(warnings, `$ref "${ref}" does not resolve; treated as {}`);
    cur = next;
  }
  return isObj(cur) ? cur : {};
}

function warn(warnings: string[] | undefined, message: string): Obj {
  if (warnings && !warnings.includes(message)) warnings.push(message);
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization (OAS 3.0 -> the validator's dialect)

/** Schema keywords whose value is a map of schemas. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
/** Schema keywords whose value is a list of schemas. */
const SCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Schema keywords whose value is one schema. */
const SCHEMA_ONE = new Set([
  'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties',
  'unevaluatedItems', 'additionalItems', 'contentSchema',
]);
/** Dropped from schemas (`example` becomes `examples: [example]`). */
const SCHEMA_DROP = new Set(['example', 'xml', 'externalDocs']);
/** Keywords the validator does not check: one import warning each. */
const UNSUPPORTED = new Set([
  'unevaluatedProperties', 'unevaluatedItems', 'dependentSchemas', 'dependencies', '$dynamicRef', '$recursiveRef',
  'minContains', 'maxContains',
]);
/** Annotations kept on the outside when a 3.0 `nullable` schema without `type` is wrapped in anyOf. */
const ANNOTATIONS = ['title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples', 'discriminator'];

/** Set a key without the `__proto__` setter (a parsed document can have it as an own key). */
function put(o: Obj, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

class Normalizer {
  readonly warnings: string[] = [];
  private readonly ancestors = new Set<object>();

  constructor(
    private readonly src: Obj,
    private readonly is30: boolean,
  ) {}

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Guards against cyclic input (YAML aliases can build one); a cycle becomes null. */
  private guard<T>(node: object, fn: () => T): T | null {
    if (this.ancestors.has(node)) {
      this.warn('The document contains a cyclic YAML alias; that part was dropped');
      return null;
    }
    this.ancestors.add(node);
    try {
      return fn();
    } finally {
      this.ancestors.delete(node);
    }
  }

  /** A plain deep copy (examples, extensions, info …). */
  data(v: unknown): unknown {
    if (!v || typeof v !== 'object') return v;
    return this.guard(v, () => {
      if (Array.isArray(v)) return v.map((x) => this.data(x));
      const out: Obj = {};
      for (const [k, x] of Object.entries(v)) put(out, k, this.data(x));
      return out;
    });
  }

  private map(v: unknown, fn: (x: unknown) => unknown): unknown {
    if (!isObj(v)) return this.data(v);
    return this.guard(v, () => {
      const out: Obj = {};
      for (const [k, x] of Object.entries(v)) put(out, k, fn(x));
      return out;
    });
  }

  private list(v: unknown, fn: (x: unknown) => unknown): unknown {
    if (!Array.isArray(v)) return this.data(v);
    return this.guard(v, () => v.map(fn));
  }

  /** Copy `node` key by key; `fields` transforms the known keys, the rest is copied as data. */
  private object(node: unknown, fields: Record<string, (x: unknown) => unknown>): unknown {
    if (!isObj(node)) return this.data(node);
    const ref = this.refCheck(node);
    if (ref !== undefined) return ref;
    return this.guard(node, () => {
      const out: Obj = {};
      for (const [k, x] of Object.entries(node)) put(out, k, Object.hasOwn(fields, k) ? fields[k](x) : this.data(x));
      return out;
    });
  }

  /** A `$ref` node outside a schema: external or unresolved → `{}` (warned); local → kept as is. */
  private refCheck(node: Obj): Obj | undefined {
    if (typeof node.$ref !== 'string') return undefined;
    const ref = node.$ref;
    if (!ref.startsWith('#')) {
      this.warn(`External $ref "${ref}" is not supported; treated as {}`);
      return {};
    }
    if (resolvePointer(this.src, ref) === undefined) {
      this.warn(`$ref "${ref}" does not resolve; treated as {}`);
      return {};
    }
    return this.data(node) as Obj;
  }

  document(): SpecDocument {
    return this.object(this.src, {
      paths: (x) => this.map(x, (p) => this.pathItem(p)),
      webhooks: (x) => this.map(x, (p) => this.pathItem(p)),
      components: (x) => this.components(x),
    }) as SpecDocument;
  }

  components(c: unknown): unknown {
    return this.object(c, {
      schemas: (x) => this.map(x, (s) => this.schema(s)),
      parameters: (x) => this.map(x, (p) => this.parameter(p)),
      requestBodies: (x) => this.map(x, (b) => this.requestBody(b)),
      responses: (x) => this.map(x, (r) => this.response(r)),
      headers: (x) => this.map(x, (h) => this.parameter(h)),
      pathItems: (x) => this.map(x, (p) => this.pathItem(p)),
      callbacks: (x) => this.map(x, (cb) => this.callback(cb)),
    });
  }

  pathItem(p: unknown): unknown {
    const fields: Record<string, (x: unknown) => unknown> = { parameters: (x) => this.list(x, (q) => this.parameter(q)) };
    for (const m of HTTP_METHODS) fields[m] = (x) => this.operation(x);
    return this.object(p, fields);
  }

  operation(o: unknown): unknown {
    return this.object(o, {
      parameters: (x) => this.list(x, (q) => this.parameter(q)),
      requestBody: (x) => this.requestBody(x),
      responses: (x) => this.map(x, (r) => this.response(r)),
      callbacks: (x) => this.map(x, (cb) => this.callback(cb)),
    });
  }

  callback(cb: unknown): unknown {
    if (isObj(cb)) {
      const ref = this.refCheck(cb);
      if (ref !== undefined) return ref;
    }
    return this.map(cb, (p) => this.pathItem(p));
  }

  /** A parameter or a header object. */
  parameter(p: unknown): unknown {
    return this.object(p, { schema: (x) => this.schema(x), content: (x) => this.map(x, (m) => this.media(m)) });
  }

  requestBody(b: unknown): unknown {
    return this.object(b, { content: (x) => this.map(x, (m) => this.media(m)) });
  }

  response(r: unknown): unknown {
    return this.object(r, {
      headers: (x) => this.map(x, (h) => this.parameter(h)),
      content: (x) => this.map(x, (m) => this.media(m)),
    });
  }

  /** A media type object: `example` / `examples` are kept here (mock mapping uses them). */
  media(m: unknown): unknown {
    return this.object(m, {
      schema: (x) => this.schema(x),
      encoding: (x) => this.map(x, (e) => this.object(e, { headers: (h) => this.map(h, (y) => this.parameter(y)) })),
    });
  }

  schema(s: unknown): unknown {
    if (!isObj(s)) return this.data(s); // boolean schemas and garbage
    if (typeof s.$ref === 'string') {
      const ref = s.$ref;
      if (!ref.startsWith('#')) {
        this.warn(`External $ref "${ref}" is not supported; treated as {}`);
        return {};
      }
      if (resolvePointer(this.src, ref) === undefined) {
        this.warn(`$ref "${ref}" does not resolve; treated as {}`);
        return {};
      }
    }
    return this.guard(s, () => {
      const out: Obj = {};
      for (const [k, v] of Object.entries(s)) {
        if (SCHEMA_DROP.has(k)) continue;
        if (UNSUPPORTED.has(k)) this.warn(`Schema keyword "${k}" is not checked`);
        if (SCHEMA_MAPS.has(k)) put(out, k, this.map(v, (x) => this.schema(x)));
        else if (SCHEMA_LISTS.has(k)) put(out, k, this.list(v, (x) => this.schema(x)));
        else if (SCHEMA_ONE.has(k)) put(out, k, this.schema(v));
        else if (k === 'items') put(out, k, Array.isArray(v) ? this.list(v, (x) => this.schema(x)) : this.schema(v));
        else put(out, k, this.data(v));
      }
      if (s.example !== undefined && s.examples === undefined) out.examples = [this.data(s.example)];
      return this.is30 ? this.from30(out) : this.from31(out);
    });
  }

  /** OAS 3.0 → 2020-12: nullable and the boolean exclusiveMinimum / exclusiveMaximum. */
  private from30(out: Obj): Obj {
    for (const [ex, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
      if (typeof out[ex] !== 'boolean') continue;
      if (out[ex] === true && typeof out[bound] === 'number') {
        out[ex] = out[bound];
        delete out[bound];
      } else delete out[ex];
    }
    if (out.nullable === undefined) return out;
    const nullable = out.nullable === true;
    delete out.nullable;
    if (!nullable) return out;
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.type)) {
      if (!out.type.includes('null')) out.type = [...out.type, 'null'];
    } else if (out.$ref !== undefined || out.allOf !== undefined || out.anyOf !== undefined || out.oneOf !== undefined) {
      // `nullable` next to a composition: null is allowed in addition to what the composition accepts.
      const outer: Obj = {};
      for (const k of ANNOTATIONS) {
        if (out[k] !== undefined) {
          outer[k] = out[k];
          delete out[k];
        }
      }
      outer.anyOf = [out, { type: 'null' }];
      return outer;
    }
    return out;
  }

  private from31(out: Obj): Obj {
    if (out.nullable !== undefined) {
      this.warn('"nullable" is OpenAPI 3.0 only and is ignored in a 3.1 document (use type: [..., "null"])');
      delete out.nullable;
    }
    for (const ex of ['exclusiveMinimum', 'exclusiveMaximum']) if (typeof out[ex] === 'boolean') delete out[ex];
    return out;
  }
}

/**
 * Normalize a parsed OpenAPI 3.x document into a new object: 3.0 schemas get 3.1 / 2020-12 shapes, schema-level
 * `example` / `xml` / `externalDocs` are dropped (`example` survives as `examples: [example]`), external and broken
 * `$ref`s become `{}`. Local `$ref`s are kept. Pure: the input is not changed.
 */
export function normalizeSpec(doc: Obj): { document: SpecDocument; warnings: string[] } {
  const is30 = typeof doc.openapi === 'string' && doc.openapi.startsWith('3.0');
  const n = new Normalizer(doc, is30);
  const document = n.document();
  return { document, warnings: n.warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Compilation

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Convert a path template into an anchored regex. `{name}` matches within one segment (`{a}.{ext}` works); the
 * capture groups follow `paramNames`. A trailing slash on the concrete path is tolerated.
 */
export function templateToRegex(template: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = template.split('/').filter((s, i) => i > 0 || s !== '');
  const parts = segments.map((seg) => {
    let re = '';
    let rest = seg;
    for (let m = /\{([^{}/]+)\}/.exec(rest); m; m = /\{([^{}/]+)\}/.exec(rest)) {
      re += escapeRe(rest.slice(0, m.index)) + '([^/]+)';
      paramNames.push(m[1]);
      rest = rest.slice(m.index + m[0].length);
    }
    return re + escapeRe(rest);
  });
  const body = parts.join('/');
  return { regex: new RegExp(`^/${body}${body ? '/?' : ''}$`), paramNames };
}

/** Literal weight of a template: whole literal segments count 1, segments mixing text and `{x}` count 0.5. */
function literalWeight(template: string): number {
  let w = 0;
  for (const seg of template.split('/').filter(Boolean)) {
    if (!seg.includes('{')) w += 1;
    else if (seg.replace(/\{[^{}]*\}/g, '') !== '') w += 0.5;
  }
  return w;
}

/** Literal-first: more literal segments first, then longer paths, then by key (deterministic). */
export function compareOperations(a: { pathTemplate: string; key: string }, b: { pathTemplate: string; key: string }): number {
  return (
    literalWeight(b.pathTemplate) - literalWeight(a.pathTemplate) ||
    b.pathTemplate.split('/').length - a.pathTemplate.split('/').length ||
    b.pathTemplate.length - a.pathTemplate.length ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

function isRecord(v: unknown): v is SpecRecord {
  return isObj(v) && isObj(v.document) && typeof v.hash === 'string';
}

/** A stand-in record for compiling a bare document. */
function recordFor(doc: SpecDocument): SpecRecord {
  const title = typeof doc.info?.title === 'string' ? doc.info.title : '';
  return {
    id: '',
    projectId: '',
    name: title,
    role: 'mock',
    prefix: '',
    mode: 'report',
    openapiVersion: doc.openapi,
    title,
    apiVersion: typeof doc.info?.version === 'string' ? doc.info.version : '',
    source: { kind: 'inline' },
    document: doc,
    options: { unknownParams: 'ignore', unknownFields: 'ignore', checkAuth: false, include: {} },
    warnings: [],
    operations: 0,
    hash: specHash(doc),
    createdAt: '',
    updatedAt: '',
  };
}

const paramKey = (p: SpecParameter) => `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`;

function parametersOf(doc: SpecDocument, list: unknown, warnings: string[]): SpecParameter[] {
  if (!Array.isArray(list)) return [];
  const out: SpecParameter[] = [];
  for (const raw of list) {
    const p = deref(doc, raw, warnings);
    if (typeof p.name === 'string' && ['path', 'query', 'header', 'cookie'].includes(p.in as string)) out.push(p as SpecParameter);
  }
  return out;
}

/** Compile every path × method of a (normalized) spec into operations, sorted literal-first. */
export function compileSpec(input: SpecRecord | SpecDocument): CompiledSpec {
  const spec = isRecord(input) ? input : recordFor(input);
  const doc = spec.document;
  const warnings: string[] = [];
  const operations: CompiledOperation[] = [];
  const globalSecurity = Array.isArray(doc.security) ? doc.security : [];
  for (const [rawPath, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const item = deref(doc, rawItem, warnings);
    const pathTemplate = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const { regex, paramNames } = templateToRegex(pathTemplate);
    const shared = parametersOf(doc, item.parameters, warnings);
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const merged = new Map<string, SpecParameter>();
      for (const p of [...shared, ...parametersOf(doc, op.parameters, warnings)]) merged.set(paramKey(p), p);
      const responses: Obj = {};
      for (const [code, r] of Object.entries(isObj(op.responses) ? op.responses : {})) {
        const res = deref(doc, r, warnings);
        if (isObj(res.headers)) {
          const headers: Obj = {};
          for (const [h, v] of Object.entries(res.headers)) put(headers, h, deref(doc, v, warnings));
          put(responses, code, { ...res, headers });
        } else put(responses, code, res);
      }
      const key = `${method.toUpperCase()} ${pathTemplate}`;
      operations.push({
        key,
        method: method.toUpperCase(),
        pathTemplate,
        regex,
        paramNames,
        parameters: [...merged.values()],
        requestBody: op.requestBody !== undefined ? deref(doc, op.requestBody, warnings) : null,
        responses,
        security: Array.isArray(op.security) ? (op.security as Record<string, string[]>[]) : globalSecurity,
        deprecated: op.deprecated === true,
        operationId: typeof op.operationId === 'string' ? op.operationId : null,
        summary: typeof op.summary === 'string' ? op.summary : null,
        tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === 'string') : [],
      });
    }
  }
  operations.sort(compareOperations);
  return { spec, operations, byKey: new Map(operations.map((o) => [o.key, o])), warnings };
}

export type OperationMatch = { op: CompiledOperation; params: Record<string, string> } | { methodNotAllowed: string[] };

/**
 * Find the operation for a request. `path` is relative to the spec prefix (a query string is ignored). Returns the
 * operation with its decoded path params, `{methodNotAllowed: [...]}` when the path exists for other methods only,
 * or null.
 */
export function findOperation(compiled: CompiledSpec, method: string, path: string): OperationMatch | null {
  const m = method.toUpperCase();
  const p = path.split('?')[0] || '/';
  const allowed: string[] = [];
  for (const op of compiled.operations) {
    const hit = op.regex.exec(p);
    if (!hit) continue;
    if (op.method !== m) {
      if (!allowed.includes(op.method)) allowed.push(op.method);
      continue;
    }
    const params: Record<string, string> = {};
    op.paramNames.forEach((name, i) => {
      const raw = hit[i + 1];
      let value = raw;
      try {
        value = decodeURIComponent(raw);
      } catch {
        // keep the raw value
      }
      put(params, name, value);
    });
    return { op, params };
  }
  return allowed.length ? { methodNotAllowed: allowed } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// readOnly / writeOnly views

type ViewKind = 'readOnly' | 'writeOnly';
const VIEWS = new WeakMap<object, Record<ViewKind, WeakMap<object, Obj>>>();

/** True when the property schema (or what its `$ref` chain points to) carries the flag. */
function flagged(doc: unknown, prop: unknown, flag: ViewKind): boolean {
  const seen = new Set<unknown>();
  let cur = prop;
  while (isObj(cur) && !seen.has(cur)) {
    if (cur[flag] === true) return true;
    seen.add(cur);
    cur = typeof cur.$ref === 'string' ? resolvePointer(doc, cur.$ref) : undefined;
  }
  return false;
}

/**
 * A copy of `schema` where properties carrying `flag` are dropped from every `required`. Local `$ref`s are inlined
 * (as `allOf` members, so cyclic schemas give a cyclic object graph rather than an endless copy). Memoized per
 * schema object, so repeated calls are cheap.
 */
function view(schema: JsonSchema, doc: unknown, flag: ViewKind): JsonSchema {
  if (!isObj(schema)) return schema;
  const root = isObj(doc) ? doc : schema;
  let byDoc = VIEWS.get(root);
  if (!byDoc) VIEWS.set(root, (byDoc = { readOnly: new WeakMap(), writeOnly: new WeakMap() }));
  const memo = byDoc[flag];

  const walk = (s: unknown): unknown => {
    if (!isObj(s)) return s;
    const hit = memo.get(s);
    if (hit) return hit;
    const out: Obj = {};
    memo.set(s, out);
    const allOf: unknown[] = [];
    for (const [k, v] of Object.entries(s)) {
      if (k === '$ref') {
        const target = typeof v === 'string' ? resolvePointer(root, v) : undefined;
        if (target !== undefined) allOf.push(walk(target));
      } else if (k === 'allOf' && Array.isArray(v)) allOf.push(...v.map(walk));
      else if (SCHEMA_MAPS.has(k) && isObj(v)) {
        const m: Obj = {};
        for (const [name, x] of Object.entries(v)) put(m, name, walk(x));
        put(out, k, m);
      } else if (SCHEMA_LISTS.has(k) && Array.isArray(v)) put(out, k, v.map(walk));
      else if (SCHEMA_ONE.has(k)) put(out, k, walk(v));
      else if (k === 'items') put(out, k, Array.isArray(v) ? v.map(walk) : walk(v));
      else put(out, k, v);
    }
    if (allOf.length) out.allOf = allOf;
    if (Array.isArray(s.required) && isObj(s.properties)) {
      const props = s.properties;
      out.required = s.required.filter((name) => !(typeof name === 'string' && Object.hasOwn(props, name) && flagged(root, props[name], flag)));
    }
    return out;
  };
  return walk(schema) as JsonSchema;
}

/** The schema as a request body sees it: readOnly properties are not required. */
export function requestView(schema: JsonSchema, doc?: unknown): JsonSchema {
  return view(schema, doc, 'readOnly');
}

/** The schema as a response body sees it: writeOnly properties are not required. */
export function responseView(schema: JsonSchema, doc?: unknown): JsonSchema {
  return view(schema, doc, 'writeOnly');
}

// ---------------------------------------------------------------------------------------------------------------
// Hash

/** JSON with sorted keys and no undefined values. */
function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Obj = {};
      for (const k of Object.keys(x).sort()) {
        const val = (x as Obj)[k];
        if (val !== undefined) put(out, k, norm(val));
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** sha256 (hex) of the document's stable JSON: equal documents hash equal regardless of key order. */
export function specHash(doc: unknown): string {
  return createHash('sha256').update(stableJson(doc)).digest('hex');
}

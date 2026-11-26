// OpenAPI contracts (C1): example bodies for generated mocks. Picks a declared example when there is one, otherwise
// builds a value from the schema. Local `$ref`s ("#/...") are resolved against the spec document (`root`).

type Obj = Record<string, unknown>;

export interface ExampleContext {
  /** The spec document local `$ref`s point into. */
  root: unknown;
  /** Path parameter names of the operation; a string property with one of these names becomes "{{params.<name>}}". */
  pathParams?: string[];
}

export interface GenerateOptions extends ExampleContext {
  /** Nesting cap (objects / arrays); deeper values are left out. Default 6. */
  maxDepth?: number;
}

export type ExampleSource = 'example' | 'examples' | 'schema-example' | 'generated';

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Resolve a local JSON pointer ("#/components/schemas/Pet"); undefined for external or broken refs. */
export function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    try {
      part = decodeURIComponent(part);
    } catch {
      /* keep as is */
    }
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (isObj(cur)) cur = cur[part];
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Follow `$ref` chains (at most 20 hops). Returns the input when it is not a ref, undefined when a ref is broken. */
export function deref(root: unknown, v: unknown): unknown {
  let cur = v;
  for (let i = 0; i < 20 && isObj(cur) && typeof cur.$ref === 'string'; i++) cur = resolvePointer(root, cur.$ref);
  return isObj(cur) && typeof cur.$ref === 'string' ? undefined : cur;
}

/** The named examples of a media type object (`examples: {name: {value}}`), refs resolved, without externalValue-only entries. */
export function namedExamples(media: unknown, root: unknown): { name: string; value: unknown }[] {
  const m = deref(root, media);
  if (!isObj(m) || !isObj(m.examples)) return [];
  const out: { name: string; value: unknown }[] = [];
  for (const [name, ex] of Object.entries(m.examples)) {
    const e = deref(root, ex);
    if (isObj(e) && 'value' in e) out.push({ name, value: e.value });
  }
  return out;
}

/**
 * The example body of a media type: the media `example`, else the first `examples[*].value`, else the schema's
 * `example`, else a value generated from the schema. `schema` defaults to `media.schema`.
 */
export function exampleFor(media: unknown, schema: unknown, ctx: ExampleContext): { value: unknown; source: ExampleSource } {
  const m = deref(ctx.root, media);
  if (isObj(m) && m.example !== undefined) return { value: m.example, source: 'example' };
  const named = namedExamples(m, ctx.root);
  if (named.length) return { value: named[0].value, source: 'examples' };
  const s = deref(ctx.root, schema ?? (isObj(m) ? m.schema : undefined));
  if (isObj(s) && s.example !== undefined) return { value: s.example, source: 'schema-example' };
  return { value: generateFromSchema(s, ctx), source: 'generated' };
}

/**
 * Build a value from a JSON Schema: const / default / enum[0] / examples[0] / example first, then formats
 * (uuid → {{uuid}}, date-time → {{now}}, email, uri), then types (arrays get one item, objects all properties).
 * allOf is merged, oneOf / anyOf take the first branch. Cycles and anything deeper than `maxDepth` are left out.
 * Returns null when nothing can be generated.
 */
export function generateFromSchema(schema: unknown, opts: GenerateOptions): unknown {
  const g = new Generator(opts);
  const v = g.gen(schema, 0, null, false);
  return v === undefined ? null : v;
}

class Generator {
  private readonly root: unknown;
  private readonly params: Set<string>;
  private readonly maxDepth: number;
  /** Schemas on the current path (cycle guard). */
  private readonly stack = new Set<object>();

  constructor(opts: GenerateOptions) {
    this.root = opts.root;
    this.params = new Set(opts.pathParams ?? []);
    this.maxDepth = opts.maxDepth ?? 6;
  }

  /**
   * `prop` is the property name this schema belongs to; `inArray` is true below an array, where path-param names are
   * not substituted (a list's items are not the requested resource). undefined = leave the value out.
   */
  gen(schema: unknown, depth: number, prop: string | null, inArray: boolean): unknown {
    if (schema === true || schema === undefined) return undefined;
    const s = deref(this.root, schema);
    if (!isObj(s) || depth > this.maxDepth || this.stack.has(s)) return undefined;
    this.stack.add(s);
    try {
      return this.genObj(s, depth, prop, inArray);
    } finally {
      this.stack.delete(s);
    }
  }

  private genObj(s: Obj, depth: number, prop: string | null, inArray: boolean): unknown {
    if ('const' in s) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    const type = typeOf(s);
    if (prop && !inArray && type === 'string' && this.params.has(prop)) return `{{params.${prop}}}`;
    if (s.default !== undefined) return s.default;
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if (s.example !== undefined) return s.example;

    // Composition: generate the schema's own keywords, then merge allOf branches / the first oneOf / anyOf branch.
    const parts: unknown[] = [];
    const own = this.byType(s, type, depth, prop, inArray);
    if (own !== undefined) parts.push(own);
    if (Array.isArray(s.allOf)) for (const b of s.allOf) parts.push(this.gen(b, depth, prop, inArray));
    const alt = Array.isArray(s.oneOf) && s.oneOf.length ? s.oneOf : Array.isArray(s.anyOf) && s.anyOf.length ? s.anyOf : null;
    if (alt) {
      // First branch that yields something (a branch that is a cycle back to this schema yields nothing).
      for (const b of alt) {
        const v = this.gen(b, depth, prop, inArray);
        if (v !== undefined) {
          parts.push(v);
          break;
        }
      }
    }
    return merge(parts.filter((p) => p !== undefined));
  }

  private byType(s: Obj, type: string | null, depth: number, prop: string | null, inArray: boolean): unknown {
    switch (type) {
      case 'string':
        return stringFor(s);
      case 'integer':
      case 'number':
        return numberFor(s, type === 'integer');
      case 'boolean':
        return true;
      case 'null':
        return null;
      case 'array': {
        if (depth >= this.maxDepth) return [];
        const item = this.gen(s.items, depth + 1, prop, true);
        return item === undefined ? [] : [item];
      }
      case 'object': {
        const out: Obj = {};
        if (depth >= this.maxDepth) return out;
        if (isObj(s.properties)) {
          for (const [k, ps] of Object.entries(s.properties)) {
            const v = this.gen(ps, depth + 1, k, inArray);
            if (v !== undefined) out[k] = v;
          }
        }
        return out;
      }
      default:
        return undefined;
    }
  }
}

/** The schema's type: the first non-null entry of a type array; inferred from properties / items when missing. */
function typeOf(s: Obj): string | null {
  const t = s.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return (t.find((x) => x !== 'null') as string | undefined) ?? (t.length ? 'null' : null);
  if (isObj(s.properties) || isObj(s.additionalProperties)) return 'object';
  if (s.items !== undefined) return 'array';
  return null;
}

function stringFor(s: Obj): string {
  switch (s.format) {
    case 'uuid':
      return '{{uuid}}';
    case 'date-time':
      return '{{now}}';
    case 'date':
      return '2024-01-01';
    case 'email':
    case 'idn-email':
      return 'user@example.test';
    case 'uri':
    case 'url':
    case 'iri':
      return 'https://example.test/x';
  }
  return 'string';
}

function numberFor(s: Obj, integer: boolean): number {
  let v = 0;
  if (typeof s.minimum === 'number') v = s.minimum;
  else if (typeof s.exclusiveMinimum === 'number') v = s.exclusiveMinimum + (integer ? 1 : 0.5);
  else if (typeof s.maximum === 'number' && s.maximum < 0) v = s.maximum;
  else if (typeof s.exclusiveMaximum === 'number' && s.exclusiveMaximum <= 0) v = s.exclusiveMaximum - 1;
  return integer ? Math.ceil(v) : v;
}

/** Merge generated parts: objects are combined (later keys win), otherwise the first part is used. */
function merge(parts: unknown[]): unknown {
  if (!parts.length) return undefined;
  return parts.every(isObj) ? Object.assign({}, ...(parts as Obj[])) : parts[0];
}

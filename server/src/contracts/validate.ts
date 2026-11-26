// OpenAPI contract checks (C1): validate one request against a compiled operation (path, query, header and cookie
// params, auth presence, body) and one response (status, content type, body, required headers). Pure functions: no
// hub, no DB. The runtime (contracts/runtime.ts) turns the issues into a ContractResult with `capIssues`.

import { parseBracketForm } from '../payments/common.js';
import { validateSchema, type JsonSchema } from '../webhooks/schema.js';
import { deref, requestView, resolvePointer, responseView } from './openapi.js';
import {
  CONTRACT_CHECKS,
  MAX_CONTRACT_ISSUES,
  type CompiledOperation,
  type CompiledSpec,
  type ContractCheckId,
  type ContractIssue,
  type ContractSeverity,
  type SpecOptions,
  type SpecParameter,
} from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ContractRequest {
  method: string;
  /** Relative to the spec prefix (query string ignored). */
  path: string;
  /** Decoded path params, as findOperation returned them. */
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  /** Lower-case names. */
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer | undefined;
  contentType: string | undefined;
}

export interface ContractResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer | undefined;
  contentType: string | undefined;
}

/** The SpecOptions the validator reads, plus the oneOf mode (default 'lenient'). */
export type ValidateContractOptions = Partial<Pick<SpecOptions, 'unknownParams' | 'unknownFields' | 'checkAuth'>> & {
  oneOf?: 'strict' | 'lenient';
};

/** Most issues one validation collects (`capIssues` then keeps MAX_CONTRACT_ISSUES). */
const HARD_LIMIT = 500;
/** Schema errors kept per validated value. */
const SCHEMA_ERRORS = 50;
const ACTUAL_MAX = 80;
/** Header params that are never checked as parameters (OpenAPI says they are ignored). */
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
/** Headers whose values never appear in `actual`. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
/** Body / param names whose values never appear in `actual`. */
const SECRET_NAME = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|cvc|cvv/i;

const SEVERITY = new Map<string, ContractSeverity>(CONTRACT_CHECKS.map((c) => [c.id, c.severity]));
const RANK: Record<ContractSeverity, number> = { error: 3, warn: 2, info: 1 };

// ---------------------------------------------------------------------------------------------------------------
// Issues

class Issues {
  readonly list: ContractIssue[] = [];
  constructor(private readonly side: 'request' | 'response') {}
  add(check: ContractCheckId, where: ContractIssue['where'], message: string, extra: Partial<Pick<ContractIssue, 'name' | 'pointer' | 'expected'>> & { actual?: unknown } = {}): void {
    if (this.list.length >= HARD_LIMIT) return;
    const issue: ContractIssue = { check, severity: SEVERITY.get(check) ?? 'error', side: this.side, where, message };
    if (extra.name !== undefined) issue.name = extra.name;
    if (extra.pointer) issue.pointer = extra.pointer;
    const actual = maskActual(extra.actual);
    if (actual !== undefined) issue.actual = actual;
    if (extra.expected !== undefined) issue.expected = clip(extra.expected);
    this.list.push(issue);
  }
}

function clip(s: string): string {
  return s.length > ACTUAL_MAX ? `${s.slice(0, ACTUAL_MAX - 1)}…` : s;
}

/** Card-like digit runs: 13–19 digits, optionally separated by single spaces or dashes. */
const CARD_RE = /\d(?:[ -]?\d){12,18}/g;

/**
 * A value as it may appear in `ContractIssue.actual`: stringified, card-like digit runs masked except the last 4,
 * at most 80 characters. undefined stays undefined.
 */
export function maskActual(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  s = s.replace(CARD_RE, (run) => {
    let keep = 4;
    let out = '';
    for (let i = run.length - 1; i >= 0; i--) {
      const ch = run[i];
      if (ch >= '0' && ch <= '9') out = (keep-- > 0 ? ch : '*') + out;
      else out = ch + out;
    }
    return out;
  });
  return clip(s);
}

/**
 * Cap issues for a ContractResult: errors first (stable otherwise), at most MAX_CONTRACT_ISSUES kept, `truncated`
 * when more were found. Counts are taken over the full list.
 */
export function capIssues(issues: readonly ContractIssue[]): { issues: ContractIssue[]; truncated: boolean } {
  const sorted = issues.map((issue, i) => ({ issue, i })).sort((a, b) => RANK[b.issue.severity] - RANK[a.issue.severity] || a.i - b.i);
  return { issues: sorted.slice(0, MAX_CONTRACT_ISSUES).map((x) => x.issue), truncated: issues.length > MAX_CONTRACT_ISSUES };
}

// ---------------------------------------------------------------------------------------------------------------
// Schema helpers

/** Follow a schema's `$ref` chain (cycle-safe). */
function resolveSchema(doc: unknown, s: unknown): unknown {
  const seen = new Set<string>();
  let cur = s;
  while (isObj(cur) && typeof cur.$ref === 'string' && !seen.has(cur.$ref)) {
    seen.add(cur.$ref);
    const next = resolvePointer(doc, cur.$ref);
    if (next === undefined) return {};
    cur = next;
  }
  return cur;
}

/** The schema and its allOf members (refs followed), flattened. */
function members(doc: unknown, s: unknown, depth = 0, out: Obj[] = []): Obj[] {
  const r = resolveSchema(doc, s);
  if (!isObj(r) || depth > 16 || out.includes(r)) return out;
  out.push(r);
  if (Array.isArray(r.allOf)) for (const m of r.allOf) members(doc, m, depth + 1, out);
  return out;
}

/** Types a value may take: from `type` of the schema, its allOf members and its anyOf/oneOf branches. */
function typesOf(doc: unknown, s: unknown): Set<string> {
  const types = new Set<string>();
  const addType = (m: Obj) => {
    if (typeof m.type === 'string') types.add(m.type);
    else if (Array.isArray(m.type)) for (const t of m.type) if (typeof t === 'string') types.add(t);
  };
  for (const m of members(doc, s)) {
    addType(m);
    for (const k of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(m[k])) for (const b of m[k] as unknown[]) for (const bm of members(doc, b)) addType(bm);
    }
  }
  return types;
}

/** The schema of property `key` (first member declaring it), else an `additionalProperties` schema. */
function propertySchema(doc: unknown, s: unknown, key: string): unknown {
  const ms = members(doc, s);
  for (const m of ms) if (isObj(m.properties) && Object.hasOwn(m.properties, key)) return m.properties[key];
  for (const m of ms) if (isObj(m.additionalProperties)) return m.additionalProperties;
  return undefined;
}

function itemsSchema(doc: unknown, s: unknown): unknown {
  for (const m of members(doc, s)) if (m.items !== undefined && !Array.isArray(m.items)) return m.items;
  return undefined;
}

const INT_RE = /^-?\d+$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A string from a URL, header or form → the type the schema wants (integer, number, boolean, null); else unchanged. */
function coerceScalar(doc: unknown, raw: string, s: unknown): unknown {
  const t = typesOf(doc, s);
  if (!t.size || t.has('string')) return raw;
  if (t.has('integer') && INT_RE.test(raw)) return Number(raw);
  if (t.has('number') && NUM_RE.test(raw)) return Number(raw);
  if (t.has('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (t.has('null') && (raw === '' || raw === 'null')) return null;
  return raw;
}

/** Coerce a parsed form / deepObject value (strings, arrays, objects of strings) along the schema. */
function coerceDeep(doc: unknown, v: unknown, s: unknown, depth = 0): unknown {
  if (s === undefined || depth > 32) return v;
  const t = typesOf(doc, s);
  if (typeof v === 'string') return t.has('array') && !t.has('string') ? [coerceScalar(doc, v, itemsSchema(doc, s))] : coerceScalar(doc, v, s);
  if (Array.isArray(v)) {
    const items = itemsSchema(doc, s);
    return v.map((x) => coerceDeep(doc, x, items, depth + 1));
  }
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = coerceDeep(doc, x, propertySchema(doc, s, k), depth + 1);
    return out;
  }
  return v;
}

function valueAt(v: unknown, pointer: string): unknown {
  let cur = v;
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur && typeof cur === 'object' && Object.hasOwn(cur, key)) cur = (cur as Obj)[key];
    else return undefined;
  }
  return cur;
}

/** True when a pointer passes through a property whose value must stay out of `actual`. */
function secretPointer(pointer: string): boolean {
  return pointer.split('/').some((p) => SECRET_NAME.test(p));
}

interface SchemaRun {
  doc: unknown;
  oneOf: 'strict' | 'lenient';
}

/** validateSchema with the spec as root; a schema the validator cannot use (bad $ref, bad regex) gives one message. */
function schemaErrors(run: SchemaRun, schema: JsonSchema, value: unknown): { path: string; message: string }[] | string {
  try {
    return validateSchema(schema, value, SCHEMA_ERRORS, { root: run.doc, oneOf: run.oneOf });
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).slice(0, 200);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Media types

/** "Application/JSON; charset=utf-8" → "application/json". */
function essence(ct: string | undefined): string {
  return (ct ?? '').split(';')[0].trim().toLowerCase();
}

const isJsonType = (t: string) => t === 'application/json' || t.endsWith('+json') || t.endsWith('/json');

/** Does a declared media range accept the actual content type? Wildcards and +json count. */
export function mediaTypeMatches(declared: string, actual: string): boolean {
  const d = essence(declared);
  const a = essence(actual);
  if (!a) return false;
  if (d === a || d === '*/*' || d === '*') return true;
  const [dt, ds] = d.split('/');
  const [at] = a.split('/');
  if (ds === '*' && dt === at) return true;
  return isJsonType(d) && isJsonType(a);
}

/** The declared media entry for a content type: exact first, then +json / wildcard ranges. */
function pickMedia(content: Obj, contentType: string): [string, Obj] | null {
  const a = essence(contentType);
  const keys = Object.keys(content);
  const exact = keys.find((k) => essence(k) === a);
  const key = exact ?? keys.find((k) => isJsonType(essence(k)) && isJsonType(a)) ?? keys.find((k) => mediaTypeMatches(k, a));
  if (key === undefined || !a) return null;
  return [key, isObj(content[key]) ? (content[key] as Obj) : {}];
}

function bodyText(body: string | Buffer | undefined): string {
  if (body === undefined) return '';
  return typeof body === 'string' ? body : body.toString('utf8');
}

function formObject(text: string): Obj {
  const flat: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const prev = flat[k];
    flat[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return parseBracketForm(flat) as Obj;
}

// ---------------------------------------------------------------------------------------------------------------
// Unknown / readOnly / deprecated fields

interface WalkOptions {
  unknown: boolean;
  /** 'readOnly' for requests (a readOnly field sent is a warn); null for responses. */
  readOnly: boolean;
}

/**
 * Walk a body along its schema: properties and allOf (refs followed). A subtree under anyOf / oneOf is skipped (we
 * cannot tell which branch applies without risking false positives), and so is an object that is open
 * (additionalProperties true / a schema, patternProperties, no declared properties) or closed with
 * additionalProperties: false (the schema check already reports those keys).
 */
function walkFields(doc: unknown, schema: unknown, value: unknown, pointer: string, issues: Issues, o: WalkOptions, depth = 0): void {
  if (depth > 32 || issues.list.length >= HARD_LIMIT) return;
  const ms = members(doc, schema);
  if (!ms.length || ms.some((m) => Array.isArray(m.anyOf) || Array.isArray(m.oneOf) || m.not !== undefined || m.if !== undefined)) return;
  if (Array.isArray(value)) {
    const items = itemsSchema(doc, schema);
    if (items !== undefined) value.slice(0, 1000).forEach((x, i) => walkFields(doc, items, x, `${pointer}/${i}`, issues, o, depth + 1));
    return;
  }
  if (!isObj(value)) return;
  const declared = new Map<string, unknown[]>();
  for (const m of ms) {
    if (!isObj(m.properties)) continue;
    for (const [k, ps] of Object.entries(m.properties)) {
      const list = declared.get(k) ?? [];
      list.push(ps);
      declared.set(k, list);
    }
  }
  const open = !declared.size || ms.some((m) => (m.additionalProperties !== undefined && m.additionalProperties !== false) || m.patternProperties !== undefined);
  const closed = ms.some((m) => m.additionalProperties === false);
  for (const [k, v] of Object.entries(value)) {
    const ptr = `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const props = declared.get(k);
    if (!props) {
      if (o.unknown && !open && !closed) issues.add('contract.unknown-field', 'body', `Field "${ptr.slice(1)}" is not declared in the schema`, { pointer: ptr, name: k });
      continue;
    }
    const resolved = props.map((p) => resolveSchema(doc, p));
    if (o.readOnly && resolved.some((p) => isObj(p) && p.readOnly === true)) issues.add('contract.read-only', 'body', `Field "${ptr.slice(1)}" is readOnly and should not be sent`, { pointer: ptr, name: k });
    if (resolved.some((p) => isObj(p) && p.deprecated === true)) issues.add('contract.deprecated', 'body', `Field "${ptr.slice(1)}" is deprecated`, { pointer: ptr, name: k });
    for (const p of props) walkFields(doc, p, v, ptr, issues, o, depth + 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Body (shared by request and response)

interface BodyCheck {
  check: 'contract.body' | 'contract.response-body';
  view: (schema: JsonSchema, doc?: unknown) => JsonSchema;
  walk: WalkOptions;
}

function checkBody(run: SchemaRun, content: Obj, text: string, contentType: string | undefined, issues: Issues, c: BodyCheck): void {
  const declared = Object.keys(content);
  if (!declared.length) return;
  const picked = contentType ? pickMedia(content, contentType) : null;
  if (!picked) {
    issues.add('contract.content-type', 'content-type', contentType ? `Content type ${essence(contentType)} is not declared` : 'Content-Type is missing', {
      actual: contentType ? essence(contentType) : undefined,
      expected: declared.join(', '),
    });
    return;
  }
  const media = essence(contentType);
  const schema = picked[1].schema;
  let value: unknown;
  if (isJsonType(media)) {
    try {
      value = JSON.parse(text);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120);
      issues.add(c.check, 'body', `Body is not valid JSON: ${msg}`);
      return;
    }
  } else if (media === 'application/x-www-form-urlencoded') {
    value = coerceDeep(run.doc, formObject(text), schema);
  } else if (media.startsWith('multipart/')) {
    // Required part names only.
    const names = new Set([...text.matchAll(/content-disposition:[^\r\n]*?\bname="([^"]*)"/gi)].map((m) => m[1]));
    for (const m of members(run.doc, c.view(schema as JsonSchema, run.doc))) {
      if (Array.isArray(m.required)) for (const r of m.required) if (typeof r === 'string' && !names.has(r)) issues.add(c.check, 'body', `Missing required part "${r}"`, { pointer: `/${r}`, name: r });
    }
    return;
  } else return; // binary / other: content type only
  if (schema === undefined) return;
  const errors = schemaErrors(run, c.view(schema as JsonSchema, run.doc), value);
  if (typeof errors === 'string') {
    issues.add('contract.unchecked', 'body', `Body schema could not be checked: ${errors}`);
    return;
  }
  for (const e of errors) {
    const actual = secretPointer(e.path) ? undefined : valueAt(value, e.path);
    issues.add(c.check, 'body', `${e.path || 'Body'} ${e.message}`, { pointer: e.path || undefined, actual });
  }
  walkFields(run.doc, schema, value, '', issues, c.walk);
}

// ---------------------------------------------------------------------------------------------------------------
// Parameters

function headerValue(headers: ContractRequest['headers'], name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep raw
    }
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

const DELIMS: Record<string, string> = { form: ',', simple: ',', spaceDelimited: ' ', pipeDelimited: '|' };

/** "a,1,b,2" → {a: "1", b: "2"}; "a=1,b=2" (explode) → the same. */
function splitObject(raw: string, explode: boolean): Obj {
  const out: Obj = {};
  const parts = raw.split(',');
  if (explode) {
    for (const p of parts) {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
    }
  } else for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

/** The raw (string-shaped) value of a parameter, and the query keys it consumed. undefined = not sent. */
function rawParam(doc: unknown, p: SpecParameter, schema: unknown, req: ContractRequest, cookies: Map<string, string>, consumed: Set<string>): unknown {
  const t = typesOf(doc, schema);
  const kind = t.has('array') ? 'array' : t.has('object') && !t.has('string') ? 'object' : 'scalar';
  const style = typeof p.style === 'string' ? p.style : p.in === 'query' || p.in === 'cookie' ? 'form' : 'simple';
  const explode = typeof p.explode === 'boolean' ? p.explode : style === 'form';

  if (p.in === 'query') {
    const values: string[] = [];
    for (const key of [p.name, `${p.name}[]`]) {
      const v = req.query[key];
      if (v === undefined) continue;
      consumed.add(key);
      values.push(...(Array.isArray(v) ? v : [v]));
    }
    // Bracket keys (name[x]=…) mean deepObject, whatever the declared style.
    const bracketKeys = Object.keys(req.query).filter((k) => k.startsWith(`${p.name}[`) && k !== `${p.name}[]`);
    if (kind === 'object' && (style === 'deepObject' || bracketKeys.length)) {
      if (!bracketKeys.length) return values.length ? values[0] : undefined;
      const flat: Record<string, string | string[]> = {};
      for (const k of bracketKeys) {
        consumed.add(k);
        flat[k] = req.query[k];
      }
      return (parseBracketForm(flat) as Obj)[p.name];
    }
    if (kind === 'object' && style === 'form' && explode && !values.length) {
      // Each property is its own query key.
      const out: Obj = {};
      for (const m of members(doc, schema)) {
        if (!isObj(m.properties)) continue;
        for (const k of Object.keys(m.properties)) {
          const v = req.query[k];
          if (v === undefined) continue;
          consumed.add(k);
          out[k] = Array.isArray(v) ? v[0] : v;
        }
      }
      return Object.keys(out).length ? out : undefined;
    }
    if (!values.length) return undefined;
    if (kind === 'array') return explode && style === 'form' ? values : values.flatMap((v) => v.split(DELIMS[style] ?? ','));
    if (kind === 'object') return splitObject(values[0], explode);
    return values[0];
  }

  let raw: string | undefined;
  if (p.in === 'path') raw = req.params[p.name];
  else if (p.in === 'header') raw = headerValue(req.headers, p.name);
  else raw = cookies.get(p.name);
  if (raw === undefined) return undefined;
  if (kind === 'array') return raw === '' ? [] : raw.split(',').map((s) => (p.in === 'header' ? s.trim() : s));
  if (kind === 'object') return splitObject(raw, explode);
  return raw;
}

const WHERE_LABEL: Record<SpecParameter['in'], string> = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie' };

function checkParams(run: SchemaRun, op: CompiledOperation, req: ContractRequest, secret: Set<string>, opts: ValidateContractOptions, issues: Issues): void {
  const cookies = parseCookies(headerValue(req.headers, 'cookie'));
  const consumed = new Set<string>();
  for (const p of op.parameters) {
    if (p.in === 'header' && IGNORED_HEADERS.has(p.name.toLowerCase())) continue;
    const label = `${WHERE_LABEL[p.in]} parameter "${p.name}"`;
    const hide = p.in === 'cookie' || secret.has(`${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`) || (p.in === 'header' && SECRET_HEADERS.has(p.name.toLowerCase()));
    // `content` params: the first media type's schema, the value parsed as JSON.
    let schema: unknown = p.schema;
    let jsonContent = false;
    if (schema === undefined && isObj(p.content)) {
      const first = Object.values(p.content)[0];
      if (isObj(first)) schema = first.schema;
      jsonContent = true;
    }
    const raw = jsonContent ? rawParam(run.doc, { ...p, style: 'form', explode: false }, { type: 'string' }, req, cookies, consumed) : rawParam(run.doc, p, schema, req, cookies, consumed);
    if (raw === undefined) {
      if (p.required === true || p.in === 'path') issues.add('contract.param', p.in, `${label} is required`, { name: p.name });
      continue;
    }
    if (p.deprecated === true) issues.add('contract.deprecated', p.in, `${label} is deprecated`, { name: p.name });
    let value: unknown;
    if (jsonContent) {
      try {
        value = JSON.parse(String(raw));
      } catch {
        issues.add('contract.param', p.in, `${label} is not valid JSON`, { name: p.name, actual: hide ? undefined : raw });
        continue;
      }
    } else value = coerceDeep(run.doc, raw, schema);
    if (schema === undefined) continue;
    const errors = schemaErrors(run, schema as JsonSchema, value);
    if (typeof errors === 'string') {
      issues.add('contract.unchecked', p.in, `${label} could not be checked: ${errors}`, { name: p.name });
      continue;
    }
    for (const e of errors) {
      const actual = hide ? undefined : e.path ? valueAt(value, e.path) : raw;
      issues.add('contract.param', p.in, `${label}${e.path ? ` ${e.path}` : ''} ${e.message}`, { name: p.name, pointer: e.path || undefined, actual });
    }
  }
  if (opts.unknownParams === 'warn') {
    for (const key of Object.keys(req.query)) {
      if (consumed.has(key) || secret.has(`query:${key}`)) continue;
      issues.add('contract.unknown-param', 'query', `Query parameter "${key}" is not declared`, { name: key });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Auth (presence only)

interface SchemeCheck {
  label: string;
  present: boolean;
}

function securitySchemes(doc: unknown): Obj {
  const c = isObj(doc) && isObj((doc as Obj).components) ? ((doc as Obj).components as Obj) : {};
  return isObj(c.securitySchemes) ? c.securitySchemes : {};
}

/** `in:name` keys of apiKey credentials (header names lower-case): their values never appear in `actual`. */
function secretParams(doc: unknown): Set<string> {
  const out = new Set<string>();
  for (const raw of Object.values(securitySchemes(doc))) {
    const s = deref(doc, raw);
    if (s.type === 'apiKey' && typeof s.name === 'string' && typeof s.in === 'string') out.add(`${s.in}:${s.in === 'header' ? s.name.toLowerCase() : s.name}`);
  }
  return out;
}

function schemeCheck(doc: unknown, name: string, req: ContractRequest, cookies: Map<string, string>): SchemeCheck {
  const s = deref(doc, securitySchemes(doc)[name]);
  const auth = headerValue(req.headers, 'authorization') ?? '';
  const hasScheme = (scheme: string) => auth.toLowerCase().startsWith(`${scheme.toLowerCase()} `) && auth.slice(scheme.length + 1).trim() !== '';
  if (s.type === 'http') {
    const scheme = typeof s.scheme === 'string' ? s.scheme : 'bearer';
    return { label: `${scheme} Authorization header`, present: hasScheme(scheme) };
  }
  if (s.type === 'apiKey' && typeof s.name === 'string') {
    const present =
      s.in === 'header' ? !!headerValue(req.headers, s.name) : s.in === 'query' ? req.query[s.name] !== undefined : s.in === 'cookie' ? cookies.has(s.name) : true;
    return { label: `API key ${s.in} "${s.name}"`, present };
  }
  if (s.type === 'oauth2' || s.type === 'openIdConnect') return { label: 'bearer Authorization header', present: hasScheme('bearer') };
  // mutualTLS or an unknown / unresolved scheme: not checkable here.
  return { label: name, present: true };
}

function checkAuth(doc: unknown, op: CompiledOperation, req: ContractRequest, issues: Issues): void {
  if (!op.security.length) return;
  const cookies = parseCookies(headerValue(req.headers, 'cookie'));
  const alternatives: string[] = [];
  for (const requirement of op.security) {
    const names = Object.keys(requirement ?? {});
    if (!names.length) return; // `{}`: anonymous access allowed
    const checks = names.map((n) => schemeCheck(doc, n, req, cookies));
    if (checks.every((c) => c.present)) return;
    alternatives.push(checks.map((c) => c.label).join(' + '));
  }
  issues.add('contract.auth-missing', 'auth', `Credentials missing: expected ${alternatives.join(' or ')}`, { expected: alternatives.join(' or ') });
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points

/** Check a request against its operation. Issues are in discovery order; pass them through `capIssues` before storing. */
export function validateRequest(spec: CompiledSpec, op: CompiledOperation, req: ContractRequest, opts: ValidateContractOptions): ContractIssue[] {
  const doc = spec.spec.document;
  const run: SchemaRun = { doc, oneOf: opts.oneOf ?? 'lenient' };
  const issues = new Issues('request');
  if (op.deprecated) issues.add('contract.deprecated', 'operation', `${op.key} is deprecated`);
  checkParams(run, op, req, secretParams(doc), opts, issues);
  if (opts.checkAuth) checkAuth(doc, op, req, issues);

  const rb = op.requestBody;
  const text = bodyText(req.body);
  if (rb) {
    if (!text.length) {
      if (rb.required === true) issues.add('contract.body-missing', 'body', 'A request body is required');
    } else if (isObj(rb.content)) {
      checkBody(run, rb.content, text, req.contentType, issues, {
        check: 'contract.body',
        view: requestView,
        walk: { unknown: opts.unknownFields === 'warn', readOnly: true },
      });
    }
  }
  return issues.list;
}

/** The declared response for a status: exact code, then the NXX range, then `default`. */
function responseFor(op: CompiledOperation, status: number): Obj | null {
  const code = String(status);
  const keys = Object.keys(op.responses);
  const key = keys.find((k) => k === code) ?? keys.find((k) => k.toUpperCase() === `${code[0]}XX`) ?? keys.find((k) => k === 'default');
  return key === undefined ? null : isObj(op.responses[key]) ? (op.responses[key] as Obj) : {};
}

/** Check a response (the app's answer to a stubyard call) against its operation. */
export function validateResponse(spec: CompiledSpec, op: CompiledOperation, res: ContractResponse, opts: ValidateContractOptions): ContractIssue[] {
  const doc = spec.spec.document;
  const run: SchemaRun = { doc, oneOf: opts.oneOf ?? 'lenient' };
  const issues = new Issues('response');
  const declared = responseFor(op, res.status);
  if (!declared) {
    issues.add('contract.response-status', 'status', `Status ${res.status} is not declared for ${op.key}`, {
      actual: String(res.status),
      expected: Object.keys(op.responses).join(', '),
    });
    return issues.list;
  }

  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
  if (isObj(declared.headers)) {
    for (const [name, raw] of Object.entries(declared.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'content-type') continue;
      const h = deref(doc, raw);
      const value = headerValue(headers, lower);
      if (value === undefined) {
        if (h.required === true) issues.add('contract.response-header', 'header', `Response header "${name}" is required`, { name });
        continue;
      }
      if (h.schema === undefined) continue;
      const errors = schemaErrors(run, h.schema as JsonSchema, coerceScalar(doc, value, h.schema));
      if (typeof errors === 'string') continue;
      const hide = SECRET_HEADERS.has(lower);
      for (const e of errors) issues.add('contract.response-header', 'header', `Response header "${name}" ${e.message}`, { name, actual: hide ? undefined : value });
    }
  }

  const text = bodyText(res.body);
  if (isObj(declared.content) && Object.keys(declared.content).length) {
    if (!text.length) {
      const picked = res.contentType ? pickMedia(declared.content, res.contentType) : null;
      const anySchema = Object.values(declared.content).some((m) => isObj(m) && m.schema !== undefined);
      if ((picked ? picked[1].schema !== undefined : anySchema) && res.status !== 204 && res.status !== 304) {
        issues.add('contract.response-body', 'body', 'The response body is empty');
      }
    } else {
      checkBody(run, declared.content, text, res.contentType, issues, {
        check: 'contract.response-body',
        view: responseView,
        walk: { unknown: opts.unknownFields === 'warn', readOnly: false },
      });
    }
  }
  return issues.list;
}

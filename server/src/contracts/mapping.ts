// OpenAPI contracts (C1): a compiled spec → stubyard API mocks (one per operation), and the re-import diff.

import { STATUS_CODES } from 'node:http';
import { globMatch } from '../llmmocks/match.js';
import { normalizePath } from '../mocks/match.js';
import { mockContentHash, type MockInput, type MockScenario } from '../repos/mocks.js';

export { mockContentHash };
import { HttpError } from '../util.js';
import { deref, exampleFor, namedExamples } from './examples.js';
import type { CompiledOperation, CompiledSpec } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A generated mock: a full MockInput plus the spec link stored on api_mocks. */
export interface SpecMock extends MockInput {
  name: string;
  description: string;
  method: string;
  path: string;
  scenarios: MockScenario[];
  activeScenario: string;
  /** The operation key, "GET /users/{id}". */
  specOperation: string;
  /** mockContentHash of the generated mock (edit detection on re-import). */
  specHash: string;
}

export interface SpecInclude {
  tags?: string[];
  /** Globs on the OpenAPI path template ("/users/*"). */
  paths?: string[];
  /** operationIds or operation keys ("GET /users/{id}"). */
  operations?: string[];
}

export interface SpecToMocksOptions {
  specName: string;
  /** Below /mock/<project>/api, e.g. "/v1" or "". */
  prefix: string;
  include?: SpecInclude;
  /** Most mocks one import may create (default 300). */
  cap?: number;
}

export const DEFAULT_MOCK_CAP = 300;
/** Named examples turned into extra scenarios, per response code. */
export const MAX_NAMED_EXAMPLES = 5;
const MOCK_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_NAME = 120;

// ---------------------------------------------------------------------------------------------------------------
// Paths, names, ordering

/** "/users/{id}" → prefix + "/users/:id"; a segment mixing text and params ("{name}.{ext}") becomes "*.*". */
export function toMockPath(prefix: string, template: string): string {
  const segs = template
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const whole = /^\{([^{}]+)\}$/.exec(seg);
      if (whole) return ':' + whole[1];
      return seg.replace(/\{[^{}]*\}/g, '*');
    });
  const p = normalizePath(prefix || '');
  return normalizePath((p === '/' ? '' : p) + '/' + segs.join('/'));
}

/** The mock name for an operation: the operationId, or "METHOD path"; "<spec> · <name>" when `isTaken` says it is used. */
export function nameFor(op: Pick<CompiledOperation, 'operationId' | 'method' | 'pathTemplate'>, specName: string, isTaken?: (name: string) => boolean): string {
  const base = (op.operationId?.trim() || `${op.method.toUpperCase()} ${op.pathTemplate}`).slice(0, MAX_NAME);
  if (!isTaken || !isTaken(base)) return base;
  return `${specName} · ${base}`.slice(0, MAX_NAME);
}

/** 0 = literal segment, 1 = text mixed with params, 2 = a whole-segment param. */
function segRank(seg: string): number {
  if (/^\{[^{}]+\}$/.test(seg)) return 2;
  return seg.includes('{') ? 1 : 0;
}

/**
 * Literal-first, segment by segment: literal < mixed < param, equal kinds by text; a path before its own extensions
 * (/users before /users/me). A total order, so /users/me is always checked before /users/{id}.
 */
export function compareTemplates(a: string, b: string): number {
  const sa = a.split('/').filter(Boolean);
  const sb = b.split('/').filter(Boolean);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const d = segRank(sa[i]) - segRank(sb[i]);
    if (d) return d;
    if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
  }
  return sa.length - sb.length;
}

function included(op: CompiledOperation, inc: SpecInclude | undefined): boolean {
  if (!inc) return true;
  if (inc.tags?.length) {
    const want = new Set(inc.tags.map((t) => t.toLowerCase()));
    if (!op.tags.some((t) => want.has(t.toLowerCase()))) return false;
  }
  if (inc.paths?.length && !inc.paths.some((g) => globMatch(g, op.pathTemplate))) return false;
  if (inc.operations?.length) {
    const want = new Set(inc.operations.map((o) => o.trim().toLowerCase()));
    if (!want.has(op.key.toLowerCase()) && !(op.operationId && want.has(op.operationId.toLowerCase()))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios

interface ResponseEntry {
  key: string;
  status: number;
  /** 0 = exact code, 1 = range (2XX), 2 = default. */
  kind: number;
  response: Obj;
}

function responseEntries(op: CompiledOperation, root: unknown, warnings: string[]): ResponseEntry[] {
  const out: ResponseEntry[] = [];
  for (const [key, raw] of Object.entries(op.responses ?? {})) {
    const response = deref(root, raw);
    if (!isObj(response)) {
      warnings.push(`${op.key}: response ${key} could not be resolved`);
      continue;
    }
    const k = key.trim().toUpperCase();
    if (/^[1-5]\d\d$/.test(k)) out.push({ key, status: Number(k), kind: 0, response });
    else if (/^[1-5]XX$/.test(k)) out.push({ key: k, status: Number(k[0]) * 100, kind: 1, response });
    else if (k === 'DEFAULT') out.push({ key: 'default', status: 500, kind: 2, response });
    else warnings.push(`${op.key}: response code "${key}" ignored`);
  }
  // By status; an exact code before its range; default last.
  return out.sort((a, b) => Number(a.kind === 2) - Number(b.kind === 2) || a.status - b.status || a.kind - b.kind);
}

function scenarioLabel(e: ResponseEntry): string {
  if (e.kind === 2) return 'default (500)';
  if (e.kind === 1) return `${e.key} (${e.status})`;
  const text = STATUS_CODES[e.status] ?? (typeof e.response.description === 'string' ? e.response.description.trim().slice(0, 40) : '');
  return text ? `${e.status} ${text}` : String(e.status);
}

/** The media type a scenario answers with: application/json, then any +json, then the first one. */
function pickMedia(content: unknown): [string, unknown] | null {
  if (!isObj(content)) return null;
  const keys = Object.keys(content);
  if (!keys.length) return null;
  const key =
    keys.find((k) => k.split(';')[0].trim().toLowerCase() === 'application/json') ??
    keys.find((k) => /\+json\b/i.test(k.split(';')[0])) ??
    keys[0];
  return [key, content[key]];
}

const isJsonMedia = (type: string) => /^application\/(?:[\w.+-]*\+)?json\b/i.test(type) || type.includes('*');

function serialize(value: unknown, mediaType: string): string {
  if (value === undefined) return '';
  if (typeof value === 'string' && !isJsonMedia(mediaType)) return value;
  return JSON.stringify(value, null, 2);
}

/** Response headers that declare an example (header `example`, first `examples[*].value`, or schema `example`). */
function exampleHeaders(response: Obj, root: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(response.headers)) return out;
  for (const [name, raw] of Object.entries(response.headers)) {
    if (name.toLowerCase() === 'content-type' || !name.trim()) continue;
    const h = deref(root, raw);
    if (!isObj(h)) continue;
    let v: unknown = h.example;
    if (v === undefined) v = namedExamples(h, root)[0]?.value;
    if (v === undefined) {
      const s = deref(root, h.schema);
      if (isObj(s)) v = s.example;
    }
    if (v !== undefined && v !== null) out[name.trim()] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

function scenario(name: string, status: number, headers: Record<string, string>, body: string): MockScenario {
  return { name, status, headers, body, delayMs: 0, behaviour: 'respond' };
}

function scenariosFor(op: CompiledOperation, root: unknown, warnings: string[]): { scenarios: MockScenario[]; active: string } {
  const scenarios: MockScenario[] = [];
  const names = new Set<string>();
  const add = (s: MockScenario) => {
    const k = s.name.toLowerCase();
    if (names.has(k)) return;
    names.add(k);
    scenarios.push(s);
  };
  let active: { name: string; status: number } | null = null;
  const ctx = { root, pathParams: op.paramNames };
  for (const e of responseEntries(op, root, warnings)) {
    const label = scenarioLabel(e);
    const headers = exampleHeaders(e.response, root);
    const media = pickMedia(e.response.content);
    let body = '';
    if (media) {
      const [type, m] = media;
      if (!type.includes('*')) headers['content-type'] = type;
      body = serialize(exampleFor(m, undefined, ctx).value, type);
    }
    add(scenario(label, e.status, headers, body));
    if (e.status >= 200 && e.status < 300 && (!active || e.status < active.status)) active = { name: label, status: e.status };
    if (media) {
      for (const ex of namedExamples(media[1], root).slice(0, MAX_NAMED_EXAMPLES)) {
        add(scenario(`${e.key} · ${ex.name.slice(0, 60)}`, e.status, { ...headers }, serialize(ex.value, media[0])));
      }
    }
  }
  if (!scenarios.length) {
    warnings.push(`${op.key}: no usable responses; the mock answers 200 with an empty body`);
    add(scenario('200 OK', 200, {}, ''));
  }
  return { scenarios, active: active?.name ?? scenarios[0].name };
}

// ---------------------------------------------------------------------------------------------------------------
// specToMocks

/**
 * One mock per operation, ordered literal-first. Throws 400 when more than `cap` operations pass the filters.
 * Names are the plain `nameFor` names; the service applies the "<spec> · <name>" rule against existing mocks.
 */
export function specToMocks(compiled: CompiledSpec, opts: SpecToMocksOptions): { mocks: SpecMock[]; warnings: string[] } {
  const warnings: string[] = [];
  const root = compiled.spec.document;
  const cap = opts.cap ?? DEFAULT_MOCK_CAP;
  const ops = compiled.operations.filter((op) => included(op, opts.include));
  if (ops.length > cap) throw new HttpError(400, `spec has ${ops.length} operations; pass include.tags/paths`);
  const sorted = ops
    .map((op, i) => ({ op, i }))
    .sort((a, b) => compareTemplates(a.op.pathTemplate, b.op.pathTemplate) || a.i - b.i)
    .map((x) => x.op);
  const mocks: SpecMock[] = [];
  const used = new Set<string>();
  for (const op of sorted) {
    const method = op.method.toUpperCase();
    if (!MOCK_METHODS.has(method)) {
      warnings.push(`${op.key}: method ${method} cannot be mocked; skipped`);
      continue;
    }
    let name = nameFor(op, opts.specName);
    // Duplicate operationIds within one spec: keep the names unique.
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${nameFor(op, opts.specName).slice(0, MAX_NAME - 6)} (${n})`;
    used.add(name.toLowerCase());
    const { scenarios, active } = scenariosFor(op, root, warnings);
    const summary = op.summary?.trim();
    const description = `${summary ? `${summary} · ` : ''}from spec ${opts.specName}${op.deprecated ? ' (deprecated)' : ''}`;
    const m = { name, description, method, path: toMockPath(opts.prefix, op.pathTemplate), scenarios, activeScenario: active, specOperation: op.key };
    mocks.push({ ...m, specHash: mockContentHash(m) });
  }
  return { mocks, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Edit detection and re-import

export interface ExistingSpecMock {
  id: string;
  specOperation: string | null;
  /** Hash stored at the last import (null = unknown, treated as edited). */
  specHash: string | null;
  /** mockContentHash of the mock as it is now. */
  currentHash: string;
  enabled: boolean;
  activeScenario: string;
  description?: string;
}

export interface ReimportOptions {
  overwriteEdited?: boolean;
  removeMissing?: 'disable' | 'delete' | 'keep';
}

export const REMOVED_SUFFIX = '(removed from spec)';

export interface ReimportPlan {
  create: SpecMock[];
  /** Replace method, path, scenarios and description; `mock.activeScenario` keeps the current one when it still exists. */
  update: { id: string; specOperation: string; mock: SpecMock; overwritten: boolean }[];
  /** Changed in the spec but edited in stubyard, so left alone. */
  kept: { id: string; specOperation: string; reason: 'edited' }[];
  /** The operation is gone; `patch` is set for 'disable'. */
  removed: { id: string; specOperation: string; action: 'disable' | 'delete' | 'keep'; patch?: { enabled: false; description: string } }[];
  /** Same operation, same generated content: nothing to do. */
  unchanged: { id: string; specOperation: string }[];
}

/** The re-import diff by `specOperation` (§2.6). Enabled state, hits and position are never part of an update. */
export function planReimport(existing: ExistingSpecMock[], generated: SpecMock[], opts: ReimportOptions = {}): ReimportPlan {
  const removeMissing = opts.removeMissing ?? 'disable';
  const plan: ReimportPlan = { create: [], update: [], kept: [], removed: [], unchanged: [] };
  const byOp = new Map<string, ExistingSpecMock>();
  for (const e of existing) if (e.specOperation && !byOp.has(e.specOperation)) byOp.set(e.specOperation, e);
  const seen = new Set<string>();
  for (const g of generated) {
    seen.add(g.specOperation);
    const cur = byOp.get(g.specOperation);
    if (!cur) {
      plan.create.push(g);
      continue;
    }
    if (cur.specHash === g.specHash) {
      plan.unchanged.push({ id: cur.id, specOperation: g.specOperation });
      continue;
    }
    const edited = cur.specHash === null || cur.currentHash !== cur.specHash;
    if (edited && !opts.overwriteEdited) {
      plan.kept.push({ id: cur.id, specOperation: g.specOperation, reason: 'edited' });
      continue;
    }
    const keepActive = g.scenarios.find((s) => s.name.toLowerCase() === String(cur.activeScenario ?? '').toLowerCase());
    plan.update.push({ id: cur.id, specOperation: g.specOperation, mock: { ...g, activeScenario: keepActive?.name ?? g.activeScenario }, overwritten: edited });
  }
  for (const [op, cur] of byOp) {
    if (seen.has(op)) continue;
    const entry: ReimportPlan['removed'][number] = { id: cur.id, specOperation: op, action: removeMissing };
    if (removeMissing === 'disable') {
      const d = (cur.description ?? '').trim();
      entry.patch = { enabled: false, description: d.endsWith(REMOVED_SUFFIX) ? d : `${d ? d + ' ' : ''}${REMOVED_SUFFIX}` };
    }
    plan.removed.push(entry);
  }
  return plan;
}

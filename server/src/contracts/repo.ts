import type { DB } from '../db/index.js';
import { HttpError, SLUG_RE, newId, nowIso, parseJson } from '../util.js';
import type { SpecDocument, SpecMode, SpecOptions, SpecRecord, SpecRole, SpecSource } from './types.js';

export const SPEC_ROLES: readonly SpecRole[] = ['mock', 'app'];
export const SPEC_MODES: readonly SpecMode[] = ['off', 'report', 'strict'];

/** An api_specs row without the (large) document, for lists. */
export type SpecSummary = Omit<SpecRecord, 'document'>;

export interface SpecInput {
  name: string;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  openapiVersion: string;
  title?: string;
  apiVersion?: string;
  source?: SpecSource;
  document: SpecDocument;
  options?: Partial<SpecOptions>;
  warnings?: string[];
  operations?: number;
  hash: string;
}

export interface SpecPatch {
  name?: string;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  openapiVersion?: string;
  title?: string;
  apiVersion?: string;
  source?: SpecSource;
  document?: SpecDocument;
  options?: Partial<SpecOptions>;
  warnings?: string[];
  operations?: number;
  hash?: string;
}

interface Row {
  id: string;
  project_id: string;
  name: string;
  role: string;
  prefix: string;
  mode: string;
  openapi_version: string;
  title: string;
  api_version: string;
  source: string;
  document?: string;
  options: string;
  warnings: string;
  operations: number;
  hash: string;
  created_at: string;
  updated_at: string;
}

const SUMMARY_COLS = 'id, project_id, name, role, prefix, mode, openapi_version, title, api_version, source, options, warnings, operations, hash, created_at, updated_at';

function toSummary(r: Row): SpecSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    role: r.role as SpecRole,
    prefix: r.prefix,
    mode: r.mode as SpecMode,
    openapiVersion: r.openapi_version,
    title: r.title,
    apiVersion: r.api_version,
    source: parseJson<SpecSource>(r.source, { kind: 'inline' }),
    options: normalizeSpecOptions(parseJson<Partial<SpecOptions>>(r.options, {}), null, r.mode as SpecMode),
    warnings: parseJson<string[]>(r.warnings, []),
    operations: r.operations,
    hash: r.hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSpec(r: Row): SpecRecord {
  return { ...toSummary(r), document: parseJson<SpecDocument>(r.document, { openapi: r.openapi_version }) };
}

/** Spec names are slugs ("crm", "payments-v2"); templates and MCP tools refer to specs by name. */
function parseName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new HttpError(400, 'Spec name is required (e.g. "crm")');
  if (!SLUG_RE.test(name)) throw new HttpError(400, `Spec name "${name}" must be lowercase letters, digits and dashes (max 48), e.g. "crm"`);
  return name;
}

function parseRole(v: unknown, fallback: SpecRole): SpecRole {
  if (v === undefined || v === null || v === '') return fallback;
  if (!SPEC_ROLES.includes(v as SpecRole)) throw new HttpError(400, `role must be ${SPEC_ROLES.join(' or ')}`);
  return v as SpecRole;
}

function parseMode(v: unknown, fallback: SpecMode): SpecMode {
  if (v === undefined || v === null || v === '') return fallback;
  if (!SPEC_MODES.includes(v as SpecMode)) throw new HttpError(400, `mode must be ${SPEC_MODES.join(', ')}`);
  return v as SpecMode;
}

/** "crm/", "/crm//v1/" → "/crm/v1"; "", "/" → "". Literal segments only (no :params or *). */
export function normalizeSpecPrefix(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'prefix must be a path like "/crm"');
  const segs = v.trim().split('/').filter(Boolean);
  for (const seg of segs) {
    if (!/^[A-Za-z0-9._~-]+$/.test(seg)) throw new HttpError(400, `Invalid prefix segment "${seg}". Use letters, digits and - _ . ~`);
  }
  const prefix = segs.length ? '/' + segs.join('/') : '';
  if (prefix.length > 200) throw new HttpError(400, 'prefix is too long (max 200)');
  return prefix;
}

/**
 * Full options from a partial input. Missing fields keep `cur`; without `cur`, unknownParams and unknownFields
 * default to 'warn' in strict mode and 'ignore' otherwise, and checkAuth defaults to true.
 */
export function normalizeSpecOptions(v: unknown, cur: SpecOptions | null, mode: SpecMode): SpecOptions {
  if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) throw new HttpError(400, 'options must be an object');
  const o = (v ?? {}) as Record<string, unknown>;
  const loud = mode === 'strict' ? 'warn' : 'ignore';
  const level = (x: unknown, field: string, fallback: 'ignore' | 'warn'): 'ignore' | 'warn' => {
    if (x === undefined || x === null) return fallback;
    if (x !== 'ignore' && x !== 'warn') throw new HttpError(400, `options.${field} must be ignore or warn`);
    return x;
  };
  const strList = (x: unknown, field: string): string[] | undefined => {
    if (x === undefined || x === null) return undefined;
    if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) throw new HttpError(400, `options.include.${field} must be an array of strings`);
    const list = (x as string[]).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  };
  let include = cur?.include ?? {};
  if (o.include !== undefined && o.include !== null) {
    if (typeof o.include !== 'object' || Array.isArray(o.include)) throw new HttpError(400, 'options.include must be an object { tags?, paths? }');
    const inc = o.include as Record<string, unknown>;
    const tags = strList(inc.tags, 'tags');
    const paths = strList(inc.paths, 'paths');
    include = { ...(tags ? { tags } : {}), ...(paths ? { paths } : {}) };
  }
  return {
    unknownParams: level(o.unknownParams, 'unknownParams', cur?.unknownParams ?? loud),
    unknownFields: level(o.unknownFields, 'unknownFields', cur?.unknownFields ?? loud),
    checkAuth: o.checkAuth === undefined || o.checkAuth === null ? (cur?.checkAuth ?? true) : !!o.checkAuth,
    include,
  };
}

function parseSource(v: unknown, fallback: SpecSource): SpecSource {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'source must be an object');
  const s = v as Record<string, unknown>;
  if (s.kind !== 'upload' && s.kind !== 'url' && s.kind !== 'inline') throw new HttpError(400, 'source.kind must be upload, url or inline');
  return {
    kind: s.kind,
    ...(typeof s.url === 'string' && s.url ? { url: s.url } : {}),
    ...(typeof s.filename === 'string' && s.filename ? { filename: s.filename } : {}),
  };
}

/** Imported OpenAPI specs (api_specs), per project. */
export class SpecRepo {
  constructor(private db: DB) {}

  get(id: string): SpecRecord | null {
    const r = this.db.prepare('SELECT * FROM api_specs WHERE id = ?').get(id) as Row | undefined;
    return r ? toSpec(r) : null;
  }

  byName(projectId: string, name: string): SpecRecord | null {
    const r = this.db.prepare('SELECT * FROM api_specs WHERE project_id = ? AND name = ?').get(projectId, name) as Row | undefined;
    return r ? toSpec(r) : null;
  }

  /** By id or name. */
  require(projectId: string, ref: string): SpecRecord {
    const r = (this.db.prepare('SELECT * FROM api_specs WHERE project_id = ? AND id = ?').get(projectId, ref) ??
      this.db.prepare('SELECT * FROM api_specs WHERE project_id = ? AND name = ?').get(projectId, ref)) as Row | undefined;
    if (!r) throw new HttpError(404, `API spec "${ref}" not found`);
    return toSpec(r);
  }

  /** Specs of a project by name; without the document unless `withDocument`. */
  list(projectId: string): SpecSummary[];
  list(projectId: string, opts: { withDocument: true }): SpecRecord[];
  list(projectId: string, opts?: { withDocument?: boolean }): SpecSummary[] | SpecRecord[] {
    if (opts?.withDocument) return (this.db.prepare('SELECT * FROM api_specs WHERE project_id = ? ORDER BY name').all(projectId) as Row[]).map(toSpec);
    return (this.db.prepare(`SELECT ${SUMMARY_COLS} FROM api_specs WHERE project_id = ? ORDER BY name`).all(projectId) as Row[]).map(toSummary);
  }

  create(projectId: string, input: SpecInput): SpecRecord {
    const name = parseName(input.name);
    const role = parseRole(input.role, 'mock');
    const mode = parseMode(input.mode, 'report');
    const prefix = normalizeSpecPrefix(input.prefix);
    const options = normalizeSpecOptions(input.options, null, mode);
    const source = parseSource(input.source, { kind: 'inline' });
    if (!input.document || typeof input.document !== 'object') throw new HttpError(400, 'document is required');
    if (!input.openapiVersion) throw new HttpError(400, 'openapiVersion is required');
    if (!input.hash) throw new HttpError(400, 'hash is required');
    this.checkName(projectId, name, null);
    this.checkPrefix(projectId, role, prefix, null);
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO api_specs (id, project_id, name, role, prefix, mode, openapi_version, title, api_version, source, document, options, warnings, operations, hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, projectId, name, role, prefix, mode, String(input.openapiVersion), String(input.title ?? ''), String(input.apiVersion ?? ''),
        JSON.stringify(source), JSON.stringify(input.document), JSON.stringify(options), JSON.stringify(input.warnings ?? []),
        Math.max(0, Math.round(Number(input.operations ?? 0)) || 0), String(input.hash), now, now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: SpecPatch): SpecRecord {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, `API spec "${id}" not found`);
    const name = patch.name === undefined ? cur.name : parseName(patch.name);
    const role = parseRole(patch.role, cur.role);
    const mode = parseMode(patch.mode, cur.mode);
    const prefix = patch.prefix === undefined ? cur.prefix : normalizeSpecPrefix(patch.prefix);
    const options = patch.options === undefined ? cur.options : normalizeSpecOptions(patch.options, cur.options, mode);
    const source = parseSource(patch.source, cur.source);
    if (patch.document !== undefined && (!patch.document || typeof patch.document !== 'object')) throw new HttpError(400, 'document must be an object');
    if (name !== cur.name) this.checkName(cur.projectId, name, cur.id);
    if (role !== cur.role || prefix !== cur.prefix) this.checkPrefix(cur.projectId, role, prefix, cur.id);
    this.db
      .prepare(
        `UPDATE api_specs SET name=?, role=?, prefix=?, mode=?, openapi_version=?, title=?, api_version=?, source=?, document=?, options=?, warnings=?,
         operations=?, hash=?, updated_at=? WHERE id=?`,
      )
      .run(
        name, role, prefix, mode, String(patch.openapiVersion ?? cur.openapiVersion), String(patch.title ?? cur.title), String(patch.apiVersion ?? cur.apiVersion),
        JSON.stringify(source), JSON.stringify(patch.document ?? cur.document), JSON.stringify(options), JSON.stringify(patch.warnings ?? cur.warnings),
        patch.operations === undefined ? cur.operations : Math.max(0, Math.round(Number(patch.operations)) || 0), String(patch.hash ?? cur.hash), nowIso(), cur.id,
      );
    return this.get(cur.id)!;
  }

  /** Deletes the spec; linked mocks keep existing with spec_id set to NULL (the service decides about deleting them). */
  delete(id: string): SpecRecord {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, `API spec "${id}" not found`);
    this.db.prepare('DELETE FROM api_specs WHERE id = ?').run(id);
    return cur;
  }

  private checkName(projectId: string, name: string, selfId: string | null): void {
    const r = this.db.prepare('SELECT id FROM api_specs WHERE project_id = ? AND name = ?').get(projectId, name) as { id: string } | undefined;
    if (r && r.id !== selfId) throw new HttpError(409, `An API spec named "${name}" already exists`);
  }

  /** Mock specs share /mock/<project>/api, so two of them cannot have the same prefix. */
  private checkPrefix(projectId: string, role: SpecRole, prefix: string, selfId: string | null): void {
    if (role !== 'mock') return;
    const r = this.db.prepare("SELECT id, name FROM api_specs WHERE project_id = ? AND role = 'mock' AND prefix = ?").get(projectId, prefix) as { id: string; name: string } | undefined;
    if (r && r.id !== selfId) throw new HttpError(409, `API spec "${r.name}" already uses the prefix "${prefix || '/'}"; pick another prefix`);
  }
}

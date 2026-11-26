// OpenAPI contracts (C1): import / re-import / delete of specs, the spec → mocks write path, and the compiled-spec
// lookups the runtime checks use (§2, §3.4, §3.5).

import type { Hub } from '../hub.js';
import type { ApiMock } from '../repos/mocks.js';
import { HttpError, SLUG_RE, slugify } from '../util.js';
import { fetchSpec } from './fetch.js';
import { mockContentHash, nameFor, planReimport, specToMocks, type ExistingSpecMock, type ReimportPlan, type SpecInclude, type SpecMock } from './mapping.js';
import { compileSpec, findOperation, normalizeSpec, parseSpecText, specHash } from './openapi.js';
import { SpecRepo, normalizeSpecOptions, normalizeSpecPrefix, type SpecSummary } from './repo.js';
import { installObserver } from './runtime.js';
import type { CompiledOperation, CompiledSpec, SpecDocument, SpecMode, SpecOptions, SpecRecord, SpecRole, SpecSource } from './types.js';

export type SpecImportSource = { kind: 'inline' | 'upload'; text: string; filename?: string } | { kind: 'url'; url: string };

export interface SpecImportInput {
  /** Defaults to the slugified info.title. An existing name upserts (re-import). */
  name?: string;
  source: SpecImportSource;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  options?: Partial<SpecOptions>;
  /** Overrides options.include for this import (and is stored there); `operations` applies to this import only. */
  include?: SpecInclude;
  dryRun?: boolean;
  /** Upsert only (an existing name). */
  overwriteEdited?: boolean;
  removeMissing?: 'disable' | 'delete' | 'keep';
}

export interface SpecReimportInput {
  /** New text or URL; default: the stored URL again, or the stored document. */
  source?: SpecImportSource;
  overwriteEdited?: boolean;
  removeMissing?: 'disable' | 'delete' | 'keep';
  dryRun?: boolean;
}

export interface SpecPatchInput {
  name?: string;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  options?: Partial<SpecOptions>;
}

/** One mock in an import result (`id` is null in a dry run for mocks still to be created). */
export interface ImportedMock {
  id: string | null;
  name: string;
  method: string;
  path: string;
  specOperation: string;
}

export interface SpecImportResult {
  spec: SpecSummary;
  dryRun: boolean;
  /** True when a re-import found the same document and nothing to change. */
  unchanged: boolean;
  created: ImportedMock[];
  updated: (ImportedMock & { overwritten: boolean })[];
  kept: { id: string; name: string; specOperation: string; reason: 'edited' }[];
  removed: { id: string; name: string; specOperation: string; action: 'disable' | 'delete' | 'keep' }[];
  warnings: string[];
}

export type SpecMockMatch =
  | { spec: SpecRecord; compiled: CompiledSpec; op: CompiledOperation; params: Record<string, string> }
  | { spec: SpecRecord; compiled: CompiledSpec; methodNotAllowed: string[] }
  | { spec: SpecRecord; compiled: CompiledSpec; unknownOperation: true };

interface Loaded {
  document: SpecDocument;
  openapiVersion: string;
  hash: string;
  warnings: string[];
  source: SpecSource;
}

const summaryOf = ({ document: _d, ...rest }: SpecRecord): SpecSummary => rest;

export class ContractService {
  readonly specs: SpecRepo;
  private cache = new Map<string, { hash: string; updatedAt: string; compiled: CompiledSpec }>();

  constructor(private hub: Hub) {
    this.specs = new SpecRepo(hub.db);
    installObserver(hub);
  }

  list(projectId: string): SpecSummary[] {
    return this.specs.list(projectId);
  }

  get(projectId: string, ref: string): SpecRecord {
    return this.specs.require(projectId, ref);
  }

  /** Import a spec (text or URL). An existing `name` re-imports into that spec (§2.6). */
  async import(projectId: string, input: SpecImportInput): Promise<SpecImportResult> {
    const loaded = await this.load(input.source);
    const name = input.name?.trim() || slugify(String(loaded.document.info?.title ?? '')) || 'api';
    const existing = this.specs.byName(projectId, name);
    if (existing) {
      return this.apply(projectId, existing, loaded, {
        role: input.role, prefix: input.prefix, mode: input.mode, options: input.options, include: input.include,
        overwriteEdited: input.overwriteEdited, removeMissing: input.removeMissing, dryRun: input.dryRun,
      });
    }

    if (!SLUG_RE.test(name)) throw new HttpError(400, `Spec name "${name}" must be lowercase letters, digits and dashes (max 48), e.g. "crm"`);
    const role = input.role ?? 'mock';
    const mode = input.mode ?? 'report';
    const prefix = normalizeSpecPrefix(input.prefix);
    const options = this.optionsWith(input.options, input.include, null, mode);
    this.checkPrefix(projectId, role, prefix, null);
    const compiled = compileSpec(loaded.document);
    const warnings = [...loaded.warnings, ...compiled.warnings];
    const generated = role === 'mock' ? this.generate(compiled, name, prefix, options, input.include, warnings) : [];
    const taken = this.nameTaker(projectId, name);
    const named = generated.map((m) => ({ ...m, name: taken(m) }));

    const preview: SpecSummary = {
      id: '', projectId, name, role, prefix, mode, openapiVersion: loaded.openapiVersion, title: String(loaded.document.info?.title ?? ''),
      apiVersion: String(loaded.document.info?.version ?? ''), source: loaded.source, options, warnings, operations: compiled.operations.length,
      hash: loaded.hash, createdAt: '', updatedAt: '',
    };
    if (input.dryRun) {
      return { spec: preview, dryRun: true, unchanged: false, created: named.map((m) => imported(null, m)), updated: [], kept: [], removed: [], warnings };
    }

    const { spec, created } = this.hub.db.transaction(() => {
      const spec = this.specs.create(projectId, {
        name, role, prefix, mode, openapiVersion: loaded.openapiVersion, title: preview.title, apiVersion: preview.apiVersion,
        source: loaded.source, document: loaded.document, options, warnings, operations: compiled.operations.length, hash: loaded.hash,
      });
      const created = named.map((m) => this.hub.mocks.create(projectId, { ...m, specId: spec.id }));
      return { spec, created };
    })();
    this.changed(projectId, spec, 'imported', created.length > 0);
    return { spec: summaryOf(spec), dryRun: false, unchanged: false, created: created.map((m) => imported(m.id, m)), updated: [], kept: [], removed: [], warnings };
  }

  /** Re-import a spec: the new source, else its URL again, else the stored document (e.g. after mocks were edited). */
  async reimport(projectId: string, ref: string, input: SpecReimportInput = {}): Promise<SpecImportResult> {
    const spec = this.specs.require(projectId, ref);
    let loaded: Loaded;
    if (input.source) loaded = await this.load(input.source);
    else if (spec.source.kind === 'url' && spec.source.url) loaded = await this.load({ kind: 'url', url: spec.source.url });
    else loaded = { document: spec.document, openapiVersion: spec.openapiVersion, hash: spec.hash, warnings: [], source: spec.source };
    return this.apply(projectId, spec, loaded, input);
  }

  /** Metadata only (name, role, prefix, mode, options); mock paths follow a prefix change on the next re-import. */
  update(projectId: string, ref: string, patch: SpecPatchInput): SpecRecord {
    const cur = this.specs.require(projectId, ref);
    const spec = this.specs.update(cur.id, patch);
    this.cache.delete(cur.id);
    this.changed(projectId, spec, 'updated', false);
    return spec;
  }

  /** Delete a spec; its mocks are deleted with `deleteMocks`, otherwise kept as hand-made mocks (unlinked). */
  delete(projectId: string, ref: string, opts: { deleteMocks?: boolean } = {}): { spec: SpecSummary; mocksDeleted: number; mocksKept: number } {
    const cur = this.specs.require(projectId, ref);
    const linked = this.hub.mocks.listBySpec(cur.id);
    this.hub.db.transaction(() => {
      for (const m of linked) {
        if (opts.deleteMocks) this.hub.mocks.delete(projectId, m.id);
        else this.hub.mocks.setSpecLink(m.id, null);
      }
      this.specs.delete(cur.id);
    })();
    this.cache.delete(cur.id);
    this.changed(projectId, cur, 'deleted', linked.length > 0);
    return { spec: summaryOf(cur), mocksDeleted: opts.deleteMocks ? linked.length : 0, mocksKept: opts.deleteMocks ? 0 : linked.length };
  }

  /** The compiled form of a spec, cached by id + document hash (+ updatedAt, so mode / prefix / option changes show). */
  compiled(spec: SpecRecord): CompiledSpec {
    const hit = this.cache.get(spec.id);
    if (hit && hit.hash === spec.hash && hit.updatedAt === spec.updatedAt) return hit.compiled;
    const compiled = compileSpec(spec);
    this.cache.set(spec.id, { hash: spec.hash, updatedAt: spec.updatedAt, compiled });
    return compiled;
  }

  /**
   * The role=mock spec for a /mock/<project>/api request path (relative to /api): the longest matching prefix among
   * specs whose mode is not off. Returns the operation, `methodNotAllowed`, `unknownOperation` (the prefix matched but
   * no path did), or null when no spec covers the path.
   */
  specForMockPath(projectId: string, method: string, path: string): SpecMockMatch | null {
    const p = '/' + path.split('?')[0].replace(/^\/+/, '');
    const candidates = this.specs
      .list(projectId, { withDocument: true })
      .filter((s) => s.role === 'mock' && s.mode !== 'off')
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const spec of candidates) {
      if (spec.prefix && p !== spec.prefix && !p.startsWith(spec.prefix + '/')) continue;
      const compiled = this.compiled(spec);
      const rel = p.slice(spec.prefix.length) || '/';
      const m = findOperation(compiled, method, rel);
      if (!m) return { spec, compiled, unknownOperation: true };
      if ('methodNotAllowed' in m) return { spec, compiled, methodNotAllowed: m.methodNotAllowed };
      return { spec, compiled, op: m.op, params: m.params };
    }
    return null;
  }

  /** Compiled role=app specs (mode not off), for checking the app's responses. */
  appSpecsFor(projectId: string): CompiledSpec[] {
    return this.specs
      .list(projectId, { withDocument: true })
      .filter((s) => s.role === 'app' && s.mode !== 'off')
      .map((s) => this.compiled(s));
  }

  // -------------------------------------------------------------------------------------------------------------

  private async load(source: SpecImportSource): Promise<Loaded> {
    if (!source || typeof source !== 'object') throw new HttpError(400, 'Pass the spec text or a url');
    let text: string;
    let src: SpecSource;
    if (source.kind === 'url') {
      if (typeof source.url !== 'string' || !source.url.trim()) throw new HttpError(400, 'url is required');
      const res = await fetchSpec(source.url.trim());
      text = res.text;
      src = { kind: 'url', url: source.url.trim() };
    } else {
      if (typeof source.text !== 'string') throw new HttpError(400, 'spec must be the document text (JSON or YAML)');
      text = source.text;
      src = { kind: source.kind === 'upload' ? 'upload' : 'inline', ...(source.filename ? { filename: source.filename } : {}) };
    }
    const parsed = parseSpecText(text);
    const { document, warnings } = normalizeSpec(parsed.document);
    return { document, openapiVersion: parsed.openapiVersion, hash: specHash(document), warnings, source: src };
  }

  /** options + include (include.operations is not stored: it narrows one import only). */
  private optionsWith(options: Partial<SpecOptions> | undefined, include: SpecInclude | undefined, cur: SpecOptions | null, mode: SpecMode): SpecOptions {
    const o: Record<string, unknown> = { ...(options ?? {}) };
    if (include) o.include = { tags: include.tags, paths: include.paths };
    return normalizeSpecOptions(o, cur, mode);
  }

  private generate(compiled: CompiledSpec, name: string, prefix: string, options: SpecOptions, include: SpecInclude | undefined, warnings: string[]): SpecMock[] {
    const inc: SpecInclude = { ...options.include, ...(include?.operations?.length ? { operations: include.operations } : {}) };
    const { mocks, warnings: w } = specToMocks(compiled, { specName: name, prefix, include: inc });
    warnings.push(...w);
    return mocks;
  }

  /** The "<spec> · <name>" collision rule against the project's mock names (and the names this import already took). */
  private nameTaker(projectId: string, specName: string): (m: SpecMock) => string {
    const used = new Set(this.hub.mocks.list(projectId).map((m) => m.name.toLowerCase()));
    const isTaken = (n: string) => used.has(n.toLowerCase());
    return (m) => {
      // m.name is the plain generated name (operationId or "METHOD path", deduplicated within the spec).
      let name = nameFor({ operationId: m.name, method: m.method, pathTemplate: m.path }, specName, isTaken);
      for (let n = 2; isTaken(name); n++) name = `${nameFor({ operationId: m.name, method: m.method, pathTemplate: m.path }, specName).slice(0, 114)} (${n})`;
      used.add(name.toLowerCase());
      return name;
    };
  }

  private checkPrefix(projectId: string, role: SpecRole, prefix: string, selfId: string | null): void {
    if (role !== 'mock') return;
    const other = this.specs.list(projectId).find((s) => s.role === 'mock' && s.prefix === prefix && s.id !== selfId);
    if (other) throw new HttpError(409, `API spec "${other.name}" already uses the prefix "${prefix || '/'}"; pick another prefix`);
  }

  /** The re-import / upsert diff and (unless dryRun) its write. */
  private apply(
    projectId: string,
    spec: SpecRecord,
    loaded: Loaded,
    opts: SpecReimportInput & { role?: SpecRole; prefix?: string; mode?: SpecMode; options?: Partial<SpecOptions>; include?: SpecInclude },
  ): SpecImportResult {
    const role = opts.role ?? spec.role;
    const mode = opts.mode ?? spec.mode;
    const prefix = opts.prefix === undefined ? spec.prefix : normalizeSpecPrefix(opts.prefix);
    const options = opts.options === undefined && opts.include === undefined && mode === spec.mode ? spec.options : this.optionsWith(opts.options, opts.include, spec.options, mode);
    if (role !== spec.role || prefix !== spec.prefix) this.checkPrefix(projectId, role, prefix, spec.id);
    const compiled = compileSpec(loaded.document);
    const warnings = [...loaded.warnings, ...compiled.warnings];
    const generated = role === 'mock' ? this.generate(compiled, spec.name, prefix, options, opts.include, warnings) : [];

    const linked = this.hub.mocks.listBySpec(spec.id);
    const byId = new Map<string, ApiMock>(linked.map((m) => [m.id, m]));
    const existing: ExistingSpecMock[] = linked.map((m) => ({
      id: m.id, specOperation: m.specOperation, specHash: m.specHash, currentHash: mockContentHash(m), enabled: m.enabled, activeScenario: m.activeScenario, description: m.description,
    }));
    const plan: ReimportPlan = planReimport(existing, generated, { overwriteEdited: opts.overwriteEdited, removeMissing: opts.removeMissing });
    const taken = this.nameTaker(projectId, spec.name);
    const toCreate = plan.create.map((m) => ({ ...m, name: taken(m) }));
    const nameOf = (id: string) => byId.get(id)?.name ?? id;
    const sameMeta = role === spec.role && prefix === spec.prefix && mode === spec.mode && JSON.stringify(options) === JSON.stringify(spec.options);
    const unchanged = loaded.hash === spec.hash && sameMeta && !plan.create.length && !plan.update.length && !plan.removed.some((r) => r.action !== 'keep' && byId.get(r.id)?.enabled !== false);
    const result = (s: SpecSummary, created: ImportedMock[], dryRun: boolean): SpecImportResult => ({
      spec: s, dryRun, unchanged,
      created,
      updated: plan.update.map((u) => ({ ...imported(u.id, { ...u.mock, name: nameOf(u.id) }), overwritten: u.overwritten })),
      kept: plan.kept.map((k) => ({ id: k.id, name: nameOf(k.id), specOperation: k.specOperation, reason: k.reason })),
      removed: plan.removed.map((r) => ({ id: r.id, name: nameOf(r.id), specOperation: r.specOperation, action: r.action })),
      warnings,
    });
    const meta = {
      role, prefix, mode, options, source: loaded.source, openapiVersion: loaded.openapiVersion, hash: loaded.hash, warnings,
      title: String(loaded.document.info?.title ?? ''), apiVersion: String(loaded.document.info?.version ?? ''), operations: compiled.operations.length,
    };
    const patch = { ...meta, document: loaded.document };
    if (opts.dryRun) return result({ ...summaryOf(spec), ...meta }, toCreate.map((m) => imported(null, m)), true);
    if (unchanged) return result(summaryOf(spec), [], false);

    const { updated, created } = this.hub.db.transaction(() => {
      const updated = this.specs.update(spec.id, patch);
      for (const u of plan.update) {
        this.hub.mocks.update(projectId, u.id, {
          method: u.mock.method, path: u.mock.path, description: u.mock.description, scenarios: u.mock.scenarios, activeScenario: u.mock.activeScenario,
          specOperation: u.specOperation, specHash: u.mock.specHash,
        });
      }
      for (const r of plan.removed) {
        if (r.action === 'delete') this.hub.mocks.delete(projectId, r.id);
        else if (r.action === 'disable' && r.patch) this.hub.mocks.update(projectId, r.id, r.patch);
      }
      const created = toCreate.map((m) => this.hub.mocks.create(projectId, { ...m, specId: spec.id }));
      return { updated, created };
    })();
    this.cache.delete(spec.id);
    this.changed(projectId, updated, 'reimported', created.length + plan.update.length + plan.removed.length > 0);
    return result(summaryOf(updated), created.map((m) => imported(m.id, m)), false);
  }

  private changed(projectId: string, spec: SpecRecord, action: 'imported' | 'reimported' | 'updated' | 'deleted', mocksChanged: boolean): void {
    const data = { action, spec: summaryOf(spec) };
    this.hub.bus.publish({ type: 'contracts.changed', projectId, data });
    if (mocksChanged) this.hub.bus.publish({ type: 'mocks.changed', projectId, data: { spec: spec.name, action } });
  }
}

function imported(id: string | null, m: { name: string; method: string; path: string; specOperation?: string | null }): ImportedMock {
  return { id, name: m.name, method: m.method, path: m.path, specOperation: m.specOperation ?? '' };
}

import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import { compilePath, normalizePath, type MockMatch } from '../mocks/match.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';

export const MOCK_BEHAVIOURS = ['respond', 'timeout', 'drop'] as const;
export type MockBehaviour = (typeof MOCK_BEHAVIOURS)[number];

/** One possible answer of a mock ("OK", "Card declined", "Timeout"…). */
export interface MockScenario {
  name: string;
  status: number;
  headers: Record<string, string>;
  /** Response body; templates like {{params.id}} are filled per request. */
  body: string;
  delayMs: number;
  /** respond = send the response; timeout = never answer; drop = close the connection without a response. */
  behaviour: MockBehaviour;
}

export interface ApiMock {
  id: string;
  projectId: string;
  name: string;
  description: string;
  /** GET, POST, … , "GET,HEAD" or ANY. */
  method: string;
  /** Path below /mock/<project>/api, e.g. /payments/:id or /files/*. */
  path: string;
  match: MockMatch;
  scenarios: MockScenario[];
  /** Name of the scenario used for normal requests. */
  activeScenario: string;
  position: number;
  enabled: boolean;
  hits: number;
  lastHitAt: string | null;
  /** OpenAPI spec this mock was generated from (C1); null = hand-made. */
  specId: string | null;
  /** The spec operation, e.g. "GET /users/{id}". */
  specOperation: string | null;
  /** mockContentHash of the generated mock at the last import (an edit changes the hash). */
  specHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The link between a mock and its spec operation. */
export interface MockSpecLink {
  specId: string;
  specOperation: string;
  specHash: string;
}

export interface MockInput {
  name?: string;
  description?: string;
  method?: string;
  path?: string;
  match?: MockMatch | null;
  scenarios?: Partial<MockScenario>[];
  activeScenario?: string | null;
  enabled?: boolean;
  position?: number;
  specId?: string | null;
  specOperation?: string | null;
  specHash?: string | null;
}

interface Row {
  id: string;
  project_id: string;
  name: string;
  description: string;
  method: string;
  path: string;
  match: string;
  scenarios: string;
  active_scenario: string | null;
  position: number;
  enabled: number;
  hits: number;
  last_hit_at: string | null;
  spec_id: string | null;
  spec_operation: string | null;
  spec_hash: string | null;
  created_at: string;
  updated_at: string;
}

function toMock(r: Row): ApiMock {
  const scenarios = parseJson<MockScenario[]>(r.scenarios, []);
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    method: r.method,
    path: r.path,
    match: parseJson<MockMatch>(r.match, {}),
    scenarios,
    activeScenario: r.active_scenario && scenarios.some((s) => s.name === r.active_scenario) ? r.active_scenario : (scenarios[0]?.name ?? ''),
    position: r.position,
    enabled: r.enabled === 1,
    hits: r.hits,
    lastHitAt: r.last_hit_at,
    specId: r.spec_id ?? null,
    specOperation: r.spec_operation ?? null,
    specHash: r.spec_hash ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Sorted object keys at every level, so the JSON does not depend on key order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/**
 * Stable sha256 (hex) of the parts of a mock an OpenAPI import generates: method, path, description and scenarios.
 * Re-imports compare it with `specHash` to tell an unedited mock from an edited one. Key order does not matter.
 */
export function mockContentHash(m: Pick<ApiMock, 'method' | 'path' | 'description' | 'scenarios'>): string {
  const canonical = {
    method: m.method,
    path: m.path,
    description: m.description,
    scenarios: m.scenarios.map((s) => ({ name: s.name, status: s.status, headers: s.headers, body: s.body, delayMs: s.delayMs, behaviour: s.behaviour })),
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(canonical))).digest('hex');
}

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export class MockRepo {
  constructor(private db: DB) {}

  list(projectId: string): ApiMock[] {
    return (this.db.prepare('SELECT * FROM api_mocks WHERE project_id = ? ORDER BY position, created_at').all(projectId) as Row[]).map(toMock);
  }

  get(id: string): ApiMock | null {
    const r = this.db.prepare('SELECT * FROM api_mocks WHERE id = ?').get(id) as Row | undefined;
    return r ? toMock(r) : null;
  }

  /** By id or (case-insensitive) name. */
  require(projectId: string, ref: string): ApiMock {
    const r = (this.db.prepare('SELECT * FROM api_mocks WHERE project_id = ? AND id = ?').get(projectId, ref) ??
      this.db.prepare('SELECT * FROM api_mocks WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, ref)) as Row | undefined;
    if (!r) throw new HttpError(404, `API mock "${ref}" not found`);
    return toMock(r);
  }

  create(projectId: string, input: MockInput): ApiMock {
    const v = validate(input, null);
    this.checkName(projectId, v.name, null);
    const id = newId();
    const now = nowIso();
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM api_mocks WHERE project_id = ?').get(projectId) as { m: number }).m + 1;
    this.db
      .prepare(
        `INSERT INTO api_mocks (id, project_id, name, description, method, path, match, scenarios, active_scenario, position, enabled, spec_id, spec_operation, spec_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, projectId, v.name, v.description, v.method, v.path, JSON.stringify(v.match), JSON.stringify(v.scenarios), v.activeScenario, pos, v.enabled ? 1 : 0,
        v.specId, v.specOperation, v.specHash, now, now);
    if (input.position !== undefined) this.move(id, input.position);
    return this.get(id)!;
  }

  update(projectId: string, ref: string, patch: MockInput): ApiMock {
    const cur = this.require(projectId, ref);
    const v = validate({ ...cur, ...stripUndefined(patch) }, cur);
    this.checkName(projectId, v.name, cur.id);
    this.db
      .prepare('UPDATE api_mocks SET name=?, description=?, method=?, path=?, match=?, scenarios=?, active_scenario=?, enabled=?, spec_id=?, spec_operation=?, spec_hash=?, updated_at=? WHERE id=?')
      .run(v.name, v.description, v.method, v.path, JSON.stringify(v.match), JSON.stringify(v.scenarios), v.activeScenario, v.enabled ? 1 : 0,
        v.specId, v.specOperation, v.specHash, nowIso(), cur.id);
    if (patch.position !== undefined) this.move(cur.id, patch.position);
    return this.get(cur.id)!;
  }

  setActiveScenario(projectId: string, ref: string, scenario: string): ApiMock {
    const cur = this.require(projectId, ref);
    const s = cur.scenarios.find((x) => x.name.toLowerCase() === String(scenario ?? '').trim().toLowerCase());
    if (!s) throw new HttpError(400, `Mock "${cur.name}" has no scenario "${scenario}". Scenarios: ${cur.scenarios.map((x) => x.name).join(', ')}`);
    this.db.prepare('UPDATE api_mocks SET active_scenario = ?, updated_at = ? WHERE id = ?').run(s.name, nowIso(), cur.id);
    return this.get(cur.id)!;
  }

  delete(projectId: string, ref: string): ApiMock {
    const cur = this.require(projectId, ref);
    this.db.prepare('DELETE FROM api_mocks WHERE id = ?').run(cur.id);
    this.renumber(projectId);
    return cur;
  }

  /** Link a mock to a spec operation (null unlinks it). */
  setSpecLink(mockId: string, link: MockSpecLink | null): ApiMock {
    const cur = this.get(mockId);
    if (!cur) throw new HttpError(404, `API mock "${mockId}" not found`);
    this.db
      .prepare('UPDATE api_mocks SET spec_id = ?, spec_operation = ?, spec_hash = ? WHERE id = ?')
      .run(link?.specId ?? null, link?.specOperation ?? null, link?.specHash ?? null, mockId);
    return this.get(mockId)!;
  }

  /** Mocks generated from a spec, in priority order. */
  listBySpec(specId: string): ApiMock[] {
    return (this.db.prepare('SELECT * FROM api_mocks WHERE spec_id = ? ORDER BY position, created_at').all(specId) as Row[]).map(toMock);
  }

  /** mockContentHash of a mock (see there). */
  contentHash(mock: Pick<ApiMock, 'method' | 'path' | 'description' | 'scenarios'>): string {
    return mockContentHash(mock);
  }

  hit(id: string): void {
    this.db.prepare('UPDATE api_mocks SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(nowIso(), id);
  }

  resetHits(projectId: string): number {
    return this.db.prepare('UPDATE api_mocks SET hits = 0, last_hit_at = NULL WHERE project_id = ?').run(projectId).changes;
  }

  /** Move a mock to a 1-based position (priority: lower = checked first). */
  move(id: string, position: number): void {
    const m = this.get(id);
    if (!m) return;
    const list = this.list(m.projectId).filter((x) => x.id !== id);
    const at = Math.max(0, Math.min(list.length, Math.round(position) - 1));
    list.splice(at, 0, m);
    const stmt = this.db.prepare('UPDATE api_mocks SET position = ? WHERE id = ?');
    this.db.transaction(() => list.forEach((x, i) => stmt.run(i + 1, x.id)))();
  }

  private renumber(projectId: string): void {
    const stmt = this.db.prepare('UPDATE api_mocks SET position = ? WHERE id = ?');
    this.db.transaction(() => this.list(projectId).forEach((x, i) => stmt.run(i + 1, x.id)))();
  }

  private checkName(projectId: string, name: string, selfId: string | null): void {
    const r = this.db.prepare('SELECT id FROM api_mocks WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, name) as { id: string } | undefined;
    if (r && r.id !== selfId) throw new HttpError(409, `An API mock named "${name}" already exists`);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function validate(i: MockInput, cur: ApiMock | null) {
  const path = normalizePath(String(i.path ?? ''));
  if (!i.path || !String(i.path).trim()) throw new HttpError(400, 'path is required, e.g. /payments/:id');
  try {
    compilePath(path);
  } catch {
    throw new HttpError(400, `Invalid path pattern "${i.path}"`);
  }
  const method = String(i.method ?? 'ANY').trim().toUpperCase() || 'ANY';
  for (const m of method.split(/[,\s|]+/).filter(Boolean)) {
    if (m !== '*' && !METHODS.includes(m)) throw new HttpError(400, `Unknown method "${m}". Use ${METHODS.join(', ')}`);
  }
  const name = String(i.name ?? '').trim() || `${method === 'ANY' ? '' : method + ' '}${path}`;
  if (name.length > 120) throw new HttpError(400, 'name is too long (max 120)');
  const match = validateMatch(i.match ?? {});
  const raw = Array.isArray(i.scenarios) && i.scenarios.length ? i.scenarios : cur?.scenarios ?? [{ name: 'OK' }];
  const scenarios = raw.map((s, idx) => validateScenario(s, idx));
  const names = new Set<string>();
  for (const s of scenarios) {
    if (names.has(s.name.toLowerCase())) throw new HttpError(400, `Duplicate scenario name "${s.name}"`);
    names.add(s.name.toLowerCase());
  }
  const wanted = i.activeScenario ? String(i.activeScenario).toLowerCase() : null;
  const active = scenarios.find((s) => s.name.toLowerCase() === wanted)?.name ?? scenarios[0].name;
  if (wanted && !scenarios.some((s) => s.name.toLowerCase() === wanted)) throw new HttpError(400, `activeScenario "${i.activeScenario}" is not one of the scenarios`);
  const opt = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    name, description: String(i.description ?? ''), method, path, match, scenarios, activeScenario: active, enabled: i.enabled !== false,
    specId: opt(i.specId), specOperation: opt(i.specOperation), specHash: opt(i.specHash),
  };
}

function validateMatch(m: MockMatch): MockMatch {
  if (typeof m !== 'object' || Array.isArray(m)) throw new HttpError(400, 'match must be an object');
  const strMap = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `match.${what} must be an object of name → value`);
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (k.trim()) out[k.trim()] = String(val);
    return Object.keys(out).length ? out : undefined;
  };
  const out: MockMatch = {};
  const q = strMap(m.query, 'query');
  if (q) out.query = q;
  const h = strMap(m.headers, 'headers');
  if (h) out.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  if (m.bodyContains) out.bodyContains = String(m.bodyContains);
  if (m.bodyJson !== undefined && m.bodyJson !== null) {
    if (typeof m.bodyJson !== 'object' || Array.isArray(m.bodyJson)) throw new HttpError(400, 'match.bodyJson must be an object of path → value');
    if (Object.keys(m.bodyJson).length) out.bodyJson = m.bodyJson;
  }
  return out;
}

function validateScenario(s: Partial<MockScenario> & { behavior?: string }, idx: number): MockScenario {
  const name = String(s.name ?? '').trim() || `Scenario ${idx + 1}`;
  const behaviour = String(s.behaviour ?? s.behavior ?? 'respond').toLowerCase().replace('drop-connection', 'drop').replace('drop_connection', 'drop') as MockBehaviour;
  if (!MOCK_BEHAVIOURS.includes(behaviour)) throw new HttpError(400, `Scenario "${name}": behaviour must be respond, timeout or drop`);
  const status = s.status === undefined || s.status === null || (s.status as unknown) === '' ? 200 : Number(s.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new HttpError(400, `Scenario "${name}": status must be 100-599`);
  const delayMs = s.delayMs === undefined || s.delayMs === null || (s.delayMs as unknown) === '' ? 0 : Number(s.delayMs);
  if (!(delayMs >= 0 && delayMs <= 600_000)) throw new HttpError(400, `Scenario "${name}": delayMs must be 0-600000`);
  const headers: Record<string, string> = {};
  if (s.headers && typeof s.headers === 'object') for (const [k, v] of Object.entries(s.headers)) if (k.trim()) headers[k.trim()] = String(v);
  const body = s.body === undefined || s.body === null ? '' : typeof s.body === 'string' ? s.body : JSON.stringify(s.body, null, 2);
  return { name, status, headers, body, delayMs, behaviour };
}

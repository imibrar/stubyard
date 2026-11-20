import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { isMasked, maskHeaders, type TransportPref } from './client.js';

/** Saved MCP server targets and saved tool calls (migration 13). Ids are stable (newId), so other features can refer to them. */

export interface McpTarget {
  id: string;
  projectId: string;
  name: string;
  url: string;
  transport: TransportPref;
  /** Header values in clear text: only inside the server (never in list responses). */
  headers: Record<string, string>;
  notes: string;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedCallExpect {
  /** Expected isError of the result (default false). */
  isError?: boolean;
  /** Text that must appear in the result (text blocks or JSON of structuredContent). */
  contains?: string;
  /** Fail when the call takes longer. */
  maxMs?: number;
  /** structuredContent must validate against the tool's outputSchema (default true when there is one). */
  validOutput?: boolean;
}

export interface SavedCallResult {
  pass: boolean;
  ranAt: string;
  durationMs: number;
  failures: string[];
  isError?: boolean;
  rpcError?: { code: number; message: string } | null;
  error?: string | null;
  preview?: string;
}

export interface SavedCall {
  id: string;
  projectId: string;
  targetId: string;
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  expect: SavedCallExpect;
  position: number;
  lastResult: SavedCallResult | null;
  createdAt: string;
  updatedAt: string;
}

interface TargetRow {
  id: string;
  project_id: string;
  name: string;
  url: string;
  transport: TransportPref;
  headers: string;
  notes: string;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CallRow {
  id: string;
  project_id: string;
  target_id: string;
  name: string;
  tool: string;
  arguments: string;
  expect: string;
  position: number;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

const toTarget = (r: TargetRow): McpTarget => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  url: r.url,
  transport: r.transport,
  headers: parseJson<Record<string, string>>(r.headers, {}),
  notes: r.notes,
  lastConnectedAt: r.last_connected_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCall = (r: CallRow): SavedCall => ({
  id: r.id,
  projectId: r.project_id,
  targetId: r.target_id,
  name: r.name,
  tool: r.tool,
  arguments: parseJson<Record<string, unknown>>(r.arguments, {}),
  expect: parseJson<SavedCallExpect>(r.expect, {}),
  position: r.position,
  lastResult: parseJson<SavedCallResult | null>(r.last_result, null),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Target as returned by the API: every header value masked. */
export function publicTarget(t: McpTarget): Omit<McpTarget, 'headers'> & { headers: Record<string, string>; headerNames: string[] } {
  return { ...t, headers: maskHeaders(t.headers, true), headerNames: Object.keys(t.headers) };
}

export function validateUrl(url: unknown): string {
  const u = String(url ?? '').trim();
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error();
    return p.toString();
  } catch {
    throw new HttpError(400, `"${u}" is not an http(s) URL. MCP tester connects to Streamable HTTP or HTTP+SSE servers; for a stdio server run a bridge (see the page hint).`);
  }
}

export function normalizeHeaders(h: unknown, previous: Record<string, string> = {}): Record<string, string> {
  if (h === undefined) return previous;
  if (h === null) return {};
  const entries: [string, string][] = Array.isArray(h)
    ? (h as { name?: unknown; value?: unknown }[]).map((x) => [String(x?.name ?? ''), String(x?.value ?? '')])
    : typeof h === 'object'
      ? Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
      : [];
  const out: Record<string, string> = {};
  for (const [k0, v] of entries) {
    const k = k0.trim();
    if (!k) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new HttpError(400, `Invalid header name "${k}"`);
    if (['host', 'content-length', 'mcp-session-id', 'mcp-protocol-version'].includes(k.toLowerCase())) throw new HttpError(400, `Header "${k}" is managed by the MCP tester`);
    // A masked value sent back from the dashboard means "keep the stored value".
    const prevKey = Object.keys(previous).find((p) => p.toLowerCase() === k.toLowerCase());
    out[k] = isMasked(v) && prevKey ? previous[prevKey] : v;
  }
  return out;
}

export interface TargetInput {
  name?: unknown;
  url?: unknown;
  transport?: unknown;
  headers?: unknown;
  notes?: unknown;
}

const TRANSPORTS = ['auto', 'streamable', 'sse'];

export class McpTesterRepo {
  constructor(private db: DB) {}

  listTargets(projectId: string): McpTarget[] {
    return (this.db.prepare('SELECT * FROM mcp_targets WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(projectId) as unknown as TargetRow[]).map(toTarget);
  }

  /** By id or (case-insensitive) name. */
  getTarget(projectId: string, ref: string): McpTarget | null {
    const r = (this.db.prepare('SELECT * FROM mcp_targets WHERE project_id = ? AND (id = ? OR name = ? COLLATE NOCASE)').get(projectId, ref, ref) as TargetRow | undefined) ?? null;
    return r ? toTarget(r) : null;
  }

  requireTarget(projectId: string, ref: string): McpTarget {
    const t = this.getTarget(projectId, ref);
    if (!t) throw new HttpError(404, `MCP target "${ref}" not found`);
    return t;
  }

  createTarget(projectId: string, input: TargetInput): McpTarget {
    const url = validateUrl(input.url);
    const name = String(input.name ?? '').trim() || new URL(url).host;
    const transport = String(input.transport ?? 'auto');
    if (!TRANSPORTS.includes(transport)) throw new HttpError(400, 'transport must be auto, streamable or sse');
    if (this.getTarget(projectId, name)) throw new HttpError(409, `An MCP target named "${name}" exists already`);
    const now = nowIso();
    const id = newId();
    this.db
      .prepare('INSERT INTO mcp_targets (id, project_id, name, url, transport, headers, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, name, url, transport, JSON.stringify(normalizeHeaders(input.headers)), String(input.notes ?? ''), now, now);
    return this.requireTarget(projectId, id);
  }

  updateTarget(projectId: string, ref: string, input: TargetInput): McpTarget {
    const t = this.requireTarget(projectId, ref);
    const name = input.name !== undefined ? String(input.name).trim() || t.name : t.name;
    if (name.toLowerCase() !== t.name.toLowerCase()) {
      const other = this.getTarget(projectId, name);
      if (other && other.id !== t.id) throw new HttpError(409, `An MCP target named "${name}" exists already`);
    }
    const transport = input.transport !== undefined ? String(input.transport) : t.transport;
    if (!TRANSPORTS.includes(transport)) throw new HttpError(400, 'transport must be auto, streamable or sse');
    this.db
      .prepare('UPDATE mcp_targets SET name = ?, url = ?, transport = ?, headers = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(name, input.url !== undefined ? validateUrl(input.url) : t.url, transport, JSON.stringify(normalizeHeaders(input.headers, t.headers)), input.notes !== undefined ? String(input.notes) : t.notes, nowIso(), t.id);
    return this.requireTarget(projectId, t.id);
  }

  touchTarget(id: string): void {
    this.db.prepare('UPDATE mcp_targets SET last_connected_at = ? WHERE id = ?').run(nowIso(), id);
  }

  deleteTarget(projectId: string, ref: string): void {
    const t = this.requireTarget(projectId, ref);
    this.db.prepare('DELETE FROM mcp_targets WHERE id = ?').run(t.id);
  }

  // ------------------------------------------------------------------ saved calls

  listCalls(targetId: string): SavedCall[] {
    return (this.db.prepare('SELECT * FROM mcp_saved_calls WHERE target_id = ? ORDER BY position, created_at').all(targetId) as unknown as CallRow[]).map(toCall);
  }

  getCall(projectId: string, id: string): SavedCall | null {
    const r = this.db.prepare('SELECT * FROM mcp_saved_calls WHERE project_id = ? AND id = ?').get(projectId, id) as CallRow | undefined;
    return r ? toCall(r) : null;
  }

  requireCall(projectId: string, id: string): SavedCall {
    const c = this.getCall(projectId, id);
    if (!c) throw new HttpError(404, `Saved call "${id}" not found`);
    return c;
  }

  createCall(target: McpTarget, input: { name?: unknown; tool?: unknown; arguments?: unknown; expect?: unknown; position?: unknown }): SavedCall {
    const tool = String(input.tool ?? '').trim();
    if (!tool) throw new HttpError(400, 'tool is required');
    const args = checkArgs(input.arguments);
    const pos = input.position !== undefined ? Number(input.position) : ((this.db.prepare('SELECT MAX(position) AS m FROM mcp_saved_calls WHERE target_id = ?').get(target.id) as { m: number | null }).m ?? -1) + 1;
    const now = nowIso();
    const id = newId();
    this.db
      .prepare('INSERT INTO mcp_saved_calls (id, project_id, target_id, name, tool, arguments, expect, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, target.projectId, target.id, String(input.name ?? '').trim() || tool, tool, JSON.stringify(args), JSON.stringify(checkExpect(input.expect)), pos, now, now);
    return this.requireCall(target.projectId, id);
  }

  updateCall(projectId: string, id: string, input: { name?: unknown; tool?: unknown; arguments?: unknown; expect?: unknown; position?: unknown }): SavedCall {
    const c = this.requireCall(projectId, id);
    this.db
      .prepare('UPDATE mcp_saved_calls SET name = ?, tool = ?, arguments = ?, expect = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(
        input.name !== undefined ? String(input.name).trim() || c.name : c.name,
        input.tool !== undefined ? String(input.tool).trim() || c.tool : c.tool,
        JSON.stringify(input.arguments !== undefined ? checkArgs(input.arguments) : c.arguments),
        JSON.stringify(input.expect !== undefined ? checkExpect(input.expect) : c.expect),
        input.position !== undefined ? Number(input.position) : c.position,
        nowIso(),
        c.id,
      );
    return this.requireCall(projectId, id);
  }

  setCallResult(id: string, result: SavedCallResult): void {
    this.db.prepare('UPDATE mcp_saved_calls SET last_result = ? WHERE id = ?').run(JSON.stringify(result), id);
  }

  deleteCall(projectId: string, id: string): void {
    const c = this.requireCall(projectId, id);
    this.db.prepare('DELETE FROM mcp_saved_calls WHERE id = ?').run(c.id);
  }
}

function checkArgs(a: unknown): Record<string, unknown> {
  if (a === undefined || a === null) return {};
  if (typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, 'arguments must be a JSON object');
  return a as Record<string, unknown>;
}

function checkExpect(e: unknown): SavedCallExpect {
  if (e === undefined || e === null) return {};
  if (typeof e !== 'object' || Array.isArray(e)) throw new HttpError(400, 'expect must be an object');
  const o = e as Record<string, unknown>;
  const out: SavedCallExpect = {};
  if (o.isError !== undefined && o.isError !== null) out.isError = o.isError === true;
  if (typeof o.contains === 'string' && o.contains) out.contains = o.contains;
  if (o.maxMs !== undefined && o.maxMs !== null && o.maxMs !== '') {
    const n = Number(o.maxMs);
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'expect.maxMs must be a positive number');
    out.maxMs = n;
  }
  if (o.validOutput === false) out.validOutput = false;
  return out;
}

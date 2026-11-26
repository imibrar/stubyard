import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import { HttpError, trimEnd } from '../util.js';
import { FAULT_HELP, globMatch, parseFault, pickIndex, toRegex, whyNot, type Fault } from './match.js';
import { lastUserText, requestHash, turnOf } from './normalize.js';
import { LLM_MOCK_MODES, LlmRepo, type LlmCall, type LlmMock, type LlmRecording, type LlmSettings, type MockFields } from './repo.js';
import { DEFAULT_MODELS } from './synth.js';
import { LLM_ENDPOINTS, type CanonRequest, type CanonResponse, type LlmMatch } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const PROVIDERS = ['openai', 'anthropic', 'any'];
/** Recording auto-stop defaults (override per recording with maxCalls / ttlMinutes). */
export const RECORDING_MAX_CALLS = 200;
export const RECORDING_TTL_MINUTES = 60;

export interface Pick {
  /** A fault rule (or the header / the mock's own fault) that applies. */
  fault: Fault | null;
  faultSource: 'header' | 'rule' | 'mock' | null;
  faultMock: LlmMock | null;
  mock: LlmMock | null;
  response: CanonResponse | null;
  /** Matched by the recorded request hash. */
  hashHit: boolean;
  misses: { id: string; name: string; reason: string }[];
}

/** hub.llm: scripted OpenAI / Anthropic API mocks, fault rules, the call log and record-to-mock sessions. */
export class LlmMockService {
  readonly repo: LlmRepo;

  constructor(private hub: Hub) {
    this.repo = new LlmRepo(hub.db);
  }

  // ------------------------------------------------------------------ mocks

  private checkResponse(r: unknown, i: number): CanonResponse {
    if (typeof r === 'string') return { text: r };
    if (!isObj(r)) throw new HttpError(400, `responses[${i}] must be an object like {"text": "…"} or {"toolCalls": [{"name": "…", "arguments": {}}]}`);
    const out: CanonResponse = {};
    if (r.text !== undefined && r.text !== null) out.text = String(r.text);
    if (r.toolCalls !== undefined && r.toolCalls !== null) {
      if (!Array.isArray(r.toolCalls)) throw new HttpError(400, `responses[${i}].toolCalls must be an array`);
      out.toolCalls = r.toolCalls.map((c, k) => {
        if (!isObj(c) || !c.name) throw new HttpError(400, `responses[${i}].toolCalls[${k}] needs a name`);
        return { name: String(c.name), arguments: c.arguments ?? {}, ...(c.id ? { id: String(c.id) } : {}) };
      });
    }
    if (r.stopReason) out.stopReason = String(r.stopReason);
    if (isObj(r.usage)) out.usage = { ...(r.usage.input !== undefined ? { input: Math.max(0, Number(r.usage.input) || 0) } : {}), ...(r.usage.output !== undefined ? { output: Math.max(0, Number(r.usage.output) || 0) } : {}) };
    if (isObj(r.chunk)) out.chunk = { ...(r.chunk.size !== undefined ? { size: Number(r.chunk.size) } : {}), ...(r.chunk.delayMs !== undefined ? { delayMs: Number(r.chunk.delayMs) } : {}) };
    if (r.raw !== undefined && r.raw !== null) out.raw = this.checkRaw(r.raw, i);
    if (out.text === undefined && !out.toolCalls && !out.raw) out.text = '';
    return out;
  }

  /** A recorded exact reply: replayed byte for byte, so it must be complete. */
  private checkRaw(raw: unknown, i: number): NonNullable<CanonResponse['raw']> {
    const at = `responses[${i}].raw`;
    if (!isObj(raw)) throw new HttpError(400, `${at} must be an object {provider, endpoint, stream, status, contentType, body}`);
    if (raw.provider !== 'openai' && raw.provider !== 'anthropic') throw new HttpError(400, `${at}.provider must be "openai" or "anthropic"`);
    if (!(LLM_ENDPOINTS as unknown[]).includes(raw.endpoint)) throw new HttpError(400, `${at}.endpoint must be one of ${LLM_ENDPOINTS.join(', ')}`);
    if (typeof raw.stream !== 'boolean') throw new HttpError(400, `${at}.stream must be true or false`);
    const status = Number(raw.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new HttpError(400, `${at}.status must be an HTTP status from 200 to 599`);
    if (typeof raw.body !== 'string' || !raw.body.trim()) throw new HttpError(400, `${at}.body must be a non-empty string`);
    const contentType = raw.contentType === undefined || raw.contentType === null || raw.contentType === '' ? (raw.stream ? 'text/event-stream' : 'application/json') : String(raw.contentType);
    return { provider: raw.provider, endpoint: raw.endpoint as NonNullable<CanonResponse['raw']>['endpoint'], stream: raw.stream, status, contentType, body: raw.body };
  }

  private checkMatch(m: unknown): LlmMatch {
    if (m === undefined || m === null) return {};
    if (!isObj(m)) throw new HttpError(400, 'match must be an object');
    const out: LlmMatch = {};
    if (m.endpoint !== undefined && m.endpoint !== null && m.endpoint !== '') {
      const list = (Array.isArray(m.endpoint) ? m.endpoint : String(m.endpoint).split(',')).map((s) => String(s).trim());
      for (const e of list) if (!(LLM_ENDPOINTS as string[]).includes(e)) throw new HttpError(400, `match.endpoint "${e}" is not one of ${LLM_ENDPOINTS.join(', ')}`);
      out.endpoint = list.length === 1 ? (list[0] as LlmMatch['endpoint'] & string) : (list as LlmMatch['endpoint']);
    }
    if (m.model) out.model = String(m.model);
    const text = (v: unknown, key: string) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'string') return { contains: v };
      if (!isObj(v)) throw new HttpError(400, `match.${key} must be {contains|equals|regex}`);
      const t: J = {};
      for (const k of ['contains', 'equals', 'regex']) if (v[k] !== undefined && v[k] !== null && v[k] !== '') t[k] = String(v[k]);
      if (t.regex !== undefined && !toRegex(String(t.regex))) throw new HttpError(400, `match.${key}.regex is not a valid regular expression`);
      return t;
    };
    const lu = text(m.lastUser, 'lastUser');
    if (lu && Object.keys(lu).length) out.lastUser = lu;
    const sys = text(m.system, 'system');
    if (sys?.contains) out.system = { contains: String(sys.contains) };
    if (m.toolResult !== undefined && m.toolResult !== null) {
      if (!isObj(m.toolResult)) throw new HttpError(400, 'match.toolResult must be {name?, contains?}');
      out.toolResult = { ...(m.toolResult.name ? { name: String(m.toolResult.name) } : {}), ...(m.toolResult.contains ? { contains: String(m.toolResult.contains) } : {}) };
    }
    if (m.hasTool) out.hasTool = String(m.hasTool);
    if (m.turn !== undefined && m.turn !== null && m.turn !== '') {
      const t = Number(m.turn);
      if (!Number.isInteger(t) || t < 0) throw new HttpError(400, 'match.turn must be a whole number ≥ 0');
      out.turn = t;
    }
    if (typeof m.stream === 'boolean') out.stream = m.stream;
    return out;
  }

  private fields(input: J, prev: LlmMock | null): Partial<MockFields> {
    const f: Partial<MockFields> = {};
    if (input.name !== undefined) f.name = String(input.name ?? '').slice(0, 120);
    if (input.provider !== undefined) {
      const p = String(input.provider || 'any');
      if (!PROVIDERS.includes(p)) throw new HttpError(400, 'provider must be openai, anthropic or any');
      f.provider = p as LlmMock['provider'];
    }
    if (input.match !== undefined) f.match = this.checkMatch(input.match);
    let responses: unknown[] | undefined;
    if (input.responses !== undefined) {
      if (!Array.isArray(input.responses)) throw new HttpError(400, 'responses must be an array');
      responses = input.responses;
    } else if (input.response !== undefined) responses = [input.response];
    else if (input.text !== undefined || input.toolCalls !== undefined) responses = [{ text: input.text, toolCalls: input.toolCalls, stopReason: input.stopReason, usage: input.usage, chunk: input.chunk }];
    if (responses) f.responses = responses.map((r, i) => this.checkResponse(r, i));
    if (input.mode !== undefined) {
      if (!LLM_MOCK_MODES.includes(input.mode as never)) throw new HttpError(400, 'mode must be first, sequence or cycle');
      f.mode = input.mode as LlmMock['mode'];
    }
    if (input.fault !== undefined) f.fault = input.fault === null || input.fault === '' ? null : parseFault(input.fault)!.spec;
    const times = input.times !== undefined ? input.times : input.remaining;
    if (times !== undefined) {
      if (times === null || times === '') f.remaining = null;
      else {
        const t = Number(times);
        if (!Number.isInteger(t) || t < 0) throw new HttpError(400, 'times must be a whole number ≥ 0 (or null for unlimited)');
        f.remaining = t;
      }
    }
    if (input.enabled !== undefined) f.enabled = input.enabled !== false;
    if (input.position !== undefined && input.position !== null) f.position = Math.floor(Number(input.position) || 0);
    const next = { ...(prev ?? {}), ...f } as Partial<LlmMock>;
    if (!next.fault && !(next.responses ?? []).length) throw new HttpError(400, 'A mock needs at least one response ({"text": "…"} / toolCalls) or a fault');
    return f;
  }

  createMock(project: Project, input: J, run: Run | null = null): LlmMock {
    const f = this.fields(input, null);
    const m = this.repo.insertMock(project.id, {
      runId: run?.id ?? null,
      name: f.name || autoName(f),
      position: f.position ?? this.repo.nextPosition(project.id),
      enabled: f.enabled ?? true,
      provider: f.provider ?? 'any',
      match: f.match ?? {},
      responses: f.responses ?? [],
      mode: f.mode ?? 'first',
      fault: f.fault ?? null,
      remaining: f.remaining ?? null,
      source: 'manual',
      recordingId: null,
      requestHash: null,
    });
    this.changed(project.id, { mock: m.id });
    return m;
  }

  requireMock(project: Project, id: string): LlmMock {
    const m = this.repo.getMock(project.id, id);
    if (!m) throw new HttpError(404, `LLM mock "${id}" not found`);
    return m;
  }

  updateMock(project: Project, id: string, input: J): LlmMock {
    const prev = this.requireMock(project, id);
    const f = this.fields(input, prev);
    // A recorded row whose match is edited by hand no longer replays by hash.
    if (f.match && prev.requestHash) f.requestHash = input.keepHash === true ? prev.requestHash : null;
    const m = this.repo.updateMock(prev, f);
    this.changed(project.id, { mock: m.id });
    return m;
  }

  deleteMock(project: Project, id: string): void {
    this.requireMock(project, id);
    this.repo.deleteMock(id);
    this.changed(project.id, { mock: id, deleted: true });
  }

  deleteMocks(project: Project, o: { run?: Run | null; source?: string } = {}): number {
    const n = this.repo.deleteMocks(project.id, { ...(o.run ? { runId: o.run.id } : {}), ...(o.source ? { source: o.source } : {}) });
    this.changed(project.id, { deleted: n });
    return n;
  }

  reorder(project: Project, ids: unknown): LlmMock[] {
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array of mock ids (new order)');
    const all = this.repo.listMocks(project.id, { all: true });
    const known = new Set(all.map((m) => m.id));
    const order = ids.map(String).filter((id) => known.has(id));
    for (const m of all) if (!order.includes(m.id)) order.push(m.id);
    this.repo.setPositions(order);
    this.changed(project.id, { reordered: true });
    return this.repo.listMocks(project.id, { all: true });
  }

  /** Shorthand fault rule: a mock with no responses, first in line, optionally limited to n requests. */
  addFault(project: Project, input: J, run: Run | null): LlmMock {
    const fault = parseFault(input.fault)!;
    const provider = input.provider ? String(input.provider) : 'any';
    if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'provider must be openai, anthropic or any');
    const times = input.times === undefined || input.times === null || input.times === '' ? null : Number(input.times);
    if (times !== null && (!Number.isInteger(times) || times < 1)) throw new HttpError(400, 'times must be a whole number ≥ 1 (leave it out for every request)');
    const match = this.checkMatch(input.match);
    const m = this.repo.insertMock(project.id, {
      runId: run?.id ?? null,
      name: `Fault: ${fault.spec}${times !== null ? ` ×${times}` : ''}`,
      position: this.repo.minPosition(project.id) - 1,
      enabled: true,
      provider: provider as LlmMock['provider'],
      match,
      responses: [],
      mode: 'first',
      fault: fault.spec,
      remaining: times,
      source: 'manual',
      recordingId: null,
      requestHash: null,
    });
    this.changed(project.id, { fault: m.id });
    return m;
  }

  clearFaults(project: Project, run: Run | null): number {
    const n = this.repo.deleteMocks(project.id, { faultsOnly: true, ...(run ? { runId: run.id } : {}) });
    this.changed(project.id, { faultsCleared: n });
    return n;
  }

  // ------------------------------------------------------------------ resolve a request

  /**
   * Fault first (header, then fault rules), then content: an exact recorded request-hash hit beats field matching;
   * run-scoped rows are checked before project rows, each by position; the first match wins.
   */
  pick(projectId: string, req: CanonRequest, runId: string | null, header: string | null, o: { content?: boolean } = {}): Pick & { unknownHeader?: string } {
    const all = this.repo.listMocks(projectId, { runId });
    const ordered = [...all.filter((m) => m.runId), ...all.filter((m) => !m.runId)];
    const out: Pick & { unknownHeader?: string } = { fault: null, faultSource: null, faultMock: null, mock: null, response: null, hashHit: false, misses: [] };
    if (header) {
      const f = parseFault(header, false);
      if (f) (out.fault = f), (out.faultSource = 'header');
      else out.unknownHeader = header;
    }
    const faultRules = ordered.filter((m) => m.fault && !m.responses.length);
    const content = o.content === false ? [] : ordered.filter((m) => m.responses.length);
    if (!out.fault) {
      for (const m of faultRules) {
        if (!m.enabled) continue;
        if (whyNot(m, req) === null) {
          out.fault = parseFault(m.fault, false);
          out.faultSource = 'rule';
          out.faultMock = m;
          this.repo.hit(m.id);
          break;
        }
      }
    }
    const hash = req.messages.length && o.content !== false ? requestHash(req) : null;
    if (hash) {
      const h = content.find((m) => m.enabled && m.requestHash === hash && (m.remaining === null || m.remaining > 0) && (m.provider === 'any' || m.provider === req.provider));
      if (h) {
        out.mock = h;
        out.hashHit = true;
      }
    }
    if (!out.mock) {
      for (const m of content) {
        if (!m.enabled) {
          out.misses.push({ id: m.id, name: m.name, reason: 'disabled' });
          continue;
        }
        const why = whyNot(m, req);
        if (why === null) {
          out.mock = m;
          break;
        }
        out.misses.push({ id: m.id, name: m.name, reason: why });
      }
    }
    if (out.mock) {
      const m = out.mock;
      out.response = m.responses[pickIndex(m.mode, m.hits, m.responses.length)];
      this.repo.hit(m.id);
      if (!out.fault && m.fault) {
        out.fault = parseFault(m.fault, false);
        out.faultSource = 'mock';
      }
      this.changed(projectId, { hit: m.id });
    }
    return out;
  }

  // ------------------------------------------------------------------ calls

  logCall(c: Omit<LlmCall, 'id' | 'createdAt'>): LlmCall {
    const call = this.repo.insertCall(c);
    this.changed(c.projectId, { call: call.id, mode: call.mode });
    return call;
  }

  callMatches(c: LlmCall, f: { provider?: string; endpoint?: string; model?: string; contains?: string; mode?: string; runId?: string }): boolean {
    if (f.runId && c.runId !== f.runId) return false;
    if (f.provider && c.provider !== f.provider) return false;
    if (f.endpoint && c.endpoint !== f.endpoint) return false;
    if (f.mode && !f.mode.split(',').map((s) => s.trim()).includes(c.mode)) return false;
    if (f.model && !globMatch(f.model, c.model ?? '')) return false;
    if (f.contains && !JSON.stringify(c.request ?? '').toLowerCase().includes(f.contains.toLowerCase())) return false;
    return true;
  }

  /** Long-poll for the newest call after `after` matching the filter (null on timeout). */
  async waitCall(project: Project, f: { provider?: string; endpoint?: string; model?: string; contains?: string; mode?: string; runId?: string; after?: string }, timeoutMs: number): Promise<LlmCall | null> {
    const deadline = Date.now() + Math.max(0, Math.min(60_000, timeoutMs));
    const after = f.after ?? new Date(0).toISOString();
    for (;;) {
      const hit = this.repo.listCalls(project.id, { runId: f.runId, after, limit: 200 }).find((c) => this.callMatches(c, f));
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ------------------------------------------------------------------ recordings

  startRecording(project: Project, input: J, run: Run | null): LlmRecording {
    const ref = String(input.provider ?? '').trim();
    if (!ref) throw new HttpError(400, 'provider is required: the name or id of an AI provider (System → AI providers), e.g. "env:openai"');
    const chat = this.hub.chat;
    if (!chat) throw new HttpError(400, 'AI providers are not available');
    const p = chat.providers.get(ref);
    if (!p) throw new HttpError(404, `AI provider "${ref}" not found. Add it under System → AI providers${ref.startsWith('env:') ? ' or set its environment variable' : ''}.`);
    if (p.kind === 'google') throw new HttpError(400, 'Google Gemini has its own API format; record-to-mock supports OpenAI(-compatible) and Anthropic providers only');
    if (!p.enabled) throw new HttpError(400, `AI provider "${p.name}" is disabled`);
    const resolved = chat.providers.resolve(p);
    const needsKey = !(p.kind === 'openai-compatible' && p.preset !== 'openrouter');
    if (needsKey && !resolved.apiKey) throw new HttpError(400, `AI provider "${p.name}" has no API key`);
    const kind = p.kind === 'anthropic' ? 'anthropic' : 'openai';
    const active = this.repo.activeRecording(project.id, kind);
    if (active) throw new HttpError(409, `A ${kind} recording is already active ("${active.name}"). Stop it first.`, { recording: this.viewRecording(active) });
    const mode = input.mode === undefined || input.mode === null || input.mode === '' ? 'new' : String(input.mode);
    if (mode !== 'new' && mode !== 'all') throw new HttpError(400, 'mode must be "new" (only requests no mock answers) or "all"');
    // Limits: a recording forwards to the real provider on the stored key, so it stops by itself.
    const limit = (key: string, def: number, max: number) => {
      const v = input[key];
      if (v === undefined || v === null || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${key} must be a whole number from 1 to ${max}`);
      return n;
    };
    const maxCalls = limit('maxCalls', RECORDING_MAX_CALLS, 10_000);
    const ttlMinutes = limit('ttlMinutes', RECORDING_TTL_MINUTES, 24 * 60);
    const rec = this.repo.insertRecording(project.id, {
      runId: run?.id ?? null,
      name: input.name ? String(input.name).slice(0, 80) : `${p.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      providerRef: p.env ? p.name : p.id,
      kind,
      mode,
      maxCalls,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    });
    this.changed(project.id, { recording: rec.id });
    return rec;
  }

  stopRecording(project: Project, id: string | null): LlmRecording[] {
    const list = id ? [this.requireRecording(project, id)] : this.repo.listRecordings(project.id).filter((r) => r.status === 'active');
    for (const r of list) this.repo.stopRecording(r.id, 'manual');
    this.changed(project.id, { recordingsStopped: list.length });
    return list.map((r) => this.repo.getRecording(project.id, r.id)!);
  }

  requireRecording(project: Project, id: string): LlmRecording {
    const r = this.repo.getRecording(project.id, id);
    if (!r) throw new HttpError(404, `Recording "${id}" not found`);
    return r;
  }

  /** Save one recorded exchange as a mock (an earlier recording of the same request is replaced). */
  saveRecorded(rec: LlmRecording, req: CanonRequest, res: CanonResponse): LlmMock {
    const hash = requestHash(req);
    const lu = lastUserText(req);
    const match: LlmMatch = { endpoint: req.endpoint, model: req.model, turn: turnOf(req), ...(lu ? { lastUser: { equals: lu } } : {}) };
    const prev = this.repo.byHash(rec.projectId, hash).find((m) => m.source === 'recorded' && m.provider === req.provider);
    const m = prev
      ? this.repo.updateMock(prev, { responses: [res], match })
      : this.repo.insertMock(rec.projectId, {
          runId: null,
          name: `Recorded: ${lu.replace(/\s+/g, ' ').slice(0, 60) || req.endpoint}${turnOf(req) ? ` (turn ${turnOf(req)})` : ''}`,
          position: this.repo.nextPosition(rec.projectId),
          enabled: true,
          provider: req.provider,
          match,
          responses: [res],
          mode: 'first',
          fault: null,
          remaining: null,
          source: 'recorded',
          recordingId: rec.id,
          requestHash: hash,
        });
    this.repo.countRecorded(rec.id);
    this.changed(rec.projectId, { recorded: m.id });
    return m;
  }

  // ------------------------------------------------------------------ settings

  settings(projectId: string): LlmSettings {
    return this.repo.settings(projectId);
  }

  updateSettings(project: Project, input: J): LlmSettings {
    const s = this.repo.settings(project.id);
    if (input.fallback !== undefined) {
      if (!['error', 'echo', 'text'].includes(String(input.fallback))) throw new HttpError(400, 'fallback must be error, echo or text');
      s.fallback = input.fallback as LlmSettings['fallback'];
    }
    if (input.fallbackText !== undefined) s.fallbackText = String(input.fallbackText ?? '').slice(0, 20_000);
    if (isObj(input.defaultChunk)) {
      const size = Number(input.defaultChunk.size ?? s.defaultChunk.size);
      const delayMs = Number(input.defaultChunk.delayMs ?? s.defaultChunk.delayMs);
      if (!(size >= 1 && size <= 10_000)) throw new HttpError(400, 'defaultChunk.size must be 1–10000 characters');
      if (!(delayMs >= 0 && delayMs <= 10_000)) throw new HttpError(400, 'defaultChunk.delayMs must be 0–10000');
      s.defaultChunk = { size: Math.floor(size), delayMs: Math.floor(delayMs) };
    }
    if (input.models !== undefined) {
      if (!Array.isArray(input.models)) throw new HttpError(400, 'models must be an array of model ids');
      s.models = [...new Set(input.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 200);
    }
    this.repo.saveSettings(project.id, s);
    this.changed(project.id, { settings: true });
    return s;
  }

  /** Model ids for GET /v1/models: defaults, settings.models and the exact model names used in mocks. */
  models(projectId: string, provider: 'openai' | 'anthropic'): string[] {
    const fromMocks = this.repo
      .listMocks(projectId, { all: true })
      .filter((m) => m.provider === provider || m.provider === 'any')
      .map((m) => m.match.model)
      .filter((x): x is string => !!x && !/[*?]/.test(x))
      .filter((x) => (provider === 'anthropic' ? x.startsWith('claude') : !x.startsWith('claude')));
    return [...new Set([...this.repo.settings(projectId).models, ...fromMocks, ...DEFAULT_MODELS[provider]])];
  }

  // ------------------------------------------------------------------ lifecycle hooks

  /** A run stopped: its own mocks and fault rules go, its recordings stop. */
  onRunStopped(runId: string): void {
    this.repo.deleteRunMocks(runId);
    this.repo.stopRunRecordings(runId);
  }

  /** A run is purged: its call log goes. */
  purgeRun(runId: string): void {
    this.repo.deleteRunCalls(runId);
  }

  /** Project reset: calls and recordings go, recordings stop; mocks and settings stay (hit counters back to 0). */
  resetProject(projectId: string): void {
    this.repo.deleteCalls(projectId);
    this.repo.deleteRecordings(projectId);
    this.repo.resetHits(projectId);
    this.changed(projectId, { reset: true });
  }

  // ------------------------------------------------------------------ views

  viewMock(m: LlmMock) {
    const run = m.runId ? this.hub.runs.repo.get(m.runId) : null;
    return { ...m, run: run ? run.key : null, kind: m.fault && !m.responses.length ? ('fault' as const) : ('mock' as const) };
  }

  viewCall(c: LlmCall, detail = false) {
    const run = c.runId ? this.hub.runs.repo.get(c.runId) : null;
    const req = (c.request ?? {}) as J;
    const res = (c.response ?? {}) as J;
    const mock = c.mockId ? this.repo.getMock(c.projectId, c.mockId) : null;
    const base = {
      id: c.id,
      provider: c.provider,
      endpoint: c.endpoint,
      model: c.model,
      stream: c.stream,
      mode: c.mode,
      mock: c.mockId ? { id: c.mockId, name: mock?.name ?? '(deleted)' } : null,
      fault: c.fault,
      status: c.status,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      durationMs: c.durationMs,
      run: run?.key ?? null,
      logId: c.logId,
      lastUser: typeof req.lastUser === 'string' ? req.lastUser : '',
      turn: typeof req.turn === 'number' ? req.turn : null,
      reply: typeof res.text === 'string' ? res.text : '',
      toolCalls: Array.isArray(res.toolCalls) ? (res.toolCalls as J[]).map((t) => t.name) : [],
      createdAt: c.createdAt,
    };
    return detail ? { ...base, request: c.request, response: c.response } : base;
  }

  viewRecording(r: LlmRecording) {
    const run = r.runId ? this.hub.runs.repo.get(r.runId) : null;
    const ttlMinutes = r.expiresAt ? Math.round((Date.parse(r.expiresAt) - Date.parse(r.createdAt)) / 60_000) : null;
    return { ...r, run: run?.key ?? null, ttlMinutes, callsLeft: r.status === 'active' ? Math.max(0, r.maxCalls - r.forwarded) : 0 };
  }

  /** Base URLs, env vars and copy-paste snippets. */
  connect(project: Project, origin: string) {
    const o = trimEnd(origin, '/');
    const openai = `${o}/llm/${project.slug}/openai/v1`;
    const anthropic = `${o}/llm/${project.slug}/anthropic`;
    const recordings = this.repo.listRecordings(project.id).filter((r) => r.status === 'active').map((r) => this.viewRecording(r));
    return {
      openai: { baseUrl: openai, env: { OPENAI_BASE_URL: openai, OPENAI_API_KEY: 'sk-test-stubyard' } },
      anthropic: { baseUrl: anthropic, env: { ANTHROPIC_BASE_URL: anthropic, ANTHROPIC_API_KEY: 'sk-ant-test-stubyard' } },
      runPrefix: `${o}/run/<run-key>/llm/${project.slug}/…`,
      endpoints: [
        'POST /llm/<p>/openai/v1/chat/completions',
        'POST /llm/<p>/openai/v1/responses',
        'POST /llm/<p>/openai/v1/embeddings',
        'GET  /llm/<p>/openai/v1/models[/<id>]',
        'POST /llm/<p>/anthropic/v1/messages',
        'POST /llm/<p>/anthropic/v1/messages/count_tokens',
        'GET  /llm/<p>/anthropic/v1/models[/<id>]',
      ],
      faults: FAULT_HELP,
      recordings,
      snippets: [
        { title: '.env', code: `OPENAI_BASE_URL=${openai}\nOPENAI_API_KEY=sk-test-stubyard\nANTHROPIC_BASE_URL=${anthropic}\nANTHROPIC_API_KEY=sk-ant-test-stubyard` },
        { title: 'OpenAI SDK (Node)', code: `import OpenAI from 'openai';\n\nconst openai = new OpenAI({\n  baseURL: '${openai}',\n  apiKey: 'sk-test-stubyard', // any value; never stored\n  // defaultHeaders: { 'X-Hub-Run': 'w1' }, // attribute calls to a test run\n});` },
        { title: 'Anthropic SDK (Node)', code: `import Anthropic from '@anthropic-ai/sdk';\n\nconst anthropic = new Anthropic({\n  baseURL: '${anthropic}',\n  apiKey: 'sk-ant-test-stubyard',\n});` },
        { title: 'Python', code: `from openai import OpenAI\nfrom anthropic import Anthropic\n\nopenai = OpenAI(base_url="${openai}", api_key="sk-test-stubyard")\nanthropic = Anthropic(base_url="${anthropic}", api_key="sk-ant-test-stubyard")` },
        { title: 'Vercel AI SDK', code: `import { createOpenAI } from '@ai-sdk/openai';\nimport { createAnthropic } from '@ai-sdk/anthropic';\n\nconst openai = createOpenAI({ baseURL: '${openai}', apiKey: 'test' });\n// the AI SDK wants the /v1 suffix for Anthropic\nconst anthropic = createAnthropic({ baseURL: '${anthropic}/v1', apiKey: 'test' });` },
        { title: 'curl', code: `curl ${openai}/chat/completions -H 'content-type: application/json' \\\n  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Hello"}]}'` },
        { title: 'Script a reply', code: `curl -X POST ${o}/api/projects/${project.slug}/llm/mocks -H 'content-type: application/json' \\\n  -d '{"name":"greeting","match":{"lastUser":{"contains":"hello"}},"responses":[{"text":"Hi! How can I help?"}]}'` },
      ],
    };
  }

  changed(projectId: string, data: unknown): void {
    this.hub.bus.publish({ type: 'llm.changed', projectId, data });
  }
}

function autoName(f: Partial<MockFields>): string {
  const m = f.match ?? {};
  if (m.lastUser?.contains) return `"${m.lastUser.contains.slice(0, 40)}"`;
  if (m.lastUser?.equals) return `= "${m.lastUser.equals.slice(0, 40)}"`;
  if (m.toolResult) return `after ${m.toolResult.name ?? 'tool'} result`;
  if (m.model) return m.model;
  if (f.fault && !(f.responses ?? []).length) return `Fault: ${f.fault}`;
  return 'Any request';
}

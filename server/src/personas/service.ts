import type { Hub } from '../hub.js';
import type { AutoReplyRule, AutoReplySpec, ReplyPlan } from '../autoreplies/types.js';
import type { TriggerView } from '../autoreplies/service.js';
import { runOnce, type ChatUIMessage } from '../chat/engine.js';
import { isMockRef, scrub } from '../chat/keys.js';
import { replyOptions } from '../messages/simulator.js';
import type { Channel } from '../providers/catalog.js';
import type { Message } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import type { TestUser } from '../repos/users.js';
import { HttpError, slugify } from '../util.js';
import {
  buildSystem,
  clipText,
  controlLines,
  escapeHtml,
  historyMessages,
  maxCharsFor,
  MAX_NOTES,
  MAX_RAW,
  newNonce,
  parseOutput,
  type HistoryItem,
  type PromptMessage,
} from './prompt.js';
import { PersonaRepo, type PersonaFields } from './repo.js';
import {
  ENDED_STATES,
  LIMIT_DEFAULTS,
  LIMIT_MAX,
  THREAD_STATES,
  type GoalState,
  type Persona,
  type PersonaControls,
  type PersonaGoal,
  type PersonaLimits,
  type PersonaStyle,
  type PersonaThread,
  type PersonaThreadState,
  type PersonaTurn,
  type PersonaTurnStatus,
} from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: J, k: string) => o[k] !== undefined;
const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];
/** Outbound statuses that never reached the user: left out of the history. */
const NOT_RECEIVED = ['failed', 'bounced', 'rejected', 'dropped', 'scheduled', 'undelivered'];
/** Model errors in a row that end a thread (state error). */
export const MAX_ERRORS_IN_A_ROW = 3;

/** What the auto-reply fire stores in FirePlan.persona. */
export interface PersonaFireInfo {
  personaId: string;
  name: string;
  threadId: string | null;
  turnId: string | null;
  status: PersonaTurnStatus | null;
  usage: { inputTokens: number; outputTokens: number };
  goals: Record<string, GoalState>;
}

export interface PersonaReplyResult {
  plan: ReplyPlan | null;
  warnings: string[];
  /** send: plan is set; skip: nothing to send (reason); fail: the model call failed (reason, scrubbed). */
  outcome: 'send' | 'skip' | 'fail';
  reason: string | null;
  persona: PersonaFireInfo | null;
}

interface ModelRun {
  raw: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string | null;
  durationMs: number;
  toolCalls: string[];
  error: string | null;
  provider: string;
}

const PRESET_LIST = [
  {
    id: 'cooperative',
    name: 'Cooperative customer',
    description: 'Answers what is asked and sends codes back.',
    persona: {
      name: 'Cooperative customer',
      prompt: 'A friendly, cooperative customer. You answer exactly what the app asks. When a message contains a code, you send the code back on its own. You keep replies short.',
      goals: [{ id: 'code', text: 'Get the login code and send it back' }],
    },
  },
  {
    id: 'confused',
    name: 'Confused customer',
    description: 'Asks one clarifying question first, then cooperates.',
    persona: {
      name: 'Confused customer',
      prompt: 'A customer who is not sure what the message is about. Your first reply is one short clarifying question (for example "what is this code for?"). After the app answers, you cooperate and do what it asks.',
      goals: [{ id: 'understand', text: 'Understand what the message is for, then do what it asks' }],
    },
  },
  {
    id: 'impatient',
    name: 'Impatient customer',
    description: 'Short replies, wants a human.',
    persona: {
      name: 'Impatient customer',
      prompt: 'An impatient customer in a hurry. You write very short replies, sometimes without punctuation. You ask to talk to a human after the second message from the app.',
      goals: [{ id: 'human', text: 'Get handed over to a human agent' }],
      style: { tone: 'curt' },
    },
  },
  {
    id: 'opt-out',
    name: 'Opt-out',
    description: 'Replies STOP once, then stays silent.',
    persona: {
      name: 'Opt-out',
      prompt: 'A customer who does not want these messages. Your first reply is exactly STOP. After that you never reply again: answer with [[NO_REPLY]] only.',
      goals: [{ id: 'stop', text: 'Opt out with STOP' }],
      limits: { maxReplies: 2 },
    },
  },
  {
    id: 'wrong-code',
    name: 'Wrong code first',
    description: 'Sends one wrong code, then the right one.',
    persona: {
      name: 'Wrong code first',
      prompt: 'A customer who makes a typo. The first time you get a code, you send it back with the last two digits swapped. When the app says the code is wrong, you send the correct code from the first message. Remember the code in a [[NOTE: …]] line.',
      goals: [{ id: 'login', text: 'Log in with the right code after one wrong attempt' }],
    },
  },
];
export const PERSONA_PRESETS = PRESET_LIST;

const str = (v: unknown, field: string, max: number): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
  return s;
};

/** hub.personas: AI personas (§AE). Persona rules are auto-reply rules whose reply is {persona}. */
export class PersonaService {
  readonly repo: PersonaRepo;
  /** Pause before the one retry of a 429 / 5xx (tests shorten it). */
  retryDelayMs = 5000;
  private chains = new Map<string, Promise<unknown>>();

  constructor(private hub: Hub) {
    this.repo = new PersonaRepo(hub.db);
  }

  changed(projectId: string, data: J = {}): void {
    this.hub.bus.publish({ type: 'personas.changed', projectId, data });
  }

  // ------------------------------------------------------------------ personas

  require(project: Project, ref: string): Persona {
    const p = this.repo.get(project.id, String(ref ?? '').trim());
    if (!p) throw new HttpError(404, `Persona "${ref}" not found`);
    return p;
  }

  private limits(v: unknown, prev: PersonaLimits): PersonaLimits {
    if (v === undefined || v === null) return prev;
    if (!isObj(v)) throw new HttpError(400, 'limits must be an object');
    const out: PersonaLimits = { ...prev };
    for (const [k, raw] of Object.entries(v)) {
      if (raw === undefined || raw === null || raw === '') continue;
      if (k === 'endWhenDone') {
        if (typeof raw !== 'boolean') throw new HttpError(400, 'limits.endWhenDone must be true or false');
        out.endWhenDone = raw;
        continue;
      }
      if (!(k in LIMIT_MAX)) throw new HttpError(400, `limits.${k} is not a limit (${[...Object.keys(LIMIT_MAX), 'endWhenDone'].join(', ')})`);
      const n = Number(raw);
      const max = LIMIT_MAX[k as keyof typeof LIMIT_MAX];
      if (k === 'temperature') {
        if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `limits.temperature must be between 0 and ${max}`);
        out.temperature = n;
        continue;
      }
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `limits.${k} must be a whole number ≥ 1`);
      if (n > max) throw new HttpError(400, `limits.${k} must be at most ${max}`);
      (out as unknown as Record<string, number>)[k] = n;
    }
    return out;
  }

  private goals(v: unknown): PersonaGoal[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'goals must be a list of sentences (or {id, text})');
    if (v.length > 10) throw new HttpError(400, 'at most 10 goals');
    const seen = new Set<string>();
    return v.map((g, i) => {
      const o = typeof g === 'string' ? { text: g } : isObj(g) ? g : null;
      if (!o || !String(o.text ?? '').trim()) throw new HttpError(400, `goals[${i}] needs a text`);
      const text = String(o.text).trim();
      if (text.length > 300) throw new HttpError(400, `goals[${i}] is longer than 300 characters`);
      let id = o.id !== undefined && o.id !== null && o.id !== '' ? String(o.id).trim() : `g${i + 1}`;
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, `goals[${i}].id must be 1–40 letters, digits, _ or -`);
      while (seen.has(id)) id = `${id}-2`;
      seen.add(id);
      return { id, text };
    });
  }

  private style(v: unknown): PersonaStyle {
    if (v === undefined || v === null) return {};
    if (!isObj(v)) throw new HttpError(400, 'style must be an object {language?, tone?, maxChars?}');
    for (const k of Object.keys(v)) if (!['language', 'tone', 'maxChars'].includes(k)) throw new HttpError(400, `style.${k} is not supported (language, tone, maxChars)`);
    const out: PersonaStyle = {};
    const lang = str(v.language, 'style.language', 60);
    if (lang) out.language = lang;
    const tone = str(v.tone, 'style.tone', 200);
    if (tone) out.tone = tone;
    if (v.maxChars !== undefined && v.maxChars !== null && v.maxChars !== '') {
      const n = Number(v.maxChars);
      if (!Number.isInteger(n) || n < 1 || n > 4000) throw new HttpError(400, 'style.maxChars must be a whole number from 1 to 4000');
      out.maxChars = n;
    }
    return out;
  }

  private uniqueSlug(projectId: string, base: string, exceptId?: string): string {
    const b = slugify(base).slice(0, 60) || 'persona';
    let s = b;
    for (let i = 2; this.repo.slugTaken(projectId, s, exceptId); i++) s = `${b}-${i}`;
    return s;
  }

  /** Validates input into persona fields (400 on bad input). Provider + model are checked through hub.chat.modelFor. */
  fields(project: Project, input: J, prev: Persona | null, opts: { checkProvider?: boolean } = {}): Partial<PersonaFields> {
    if (!isObj(input)) throw new HttpError(400, 'Body must be a JSON object');
    const known = ['name', 'slug', 'enabled', 'provider', 'model', 'agent', 'prompt', 'goals', 'style', 'limits', 'fallback', 'opener'];
    for (const k of Object.keys(input)) if (!known.includes(k)) throw new HttpError(400, `${k} is not a persona field (${known.join(', ')})`);
    const f: Partial<PersonaFields> = {};
    if (has(input, 'name')) {
      const n = String(input.name ?? '').trim().slice(0, 120);
      if (!n) throw new HttpError(400, 'name is required');
      f.name = n;
    }
    if (has(input, 'slug') && input.slug) {
      const s = slugify(String(input.slug)).slice(0, 60);
      if (!s) throw new HttpError(400, 'slug must contain letters or digits');
      if (this.repo.slugTaken(project.id, s, prev?.id)) throw new HttpError(409, `A persona with slug "${s}" exists`);
      f.slug = s;
    }
    if (has(input, 'enabled')) {
      if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
      f.enabled = input.enabled;
    }
    if (input.agent) {
      const a = this.hub.chat.repo.requireAgent(project.id, String(input.agent));
      f.provider = a.provider;
      f.model = a.model;
    }
    if (has(input, 'provider') && input.provider) f.provider = String(input.provider).trim().slice(0, 120);
    if (has(input, 'model') && input.model) f.model = String(input.model).trim().slice(0, 200);
    if (has(input, 'prompt')) f.prompt = str(input.prompt, 'prompt', 8000) ?? '';
    if (has(input, 'goals')) f.goals = this.goals(input.goals);
    if (has(input, 'style')) f.style = this.style(input.style);
    if (has(input, 'limits')) f.limits = this.limits(input.limits, prev?.limits ?? LIMIT_DEFAULTS);
    if (has(input, 'fallback')) f.fallback = str(input.fallback, 'fallback', 2000);
    if (has(input, 'opener')) f.opener = str(input.opener, 'opener', 4000);
    const provider = f.provider ?? prev?.provider;
    const model = f.model ?? prev?.model;
    if (!provider || !model) throw new HttpError(400, 'provider and model are required (e.g. {"provider": "mock:openai", "model": "gpt-5-mini"}), or agent: <chat agent id> to copy them');
    if (opts.checkProvider !== false && (f.provider || f.model)) this.hub.chat.modelFor(provider, model, project);
    return f;
  }

  create(project: Project, input: J, run: Run | null): Persona {
    const f = this.fields(project, input, null);
    if (!f.name) throw new HttpError(400, 'name is required');
    const p = this.repo.create(project.id, run?.id ?? null, {
      slug: f.slug ?? this.uniqueSlug(project.id, f.name),
      name: f.name,
      enabled: f.enabled ?? true,
      provider: f.provider!,
      model: f.model!,
      prompt: f.prompt ?? '',
      goals: f.goals ?? [],
      style: f.style ?? {},
      limits: f.limits ?? { ...LIMIT_DEFAULTS },
      fallback: f.fallback ?? null,
      opener: f.opener ?? null,
    });
    this.changed(project.id, { persona: p.id, created: true });
    return p;
  }

  update(project: Project, ref: string, input: J): Persona {
    const prev = this.require(project, ref);
    const p = this.repo.update(prev.id, this.fields(project, input, prev))!;
    this.changed(project.id, { persona: p.id });
    return p;
  }

  /** Deletes the persona, its threads and turns, and the auto-reply rules that use it. */
  delete(project: Project, ref: string): { rules: number } {
    const p = this.require(project, ref);
    const rules = this.rulesOf(p);
    for (const r of rules) this.hub.autoReplies.deleteRule(project, r.id);
    this.repo.delete(p.id);
    this.changed(project.id, { persona: p.id, deleted: true });
    return { rules: rules.length };
  }

  rulesOf(p: Persona): AutoReplyRule[] {
    return this.hub.autoReplies.repo.listRules(p.projectId, { all: true }).filter((r) => r.reply.persona === p.id);
  }

  /** POST /:id/assign: an auto-reply rule {match.user | match.role, reply.persona}, first in line. */
  assign(project: Project, ref: string, input: J, run: Run | null): AutoReplyRule {
    const p = this.require(project, ref);
    if (!isObj(input)) throw new HttpError(400, 'Body must be a JSON object');
    const match: J = {};
    let label: string;
    if (input.user) {
      const u = this.hub.users.requireRef(project.id, String(input.user), run?.id ?? null);
      match.user = u.id;
      label = u.name;
    } else if (input.role) {
      match.role = String(input.role).trim();
      label = `role ${match.role}`;
    } else throw new HttpError(400, 'user (id, email, phone or name) or role is required');
    const channel = input.channel ? String(input.channel) : 'any';
    const scope = this.hub.autoReplies.repo.listRules(project.id, run ? { runId: run.id } : {});
    const first = scope.length ? Math.min(...scope.map((r) => r.position)) - 1 : 0;
    const reply: J = { persona: p.id };
    if (input.instruction) reply.instruction = input.instruction;
    const rule = this.hub.autoReplies.createRule(
      project,
      {
        name: `Persona: ${p.name} → ${label}`,
        channel,
        match,
        reply,
        delaySeconds: input.delaySeconds ?? input.delay_seconds ?? 2,
        jitterSeconds: input.jitterSeconds ?? input.jitter_seconds ?? 3,
        stop: true,
        position: first,
      },
      run,
    );
    this.changed(project.id, { persona: p.id, assigned: rule.id });
    return rule;
  }

  // ------------------------------------------------------------------ views

  providerStatus(p: Persona): { ok: boolean; error: string | null } {
    try {
      this.hub.chat.modelFor(p.provider, p.model, this.hub.projects.get(p.projectId));
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  view(p: Persona): J {
    const run = p.runId ? this.hub.runs.repo.get(p.runId) : null;
    const mock = isMockRef(p.provider);
    const st = this.providerStatus(p);
    const assigned = this.rulesOf(p).map((r) => {
      const u = r.match.user ? this.hub.users.get(p.projectId, r.match.user) : null;
      return { ruleId: r.id, name: r.name, enabled: r.enabled, disabledReason: r.disabledReason, channel: r.channel, user: u ? { id: u.id, name: u.name } : r.match.user ? { id: r.match.user, name: r.match.user } : null, role: r.match.role ?? null, run: r.runId ? (this.hub.runs.repo.get(r.runId)?.key ?? null) : null };
    });
    const threads = this.repo.threads(p.projectId, { personaId: p.id, limit: 500 });
    const warnings: string[] = [];
    if (!st.ok && st.error) warnings.push(st.error);
    if (!mock && p.runId) warnings.push(`This test-run persona sends app message content to ${p.provider}. Use mock:openai or mock:anthropic in CI.`);
    return {
      ...p,
      run: run?.key ?? null,
      mock,
      sendsContentTo: mock ? null : p.provider,
      providerOk: st.ok,
      providerError: st.error,
      assigned,
      threads: { total: threads.length, active: threads.filter((t) => t.state === 'active').length },
      today: { ...this.repo.usageToday(p.id), projectCalls: this.repo.callsToday(p.projectId), dailyCalls: p.limits.dailyCalls },
      warnings,
    };
  }

  viewThread(t: PersonaThread): J {
    const p = this.repo.byId(t.personaId);
    const u = this.hub.users.get(t.projectId, t.testUserId);
    const run = t.runId ? this.hub.runs.repo.get(t.runId) : null;
    return {
      ...t,
      persona: p ? { id: p.id, slug: p.slug, name: p.name } : null,
      user: u ? { id: u.id, name: u.name } : null,
      run: run?.key ?? null,
      tokens: t.tokensIn + t.tokensOut,
      limits: p ? { maxReplies: p.limits.maxReplies, maxTokens: p.limits.maxTokens } : null,
      goalList: (p?.goals ?? []).map((g) => ({ ...g, state: t.goals[g.id] ?? 'open' })),
    };
  }

  /** Thread + turns + the transcript (both sides, oldest first). */
  threadDetail(project: Project, id: string): J {
    const t = this.repo.thread(project.id, id);
    if (!t) throw new HttpError(404, `Persona thread "${id}" not found`);
    const turns = this.repo.turnsOf(t.id);
    const firstTrigger = turns.find((x) => x.triggerMessageId)?.triggerMessageId ?? null;
    const byReply = new Map(turns.filter((x) => x.replyMessageId).map((x) => [x.replyMessageId!, x.id]));
    const msgs = this.hub.messages
      .list(project.id, { testUserId: t.testUserId, channel: t.channel, ...(t.runId ? { runId: t.runId } : {}), limit: 200 })
      .filter((m) => (t.runId ? true : m.runId === null) && (m.createdAt >= t.createdAt || (firstTrigger !== null && m.id >= firstTrigger)))
      .reverse()
      .map((m) => ({ id: m.id, direction: m.direction, subject: m.subject, text: clipText(m.bodyText ?? '', 2000), status: m.status, createdAt: m.createdAt, turnId: byReply.get(m.id) ?? null, opener: !!(m.metadata.persona as J | undefined)?.opener }));
    return { ...this.viewThread(t), turns, messages: msgs };
  }

  // ------------------------------------------------------------------ threads

  stopThread(project: Project, id: string, reason = 'manual'): PersonaThread {
    const t = this.repo.thread(project.id, id);
    if (!t) throw new HttpError(404, `Persona thread "${id}" not found`);
    const n = this.repo.updateThread(t.id, { state: 'stopped', stopReason: reason })!;
    this.changed(project.id, { thread: t.id, state: 'stopped' });
    return n;
  }

  resetThread(project: Project, id: string): PersonaThread {
    const t = this.repo.thread(project.id, id);
    if (!t) throw new HttpError(404, `Persona thread "${id}" not found`);
    const p = this.repo.byId(t.personaId);
    const n = this.repo.updateThread(t.id, { state: 'active', stopReason: null, replies: 0, tokensIn: 0, tokensOut: 0, errors: 0, fallbackSent: false, notes: '', goals: Object.fromEntries((p?.goals ?? []).map((g) => [g.id, 'open'])) })!;
    this.changed(project.id, { thread: t.id, reset: true });
    return n;
  }

  stopThreads(project: Project, q: { personaId?: string; runId?: string; testUserId?: string }): number {
    const n = this.repo.setThreadsState({ projectId: project.id, ...q }, ['active'], 'stopped', 'manual').length;
    if (n) this.changed(project.id, { stopped: n });
    return n;
  }

  deleteThreads(project: Project, q: { personaId?: string; runId?: string }): number {
    const n = this.repo.deleteThreads(project.id, q);
    this.changed(project.id, { threadsDeleted: n });
    return n;
  }

  async waitThread(project: Project, q: { personaId?: string; testUserId?: string; state?: string[]; goal?: { id: string; is: string } | null; after?: string; runId?: string }, timeoutMs: number): Promise<PersonaThread | null> {
    const states = q.state?.length ? q.state : q.goal ? undefined : ENDED_STATES;
    for (const s of states ?? []) if (!(THREAD_STATES as string[]).includes(s)) throw new HttpError(400, `state "${s}" is not one of ${THREAD_STATES.join(', ')}`);
    const find = () =>
      this.repo.threads(project.id, { personaId: q.personaId, testUserId: q.testUserId, state: states, runId: q.runId, after: q.after, limit: 100 }).find((t) => !q.goal || (t.goals[q.goal.id] ?? 'open') === q.goal.is) ?? null;
    const now = find();
    if (now || timeoutMs <= 0) return now;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: PersonaThread | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(v);
      };
      const unsub = this.hub.bus.subscribe((e) => {
        if (e.type !== 'personas.changed' || e.projectId !== project.id) return;
        const t = find();
        if (t) finish(t);
      });
      const timer = setTimeout(() => finish(find()), timeoutMs);
    });
  }

  /** POST /:id/start: the opener (or text) as the user's inbound message, no model call. Creates the thread. */
  async start(project: Project, ref: string, input: J, run: Run | null): Promise<J> {
    const p = this.require(project, ref);
    if (!isObj(input)) throw new HttpError(400, 'Body must be a JSON object');
    if (!input.user) throw new HttpError(400, 'user is required (id, email, phone or name)');
    const user = this.hub.users.requireRef(project.id, String(input.user), run?.id ?? null);
    const channel = String(input.channel ?? '').toLowerCase() as Channel;
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'channel must be email, sms or whatsapp');
    const text = input.text ? String(input.text) : p.opener;
    if (!text?.trim()) throw new HttpError(400, 'The persona has no opener: pass text');
    const thread = this.repo.ensureThread({ projectId: project.id, personaId: p.id, testUserId: user.id, channel, runId: run?.id ?? null, goals: Object.fromEntries(p.goals.map((g) => [g.id, 'open'])) });
    const res = await this.hub.simulator.reply(project, user, {
      channel,
      text: clipText(text, 4000),
      instance: input.instance ? String(input.instance) : null,
      subject: channel === 'email' ? String(input.subject ?? 'Hello') : null,
    });
    const updated = this.hub.messages.updateStatus(res.message.id, { metadata: { persona: { personaId: p.id, name: p.name, threadId: thread.id, turnId: null, opener: true } } });
    if (updated) this.hub.bus.publish({ type: 'message.updated', projectId: project.id, data: updated });
    this.repo.updateThread(thread.id, { lastTurnAt: new Date().toISOString() });
    this.changed(project.id, { thread: thread.id, started: true });
    return { thread: this.viewThread(this.repo.threadById(thread.id)!), message: { id: res.message.id }, webhook: res.webhook ? { ok: res.webhook.ok, status: res.webhook.status } : null };
  }

  // ------------------------------------------------------------------ the model call

  /** One call at a time per thread: a second trigger waits and then sees the first reply in its history. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  private errorText = (err: unknown): string => {
    const e = err as { message?: string; statusCode?: number; lastError?: { statusCode?: number } };
    const code = e?.statusCode ?? e?.lastError?.statusCode;
    const msg = e?.message ? String(e.message) : String(err);
    return scrub(`${msg}${typeof code === 'number' && !msg.includes(String(code)) ? ` (HTTP ${code})` : ''}`, this.hub.chat.providers.secrets()).slice(0, 1000);
  };

  private retryable(err: unknown): boolean {
    const e = err as { statusCode?: number; lastError?: { statusCode?: number }; name?: string };
    const code = e?.statusCode ?? e?.lastError?.statusCode;
    return typeof code === 'number' && (code === 429 || code >= 500);
  }

  /**
   * runOnce with no tools, one step, the persona's limits; one retry after retryDelayMs for 429 / 5xx. Never throws.
   * The caller has reserved the first attempt (repo.reserveCall); the retry reserves its own against dailyCalls.
   */
  private async callModel(project: Project, p: Persona, system: string, messages: PromptMessage[]): Promise<ModelRun> {
    const ui: ChatUIMessage[] = messages.map((m, i) => ({ id: `m${i}`, role: m.role, parts: [{ type: 'text', text: m.text }] }) as ChatUIMessage);
    const t0 = Date.now();
    let provider = p.provider;
    for (let attempt = 0; ; attempt++) {
      try {
        const h = this.hub.chat.modelFor(p.provider, p.model, project);
        provider = h.provider.name;
        const r = await runOnce({
          model: h.model,
          system,
          messages: ui,
          tools: [],
          maxSteps: 1,
          maxOutputTokens: p.limits.maxOutputTokens,
          temperature: p.limits.temperature,
          abortSignal: AbortSignal.timeout(p.limits.timeoutMs),
          errorText: this.errorText,
        });
        return { raw: r.text ?? '', usage: r.usage, finishReason: r.finishReason, durationMs: Date.now() - t0, toolCalls: r.toolCalls.map((c) => c.name), error: null, provider };
      } catch (err) {
        if (attempt === 0 && this.retryable(err)) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          if (this.repo.reserveCall(project.id, p.limits.dailyCalls)) continue;
          return { raw: '', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'error', durationMs: Date.now() - t0, toolCalls: [], error: `${this.errorText(err)}; not retried: dailyCalls reached (${p.limits.dailyCalls} model calls today, UTC)`, provider };
        }
        const e = err as { name?: string };
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return { raw: '', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'error', durationMs: Date.now() - t0, toolCalls: [], error: timedOut ? `The model did not answer within ${p.limits.timeoutMs} ms` : this.errorText(err), provider };
      }
    }
  }

  /** The thread's history from the messages table: app → persona, oldest first, the trigger last. */
  history(projectId: string, q: { testUserId: string; channel: Channel; runId: string | null }, trigger: Message | null, maxHistory: number): HistoryItem[] {
    const rows = this.hub.messages
      .list(projectId, { testUserId: q.testUserId, channel: q.channel, ...(q.runId ? { runId: q.runId } : {}), limit: 500 })
      .filter((m) => (q.runId ? true : m.runId === null) && (!trigger || m.id <= trigger.id))
      .filter((m) => m.direction === 'inbound' || !NOT_RECEIVED.includes(m.status));
    if (trigger && !rows.some((m) => m.id === trigger.id)) rows.unshift(trigger);
    return rows
      .slice(0, maxHistory)
      .reverse()
      .map((m) => this.itemOf(m));
  }

  private itemOf(m: Message): HistoryItem {
    return {
      from: m.direction === 'outbound' ? 'app' : 'persona',
      channel: m.channel,
      text: m.bodyText ?? '',
      subject: m.channel === 'email' ? m.subject : null,
      at: m.createdAt,
      buttons: m.direction === 'outbound' && m.channel === 'whatsapp' ? replyOptions(m).map((o) => ({ id: o.id, title: o.title })) : undefined,
    };
  }

  private userFacts(u: Pick<TestUser, 'name' | 'email' | 'phone' | 'role'> | null) {
    return { name: u?.name ?? 'Test user', email: u?.email ?? null, phone: u?.phone ?? null, role: u?.role ?? '' };
  }

  private info(p: Persona, thread: PersonaThread | null, turn: PersonaTurn | null): PersonaFireInfo {
    return { personaId: p.id, name: p.name, threadId: thread?.id ?? null, turnId: turn?.id ?? null, status: turn?.status ?? null, usage: { inputTokens: turn?.tokensIn ?? 0, outputTokens: turn?.tokensOut ?? 0 }, goals: thread?.goals ?? {} };
  }

  /**
   * The persona answers one trigger message (auto-reply fire, or /test with llm: true when dryRun). Never throws:
   * the outcome says whether to send the plan, skip or fail the fire.
   */
  async reply(a: { rule: Pick<AutoReplyRule, 'id' | 'reply' | 'projectId'>; project: Project; message: Message; trigger: TriggerView; user: TestUser; fireId: string | null; dryRun: boolean }): Promise<PersonaReplyResult> {
    const ref = a.rule.reply.persona ?? '';
    const p = this.repo.get(a.project.id, ref);
    if (!p) return { plan: null, warnings: [], outcome: 'skip', reason: `The persona of this rule is gone ("${ref}")`, persona: null };
    if (!p.enabled) return { plan: null, warnings: [], outcome: 'skip', reason: `Persona "${p.name}" is disabled`, persona: this.info(p, null, null) };
    const channel = a.message.channel;
    const runId = a.message.runId;
    const key = { projectId: a.project.id, personaId: p.id, testUserId: a.user.id, channel, runId, goals: Object.fromEntries(p.goals.map((g) => [g.id, 'open'])) };
    const existing = this.repo.findThread(p.id, a.user.id, channel, runId);
    if (a.dryRun) return this.turn(a, p, existing, true);
    const thread = existing ?? this.repo.ensureThread(key);
    return this.serial(thread.id, () => this.turn(a, p, this.repo.threadById(thread.id) ?? thread, false));
  }

  private async turn(a: { rule: Pick<AutoReplyRule, 'id' | 'reply'>; project: Project; message: Message; trigger: TriggerView; user: TestUser; fireId: string | null }, p: Persona, thread: PersonaThread | null, dryRun: boolean): Promise<PersonaReplyResult> {
    const r: AutoReplySpec = a.rule.reply;
    const t = a.trigger;
    const warnings: string[] = [];
    const planChannel: Channel = r.channel ?? t.channel;
    const same = planChannel === t.channel;
    const base = { projectId: a.project.id, personaId: p.id, threadId: thread?.id ?? null, fireId: a.fireId, triggerMessageId: a.message.id, replyMessageId: null, provider: p.provider, model: p.model };
    const record = (x: Partial<PersonaTurn> & { status: PersonaTurnStatus }): PersonaTurn =>
      this.repo.insertTurn({ ...base, text: '', raw: '', controls: null, warnings, tokensIn: 0, tokensOut: 0, durationMs: 0, finishReason: null, error: null, called: false, ...x });
    const routed = (text: string, controls: PersonaControls | null): ReplyPlan => {
      const plan: ReplyPlan = { channel: planChannel, text, instance: r.instance ?? (same ? t.instanceSlug : null) };
      if (planChannel === 'email') {
        const threaded = same && r.thread !== false && !!t.id;
        if (threaded) {
          plan.inReplyTo = t.id;
          if (controls?.subject) warnings.push('[[SUBJECT]] is ignored in a threaded reply (the reply keeps "Re: …")');
        } else {
          plan.subject = controls?.subject || (same && t.subject ? (/^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`) : null);
          if (same && t.from) plan.to = t.from;
        }
        plan.html = text ? `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>` : null;
      }
      if (planChannel === 'whatsapp' && controls?.button) {
        const want = controls.button.trim();
        const buttons = same ? (t.buttons ?? []) : [];
        const nth = /^#(\d+)$/.exec(want);
        const b = nth ? buttons[Number(nth[1]) - 1] : buttons.find((x) => x.id === want || x.title.toLowerCase() === want.toLowerCase());
        if (b) {
          plan.button = b.id;
          if (t.id) plan.contextMessageId = t.id;
        } else warnings.push(`[[BUTTON:${want.slice(0, 40)}]] is not a button of the message; ignored`);
      }
      return plan;
    };
    const fallbackPlan = () => (p.fallback ? routed(clipText(p.fallback, maxCharsFor(p, planChannel)), null) : null);
    const done = (outcome: PersonaReplyResult['outcome'], reason: string | null, plan: ReplyPlan | null, turn: PersonaTurn | null, th: PersonaThread | null): PersonaReplyResult => {
      if (!dryRun) this.changed(a.project.id, { thread: th?.id ?? null, turn: turn?.id ?? null, state: th?.state ?? null });
      return { plan, warnings, outcome, reason, persona: this.info(p, th, turn) };
    };

    // Thread over, or a cap reached: no model call.
    if (thread && !dryRun) {
      if (thread.state !== 'active') return done('skip', `The conversation has ended (${thread.state}${thread.stopReason ? `: ${thread.stopReason}` : ''})`, null, null, thread);
    }
    const L = p.limits;
    const cap = !thread
      ? null
      : thread.replies >= L.maxReplies
        ? { why: 'maxReplies', text: `maxReplies reached (${thread.replies}/${L.maxReplies} replies)` }
        : thread.tokensIn + thread.tokensOut >= L.maxTokens
          ? { why: 'maxTokens', text: `maxTokens reached (${thread.tokensIn + thread.tokensOut}/${L.maxTokens} tokens)` }
          : null;
    // The daily slot is reserved here (synchronously, before the model call), so parallel fires cannot overshoot.
    const daily = { why: 'dailyCalls', text: `dailyCalls reached (${L.dailyCalls} model calls today, UTC)` };
    const hit = (dryRun ? null : cap) ?? (this.repo.reserveCall(a.project.id, L.dailyCalls) ? null : daily);
    if (hit) {
      if (dryRun) return { plan: null, warnings, outcome: 'skip', reason: `Persona limit: ${hit.text}`, persona: this.info(p, thread, null) };
      const fb = !thread!.fallbackSent ? fallbackPlan() : null;
      const th = this.repo.updateThread(thread!.id, { state: 'limit', stopReason: hit.why, fallbackSent: thread!.fallbackSent || !!fb, lastTurnAt: new Date().toISOString() });
      const turn = record({ status: fb ? 'fallback' : 'capped', text: fb?.text ?? '', error: hit.text });
      if (fb) {
        warnings.push(`Persona limit: ${hit.text}; the fallback text was sent`);
        return done('send', null, fb, turn, th);
      }
      return done('skip', `Persona limit: ${hit.text}`, null, turn, th);
    }

    // Build the prompt.
    const nonce = newNonce();
    const goalsState = thread?.goals ?? Object.fromEntries(p.goals.map((g) => [g.id, 'open' as GoalState]));
    const items = this.history(a.project.id, { testUserId: a.user.id, channel: a.message.channel, runId: a.message.runId }, a.message, L.maxHistory);
    const system = buildSystem({ persona: p, user: this.userFacts(a.user), channel: planChannel, goals: goalsState, notes: thread?.notes ?? '', nonce, instruction: r.instruction ?? null, buttons: (t.buttons ?? []).length > 0 });
    const messages = historyMessages(nonce, items);
    const run = await this.callModel(a.project, p, system, messages);
    // The thread or persona may have been deleted / stopped while the model was answering.
    const personaGone = !this.repo.byId(p.id);
    const fresh = thread ? this.repo.threadById(thread.id) : null;
    if (personaGone || (thread && !fresh)) {
      return { plan: null, warnings, outcome: 'skip', reason: personaGone ? `Persona "${p.name}" was deleted during the model call` : 'The conversation was deleted during the model call', persona: this.info(p, null, null) };
    }
    if (!dryRun && fresh && fresh.state !== 'active') {
      return done('skip', `The conversation ended during the model call (${fresh.state}${fresh.stopReason ? `: ${fresh.stopReason}` : ''})`, null, null, fresh);
    }
    if (fresh) thread = fresh;
    const usage = run.usage;
    const rawStored = scrub(run.raw, this.hub.chat.providers.secrets()).slice(0, MAX_RAW);
    if (run.toolCalls.length) warnings.push(`The model asked for tool(s) ${run.toolCalls.join(', ')}; personas have no tools, the calls were dropped`);
    const common = { raw: rawStored, provider: run.provider, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, durationMs: run.durationMs, finishReason: run.finishReason, called: true };

    const parsed = run.error ? null : parseOutput(run.raw, { goalIds: p.goals.map((g) => g.id), channel: planChannel, maxChars: maxCharsFor(p, planChannel) });
    if (parsed) warnings.push(...parsed.warnings);
    const empty = parsed && !parsed.controls.noReply && !parsed.text && !(planChannel === 'whatsapp' && parsed.controls.button);
    const error = run.error ?? (empty ? 'The model returned no reply text' : null);

    if (dryRun) {
      const turn = record({ ...common, status: 'dry-run', text: parsed?.text ?? '', controls: parsed?.controls ?? null, error });
      const plan = parsed && !error && !parsed.controls.noReply ? routed(parsed.text, parsed.controls) : null;
      return { plan, warnings, outcome: error ? 'fail' : plan ? 'send' : 'skip', reason: error ?? (parsed?.controls.noReply ? 'The persona chose not to reply ([[NO_REPLY]])' : null), persona: this.info(p, thread, turn) };
    }
    const th0 = thread!;
    const now = new Date().toISOString();
    if (error) {
      const errors = th0.errors + 1;
      const fb = fallbackPlan();
      const th = this.repo.updateThread(th0.id, {
        errors,
        tokensIn: th0.tokensIn + usage.inputTokens,
        tokensOut: th0.tokensOut + usage.outputTokens,
        lastTurnAt: now,
        ...(errors >= MAX_ERRORS_IN_A_ROW ? { state: 'error' as PersonaThreadState, stopReason: `${errors} model errors in a row` } : {}),
        ...(fb ? { replies: th0.replies + 1 } : {}),
      });
      const turn = record({ ...common, status: fb ? 'fallback' : 'error', text: fb?.text ?? parsed?.text ?? '', controls: parsed?.controls ?? null, error });
      if (fb) {
        warnings.push(`The model failed (${error}); the fallback text was sent`);
        return done('send', null, fb, turn, th);
      }
      return done('fail', error, null, turn, th);
    }
    const c = parsed!.controls;
    const goals = { ...goalsState };
    for (const g of c.goals) goals[g.id] = g.is;
    const allClosed = p.goals.length > 0 && p.goals.every((g) => goals[g.id] && goals[g.id] !== 'open');
    const end = c.done ? 'done' : allClosed && L.endWhenDone ? 'goals' : null;
    const notes = c.note !== undefined ? c.note.slice(0, MAX_NOTES) : th0.notes;
    const silent = c.noReply;
    const th = this.repo.updateThread(th0.id, {
      errors: 0,
      tokensIn: th0.tokensIn + usage.inputTokens,
      tokensOut: th0.tokensOut + usage.outputTokens,
      replies: th0.replies + (silent ? 0 : 1),
      goals,
      notes,
      lastTurnAt: now,
      ...(end ? { state: 'done' as PersonaThreadState, stopReason: end === 'done' ? 'done' : 'all goals closed' } : {}),
    });
    const turn = record({ ...common, status: silent ? 'silent' : 'replied', text: parsed!.text, controls: c });
    if (silent) return done('skip', 'The persona chose not to reply ([[NO_REPLY]])', null, turn, th);
    return done('send', null, routed(parsed!.text, c), turn, th);
  }

  /** After the fire sent (or failed to send) the reply: link the reply message to the turn. */
  afterSend(info: PersonaFireInfo, messageId: string | null, error?: string | null): void {
    if (!info.turnId) return;
    if (messageId) this.repo.updateTurn(info.turnId, { replyMessageId: messageId });
    if (error) this.repo.updateTurn(info.turnId, { status: 'error', error: scrub(error, this.hub.chat.providers.secrets()).slice(0, 1000) });
    const turn = this.repo.turn(info.turnId);
    if (turn) this.changed(turn.projectId, { turn: turn.id });
  }

  /** POST /:id/test: one dry-run call against a stored message or an inline one (+ optional history). Nothing is sent. */
  async test(project: Project, ref: string, input: J): Promise<J> {
    const p = this.require(project, ref);
    if (!isObj(input)) throw new HttpError(400, 'Body must be a JSON object');
    let user: TestUser | null = null;
    let items: HistoryItem[];
    let channel: Channel;
    let triggerId: string | null = null;
    let buttons: { id: string; title: string }[] = [];
    if (typeof input.message === 'string') {
      const m = this.hub.messages.get(input.message);
      if (!m || m.projectId !== project.id) throw new HttpError(404, `Message "${input.message}" not found`);
      if (m.direction !== 'outbound') throw new HttpError(400, 'Pick a message the app sent (outbound)');
      user = m.testUserId ? this.hub.users.get(project.id, m.testUserId) : null;
      channel = m.channel;
      triggerId = m.id;
      buttons = m.channel === 'whatsapp' ? replyOptions(m).map((o) => ({ id: o.id, title: o.title })) : [];
      items = Array.isArray(input.history) ? [] : user ? this.history(project.id, { testUserId: user.id, channel, runId: m.runId }, m, p.limits.maxHistory) : [this.itemOf(m)];
      if (Array.isArray(input.history)) items = [...this.inlineHistory(input.history, channel), this.itemOf(m)];
    } else if (isObj(input.message)) {
      const mm = input.message;
      channel = String(mm.channel ?? 'sms').toLowerCase() as Channel;
      if (!CHANNELS.includes(channel)) throw new HttpError(400, 'message.channel must be email, sms or whatsapp');
      const body = str(mm.body, 'message.body', 20_000) ?? '';
      if (!body.trim()) throw new HttpError(400, 'message.body is required');
      items = [...this.inlineHistory(input.history, channel), { from: 'app', channel, text: body, subject: channel === 'email' ? (str(mm.subject, 'message.subject', 1000) ?? null) : null, at: new Date().toISOString() }];
    } else throw new HttpError(400, 'message is required: a message id or {channel, from?, subject?, body}');
    if (input.user) user = this.hub.users.requireRef(project.id, String(input.user));
    const thread = user ? this.repo.findThread(p.id, user.id, channel, null) : null;
    if (!this.repo.reserveCall(project.id, p.limits.dailyCalls)) throw new HttpError(429, `dailyCalls reached (${p.limits.dailyCalls} model calls today, UTC)`);
    const nonce = newNonce();
    const system = buildSystem({ persona: p, user: this.userFacts(user), channel, goals: thread?.goals ?? {}, notes: thread?.notes ?? '', nonce, buttons: buttons.length > 0 });
    const messages = historyMessages(nonce, items.slice(-p.limits.maxHistory));
    const run = await this.callModel(project, p, system, messages);
    const warnings: string[] = [];
    if (run.toolCalls.length) warnings.push(`The model asked for tool(s) ${run.toolCalls.join(', ')}; personas have no tools, the calls were dropped`);
    const parsed = run.error ? null : parseOutput(run.raw, { goalIds: p.goals.map((g) => g.id), channel, maxChars: maxCharsFor(p, channel) });
    if (parsed) warnings.push(...parsed.warnings);
    // Persona deleted while the model was answering: report the result, store no turn.
    const turn = !this.repo.byId(p.id) ? null : this.repo.insertTurn({
      projectId: project.id, personaId: p.id, threadId: null, fireId: null, triggerMessageId: triggerId, replyMessageId: null, status: 'dry-run',
      text: parsed?.text ?? '', raw: scrub(run.raw, this.hub.chat.providers.secrets()).slice(0, MAX_RAW), controls: parsed?.controls ?? null, warnings,
      provider: run.provider, model: p.model, tokensIn: run.usage.inputTokens, tokensOut: run.usage.outputTokens, durationMs: run.durationMs, finishReason: run.finishReason, error: run.error, called: true,
    });
    if (!turn) warnings.push('The persona was deleted during the model call; no turn was stored');
    else this.changed(project.id, { turn: turn.id, dryRun: true });
    return {
      reply: parsed?.text ?? null,
      controls: parsed ? controlLines(parsed.controls) : [],
      parsed: parsed?.controls ?? null,
      warnings,
      error: run.error,
      usage: run.usage,
      finishReason: run.finishReason,
      durationMs: run.durationMs,
      turn: turn?.id ?? null,
      system,
      messages,
    };
  }

  private inlineHistory(v: unknown, channel: Channel): HistoryItem[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'history must be a list of {role: "app" | "persona", text}');
    return v.slice(-60).map((h, i) => {
      if (!isObj(h)) throw new HttpError(400, `history[${i}] must be {role, text}`);
      const role = String(h.role ?? '').toLowerCase();
      const from = role === 'app' || role === 'user' ? 'app' : role === 'persona' || role === 'assistant' ? 'persona' : null;
      if (!from) throw new HttpError(400, `history[${i}].role must be "app" (the app's message) or "persona" (the test user's reply)`);
      return { from, channel, text: clipText(String(h.text ?? ''), 20_000) } as HistoryItem;
    });
  }

  // ------------------------------------------------------------------ lifecycle hooks

  /** The §AB loop guard switched a persona rule off: its threads for that user stop. */
  onRuleDisabled(rule: Pick<AutoReplyRule, 'projectId' | 'reply'>, testUserId: string, reason: string): void {
    if (!rule.reply.persona) return;
    const n = this.repo.setThreadsState({ projectId: rule.projectId, personaId: rule.reply.persona, testUserId }, ['active'], 'stopped', reason);
    if (n.length) this.changed(rule.projectId, { stopped: n.length, reason });
  }

  onRunStopped(runId: string): void {
    const n = this.repo.setThreadsState({ runId }, ['active'], 'stopped', 'run stopped');
    if (n.length) this.changed(n[0].projectId, { runStopped: runId });
  }

  purgeRun(runId: string): void {
    this.repo.purgeRun(runId);
  }

  /** Project reset: threads and turns go, personas stay. */
  resetProject(projectId: string): void {
    this.repo.resetProject(projectId);
    this.changed(projectId, { reset: true });
  }

  /** Retention: persona turns older than the cutoff (the integrator wires it into maintenance/retention.ts). */
  purgeOlderThan(projectId: string, cutoffIso: string): number {
    return this.repo.deleteTurnsBefore(projectId, cutoffIso);
  }
}

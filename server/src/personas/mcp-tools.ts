/** MCP tools for AI personas (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface PersonaTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const o = (description: string) => ({ type: 'object', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "shop"');
const RUN = s('Test run key or id: limit to / attach to that run');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/personas`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const RO = { readOnlyHint: true, openWorldHint: false };
const WHEN = 'Use set_auto_reply for a fixed answer (no tokens, deterministic); use a persona when the conversation has several turns or needs free text. Use provider mock:openai (answered by this project\'s LLM mocks, no key) in CI.';

const briefPersona = (p: Json) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  enabled: p.enabled,
  provider: p.provider,
  model: p.model,
  mock: p.mock,
  ...(p.sendsContentTo ? { sendsContentTo: p.sendsContentTo } : {}),
  goals: p.goals,
  limits: p.limits,
  run: p.run,
  assigned: p.assigned,
  threads: p.threads,
  today: p.today,
  ...((p.warnings as unknown[] | undefined)?.length ? { warnings: p.warnings } : {}),
});

const briefThread = (t: Json) => ({
  id: t.id,
  persona: (t.persona as Json | null)?.slug ?? null,
  user: (t.user as Json | null)?.name ?? null,
  channel: t.channel,
  run: t.run,
  state: t.state,
  stopReason: t.stopReason,
  replies: t.replies,
  tokens: t.tokens,
  limits: t.limits,
  goals: t.goalList,
  notes: t.notes,
  lastTurnAt: t.lastTurnAt,
});

export const PERSONA_MCP_TOOLS: PersonaTool[] = [
  {
    name: 'list_personas',
    description: `List the AI personas of a project: test users whose replies an LLM writes in character (provider, model, goals, which users / roles they drive, threads, calls and tokens today, warnings). ${WHEN}`,
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}${qs({ run: a.run })}`)) as Json[]).map(briefPersona),
  },
  {
    name: 'get_persona_thread',
    description: 'One persona conversation (thread id), or the threads of a persona / user: state (active, done, limit, error, stopped), goals with their state, replies, tokens used / cap, notes, and with an id the turns and the two-sided transcript.',
    inputSchema: obj({ project: PROJECT, id: s('Thread id (else a list)'), persona: s('Persona id or slug'), user: s('Test user (id, email, phone, name)'), state: s('Comma-separated states'), run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      if (a.id) {
        const t = (await api('GET', `${base(a)}/threads/${enc(String(a.id))}`)) as Json;
        return { ...briefThread(t), turns: ((t.turns as Json[]) ?? []).map((x) => ({ id: x.id, status: x.status, text: x.text, error: x.error, tokensIn: x.tokensIn, tokensOut: x.tokensOut, warnings: x.warnings, createdAt: x.createdAt })), messages: t.messages };
      }
      return ((await api('GET', `${base(a)}/threads${qs({ persona: a.persona, user: a.user, state: a.state, run: a.run })}`)) as Json[]).map(briefThread);
    },
  },
  {
    name: 'test_persona',
    description: 'Dry run: what would the persona answer to a message (a stubyard message id, or {channel, subject?, body}) with an optional history [{role: "app" | "persona", text}]? One model call; returns the reply, control lines, warnings, usage and the exact system prompt. Nothing is sent.',
    inputSchema: obj({ project: PROJECT, persona: s('Persona id or slug'), message: { description: 'Message id, or {channel, subject?, body}' }, user: s('Test user whose facts go into the prompt'), history: { type: 'array', description: 'Earlier messages, oldest first: [{role: "app" | "persona", text}]' } }, ['project', 'persona', 'message']),
    annotations: RO,
    run: async (a, { api }) => api('POST', `${base(a)}/${enc(String(a.persona))}/test`, { message: a.message, user: a.user, history: a.history }),
  },
  {
    name: 'wait_for_persona',
    description: 'Wait (long-poll) until a persona conversation ends (state done, limit, error or stopped), or until a goal reaches a state (goal {id, is: "reached" | "failed"}). Returns the thread; timedOut: true when nothing happened.',
    inputSchema: obj({ project: PROJECT, persona: s('Persona id or slug'), user: s('Test user (id, email, phone, name)'), goal: o('{id, is} e.g. {"id": "code", "is": "reached"}'), state: s('Comma-separated states (default done,limit,error,stopped)'), run: RUN, timeout_seconds: n('Max wait, ≤ 60 (default 10)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/threads/wait`, { persona: a.persona, user: a.user, goal: a.goal, state: a.state, run: a.run, timeoutMs: Math.round(Number(a.timeout_seconds ?? 10) * 1000) })) as Json;
      return { timedOut: r.timedOut, thread: r.thread ? briefThread(r.thread as Json) : null };
    },
  },
  {
    name: 'set_persona',
    description: `Create (or with id: update) an AI persona: who the test user is and how they write (prompt), goals (short sentences such as "get the login code and send it back"), provider + model (e.g. mock:openai / gpt-5-mini), limits {maxReplies, maxTokens, maxOutputTokens, maxHistory, dailyCalls, timeoutMs, temperature}, fallback and opener. Then assign_persona makes a test user answer with it. ${WHEN}`,
    inputSchema: obj(
      {
        project: PROJECT,
        id: s('Persona id or slug to update (default: create)'),
        name: s('Persona name'),
        prompt: s('Who the user is and how they write'),
        goals: { type: 'array', description: 'Goals: sentences, or {id, text}' },
        provider: s('AI provider: mock:openai, mock:anthropic, env:openai, or a provider name'),
        model: s('Model id, e.g. gpt-5-mini'),
        limits: o('Limits; defaults maxReplies 10, maxTokens 20000, maxOutputTokens 300, maxHistory 20, dailyCalls 200, timeoutMs 30000, temperature 0.7'),
        style: o('{language?, tone?, maxChars?}'),
        fallback: s('Text sent once when a limit is reached or the model fails'),
        opener: s('First message for start_persona_conversation'),
        run: RUN,
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      const body: Json = {};
      for (const k of ['name', 'prompt', 'goals', 'provider', 'model', 'limits', 'style', 'fallback', 'opener']) if (a[k] !== undefined) body[k] = a[k];
      const r = a.id ? await api('PATCH', `${base(a)}/${enc(String(a.id))}`, body) : await api('POST', `${base(a)}${qs({ run: a.run })}`, body);
      return briefPersona(r as Json);
    },
  },
  {
    name: 'assign_persona',
    description: 'Make a test user (or every user with a role) answer the app with this persona: creates an auto-reply rule {match.user | match.role, reply.persona} first in line, with a 2 s delay + 0–3 s jitter by default. Delete the rule (delete_auto_reply) or the persona to stop.',
    inputSchema: obj({ project: PROJECT, persona: s('Persona id or slug'), user: s('Test user (id, email, phone, name)'), role: s('Or: every test user with this role'), channel: s('email | sms | whatsapp | any (default any)', { enum: ['email', 'sms', 'whatsapp', 'any'] }), delay_seconds: n('Wait before replying (default 2)'), jitter_seconds: n('Random extra delay 0..n (default 3)'), instruction: s('Extra line for the persona, for this rule only'), run: RUN }, ['project', 'persona']),
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/${enc(String(a.persona))}/assign${qs({ run: a.run })}`, { user: a.user, role: a.role, channel: a.channel, delaySeconds: a.delay_seconds, jitterSeconds: a.jitter_seconds, instruction: a.instruction })) as Json;
      return { rule: { id: r.id, name: r.name, channel: r.channel, summary: r.summary, delayMs: r.delayMs, jitterMs: r.jitterMs, run: r.run } };
    },
  },
  {
    name: 'start_persona_conversation',
    description: 'Start a conversation from the user\'s side: the persona\'s opener (or text) is sent as the test user\'s inbound message through the provider\'s inbound webhook. No model call. The app\'s answers are then handled by the persona\'s rule (assign_persona first).',
    inputSchema: obj({ project: PROJECT, persona: s('Persona id or slug'), user: s('Test user (id, email, phone, name)'), channel: s('email | sms | whatsapp', { enum: ['email', 'sms', 'whatsapp'] }), text: s('Default: the persona opener'), subject: s('Email subject'), instance: s('Provider instance slug'), run: RUN }, ['project', 'persona', 'user', 'channel']),
    run: async (a, { api }) => api('POST', `${base(a)}/${enc(String(a.persona))}/start${qs({ run: a.run })}`, { user: a.user, channel: a.channel, text: a.text, subject: a.subject, instance: a.instance }),
  },
  {
    name: 'stop_persona_threads',
    description: 'Stop persona conversations (state stopped): one thread (id), or every active thread of a persona / user / run. The rules stay; reset a thread in the dashboard or with the API to start over.',
    inputSchema: obj({ project: PROJECT, id: s('Thread id'), persona: s('Persona id or slug'), user: s('Test user'), run: RUN }, ['project']),
    run: async (a, { api }) => {
      if (a.id) return briefThread((await api('POST', `${base(a)}/threads/${enc(String(a.id))}/stop`)) as Json);
      return api('POST', `${base(a)}/threads/stop`, { persona: a.persona, user: a.user, run: a.run });
    },
  },
  {
    name: 'delete_persona',
    description: 'Delete a persona with its threads, turns and the auto-reply rules that use it.',
    inputSchema: obj({ project: PROJECT, persona: s('Persona id or slug') }, ['project', 'persona']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', `${base(a)}/${enc(String(a.persona))}`),
  },
];

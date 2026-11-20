/** MCP tools for LLM API mocks (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface LlmTool {
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
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const RUN = s('Test run key or id: limit to / attach to that run');
const PROVIDER = s('openai | anthropic | any (default any)', { enum: ['openai', 'anthropic', 'any'] });
const FAULT = s(
  'rate_limit[:secs] | error[:status] | overloaded | timeout | drop | malformed | cut[:n] | stream_error[:n] | slow:<ms> | auth | context_length. E.g. "rate_limit:2" or "error:503"',
);
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/llm`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const RO = { readOnlyHint: true, openWorldHint: false };

const briefMock = (m: Json) => ({
  id: m.id,
  name: m.name,
  kind: m.kind,
  provider: m.provider,
  match: m.match,
  responses: (m.responses as Json[] | undefined)?.map((r) => ({ text: r.text, toolCalls: r.toolCalls, stopReason: r.stopReason, ...(r.raw ? { raw: '(recorded body)' } : {}) })),
  mode: m.mode,
  fault: m.fault,
  remaining: m.remaining,
  hits: m.hits,
  enabled: m.enabled,
  source: m.source,
  run: m.run,
});

export const LLM_MCP_TOOLS: LlmTool[] = [
  {
    name: 'list_llm_mocks',
    description: 'Scripted OpenAI / Anthropic replies (and fault rules) of a project, in match order. Your app talks to them at /llm/<project>/openai/v1 or /llm/<project>/anthropic.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/mocks${qs({ run: a.run })}`)) as Json[]).map(briefMock),
  },
  {
    name: 'list_llm_calls',
    description: 'LLM API calls your app made to stubyard, newest first: endpoint, model, last user message, how it was answered (mode mock | record | fallback | unmatched | fault), mock, tokens.',
    inputSchema: obj({ project: PROJECT, run: RUN, mode: s('Comma list of modes'), provider: s('openai | anthropic'), limit: n('Max results (default 20)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/calls${qs({ run: a.run, mode: a.mode, provider: a.provider, limit: a.limit ?? 20 })}`),
  },
  {
    name: 'wait_for_llm_call',
    description: 'Wait (up to timeout_seconds, default 10, max 60) for the next LLM call matching the filters, then return it with the request and the reply.',
    inputSchema: obj(
      { project: PROJECT, run: RUN, provider: s('openai | anthropic'), endpoint: s('chat | responses | messages | embeddings | count_tokens'), model: s('Model glob, e.g. "gpt-5*"'), contains: s('Text somewhere in the request'), after: s('Only calls after this ISO time (default: any)'), timeout_seconds: n('Max wait (default 10, max 60)') },
      ['project'],
    ),
    annotations: RO,
    run: async (a, { api }) =>
      api('POST', `${base(a)}/calls/wait`, { run: a.run, provider: a.provider, endpoint: a.endpoint, model: a.model, contains: a.contains, after: a.after, timeoutMs: Math.round(Number(a.timeout_seconds ?? 10) * 1000) }),
  },
  {
    name: 'set_llm_mock',
    description:
      'Create (no id) or update (id) a scripted LLM reply. match: {endpoint?, model? (glob), lastUser?: {contains|equals|regex}, system?: {contains}, toolResult?: {name?, contains?}, hasTool?, turn?, stream?}. ' +
      'Reply: text (supports {{lastUser}}, {{model}}, {{body.x}}, {{uuid}}) and/or toolCalls [{name, arguments}], or responses [...] with mode first | sequence | cycle. The same mock answers OpenAI chat, OpenAI Responses and Anthropic Messages, streamed or not.',
    inputSchema: obj(
      {
        project: PROJECT,
        id: s('Mock id to update (leave out to create)'),
        name: s('Label'),
        provider: PROVIDER,
        match: o('Match conditions (all must hold)'),
        text: s('Reply text'),
        toolCalls: { type: 'array', description: 'Tool calls to return: [{name, arguments}]', items: { type: 'object' } },
        responses: { type: 'array', description: 'Several replies: [{text?, toolCalls?, stopReason?, usage?: {input, output}, chunk?: {size, delayMs}}]', items: { type: 'object' } },
        mode: s('first | sequence | cycle (with several responses)'),
        stopReason: s('stop | tool_calls | length (default from content)'),
        usage: o('{input, output} token counts (default: characters / 4)'),
        fault: FAULT,
        times: n('Only answer this many requests (default unlimited)'),
        enabled: { type: 'boolean', description: 'Enable / disable' },
        run: RUN,
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      const { project: _p, id, run, ...rest } = a;
      const b = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      return briefMock(id ? await api('PATCH', `${base(a)}/mocks/${enc(String(id))}`, b) : await api('POST', `${base(a)}/mocks${qs({ run })}`, b));
    },
  },
  {
    name: 'delete_llm_mock',
    description: 'Delete one LLM mock or fault rule by id.',
    inputSchema: obj({ project: PROJECT, id: s('Mock id') }, ['project', 'id']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => {
      await api('DELETE', `${base(a)}/mocks/${enc(String(a.id))}`);
      return { deleted: a.id };
    },
  },
  {
    name: 'set_llm_fault',
    description: 'Make LLM calls fail on purpose: a fault rule checked before every mock, for the next `times` requests (default every request), optionally only for one provider or test run. fault "none" removes the fault rules (of the run, if given).',
    inputSchema: obj({ project: PROJECT, fault: FAULT, provider: PROVIDER, times: n('Number of requests (default: all until removed)'), run: RUN }, ['project', 'fault']),
    run: async (a, { api }) => {
      if (String(a.fault).toLowerCase() === 'none') return api('DELETE', `${base(a)}/faults${qs({ run: a.run })}`);
      return briefMock(await api('POST', `${base(a)}/faults`, { fault: a.fault, provider: a.provider, times: a.times, run: a.run }));
    },
  },
  {
    name: 'reset_llm_mocks',
    description: 'Delete the LLM mocks and fault rules of a project (or only those of one run). Recorded mocks go too unless keep_recorded is true.',
    inputSchema: obj({ project: PROJECT, run: RUN, keep_recorded: { type: 'boolean', description: 'Keep mocks saved by recordings' } }, ['project']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => {
      if (a.keep_recorded) return api('DELETE', `${base(a)}/mocks${qs({ run: a.run, source: 'manual' })}`);
      return api('DELETE', `${base(a)}/mocks${qs({ run: a.run })}`);
    },
  },
  {
    name: 'start_llm_recording',
    description:
      'Record-to-mock: forward LLM calls that no mock answers (mode "new", default) or all calls (mode "all") to a real AI provider (System → AI providers, e.g. "env:openai"), pass the reply through and save each exchange as a mock for exact replay. One active recording per provider kind; it stops by itself after maxCalls forwarded calls or ttlMinutes. Browser requests from other web pages are never forwarded.',
    inputSchema: obj({ project: PROJECT, provider: s('AI provider name or id, e.g. "env:anthropic"'), name: s('Recording label'), mode: s('new | all'), maxCalls: n('Stop after this many forwarded calls (default 200)'), ttlMinutes: n('Stop after this many minutes (default 60)'), run: RUN }, ['project', 'provider']),
    run: async (a, { api }) => api('POST', `${base(a)}/recordings`, { provider: a.provider, name: a.name, mode: a.mode, maxCalls: a.maxCalls, ttlMinutes: a.ttlMinutes, run: a.run }),
  },
  {
    name: 'stop_llm_recording',
    description: 'Stop one recording (id) or every active recording of the project.',
    inputSchema: obj({ project: PROJECT, recording: s('Recording id (default: all active)') }, ['project']),
    run: async (a, { api }) => (a.recording ? api('POST', `${base(a)}/recordings/${enc(String(a.recording))}/stop`) : api('POST', `${base(a)}/recordings/stop`)),
  },
];

/** MCP tools for chat agents (appended to the TOOLS list in http/routes/mcp.ts). No tool touches provider keys. */
type Json = Record<string, unknown>;
interface ChatTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/chat`;

export const CHAT_MCP_TOOLS: ChatTool[] = [
  {
    name: 'list_chat_agents',
    description:
      'Chat agents of a project (dashboard → Chat): provider, model, step cap, which tools they may use (stubyard read-only tools, MCP tester targets), ' +
      'whether the provider is usable (providerOk / providerError) and how many saved prompts they have.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const list = (await api('GET', `${base(a)}/agents`)) as Json[];
      return {
        agents: list.map((x) => ({
          id: x.id,
          slug: x.slug,
          name: x.name,
          provider: x.provider,
          model: x.model,
          maxSteps: x.maxSteps,
          tools: x.tools,
          providerOk: x.providerOk,
          providerError: x.providerError,
          prompts: x.prompts,
        })),
      };
    },
  },
  {
    name: 'ask_agent',
    description:
      'Send one prompt to a chat agent and return its final reply, the tool calls it made (name, input, output), steps, token usage and finish reason. ' +
      'Use it to check that an LLM can use the MCP server you are building (add the server as an MCP tester target and allow it in the agent). ' +
      'The exchange is saved as a conversation (pass conversation to continue one). Calls the real model provider configured for the agent.',
    inputSchema: obj(
      {
        project: PROJECT,
        agent: s('Agent slug or id (see list_chat_agents)'),
        prompt: s('The user message'),
        conversation: s('Conversation id to continue (default: a new conversation)'),
      },
      ['project', 'agent', 'prompt'],
    ),
    run: async (a, { api }) => api('POST', `${base(a)}/agents/${enc(String(a.agent))}/ask`, { prompt: a.prompt, conversation: a.conversation }),
  },
  {
    name: 'run_saved_prompts',
    description:
      'Run saved chat prompts one after another and check their expectations (reply contains / does not contain / matches, tools called / not called, ' +
      'max steps, max tokens, finish reason). Returns passed / failed counts and per-prompt checks. Without ids: every saved prompt of the project (or of one agent).',
    inputSchema: obj(
      {
        project: PROJECT,
        ids: { type: 'array', items: { type: 'string' }, description: 'Saved prompt ids or names (default: all)' },
        agent: s('Only the saved prompts of this agent (slug or id)'),
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      const r = await api('POST', `${base(a)}/prompts/run`, { ids: a.ids, agent: a.agent });
      return {
        passed: r.passed,
        failed: r.failed,
        durationMs: r.durationMs,
        results: (r.results as Json[]).map((x) => ({
          id: x.id,
          name: x.name,
          agent: x.agent,
          passed: x.passed,
          failedChecks: (x.checks as { id: string; ok: boolean; detail: string }[]).filter((c) => !c.ok),
          text: String(x.text ?? '').slice(0, 1000),
          toolCalls: (x.toolCalls as Json[]).map((c) => c.name),
          steps: x.steps,
          usage: x.usage,
          error: x.error ?? null,
        })),
      };
    },
  },
  {
    name: 'compare_models',
    description:
      'Send one prompt to 2–6 models side by side (the Chat → Matrix tab) and wait for every answer: per model the reply text, tool calls, steps, tokens, ' +
      'time, finish reason, error and (with expectations) pass / fail checks. One failing model never fails the others. Models are {provider, model}: ' +
      'provider is an AI provider name (System → AI providers), env:<id>, or the keyless mock:openai / mock:anthropic (answered by this project\'s LLM mocks, good for CI). ' +
      'With agent, its instructions and settings are used and tools default to stubyard\'s read-only tools; tools "agent" (MCP tester targets) is refused here because ' +
      'a tool that changes state would run once per model. No cost estimates: tokens and time only.',
    inputSchema: obj(
      {
        project: PROJECT,
        prompt: s('The user message (or prompt_id)'),
        prompt_id: s('A saved prompt id or name: its text and expectations are used'),
        models: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          items: obj({ provider: s('AI provider name, env:<id>, mock:openai or mock:anthropic'), model: s('Model id, e.g. "gpt-5-mini"') }, ['provider', 'model']),
          description: '2–6 models',
        },
        agent: s('Agent slug or id: its instructions, temperature and step cap'),
        tools: { type: 'string', enum: ['none', 'builtin'], description: 'none, or builtin = stubyard read-only tools (default builtin with an agent, else none)' },
        expectations: {
          type: 'object',
          description: 'Checks per column, like saved prompts: {contains, notContains, matches, toolCalled, toolNotCalled, maxSteps, maxTokens, finishReason}',
        },
      },
      ['project', 'models'],
    ),
    run: async (a, { api }) => {
      const r = await api('POST', `${base(a)}/matrix?wait=1`, {
        prompt: a.prompt,
        promptId: a.prompt_id,
        models: a.models,
        agent: a.agent,
        tools: a.tools,
        expectations: a.expectations,
      });
      return {
        id: r.id,
        status: r.status,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        columns: (r.columns as Json[]).map((c) => ({
          provider: c.provider,
          model: c.model,
          status: c.status,
          text: String(c.text ?? '').slice(0, 2000),
          toolCalls: c.toolCalls,
          steps: c.steps,
          usage: c.usage,
          finishReason: c.finishReason,
          durationMs: c.durationMs,
          error: c.error,
          ...(c.expectations ? { passed: (c.expectations as Json).passed, failedChecks: ((c.expectations as Json).checks as { ok: boolean }[]).filter((x) => !x.ok) } : {}),
        })),
      };
    },
  },
  {
    name: 'explain_item',
    description:
      'Ask a chat agent to explain one stubyard item: a traffic log entry, a message, an LLM API call, an MCP tester saved call, a payment or an auto-reply fire. ' +
      'stubyard sends the item as JSON marked as untrusted data (clipped to 8 KB; credential-looking headers, fields and query parameters, card numbers and stored provider keys removed) and returns ' +
      'the agent\'s answer (one turn, saved as a conversation "Explain: …"; the agent gets no tools for it). Default agent: the first one whose provider works. Calls the agent\'s model provider.',
    inputSchema: obj(
      {
        project: PROJECT,
        kind: { type: 'string', enum: ['traffic', 'message', 'llm-call', 'mcp-call', 'payment', 'fire'], description: 'What id refers to' },
        id: s('The item id (traffic log id, message id, LLM call id, MCP saved call id, payment id, auto-reply fire id)'),
        question: s('Your question (default: what happened and what looks wrong)'),
        agent: s('Agent slug or id'),
      },
      ['project', 'kind', 'id'],
    ),
    run: async (a, { api }) => {
      const r = await api('POST', `${base(a)}/explain?run=1`, { kind: a.kind, id: a.id, question: a.question, agent: a.agent });
      return { conversation: r.conversation, agent: r.agent, text: r.text, usage: r.usage, finishReason: r.finishReason, error: r.error ?? null };
    },
  },
  {
    name: 'save_chat_tool_call',
    description:
      'Save a tool call an agent made in a chat conversation: as "saved-call" an MCP tester saved call (only tools of MCP tester targets, named <target>__<tool>; ' +
      'expects isError false), or as "llm-mock" an LLM mock that makes a fake model ask for exactly this call when it sees the same user message ' +
      '(include_follow_up adds a second mock that answers the tool result with the assistant\'s final text). Get conversation / message / call ids from the dashboard or ask_agent.',
    inputSchema: obj(
      {
        project: PROJECT,
        conversation: s('Conversation id'),
        message: s('Assistant message id'),
        call: s('Tool call id (toolCallId)'),
        as: { type: 'string', enum: ['saved-call', 'llm-mock'], description: 'saved-call (MCP tester) or llm-mock' },
        name: s('Name for the saved call / mock'),
        include_follow_up: { type: 'boolean', description: 'llm-mock: also mock the answer after the tool result' },
        expect_same_result: { type: 'boolean', description: 'saved-call: also expect the first 200 characters of this result' },
      },
      ['project', 'conversation', 'message', 'call', 'as'],
    ),
    run: async (a, { api }) =>
      api('POST', `${base(a)}/conversations/${enc(String(a.conversation))}/messages/${enc(String(a.message))}/tool-calls/${enc(String(a.call))}/save`, {
        as: a.as,
        name: a.name,
        includeFollowUp: a.include_follow_up === true,
        expect: a.expect_same_result === true ? 'same-result' : undefined,
      }),
  },
];

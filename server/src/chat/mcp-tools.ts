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
];

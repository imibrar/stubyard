/** MCP tools for the MCP tester (appended to the TOOLS list in http/routes/mcp.ts): an agent tests its own MCP server through stubyard. */
type Json = Record<string, unknown>;
interface TesterTool {
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
const TARGET = s('Saved MCP target: id or name (see mcp_tester_targets)');
const SESSION = s('MCP tester session id from mcp_tester_connect (optional when target is given)');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/mcp-tester`;

/** Session id for the call: the given one, or an open / new session of the target, or an ad-hoc URL. */
async function sessionFor(a: Json, api: (method: string, url: string, body?: unknown) => Promise<any>): Promise<string> {
  if (a.session) return String(a.session);
  if (a.target) return (await api('POST', `${base(a)}/connect`, { target: a.target, reuse: true, checks: false })).session.id;
  if (a.url) return (await api('POST', `${base(a)}/connect`, { url: a.url, headers: a.headers, transport: a.transport, checks: false })).session.id;
  throw new Error('Pass session, target or url');
}

const short = (t: Json) => ({
  name: t.name,
  ...(t.title ? { title: t.title } : {}),
  description: typeof t.description === 'string' ? (t.description.length > 300 ? `${t.description.slice(0, 300)}…` : t.description) : null,
  inputSchema: t.inputSchema,
  ...(t.outputSchema ? { hasOutputSchema: true } : {}),
  ...(t.annotations ? { annotations: t.annotations } : {}),
});

export const MCP_TESTER_MCP_TOOLS: TesterTool[] = [
  {
    name: 'mcp_tester_targets',
    description: 'Saved MCP server targets of a project (the MCP servers you are developing) with their saved calls count and open session. Header values are masked.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const r = await api('GET', base(a));
      return { targets: r.targets, sessions: r.sessions.map((x: Json) => ({ id: x.id, label: x.label, url: x.url, protocolVersion: x.protocolVersion })), stubyardSelf: r.self };
    },
  },
  {
    name: 'mcp_tester_connect',
    description:
      'Connect stubyard (as an MCP client) to an MCP server over Streamable HTTP or legacy HTTP+SSE: runs initialize, lists tools, and runs the MCP checks. ' +
      'Give a saved `target`, or a `url` (+ optional `headers` such as {"Authorization":"Bearer …"}); `save_as` stores the url as a target. ' +
      'stubyard runs in Docker: use http://host.docker.internal:<port>/mcp for a server on the host. stdio servers need a bridge, e.g. npx -y supergateway --stdio "<cmd>" --outputTransport streamableHttp --port 8000. ' +
      'Returns the session id for mcp_tester_call.',
    inputSchema: obj(
      {
        project: PROJECT,
        target: TARGET,
        url: s('MCP endpoint URL, e.g. http://host.docker.internal:3001/mcp'),
        headers: { type: 'object', description: 'Extra HTTP headers (e.g. Authorization)', additionalProperties: { type: 'string' } },
        transport: s('Transport (default auto: Streamable HTTP, falling back to HTTP+SSE)', { enum: ['auto', 'streamable', 'sse'] }),
        save_as: s('Save the url as a target with this name'),
        self: { type: 'boolean', description: "Connect to stubyard's own /mcp endpoint (demo)" },
        reuse: { type: 'boolean', description: 'Reuse an open session of the target (default true)' },
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      let target = a.target;
      if (a.save_as && a.url) target = (await api('POST', `${base(a)}/targets`, { name: a.save_as, url: a.url, headers: a.headers, transport: a.transport })).id;
      const r = await api('POST', `${base(a)}/connect`, a.self ? { self: true } : target ? { target, reuse: a.reuse !== false } : { url: a.url, headers: a.headers, transport: a.transport });
      let checks = r.checks;
      if (!checks) checks = await api('POST', `${base(a)}/sessions/${r.session.id}/checks`);
      const tools = await api('GET', `${base(a)}/sessions/${r.session.id}/tools`);
      const ss = r.session;
      return {
        session: ss.id,
        server: ss.serverInfo,
        protocolVersion: ss.protocolVersion,
        transport: ss.transport,
        mcpSessionId: ss.mcpSessionId,
        capabilities: ss.capabilities,
        instructions: ss.instructions,
        tools: (tools.tools as Json[]).map(short),
        checks: { summary: checks.summary, toolTokens: checks.stats.toolTokens, findings: checks.findings },
      };
    },
  },
  {
    name: 'mcp_tester_call',
    description:
      'Call a tool of the MCP server under test and return the raw result (content, structuredContent, isError), its outputSchema validation, the duration, ' +
      'and whether it failed as a JSON-RPC error instead. Use session from mcp_tester_connect, or target (connects if needed). save_as stores the call (with expect) for mcp_tester_run_saved.',
    inputSchema: obj(
      {
        project: PROJECT,
        session: SESSION,
        target: TARGET,
        tool: s('Tool name'),
        arguments: { type: 'object', description: 'Tool arguments' },
        timeout_seconds: { type: 'number', description: 'Default 60, max 300' },
        save_as: s('Save this call under a name in the target’s saved calls (needs target)'),
        expect: obj({ isError: { type: 'boolean', description: 'Expected isError (default false)' }, contains: s('Text the result must contain'), maxMs: { type: 'number', description: 'Max duration in ms' } }),
      },
      ['project', 'tool'],
    ),
    run: async (a, { api }) => {
      const sid = await sessionFor(a, api);
      const out = await api('POST', `${base(a)}/sessions/${sid}/call`, { name: a.tool, arguments: a.arguments ?? {}, timeoutMs: a.timeout_seconds ? Number(a.timeout_seconds) * 1000 : undefined });
      let saved: unknown;
      if (a.save_as) {
        if (!a.target) throw new Error('save_as needs target');
        saved = await api('POST', `${base(a)}/targets/${enc(String(a.target))}/saved`, { name: a.save_as, tool: a.tool, arguments: a.arguments ?? {}, expect: a.expect });
      }
      return { session: sid, ...out, ...(saved ? { saved } : {}) };
    },
  },
  {
    name: 'mcp_tester_checks',
    description:
      'Run the MCP checks ("MCP lint") on an MCP server: tool names, duplicates, descriptions, token cost of the tool list, inputSchema/outputSchema validity, required properties, ' +
      'structuredContent vs outputSchema (for tools called in this session), protocol version, ping, JSON-RPC vs isError, slow answers. Findings have severity error / warn / info.',
    inputSchema: obj({ project: PROJECT, session: SESSION, target: TARGET, url: s('Ad-hoc MCP endpoint URL') }, ['project']),
    // Connects to (and calls) a URL of the caller's choosing: not read-only.
    annotations: { readOnlyHint: false },
    run: async (a, { api }) => {
      const sid = await sessionFor(a, api);
      return { session: sid, ...(await api('POST', `${base(a)}/sessions/${sid}/checks`)) };
    },
  },
  {
    name: 'mcp_tester_run_saved',
    description: 'Run the saved calls of a target (a small regression suite: tool + arguments + expect) and return pass/fail per call. Connects if needed.',
    inputSchema: obj({ project: PROJECT, target: TARGET, ids: { type: 'array', items: { type: 'string' }, description: 'Only these saved call ids' } }, ['project', 'target']),
    run: async (a, { api }) => api('POST', `${base(a)}/targets/${enc(String(a.target))}/run-saved`, { ids: a.ids }),
  },
  {
    name: 'mcp_tester_log',
    description: 'JSON-RPC message log of an MCP tester session (requests, responses, errors, server notifications, transport events), oldest first. after = only entries with a larger seq.',
    inputSchema: obj({ project: PROJECT, session: SESSION, after: { type: 'number', description: 'Sequence number' }, limit: { type: 'number', description: 'Default 100' } }, ['project', 'session']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => api('GET', `${base(a)}/sessions/${enc(String(a.session))}/log?after=${Number(a.after ?? 0)}&limit=${Number(a.limit ?? 100)}`),
  },
];

import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { ToolSpec } from './engine.js';
import type { ChatAgent } from './repo.js';

/**
 * The tools a chat agent may use:
 *  - devhub's own MCP tools (POST /mcp via app.inject): only the explicit allowlist BUILTIN_TOOLS (read-only and
 *    project-scoped; readOnlyHint alone is not trusted); the project argument is removed from the schema and forced
 *    to the agent's project. Named devhub__<tool>.
 *  - tools of MCP tester targets (hub.mcpTester.openClient, source "chat"): named <target>__<tool>.
 * Tool failures (isError, JSON-RPC errors, transport errors) are returned to the model as text, never thrown.
 */

type Json = Record<string, unknown>;
export type InjectFn = (o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<{ statusCode: number; body: string }>;

export const RESULT_LIMIT = 16 * 1024;

export interface ToolInfo {
  name: string;
  source: 'devhub' | 'target';
  tool: string;
  description: string;
  target?: string;
  targetId?: string;
  sessionId?: string;
}

export interface BuiltTools {
  tools: ToolSpec[];
  info: ToolInfo[];
  errors: { target: string; error: string }[];
}

export function clip(text: string, limit = RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[clipped: ${text.length} characters in total, first ${limit} shown]`;
}

/** MCP tools/call result → text for the model. */
export function resultText(r: Json | undefined): string {
  if (!r) return '';
  const content = Array.isArray(r.content) ? (r.content as Json[]) : [];
  const parts = content.map((b) => {
    if (b?.type === 'text') return String(b.text ?? '');
    if (b?.type === 'resource' && b.resource && typeof (b.resource as Json).text === 'string') return String((b.resource as Json).text);
    if (b?.type === 'resource_link') return `[resource ${String(b.uri ?? '')}]`;
    return `[${String(b?.type ?? 'content')}${b?.mimeType ? ` ${String(b.mimeType)}` : ''}]`;
  });
  let text = parts.join('\n');
  if (!text.trim() && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  return text;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');

/** <prefix>__<tool>, [A-Za-z0-9_-], at most 64 chars, unique within `taken`. */
export function toolName(prefix: string, tool: string, taken: Set<string>): string {
  const p = (sanitize(prefix).toLowerCase() || 'mcp').slice(0, 24);
  let base = `${p}__${sanitize(tool) || 'tool'}`.slice(0, 64);
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    const suffix = `_${i}`;
    name = base.slice(0, 64 - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

function objectSchema(s: unknown): Json {
  const schema = s && typeof s === 'object' && !Array.isArray(s) ? (JSON.parse(JSON.stringify(s)) as Json) : {};
  if (schema.type !== 'object') schema.type = 'object';
  if (!schema.properties || typeof schema.properties !== 'object') schema.properties = {};
  delete schema.$schema;
  return schema;
}

function stripProject(s: unknown): Json {
  const schema = objectSchema(s);
  delete (schema.properties as Json).project;
  if (Array.isArray(schema.required)) schema.required = (schema.required as string[]).filter((r) => r !== 'project');
  return schema;
}

async function mcpRpc(inject: InjectFn, method: string, params?: Json): Promise<Json> {
  const res = await inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method, params }, headers: { 'content-type': 'application/json' } });
  const body = JSON.parse(res.body) as Json;
  if (body.error) throw new Error(String((body.error as Json).message ?? 'MCP error'));
  return (body.result ?? {}) as Json;
}

/**
 * devhub MCP tools a chat agent may get: they change nothing, read only the project's own data and never connect to
 * a URL the model chooses. Deliberately not here: mcp_tester_checks / _connect / _call (connect to any URL),
 * export_project (secrets), get_request (not project-scoped), get_file_url (mints write URLs), list_projects, and
 * every tool that changes state.
 */
export const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'list_test_users',
  'get_latest_code',
  'wait_for_message',
  'get_messages',
  'lint_report',
  'get_2fa_code',
  'get_traffic',
  'get_run_report',
  'doctor',
  'list_webhooks',
  'list_api_mocks',
  'list_providers',
  'list_login_providers',
  'list_storage',
  'list_files',
  'get_file',
  'wait_for_upload',
  'mcp_tester_targets',
  'mcp_tester_log',
  'list_scheduled',
  'get_time_offsets',
  'list_payments',
  'get_payment',
  'wait_for_payment',
  'payment_lint',
  'list_chat_agents',
]);

/** devhub's read-only, project-scoped MCP tools (raw, before the agent's allowlist). */
export async function builtinCatalog(inject: InjectFn): Promise<Json[]> {
  const r = await mcpRpc(inject, 'tools/list');
  return ((r.tools ?? []) as Json[]).filter((t) => {
    const props = ((t.inputSchema ?? {}) as Json).properties as Json | undefined;
    return BUILTIN_TOOLS.has(String(t.name)) && !!props && 'project' in props;
  });
}

const wanted = (list: '*' | string[], name: string) => list === '*' || list.includes(name);

export async function buildTools(hub: Hub, inject: InjectFn, project: Project, agent: ChatAgent): Promise<BuiltTools> {
  const tools: ToolSpec[] = [];
  const info: ToolInfo[] = [];
  const errors: BuiltTools['errors'] = [];
  const taken = new Set<string>();

  const builtin = agent.tools.builtin;
  if (builtin !== false) {
    try {
      const allow = builtin === true ? '*' : builtin.map((n) => n.replace(/^devhub__/, ''));
      for (const t of await builtinCatalog(inject)) {
        const tool = String(t.name);
        if (!wanted(allow, tool)) continue;
        const name = toolName('devhub', tool, taken);
        const description = String(t.description ?? '');
        tools.push({
          name,
          description: `[devhub, project ${project.slug}] ${description}`,
          inputSchema: stripProject(t.inputSchema),
          execute: async (args) => {
            try {
              const r = await mcpRpc(inject, 'tools/call', { name: tool, arguments: { ...args, project: project.slug } });
              const text = clip(resultText(r));
              return r.isError ? `Error: ${text}` : text;
            } catch (err) {
              return `Error: ${(err as Error).message}`;
            }
          },
        });
        info.push({ name, source: 'devhub', tool, description });
      }
    } catch (err) {
      errors.push({ target: 'devhub', error: (err as Error).message });
    }
  }

  for (const entry of agent.tools.targets) {
    try {
      const target = hub.mcpTester.repo.requireTarget(project.id, entry.target);
      const handle = await hub.mcpTester.openClient(project, target.id, { source: 'chat' });
      const listed = await handle.listTools();
      for (const t of listed) {
        const tool = String(t.name ?? '');
        if (!tool || !wanted(entry.tools, tool)) continue;
        const name = toolName(target.name, tool, taken);
        const description = String(t.description ?? t.title ?? '');
        tools.push({
          name,
          description: `[MCP server ${target.name}] ${description}`,
          inputSchema: objectSchema(t.inputSchema),
          execute: async (args) => {
            try {
              const o = await handle.callTool(tool, args, { timeoutMs: 60_000 });
              if (o.kind === 'transport_error') return `Error: no answer from MCP server ${target.name}: ${o.error ?? 'transport error'}`;
              if (o.kind === 'rpc_error') return `Error: JSON-RPC ${o.rpcError?.code}: ${o.rpcError?.message}`;
              const text = clip(resultText(o.result));
              return o.isError ? `Error: ${text}` : text;
            } catch (err) {
              return `Error: ${(err as Error).message}`;
            }
          },
        });
        info.push({ name, source: 'target', tool, description, target: target.name, targetId: target.id, sessionId: handle.session.id });
      }
    } catch (err) {
      errors.push({ target: entry.target, error: (err as Error).message });
    }
  }
  return { tools, info, errors };
}

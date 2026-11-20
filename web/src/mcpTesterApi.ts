/** Types of the MCP tester API (/api/projects/:slug/mcp-tester/…). */

export type Json = Record<string, unknown>;
export type Severity = 'error' | 'warn' | 'info';

export const mtBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/mcp-tester`;

export interface McpTarget {
  id: string;
  name: string;
  url: string;
  transport: 'auto' | 'streamable' | 'sse';
  /** Values masked ("Bearer ••••1234"); send them back unchanged to keep them. */
  headers: Record<string, string>;
  headerNames: string[];
  notes: string;
  lastConnectedAt: string | null;
  savedCalls: number;
  /** Open tester session of this target. */
  session: string | null;
}

export interface McpSession {
  id: string;
  targetId: string | null;
  label: string;
  url: string;
  transport: 'streamable' | 'sse' | null;
  transportPref: string;
  protocolVersion: string | null;
  mcpSessionId: string | null;
  getStream: 'open' | 'unsupported' | 'closed' | null;
  endpoint: string | null;
  serverInfo: { name?: string; title?: string; version?: string; websiteUrl?: string } | null;
  capabilities: Json;
  instructions: string | null;
  initMs: number;
  connectedAt: string;
  lastUsedAt: string;
  idleTimeoutMs: number;
  closed: boolean;
  stats: { invalidMessages: number; serverRequests: number; notifications: Record<string, number>; sessionReinits: number; messages: number; lastSeq: number };
  stale: string[];
  subscriptions: string[];
  checks: { ranAt: string; summary: Record<Severity, number> } | null;
  headers: Record<string, string>;
}

export interface McpOverview {
  targets: McpTarget[];
  sessions: McpSession[];
  self: { name: string; url: string };
  protocolVersions: string[];
  checks: { id: string; severity: string; title: string }[];
  idleTimeoutMs: number;
  inContainer: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Json;
  outputSchema?: Json;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** GET …/tools | resources | resource-templates | prompts: the items under their key plus this metadata. */
export interface ListMeta {
  supported: boolean;
  error: string | { code: number; message: string } | null;
  ms: number;
  pages: number;
  fetchedAt: string;
  stale: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CallOutcome {
  tool: string;
  arguments: Json;
  kind: 'result' | 'rpc_error' | 'transport_error';
  durationMs: number;
  result?: Json;
  isError?: boolean;
  rpcError?: RpcError;
  error?: string;
  validation: { hasOutputSchema: boolean; hasStructured: boolean; errors: string[] } | null;
  contentProblems: string[];
  progress: Json[];
  logSeq: { from: number; to: number };
}

export interface RpcOutcome {
  result?: Json;
  error?: RpcError;
  durationMs: number;
}

export interface LogEntry {
  seq: number;
  at: string;
  dir: 'out' | 'in' | 'local';
  kind: 'request' | 'response' | 'error' | 'notification' | 'transport' | 'invalid';
  method?: string;
  id?: string | number | null;
  durationMs?: number;
  size: number;
  status?: number;
  note?: string;
  logId?: string;
  source?: string;
  payload: unknown;
}

export interface CheckFinding {
  check: string;
  severity: Severity;
  message: string;
  subject?: string;
  detail?: string;
}

export interface CheckReport {
  ranAt: string;
  summary: Record<Severity, number>;
  stats: { tools: number; toolTokens: number; perTool: { name: string; tokens: number }[]; resources: number; resourceTemplates: number; prompts: number };
  findings: CheckFinding[];
}

export interface SavedCall {
  id: string;
  targetId: string;
  name: string;
  tool: string;
  arguments: Json;
  expect: { isError?: boolean; contains?: string; maxMs?: number; validOutput?: boolean };
  position: number;
  lastResult: SavedResult | null;
}

export interface SavedResult {
  pass: boolean;
  ranAt: string;
  durationMs: number;
  failures: string[];
  isError?: boolean;
  rpcError?: RpcError | null;
  error?: string | null;
  preview?: string;
}

export interface RunSavedResponse {
  target: string;
  session: string;
  passed: number;
  failed: number;
  durationMs: number;
  results: (SavedResult & { id: string; name: string; tool: string })[];
}

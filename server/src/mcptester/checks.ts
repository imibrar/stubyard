import { assertSchema, validateSchema, type JsonSchema } from '../webhooks/schema.js';
import { KNOWN_PROTOCOL_VERSIONS } from './client.js';

/**
 * "MCP lint": checks of an MCP server's handshake, tool / resource / prompt definitions and observed behaviour.
 * Precise and low false-positive: every finding cites the spec rule (MUST / SHOULD) or a concrete client limit.
 */

type Json = Record<string, unknown>;
export type CheckSeverity = 'error' | 'warn' | 'info';

export interface CheckFinding {
  check: string;
  severity: CheckSeverity;
  message: string;
  /** Tool / resource / prompt name the finding is about. */
  subject?: string;
  detail?: string;
}

export const MCP_CHECKS: { id: string; severity: string; title: string }[] = [
  { id: 'protocol-version', severity: 'error / info', title: 'Negotiated protocol version is one devhub knows (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05); info for 2024-11-05' },
  { id: 'server-info', severity: 'warn', title: 'initialize result has serverInfo.name and serverInfo.version' },
  { id: 'capabilities', severity: 'error / warn', title: 'tools / resources / prompts capabilities match what the server answers' },
  { id: 'ping', severity: 'error', title: 'The server answers ping with an empty result' },
  { id: 'tool-name', severity: 'warn / info', title: 'Tool names: 1–128 characters from A–Z a–z 0–9 _ - . (spec SHOULD); info when longer than 64 or with "." (rejected by some LLM APIs)' },
  { id: 'tool-name-duplicate', severity: 'error', title: 'Tool names are unique' },
  { id: 'tool-description', severity: 'warn', title: 'Every tool has a description, at most 2,000 characters (~500 tokens)' },
  { id: 'tool-list-size', severity: 'warn', title: 'The whole tool list (sent to the model every turn) is under ~10,000 tokens' },
  { id: 'input-schema', severity: 'error', title: 'inputSchema is a valid JSON Schema object with type "object"' },
  { id: 'schema-required', severity: 'error', title: '"required" lists only properties that exist' },
  { id: 'property-description', severity: 'info', title: 'Input properties have descriptions (the model only sees the schema)' },
  { id: 'output-schema', severity: 'error', title: 'outputSchema is a valid JSON Schema object with type "object"' },
  { id: 'structured-content', severity: 'error / info', title: 'A tool with outputSchema returns structuredContent that validates (MUST); info when no text fallback' },
  { id: 'tool-annotations', severity: 'warn', title: 'Annotations are consistent (readOnlyHint with destructiveHint)' },
  { id: 'content-blocks', severity: 'error', title: 'Result content blocks have a known type and their required fields' },
  { id: 'error-handling', severity: 'warn', title: 'Tool failures come back as isError results, not JSON-RPC errors; unknown tools are rejected' },
  { id: 'slow-response', severity: 'warn / info', title: 'initialize / ping / list calls under 2 s; tool calls under 10 s (info)' },
  { id: 'list-changed', severity: 'warn', title: 'list_changed notifications only when the capability declares listChanged' },
  { id: 'pagination', severity: 'error', title: 'nextCursor does not repeat' },
  { id: 'resource-shape', severity: 'warn', title: 'Resources have uri and name; templates have uriTemplate and name' },
  { id: 'prompt-shape', severity: 'warn', title: 'Prompts and prompt arguments have names' },
  { id: 'jsonrpc', severity: 'error', title: 'Every message from the server is valid JSON-RPC 2.0' },
];

export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
export const PORTABLE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DESCRIPTION_MAX = 2000;
const TOOL_LIST_TOKENS_WARN = 10_000;
const SLOW_MS = 2000;
const SLOW_CALL_MS = 10_000;
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** Rough token estimate (≈ 4 characters per token for English / JSON). */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

export function toolTokens(tool: Json): number {
  const { name, title, description, inputSchema, outputSchema, annotations } = tool;
  return approxTokens(JSON.stringify({ name, title, description, inputSchema, outputSchema, annotations }));
}

/** Structural problems of a JSON Schema (beyond what the validator would trip over). */
export function schemaProblems(schema: unknown, path = ''): string[] {
  const out: string[] = [];
  const walk = (s: unknown, p: string, depth: number) => {
    if (depth > 30 || out.length > 10) return;
    if (typeof s === 'boolean') return;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      out.push(`${p || '/'}: a schema must be an object or a boolean`);
      return;
    }
    const o = s as Json;
    if (o.type !== undefined) {
      const types = Array.isArray(o.type) ? o.type : [o.type];
      for (const t of types) if (typeof t !== 'string' || !SCHEMA_TYPES.has(t)) out.push(`${p || '/'}: unknown type ${JSON.stringify(t)}`);
    }
    if (o.properties !== undefined) {
      if (!o.properties || typeof o.properties !== 'object' || Array.isArray(o.properties)) out.push(`${p}/properties: must be an object`);
      else for (const [k, v] of Object.entries(o.properties as Json)) walk(v, `${p}/properties/${k}`, depth + 1);
    }
    if (o.required !== undefined && (!Array.isArray(o.required) || o.required.some((r) => typeof r !== 'string'))) out.push(`${p}/required: must be an array of strings`);
    if (o.items !== undefined) {
      if (Array.isArray(o.items)) o.items.forEach((it, i) => walk(it, `${p}/items/${i}`, depth + 1));
      else walk(o.items, `${p}/items`, depth + 1);
    }
    for (const k of ['anyOf', 'oneOf', 'allOf']) {
      if (o[k] === undefined) continue;
      if (!Array.isArray(o[k]) || (o[k] as unknown[]).length === 0) out.push(`${p}/${k}: must be a non-empty array`);
      else (o[k] as unknown[]).forEach((x, i) => walk(x, `${p}/${k}/${i}`, depth + 1));
    }
    if (o.enum !== undefined && !Array.isArray(o.enum)) out.push(`${p}/enum: must be an array`);
    if (o.additionalProperties !== undefined && typeof o.additionalProperties !== 'boolean') walk(o.additionalProperties, `${p}/additionalProperties`, depth + 1);
    for (const k of ['$defs', 'definitions']) if (o[k] && typeof o[k] === 'object') for (const [n, v] of Object.entries(o[k] as Json)) walk(v, `${p}/${k}/${n}`, depth + 1);
  };
  walk(schema, path, 0);
  if (!out.length) {
    try {
      assertSchema(schema);
    } catch (err) {
      out.push(`${path || '/'}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Validate structuredContent against an outputSchema; [] = valid. */
export function validateStructured(schema: unknown, value: unknown): string[] {
  try {
    return validateSchema(schema as JsonSchema, value, 20).map((e) => `${e.path || '/'} ${e.message}`);
  } catch (err) {
    return [`outputSchema could not be used: ${(err as Error).message}`];
  }
}

/** Problems of one result content block ([] = fine). */
export function contentBlockProblems(b: unknown): string[] {
  if (!b || typeof b !== 'object') return ['content block is not an object'];
  const o = b as Json;
  const need = (k: string) => (typeof o[k] === 'string' && o[k] !== '' ? [] : [`${o.type} block without "${k}"`]);
  switch (o.type) {
    case 'text':
      return typeof o.text === 'string' ? [] : ['text block without "text"'];
    case 'image':
    case 'audio': {
      const p = [...need('data'), ...need('mimeType')];
      if (typeof o.data === 'string' && !/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(o.data)) p.push(`${o.type} data is not base64`);
      return p;
    }
    case 'resource_link':
      return [...need('uri'), ...need('name')];
    case 'resource': {
      const r = o.resource as Json | undefined;
      if (!r || typeof r !== 'object') return ['resource block without "resource"'];
      if (typeof r.uri !== 'string') return ['embedded resource without "uri"'];
      if (typeof r.text !== 'string' && typeof r.blob !== 'string') return ['embedded resource without "text" or "blob"'];
      return [];
    }
    default:
      return [`unknown content type ${JSON.stringify(o.type)}`];
  }
}

export interface CallObservation {
  tool: string;
  at: string;
  durationMs: number;
  /** JSON-RPC error instead of a result. */
  rpcError?: { code: number; message: string } | null;
  isError?: boolean;
  hasStructured?: boolean;
  hasText?: boolean;
  /** outputSchema validation errors (null = not validated). */
  schemaErrors?: string[] | null;
  contentProblems?: string[];
}

export interface CheckInput {
  init: Json | null;
  protocolVersion: string | null;
  initMs: number | null;
  ping: { ok: boolean; ms: number; error?: string } | null;
  lists: Record<'tools' | 'resources' | 'resourceTemplates' | 'prompts', { items: Json[] | null; error?: { code: number; message: string } | string | null; ms?: number; repeatedCursor?: boolean } | undefined>;
  calls: CallObservation[];
  /** Result of tools/call with a name that does not exist. */
  unknownToolProbe?: { rpcError?: { code: number; message: string } | null; isError?: boolean; ms: number } | null;
  notifications: Record<string, number>;
  invalidMessages: number;
}

export interface CheckReport {
  ranAt: string;
  summary: { error: number; warn: number; info: number };
  stats: { tools: number; toolTokens: number; perTool: { name: string; tokens: number }[]; resources: number; resourceTemplates: number; prompts: number };
  findings: CheckFinding[];
}

export function runMcpChecks(input: CheckInput): CheckReport {
  const f: CheckFinding[] = [];
  const add = (check: string, severity: CheckSeverity, message: string, subject?: string, detail?: string) =>
    f.push({ check, severity, message, ...(subject !== undefined ? { subject } : {}), ...(detail ? { detail } : {}) });
  const init = input.init ?? {};
  const caps = (init.capabilities ?? {}) as Json;

  // --- handshake
  const v = input.protocolVersion;
  if (!v) add('protocol-version', 'error', 'initialize result has no protocolVersion');
  else if (!KNOWN_PROTOCOL_VERSIONS.includes(v)) add('protocol-version', 'error', `Negotiated protocol version "${v}" is not a released MCP version; a client must disconnect when it does not support the version`, undefined, `Known: ${KNOWN_PROTOCOL_VERSIONS.join(', ')}`);
  else if (v === '2024-11-05') add('protocol-version', 'info', 'The server negotiated 2024-11-05 (the HTTP+SSE era); current clients prefer 2025-06-18 or newer');
  const si = init.serverInfo as Json | undefined;
  if (!si || typeof si.name !== 'string' || !si.name) add('server-info', 'warn', 'initialize result has no serverInfo.name (required by the schema)');
  else if (typeof si.version !== 'string' || !si.version) add('server-info', 'warn', 'serverInfo has no version (required by the schema)');
  if (input.ping && !input.ping.ok) add('ping', 'error', `The server did not answer ping: ${input.ping.error ?? 'no result'}`, undefined, 'Clients use ping to keep connections alive; the server must answer with an empty result');
  if (input.invalidMessages > 0) add('jsonrpc', 'error', `${input.invalidMessages} message(s) from the server were not valid JSON-RPC 2.0 (see the Log tab)`);

  const slow: string[] = [];
  if (input.initMs !== null && input.initMs > SLOW_MS) slow.push(`initialize ${input.initMs} ms`);
  if (input.ping?.ok && input.ping.ms > SLOW_MS) slow.push(`ping ${input.ping.ms} ms`);

  // --- capabilities vs. lists
  const capFor: Record<string, string> = { tools: 'tools', resources: 'resources', resourceTemplates: 'resources', prompts: 'prompts' };
  for (const [key, l] of Object.entries(input.lists)) {
    if (!l) continue;
    const declared = caps[capFor[key]] !== undefined;
    const method = key === 'resourceTemplates' ? 'resources/templates/list' : `${key}/list`;
    if (l.error && declared) {
      const msg = typeof l.error === 'string' ? l.error : `${l.error.message} (JSON-RPC ${l.error.code})`;
      // Templates are optional even with the resources capability; -32601 there is fine.
      if (!(key === 'resourceTemplates' && typeof l.error !== 'string' && l.error.code === -32601)) add('capabilities', 'error', `The server declares the ${capFor[key]} capability but ${method} failed: ${msg}`);
    } else if (!l.error && !declared && l.items && l.items.length > 0) {
      add('capabilities', 'warn', `${method} returned ${l.items.length} item(s) but the ${capFor[key]} capability is not declared; clients will not ask for them`);
    }
    if (l.repeatedCursor) add('pagination', 'error', `${method}: nextCursor repeated (pagination loop); devhub stopped paging`);
    if (l.ms !== undefined && l.ms > SLOW_MS) slow.push(`${method} ${l.ms} ms`);
  }
  if (slow.length) add('slow-response', 'warn', `Slow answers: ${slow.join(', ')} (over ${SLOW_MS / 1000} s); clients call these on every connect`);

  // --- notifications
  for (const [method, n] of Object.entries(input.notifications)) {
    const m = /^notifications\/(tools|resources|prompts)\/list_changed$/.exec(method);
    if (m && (caps[m[1]] as Json | undefined)?.listChanged !== true) add('list-changed', 'warn', `The server sent ${method} ${n}× but ${m[1]}.listChanged is not declared`);
  }

  // --- tools
  const tools = input.lists.tools?.items ?? [];
  const perTool: { name: string; tokens: number }[] = [];
  const seen = new Map<string, number>();
  for (const t of tools) {
    const name = typeof t.name === 'string' ? t.name : '';
    const subj = name || '(no name)';
    perTool.push({ name: subj, tokens: toolTokens(t) });
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (!name) add('tool-name', 'warn', 'A tool has no name');
    else if (!TOOL_NAME_RE.test(name)) {
      const bad = [...new Set(name.replace(/[A-Za-z0-9_.-]/g, ''))].map((c) => JSON.stringify(c)).join(' ');
      add('tool-name', 'warn', name.length > 128 ? `Tool name is ${name.length} characters (spec: 1–128)` : `Tool name contains characters outside A–Z a–z 0–9 _ - . : ${bad}`, subj);
    } else if (!PORTABLE_NAME_RE.test(name)) {
      add('tool-name', 'info', `Valid per spec, but ${name.length > 64 ? `${name.length} characters` : 'the "."'} is rejected by LLM APIs that require ^[a-zA-Z0-9_-]{1,64}$ for function names (clients may rename or drop it)`, subj);
    }
    const desc = typeof t.description === 'string' ? t.description.trim() : '';
    if (!desc) add('tool-description', 'warn', 'No description: the model has only the name to decide when to call this tool', subj);
    else if (desc.length > DESCRIPTION_MAX) add('tool-description', 'warn', `Description is ${desc.length} characters (≈${approxTokens(desc)} tokens), sent to the model on every turn`, subj);

    // inputSchema
    const is = t.inputSchema as Json | undefined;
    if (is === undefined || is === null) add('input-schema', 'error', 'inputSchema is missing (MUST be a JSON Schema object, not null)', subj);
    else if (typeof is !== 'object' || Array.isArray(is)) add('input-schema', 'error', 'inputSchema is not an object', subj);
    else {
      if (is.type !== 'object') add('input-schema', 'error', `inputSchema.type must be "object" (got ${JSON.stringify(is.type)})`, subj);
      const probs = schemaProblems(is);
      if (probs.length) add('input-schema', 'error', 'inputSchema is not a valid JSON Schema', subj, probs.slice(0, 5).join('; '));
      const props = is.properties && typeof is.properties === 'object' && !Array.isArray(is.properties) ? (is.properties as Json) : null;
      if (Array.isArray(is.required) && props) {
        const missing = (is.required as unknown[]).filter((r) => typeof r === 'string' && !(r in props));
        if (missing.length) add('schema-required', 'error', `"required" lists properties that do not exist: ${missing.join(', ')}`, subj);
      } else if (Array.isArray(is.required) && is.required.length && !props && is.additionalProperties === false) {
        add('schema-required', 'error', `"required" lists ${is.required.join(', ')} but no properties are allowed`, subj);
      }
      if (props) {
        const undocumented = Object.entries(props).filter(([, p]) => p && typeof p === 'object' && !(p as Json).description && !(p as Json).$ref && !(p as Json).title).map(([k]) => k);
        if (undocumented.length) add('property-description', 'info', `Properties without a description: ${undocumented.join(', ')}`, subj);
      }
    }
    // outputSchema
    if (t.outputSchema !== undefined) {
      const os = t.outputSchema as Json;
      if (!os || typeof os !== 'object' || Array.isArray(os)) add('output-schema', 'error', 'outputSchema is not an object', subj);
      else {
        if (os.type !== 'object') add('output-schema', 'error', `outputSchema.type must be "object" (structuredContent is a JSON object; got ${JSON.stringify(os.type)})`, subj);
        const probs = schemaProblems(os);
        if (probs.length) add('output-schema', 'error', 'outputSchema is not a valid JSON Schema', subj, probs.slice(0, 5).join('; '));
      }
    }
    const a = t.annotations as Json | undefined;
    if (a && a.readOnlyHint === true && a.destructiveHint === true) add('tool-annotations', 'warn', 'readOnlyHint and destructiveHint are both true (destructiveHint only applies when the tool is not read-only)', subj);
  }
  for (const [name, n] of seen) if (name && n > 1) add('tool-name-duplicate', 'error', `${n} tools are named "${name}"`, name);
  const toolTokensTotal = tools.length ? approxTokens(JSON.stringify(tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations })))) : 0;
  if (toolTokensTotal > TOOL_LIST_TOKENS_WARN) {
    const top = [...perTool].sort((x, y) => y.tokens - x.tokens).slice(0, 3).map((x) => `${x.name} ≈${x.tokens}`);
    add('tool-list-size', 'warn', `The tool list is ≈${toolTokensTotal.toLocaleString('en')} tokens (${tools.length} tools), sent to the model on every turn`, undefined, `Largest: ${top.join(', ')}`);
  }

  // --- observed calls
  const byName = new Map(tools.map((t) => [String(t.name), t]));
  const reported = new Set<string>();
  const once = (key: string) => (reported.has(key) ? false : (reported.add(key), true));
  const slowCalls: string[] = [];
  for (const c of input.calls) {
    const tool = byName.get(c.tool);
    if (c.durationMs > SLOW_CALL_MS && once(`slow:${c.tool}`)) slowCalls.push(`${c.tool} ${(c.durationMs / 1000).toFixed(1)} s`);
    if (c.rpcError) {
      // -32602 (invalid params) and -32601 / -32600 are protocol errors; other codes mean the tool threw.
      if (tool && ![-32602, -32601, -32600, -32700].includes(c.rpcError.code) && once(`rpc:${c.tool}`)) {
        add('error-handling', 'warn', `tools/call returned a JSON-RPC error (${c.rpcError.code}: ${c.rpcError.message.slice(0, 120)}); return tool failures as a result with isError: true so the model can see and fix them`, c.tool);
      }
      continue;
    }
    if (c.contentProblems?.length && once(`content:${c.tool}`)) add('content-blocks', 'error', `Invalid content in the result: ${c.contentProblems.slice(0, 3).join('; ')}`, c.tool);
    if (tool?.outputSchema !== undefined && !c.isError) {
      if (!c.hasStructured) {
        if (once(`sc:${c.tool}`)) add('structured-content', 'error', 'The tool declares outputSchema but the result has no structuredContent (servers MUST provide structured results that conform to it)', c.tool);
      } else if (c.schemaErrors && c.schemaErrors.length) {
        if (once(`scv:${c.tool}`)) add('structured-content', 'error', 'structuredContent does not match outputSchema', c.tool, c.schemaErrors.slice(0, 5).join('; '));
      }
    }
    if (c.hasStructured && !c.hasText && once(`sctext:${c.tool}`)) add('structured-content', 'info', 'structuredContent without a text block: for backwards compatibility a tool SHOULD also return the serialized JSON as text', c.tool);
  }
  if (slowCalls.length) add('slow-response', 'info', `Slow tool calls: ${slowCalls.join(', ')} (over ${SLOW_CALL_MS / 1000} s; consider progress notifications)`);
  const probe = input.unknownToolProbe;
  if (probe && !probe.rpcError && !probe.isError) add('error-handling', 'warn', 'tools/call with a tool name that does not exist returned a normal result; it should fail (JSON-RPC -32602 "Unknown tool", or isError)');

  // --- resources / prompts
  for (const r of input.lists.resources?.items ?? []) {
    const subj = String(r.uri ?? r.name ?? '(resource)');
    if (typeof r.uri !== 'string' || !r.uri) add('resource-shape', 'warn', 'Resource without uri', subj);
    if (typeof r.name !== 'string' || !r.name) add('resource-shape', 'warn', 'Resource without name (required)', subj);
  }
  for (const r of input.lists.resourceTemplates?.items ?? []) {
    const subj = String(r.uriTemplate ?? r.name ?? '(template)');
    if (typeof r.uriTemplate !== 'string' || !r.uriTemplate) add('resource-shape', 'warn', 'Resource template without uriTemplate', subj);
    if (typeof r.name !== 'string' || !r.name) add('resource-shape', 'warn', 'Resource template without name (required)', subj);
  }
  for (const p of input.lists.prompts?.items ?? []) {
    const subj = String(p.name ?? '(prompt)');
    if (typeof p.name !== 'string' || !p.name) add('prompt-shape', 'warn', 'Prompt without name', subj);
    if (Array.isArray(p.arguments) && p.arguments.some((a) => !a || typeof (a as Json).name !== 'string')) add('prompt-shape', 'warn', 'Prompt argument without name', subj);
  }

  const order = { error: 0, warn: 1, info: 2 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    ranAt: new Date().toISOString(),
    summary: { error: f.filter((x) => x.severity === 'error').length, warn: f.filter((x) => x.severity === 'warn').length, info: f.filter((x) => x.severity === 'info').length },
    stats: {
      tools: tools.length,
      toolTokens: toolTokensTotal,
      perTool,
      resources: input.lists.resources?.items?.length ?? 0,
      resourceTemplates: input.lists.resourceTemplates?.items?.length ?? 0,
      prompts: input.lists.prompts?.items?.length ?? 0,
    },
    findings: f,
  };
}

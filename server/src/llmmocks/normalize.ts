import { createHash } from 'node:crypto';
import type { CanonMessage, CanonRequest, CanonToolCall, CanonToolResult, LlmEndpoint, LlmProvider } from './types.js';

/**
 * Read the three request shapes (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) into one canonical
 * request. Unknown content parts (images, files, audio) become "[image]" style placeholders so text matching still works.
 */

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** Text of a content value: a string or an array of parts ({type:'text'|'input_text'|'output_text', text}). */
export function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return c === undefined || c === null ? '' : str(c);
  const out: string[] = [];
  for (const p of c) {
    if (typeof p === 'string') out.push(p);
    else if (isObj(p)) {
      const t = String(p.type ?? '');
      if (typeof p.text === 'string' && t !== 'tool_result' && t !== 'tool_use') out.push(p.text);
      else if (t === 'refusal' && typeof p.refusal === 'string') out.push(p.refusal);
      else if (/image/.test(t)) out.push('[image]');
      else if (/file|document/.test(t)) out.push('[file]');
      else if (/audio/.test(t)) out.push('[audio]');
    }
  }
  return out.join('\n');
}

const parseArgs = (a: unknown): unknown => {
  if (typeof a !== 'string') return a ?? {};
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
};

/** Tool results carry only a call id: fill in the tool name from the assistant call with that id. */
function nameResults(messages: CanonMessage[]): void {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) if (c.id) names.set(c.id, c.name);
    for (const r of m.toolResults ?? []) if (!r.name && r.id) r.name = names.get(r.id);
  }
}

function openAiChat(b: J): Omit<CanonRequest, 'provider' | 'endpoint'> {
  const system: string[] = [];
  const messages: CanonMessage[] = [];
  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (!isObj(m)) continue;
    const role = String(m.role ?? '');
    if (role === 'system' || role === 'developer') system.push(contentText(m.content));
    else if (role === 'assistant') {
      const toolCalls: CanonToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter(isObj).map((c) => {
        const f = isObj(c.function) ? c.function : {};
        return { id: c.id ? String(c.id) : undefined, name: String(f.name ?? ''), arguments: parseArgs(f.arguments) };
      });
      messages.push({ role: 'assistant', text: contentText(m.content), ...(toolCalls.length ? { toolCalls } : {}) });
    } else if (role === 'tool' || role === 'function') {
      const r: CanonToolResult = { id: m.tool_call_id ? String(m.tool_call_id) : undefined, name: role === 'function' ? String(m.name ?? '') : undefined, content: contentText(m.content) };
      const prev = messages[messages.length - 1];
      if (prev?.role === 'tool') prev.toolResults!.push(r);
      else messages.push({ role: 'tool', text: '', toolResults: [r] });
    } else messages.push({ role: 'user', text: contentText(m.content) });
  }
  const tools = (Array.isArray(b.tools) ? b.tools : []).filter(isObj).map((t) => String((isObj(t.function) ? t.function.name : t.name) ?? '')).filter(Boolean);
  const so = isObj(b.stream_options) ? b.stream_options : {};
  return {
    model: str(b.model),
    system: system.join('\n'),
    messages,
    tools,
    stream: b.stream === true,
    includeUsage: so.include_usage === true,
    maxTokens: num(b.max_completion_tokens ?? b.max_tokens),
  };
}

function openAiResponses(b: J): Omit<CanonRequest, 'provider' | 'endpoint'> {
  const system: string[] = [];
  if (typeof b.instructions === 'string') system.push(b.instructions);
  const messages: CanonMessage[] = [];
  const input = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : Array.isArray(b.input) ? b.input : [];
  for (const it of input) {
    if (!isObj(it)) continue;
    const type = String(it.type ?? 'message');
    if (type === 'function_call') {
      const call: CanonToolCall = { id: String(it.call_id ?? it.id ?? ''), name: String(it.name ?? ''), arguments: parseArgs(it.arguments) };
      const prev = messages[messages.length - 1];
      if (prev?.role === 'assistant') (prev.toolCalls ??= []).push(call);
      else messages.push({ role: 'assistant', text: '', toolCalls: [call] });
    } else if (type === 'function_call_output') {
      const r: CanonToolResult = { id: String(it.call_id ?? ''), content: contentText(it.output) };
      const prev = messages[messages.length - 1];
      if (prev?.role === 'tool') prev.toolResults!.push(r);
      else messages.push({ role: 'tool', text: '', toolResults: [r] });
    } else if (type === 'message') {
      const role = String(it.role ?? 'user');
      if (role === 'system' || role === 'developer') system.push(contentText(it.content));
      else if (role === 'assistant') {
        const prev = messages[messages.length - 1];
        // An assistant text item right before its function_call items is one turn.
        messages.push({ role: 'assistant', text: contentText(it.content) });
        void prev;
      } else messages.push({ role: 'user', text: contentText(it.content) });
    }
    // reasoning, file_search_call, … are ignored
  }
  const tools = (Array.isArray(b.tools) ? b.tools : []).filter(isObj).map((t) => String(t.name ?? (isObj(t.function) ? t.function.name : '') ?? t.type ?? '')).filter(Boolean);
  return { model: str(b.model), system: system.join('\n'), messages, tools, stream: b.stream === true, maxTokens: num(b.max_output_tokens) };
}

function anthropic(b: J): Omit<CanonRequest, 'provider' | 'endpoint'> {
  const system = typeof b.system === 'string' ? b.system : contentText(b.system);
  const messages: CanonMessage[] = [];
  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (!isObj(m)) continue;
    const role = String(m.role ?? 'user');
    const blocks = Array.isArray(m.content) ? m.content.filter(isObj) : [];
    if (role === 'assistant') {
      const toolCalls: CanonToolCall[] = blocks.filter((x) => x.type === 'tool_use').map((x) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), arguments: x.input ?? {} }));
      messages.push({ role: 'assistant', text: contentText(m.content), ...(toolCalls.length ? { toolCalls } : {}) });
    } else {
      const toolResults: CanonToolResult[] = blocks
        .filter((x) => x.type === 'tool_result')
        .map((x) => ({ id: String(x.tool_use_id ?? ''), content: contentText(x.content), ...(x.is_error ? { isError: true } : {}) }));
      const text = contentText(m.content);
      if (toolResults.length) messages.push({ role: 'tool', text: '', toolResults });
      if (text || !toolResults.length) messages.push({ role: 'user', text });
    }
  }
  const tools = (Array.isArray(b.tools) ? b.tools : []).filter(isObj).map((t) => String(t.name ?? '')).filter(Boolean);
  return { model: str(b.model), system, messages, tools, stream: b.stream === true, maxTokens: num(b.max_tokens) };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalizeRequest(provider: LlmProvider, endpoint: LlmEndpoint, body: unknown): CanonRequest {
  const b = isObj(body) ? body : {};
  const base = endpoint === 'chat' ? openAiChat(b) : endpoint === 'responses' ? openAiResponses(b) : endpoint === 'messages' || endpoint === 'count_tokens' ? anthropic(b) : embeddingsReq(b);
  nameResults(base.messages);
  return { provider, endpoint, ...base };
}

function embeddingsReq(b: J): Omit<CanonRequest, 'provider' | 'endpoint'> {
  const input = Array.isArray(b.input) ? b.input.map(str).join('\n') : str(b.input);
  return { model: str(b.model), system: '', messages: [{ role: 'user', text: input }], tools: [], stream: false };
}

/** Text of the last user message (tool results do not count). */
export function lastUserText(r: CanonRequest): string {
  for (let i = r.messages.length - 1; i >= 0; i--) if (r.messages[i].role === 'user') return r.messages[i].text;
  return '';
}

/** Assistant messages so far. */
export function turnOf(r: CanonRequest): number {
  return r.messages.filter((m) => m.role === 'assistant').length;
}

/** Tool results after the last assistant message (the ones this request answers). */
export function latestToolResults(r: CanonRequest): CanonToolResult[] {
  const out: CanonToolResult[] = [];
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i];
    if (m.role === 'assistant') break;
    if (m.toolResults) out.unshift(...m.toolResults);
  }
  return out;
}

const canonArgs = (a: unknown): string => {
  const v = typeof a === 'string' ? parseArgs(a) : a;
  return JSON.stringify(sortKeys(v));
};
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/**
 * Hash of what makes two requests "the same conversation": model, system, messages (role, text, tool calls by
 * name + arguments, tool results by content) and the offered tool names. Provider ids (call_…, toolu_…), the
 * provider format and stream mode do not count, so a recorded OpenAI chat call replays for the same Responses call.
 */
export function requestHash(r: CanonRequest): string {
  const norm = {
    model: r.model,
    system: r.system.trim(),
    messages: r.messages.map((m) => ({
      role: m.role,
      text: m.text.trim(),
      calls: (m.toolCalls ?? []).map((c) => [c.name, canonArgs(c.arguments)]),
      results: (m.toolResults ?? []).map((x) => x.content.trim()),
    })),
    tools: [...r.tools].sort(),
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

/** Rough token estimate: ceil(characters / 4). */
export const estimateTokens = (chars: number): number => (chars <= 0 ? 0 : Math.ceil(chars / 4));

export function inputChars(r: CanonRequest): number {
  let n = r.system.length;
  for (const m of r.messages) {
    n += m.text.length;
    for (const c of m.toolCalls ?? []) n += c.name.length + canonArgs(c.arguments).length;
    for (const x of m.toolResults ?? []) n += x.content.length;
  }
  return n;
}

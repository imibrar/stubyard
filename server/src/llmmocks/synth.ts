import { createHash, randomBytes, randomInt } from 'node:crypto';
import { estimateTokens, inputChars } from './normalize.js';
import type { CanonRequest, CanonResponse, LlmEndpoint, LlmProvider, StopReason } from './types.js';

/**
 * Render one canonical response as OpenAI Chat Completions, OpenAI Responses or Anthropic Messages, streamed (a list
 * of complete SSE frames) or as one JSON body. Usage is ceil(chars / 4) unless the mock sets it.
 */

type J = Record<string, unknown>;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function rid(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}
const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

export const ids = {
  chat: () => `chatcmpl-${rid(29)}`,
  call: () => `call_${rid(24)}`,
  resp: () => `resp_${hex(48)}`,
  respMsg: () => `msg_${hex(48)}`,
  fc: () => `fc_${hex(48)}`,
  anthropicMsg: () => `msg_01${rid(22)}`,
  toolu: () => `toolu_01${rid(22)}`,
  openAiRequest: () => `req_${hex(32)}`,
  anthropicRequest: () => `req_011C${rid(20)}`,
};

/** Map any provider's stop reason name to the canonical one. */
export function canonStop(s: unknown, hasTools: boolean): StopReason {
  const v = String(s ?? '').toLowerCase();
  if (v === 'tool_calls' || v === 'tool_use' || v === 'function_call') return 'tool_calls';
  if (v === 'length' || v === 'max_tokens' || v === 'max_output_tokens' || v === 'incomplete') return 'length';
  if (v === 'stop_sequence') return 'stop_sequence';
  if (v === 'stop' || v === 'end_turn' || v === 'completed') return 'stop';
  return hasTools ? 'tool_calls' : 'stop';
}

export interface Prepared {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  stop: StopReason;
  usage: { input: number; output: number };
  chunk: { size: number; delayMs: number };
}

const argString = (a: unknown): string => (typeof a === 'string' ? a : JSON.stringify(a ?? {}));

/** Fill ids, arguments as JSON text, stop reason, usage and chunking for one response. */
export function prepare(req: CanonRequest, res: CanonResponse, defaults: { size: number; delayMs: number }): Prepared {
  const text = res.text ?? '';
  const toolCalls = (res.toolCalls ?? []).map((c) => ({
    id: c.id || (req.provider === 'anthropic' ? ids.toolu() : ids.call()),
    name: String(c.name),
    arguments: argString(c.arguments),
  }));
  const outChars = text.length + toolCalls.reduce((n, c) => n + c.name.length + c.arguments.length, 0);
  return {
    text,
    toolCalls,
    stop: canonStop(res.stopReason, toolCalls.length > 0),
    usage: {
      input: res.usage?.input ?? estimateTokens(inputChars(req)),
      output: res.usage?.output ?? Math.max(1, estimateTokens(outChars)),
    },
    chunk: {
      size: Math.max(1, Math.floor(Number(res.chunk?.size ?? defaults.size) || defaults.size)),
      delayMs: Math.max(0, Math.min(10_000, Math.floor(Number(res.chunk?.delayMs ?? defaults.delayMs) || 0))),
    },
  };
}

/** Split text into pieces of `size` characters (code points, so emoji stay whole). */
export function pieces(text: string, size: number): string[] {
  if (!text) return [];
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

export interface Rendered {
  /** Non-stream JSON body. */
  json?: J;
  /** Stream: complete SSE frames ("data: …\n\n" or "event: …\ndata: …\n\n"). */
  frames?: string[];
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const ev = (type: string, o: unknown) => `event: ${type}\ndata: ${JSON.stringify(o)}\n\n`;
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- OpenAI Chat Completions

const chatFinish = (s: StopReason) => (s === 'tool_calls' ? 'tool_calls' : s === 'length' ? 'length' : 'stop');

export function toOpenAiChat(req: CanonRequest, p: Prepared, stream: boolean): Rendered {
  const id = ids.chat();
  const created = now();
  const model = req.model || 'gpt-mock';
  const usage = {
    prompt_tokens: p.usage.input,
    completion_tokens: p.usage.output,
    total_tokens: p.usage.input + p.usage.output,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
  if (!stream) {
    const message: J = { role: 'assistant', content: p.text || (p.toolCalls.length ? null : ''), refusal: null, annotations: [] };
    if (p.toolCalls.length) message.tool_calls = p.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
    return {
      json: {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: chatFinish(p.stop) }],
        usage,
        service_tier: 'default',
        system_fingerprint: 'fp_stubyard',
      },
    };
  }
  const base = (choices: unknown[], extra: J = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    service_tier: 'default',
    system_fingerprint: 'fp_stubyard',
    choices,
    ...(req.includeUsage ? { usage: null } : {}),
    ...extra,
  });
  const choice = (delta: J, finish: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finish });
  const frames: string[] = [data(base([choice({ role: 'assistant', content: '', refusal: null })]))];
  for (const t of pieces(p.text, p.chunk.size)) frames.push(data(base([choice({ content: t })])));
  p.toolCalls.forEach((c, index) => {
    frames.push(data(base([choice({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] })])));
    for (const a of pieces(c.arguments, p.chunk.size)) frames.push(data(base([choice({ tool_calls: [{ index, function: { arguments: a } }] })])));
  });
  frames.push(data(base([choice({}, chatFinish(p.stop))])));
  if (req.includeUsage) frames.push(data(base([], { usage })));
  frames.push('data: [DONE]\n\n');
  return { frames };
}

// ---------------------------------------------------------------- OpenAI Responses

export function toOpenAiResponses(req: CanonRequest, p: Prepared, stream: boolean, body: J): Rendered {
  const id = ids.resp();
  const created_at = now();
  const msgId = ids.respMsg();
  const incomplete = p.stop === 'length';
  const usage = {
    input_tokens: p.usage.input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: p.usage.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: p.usage.input + p.usage.output,
  };
  const textPart = (text: string) => ({ type: 'output_text', text, annotations: [], logprobs: [] });
  const messageItem = (status: string, text: string | null) => ({ id: msgId, type: 'message', status, role: 'assistant', content: text === null ? [] : [textPart(text)] });
  const calls = p.toolCalls.map((c) => ({ fcId: ids.fc(), ...c }));
  const fcItem = (c: (typeof calls)[number], status: string, args: string) => ({ id: c.fcId, type: 'function_call', status, arguments: args, call_id: c.id, name: c.name });
  const output: J[] = [];
  if (p.text || !calls.length) output.push(messageItem(incomplete ? 'incomplete' : 'completed', p.text));
  for (const c of calls) output.push(fcItem(c, 'completed', c.arguments));
  const response = (status: string, out: J[], u: unknown) => ({
    id,
    object: 'response',
    created_at,
    status,
    background: false,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof body.instructions === 'string' ? body.instructions : null,
    max_output_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : null,
    model: req.model || 'gpt-mock',
    output: out,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    service_tier: 'default',
    store: false,
    temperature: typeof body.temperature === 'number' ? body.temperature : 1,
    text: { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: typeof body.top_p === 'number' ? body.top_p : 1,
    truncation: 'disabled',
    usage: u,
    user: null,
    metadata: {},
  });
  const finalStatus = incomplete ? 'incomplete' : 'completed';
  if (!stream) return { json: response(finalStatus, output, usage) };

  let seq = 0;
  const frames: string[] = [];
  const push = (type: string, o: J) => frames.push(ev(type, { type, sequence_number: seq++, ...o }));
  push('response.created', { response: response('in_progress', [], null) });
  push('response.in_progress', { response: response('in_progress', [], null) });
  let outputIndex = 0;
  if (p.text || !calls.length) {
    const oi = outputIndex++;
    push('response.output_item.added', { output_index: oi, item: messageItem('in_progress', null) });
    push('response.content_part.added', { item_id: msgId, output_index: oi, content_index: 0, part: textPart('') });
    for (const t of pieces(p.text, p.chunk.size)) push('response.output_text.delta', { item_id: msgId, output_index: oi, content_index: 0, delta: t, logprobs: [] });
    push('response.output_text.done', { item_id: msgId, output_index: oi, content_index: 0, text: p.text, logprobs: [] });
    push('response.content_part.done', { item_id: msgId, output_index: oi, content_index: 0, part: textPart(p.text) });
    push('response.output_item.done', { output_index: oi, item: messageItem(incomplete ? 'incomplete' : 'completed', p.text) });
  }
  for (const c of calls) {
    const oi = outputIndex++;
    push('response.output_item.added', { output_index: oi, item: fcItem(c, 'in_progress', '') });
    for (const a of pieces(c.arguments, p.chunk.size)) push('response.function_call_arguments.delta', { item_id: c.fcId, output_index: oi, delta: a });
    push('response.function_call_arguments.done', { item_id: c.fcId, output_index: oi, arguments: c.arguments });
    push('response.output_item.done', { output_index: oi, item: fcItem(c, 'completed', c.arguments) });
  }
  push(incomplete ? 'response.incomplete' : 'response.completed', { response: response(finalStatus, output, usage) });
  return { frames };
}

// ---------------------------------------------------------------- Anthropic Messages

const anthropicStop = (s: StopReason) => (s === 'tool_calls' ? 'tool_use' : s === 'length' ? 'max_tokens' : s === 'stop_sequence' ? 'stop_sequence' : 'end_turn');

export function toAnthropic(req: CanonRequest, p: Prepared, stream: boolean): Rendered {
  const id = ids.anthropicMsg();
  const model = req.model || 'claude-mock';
  const parseInput = (a: string): unknown => {
    try {
      return JSON.parse(a);
    } catch {
      return {};
    }
  };
  const blocks: J[] = [];
  if (p.text || !p.toolCalls.length) blocks.push({ type: 'text', text: p.text });
  for (const c of p.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseInput(c.arguments) });
  const usage = (output: number) => ({ input_tokens: p.usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output, service_tier: 'standard' });
  if (!stream) {
    return { json: { id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: anthropicStop(p.stop), stop_sequence: null, usage: usage(p.usage.output) } };
  }
  const frames: string[] = [];
  frames.push(ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usage(1) } }));
  let index = 0;
  let pinged = false;
  const ping = () => {
    if (!pinged) frames.push(ev('ping', { type: 'ping' }));
    pinged = true;
  };
  if (p.text || !p.toolCalls.length) {
    frames.push(ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
    ping();
    for (const t of pieces(p.text, p.chunk.size)) frames.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }));
    frames.push(ev('content_block_stop', { type: 'content_block_stop', index }));
    index++;
  }
  for (const c of p.toolCalls) {
    frames.push(ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }));
    ping();
    frames.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } }));
    for (const a of pieces(c.arguments, p.chunk.size)) frames.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: a } }));
    frames.push(ev('content_block_stop', { type: 'content_block_stop', index }));
    index++;
  }
  frames.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicStop(p.stop), stop_sequence: null }, usage: { output_tokens: p.usage.output } }));
  frames.push(ev('message_stop', { type: 'message_stop' }));
  return { frames };
}

export function render(endpoint: LlmEndpoint, req: CanonRequest, p: Prepared, stream: boolean, body: J): Rendered {
  if (endpoint === 'responses') return toOpenAiResponses(req, p, stream, body);
  if (endpoint === 'messages') return toAnthropic(req, p, stream);
  return toOpenAiChat(req, p, stream);
}

// ---------------------------------------------------------------- errors

export interface ProviderError {
  status: number;
  headers: Record<string, string>;
  body: J;
}

/** A provider-shaped error body + request id header. kind: the Anthropic error type / OpenAI type. */
export function providerError(provider: LlmProvider, status: number, message: string, o: { type?: string; code?: string | null; param?: string | null; extra?: J } = {}): ProviderError {
  if (provider === 'anthropic') {
    const requestId = ids.anthropicRequest();
    return { status, headers: { 'request-id': requestId }, body: { type: 'error', error: { type: o.type ?? anthropicType(status), message, ...(o.extra ?? {}) }, request_id: requestId } };
  }
  return {
    status,
    headers: { 'x-request-id': ids.openAiRequest() },
    body: { error: { message, type: o.type ?? openAiType(status), param: o.param ?? null, code: o.code ?? null, ...(o.extra ?? {}) } },
  };
}

function anthropicType(status: number): string {
  return (
    ({ 400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error', 404: 'not_found_error', 409: 'conflict_error', 413: 'request_too_large', 429: 'rate_limit_error', 504: 'timeout_error', 529: 'overloaded_error' } as Record<number, string>)[status] ??
    (status >= 500 ? 'api_error' : 'invalid_request_error')
  );
}

function openAiType(status: number): string {
  if (status === 429) return 'requests';
  if (status === 503) return 'service_unavailable_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

/** The error frame a stream ends with for stream_error faults. */
export function streamErrorFrame(endpoint: LlmEndpoint, seq: number): string {
  if (endpoint === 'messages') return ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  if (endpoint === 'responses') return ev('error', { type: 'error', sequence_number: seq, code: 'server_error', message: 'The server had an error while processing your request (simulated by stubyard).', param: null });
  return data({ error: { message: 'The server had an error while processing your request (simulated by stubyard).', type: 'server_error', param: null, code: null } });
}

// ---------------------------------------------------------------- embeddings, models

/** Deterministic unit vector for a text: sha256(text) in counter mode → floats in [-1, 1] → L2-normalised. */
export function embedVector(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  let i = 0;
  for (let block = 0; i < dims; block++) {
    const h = createHash('sha256').update(`${block}:`).update(text).digest();
    for (let k = 0; k + 4 <= h.length && i < dims; k += 4) v[i++] = (h.readUInt32LE(k) / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (let k = 0; k < dims; k++) norm += v[k] * v[k];
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < dims; k++) v[k] /= norm;
  return v;
}

/** Little-endian float32 bytes as base64 (what encoding_format "base64" returns). */
export function vectorBase64(v: Float32Array): string {
  const b = Buffer.alloc(v.length * 4);
  for (let k = 0; k < v.length; k++) b.writeFloatLE(v[k], k * 4);
  return b.toString('base64');
}

export const DEFAULT_MODELS: Record<LlmProvider, string[]> = {
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small', 'text-embedding-3-large'],
  anthropic: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
};

export const openAiModel = (id: string) => ({ id, object: 'model', created: 1_735_689_600, owned_by: 'stubyard' });
export const anthropicModel = (id: string) => ({ type: 'model', id, display_name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), created_at: '2025-01-01T00:00:00Z' });

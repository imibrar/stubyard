import type { CanonResponse, LlmEndpoint } from './types.js';
import { canonStop } from './synth.js';

/**
 * Read a provider reply (JSON body, or the SSE text of a stream) back into a canonical response. Used by
 * record-to-mock, and by the tests' strict parsers as a cross-check.
 */

type J = Record<string, any>;

export interface SseEvent {
  event: string | null;
  data: string;
}

/** Split SSE text into events (blank-line separated; multi-line data joined by "\n"; comments skipped). */
export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (event !== null || data.length) out.push({ event, data: data.join('\n') });
  }
  return out;
}

const tryJson = (s: string): J | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};
const args = (s: unknown): unknown => {
  if (typeof s !== 'string') return s ?? {};
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

function finish(text: string, calls: { id?: string; name: string; arguments: unknown }[], stop: unknown, input: number | null, output: number | null): CanonResponse {
  const r: CanonResponse = { text, stopReason: canonStop(stop, calls.length > 0) };
  if (calls.length) r.toolCalls = calls;
  if (input !== null || output !== null) r.usage = { ...(input !== null ? { input } : {}), ...(output !== null ? { output } : {}) };
  return r;
}
/** Upstream replies are untrusted: list items may be null, strings, … */
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const objs = (v: unknown): J[] => (Array.isArray(v) ? v.filter(isObj) : []);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function fromChatJson(b: J): CanonResponse {
  const ch = objs(b.choices)[0] ?? {};
  const m = isObj(ch.message) ? ch.message : {};
  const calls = objs(m.tool_calls).map((c: J) => ({ id: c.id, name: String(c.function?.name ?? ''), arguments: args(c.function?.arguments) }));
  return finish(typeof m.content === 'string' ? m.content : '', calls, ch.finish_reason, n(b.usage?.prompt_tokens), n(b.usage?.completion_tokens));
}

function fromChatStream(events: SseEvent[]): CanonResponse | null {
  let text = '';
  const calls: { id?: string; name: string; args: string }[] = [];
  let stop: unknown = null;
  let input: number | null = null;
  let output: number | null = null;
  let any = false;
  for (const e of events) {
    if (e.data === '[DONE]') continue;
    const c = tryJson(e.data);
    if (!c || c.error) continue;
    any = true;
    if (c.usage) {
      input = n(c.usage.prompt_tokens) ?? input;
      output = n(c.usage.completion_tokens) ?? output;
    }
    for (const ch of objs(c.choices)) {
      const d = isObj(ch.delta) ? ch.delta : {};
      if (typeof d.content === 'string') text += d.content;
      for (const t of objs(d.tool_calls)) {
        const i = Number(t.index ?? 0);
        if (!Number.isInteger(i) || i < 0 || i > 1000) continue;
        calls[i] ??= { name: '', args: '' };
        if (t.id) calls[i].id = t.id;
        if (t.function?.name) calls[i].name += t.function.name;
        if (typeof t.function?.arguments === 'string') calls[i].args += t.function.arguments;
      }
      if (ch.finish_reason) stop = ch.finish_reason;
    }
  }
  if (!any) return null;
  return finish(text, calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, arguments: args(c.args) })), stop, input, output);
}

function fromResponsesJson(b: J): CanonResponse {
  let text = '';
  const calls: { id?: string; name: string; arguments: unknown }[] = [];
  for (const it of objs(b.output)) {
    if (it.type === 'message') for (const p of objs(it.content)) if (p.type === 'output_text' && typeof p.text === 'string') text += p.text;
    if (it.type === 'function_call') calls.push({ id: it.call_id, name: String(it.name ?? ''), arguments: args(it.arguments) });
  }
  const stop = b.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop';
  return finish(text, calls, stop, n(b.usage?.input_tokens), n(b.usage?.output_tokens));
}

function fromResponsesStream(events: SseEvent[]): CanonResponse | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = tryJson(events[i].data);
    if (d && (d.type === 'response.completed' || d.type === 'response.incomplete') && isObj(d.response)) return fromResponsesJson(d.response);
  }
  // No final event: rebuild from deltas.
  let text = '';
  let any = false;
  const calls = new Map<string, { id?: string; name: string; args: string }>();
  for (const e of events) {
    const d = tryJson(e.data);
    if (!d) continue;
    any = true;
    if (d.type === 'response.output_text.delta') text += String(d.delta ?? '');
    if (d.type === 'response.output_item.added' && isObj(d.item) && d.item.type === 'function_call') calls.set(d.item.id, { id: d.item.call_id, name: d.item.name, args: '' });
    if (d.type === 'response.function_call_arguments.delta' && calls.has(d.item_id)) calls.get(d.item_id)!.args += String(d.delta ?? '');
  }
  if (!any) return null;
  const list = [...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: args(c.args) }));
  return finish(text, list, null, null, null);
}

function fromAnthropicJson(b: J): CanonResponse {
  let text = '';
  const calls: { id?: string; name: string; arguments: unknown }[] = [];
  for (const c of objs(b.content)) {
    if (c.type === 'text') text += String(c.text ?? '');
    if (c.type === 'tool_use') calls.push({ id: c.id, name: String(c.name ?? ''), arguments: c.input ?? {} });
  }
  return finish(text, calls, b.stop_reason, n(b.usage?.input_tokens), n(b.usage?.output_tokens));
}

function fromAnthropicStream(events: SseEvent[]): CanonResponse | null {
  const blocks: { type: string; text: string; id?: string; name?: string; json: string }[] = [];
  let stop: unknown = null;
  let input: number | null = null;
  let output: number | null = null;
  let any = false;
  for (const e of events) {
    const d = tryJson(e.data);
    if (!d) continue;
    any = true;
    if (d.type === 'message_start') {
      input = n(d.message?.usage?.input_tokens);
      output = n(d.message?.usage?.output_tokens);
    } else if (d.type === 'content_block_start') {
      const b = isObj(d.content_block) ? d.content_block : {};
      const i = Number(d.index ?? 0);
      if (!Number.isInteger(i) || i < 0 || i > 1000) continue;
      blocks[i] = { type: String(b.type), text: String(b.text ?? ''), id: b.id, name: b.name, json: '' };
    } else if (d.type === 'content_block_delta') {
      const b = blocks[Number(d.index ?? 0)];
      if (!b) continue;
      if (d.delta?.type === 'text_delta') b.text += String(d.delta.text ?? '');
      if (d.delta?.type === 'input_json_delta') b.json += String(d.delta.partial_json ?? '');
    } else if (d.type === 'message_delta') {
      stop = d.delta?.stop_reason ?? stop;
      output = n(d.usage?.output_tokens) ?? output;
    }
  }
  if (!any) return null;
  let text = '';
  const calls: { id?: string; name: string; arguments: unknown }[] = [];
  for (const b of blocks.filter(Boolean)) {
    if (b.type === 'text') text += b.text;
    if (b.type === 'tool_use') calls.push({ id: b.id, name: String(b.name ?? ''), arguments: args(b.json) });
  }
  return finish(text, calls, stop, input, output);
}

/** Canonical response of a reply body; null when it cannot be read. */
export function canonFromReply(endpoint: LlmEndpoint, stream: boolean, body: string): CanonResponse | null {
  if (stream) {
    const events = parseSse(body);
    if (endpoint === 'responses') return fromResponsesStream(events);
    if (endpoint === 'messages') return fromAnthropicStream(events);
    return fromChatStream(events);
  }
  const b = tryJson(body);
  if (!b) return null;
  if (endpoint === 'responses') return fromResponsesJson(b);
  if (endpoint === 'messages') return fromAnthropicJson(b);
  return fromChatJson(b);
}

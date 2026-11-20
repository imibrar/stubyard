import { renderTemplate, type TemplateContext } from '../mocks/match.js';
import { HttpError } from '../util.js';
import { lastUserText, latestToolResults, turnOf } from './normalize.js';
import type { CanonRequest, CanonResponse, LlmMatch, LlmMatchText } from './types.js';

/** Matching scripted LLM mocks against a canonical request, faults, and response templates. */

export interface MatchableMock {
  provider: string;
  match: LlmMatch;
  remaining: number | null;
}

const globCache = new Map<string, RegExp>();
export function globMatch(glob: string, value: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = new RegExp('^' + glob.split('*').map((s) => s.split('?').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*') + '$', 'i');
    globCache.set(glob, re);
  }
  return re.test(value);
}

/** "/abc/i" → RegExp(abc, i); anything else → case-sensitive RegExp. Invalid → null. */
export function toRegex(src: string): RegExp | null {
  try {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
    return m ? new RegExp(m[1], m[2]) : new RegExp(src);
  } catch {
    return null;
  }
}

function textOk(m: LlmMatchText, text: string): string | null {
  if (m.equals !== undefined && text.trim() !== String(m.equals).trim()) return `last user message is not "${clip(m.equals)}"`;
  if (m.contains !== undefined && !text.toLowerCase().includes(String(m.contains).toLowerCase())) return `last user message does not contain "${clip(m.contains)}"`;
  if (m.regex !== undefined) {
    const re = toRegex(String(m.regex));
    if (!re || !re.test(text)) return `last user message does not match /${clip(m.regex)}/`;
  }
  return null;
}
const clip = (s: unknown) => {
  const t = String(s);
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
};

/** null = matches; otherwise the reason it does not. */
export function whyNot(mock: MatchableMock, req: CanonRequest): string | null {
  if (mock.remaining !== null && mock.remaining <= 0) return 'used up (times reached 0)';
  if (mock.provider !== 'any' && mock.provider !== req.provider) return `provider is ${mock.provider}`;
  const m = mock.match ?? {};
  if (m.endpoint !== undefined) {
    const list = Array.isArray(m.endpoint) ? m.endpoint : [m.endpoint];
    if (list.length && !list.includes(req.endpoint)) return `endpoint is ${list.join('|')}`;
  }
  if (m.model && !globMatch(m.model, req.model)) return `model is not ${m.model}`;
  if (m.stream !== undefined && m.stream !== req.stream) return m.stream ? 'request is not streamed' : 'request is streamed';
  if (m.turn !== undefined && m.turn !== null && turnOf(req) !== Number(m.turn)) return `turn is ${turnOf(req)}, not ${m.turn}`;
  if (m.hasTool && !req.tools.includes(m.hasTool)) return `tool "${m.hasTool}" not offered`;
  if (m.system?.contains && !req.system.toLowerCase().includes(String(m.system.contains).toLowerCase())) return `system prompt does not contain "${clip(m.system.contains)}"`;
  if (m.lastUser) {
    const r = textOk(m.lastUser, lastUserText(req));
    if (r) return r;
  }
  if (m.toolResult) {
    const results = latestToolResults(req);
    const want = m.toolResult;
    const hit = results.some((x) => (!want.name || x.name === want.name) && (!want.contains || x.content.toLowerCase().includes(String(want.contains).toLowerCase())));
    if (!hit) return results.length ? `no tool result${want.name ? ` from "${want.name}"` : ''}${want.contains ? ` containing "${clip(want.contains)}"` : ''}` : 'no tool result in this request';
  }
  return null;
}

/** Which response a mock plays for its n-th hit (n counts from 0). */
export function pickIndex(mode: string, hits: number, count: number): number {
  if (count <= 1) return 0;
  if (mode === 'sequence') return Math.min(hits, count - 1);
  if (mode === 'cycle') return hits % count;
  return 0;
}

/** Fill {{lastUser}} and the API-mock templates ({{body.model}}, {{uuid}}, {{now}}, …) in the response text. */
export function renderResponse(res: CanonResponse, req: CanonRequest, ctx: TemplateContext): CanonResponse {
  const fill = (s: string) => renderTemplate(s.replace(/\{\{\s*lastUser\s*\}\}/g, () => lastUserText(req)).replace(/\{\{\s*model\s*\}\}/g, () => req.model), ctx);
  return {
    ...res,
    ...(typeof res.text === 'string' ? { text: fill(res.text) } : {}),
    ...(res.toolCalls ? { toolCalls: res.toolCalls.map((c) => ({ ...c, arguments: typeof c.arguments === 'string' ? fill(c.arguments) : c.arguments })) } : {}),
  };
}

// ---------------------------------------------------------------- faults

export const FAULT_KINDS = ['rate_limit', 'error', 'overloaded', 'timeout', 'drop', 'malformed', 'cut', 'slow', 'auth', 'context_length', 'stream_error'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export interface Fault {
  kind: FaultKind;
  /** rate_limit: retry-after seconds; error: status; cut / stream_error: frames before; slow: ms. */
  arg: number | null;
  spec: string;
}

export const FAULT_HELP: { fault: string; does: string }[] = [
  { fault: 'rate_limit[:secs]', does: '429 with retry-after (default 1 s); OpenAI also retry-after-ms and x-ratelimit-* headers, Anthropic anthropic-ratelimit-* headers' },
  { fault: 'error[:status]', does: 'Provider error with that status (default 500)' },
  { fault: 'overloaded', does: 'Anthropic 529 overloaded_error, OpenAI 503 service_unavailable_error / server_is_overloaded' },
  { fault: 'timeout', does: 'Accept the request and never answer (connection closed after the hold time)' },
  { fault: 'drop', does: 'Close the connection without a response' },
  { fault: 'malformed', does: 'Broken JSON: in one SSE data line (streams) or the body (non-stream)' },
  { fault: 'cut[:n]', does: 'Close the connection after n stream frames (default 3), without the terminator' },
  { fault: 'stream_error[:n]', does: 'After n frames (default 2) send the provider error event (Anthropic event: error, OpenAI error chunk / Responses error event)' },
  { fault: 'slow:ms', does: 'Wait ms before answering normally' },
  { fault: 'auth', does: '401 invalid API key (OpenAI invalid_api_key, Anthropic authentication_error)' },
  { fault: 'context_length', does: '400 context too long (OpenAI context_length_exceeded, Anthropic invalid_request_error "prompt is too long")' },
];

/** Parse "rate_limit:2", "error:503", "cut:4", "slow:1500". Throws 400 on anything else (strict) or returns null. */
export function parseFault(spec: unknown, strict = true): Fault | null {
  const s = String(spec ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = /^([a-z_-]+)(?::(\d+))?$/.exec(s);
  const kind = m?.[1].replace(/-/g, '_') as FaultKind | undefined;
  if (!m || !kind || !(FAULT_KINDS as readonly string[]).includes(kind)) {
    if (strict) throw new HttpError(400, `Unknown LLM fault "${s}". Use one of: ${FAULT_HELP.map((f) => f.fault).join(', ')}`);
    return null;
  }
  const arg = m[2] === undefined ? null : Number(m[2]);
  if (kind === 'error' && arg !== null && !(arg >= 400 && arg <= 599)) {
    if (strict) throw new HttpError(400, 'error:<status> needs a status from 400 to 599');
    return null;
  }
  if (kind === 'slow' && arg === null) {
    if (strict) throw new HttpError(400, 'slow needs a delay: slow:<ms>');
    return null;
  }
  return { kind, arg, spec: arg === null ? kind : `${kind}:${arg}` };
}

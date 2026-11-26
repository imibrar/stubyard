import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { LogOutcome } from '../repos/logs.js';
import type { Project } from '../repos/projects.js';
import { crossSiteChecker } from '../http/guard.js';
import { trimEnd } from '../util.js';
import { tagLog } from '../runs/resolver.js';
import type { Fault } from './match.js';
import { renderResponse } from './match.js';
import { estimateTokens, inputChars, lastUserText, latestToolResults, normalizeRequest, turnOf } from './normalize.js';
import { forwardToUpstream } from './record.js';
import type { LlmCallMode } from './repo.js';
import { anthropicModel, embedVector, openAiModel, prepare, providerError, render, streamErrorFrame, vectorBase64, type ProviderError } from './synth.js';
import type { CanonRequest, CanonResponse, LlmEndpoint, LlmProvider } from './types.js';

/**
 * /llm/<project>/<openai|anthropic>/… : answer like the real API from scripted mocks, recordings or the fallback,
 * with faults. Streams are written by hand (reply.hijack), so the traffic log entry of a stream is finished here.
 */

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REQUEST_CLIP = 16 * 1024;
const checkers = new WeakMap<Hub, ReturnType<typeof crossSiteChecker>>();
/** The dashboard guard's cross-site check, built once per hub. */
function crossSiteOf(hub: Hub): ReturnType<typeof crossSiteChecker> {
  let f = checkers.get(hub);
  if (!f) checkers.set(hub, (f = crossSiteChecker(hub.config)));
  return f;
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-request-id, request-id, retry-after, retry-after-ms, x-hub-request-id' };

export interface LlmCtx {
  hub: Hub;
  req: FastifyRequest;
  reply: FastifyReply;
  project: Project;
  provider: LlmProvider;
  endpoint: LlmEndpoint;
  /** Path below /llm/<project>/<provider>, e.g. /v1/chat/completions. */
  path: string;
  canon: CanonRequest;
  runId: string | null;
  resolved: J;
  t0: number;
}

/** Which endpoint a method + path is (null = not simulated). */
export function endpointOf(provider: LlmProvider, method: string, path: string): { endpoint: LlmEndpoint; modelId?: string } | null {
  const p = trimEnd(path, '/');
  if (method === 'GET' || method === 'HEAD') {
    if (p === '/v1/models') return { endpoint: 'models' };
    const m = /^\/v1\/models\/(.+)$/.exec(p);
    if (m) return { endpoint: 'models', modelId: decodeURIComponent(m[1]) };
    return null;
  }
  if (method !== 'POST') return null;
  if (provider === 'openai') {
    if (p === '/v1/chat/completions') return { endpoint: 'chat' };
    if (p === '/v1/responses') return { endpoint: 'responses' };
    if (p === '/v1/embeddings') return { endpoint: 'embeddings' };
    return null;
  }
  if (p === '/v1/messages') return { endpoint: 'messages' };
  if (p === '/v1/messages/count_tokens') return { endpoint: 'count_tokens' };
  return null;
}

/** Send a provider-shaped JSON error (normal reply, so the generic traffic hooks log it). */
function sendError(reply: FastifyReply, e: ProviderError, extraHeaders: Record<string, string> = {}, cors = true) {
  return reply.status(e.status).headers({ ...(cors ? CORS : {}), ...e.headers, ...extraHeaders }).type('application/json').send(JSON.stringify(e.body));
}

function clipRequest(req: FastifyRequest): unknown {
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (raw.length <= REQUEST_CLIP) return isObj(req.body) ? req.body : raw || null;
  return { truncated: true, size: raw.length, text: raw.slice(0, REQUEST_CLIP) };
}

/** Request summary stored on the call row. */
function requestSummary(c: LlmCtx): J {
  return { lastUser: lastUserText(c.canon), turn: turnOf(c.canon), tools: c.canon.tools, system: c.canon.system.slice(0, 2000), messages: c.canon.messages.length, toolResults: latestToolResults(c.canon).map((t) => t.name ?? t.id ?? ''), body: clipRequest(c.req) };
}

export function logCall(c: LlmCtx, o: { mode: LlmCallMode; mockId?: string | null; fault?: string | null; status: number | null; tokensIn?: number | null; tokensOut?: number | null; response: unknown }) {
  c.hub.llm.logCall({
    projectId: c.project.id,
    runId: c.runId,
    logId: c.req.trafficLogId ?? (c.resolved.__logId as string | undefined) ?? null,
    provider: c.provider,
    endpoint: c.endpoint,
    model: c.canon.model || null,
    stream: c.canon.stream,
    mode: o.mode,
    mockId: o.mockId ?? null,
    fault: o.fault ?? null,
    status: o.status,
    tokensIn: o.tokensIn ?? null,
    tokensOut: o.tokensOut ?? null,
    durationMs: Date.now() - c.t0,
    request: requestSummary(c),
    response: o.response,
  });
}

/** Take over the response: the traffic log entry is finished by finishHijacked. Returns the log id. */
export function hijack(c: LlmCtx): string | undefined {
  const id = c.req.trafficLogId;
  c.resolved.__logId = id;
  // We finish the log entry ourselves; stop the generic onRequestAbort hook from marking it "client_aborted".
  c.req.trafficLogId = undefined;
  c.reply.hijack();
  return id;
}

export function finishHijacked(c: LlmCtx, logId: string | undefined, o: { status: number | null; headers?: Record<string, unknown>; body?: string | null; outcome: LogOutcome; errorType?: string; errorMessage?: string }) {
  if (!logId) return;
  const { hub, req } = c;
  const reqBody = hub.traffic.clip(req.rawBody ?? null);
  const resBody = hub.traffic.clip(o.body ?? null);
  const { __logId: _drop, ...resolved } = c.resolved;
  hub.traffic.mergeResolved(logId, resolved);
  hub.traffic.finish(logId, {
    outcome: o.outcome,
    resStatus: o.status,
    resHeaders: o.headers ?? null,
    resBody: resBody.text,
    resBodySize: resBody.size,
    resTruncated: resBody.truncated,
    reqBody: reqBody.text,
    reqBodySize: reqBody.size,
    reqTruncated: reqBody.truncated,
    ...(o.errorType ? { errorType: o.errorType, errorMessage: o.errorMessage ?? null } : {}),
  });
}

/**
 * Run a hijacked section: an exception ends the socket and still finishes the traffic log entry (internal_error),
 * so a bad mock can never leave the client hanging or the log row pending.
 */
export async function guardHijacked(c: LlmCtx, logId: string | undefined, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    const res = c.reply.raw;
    if (!res.headersSent && !res.destroyed) {
      try {
        res.writeHead(500, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stubyard failed while writing this reply', type: 'server_error' } }));
      } catch {
        res.destroy();
      }
    } else if (!res.destroyed) res.destroy();
    finishHijacked(c, logId, { status: res.headersSent ? res.statusCode : 500, outcome: 'internal_error', errorType: 'internal_error', errorMessage: (e as Error)?.message ?? String(e) });
  }
}

/** Write SSE frames with a pause between them; cut / stream_error / malformed shape the stream. */
async function writeFrames(c: LlmCtx, frames: string[], delayMs: number, fault: Fault | null, status = 200, extraHeaders: Record<string, string> = {}): Promise<void> {
  const logId = hijack(c);
  await guardHijacked(c, logId, () => writeFramesHijacked(c, logId, frames, delayMs, fault, status, extraHeaders));
}

async function writeFramesHijacked(c: LlmCtx, logId: string | undefined, frames: string[], delayMs: number, fault: Fault | null, status: number, extraHeaders: Record<string, string>): Promise<void> {
  const res = c.reply.raw;
  const headers: Record<string, unknown> = {
    ...(c.reply.getHeaders() as Record<string, unknown>),
    ...CORS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(c.provider === 'anthropic' ? { 'request-id': `req_011C${Math.random().toString(36).slice(2, 14)}` } : { 'x-request-id': `req_${Math.random().toString(16).slice(2, 18)}` }),
    ...extraHeaders,
  };
  let list = frames;
  if (fault?.kind === 'malformed' && list.length) {
    const k = Math.min(2, Math.max(0, list.length - 2));
    list = [...list];
    list[k] = breakFrame(list[k]);
  }
  const cutAt = fault?.kind === 'cut' ? Math.max(0, fault.arg ?? 3) : fault?.kind === 'stream_error' ? Math.max(0, fault.arg ?? 2) : null;
  let closed = false;
  res.on('close', () => (closed = true));
  res.writeHead(status, headers as Record<string, string>);
  let sent = '';
  for (let i = 0; i < list.length; i++) {
    if (closed) break;
    if (cutAt !== null && i >= cutAt) break;
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    // Wait until the frame is flushed: a cut must not lose frames that were already "sent".
    await new Promise<void>((r) => res.write(list[i], () => r()));
    sent += list[i];
  }
  let outcome: LogOutcome = fault ? 'forced_error' : 'ok';
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  if (closed) {
    outcome = 'network_error';
    errorType = 'client_aborted';
    errorMessage = 'Client closed the stream before it ended';
  } else if (fault?.kind === 'cut') {
    errorType = 'simulated_cut';
    errorMessage = `Stream cut after ${cutAt} frame(s) (fault cut)`;
    res.socket?.destroy();
    res.destroy();
  } else {
    if (fault?.kind === 'stream_error') {
      const f = streamErrorFrame(c.endpoint, cutAt ?? 0);
      res.write(f);
      sent += f;
      errorType = 'simulated_stream_error';
      errorMessage = `Provider error event after ${cutAt} frame(s)`;
    }
    res.end();
  }
  finishHijacked(c, logId, { status, headers, body: sent, outcome, errorType, errorMessage });
}

/** "data: {json}" → "data: {js" (the JSON cut in half): a malformed SSE line. */
function breakFrame(frame: string | undefined): string {
  if (typeof frame !== 'string') return '';
  const i = frame.lastIndexOf('data: ');
  if (i < 0) return frame;
  const json = frame.slice(i + 6).replace(/\n+$/, '');
  return frame.slice(0, i + 6) + json.slice(0, Math.max(1, Math.floor(json.length / 2))) + '\n\n';
}

/** Answer with a terminal fault (rate limit, errors, timeout, drop, auth, context length). */
async function sendFault(c: LlmCtx, f: Fault): Promise<ProviderError | null> {
  const { provider } = c;
  if (f.kind === 'timeout' || f.kind === 'drop') {
    const logId = hijack(c);
    if (f.kind === 'timeout') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, c.hub.config.timeoutHoldMs);
        c.req.raw.once('close', () => (clearTimeout(t), resolve()));
        c.reply.raw.once('close', () => (clearTimeout(t), resolve()));
      });
    }
    c.req.raw.socket?.destroy();
    finishHijacked(c, logId, {
      status: null,
      outcome: 'forced_error',
      errorType: f.kind === 'timeout' ? 'simulated_timeout' : 'simulated_drop',
      errorMessage: f.kind === 'timeout' ? 'LLM fault timeout: no response' : 'LLM fault drop: connection closed without a response',
    });
    return null;
  }
  let e: ProviderError;
  const headers: Record<string, string> = {};
  if (f.kind === 'rate_limit') {
    const secs = Math.max(0, f.arg ?? 1);
    headers['retry-after'] = String(secs);
    if (provider === 'openai') {
      Object.assign(headers, {
        'retry-after-ms': String(secs * 1000),
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': `${secs}s`,
        'x-ratelimit-limit-tokens': '200000',
        'x-ratelimit-remaining-tokens': '0',
        'x-ratelimit-reset-tokens': `${secs}s`,
      });
      e = providerError('openai', 429, `Rate limit reached for ${c.canon.model || 'model'} on requests per min (RPM): Limit 500, Used 500, Requested 1. Please try again in ${secs}s. (simulated by stubyard)`, { type: 'requests', code: 'rate_limit_exceeded' });
    } else {
      const reset = new Date(Date.now() + secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      Object.assign(headers, {
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': reset,
        'anthropic-ratelimit-tokens-limit': '40000',
        'anthropic-ratelimit-tokens-remaining': '0',
        'anthropic-ratelimit-tokens-reset': reset,
      });
      e = providerError('anthropic', 429, 'Number of request tokens has exceeded your per-minute rate limit (simulated by stubyard)');
    }
  } else if (f.kind === 'overloaded') {
    e = provider === 'anthropic' ? providerError('anthropic', 529, 'Overloaded') : providerError('openai', 503, 'The server is overloaded. Please try again later. (simulated by stubyard)', { type: 'service_unavailable_error', code: 'server_is_overloaded' });
  } else if (f.kind === 'auth') {
    e = provider === 'anthropic' ? providerError('anthropic', 401, 'invalid x-api-key') : providerError('openai', 401, 'Incorrect API key provided: sk-****. You can find your API key at https://platform.openai.com/account/api-keys. (simulated by stubyard)', { type: 'invalid_request_error', code: 'invalid_api_key' });
  } else if (f.kind === 'context_length') {
    const n = Math.max(estimateTokens(inputChars(c.canon)), 1) + 200_000;
    e =
      provider === 'anthropic'
        ? providerError('anthropic', 400, `prompt is too long: ${n} tokens > 200000 maximum`)
        : providerError('openai', 400, `This model's maximum context length is 128000 tokens. However, your messages resulted in ${n} tokens. Please reduce the length of the messages.`, { type: 'invalid_request_error', code: 'context_length_exceeded', param: 'messages' });
  } else {
    // error[:status] (and stream_error on a non-stream request)
    const status = f.kind === 'error' ? (f.arg ?? 500) : 500;
    e = provider === 'anthropic' ? providerError('anthropic', status, status >= 500 ? 'Internal server error (simulated by stubyard)' : `Simulated error ${status}`) : providerError('openai', status, status >= 500 ? 'The server had an error while processing your request. Sorry about that! (simulated by stubyard)' : `Simulated error ${status}`);
  }
  c.req.trafficOutcome = 'forced_error';
  await sendError(c.reply, e, headers);
  return e;
}

const TERMINAL = new Set(['rate_limit', 'error', 'overloaded', 'timeout', 'drop', 'auth', 'context_length']);

/** Validate a request like the real API does (the errors an SDK would surface). null = fine. */
function validate(provider: LlmProvider, endpoint: LlmEndpoint, body: J, req: FastifyRequest, warnings: string[]): ProviderError | null {
  if (req.bodyError) {
    return provider === 'anthropic' ? providerError('anthropic', 400, `Invalid JSON body: ${req.bodyError}`) : providerError('openai', 400, `We could not parse the JSON body of your request. (${req.bodyError})`);
  }
  const missing = (param: string) =>
    provider === 'anthropic' ? providerError('anthropic', 400, `${param}: Field required`) : providerError('openai', 400, `Missing required parameter: '${param}'.`, { code: 'missing_required_parameter', param });
  if (!body.model && endpoint !== 'models') return missing('model');
  if (endpoint === 'chat' && !(Array.isArray(body.messages) && body.messages.length)) return missing('messages');
  if (endpoint === 'responses') {
    if (body.input === undefined || body.input === null) return missing('input');
    if (body.previous_response_id) {
      return providerError('openai', 400, `Previous response with id '${String(body.previous_response_id)}' not found. stubyard does not store responses (previous_response_id is not simulated): send the whole conversation in input.`, {
        code: 'previous_response_not_found',
        param: 'previous_response_id',
      });
    }
  }
  if (endpoint === 'embeddings' && (body.input === undefined || body.input === null || body.input === '')) return missing('input');
  if (endpoint === 'messages' || endpoint === 'count_tokens') {
    if (!Array.isArray(body.messages)) return missing('messages');
    if (endpoint === 'messages' && body.max_tokens === undefined) return missing('max_tokens');
    if (!req.headers['anthropic-version']) warnings.push('anthropic-version header missing (the real API requires it, e.g. "2023-06-01")');
  }
  return null;
}

/** The fallback reply when no mock matches (null = provider-shaped 404). */
function fallbackResponse(c: LlmCtx): CanonResponse | null {
  const s = c.hub.llm.settings(c.project.id);
  if (s.fallback === 'echo') return { text: `Echo: ${lastUserText(c.canon)}` };
  if (s.fallback === 'text') return { text: s.fallbackText };
  return null;
}

export async function handleLlmRequest(hub: Hub, req: FastifyRequest, reply: FastifyReply, project: Project, provider: LlmProvider, path: string): Promise<unknown> {
  const t0 = Date.now();
  const resolved: J = { project: project.slug, kind: 'llm', provider, path };
  req.trafficResolved = resolved;
  const ep = endpointOf(provider, req.method, path);
  if (!ep) {
    req.trafficOutcome = 'unmatched';
    const e = providerError(provider, 404, `stubyard does not simulate ${req.method} ${path} for ${provider}. Simulated: ${provider === 'openai' ? 'POST /v1/chat/completions, POST /v1/responses, POST /v1/embeddings, GET /v1/models' : 'POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models'} (base URL ${provider === 'openai' ? `/llm/${project.slug}/openai/v1` : `/llm/${project.slug}/anthropic`}).`, { type: provider === 'anthropic' ? 'not_found_error' : 'invalid_request_error' });
    return sendError(reply, e);
  }
  const endpoint = ep.endpoint;
  resolved.endpoint = endpoint;
  const attribution = hub.runs.resolver.forRequest(project.id, req);
  tagLog(hub, req.trafficLogId, attribution);
  const runId = attribution.run?.id ?? null;

  if (endpoint === 'models') {
    const ids = hub.llm.models(project.id, provider);
    if (ep.modelId) {
      return reply.headers(CORS).send(provider === 'openai' ? openAiModel(ep.modelId) : anthropicModel(ep.modelId));
    }
    return reply.headers(CORS).send(
      provider === 'openai' ? { object: 'list', data: ids.map(openAiModel) } : { data: ids.map(anthropicModel), has_more: false, first_id: ids[0] ?? null, last_id: ids[ids.length - 1] ?? null },
    );
  }

  const body = isObj(req.body) ? req.body : {};
  const warnings: string[] = [];
  const invalid = validate(provider, endpoint, body, req, warnings);
  if (warnings.length) resolved.warnings = warnings;
  const canon = normalizeRequest(provider, endpoint, body);
  resolved.model = canon.model;
  resolved.stream = canon.stream;
  const c: LlmCtx = { hub, req, reply, project, provider, endpoint, path, canon, runId, resolved, t0 };
  if (invalid) {
    logCall(c, { mode: 'unmatched', status: invalid.status, response: { error: invalid.body } });
    resolved.mode = 'invalid';
    return sendError(reply, invalid);
  }

  const headerRaw = req.headers['x-hub-scenario'];
  const header = (Array.isArray(headerRaw) ? headerRaw[0] : headerRaw) ?? null;
  const conversational = endpoint === 'chat' || endpoint === 'responses' || endpoint === 'messages';
  // (activeRecording also stops recordings whose time is up.)
  const rec0 = conversational ? hub.llm.repo.activeRecording(project.id, provider) : null;
  const rec = rec0 && (!rec0.runId || rec0.runId === runId) ? rec0 : null;
  let pick = hub.llm.pick(project.id, canon, runId, header, { content: conversational && rec?.mode !== 'all' });
  if (pick.unknownHeader) resolved.unknownScenarioHeader = pick.unknownHeader;
  let fault = pick.fault;
  if (fault) Object.assign(resolved, { fault: fault.spec, faultSource: pick.faultSource });

  if (fault?.kind === 'slow') {
    await sleep(Math.min(Math.max(0, fault.arg ?? 0), 600_000));
    fault = null;
  }
  if (fault && (TERMINAL.has(fault.kind) || (fault.kind === 'stream_error' && !canon.stream && conversational))) {
    resolved.mode = 'fault';
    const e = await sendFault(c, fault);
    logCall(c, { mode: 'fault', mockId: pick.faultMock?.id ?? pick.mock?.id ?? null, fault: fault.spec, status: e?.status ?? null, response: e ? { error: e.body } : { error: fault.kind } });
    return reply;
  }

  // ---------- non-conversational endpoints
  if (endpoint === 'embeddings') return sendEmbeddings(c, body, fault);
  if (endpoint === 'count_tokens') {
    const n = estimateTokens(inputChars(canon));
    resolved.mode = 'mock';
    logCall(c, { mode: 'mock', status: 200, tokensIn: n, response: { input_tokens: n } });
    return reply.headers(CORS).send({ input_tokens: n });
  }

  // ---------- record (no mock answered, or mode "all")
  if (rec && !pick.mock) {
    resolved.mode = 'record';
    resolved.recording = rec.id;
    // Recording spends the stored provider key: never for another web page (no CORS on anything below either).
    const crossSite = crossSiteOf(hub)(req.headers);
    if (crossSite) {
      req.trafficOutcome = 'forced_error';
      resolved.recordRefused = crossSite;
      const e = providerError(provider, 403, `stubyard refused to forward this request to the real provider while recording: ${crossSite}. Browser requests from other web pages are never forwarded; call the LLM API from your server, or stop the recording to get mocked replies.`, { type: provider === 'anthropic' ? 'permission_error' : 'invalid_request_error', code: provider === 'anthropic' ? undefined : 'stubyard_cross_site' });
      logCall(c, { mode: 'record', status: 403, response: { error: e.body } });
      return sendError(reply, e, {}, false);
    }
    if (hub.llm.repo.claimForward(rec.id)) {
      hub.llm.changed(project.id, { recording: rec.id });
      return forwardToUpstream(c, rec);
    }
    // Used up in the meantime: answer like there is no recording.
    hub.llm.changed(project.id, { recordingsStopped: 1 });
    delete resolved.mode;
    delete resolved.recording;
    resolved.recordingStopped = rec.id;
    if (rec.mode === 'all') pick = hub.llm.pick(project.id, canon, runId, header, { content: true });
  }

  let response = pick.response;
  let mode: LlmCallMode = pick.mock ? 'mock' : 'fallback';
  if (pick.mock) Object.assign(resolved, { mock: pick.mock.name, mockId: pick.mock.id, ...(pick.hashHit ? { matchedBy: 'request-hash' } : {}) });
  if (!response) response = fallbackResponse(c);
  if (!response && fault) response = { text: hub.llm.settings(project.id).fallbackText };
  if (!response) {
    mode = 'unmatched';
    resolved.mode = 'unmatched';
    req.trafficOutcome = 'unmatched';
    const e = providerError(
      provider,
      404,
      `No LLM mock in project "${project.slug}" matches this ${endpoint} request (model "${canon.model}", last user message "${lastUserText(canon).slice(0, 80)}"). Add one under LLM mocks or POST /api/projects/${project.slug}/llm/mocks, or set a fallback (echo / text).`,
      { type: provider === 'anthropic' ? 'not_found_error' : 'invalid_request_error', code: provider === 'anthropic' ? undefined : 'stubyard_no_mock', extra: { stubyard: { mocks: pick.misses.slice(0, 50) } } },
    );
    logCall(c, { mode, status: 404, response: { error: e.body, misses: pick.misses.slice(0, 50) } });
    return sendError(reply, e);
  }
  if (fault) mode = 'fault';
  resolved.mode = mode;

  const settings = hub.llm.settings(project.id);
  const ctx = { params: {}, query: (req.query ?? {}) as J, headers: req.headers as J, body, method: req.method, path };
  const filled = renderResponse(response, canon, ctx);
  const p = prepare(canon, filled, settings.defaultChunk);
  resolved.tokens = { input: p.usage.input, output: p.usage.output };
  const callResponse = { text: p.text, toolCalls: p.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })), stopReason: p.stop, usage: p.usage };

  // Recorded exact bytes for the same provider + endpoint + stream mode.
  const raw = filled.raw && filled.raw.provider === provider && filled.raw.endpoint === endpoint && filled.raw.stream === canon.stream && filled.raw.status < 400 ? filled.raw : null;
  if (raw) resolved.replay = 'raw';

  if (canon.stream) {
    const frames = raw ? splitFrames(raw.body) : render(endpoint, canon, p, true, body).frames!;
    await writeFrames(c, frames, p.chunk.delayMs, fault);
    logCall(c, { mode, mockId: pick.mock?.id ?? null, fault: fault?.spec ?? null, status: 200, tokensIn: p.usage.input, tokensOut: p.usage.output, response: callResponse });
    return reply;
  }

  const text = raw ? raw.body : JSON.stringify(render(endpoint, canon, p, false, body).json);
  logCall(c, { mode, mockId: pick.mock?.id ?? null, fault: fault?.spec ?? null, status: 200, tokensIn: p.usage.input, tokensOut: p.usage.output, response: callResponse });
  if (fault?.kind === 'malformed') {
    req.trafficOutcome = 'forced_error';
    return reply.headers(CORS).type('application/json').send(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
  }
  if (fault?.kind === 'cut') {
    const logId = hijack(c);
    await guardHijacked(c, logId, async () => {
      const res = reply.raw;
      const headers = { ...(reply.getHeaders() as Record<string, unknown>), ...CORS, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
      res.writeHead(200, headers as Record<string, string>);
      const half = text.slice(0, Math.floor(text.length / 2));
      await new Promise<void>((r) => res.write(half, () => r()));
      res.socket?.destroy();
      finishHijacked(c, logId, { status: 200, headers, body: half, outcome: 'forced_error', errorType: 'simulated_cut', errorMessage: 'Body cut in half (fault cut)' });
    });
    return reply;
  }
  if (fault) req.trafficOutcome = 'forced_error';
  const rid = provider === 'anthropic' ? { 'request-id': `req_011C${Math.random().toString(36).slice(2, 14)}` } : { 'x-request-id': `req_${Math.random().toString(16).slice(2, 18)}` };
  return reply.headers({ ...CORS, ...rid }).type(raw?.contentType || 'application/json').send(text);
}

/** "event: …\ndata: …\n\n" blocks of a recorded stream, separators kept. */
export function splitFrames(body: string): string[] {
  return body
    .split(/(?<=\r?\n\r?\n)/)
    .filter((f) => f.trim().length > 0);
}

function sendEmbeddings(c: LlmCtx, body: J, fault: Fault | null) {
  const { reply, canon } = c;
  const inputs: string[] = Array.isArray(body.input) ? body.input.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [typeof body.input === 'string' ? body.input : JSON.stringify(body.input)];
  const dimsReq = Number(body.dimensions);
  const dims = Number.isInteger(dimsReq) && dimsReq > 0 && dimsReq <= 8192 ? dimsReq : /large/.test(canon.model) ? 3072 : 1536;
  const base64 = body.encoding_format === 'base64';
  const tokens = inputs.reduce((n, s) => n + estimateTokens(s.length), 0);
  const json = {
    object: 'list',
    data: inputs.map((s, index) => {
      const v = embedVector(s, dims);
      return { object: 'embedding', index, embedding: base64 ? vectorBase64(v) : Array.from(v) };
    }),
    model: canon.model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
  c.resolved.mode = fault ? 'fault' : 'mock';
  c.resolved.tokens = { input: tokens, output: 0 };
  logCall(c, { mode: fault ? 'fault' : 'mock', fault: fault?.spec ?? null, status: 200, tokensIn: tokens, tokensOut: 0, response: { embeddings: inputs.length, dimensions: dims, encoding: base64 ? 'base64' : 'float' } });
  const text = JSON.stringify(json);
  if (fault?.kind === 'malformed') {
    c.req.trafficOutcome = 'forced_error';
    return reply.headers(CORS).type('application/json').send(text.slice(0, Math.floor(text.length / 2)));
  }
  return reply.headers({ ...CORS, 'x-request-id': `req_${Math.random().toString(16).slice(2, 18)}` }).type('application/json').send(text);
}

export { sendError, CORS };

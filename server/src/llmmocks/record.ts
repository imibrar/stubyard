import { egressFetch, scrub } from '../chat/keys.js';
import { canonFromReply } from './assemble.js';
import { finishHijacked, guardHijacked, hijack, logCall, sendError, type LlmCtx } from './handler.js';
import type { LlmRecording } from './repo.js';
import { providerError } from './synth.js';

/**
 * Record-to-mock: forward one request to the real provider (an AI provider from System → AI providers), tee the reply
 * to the client unchanged, and save it as a mock (source "recorded", request hash for exact replay).
 * The client's own key is dropped; stubyard adds the provider's key. Egress goes only through egressFetch (host pinned,
 * no redirects). Keys never reach a row, a log line or an error message. Nothing here sends CORS headers: a recording
 * spends the stored key, so other web pages must not read its replies (cross-site requests are refused before this).
 */

/** Client headers passed on as they are. */
const PASS = ['accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent'];
/** Upstream reply headers passed back. */
const BACK = ['content-type', 'x-request-id', 'request-id', 'openai-processing-ms', 'retry-after', 'retry-after-ms'];

const redactExact = (text: string, secrets: string[]) => secrets.reduce((t, s) => (s ? t.split(s).join('••••') : t), text);

export async function forwardToUpstream(c: LlmCtx, rec: LlmRecording): Promise<unknown> {
  const { hub, req, reply } = c;
  const chat = hub.chat;
  const secrets = chat ? chat.providers.secrets() : [];
  const fail = (status: number, msg: string) => {
    const e = providerError(c.provider, status, scrub(msg, secrets));
    c.resolved.recordError = e.body;
    req.trafficOutcome = 'internal_error';
    logCall(c, { mode: 'record', status, response: { error: e.body } });
    return sendError(reply, e, {}, false);
  };
  const p = chat?.providers.get(rec.providerRef);
  if (!chat || !p) return fail(502, `stubyard is recording to AI provider "${rec.providerRef}", which no longer exists. Stop the recording or add the provider again.`);
  // The provider may have changed since the recording started.
  if (!p.enabled) return fail(502, `stubyard is recording to AI provider "${p.name}", which is disabled. Enable it or stop the recording.`);
  const kindNow = p.kind === 'anthropic' ? 'anthropic' : p.kind === 'google' ? null : 'openai';
  if (kindNow !== rec.kind) return fail(502, `AI provider "${p.name}" is now a ${p.kind} provider; this recording forwards ${rec.kind} requests. Stop it and start a new one.`);
  let rp;
  try {
    rp = chat.providers.resolve(p);
  } catch (e) {
    return fail(502, (e as Error).message);
  }
  const base = rp.baseUrl.replace(/\/+$/, '');
  const sub = c.path.replace(/^\/v1(?=\/|$)/, '');
  const q = req.url.indexOf('?');
  const url = base + sub + (q >= 0 ? req.url.slice(q) : '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const h of PASS) {
    const v = req.headers[h];
    if (typeof v === 'string' && v) headers[h] = v;
  }
  if (rp.kind === 'anthropic') {
    headers['anthropic-version'] ??= '2023-06-01';
    if (rp.apiKey) headers['x-api-key'] = rp.apiKey;
  } else if (rp.apiKey) headers.authorization = `Bearer ${rp.apiKey}`;
  for (const [k, v] of Object.entries(rp.headers)) if (v) headers[k] = v;
  c.resolved.upstream = new URL(url).host;

  const ac = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) ac.abort();
  };
  reply.raw.once('close', onClose);
  let up: Response;
  try {
    up = await egressFetch({ name: rp.name, baseUrl: rp.baseUrl })(url, { method: 'POST', headers, body: req.rawBody ? new Uint8Array(req.rawBody) : undefined, signal: ac.signal });
  } catch (e) {
    reply.raw.off('close', onClose);
    const err = e as Error & { cause?: { message?: string } };
    return fail(502, `stubyard could not reach the recording provider "${rp.name}": ${err.message}${err.cause?.message ? ` (${err.cause.message})` : ''}`);
  }

  const logId = hijack(c);
  await guardHijacked(c, logId, async () => {
    const res = reply.raw;
    const out: Record<string, string> = { ...(reply.getHeaders() as Record<string, string>) };
    for (const h of BACK) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    const chunks: Buffer[] = [];
    let aborted = false;
    try {
      if (up.body) {
        const reader = up.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const b = Buffer.from(value);
          chunks.push(b);
          if (!res.destroyed) res.write(b);
        }
      }
    } catch {
      aborted = true;
    } finally {
      reply.raw.off('close', onClose);
      if (!res.destroyed) res.end();
    }
    const text = redactExact(Buffer.concat(chunks).toString('utf8'), secrets);
    const contentType = up.headers.get('content-type') ?? 'application/json';
    const stream = /event-stream/i.test(contentType);
    let savedId: string | null = null;
    let canonRes = null;
    if (up.ok && !aborted && text.trim()) {
      try {
        // An odd upstream body (content: [null], choices: [null], …) is relayed but not saved.
        canonRes = canonFromReply(c.endpoint, stream, text);
        if (canonRes) {
          const m = hub.llm.saveRecorded(rec, c.canon, { ...canonRes, raw: { provider: c.provider, endpoint: c.endpoint, stream, status: up.status, contentType, body: text } });
          savedId = m.id;
        }
      } catch (e) {
        canonRes = null;
        c.resolved.recordError = `Reply relayed but not saved: ${scrub((e as Error)?.message ?? String(e), secrets)}`;
      }
    }
    Object.assign(c.resolved, { recorded: savedId, upstreamStatus: up.status });
    finishHijacked(c, logId, {
      status: up.status,
      headers: out,
      body: text,
      outcome: aborted ? 'network_error' : up.ok ? 'ok' : 'forced_error',
      ...(aborted ? { errorType: 'upstream_aborted', errorMessage: 'The upstream stream ended early or the client closed it' } : {}),
    });
    logCall(c, {
      mode: 'record',
      mockId: savedId,
      status: up.status,
      tokensIn: canonRes?.usage?.input ?? null,
      tokensOut: canonRes?.usage?.output ?? null,
      response: canonRes ? { text: canonRes.text ?? '', toolCalls: canonRes.toolCalls ?? [], stopReason: canonRes.stopReason, usage: canonRes.usage } : { upstreamStatus: up.status, body: text.slice(0, 4000) },
    });
  });
  return reply;
}

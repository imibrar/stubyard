import type { TrafficLogger } from './logger.js';

export interface OutboundRequest {
  projectId: string | null;
  parentLogId?: string | null;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** Shown in the traffic log ("status callback", "inbound message"…). */
  purpose: string;
  resolved?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface OutboundResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  logId: string;
}

/**
 * Sends a request to the developer's app (status callbacks, inbound messages, webhooks) and records it in the
 * traffic log as an outbound entry, linked to the request that caused it.
 */
export async function sendOutbound(traffic: TrafficLogger, r: OutboundRequest): Promise<OutboundResult> {
  const method = r.method ?? 'POST';
  const headers = { 'user-agent': 'devhub (local testing hub)', ...(r.headers ?? {}) };
  const logId = traffic.start({
    projectId: r.projectId,
    direction: 'outbound',
    protocol: 'http',
    method,
    url: r.url,
    reqHeaders: headers,
    parentLogId: r.parentLogId ?? null,
    resolved: { purpose: r.purpose, ...(r.resolved ?? {}) },
  });
  const reqBody = traffic.clip(r.body ?? null);
  traffic.update(logId, { reqBody: reqBody.text, reqBodySize: reqBody.size, reqTruncated: reqBody.truncated });
  try {
    const res = await fetch(r.url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : r.body ?? undefined,
      signal: AbortSignal.timeout(r.timeoutMs ?? 10_000),
      redirect: 'manual',
    });
    const text = await res.text();
    const clipped = traffic.clip(text);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (resHeaders[k] = v));
    traffic.finish(logId, {
      resStatus: res.status,
      resHeaders,
      resBody: clipped.text,
      resBodySize: clipped.size,
      resTruncated: clipped.truncated,
      outcome: res.status < 400 ? 'ok' : 'rejected',
      errorType: res.status < 400 ? null : 'app_error',
      errorMessage: res.status < 400 ? null : `Your app answered ${res.status}`,
    });
    return { ok: res.status < 400, status: res.status, body: text, error: null, logId };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const msg = timeout ? `No answer within ${(r.timeoutMs ?? 10_000) / 1000}s` : e.cause?.code ? `${e.cause.code}: ${e.cause.message ?? e.message}` : e.message;
    traffic.finish(logId, { outcome: 'network_error', errorType: timeout ? 'timeout' : 'connection_failed', errorMessage: `${msg} (is your app running and reachable from devhub?)` });
    return { ok: false, status: null, body: null, error: msg, logId };
  }
}

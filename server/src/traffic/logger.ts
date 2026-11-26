import type { EventBus } from '../events.js';
import { LogRepo, summarize, type LogPatch, type LogStart } from '../repos/logs.js';
import { nowIso } from '../util.js';
import type { OutboundRequest } from './outbound.js';

/** What sendOutbound reports once the app answered (any status); `text` is the full response text. */
export type OutboundObserver = (req: OutboundRequest, res: { logId: string; status: number; headers: Record<string, string>; text: string }) => void;

/**
 * "Log everything": every request the hub receives or sends goes through here.
 * Rows are inserted as soon as a request arrives, then updated when the response is known.
 */
export class TrafficLogger {
  private startedAt = new Map<string, number>();
  /** Called after an outbound call's response is logged (contract checks of the app's responses, C1 §3.5). */
  outboundObserver?: OutboundObserver;

  constructor(
    readonly repo: LogRepo,
    private bus: EventBus,
    readonly maxBodyBytes: number,
  ) {}

  start(s: LogStart): string {
    const id = this.repo.start(s);
    this.startedAt.set(id, Date.now());
    this.publish('log.created', id);
    return id;
  }

  update(id: string, patch: LogPatch): void {
    this.repo.update(id, patch);
    this.publish('log.updated', id);
  }

  /** Record the final response / error and compute the duration. */
  finish(id: string, patch: LogPatch): void {
    const t0 = this.startedAt.get(id);
    this.startedAt.delete(id);
    this.repo.update(id, {
      respondedAt: patch.respondedAt === undefined ? nowIso() : patch.respondedAt,
      durationMs: patch.durationMs ?? (t0 !== undefined ? Date.now() - t0 : null),
      ...patch,
      outcome: patch.outcome ?? 'ok',
    });
    this.publish('log.updated', id);
  }

  mergeResolved(id: string, extra: Record<string, unknown>): void {
    this.repo.mergeResolved(id, extra);
  }

  /** Clip a body for storage. */
  clip(body: Buffer | string | null | undefined): { text: string | null; size: number; truncated: boolean } {
    if (body === null || body === undefined) return { text: null, size: 0, truncated: false };
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    const truncated = buf.length > this.maxBodyBytes;
    return { text: (truncated ? buf.subarray(0, this.maxBodyBytes) : buf).toString('utf8'), size: buf.length, truncated };
  }

  private publish(type: 'log.created' | 'log.updated', id: string): void {
    const log = this.repo.get(id);
    if (log) this.bus.publish({ type, projectId: log.projectId, data: summarize(log) });
  }
}

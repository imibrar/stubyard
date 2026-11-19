import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';

export interface Job<P = Record<string, unknown>> {
  id: string;
  projectId: string | null;
  type: string;
  runAt: string;
  payload: P;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
}

interface Row {
  id: string;
  project_id: string | null;
  type: string;
  run_at: string;
  payload: string;
  status: Job['status'];
  attempts: number;
  last_error: string | null;
}

const toJob = (r: Row): Job => ({
  id: r.id,
  projectId: r.project_id,
  type: r.type,
  runAt: r.run_at,
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
});

/** Thrown by a handler to ask for another attempt later. */
export class RetryLater extends Error {
  constructor(
    message: string,
    public delayMs: number,
  ) {
    super(message);
  }
}

type Handler = (job: Job) => Promise<void>;

/**
 * Durable, SQLite-backed job queue (status callbacks, delayed deliveries, delayed bounces).
 * Jobs survive a restart; anything left "running" by a crash is picked up again.
 */
export class Scheduler {
  private handlers = new Map<string, Handler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private inFlight = new Set<Promise<void>>();

  constructor(
    private db: DB,
    private log: FastifyBaseLogger,
    private maxAttempts = 3,
  ) {}

  register(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  schedule(type: string, payload: Record<string, unknown>, opts: { projectId?: string | null; delayMs?: number } = {}): string {
    const id = newId();
    const runAt = new Date(Date.now() + Math.max(0, opts.delayMs ?? 0)).toISOString();
    this.db
      .prepare('INSERT INTO scheduled_jobs (id, project_id, type, run_at, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, opts.projectId ?? null, type, runAt, JSON.stringify(payload), nowIso());
    // Run soon without waiting for the next tick when it's already due.
    if (!opts.delayMs) setImmediate(() => void this.tick());
    return id;
  }

  pending(projectId?: string): Job[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM scheduled_jobs WHERE project_id = ? AND status IN ('pending','running') ORDER BY run_at").all(projectId)
      : this.db.prepare("SELECT * FROM scheduled_jobs WHERE status IN ('pending','running') ORDER BY run_at").all();
    return (rows as Row[]).map(toJob);
  }

  start(intervalMs = 200): void {
    this.db.prepare("UPDATE scheduled_jobs SET status = 'pending' WHERE status = 'running'").run();
    // Old finished jobs are not needed.
    this.db.prepare("DELETE FROM scheduled_jobs WHERE status IN ('done','failed') AND run_at < ?").run(new Date(Date.now() - 86_400_000).toISOString());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = (
        this.db.prepare("SELECT * FROM scheduled_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 50").all(nowIso()) as Row[]
      ).map(toJob);
      for (const job of due) {
        this.db.prepare("UPDATE scheduled_jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
        const p = this.run({ ...job, attempts: job.attempts + 1 }).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
    } catch (err) {
      this.log.error({ err }, 'scheduler tick failed');
    } finally {
      this.busy = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type "${job.type}"`);
      await handler(job);
      this.db.prepare("UPDATE scheduled_jobs SET status = 'done', last_error = NULL WHERE id = ?").run(job.id);
    } catch (err) {
      const e = err as Error;
      if (err instanceof RetryLater && job.attempts < this.maxAttempts) {
        this.db
          .prepare("UPDATE scheduled_jobs SET status = 'pending', run_at = ?, last_error = ? WHERE id = ?")
          .run(new Date(Date.now() + err.delayMs).toISOString(), e.message, job.id);
      } else {
        if (!(err instanceof RetryLater)) this.log.error({ err, job: job.type }, 'scheduled job failed');
        this.db.prepare("UPDATE scheduled_jobs SET status = 'failed', last_error = ? WHERE id = ?").run(e.message, job.id);
      }
    }
  }
}

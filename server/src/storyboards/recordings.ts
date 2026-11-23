import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import type { RecordMode } from './schema.js';

/**
 * Walkthrough recording, R1 (docs/design/storyboards.md "Recording"): the extension records the run's app pages with
 * rrweb in its content script and its service worker uploads the events here in chunks (about every 5 s and when a page
 * is hidden or left). Each page load (or a resume after a pause) is a segment; a chunk is stored gzip-compressed as
 * NDJSON, one row per chunk in walkthrough_recording_chunks (migration 27). Everything CASCADEs with the walkthrough
 * and the project, so walkthrough delete, cleanup of quick runs, project reset and project delete need nothing extra.
 * Retention: segments of a walkthrough go settings.recordingRetentionDays (default 14) after its last one ended.
 * Never part of a project or storyboard export.
 */

/** Caps. Mutable for tests. */
export interface RecordingCaps {
  /** One chunk's NDJSON (uncompressed) at most. The route's body limit sits a bit above, so this answers 413 first. */
  chunkBytes: number;
  /** Events per chunk at most. */
  chunkEvents: number;
  /** Per walkthrough (compressed bytes stored) when the project has no settings.recordingMaxMb. */
  defaultMaxMb: number;
}
export const DEFAULT_RECORDING_CAPS: RecordingCaps = { chunkBytes: 8 * 1024 * 1024, chunkEvents: 50_000, defaultMaxMb: 50 };
export const DEFAULT_RECORDING_RETENTION_DAYS = 14;
/** The route's bodyLimit for POST …/recording/chunks (JSON overhead above chunkBytes). */
export const RECORDING_CHUNK_BODY_LIMIT = 10 * 1024 * 1024;

/** Selectors whose input values are always masked, on top of password inputs (the extension adds the run's own). */
export const DEFAULT_MASK_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-csc"]',
];

export type RecordingStatus = 'recording' | 'complete' | 'cut';

/** walkthroughs.recording (JSON). */
export interface RecordingState {
  /** What was asked for at start (the storyboard's record or the start override); 'video' is recorded as dom. */
  requested: RecordMode;
  maskAllInputs: boolean;
  paused: boolean;
  /** Why recording stopped by itself (the size cap), else null. */
  stopped: string | null;
  stoppedAt: string | null;
}

/** WalkthroughView.recording. */
export interface RecordingInfo {
  /** What the extension does now: off, or dom (record the run's app pages). */
  mode: 'off' | 'dom';
  requested: RecordMode;
  maskAllInputs: boolean;
  paused: boolean;
  stopped: string | null;
  stoppedAt: string | null;
  /** CSS selectors whose input values the recorder masks (the run's 2FA code fields and the like), besides passwords. */
  maskSelectors: string[];
  segmentCount: number;
  /** Compressed bytes stored. */
  bytes: number;
  /** The per-walkthrough cap (settings.recordingMaxMb, default 50 MB). */
  maxBytes: number;
}

export interface RecordingSegmentView {
  no: number;
  id: string;
  stepId: string | null;
  url: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  bytes: number;
  events: number;
  status: RecordingStatus;
}

/** GET …/recording. */
export interface RecordingList extends RecordingInfo {
  walkthrough: { id: string; key: string; status: string };
  segments: RecordingSegmentView[];
}

/** POST …/recording/chunks. */
export interface RecordingChunkInput {
  segment: { key: string; url?: string; startedAt?: string; stepId?: string | null };
  seq: number;
  events: unknown[];
  /** The last chunk of the segment (the page is being left, or recording paused / stopped). */
  final?: boolean;
}

export interface RecordingChunkResult {
  segment: number;
  seq: number;
  /** false: this seq was stored before (a retry); nothing changed. */
  stored: boolean;
  bytes: number;
  maxBytes: number;
  /** The run's state now, so the recorder follows pauses and step changes even without the panel or widget open. */
  state: { mode: 'off' | 'dom'; paused: boolean; stopped: string | null; currentStepId: string | null; status: string };
}

interface WtRow {
  id: string;
  project_id: string;
  key: string;
  status: string;
  record: string;
  recording: string;
  current_step_id: string | null;
}

interface SegRow {
  id: string;
  walkthrough_id: string;
  segment_no: number;
  segment_key: string;
  step_id: string | null;
  url: string;
  started_at: string;
  ended_at: string;
  bytes: number;
  events_count: number;
  status: RecordingStatus;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

export function recordingState(raw: string | null | undefined): RecordingState {
  const s = parseJson<Partial<RecordingState>>(raw ?? '{}', {});
  const requested: RecordMode = s.requested === 'dom' || s.requested === 'video' ? s.requested : 'off';
  return { requested, maskAllInputs: s.maskAllInputs === true, paused: s.paused === true, stopped: typeof s.stopped === 'string' ? s.stopped : null, stoppedAt: typeof s.stoppedAt === 'string' ? s.stoppedAt : null };
}

/** The walkthroughs.record value for a requested mode ('video' is reserved: dom for now). */
export const effectiveRecord = (m: RecordMode): 'off' | 'dom' => (m === 'off' ? 'off' : 'dom');

/** An ISO time from the extension, kept within [now - 1 day, now]; else the fallback. */
function clampIso(v: unknown, fallback: string): string {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(t)) return fallback;
  const now = Date.now();
  return new Date(Math.min(now, Math.max(now - 86_400_000, t))).toISOString();
}

export class RecordingService {
  caps: RecordingCaps = { ...DEFAULT_RECORDING_CAPS };

  constructor(private hub: Hub) {}

  private wt(project: Project, idOrKey: string): WtRow {
    const r = this.hub.db.prepare('SELECT id, project_id, key, status, record, recording, current_step_id FROM walkthroughs WHERE project_id = ? AND (id = ? OR key = ?)').get(project.id, idOrKey, idOrKey) as WtRow | undefined;
    if (!r) throw new HttpError(404, `Walkthrough "${idOrKey}" not found`);
    return r;
  }

  maxBytes(project: Project): number {
    const v = (project.settings as { recordingMaxMb?: unknown }).recordingMaxMb;
    const n = typeof v === 'number' && v > 0 ? v : this.caps.defaultMaxMb;
    return Math.round(n * 1024 * 1024);
  }

  private totals(walkthroughId: string): { bytes: number; segments: number } {
    const t = this.hub.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS segments FROM walkthrough_recordings WHERE walkthrough_id = ?').get(walkthroughId) as { bytes: number; segments: number };
    return { bytes: Number(t.bytes), segments: Number(t.segments) };
  }

  /** WalkthroughView.recording (maskSelectors from the walkthrough service, which knows the login recipes). */
  info(project: Project, r: { id: string; record: string; recording: string }, maskSelectors: string[] = []): RecordingInfo {
    const s = recordingState(r.recording);
    const t = this.totals(r.id);
    return {
      mode: r.record === 'dom' ? 'dom' : 'off',
      requested: s.requested,
      maskAllInputs: s.maskAllInputs,
      paused: s.paused,
      stopped: s.stopped,
      stoppedAt: s.stoppedAt,
      maskSelectors: r.record === 'dom' ? [...new Set([...DEFAULT_MASK_SELECTORS, ...maskSelectors])] : [],
      segmentCount: t.segments,
      bytes: t.bytes,
      maxBytes: this.maxBytes(project),
    };
  }

  private segView(s: SegRow): RecordingSegmentView {
    return {
      no: s.segment_no,
      id: s.id,
      stepId: s.step_id,
      url: s.url,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      durationMs: Math.max(0, Date.parse(s.ended_at) - Date.parse(s.started_at)),
      bytes: s.bytes,
      events: s.events_count,
      status: s.status,
    };
  }

  list(project: Project, idOrKey: string, maskSelectors: string[] = []): RecordingList {
    const r = this.wt(project, idOrKey);
    const rows = this.hub.db.prepare('SELECT * FROM walkthrough_recordings WHERE walkthrough_id = ? ORDER BY segment_no').all(r.id) as unknown as SegRow[];
    return { ...this.info(project, r, maskSelectors), walkthrough: { id: r.id, key: r.key, status: r.status }, segments: rows.map((s) => this.segView(s)) };
  }

  private saveState(walkthroughId: string, s: RecordingState): void {
    this.hub.db.prepare('UPDATE walkthroughs SET recording = ? WHERE id = ?').run(JSON.stringify(s), walkthroughId);
  }

  private publish(project: Project, r: WtRow): void {
    this.hub.bus.publish({ type: 'walkthrough.changed', projectId: project.id, data: { id: r.id, status: r.status, recording: true } });
  }

  /** Pause / resume, or switch recording on or off for the rest of the run. Switching on clears a stop at the cap. */
  setState(project: Project, idOrKey: string, patch: unknown): void {
    const r = this.wt(project, idOrKey);
    const p = isObj(patch) ? patch : {};
    if (p.paused !== undefined && typeof p.paused !== 'boolean') throw new HttpError(400, 'paused must be true or false');
    if (p.mode !== undefined && p.mode !== 'off' && p.mode !== 'dom' && p.mode !== 'video') throw new HttpError(400, 'mode must be off, dom or video');
    if (p.maskAllInputs !== undefined && typeof p.maskAllInputs !== 'boolean') throw new HttpError(400, 'maskAllInputs must be true or false');
    const s = recordingState(r.recording);
    let record = r.record === 'dom' ? 'dom' : 'off';
    if (typeof p.paused === 'boolean') s.paused = p.paused;
    if (typeof p.maskAllInputs === 'boolean') s.maskAllInputs = p.maskAllInputs;
    if (typeof p.mode === 'string') {
      record = effectiveRecord(p.mode as RecordMode);
      s.requested = p.mode as RecordMode;
      if (record === 'dom') {
        s.stopped = null;
        s.stoppedAt = null;
      } else s.paused = false;
    }
    this.hub.db.transaction(() => {
      this.hub.db.prepare('UPDATE walkthroughs SET record = ?, updated_at = ? WHERE id = ?').run(record, nowIso(), r.id);
      this.saveState(r.id, s);
    })();
    this.publish(project, r);
  }

  /** Store one chunk of a segment (idempotent per seq). 409 when recording is off; 413 over the caps. */
  addChunk(project: Project, idOrKey: string, input: unknown): RecordingChunkResult {
    const r = this.wt(project, idOrKey);
    const b = isObj(input) ? input : {};
    const seg = isObj(b.segment) ? b.segment : null;
    if (!seg || typeof seg.key !== 'string' || !KEY_RE.test(seg.key)) throw new HttpError(400, 'segment.key is required (1-64 letters, digits, - or _)');
    if (seg.url !== undefined && (typeof seg.url !== 'string' || seg.url.length > 2000)) throw new HttpError(400, 'segment.url must be a string of at most 2000 characters');
    if (seg.stepId !== undefined && seg.stepId !== null && (typeof seg.stepId !== 'string' || seg.stepId.length > 200)) throw new HttpError(400, 'segment.stepId must be a string');
    if (typeof b.seq !== 'number' || !Number.isInteger(b.seq) || b.seq < 0 || b.seq > 1_000_000) throw new HttpError(400, 'seq must be an integer from 0');
    if (!Array.isArray(b.events)) throw new HttpError(400, 'events must be an array of rrweb events');
    if (b.events.length > this.caps.chunkEvents) throw new HttpError(413, `A chunk holds at most ${this.caps.chunkEvents} events (got ${b.events.length}); send smaller chunks`);
    let lastTs = 0;
    const lines: string[] = [];
    for (const [i, e] of b.events.entries()) {
      if (!isObj(e) || typeof e.type !== 'number' || typeof e.timestamp !== 'number') throw new HttpError(400, `events[${i}] is not an rrweb event ({type, data, timestamp})`);
      if (e.timestamp > lastTs) lastTs = e.timestamp;
      lines.push(JSON.stringify(e));
    }
    const ndjson = lines.length ? lines.join('\n') + '\n' : '';
    const raw = Buffer.byteLength(ndjson);
    if (raw > this.caps.chunkBytes) throw new HttpError(413, `This chunk is ${mb(raw)}; at most ${mb(this.caps.chunkBytes)} each`);

    if (r.record !== 'dom') throw new HttpError(409, `Recording is off for walkthrough ${r.key}`);
    const state = recordingState(r.recording);
    const maxBytes = this.maxBytes(project);
    if (state.stopped) throw new HttpError(413, state.stopped, { stopped: true, maxBytes });

    const data = ndjson ? gzipSync(ndjson) : Buffer.alloc(0);
    const now = nowIso();
    const key = seg.key;
    const existing = this.hub.db.prepare('SELECT * FROM walkthrough_recordings WHERE walkthrough_id = ? AND segment_key = ?').get(r.id, key) as SegRow | undefined;
    const dup = existing ? !!this.hub.db.prepare('SELECT 1 FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq = ?').get(existing.id, b.seq) : false;
    const totals = this.totals(r.id);
    const stateOut = () => ({ mode: 'dom' as const, paused: state.paused, stopped: state.stopped, currentStepId: r.current_step_id, status: r.status });
    if (dup && existing) return { segment: existing.segment_no, seq: b.seq, stored: false, bytes: totals.bytes, maxBytes, state: stateOut() };

    if (totals.bytes + data.length > maxBytes) {
      state.stopped = `Recording stopped: walkthrough ${r.key} reached its ${mb(maxBytes)} limit (project setting recordingMaxMb). Delete the recording or raise the limit to record again.`;
      state.stoppedAt = now;
      this.hub.db.transaction(() => {
        this.saveState(r.id, state);
        if (existing) this.hub.db.prepare("UPDATE walkthrough_recordings SET status = 'cut' WHERE id = ?").run(existing.id);
      })();
      this.publish(project, r);
      throw new HttpError(413, state.stopped, { stopped: true, maxBytes });
    }

    let segmentNo = existing?.segment_no ?? 0;
    const endedAt = clampIso(lastTs || now, now);
    this.hub.db.transaction(() => {
      let segId = existing?.id;
      if (!existing) {
        segmentNo = Number((this.hub.db.prepare('SELECT COALESCE(MAX(segment_no), 0) AS n FROM walkthrough_recordings WHERE walkthrough_id = ?').get(r.id) as { n: number }).n) + 1;
        segId = newId();
        const firstTs = (b.events as { timestamp: number }[]).reduce((m, e) => Math.min(m, e.timestamp), Number.POSITIVE_INFINITY);
        const startedAt = clampIso(seg.startedAt ?? (Number.isFinite(firstTs) ? firstTs : now), now);
        this.hub.db
          .prepare('INSERT INTO walkthrough_recordings (id, walkthrough_id, project_id, segment_no, segment_key, step_id, url, started_at, ended_at, bytes, events_count, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?)')
          .run(segId, r.id, project.id, segmentNo, key, (seg.stepId as string | null | undefined) ?? r.current_step_id, (seg.url as string | undefined) ?? '', startedAt, startedAt > endedAt ? startedAt : endedAt, 'recording', now);
      }
      if (data.length) {
        this.hub.db.prepare('INSERT INTO walkthrough_recording_chunks (recording_id, project_id, seq, events_count, bytes, data, created_at) VALUES (?,?,?,?,?,?,?)').run(segId!, project.id, b.seq, lines.length, data.length, data, now);
      }
      this.hub.db
        .prepare("UPDATE walkthrough_recordings SET bytes = bytes + ?, events_count = events_count + ?, ended_at = MAX(ended_at, ?), status = CASE WHEN ? THEN 'complete' ELSE status END WHERE id = ?")
        .run(data.length, lines.length, endedAt, b.final === true ? 1 : 0, segId!);
    })();
    // A new segment (a page load) is worth an event (the dashboard's list); chunks of a segment are not.
    if (!existing) this.publish(project, r);
    return { segment: segmentNo, seq: b.seq, stored: true, bytes: totals.bytes + data.length, maxBytes, state: stateOut() };
  }

  /** A segment's events as NDJSON (a stream; chunks are decompressed one at a time). */
  segmentStream(project: Project, idOrKey: string, no: number): { segment: RecordingSegmentView; stream: Readable } {
    const r = this.wt(project, idOrKey);
    const s = this.hub.db.prepare('SELECT * FROM walkthrough_recordings WHERE walkthrough_id = ? AND segment_no = ?').get(r.id, no) as SegRow | undefined;
    if (!s) throw new HttpError(404, `Recording segment ${no} of walkthrough ${r.key} not found`);
    const seqs = (this.hub.db.prepare('SELECT seq FROM walkthrough_recording_chunks WHERE recording_id = ? ORDER BY seq').all(s.id) as { seq: number }[]).map((x) => x.seq);
    const db = this.hub.db;
    const id = s.id;
    function* gen() {
      for (const seq of seqs) {
        const c = db.prepare('SELECT data FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq = ?').get(id, seq) as { data: Uint8Array } | undefined;
        if (c && c.data.length) yield gunzipSync(c.data);
      }
    }
    return { segment: this.segView(s), stream: Readable.from(gen()) };
  }

  /** Delete every segment of a walkthrough's recording (a stop at the cap is cleared, so recording can go on). */
  delete(project: Project, idOrKey: string): { deleted: number; bytes: number } {
    const r = this.wt(project, idOrKey);
    const t = this.totals(r.id);
    const s = recordingState(r.recording);
    this.hub.db.transaction(() => {
      this.hub.db.prepare('DELETE FROM walkthrough_recordings WHERE walkthrough_id = ?').run(r.id);
      if (s.stopped) this.saveState(r.id, { ...s, stopped: null, stoppedAt: null });
    })();
    this.publish(project, r);
    return { deleted: t.segments, bytes: t.bytes };
  }

  /** Retention: whole recordings whose last segment ended before the cutoff. Returns the segments removed. */
  purgeOlderThan(projectId: string, cutoffIso: string): number {
    return this.hub.db
      .prepare('DELETE FROM walkthrough_recordings WHERE walkthrough_id IN (SELECT walkthrough_id FROM walkthrough_recordings WHERE project_id = ? GROUP BY walkthrough_id HAVING MAX(ended_at) < ?)')
      .run(projectId, cutoffIso).changes;
  }

  /** Recording bytes per project (System → Storage). */
  projectBytes(projectId: string): number {
    return Number((this.hub.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM walkthrough_recordings WHERE project_id = ?').get(projectId) as { n: number }).n);
  }
}

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
 *
 * R2 video mode (record 'video'): the extension records the tab with chrome.tabCapture in an offscreen document
 * (MediaRecorder, WebM) and the service worker uploads a WebM chunk about every 5 s through the same endpoint
 * ({kind: 'video', data: base64}). A video segment's chunks are stored as they came (no gzip: WebM does not compress);
 * concatenated in seq order they are one WebM file. Without a migration a video segment is told apart by its key
 * (VIDEO_KEY_PREFIX, which the extension's keys cannot contain) and its metadata (mime type, duration, step markers)
 * sits in a chunk row with seq META_SEQ (-1, JSON, not counted in bytes). The file is served with Range support and a
 * Duration patched into the WebM header (MediaRecorder leaves it out, so players would show no length).
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
/** segment_key prefix of a video segment ('.' is not allowed in the extension's keys). */
export const VIDEO_KEY_PREFIX = 'video.';
/** The chunk row (seq) holding a video segment's metadata (JSON). */
export const META_SEQ = -1;
/** Step markers per video segment at most. */
export const MAX_VIDEO_MARKERS = 2000;
const WEBM_MIME_RE = /^video\/webm(;\s*codecs="?[a-z0-9.,]+"?)?$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

export type RecordingKind = 'dom' | 'video';
/** What the extension records now: nothing, the DOM (rrweb) or a video of the tab. */
export type RecordingModeNow = 'off' | 'dom' | 'video';

export const DEFAULT_MASK_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-csc"]',
];

export type RecordingStatus = 'recording' | 'complete' | 'cut';

/** walkthroughs.recording (JSON). */
export interface RecordingState {
  /** What was asked for at start (the storyboard's record or the start override). */
  requested: RecordMode;
  maskAllInputs: boolean;
  paused: boolean;
  /** Why recording stopped by itself (the size cap), else null. */
  stopped: string | null;
  stoppedAt: string | null;
}

/** WalkthroughView.recording. */
export interface RecordingInfo {
  /** What the extension does now: off, dom (record the run's app pages with rrweb) or video (record the tab). */
  mode: RecordingModeNow;
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
  /** rrweb events (dom) or WebM chunks (video). */
  events: number;
  status: RecordingStatus;
  /** dom: rrweb events (NDJSON); video: a WebM file (GET …/segments/:no serves it with Range support). */
  kind: RecordingKind;
  /** video: the MediaRecorder mime type (video/webm;codecs=vp9 or vp8). */
  mime?: string;
  /** video: step changes as offsets into the video (ms; the first one at 0). */
  markers?: { at: number; stepId: string }[];
}

/** A video segment's metadata (the META_SEQ chunk row). */
interface VideoMeta {
  mime: string;
  /** Media time recorded (pauses left out), as the extension reports it. */
  durationMs: number;
  markers: { at: number; stepId: string }[];
  width?: number;
  height?: number;
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

/** POST …/recording/chunks with kind 'video': one WebM chunk (MediaRecorder timeslice) of a tab video. */
export interface VideoChunkInput {
  kind: 'video';
  segment: { key: string; url?: string; startedAt?: string; stepId?: string | null };
  seq: number;
  /** The WebM bytes, base64. seq 0 starts with the EBML header. */
  data: string;
  mime: string;
  /** Media time recorded so far (ms, pauses left out). */
  durationMs?: number;
  /** Step changes since the previous chunk (offsets into the video, ms). */
  markers?: { at: number; stepId: string }[];
  width?: number;
  height?: number;
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
  state: { mode: RecordingModeNow; paused: boolean; stopped: string | null; currentStepId: string | null; status: string };
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

/** The walkthroughs.record value for a requested mode. */
export const effectiveRecord = (m: RecordMode): RecordingModeNow => (m === 'dom' || m === 'video' ? m : 'off');
/** walkthroughs.record as a mode (anything unknown is off). */
export const modeOf = (record: string): RecordingModeNow => (record === 'dom' || record === 'video' ? record : 'off');
export const isVideoKey = (key: string) => key.startsWith(VIDEO_KEY_PREFIX);

/** An ISO time from the extension, kept within [now - 1 day, now]; else the fallback. */
function clampIso(v: unknown, fallback: string): string {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(t)) return fallback;
  const now = Date.now();
  return new Date(Math.min(now, Math.max(now - 86_400_000, t))).toISOString();
}

/** segment + seq of a chunk body (both kinds). */
function checkSegment(b: Record<string, unknown>): { key: string; url?: string; startedAt?: unknown; stepId?: string | null; seq: number } {
  const seg = isObj(b.segment) ? b.segment : null;
  if (!seg || typeof seg.key !== 'string' || !KEY_RE.test(seg.key)) throw new HttpError(400, 'segment.key is required (1-64 letters, digits, - or _)');
  if (seg.url !== undefined && (typeof seg.url !== 'string' || seg.url.length > 2000)) throw new HttpError(400, 'segment.url must be a string of at most 2000 characters');
  if (seg.stepId !== undefined && seg.stepId !== null && (typeof seg.stepId !== 'string' || seg.stepId.length > 200)) throw new HttpError(400, 'segment.stepId must be a string');
  if (typeof b.seq !== 'number' || !Number.isInteger(b.seq) || b.seq < 0 || b.seq > 1_000_000) throw new HttpError(400, 'seq must be an integer from 0');
  return { key: seg.key, url: seg.url as string | undefined, startedAt: seg.startedAt, stepId: seg.stepId as string | null | undefined, seq: b.seq };
}

// ---------------------------------------------------------------------------------------------------------------
// WebM (Matroska / EBML) duration fix. Chrome's MediaRecorder writes a live WebM: Segment and Clusters of unknown
// size, no SeekHead, no Cues and no Duration, so a <video> shows no length and a poor timeline. Inserting a Duration
// element into the Info element of the first chunk fixes that; nothing points at byte offsets in such a file, so the
// bytes after it may move. Files with a SeekHead or Cues, or a Segment of known size, are left as they are.

const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_CUES = 0x1c53bb6b;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

/** An EBML variable-length integer at pos: an element ID (marker kept) or a size (marker removed; unknown = all ones). */
function readVint(b: Uint8Array, pos: number, id: boolean): { value: number; len: number; unknown: boolean } | null {
  if (pos >= b.length || b[pos] === 0) return null;
  const first = b[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > b.length) return null;
  const mask = 0xff >> len;
  let value = id ? first : first & mask;
  let ones = (first & mask) === mask;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) ones = false;
  }
  return { value, len, unknown: !id && ones };
}

const vint8 = (n: number): Buffer => {
  const out = Buffer.alloc(8);
  out[0] = 0x01;
  out.writeUIntBE(n, 2, 6);
  return out;
};

/** The WebM bytes with Info/Duration set to durationMs (in the file's TimecodeScale); unchanged when it cannot. */
export function webmSetDuration(buf: Buffer, durationMs: number): Buffer {
  if (!(durationMs > 0) || buf.length < 8 || !buf.subarray(0, 4).equals(EBML_MAGIC)) return buf;
  const hid = readVint(buf, 0, true);
  const hsz = hid && readVint(buf, hid.len, false);
  if (!hid || !hsz || hsz.unknown) return buf;
  let p = hid.len + hsz.len + hsz.value;
  const sid = readVint(buf, p, true);
  const ssz = sid && readVint(buf, p + sid.len, false);
  if (!sid || !ssz || sid.value !== ID_SEGMENT || !ssz.unknown) return buf;
  p += sid.len + ssz.len;
  while (p < buf.length) {
    const id = readVint(buf, p, true);
    const sz = id && readVint(buf, p + id.len, false);
    if (!id || !sz) return buf;
    const start = p + id.len + sz.len;
    if (id.value === ID_SEEKHEAD || id.value === ID_CUES || id.value === ID_CLUSTER) return buf;
    if (id.value === ID_INFO) {
      if (sz.unknown || start + sz.value > buf.length) return buf;
      const info = buf.subarray(start, start + sz.value);
      const kept: Buffer[] = [];
      let scale = 1_000_000;
      for (let q = 0; q < info.length; ) {
        const cid = readVint(info, q, true);
        const csz = cid && readVint(info, q + cid.len, false);
        if (!cid || !csz || csz.unknown) return buf;
        const cstart = q + cid.len + csz.len;
        const end = cstart + csz.value;
        if (end > info.length) return buf;
        if (cid.value === ID_TIMECODE_SCALE && csz.value >= 1 && csz.value <= 6) scale = info.readUIntBE(cstart, csz.value) || scale;
        if (cid.value !== ID_DURATION) kept.push(info.subarray(q, end));
        q = end;
      }
      const dur = Buffer.alloc(11);
      dur[0] = 0x44;
      dur[1] = 0x89;
      dur[2] = 0x88; // size 8: a float64
      dur.writeDoubleBE((durationMs * 1_000_000) / scale, 3);
      const body = Buffer.concat([...kept, dur]);
      return Buffer.concat([buf.subarray(0, p), Buffer.from([0x15, 0x49, 0xa9, 0x66]), vint8(body.length), body, buf.subarray(start + sz.value)]);
    }
    if (sz.unknown) return buf;
    p = start + sz.value;
  }
  return buf;
}

/** A byte range of a video segment (inclusive end), as the route parsed it. */
export interface ByteRange {
  start: number;
  end: number;
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
      mode: modeOf(r.record),
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

  private videoMeta(segId: string): VideoMeta {
    const row = this.hub.db.prepare('SELECT data FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq = ?').get(segId, META_SEQ) as { data: Uint8Array } | undefined;
    const m = row ? parseJson<Partial<VideoMeta>>(Buffer.from(row.data).toString('utf8'), {}) : {};
    return {
      mime: typeof m.mime === 'string' ? m.mime : 'video/webm',
      durationMs: typeof m.durationMs === 'number' ? m.durationMs : 0,
      markers: Array.isArray(m.markers) ? m.markers : [],
      ...(typeof m.width === 'number' ? { width: m.width } : {}),
      ...(typeof m.height === 'number' ? { height: m.height } : {}),
    };
  }

  private segView(s: SegRow): RecordingSegmentView {
    if (isVideoKey(s.segment_key)) {
      const m = this.videoMeta(s.id);
      return {
        no: s.segment_no,
        id: s.id,
        stepId: s.step_id,
        url: s.url,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        durationMs: m.durationMs || Math.max(0, Date.parse(s.ended_at) - Date.parse(s.started_at)),
        bytes: s.bytes,
        events: s.events_count,
        status: s.status,
        kind: 'video',
        mime: m.mime,
        markers: m.markers,
      };
    }
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
      kind: 'dom',
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
    let record = modeOf(r.record);
    if (typeof p.paused === 'boolean') s.paused = p.paused;
    if (typeof p.maskAllInputs === 'boolean') s.maskAllInputs = p.maskAllInputs;
    if (typeof p.mode === 'string') {
      record = effectiveRecord(p.mode as RecordMode);
      s.requested = p.mode as RecordMode;
      if (record !== 'off') {
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
    const seg = checkSegment(b);
    if (b.kind === 'video') return this.addVideoChunk(project, r, b, seg);
    if (b.kind !== undefined && b.kind !== 'dom') throw new HttpError(400, 'kind must be dom or video');
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

    if (r.record !== 'dom') throw new HttpError(409, r.record === 'video' ? `Walkthrough ${r.key} records video, not the DOM` : `Recording is off for walkthrough ${r.key}`);
    const state = recordingState(r.recording);
    const maxBytes = this.maxBytes(project);
    if (state.stopped) throw new HttpError(413, state.stopped, { stopped: true, maxBytes });

    const data = ndjson ? gzipSync(ndjson) : Buffer.alloc(0);
    const now = nowIso();
    const key = seg.key;
    const existing = this.segByKey(r.id, key);
    const dup = existing ? this.hasChunk(existing.id, seg.seq) : false;
    const totals = this.totals(r.id);
    const stateOut = () => ({ mode: 'dom' as const, paused: state.paused, stopped: state.stopped, currentStepId: r.current_step_id, status: r.status });
    if (dup && existing) return { segment: existing.segment_no, seq: seg.seq, stored: false, bytes: totals.bytes, maxBytes, state: stateOut() };
    if (totals.bytes + data.length > maxBytes) this.stopAtCap(project, r, state, existing, maxBytes, now);

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
        this.hub.db.prepare('INSERT INTO walkthrough_recording_chunks (recording_id, project_id, seq, events_count, bytes, data, created_at) VALUES (?,?,?,?,?,?,?)').run(segId!, project.id, seg.seq, lines.length, data.length, data, now);
      }
      this.hub.db
        .prepare("UPDATE walkthrough_recordings SET bytes = bytes + ?, events_count = events_count + ?, ended_at = MAX(ended_at, ?), status = CASE WHEN ? THEN 'complete' ELSE status END WHERE id = ?")
        .run(data.length, lines.length, endedAt, b.final === true ? 1 : 0, segId!);
    })();
    // A new segment (a page load) is worth an event (the dashboard's list); chunks of a segment are not.
    if (!existing) this.publish(project, r);
    return { segment: segmentNo, seq: seg.seq, stored: true, bytes: totals.bytes + data.length, maxBytes, state: stateOut() };
  }

  private segByKey(walkthroughId: string, key: string): SegRow | undefined {
    return this.hub.db.prepare('SELECT * FROM walkthrough_recordings WHERE walkthrough_id = ? AND segment_key = ?').get(walkthroughId, key) as SegRow | undefined;
  }

  private hasChunk(segId: string, seq: number): boolean {
    return !!this.hub.db.prepare('SELECT 1 FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq = ?').get(segId, seq);
  }

  /** Over the cap: recording stops (the segment is cut) and the chunk is refused with 413. */
  private stopAtCap(project: Project, r: WtRow, state: RecordingState, existing: SegRow | undefined, maxBytes: number, now: string): never {
    state.stopped = `Recording stopped: walkthrough ${r.key} reached its ${mb(maxBytes)} limit (project setting recordingMaxMb). Delete the recording or raise the limit to record again.`;
    state.stoppedAt = now;
    this.hub.db.transaction(() => {
      this.saveState(r.id, state);
      if (existing) this.hub.db.prepare("UPDATE walkthrough_recordings SET status = 'cut' WHERE id = ?").run(existing.id);
    })();
    this.publish(project, r);
    throw new HttpError(413, state.stopped, { stopped: true, maxBytes });
  }

  /** A WebM chunk of a tab video (kind 'video'): stored as it came, in seq order; markers and duration in the metadata row. */
  private addVideoChunk(project: Project, r: WtRow, b: Record<string, unknown>, seg: ReturnType<typeof checkSegment>): RecordingChunkResult {
    if (typeof b.data !== 'string' || !BASE64_RE.test(b.data)) throw new HttpError(400, 'data must be the WebM bytes of the chunk, base64');
    const maxB64 = Math.ceil(this.caps.chunkBytes / 3) * 4;
    if (b.data.length > maxB64) throw new HttpError(413, `This chunk is ${mb((b.data.length / 4) * 3)}; at most ${mb(this.caps.chunkBytes)} each`);
    if (typeof b.mime !== 'string' || !WEBM_MIME_RE.test(b.mime)) throw new HttpError(400, 'mime must be video/webm (optionally with codecs)');
    if (b.durationMs !== undefined && (typeof b.durationMs !== 'number' || !Number.isFinite(b.durationMs) || b.durationMs < 0 || b.durationMs > 86_400_000)) throw new HttpError(400, 'durationMs must be a number of milliseconds');
    const markers: { at: number; stepId: string }[] = [];
    if (b.markers !== undefined) {
      if (!Array.isArray(b.markers) || b.markers.length > 200) throw new HttpError(400, 'markers must be an array of at most 200 {at, stepId}');
      for (const [i, m] of b.markers.entries()) {
        if (!isObj(m) || typeof m.at !== 'number' || !Number.isFinite(m.at) || m.at < 0 || typeof m.stepId !== 'string' || !m.stepId || m.stepId.length > 200) throw new HttpError(400, `markers[${i}] must be {at: ms, stepId}`);
        markers.push({ at: Math.round(m.at), stepId: m.stepId });
      }
    }
    const dim = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10_000 ? v : undefined);
    const data = Buffer.from(b.data, 'base64');
    if (seg.seq === 0 && data.length && !data.subarray(0, 4).equals(EBML_MAGIC)) throw new HttpError(400, 'The first chunk (seq 0) must start with the WebM (EBML) header');

    if (r.record !== 'video') throw new HttpError(409, r.record === 'dom' ? `Walkthrough ${r.key} records the DOM, not video` : `Recording is off for walkthrough ${r.key}`);
    const state = recordingState(r.recording);
    const maxBytes = this.maxBytes(project);
    if (state.stopped) throw new HttpError(413, state.stopped, { stopped: true, maxBytes });

    const now = nowIso();
    const key = VIDEO_KEY_PREFIX + seg.key;
    const existing = this.segByKey(r.id, key);
    const totals = this.totals(r.id);
    const stateOut = () => ({ mode: 'video' as const, paused: state.paused, stopped: state.stopped, currentStepId: r.current_step_id, status: r.status });
    if (existing && this.hasChunk(existing.id, seg.seq)) return { segment: existing.segment_no, seq: seg.seq, stored: false, bytes: totals.bytes, maxBytes, state: stateOut() };
    if (totals.bytes + data.length > maxBytes) this.stopAtCap(project, r, state, existing, maxBytes, now);

    let segmentNo = existing?.segment_no ?? 0;
    this.hub.db.transaction(() => {
      let segId = existing?.id;
      if (!existing) {
        segmentNo = Number((this.hub.db.prepare('SELECT COALESCE(MAX(segment_no), 0) AS n FROM walkthrough_recordings WHERE walkthrough_id = ?').get(r.id) as { n: number }).n) + 1;
        segId = newId();
        const startedAt = clampIso(seg.startedAt ?? now, now);
        this.hub.db
          .prepare('INSERT INTO walkthrough_recordings (id, walkthrough_id, project_id, segment_no, segment_key, step_id, url, started_at, ended_at, bytes, events_count, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?)')
          .run(segId, r.id, project.id, segmentNo, key, seg.stepId ?? r.current_step_id, seg.url ?? '', startedAt, now, 'recording', now);
      }
      if (data.length) {
        this.hub.db.prepare('INSERT INTO walkthrough_recording_chunks (recording_id, project_id, seq, events_count, bytes, data, created_at) VALUES (?,?,?,?,?,?,?)').run(segId!, project.id, seg.seq, 1, data.length, data, now);
      }
      const meta = this.videoMeta(segId!);
      meta.mime = b.mime as string;
      if (typeof b.durationMs === 'number') meta.durationMs = Math.max(meta.durationMs, Math.round(b.durationMs));
      for (const m of markers) {
        if (meta.markers.length >= MAX_VIDEO_MARKERS || meta.markers.at(-1)?.stepId === m.stepId) continue;
        meta.markers.push(m);
      }
      meta.markers.sort((x, y) => x.at - y.at);
      if (dim(b.width) && dim(b.height)) {
        meta.width = dim(b.width);
        meta.height = dim(b.height);
      }
      this.hub.db
        .prepare('INSERT INTO walkthrough_recording_chunks (recording_id, project_id, seq, events_count, bytes, data, created_at) VALUES (?,?,?,0,0,?,?) ON CONFLICT(recording_id, seq) DO UPDATE SET data = excluded.data')
        .run(segId!, project.id, META_SEQ, Buffer.from(JSON.stringify(meta)), now);
      this.hub.db
        .prepare("UPDATE walkthrough_recordings SET bytes = bytes + ?, events_count = events_count + ?, ended_at = MAX(ended_at, ?), status = CASE WHEN ? THEN 'complete' ELSE status END WHERE id = ?")
        .run(data.length, data.length ? 1 : 0, now, b.final === true ? 1 : 0, segId!);
    })();
    if (!existing) this.publish(project, r);
    return { segment: segmentNo, seq: seg.seq, stored: true, bytes: totals.bytes + data.length, maxBytes, state: stateOut() };
  }

  /** The kind of a segment (the route serves dom as NDJSON and video as a WebM file). */
  segmentKind(project: Project, idOrKey: string, no: number): RecordingKind {
    const r = this.wt(project, idOrKey);
    const s = this.hub.db.prepare('SELECT segment_key FROM walkthrough_recordings WHERE walkthrough_id = ? AND segment_no = ?').get(r.id, no) as { segment_key: string } | undefined;
    if (!s) throw new HttpError(404, `Recording segment ${no} of walkthrough ${r.key} not found`);
    return isVideoKey(s.segment_key) ? 'video' : 'dom';
  }

  /**
   * A video segment as one WebM file: its chunks in seq order, the first one with the Duration patched in. size is
   * the whole file; stream(range) reads only the chunks a byte range touches (Range requests from the <video>).
   */
  videoFile(project: Project, idOrKey: string, no: number): { segment: RecordingSegmentView; mime: string; size: number; stream(range?: ByteRange): Readable } {
    const r = this.wt(project, idOrKey);
    const s = this.hub.db.prepare('SELECT * FROM walkthrough_recordings WHERE walkthrough_id = ? AND segment_no = ?').get(r.id, no) as SegRow | undefined;
    if (!s || !isVideoKey(s.segment_key)) throw new HttpError(404, `Video segment ${no} of walkthrough ${r.key} not found`);
    const view = this.segView(s);
    const db = this.hub.db;
    const parts = (db.prepare('SELECT seq, bytes FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq >= 0 ORDER BY seq').all(s.id) as { seq: number; bytes: number }[]).map((p) => ({ seq: p.seq, size: Number(p.bytes) }));
    const read = (seq: number): Buffer => {
      const c = db.prepare('SELECT data FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq = ?').get(s.id, seq) as { data: Uint8Array } | undefined;
      return c ? Buffer.from(c.data) : Buffer.alloc(0);
    };
    let head: Buffer | null = null;
    if (parts.length && parts[0].seq === 0) {
      head = webmSetDuration(read(0), view.durationMs);
      parts[0].size = head.length;
    }
    const size = parts.reduce((n, p) => n + p.size, 0);
    const stream = (range?: ByteRange) => {
      const from = range?.start ?? 0;
      const to = range?.end ?? size - 1;
      function* gen() {
        let off = 0;
        for (const p of parts) {
          const pStart = off;
          const pEnd = off + p.size - 1;
          off += p.size;
          if (pEnd < from) continue;
          if (pStart > to) break;
          const buf = p.seq === 0 && head ? head : read(p.seq);
          yield buf.subarray(Math.max(0, from - pStart), Math.min(buf.length, to - pStart + 1));
        }
      }
      return Readable.from(gen());
    };
    return { segment: view, mime: (view.mime ?? 'video/webm').split(';')[0].trim(), size, stream };
  }

  /** A segment's events as NDJSON (a stream; chunks are decompressed one at a time). */
  segmentStream(project: Project, idOrKey: string, no: number): { segment: RecordingSegmentView; stream: Readable } {
    const r = this.wt(project, idOrKey);
    const s = this.hub.db.prepare('SELECT * FROM walkthrough_recordings WHERE walkthrough_id = ? AND segment_no = ?').get(r.id, no) as SegRow | undefined;
    if (!s) throw new HttpError(404, `Recording segment ${no} of walkthrough ${r.key} not found`);
    const seqs = (this.hub.db.prepare('SELECT seq FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq >= 0 ORDER BY seq').all(s.id) as { seq: number }[]).map((x) => x.seq);
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

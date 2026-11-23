// The offscreen document's video recorder (walkthrough recording R2; shared/video.ts). It turns the tab capture
// stream id from the service worker into a MediaStream (getUserMedia, video only, scaled, ~8 fps), records it with
// MediaRecorder (WebM VP9, else VP8; ~500 kbps; a chunk every 5 s) and sends the chunks to the worker one at a time,
// in order (a WebM file is its chunks concatenated). Pause / resume keep one segment: the media time leaves paused
// spans out, and step markers are offsets into that media time. Everything the browser gives is passed in, so the
// logic runs in unit tests with a fake MediaRecorder.
import {
  captureConstraints,
  type BeginResult,
  type OffscreenStatus,
  pickVideoMime,
  VIDEO_BITS_PER_SECOND,
  VIDEO_MAX_QUEUE,
  VIDEO_TIMESLICE_MS,
  type VideoChunkMessage,
  type VideoChunkReply,
  type VideoEndedMessage,
  type VideoSession,
} from '../shared/video';

export interface MediaRecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType?: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
}
export interface MediaRecorderCtor {
  new (stream: MediaStream, options: { mimeType: string; videoBitsPerSecond: number }): MediaRecorderLike;
  isTypeSupported(type: string): boolean;
}

export interface VideoRecorderDeps {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  MediaRecorder: MediaRecorderCtor;
  /** To the service worker (chrome.runtime.sendMessage). */
  send(msg: VideoChunkMessage | VideoEndedMessage): Promise<unknown>;
  toBase64(b: Blob): Promise<string>;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

interface Pending {
  seq: number;
  blob: Blob | null;
  durationMs: number;
  markers: { at: number; stepId: string }[];
  final: boolean;
  tries: number;
}

/** Retry delays for a chunk the worker could not upload (the hub offline), then the queue waits for the next one. */
const RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000];

/** Base64 of a Blob's bytes (no data: URL; 32 KB per String.fromCharCode call). */
export async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class VideoRecorder {
  session: VideoSession | null = null;
  mime = '';
  width = 0;
  height = 0;
  /** Why it stopped (set once stop() ran). */
  stopReason: string | null = null;
  private rec: MediaRecorderLike | null = null;
  private stream: MediaStream | null = null;
  private seq = 0;
  private queue: Pending[] = [];
  private uploading = false;
  private stopped = false;
  private recorderDone = false;
  private endedSent = false;
  /** The final chunk is queued (the recorder's last data, or an empty one). */
  private finalQueued = false;
  /** The hub said stop (413, 409, …): nothing more is uploaded. */
  private refused = false;
  private activeMs = 0;
  private activeSince: number | null = null;
  private markers: { at: number; stepId: string }[] = [];
  private lastStep: string | null = null;
  private lastChunkBytes = 0;
  /** Bytes the hub holds and its cap, from the last chunk reply. */
  hubBytes = 0;
  hubMaxBytes = 0;

  constructor(private deps: VideoRecorderDeps) {}

  get recording(): boolean {
    return !!this.rec && !this.stopped;
  }

  status(): OffscreenStatus {
    return { recording: this.recording, key: this.session?.key ?? null, paused: this.rec?.state === 'paused', seq: this.seq, durationMs: Math.round(this.mediaMs()), queued: this.queue.length };
  }

  /** Media time recorded so far (paused spans left out). */
  mediaMs(): number {
    return this.activeMs + (this.activeSince !== null ? this.deps.now() - this.activeSince : 0);
  }

  async begin(streamId: string, session: VideoSession, size: { width: number; height: number }): Promise<BeginResult> {
    if (this.rec && !this.endedSent) return { ok: false, error: 'A video is being recorded already' };
    this.reset();
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(captureConstraints(streamId, size));
    } catch (err) {
      return { ok: false, error: `The tab could not be captured: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}` };
    }
    const mime = pickVideoMime((t) => this.deps.MediaRecorder.isTypeSupported(t));
    let rec: MediaRecorderLike;
    try {
      rec = new this.deps.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      return { ok: false, error: `MediaRecorder failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.session = session;
    this.stream = stream;
    this.rec = rec;
    this.mime = mime;
    const track = stream.getVideoTracks()[0];
    const set = track?.getSettings?.() ?? {};
    this.width = Math.round(set.width ?? size.width);
    this.height = Math.round(set.height ?? size.height);
    // The tab closed, or Chrome ended the capture (the "stop sharing" bar, a crash): finish what we have.
    track?.addEventListener?.('ended', () => this.stop('The tab was closed or its capture ended'));
    rec.ondataavailable = (e) => this.onData(e.data);
    rec.onstop = () => this.onRecorderStopped();
    rec.onerror = (e) => this.stop(`The recorder failed: ${(e as { error?: { message?: string } })?.error?.message ?? 'unknown error'}`);
    rec.start(VIDEO_TIMESLICE_MS);
    this.activeSince = this.deps.now();
    this.step(session.stepId);
    if (session.paused) this.pause();
    return { ok: true, mime, width: this.width, height: this.height };
  }

  pause(): void {
    if (!this.rec || this.stopped || this.rec.state !== 'recording') return;
    this.rec.pause();
    if (this.activeSince !== null) this.activeMs += this.deps.now() - this.activeSince;
    this.activeSince = null;
  }

  resume(): void {
    if (!this.rec || this.stopped || this.rec.state !== 'paused') return;
    this.rec.resume();
    this.activeSince = this.deps.now();
  }

  /** A step change: a marker at the current media time (once per change). */
  step(stepId: string | null): void {
    if (!stepId || stepId === this.lastStep) return;
    this.lastStep = stepId;
    if (this.markers.at(-1)?.at === Math.round(this.mediaMs())) this.markers.pop();
    this.markers.push({ at: Math.round(this.mediaMs()), stepId });
  }

  /** Stop: the recorder hands over its last data (a final chunk), then the worker hears video.ended. */
  stop(reason: string): void {
    if (!this.rec || this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    if (this.activeSince !== null) this.activeMs += this.deps.now() - this.activeSince;
    this.activeSince = null;
    try {
      if (this.rec.state !== 'inactive') this.rec.stop();
      else this.onRecorderStopped();
    } catch {
      this.onRecorderStopped();
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
  }

  private reset(): void {
    Object.assign(this, { session: null, rec: null, stream: null, seq: 0, queue: [], uploading: false, stopped: false, recorderDone: false, endedSent: false, finalQueued: false, refused: false, activeMs: 0, activeSince: null, markers: [], lastStep: null, stopReason: null, lastChunkBytes: 0 });
  }

  private onData(blob: Blob): void {
    if (!this.session || this.endedSent || this.refused || this.finalQueued) return;
    // After stop() the recorder is inactive: this is its last data (the stop event follows).
    const final = this.stopped && this.rec?.state === 'inactive';
    if (!blob.size && !final) return;
    if (final) this.finalQueued = true;
    this.queue.push({ seq: this.seq++, blob, durationMs: Math.round(this.mediaMs()), markers: this.markers.splice(0), final, tries: 0 });
    if (this.queue.length > VIDEO_MAX_QUEUE) {
      this.queue = [];
      this.refused = true;
      this.stop('Video stopped: stubyard could not be reached for too long');
      return;
    }
    void this.pump();
  }

  /** MediaRecorder stopped (its last dataavailable came first): the last chunk waiting is the final one. */
  private onRecorderStopped(): void {
    if (this.recorderDone) return;
    this.recorderDone = true;
    if (!this.finalQueued && !this.refused && this.session) {
      this.finalQueued = true;
      this.queue.push({ seq: this.seq++, blob: null, durationMs: Math.round(this.mediaMs()), markers: this.markers.splice(0), final: true, tries: 0 });
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.uploading) return;
    this.uploading = true;
    try {
      while (this.queue.length && this.session) {
        const item = this.queue[0];
        const data = item.blob ? await this.deps.toBase64(item.blob) : '';
        const msg: VideoChunkMessage = {
          type: 'video.chunk',
          key: this.session.key,
          seq: item.seq,
          data,
          mime: this.mime,
          durationMs: item.durationMs,
          markers: item.markers,
          width: this.width || undefined,
          height: this.height || undefined,
          final: item.final,
        };
        let reply: VideoChunkReply;
        try {
          reply = ((await this.deps.send(msg)) as VideoChunkReply | undefined) ?? { ok: false, error: 'no answer from the service worker', stop: false };
        } catch (err) {
          reply = { ok: false, error: err instanceof Error ? err.message : String(err), stop: false };
        }
        if (reply.ok) {
          this.queue.shift();
          this.lastChunkBytes = item.blob?.size ?? 0;
          this.hubBytes = reply.bytes;
          this.hubMaxBytes = reply.maxBytes;
          // Close to the cap: stop now, so the last (partial) chunk still fits and the file ends cleanly.
          if (!this.stopped && reply.maxBytes > 0 && reply.maxBytes - reply.bytes < Math.max(2 * this.lastChunkBytes, 64 * 1024)) this.stop('Video stopped: the walkthrough is at its recording size limit');
          continue;
        }
        if (reply.stop) {
          this.queue = [];
          this.refused = true;
          this.stop(reply.error);
          break;
        }
        item.tries += 1;
        if (item.tries <= RETRY_MS.length) {
          this.deps.setTimeout(() => void this.pump(), RETRY_MS[item.tries - 1]);
          return;
        }
        // Given up on this chunk: what follows would not play without it.
        this.queue = [];
        this.refused = true;
        this.stop(`Video stopped: a chunk could not be uploaded (${reply.error})`);
        break;
      }
    } finally {
      this.uploading = false;
    }
    if (this.stopped && this.recorderDone && !this.queue.length) await this.sendEnded();
  }

  private async sendEnded(): Promise<void> {
    if (this.endedSent || !this.session) return;
    this.endedSent = true;
    try {
      await this.deps.send({ type: 'video.ended', key: this.session.key, reason: this.stopReason ?? 'stopped' });
    } catch {
      /* the worker is gone; it finds the session without a recorder on its next sync */
    }
  }
}

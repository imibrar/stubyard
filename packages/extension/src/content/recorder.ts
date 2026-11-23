// The content script's recorder (walkthrough recording R1): rrweb record() on the page while the run records, the
// events buffered and sent to the service worker as chunks (every FLUSH_MS, early at FLUSH_EVENTS, and on pagehide /
// visibilitychange). One segment per page load and per resume after a pause; step changes become rrweb custom events.
// Every HEARTBEAT_MS it sends a chunk when one is due, else an empty heartbeat chunk, so a pause or a stop made on the
// hub reaches it within seconds. URLs are redacted (query values, fragments, token-like segments) before they leave
// the page; an event too large to upload (a huge page snapshot) is replaced by a note saying so.
// It never calls stubyard: the worker uploads (it has the hub URL; the page cannot reach chrome.runtime).
// rrweb and the timers are passed in, so the logic is unit-tested without a browser.
import {
  FLUSH_BYTES,
  FLUSH_EVENTS,
  FLUSH_MS,
  HEARTBEAT_MS,
  MAX_EVENT_BYTES,
  MAX_RETRY_CHUNKS,
  NOTE_EVENT_TAG,
  type RecordingChunkMessage,
  type RecordingChunkReply,
  type RecordingConfig,
  recordOptions,
  redactUrl,
  type SensitiveMemory,
  STEP_EVENT_TAG,
} from '../shared/recording';

/** The bit of rrweb the recorder uses. */
export interface RrwebRecord {
  (options: Record<string, unknown> & { emit: (e: unknown) => void }): (() => void) | undefined;
  addCustomEvent: (tag: string, payload: unknown) => void;
}

export interface RecorderDeps {
  record: RrwebRecord;
  /** chrome.runtime.sendMessage to the worker; resolves its reply (undefined when the worker is gone). */
  send: (msg: RecordingChunkMessage) => Promise<RecordingChunkReply | undefined>;
  win: Window;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
  newKey?: () => string;
  /** The recorder stopped by itself (the hub's cap, recording off): for the console only. */
  onStop?: (reason: string) => void;
  /** What the content script knows about the page's sensitive fields (content/sensitive.ts). */
  memory?: SensitiveMemory;
}

interface RrEvent {
  type: number;
  timestamp: number;
  data?: Record<string, unknown>;
}

interface Segment {
  key: string;
  url: string;
  startedAt: string;
  stepId: string | null;
  seq: number;
}

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
/** UTF-8 bytes of a string (its length when there is no TextEncoder). */
const byteLength = (s: string) => (encoder ? encoder.encode(s).length : s.length);

const randomKey = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

export class Recorder {
  private cfg: RecordingConfig | null = null;
  private stopRrweb: (() => void) | null = null;
  private seg: Segment | null = null;
  private buffer: unknown[] = [];
  private timer: unknown = null;
  private retry: RecordingChunkMessage[] = [];
  private bufferBytes = 0;
  private lastFlush = 0;
  /** This page's snapshot is too large to upload: no recording until the next page load. */
  private pageTooLarge = false;
  /** Set when the hub refused (cap, off, gone): no recording until a new config for another walkthrough. */
  private stoppedFor: string | null = null;
  private listening = false;
  private readonly now: () => number;

  constructor(private deps: RecorderDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Recording now (not paused or stopped). */
  get active(): boolean {
    return !!this.stopRrweb;
  }

  get segmentKey(): string | null {
    return this.seg?.key ?? null;
  }

  get config(): RecordingConfig | null {
    return this.cfg;
  }

  /** Start, or follow a changed config (idempotent): step change → marker; paused → stop rrweb; resumed → new segment. */
  apply(cfg: RecordingConfig): { recording: boolean } {
    const prev = this.cfg;
    const other = !prev || prev.walkthroughId !== cfg.walkthroughId || prev.project !== cfg.project;
    if (other) {
      if (prev) this.stop();
      this.stoppedFor = null;
    }
    if (this.stoppedFor === cfg.walkthroughId) {
      this.cfg = cfg;
      return { recording: false };
    }
    const maskChanged = !!prev && !other && (prev.maskAllInputs !== cfg.maskAllInputs || prev.maskSelectors.join('\n') !== cfg.maskSelectors.join('\n'));
    this.cfg = cfg;
    this.listen();
    if (cfg.paused) {
      if (this.active) this.endSegment();
      return { recording: false };
    }
    if (this.active && maskChanged) this.endSegment(); // new masks: a fresh snapshot with them
    if (!this.active) this.beginSegment();
    else if (prev && prev.stepId !== cfg.stepId) this.stepMarker(cfg.stepId);
    return { recording: true };
  }

  /** Stop for good (the run closed in this window, recording off): the last chunk is sent. */
  stop(): void {
    if (this.active) this.endSegment();
    this.unlisten();
    this.cfg = null;
  }

  /** Send what the buffer holds. */
  flush(final = false): void {
    const cfg = this.cfg;
    const seg = this.seg;
    if (!cfg || !seg) return;
    this.resendFailed();
    if (!this.buffer.length && !final) return;
    const events = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    this.lastFlush = this.now();
    const msg: RecordingChunkMessage = {
      type: 'recording.chunk',
      project: cfg.project,
      walkthroughId: cfg.walkthroughId,
      segment: { key: seg.key, url: seg.url, startedAt: seg.startedAt, stepId: seg.stepId },
      seq: seg.seq++,
      events,
      final,
    };
    void this.sendChunk(msg);
  }

  /** The tick: a chunk when one is due (FLUSH_MS since the last), else a heartbeat that only reads the hub's state. */
  tick(): void {
    if (this.buffer.length && this.now() - this.lastFlush >= FLUSH_MS) return this.flush();
    this.heartbeat();
  }

  /** An empty chunk (not stored by the hub): its answer carries pauses, stops and step changes made elsewhere. */
  private heartbeat(): void {
    const cfg = this.cfg;
    const seg = this.seg;
    if (!cfg || !seg) return;
    const msg: RecordingChunkMessage = {
      type: 'recording.chunk',
      project: cfg.project,
      walkthroughId: cfg.walkthroughId,
      segment: { key: seg.key, url: seg.url, startedAt: seg.startedAt, stepId: seg.stepId },
      seq: seg.seq,
      events: [],
      final: false,
    };
    void this.sendChunk(msg, true);
  }

  /** An rrweb event: Meta hrefs redacted; one too large to upload becomes a note and ends the page's recording. */
  private onEvent(e: RrEvent): void {
    if (e.type === 4 && e.data && typeof e.data.href === 'string') e.data = { ...e.data, href: redactUrl(e.data.href) };
    let size = 200;
    const big = e.type === 2 || (e.type === 3 && e.data?.source === 0 && ((e.data.adds as unknown[] | undefined)?.length ?? 0) + ((e.data.texts as unknown[] | undefined)?.length ?? 0) > 20);
    if (big) {
      try {
        size = byteLength(JSON.stringify(e));
      } catch {
        size = MAX_EVENT_BYTES + 1;
      }
    }
    if (size > MAX_EVENT_BYTES) return this.tooLarge(e.type === 2 ? 'snapshot' : 'mutation', size);
    this.buffer.push(e);
    this.bufferBytes += size;
    if (this.buffer.length >= FLUSH_EVENTS || this.bufferBytes >= FLUSH_BYTES) this.flush();
  }

  /**
   * An event the hub could not take: the page is not recorded from here on (a note in the segment says why, and the
   * dashboard shows it). A new page load records again.
   */
  private tooLarge(what: 'snapshot' | 'mutation' | 'chunk', bytes: number): void {
    if (this.pageTooLarge) return;
    this.pageTooLarge = true;
    const reason = `This page was not recorded from here on: its ${what === 'snapshot' ? 'page snapshot' : what === 'mutation' ? 'latest DOM change' : 'data'} is ${mb(bytes)}, more than the ${mb(MAX_EVENT_BYTES)} one upload can hold.`;
    this.buffer.push({ type: 5, timestamp: this.now(), data: { tag: NOTE_EVENT_TAG, payload: { kind: 'too-large', what, bytes, limit: MAX_EVENT_BYTES, reason } } });
    // Leave rrweb's callback first: stopping it from inside its own emit is not safe.
    queueMicrotask(() => {
      if (this.active) this.endSegment();
      this.deps.onStop?.(reason);
    });
  }

  /** The hub says this segment is full: a new one starts (a fresh snapshot), recording goes on. */
  private rotate(): void {
    if (!this.active || !this.cfg || this.cfg.paused) return;
    this.halt();
    this.buffer = [];
    this.bufferBytes = 0;
    this.seg = null;
    this.beginSegment();
  }

  /** Stop rrweb and the tick, keep the rest. */
  private halt(): void {
    try {
      this.stopRrweb?.();
    } catch {
      /* rrweb already gone */
    }
    this.stopRrweb = null;
    if (this.timer !== null) (this.deps.clearInterval ?? ((id: unknown) => this.deps.win.clearInterval(id as number)))(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------------------------------------------

  private beginSegment() {
    const cfg = this.cfg!;
    const win = this.deps.win;
    if (this.pageTooLarge) return;
    this.seg = { key: (this.deps.newKey ?? randomKey)(), url: redactUrl(win.location.href), startedAt: new Date(this.now()).toISOString(), stepId: cfg.stepId, seq: 0 };
    this.buffer = [];
    this.bufferBytes = 0;
    this.lastFlush = this.now();
    try {
      this.stopRrweb =
        this.deps.record({
          ...recordOptions(cfg, this.deps.memory),
          emit: (e: unknown) => this.onEvent(e as RrEvent),
        }) ?? null;
    } catch (err) {
      this.stopRrweb = null;
      this.deps.onStop?.(`rrweb could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!this.stopRrweb) return;
    this.stepMarker(cfg.stepId);
    const si = this.deps.setInterval ?? ((fn: () => void, ms: number) => win.setInterval(fn, ms));
    this.timer = si(() => this.tick(), HEARTBEAT_MS);
  }

  private endSegment() {
    this.halt();
    this.flush(true);
    this.seg = null;
  }

  private stepMarker(stepId: string | null) {
    if (!stepId || !this.active) return;
    try {
      this.deps.record.addCustomEvent(STEP_EVENT_TAG, { stepId });
    } catch {
      /* not recording */
    }
  }

  private async sendChunk(msg: RecordingChunkMessage, heartbeat = false): Promise<void> {
    let reply: RecordingChunkReply | undefined;
    try {
      reply = await this.deps.send(msg);
    } catch {
      reply = undefined; // the worker is gone (extension reloaded) or the page is unloading
    }
    if (!reply) return heartbeat ? undefined : this.keepForRetry(msg);
    if (!reply.ok) {
      if (reply.segmentFull) return msg.segment.key === this.seg?.key ? this.rotate() : undefined;
      if (reply.tooLarge) return msg.segment.key === this.seg?.key ? this.tooLarge('chunk', msg.events.length ? byteLength(JSON.stringify(msg.events)) : 0) : undefined;
      if (reply.stop) return this.stoppedByHub(msg.walkthroughId, reply.error);
      return heartbeat ? undefined : this.keepForRetry(msg);
    }
    const s = reply.state;
    const cfg = this.cfg;
    if (!cfg || cfg.walkthroughId !== msg.walkthroughId) return;
    if (s.mode !== 'dom' || s.stopped || s.status !== 'active') return this.stoppedByHub(msg.walkthroughId, s.stopped ?? 'recording is off');
    // Follow the hub without waiting for the panel or the widget: a pause, a step change.
    if (s.paused !== cfg.paused || s.currentStepId !== cfg.stepId) this.apply({ ...cfg, paused: s.paused, stepId: s.currentStepId });
  }

  private keepForRetry(msg: RecordingChunkMessage) {
    this.retry.push(msg);
    if (this.retry.length > MAX_RETRY_CHUNKS) this.retry.shift();
  }

  private resendFailed() {
    if (!this.retry.length) return;
    const list = this.retry;
    this.retry = [];
    for (const m of list) void this.sendChunk(m);
  }

  private stoppedByHub(walkthroughId: string, reason: string) {
    this.stoppedFor = walkthroughId;
    this.retry = [];
    if (this.active) {
      this.halt();
      this.buffer = [];
      this.bufferBytes = 0;
      this.seg = null;
    }
    this.deps.onStop?.(reason);
  }

  // Page lifecycle: a hidden page sends its buffer; a page being left ends its segment; one restored from the
  // back/forward cache starts a new segment.
  private onHidden = () => {
    if (this.deps.win.document.visibilityState === 'hidden') this.flush();
  };
  private onPagehide = () => {
    if (this.active) this.endSegment();
  };
  private onPageshow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted && this.cfg && !this.cfg.paused && !this.active && this.stoppedFor !== this.cfg.walkthroughId) this.beginSegment();
  };

  private listen() {
    if (this.listening) return;
    this.listening = true;
    const w = this.deps.win;
    w.document.addEventListener('visibilitychange', this.onHidden);
    w.addEventListener('pagehide', this.onPagehide);
    w.addEventListener('pageshow', this.onPageshow);
  }

  private unlisten() {
    if (!this.listening) return;
    this.listening = false;
    const w = this.deps.win;
    w.document.removeEventListener('visibilitychange', this.onHidden);
    w.removeEventListener('pagehide', this.onPagehide);
    w.removeEventListener('pageshow', this.onPageshow);
  }
}

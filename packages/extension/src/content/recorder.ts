// The content script's recorder (walkthrough recording R1): rrweb record() on the page while the run records, the
// events buffered and sent to the service worker as chunks (every FLUSH_MS, early at FLUSH_EVENTS, and on pagehide /
// visibilitychange). One segment per page load and per resume after a pause; step changes become rrweb custom events.
// It never calls stubyard: the worker uploads (it has the hub URL; the page cannot reach chrome.runtime).
// rrweb and the timers are passed in, so the logic is unit-tested without a browser.
import { FLUSH_EVENTS, FLUSH_MS, MAX_RETRY_CHUNKS, type RecordingChunkMessage, type RecordingChunkReply, type RecordingConfig, recordOptions, STEP_EVENT_TAG } from '../shared/recording';

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
}

interface Segment {
  key: string;
  url: string;
  startedAt: string;
  stepId: string | null;
  seq: number;
}

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
  /** Inputs stubyard filled with a password or a code (setValue secret): always masked. */
  readonly marked = new WeakSet<Element>();
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

  // -------------------------------------------------------------------------------------------------------------

  private beginSegment() {
    const cfg = this.cfg!;
    const win = this.deps.win;
    this.seg = { key: (this.deps.newKey ?? randomKey)(), url: win.location.href, startedAt: new Date(this.now()).toISOString(), stepId: cfg.stepId, seq: 0 };
    this.buffer = [];
    try {
      this.stopRrweb =
        this.deps.record({
          ...recordOptions(cfg, this.marked),
          emit: (e: unknown) => {
            this.buffer.push(e);
            if (this.buffer.length >= FLUSH_EVENTS) this.flush();
          },
        }) ?? null;
    } catch (err) {
      this.stopRrweb = null;
      this.deps.onStop?.(`rrweb could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!this.stopRrweb) return;
    this.stepMarker(cfg.stepId);
    const si = this.deps.setInterval ?? ((fn: () => void, ms: number) => win.setInterval(fn, ms));
    this.timer = si(() => this.flush(), FLUSH_MS);
  }

  private endSegment() {
    try {
      this.stopRrweb?.();
    } catch {
      /* rrweb already gone */
    }
    this.stopRrweb = null;
    if (this.timer !== null) (this.deps.clearInterval ?? ((id: unknown) => this.deps.win.clearInterval(id as number)))(this.timer);
    this.timer = null;
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

  private async sendChunk(msg: RecordingChunkMessage): Promise<void> {
    let reply: RecordingChunkReply | undefined;
    try {
      reply = await this.deps.send(msg);
    } catch {
      reply = undefined; // the worker is gone (extension reloaded) or the page is unloading
    }
    if (!reply) return this.keepForRetry(msg);
    if (!reply.ok) {
      if (reply.stop) return this.stoppedByHub(msg.walkthroughId, reply.error);
      return this.keepForRetry(msg);
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
      try {
        this.stopRrweb?.();
      } catch {
        /* gone */
      }
      this.stopRrweb = null;
      if (this.timer !== null) (this.deps.clearInterval ?? ((id: unknown) => this.deps.win.clearInterval(id as number)))(this.timer);
      this.timer = null;
      this.buffer = [];
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

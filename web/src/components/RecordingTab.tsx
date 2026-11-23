// The Recording tab of a walkthrough (walkthrough recording R1): the segments the extension recorded (one per page
// load), a player (rrweb-player, loaded on first use: it is ~200 KB) with our own Canvas-style controls, step markers
// on the timeline (rrweb custom events "stubyard.step"; a click jumps there), speed 1x / 2x / 4x, skip inactivity,
// the stored size against the cap, Pause / Resume while the run is active, and Delete.
// R2 video mode: video segments (WebM, served with Range support) play in a <video> with the same controls (step
// markers from the segment's metadata, 1x / 2x / 4x); a run with both kinds shows Video and Page (DOM) tabs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from '../hooks';
import { sbApi, sbPaths, type RecordingList, type RecordingSegment, type WalkthroughView } from '../storyboardsApi';
import { Badge, ErrorBox, fmtBytes, fmtDateTime, Modal, useToast } from './ui';
import '../styles/recording.css';

/** The rrweb custom event the extension adds at a segment start and at every step change. */
export const STEP_EVENT_TAG = 'stubyard.step';
const SPEEDS = [1, 2, 4] as const;
/** The extension's MediaRecorder bitrate (packages/extension/src/shared/video.ts): minutes left are at least this many. */
const VIDEO_BITS_PER_SECOND = 500_000;
export const videoMinutesLeft = (bytes: number, maxBytes: number) => Math.floor(Math.max(0, maxBytes - bytes) / (VIDEO_BITS_PER_SECOND / 8) / 60);
export type SegmentKind = 'dom' | 'video';
export const kindOf = (s: Pick<RecordingSegment, 'kind'>): SegmentKind => (s.kind === 'video' ? 'video' : 'dom');

interface RrEvent {
  type: number;
  timestamp: number;
  data?: { tag?: string; payload?: { stepId?: string }; width?: number; height?: number; href?: string };
}

/** Step markers of a segment: offset from its first event, the step, once per change. */
export function stepMarkers(events: RrEvent[]): { at: number; stepId: string }[] {
  if (!events.length) return [];
  const start = events[0].timestamp;
  const out: { at: number; stepId: string }[] = [];
  for (const e of events) {
    if (e.type !== 5 || e.data?.tag !== STEP_EVENT_TAG) continue;
    const id = e.data.payload?.stepId;
    if (!id || out.at(-1)?.stepId === id) continue;
    out.push({ at: Math.max(0, e.timestamp - start), stepId: id });
  }
  return out;
}

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

type PlayerT = {
  play(): void;
  pause(): void;
  goto(t: number, play?: boolean): void;
  setSpeed(n: number): void;
  toggleSkipInactive(): void;
  getMetaData(): { startTime: number; endTime: number; totalTime: number };
  addEventListener(ev: string, fn: (p: unknown) => unknown): void;
  triggerResize(): void;
  $set(p: Record<string, unknown>): void;
  $destroy(): void;
};

export function RecordingTab({ slug, w, onChanged }: { slug: string; w: WalkthroughView; onChanged: () => void }) {
  const toast = useToast();
  const info = w.recording;
  // Re-read when the hub reports a change of the run (a new segment, a pause, a cut at the cap).
  const tick = [info?.segmentCount, info?.bytes, info?.paused, info?.stopped, info?.mode, w.updatedAt].join('|');
  const list = useFetch<RecordingList>(sbPaths.recording(slug, w.id), [slug, w.id, tick]);
  const [sel, setSel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const all = list.data?.segments ?? [];
  const kinds = [...new Set(all.map(kindOf))];
  const [kindSel, setKindSel] = useState<SegmentKind | null>(null);
  const kind: SegmentKind = kindSel && kinds.includes(kindSel) ? kindSel : (kinds.includes('video') ? 'video' : 'dom');
  const segs = all.filter((s) => kindOf(s) === kind);
  const current = segs.find((s) => s.no === sel) ?? segs[0] ?? null;

  useEffect(() => {
    if (sel === null && segs.length) setSel(segs[0].no);
    if (sel !== null && segs.length && !segs.some((s) => s.no === sel)) setSel(segs[0].no);
  }, [segs.map((s) => s.no).join(','), kind]);

  const stepTitle = (id: string | null) => {
    if (!id) return null;
    const i = w.steps.findIndex((s) => s.id === id);
    return i < 0 ? null : `${i + 1}. ${w.steps[i].title}`;
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      toast(done);
      void list.reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const l = list.data;
  const active = w.status === 'active';
  const recording = !!l && l.mode !== 'off' && active && !l.stopped;
  const video = l?.mode === 'video';
  return (
    <section className="rec" data-testid="recording-tab">
      <div className="rec-head">
        <div className="rec-sum">
          {recording && (
            <Badge kind={l.paused ? 'warn' : 'bad'}>{l.paused ? 'paused' : video ? 'video' : 'recording'}</Badge>
          )}
          {l?.stopped && <Badge kind="warn">stopped at the cap</Badge>}
          <span className="small">
            {segs.length} segment{segs.length === 1 ? '' : 's'} · {fmtBytes(l?.bytes ?? 0)} <span className="faint">of {fmtBytes(l?.maxBytes ?? 0)}</span>
          </span>
          {l?.maskAllInputs && !video && <span className="faint small">all inputs and text masked</span>}
          {recording && video && <span className="faint small" data-testid="video-left">at least {videoMinutesLeft(l.bytes, l.maxBytes)} min of video left</span>}
        </div>
        <div className="rec-actions">
          {recording && (
            <button className="btn sm" onClick={() => void act(() => sbApi.setRecording(slug, w.id, { paused: !l.paused }), l.paused ? 'Recording resumed' : 'Recording paused')}>
              {l.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {active && l && l.mode === 'off' && (
            <button className="btn sm" title="The extension records the app pages from now on" onClick={() => void act(() => sbApi.setRecording(slug, w.id, { mode: 'dom' }), 'Recording on for the rest of the run')}>
              Record the rest
            </button>
          )}
          {segs.length > 0 && (
            <button className="btn sm ghost rec-del" onClick={() => setConfirm(true)}>
              Delete recording
            </button>
          )}
        </div>
      </div>
      {l?.stopped && <p className="small rec-note">{l.stopped}</p>}
      <ErrorBox error={error ?? list.error} />
      {!l && !list.error && <p className="muted">Loading…</p>}
      {kinds.length > 1 && (
        <div className="seg rec-kinds" role="tablist" aria-label="Recording kind">
          {(['video', 'dom'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={`seg-btn ${kind === k ? 'active' : ''}`} onClick={() => setKindSel(k)}>
              {k === 'video' ? 'Video' : 'Page (DOM)'} <span className="faint">{all.filter((s) => kindOf(s) === k).length}</span>
            </button>
          ))}
        </div>
      )}
      {l && segs.length === 0 && (
        <div className="rec-empty">
          <strong>Nothing recorded</strong>
          <p className="small muted">
            {l.mode === 'video'
              ? 'This run records a video of the tab once the tester presses Start or Record video in the extension (Chrome extension 0.5.0 or later). The video shows here as it comes in. Passwords and codes typed by hand are visible in it.'
              : l.mode === 'dom'
              ? 'The extension records the app pages of this run while it is open in a window (Chrome extension 0.5.0 or later). Segments show here as they come in.'
              : l.requested === 'off'
                ? 'Recording was off for this run. Turn it on per storyboard (Record) or per run in the extension\'s Start screen.'
                : 'Recording is off now.'}
          </p>
        </div>
      )}
      {current && (
        <div className="rec-body">
          {kindOf(current) === 'video' ? (
            <VideoPlayer key={`v${current.no}-${current.status === 'recording' ? current.bytes : 'done'}`} slug={slug} w={w} seg={current} stepTitle={stepTitle} />
          ) : (
            <Player key={`${current.no}-${current.status === 'recording' ? current.events : 'done'}`} slug={slug} w={w} seg={current} stepTitle={stepTitle} />
          )}
          <ol className="rec-segs" aria-label="Segments">
            {segs.map((s) => (
              <li key={s.no}>
                <button className={`rec-seg ${s.no === current.no ? 'on' : ''}`} aria-current={s.no === current.no ? 'true' : undefined} onClick={() => setSel(s.no)}>
                  <span className="rec-seg-no">{kindOf(s) === 'video' ? <span title="Video" aria-label="Video">▶</span> : s.no}</span>
                  <span className="rec-seg-main">
                    <code className="rec-seg-url" title={s.url}>
                      {pathOf(s.url)}
                    </code>
                    <span className="faint small">{stepTitle(s.stepId) ?? 'no step'}</span>
                  </span>
                  <span className="rec-seg-meta small">
                    <span>{fmtClock(s.durationMs)}</span>
                    <span className="faint">{fmtBytes(s.bytes)}</span>
                    {s.status !== 'complete' && <Badge kind={s.status === 'cut' ? 'warn' : 'accent'}>{s.status === 'cut' ? 'cut' : 'live'}</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {confirm && (
        <Modal
          title="Delete the recording?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
                onClick={() => (setConfirm(false), void act(() => sbApi.deleteRecording(slug, w.id), 'Recording deleted'))}
              >
                Delete
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            All {all.length} segments ({fmtBytes(l?.bytes ?? 0)}) are removed. Step results, notes and screenshots stay.{active && l && l.mode !== 'off' ? ' Recording goes on for the rest of the run.' : ''}
          </p>
        </Modal>
      )}
    </section>
  );
}

/** The rrweb custom event the extension adds when it could not record a page (too large to upload). */
const NOTE_TAG = 'stubyard.note';

/** Why parts of a segment are missing (the extension's notes): one line each. */
export function recordingNotes(events: { type: number; data?: { tag?: string; payload?: unknown } }[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== 5 || e.data?.tag !== NOTE_TAG) continue;
    const r = (e.data.payload as { reason?: unknown } | undefined)?.reason;
    if (typeof r === 'string' && r && !out.includes(r)) out.push(r.slice(0, 300));
  }
  return out;
}

/** Styles the player needs inside its frame (the dashboard's stylesheets do not reach it). */
const FRAME_CSS = `
.rr-player { background: transparent !important; box-shadow: none !important; border-radius: 0 !important; margin: 0 auto; float: none !important; }
.rr-controller { display: none !important; }
.replayer-wrapper { border-radius: 0; }
iframe { background: #fff; }`;

/**
 * The replay runs inside a hub page (GET …/recording/player) whose Content-Security-Policy lets the recorded page
 * load nothing from the network: no images, stylesheets, fonts or frames from other sites (only data: URLs and the
 * run's own app origins), no scripts, and no referrer. The frame is sandboxed (no scripts of its own); the dashboard
 * mounts rrweb-player into it from outside, and rrweb's replay frame inside inherits that policy.
 */
function Player({ slug, w, seg, stepTitle }: { slug: string; w: WalkthroughView; seg: RecordingSegment; stepTitle: (id: string | null) => string | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const player = useRef<PlayerT | null>(null);
  const [events, setEvents] = useState<RrEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [skip, setSkip] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setError(null);
    sbApi.recordingEvents(slug, w.id, seg.no).then(
      (ev) => live && setEvents(ev as RrEvent[]),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [slug, w.id, seg.no]);

  const markers = useMemo(() => (events ? stepMarkers(events) : []), [events]);
  const notes = useMemo(() => (events ? recordingNotes(events as never) : []), [events]);
  const viewport = useMemo(() => {
    const meta = events?.find((e) => e.type === 4 && e.data?.width);
    return { w: meta?.data?.width ?? 1280, h: meta?.data?.height ?? 800 };
  }, [events]);

  // The player is created when the events are in (rrweb-player is imported then, with its stylesheet).
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!events || events.length < 2 || !frameReady || !doc?.body || !stage.current) return;
    let live = true;
    let p: PlayerT | null = null;
    const size = () => {
      const width = Math.max(200, Math.floor(stage.current?.clientWidth ?? 640));
      const height = Math.min(Math.round((width * viewport.h) / viewport.w), Math.round(window.innerHeight * 0.62));
      return { width, height };
    };
    void Promise.all([import('rrweb-player'), import('rrweb-player/dist/style.css?inline')]).then(([mod, css]) => {
      if (!live || !doc.body) return;
      const Ctor = mod.default as unknown as new (o: { target: HTMLElement; props: Record<string, unknown> }) => PlayerT;
      doc.head.querySelectorAll('style[data-rec]').forEach((s) => s.remove());
      const st = doc.createElement('style');
      st.setAttribute('data-rec', '');
      st.textContent = `${(css as { default: string }).default}\n${FRAME_CSS}`;
      doc.head.append(st);
      const target = doc.createElement('div');
      doc.body.replaceChildren(target);
      const s0 = size();
      setFrameSize(s0);
      p = new Ctor({
        target,
        // UNSAFE_replayCanvas stays off: it would run the recorded canvas code.
        props: { events, ...s0, showController: false, autoPlay: false, speedOption: [...SPEEDS], speed: 1, skipInactive: true, mouseTail: false, UNSAFE_replayCanvas: false },
      });
      player.current = p;
      setTotal(p.getMetaData().totalTime);
      setTime(0);
      setPlaying(false);
      setSpeed(1);
      setSkip(true);
      p.addEventListener('ui-update-current-time', (d) => setTime(Number((d as { payload?: number }).payload ?? 0)));
      p.addEventListener('ui-update-player-state', (d) => setPlaying((d as { payload?: string }).payload === 'playing'));
      setReady(true);
    }, (e) => live && setError(`The player could not load: ${e instanceof Error ? e.message : String(e)}`));
    const ro = new ResizeObserver(() => {
      if (!p) return;
      const s = size();
      setFrameSize(s);
      p.$set(s);
      p.triggerResize();
    });
    ro.observe(stage.current);
    return () => {
      live = false;
      ro.disconnect();
      setReady(false);
      try {
        p?.pause();
        p?.$destroy();
      } catch {
        /* gone */
      }
      player.current = null;
    };
  }, [events, frameReady, viewport.w, viewport.h]);

  const go = (t: number) => {
    player.current?.goto(Math.max(0, Math.min(total, t)), playing);
    setTime(t);
  };
  const toggle = () => {
    const p = player.current;
    if (!p) return;
    if (playing) p.pause();
    else {
      if (time >= total - 50) p.goto(0, true);
      else p.play();
    }
  };
  const pct = (t: number) => (total ? Math.min(100, (t / total) * 100) : 0);

  return (
    <div className="rec-player">
      <div className="rec-stage" ref={stage} style={{ aspectRatio: ready ? undefined : `${viewport.w} / ${viewport.h}` }}>
        <iframe
          ref={frame}
          className="rec-host"
          title="Recording replay"
          src={sbPaths.recordingPlayer(slug, w.id)}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          style={frameSize ? { width: frameSize.width, height: frameSize.height } : undefined}
          onLoad={() => setFrameReady(true)}
        />
        {!ready && !error && <div className="rec-stage-msg muted small">{events && events.length < 2 ? 'This segment has no page snapshot yet.' : 'Loading the recording…'}</div>}
        {error && <div className="rec-stage-msg"><ErrorBox error={error} /></div>}
      </div>
      {notes.map((n) => (
        <p key={n} className="rec-note small" role="note">
          {n}
        </p>
      ))}
      <div className="rec-controls" aria-disabled={!ready}>
        <button className="btn sm rec-play" disabled={!ready} onClick={toggle} aria-label={playing ? 'Pause playback' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="rec-time small" aria-live="off">
          {fmtClock(time)} <span className="faint">/ {fmtClock(total)}</span>
        </span>
        <div className="rec-timeline">
          <span className="rec-track" aria-hidden="true">
            <span style={{ width: `${pct(time)}%` }} />
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, total)}
            step={100}
            value={Math.min(time, total)}
            disabled={!ready}
            aria-label="Position"
            aria-valuetext={`${fmtClock(time)} of ${fmtClock(total)}`}
            onChange={(e) => go(Number(e.target.value))}
          />
          {markers.map((m, i) => (
            <button
              key={`${m.stepId}-${i}`}
              className="rec-marker"
              style={{ left: `${pct(m.at)}%` }}
              disabled={!ready}
              title={`${stepTitle(m.stepId) ?? 'Step'} · ${fmtClock(m.at)}`}
              aria-label={`Jump to step ${stepTitle(m.stepId) ?? m.stepId} at ${fmtClock(m.at)}`}
              onClick={() => go(m.at)}
            />
          ))}
        </div>
        <div className="seg rec-speed" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`seg-btn ${speed === s ? 'active' : ''}`}
              aria-pressed={speed === s}
              disabled={!ready}
              onClick={() => {
                player.current?.setSpeed(s);
                setSpeed(s);
              }}
            >
              {s}x
            </button>
          ))}
        </div>
        <label className="rec-skip small">
          <input
            type="checkbox"
            checked={skip}
            disabled={!ready}
            onChange={() => {
              player.current?.toggleSkipInactive();
              setSkip(!skip);
            }}
          />
          Skip inactivity
        </label>
      </div>
      {markers.length > 0 && (
        <div className="rec-steps" aria-label="Steps in this segment">
          {markers.map((m, i) => (
            <button key={`${m.stepId}-${i}`} className={`rec-step ${time >= m.at && (markers[i + 1]?.at ?? Infinity) > time ? 'on' : ''}`} disabled={!ready} onClick={() => go(m.at)}>
              <span className="faint">{fmtClock(m.at)}</span> <span className="ellipsis">{stepTitle(m.stepId) ?? 'Step'}</span>
            </button>
          ))}
        </div>
      )}
      <p className="faint small rec-foot">
        {pathOf(seg.url)} · {fmtDateTime(seg.startedAt)} · {seg.events} events · {fmtBytes(seg.bytes)}
      </p>
    </div>
  );
}

/** Step markers of a video segment (its metadata), once per change, inside the video. */
export function videoMarkers(seg: Pick<RecordingSegment, 'markers' | 'durationMs'>): { at: number; stepId: string }[] {
  const out: { at: number; stepId: string }[] = [];
  for (const m of seg.markers ?? []) {
    if (!m.stepId || out.at(-1)?.stepId === m.stepId) continue;
    out.push({ at: Math.max(0, seg.durationMs ? Math.min(m.at, seg.durationMs) : m.at), stepId: m.stepId });
  }
  return out;
}

/** A video segment: the WebM file in a <video> (Range requests), with the same controls as the DOM player. */
function VideoPlayer({ slug, w, seg, stepTitle }: { slug: string; w: WalkthroughView; seg: RecordingSegment; stepTitle: (id: string | null) => string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = sbPaths.recordingSegment(slug, w.id, seg.no);
  // The hub writes the duration into the file; the segment's own is the fallback (a live one grows).
  const total = mediaTotal || seg.durationMs;
  const markers = useMemo(() => videoMarkers(seg), [seg.markers, seg.durationMs]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onMeta = () => {
      const d = v.duration;
      if (Number.isFinite(d) && d > 0) setMediaTotal(Math.round(d * 1000));
      setReady(true);
    };
    const onTime = () => setTime(Math.round(v.currentTime * 1000));
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError('The video could not be played (this browser may not play WebM).');
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('durationchange', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('durationchange', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
      v.removeEventListener('error', onError);
    };
  }, [src]);

  const go = (t: number) => {
    const v = ref.current;
    if (!v) return;
    const c = Math.max(0, Math.min(total, t));
    v.currentTime = c / 1000;
    setTime(c);
  };
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    else v.pause();
  };
  const pct = (t: number) => (total ? Math.min(100, (t / total) * 100) : 0);
  const codec = (seg.mime ?? '').match(/codecs="?([a-z0-9.]+)/i)?.[1]?.toUpperCase();

  return (
    <div className="rec-player rec-video-player">
      <div className="rec-stage rec-video-stage">
        <video ref={ref} className="rec-video" src={src} preload="metadata" playsInline muted onClick={toggle} aria-label={`Video of segment ${seg.no}`} data-testid="recording-video" />
        {error && (
          <div className="rec-stage-msg">
            <ErrorBox error={error} />
          </div>
        )}
      </div>
      <div className="rec-controls" aria-disabled={!ready}>
        <button className="btn sm rec-play" disabled={!ready} onClick={toggle} aria-label={playing ? 'Pause playback' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="rec-time small" aria-live="off">
          {fmtClock(time)} <span className="faint">/ {fmtClock(total)}</span>
        </span>
        <div className="rec-timeline">
          <span className="rec-track" aria-hidden="true">
            <span style={{ width: `${pct(time)}%` }} />
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, total)}
            step={100}
            value={Math.min(time, total)}
            disabled={!ready}
            aria-label="Position"
            aria-valuetext={`${fmtClock(time)} of ${fmtClock(total)}`}
            onChange={(e) => go(Number(e.target.value))}
          />
          {markers.map((m, i) => (
            <button
              key={`${m.stepId}-${i}`}
              className="rec-marker"
              style={{ left: `${pct(m.at)}%` }}
              disabled={!ready}
              title={`${stepTitle(m.stepId) ?? 'Step'} · ${fmtClock(m.at)}`}
              aria-label={`Jump to step ${stepTitle(m.stepId) ?? m.stepId} at ${fmtClock(m.at)}`}
              onClick={() => go(m.at)}
            />
          ))}
        </div>
        <div className="seg rec-speed" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`seg-btn ${speed === s ? 'active' : ''}`}
              aria-pressed={speed === s}
              disabled={!ready}
              onClick={() => {
                if (ref.current) ref.current.playbackRate = s;
                setSpeed(s);
              }}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
      {markers.length > 0 && (
        <div className="rec-steps" aria-label="Steps in this video">
          {markers.map((m, i) => (
            <button key={`${m.stepId}-${i}`} className={`rec-step ${time >= m.at && (markers[i + 1]?.at ?? Infinity) > time ? 'on' : ''}`} disabled={!ready} onClick={() => go(m.at)}>
              <span className="faint">{fmtClock(m.at)}</span> <span className="ellipsis">{stepTitle(m.stepId) ?? 'Step'}</span>
            </button>
          ))}
        </div>
      )}
      <p className="faint small rec-foot">
        Video · {pathOf(seg.url)} · {fmtDateTime(seg.startedAt)} · {fmtClock(seg.durationMs)} · {fmtBytes(seg.bytes)}
        {codec ? ` · WebM ${codec}` : ''}
        {seg.status === 'recording' ? ' · still recording (reopen to see more)' : ''}
      </p>
    </div>
  );
}

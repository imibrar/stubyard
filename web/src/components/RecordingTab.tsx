// The Recording tab of a walkthrough (walkthrough recording R1): the segments the extension recorded (one per page
// load), a player (rrweb-player, loaded on first use: it is ~200 KB) with our own Canvas-style controls, step markers
// on the timeline (rrweb custom events "stubyard.step"; a click jumps there), speed 1x / 2x / 4x, skip inactivity,
// the stored size against the cap, Pause / Resume while the run is active, and Delete.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from '../hooks';
import { sbApi, sbPaths, type RecordingList, type RecordingSegment, type WalkthroughView } from '../storyboardsApi';
import { Badge, ErrorBox, fmtBytes, fmtDateTime, Modal, useToast } from './ui';
import '../styles/recording.css';

/** The rrweb custom event the extension adds at a segment start and at every step change. */
export const STEP_EVENT_TAG = 'stubyard.step';
const SPEEDS = [1, 2, 4] as const;

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
  const segs = list.data?.segments ?? [];
  const current = segs.find((s) => s.no === sel) ?? segs[0] ?? null;

  useEffect(() => {
    if (sel === null && segs.length) setSel(segs[0].no);
    if (sel !== null && segs.length && !segs.some((s) => s.no === sel)) setSel(segs[0].no);
  }, [segs.map((s) => s.no).join(',')]);

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
  const recording = l?.mode === 'dom' && active && !l.stopped;
  return (
    <section className="rec" data-testid="recording-tab">
      <div className="rec-head">
        <div className="rec-sum">
          {recording && (
            <Badge kind={l.paused ? 'warn' : 'bad'}>{l.paused ? 'paused' : 'recording'}</Badge>
          )}
          {l?.stopped && <Badge kind="warn">stopped at the cap</Badge>}
          <span className="small">
            {segs.length} segment{segs.length === 1 ? '' : 's'} · {fmtBytes(l?.bytes ?? 0)} <span className="faint">of {fmtBytes(l?.maxBytes ?? 0)}</span>
          </span>
          {l?.maskAllInputs && <span className="faint small">all inputs masked</span>}
        </div>
        <div className="rec-actions">
          {recording && (
            <button className="btn sm" onClick={() => void act(() => sbApi.setRecording(slug, w.id, { paused: !l.paused }), l.paused ? 'Recording resumed' : 'Recording paused')}>
              {l.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {active && l && l.mode !== 'dom' && (
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
      {l && segs.length === 0 && (
        <div className="rec-empty">
          <strong>Nothing recorded</strong>
          <p className="small muted">
            {l.mode === 'dom'
              ? 'The extension records the app pages of this run while it is open in a window (Chrome extension 0.5.0 or later). Segments show here as they come in.'
              : l.requested === 'off'
                ? 'Recording was off for this run. Turn it on per storyboard (Record) or per run in the extension\'s Start screen.'
                : 'Recording is off now.'}
          </p>
        </div>
      )}
      {current && (
        <div className="rec-body">
          <Player key={`${current.no}-${current.status === 'recording' ? current.events : 'done'}`} slug={slug} w={w} seg={current} stepTitle={stepTitle} />
          <ol className="rec-segs" aria-label="Segments">
            {segs.map((s) => (
              <li key={s.no}>
                <button className={`rec-seg ${s.no === current.no ? 'on' : ''}`} aria-current={s.no === current.no ? 'true' : undefined} onClick={() => setSel(s.no)}>
                  <span className="rec-seg-no">{s.no}</span>
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
            All {segs.length} segments ({fmtBytes(l?.bytes ?? 0)}) are removed. Step results, notes and screenshots stay.{active && l?.mode === 'dom' ? ' Recording goes on for the rest of the run.' : ''}
          </p>
        </Modal>
      )}
    </section>
  );
}

function Player({ slug, w, seg, stepTitle }: { slug: string; w: WalkthroughView; seg: RecordingSegment; stepTitle: (id: string | null) => string | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
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
  const viewport = useMemo(() => {
    const meta = events?.find((e) => e.type === 4 && e.data?.width);
    return { w: meta?.data?.width ?? 1280, h: meta?.data?.height ?? 800 };
  }, [events]);

  // The player is created when the events are in (rrweb-player is imported then, with its stylesheet).
  useEffect(() => {
    if (!events || events.length < 2 || !host.current || !stage.current) return;
    let live = true;
    let p: PlayerT | null = null;
    const size = () => {
      const width = Math.max(200, Math.floor(stage.current?.clientWidth ?? 640));
      const height = Math.min(Math.round((width * viewport.h) / viewport.w), Math.round(window.innerHeight * 0.62));
      return { width, height };
    };
    void Promise.all([import('rrweb-player'), import('rrweb-player/dist/style.css')]).then(([mod]) => {
      if (!live || !host.current) return;
      const Ctor = mod.default as unknown as new (o: { target: HTMLElement; props: Record<string, unknown> }) => PlayerT;
      host.current.replaceChildren();
      p = new Ctor({
        target: host.current,
        props: { events, ...size(), showController: false, autoPlay: false, speedOption: [...SPEEDS], speed: 1, skipInactive: true, mouseTail: false, UNSAFE_replayCanvas: false },
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
      p.$set(size());
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
  }, [events, viewport.w, viewport.h]);

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
        <div ref={host} className="rec-host" />
        {!ready && !error && <div className="rec-stage-msg muted small">{events && events.length < 2 ? 'This segment has no page snapshot yet.' : 'Loading the recording…'}</div>}
        {error && <div className="rec-stage-msg"><ErrorBox error={error} /></div>}
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

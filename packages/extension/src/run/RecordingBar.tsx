// The recording line of a run (walkthrough recording R1 DOM, R2 video): a red dot while the extension records,
// Pause / Resume, why it stopped (the hub's size cap). Video runs also show the minutes left under the cap and, when
// no capture runs, Record video (Chrome's tab capture must start from a click). Shared by the side panel and the
// on-page widget. The hub holds the state (PATCH …/recording); the views tell the service worker to re-sync (useRun).
import { useContext } from 'react';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { setRecording } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAction } from '../sidepanel/context';
import type { HubTarget } from '../sidepanel/hub';
import { videoMinutesLeft, type VideoSession } from '../shared/video';
import { StepHostContext } from './host';
import { startVideoFor, useVideo, type VideoEnded } from './useVideo';

/** idle: a video run whose capture is not running (Record video). */
export type RecordingUiState = 'on' | 'paused' | 'stopped' | 'off' | 'idle';

/** The run's recording state for the UI (video: `video` is the running capture of this run, if any). */
export function recordingUiState(w: Pick<WalkthroughView, 'recording' | 'status'>, video?: VideoSession | null): RecordingUiState {
  const r = w.recording;
  if (!r) return 'off';
  if (r.stopped) return 'stopped';
  if ((r.mode !== 'dom' && r.mode !== 'video') || w.status !== 'active') return 'off';
  if (r.mode === 'video') {
    if (!video) return 'idle';
    return r.paused || video.paused ? 'paused' : 'on';
  }
  return r.paused ? 'paused' : 'on';
}

/** The text of the line. */
export function recordingText(w: Pick<WalkthroughView, 'recording' | 'status'>, state: RecordingUiState, compact: boolean, video: VideoSession | null, ended: VideoEnded | null): string {
  const r = w.recording!;
  if (state === 'stopped') return r.stopped ?? 'Recording stopped';
  if (r.mode === 'video') {
    const left = videoMinutesLeft(r.bytes, r.maxBytes);
    const leftText = r.maxBytes ? (compact ? ` · ≥${left} min left` : ` · at least ${left} min left of ${Math.round(r.maxBytes / 1024 / 1024)} MB`) : '';
    if (state === 'idle') return compact ? 'Video: not recording' : `Video recording is on for this run but not running${ended ? ` (${ended.reason})` : ''}.`;
    if (state === 'paused')
      return video?.pausedFor === 'origin' && !r.paused
        ? compact
          ? 'Video paused (other site)'
          : 'Video paused: the tab shows a page outside the run.'
        : compact
          ? 'Video paused'
          : 'Video paused: nothing is recorded.';
    return compact ? `Recording video${leftText}` : `Recording a video of this tab${leftText}.`;
  }
  if (state === 'paused') return compact ? 'Recording paused' : 'Recording paused: nothing on the pages is recorded.';
  return compact ? 'Recording' : 'Recording this run (the app pages; passwords and codes masked).';
}

export function RecordingBar({ t, w, apply, compact }: { t: HubTarget; w: WalkthroughView; apply: (v: WalkthroughView) => void; compact?: boolean }) {
  const act = useAction();
  const host = useContext(StepHostContext);
  const { session, ended } = useVideo(w.recording?.mode === 'video' ? w.id : null);
  const state = recordingUiState(w, session);
  if (state === 'off') return null;
  const r = w.recording!;
  const toggle = () => act.run('rec', async () => apply(await setRecording(t, w.id, { paused: !r.paused })));
  const record = () =>
    act.run('rec', async () => {
      const res = await startVideoFor(host?.tab?.id);
      if (!res.ok) throw new Error(res.error);
    });
  const text = recordingText(w, state, !!compact, session, ended);
  // A capture paused because the tab is on another site resumes by itself; the run's Pause is the button.
  const pausedByRun = r.paused;
  return (
    <div className={`rec-bar ${state}`} role="status" data-testid="recording-bar">
      <span className="rec-dot" aria-hidden="true" />
      <span className="rec-text" title={state === 'stopped' || state === 'idle' ? text : undefined}>
        {text}
      </span>
      {state === 'idle' && (
        <button className="link small" disabled={!!act.busy} onClick={() => void record()} data-testid="record-video">
          Record video
        </button>
      )}
      {(state === 'on' || state === 'paused') && (
        <button className="link small" disabled={!!act.busy} onClick={() => void toggle()} aria-label={pausedByRun ? 'Resume the recording' : 'Pause the recording'}>
          {pausedByRun ? 'Resume' : 'Pause'}
        </button>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

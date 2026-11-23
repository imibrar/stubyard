// The recording line of a run (walkthrough recording R1): a red dot while the extension records the run's app pages,
// Pause / Resume, and why it stopped (the hub's size cap). Shared by the side panel and the on-page widget. The hub
// holds the state (PATCH …/recording); the views tell the service worker to re-sync the tabs (useRun does).
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { setRecording } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAction } from '../sidepanel/context';
import type { HubTarget } from '../sidepanel/hub';

export type RecordingUiState = 'on' | 'paused' | 'stopped' | 'off';

/** The run's recording state for the UI. */
export function recordingUiState(w: Pick<WalkthroughView, 'recording' | 'status'>): RecordingUiState {
  const r = w.recording;
  if (!r) return 'off';
  if (r.stopped) return 'stopped';
  if (r.mode !== 'dom' || w.status !== 'active') return 'off';
  return r.paused ? 'paused' : 'on';
}

export function RecordingBar({ t, w, apply, compact }: { t: HubTarget; w: WalkthroughView; apply: (v: WalkthroughView) => void; compact?: boolean }) {
  const act = useAction();
  const state = recordingUiState(w);
  if (state === 'off') return null;
  const r = w.recording!;
  const toggle = () => act.run('rec', async () => apply(await setRecording(t, w.id, { paused: state === 'on' })));
  const text =
    state === 'stopped'
      ? (r.stopped ?? 'Recording stopped')
      : state === 'paused'
        ? compact
          ? 'Recording paused'
          : 'Recording paused: nothing on the pages is recorded.'
        : compact
          ? 'Recording'
          : 'Recording this run (the app pages; passwords and codes masked).';
  return (
    <div className={`rec-bar ${state}`} role="status" data-testid="recording-bar">
      <span className="rec-dot" aria-hidden="true" />
      <span className="rec-text" title={state === 'stopped' ? text : undefined}>
        {text}
      </span>
      {state !== 'stopped' && (
        <button className="link small" disabled={!!act.busy} onClick={() => void toggle()} aria-label={state === 'on' ? 'Pause the recording' : 'Resume the recording'}>
          {state === 'on' ? 'Pause' : 'Resume'}
        </button>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

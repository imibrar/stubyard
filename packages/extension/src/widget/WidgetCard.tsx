// The widget's card: the current step only (title, intent, actor, expected, values), the shared kind controls for
// the simple step kinds, and the footers: tracked (Done/Pass, Skip, Fail, note, Screenshot, Next) or quick (Next ✓,
// Finish). All step kinds run here (login with the 2FA wait and email with the compact link picker since phase 1b).
// Sign-off and cleanup stay in the panel.
import { useRef, useState } from 'react';
import type { ResolvedStep, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { finishWalkthrough, updateStep } from '@stubyard/client/walkthroughs';
import { useStepHost } from '../run/host';
import { useStepActions } from '../run/stepActions';
import { resolvedFor, type RunState } from '../run/useRun';
import { RecordingBar } from '../run/RecordingBar';
import { widgetRunsKind } from '../shared/widget';
import { createdUsers } from '../sidepanel/cleanup';
import { ErrorBox, useAction } from '../sidepanel/context';
import type { HubTarget } from '../sidepanel/hub';
import { fillVars, isQuickRun, progress } from '../sidepanel/state';
import { StepControls, StepIntro } from '../sidepanel/steps/StepCard';

export interface WidgetUi {
  openPanel: () => void;
  collapse: () => void;
  hide: () => void;
}

/** 16 px stroke icons (no icon font: the widget loads nothing from the network). */
const ICONS = {
  panel: 'M3.5 3.5h13v13h-13z M12 3.5v13',
  collapse: 'M5 10h10',
  close: 'M5.5 5.5l9 9 M14.5 5.5l-9 9',
  camera: 'M3 6.5h3l1.5-2h5L14 6.5h3v9H3z M10 13.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z',
};
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="w-svg" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Tools({ ui }: { ui: WidgetUi }) {
  return (
    <span className="w-tools">
      <button className="w-icon" title="Open the side panel" aria-label="Open the side panel" onClick={ui.openPanel}>
        <Icon name="panel" />
      </button>
      <button className="w-icon" title="Collapse (Esc)" aria-label="Collapse the widget" aria-keyshortcuts="Escape" onClick={ui.collapse}>
        <Icon name="collapse" />
      </button>
      <button className="w-icon" title="Hide on this tab (the panel's Walkthrough screen can show it again)" aria-label="Hide on this tab" onClick={ui.hide}>
        <Icon name="close" />
      </button>
    </span>
  );
}

/** Hub offline or a failed reload: a clear line, the countdown and Retry now (the card below may be out of date). */
export function Offline({ retryIn, onRetry, offline, stale, error }: { retryIn: number | null; onRetry: () => void; offline: boolean; stale?: boolean; error?: string }) {
  return (
    <div className="w-offline" role="status" title={stale ? 'The card below shows the last state it loaded; buttons work again once stubyard answers.' : undefined}>
      <span className="w-offline-dot" aria-hidden="true" />
      <span className="w-offline-text">
        {stale ? (offline ? 'stubyard is not reachable.' : `Could not reload: ${error ?? 'error'}`) : 'The widget keeps trying.'}
        {retryIn !== null && retryIn > 0 ? ` Retrying in ${retryIn} s.` : retryIn === 0 ? ' Retrying…' : ''}
      </span>
      <button className="link small" onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
}

/** A one-line state (no run, an error, a finished run) with the tools. */
export function WidgetMessage({ ui, text, error, children }: { ui: WidgetUi; text: string; error?: boolean; children?: React.ReactNode }) {
  return (
    <section className="w-card" role="dialog" aria-label="stubyard">
      <header className="w-head">
        <span className="w-brand">stubyard</span>
        <Tools ui={ui} />
      </header>
      <p className={error ? 'error' : 'w-msg'} dir="auto">
        {text}
      </p>
      {children}
    </section>
  );
}

export function WidgetCard({ t, run, ui }: { t: HubTarget; run: RunState; ui: WidgetUi }) {
  const p = useStepHost();
  const act = useAction();
  const w = run.w!;
  const quick = isQuickRun(w);
  const step = w.status === 'active' ? run.step : null;
  const created = createdUsers(w);

  const quickFinish = () =>
    act.run('finish', async () => {
      const v = await finishWalkthrough(t, w.id, {});
      // A run that created users stays open, so the panel's cleanup section can offer "Clean up this run".
      if (createdUsers(v) > 0) return run.apply(v);
      await p.openWalkthrough(null);
      p.notify('Quick test finished');
    });

  if (w.status !== 'active') {
    const cleanupLeft = created > 0 && w.cleanupStatus !== 'cleaned' && w.cleanupStatus !== 'dismissed';
    return (
      <WidgetMessage ui={ui} text={`${w.storyboard.name}: this ${quick ? 'quick test' : 'walkthrough'} is ${w.status}.`}>
        {cleanupLeft && (
          <p className="small">
            It created {created} test user{created === 1 ? '' : 's'}. Clean {created === 1 ? 'it' : 'them'} up in the panel.
          </p>
        )}
        <div className="row wrap w-foot">
          <button className={cleanupLeft ? 'primary' : ''} onClick={ui.openPanel}>
            Open panel
          </button>
          {!cleanupLeft && <button onClick={() => void p.openWalkthrough(null)}>Close</button>}
        </div>
      </WidgetMessage>
    );
  }

  if (!step) {
    return (
      <WidgetMessage ui={ui} text={quick ? 'All steps are done.' : 'All steps are finished. Sign off in the panel.'}>
        <div className="row wrap w-foot">
          {quick ? (
            <button className="primary" disabled={!!act.busy} onClick={() => void quickFinish()}>
              {act.busy === 'finish' ? 'Finishing…' : 'Finish'}
            </button>
          ) : (
            <button className="primary" onClick={ui.openPanel}>
              Open panel
            </button>
          )}
        </div>
        <ErrorBox error={act.error} />
      </WidgetMessage>
    );
  }

  return <StepView key={step.id} t={t} w={w} step={step} run={run} ui={ui} quick={quick} quickFinish={quickFinish} finishing={act.busy === 'finish'} finishError={act.error} />;
}

function StepView(props: {
  t: HubTarget;
  w: WalkthroughView;
  step: WalkthroughStepView;
  run: RunState;
  ui: WidgetUi;
  quick: boolean;
  quickFinish: () => Promise<void>;
  finishing: boolean;
  finishError: string | null;
}) {
  const { t, w, step, run, ui, quick } = props;
  const resolved = resolvedFor(run.resolved, step.id);
  const { finished, total } = progress(w);
  const title = resolved?.text?.title ?? fillVars(step.title, w.vars);
  const n = step.position + 1;
  const [warnOpen, setWarnOpen] = useState(false);
  return (
    <section className="w-card step" role="dialog" aria-label={`stubyard step ${n} of ${total}: ${title}`}>
      <header className="w-head">
        <span className="w-count" title={`${finished} of ${total} steps finished`}>
          {n}
          <span className="w-of">/{total}</span>
        </span>
        <span className="chip w-kind">{step.kind}</span>
        {quick && <span className="chip w-quick">Quick</span>}
        <Tools ui={ui} />
      </header>
      <div className="w-progress" role="progressbar" aria-label="Steps finished" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished}>
        <span style={{ width: `${total ? Math.round((finished / total) * 100) : 0}%` }} />
      </div>
      <RecordingBar t={t} w={w} apply={run.apply} compact />
      <h1 className="w-title" dir="auto" title={title}>
        {title}
      </h1>
      <StepIntro w={w} step={step} resolved={resolved} />
      {run.resolveError && (
        <div className="stack">
          <ErrorBox error={run.resolveError} />
          <button onClick={run.reresolve}>Retry</button>
        </div>
      )}
      {!resolved && !run.resolveError && <p className="muted small">Preparing the step…</p>}
      {resolved && resolved.warnings.length > 0 && (
        <button className="badge w-warn" aria-expanded={warnOpen} onClick={() => setWarnOpen(!warnOpen)}>
          ⚠ {resolved.warnings.length} warning{resolved.warnings.length === 1 ? '' : 's'}
        </button>
      )}
      {warnOpen && resolved && (
        <ul className="warnings">
          {resolved.warnings.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {resolved && <KindBody t={t} w={w} step={step} resolved={resolved} apply={run.apply} quick={quick} ui={ui} />}
      {quick ? (
        <QuickFoot t={t} w={w} step={step} apply={run.apply} finish={props.quickFinish} finishing={props.finishing} finishError={props.finishError} />
      ) : (
        <TrackedFoot t={t} w={w} step={step} apply={run.apply} />
      )}
    </section>
  );
}

const valueText = (v: string | boolean | string[]) => (Array.isArray(v) ? v.join(', ') : String(v));

function KindBody(props: { t: HubTarget; w: WalkthroughView; step: WalkthroughStepView; resolved: ResolvedStep; apply: (w: WalkthroughView) => void; quick: boolean; ui: WidgetUi }) {
  const { resolved, ui } = props;
  if (!widgetRunsKind(resolved.step.kind)) {
    return (
      <div className="controls w-panel-only">
        <p className="small">This kind of step ({resolved.step.kind}) runs in the side panel.</p>
        <button className="primary" onClick={ui.openPanel}>
          Open panel
        </button>
      </div>
    );
  }
  return (
    <>
      <StepControls t={props.t} w={props.w} step={props.step} resolved={resolved} apply={props.apply} quick={props.quick} />
      {resolved.step.kind === 'fill' && 'entries' in resolved && resolved.entries.length > 0 && (
        <details className="w-values">
          <summary>
            {resolved.entries.length} value{resolved.entries.length === 1 ? '' : 's'}
          </summary>
          <dl className="creds">
            {resolved.entries.map((e) => (
              <div key={e.key} className="w-value">
                <dt>{e.label || e.key}</dt>
                <dd dir="auto">{e.kind === 'skip' ? <span className="muted">skipped</span> : valueText(e.value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}

function TrackedFoot({ t, w, step, apply }: { t: HubTarget; w: WalkthroughView; step: WalkthroughStepView; apply: (w: WalkthroughView) => void }) {
  const { act, finish, next, hasNext, shoot } = useStepActions(t, w, step, apply);
  const [note, setNote] = useState(step.note ?? '');
  const [noteOpen, setNoteOpen] = useState(!!step.note);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const openNote = () => {
    setNoteOpen(true);
    setTimeout(() => noteRef.current?.focus(), 0);
  };
  // Fail opens the note first (say what went wrong); pressing Fail again records it.
  const fail = () => (noteOpen ? void finish('failed', note) : openNote());
  return (
    <div className="footer w-foot">
      {noteOpen ? (
        <textarea ref={noteRef} rows={2} dir="auto" placeholder="Note (what you saw, why it failed…)" value={note} onChange={(e) => setNote(e.target.value)} />
      ) : (
        <button className="link small w-addnote" onClick={openNote}>
          Add note
        </button>
      )}
      <div className="row wrap">
        <button className="primary" disabled={!!act.busy} onClick={() => void finish('done', note)}>
          {step.kind === 'check' ? 'Pass' : 'Done'}
        </button>
        <button disabled={!!act.busy} onClick={() => void finish('skipped', note)}>
          Skip
        </button>
        <button className="danger" disabled={!!act.busy} onClick={fail} title={noteOpen ? 'Record as failed' : 'Add a note, then press Fail again'}>
          Fail
        </button>
        <button className="w-icon-btn" disabled={!!act.busy} title="Screenshot (the widget is hidden for the shot)" aria-label="Screenshot" onClick={() => void shoot()}>
          <Icon name="camera" />
          {step.shots.length > 0 && <span className="w-shots">{step.shots.length}</span>}
        </button>
        <button disabled={!!act.busy || !hasNext} onClick={() => void next()}>
          Next
        </button>
      </div>
      {step.status !== 'pending' && step.status !== 'active' && <p className="muted small">Recorded as {step.status}.</p>}
      <ErrorBox error={act.error} />
    </div>
  );
}

function QuickFoot(props: {
  t: HubTarget;
  w: WalkthroughView;
  step: WalkthroughStepView;
  apply: (w: WalkthroughView) => void;
  finish: () => Promise<void>;
  finishing: boolean;
  finishError: string | null;
}) {
  const { t, w, step, apply } = props;
  const act = useAction();
  // The hub moves the current step on to the next open one.
  const next = () => act.run('next', async () => apply(await updateStep(t, w.id, step.id, { status: 'done' })));
  return (
    <div className="footer w-foot">
      <div className="row wrap">
        <button className="primary" title="Mark this step done and go to the next one" disabled={!!act.busy || props.finishing} onClick={() => void next()}>
          Next ✓
        </button>
        <button disabled={!!act.busy || props.finishing} onClick={() => void props.finish()}>
          {props.finishing ? 'Finishing…' : 'Finish'}
        </button>
      </div>
      <ErrorBox error={act.error ?? props.finishError} />
    </div>
  );
}

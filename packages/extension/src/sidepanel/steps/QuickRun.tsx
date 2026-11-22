// Quick test run: a compact list of the steps with the current one expanded to its helpers (Go, Fill login, Fill
// form, Wait for message, Capture…). Nothing is recorded but progress: "Next ✓" marks the step done quietly (so the
// run can be resumed), rows can be clicked to jump, and Finish ends the run (the hub skips the open steps).
import type { ResolvedStep, WalkthroughView } from '@stubyard/client/storyboard-types';
import { abandonWalkthrough, finishWalkthrough, patchWalkthrough, updateStep } from '@stubyard/client/walkthroughs';
import { createdUsers } from '../cleanup';
import { RunCleanup } from '../cleanupUi';
import { ErrorBox, useAction } from '../context';
import { useStepHost } from '../../run/host';
import type { HubTarget } from '../hub';
import { currentStep, quickRows } from '../state';
import { StepControls, StepIntro } from './StepCard';

/** The panel's quick run list. Its end screen's RunCleanup is panel-only (it reads PanelState ticks). */
export function QuickRun(props: {
  t: HubTarget;
  w: WalkthroughView;
  resolved: ResolvedStep | null;
  resolveError: string | null;
  reresolve: () => void;
  apply: (w: WalkthroughView) => void;
}) {
  const { t, w, apply } = props;
  const p = useStepHost();
  const act = useAction();
  const step = w.status === 'active' ? currentStep(w) : null;
  const resolved = step && props.resolved?.step.id === step.id ? props.resolved : null;
  const rows = quickRows(w, step?.id ?? null, resolved?.text?.title);

  const jump = (id: string) => act.run('select', async () => apply(await patchWalkthrough(t, w.id, { currentStepId: id })));
  // The hub moves the current step on to the next open one.
  const next = (id: string) => act.run('next', async () => apply(await updateStep(t, w.id, id, { status: 'done' })));
  // A run that created users stays open on its end screen, to offer "Clean up this run"; else it closes.
  const end = async (v: WalkthroughView, msg: string) => {
    if (createdUsers(v) > 0) return apply(v);
    await p.openWalkthrough(null);
    p.notify(msg);
  };
  const finish = () => act.run('finish', async () => end(await finishWalkthrough(t, w.id, {}), 'Quick test finished'));
  const abandon = () => act.run('abandon', async () => end(await abandonWalkthrough(t, w.id), 'Quick test abandoned'));

  if (w.status !== 'active') {
    return (
      <div className="stack">
        <section className="card">
          <p>This quick test is {w.status}.</p>
          <button onClick={() => void p.openWalkthrough(null)}>Close</button>
        </section>
        <RunCleanup t={t} w={w} />
      </div>
    );
  }

  return (
    <div className="stack">
      <ol className="quick">
        {rows.map((r) => {
          const s = r.current ? step : null;
          return (
            <li key={r.id} className={`${r.done ? 'done' : ''} ${r.current ? 'current' : ''}`}>
              <div className="quick-head" onClick={() => !r.current && void jump(r.id)}>
                <span className="n">{r.done ? '✓' : `${r.n}.`}</span>
                <span className="title">{r.title}</span>
                {r.current && (
                  <button
                    className="primary next"
                    title="Mark this step done and go to the next one"
                    disabled={!!act.busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void next(r.id);
                    }}
                  >
                    Next ✓
                  </button>
                )}
              </div>
              {s && (
                <div className="quick-body">
                  <StepIntro w={w} step={s} resolved={resolved} />
                  {props.resolveError && (
                    <div className="stack">
                      <ErrorBox error={props.resolveError} />
                      <button onClick={props.reresolve}>Retry</button>
                    </div>
                  )}
                  {!resolved && !props.resolveError && <p className="muted small">Preparing the step…</p>}
                  {resolved && resolved.warnings.length > 0 && (
                    <ul className="warnings">
                      {resolved.warnings.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  )}
                  {resolved && <StepControls key={s.id} t={t} w={w} step={s} resolved={resolved} apply={apply} quick />}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!step && <p className="muted">All steps are done. Press Finish to end the quick test.</p>}
      <ErrorBox error={act.error} />
      <div className="row quick-foot">
        <button className="primary" disabled={!!act.busy} onClick={() => void finish()}>
          {act.busy === 'finish' ? 'Finishing…' : 'Finish'}
        </button>
        <button className="danger" disabled={!!act.busy} onClick={() => confirm('Abandon this quick test?') && void abandon()}>
          Abandon
        </button>
      </div>
    </div>
  );
}

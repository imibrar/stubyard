// The current step's card: title, intent, notes, actor hint, kind-specific controls, and the common footer
// (Done / Skip / Fail, note, Screenshot, Next). Every status change is PATCHed at once.
import { HubShot } from '../HubShot';
import { useState } from 'react';
import type { ResolvedStep, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { ErrorBox } from '../context';
import { useStepActions } from '../../run/stepActions';
import { shotUrl, type HubTarget } from '../hub';
import { actorHint, fillVars } from '../state';
import { Clamp } from '../ui';
import { CaptureControls, CheckControls, InstructionControls, OpenControls } from './SimpleControls';
import { EmailControls } from './EmailControls';
import { FillControls } from './FillControls';
import { LoginControls } from './LoginControls';

export interface StepProps<R extends ResolvedStep = ResolvedStep> {
  t: HubTarget;
  w: WalkthroughView;
  step: WalkthroughStepView;
  resolved: R;
  apply: (w: WalkthroughView) => void;
  /** A quick test run: no outcomes are recorded, so controls leave out tracking bits (assertions, "press Done"). */
  quick?: boolean;
}

export type ResolvedOf<K extends ResolvedStep['step']['kind']> = Extract<ResolvedStep, { step: { kind: K } }>;

export function StepCard(props: {
  t: HubTarget;
  w: WalkthroughView;
  step: WalkthroughStepView;
  resolved: ResolvedStep | null;
  resolveError: string | null;
  reresolve: () => void;
  apply: (w: WalkthroughView) => void;
}) {
  const { t, w, step, resolved, apply } = props;
  const { act, finish, next, hasNext, shoot } = useStepActions(t, w, step, apply);
  const [note, setNote] = useState(step.note ?? '');
  // Rendered by the hub once resolved; before that, {{vars.x}} filled from the walkthrough's vars.
  const title = resolved?.text?.title ?? fillVars(step.title, w.vars);
  const extras = [step.optional && 'Optional', step.screenshot === 'required' ? 'Screenshot required' : step.screenshot === 'offer' && 'Screenshot welcome'].filter(Boolean);

  return (
    <section className="card step">
      <div className="row between">
        <h3 dir="auto">
          {step.position + 1}. {title}
        </h3>
        <span className="chip">{step.kind}</span>
      </div>
      <StepIntro w={w} step={step} resolved={resolved} />
      {extras.length > 0 && <p className="muted small">{extras.join(' · ')}</p>}

      {props.resolveError && (
        <div className="stack">
          <ErrorBox error={props.resolveError} />
          <button onClick={props.reresolve}>Retry</button>
        </div>
      )}
      {!resolved && !props.resolveError && <p className="muted">Preparing the step…</p>}
      {resolved && resolved.warnings.length > 0 && (
        <ul className="warnings">
          {resolved.warnings.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {resolved && <StepControls t={t} w={w} step={step} resolved={resolved} apply={apply} />}

      {step.shots.length > 0 && (
        <div className="shots">
          {step.shots.map((s) => (
            <HubShot key={s.id} src={shotUrl(t, w.id, s.id)} />
          ))}
        </div>
      )}

      <div className="footer">
        <textarea rows={2} dir="auto" placeholder="Note (what you saw, why it failed…)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row wrap">
          <button className="primary" disabled={!!act.busy} onClick={() => void finish('done', note)}>
            {step.kind === 'check' ? 'Pass' : 'Done'}
          </button>
          <button disabled={!!act.busy} onClick={() => void finish('skipped', note)}>Skip</button>
          <button className="danger" disabled={!!act.busy} onClick={() => void finish('failed', note)}>Fail</button>
          <button disabled={!!act.busy} onClick={() => void shoot()}>Screenshot</button>
          <button disabled={!!act.busy || !hasNext} onClick={() => void next()}>Next</button>
        </div>
        {step.status !== 'pending' && step.status !== 'active' && <p className="muted small">Recorded as {step.status}. Pressing a button again changes it.</p>}
        <ErrorBox error={act.error} />
      </div>
    </section>
  );
}

/** Intent (one line, More), the actor hint, and the notes behind "Show notes"; shared by tracked and quick runs. */
export function StepIntro({ w, step, resolved }: { w: WalkthroughView; step: WalkthroughStepView; resolved: ResolvedStep | null }) {
  const [showNotes, setShowNotes] = useState(false);
  const shown = (rendered: string | undefined, raw: string) => rendered ?? fillVars(raw, w.vars);
  const intent = step.intent ? shown(resolved?.text?.intent, step.intent) : '';
  const notes = step.notes ? shown(resolved?.text?.notes, step.notes) : '';
  const hint = actorHint(w, step);
  return (
    <>
      {intent && <Clamp className="intent" text={intent} lines={1} dir="auto" />}
      {hint && <p className="actor small">{hint}</p>}
      {notes && (
        <>
          <button className="link small" onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? 'Hide notes' : 'Show notes'}
          </button>
          {showNotes && (
            <p className="notes small" dir="auto">
              {notes}
            </p>
          )}
        </>
      )}
    </>
  );
}

/** The kind-specific controls of a resolved step (shared by the tracked step card and the quick run list). */
export function StepControls(props: StepProps) {
  const { resolved } = props;
  const common = { t: props.t, w: props.w, step: props.step, apply: props.apply, quick: props.quick };
  switch (resolved.step.kind) {
    case 'open':
    case 'logout':
      return <OpenControls {...common} resolved={resolved as ResolvedOf<'open' | 'logout'>} />;
    case 'login':
      return <LoginControls {...common} resolved={resolved as ResolvedOf<'login'>} />;
    case 'fill':
      return <FillControls {...common} resolved={resolved as ResolvedOf<'fill'>} />;
    case 'email':
      return <EmailControls {...common} resolved={resolved as ResolvedOf<'email'>} />;
    case 'instruction':
      return <InstructionControls {...common} resolved={resolved as ResolvedOf<'instruction'>} />;
    case 'capture':
      return <CaptureControls {...common} resolved={resolved as ResolvedOf<'capture'>} />;
    case 'check':
      return <CheckControls {...common} resolved={resolved as ResolvedOf<'check'>} />;
    default:
      return null;
  }
}

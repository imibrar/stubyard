// Walkthrough (§6.10.4): header, the ordered step list, and the current step's card. The walkthrough record in
// stubyard is the only state: every status change is PATCHed at once, and the view is re-read on every event.
import { useEffect, useState } from 'react';
import { patchWalkthrough } from '@stubyard/client/walkthroughs';
import { resolvedFor, useRun } from '../../run/useRun';
import { ErrorBox, useAction, usePanel } from '../context';
import { isQuickRun, liveSteps, progress, STATUS_ICON } from '../state';
import { QuickRun } from '../steps/QuickRun';
import { StepCard } from '../steps/StepCard';
import { SummaryView } from './Summary';
import { WidgetTabToggle } from '../WidgetToggle';

export function WalkthroughScreen() {
  const p = usePanel();
  const active = p.active;
  const [view, setView] = useState<'steps' | 'summary'>('steps');
  const [details, setDetails] = useState(false);
  const act = useAction();
  const t = active ? p.target(active.project) : null;
  // Load (and reload on every walkthrough.changed event of this walkthrough), and resolve the current step.
  const { w, loadError, step, resolved, resolveError, reresolve, apply } = useRun(t, active?.id ?? null, p.ticks.walkthrough);

  useEffect(() => {
    if (w && w.status !== 'active') setView('summary');
  }, [w?.status]);

  if (!active || !t) {
    return (
      <p className="muted">
        No walkthrough is open in this window. <button className="link" onClick={() => p.go({ name: 'home' })}>Start one</button>
      </p>
    );
  }
  if (!w) {
    return (
      <div className="stack">
        {loadError ? <ErrorBox error={loadError} /> : <p className="muted">Loading the walkthrough…</p>}
        {loadError && <button onClick={() => void p.openWalkthrough(null)}>Close it in this window</button>}
      </div>
    );
  }

  const { finished, total } = progress(w);
  const vars = Object.entries(w.vars);
  const quick = isQuickRun(w);

  return (
    <div className="stack">
      <section className="card header">
        <div className="row between">
          <h2 className="one-line" dir="auto" title={w.storyboard.name}>{w.storyboard.name}</h2>
          {quick ? (
            <span className="chip">Quick test</span>
          ) : (
            <span className="row tabs">
              <button className={view === 'steps' ? 'tab on' : 'tab'} onClick={() => setView('steps')}>Steps</button>
              <button className={view === 'summary' ? 'tab on' : 'tab'} onClick={() => setView('summary')}>Summary</button>
            </span>
          )}
        </div>
        <div className="row progress-row">
          <div className="progress">
            <div style={{ width: `${total ? (finished / total) * 100 : 0}%` }} />
          </div>
          <span className="muted small">
            {finished}/{total}
          </span>
          <button className="link small" onClick={() => setDetails(!details)}>
            {details ? 'Hide details' : 'Details'}
          </button>
          {w.warnings.length > 0 && (
            <span className="badge" title={`${w.warnings.length} warning(s): see Details`} onClick={() => setDetails(true)}>
              ⚠ {w.warnings.length}
            </span>
          )}
        </div>
        {w.status === 'active' && <WidgetTabToggle />}
        {details && (
          <div className="details">
            <div className="muted small">
              {w.label ? `${w.label} · ` : ''}key <code>{w.key}</code> · {w.status}
            </div>
            {vars.length > 0 && (
              <div className="chips">
                {vars.map(([k, v]) => (
                  <span key={k} className="chip" title={v}>
                    {k}: {v.length > 24 ? `${v.slice(0, 23)}…` : v}
                  </span>
                ))}
              </div>
            )}
            {w.warnings.length > 0 && (
              <ul className="warnings">
                {w.warnings.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {quick ? (
        <QuickRun
          t={t}
          w={w}
          resolved={resolved?.r ?? null}
          resolveError={resolveError}
          reresolve={reresolve}
          apply={apply}
        />
      ) : view === 'summary' ? (
        <SummaryView w={w} t={t} apply={apply} />
      ) : (
        <>
          <ol className="steps">
            {liveSteps(w).map((s) => (
              <li
                key={s.id}
                className={`${s.status} ${s.id === step?.id ? 'current' : ''}`}
                onClick={() =>
                  w.status === 'active' &&
                  s.id !== step?.id &&
                  void act.run('select', async () => apply(await patchWalkthrough(t, w.id, { currentStepId: s.id })))
                }
              >
                <span className="icon">{STATUS_ICON[s.status]}</span>
                <span className="title">{s.title}</span>
                <span className="kind">{s.kind}</span>
              </li>
            ))}
          </ol>
          <ErrorBox error={act.error} />
          {w.status !== 'active' && <p className="muted">This walkthrough is {w.status}.</p>}
          {w.status === 'active' && !step && (
            <section className="card">
              <p>All steps are finished.</p>
              <button className="primary" onClick={() => setView('summary')}>Sign off</button>
            </section>
          )}
          {w.status === 'active' && step && (
            <StepCard
              key={step.id}
              t={t}
              w={w}
              step={step}
              resolved={resolvedFor(resolved, step.id)}
              resolveError={resolveError}
              reresolve={reresolve}
              apply={apply}
            />
          )}
        </>
      )}
    </div>
  );
}

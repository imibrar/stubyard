// Walkthrough (§6.10.4): header, the ordered step list, and the current step's card. The walkthrough record in
// stubyard is the only state: every status change is PATCHed at once, and the view is re-read on every event.
import { useCallback, useEffect, useState } from 'react';
import type { ResolvedStep, WalkthroughView } from '@stubyard/client/storyboard-types';
import { getWalkthrough, patchWalkthrough, resolveStep } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAction, usePanel } from '../context';
import { errorText } from '../hub';
import { currentStep, liveSteps, progress, STATUS_ICON } from '../state';
import { StepCard } from '../steps/StepCard';
import { SummaryView } from './Summary';

export function WalkthroughScreen() {
  const p = usePanel();
  const active = p.active;
  const [w, setW] = useState<WalkthroughView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'steps' | 'summary'>('steps');
  const [resolved, setResolved] = useState<{ stepId: string; r: ResolvedStep } | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveNonce, setResolveNonce] = useState(0);
  const act = useAction();
  const t = active ? p.target(active.project) : null;

  // Load (and reload on every walkthrough.changed event of this walkthrough).
  useEffect(() => {
    if (!active || !t) return;
    let live = true;
    setW((prev) => (prev?.id === active.id ? prev : null));
    getWalkthrough(t, active.id).then(
      (v) => {
        if (!live) return;
        setW(v);
        setLoadError(null);
      },
      (err) => live && setLoadError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [active?.id, active?.project, p.settings.apiUrl, p.ticks.walkthrough]);

  useEffect(() => {
    if (w && w.status !== 'active') setView('summary');
  }, [w?.status]);

  const step = w ? currentStep(w) : null;

  // Resolve the current step (URLs, credentials, rendered entries); this also marks a pending step active.
  useEffect(() => {
    if (!w || !t || !step || w.status !== 'active') return;
    let live = true;
    setResolveError(null);
    resolveStep(t, w.id, step.id).then(
      (r) => live && setResolved({ stepId: step.id, r }),
      (err) => {
        if (!live) return;
        setResolved(null);
        setResolveError(errorText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [w?.id, w?.status, step?.id, resolveNonce]);

  const apply = useCallback((v: WalkthroughView) => setW(v), []);

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

  return (
    <div className="stack">
      <section className="card header">
        <div className="row between">
          <h2>{w.storyboard.name}</h2>
          <span className="row">
            <button className={view === 'steps' ? 'tab on' : 'tab'} onClick={() => setView('steps')}>Steps</button>
            <button className={view === 'summary' ? 'tab on' : 'tab'} onClick={() => setView('summary')}>Summary</button>
          </span>
        </div>
        <div className="muted small">
          {w.label ? `${w.label} · ` : ''}key <code>{w.key}</code> · {finished}/{total} · {w.status}
        </div>
        <div className="progress">
          <div style={{ width: `${total ? (finished / total) * 100 : 0}%` }} />
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
      </section>

      {view === 'summary' ? (
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
              resolved={resolved?.stepId === step.id ? resolved.r : null}
              resolveError={resolveError}
              reresolve={() => setResolveNonce((n) => n + 1)}
              apply={apply}
            />
          )}
        </>
      )}
    </div>
  );
}

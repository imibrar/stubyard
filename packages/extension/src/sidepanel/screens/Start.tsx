// Start walkthrough (§6.10.3): storyboard description, actors (fresh / existing, with an override), inputs, origin.
import { useEffect, useState } from 'react';
import { getStoryboard } from '@stubyard/client/storyboards';
import { listUsers } from '@stubyard/client/users';
import { ErrorBox, useAction, useLoad, usePanel } from '../context';
import { getProject } from '../hub';
import { launchRun } from '../run';
import { defaultOrigin, initialVars, missingInputs, type RunMode, startBody, startChoices } from '../state';
import { Clamp } from '../ui';

/** `mode`: the start button to put first (Home's "Quick" button asks for quick); else the storyboard's preferred one. */
export function StartScreen({ storyboard, mode: askedMode }: { storyboard: string; mode?: RunMode }) {
  const p = usePanel();
  const project = p.project;
  const act = useAction();
  const data = useLoad(
    project
      ? async () => {
          const t = p.target(project);
          const [sb, proj, users] = await Promise.all([getStoryboard(t, storyboard), getProject(t), listUsers(t)]);
          return { sb, proj, users: users.filter((u) => !u.runId) };
        }
      : null,
    [project, storyboard, p.settings.apiUrl],
  );
  const [vars, setVars] = useState<Record<string, string>>({});
  const [actors, setActors] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');

  const sb = data.data?.sb;
  const appOrigins = data.data?.proj.settings.appOrigins ?? [];
  const origins = [...new Set([...(p.origin ? [p.origin] : []), ...appOrigins])];

  useEffect(() => {
    if (!sb) return;
    setVars(initialVars(sb.inputs));
    setOrigin(defaultOrigin(p.origin, appOrigins));
  }, [sb?.id]);

  if (!project) return <p className="muted">Choose a project on Home first.</p>;
  if (data.loading && !sb) return <p className="muted">Loading…</p>;
  if (!sb) return <ErrorBox error={data.error} />;

  const missing = missingInputs(sb.inputs, vars);

  const start = (mode: RunMode) => act.run(mode, () => launchRun(p, project, startBody({ storyboard: sb.slug, origin, label, vars, actors, mode })));

  return (
    <div className="stack">
      <section className="card">
        <button className="link small" onClick={() => p.go({ name: 'home' })}>← Storyboards</button>
        <h2>{sb.name}</h2>
        {sb.description && <Clamp text={sb.description} lines={3} />}
        {sb.intent && <Clamp className="muted" text={sb.intent} lines={2} />}
        <p className="muted small">
          {sb.steps.length} steps · version {sb.version}
        </p>
        {sb.warnings.length > 0 && (
          <ul className="warnings">
            {sb.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        )}
      </section>

      {sb.actors.length > 0 && (
        <section className="card">
          <h3>Actors</h3>
          {sb.actors.map((a) => {
            const candidates = data.data!.users.filter((u) => u.role === a.role);
            return (
              <label key={a.key} className="field">
                <span>
                  {a.label || a.key} <span className="muted">({a.role})</span>
                </span>
                <select value={actors[a.key] ?? ''} onChange={(e) => setActors({ ...actors, [a.key]: e.target.value })}>
                  <option value="">{a.fresh ? 'A new test user (fresh)' : `Default: ${a.user ?? `first user with role ${a.role}`}`}</option>
                  {candidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} {u.email ? `<${u.email}>` : ''}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </section>
      )}

      {sb.inputs.length > 0 && (
        <section className="card">
          <h3>Inputs</h3>
          {sb.inputs.map((i) => (
            <label key={i.name} className="field">
              <span>
                {i.label || i.name}
                {i.required && ' *'}
              </span>
              <input value={vars[i.name] ?? ''} onChange={(e) => setVars({ ...vars, [i.name]: e.target.value })} />
              {i.help && <span className="muted small">{i.help}</span>}
            </label>
          ))}
        </section>
      )}

      <section className="card">
        <label className="field">
          <span>App origin</span>
          <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
            {origins.length === 0 && <option value="">(none)</option>}
            {origins.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Label (optional)</span>
          <input value={label} placeholder="e.g. release 1.4 smoke" onChange={(e) => setLabel(e.target.value)} />
        </label>
      </section>

      <section className="start-choices">
        {missing.length > 0 && <p className="muted">Required: {missing.join(', ')}</p>}
        {startChoices(askedMode ?? sb.preferredMode).map((c) => (
          <div key={c.mode} className="start-choice">
            <button className={c.primary ? 'primary' : ''} disabled={!!act.busy || missing.length > 0} onClick={() => void start(c.mode)}>
              {act.busy === c.mode ? 'Starting…' : c.label}
            </button>
            <span className="muted small">{c.hint}</span>
          </div>
        ))}
        <ErrorBox error={act.error} />
      </section>
    </div>
  );
}

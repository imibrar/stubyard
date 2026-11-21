// Start walkthrough (§6.10.3): storyboard description, actors (fresh / existing, with an override), inputs, origin.
import { useEffect, useState } from 'react';
import { getStoryboard } from '@stubyard/client/storyboards';
import { listUsers } from '@stubyard/client/users';
import { startWalkthrough } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAction, useLoad, usePanel } from '../context';
import { getProject } from '../hub';

export function StartScreen({ storyboard }: { storyboard: string }) {
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
    setVars(Object.fromEntries(sb.inputs.map((i) => [i.name, i.default ?? ''])));
    setOrigin(p.origin && appOrigins.includes(p.origin) ? p.origin : (appOrigins[0] ?? p.origin ?? ''));
  }, [sb?.id]);

  if (!project) return <p className="muted">Choose a project on Home first.</p>;
  if (data.loading && !sb) return <p className="muted">Loading…</p>;
  if (!sb) return <ErrorBox error={data.error} />;

  const missing = sb.inputs.filter((i) => i.required && !vars[i.name]?.trim()).map((i) => i.label || i.name);

  const start = () =>
    act.run('start', async () => {
      const filledVars = Object.fromEntries(Object.entries(vars).filter(([, v]) => v.trim() !== ''));
      const chosenActors = Object.fromEntries(Object.entries(actors).filter(([, v]) => v));
      const w = await startWalkthrough(p.target(project), {
        storyboard: sb.slug,
        origin: origin || undefined,
        label: label.trim() || undefined,
        vars: filledVars,
        actors: chosenActors,
      });
      await p.openWalkthrough({ project, id: w.id });
      if (w.warnings.length) p.notify(w.warnings.join('\n'));
    });

  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <h2>{sb.name}</h2>
          <button className="link" onClick={() => p.go({ name: 'home' })}>Back</button>
        </div>
        {sb.description && <p>{sb.description}</p>}
        {sb.intent && <p className="muted">{sb.intent}</p>}
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
        {missing.length > 0 && <p className="muted">Required: {missing.join(', ')}</p>}
        <button className="primary" disabled={!!act.busy || missing.length > 0} onClick={() => void start()}>
          {act.busy ? 'Starting…' : 'Start walkthrough'}
        </button>
        <ErrorBox error={act.error} />
      </section>
    </div>
  );
}

// Home (§6.10.2): the project for this origin, its active walkthroughs (Resume) and its storyboards (Start).
import { listStoryboards } from '@stubyard/client/storyboards';
import { listWalkthroughs } from '@stubyard/client/walkthroughs';
import type { ProjectMatch } from '../App';
import { ErrorBox, useAction, useLoad, usePanel } from '../context';
import { addAppOrigin } from '../hub';

export function HomeScreen({ match }: { match: ProjectMatch }) {
  const p = usePanel();
  const { project, origin, active } = p;

  return (
    <div className="stack">
      {active && (
        <section className="card">
          <div className="row between">
            <span>
              Walkthrough in progress <span className="chip">{active.project}</span>
            </span>
            <button className="primary" onClick={() => p.go({ name: 'walkthrough' })}>Open</button>
          </div>
        </section>
      )}
      {!origin && <p className="muted">Open your app in this tab first (stubyard works on http and https pages).</p>}
      {origin && <ProjectPicker match={match} />}
      {project && <ProjectHome project={project} />}
    </div>
  );
}

function ProjectPicker({ match }: { match: ProjectMatch }) {
  const p = usePanel();
  const act = useAction();
  if (match.status === 'loading') return <p className="muted">Finding the project for {p.origin}…</p>;
  if (match.status === 'error') return <ErrorBox error={match.error} />;
  if (match.status === 'matched') return null;
  if (match.status === 'many') {
    return (
      <section className="card">
        <h3>Several projects use {p.origin}</h3>
        <ul className="list">
          {match.projects.map((x) => (
            <li key={x.slug} className="row between">
              <span>
                {x.name} <span className="muted">({x.storyboards} storyboards)</span>
              </span>
              <button onClick={() => void p.chooseProject(x.slug)}>Use</button>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (match.status === 'none') {
    return (
      <section className="card">
        <h3>Choose project</h3>
        <p className="muted">No project lists {p.origin} in its App origins.</p>
        <ul className="list">
          {match.projects.map((x) => (
            <li key={x.slug} className="row between">
              <span>{x.name}</span>
              <span className="row">
                <button onClick={() => void p.chooseProject(x.slug)}>Use</button>
                <button
                  disabled={!!act.busy}
                  onClick={() =>
                    void act.run('add', async () => {
                      await addAppOrigin(p.target(x.slug), p.origin!);
                      await p.chooseProject(x.slug);
                      p.notify(`Added ${p.origin} to ${x.name}`);
                    })
                  }
                >
                  Add this origin to project
                </button>
              </span>
            </li>
          ))}
        </ul>
        <ErrorBox error={act.error} />
      </section>
    );
  }
  return null;
}

function ProjectHome({ project }: { project: string }) {
  const p = usePanel();
  const t = p.target(project);
  const walkthroughs = useLoad(() => listWalkthroughs(t, { status: 'active', limit: 20 }), [project, p.settings.apiUrl, p.ticks.walkthrough]);
  const storyboards = useLoad(() => listStoryboards(t), [project, p.settings.apiUrl, p.ticks.storyboards]);

  return (
    <>
      <section className="card">
        <h3>Active walkthroughs</h3>
        <ErrorBox error={walkthroughs.error} />
        {walkthroughs.data?.length === 0 && <p className="muted">None.</p>}
        <ul className="list">
          {walkthroughs.data?.map((w) => {
            const total = w.counts.pending + w.counts.active + w.counts.done + w.counts.skipped + w.counts.failed;
            const finished = w.counts.done + w.counts.skipped + w.counts.failed;
            return (
              <li key={w.id} className="row between">
                <span>
                  {w.storyboard.name} <span className="muted">{w.label || w.key} · {finished}/{total}</span>
                </span>
                <button onClick={() => (p.active?.id === w.id ? p.go({ name: 'walkthrough' }) : void p.openWalkthrough({ project, id: w.id }))}>
                  {p.active?.id === w.id ? 'Open' : 'Resume'}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="card">
        <h3>Storyboards</h3>
        <ErrorBox error={storyboards.error} />
        {storyboards.data?.length === 0 && <p className="muted">This project has no storyboards yet. An agent or the dashboard can write them.</p>}
        <ul className="list">
          {storyboards.data?.map((s) => (
            <li key={s.id} className="row between">
              <span>
                <strong>{s.name}</strong>
                <span className="muted">
                  {' '}
                  · {s.steps} steps
                  {s.lastWalkthrough && ` · last: ${s.lastWalkthrough.verdict ?? s.lastWalkthrough.status}`}
                </span>
                {s.description && <div className="muted small">{s.description}</div>}
              </span>
              <button className="primary" onClick={() => p.go({ name: 'start', storyboard: s.slug })}>Start</button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

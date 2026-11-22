// Home (§6.10.2): the project for this origin, its active walkthroughs (Continue) and its storyboards (open Start,
// or a one-tap quick test).
import { useState } from 'react';
import { listStoryboards } from '@stubyard/client/storyboards';
import type { StoryboardBrief, WalkthroughBrief } from '@stubyard/client/storyboard-types';
import { listWalkthroughs } from '@stubyard/client/walkthroughs';
import type { ProjectMatch } from '../App';
import { ErrorBox, useAction, useLoad, usePanel } from '../context';
import { cleanupEntryLabel } from '../cleanup';
import { addAppOrigin, listCleanup } from '../hub';
import { quickStartOrOpen } from '../run';
import { countProgress, filterStoryboards, groupByFirstTag, isQuickRun, SEARCH_THRESHOLD } from '../state';

export function HomeScreen({ match }: { match: ProjectMatch }) {
  const p = usePanel();
  const { project, origin } = p;

  return (
    <div className="stack">
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
  const walkthroughs = useLoad(() => listWalkthroughs(t, { status: 'active', mode: 'all', limit: 20 }), [project, p.settings.apiUrl, p.ticks.walkthrough]);
  const storyboards = useLoad(() => listStoryboards(t), [project, p.settings.apiUrl, p.ticks.storyboards]);
  // Errors are ignored: an older hub has no cleanup API, and the entry is only a shortcut.
  const cleanup = useLoad(() => listCleanup(t, { status: 'pending' }), [project, p.settings.apiUrl, p.ticks.cleanup]);
  const cleanupLabel = cleanupEntryLabel(cleanup.data?.counts);
  const [query, setQuery] = useState('');
  const act = useAction();

  const all = storyboards.data ?? [];
  const groups = groupByFirstTag(filterStoryboards(all, query));
  const runs = walkthroughs.data ?? [];

  return (
    <>
      <ErrorBox error={walkthroughs.error} />
      {runs.length > 0 && (
        <section>
          <h3 className="section">Continue</h3>
          <ul className="rows">
            {runs.map((w) => (
              <RunRow key={w.id} w={w} project={project} />
            ))}
          </ul>
        </section>
      )}
      {cleanupLabel && (
        <button className="cu-entry" title="Remove the test users and messages finished runs created" onClick={() => p.go({ name: 'cleanup' })}>
          <span>{cleanupLabel}</span>
          <span className="muted small">test data from finished runs ›</span>
        </button>
      )}
      <section>
        <h3 className="section">Storyboards</h3>
        <ErrorBox error={storyboards.error} />
        {storyboards.data?.length === 0 && <p className="muted">This project has no storyboards yet. An agent or the dashboard can write them.</p>}
        {all.length > SEARCH_THRESHOLD && (
          <input className="search" type="search" placeholder="Search storyboards" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        {all.length > 0 && groups.length === 0 && <p className="muted">No storyboard matches “{query}”.</p>}
        {groups.map((g) => (
          <div key={g.tag ?? ''} className="group">
            {(g.tag || groups.length > 1) && <div className="group-head">{g.tag ?? 'Other'}</div>}
            <ul className="rows">
              {g.items.map((s) => (
                <StoryboardRow key={s.id} s={s} busy={act.busy === s.slug} disabled={!!act.busy} quick={() => void act.run(s.slug, () => quickStartOrOpen(p, project, s.slug))} />
              ))}
            </ul>
          </div>
        ))}
        <ErrorBox error={act.error} />
      </section>
    </>
  );
}

function RunRow({ w, project }: { w: WalkthroughBrief; project: string }) {
  const p = usePanel();
  const { finished, total } = countProgress(w.counts);
  const open = () => (p.active?.id === w.id ? p.go({ name: 'walkthrough' }) : void p.openWalkthrough({ project, id: w.id }));
  return (
    <li className="item" title={`${w.storyboard.name}${w.label ? ` · ${w.label}` : ''} · key ${w.key}`}>
      <div className="item-main" onClick={open}>
        <div className="item-name one-line">{w.storyboard.name}</div>
        <div className="item-sub">
          {isQuickRun(w) && <span className="chip">Quick</span>}
          <span className="mini-progress">
            <span style={{ width: `${total ? (finished / total) * 100 : 0}%` }} />
          </span>
          <span>
            {finished}/{total} steps
          </span>
        </div>
      </div>
      <button className="primary" onClick={open}>Continue</button>
    </li>
  );
}

function StoryboardRow({ s, busy, disabled, quick }: { s: StoryboardBrief; busy: boolean; disabled: boolean; quick: () => void }) {
  const p = usePanel();
  return (
    <li className="item" title={s.description || s.name}>
      <div className="item-main" onClick={() => p.go({ name: 'start', storyboard: s.slug })}>
        <div className="item-name two-lines">{s.name}</div>
        <div className="item-sub">
          {s.preferredMode === 'quick' && <span className="chip">Quick</span>}
          <span>
            {s.steps} steps
            {s.lastWalkthrough && ` · last: ${s.lastWalkthrough.verdict ?? s.lastWalkthrough.status}`}
          </span>
        </div>
      </div>
      <button title="Start a quick test (opens Start when something needs choosing)" disabled={disabled} onClick={quick}>
        {busy ? '…' : '▶ Quick'}
      </button>
    </li>
  );
}

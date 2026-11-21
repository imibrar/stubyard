// Connect / Settings (§6.9, §6.10.1): stubyard URL (connection test, host permission when not localhost),
// sign-off name, and the project used for this tab's origin (override, add the origin to a project).
import { useState } from 'react';
import type { ProjectMatch } from '../App';
import { ErrorBox, useAction, useLoad, usePanel } from '../context';
import { addAppOrigin, listProjects, systemInfo } from '../hub';
import { DEFAULT_API_URL, needsHostPermission, normalizeApiUrl } from '../../shared/settings';
import { requestOriginAccess } from '../tabs';

export function SettingsScreen({ match, hubStatus }: { match: ProjectMatch; hubStatus: { ok: boolean; text: string } | null }) {
  const p = usePanel();
  const act = useAction();
  const [url, setUrl] = useState(p.settings.apiUrl);
  const [name, setName] = useState(p.settings.signedOffBy);
  const [pick, setPick] = useState(p.project ?? '');
  const projects = useLoad(() => listProjects(p.settings.apiUrl), [p.settings.apiUrl]);

  const saveUrl = () =>
    act.run('url', async () => {
      const next = normalizeApiUrl(url);
      if (!next) throw new Error('Enter an http(s) URL, e.g. http://localhost:4000');
      // The permission prompt needs the click's user gesture: ask before any await.
      if (needsHostPermission(next) && !(await requestOriginAccess(next))) throw new Error(`Access to ${next} was not granted.`);
      const info = await systemInfo(next);
      await p.updateSettings({ apiUrl: next });
      setUrl(next);
      p.notify(`Connected to stubyard ${info.version}`);
    });

  return (
    <div className="stack">
      <section className="card">
        <h3>stubyard</h3>
        <label className="field">
          <span>URL</span>
          <input value={url} placeholder={DEFAULT_API_URL} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div className="row wrap">
          <button className="primary" disabled={!!act.busy} onClick={() => void saveUrl()}>Save and test</button>
          {hubStatus && <span className={hubStatus.ok ? 'ok small' : 'bad small'}>{hubStatus.text}</span>}
        </div>
        <ErrorBox error={act.error} />
      </section>

      <section className="card">
        <h3>Sign-off name</h3>
        <div className="row">
          <input value={name} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
          <button disabled={name === p.settings.signedOffBy} onClick={() => void p.updateSettings({ signedOffBy: name.trim() })}>Save</button>
        </div>
      </section>

      <section className="card">
        <h3>Project for this page</h3>
        {!p.origin ? (
          <p className="muted">Open your app in this tab first.</p>
        ) : (
          <>
            <p className="muted small">
              {p.origin}: {p.project ? <strong>{p.project}</strong> : match.status === 'loading' ? 'looking…' : 'none chosen'}
              {p.settings.lastProjectByOrigin[p.origin] ? ' (chosen here)' : p.project ? ' (from App origins)' : ''}
            </p>
            <ErrorBox error={projects.error} />
            <div className="row wrap">
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">(choose)</option>
                {projects.data?.map((x) => (
                  <option key={x.slug} value={x.slug}>
                    {x.name}
                  </option>
                ))}
              </select>
              <button disabled={!pick} onClick={() => void p.chooseProject(pick)}>Use for this origin</button>
              <button
                disabled={!pick || !!act.busy}
                onClick={() =>
                  void act.run('origin', async () => {
                    await addAppOrigin(p.target(pick), p.origin!);
                    p.notify(`Added ${p.origin} to the App origins of ${pick}`);
                    projects.reload();
                  })
                }
              >
                Add this origin to project
              </button>
              {p.settings.lastProjectByOrigin[p.origin] && <button onClick={() => void p.chooseProject(null)}>Forget choice</button>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

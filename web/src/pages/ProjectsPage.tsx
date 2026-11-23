import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project } from '../api';
import { DEFAULT_ROLES, Icon, RoleCountsEditor, type RoleCount } from '../components/people';
import { Empty, ErrorBox, Modal, timeAgo } from '../components/ui';
import { useProjects } from '../context';
import { PageHeader } from '../components/layout';

export const DEFAULT_ROLE_COUNTS: RoleCount[] = [
  { role: 'admin', count: 1 },
  { role: 'sales', count: 1 },
  { role: 'support', count: 1 },
  { role: 'customer', count: 7 },
];

export default function ProjectsPage() {
  const { projects, reload, error } = useProjects();
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const [sel, setSel] = useState<string | null>(null);
  const selected = projects?.find((p) => p.id === sel) ?? projects?.[0];
  return (
    <>
      <PageHeader
        title="Projects"
        meta={projects ? <span className="small muted">{plural(projects.length, 'project')}</span> : undefined}
        description="Each project is a full test workspace for one app: test users, email, SMS, WhatsApp, webhooks and mocks."
        primary={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New project
          </button>
        }
      />
      <ErrorBox error={error} />
      {projects && projects.length === 0 && (
        <div className="card">
          <Empty title="No projects yet">
            <p>Create a project for each app you test, e.g. Hyper, Mkhdoom or Fleet.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              Create your first project
            </button>
          </Empty>
        </div>
      )}
      {projects && projects.length > 0 && (
        <div className="projects-layout">
          <div className="card projects-card">
            <div className="table-wrap">
              <table className="projects-table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col" className="col-sm">
                      Description
                    </th>
                    <th scope="col" className="align-end">
                      Users
                    </th>
                    <th scope="col" className="align-end col-sm">
                      Providers
                    </th>
                    <th scope="col" className="align-end col-sm">
                      Messages
                    </th>
                    <th scope="col" className="align-end">
                      Unread
                    </th>
                    <th scope="col" className="align-end col-sm">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr
                      key={p.id}
                      className={`clickable ${selected?.id === p.id ? 'selected' : ''}`}
                      tabIndex={0}
                      onClick={() => nav(`/p/${p.slug}`)}
                      onFocus={() => setSel(p.id)}
                      onMouseEnter={() => setSel(p.id)}
                      onKeyDown={(e) => e.key === 'Enter' && nav(`/p/${p.slug}`)}
                    >
                      <td>
                        <div className="row nowrap">
                          <span className="ps-mark" aria-hidden>
                            {p.name.slice(0, 1).toUpperCase()}
                          </span>
                          <Link to={`/p/${p.slug}`} className="project-name" onClick={(e) => e.stopPropagation()}>
                            {p.name}
                          </Link>
                          <code>{p.slug}</code>
                        </div>
                      </td>
                      <td className="col-sm muted project-desc">
                        <div className="ellipsis">{p.description || <span className="faint">—</span>}</div>
                      </td>
                      <td className="align-end mono">{p.stats?.users ?? 0}</td>
                      <td className="align-end mono col-sm">{p.stats?.providers ?? 0}</td>
                      <td className="align-end mono col-sm">{p.stats?.messages ?? 0}</td>
                      <td className="align-end">{p.stats?.unread ? <span className="count">{p.stats.unread}</span> : <span className="faint">0</span>}</td>
                      <td className="align-end muted col-sm nowrap-cell">{timeAgo(p.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {selected && (
            <aside className="card project-summary" aria-label="Project summary">
              <div className="card-head">
                <h2 className="ellipsis">{selected.name}</h2>
                <code>{selected.slug}</code>
              </div>
              <div className="card-pad stack">
                {selected.description && <p className="muted small project-summary-desc">{selected.description}</p>}
                <dl className="kv bare">
                  <dt>Users</dt>
                  <dd className="mono">{selected.stats?.users ?? 0}</dd>
                  <dt>Providers</dt>
                  <dd className="mono">{selected.stats?.providers ?? 0}</dd>
                  <dt>Messages</dt>
                  <dd className="mono">{selected.stats?.messages ?? 0}</dd>
                  <dt>Unread</dt>
                  <dd className="mono">{selected.stats?.unread ?? 0}</dd>
                  <dt>Updated</dt>
                  <dd>{timeAgo(selected.updatedAt)}</dd>
                </dl>
                <div className="row">
                  <Link to={`/p/${selected.slug}`} className="btn sm primary">
                    Open
                  </Link>
                  <Link to={`/p/${selected.slug}/setup`} className="btn sm">
                    Connect
                  </Link>
                  <Link to={`/p/${selected.slug}/settings`} className="btn sm ghost">
                    Settings
                  </Link>
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
      {creating && <NewProjectModal onClose={() => setCreating(false)} onCreated={reload} />}
    </>
  );
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [generate, setGenerate] = useState(true);
  const [roles, setRoles] = useState<RoleCount[]>(DEFAULT_ROLE_COUNTS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.post<Project>('/api/projects', {
        name,
        slug: slug || undefined,
        settings: { roles: roles.map((r) => r.role).filter(Boolean) },
        generateUsers: generate ? { roles: roles.filter((r) => r.role && r.count > 0) } : undefined,
      });
      onCreated();
      onClose();
      nav(`/p/${p.slug}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={submit}>
            Create project
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Hyper" />
          </label>
          <label className="field">
            Slug <span className="hint">URLs and SMTP username</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={autoSlug || 'hyper'} />
          </label>
        </div>
        <label className="row">
          <input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} /> Generate test users
        </label>
        {generate && <RoleCountsEditor value={roles} onChange={setRoles} suggestions={DEFAULT_ROLES} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

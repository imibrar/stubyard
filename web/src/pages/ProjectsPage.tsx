import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project } from '../api';
import { DEFAULT_ROLES, Icon, RoleCountsEditor, type RoleCount } from '../components/people';
import { Empty, ErrorBox, Modal, timeAgo } from '../components/ui';
import { useProjects } from '../context';

export const DEFAULT_ROLE_COUNTS: RoleCount[] = [
  { role: 'admin', count: 1 },
  { role: 'sales', count: 1 },
  { role: 'support', count: 1 },
  { role: 'customer', count: 7 },
];

export default function ProjectsPage() {
  const { projects, reload, error } = useProjects();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Each project is a full test workspace for one app: test users, email, SMS, WhatsApp, webhooks and mocks.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New project
        </button>
      </div>
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
        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.id} to={`/p/${p.slug}`} className="card project-card">
              <div className="project-card-head">
                <span className="project-mark" aria-hidden>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="grow">
                  <h2 className="ellipsis">{p.name}</h2>
                  <div className="row nowrap small">
                    <code>{p.slug}</code>
                    <span className="faint ellipsis">updated {timeAgo(p.updatedAt)}</span>
                  </div>
                </div>
                {!!p.stats?.unread && (
                  <span className="badge accent" title={`${p.stats.unread} unread messages`}>
                    {p.stats.unread} unread
                  </span>
                )}
              </div>
              <p className="project-desc">{p.description || <span className="faint">No description</span>}</p>
              <dl className="project-stats">
                <div>
                  <dt>Users</dt>
                  <dd>{p.stats?.users ?? 0}</dd>
                </div>
                <div>
                  <dt>Providers</dt>
                  <dd>{p.stats?.providers ?? 0}</dd>
                </div>
                <div>
                  <dt>Messages</dt>
                  <dd>{p.stats?.messages ?? 0}</dd>
                </div>
              </dl>
            </Link>
          ))}
          <button type="button" className="project-card project-new" onClick={() => setCreating(true)}>
            <span className="project-new-icon" aria-hidden>
              <Icon name="plus" size={20} />
            </span>
            <span className="project-new-title">New project</span>
            <span className="faint small">A workspace for one app: users, inboxes, providers</span>
          </button>
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


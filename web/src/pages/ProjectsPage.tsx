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
      <div className="grid grid-cards">
        {projects?.map((p) => (
          <Link key={p.id} to={`/p/${p.slug}`} className="card pin-card">
            <div className="row nowrap">
              <Icon name="folder" />
              <h2 className="grow ellipsis">{p.name}</h2>
              {!!p.stats?.unread && <span className="count">{p.stats.unread}</span>}
            </div>
            <div className="row small">
              <code>{p.slug}</code>
              <span className="faint">updated {timeAgo(p.updatedAt)}</span>
            </div>
            {p.description && <p className="muted small" style={{ margin: 0 }}>{p.description}</p>}
            <div className="row small muted">
              <span>{plural(p.stats?.users ?? 0, 'user')}</span>·<span>{plural(p.stats?.providers ?? 0, 'provider')}</span>·
              <span>{plural(p.stats?.messages ?? 0, 'message')}</span>
            </div>
          </Link>
        ))}
      </div>
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

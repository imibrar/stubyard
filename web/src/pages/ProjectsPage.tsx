import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Project } from '../api';
import { DEFAULT_ROLES, Icon, RoleCountsEditor, type IconName, type RoleCount } from '../components/people';
import { PageHeader, useMediaQuery } from '../components/layout';
import { ListPane } from '../components/shell/panes';
import { onListKeys } from '../components/shell/UsersPane';
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
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const wide = useMediaQuery('(width >= 1024px)');
  const selected = projects?.find((p) => p.slug === params.get('project')) ?? projects?.[0] ?? null;
  const select = (p: Project) => setParams({ project: p.slug }, { replace: true });
  const open = (p: Project) => nav(`/p/${p.slug}`);

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project is a full test workspace for one app: test users, email, SMS, WhatsApp, webhooks and mocks."
        primary={
          <button className="btn sm primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New project
          </button>
        }
      />
      <ErrorBox error={error} />
      {projects && projects.length > 0 && (
        <ListPane title="Projects" count={projects.length} narrow="inline">
          <div className="lrows" onKeyDown={onListKeys}>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`lrow ${wide && selected?.id === p.id ? 'active' : ''} ${p.stats?.unread ? 'unread' : ''}`}
                aria-current={wide && selected?.id === p.id ? 'true' : undefined}
                onClick={() => (wide ? select(p) : open(p))}
                onDoubleClick={() => open(p)}
                onKeyDown={(e) => e.key === 'Enter' && wide && (e.preventDefault(), open(p))}
                title={wide ? 'Click to preview, double-click or Enter to open' : `Open ${p.name}`}
              >
                <span className="lrow-lead">
                  <span className="lrow-icon">
                    <Icon name="folder" size={15} />
                  </span>
                </span>
                <span className="lrow-title">
                  <span className="t">{p.name}</span>
                </span>
                <span className="lrow-meta">{timeAgo(p.updatedAt)}</span>
                <span className="lrow-sub">
                  <code>{p.slug}</code>
                  <span className="ellipsis">
                    {plural(p.stats?.users ?? 0, 'user')} · {plural(p.stats?.messages ?? 0, 'message')}
                  </span>
                </span>
                <span className="lrow-end">{!!p.stats?.unread && <span className="count">{p.stats.unread}</span>}</span>
              </button>
            ))}
          </div>
        </ListPane>
      )}
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
      {wide && selected && <ProjectPreview p={selected} />}
      {creating && <NewProjectModal onClose={() => setCreating(false)} onCreated={reload} />}
    </>
  );
}

/** Selected project in the detail pane: stats and quick links, so a project can be checked before opening it. */
function ProjectPreview({ p }: { p: Project }) {
  const base = `/p/${p.slug}`;
  const stats: [string, number][] = [
    ['Users', p.stats?.users ?? 0],
    ['Providers', p.stats?.providers ?? 0],
    ['Messages', p.stats?.messages ?? 0],
    ['Unread', p.stats?.unread ?? 0],
  ];
  return (
    <section className="project-preview" aria-label={`Project ${p.name}`}>
      <div className="project-preview-head">
        <span className="lrow-icon lg">
          <Icon name="folder" size={20} />
        </span>
        <div className="grow">
          <h2>{p.name}</h2>
          <div className="row small muted" style={{ gap: 6 }}>
            <code>{p.slug}</code>
            <span>updated {timeAgo(p.updatedAt)}</span>
          </div>
        </div>
        <Link to={base} className="btn primary">
          Open project <Icon name="chevron" size={14} />
        </Link>
      </div>
      {p.description && <p className="muted project-preview-desc">{p.description}</p>}
      <dl className="stat-row">
        {stats.map(([k, v]) => (
          <div key={k} className="stat">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="section-title">Jump to</div>
      <div className="quick-links">
        {[
          ['users', 'Users and inboxes', 'users'],
          ['plug', 'Providers', 'providers'],
          ['code', 'Connect your app', 'setup'],
          ['activity', 'Traffic log', 'traffic'],
          ['settings', 'Settings', 'settings'],
        ].map(([icon, label, path]) => (
          <Link key={path} to={`${base}/${path}`} className="quick-link">
            <Icon name={icon as IconName} size={15} /> {label}
          </Link>
        ))}
      </div>
    </section>
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

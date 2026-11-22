import { useMemo, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, type Overview, type SetupGuide } from '../api';
import { AuthenticatorsTab } from '../components/Authenticators';
import { DEFAULT_ROLES, Icon } from '../components/people';
import { Shell } from '../components/Shell';
import { TrafficLog } from '../components/TrafficLog';
import { ProjectMaintenance } from '../components/ProjectMaintenance';
import { DoctorPanel } from '../components/Doctor';
import { providersPath } from '../components/providerLayout';
import MocksPage from './MocksPage';
import LlmMocksPage from './LlmMocksPage';
import WebhooksPage from './WebhooksPage';
import AutoRepliesPage from './AutoRepliesPage';
import StoryboardsPage from './StoryboardsPage';
import PushPage from './PushPage';
import RunsPage from './RunsPage';
import StoragePage from './StoragePage';
import McpTesterPage from './McpTesterPage';
import ChatPage from './ChatPage';
import ScheduledPage from './ScheduledPage';
import PaymentsPage from './PaymentsPage';
import ProvidersPage, { categoryOfSection } from './ProvidersPage';
import { CodeBlock, Empty, ErrorBox, Modal, useToast } from '../components/ui';
import { ProjectProvider, useProject, useProjects, type ProjectState } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import ProjectHome from './ProjectHome';
import UserWorkspace from './UserWorkspace';
import { ContentChecksCard } from '../components/Lint';
import { PageHeader, SettingsLayout, useQueryTab, type Crumb, type PageHeaderProps } from '../components/layout';
import { findNavItem, projectPath, SETTINGS_TABS } from '../nav';
import { TimeOffsetsCard } from '../components/TimeOffsets';

/** /p/:slug/* — loads the project once and provides it to the shell (sidebar) and all project pages. */
export default function ProjectPage() {
  const { slug = '' } = useParams();
  const ov = useFetch<Overview>(`/api/projects/${slug}/overview`, [slug]);
  const reload = useDebounced(() => void ov.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type !== 'log.created' && e.type !== 'log.updated') reload();
  });

  const data = ov.data?.project.slug === slug ? ov.data : null;
  const state = useMemo<ProjectState | null>(() => (data ? { slug, overview: data, reload: () => void ov.reload() } : null), [data, slug, ov.reload]);

  return (
    <ProjectProvider value={state}>
      <Shell>
        {ov.error && !data ? (
          <div className="card">
            <Empty title="Project not available">
              <p className="muted">{ov.error}</p>
              <Link to="/" className="btn">
                All projects
              </Link>
            </Empty>
          </div>
        ) : !state ? (
          <p className="muted">Loading…</p>
        ) : (
          <Routes>
            <Route index element={<ProjectHome />} />
            {/* Users nav item: the users table lives on the project home. */}
            <Route path="users" element={<ProjectHome />} />
            <Route path="users/:userId" element={<UserWorkspace />} />
            <Route path="unassigned" element={<UserWorkspace unassigned />} />
            <Route
              path="traffic"
              element={
                <Page title="Traffic log" description="Every request and SMTP transaction for this project, live. Click a row for headers, bodies and the SMTP transcript.">
                  <div className="card">
                    <TrafficLog project={slug} />
                  </div>
                </Page>
              }
            />
            <Route path="providers/*" element={<ProvidersPage />} />
            <Route path="mocks" element={<MocksPage />} />
            <Route path="llm/*" element={<LlmMocksPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="auto-replies" element={<AutoRepliesPage />} />
            <Route path="storyboards/*" element={<StoryboardsPage />} />
            <Route path="push/*" element={<PushPage />} />
            <Route path="scheduled" element={<ScheduledPage />} />
            <Route path="payments/*" element={<PaymentsPage />} />
            <Route path="runs/*" element={<RunsPage />} />
            <Route path="storage" element={<StoragePage />} />
            <Route path="mcp-tester" element={<McpTesterPage />} />
            <Route path="chat/*" element={<ChatPage />} />
            <Route
              path="authenticator"
              element={
                <AuthenticatorsTab
                  slug={slug}
                  users={state.overview.users}
                  frame={(actions, body) => (
                    <Page title="Authenticator" description="Live 2FA (TOTP) codes for your test accounts, like Google Authenticator." actions={actions}>
                      {body}
                    </Page>
                  )}
                />
              }
            />
            <Route path="setup" element={<SetupTab />} />
            <Route path="settings" element={<SettingsTab />} />
            <Route path="*" element={<Empty title="Page not found" />} />
          </Routes>
        )}
      </Shell>
    </ProjectProvider>
  );
}

/**
 * Page frame of every project section: a thin wrapper around PageHeader (breadcrumb project / section / title) so
 * existing callers keep compiling. New props (primary, secondary, more, meta, tabs, toolbar) go straight to PageHeader.
 */
export function Page({ title, description, actions, children, ...header }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode } & Omit<PageHeaderProps, 'title' | 'description' | 'actions' | 'crumbs'>) {
  const { overview, slug } = useProject();
  const location = useLocation();
  const section = findNavItem(location.pathname.replace(new RegExp(`^/p/${slug}/?`), ''))?.item;
  const crumbs: Crumb[] = [{ label: overview.project.name, to: `/p/${slug}` }];
  if (section && section.path && typeof title === 'string' && section.label !== title) crumbs.push({ label: section.label, to: projectPath(slug, section.path) });
  crumbs.push({ label: title });
  return (
    <>
      <PageHeader title={title} crumbs={crumbs} description={description} actions={actions} {...header} />
      {children}
    </>
  );
}

// ---------------- Setup ----------------

function SetupTab() {
  const { slug } = useProject();
  const guide = useFetch<SetupGuide>(`/api/projects/${slug}/setup`, [slug]);
  return (
    <Page title="Connect your app" description="Copy-paste settings for your app's email, SMS and WhatsApp providers.">
      <SetupBody slug={slug} guide={guide.data} error={guide.error} />
      <DoctorPanel slug={slug} />
    </Page>
  );
}

function SetupBody({ slug, guide: data, error }: { slug: string; guide: SetupGuide | null; error: string | null }) {
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const guide = { data };
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h2>Where does your app run?</h2>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App location</th>
              <th>Host to use</th>
              <th>HTTPS base</th>
            </tr>
          </thead>
          <tbody>
            {guide.data.hosts.map((h) => (
              <tr key={h.id}>
                <td>{h.label}</td>
                <td>
                  <code>{h.host}</code>
                </td>
                <td>
                  <code>{h.https}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          The snippets below use <code>localhost</code>; replace it with the host for your setup. For HTTPS, trust the stubyard CA once (see{' '}
          <Link to="/https">HTTPS setup</Link>).
        </p>
      </div>
      {guide.data.sections.map((s) => {
        const category = s.instance ? categoryOfSection(s.id) : null;
        return (
        <div key={s.id} className="card card-pad stack">
          <div className="row nowrap" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div className="grow">
              <h2>{s.title}</h2>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                {s.description}
              </p>
            </div>
            {category && (
              <Link to={providersPath(slug, category, s.instance)} className="btn sm ghost" title="Settings, failure rules and status callbacks of this provider">
                <Icon name="plug" size={13} /> Provider
              </Link>
            )}
          </div>
          <div className="grid-snippets">
            {s.snippets.map((sn) => (
              <CodeBlock key={sn.title} title={sn.title} code={sn.code} />
            ))}
          </div>
        </div>
        );
      })}
    </div>
  );
}

// ---------------- Settings ----------------

function SettingsTab() {
  const { overview, reload } = useProject();
  const { reload: onChanged } = useProjects();
  const { project, stats } = overview;
  const nav = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    otpRegex: project.settings.otpRegex ?? '',
    phonePrefix: project.settings.phonePrefix ?? '',
    emailDomain: project.settings.emailDomain ?? '',
    defaultPassword: project.settings.defaultPassword ?? '',
    roles: (project.settings.roles ?? []).join(', '),
    appOrigins: (project.settings.appOrigins ?? []).join('\n'),
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setError(null);
    try {
      await api.patch(`/api/projects/${project.slug}`, {
        name: form.name,
        description: form.description,
        settings: {
          otpRegex: form.otpRegex || undefined,
          phonePrefix: form.phonePrefix || undefined,
          emailDomain: form.emailDomain || undefined,
          defaultPassword: form.defaultPassword || undefined,
          roles: form.roles.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean),
          appOrigins: form.appOrigins.split(/[\s,]+/).map((o) => o.trim()).filter(Boolean),
        },
      });
      toast('Settings saved');
      reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const reset = async () => {
    if (!confirm(`Delete all ${stats.messages} messages and ${stats.logs} log entries of "${project.name}"? Test users and providers are kept.`)) return;
    const r = await api.post<{ messages: number; logs: number }>(`/api/projects/${project.slug}/reset`);
    toast(`Removed ${r.messages} messages and ${r.logs} log entries`);
    reload();
    onChanged();
  };
  const remove = async () => {
    await api.del(`/api/projects/${project.slug}`);
    onChanged();
    nav('/');
  };

  const [tab, setTab] = useQueryTab(SETTINGS_TABS);

  return (
    <Page title="Settings" description="Project details, test-data defaults, data retention, checks and clean-up.">
    <SettingsLayout sections={SETTINGS_TABS.map((t) => ({ ...t, danger: t.id === 'danger' }))} value={tab} onChange={setTab} label="Settings sections">
      {tab === 'general' && (
      <div className="card card-pad form">
        <h2>Project</h2>
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            Slug <span className="hint">Cannot be changed</span>
            <input value={project.slug} disabled />
          </label>
        </div>
        <label className="field">
          Description
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <label className="field">
          OTP regex <span className="hint">Optional. First capture group is the code. Defaults detect 4–8 digit codes.</span>
          <input className="mono" value={form.otpRegex} onChange={(e) => setForm({ ...form, otpRegex: e.target.value })} placeholder="code[:\s]+(\d{6})" />
        </label>
        <div className="form form-2">
          <label className="field">
            Phone prefix for generated users
            <input value={form.phonePrefix} onChange={(e) => setForm({ ...form, phonePrefix: e.target.value })} placeholder="+92300" />
          </label>
          <label className="field">
            Email domain for generated users
            <input value={form.emailDomain} onChange={(e) => setForm({ ...form, emailDomain: e.target.value })} placeholder={`${project.slug}.test`} />
          </label>
        </div>
        <div className="form form-2">
          <label className="field">
            Default test password <span className="hint">Shown on users without their own password</span>
            <input value={form.defaultPassword} onChange={(e) => setForm({ ...form, defaultPassword: e.target.value })} placeholder="Password123!" />
          </label>
          <label className="field">
            Roles <span className="hint">Comma-separated, offered when adding users</span>
            <input value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} placeholder={DEFAULT_ROLES.join(', ')} />
          </label>
        </div>
        <label className="field">
          <span className="field-label">
            App origins <span className="hint">One per line (or comma-separated); the browser extension finds this project by them</span>
          </span>
          <textarea className="mono" rows={2} value={form.appOrigins} onChange={(e) => setForm({ ...form, appOrigins: e.target.value })} placeholder={'http://localhost:3000\nhttps://staging.example.test'} />
        </label>
        <div className="row">
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
      )}
      {tab === 'data' && <ProjectMaintenance parts={['retention', 'export']} />}
      {tab === 'checks' && (
        <>
          <ContentChecksCard />
          <TimeOffsetsCard />
          <ProjectMaintenance parts={['rules']} />
        </>
      )}
      {tab === 'danger' && (
      <div className="card card-pad stack section-danger">
        <h2>Danger zone</h2>
        <div className="row">
          <div className="grow">
            <h3>Reset project data</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Deletes {stats.messages} messages (and their emails) and {stats.logs} log entries. Keeps test users, providers and settings.
            </p>
          </div>
          <button className="btn" onClick={reset}>
            Reset data
          </button>
        </div>
        <div className="row">
          <div className="grow">
            <h3>Delete project</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Removes the project and everything in it.
            </p>
          </div>
          <button className="btn danger" onClick={() => setConfirmDelete(true)}>
            Delete project
          </button>
        </div>
      </div>
      )}
      {confirmDelete && (
        <Modal
          title={`Delete "${project.name}"?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="btn primary" style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }} onClick={remove}>
                Delete permanently
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This deletes {stats.users} test users, {stats.providers} providers, {stats.messages} messages and {stats.logs} log entries. It cannot be undone.
          </p>
        </Modal>
      )}
    </SettingsLayout>
    </Page>
  );
}

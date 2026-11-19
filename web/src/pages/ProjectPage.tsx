import { useMemo, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, type Channel, type ConfigField, type Overview, type Preset, type ProviderInstance, type SetupGuide, type SystemInfo } from '../api';
import { RulesPanel } from '../components/Rules';
import { AuthenticatorsTab } from '../components/Authenticators';
import { DEFAULT_ROLES, Icon } from '../components/people';
import { Shell } from '../components/Shell';
import { TrafficLog } from '../components/TrafficLog';
import { ProjectMaintenance } from '../components/ProjectMaintenance';
import { DoctorPanel } from '../components/Doctor';
import { LoginProviders } from '../components/LoginProviders';
import MocksPage from './MocksPage';
import WebhooksPage from './WebhooksPage';
import RunsPage from './RunsPage';
import StoragePage from './StoragePage';
import { Badge, CHANNEL_LABEL, ChannelIcon, CodeBlock, Empty, ErrorBox, Modal, useCopy, useToast } from '../components/ui';
import { ProjectProvider, useProject, useProjects, type ProjectState } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import ProjectHome from './ProjectHome';
import UserWorkspace from './UserWorkspace';

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
            <Route path="providers" element={<ProvidersTab />} />
            <Route path="mocks" element={<MocksPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="runs/*" element={<RunsPage />} />
            <Route path="storage" element={<StoragePage />} />
            <Route
              path="authenticator"
              element={
                <Page title="Authenticator" description="Live 2FA (TOTP) codes for your test accounts, like Google Authenticator.">
                  <AuthenticatorsTab slug={slug} users={state.overview.users} />
                </Page>
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

export function Page({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { overview, slug } = useProject();
  return (
    <>
      <div className="crumbs">
        <Link to={`/p/${slug}`}>{overview.project.name}</Link>
        <span>/</span>
        <span>{title}</span>
      </div>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </>
  );
}

// ---------------- Providers ----------------

function ProvidersTab() {
  const { slug, overview, reload } = useProject();
  const providers = overview.providers;
  const sys = useFetch<SystemInfo>('/api/system');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const presets = sys.data?.presets ?? [];
  const byChannel: Record<Channel, ProviderInstance[]> = { email: [], sms: [], whatsapp: [] };
  for (const p of providers) byChannel[p.channel].push(p);

  return (
    <Page
      title="Providers"
      description="One instance per provider account your app uses (primary, fallback, marketing…). Point the SDK at the instance URL; each instance has its own settings and failure rules."
      actions={
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Add provider
        </button>
      }
    >
      <div className="stack">
        {(['email', 'sms', 'whatsapp'] as Channel[]).map((c) => (
          <div key={c} className="card">
            <div className="card-head">
              <h3 className="row">
                <ChannelIcon channel={c} /> {CHANNEL_LABEL[c]}
              </h3>
            </div>
            {byChannel[c].length === 0 ? (
              <p className="muted small" style={{ padding: '12px 16px', margin: 0 }}>
                No {CHANNEL_LABEL[c]} provider yet.
                {c !== 'email' && ' Add Twilio, Vonage, Meta WhatsApp or a Generic API to start sending to test users.'}
              </p>
            ) : (
              byChannel[c].map((p) => (
                <ProviderItem
                  key={p.id}
                  slug={slug}
                  p={p}
                  preset={presets.find((x) => x.id === p.preset)}
                  reload={reload}
                  open={open === p.id}
                  onToggle={() => setOpen(open === p.id ? null : p.id)}
                />
              ))
            )}
          </div>
        ))}
        <LoginProviders slug={slug} users={overview.users} />
        {adding && <AddProviderModal slug={slug} presets={presets} labels={sys.data?.labels ?? []} onClose={() => setAdding(false)} onDone={reload} />}
      </div>
    </Page>
  );
}

function ProviderItem({ slug, p, preset, reload, open, onToggle }: { slug: string; p: ProviderInstance; preset?: Preset; reload: () => void; open: boolean; onToggle: () => void }) {
  const toast = useToast();
  const { system } = useProjects();
  const { overview } = useProject();
  const copy = useCopy();
  const patch = async (b: Partial<ProviderInstance>) => {
    await api.patch(`/api/projects/${slug}/providers/${p.slug}`, b);
    reload();
  };
  const remove = async () => {
    if (!confirm(`Delete provider instance "${p.name}"?`)) return;
    await api.del(`/api/projects/${slug}/providers/${p.slug}`);
    toast('Provider deleted');
    reload();
  };
  const smtp = p.preset === 'smtp';
  const url = smtp
    ? `smtp://${p.isDefault ? slug : `${slug}.${p.slug}`}@localhost:${system?.ports.smtp ?? 1025}`
    : `https://localhost:${system?.ports.https ?? 4443}/mock/${slug}/${p.slug}`;
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="row nowrap list-row" style={{ padding: '10px 14px' }}>
        <button className="btn xs ghost" onClick={onToggle} aria-expanded={open} aria-label="Details">
          {open ? '▾' : '▸'}
        </button>
        <div style={{ minWidth: 180 }}>
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <code className="faint">{p.slug}</code>
        </div>
        <div className="row grow row-meta">
          <Badge>{preset?.name ?? p.preset}</Badge>
          {p.isDefault && <Badge kind="accent">default</Badge>}
          {p.labels.map((l) => (
            <Badge key={l}>{l}</Badge>
          ))}
          {preset && !preset.available && <Badge kind="warn">coming soon</Badge>}
          {!p.enabled && <Badge kind="bad">disabled (503)</Badge>}
          <button className="cred" style={{ cursor: 'copy' }} onClick={() => copy(url, 'URL copied')} title="Copy">
            <span className="ellipsis" style={{ maxWidth: 360 }}>{url}</span>
            <Icon name="copy" size={12} />
          </button>
        </div>
        <div className="row-actions">
          {!p.isDefault && (
            <button className="btn sm ghost" onClick={() => patch({ isDefault: true })}>
              Make default
            </button>
          )}
          <button className="btn sm ghost" onClick={() => patch({ enabled: !p.enabled })}>
            {p.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
      {open && (
        <div className="panel-pair">
          <ProviderConfig slug={slug} p={p} reload={reload} />
          <RulesPanel slug={slug} scope="instance" ownerRef={p.slug} providers={overview.providers} title={`Rules for ${p.slug} (everyone)`} />
        </div>
      )}
    </div>
  );
}

function ProviderConfig({ slug, p, reload }: { slug: string; p: ProviderInstance; reload: () => void }) {
  const fields = useFetch<ConfigField[]>(`/api/presets/${p.preset}/fields`, [p.preset]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(p.config).map(([k, v]) => [k, String(v ?? '')])));
  const [labels, setLabels] = useState(p.labels.join(', '));
  const toast = useToast();
  const save = async () => {
    try {
      const config: Record<string, string | null> = {};
      for (const f of fields.data ?? []) config[f.key] = values[f.key]?.trim() ? values[f.key].trim() : null;
      await api.patch(`/api/projects/${slug}/providers/${p.slug}`, { config, labels: labels.split(',').map((l) => l.trim()).filter(Boolean) });
      toast('Provider settings saved');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Settings</h3>
        <button className="btn sm primary" onClick={save}>
          Save
        </button>
      </div>
      <div className="card-pad form">
        <label className="field">
          Labels <span className="hint">primary, fallback, transactional, marketing… ("marketing" enforces DND opt-outs)</span>
          <input value={labels} onChange={(e) => setLabels(e.target.value)} />
        </label>
        {p.preset === 'smtp' && <p className="small faint" style={{ margin: 0 }}>SMTP needs no settings. Use the username shown in the URL; any password works.</p>}
        {(fields.data ?? []).map((f) => (
          <label key={f.key} className="field">
            {f.label} {f.hint && <span className="hint">{f.hint}</span>}
            {f.multiline ? (
              <textarea className="mono" rows={3} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input type={f.secret ? 'password' : 'text'} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

function AddProviderModal({ slug, presets, labels, onClose, onDone }: { slug: string; presets: Preset[]; labels: string[]; onClose: () => void; onDone: () => void }) {
  const [preset, setPreset] = useState(presets[0]?.id ?? 'smtp');
  const [name, setName] = useState('');
  const [instSlug, setInstSlug] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const p = presets.find((x) => x.id === preset);
  const save = async () => {
    try {
      await api.post(`/api/projects/${slug}/providers`, { preset, name: name || undefined, slug: instSlug || undefined, labels: chosen });
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title="Add provider instance"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Add
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Provider
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {(['email', 'sms', 'whatsapp'] as Channel[]).map((c) => (
              <optgroup key={c} label={CHANNEL_LABEL[c]}>
                {presets
                  .filter((x) => x.channel === c)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.available ? '' : ' (coming soon)'}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          {p && <span className="hint">{p.description}</span>}
        </label>
        <div className="form form-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={p?.name} />
          </label>
          <label className="field">
            Slug <span className="hint">Part of the URL / SMTP username</span>
            <input value={instSlug} onChange={(e) => setInstSlug(e.target.value)} placeholder="sms-primary" />
          </label>
        </div>
        <div className="field">
          Labels
          <div className="row">
            {labels.map((l) => (
              <label key={l} className="row" style={{ gap: 4, fontWeight: 400, color: 'var(--text)' }}>
                <input type="checkbox" checked={chosen.includes(l)} onChange={(e) => setChosen(e.target.checked ? [...chosen, l] : chosen.filter((x) => x !== l))} />
                {l}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- Setup ----------------

function SetupTab() {
  const { slug } = useProject();
  const guide = useFetch<SetupGuide>(`/api/projects/${slug}/setup`, [slug]);
  return (
    <Page title="Connect your app" description="Copy-paste settings for your app's email, SMS and WhatsApp providers.">
      <SetupBody guide={guide.data} error={guide.error} />
      <DoctorPanel slug={slug} />
    </Page>
  );
}

function SetupBody({ guide: data, error }: { guide: SetupGuide | null; error: string | null }) {
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
          The snippets below use <code>localhost</code>; replace it with the host for your setup. For HTTPS, trust the devhub CA once (see{' '}
          <Link to="/https">HTTPS setup</Link>).
        </p>
      </div>
      {guide.data.sections.map((s) => (
        <div key={s.id} className="card card-pad stack">
          <div>
            <h2>{s.title}</h2>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {s.description}
            </p>
          </div>
          <div className="grid-snippets">
            {s.snippets.map((sn) => (
              <CodeBlock key={sn.title} title={sn.title} code={sn.code} />
            ))}
          </div>
        </div>
      ))}
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

  return (
    <Page title="Settings" description="Project details, test-data defaults and clean-up.">
    <div className="cards-flow">
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
        <div className="row">
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
      <div className="stack" style={{ gap: 16 }}>
      <ProjectMaintenance />
      <div className="card card-pad stack">
        <h2>Clean up</h2>
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
      </div>
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
    </div>
    </Page>
  );
}

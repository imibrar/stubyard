import { useState, type ComponentType, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, type Channel, type ConfigField, type LoginProvider, type Overview, type Preset, type ProviderInstance, type SetupGuide, type SystemInfo } from '../api';
import { RulesPanel } from '../components/Rules';
import { Icon } from '../components/people';
import { createLoginProvider, LoginProviderDetail, LoginProviderRow, OIDC_FLAVORS, useLoginProviders } from '../components/LoginProviders';
import { createPaymentProvider, PaymentAddFields, PaymentsCategory, usePaymentInstances, type PaymentsData } from '../components/PaymentProviders';
import { LLM_CATEGORY } from '../components/LlmProviders';
import { CopyUrl, DetailHead, InstanceRow, providersPath, SectionTabs, useSection } from '../components/providerLayout';
import { Badge, ChannelIcon, CodeBlock, Empty, ErrorBox, Modal, useToast } from '../components/ui';
import { useProject, useProjects } from '../context';
import { useFetch } from '../hooks';
import { Page } from './ProjectPage';
import '../styles/providers.css';

// ---------------- category registry ----------------

/** What every category sees: project data plus the shared preset / login lists. */
export interface ProvidersData {
  slug: string;
  overview: Overview;
  reload: () => void;
  presets: Preset[];
  labels: string[];
  login: ReturnType<typeof useLoginProviders>;
  payments: PaymentsData;
}
interface Ctx extends ProvidersData {
  /** Opens the add modal on a category (optionally with a preset chosen). */
  add: (category: string, preset?: string) => void;
}
export type AddForm = Record<string, string | string[]>;
export interface AddOption {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

/**
 * One tab of the Providers page. Adding a category (Payments, LLM APIs, Push…) = one entry here plus its Panel
 * (list + detail, see ChannelCategory / LoginCategory) and its add-modal fields / create call.
 */
export interface CategoryDef {
  /** URL segment: /p/<slug>/providers/<id>/<instance>. */
  id: string;
  label: string;
  /** What the tab includes, shown next to the label (hidden on phones). */
  sub: string;
  /** "email provider" — used in "Add …" / "No … yet". */
  noun: string;
  description: string;
  emptyText: string;
  icon: (size: number) => ReactNode;
  /** Prefix of this category's sections in the "Connect your app" guide (`<prefix>-<instance>`). */
  guidePrefix: string;
  /** Tab count (null = still loading) and problems (tab dot + tooltip). */
  status: (d: ProvidersData) => { n: number | null; problems: string[] };
  /** Presets offered by the add modal and the empty state. */
  options: (d: ProvidersData) => AddOption[];
  /** Extra add-modal fields under the preset list. */
  AddFields: ComponentType<{ d: ProvidersData; def: CategoryDef; preset: string; form: AddForm; set: (f: AddForm) => void }>;
  /** Creates the instance (and refreshes its data); resolves to the new instance slug. */
  create: (d: ProvidersData, preset: string, form: AddForm) => Promise<string>;
  /** List + detail of the category. */
  Panel: ComponentType<{ ctx: Ctx; def: CategoryDef; instance?: string }>;
}

/** Email, SMS and WhatsApp share one implementation keyed by the channel (category id = channel). */
function channelCategory(channel: Channel, meta: Pick<CategoryDef, 'label' | 'sub' | 'noun' | 'description' | 'emptyText'>): CategoryDef {
  return {
    id: channel,
    ...meta,
    icon: (size) => <ChannelIcon channel={channel} size={size} />,
    guidePrefix: channel,
    status: (d) => problemsOf(d.overview.providers.filter((p) => p.channel === channel), d.presets),
    options: (d) => d.presets.filter((p) => p.channel === channel),
    AddFields: InstanceAddFields,
    create: async (d, preset, form) => {
      const p = await api.post<ProviderInstance>(`/api/projects/${d.slug}/providers`, {
        preset,
        name: (form.name as string) || undefined,
        slug: (form.slug as string) || undefined,
        labels: (form.labels as string[] | undefined) ?? [],
      });
      d.reload();
      return p.slug;
    },
    Panel: ChannelCategory,
  };
}

export const PROVIDER_CATEGORIES: CategoryDef[] = [
  channelCategory('email', {
    label: 'Email',
    sub: 'SMTP · APIs',
    noun: 'email provider',
    description: 'SMTP plus the SendGrid, Mailgun, Amazon SES and generic HTTP email APIs. Every accepted email lands in Mailpit and the test user’s inbox.',
    emptyText: 'Add SMTP or an email API (SendGrid, Mailgun, Amazon SES, generic). Several instances can live side by side, e.g. transactional and marketing.',
  }),
  channelCategory('sms', {
    label: 'SMS',
    sub: '& Verify',
    noun: 'SMS provider',
    description: 'Twilio, Vonage and generic SMS APIs. Twilio Verify and Vonage Verify run on the same Twilio / Vonage instances (same base URL), so they need no separate provider.',
    emptyText: 'Add Twilio, Vonage or a generic SMS API, point the SDK at the instance URL, and every SMS lands in the test user’s inbox. Twilio Verify and Vonage Verify work on the same instance.',
  }),
  channelCategory('whatsapp', {
    label: 'WhatsApp',
    sub: 'Meta · Twilio',
    noun: 'WhatsApp provider',
    description: 'Meta WhatsApp Cloud API (also used by resellers such as 360dialog), Twilio WhatsApp and generic WhatsApp APIs.',
    emptyText: 'Add Meta WhatsApp Cloud API, Twilio WhatsApp or a generic API to start sending WhatsApp messages (templates, buttons, lists) to test users.',
  }),
  {
    id: 'login',
    label: 'Login',
    sub: 'OAuth · OIDC',
    noun: 'login provider',
    description: 'Fake Google, Microsoft, GitHub, Apple… and generic OIDC providers. Point your OAuth library at the URLs and sign in as any test user.',
    emptyText: 'Add a fake identity provider, point your app’s OAuth library at its URLs and sign in as any test user: no real accounts, no consent screens.',
    icon: (size) => <Icon name="key" size={size} />,
    guidePrefix: 'auth',
    status: (d) => (d.login.providers ? { n: d.login.providers.length, problems: d.login.providers.filter((p) => !p.enabled).map((p) => `${p.slug} is disabled (503)`) } : { n: null, problems: [] }),
    options: (d) => (d.login.presets?.presets ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description, available: true })),
    AddFields: LoginAddFields,
    create: async (d, preset, form) => {
      const p = await createLoginProvider(d.slug, preset, (form.flavor as string) || 'generic', (d.login.providers ?? []).map((x) => x.slug), form.slug as string | undefined);
      d.login.reload();
      return p.slug;
    },
    Panel: LoginCategory,
  },
  {
    id: 'payments',
    label: 'Payments',
    sub: 'Stripe · PayTabs · PayPal',
    noun: 'payment provider',
    description: 'Fake Stripe Checkout, PayTabs and PayPal: hosted payment pages, test cards, signed webhooks and refunds. Point the SDK base URL at the instance and pay as any test user.',
    emptyText: 'Add a fake payment gateway, point your app’s SDK / HTTP client at its URL and walk through checkout, 3-D Secure, declines and webhooks without a real account.',
    icon: (size) => <Icon name="lock" size={size} />,
    guidePrefix: 'pay',
    status: (d) => (d.payments.instances ? { n: d.payments.instances.length, problems: d.payments.instances.flatMap((p) => p.problems) } : { n: null, problems: [] }),
    options: (d) => (d.payments.reference?.presets ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description, available: p.available })),
    AddFields: PaymentAddFields,
    create: async (d, preset, form) => {
      const s = await createPaymentProvider(d.slug, preset, form);
      d.payments.reload();
      return s;
    },
    Panel: PaymentsCategory,
  },
  LLM_CATEGORY,
];

export const findCategory = (id: string | undefined) => PROVIDER_CATEGORIES.find((c) => c.id === id);
/** Category of a "Connect your app" guide section id (`email-mail`, `auth-google`…). */
export const categoryOfSection = (sectionId: string) => PROVIDER_CATEGORIES.find((c) => sectionId.startsWith(`${c.guidePrefix}-`))?.id ?? null;

// ---------------- page ----------------

/**
 * /p/:slug/providers/:category?/:instance? — one tab per registered category (Email incl. SMTP + email APIs,
 * SMS incl. Verify, WhatsApp, Login), each a list of instances with a detail column.
 */
export default function ProvidersPage() {
  const { slug, overview, reload } = useProject();
  const sys = useFetch<SystemInfo>('/api/system');
  const login = useLoginProviders(slug);
  const payments = usePaymentInstances(slug);
  const params = useParams();
  const nav = useNavigate();
  const [adding, setAdding] = useState<{ category: string; preset?: string } | null>(null);
  const current = findCategory((params['*'] ?? '').split('/')[0]);
  const ctx: Ctx = { slug, overview, reload, presets: sys.data?.presets ?? [], labels: sys.data?.labels ?? [], login, payments, add: (category, preset) => setAdding({ category, preset }) };
  const statuses = new Map(PROVIDER_CATEGORIES.map((c) => [c.id, c.status(ctx)]));

  return (
    <Page
      title="Providers"
      description="Simulated provider accounts your app sends through. Add one instance per real account (primary, fallback, marketing…): each has its own URL, settings and failure rules."
      actions={
        <button className="btn primary" onClick={() => setAdding({ category: (current ?? PROVIDER_CATEGORIES[0]).id })}>
          <Icon name="plus" size={14} /> Add {current ? current.noun : 'provider'}
        </button>
      }
    >
      <nav className="tabs prov-tabs" aria-label="Provider categories">
        {PROVIDER_CATEGORIES.map((c) => {
          const { n, problems } = statuses.get(c.id)!;
          return (
            <NavLink key={c.id} to={providersPath(slug, c.id)} className={() => `tab ${current?.id === c.id ? 'active' : ''}`} title={problems.length ? problems.join(' · ') : `${c.label}: ${c.sub}`}>
              {c.icon(14)}
              <span>{c.label}</span>
              <span className="tab-sub">{c.sub}</span>
              <span className={`tab-n ${n ? '' : 'zero'}`}>{n ?? '…'}</span>
              {problems.length > 0 && <span className="tab-dot" aria-label={`${problems.length} problem${problems.length > 1 ? 's' : ''}`} />}
            </NavLink>
          );
        })}
      </nav>
      <Routes>
        <Route index element={<FirstTab statuses={statuses} />} />
        <Route path=":category/:instance?" element={<CategoryView ctx={ctx} />} />
        <Route path="*" element={<Navigate to={providersPath(slug)} replace />} />
      </Routes>
      {adding && (
        <AddProviderModal
          d={ctx}
          initial={adding}
          onClose={() => setAdding(null)}
          onCreated={(category, instance) => nav(providersPath(slug, category, instance))}
        />
      )}
    </Page>
  );
}

function problemsOf(list: ProviderInstance[], presets: Preset[] | undefined) {
  const problems: string[] = [];
  for (const p of list) {
    if (!p.enabled) problems.push(`${p.slug} is disabled (503)`);
    const preset = presets?.find((x) => x.id === p.preset);
    if (preset && !preset.available) problems.push(`${p.slug}: ${preset.name} simulator not available yet`);
  }
  return { n: list.length, problems };
}

/** /providers without a tab: the first category that has instances (waits while a count is still loading). */
function FirstTab({ statuses }: { statuses: Map<string, { n: number | null }> }) {
  const { slug } = useProject();
  for (const c of PROVIDER_CATEGORIES) {
    const n = statuses.get(c.id)?.n;
    if (n === null) return <p className="muted">Loading…</p>;
    if (n) return <Navigate to={providersPath(slug, c.id)} replace />;
  }
  return <Navigate to={providersPath(slug, PROVIDER_CATEGORIES[0].id)} replace />;
}

function CategoryView({ ctx }: { ctx: Ctx }) {
  const { category, instance } = useParams();
  const def = findCategory(category);
  if (!def) return <Navigate to={providersPath(ctx.slug)} replace />;
  return <def.Panel key={def.id} ctx={ctx} def={def} instance={instance} />;
}

/** List column + detail column. On phones only one of them shows: the list, or the selected instance. */
function Split({ hasSelection, list, detail }: { hasSelection: boolean; list: ReactNode; detail: ReactNode }) {
  return (
    <div className={`prov-split ${hasSelection ? 'has-selection' : ''}`}>
      <div className="card prov-list">{list}</div>
      <div className="prov-detail">{detail}</div>
    </div>
  );
}

function CategoryIntro({ def }: { def: CategoryDef }) {
  return <p className="prov-intro small muted">{def.description}</p>;
}

function EmptyCategory({ ctx, def }: { ctx: Ctx; def: CategoryDef }) {
  return (
    <div className="card prov-empty">
      <Empty title={`No ${def.noun} yet`}>
        <p className="prov-empty-text">{def.emptyText}</p>
        <div className="chips prov-empty-presets">
          {def
            .options(ctx)
            .filter((p) => p.available)
            .map((p) => (
              <button key={p.id} className="chip" title={p.description} onClick={() => ctx.add(def.id, p.id)}>
                <Icon name="plus" size={12} /> {p.name}
              </button>
            ))}
        </div>
        <button className="btn primary" onClick={() => ctx.add(def.id)}>
          <Icon name="plus" size={14} /> Add {def.noun}
        </button>
      </Empty>
    </div>
  );
}

// ---------------- email / SMS / WhatsApp ----------------

export function instanceUrl(slug: string, p: ProviderInstance, ports?: { https: number; smtp: number }) {
  return p.preset === 'smtp'
    ? `smtp://${smtpUser(slug, p)}@localhost:${ports?.smtp ?? 1025}`
    : `https://localhost:${ports?.https ?? 4443}/mock/${slug}/${p.slug}`;
}
const smtpUser = (slug: string, p: ProviderInstance) => (p.isDefault ? slug : `${slug}.${p.slug}`);

function ChannelCategory({ ctx, def, instance }: { ctx: Ctx; def: CategoryDef; instance?: string }) {
  const channel = def.id as Channel;
  const { slug, overview } = useProject();
  const { system } = useProjects();
  const list = overview.providers.filter((p) => p.channel === channel);
  const found = instance ? list.find((p) => p.slug === instance) : undefined;
  const selected = found ?? list.find((p) => p.isDefault) ?? list[0];
  // An unknown instance (just created and not loaded yet, or deleted) shows the default; the URL is kept.
  if (list.length === 0)
    return (
      <>
        <CategoryIntro def={def} />
        <EmptyCategory ctx={ctx} def={def} />
      </>
    );
  const groups: [string | null, ProviderInstance[]][] =
    channel === 'email'
      ? [
          ['SMTP', list.filter((p) => p.preset === 'smtp')],
          ['Email APIs', list.filter((p) => p.preset !== 'smtp')],
        ]
      : [[null, list]];
  const presetName = (id: string) => ctx.presets.find((x) => x.id === id)?.name ?? id;
  return (
    <>
      <CategoryIntro def={def} />
      <Split
        hasSelection={!!found}
        list={
          <>
            <div className="card-head">
              <h3>
                {list.length} instance{list.length > 1 ? 's' : ''}
              </h3>
              <button className="btn sm ghost" onClick={() => ctx.add(channel)}>
                <Icon name="plus" size={13} /> Add
              </button>
            </div>
            {groups
              .filter(([, items]) => items.length)
              .map(([title, items]) => (
                <div key={title ?? 'all'} className="prov-group">
                  {title && <div className="prov-group-title">{title}</div>}
                  {items.map((p) => (
                    <InstanceRow
                      key={p.id}
                      to={providersPath(slug, channel, p.slug)}
                      active={selected?.id === p.id}
                      title={p.name}
                      status={
                        <>
                          {p.isDefault && <Badge kind="accent">default</Badge>}
                          {!p.enabled && <Badge kind="bad">disabled</Badge>}
                        </>
                      }
                      meta={
                        <>
                          <span className="small muted">{presetName(p.preset)}</span>
                          {p.labels.map((l) => (
                            <Badge key={l}>{l}</Badge>
                          ))}
                        </>
                      }
                      url={<CopyUrl url={instanceUrl(slug, p, system?.ports)} />}
                    />
                  ))}
                </div>
              ))}
            <p className="prov-note small faint">
              {list.length > 1 ? (
                <>
                  <strong>Default</strong> {channel === 'email' ? <>takes SMTP mail sent as <code>{slug}</code> and</> : 'takes'} simulated replies from test users. The others are reached through their own{' '}
                  {channel === 'email' ? <>SMTP username (<code>{slug}.&lt;instance&gt;</code>) or URL</> : 'URL'}; labels (primary, fallback, marketing…) name their role.
                </>
              ) : (
                <>Add another instance for a fallback or marketing account: each gets its own {channel === 'email' ? 'SMTP username / URL' : 'URL'}, settings and failure rules.</>
              )}
            </p>
          </>
        }
        detail={selected && <ProviderDetail key={selected.id} def={def} p={selected} preset={ctx.presets.find((x) => x.id === selected.preset)} />}
      />
    </>
  );
}

const SECTIONS = ['settings', 'rules', 'connect'] as const;
const SECTION_LABEL = { settings: 'Settings', rules: 'Failure rules', connect: 'Connect' };

function ProviderDetail({ def, p, preset }: { def: CategoryDef; p: ProviderInstance; preset?: Preset }) {
  const { slug, overview, reload } = useProject();
  const { system } = useProjects();
  const toast = useToast();
  const nav = useNavigate();
  const [section, setSection] = useSection(SECTIONS);
  const base = `/api/projects/${slug}/providers/${p.slug}`;
  const patch = async (b: Partial<ProviderInstance>, msg: string) => {
    try {
      await api.patch(base, b);
      toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete provider instance "${p.name}"?`)) return;
    try {
      await api.del(base);
      toast('Provider deleted');
      reload();
      nav(providersPath(slug, p.channel), { replace: true });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const smtp = p.preset === 'smtp';
  const url = instanceUrl(slug, p, system?.ports);
  const verify = p.preset === 'twilio' || p.preset === 'twilio-whatsapp' ? 'Twilio Verify v2' : p.preset === 'vonage' ? 'Vonage Verify (v1 + v2)' : null;
  const channelNoun = def.noun;
  return (
    <>
      <DetailHead
        backTo={providersPath(slug, p.channel)}
        icon={<ChannelIcon channel={p.channel} />}
        title={p.name}
        sub={
          <>
            <code>{p.slug}</code>
            <span>{preset?.name ?? p.preset}</span>
          </>
        }
        badges={
          <>
            {p.isDefault ? <Badge kind="accent">default {channelNoun}</Badge> : <Badge>not default</Badge>}
            {p.labels.map((l) => (
              <Badge key={l}>{l}</Badge>
            ))}
            {preset && !preset.available && <Badge kind="warn">coming soon</Badge>}
            {p.enabled ? <Badge kind="ok">enabled</Badge> : <Badge kind="bad">disabled (503)</Badge>}
          </>
        }
        actions={
          <>
            {!p.isDefault && (
              <button className="btn sm" onClick={() => void patch({ isDefault: true }, `${p.name} is now the default`)}>
                Make default
              </button>
            )}
            <button className="btn sm" onClick={() => void patch({ enabled: !p.enabled }, p.enabled ? 'Disabled: calls get 503' : 'Enabled')}>
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn sm ghost danger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        }
        sections={<SectionTabs sections={SECTIONS} labels={SECTION_LABEL} current={section} onChange={setSection} />}
      >
        <dl className="kv prov-facts">
          <dt>{smtp ? 'SMTP' : 'Base URL'}</dt>
          <dd>
            <CopyUrl url={url} className="prov-url-full" />
          </dd>
          {smtp && (
            <>
              <dt>Username</dt>
              <dd>
                <code>{smtpUser(slug, p)}</code> <span className="faint small">any password</span>
              </dd>
            </>
          )}
          {verify && (
            <>
              <dt>Verify</dt>
              <dd className="small">
                {verify} on the same base URL{p.preset.startsWith('twilio') && <> (rewrite both api.twilio.com and verify.twilio.com)</>}: stubyard generates and checks the code.
              </dd>
            </>
          )}
          <dt>Routing</dt>
          <dd className="small">
            {p.isDefault ? (
              p.channel === 'email' ? (
                <>
                  Default: SMTP mail sent as <code>{slug}</code> and test-user replies use this instance.
                </>
              ) : (
                <>Default: test-user replies and simulated messages use this instance. Your app calls it through the base URL.</>
              )
            ) : (
              <>Reached only through its own {smtp ? 'SMTP username' : 'URL'}. Use labels to mark its role (fallback, marketing…).</>
            )}
          </dd>
        </dl>
      </DetailHead>
      {section === 'settings' && <ProviderConfig key={`${p.id}-${p.preset}`} slug={slug} p={p} reload={reload} />}
      {section === 'rules' && <RulesPanel key={p.id} slug={slug} scope="instance" ownerRef={p.slug} providers={overview.providers} title={`Failure rules for ${p.slug} (everyone)`} />}
      {section === 'connect' && <ConnectPanel slug={slug} p={p} />}
    </>
  );
}

function ProviderConfig({ slug, p, reload }: { slug: string; p: ProviderInstance; reload: () => void }) {
  const fields = useFetch<ConfigField[]>(`/api/presets/${p.preset}/fields`, [p.preset]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(p.config).map(([k, v]) => [k, String(v ?? '')])));
  const [labels, setLabels] = useState(p.labels.join(', '));
  const [name, setName] = useState(p.name);
  const toast = useToast();
  const save = async () => {
    try {
      const config: Record<string, string | null> = {};
      for (const f of fields.data ?? []) config[f.key] = values[f.key]?.trim() ? values[f.key].trim() : null;
      await api.patch(`/api/projects/${slug}/providers/${p.slug}`, { name: name.trim() || p.name, config, labels: labels.split(',').map((l) => l.trim()).filter(Boolean) });
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
        <button className="btn sm primary" onClick={() => void save()}>
          Save
        </button>
      </div>
      <div className="card-pad form">
        <div className="form form-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Labels <span className="hint">comma-separated · “marketing” honours DND opt-outs</span>
            <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="primary, fallback, transactional, marketing" />
          </label>
        </div>
        {p.preset === 'smtp' && (
          <p className="small faint" style={{ margin: 0 }}>
            SMTP needs no settings. Use the username shown above; any password works.
          </p>
        )}
        <ErrorBox error={fields.error} />
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

/** The instance's section of "Connect your app" (same snippets, filtered to this instance). */
function ConnectPanel({ slug, p }: { slug: string; p: ProviderInstance }) {
  const guide = useFetch<SetupGuide>(`/api/projects/${slug}/setup`, [slug, p.id, p.isDefault, JSON.stringify(p.config)]);
  const section = guide.data?.sections.find((s) => s.id === `${p.channel}-${p.slug}`);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Connect your app</h3>
        <Link to={`/p/${slug}/setup`} className="btn sm ghost">
          All settings <Icon name="external" size={12} />
        </Link>
      </div>
      <div className="card-pad stack">
        <ErrorBox error={guide.error} />
        {!guide.data && !guide.error && <p className="muted small">Loading…</p>}
        {guide.data && !section && <p className="muted small">No snippet for this instance.</p>}
        {section && (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              {section.description}
            </p>
            <div className="grid-snippets prov-snippets">
              {section.snippets.map((sn) => (
                <CodeBlock key={sn.title} title={sn.title} code={sn.code} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- login ----------------

function LoginCategory({ ctx, def, instance }: { ctx: Ctx; def: CategoryDef; instance?: string }) {
  const { slug, overview } = useProject();
  const nav = useNavigate();
  const { providers, error, presets, reload } = ctx.login;
  if (!providers)
    return (
      <>
        <CategoryIntro def={def} />
        {error ? <ErrorBox error={error} /> : <p className="muted">Loading…</p>}
      </>
    );
  const found = instance ? providers.find((p) => p.slug === instance) : undefined;
  const selected: LoginProvider | undefined = found ?? providers[0];
  // An unknown instance (just created and not loaded yet, or deleted) shows the default; the URL is kept.
  if (providers.length === 0)
    return (
      <>
        <CategoryIntro def={def} />
        <EmptyCategory ctx={ctx} def={def} />
      </>
    );
  return (
    <>
      <CategoryIntro def={def} />
      <Split
        hasSelection={!!found}
        list={
          <>
            <div className="card-head">
              <h3>
                {providers.length} login provider{providers.length > 1 ? 's' : ''}
              </h3>
              <button className="btn sm ghost" onClick={() => ctx.add(def.id)}>
                <Icon name="plus" size={13} /> Add
              </button>
            </div>
            <div className="prov-group">
              {providers.map((p) => (
                <LoginProviderRow key={p.id} slug={slug} p={p} active={selected?.id === p.id} category={def.id} />
              ))}
            </div>
            <p className="prov-note small faint">Each provider has its own issuer under /auth/{slug}/&lt;provider&gt;/. Add a second one of the same kind (google-2) to test two tenants or apps.</p>
          </>
        }
        detail={
          selected && (
            <LoginProviderDetail key={selected.id} slug={slug} p={selected} users={overview.users} presets={presets} reload={reload} onDeleted={() => nav(providersPath(slug, def.id), { replace: true })} category={def.id} />
          )
        }
      />
    </>
  );
}

// ---------------- add ----------------

function AddProviderModal({ d, initial, onClose, onCreated }: { d: ProvidersData; initial: { category: string; preset?: string }; onClose: () => void; onCreated: (category: string, instance: string) => void }) {
  const firstOf = (def: CategoryDef) => def.options(d).find((x) => x.available)?.id ?? '';
  const [def, setDef] = useState<CategoryDef>(() => findCategory(initial.category) ?? PROVIDER_CATEGORIES[0]);
  const [picked, setPreset] = useState(initial.preset ?? '');
  const [form, setForm] = useState<AddForm>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const switchTo = (c: CategoryDef) => {
    setDef(c);
    setPreset('');
    setForm({});
    setError(null);
  };
  const options = def.options(d);
  // Presets may still be loading when the modal opens: fall back to the first available one once they arrive.
  const preset = picked && options.some((o) => o.id === picked) ? picked : firstOf(def);
  const save = async () => {
    setBusy(true);
    try {
      const instance = await def.create(d, preset, form);
      toast(`${options.find((o) => o.id === preset)?.name ?? 'Provider'} added`);
      onCreated(def.id, instance);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Add ${def.noun}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy || !preset}>
            Add
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <div className="chips" role="tablist" aria-label="Category">
          {PROVIDER_CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={def.id === c.id} className={`chip ${def.id === c.id ? 'active' : ''}`} onClick={() => switchTo(c)}>
              {c.icon(12)}
              {c.label}
              <span className="n">{c.sub}</span>
            </button>
          ))}
        </div>
        <div className="prov-presets grid-auto" role="radiogroup" aria-label="Provider">
          {options.map((x) => (
            <label key={x.id} className={`prov-preset ${preset === x.id ? 'active' : ''} ${x.available ? '' : 'faint'}`} title={x.description}>
              <input type="radio" name="preset" value={x.id} checked={preset === x.id} onChange={() => setPreset(x.id)} />
              <span>
                <span className="prov-preset-name">
                  {x.name}
                  {!x.available && ' (coming soon)'}
                </span>
                <span className="small faint">{x.description}</span>
              </span>
            </label>
          ))}
        </div>
        <def.AddFields d={d} def={def} preset={preset} form={form} set={setForm} />
      </div>
    </Modal>
  );
}

/** Add fields of a message provider instance: name, slug, labels. */
function InstanceAddFields({ d, def, preset, form, set }: { d: ProvidersData; def: CategoryDef; preset: string; form: AddForm; set: (f: AddForm) => void }) {
  const chosen = (form.labels as string[] | undefined) ?? [];
  return (
    <>
      <div className="form form-2">
        <label className="field">
          Name
          <input value={(form.name as string) ?? ''} onChange={(e) => set({ ...form, name: e.target.value })} placeholder={d.presets.find((x) => x.id === preset)?.name} />
        </label>
        <label className="field">
          Slug <span className="hint">part of the URL{def.id === 'email' ? ' / SMTP username' : ''}</span>
          <input value={(form.slug as string) ?? ''} onChange={(e) => set({ ...form, slug: e.target.value })} placeholder={def.id === 'email' ? 'marketing' : `${def.id}-primary`} />
        </label>
      </div>
      <div className="prov-labels">
        <span>
          Labels <span className="hint">mark its role when there are several</span>
        </span>
        <div className="row">
          {d.labels.map((l) => (
            <label key={l} className="row" style={{ gap: 4, fontWeight: 400, color: 'var(--text)' }}>
              <input type="checkbox" checked={chosen.includes(l)} onChange={(e) => set({ ...form, labels: e.target.checked ? [...chosen, l] : chosen.filter((x) => x !== l) })} />
              {l}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

/** Add fields of a login provider: OIDC flavor and slug. */
function LoginAddFields({ preset, form, set }: { d: ProvidersData; def: CategoryDef; preset: string; form: AddForm; set: (f: AddForm) => void }) {
  const flavor = (form.flavor as string) || 'generic';
  return (
    <div className="form form-2">
      {preset === 'oidc' ? (
        <label className="field">
          Flavor
          <select value={flavor} onChange={(e) => set({ ...form, flavor: e.target.value })}>
            {OIDC_FLAVORS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
      ) : (
        <span />
      )}
      <label className="field">
        Slug <span className="hint">part of the issuer URL; default: the preset (google, google-2…)</span>
        <input value={(form.slug as string) ?? ''} onChange={(e) => set({ ...form, slug: e.target.value })} placeholder={preset === 'oidc' && flavor !== 'generic' ? flavor : preset} />
      </label>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useGate } from '../auth';
import {
  caPemUrl,
  einvoiceApi,
  einvoiceBase,
  ZATCA_ENV_LABEL,
  ZATCA_ENVS,
  type EinvoiceConnect,
  type EinvoiceInstance,
  type EinvoiceOtp,
  type EinvoiceOverview,
  type ZatcaConfigInput,
  type ZatcaConfigView,
  type ZatcaEnv,
} from '../einvoiceApi';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Icon } from './people';
import { CopyUrl, DetailHead, InstanceRow, providersPath, SectionTabs, useSection } from './providerLayout';
import { Badge, CodeBlock, Empty, ErrorBox, timeUntil, useCopy, useToast } from './ui';

/**
 * "E-invoicing" tab of the Providers page: fake ZATCA Fatoora instances of the project. The category entry is
 * EINVOICE_CATEGORY (appended in ProvidersPage); invoices, CSIDs, chains, faults and checks live on the E-invoicing page.
 */

const CATEGORY = 'einvoice';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pagePath = (slug: string) => `/p/${slug}/einvoice`;

/** The boolean flags of a ZATCA instance, with what each one changes. */
const FLAGS: { key: 'strictAuth' | 'strictCsr' | 'requireComplianceChecks' | 'clearanceEnabled'; label: string; hint: string }[] = [
  { key: 'strictAuth', label: 'Strict auth', hint: 'unknown or wrong CSID credentials on the invoice endpoints answer 401 like the real gateway (a wrong OTP is always 400 Invalid-OTP)' },
  { key: 'strictCsr', label: 'Strict CSR', hint: 'a CSR on the wrong curve or with the wrong template is refused (otherwise a lint finding)' },
  { key: 'requireComplianceChecks', label: 'Require compliance checks', hint: 'the production CSID needs every declared invoice kind to pass first' },
  { key: 'clearanceEnabled', label: 'Clearance enabled', hint: 'off: clearance answers 303 (clearance switched off, report instead)' },
];

/** Tab count for the Providers page (its status() runs before the panel loads; refreshed by any fetch here). */
const counts = new Map<string, number>();
const loading = new Set<string>();
function cachedCount(slug: string): number | null {
  if (!counts.has(slug) && !loading.has(slug)) {
    loading.add(slug);
    void fetch(einvoiceBase(slug))
      .then((r) => (r.ok ? r.json() : null))
      .then((o: EinvoiceOverview | null) => o && counts.set(slug, o.instances.length))
      .catch(() => undefined)
      .finally(() => loading.delete(slug));
  }
  return counts.get(slug) ?? null;
}

export function useEinvoiceInstances(slug: string) {
  const ov = useFetch<EinvoiceOverview>(einvoiceBase(slug), [slug]);
  if (ov.data) counts.set(slug, ov.data.instances.length);
  const reload = useDebounced(() => void ov.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'einvoice.changed' || e.type === 'project.reset') reload();
  });
  return { overview: ov.data, error: ov.error, reload };
}

export function EinvoiceCategory({ ctx, def, instance }: { ctx: { slug: string; add: (category: string, preset?: string) => void }; def: { description: string; emptyText: string }; instance?: string }) {
  const { slug } = ctx;
  const gate = useGate(slug)('project.providers');
  const d = useEinvoiceInstances(slug);
  const list = d.overview?.instances ?? [];
  const found = list.find((i) => i.slug === instance);
  const selected = found ?? list[0];
  return (
    <>
      <p className="prov-intro small muted">{def.description}</p>
      <ErrorBox error={d.error} />
      {d.overview && !list.length ? (
        <Empty title="No e-invoicing instances yet">
          <p className="small">{def.emptyText}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => ctx.add(CATEGORY, 'zatca')} {...gate}>
              Add ZATCA
            </button>
          </div>
        </Empty>
      ) : (
        <div className={`prov-split ${found ? 'has-selection' : ''}`}>
          <div className="card prov-list">
            <div className="card-head">
              <h3>
                {list.length} e-invoicing instance{list.length === 1 ? '' : 's'}
              </h3>
            </div>
            <div className="prov-group">
              {list.map((i) => (
                <InstanceRow
                  key={i.id}
                  to={providersPath(slug, CATEGORY, i.slug)}
                  active={selected?.id === i.id}
                  title={i.name}
                  status={!i.enabled ? <Badge kind="bad">disabled</Badge> : <Badge>{i.config.env}</Badge>}
                  meta={
                    <code className="faint small">
                      zatca · checks {i.config.checks}
                      {i.config.clearanceEnabled ? '' : ' · no clearance'}
                    </code>
                  }
                  url={<CopyUrl url={i.urls.envBase} />}
                />
              ))}
            </div>
            <p className="prov-note small faint">
              Invoices, CSIDs, chains, faults and checks in <Link to={pagePath(slug)}>E-invoicing</Link>.
            </p>
          </div>
          <div className="prov-detail">{selected && <EinvoiceDetailPanel key={selected.id} slug={slug} inst={selected} reload={d.reload} />}</div>
        </div>
      )}
    </>
  );
}

const SECTIONS = ['connect', 'settings'] as const;
type Section = (typeof SECTIONS)[number];

function EinvoiceDetailPanel({ slug, inst, reload }: { slug: string; inst: EinvoiceInstance; reload: () => void }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const [section, setSection] = useSection(SECTIONS);
  const remove = async () => {
    if (!window.confirm(`Delete ${inst.name}? Its CSIDs, invoices, chains and faults go too.`)) return;
    try {
      await einvoiceApi.deleteInstance(slug, inst.slug);
      toast('E-invoicing instance deleted');
      reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const toggle = () =>
    void einvoiceApi
      .updateInstance(slug, inst.slug, { enabled: !inst.enabled })
      .then(() => (toast(inst.enabled ? 'Disabled: the Fatoora routes answer 503' : 'Enabled'), reload()))
      .catch((e) => toast(errText(e)));
  return (
    <div className="stack">
      <DetailHead
        backTo={providersPath(slug, CATEGORY)}
        icon={<Icon name="flag" size={16} />}
        title={inst.name}
        sub={
          <code>
            zatca · {inst.slug} · {ZATCA_ENV_LABEL[inst.config.env]}
          </code>
        }
        badges={
          <>
            {!inst.enabled && <Badge kind="bad">disabled</Badge>}
            <Badge>checks {inst.config.checks}</Badge>
            {inst.config.strictAuth ? <Badge kind="warn">strict auth</Badge> : <Badge>lax auth</Badge>}
            {inst.config.strictCsr && <Badge kind="warn">strict CSR</Badge>}
            {!inst.config.clearanceEnabled && <Badge kind="warn">clearance off</Badge>}
            {inst.config.otp ? <Badge title="Only this OTP (or one from Generate OTP)">OTP {inst.config.otp}</Badge> : <Badge title="Any 6 digits">any OTP</Badge>}
          </>
        }
        actions={
          <>
            <Link className="btn sm" to={pagePath(slug)}>
              <Icon name="flag" size={13} /> E-invoicing
            </Link>
            <button className="btn sm ghost" onClick={toggle} {...gate}>
              {inst.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn sm ghost" onClick={() => void remove()} {...gate}>
              Delete
            </button>
          </>
        }
        sections={<SectionTabs sections={SECTIONS} labels={{ connect: 'Connect', settings: 'Settings' }} current={section} onChange={(s: Section) => setSection(s)} />}
      />
      {section === 'connect' ? <EinvoiceConnectPanel slug={slug} inst={inst} /> : <EinvoiceSettings slug={slug} inst={inst} reload={reload} />}
    </div>
  );
}

/** Generate OTP: 6 digits valid 1 h, accepted by /compliance and the CSID renewal even when a fixed OTP is set. */
function OtpCard({ slug, inst }: { slug: string; inst: EinvoiceInstance }) {
  const toast = useToast();
  const copy = useCopy();
  const gate = useGate(slug)('project.providers');
  const [otp, setOtp] = useState<EinvoiceOtp | null>(null);
  const issue = () =>
    void einvoiceApi
      .issueOtp(slug, inst.slug)
      .then(setOtp)
      .catch((e) => toast(errText(e)));
  return (
    <div className="card card-pad stack">
      <div className="row">
        <h3 className="grow">OTP</h3>
        <button className="btn sm primary" onClick={issue} {...gate}>
          Generate OTP
        </button>
      </div>
      <p className="small muted">
        {inst.config.otp ? `The compliance call accepts ${inst.config.otp}, or a generated OTP.` : 'The compliance call accepts any 6 digits, or a generated OTP.'} A generated OTP is valid for 1 hour.
      </p>
      {otp && (
        <div className="row">
          <button className="cred" style={{ fontSize: 22, letterSpacing: 4, fontFamily: 'var(--mono)' }} onClick={() => void copy(otp.otp, 'OTP copied')} title="Copy the OTP">
            {otp.otp} <Icon name="copy" size={14} />
          </button>
          <span className="small faint">expires in {timeUntil(otp.expiresAt)}</span>
        </div>
      )}
    </div>
  );
}

function EinvoiceConnectPanel({ slug, inst }: { slug: string; inst: EinvoiceInstance }) {
  const c = useFetch<EinvoiceConnect>(`${einvoiceBase(slug)}/instances/${encodeURIComponent(inst.slug)}/connect`, [slug, inst.slug, inst.config.env, inst.config.otp]);
  const d = c.data;
  const urls = d?.urls ?? inst.urls;
  const rows: [string, string][] = [
    ['Base URL', urls.envBase],
    ['Compliance CSID', urls.compliance],
    ['Compliance checks', urls.complianceInvoices],
    ['Production CSID', urls.productionCsids],
    ['Reporting', urls.reporting],
    ['Clearance', urls.clearance],
  ];
  const others = ZATCA_ENVS.filter((e) => e !== inst.config.env);
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>URLs</h3>
        <ErrorBox error={c.error} />
        {rows.map(([k, v]) => (
          <div key={k} className="row nowrap">
            <span className="small muted" style={{ flex: 'none', width: 130 }}>
              {k}
            </span>
            <CopyUrl url={v} />
          </div>
        ))}
        <p className="small faint">
          Other environments on the same instance: {others.map((e, n) => (
            <span key={e}>
              {n ? ', ' : ''}
              <code>{urls.byEnv[e]}</code>
            </span>
          ))}
          . The env segment of the URL wins over the instance setting.
        </p>
        {d && (
          <p className="small muted">
            CSR certificate template <code>{d.csrTemplate}</code> · first PIH <code>{d.firstPih}</code>
          </p>
        )}
        <div className="row">
          {inst.config.caCertPem ? (
            <a className="btn" href={caPemUrl(slug, inst.slug)}>
              Download fake ZATCA CA
            </a>
          ) : (
            <span className="small faint">The fake ZATCA CA is created with the first CSID.</span>
          )}
        </div>
      </div>
      <OtpCard slug={slug} inst={inst} />
      {d && <CodeBlock title=".env" code={Object.entries(d.dotenv).map(([k, v]) => `${k}=${v}`).join('\n')} />}
      {d?.snippets.filter((s) => s.id !== 'env').map((s) => <CodeBlock key={s.id} title={s.title} lang={s.lang} code={s.code} />)}
    </div>
  );
}

type Draft = Pick<ZatcaConfigView, 'env' | 'otp' | 'checks' | 'chainCheck' | 'reportingWindowHours' | 'strictAuth' | 'strictCsr' | 'requireComplianceChecks' | 'clearanceEnabled'>;
const draftOf = (c: ZatcaConfigView): Draft => ({
  env: c.env,
  otp: c.otp,
  checks: c.checks,
  chainCheck: c.chainCheck,
  reportingWindowHours: c.reportingWindowHours,
  strictAuth: c.strictAuth,
  strictCsr: c.strictCsr,
  requireComplianceChecks: c.requireComplianceChecks,
  clearanceEnabled: c.clearanceEnabled,
});

/** The config fields shared by the add modal and the Settings section. */
function ConfigFields({ value, set, disabled }: { value: Draft; set: (d: Draft) => void; disabled?: boolean }) {
  return (
    <>
      <div className="form form-2">
        <label className="field">
          Environment <span className="hint">CSR template and URL segment</span>
          <select value={value.env} disabled={disabled} onChange={(e) => set({ ...value, env: e.target.value as ZatcaEnv })}>
            {ZATCA_ENVS.map((e) => (
              <option key={e} value={e}>
                {ZATCA_ENV_LABEL[e]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Checks <span className="hint">basic: parse, UUID, hash, endpoint and chain; full: every ZATCA rule (structure, KSA, VAT, signature, QR)</span>
          <select value={value.checks} disabled={disabled} onChange={(e) => set({ ...value, checks: e.target.value as Draft['checks'] })}>
            <option value="full">full</option>
            <option value="basic">basic</option>
          </select>
        </label>
        <label className="field">
          Fixed OTP <span className="hint">empty = any 6 digits</span>
          <input value={value.otp} disabled={disabled} inputMode="numeric" maxLength={6} placeholder="any 6 digits" onChange={(e) => set({ ...value, otp: e.target.value.replace(/\D/g, '') })} />
        </label>
        <label className="field">
          ICV / PIH chain <span className="hint">lint: a finding; error: rejects a PIH mismatch or repeated ICV (an ICV gap or reset stays a warning); off: not checked</span>
          <select value={value.chainCheck} disabled={disabled} onChange={(e) => set({ ...value, chainCheck: e.target.value as Draft['chainCheck'] })}>
            <option value="lint">lint</option>
            <option value="error">error</option>
            <option value="off">off</option>
          </select>
        </label>
        <label className="field">
          Reporting window (hours) <span className="hint">Stored for later; not checked yet</span>
          <input type="number" min={1} max={8760} value={value.reportingWindowHours} disabled={disabled} onChange={(e) => set({ ...value, reportingWindowHours: Number(e.target.value) })} />
        </label>
      </div>
      <div className="stack">
        {FLAGS.map((f) => (
          <label key={f.key} className="row">
            <input type="checkbox" checked={value[f.key]} disabled={disabled} onChange={(e) => set({ ...value, [f.key]: e.target.checked })} />
            <span>
              {f.label} <span className="hint">{f.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </>
  );
}

function EinvoiceSettings({ slug, inst, reload }: { slug: string; inst: EinvoiceInstance; reload: () => void }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const [name, setName] = useState(inst.name);
  const [draft, setDraft] = useState<Draft>(() => draftOf(inst.config));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== inst.name || JSON.stringify(draft) !== JSON.stringify(draftOf(inst.config));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await einvoiceApi.updateInstance(slug, inst.slug, { name, config: draft satisfies ZatcaConfigInput });
      toast('Saved');
      reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card card-pad stack">
      <ErrorBox error={error} />
      <label className="field">
        Name
        <input value={name} disabled={!!gate.disabled} onChange={(e) => setName(e.target.value)} />
      </label>
      <ConfigFields value={draft} set={setDraft} disabled={!!gate.disabled} />
      <div className="row">
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty || !!gate.disabled} title={gate.title}>
          Save
        </button>
        {dirty && (
          <button className="btn ghost" onClick={() => (setName(inst.name), setDraft(draftOf(inst.config)))}>
            Revert
          </button>
        )}
      </div>
    </div>
  );
}

/** Defaults of a new instance (ZATCA_CONFIG_DEFAULTS in server/src/einvoice/types.ts). */
const DEFAULT_DRAFT: Draft = {
  env: 'developer-portal',
  otp: '',
  checks: 'full',
  chainCheck: 'lint',
  reportingWindowHours: 24,
  strictAuth: true,
  strictCsr: false,
  requireComplianceChecks: true,
  clearanceEnabled: true,
};
/** The add form keeps strings: config fields are stored as `cfg.<key>`, booleans as '1' / '0'. */
function draftFromForm(form: Record<string, string | string[]>): Draft {
  const s = (k: keyof Draft) => form[`cfg.${k}`] as string | undefined;
  const b = (k: keyof Draft, def: boolean) => (s(k) === undefined ? def : s(k) === '1');
  return {
    env: (s('env') as ZatcaEnv | undefined) ?? DEFAULT_DRAFT.env,
    otp: s('otp') ?? DEFAULT_DRAFT.otp,
    checks: (s('checks') as Draft['checks'] | undefined) ?? DEFAULT_DRAFT.checks,
    chainCheck: (s('chainCheck') as Draft['chainCheck'] | undefined) ?? DEFAULT_DRAFT.chainCheck,
    reportingWindowHours: s('reportingWindowHours') !== undefined ? Number(s('reportingWindowHours')) : DEFAULT_DRAFT.reportingWindowHours,
    strictAuth: b('strictAuth', DEFAULT_DRAFT.strictAuth),
    strictCsr: b('strictCsr', DEFAULT_DRAFT.strictCsr),
    requireComplianceChecks: b('requireComplianceChecks', DEFAULT_DRAFT.requireComplianceChecks),
    clearanceEnabled: b('clearanceEnabled', DEFAULT_DRAFT.clearanceEnabled),
  };
}
function formFromDraft(form: Record<string, string | string[]>, d: Draft): Record<string, string | string[]> {
  const out = { ...form };
  for (const [k, v] of Object.entries(d)) out[`cfg.${k}`] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  return out;
}

/** Add-modal fields: name, slug and the instance config. */
export function EinvoiceAddFields({ form, set }: { preset: string; form: Record<string, string | string[]>; set: (f: Record<string, string | string[]>) => void }) {
  return (
    <>
      <div className="form form-2">
        <label className="field">
          Name
          <input value={(form.name as string) ?? ''} placeholder="ZATCA" onChange={(e) => set({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          Slug <span className="hint">part of the URL</span>
          <input value={(form.slug as string) ?? ''} placeholder="zatca" onChange={(e) => set({ ...form, slug: e.target.value })} />
        </label>
      </div>
      <ConfigFields value={draftFromForm(form)} set={(d) => set(formFromDraft(form, d))} />
    </>
  );
}

/** CategoryDef for PROVIDER_CATEGORIES (typed structurally to avoid importing the page). */
export const EINVOICE_CATEGORY = {
  id: CATEGORY,
  label: 'E-invoicing',
  sub: 'ZATCA',
  noun: 'e-invoicing instance',
  description: 'Fake ZATCA Fatoora (Saudi e-invoicing, phase 2): onboarding with OTP, compliance and production CSIDs, compliance checks, reporting and clearance with the real validation rules, ICV / PIH chains and faults.',
  emptyText: 'Add a fake ZATCA instance, point your EGS / SDK base URL at it and onboard, report and clear invoices without the developer portal.',
  icon: (size: number) => <Icon name="flag" size={size} />,
  guidePrefix: 'einvoice',
  status: (d: { slug: string }) => ({ n: cachedCount(d.slug), problems: [] as string[] }),
  options: () => [{ id: 'zatca', name: 'ZATCA Fatoora', description: 'Saudi Arabia e-invoicing (phase 2): developer portal, simulation and core environments.', available: true }],
  AddFields: EinvoiceAddFields,
  create: async (d: { slug: string }, _preset: string, form: Record<string, string | string[]>) => {
    const i = await einvoiceApi.createInstance(d.slug, { name: (form.name as string) || undefined, slug: (form.slug as string) || undefined, config: draftFromForm(form) });
    return i.slug;
  },
  Panel: EinvoiceCategory,
};

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { createPaymentInstance, payBase, QUICK_OUTCOMES, type PaymentInstance, type PaymentReference } from '../paymentsApi';
import { Icon } from './people';
import { PaymentRulesPanel } from './PaymentRules';
import { CopyUrl, DetailHead, InstanceRow, providersPath, SectionTabs, useSection } from './providerLayout';
import { Badge, CodeBlock, Empty, ErrorBox, useToast } from './ui';
import '../styles/payments.css';

/**
 * Payments tab of the Providers page: fake Stripe Checkout, PayTabs and PayPal instances under
 * /pay/<project>/<instance>/. List + detail (connect, settings, outcome rules); the category entry lives in
 * pages/ProvidersPage.tsx (PROVIDER_CATEGORIES).
 */
export function usePaymentInstances(slug: string) {
  const list = useFetch<PaymentInstance[]>(`${payBase(slug)}/payment-instances`, [slug]);
  const reference = useFetch<PaymentReference>('/api/payment-presets');
  const reload = useDebounced(() => void list.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset') reload();
  });
  return { instances: list.data, error: list.error, reference: reference.data, reload };
}
export type PaymentsData = ReturnType<typeof usePaymentInstances>;

const CATEGORY = 'payments';

/** Add-modal fields: slug and webhook URL. */
export function PaymentAddFields({ preset, form, set }: { preset: string; form: Record<string, string | string[]>; set: (f: Record<string, string | string[]>) => void }) {
  return (
    <div className="form form-2">
      <label className="field">
        Slug <span className="hint">part of the URL; default: {preset === 'stripe-checkout' ? 'stripe' : preset} (then -2, -3…)</span>
        <input value={(form.slug as string) ?? ''} onChange={(e) => set({ ...form, slug: e.target.value })} placeholder={preset === 'stripe-checkout' ? 'stripe' : preset} />
      </label>
      <label className="field">
        {preset === 'paytabs' ? 'Default callback (IPN) URL' : 'Webhook URL'} <span className="hint">your app endpoint; can be set later</span>
        <input value={(form.webhookUrl as string) ?? ''} onChange={(e) => set({ ...form, webhookUrl: e.target.value })} placeholder="http://host.docker.internal:3000/webhooks/payments" />
      </label>
    </div>
  );
}

export async function createPaymentProvider(slug: string, preset: string, form: Record<string, string | string[]>): Promise<string> {
  const webhookUrl = ((form.webhookUrl as string) ?? '').trim();
  const p = await createPaymentInstance(slug, preset, { slug: ((form.slug as string) ?? '').trim() || undefined, config: webhookUrl ? { webhookUrl } : {} });
  return p.slug;
}

interface PanelCtx {
  slug: string;
  add: (category: string, preset?: string) => void;
  payments: PaymentsData;
}

export function PaymentsCategory({ ctx, def, instance }: { ctx: PanelCtx; def: { id: string; noun: string; description: string; emptyText: string }; instance?: string }) {
  const { slug, payments } = ctx;
  const nav = useNavigate();
  const { instances, error, reference, reload } = payments;
  const intro = <p className="prov-intro small muted">{def.description}</p>;
  if (!instances)
    return (
      <>
        {intro}
        {error ? <ErrorBox error={error} /> : <p className="muted">Loading…</p>}
      </>
    );
  if (!instances.length)
    return (
      <>
        {intro}
        <div className="card prov-empty">
          <Empty title={`No ${def.noun} yet`}>
            <p className="prov-empty-text">{def.emptyText}</p>
            <div className="chips prov-empty-presets">
              {(reference?.presets ?? [])
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
      </>
    );
  const found = instance ? instances.find((p) => p.slug === instance) : undefined;
  const selected = found ?? instances[0];
  return (
    <>
      {intro}
      <div className={`prov-split ${found ? 'has-selection' : ''}`}>
        <div className="card prov-list">
          <div className="card-head">
            <h3>
              {instances.length} payment provider{instances.length > 1 ? 's' : ''}
            </h3>
            <button className="btn sm ghost" onClick={() => ctx.add(def.id)}>
              <Icon name="plus" size={13} /> Add
            </button>
          </div>
          <div className="prov-group">
            {instances.map((p) => (
              <InstanceRow
                key={p.id}
                to={providersPath(slug, CATEGORY, p.slug)}
                active={selected?.id === p.id}
                title={p.name}
                status={
                  <>
                    {p.activeRules > 0 && <Badge kind="warn">{p.activeRules} rule{p.activeRules > 1 ? 's' : ''}</Badge>}
                    {!p.enabled && <Badge kind="bad">disabled</Badge>}
                    {p.problems.length > 0 && p.enabled && <Badge kind="warn" title={p.problems.join(' · ')}>!</Badge>}
                  </>
                }
                meta={
                  <>
                    <Badge>{p.presetName}</Badge>
                    <code className="faint small">{p.slug}</code>
                  </>
                }
                url={<CopyUrl url={p.urls.browser} />}
              />
            ))}
          </div>
          <p className="prov-note small faint">
            Each provider answers under /pay/{slug}/&lt;instance&gt;/. Payments show up in <Link to={`/p/${slug}/payments`}>Payments</Link>.
          </p>
        </div>
        <div className="prov-detail">{selected && <PaymentProviderDetail key={selected.id} slug={slug} p={selected} reference={reference} reload={reload} onDeleted={() => nav(providersPath(slug, CATEGORY), { replace: true })} />}</div>
      </div>
    </>
  );
}

const SECTIONS = ['connect', 'settings', 'rules'] as const;
const SECTION_LABEL = { connect: 'Connect', settings: 'Settings', rules: 'Outcome rules' };

function PaymentProviderDetail({ slug, p, reference, reload, onDeleted }: { slug: string; p: PaymentInstance; reference: PaymentReference | null; reload: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [section, setSection] = useSection(SECTIONS);
  const base = `${payBase(slug)}/payment-instances/${p.slug}`;
  const call = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete payment provider "${p.name}" and its payments?`)) return;
    await call(() => api.del(base), 'Payment provider deleted');
    onDeleted();
  };
  const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
  return (
    <>
      <DetailHead
        backTo={providersPath(slug, CATEGORY)}
        icon={<Icon name="lock" size={16} />}
        title={p.name}
        sub={
          <>
            <code>{p.slug}</code>
            <span>{p.presetName}</span>
          </>
        }
        badges={
          <>
            {p.methods.map((m) => (
              <Badge key={m}>{m}</Badge>
            ))}
            {p.config.strictKeys ? <Badge kind="accent">strict keys</Badge> : null}
            {p.config.magicAmounts ? <Badge kind="accent">magic amounts</Badge> : null}
            {p.config.defaultOutcome ? <Badge kind="warn">default: {String(p.config.defaultOutcome)}</Badge> : null}
            {p.problems.map((x) => (
              <Badge key={x} kind="warn">
                {x}
              </Badge>
            ))}
            {p.enabled ? <Badge kind="ok">enabled</Badge> : <Badge kind="bad">disabled (503)</Badge>}
          </>
        }
        actions={
          <>
            <Link className="btn sm" to={`/p/${slug}/payments?instance=${encodeURIComponent(p.slug)}`}>
              {total} payment{total === 1 ? '' : 's'}
            </Link>
            <button className="btn sm" onClick={() => void call(() => api.patch(base, { enabled: !p.enabled }), p.enabled ? 'Disabled: calls get 503' : 'Enabled')}>
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn sm ghost danger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        }
        sections={<SectionTabs sections={SECTIONS} labels={SECTION_LABEL} current={section} onChange={setSection} extra={{ rules: p.activeRules > 0 ? <span className="tab-n">{p.activeRules}</span> : null }} />}
      >
        <dl className="kv prov-facts">
          <dt>Base URL</dt>
          <dd>
            <CopyUrl url={p.urls.backend} className="prov-url-full" />
          </dd>
        </dl>
      </DetailHead>
      <div className="prov-body pay-body">
        {section === 'connect' && <ConnectPanel p={p} reference={reference} />}
        {section === 'settings' && <SettingsPanel key={p.id + JSON.stringify(p.config)} p={p} base={base} call={call} />}
        {section === 'rules' && <PaymentRulesPanel slug={slug} instance={p.slug} />}
      </div>
    </>
  );
}

function ConnectPanel({ p, reference }: { p: PaymentInstance; reference: PaymentReference | null }) {
  const env = Object.entries(p.connect.env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Connect your app</h3>
        </div>
        <div className="card-pad stack">
          <dl className="kv">
            <dt>App in Docker</dt>
            <dd>
              <CopyUrl url={p.urls.backend} className="prov-url-full" />
            </dd>
            <dt>App on this machine</dt>
            <dd>
              <CopyUrl url={p.urls.backendLocal} className="prov-url-full" />
            </dd>
            <dt>Browser</dt>
            <dd>
              <CopyUrl url={p.urls.browser} className="prov-url-full" />
            </dd>
          </dl>
          <CodeBlock title=".env" code={env} />
          <ul className="pay-notes small">
            {p.connect.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      </div>
      {reference && p.methods.some((m) => m === 'card' || m === 'mada') && (
        <div className="card">
          <div className="card-head">
            <h3>Test cards</h3>
          </div>
          <div className="table-wrap">
            <table className="pay-cards">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Magic id</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {reference.magicCards.map((c) => (
                  <tr key={c.id}>
                    <td className="mono nowrap">{c.number.replace(/(\d{4})(?=\d)/g, '$1 ')}</td>
                    <td>
                      <code>{c.id}</code>
                    </td>
                    <td className="small">{c.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-pad small faint" style={{ margin: 0 }}>
            Any expiry in the future and any CVC. Other public test numbers (4111 1111 1111 1111, 5555 5555 5555 4444…) are accepted; the outcome then comes from the button you click. A real-looking card number is refused and flagged.
          </p>
        </div>
      )}
    </>
  );
}

function SettingsPanel({ p, base, call }: { p: PaymentInstance; base: string; call: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const str = (k: string) => (p.config[k] === undefined || p.config[k] === null ? '' : String(p.config[k]));
  const [name, setName] = useState(p.name);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(p.fields.map((f) => [f.key, f.secret ? '' : str(f.key)])));
  const [delay, setDelay] = useState(str('webhookDelayMs'));
  const [settle, setSettle] = useState(str('settleDelayMs'));
  const [def, setDef] = useState(str('defaultOutcome'));
  const [magic, setMagic] = useState(!!p.config.magicAmounts);
  const [strict, setStrict] = useState(!!p.config.strictKeys);
  const save = () => {
    const config: Record<string, unknown> = {};
    for (const f of p.fields) {
      const v = values[f.key]?.trim() ?? '';
      if (f.secret) {
        if (v) config[f.key] = v;
      } else config[f.key] = v || null;
    }
    config.webhookDelayMs = delay.trim() === '' ? null : Number(delay);
    config.settleDelayMs = settle.trim() === '' ? null : Number(settle);
    config.defaultOutcome = def.trim() || null;
    config.magicAmounts = magic;
    config.strictKeys = strict;
    void call(() => api.patch(base, { name: name.trim() || p.name, config }), 'Payment provider saved');
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
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="form form-2">
          {p.fields.map((f) => (
            <label key={f.key} className="field">
              {f.label} {f.hint && <span className="hint">{f.hint}</span>}
              <input
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                value={values[f.key] ?? ''}
                placeholder={f.secret ? `${str(f.key) || 'not set'} (leave empty to keep)` : undefined}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="form form-2">
          <label className="field">
            Webhook delay (ms) <span className="hint">0 = before the browser returns; default 500</span>
            <input inputMode="numeric" value={delay} onChange={(e) => setDelay(e.target.value)} placeholder="500" />
          </label>
          <label className="field">
            Settle delay (ms) <span className="hint">pending_then_success; default 3000</span>
            <input inputMode="numeric" value={settle} onChange={(e) => setSettle(e.target.value)} placeholder="3000" />
          </label>
          <label className="field">
            Default outcome <span className="hint">when nothing else decides (API completes without outcome)</span>
            <input list="pay-outcomes" value={def} onChange={(e) => setDef(e.target.value)} placeholder="success" />
            <datalist id="pay-outcomes">
              {QUICK_OUTCOMES.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </label>
          <div className="field pay-toggles">
            <label className="row">
              <input type="checkbox" checked={magic} onChange={(e) => setMagic(e.target.checked)} /> Magic amounts <span className="hint">.02 decline, .05 insufficient, .12 3DS fail, .99 pending</span>
            </label>
            <label className="row">
              <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} /> Strict keys <span className="hint">only this instance's credentials</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

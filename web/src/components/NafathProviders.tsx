import { useState, type ChangeEvent } from 'react';
import { useGate } from '../auth';
import { useProjectMaybe } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  AUTO_DECISION_LABEL,
  AUTO_DECISIONS,
  NAFATH_DEFAULTS,
  nafathApi,
  nafathBase,
  type AutoDecision,
  type NafathConfig,
  type NafathConnect,
  type NafathInstance,
  type NafathOverview,
  type NafathRequest,
  type NafathRule,
  type NafathStatus,
} from '../nafathApi';
import { Icon } from './people';
import { CopyUrl, DetailHead, InstanceRow, providersPath, SectionTabs, useSection } from './providerLayout';
import { Badge, CodeBlock, Empty, ErrorBox, fmtTime, timeAgo, useCopy, useToast } from './ui';
import '../styles/nafath.css';

/**
 * "Nafath" tab of the Providers page: fake Nafath (Saudi national SSO, MFA API) instances of the project. The category
 * entry is NAFATH_CATEGORY (appended in ProvidersPage). Each instance has Connect, Settings, Requests and Faults.
 */

const CATEGORY = 'nafath';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Tab count for the Providers page (its status() runs before the panel loads; refreshed by any fetch here). */
const counts = new Map<string, number>();
const loading = new Set<string>();
function cachedCount(slug: string): number | null {
  if (!counts.has(slug) && !loading.has(slug)) {
    loading.add(slug);
    void fetch(nafathBase(slug))
      .then((r) => (r.ok ? r.json() : null))
      .then((o: NafathOverview | null) => o && counts.set(slug, o.instances.length))
      .catch(() => undefined)
      .finally(() => loading.delete(slug));
  }
  return counts.get(slug) ?? null;
}

const isNafathEvent = (type: string) => type === 'nafath.changed' || type === 'project.reset';

export function useNafathInstances(slug: string) {
  const ov = useFetch<NafathOverview>(nafathBase(slug), [slug]);
  if (ov.data) counts.set(slug, ov.data.instances.length);
  const reload = useDebounced(() => void ov.reload(), 200);
  useHubEvents(slug, (e) => {
    if (isNafathEvent(e.type)) reload();
  });
  return { overview: ov.data, error: ov.error, reload };
}

/** A fetch of this project's Nafath data that reloads on nafath.changed / project.reset. */
function useNafathFetch<T>(slug: string, path: string) {
  const f = useFetch<T>(path, [path]);
  const reload = useDebounced(() => void f.reload(), 200);
  useHubEvents(slug, (e) => {
    if (isNafathEvent(e.type)) reload();
  });
  return { data: f.data, error: f.error, reload };
}

export function NafathCategory({ ctx, def, instance }: { ctx: { slug: string; add: (category: string, preset?: string) => void }; def: { description: string; emptyText: string }; instance?: string }) {
  const { slug } = ctx;
  const gate = useGate(slug)('project.providers');
  const d = useNafathInstances(slug);
  const list = d.overview?.instances ?? [];
  const found = list.find((i) => i.slug === instance);
  const selected = found ?? list[0];
  return (
    <>
      <p className="prov-intro small muted">{def.description}</p>
      <ErrorBox error={d.error} />
      {d.overview && !list.length ? (
        <Empty title="No Nafath instances yet">
          <p className="small">{def.emptyText}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => ctx.add(CATEGORY, 'nafath')} {...gate}>
              Add Nafath
            </button>
          </div>
        </Empty>
      ) : (
        <div className={`prov-split ${found ? 'has-selection' : ''}`}>
          <div className="card prov-list">
            <div className="card-head">
              <h3>{plural(list.length, 'Nafath instance')}</h3>
            </div>
            <div className="prov-group">
              {list.map((i) => (
                <InstanceRow
                  key={i.id}
                  to={providersPath(slug, CATEGORY, i.slug)}
                  active={selected?.id === i.id}
                  title={i.name}
                  status={
                    <>
                      {!i.enabled && <Badge kind="bad">disabled</Badge>}
                      {i.strict ? <Badge kind="warn">strict</Badge> : <Badge>lax</Badge>}
                    </>
                  }
                  meta={
                    <code className="faint small">
                      APP-ID {i.appId} · {i.config.callbackUrl ? 'callback set' : 'no callback'} · auto {i.config.autoDecision}
                    </code>
                  }
                  url={<CopyUrl url={i.urls.base} />}
                />
              ))}
            </div>
            {d.overview && (d.overview.waiting > 0 || d.overview.faults > 0) && (
              <p className="prov-note small faint">
                {plural(d.overview.waiting, 'waiting request')} · {plural(d.overview.faults, 'active fault rule')} in the project.
              </p>
            )}
          </div>
          <div className="prov-detail">{selected && d.overview && <NafathDetailPanel key={selected.id} slug={slug} inst={selected} overview={d.overview} reload={d.reload} />}</div>
        </div>
      )}
    </>
  );
}

const SECTIONS = ['connect', 'settings', 'requests', 'faults'] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABELS: Record<Section, string> = { connect: 'Connect', settings: 'Settings', requests: 'Requests', faults: 'Faults' };

function NafathDetailPanel({ slug, inst, overview, reload }: { slug: string; inst: NafathInstance; overview: NafathOverview; reload: () => void }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const [section, setSection] = useSection(SECTIONS);
  const remove = async () => {
    if (!window.confirm(`Delete ${inst.name}? Its requests and pending callbacks go too.`)) return;
    try {
      await nafathApi.deleteInstance(slug, inst.slug);
      toast('Nafath instance deleted');
      reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const toggle = () =>
    void nafathApi
      .updateInstance(slug, inst.slug, { enabled: !inst.enabled })
      .then(() => (toast(inst.enabled ? 'Disabled: the Nafath API answers 503' : 'Enabled'), reload()))
      .catch((e) => toast(errText(e)));
  const c = inst.config;
  return (
    <div className="stack">
      <DetailHead
        backTo={providersPath(slug, CATEGORY)}
        icon={<Icon name="shield" size={16} />}
        title={inst.name}
        sub={<code>nafath · {inst.slug}</code>}
        badges={
          <>
            {!inst.enabled && <Badge kind="bad">disabled</Badge>}
            {inst.strict ? (
              <Badge kind="warn" title="Wrong credentials, unknown national IDs and services outside the list are errors">
                strict
              </Badge>
            ) : (
              <Badge title="Wrong credentials and unknown national IDs are accepted with a warning">lax</Badge>
            )}
            {c.callbackUrl ? <Badge kind="ok" title={c.callbackUrl}>callback set</Badge> : <Badge title="No callback URL: the app has to poll /status">no callback</Badge>}
            <Badge title={`Auto decision after ${c.autoDelayMs} ms`}>auto {c.autoDecision}</Badge>
            <Badge>TTL {c.ttlSeconds}s</Badge>
          </>
        }
        actions={
          <>
            <button className="btn sm ghost" onClick={toggle} {...gate}>
              {inst.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn sm ghost" onClick={() => void remove()} {...gate}>
              Delete
            </button>
          </>
        }
        sections={<SectionTabs sections={SECTIONS} labels={SECTION_LABELS} current={section} onChange={(s: Section) => setSection(s)} />}
      />
      {section === 'connect' ? (
        <NafathConnectPanel slug={slug} inst={inst} reload={reload} />
      ) : section === 'settings' ? (
        <NafathSettings slug={slug} inst={inst} reload={reload} />
      ) : section === 'requests' ? (
        <NafathRequests slug={slug} inst={inst} />
      ) : (
        <NafathFaults slug={slug} inst={inst} overview={overview} />
      )}
    </div>
  );
}

// ---------------- Connect ----------------

function SecretRow({ label, value }: { label: string; value: string }) {
  const copy = useCopy();
  const [shown, setShown] = useState(false);
  return (
    <div className="row nowrap">
      <span className="small muted nafath-key">{label}</span>
      <code className="ellipsis grow">{shown ? value : '•'.repeat(Math.min(value.length, 24))}</code>
      <button className="btn xs ghost" onClick={() => setShown(!shown)} aria-pressed={shown} aria-label={shown ? `Hide ${label}` : `Show ${label}`}>
        <Icon name={shown ? 'eyeOff' : 'eye'} size={13} />
      </button>
      <button className="btn xs" onClick={() => void copy(value, `${label} copied`)} aria-label={`Copy ${label}`}>
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
}

function NafathConnectPanel({ slug, inst, reload }: { slug: string; inst: NafathInstance; reload: () => void }) {
  const toast = useToast();
  const copy = useCopy();
  const gate = useGate(slug)('project.providers');
  const c = useFetch<NafathConnect>(`${nafathBase(slug)}/instances/${encodeURIComponent(inst.slug)}/connect`, [slug, inst.slug, inst.appId, inst.appKey, inst.config.callbackUrl]);
  const d = c.data;
  const urls = d?.urls ?? inst.urls;
  const rows: [string, string][] = [
    ['Base URL', urls.base],
    ['Start request', urls.request],
    ['Status', urls.status],
    ['Info', urls.info],
    ['JWK set', urls.jwk],
    ['Sandbox base', urls.sandboxBase],
    ['Staging base', urls.stagingBase],
  ];
  const rotate = (dropOld: boolean) => {
    if (dropOld && !window.confirm('Rotate and drop every old key? Tokens signed with them stop verifying.')) return;
    void nafathApi
      .rotateKeys(slug, inst.slug, dropOld)
      .then(() => (toast('New signing key'), reload()))
      .catch((e) => toast(errText(e)));
  };
  const isHostMode = (title: string) => title.startsWith('Host mode');
  const hostSnippet = d?.snippets.find((s) => isHostMode(s.title));
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>URLs</h3>
        <ErrorBox error={c.error} />
        {rows.map(([k, v]) => (
          <div key={k} className="row nowrap">
            <span className="small muted nafath-key">{k}</span>
            <CopyUrl url={v} />
          </div>
        ))}
        <p className="small faint">The paths are the real ones (/api/v1/mfa/…); the /nafath-sandbox and /stg prefixes of the real hosts work too.</p>
      </div>
      <div className="card card-pad stack">
        <h3>Credentials</h3>
        <p className="small muted">Send them as the APP-ID and APP-KEY headers. {inst.strict ? 'Strict: other values get 403.' : 'Lax: other values are accepted with a warning.'}</p>
        <div className="row nowrap">
          <span className="small muted nafath-key">APP-ID</span>
          <code className="ellipsis grow">{inst.appId}</code>
          <button className="btn xs" onClick={() => void copy(inst.appId, 'APP-ID copied')} aria-label="Copy APP-ID">
            <Icon name="copy" size={13} />
          </button>
        </div>
        <SecretRow label="APP-KEY" value={inst.appKey} />
      </div>
      <div className="card card-pad stack">
        <div className="row">
          <h3 className="grow">Signing keys</h3>
          <button className="btn sm" onClick={() => rotate(false)} {...gate}>
            Rotate key
          </button>
          <button className="btn sm ghost" onClick={() => rotate(true)} {...gate}>
            Rotate and drop old
          </button>
        </div>
        <p className="small muted">
          Callback tokens are RS256 JWTs signed with the active key; retired keys stay in the JWK set until dropped.
        </p>
        <ul className="nafath-keys">
          {inst.keys.map((k) => (
            <li key={k.kid} className="row nowrap">
              <code className="ellipsis grow">{k.kid}</code>
              {k.status === 'active' ? <Badge kind="ok">active</Badge> : <Badge>retired</Badge>}
              <span className="small faint nowrap">{timeAgo(k.createdAt)}</span>
            </li>
          ))}
        </ul>
      </div>
      {d && <CodeBlock title=".env" lang="dotenv" code={d.dotenv} />}
      {d && d.hosts.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="nafath-table">
              <caption className="nafath-caption">Base URL by where the app runs</caption>
              <thead>
                <tr>
                  <th scope="col">App runs in</th>
                  <th scope="col">Base URL</th>
                </tr>
              </thead>
              <tbody>
                {d.hosts.map((h) => (
                  <tr key={h.id}>
                    <td className="small">{h.label}</td>
                    <td>
                      <CopyUrl url={h.baseUrl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {d?.snippets
        .filter((s) => s.title !== '.env' && s.title !== 'Base URL by where the app runs' && !isHostMode(s.title))
        .map((s) => <CodeBlock key={s.title} title={s.title} lang={s.language} code={s.code} />)}
      {d && (
        <div className="card card-pad stack">
          <h3>Host mode (keep the real Elm URL)</h3>
          <p className="small muted">
            Leave the app on the real Nafath host and point that host name at stubyard instead. stubyard finds the instance by the APP-ID header. Hosts:{' '}
            {d.hostMode.hosts.map((h, n) => (
              <span key={h}>
                {n ? ', ' : ''}
                <code>{h}</code>
              </span>
            ))}
            .
          </p>
          <ol className="small nafath-steps">
            <li>
              Add the hosts entry (<code>/etc/hosts</code> or the container's <code>extra_hosts</code>).
            </li>
            <li>
              Set <code>STUBYARD_TLS_NAMES</code> to those names and trust the stubyard CA (<a href={d.hostMode.caUrl}>download</a>).
            </li>
            <li>Serve stubyard's HTTPS on port 443 (or put a proxy in front).</li>
          </ol>
          <CodeBlock title="hosts entry" lang="text" code={d.hostMode.hostsEntry} />
          {hostSnippet && <CodeBlock title={hostSnippet.title} lang={hostSnippet.language} code={hostSnippet.code} />}
        </div>
      )}
    </div>
  );
}

// ---------------- Settings ----------------

/** The editable fields (config with services as text, plus strict). */
interface Draft {
  callbackUrl: string;
  ttlSeconds: number;
  autoDecision: AutoDecision;
  autoDelayMs: number;
  services: string;
  callbackFields: NafathConfig['callbackFields'];
  callbackOnExpired: boolean;
  wrongNumberCooldownSeconds: number;
  statusLagMs: number;
  strict: boolean;
}
const draftOf = (c: NafathConfig, strict: boolean): Draft => ({
  callbackUrl: c.callbackUrl ?? '',
  ttlSeconds: c.ttlSeconds,
  autoDecision: c.autoDecision,
  autoDelayMs: c.autoDelayMs,
  services: c.services.join(', '),
  callbackFields: c.callbackFields,
  callbackOnExpired: c.callbackOnExpired,
  wrongNumberCooldownSeconds: c.wrongNumberCooldownSeconds,
  statusLagMs: c.statusLagMs,
  strict,
});
const configOf = (d: Draft): Partial<NafathConfig> => ({
  callbackUrl: d.callbackUrl.trim() || null,
  ttlSeconds: d.ttlSeconds,
  autoDecision: d.autoDecision,
  autoDelayMs: d.autoDelayMs,
  services: d.services
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  callbackFields: d.callbackFields,
  callbackOnExpired: d.callbackOnExpired,
  wrongNumberCooldownSeconds: d.wrongNumberCooldownSeconds,
  statusLagMs: d.statusLagMs,
});

/** The config fields shared by the add modal and the Settings section. */
function ConfigFields({ value, set, disabled }: { value: Draft; set: (d: Draft) => void; disabled?: boolean }) {
  const num = (k: 'ttlSeconds' | 'autoDelayMs' | 'wrongNumberCooldownSeconds' | 'statusLagMs') => (e: ChangeEvent<HTMLInputElement>) => set({ ...value, [k]: Number(e.target.value) });
  return (
    <>
      <label className="field">
        Callback URL <span className="hint">COMPLETED / REJECTED are POSTed here; empty = no callback, the app polls</span>
        <input type="url" value={value.callbackUrl} disabled={disabled} placeholder="http://app:3000/nafath/callback" onChange={(e) => set({ ...value, callbackUrl: e.target.value })} />
      </label>
      <div className="form form-2">
        <label className="field">
          Auto decision <span className="hint">what the fake Nafath app does by itself</span>
          <select value={value.autoDecision} disabled={disabled} onChange={(e) => set({ ...value, autoDecision: e.target.value as AutoDecision })}>
            {AUTO_DECISIONS.map((a) => (
              <option key={a} value={a}>
                {AUTO_DECISION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Auto delay (ms) <span className="hint">after the request starts</span>
          <input type="number" min={0} max={3600000} value={value.autoDelayMs} disabled={disabled || value.autoDecision === 'none'} onChange={num('autoDelayMs')} />
        </label>
        <label className="field">
          Lifetime (seconds) <span className="hint">real Nafath: 200</span>
          <input type="number" min={1} max={86400} value={value.ttlSeconds} disabled={disabled} onChange={num('ttlSeconds')} />
        </label>
        <label className="field">
          Status lag (ms) <span className="hint">/status keeps saying WAITING this long after the decision</span>
          <input type="number" min={0} max={600000} value={value.statusLagMs} disabled={disabled} onChange={num('statusLagMs')} />
        </label>
        <label className="field">
          Wrong-number cooldown (seconds) <span className="hint">a new request for the ID within it gets 400-034-050</span>
          <input type="number" min={0} max={86400} value={value.wrongNumberCooldownSeconds} disabled={disabled} onChange={num('wrongNumberCooldownSeconds')} />
        </label>
        <label className="field">
          Callback body <span className="hint">compat adds transactionId</span>
          <select value={value.callbackFields} disabled={disabled} onChange={(e) => set({ ...value, callbackFields: e.target.value as Draft['callbackFields'] })}>
            <option value="default">default</option>
            <option value="compat">compat</option>
          </select>
        </label>
      </div>
      <label className="field">
        Services <span className="hint">comma separated; empty = any (checked in strict mode only)</span>
        <input value={value.services} disabled={disabled} placeholder="Login, DigitalServiceEnrollmentWithoutBio" onChange={(e) => set({ ...value, services: e.target.value })} />
      </label>
      <div className="stack">
        <label className="row">
          <input type="checkbox" checked={value.strict} disabled={disabled} onChange={(e) => set({ ...value, strict: e.target.checked })} />
          <span>
            Strict <span className="hint">wrong credentials, unknown national IDs and other services are errors (lax: warnings)</span>
          </span>
        </label>
        <label className="row">
          <input type="checkbox" checked={value.callbackOnExpired} disabled={disabled} onChange={(e) => set({ ...value, callbackOnExpired: e.target.checked })} />
          <span>
            Callback on EXPIRED <span className="hint">real Nafath sends none</span>
          </span>
        </label>
      </div>
    </>
  );
}

function NafathSettings({ slug, inst, reload }: { slug: string; inst: NafathInstance; reload: () => void }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const [name, setName] = useState(inst.name);
  const [appId, setAppId] = useState(inst.appId);
  const [appKey, setAppKey] = useState(inst.appKey);
  const [draft, setDraft] = useState<Draft>(() => draftOf(inst.config, inst.strict));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== inst.name || appId !== inst.appId || appKey !== inst.appKey || JSON.stringify(draft) !== JSON.stringify(draftOf(inst.config, inst.strict));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await nafathApi.updateInstance(slug, inst.slug, {
        name,
        strict: draft.strict,
        config: configOf(draft),
        ...(appId !== inst.appId ? { appId } : {}),
        ...(appKey !== inst.appKey ? { appKey } : {}),
      });
      toast('Saved');
      reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const revert = () => {
    setName(inst.name);
    setAppId(inst.appId);
    setAppKey(inst.appKey);
    setDraft(draftOf(inst.config, inst.strict));
  };
  const off = !!gate.disabled;
  return (
    <div className="card card-pad stack">
      <ErrorBox error={error} />
      <div className="form form-2">
        <label className="field">
          Name
          <input value={name} disabled={off} onChange={(e) => setName(e.target.value)} />
        </label>
        <span />
        <label className="field">
          APP-ID <span className="hint">unique across the hub (host mode finds the instance by it)</span>
          <input value={appId} disabled={off} onChange={(e) => setAppId(e.target.value)} />
        </label>
        <label className="field">
          APP-KEY
          <input value={appKey} disabled={off} onChange={(e) => setAppKey(e.target.value)} />
        </label>
      </div>
      <ConfigFields value={draft} set={setDraft} disabled={off} />
      <div className="row">
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty || off} title={gate.title}>
          Save
        </button>
        {dirty && (
          <button className="btn ghost" onClick={revert}>
            Revert
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- Requests ----------------

const STATUS_KIND: Record<NafathStatus, string> = { WAITING: 'accent', COMPLETED: 'ok', REJECTED: 'bad', EXPIRED: 'warn' };
const STATUS_ICON: Record<NafathStatus, string> = { WAITING: 'clock', COMPLETED: 'check', REJECTED: 'close', EXPIRED: 'info' };

function StatusBadge({ r }: { r: NafathRequest }) {
  const reason = r.reason && r.reason !== 'rejected' && r.reason !== 'expired' ? r.reason.replace(/_/g, ' ') : null;
  return (
    <Badge kind={STATUS_KIND[r.status]} title={r.decidedBy ? `Decided by ${r.decidedBy}` : undefined}>
      <span className="nafath-status">
        <Icon name={STATUS_ICON[r.status]} size={12} />
        {r.status}
        {reason ? ` (${reason})` : ''}
      </span>
    </Badge>
  );
}

function CallbackCell({ r }: { r: NafathRequest }) {
  if (!r.callback.length) return <span className="faint">none</span>;
  const last = r.callback[r.callback.length - 1];
  const ok = last.status !== null && last.status >= 200 && last.status < 300;
  return (
    <span title={last.error ?? last.url}>
      {plural(r.callback.length, 'attempt')} · <span className={ok ? '' : 'nafath-bad'}>{last.status ?? 'no answer'}</span>
    </span>
  );
}

function NafathRequests({ slug, inst }: { slug: string; inst: NafathInstance }) {
  const toast = useToast();
  const gate = useGate(slug)('walkthroughs.run');
  const users = useProjectMaybe()?.overview.users ?? [];
  const list = useNafathFetch<NafathRequest[]>(slug, `${nafathBase(slug)}/requests?instance=${encodeURIComponent(inst.slug)}&limit=100`);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (r: NafathRequest, label: string, fn: () => Promise<unknown>) => {
    setBusy(r.id);
    try {
      await fn();
      toast(label);
      list.reload();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? 'unknown user') : null);
  const rows = list.data ?? [];
  return (
    <div className="stack">
      <ErrorBox error={list.error} />
      <div className="card">
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No requests yet">
            <p className="small muted">
              Requests appear here live when the app calls <code>POST {inst.urls.request}</code> with a test user's national ID.
            </p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="nafath-table">
              <caption className="nafath-caption">{plural(rows.length, 'request')} (newest first, updated live)</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">User / national ID</th>
                  <th scope="col">Service</th>
                  <th scope="col">Status</th>
                  <th scope="col">Number</th>
                  <th scope="col">Callback</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = userName(r.testUserId);
                  const disabled = busy === r.id || !!gate.disabled;
                  return (
                    <tr key={r.id}>
                      <td className="small nowrap" title={r.createdAt}>
                        {fmtTime(r.createdAt)}
                      </td>
                      <td className="small">
                        {name ?? <span className="faint">unassigned</span>}
                        <div>
                          <code className="faint">{r.nationalId}</code>
                        </div>
                      </td>
                      <td className="small">{r.service ?? <span className="faint">-</span>}</td>
                      <td>
                        <StatusBadge r={r} />
                      </td>
                      <td className="small nowrap">
                        <code className="nafath-number">{r.random}</code>
                        {r.chosen && r.chosen !== r.random && <span className="faint"> picked {r.chosen}</span>}
                      </td>
                      <td className="small nowrap">
                        <CallbackCell r={r} />
                      </td>
                      <td>
                        {r.status === 'WAITING' ? (
                          <div className="row nafath-actions">
                            <button className="btn xs primary" onClick={() => void act(r, 'Approved', () => nafathApi.approve(slug, r.id))} disabled={disabled} title={gate.title} aria-label={`Approve request ${r.transId}`}>
                              Approve
                            </button>
                            <span className="nafath-choices" role="group" aria-label={`Choose a number for request ${r.transId}`}>
                              {r.choices.map((n) => (
                                <button
                                  key={n}
                                  className="btn xs"
                                  onClick={() => void act(r, n === r.random ? 'Right number: approved' : 'Wrong number: rejected', () => nafathApi.choose(slug, r.id, n))}
                                  disabled={disabled}
                                  title={gate.title ?? (n === r.random ? 'The right number' : 'A wrong number')}
                                  aria-label={`Choose ${n}`}
                                >
                                  {n}
                                </button>
                              ))}
                            </span>
                            <button className="btn xs ghost" onClick={() => void act(r, 'Rejected', () => nafathApi.reject(slug, r.id))} disabled={disabled} title={gate.title} aria-label={`Reject request ${r.transId}`}>
                              Reject
                            </button>
                          </div>
                        ) : inst.config.callbackUrl ? (
                          <button className="btn xs ghost" onClick={() => void act(r, 'Callback sent', () => nafathApi.resendCallback(slug, r.id))} disabled={disabled} title={gate.title} aria-label={`Resend the callback of request ${r.transId}`}>
                            Resend callback
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Faults ----------------

interface FaultDraft {
  kind: string;
  arg: string;
  scope: 'instance' | 'any';
  user: string;
  nationalId: string;
  service: string;
  times: string;
}

/** The argument a fault takes, from the reference ("slow:<ms>" → required, "approve[:<ms>]" → optional). */
function argOf(help: string | undefined): { required: boolean } | null {
  if (!help?.includes(':')) return null;
  return { required: !help.includes('[') };
}

function NafathFaults({ slug, inst, overview }: { slug: string; inst: NafathInstance; overview: NafathOverview }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const users = useProjectMaybe()?.overview.users ?? [];
  const list = useNafathFetch<NafathRule[]>(slug, `${nafathBase(slug)}/faults`);
  const [draft, setDraft] = useState<FaultDraft>({ kind: 'rejected', arg: '', scope: 'instance', user: '', nationalId: '', service: '', times: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kinds = overview.reference.faultKinds.filter((k) => k !== 'none');
  const helpOf = (kind: string) => overview.reference.faults.find((f) => f.fault.split(/[[:]/)[0] === kind);
  const help = helpOf(draft.kind);
  const arg = argOf(help?.fault);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await nafathApi.addFault(slug, {
        fault: arg && draft.arg.trim() ? `${draft.kind}:${draft.arg.trim()}` : draft.kind,
        instance: draft.scope === 'instance' ? inst.slug : undefined,
        user: draft.user || undefined,
        nationalId: draft.nationalId.trim() || undefined,
        service: draft.service.trim() || undefined,
        times: draft.times ? Number(draft.times) : undefined,
      });
      toast('Fault added');
      setDraft({ ...draft, arg: '', nationalId: '', service: '', times: '' });
      list.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: NafathRule) => {
    try {
      await nafathApi.deleteFault(slug, r.id);
      list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const clear = async () => {
    if (!window.confirm('Delete every Nafath fault rule of the project?')) return;
    try {
      const r = await nafathApi.clearFaults(slug);
      toast(`${plural(r.deleted, 'fault rule')} deleted`);
      list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const rows = (list.data ?? []).filter((r) => !r.instanceId || r.instanceId === inst.id);
  const off = !!gate.disabled;
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>Add a fault</h3>
        <p className="small muted">The next matching requests get the fault instead of the normal answer. Leave a match field empty to match any value.</p>
        <ErrorBox error={error} />
        <div className="form form-3">
          <label className="field">
            Fault
            <select value={draft.kind} disabled={off} onChange={(e) => setDraft({ ...draft, kind: e.target.value, arg: '' })}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {arg && (
            <label className="field">
              Milliseconds <span className="hint">{arg.required ? 'required' : 'optional: empty = at once'}</span>
              <input type="number" min={0} value={draft.arg} disabled={off} onChange={(e) => setDraft({ ...draft, arg: e.target.value })} placeholder="ms" />
            </label>
          )}
          <label className="field">
            Instance
            <select value={draft.scope} disabled={off} onChange={(e) => setDraft({ ...draft, scope: e.target.value as FaultDraft['scope'] })}>
              <option value="instance">This instance ({inst.slug})</option>
              <option value="any">Any instance</option>
            </select>
          </label>
          <label className="field">
            Test user
            <select value={draft.user} disabled={off} onChange={(e) => setDraft({ ...draft, user: e.target.value })}>
              <option value="">Any user</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            National ID
            <input value={draft.nationalId} disabled={off} inputMode="numeric" onChange={(e) => setDraft({ ...draft, nationalId: e.target.value })} placeholder="any" />
          </label>
          <label className="field">
            Service
            <input value={draft.service} disabled={off} onChange={(e) => setDraft({ ...draft, service: e.target.value })} placeholder="any" />
          </label>
          <label className="field">
            Times <span className="hint">empty = every request</span>
            <input type="number" min={1} value={draft.times} disabled={off} onChange={(e) => setDraft({ ...draft, times: e.target.value })} placeholder="every" />
          </label>
        </div>
        {help && (
          <p className="small muted">
            <code>{help.fault}</code> ({help.stage}): {help.effect}
          </p>
        )}
        <div className="row">
          <button className="btn primary" onClick={() => void add()} disabled={busy || !draft.kind || (!!arg?.required && !draft.arg.trim()) || off} title={gate.title}>
            Add fault
          </button>
        </div>
      </div>
      <ErrorBox error={list.error} />
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{plural(rows.length, 'fault rule')}</h3>
          <button className="btn sm ghost" onClick={() => void clear()} disabled={!list.data?.length || off} title={gate.title}>
            Clear all
          </button>
        </div>
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No faults">
            <p className="small muted">Every request gets the normal answer.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="nafath-table">
              <caption className="sr-only">Nafath fault rules of {inst.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Fault</th>
                  <th scope="col">Matches</th>
                  <th scope="col">Left / hits</th>
                  <th scope="col">Added</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const match = [
                    r.instanceId ? `instance ${inst.slug}` : null,
                    r.match.user ? `user ${userName(r.match.user)}` : null,
                    r.match.nationalId ? `ID ${r.match.nationalId}` : null,
                    r.match.service ? `service ${r.match.service}` : null,
                  ].filter(Boolean);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Badge kind="accent">{r.fault}</Badge>
                        {r.runId && <Badge title="Only for one test run">run</Badge>}
                      </td>
                      <td className="small">{match.length ? match.join(' · ') : <span className="faint">every request</span>}</td>
                      <td className="small">
                        {r.remaining ?? 'always'} / {r.hits}
                      </td>
                      <td className="small faint nowrap">{timeAgo(r.createdAt)}</td>
                      <td>
                        <button className="btn xs ghost" onClick={() => void remove(r)} aria-label={`Delete fault ${r.fault}`} {...gate}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- add modal ----------------

const DEFAULT_DRAFT: Draft = draftOf(NAFATH_DEFAULTS, false);
/** The add form keeps strings: config fields are stored as `cfg.<key>`, booleans as '1' / '0'. */
function draftFromForm(form: Record<string, string | string[]>): Draft {
  const s = (k: keyof Draft) => form[`cfg.${k}`] as string | undefined;
  const b = (k: keyof Draft, def: boolean) => (s(k) === undefined ? def : s(k) === '1');
  const n = (k: keyof Draft, def: number) => (s(k) !== undefined ? Number(s(k)) : def);
  return {
    callbackUrl: s('callbackUrl') ?? DEFAULT_DRAFT.callbackUrl,
    ttlSeconds: n('ttlSeconds', DEFAULT_DRAFT.ttlSeconds),
    autoDecision: (s('autoDecision') as AutoDecision | undefined) ?? DEFAULT_DRAFT.autoDecision,
    autoDelayMs: n('autoDelayMs', DEFAULT_DRAFT.autoDelayMs),
    services: s('services') ?? DEFAULT_DRAFT.services,
    callbackFields: (s('callbackFields') as Draft['callbackFields'] | undefined) ?? DEFAULT_DRAFT.callbackFields,
    callbackOnExpired: b('callbackOnExpired', DEFAULT_DRAFT.callbackOnExpired),
    wrongNumberCooldownSeconds: n('wrongNumberCooldownSeconds', DEFAULT_DRAFT.wrongNumberCooldownSeconds),
    statusLagMs: n('statusLagMs', DEFAULT_DRAFT.statusLagMs),
    strict: b('strict', DEFAULT_DRAFT.strict),
  };
}
function formFromDraft(form: Record<string, string | string[]>, d: Draft): Record<string, string | string[]> {
  const out = { ...form };
  for (const [k, v] of Object.entries(d)) out[`cfg.${k}`] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  return out;
}

/** Add-modal fields: name, slug and the instance config. */
export function NafathAddFields({ form, set }: { preset: string; form: Record<string, string | string[]>; set: (f: Record<string, string | string[]>) => void }) {
  return (
    <>
      <div className="form form-2">
        <label className="field">
          Name
          <input value={(form.name as string) ?? ''} placeholder="Nafath" onChange={(e) => set({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          Slug <span className="hint">part of the URL</span>
          <input value={(form.slug as string) ?? ''} placeholder="nafath" onChange={(e) => set({ ...form, slug: e.target.value })} />
        </label>
      </div>
      <p className="small muted">APP-ID, APP-KEY and the signing key are generated; change them later in Settings.</p>
      <ConfigFields value={draftFromForm(form)} set={(d) => set(formFromDraft(form, d))} />
    </>
  );
}

/** CategoryDef for PROVIDER_CATEGORIES (typed structurally to avoid importing the page). */
export const NAFATH_CATEGORY = {
  id: CATEGORY,
  label: 'Nafath',
  sub: 'Saudi national SSO',
  noun: 'Nafath instance',
  description: 'Fake Nafath (Saudi national SSO, MFA API): start a request with a national ID, pick the number in the fake Nafath app (here, the test user’s workspace or the extension), then get the signed callback and /status, /info and the JWK set like the real Elm service.',
  emptyText: 'Add a fake Nafath instance, point your app’s Nafath base URL at it with the APP-ID / APP-KEY it shows, and sign in test users without a real Elm account.',
  icon: (size: number) => <Icon name="shield" size={size} />,
  guidePrefix: 'nafath',
  status: (d: { slug: string }) => ({ n: cachedCount(d.slug), problems: [] as string[] }),
  options: () => [{ id: 'nafath', name: 'Nafath', description: 'Elm Nafath MFA API: request, status, info and JWK, with signed callbacks.', available: true }],
  AddFields: NafathAddFields,
  create: async (d: { slug: string }, _preset: string, form: Record<string, string | string[]>) => {
    const draft = draftFromForm(form);
    const i = await nafathApi.createInstance(d.slug, {
      name: (form.name as string) || undefined,
      slug: (form.slug as string) || undefined,
      strict: draft.strict,
      config: configOf(draft),
    });
    return i.slug;
  },
  Panel: NafathCategory,
};

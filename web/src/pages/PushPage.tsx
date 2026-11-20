import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon, Menu } from '../components/people';
import { CopyUrl, providersPath } from '../components/providerLayout';
import { PushList, usePushReload } from '../components/PushInbox';
import { Badge, CodeBlock, Empty, ErrorBox, timeAgo, useCopy, useToast } from '../components/ui';
import { useProject } from '../context';
import { useFetch } from '../hooks';
import { pushApi, pushBase, splitList, type PushConnect, type PushDevice, type PushInstance, type PushOverview, type PushPlatform, type PushReference, type PushRule } from '../pushApi';
import { Page } from './ProjectPage';
import '../styles/push.css';

type Tab = 'inbox' | 'devices' | 'faults' | 'connect';
const TABS: { id: Tab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'devices', label: 'Devices' },
  { id: 'faults', label: 'Faults' },
  { id: 'connect', label: 'Connect' },
];
const STATUSES = ['delivered', 'collapsed', 'dropped', 'rejected', 'validated', 'no_subscribers'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Known fault ids (server/src/push/faults.ts FAULT_HELP); /api/push-reference replaces this list once it loads. */
const KNOWN_FAULTS = ['unregistered', 'bad_token', 'quota[:secs]', 'unavailable', 'internal', 'auth', 'sender_mismatch', 'payload_too_large', 'topic_disallowed', 'timeout', 'drop', 'slow:<ms>'];
/** A FAULT_HELP spec as a ready-to-use value: "quota[:secs]" → "quota", "slow:<ms>" → "slow:2000". */
const faultValue = (spec: string) => spec.replace(/\[.*\]/, '').replace('<ms>', '2000');
const CUSTOM_FAULT = '__custom';

/** /p/:slug/push — fake FCM HTTP v1 and APNs: inbox per user / device, devices, faults, connect. */
export default function PushPage() {
  const { slug } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'inbox') as Tab;
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'inbox') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );
  const ov = useFetch<PushOverview>(pushBase(slug), [slug]);
  usePushReload(slug, () => void ov.reload());
  const unread = Object.values(ov.data?.unread ?? {}).reduce((a, b) => a + b, 0);
  return (
    <Page
      title="Push"
      description="Fake Firebase Cloud Messaging (HTTP v1) and Apple Push Notification service. Your backend sends pushes as usual; they land in each test user's inbox, with lint, faults and a lock-screen preview."
      actions={
        <Link className="btn" to={providersPath(slug, 'push')}>
          <Icon name="plug" size={14} /> Push providers
        </Link>
      }
    >
      <ErrorBox error={ov.error} />
      <div className="tabs push-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'inbox' && unread > 0 && <span className="tab-n">{unread}</span>}
            {t.id === 'devices' && ov.data && <span className={`tab-n ${ov.data.devices ? '' : 'zero'}`}>{ov.data.devices}</span>}
            {t.id === 'faults' && !!ov.data?.faults && <span className="tab-n">{ov.data.faults}</span>}
          </button>
        ))}
      </div>
      {ov.data && !ov.data.instances.length && tab !== 'connect' && <NoInstances slug={slug} />}
      {tab === 'inbox' && <InboxTab />}
      {tab === 'devices' && <DevicesTab instances={ov.data?.instances ?? []} />}
      {tab === 'faults' && <FaultsTab instances={ov.data?.instances ?? []} />}
      {tab === 'connect' && <ConnectTab instances={ov.data?.instances ?? []} reload={() => void ov.reload()} />}
    </Page>
  );
}

function NoInstances({ slug }: { slug: string }) {
  const toast = useToast();
  const add = (preset: 'fcm' | 'apns') =>
    void pushApi
      .createInstance(slug, { preset })
      .then(() => toast(preset === 'fcm' ? 'FCM instance added' : 'APNs instance added'))
      .catch((e) => toast(errText(e)));
  return (
    <div className="card card-pad stack push-start">
      <h3>Set up push</h3>
      <p className="small muted">Add a fake FCM project (Android, web and iOS through Firebase) or a fake APNs key (iOS direct). You get a service-account JSON or a .p8 key that points at stubyard.</p>
      <div className="row">
        <button className="btn primary" onClick={() => add('fcm')}>
          Add FCM
        </button>
        <button className="btn" onClick={() => add('apns')}>
          Add APNs
        </button>
      </div>
    </div>
  );
}

// ---------------- Inbox ----------------

function InboxTab() {
  const { slug, overview } = useProject();
  const [params, setParams] = useSearchParams();
  const user = params.get('user') ?? '';
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [contains, setContains] = useState('');
  const toast = useToast();
  const setUser = (u: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (u) n.set('user', u);
        else n.delete('user');
        return n;
      },
      { replace: true },
    );
  return (
    <div className="card push-inbox">
      <div className="filters">
        <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="Test user">
          <option value="">All users</option>
          <option value="unassigned">Unassigned</option>
          {overview.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
          <option value="">FCM + APNs</option>
          <option value="fcm">FCM</option>
          <option value="apns">APNs</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Title or body…" value={contains} onChange={(e) => setContains(e.target.value)} aria-label="Search" />
        <Menu label={<Icon name="menu" size={15} />} floating className="btn sm push-more" title="More actions">
          {(close) => (
            <button
              className="menu-item"
              onClick={() => {
                close();
                void pushApi
                  .clear(slug, user || undefined)
                  .then((r) => toast(`${r.deleted} push${r.deleted === 1 ? '' : 'es'} deleted`))
                  .catch((e) => toast(errText(e)));
              }}
            >
              Clear {user ? "this user's" : 'all'} pushes
            </button>
          )}
        </Menu>
      </div>
      <PushList slug={slug} q={{ user: user || undefined, provider: provider || undefined, status: status || undefined, contains: contains || undefined, limit: 200 }} />
    </div>
  );
}

// ---------------- Devices ----------------

function DevicesTab({ instances }: { instances: PushInstance[] }) {
  const { slug, overview } = useProject();
  const devices = useFetch<PushDevice[]>(`${pushBase(slug)}/devices`, [slug]);
  usePushReload(slug, () => void devices.reload());
  const toast = useToast();
  const copy = useCopy();
  const [form, setForm] = useState<{ user: string; platform: PushPlatform; instance: string; topics: string; name: string }>({ user: '', platform: 'android', instance: '', topics: '', name: '' });
  const act = (p: Promise<unknown>, msg: string) => void p.then(() => (toast(msg), devices.reload())).catch((e) => toast(errText(e)));
  const add = () =>
    act(
      pushApi.addDevice(slug, { user: form.user || undefined, platform: form.platform, instance: form.instance || undefined, topics: splitList(form.topics), name: form.name || undefined }),
      'Device registered',
    );
  const list = devices.data ?? [];
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>Register a test device</h3>
        <div className="push-form">
          <label>
            <span className="small muted">User</span>
            <select value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })}>
              <option value="">Unassigned</option>
              {overview.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="small muted">Platform</span>
            <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as PushPlatform })}>
              <option value="android">Android</option>
              <option value="ios">iOS</option>
              <option value="web">Web</option>
            </select>
          </label>
          <label>
            <span className="small muted">Instance</span>
            <select value={form.instance} onChange={(e) => setForm({ ...form, instance: e.target.value })}>
              <option value="" title="The platform's default instance">Default</option>
              {instances.map((i) => (
                <option key={i.id} value={i.slug}>
                  {i.name} ({i.preset === 'fcm' ? 'FCM' : 'APNs'})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="small muted">Name</span>
            <input value={form.name} placeholder="Pixel 9" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="push-form-wide">
            <span className="small muted">FCM topics</span>
            <input value={form.topics} placeholder="news, offers" onChange={(e) => setForm({ ...form, topics: e.target.value })} />
          </label>
          <button className="btn primary" onClick={add} disabled={!instances.length}>
            Register
          </button>
        </div>
        <p className="small faint">stubyard makes a realistic token (FCM registration token or 64-hex APNs token). Store it as the user's push token in your app, or let the app register real tokens through your own API.</p>
      </div>
      <ErrorBox error={devices.error} />
      {devices.data && !list.length && <Empty title="No devices yet">Register one above, or send to any token: unknown tokens become unassigned devices.</Empty>}
      {list.length > 0 && (
        <div className="card table-wrap">
          <table className="push-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>User</th>
                <th>Token</th>
                <th>Topics</th>
                <th>Last push</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className={d.state === 'unregistered' ? 'push-off' : ''}>
                  <td data-label="Device">
                    <strong>{d.name}</strong>
                    <div className="small faint">
                      {d.platform} · {d.instance?.slug ?? '—'}
                      {d.auto && ' · auto'}
                    </div>
                    {d.state === 'unregistered' && <Badge kind="bad">unregistered</Badge>}
                    {d.run && <Badge kind="accent">run {d.run}</Badge>}
                  </td>
                  <td data-label="User">{d.user ? <Link to={`/p/${slug}/users/${d.user.id}`}>{d.user.name}</Link> : <span className="faint">Unassigned</span>}</td>
                  <td data-label="Token">
                    <button className="cred push-token" onClick={() => copy(d.token, 'Token copied')} title={d.token}>
                      {d.token.slice(0, 10)}…{d.token.slice(-6)}
                    </button>
                  </td>
                  <td data-label="Topics" className="small">
                    {d.topics.length ? d.topics.join(', ') : <span className="faint">—</span>}
                  </td>
                  <td data-label="Last push" className="small nowrap">
                    {d.lastPushAt ? timeAgo(d.lastPushAt) : <span className="faint">never</span>}
                  </td>
                  <td className="push-actions">
                    <Menu label={<Icon name="menu" size={15} />} floating>
                      {(close) => (
                        <>
                          <Link className="menu-item" to={`/p/${slug}/push?user=${d.user?.id ?? 'unassigned'}`} onClick={close}>
                            Pushes
                          </Link>
                          <button className="menu-item" onClick={() => (close(), act(pushApi.setRegistered(slug, d.id, d.state === 'unregistered'), d.state === 'unregistered' ? 'Registered again' : 'Unregistered: sends now fail like an uninstalled app'))}>
                            {d.state === 'unregistered' ? 'Register again' : 'Unregister (uninstall)'}
                          </button>
                          <button
                            className="menu-item"
                            onClick={() => {
                              close();
                              const t = window.prompt('Topics (comma separated)', d.topics.join(', '));
                              if (t === null) return;
                              const next = splitList(t);
                              act(pushApi.topics(slug, d.id, next.filter((x) => !d.topics.includes(x)), d.topics.filter((x) => !next.includes(x))), 'Topics saved');
                            }}
                          >
                            Edit topics
                          </button>
                          <button className="menu-item danger" onClick={() => (close(), act(pushApi.deleteDevice(slug, d.id), 'Device deleted'))}>
                            Delete
                          </button>
                        </>
                      )}
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- Faults ----------------

function FaultsTab({ instances }: { instances: PushInstance[] }) {
  const { slug, overview } = useProject();
  const rules = useFetch<PushRule[]>(`${pushBase(slug)}/faults`, [slug]);
  const ref = useFetch<PushReference>('/api/push-reference');
  usePushReload(slug, () => void rules.reload());
  const toast = useToast();
  const [f, setF] = useState({ fault: 'unregistered', user: '', topic: '', instance: '', times: '' });
  const [custom, setCustom] = useState(false);
  const known = (ref.data?.faults.map((x) => x.fault) ?? KNOWN_FAULTS).map(faultValue);
  const act = (p: Promise<unknown>, msg: string) => void p.then(() => (toast(msg), rules.reload())).catch((e) => toast(errText(e)));
  const list = rules.data ?? [];
  const help = (ref.data?.faults ?? []).find((x) => x.fault.split(/[:[]/)[0] === f.fault.split(':')[0]);
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>Make sends fail</h3>
        <div className="push-form">
          <label>
            <span className="small muted">Fault</span>
            <select
              value={custom || !known.includes(f.fault) ? CUSTOM_FAULT : f.fault}
              onChange={(e) => {
                const v = e.target.value;
                setCustom(v === CUSTOM_FAULT);
                setF({ ...f, fault: v === CUSTOM_FAULT ? '' : v });
              }}
            >
              {known.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
              <option value={CUSTOM_FAULT}>Custom…</option>
            </select>
          </label>
          {(custom || !known.includes(f.fault)) && (
            <label>
              <span className="small muted">Custom fault</span>
              <input value={f.fault} placeholder="e.g. quota:30" spellCheck={false} onChange={(e) => setF({ ...f, fault: e.target.value })} />
            </label>
          )}
          <label>
            <span className="small muted">User</span>
            <select value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })}>
              <option value="">Any</option>
              {overview.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="small muted">Topic</span>
            <input value={f.topic} placeholder="any" onChange={(e) => setF({ ...f, topic: e.target.value })} />
          </label>
          <label>
            <span className="small muted">Instance</span>
            <select value={f.instance} onChange={(e) => setF({ ...f, instance: e.target.value })}>
              <option value="">Any</option>
              {instances.map((i) => (
                <option key={i.id} value={i.slug}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="small muted">Times</span>
            <input inputMode="numeric" value={f.times} placeholder="every send" onChange={(e) => setF({ ...f, times: e.target.value })} />
          </label>
          <button
            className="btn primary"
            onClick={() =>
              act(pushApi.addFault(slug, { fault: f.fault, user: f.user || undefined, topic: f.topic || undefined, instance: f.instance || undefined, times: f.times ? Number(f.times) : undefined }), 'Fault rule added')
            }
          >
            Add rule
          </button>
        </div>
        {help && (
          <p className="small muted">
            FCM: {help.fcm} · APNs: {help.apns}
          </p>
        )}
        <p className="small faint">
          One request only: send the header <code>X-Hub-Scenario: quota</code> (or any fault). Inside a test run, rules added with <code>?run=&lt;key&gt;</code> apply to that run only.
        </p>
      </div>
      <ErrorBox error={rules.error} />
      {list.length > 0 && (
        <div className="card table-wrap">
          <table className="push-table">
            <thead>
              <tr>
                <th>Fault</th>
                <th>Matches</th>
                <th>Left</th>
                <th>Hits</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className={r.remaining === 0 ? 'push-off' : ''}>
                  <td data-label="Fault">
                    <code>{r.fault}</code> {r.run && <Badge kind="accent">run {r.run}</Badge>}
                  </td>
                  <td data-label="Matches" className="small">
                    {[r.userName && `user ${r.userName}`, r.match.token && `token …${r.match.token.slice(-6)}`, r.match.topic && `topic ${r.match.topic}`, r.instance && `instance ${r.instance}`].filter(Boolean).join(' · ') || 'every send'}
                  </td>
                  <td data-label="Left">{r.remaining ?? '∞'}</td>
                  <td data-label="Hits">{r.hits}</td>
                  <td className="push-actions">
                    <button className="btn sm ghost" onClick={() => act(pushApi.deleteFault(slug, r.id), 'Rule removed')} aria-label="Remove rule">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 0 && (
        <div>
          <button className="btn sm" onClick={() => act(pushApi.clearFaults(slug), 'All fault rules removed')}>
            Remove all rules
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- Connect ----------------

function ConnectTab({ instances, reload }: { instances: PushInstance[]; reload: () => void }) {
  const { slug } = useProject();
  const [sel, setSel] = useState<string | null>(null);
  const current = instances.find((i) => i.slug === sel) ?? instances[0];
  if (!instances.length) return <NoInstances slug={slug} />;
  return (
    <div className="stack">
      {instances.length > 1 && (
        <div className="chips">
          {instances.map((i) => (
            <button key={i.id} className={`chip ${current?.id === i.id ? 'active' : ''}`} onClick={() => setSel(i.slug)}>
              {i.name} <span className="n">{i.preset}</span>
            </button>
          ))}
        </div>
      )}
      {current && <InstanceConnect key={current.id} slug={slug} inst={current} reload={reload} />}
    </div>
  );
}

export function InstanceConnect({ slug, inst, reload }: { slug: string; inst: PushInstance; reload?: () => void }) {
  const c = useFetch<PushConnect>(`${pushBase(slug)}/instances/${encodeURIComponent(inst.slug)}/connect`, [slug, inst.slug, inst.config.keyId, inst.config.privateKeyId]);
  const toast = useToast();
  const d = c.data;
  const fcm = inst.preset === 'fcm';
  const urlRows = d ? Object.entries(d.urls).filter(([, v]) => typeof v === 'string') : [];
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <div className="row">
          <h3 className="grow">
            {inst.name} <span className="faint small">{fcm ? `FCM · ${inst.config.fcmProjectId}` : `APNs · team ${inst.config.teamId} · key ${inst.config.keyId}`}</span>
          </h3>
          {inst.strict ? <Badge kind="warn">strict</Badge> : <Badge>lax</Badge>}
          <button
            className="btn sm"
            onClick={() =>
              void pushApi
                .updateInstance(slug, inst.slug, { strict: !inst.strict })
                .then(() => (toast(inst.strict ? 'Lax: auth problems are warnings' : 'Strict: answers like the real service'), reload?.()))
                .catch((e) => toast(errText(e)))
            }
          >
            {inst.strict ? 'Make lax' : 'Make strict'}
          </button>
        </div>
        <ErrorBox error={c.error} />
        {urlRows.map(([k, v]) => (
          <div key={k} className="row nowrap push-url">
            <span className="small muted push-url-k">{k}</span>
            <CopyUrl url={String(v)} className="push-url-full" />
          </div>
        ))}
        {!fcm && d && !d.urls.apns && <p className="small warn-text">The APNs HTTP/2 listener is off (STUBYARD_APNS_PORT=0). Only the HTTP/1.1 route works.</p>}
        <div className="row">
          {fcm ? (
            <a className="btn primary" href={`${pushBase(slug)}/instances/${encodeURIComponent(inst.slug)}/service-account.json`}>
              Download service-account JSON
            </a>
          ) : (
            <>
              <a className="btn primary" href={`${pushBase(slug)}/instances/${encodeURIComponent(inst.slug)}/apns-key.p8`}>
                Download .p8 key
              </a>
              {d?.caUrl && (
                <a className="btn" href={d.caUrl}>
                  stubyard CA
                </a>
              )}
            </>
          )}
          <button
            className="btn ghost"
            onClick={() =>
              void pushApi
                .rotateKey(slug, inst.slug)
                .then(() => (toast('New key: download it again'), reload?.()))
                .catch((e) => toast(errText(e)))
            }
          >
            Rotate key
          </button>
        </div>
      </div>
      {d && <CodeBlock title=".env" code={Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join('\n')} />}
      {d?.snippets.map((s) => <CodeBlock key={s.title} title={s.title} code={s.code} />)}
    </div>
  );
}

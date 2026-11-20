import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, type Message, type TestUser } from '../api';
import { LintBadges } from '../components/Lint';
import { Icon } from '../components/people';
import { LogDrawer, TrafficLog } from '../components/TrafficLog';
import { Badge, ChannelIcon, Empty, ErrorBox, Modal, fmtBytes, timeAgo, useCopy, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Page } from './ProjectPage';
import '../styles/runs.css';

// Types live here (not in api.ts) to keep this feature self-contained.
export interface RunView {
  id: string;
  projectId: string;
  key: string;
  label: string;
  status: 'active' | 'stopped';
  captureUnattributed: boolean;
  claims: string[];
  meta: Record<string, unknown>;
  startedAt: string;
  stoppedAt: string | null;
  expiresAt: string;
  counts: { users: number; messages: number; logs: number; problems: number };
  urls: { mockPrefix: string; hookPrefix: string; smtpUsername: string };
  header: Record<string, string>;
  users?: TestUser[];
}

export interface RunReport {
  run: { id: string; key: string; label: string; status: string; startedAt: string; stoppedAt: string | null; durationMs: number };
  messages: { total: number; byChannel: Record<string, number>; byStatus: Record<string, number> };
  traffic: { total: number; byOutcome: Record<string, number>; problems: { id: string; method: string | null; url: string | null; resStatus: number | null; outcome: string; errorMessage: string | null }[] };
  rules: { id: string; owner: string; description: string; hits: number }[];
  mocks: { mock: string; scenario: string; hits: number }[];
  /** File storage traffic of the run (absent when the run touched no storage). */
  storage?: {
    uploads: number;
    bytes: number;
    downloads: number;
    deletes: number;
    items: { op: string; bucket: string | null; key: string | null; size: number | null; contentType: string | null; status: number | null; logId: string }[];
    rules: { id: string; instance: string; action: string; op: string; hits: number; label: string | null }[];
  };
  warnings: string[];
}

const RELOAD_ON = ['runs.changed', 'message.created', 'message.updated', 'log.created', 'user.changed', 'project.reset', 'rules.changed', 'mocks.changed', 'storage.changed'];

/** /p/:slug/runs — test runs (one per parallel test worker). */
export default function RunsPage() {
  return (
    <Routes>
      <Route index element={<RunList />} />
      <Route path=":run" element={<RunDetail />} />
    </Routes>
  );
}

function duration(from: string, to: string | null): string {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function RunList() {
  const { slug } = useProject();
  const [status, setStatus] = useState<'' | 'active' | 'stopped'>('');
  const runs = useFetch<RunView[]>(`/api/projects/${slug}/runs${status ? `?status=${status}` : ''}`, [slug, status]);
  const reload = useDebounced(() => void runs.reload(), 300);
  useHubEvents(slug, (e) => {
    if (RELOAD_ON.includes(e.type)) reload();
  });
  useTick(15_000);
  const nav = useNavigate();
  const [starting, setStarting] = useState(false);
  const list = runs.data ?? [];

  return (
    <Page
      title="Test runs"
      description={
        <>
          Isolate parallel test workers: each run has its own test users, scenario rules and mock scenarios. Messages to a run’s users, requests with{' '}
          <code>X-Hub-Run: &lt;key&gt;</code>, URLs under <code>/run/&lt;key&gt;/…</code> and SMTP username <code>{slug}+&lt;key&gt;</code> belong to the run.
        </>
      }
      actions={
        <button className="btn primary" onClick={() => setStarting(true)}>
          <Icon name="plus" size={14} /> Start run
        </button>
      }
    >
      <ErrorBox error={runs.error} />
      <div className="chips runs-filter">
        {(['', 'active', 'stopped'] as const).map((s) => (
          <button key={s || 'all'} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
            {s || 'All'}
          </button>
        ))}
      </div>
      {list.length === 0 && !runs.loading ? (
        <div className="card">
          <Empty title="No test runs">
            <p className="muted">
              Start one from your test setup with <code>POST /api/projects/{slug}/runs</code> (or the MCP tool <code>start_run</code>) and use the users it returns.
            </p>
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Status</th>
                <th>Age</th>
                <th className="col-sm">Users</th>
                <th className="col-sm">Messages</th>
                <th>Problems</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/p/${slug}/runs/${r.id}`)}>
                  <td className="mono">
                    <Link to={`/p/${slug}/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      {r.key}
                    </Link>
                    {r.captureUnattributed && (
                      <>
                        {' '}
                        <Badge title="Captures traffic no other run claims">default</Badge>
                      </>
                    )}
                  </td>
                  <td className="ellipsis">{r.label || <span className="faint">—</span>}</td>
                  <td>
                    <Badge kind={r.status === 'active' ? 'ok' : ''}>{r.status}</Badge>
                  </td>
                  <td className="small faint" title={r.startedAt}>
                    {timeAgo(r.startedAt)}
                  </td>
                  <td className="col-sm">{r.counts.users}</td>
                  <td className="col-sm">{r.counts.messages}</td>
                  <td>{r.counts.problems ? <Badge kind="warn">{r.counts.problems}</Badge> : <span className="faint">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {starting && <StartRun slug={slug} onClose={() => setStarting(false)} onStarted={(r) => nav(`/p/${slug}/runs/${r.id}`)} />}
    </Page>
  );
}

function StartRun({ slug, onClose, onStarted }: { slug: string; onClose: () => void; onStarted: (r: RunView) => void }) {
  const [form, setForm] = useState({ key: '', label: '', role: 'customer', count: '1', ttl: '120', captureUnattributed: false });
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    try {
      const count = Number(form.count) || 0;
      const r = await api.post<RunView>(`/api/projects/${slug}/runs`, {
        key: form.key.trim() || undefined,
        label: form.label.trim() || undefined,
        ttlMinutes: Number(form.ttl) || undefined,
        captureUnattributed: form.captureUnattributed,
        users: count > 0 ? [{ role: form.role.trim() || 'user', count }] : [],
      });
      onClose();
      onStarted(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title="Start a test run"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void start()}>
            Start
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Key <span className="hint">1–24 lowercase letters / digits; empty = random</span>
            <input className="mono" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="w3" />
          </label>
          <label className="field">
            Label
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="checkout spec, worker 3" />
          </label>
          <label className="field">
            Mint users with role
            <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
          </label>
          <label className="field">
            How many
            <input type="number" min={0} max={100} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} />
          </label>
          <label className="field">
            Stop after (minutes)
            <input type="number" min={1} max={1440} value={form.ttl} onChange={(e) => setForm({ ...form, ttl: e.target.value })} />
          </label>
        </div>
        <label className="row small">
          <input type="checkbox" checked={form.captureUnattributed} onChange={(e) => setForm({ ...form, captureUnattributed: e.target.checked })} />
          Capture everything no other run claims (serial CI)
        </label>
      </div>
    </Modal>
  );
}

function RunDetail() {
  const { slug } = useProject();
  const { run: ref = '' } = useParams();
  const run = useFetch<RunView>(`/api/projects/${slug}/runs/${encodeURIComponent(ref)}`, [slug, ref]);
  const report = useFetch<RunReport>(`/api/projects/${slug}/runs/${encodeURIComponent(ref)}/report`, [slug, ref]);
  const r = run.data;
  const msgs = useFetch<Message[]>(r ? `/api/projects/${slug}/messages?run=${encodeURIComponent(r.id)}&limit=200` : null, [slug, r?.id]);
  const reload = useDebounced(() => {
    void run.reload();
    void report.reload();
    void msgs.reload();
  }, 400);
  useHubEvents(slug, (e) => {
    if (RELOAD_ON.includes(e.type)) reload();
  });
  useTick(15_000);
  const toast = useToast();
  const copy = useCopy();
  const nav = useNavigate();

  if (run.error) {
    return (
      <div className="card">
        <Empty title="Run not found">
          <p className="muted">{run.error}</p>
          <Link className="btn" to={`/p/${slug}/runs`}>
            All runs
          </Link>
        </Empty>
      </div>
    );
  }
  if (!r) return <p className="muted">Loading…</p>;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const base = `/api/projects/${slug}/runs/${encodeURIComponent(r.id)}`;
  const download = () => {
    const blob = new Blob([JSON.stringify(report.data ?? {}, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stubyard-run-${slug}-${r.key}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const rep = report.data;
  const users = r.users ?? [];
  const messages = msgs.data ?? [];

  return (
    <Page
      title={
        <>
          Run <span className="mono">{r.key}</span>
        </>
      }
      description={r.label || undefined}
      actions={
        <>
          <a className="btn" href={`${base}/report.html`} target="_blank" rel="noopener">
            Open HTML report
          </a>
          <a className="btn" href={`${base}/report.html?download=1`} download={`stubyard-run-${r.key}.html`}>
            Download HTML
          </a>
          <button className="btn" onClick={download} disabled={!rep}>
            Download JSON
          </button>
          {r.status === 'active' && (
            <button className="btn" onClick={() => void act(() => api.post(`${base}/stop`), 'Run stopped')}>
              Stop
            </button>
          )}
          <button
            className="btn danger"
            onClick={() =>
              confirm(`Delete run "${r.key}" with its users, messages and logs?`) &&
              void act(async () => {
                await api.del(base);
                nav(`/p/${slug}/runs`);
              }, 'Run deleted')
            }
          >
            Delete
          </button>
        </>
      }
    >
      <div className="crumbs">
        <Link to={`/p/${slug}/runs`}>All runs</Link>
      </div>
      <div className="card">
        <dl className="kv wide">
          <dt>Status</dt>
          <dd>
            <Badge kind={r.status === 'active' ? 'ok' : ''}>{r.status}</Badge> <span className="small faint">for {duration(r.startedAt, r.stoppedAt)}</span>
            {r.status === 'active' && <span className="small faint"> · stops automatically in {duration(new Date().toISOString(), r.expiresAt)}</span>}
          </dd>
          <dt>Header</dt>
          <dd className="mono runs-copy">
            <span>X-Hub-Run: {r.key}</span>
            <button className="btn xs ghost" onClick={() => void copy(`X-Hub-Run: ${r.key}`, 'Header copied')} aria-label="Copy header">
              <Icon name="copy" size={12} />
            </button>
          </dd>
          <dt>Mock prefix</dt>
          <dd className="mono runs-copy">
            <span>{window.location.origin + r.urls.mockPrefix}</span>
            <button className="btn xs ghost" onClick={() => void copy(window.location.origin + r.urls.mockPrefix, 'Mock prefix copied')} aria-label="Copy mock prefix">
              <Icon name="copy" size={12} />
            </button>
          </dd>
          <dt>Hook prefix</dt>
          <dd className="mono runs-copy">
            <span>{window.location.origin + r.urls.hookPrefix}</span>
            <button className="btn xs ghost" onClick={() => void copy(window.location.origin + r.urls.hookPrefix, 'Hook prefix copied')} aria-label="Copy hook prefix">
              <Icon name="copy" size={12} />
            </button>
          </dd>
          <dt>SMTP username</dt>
          <dd className="mono">{r.urls.smtpUsername}</dd>
          <dt>Counts</dt>
          <dd>
            {plural(r.counts.users, 'user')} · {plural(r.counts.messages, 'message')} · {plural(r.counts.logs, 'request')}
            {r.counts.problems > 0 && (
              <>
                {' · '}
                <Badge kind="warn">{r.counts.problems} problems</Badge>
              </>
            )}
          </dd>
        </dl>
        {rep && rep.warnings.length > 0 && (
          <ul className="runs-warnings small">
            {rep.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>

      <h3 className="runs-h">Users</h3>
      <div className="card table-wrap">
        {users.length === 0 ? (
          <Empty title="No users minted">
            <p className="muted runs-empty-code">
              <code>POST {base}/users</code> with <code>{'{ "role": "customer" }'}</code>
            </p>
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Password</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link to={`/p/${slug}/users/${u.id}`}>{u.name}</Link>
                  </td>
                  <td>{u.role}</td>
                  <td className="mono small">{u.email ?? '—'}</td>
                  <td className="mono small">{u.phone ?? '—'}</td>
                  <td className="mono small">{u.password ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rep && (rep.rules.length > 0 || rep.mocks.length > 0) && (
        <>
          <h3 className="runs-h">Rules and mock overrides</h3>
          <div className="card table-wrap">
            <table>
              <tbody>
                {rep.rules.map((x) => (
                  <tr key={x.id}>
                    <td className="small faint">{x.owner}</td>
                    <td>{x.description}</td>
                    <td className="small faint col-sm">{x.hits} hits</td>
                  </tr>
                ))}
                {rep.mocks.map((x) => (
                  <tr key={x.mock}>
                    <td className="small faint">mock</td>
                    <td>
                      {x.mock} → {x.scenario}
                    </td>
                    <td className="small faint col-sm">{x.hits} hits</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rep?.storage && <RunStorage storage={rep.storage} />}

      <h3 className="runs-h">Messages</h3>
      <div className="card table-wrap">
        {messages.length === 0 ? (
          <Empty title="No messages yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th />
                <th>To</th>
                <th>Subject / text</th>
                <th>Status</th>
                <th>Code</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className={m.testUserId ? 'clickable' : ''} onClick={() => m.testUserId && nav(`/p/${slug}/users/${m.testUserId}`)}>
                  <td className="col-sm">
                    <ChannelIcon channel={m.channel} size={14} />
                  </td>
                  <td className="mono small">{m.to}</td>
                  <td className="ellipsis">
                    {m.subject ?? m.bodyText?.slice(0, 80) ?? ''} <LintBadges findings={m.lint} />
                  </td>
                  <td>
                    <Badge kind={['delivered', 'received'].includes(m.status) ? 'ok' : ['failed', 'rejected', 'bounced', 'timeout'].includes(m.status) ? 'bad' : ''}>{m.status}</Badge>
                  </td>
                  <td className="mono">{m.otp ?? ''}</td>
                  <td className="small faint">{timeAgo(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3 className="runs-h">Traffic</h3>
      <div className="card">
        <TrafficLog project={slug} run={r.id} />
      </div>
    </Page>
  );
}

/** The run's object uploads / downloads / deletes and run-scoped storage rules (from the run report). */
function RunStorage({ storage: st }: { storage: NonNullable<RunReport['storage']> }) {
  const [openLog, setOpenLog] = useState<string | null>(null);
  return (
    <>
      <h3 className="runs-h">File storage</h3>
      <div className="card">
        <div className="runs-storage-sum small">
          <Badge>{plural(st.uploads, 'upload')}</Badge>
          <Badge>{fmtBytes(st.bytes)}</Badge>
          <Badge>{plural(st.downloads, 'download')}</Badge>
          <Badge>{plural(st.deletes, 'delete')}</Badge>
          {st.rules.length > 0 && <Badge kind="warn">{plural(st.rules.length, 'rule')}</Badge>}
        </div>
        {st.items.length === 0 ? (
          <p className="muted small runs-storage-empty">No object uploads, downloads or deletes in this run.</p>
        ) : (
          <div className="table-wrap">
            <table className="runs-storage">
              <thead>
                <tr>
                  <th>Op</th>
                  <th>Object</th>
                  <th className="col-sm">Size</th>
                  <th className="col-sm">Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {st.items.map((i) => (
                  <tr key={i.logId} className="clickable" onClick={() => setOpenLog(i.logId)}>
                    <td className="small">{i.op}</td>
                    <td className="mono small runs-storage-key">
                      {i.bucket ? <span className="faint">{i.bucket}/</span> : null}
                      {i.key ?? ''}
                    </td>
                    <td className="small faint col-sm">{i.size !== null ? fmtBytes(i.size) : '—'}</td>
                    <td className="small faint col-sm ellipsis">{i.contentType ?? '—'}</td>
                    <td>{i.status !== null ? <Badge kind={i.status < 300 ? 'ok' : 'bad'}>{i.status}</Badge> : <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {st.rules.length > 0 && (
          <div className="table-wrap">
            <table>
              <tbody>
                {st.rules.map((x) => (
                  <tr key={x.id}>
                    <td className="small faint">storage:{x.instance}</td>
                    <td>
                      {x.label ?? x.action} <span className="small faint">({x.op})</span>
                    </td>
                    <td className="small faint col-sm">{x.hits} hits</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {openLog && <LogDrawer id={openLog} onClose={() => setOpenLog(null)} />}
    </>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

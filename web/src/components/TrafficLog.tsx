import { useEffect, useState } from 'react';
import { api, qs, type LogDetail, type LogSummary } from '../api';
import { useProjectMaybe, useProjects } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { ReplayButton } from './Replay';
import { RunChip } from './RunChip';
import { Badge, CodeBlock, Drawer, Empty, ErrorBox, OUTCOME_KIND, fmtBytes, fmtTime, useCopy, useTick } from './ui';

/** Live, filterable list of everything devhub received and sent. */
export function TrafficLog({ project, initialOpenId, run }: { project?: string; initialOpenId?: string | null; /** Only this test run's traffic (key or id). */ run?: string }) {
  const { projects } = useProjects();
  useTick(10_000);
  const [outcome, setOutcome] = useState('');
  const [protocol, setProtocol] = useState('');
  const [direction, setDirection] = useState('');
  const [scope, setScope] = useState(project ?? '');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [paused, setPaused] = useState(false);
  // Phase 5: per-user / per-instance filters (project view only) and "load older" paging.
  const projectState = useProjectMaybe();
  const [user, setUser] = useState('');
  const [instance, setInstance] = useState('');
  const [older, setOlder] = useState<LogSummary[]>([]);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'end'>('idle');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const path = `/api/logs${qs({ project: project ?? scope, outcome, protocol, direction, q: debouncedSearch, user: project && user, instance: project && instance, run: project && run, limit: 200 })}`;
  const logs = useFetch<LogSummary[]>(path, [path]);
  const reload = useDebounced(() => !paused && void logs.reload(), 200);
  useHubEvents(project ?? null, (e) => {
    if (e.type === 'log.created' || e.type === 'log.updated' || e.type === 'project.reset') reload();
  });

  useEffect(() => {
    setOlder([]);
    setOlderState('idle');
  }, [path]);
  const first = logs.data ?? [];
  const seen = new Set(first.map((l) => l.id));
  const list = [...first, ...older.filter((l) => !seen.has(l.id))];
  const loadOlder = async () => {
    const last = list[list.length - 1];
    if (!last) return;
    setOlderState('loading');
    try {
      const more = await api.get<LogSummary[]>(`${path}&before=${encodeURIComponent(last.id)}`);
      setOlder((o) => [...o, ...more]);
      setOlderState(more.length < 200 ? 'end' : 'idle');
    } catch {
      setOlderState('idle');
    }
  };
  const projectUsers = project && projectState?.slug === project ? projectState.overview.users : [];
  const projectInstances = project && projectState?.slug === project ? projectState.overview.providers : [];
  return (
    <>
      <div className="filters">
        {!project && (
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            <option value="none">No project (unknown)</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
          <option value="">Any outcome</option>
          <option value="ok">OK</option>
          <option value="unmatched">Unmatched (404)</option>
          <option value="invalid">Invalid request</option>
          <option value="rejected">Rejected</option>
          <option value="forced_error">Forced error (rule)</option>
          <option value="internal_error">Internal error</option>
          <option value="network_error">Network error</option>
          <option value="pending">Pending</option>
        </select>
        <select value={protocol} onChange={(e) => setProtocol(e.target.value)} aria-label="Protocol">
          <option value="">HTTP + SMTP</option>
          <option value="http">HTTP</option>
          <option value="smtp">SMTP</option>
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} aria-label="Direction">
          <option value="">In + out</option>
          <option value="inbound">Received</option>
          <option value="outbound">Sent</option>
        </select>
        {projectUsers.length > 0 && (
          <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="Test user">
            <option value="">Any user</option>
            {projectUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
        {projectInstances.length > 1 && (
          <select value={instance} onChange={(e) => setInstance(e.target.value)} aria-label="Provider instance">
            <option value="">Any instance</option>
            {projectInstances.map((i) => (
              <option key={i.id} value={i.slug}>
                {i.slug}
              </option>
            ))}
          </select>
        )}
        <input type="search" placeholder="Search URL, body, errors…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn sm" onClick={() => setPaused(!paused)}>
          {paused ? '▶ Resume live' : '❚❚ Pause'}
        </button>
      </div>
      <ErrorBox error={logs.error} />
      {list.length === 0 && !logs.loading ? (
        <Empty title="No traffic yet">Every request your apps send to devhub, and everything devhub sends back, appears here.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th className="col-sm"></th>
                <th>Request</th>
                <th className="col-sm">Status</th>
                <th>Outcome</th>
                <th className="col-sm">Size</th>
                <th className="col-sm">Time taken</th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id} className={`clickable ${openId === l.id ? 'selected' : ''}`} onClick={() => setOpenId(l.id)}>
                  <td className="mono faint" style={{ whiteSpace: 'nowrap' }} title={l.receivedAt}>
                    {fmtTime(l.receivedAt)}
                  </td>
                  <td className="col-sm">
                    <Badge kind={l.direction === 'inbound' ? '' : 'accent'}>{l.direction === 'inbound' ? '← in' : '→ out'}</Badge>
                  </td>
                  <td className="cell-fill">
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <span className="method">{l.method}</span>
                      <span className="mono ellipsis">{l.url}</span>
                      {typeof l.resolved.run === 'string' && <RunChip runKey={l.resolved.run} />}
                    </div>
                    {(l.errorMessage || summaryLine(l)) && <div className="small muted ellipsis">{l.errorMessage ?? summaryLine(l)}</div>}
                  </td>
                  <td className="col-sm">
                    <StatusCode code={l.resStatus} />
                  </td>
                  <td>
                    <Badge kind={OUTCOME_KIND[l.outcome]}>{l.outcome.replace('_', ' ')}</Badge>
                  </td>
                  <td className="small faint col-sm">{fmtBytes(l.reqBodySize)}</td>
                  <td className="small faint col-sm">{l.durationMs !== null ? `${l.durationMs} ms` : '…'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {first.length >= 200 && olderState !== 'end' && (
            <div className="row" style={{ justifyContent: 'center', padding: 10 }}>
              <button className="btn sm" disabled={olderState === 'loading'} onClick={() => void loadOlder()}>
                {olderState === 'loading' ? 'Loading…' : 'Load older'}
              </button>
            </div>
          )}
        </div>
      )}
      {openId && <LogDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function summaryLine(l: LogSummary): string | null {
  const r = l.resolved as Record<string, unknown>;
  const parts: string[] = [];
  if (r.project) parts.push(`project ${r.project}`);
  if (r.instance) parts.push(`via ${r.instance}`);
  if (Array.isArray(r.messageIds)) parts.push(`${r.messageIds.length} message(s)`);
  if (r.bodyError) parts.push(String(r.bodyError));
  return parts.length ? parts.join(' · ') : null;
}

export function StatusCode({ code }: { code: number | null }) {
  if (code === null) return <span className="faint">—</span>;
  return <span className={`status s${String(code)[0]}`}>{code}</span>;
}

export function LogDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const log = useFetch<LogDetail>(`/api/logs/${id}`, [id]);
  const copy = useCopy();
  const l = log.data;
  return (
    <Drawer
      onClose={onClose}
      title={
        l ? (
          <div className="row">
            <span className="method">{l.method}</span>
            <StatusCode code={l.resStatus} />
            <Badge kind={OUTCOME_KIND[l.outcome]}>{l.outcome.replace('_', ' ')}</Badge>
          </div>
        ) : (
          'Loading…'
        )
      }
      actions={
        l?.protocol === 'http' ? (
          <>
            <ReplayButton log={l} />
            <button className="btn sm" onClick={() => copy(toCurl(l), 'cURL command copied')}>
              Copy as cURL
            </button>
          </>
        ) : null
      }
    >
      <ErrorBox error={log.error} />
      {l && (
        <>
          <div className="mono" style={{ overflowWrap: 'anywhere' }}>
            {l.url}
          </div>
          <dl className="kv" style={{ padding: 0, border: 0 }}>
            <dt>Request ID</dt>
            <dd className="mono">{l.id}</dd>
            <dt>Received</dt>
            <dd>{new Date(l.receivedAt).toLocaleString()}</dd>
            <dt>Responded</dt>
            <dd>{l.respondedAt ? `${new Date(l.respondedAt).toLocaleString()} (${l.durationMs} ms)` : 'No response sent'}</dd>
            <dt>Client</dt>
            <dd>{l.clientIp ?? '—'}</dd>
            {l.errorMessage && (
              <>
                <dt>Error</dt>
                <dd style={{ color: 'var(--bad)' }}>
                  {l.errorType && <code>{l.errorType}</code>} {l.errorMessage}
                </dd>
              </>
            )}
            {Object.keys(l.resolved).length > 0 && (
              <>
                <dt>Resolved</dt>
                <dd>
                  <code>{JSON.stringify(l.resolved)}</code>
                </dd>
              </>
            )}
          </dl>
          {l.transcript && l.transcript.length > 0 && (
            <section className="stack" style={{ gap: 6 }}>
              <h3>SMTP conversation</h3>
              <div className="transcript">
                {l.transcript.map((t, i) => (
                  <Line key={i} command={t.command} response={t.response} />
                ))}
              </div>
            </section>
          )}
          <section className="stack" style={{ gap: 6 }}>
            <h3>
              Request {l.reqTruncated && <Badge kind="warn">truncated · {fmtBytes(l.reqBodySize)}</Badge>}
            </h3>
            {l.reqHeaders && <pre className="dump">{formatHeaders(l.reqHeaders)}</pre>}
            {l.reqBody ? <CodeBlock code={pretty(l.reqBody)} /> : <p className="faint small">No body</p>}
          </section>
          <section className="stack" style={{ gap: 6 }}>
            <h3>
              Response {l.resTruncated && <Badge kind="warn">truncated · {fmtBytes(l.resBodySize)}</Badge>}
            </h3>
            {l.resHeaders && <pre className="dump">{formatHeaders(l.resHeaders)}</pre>}
            {l.resBody ? <CodeBlock code={pretty(l.resBody)} /> : <p className="faint small">No body</p>}
          </section>
        </>
      )}
    </Drawer>
  );
}

function Line({ command, response }: { command: string; response: string }) {
  return (
    <>
      <span className="c">{command}</span>
      <span className={`r ${/^[45]\d\d/.test(response) ? 'bad' : ''}`}>{response}</span>
    </>
  );
}

function formatHeaders(h: Record<string, unknown>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n');
}

function pretty(body: string): string {
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return body;
}

function toCurl(l: LogDetail): string {
  const url = `${window.location.protocol}//${window.location.host}${l.url ?? ''}`;
  const parts = [`curl -X ${l.method ?? 'GET'} '${url}'`];
  const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
  for (const [k, v] of Object.entries(l.reqHeaders ?? {})) {
    if (skip.has(k.toLowerCase())) continue;
    parts.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (l.reqBody) parts.push(`  --data-raw '${l.reqBody.replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n');
}

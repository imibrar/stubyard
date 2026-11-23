import { useEffect, useState } from 'react';
import { api, qs, type LogDetail, type LogSummary } from '../api';
import { useProjectMaybe, useProjects } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import ExplainButton from './ExplainButton';
import { ReplayButton } from './Replay';
import { RunChip } from './RunChip';
import { StatTile, StatTiles } from './layout';
import { Badge, CodeBlock, Drawer, Empty, ErrorBox, OUTCOME_KIND, fmtBytes, fmtTime, useCopy, useTick } from './ui';

/** Live, filterable list of everything stubyard received and sent. */
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
  const [kind, setKind] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

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
  const all = [...first, ...older.filter((l) => !seen.has(l.id))];
  const kindCounts = new Map<string, number>();
  for (const l of all) kindCounts.set(kindOf(l), (kindCounts.get(kindOf(l)) ?? 0) + 1);
  const list = kind ? all.filter((l) => kindOf(l) === kind) : all;
  const loadOlder = async () => {
    const last = all[all.length - 1];
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
  // Summary of the loaded rows: requests, errors, median duration.
  const errors = list.filter((l) => l.outcome !== 'ok' && l.outcome !== 'pending').length;
  const durs = list.map((l) => l.durationMs).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : null;
  const activeFilters = [outcome, protocol, direction, user, instance, !project ? scope : ''].filter(Boolean).length;
  const projectUsers = project && projectState?.slug === project ? projectState.overview.users : [];
  const projectInstances = project && projectState?.slug === project ? projectState.overview.providers : [];
  // Consecutive identical requests fold into one row with "× n"; the count expands them.
  const groups: { head: LogSummary; rest: LogSummary[] }[] = [];
  for (const l of list) {
    const g = groups[groups.length - 1];
    if (g && sameRequest(g.head, l)) g.rest.push(l);
    else groups.push({ head: l, rest: [] });
  }
  const row = (l: LogSummary, repeat?: { n: number; open: boolean; toggle: () => void }, folded?: boolean) => (
    <tr key={l.id} className={`clickable ${openId === l.id ? 'selected' : ''} ${folded ? 'traffic-repeat' : ''}`} onClick={() => setOpenId(l.id)}>
      <td className="mono faint traffic-time" style={{ whiteSpace: 'nowrap' }} title={l.receivedAt}>
        {fmtTime(l.receivedAt)}
      </td>
      <td className="col-sm traffic-dir">
        <Badge kind={l.direction === 'inbound' ? '' : 'accent'}>{l.direction === 'inbound' ? '← in' : '→ out'}</Badge>
      </td>
      <td className="cell-fill traffic-req">
        <div className="row traffic-req-line" style={{ flexWrap: 'nowrap' }}>
          <span className="method">{l.method}</span>
          <span className="mono ellipsis traffic-url" title={l.url ?? undefined}>{l.url}</span>
          {kindCounts.size > 1 && <span className="kind-tag traffic-kind">{KIND_LABEL[kindOf(l)] ?? kindOf(l)}</span>}
          {typeof l.resolved.run === 'string' && <RunChip runKey={l.resolved.run} />}
          {repeat && (
            <button
              type="button"
              className="badge traffic-fold"
              aria-expanded={repeat.open}
              title={repeat.open ? 'Fold the repeats' : `${repeat.n} identical requests in a row: show them all`}
              onClick={(e) => {
                e.stopPropagation();
                repeat.toggle();
              }}
            >
              × {repeat.n}
            </button>
          )}
        </div>
        {(l.errorMessage || summaryLine(l)) && <div className="small muted ellipsis">{l.errorMessage ?? summaryLine(l)}</div>}
      </td>
      <td className="col-sm traffic-status">
        <StatusCode code={l.resStatus} />
      </td>
      <td className="traffic-outcome">
        <Badge kind={OUTCOME_KIND[l.outcome]}>{l.outcome.replace('_', ' ')}</Badge>
      </td>
      <td className="small faint col-sm traffic-size">{fmtBytes(l.reqBodySize)}</td>
      <td className="small faint col-sm traffic-dur">{l.durationMs !== null ? `${l.durationMs} ms` : '…'}</td>
    </tr>
  );
  return (
    <>
      <div className="traffic-bar">
        <StatTiles label="Loaded traffic" compact className="traffic-summary">
          <StatTile label="Requests" value={list.length} sub={first.length >= 200 ? 'latest 200 loaded' : 'loaded'} />
          <StatTile label="Errors" value={errors} tone={errors ? 'bad' : undefined} sub={list.length ? `${Math.round((errors / list.length) * 100)}%` : '—'} />
          <StatTile label="Median time" value={median === null ? '—' : `${median} ms`} sub={durs.length ? `of ${durs.length} answered` : '—'} />
        </StatTiles>
        <div className="row nowrap traffic-search">
          <input type="search" placeholder="Search URL, body, errors…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search traffic" />
          <button className={`btn ${activeFilters ? 'active' : ''}`} aria-expanded={showFilters} aria-controls="traffic-filters" onClick={() => setShowFilters(!showFilters)}>
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </button>
          <button className="btn" onClick={() => setPaused(!paused)} aria-pressed={paused}>
            {paused ? '▶ Resume live' : '❚❚ Pause'}
          </button>
        </div>
      </div>
      <div className="filters traffic-filters" id="traffic-filters" hidden={!showFilters}>
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
        {activeFilters > 0 && (
          <button
            className="btn sm ghost"
            onClick={() => {
              setOutcome('');
              setProtocol('');
              setDirection('');
              setUser('');
              setInstance('');
              if (!project) setScope('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {kindCounts.size > 1 && (
        <div className="chips traffic-kinds" role="group" aria-label="Kind of traffic">
          <button className={`chip ${kind === '' ? 'active' : ''}`} onClick={() => setKind('')} aria-pressed={kind === ''}>
            All <span className="n">{all.length}</span>
          </button>
          {[...kindCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(kind === k ? '' : k)} aria-pressed={kind === k} title={KIND_HELP[k] ?? k}>
                {KIND_LABEL[k] ?? k} <span className="n">{n}</span>
              </button>
            ))}
        </div>
      )}
      <ErrorBox error={logs.error} />
      {list.length === 0 && kind && all.length > 0 ? (
        <Empty title={`No ${KIND_LABEL[kind] ?? kind} traffic in the loaded rows`}>
          <button className="btn sm" onClick={() => setKind('')}>
            Show all
          </button>
        </Empty>
      ) : list.length === 0 && !logs.loading ? (
        <Empty title="No traffic yet">Every request your apps send to stubyard, and everything stubyard sends back, appears here.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="traffic-table">
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
              {groups.map((g) => {
                const open = expanded.has(g.head.id);
                const toggle = () =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(g.head.id)) n.delete(g.head.id);
                    else n.add(g.head.id);
                    return n;
                  });
                return [row(g.head, g.rest.length ? { n: g.rest.length + 1, open, toggle } : undefined), ...(open ? g.rest.map((l) => row(l, undefined, true)) : [])];
              })}
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

const KIND_LABEL: Record<string, string> = { 'api-mock': 'API mock', storage: 'storage', pay: 'payments', 'payment-webhook': 'payment webhook', auth: 'login', hook: 'webhook', 'provider-mock': 'provider', llm: 'LLM', smtp: 'SMTP', 'mcp-tester': 'MCP tester', other: 'other' };
const KIND_HELP: Record<string, string> = {
  'api-mock': '/mock/<project>/api/… (API mocks)',
  storage: '/storage/… (S3, GCS, Azure, Cloudinary, Supabase)',
  pay: '/pay/… (payment gateways, hosted pages)',
  'payment-webhook': 'Payment webhooks stubyard sent to your app',
  auth: '/auth/… (login providers)',
  hook: 'Webhooks received or sent',
  'provider-mock': 'Email / SMS / WhatsApp provider APIs (/mock/<project>/<instance>/…)',
  llm: '/llm/… (LLM API mocks)',
  smtp: 'Mail received over SMTP',
  'mcp-tester': 'Calls the MCP tester made to your MCP server',
};

/** What a traffic row is about: resolved.kind when the handler set one, else read from the URL. */
export function kindOf(l: Pick<LogSummary, 'protocol' | 'url' | 'resolved'>): string {
  const k = (l.resolved as Record<string, unknown>).kind;
  if (typeof k === 'string' && k) return k;
  if (l.protocol === 'smtp') return 'smtp';
  if ((l.resolved as Record<string, unknown>).mcpTester) return 'mcp-tester';
  const path = (l.url ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/run\/[a-z0-9]{1,24}(?=\/)/i, '');
  if (/^\/mock\/[^/]+\/api(\/|$|\?)/.test(path)) return 'api-mock';
  if (path.startsWith('/mock/')) return 'provider-mock';
  if (path.startsWith('/pay/')) return 'pay';
  if (path.startsWith('/storage/')) return 'storage';
  if (path.startsWith('/auth/')) return 'auth';
  if (path.startsWith('/hook/') || path.startsWith('/hooks/')) return 'hook';
  if (path.startsWith('/llm/')) return 'llm';
  return 'other';
}

/** Same request repeated (retries, polling): same direction, method, URL, outcome, status and error. */
function sameRequest(a: LogSummary, b: LogSummary): boolean {
  return a.direction === b.direction && a.method === b.method && a.url === b.url && a.outcome === b.outcome && a.resStatus === b.resStatus && a.errorMessage === b.errorMessage;
}

/** "SharedKey ✓", "SAS (expired?) ✗", "bearer". */
function authLabel(a: unknown): string | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as { type?: unknown; verified?: unknown; accessKeyId?: unknown };
  if (typeof o.type !== 'string') return null;
  const mark = o.verified === true ? ' ✓ verified' : o.verified === false ? ' ✗ not verified' : '';
  return `auth ${o.type}${typeof o.accessKeyId === 'string' && o.accessKeyId ? ` (${o.accessKeyId})` : ''}${mark}`;
}

function objectLabel(r: Record<string, unknown>): string | null {
  const bucket = typeof r.bucket === 'string' ? r.bucket : '';
  const key = typeof r.key === 'string' ? r.key : '';
  if (!bucket && !key) return null;
  return [bucket, key].filter(Boolean).join('/');
}

function summaryLine(l: LogSummary): string | null {
  const r = l.resolved as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.op === 'string') parts.push(r.op);
  const obj = objectLabel(r);
  if (obj) parts.push(obj);
  if (r.mock) parts.push(`mock ${r.mock}${r.scenario ? ` → ${r.scenario}` : ''}`);
  const auth = authLabel(r.auth);
  if (auth) parts.push(auth);
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
            {l.projectId && <ExplainButton kind="traffic" id={l.id} project={l.projectId} />}
          </>
        ) : l?.projectId ? (
          <ExplainButton kind="traffic" id={l.id} project={l.projectId} />
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
            <dt>Kind</dt>
            <dd>{KIND_LABEL[kindOf(l)] ?? kindOf(l)}</dd>
            {objectLabel(l.resolved) && (
              <>
                <dt>Object</dt>
                <dd className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {objectLabel(l.resolved)}
                  {typeof l.resolved.op === 'string' && <span className="faint"> · {l.resolved.op}</span>}
                </dd>
              </>
            )}
            {authLabel(l.resolved.auth) && (
              <>
                <dt>Auth</dt>
                <dd>
                  <Badge kind={(l.resolved.auth as { verified?: unknown }).verified === true ? 'ok' : (l.resolved.auth as { verified?: unknown }).verified === false ? 'warn' : ''}>
                    {authLabel(l.resolved.auth)!.replace(/^auth /, '')}
                  </Badge>
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

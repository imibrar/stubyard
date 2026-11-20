import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { Icon } from '../components/people';
import { JsonInput, SchemaForm, formable, initialValue } from '../components/SchemaForm';
import { Badge, CodeBlock, Empty, ErrorBox, Modal, fmtBytes, fmtTime, timeAgo, useCopy, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  mtBase,
  type CallOutcome,
  type CheckReport,
  type Json,
  type ListMeta,
  type LogEntry,
  type McpOverview,
  type McpPrompt,
  type McpResource,
  type McpResourceTemplate,
  type McpSession,
  type McpTarget,
  type McpTool,
  type RpcOutcome,
  type RunSavedResponse,
  type SavedCall,
  type Severity,
} from '../mcpTesterApi';
import { Page } from './ProjectPage';
import '../styles/mcptester.css';

/**
 * /p/:slug/mcp-tester — connect devhub (as an MCP client) to an MCP server you are building, then exercise its tools,
 * resources and prompts, read the JSON-RPC log, run the MCP checks and keep saved calls as a small regression suite.
 */

type Tab = 'tools' | 'resources' | 'prompts' | 'log' | 'checks' | 'saved';
const SELF = '__self__';
const NEW = '__new__';
const SEV_KIND: Record<Severity, string> = { error: 'bad', warn: 'warn', info: '' };

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export default function McpTesterPage() {
  const { slug } = useProject();
  const toast = useToast();
  const base = mtBase(slug);
  const overview = useFetch<McpOverview>(base, [slug]);
  const [choice, setChoice] = useState<string>(() => store.get(`mt:${slug}:target`) ?? '');
  const [adhoc, setAdhoc] = useState({ url: '', transport: 'auto' });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<McpSession | null>(null);
  const [checks, setChecks] = useState<CheckReport | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<{ message: string; log?: LogEntry[] } | null>(null);
  const [tab, setTab] = useState<Tab>(() => (store.get('mt:tab') as Tab) || 'tools');
  const [editing, setEditing] = useState<McpTarget | 'new' | null>(null);
  const [rev, setRev] = useState(0);
  const reload = useDebounced(() => void overview.reload(), 250);

  const targets = overview.data?.targets ?? [];
  const target = targets.find((t) => t.id === choice) ?? null;
  // Default selection: last used, else first saved target, else devhub itself.
  useEffect(() => {
    if (!overview.data) return;
    if (choice && (choice === SELF || choice === NEW || targets.some((t) => t.id === choice))) return;
    setChoice(targets[0]?.id ?? SELF);
  }, [overview.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (choice) store.set(`mt:${slug}:target`, choice);
  }, [choice, slug]);
  useEffect(() => store.set('mt:tab', tab), [tab]);

  // Pick up an open session of the selected target (e.g. after a reload of the page).
  useEffect(() => {
    if (!overview.data) return;
    const open = target?.session ? overview.data.sessions.find((s) => s.id === target.session) : choice === SELF ? overview.data.sessions.find((s) => !s.targetId && s.url === overview.data!.self.url) : null;
    if (open && open.id !== sessionId) {
      setSessionId(open.id);
      setSession(open);
      setChecks(null);
    } else if (!open && sessionId && !overview.data.sessions.some((s) => s.id === sessionId)) {
      setSessionId(null);
      setSession(null);
    }
  }, [overview.data, choice]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      setSession(await api.get<McpSession>(`${base}/sessions/${sessionId}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setSessionId(null);
        setSession(null);
        toast('MCP session ended (idle timeout or disconnect)');
      }
    }
  }, [base, sessionId, toast]);
  const refreshSessionSoon = useDebounced(() => void refreshSession(), 300);

  useHubEvents(slug, (e) => {
    if (e.type !== 'mcptester.changed') return;
    const d = (e.data ?? {}) as { session?: string; kind?: string };
    if (d.kind === 'targets' || d.kind === 'saved' || d.kind === 'connected' || d.kind === 'closed') reload();
    if (d.session && d.session === sessionId) {
      refreshSessionSoon();
      setRev((r) => r + 1);
    }
  });

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const body = choice === SELF ? { self: true } : choice === NEW ? { url: adhoc.url, transport: adhoc.transport } : { target: choice };
      const r = await api.post<{ session: McpSession; checks?: CheckReport }>(`${base}/connect`, body);
      setSessionId(r.session.id);
      setSession(r.session);
      setChecks(r.checks ?? null);
      setRev((x) => x + 1);
      void overview.reload();
    } catch (e) {
      const err = e as ApiError;
      setConnectError({ message: err.message, log: ((err.details as { log?: LogEntry[] } | undefined)?.log ?? undefined) as LogEntry[] | undefined });
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async () => {
    if (!sessionId) return;
    await api.del(`${base}/sessions/${sessionId}`).catch(() => undefined);
    setSessionId(null);
    setSession(null);
    setChecks(null);
    void overview.reload();
  };
  const saveAdhoc = async () => {
    try {
      const t = await api.post<McpTarget>(`${base}/targets`, { url: adhoc.url, transport: adhoc.transport });
      await overview.reload();
      setChoice(t.id);
      toast(`Saved target "${t.name}"`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const saveSelf = async () => {
    const t = await api.post<McpTarget>(`${base}/targets`, { self: true });
    await overview.reload();
    setChoice(t.id);
  };

  return (
    <Page
      title="MCP tester"
      description="Connect to an MCP server you are building (Streamable HTTP or legacy HTTP+SSE), call its tools, read resources and prompts, inspect every JSON-RPC message and run the MCP checks. devhub is the MCP client, so CORS and session headers are not a problem."
      actions={
        <button className="btn" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} /> Add target
        </button>
      }
    >
      <ErrorBox error={overview.error} />
      <div className="card mt-target-bar">
        <div className="mt-target-row">
          <label className="mt-target-select">
            <span className="small faint">Target</span>
            <select value={choice} onChange={(e) => (setChoice(e.target.value), setConnectError(null))}>
              {targets.length > 0 && (
                <optgroup label="Saved targets">
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Other">
                <option value={SELF}>devhub (this server, demo)</option>
                <option value={NEW}>Enter a URL…</option>
              </optgroup>
            </select>
          </label>
          {choice === NEW ? (
            <div className="mt-adhoc">
              <input placeholder="http://host.docker.internal:3001/mcp" value={adhoc.url} onChange={(e) => setAdhoc({ ...adhoc, url: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && adhoc.url && void connect()} aria-label="MCP server URL" />
              <select value={adhoc.transport} onChange={(e) => setAdhoc({ ...adhoc, transport: e.target.value })} aria-label="Transport">
                <option value="auto">auto</option>
                <option value="streamable">Streamable HTTP</option>
                <option value="sse">HTTP+SSE (legacy)</option>
              </select>
            </div>
          ) : (
            <div className="mt-target-url">
              <code className="ellipsis" title={choice === SELF ? overview.data?.self.url : target?.url}>
                {choice === SELF ? overview.data?.self.url : target?.url}
              </code>
              {target && (
                <span className="small faint">
                  {target.transport !== 'auto' ? `${target.transport} · ` : ''}
                  {target.headerNames.length ? `headers: ${target.headerNames.join(', ')}` : 'no custom headers'}
                </span>
              )}
            </div>
          )}
          <div className="row-actions mt-target-actions">
            {target && (
              <button className="btn sm ghost" onClick={() => setEditing(target)} title="Edit URL, headers, transport">
                Edit
              </button>
            )}
            {choice === NEW && adhoc.url && (
              <button className="btn sm ghost" onClick={() => void saveAdhoc()}>
                Save
              </button>
            )}
            {choice === SELF && !targets.some((t) => t.url === overview.data?.self.url) && (
              <button className="btn sm ghost" onClick={() => void saveSelf()} title="Save as a target (for saved calls)">
                Save
              </button>
            )}
            {session ? (
              <>
                <button className="btn sm" onClick={() => void connect()} disabled={connecting}>
                  {connecting ? 'Connecting…' : 'Reconnect'}
                </button>
                <button className="btn sm" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn sm primary" onClick={() => void connect()} disabled={connecting || (choice === NEW && !adhoc.url)}>
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>
        </div>
        {session && <SessionStrip session={session} checks={checks} onChecks={() => setTab('checks')} />}
      </div>

      {connectError && (
        <div className="card card-pad stack mt-gap">
          <div className="error-box">{connectError.message}</div>
          <ConnectHints overview={overview.data} compact />
          {connectError.log && connectError.log.length > 0 && <CodeBlock title="What happened (JSON-RPC log)" code={connectError.log.map((e) => `${e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '·'} ${e.kind}${e.method ? ` ${e.method}` : ''}${e.status ? ` HTTP ${e.status}` : ''}${e.note ? ` — ${e.note}` : ''}`).join('\n')} />}
        </div>
      )}

      {!session ? (
        !connectError && <ConnectHints overview={overview.data} />
      ) : (
        <>
          <div className="tabs mt-tabs" role="tablist">
            {(
              [
                ['tools', 'Tools'],
                ['resources', 'Resources'],
                ['prompts', 'Prompts'],
                ['log', 'Log'],
                ['checks', 'Checks'],
                ['saved', 'Saved calls'],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <a key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
                {label}
                {k === 'log' && <span className="n faint"> {session.stats.messages}</span>}
                {k === 'checks' && (checks ?? session.checks) && <CheckDots summary={(checks ?? session.checks)!.summary} />}
                {k === 'saved' && target && <span className="n faint"> {target.savedCalls}</span>}
              </a>
            ))}
          </div>
          {tab === 'tools' && <ToolsTab base={base} session={session} target={target} rev={rev} onSaved={() => void overview.reload()} />}
          {tab === 'resources' && <ResourcesTab base={base} session={session} rev={rev} />}
          {tab === 'prompts' && <PromptsTab base={base} session={session} rev={rev} />}
          {tab === 'log' && <LogTab base={base} session={session} rev={rev} />}
          {tab === 'checks' && <ChecksTab base={base} session={session} report={checks} setReport={setChecks} catalog={overview.data?.checks ?? []} />}
          {tab === 'saved' && <SavedTab base={base} target={target} onChanged={() => void overview.reload()} />}
        </>
      )}

      {editing && (
        <TargetModal
          base={base}
          target={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={async (t, deleted) => {
            await overview.reload();
            if (deleted) {
              setChoice(SELF);
              setSessionId(null);
              setSession(null);
            } else if (t) setChoice(t.id);
          }}
        />
      )}
    </Page>
  );
}

// ------------------------------------------------------------------ connection

function CheckDots({ summary }: { summary: Record<Severity, number> }) {
  return (
    <span className="mt-dots">
      {summary.error > 0 && <Badge kind="bad">{summary.error}</Badge>}
      {summary.warn > 0 && <Badge kind="warn">{summary.warn}</Badge>}
      {!summary.error && !summary.warn && <Badge kind="ok">✓</Badge>}
    </span>
  );
}

function SessionStrip({ session, checks, onChecks }: { session: McpSession; checks: CheckReport | null; onChecks: () => void }) {
  const [showInstr, setShowInstr] = useState(false);
  const caps = Object.keys(session.capabilities);
  const si = session.serverInfo;
  const sum = checks?.summary ?? session.checks?.summary;
  return (
    <div className="mt-session">
      <div className="mt-session-main">
        <span className="dot on" aria-hidden />
        <strong className="ellipsis">{si?.title || si?.name || 'MCP server'}</strong>
        {si?.version && <code className="faint">v{si.version}</code>}
        <Badge kind="accent">{session.protocolVersion ?? 'no version'}</Badge>
        <Badge>{session.transport === 'sse' ? 'HTTP+SSE (legacy)' : 'Streamable HTTP'}</Badge>
        {sum && (
          <button className="linkish small" onClick={onChecks} title="Open the checks">
            {sum.error} errors · {sum.warn} warnings · {sum.info} notes
          </button>
        )}
      </div>
      <dl className="kv bare mt-kv">
        <dt>Capabilities</dt>
        <dd className="chips">
          {caps.length ? (
            caps.map((c) => {
              const v = session.capabilities[c] as Json | undefined;
              const flags = v && typeof v === 'object' ? Object.entries(v).filter(([, x]) => x === true).map(([k]) => k) : [];
              return (
                <span key={c} className="chip" title={JSON.stringify(v)}>
                  {c}
                  {flags.length > 0 && <span className="n">{flags.join(', ')}</span>}
                </span>
              );
            })
          ) : (
            <span className="faint">none declared</span>
          )}
        </dd>
        <dt>Session</dt>
        <dd>
          <code title="Mcp-Session-Id">{session.mcpSessionId ?? 'stateless (no Mcp-Session-Id)'}</code>
          <span className="faint small">
            {' '}
            · initialize {session.initMs} ms
            {session.transport === 'streamable' && ` · GET stream: ${session.getStream ?? '…'}`}
            {session.stats.sessionReinits > 0 && ` · re-initialized ${session.stats.sessionReinits}×`}
          </span>
        </dd>
        {session.instructions && (
          <>
            <dt>Instructions</dt>
            <dd>
              <div className={`mt-instructions ${showInstr ? 'open' : ''}`}>{session.instructions}</div>
              {session.instructions.length > 160 && (
                <button className="linkish small" onClick={() => setShowInstr(!showInstr)}>
                  {showInstr ? 'Less' : 'More'}
                </button>
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ConnectHints({ overview, compact }: { overview: McpOverview | null; compact?: boolean }) {
  return (
    <div className={compact ? 'stack' : 'cards-flow mt-gap'}>
      <div className={compact ? '' : 'card card-pad stack'}>
        <h3 style={{ margin: 0 }}>Reaching your MCP server</h3>
        <p className="muted small" style={{ margin: 0 }}>
          devhub connects from {overview?.inContainer ? 'its container' : 'this machine'}. {overview?.inContainer ? (
            <>
              <code>localhost</code> is devhub itself: use <code>http://host.docker.internal:&lt;port&gt;/mcp</code> for a server on your machine (start it on <code>0.0.0.0</code> on Linux), or the service name (<code>http://my-mcp:3001/mcp</code>) for another container on the devhub network.
            </>
          ) : (
            <>
              Use <code>http://localhost:&lt;port&gt;/mcp</code>.
            </>
          )}{' '}
          Only local and private hosts are allowed (outbound allowlist, <code>DEVHUB_OUTBOUND_ALLOW</code>).
        </p>
        {!compact && (
          <p className="muted small" style={{ margin: 0 }}>
            Try it on devhub itself: choose <strong>devhub (this server, demo)</strong> and Connect.
          </p>
        )}
      </div>
      <div className={compact ? '' : 'card card-pad stack'}>
        <h3 style={{ margin: 0 }}>stdio servers</h3>
        <p className="muted small" style={{ margin: 0 }}>
          The tester speaks HTTP only. Run a stdio server behind a bridge and connect to the bridge URL (<code>http://host.docker.internal:8000/mcp</code>):
        </p>
        <CodeBlock title="supergateway (Node): stdio → Streamable HTTP on :8000/mcp" code={'npx -y supergateway --stdio "node build/index.js" \\\n  --outputTransport streamableHttp --port 8000'} />
        {!compact && <CodeBlock title="mcp-proxy (Python): stdio → HTTP+SSE on :8080/sse" code={'uv tool install mcp-proxy\nmcp-proxy --host=0.0.0.0 --port=8080 -- uvx mcp-server-fetch'} />}
      </div>
    </div>
  );
}

function TargetModal({ base, target, onClose, onDone }: { base: string; target: McpTarget | null; onClose: () => void; onDone: (t: McpTarget | null, deleted?: boolean) => void }) {
  const toast = useToast();
  const [name, setName] = useState(target?.name ?? '');
  const [url, setUrl] = useState(target?.url ?? 'http://host.docker.internal:3001/mcp');
  const [transport, setTransport] = useState<string>(target?.transport ?? 'auto');
  const [notes, setNotes] = useState(target?.notes ?? '');
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>(() => Object.entries(target?.headers ?? {}).map(([n, v]) => ({ name: n, value: v })));
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      const body = { name, url, transport, notes, headers: Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])) };
      const t = target ? await api.patch<McpTarget>(`${base}/targets/${target.id}`, body) : await api.post<McpTarget>(`${base}/targets`, body);
      onDone(t);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!target || !confirm(`Delete target "${target.name}" and its ${target.savedCalls} saved calls?`)) return;
    await api.del(`${base}/targets/${target.id}`);
    toast('Target deleted');
    onDone(null, true);
    onClose();
  };
  return (
    <Modal
      title={target ? `Edit ${target.name}` : 'Add MCP target'}
      onClose={onClose}
      wide
      footer={
        <>
          {target && (
            <button className="btn danger" onClick={() => void remove()} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={err} />
        <div className="form form-1-2">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-mcp-server" />
          </label>
          <label>
            URL <span className="hint">Streamable HTTP endpoint (…/mcp) or legacy SSE (…/sse)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        </div>
        <label>
          Transport
          <select value={transport} onChange={(e) => setTransport(e.target.value)}>
            <option value="auto">auto (Streamable HTTP, falls back to HTTP+SSE on 400 / 404 / 405)</option>
            <option value="streamable">Streamable HTTP (2025-03-26 and newer)</option>
            <option value="sse">HTTP+SSE (legacy 2024-11-05)</option>
          </select>
        </label>
        <div className="stack" style={{ gap: 6 }}>
          <span>
            Headers <span className="hint">e.g. Authorization: Bearer …, X-API-Key. Stored with the target; shown masked. Leave a masked value as is to keep it.</span>
          </span>
          {headers.map((h, i) => (
            <div key={i} className="row nowrap mt-header-row">
              <input value={h.name} placeholder="Authorization" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Header name" />
              <input value={h.value} placeholder="Bearer …" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Header value" />
              <button className="btn xs ghost" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label="Remove header">
                ✕
              </button>
            </div>
          ))}
          <div>
            <button className="btn xs" onClick={() => setHeaders([...headers, { name: '', value: '' }])}>
              + Header
            </button>
          </div>
        </div>
        <label>
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ tools

function useList<T>(base: string, session: McpSession, path: string, key: string, rev: number) {
  const [data, setData] = useState<(ListMeta & { items: T[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const r = await api.get<ListMeta & Record<string, unknown>>(`${base}/sessions/${session.id}/${path}${refresh ? '?refresh=1' : ''}`);
        setData({ ...r, items: (r[key] as T[]) ?? [] });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [base, session.id, path, key],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // list_changed: refetch.
  const stale = session.stale.includes(key);
  useEffect(() => {
    if (stale) void load();
  }, [stale, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, load };
}

function listError(e: ListMeta['error']): string | null {
  if (!e) return null;
  return typeof e === 'string' ? e : `${e.message} (JSON-RPC ${e.code})`;
}

function AnnotationBadges({ a }: { a: McpTool['annotations'] }) {
  if (!a) return null;
  return (
    <>
      {a.readOnlyHint && <Badge kind="ok">read-only</Badge>}
      {a.destructiveHint === true && !a.readOnlyHint && <Badge kind="bad">destructive</Badge>}
      {a.idempotentHint && <Badge>idempotent</Badge>}
      {a.openWorldHint && <Badge kind="accent">open world</Badge>}
    </>
  );
}

function ToolsTab({ base, session, target, rev, onSaved }: { base: string; session: McpSession; target: McpTarget | null; rev: number; onSaved: () => void }) {
  const list = useList<McpTool>(base, session, 'tools', 'tools', rev);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const tools = list.data?.items ?? [];
  const shown = tools.filter((t) => !filter || `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const tool = tools.find((t) => t.name === sel) ?? null;
  useEffect(() => {
    if (!sel && tools[0] && window.matchMedia('(min-width: 901px)').matches) setSel(tools[0].name);
  }, [tools, sel]);
  const err = listError(list.data?.error ?? null) ?? list.error;
  if (list.data && !list.data.supported && !tools.length) return <div className="card"><Empty title="No tools">The server does not declare the tools capability.</Empty></div>;
  return (
    <div className={`mt-split ${tool ? 'has-selection' : ''}`}>
      <div className="card mt-list">
        <div className="filters">
          <input type="search" placeholder={`Filter ${tools.length} tools…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn xs ghost" onClick={() => void list.load(true)} title="tools/list again">
            {list.loading ? '…' : '↻'}
          </button>
        </div>
        {err && <div className="card-pad"><ErrorBox error={err} /></div>}
        <div className="mt-list-body">
          {shown.map((t) => (
            <button key={t.name} className={`mt-item ${sel === t.name ? 'selected' : ''}`} onClick={() => setSel(t.name)}>
              <div className="row nowrap">
                <code className="mt-item-name ellipsis">{t.name}</code>
                <span className="spacer" />
                <AnnotationBadges a={t.annotations} />
              </div>
              {(t.title || t.description) && <div className="small faint mt-clamp">{t.title ? <strong>{t.title}. </strong> : null}{t.description}</div>}
              {!t.description && <div className="small" style={{ color: 'var(--warn)' }}>no description</div>}
            </button>
          ))}
          {list.data && !shown.length && <Empty title={tools.length ? 'No match' : 'The server lists no tools'} />}
        </div>
      </div>
      <div className="mt-detail">
        {tool ? <ToolDetail key={tool.name} base={base} session={session} tool={tool} target={target} onBack={() => setSel(null)} onSaved={onSaved} /> : <div className="card"><Empty title="Choose a tool" /></div>}
      </div>
    </div>
  );
}

function ToolDetail({ base, session, tool, target, onBack, onSaved }: { base: string; session: McpSession; tool: McpTool; target: McpTarget | null; onBack: () => void; onSaved: () => void }) {
  const schema = (tool.inputSchema ?? {}) as Json;
  const canForm = formable(schema);
  const [mode, setMode] = useState<'form' | 'json'>(canForm ? 'form' : 'json');
  const [args, setArgs] = useState<unknown>(() => initialValue(schema) ?? {});
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<CallOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const call = async () => {
    setRunning(true);
    setErr(null);
    try {
      setOut(await api.post<CallOutcome>(`${base}/sessions/${session.id}/call`, { name: tool.name, arguments: args ?? {} }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <button className="btn xs ghost viewer-back mt-back" onClick={onBack}>
              ← Tools
            </button>
            <h3 className="mt-tool-title">
              <code>{tool.name}</code>
              {tool.title && <span className="muted"> · {tool.title}</span>}
            </h3>
          </div>
          <div className="row-actions">
            <AnnotationBadges a={tool.annotations} />
            {tool.outputSchema && <Badge kind="accent">outputSchema</Badge>}
          </div>
        </div>
        <div className="card-pad stack">
          {tool.description ? <p className="mt-desc">{tool.description}</p> : <p className="small" style={{ color: 'var(--warn)', margin: 0 }}>No description: the model only sees the name.</p>}
          <div className="row">
            <div className="chips" role="tablist">
              <button className={`chip ${mode === 'form' ? 'active' : ''}`} disabled={!canForm} onClick={() => setMode('form')} title={canForm ? '' : 'inputSchema is not an object schema'}>
                Form
              </button>
              <button className={`chip ${mode === 'json' ? 'active' : ''}`} onClick={() => setMode('json')}>
                JSON
              </button>
            </div>
            <span className="spacer" />
            <button className="btn xs ghost" onClick={() => setArgs(initialValue(schema) ?? {})}>
              Reset
            </button>
          </div>
          {mode === 'form' && canForm ? <SchemaForm schema={schema} value={args} onChange={setArgs} /> : <JsonInput value={args} onChange={setArgs} rows={8} />}
          <div className="row">
            <button className="btn primary" onClick={() => void call()} disabled={running}>
              {running ? 'Calling…' : 'Call tool'}
            </button>
            {target ? (
              <button className="btn" onClick={() => setSaving(true)}>
                Save call
              </button>
            ) : (
              <span className="small faint">Save the target to keep calls as a regression suite.</span>
            )}
          </div>
          <ErrorBox error={err} />
        </div>
      </div>
      {out && <CallResult out={out} />}
      <details className="card mt-details">
        <summary>Schemas</summary>
        <div className="card-pad stack">
          <CodeBlock title="inputSchema" code={JSON.stringify(tool.inputSchema ?? null, null, 2)} />
          {tool.outputSchema && <CodeBlock title="outputSchema" code={JSON.stringify(tool.outputSchema, null, 2)} />}
        </div>
      </details>
      {saving && target && <SaveCallModal base={base} target={target} tool={tool.name} args={(args ?? {}) as Json} last={out} onClose={() => setSaving(false)} onSaved={onSaved} />}
    </div>
  );
}

function CallResult({ out }: { out: CallOutcome }) {
  const head =
    out.kind === 'transport_error' ? (
      <Badge kind="bad">No answer</Badge>
    ) : out.kind === 'rpc_error' ? (
      <Badge kind="bad">JSON-RPC error {out.rpcError?.code}</Badge>
    ) : out.isError ? (
      <Badge kind="warn">Tool error (isError)</Badge>
    ) : (
      <Badge kind="ok">Result</Badge>
    );
  const content = (out.result?.content as Json[] | undefined) ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          {head}
          <span className="small faint">{out.durationMs} ms</span>
          {out.progress.length > 0 && <span className="small faint">· {out.progress.length} progress notification(s)</span>}
        </div>
      </div>
      <div className="card-pad stack">
        {out.kind === 'transport_error' && <div className="error-box">{out.error}</div>}
        {out.kind === 'rpc_error' && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="error-box">{out.rpcError?.message}</div>
            <p className="small muted" style={{ margin: 0 }}>
              A protocol error, not a tool result{out.rpcError && ![-32602, -32601, -32600].includes(out.rpcError.code) ? ': tool failures should come back as a result with isError: true so the model can read and fix them' : ''}.
            </p>
          </div>
        )}
        {out.contentProblems.length > 0 && <div className="error-box">Invalid content: {out.contentProblems.join('; ')}</div>}
        {content.map((b, i) => (
          <ContentBlock key={i} b={b} />
        ))}
        {out.validation && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <strong className="small">structuredContent</strong>
              {!out.validation.hasStructured ? <Badge kind={out.isError ? '' : 'bad'}>missing</Badge> : out.validation.errors.length ? <Badge kind="bad">does not match outputSchema</Badge> : <Badge kind="ok">matches outputSchema</Badge>}
            </div>
            {out.validation.errors.length > 0 && (
              <ul className="mt-errors">
                {out.validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {out.result?.structuredContent !== undefined && <CodeBlock title="structuredContent" code={JSON.stringify(out.result.structuredContent, null, 2)} />}
        <details>
          <summary className="small muted">Raw result</summary>
          <CodeBlock code={JSON.stringify(out.result ?? out.rpcError ?? { error: out.error }, null, 2)} />
        </details>
      </div>
    </div>
  );
}

function ContentBlock({ b }: { b: Json }) {
  const ann = b.annotations ? <span className="small faint"> {JSON.stringify(b.annotations)}</span> : null;
  switch (b.type) {
    case 'text':
      return <CodeBlock title={`text${b.annotations ? ` ${JSON.stringify(b.annotations)}` : ''}`} code={prettyMaybe(String(b.text ?? ''))} />;
    case 'image':
      return (
        <figure className="mt-figure">
          <img src={`data:${b.mimeType};base64,${b.data}`} alt="Image result" />
          <figcaption className="small faint">
            image · {String(b.mimeType)} · {fmtBytes(Math.floor((String(b.data ?? '').length * 3) / 4))}
            {ann}
          </figcaption>
        </figure>
      );
    case 'audio':
      return (
        <figure className="mt-figure">
          <audio controls src={`data:${b.mimeType};base64,${b.data}`} />
          <figcaption className="small faint">audio · {String(b.mimeType)}</figcaption>
        </figure>
      );
    case 'resource_link':
      return (
        <div className="mt-block">
          <Badge>resource link</Badge> <code>{String(b.uri)}</code> {b.name ? <strong>{String(b.name)}</strong> : null} {b.mimeType ? <span className="faint small">{String(b.mimeType)}</span> : null}
          {b.description ? <div className="small muted">{String(b.description)}</div> : null}
        </div>
      );
    case 'resource': {
      const r = (b.resource ?? {}) as Json;
      return <ResourceContents c={r} title={`embedded resource · ${String(r.uri ?? '')}`} />;
    }
    default:
      return <CodeBlock title={`unknown block type ${JSON.stringify(b.type)}`} code={JSON.stringify(b, null, 2)} />;
  }
}

function prettyMaybe(t: string): string {
  const s = t.trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return t;
}

function ResourceContents({ c, title }: { c: Json; title: string }) {
  const mime = String(c.mimeType ?? '');
  if (typeof c.text === 'string') return <CodeBlock title={`${title}${mime ? ` · ${mime}` : ''}`} code={prettyMaybe(c.text)} />;
  if (typeof c.blob === 'string') {
    const href = `data:${mime || 'application/octet-stream'};base64,${c.blob}`;
    return (
      <figure className="mt-figure">
        {mime.startsWith('image/') && <img src={href} alt={String(c.uri ?? 'resource')} />}
        <figcaption className="small faint">
          {title} · {mime || 'binary'} · {fmtBytes(Math.floor((c.blob.length * 3) / 4))} ·{' '}
          <a href={href} download={String(c.uri ?? 'resource').split('/').pop() || 'resource'}>
            Download
          </a>
        </figcaption>
      </figure>
    );
  }
  return <CodeBlock title={title} code={JSON.stringify(c, null, 2)} />;
}

function SaveCallModal({ base, target, tool, args, last, onClose, onSaved }: { base: string; target: McpTarget; tool: string; args: Json; last: CallOutcome | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(tool);
  const [isError, setIsError] = useState(last?.isError ? 'true' : 'false');
  const [contains, setContains] = useState('');
  const [maxMs, setMaxMs] = useState('');
  const save = async () => {
    try {
      await api.post(`${base}/targets/${target.id}/saved`, { name, tool, arguments: args, expect: { isError: isError === 'true', contains: contains || undefined, maxMs: maxMs ? Number(maxMs) : undefined } });
      toast(`Saved "${name}"`);
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <Modal
      title={`Save call to ${tool}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="form form-3">
          <label>
            Expect isError
            <select value={isError} onChange={(e) => setIsError(e.target.value)}>
              <option value="false">false (success)</option>
              <option value="true">true (error path)</option>
            </select>
          </label>
          <label>
            Result contains
            <input value={contains} onChange={(e) => setContains(e.target.value)} placeholder="optional text" />
          </label>
          <label>
            Max ms
            <input type="number" value={maxMs} onChange={(e) => setMaxMs(e.target.value)} placeholder="optional" />
          </label>
        </div>
        <CodeBlock title="arguments" code={JSON.stringify(args, null, 2)} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ resources / prompts

function ResourcesTab({ base, session, rev }: { base: string; session: McpSession; rev: number }) {
  const res = useList<McpResource>(base, session, 'resources', 'resources', rev);
  const tpl = useList<McpResourceTemplate>(base, session, 'resource-templates', 'resourceTemplates', rev);
  const [read, setRead] = useState<{ uri: string; out: RpcOutcome } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const canSubscribe = (session.capabilities.resources as Json | undefined)?.subscribe === true;
  const doRead = async (uri: string) => {
    setBusy(uri);
    try {
      setRead({ uri, out: await api.post<RpcOutcome>(`${base}/sessions/${session.id}/read`, { uri }) });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const subscribe = async (uri: string, on: boolean) => {
    const r = await api.post<RpcOutcome>(`${base}/sessions/${session.id}/subscribe`, { uri, subscribe: on });
    toast(r.error ? r.error.message : on ? 'Subscribed: updates appear in the Log' : 'Unsubscribed');
  };
  if (res.data && !res.data.supported) return <div className="card"><Empty title="No resources">The server does not declare the resources capability.</Empty></div>;
  return (
    <div className="mt-split has-selection mt-split-even">
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3>Resources <span className="faint small">{res.data?.items.length ?? ''}</span></h3>
            <button className="btn xs ghost" onClick={() => void res.load(true)}>↻</button>
          </div>
          <ErrorBox error={listError(res.data?.error ?? null) ?? res.error} />
          {(res.data?.items ?? []).map((r) => (
            <div key={r.uri} className="row nowrap list-row mt-row">
              <div className="grow">
                <div className="ellipsis">
                  <strong>{r.title || r.name}</strong> {r.mimeType && <span className="faint small">{r.mimeType}</span>}
                </div>
                <code className="small ellipsis" style={{ display: 'block' }}>{r.uri}</code>
                {r.description && <div className="small faint mt-clamp">{r.description}</div>}
              </div>
              <div className="row-actions">
                {canSubscribe && (
                  <button className="btn xs ghost" onClick={() => void subscribe(r.uri, !session.subscriptions.includes(r.uri))}>
                    {session.subscriptions.includes(r.uri) ? 'Unsubscribe' : 'Subscribe'}
                  </button>
                )}
                <button className="btn xs" onClick={() => void doRead(r.uri)} disabled={busy === r.uri}>
                  Read
                </button>
              </div>
            </div>
          ))}
          {res.data && !res.data.items.length && <Empty title="No resources listed" />}
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Resource templates <span className="faint small">{tpl.data?.items.length ?? ''}</span></h3>
          </div>
          <ErrorBox error={listError(tpl.data?.error ?? null)} />
          {(tpl.data?.items ?? []).map((t) => (
            <TemplateRow key={t.uriTemplate} t={t} onRead={(uri) => void doRead(uri)} />
          ))}
          {tpl.data && !tpl.data.items.length && <Empty title="No templates" />}
        </div>
      </div>
      <div className="mt-detail">
        {read ? (
          <div className="card">
            <div className="card-head">
              <div className="grow ellipsis">
                <code>{read.uri}</code>
              </div>
              <span className="small faint">{read.out.durationMs} ms</span>
            </div>
            <div className="card-pad stack">
              {read.out.error ? <div className="error-box">{read.out.error.message} (JSON-RPC {read.out.error.code})</div> : null}
              {((read.out.result?.contents as Json[]) ?? []).map((c, i) => (
                <ResourceContents key={i} c={c} title={String(c.uri ?? read.uri)} />
              ))}
            </div>
          </div>
        ) : (
          <div className="card">
            <Empty title="Read a resource">Its contents (text or binary preview) appear here.</Empty>
          </div>
        )}
      </div>
    </div>
  );
}

/** RFC 6570 variables of a URI template ({id}, {+path}, {?q,lang}). */
function templateVars(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/\{([+#./;?&]?)([^}]+)\}/g)) for (const v of m[2].split(',')) out.push(v.replace(/\*$|:\d+$/, ''));
  return [...new Set(out)];
}

function expandTemplate(t: string, vals: Record<string, string>): string {
  return t.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_, op: string, list: string) => {
    const names = list.split(',').map((v) => v.replace(/\*$|:\d+$/, ''));
    const enc = (v: string) => (op === '+' || op === '#' ? encodeURI(v) : encodeURIComponent(v));
    const vs = names.filter((n) => vals[n] !== undefined && vals[n] !== '');
    if (!vs.length) return '';
    if (op === '?' || op === '&') return (op === '?' ? '?' : '&') + vs.map((n) => `${n}=${enc(vals[n])}`).join('&');
    const sep = op === '.' ? '.' : op === '/' ? '/' : op === ';' ? ';' : op === '#' ? '#' : '';
    return sep + vs.map((n) => enc(vals[n])).join(',');
  });
}

function TemplateRow({ t, onRead }: { t: McpResourceTemplate; onRead: (uri: string) => void }) {
  const vars = useMemo(() => templateVars(t.uriTemplate), [t.uriTemplate]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const uri = expandTemplate(t.uriTemplate, vals);
  return (
    <div className="mt-row stack" style={{ gap: 6 }}>
      <div>
        <strong>{t.title || t.name}</strong> {t.mimeType && <span className="faint small">{t.mimeType}</span>}
        <code className="small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{t.uriTemplate}</code>
        {t.description && <div className="small faint">{t.description}</div>}
      </div>
      <div className="row mt-vars">
        {vars.map((v) => (
          <input key={v} placeholder={v} aria-label={v} value={vals[v] ?? ''} onChange={(e) => setVals({ ...vals, [v]: e.target.value })} />
        ))}
        <button className="btn xs" onClick={() => onRead(uri)} disabled={vars.some((v) => !vals[v])} title={uri}>
          Read
        </button>
      </div>
    </div>
  );
}

function PromptsTab({ base, session, rev }: { base: string; session: McpSession; rev: number }) {
  const list = useList<McpPrompt>(base, session, 'prompts', 'prompts', rev);
  const [sel, setSel] = useState<string | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [out, setOut] = useState<RpcOutcome | null>(null);
  const toast = useToast();
  const prompts = list.data?.items ?? [];
  const p = prompts.find((x) => x.name === sel) ?? null;
  const get = async () => {
    if (!p) return;
    try {
      setOut(await api.post<RpcOutcome>(`${base}/sessions/${session.id}/prompt`, { name: p.name, arguments: args }));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (list.data && !list.data.supported) return <div className="card"><Empty title="No prompts">The server does not declare the prompts capability.</Empty></div>;
  return (
    <div className={`mt-split ${p ? 'has-selection' : ''}`}>
      <div className="card mt-list">
        <div className="card-head">
          <h3>Prompts <span className="faint small">{prompts.length}</span></h3>
          <button className="btn xs ghost" onClick={() => void list.load(true)}>↻</button>
        </div>
        <ErrorBox error={listError(list.data?.error ?? null) ?? list.error} />
        <div className="mt-list-body">
          {prompts.map((x) => (
            <button key={x.name} className={`mt-item ${sel === x.name ? 'selected' : ''}`} onClick={() => (setSel(x.name), setArgs({}), setOut(null))}>
              <code className="mt-item-name">{x.name}</code>
              {(x.title || x.description) && <div className="small faint mt-clamp">{x.title ? <strong>{x.title}. </strong> : null}{x.description}</div>}
            </button>
          ))}
          {list.data && !prompts.length && <Empty title="No prompts listed" />}
        </div>
      </div>
      <div className="mt-detail">
        {p ? (
          <div className="stack">
            <div className="card">
              <div className="card-head">
                <div className="grow">
                  <button className="btn xs ghost viewer-back mt-back" onClick={() => setSel(null)}>
                    ← Prompts
                  </button>
                  <h3 className="mt-tool-title"><code>{p.name}</code></h3>
                </div>
              </div>
              <div className="card-pad stack">
                {p.description && <p className="mt-desc">{p.description}</p>}
                <div className="sf-fields">
                  {(p.arguments ?? []).map((a) => (
                    <label key={a.name} className="sf-field">
                      <span className="sf-label">
                        <code>{a.name}</code>
                        {a.required && <span className="sf-req">*</span>}
                        {a.description && <span className="sf-desc">{a.description}</span>}
                      </span>
                      <input value={args[a.name] ?? ''} onChange={(e) => setArgs({ ...args, [a.name]: e.target.value })} />
                    </label>
                  ))}
                  {!p.arguments?.length && <p className="muted small" style={{ margin: 0 }}>No arguments.</p>}
                </div>
                <div>
                  <button className="btn primary" onClick={() => void get()}>
                    Get prompt
                  </button>
                </div>
              </div>
            </div>
            {out && (
              <div className="card">
                <div className="card-head">
                  <h3>Messages</h3>
                  <span className="small faint">{out.durationMs} ms</span>
                </div>
                <div className="card-pad stack">
                  {out.error && <div className="error-box">{out.error.message} (JSON-RPC {out.error.code})</div>}
                  {typeof out.result?.description === 'string' && <p className="muted small" style={{ margin: 0 }}>{out.result.description}</p>}
                  {((out.result?.messages as { role: string; content: Json }[]) ?? []).map((m, i) => (
                    <div key={i} className="mt-message">
                      <Badge kind={m.role === 'assistant' ? 'accent' : ''}>{m.role}</Badge>
                      <div className="grow">
                        <ContentBlock b={m.content} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="card"><Empty title="Choose a prompt" /></div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ log

const KIND_BADGE: Record<LogEntry['kind'], string> = { request: 'accent', response: 'ok', error: 'bad', notification: '', transport: '', invalid: 'bad' };
type LogFilter = 'all' | 'rpc' | 'notifications' | 'errors' | 'transport';

function matches(f: LogFilter, e: LogEntry): boolean {
  if (f === 'rpc') return ['request', 'response', 'error'].includes(e.kind);
  if (f === 'notifications') return e.kind === 'notification';
  if (f === 'errors') return e.kind === 'error' || e.kind === 'invalid' || (e.status ?? 0) >= 400;
  if (f === 'transport') return e.kind === 'transport';
  return true;
}

function LogTab({ base, session, rev }: { base: string; session: McpSession; rev: number }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [serverLogs, setServerLogs] = useState<{ at: string; level: string; logger?: string; data: unknown }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<LogFilter>('all');
  const copy = useCopy();
  const load = useCallback(
    async (reset = false) => {
      const after = reset ? 0 : entries.at(-1)?.seq ?? 0;
      const r = await api.get<{ entries: LogEntry[]; serverLogs: typeof serverLogs }>(`${base}/sessions/${session.id}/log?after=${after}`);
      setEntries((cur) => {
        if (reset) return r.entries;
        const last = cur.at(-1)?.seq ?? 0;
        return [...cur, ...r.entries.filter((e) => e.seq > last)].slice(-2000);
      });
      setServerLogs(r.serverLogs);
    },
    [base, session.id, entries],
  );
  useEffect(() => {
    void load(true);
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (rev) void load();
  }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = async () => {
    await api.del(`${base}/sessions/${session.id}/log`);
    setEntries([]);
  };
  const shown = entries.filter((e) => matches(filter, e)).slice().reverse();
  const t0 = entries[0] ? Date.parse(entries[0].at) : 0;
  return (
    <div className="stack">
      <div className="card">
        <div className="filters">
          <div className="chips">
            {(['all', 'rpc', 'notifications', 'errors', 'transport'] as LogFilter[]).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {f === 'rpc' ? 'requests' : f}
                <span className="n">{entries.filter((e) => matches(f, e)).length}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="btn xs" onClick={() => void copy(JSON.stringify(entries, null, 2), `Copied ${entries.length} messages`)}>
            Copy all
          </button>
          <button className="btn xs ghost" onClick={() => void clear()}>
            Clear
          </button>
        </div>
        <div className="table-wrap">
          <table className="mt-log">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th></th>
                <th>Kind</th>
                <th>Method</th>
                <th className="col-sm">id</th>
                <th>ms</th>
                <th className="col-sm">Size</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <LogRow key={e.seq} e={e} t0={t0} open={open === e.seq} onToggle={() => setOpen(open === e.seq ? null : e.seq)} />
              ))}
            </tbody>
          </table>
        </div>
        {!shown.length && <Empty title="No messages" />}
      </div>
      {serverLogs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Server log messages <span className="faint small">notifications/message</span></h3>
          </div>
          <div className="card-pad">
            <CodeBlock code={serverLogs.map((l) => `${fmtTime(l.at)} ${l.level.toUpperCase()}${l.logger ? ` [${l.logger}]` : ''} ${typeof l.data === 'string' ? l.data : JSON.stringify(l.data)}`).join('\n')} />
          </div>
        </div>
      )}
    </div>
  );
}

function LogRow({ e, t0, open, onToggle }: { e: LogEntry; t0: number; open: boolean; onToggle: () => void }) {
  const arrow = e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '·';
  const detail = e.note ?? (e.kind === 'error' ? String(((e.payload as Json)?.error as Json)?.message ?? '') : e.kind === 'response' && (e.payload as Json)?.result && ((e.payload as Json).result as Json).isError ? 'isError: true' : '');
  return (
    <>
      <tr className={`mt-log-row ${open ? 'open' : ''}`} onClick={onToggle}>
        <td className="faint">{e.seq}</td>
        <td className="faint" title={e.at}>+{((Date.parse(e.at) - t0) / 1000).toFixed(2)}s</td>
        <td className={`mt-dir ${e.dir}`} title={e.dir === 'out' ? 'devhub → server' : e.dir === 'in' ? 'server → devhub' : 'devhub'}>
          {arrow}
        </td>
        <td>
          <Badge kind={KIND_BADGE[e.kind]}>{e.kind}</Badge>
        </td>
        <td>
          {e.method && <code className="small">{e.method}</code>}
          {e.source && e.source !== 'tester' && <span className="faint small"> · {e.source}</span>}
        </td>
        <td className="faint col-sm">{e.id ?? ''}</td>
        <td>{e.durationMs !== undefined ? e.durationMs : ''}</td>
        <td className="faint col-sm">{e.size ? fmtBytes(e.size) : ''}</td>
        <td className="cell-fill">
          <div className="ellipsis small">{e.status ? `HTTP ${e.status} ` : ''}{detail}</div>
        </td>
      </tr>
      {open && (
        <tr className="mt-log-detail">
          <td colSpan={9}>
            {e.payload !== undefined ? <CodeBlock title={`${e.kind}${e.method ? ` · ${e.method}` : ''}${e.logId ? ` · traffic log ${e.logId}` : ''}`} code={typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2)} /> : <span className="small muted">{e.note}</span>}
          </td>
        </tr>
      )}
    </>
  );
}

// ------------------------------------------------------------------ checks

function ChecksTab({ base, session, report, setReport, catalog }: { base: string; session: McpSession; report: CheckReport | null; setReport: (r: CheckReport) => void; catalog: McpOverview['checks'] }) {
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async () => {
    setRunning(true);
    setErr(null);
    try {
      setReport(await api.post<CheckReport>(`${base}/sessions/${session.id}/checks`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [base, session.id, setReport]);
  useEffect(() => {
    if (report) return;
    api
      .get<CheckReport>(`${base}/sessions/${session.id}/checks`)
      .then(setReport)
      .catch(() => void run());
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = report ? [...report.stats.perTool].sort((a, b) => b.tokens - a.tokens).slice(0, 8) : [];
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div className="row">
            <h3>MCP checks</h3>
            {report && (
              <>
                <Badge kind={report.summary.error ? 'bad' : 'ok'}>{report.summary.error} errors</Badge>
                <Badge kind={report.summary.warn ? 'warn' : ''}>{report.summary.warn} warnings</Badge>
                <Badge>{report.summary.info} notes</Badge>
                <span className="small faint">{timeAgo(report.ranAt)}</span>
              </>
            )}
          </div>
          <button className="btn sm" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Run checks'}
          </button>
        </div>
        <div className="card-pad stack">
          <ErrorBox error={err} />
          <p className="muted small" style={{ margin: 0 }}>
            Definitions are checked on every run; structuredContent and error handling are checked for the tools you called in this session. A run also sends ping and one tools/call with a name that does not exist.
          </p>
          {report && !report.findings.length && <div className="info-box">No findings. Call a few tools and run again to check their results.</div>}
          {report && report.findings.length > 0 && (
            <ul className="lint-list mt-findings">
              {report.findings.map((f, i) => (
                <li key={i}>
                  <Badge kind={SEV_KIND[f.severity]}>{f.severity}</Badge>
                  <span className="lint-msg">
                    {f.subject && <code className="mt-subject">{f.subject}</code>} {f.message}
                    {f.detail && <span className="small faint mt-detail-line">{f.detail}</span>}
                    <span className="faint small"> · {f.check}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {report && (
        <div className="cards-flow">
          <div className="card">
            <div className="card-head">
              <h3>Tool list size</h3>
              <span className="small faint">≈ characters ÷ 4</span>
            </div>
            <div className="card-pad stack">
              <div className="row">
                <span className="mt-big">≈{report.stats.toolTokens.toLocaleString()}</span>
                <span className="muted small">
                  tokens for {report.stats.tools} tools, sent to the model on every turn
                </span>
              </div>
              {top.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {top.map((t) => (
                        <tr key={t.name}>
                          <td className="cell-fill">
                            <code className="ellipsis" style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' }}>{t.name}</code>
                          </td>
                          <td style={{ textAlign: 'right' }}>≈{t.tokens}</td>
                          <td style={{ width: 120 }}>
                            <div className="mt-bar">
                              <span style={{ width: `${Math.round((t.tokens / Math.max(1, top[0].tokens)) * 100)}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          <details className="card mt-details">
            <summary>What is checked ({catalog.length})</summary>
            <ul className="mt-catalog">
              {catalog.map((c) => (
                <li key={c.id}>
                  <code>{c.id}</code> <span className="faint small">{c.severity}</span>
                  <div className="small muted">{c.title}</div>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ saved calls

function SavedTab({ base, target, onChanged }: { base: string; target: McpTarget | null; onChanged: () => void }) {
  const calls = useFetch<SavedCall[]>(target ? `${base}/targets/${target.id}/saved` : null, [target?.id]);
  const [running, setRunning] = useState<string | null>(null);
  const [last, setLast] = useState<RunSavedResponse | null>(null);
  const toast = useToast();
  if (!target) {
    return (
      <div className="card">
        <Empty title="Saved calls belong to a saved target">Save this target (Save next to Connect), then use “Save call” on a tool.</Empty>
      </div>
    );
  }
  const runAll = async (ids?: string[]) => {
    setRunning(ids?.[0] ?? 'all');
    try {
      const r = await api.post<RunSavedResponse>(`${base}/targets/${target.id}/run-saved`, { ids });
      setLast(r);
      toast(`${r.passed} passed, ${r.failed} failed`);
      await calls.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setRunning(null);
    }
  };
  const remove = async (c: SavedCall) => {
    if (!confirm(`Delete saved call "${c.name}"?`)) return;
    await api.del(`${base}/saved/${c.id}`);
    await calls.reload();
    onChanged();
  };
  const list = calls.data ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <h3>Saved calls · {target.name}</h3>
          {last && (
            <>
              <Badge kind="ok">{last.passed} passed</Badge>
              <Badge kind={last.failed ? 'bad' : ''}>{last.failed} failed</Badge>
              <span className="small faint">{last.durationMs} ms</span>
            </>
          )}
        </div>
        <button className="btn sm primary" onClick={() => void runAll()} disabled={!list.length || !!running}>
          {running === 'all' ? 'Running…' : 'Run all'}
        </button>
      </div>
      <ErrorBox error={calls.error} />
      {list.length === 0 ? (
        <Empty title="No saved calls">Open a tool, fill in arguments and press “Save call”. API: POST …/targets/{'{id}'}/run-saved; MCP: mcp_tester_run_saved.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="mt-saved">
            <thead>
              <tr>
                <th>Result</th>
                <th>Name</th>
                <th>Tool</th>
                <th>Expect</th>
                <th>Details</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const r = c.lastResult;
                const exp = [c.expect.isError ? 'isError' : 'success', c.expect.contains ? `contains “${c.expect.contains}”` : '', c.expect.maxMs ? `≤ ${c.expect.maxMs} ms` : ''].filter(Boolean).join(' · ');
                return (
                  <tr key={c.id}>
                    <td>{r ? <Badge kind={r.pass ? 'ok' : 'bad'}>{r.pass ? 'pass' : 'fail'}</Badge> : <span className="faint small">not run</span>}</td>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td>
                      <code>{c.tool}</code>
                    </td>
                    <td className="small">{exp}</td>
                    <td className="cell-fill">
                      <div className="ellipsis small" title={r ? [...r.failures, r.preview].filter(Boolean).join('\n') : JSON.stringify(c.arguments)}>
                        {r ? (r.failures.length ? <span style={{ color: 'var(--bad)' }}>{r.failures.join('; ')}</span> : <span className="faint">{r.durationMs} ms · {r.preview}</span>) : <code className="faint">{JSON.stringify(c.arguments)}</code>}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="btn xs" onClick={() => void runAll([c.id])} disabled={!!running}>
                          {running === c.id ? '…' : 'Run'}
                        </button>
                        <button className="btn xs ghost" onClick={() => void remove(c)} aria-label={`Delete ${c.name}`}>
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

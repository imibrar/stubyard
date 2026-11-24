import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { chatBase, fmtTokens, parseExpectationLines, AIP, type AiProvider, type ChatAgent, type ConversationFull, type MatrixColumn, type MatrixModel, type MatrixRun, type MatrixTools } from '../chatApi';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useFetch, useHubEvents } from '../hooks';
import { Icon, Menu, useLocalState } from './people';
import { Badge, Empty, ErrorBox, timeAgo, useToast } from './ui';

/**
 * Chat → Matrix: one prompt across 2–6 models side by side (POST …/chat/matrix). Columns: grid ≥1280 px, horizontal
 * snap-scroll cards at tablet widths, stacked accordions on phones. Tokens and time only, no cost.
 */

const MIN = 2;
const MAX = 6;
const usable = (p: AiProvider) => p.enabled && (p.hasKey || !p.needsKey);
const COL_KIND: Record<MatrixColumn['status'], string> = { pending: '', running: 'accent', done: 'ok', error: 'bad', cancelled: 'warn' };

function useNarrow(query = '(width < 640px)') {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

export default function ChatMatrix({ agents, providers, runId }: { agents: ChatAgent[]; providers: AiProvider[]; runId?: string }) {
  const { slug } = useProject();
  const base = chatBase(slug);
  const list = useFetch<MatrixRun[]>(`${base}/matrix`, [slug]);
  const run = useFetch<MatrixRun>(runId ? `${base}/matrix/${runId}` : null, [slug, runId]);
  useHubEvents(slug, (e) => {
    if (e.type !== 'chat.changed') return;
    const d = (e.data ?? {}) as { matrix?: string; kind?: string };
    if (d.matrix || d.kind === 'reset') {
      void list.reload();
      if (runId && (d.matrix === runId || d.kind === 'reset')) void run.reload();
    }
  });
  return (
    <div className={`mx-layout ${runId ? 'has-run' : ''}`}>
      <MatrixForm agents={agents} providers={providers} onStarted={() => void list.reload()} />
      {runId && (
        <div className="mx-result">
          <ErrorBox error={run.error} />
          {run.data ? <MatrixResult run={run.data} agents={agents} reload={run.reload} /> : !run.error && <div className="card card-pad faint">Loading…</div>}
        </div>
      )}
      <MatrixHistory runs={list.data} error={list.error} current={runId} />
    </div>
  );
}

// ---------------------------------------------------------------- form

function MatrixForm({ agents, providers, onStarted }: { agents: ChatAgent[]; providers: AiProvider[]; onStarted: () => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const nav = useNavigate();
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const [prompt, setPrompt] = useState(params.get('prompt') ?? '');
  const [agentId, setAgentId] = useState(params.get('agent') ?? '');
  const [models, setModels] = useLocalState<MatrixModel[]>(`stubyard.chat.matrix.models.${slug}`, []);
  const [tools, setTools] = useState<MatrixTools | ''>('');
  const [confirm, setConfirm] = useState(false);
  const [exp, setExp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agent = agents.find((a) => a.id === agentId || a.slug === agentId) ?? null;
  const toolsMode: MatrixTools = tools || (agent ? 'builtin' : 'none');
  const hasTargets = !!agent?.tools.targets.length;

  useEffect(() => {
    const p = new URLSearchParams(loc.search);
    if (p.get('prompt')) setPrompt(p.get('prompt') ?? '');
    if (p.get('agent')) setAgentId(p.get('agent') ?? '');
  }, [loc.search]);

  const add = (m: MatrixModel) => {
    if (models.length >= MAX) return;
    setModels([...models, m]);
  };
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const expectations = parseExpectationLines(exp);
      const r = await api.post<MatrixRun>(`${chatBase(slug)}/matrix`, {
        prompt,
        models,
        agent: agent?.id,
        tools: toolsMode,
        confirmSideEffects: toolsMode === 'agent' ? confirm : undefined,
        expectations: Object.keys(expectations).length ? expectations : undefined,
      });
      onStarted();
      nav(`/p/${slug}/chat/matrix/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mocks = providers.filter((p) => p.mock);
  const ready = prompt.trim() && models.length >= MIN && models.length <= MAX && (toolsMode !== 'agent' || confirm);

  return (
    <div className="card mx-form">
      <div className="card-head">
        <h2 className="grow">Compare models</h2>
        <span className="small faint">{models.length} / {MAX} models</span>
      </div>
      <div className="card-pad stack mx-form-body">
        <ErrorBox error={error} />
        <label className="field">
          Prompt
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Which test users does this project have?" />
        </label>
        <div className="field">
          <span>Models <span className="hint">{MIN}–{MAX}; the same prompt goes to each, 3 at a time</span></span>
          <div className="mx-chips">
            {models.map((m, i) => (
              <span key={`${m.provider}/${m.model}/${i}`} className="chip mx-chip">
                <span className="mono ellipsis">{m.model}</span>
                <span className="small faint ellipsis">{m.provider}</span>
                <button type="button" className="btn xs ghost" aria-label={`Remove ${m.provider} ${m.model}`} onClick={() => setModels(models.filter((_, k) => k !== i))}>
                  ×
                </button>
              </span>
            ))}
            {!models.length && <span className="small faint">No models yet.</span>}
          </div>
          <ModelPicker providers={providers.filter(usable)} onAdd={add} disabled={models.length >= MAX} />
          {mocks.length === 2 && models.length === 0 && (
            <button
              type="button"
              className="btn sm ghost mx-quick"
              onClick={() =>
                setModels([
                  { provider: 'mock:openai', model: 'gpt-5-mini' },
                  { provider: 'mock:anthropic', model: 'claude-haiku-4-5' },
                ])
              }
            >
              Use mock:openai + mock:anthropic (keyless, answered by LLM mocks)
            </button>
          )}
        </div>
        <div className="mx-form-row">
          <label className="field">
            Agent <span className="hint">instructions and settings</span>
            <select value={agent?.id ?? ''} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">No agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Tools
            <select value={toolsMode} onChange={(e) => (setTools(e.target.value as MatrixTools), setConfirm(false))}>
              <option value="none">None</option>
              <option value="builtin">stubyard read-only tools</option>
              <option value="agent" disabled={!agent}>
                The agent’s tools (incl. MCP servers)
              </option>
            </select>
          </label>
        </div>
        {toolsMode === 'agent' && (
          <div className="mx-warn small">
            <p>
              Every model gets {agent?.name ?? 'the agent'}’s tools{hasTargets ? ', including its MCP server tools' : ''}. A tool that changes state may run once per model ({models.length || 'N'}{' '}
              times).
            </p>
            <label className="chat-check">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand, run the tools for every model
            </label>
          </div>
        )}
        <label className="field">
          Expectations <span className="hint">optional, one per line: contains: Paris · not: sorry · calls: list_test_users · maxSteps: 3</span>
          <textarea value={exp} onChange={(e) => setExp(e.target.value)} rows={2} className="mono" placeholder="contains: Paris" />
        </label>
        <div className="row mx-actions">
          <button className="btn primary" disabled={!ready || busy || !!gate.disabled} title={gate.title} onClick={() => void run()}>
            {busy ? 'Starting…' : `Run on ${models.length} model${models.length === 1 ? '' : 's'}`}
          </button>
          <span className="small faint">Tokens and time only, no cost estimates.</span>
        </div>
      </div>
    </div>
  );
}

function ModelPicker({ providers, onAdd, disabled }: { providers: AiProvider[]; onAdd: (m: MatrixModel) => void; disabled: boolean }) {
  const [provider, setProvider] = useState(providers[0]?.name ?? '');
  const [model, setModel] = useState('');
  const [ids, setIds] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].name);
  }, [providers, provider]);
  // Model ids are listed when the model box gets focus (a real provider is only called then, once per provider).
  const loadIds = () => {
    if (!provider || ids[provider]) return;
    setIds((m) => ({ ...m, [provider]: [] }));
    api
      .get<{ models: { id: string }[] }>(`${AIP}/${encodeURIComponent(provider)}/models`)
      .then((r) => setIds((m) => ({ ...m, [provider]: r.models.map((x) => x.id) })))
      .catch(() => undefined);
  };
  const submit = () => {
    if (!provider || !model.trim()) return;
    onAdd({ provider, model: model.trim() });
    setModel('');
  };
  if (!providers.length)
    return (
      <p className="small faint">
        No usable AI provider. Add one in <Link to="/system?tab=ai">System → AI providers</Link>.
      </p>
    );
  return (
    <div className="mx-picker">
      <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="AI provider">
        {providers.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}
            {p.mock ? ' (mock)' : ''}
          </option>
        ))}
      </select>
      <input
        value={model}
        onChange={(e) => setModel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())}
        onFocus={loadIds}
        list="mx-model-ids"
        placeholder="model id, e.g. gpt-5-mini"
        className="mono"
        aria-label="Model"
      />
      <datalist id="mx-model-ids">
        {(ids[provider] ?? []).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button type="button" className="btn" onClick={submit} disabled={disabled || !model.trim()}>
        <Icon name="plus" size={14} /> Add
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- result

function MatrixResult({ run, agents, reload }: { run: MatrixRun; agents: ChatAgent[]; reload: () => Promise<void> }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const base = chatBase(slug);
  const nav = useNavigate();
  const toast = useToast();
  const narrow = useNarrow();
  const done = run.columns.filter((c) => c.status === 'done' || c.status === 'error' || c.status === 'cancelled').length;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const rerun = () =>
    act(async () => {
      const r = await api.post<MatrixRun>(`${base}/matrix/${run.id}/rerun`, run.config.tools === 'agent' ? { confirmSideEffects: confirm('Run the agent’s tools again for every model?') } : {});
      nav(`/p/${slug}/chat/matrix/${r.id}`);
    });
  const remove = () =>
    act(async () => {
      if (!confirm('Delete this comparison?')) return;
      await api.del(`${base}/matrix/${run.id}`);
      nav(`/p/${slug}/chat/matrix`);
    });
  const exp = run.config.expectations;
  return (
    <div className="card mx-run">
      <div className="card-head mx-run-head">
        <div className="grow mx-run-title">
          <h2 className="ellipsis">{run.name || 'Comparison'}</h2>
          <span className="small faint">
            {run.status === 'running' ? `${done} / ${run.columns.length} done` : run.status} · {fmtTokens(run.tokensIn)} in · {fmtTokens(run.tokensOut)} out tokens
            {run.agent ? ` · agent ${run.agent.name}` : ''} · tools {run.config.tools} · {timeAgo(run.createdAt)}
          </span>
        </div>
        {run.status === 'running' ? (
          <button className="btn sm" onClick={() => void act(() => api.post(`${base}/matrix/${run.id}/cancel`))} {...gate}>
            Cancel
          </button>
        ) : (
          <button className="btn sm" onClick={() => void rerun()} {...gate}>
            Run again
          </button>
        )}
        <Menu floating className="btn sm ghost" label={<span aria-label="More">⋯</span>}>
          {(close) => (
            <>
              <button onClick={() => (close(), void navigator.clipboard?.writeText(run.prompt))}>Copy prompt</button>
              <button onClick={() => (close(), void remove())} {...gate}>Delete</button>
            </>
          )}
        </Menu>
      </div>
      <div className="mx-prompt small">
        <span className="faint">Prompt</span> <span className="chat-text">{run.prompt}</span>
        {exp && Object.keys(exp).length > 0 && <span className="faint"> · checks: {Object.keys(exp).join(', ')}</span>}
      </div>
      <div className="mx-cols" role="list">
        {run.columns.map((c, i) => (
          <ColumnCard key={`${i}-${narrow ? 'n' : 'w'}`} c={c} index={i} run={run} agents={agents} defaultOpen={!narrow || i === 0} onAct={act} />
        ))}
      </div>
    </div>
  );
}

function ColumnCard({ c, index, run, agents, defaultOpen, onAct }: { c: MatrixColumn; index: number; run: MatrixRun; agents: ChatAgent[]; defaultOpen: boolean; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const base = chatBase(slug);
  const nav = useNavigate();
  const finished = c.status === 'done' || c.status === 'error';
  const pass = c.expectations?.passed;
  const openConv = () =>
    onAct(async () => {
      const conv = await api.post<ConversationFull>(`${base}/matrix/${run.id}/conversation`, { column: index });
      nav(`/p/${slug}/chat/c/${conv.id}`);
    });
  const adopt = (agent: ChatAgent) =>
    onAct(async () => {
      if (!confirm(`Switch ${agent.name} to ${c.provider} / ${c.model}?`)) return;
      await api.post(`${base}/matrix/${run.id}/adopt`, { column: index, agent: agent.id });
    });
  return (
    <details className={`mx-col ${c.status}`} open={defaultOpen} role="listitem">
      <summary className="mx-col-head">
        <div className="mx-col-title">
          <span className="mono ellipsis">{c.model}</span>
          <span className="small faint ellipsis">{c.provider}</span>
        </div>
        <span className="spacer" />
        {pass !== undefined && <Badge kind={pass ? 'ok' : 'bad'}>{pass ? 'pass' : 'fail'}</Badge>}
        <Badge kind={COL_KIND[c.status]}>{c.status}</Badge>
      </summary>
      <div className="mx-col-body">
        {c.error && c.status !== 'cancelled' && <div className="error-box small">{c.error}</div>}
        {c.status === 'pending' || c.status === 'running' ? <div className="faint small">{c.status === 'running' ? 'Waiting for the model…' : 'Queued'}</div> : null}
        {c.text && <div className="chat-text mx-text">{c.text}</div>}
        {c.toolCalls.map((t, k) => (
          <details key={k} className={`chat-tool ${t.error ? 'failed' : ''}`}>
            <summary>
              <Icon name={t.name.startsWith('stubyard__') ? 'home' : 'plug'} size={13} />
              <span className="mono ellipsis">{t.name.includes('__') ? t.name.slice(t.name.indexOf('__') + 2) : t.name}</span>
              <span className="spacer" />
              <Badge kind={t.error ? 'bad' : 'ok'}>{t.error ? 'error' : 'done'}</Badge>
            </summary>
            <div className="chat-tool-body">
              <div className="small faint">Input</div>
              <pre className="chat-pre">{JSON.stringify(t.input ?? {}, null, 2)}</pre>
              <div className="small faint">Result</div>
              <pre className="chat-pre">{typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}</pre>
            </div>
          </details>
        ))}
        {c.toolErrors?.map((t) => (
          <div key={t.target} className="small" style={{ color: 'var(--warn)' }}>
            tools of {t.target}: {t.error}
          </div>
        ))}
        {c.expectations && (
          <ul className="mx-checks">
            {c.expectations.checks.map((k) => (
              <li key={k.id}>
                <span className={`chip mx-check ${k.ok ? 'ok' : 'bad'}`} title={k.detail}>
                  {k.ok ? '✓' : '✗'} {k.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
        {finished && (
          <div className="mx-col-meta small faint">
            <span title="input / output tokens">
              {fmtTokens(c.usage.input)} / {fmtTokens(c.usage.output)} tok
            </span>
            <span>{c.steps} step{c.steps === 1 ? '' : 's'}</span>
            {c.durationMs !== null && <span>{(c.durationMs / 1000).toFixed(1)} s</span>}
            {c.finishReason && <span>{c.finishReason}</span>}
          </div>
        )}
        {finished && (
          <div className="row mx-col-actions">
            <button className="btn sm" onClick={() => void openConv()} {...gate}>
              Open as conversation
            </button>
            {c.status === 'done' && agents.length > 0 && (
              <Menu floating className="btn sm ghost" label="Use for agent…">
                {(close) =>
                  agents.map((a) => (
                    <button key={a.id} onClick={() => (close(), void adopt(a))} {...gate}>
                      {a.name}
                      <span className="sub">
                        now {a.provider} / {a.model}
                      </span>
                    </button>
                  ))
                }
              </Menu>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- history

function MatrixHistory({ runs, error, current }: { runs: MatrixRun[] | null; error: string | null; current?: string }) {
  const { slug } = useProject();
  const rows = useMemo(() => runs ?? [], [runs]);
  return (
    <div className="card mx-history">
      <div className="card-head">
        <h2 className="grow">Past comparisons</h2>
        <span className="small faint">newest 50 kept</span>
      </div>
      <ErrorBox error={error} />
      {runs && !rows.length ? (
        <div className="card-pad">
          <Empty title="No comparisons yet">
            <p>Pick a prompt and 2–6 models above.</p>
          </Empty>
        </div>
      ) : (
        <ul className="mx-history-list">
          {rows.map((r) => {
            const failed = r.columns.filter((c) => c.status === 'error').length;
            const checks = r.columns.filter((c) => c.expectations);
            const passed = checks.filter((c) => c.expectations?.passed).length;
            return (
              <li key={r.id} className={r.id === current ? 'active' : ''}>
                <Link to={`/p/${slug}/chat/matrix/${r.id}`} className="mx-history-item">
                  <span className="ellipsis mx-history-name">{r.name || r.prompt}</span>
                  <span className="small faint ellipsis">
                    {r.columns.map((c) => c.model).join(' · ')} · {timeAgo(r.createdAt)}
                  </span>
                </Link>
                <span className="mx-history-badges">
                  {r.status === 'running' && <Badge kind="accent">running</Badge>}
                  {r.status === 'cancelled' && <Badge kind="warn">cancelled</Badge>}
                  {failed > 0 && <Badge kind="bad">{failed} error</Badge>}
                  {checks.length > 0 && <Badge kind={passed === checks.length ? 'ok' : 'bad'}>{passed}/{checks.length} pass</Badge>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import { Fragment, useState } from 'react';
import { api } from '../api';
import { chatBase, expectationsSummary, fmtTokens, type ChatAgent, type ExpectationResult, type Expectations, type PromptRun, type SavedPrompt } from '../chatApi';
import { useProject } from '../context';
import { useFetch } from '../hooks';
import { Badge, Empty, ErrorBox, Modal, timeAgo, useToast } from './ui';

/** Saved prompts with deterministic expectations (contains, regex, tool called, step / token limits); run one or all. */
export default function ChatPrompts({ agents }: { agents: ChatAgent[] }) {
  const { slug } = useProject();
  const toast = useToast();
  const base = chatBase(slug);
  const [agentFilter, setAgentFilter] = useState('');
  const list = useFetch<SavedPrompt[]>(`${base}/prompts${agentFilter ? `?agent=${encodeURIComponent(agentFilter)}` : ''}`, [slug, agentFilter]);
  const [editing, setEditing] = useState<SavedPrompt | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const run = async (p?: SavedPrompt) => {
    setBusy(p?.id ?? 'all');
    try {
      if (p) {
        const r = await api.post<PromptRun>(`${base}/prompts/${p.id}/run`);
        toast(`${r.name}: ${r.passed ? 'passed' : 'failed'}`);
        if (!r.passed) setOpen(p.id);
      } else {
        const r = await api.post<{ passed: number; failed: number }>(`${base}/prompts/run`, agentFilter ? { agent: agentFilter } : {});
        toast(`${r.passed} passed, ${r.failed} failed`);
      }
      void list.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (p: SavedPrompt) => {
    if (!confirm(`Delete the saved prompt “${p.name}”?`)) return;
    await api.del(`${base}/prompts/${p.id}`);
    void list.reload();
  };

  const rows = list.data ?? [];
  const passed = rows.filter((p) => p.lastResult?.passed).length;
  const failed = rows.filter((p) => p.lastResult && !p.lastResult.passed).length;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row chat-prompts-bar">
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Agent filter">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="small muted grow">
          {rows.length} prompt{rows.length === 1 ? '' : 's'}
          {passed + failed > 0 && (
            <>
              {' '}
              · <span style={{ color: 'var(--ok)' }}>{passed} passed</span> · <span style={{ color: failed ? 'var(--bad)' : undefined }}>{failed} failed</span>
            </>
          )}
        </span>
        <button className="btn" disabled={!agents.length} onClick={() => setEditing('new')}>
          New prompt
        </button>
        <button className="btn primary" disabled={!rows.length || !!busy} onClick={() => void run()}>
          {busy === 'all' ? 'Running…' : 'Run all'}
        </button>
      </div>
      <ErrorBox error={list.error} />
      {list.data && !rows.length ? (
        <div className="card card-pad">
          <Empty title="No saved prompts">
            <p>
              Save a prompt with what the answer must (not) contain or which tool must be called; run them after every change, from here or with the{' '}
              <code>run_saved_prompts</code> MCP tool.
            </p>
          </Empty>
        </div>
      ) : (
        <div className="card chat-prompts-cq">
          <div className="table-wrap">
            <table className="chat-prompts">
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Agent</th>
                  <th>Expectations</th>
                  <th>Last run</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <Fragment key={p.id}>
                    <tr>
                      <td className="chat-prompt-cell">
                        <div className="chat-prompt-name">{p.name}</div>
                        <div className="small muted chat-clamp">{p.prompt}</div>
                      </td>
                      <td className="small">{agentName(p.agentId)}</td>
                      <td>
                        <div className="chat-exp">
                          {expectationsSummary(p.expectations).map((s) => (
                            <span key={s} className="chip">
                              {s}
                            </span>
                          ))}
                          {!expectationsSummary(p.expectations).length && <span className="small faint">none (only “no error”)</span>}
                        </div>
                      </td>
                      <td className="nowrap">
                        {p.lastResult ? (
                          <button className="linkish" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                            <Badge kind={p.lastResult.passed ? 'ok' : 'bad'}>{p.lastResult.passed ? 'pass' : 'fail'}</Badge>{' '}
                            <span className="small faint">{p.lastRunAt ? timeAgo(p.lastRunAt) : ''}</span>
                          </button>
                        ) : (
                          <span className="small faint">never</span>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="btn xs primary" disabled={!!busy} onClick={() => void run(p)}>
                            {busy === p.id ? '…' : 'Run'}
                          </button>
                          <button className="btn xs" onClick={() => setEditing(p)}>
                            Edit
                          </button>
                          <button className="btn xs ghost" onClick={() => void remove(p)} aria-label={`Delete ${p.name}`}>
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open === p.id && p.lastResult && (
                      <tr className="chat-result-row">
                        <td colSpan={5}>
                          <ResultView r={p.lastResult} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && <PromptEditor prompt={editing === 'new' ? null : editing} agents={agents} defaultAgent={agentFilter} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void list.reload())} />}
    </div>
  );
}

function ResultView({ r }: { r: ExpectationResult }) {
  return (
    <div className="stack chat-result">
      <ul className="chat-checks">
        {r.checks.map((c) => (
          <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
            <span aria-hidden>{c.ok ? '✓' : '✗'}</span> <span className="mono">{c.id}</span> <span className="small muted">{c.detail}</span>
          </li>
        ))}
        {r.error && (
          <li className="bad">
            <span aria-hidden>✗</span> error <span className="small muted">{r.error}</span>
          </li>
        )}
      </ul>
      <div className="small faint">
        {r.steps ?? '—'} steps · {fmtTokens(r.usage?.inputTokens)} / {fmtTokens(r.usage?.outputTokens)} tokens
        {r.durationMs !== undefined && ` · ${(r.durationMs / 1000).toFixed(1)} s`}
        {r.toolCalls?.length ? ` · tools: ${r.toolCalls.map((t) => (typeof t === 'string' ? t : t.name)).join(', ')}` : ''}
      </div>
      {r.text && <pre className="chat-pre">{r.text}</pre>}
    </div>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

function PromptEditor({ prompt, agents, defaultAgent, onClose, onSaved }: { prompt: SavedPrompt | null; agents: ChatAgent[]; defaultAgent: string; onClose: () => void; onSaved: () => void }) {
  const { slug } = useProject();
  const e0: Expectations = prompt?.expectations ?? {};
  const [agent, setAgent] = useState(prompt?.agentId ?? (defaultAgent || agents[0]?.id || ''));
  const [name, setName] = useState(prompt?.name ?? '');
  const [text, setText] = useState(prompt?.prompt ?? '');
  const [contains, setContains] = useState((e0.contains ?? []).join('\n'));
  const [notContains, setNotContains] = useState((e0.notContains ?? []).join('\n'));
  const [matches, setMatches] = useState(e0.matches ?? '');
  const [toolCalled, setToolCalled] = useState((e0.toolCalled ?? []).join('\n'));
  const [toolNotCalled, setToolNotCalled] = useState((e0.toolNotCalled ?? []).join('\n'));
  const [maxSteps, setMaxSteps] = useState(e0.maxSteps ? String(e0.maxSteps) : '');
  const [maxTokens, setMaxTokens] = useState(e0.maxTokens ? String(e0.maxTokens) : '');
  const [finishReason, setFinishReason] = useState(e0.finishReason ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const expectations: Expectations = {
      contains: lines(contains),
      notContains: lines(notContains),
      matches: matches.trim() || undefined,
      toolCalled: lines(toolCalled),
      toolNotCalled: lines(toolNotCalled),
      maxSteps: maxSteps ? Number(maxSteps) : undefined,
      maxTokens: maxTokens ? Number(maxTokens) : undefined,
      finishReason: finishReason || undefined,
    };
    try {
      const body = { agent, name, prompt: text, expectations };
      if (prompt) await api.patch(`${chatBase(slug)}/prompts/${prompt.id}`, body);
      else await api.post(`${chatBase(slug)}/prompts`, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      wide
      title={prompt ? `Edit ${prompt.name}` : 'New saved prompt'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!agent || !text.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorBox error={error} />
        <div className="form form-2 chat-form-2">
          <label className="field">
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Name <span className="hint">optional, defaults to the prompt</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="lists users" />
          </label>
        </div>
        <label className="field">
          Prompt
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Which test users does this project have?" autoFocus />
        </label>
        <div className="section-title">Expectations (case-insensitive; one per line)</div>
        <div className="form form-2 chat-form-2">
          <label className="field">
            Reply contains
            <textarea rows={2} value={contains} onChange={(e) => setContains(e.target.value)} placeholder="admin" />
          </label>
          <label className="field">
            Reply does not contain
            <textarea rows={2} value={notContains} onChange={(e) => setNotContains(e.target.value)} placeholder="sorry" />
          </label>
          <label className="field">
            Tool called <span className="hint">full name or the part after “__”</span>
            <textarea rows={2} value={toolCalled} onChange={(e) => setToolCalled(e.target.value)} placeholder="list_test_users" className="mono" />
          </label>
          <label className="field">
            Tool not called
            <textarea rows={2} value={toolNotCalled} onChange={(e) => setToolNotCalled(e.target.value)} className="mono" />
          </label>
        </div>
        <label className="field">
          Reply matches <span className="hint">regular expression, plain or /re/flags</span>
          <input value={matches} onChange={(e) => setMatches(e.target.value)} placeholder="/\\d+ users/i" className="mono" />
        </label>
        <div className="form form-3 chat-form-3">
          <label className="field">
            Max steps
            <input type="number" min={1} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
          </label>
          <label className="field">
            Max tokens <span className="hint">input + output</span>
            <input type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </label>
          <label className="field">
            Finish reason
            <select value={finishReason} onChange={(e) => setFinishReason(e.target.value)}>
              <option value="">any</option>
              {['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}

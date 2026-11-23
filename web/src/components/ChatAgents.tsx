import { useState } from 'react';
import { api } from '../api';
import { chatBase, toolsSummary, type AgentTools, type AiProvider, type ChatAgent, type ToolInfo } from '../chatApi';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useFetch } from '../hooks';
import { mtBase, type McpTarget } from '../mcpTesterApi';
import { Link } from 'react-router-dom';
import { Badge, Empty, ErrorBox, Modal, useToast } from './ui';

/** Agents of a project: provider + model, instructions, tool allowlist (stubyard tools, MCP tester targets), step cap. */
export default function ChatAgents({ agents, reload, providers, error }: { agents: ChatAgent[] | null; reload: () => Promise<void>; providers: AiProvider[]; error: string | null }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const toast = useToast();
  const [editing, setEditing] = useState<ChatAgent | 'new' | null>(null);
  const [toolsOf, setToolsOf] = useState<ChatAgent | null>(null);

  const remove = async (a: ChatAgent) => {
    if (!confirm(`Delete the agent “${a.name}” and its ${a.prompts} saved prompt(s)? Conversations are kept.`)) return;
    try {
      await api.del(`${chatBase(slug)}/agents/${a.id}`);
      void reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <p className="muted small grow" style={{ margin: 0 }}>
          An agent is a model + instructions + the tools it may call. stubyard tools are read-only and always scoped to this project; MCP tools come from the
          targets saved in the <Link to={`/p/${slug}/mcp-tester`}>MCP tester</Link>.
        </p>
        <button className="btn primary" onClick={() => setEditing('new')} {...gate}>
          New agent
        </button>
      </div>
      <ErrorBox error={error} />
      {agents && !agents.length && (
        <div className="card card-pad">
          <Empty title="No agents yet">
            <p>Create one to start chatting.</p>
          </Empty>
        </div>
      )}
      <div className="chat-agent-grid">
        {(agents ?? []).map((a) => (
          <div key={a.id} className="card card-pad stack chat-agent-card">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <h3 className="grow ellipsis" style={{ margin: 0 }}>
                {a.name}
              </h3>
              {a.providerOk ? <Badge kind="ok">ready</Badge> : <Badge kind="bad" title={a.providerError ?? ''}>provider</Badge>}
            </div>
            <dl className="kv bare chat-kv">
              <dt>Slug</dt>
              <dd className="mono">{a.slug}</dd>
              <dt>Model</dt>
              <dd className="mono ellipsis" title={`${a.provider} · ${a.model}`}>
                {a.provider} · {a.model}
              </dd>
              <dt>Tools</dt>
              <dd>{toolsSummary(a.tools)}</dd>
              <dt>Limits</dt>
              <dd>
                {a.maxSteps} steps{a.maxOutputTokens ? ` · ${a.maxOutputTokens} tokens/step` : ''}
                {a.temperature !== null ? ` · temp ${a.temperature}` : ''}
              </dd>
            </dl>
            {!a.providerOk && <div className="small" style={{ color: 'var(--bad)' }}>{a.providerError}</div>}
            <div className="row chat-card-actions">
              <Link className="btn sm primary" to={`/p/${slug}/chat`} onClick={() => localStorage.setItem(`stubyard.chat.agent.${slug}`, JSON.stringify(a.id))}>
                Chat
              </Link>
              <button className="btn sm" onClick={() => setToolsOf(a)}>
                Tools
              </button>
              <button className="btn sm" onClick={() => setEditing(a)} {...gate}>
                Edit
              </button>
              <span className="spacer" />
              <button className="btn sm ghost danger" onClick={() => void remove(a)} {...gate}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && <AgentEditor agent={editing === 'new' ? null : editing} providers={providers} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void reload())} />}
      {toolsOf && <ToolsPreview agent={toolsOf} onClose={() => setToolsOf(null)} />}
    </div>
  );
}

const list = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function AgentEditor({ agent, providers, onClose, onSaved }: { agent: ChatAgent | null; providers: AiProvider[]; onClose: () => void; onSaved: () => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const catalog = useFetch<{ tools: { name: string; tool: string; description: string }[] }>(`${chatBase(slug)}/builtin-tools`, [slug]);
  const targets = useFetch<McpTarget[]>(`${mtBase(slug)}/targets`, [slug]);
  const usable = providers.filter((p) => p.enabled);
  const [name, setName] = useState(agent?.name ?? '');
  const [provider, setProvider] = useState(agent?.provider ?? usable.find((p) => p.hasKey || !p.needsKey)?.name ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [maxSteps, setMaxSteps] = useState(String(agent?.maxSteps ?? 10));
  const [maxOut, setMaxOut] = useState(agent?.maxOutputTokens ? String(agent.maxOutputTokens) : '');
  const [temp, setTemp] = useState(agent?.temperature !== null && agent?.temperature !== undefined ? String(agent.temperature) : '');
  const init: AgentTools = agent?.tools ?? { builtin: true, targets: [] };
  const [builtinMode, setBuiltinMode] = useState<'all' | 'none' | 'pick'>(init.builtin === true ? 'all' : init.builtin === false ? 'none' : 'pick');
  const [picked, setPicked] = useState<Set<string>>(new Set(Array.isArray(init.builtin) ? init.builtin.map((n) => n.replace(/^[a-z]+__/, '')) : []));
  const [tg, setTg] = useState<Record<string, { on: boolean; all: boolean; tools: string }>>(() =>
    Object.fromEntries(init.targets.map((t) => [t.target, { on: true, all: t.tools === '*', tools: t.tools === '*' ? '' : t.tools.join(', ') }])),
  );
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prov = providers.find((p) => p.name === provider || p.id === provider);

  const loadModels = async () => {
    if (!prov) return;
    setError(null);
    try {
      const r = await api.get<{ models: { id: string }[] }>(`/api/system/ai-providers/${encodeURIComponent(prov.id)}/models`);
      setModels(r.models.map((m) => m.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Targets are keyed by name; a saved reference by id is matched too.
  const targetKey = (t: McpTarget) => (tg[t.id] ? t.id : t.name);
  const save = async () => {
    setBusy(true);
    setError(null);
    const tools: AgentTools = {
      builtin: builtinMode === 'all' ? true : builtinMode === 'none' ? false : [...picked],
      targets: Object.entries(tg)
        .filter(([, v]) => v.on)
        .map(([target, v]) => ({ target, tools: v.all ? '*' : list(v.tools) })),
    };
    const body = {
      name,
      provider,
      model,
      instructions,
      tools,
      maxSteps: Number(maxSteps) || 10,
      maxOutputTokens: maxOut ? Number(maxOut) : null,
      temperature: temp === '' ? null : Number(temp),
    };
    try {
      if (agent) await api.patch(`${chatBase(slug)}/agents/${agent.id}`, body);
      else await api.post(`${chatBase(slug)}/agents`, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={agent ? `Edit ${agent.name}` : 'New agent'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !provider || !model.trim() || !!gate.disabled} title={gate.title} onClick={() => void save()}>
            {agent ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorBox error={error} />
        <div className="form form-2 chat-form-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Support bot" autoFocus />
          </label>
          <label className="field">
            Provider
            <select value={provider} onChange={(e) => (setProvider(e.target.value), setModels([]))}>
              <option value="">Pick…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.name} disabled={!p.enabled}>
                  {p.name}
                  {p.needsKey && !p.hasKey ? ' (no key)' : ''}
                  {!p.enabled ? ' (disabled)' : ''}
                </option>
              ))}
              {provider && !prov && <option value={provider}>{provider} (missing)</option>}
            </select>
          </label>
        </div>
        {!providers.length && (
          <div className="small muted">
            No AI providers yet: add one in <Link to="/system?tab=ai">System → AI providers</Link>.
          </div>
        )}
        <label className="field">
          <span>
            Model{' '}
            {prov && (
              <button type="button" className="btn xs" onClick={() => void loadModels()}>
                Load models
              </button>
            )}
          </span>
          <input value={model} onChange={(e) => setModel(e.target.value)} list="chat-models" placeholder="e.g. gpt-5-mini, claude-sonnet-4-5, llama3.2" className="mono" />
          <datalist id="chat-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {models.length > 0 && <span className="hint">{models.length} models listed by the provider</span>}
        </label>
        <label className="field">
          Instructions (system prompt)
          <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="You are a QA assistant for this project. Be brief." />
        </label>
        <div className="form form-3 chat-form-3">
          <label className="field">
            Max steps <span className="hint">tool-loop cap, 1–25</span>
            <input type="number" min={1} max={25} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
          </label>
          <label className="field">
            Max output tokens <span className="hint">per step, optional</span>
            <input type="number" min={1} max={64000} value={maxOut} onChange={(e) => setMaxOut(e.target.value)} placeholder="provider default" />
          </label>
          <label className="field">
            Temperature <span className="hint">0–2, optional</span>
            <input type="number" min={0} max={2} step={0.1} value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="default" />
          </label>
        </div>

        <fieldset className="chat-tools-tree">
          <legend>Tools</legend>
          <div className="chat-tree-node">
            <div className="row">
              <b className="grow">stubyard (read-only, this project)</b>
              <select value={builtinMode} onChange={(e) => setBuiltinMode(e.target.value as 'all' | 'none' | 'pick')} aria-label="stubyard tools">
                <option value="all">All read-only tools</option>
                <option value="pick">Pick…</option>
                <option value="none">None</option>
              </select>
            </div>
            {builtinMode === 'pick' && (
              <ul className="chat-tree-leaves">
                {(catalog.data?.tools ?? []).map((t) => (
                  <li key={t.tool}>
                    <label className="chat-check" title={t.description}>
                      <input
                        type="checkbox"
                        checked={picked.has(t.tool)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(t.tool);
                          else n.delete(t.tool);
                          setPicked(n);
                        }}
                      />
                      <span className="mono">{t.tool}</span>
                      <span className="faint small ellipsis">{t.description}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(targets.data ?? []).map((t) => {
            const k = targetKey(t);
            const v = tg[k] ?? { on: false, all: true, tools: '' };
            const set = (patch: Partial<typeof v>) => setTg({ ...tg, [k]: { ...v, ...patch } });
            return (
              <div key={t.id} className="chat-tree-node">
                <div className="row">
                  <label className="chat-check grow">
                    <input type="checkbox" checked={v.on} onChange={(e) => set({ on: e.target.checked })} />
                    <b>{t.name}</b>
                    <span className="faint small mono ellipsis">{t.url}</span>
                  </label>
                  {v.on && (
                    <select value={v.all ? 'all' : 'pick'} onChange={(e) => set({ all: e.target.value === 'all' })} aria-label={`${t.name} tools`}>
                      <option value="all">All tools</option>
                      <option value="pick">Only…</option>
                    </select>
                  )}
                </div>
                {v.on && !v.all && (
                  <input className="mono chat-tree-input" value={v.tools} onChange={(e) => set({ tools: e.target.value })} placeholder="tool names, comma separated" />
                )}
              </div>
            );
          })}
          {Object.keys(tg)
            .filter((k) => !(targets.data ?? []).some((t) => t.id === k || t.name === k))
            .map((k) => (
              <div key={k} className="chat-tree-node small">
                <label className="chat-check">
                  <input type="checkbox" checked={tg[k].on} onChange={(e) => setTg({ ...tg, [k]: { ...tg[k], on: e.target.checked } })} />
                  <b>{k}</b> <Badge kind="warn">target not found</Badge>
                </label>
              </div>
            ))}
          {targets.data && !targets.data.length && (
            <p className="small faint" style={{ margin: 0 }}>
              No MCP targets yet. Add your MCP server in the <Link to={`/p/${slug}/mcp-tester`}>MCP tester</Link> to give the agent its tools.
            </p>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

function ToolsPreview({ agent, onClose }: { agent: ChatAgent; onClose: () => void }) {
  const { slug } = useProject();
  const r = useFetch<{ tools: ToolInfo[]; errors: { target: string; error: string }[] }>(`${chatBase(slug)}/agents/${agent.id}/tools`, [slug, agent.id]);
  return (
    <Modal wide title={`Tools of ${agent.name}`} onClose={onClose}>
      <ErrorBox error={r.error} />
      {!r.data && !r.error && <p className="faint">Connecting to the MCP targets…</p>}
      {r.data && (
        <div className="stack">
          {r.data.errors.map((e) => (
            <div key={e.target} className="error-box">
              {e.target}: {e.error}
            </div>
          ))}
          <p className="small muted" style={{ margin: 0 }}>
            {r.data.tools.length} tool{r.data.tools.length === 1 ? '' : 's'}, as the model sees them.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>From</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {r.data.tools.map((t) => (
                  <tr key={t.name}>
                    <td className="mono">{t.name}</td>
                    <td>{t.source === 'stubyard' ? <Badge kind="accent">stubyard</Badge> : t.target}</td>
                    <td className="small muted">{t.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

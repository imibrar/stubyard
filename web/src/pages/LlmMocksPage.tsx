import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type AiProvider } from '../chatApi';
import { Icon, Menu } from '../components/people';
import { CopyUrl, providersPath } from '../components/providerLayout';
import { LogDrawer } from '../components/TrafficLog';
import { Badge, CodeBlock, Drawer, Empty, ErrorBox, Modal, timeAgo, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  FAULT_ARG,
  FAULT_KINDS,
  llmApi,
  llmBase,
  matchSummary,
  MODE_KIND,
  responseSummary,
  type LlmCall,
  type LlmConnect,
  type LlmEndpoint,
  type LlmMatch,
  type LlmMock,
  type LlmMockMode,
  type LlmOverview,
  type LlmRecording,
  type LlmResponse,
  type LlmSettings,
} from '../llmApi';
import { Page } from './ProjectPage';
import '../styles/llm.css';
import { Tabs } from '../components/layout';

type Tab = 'script' | 'calls' | 'recording' | 'connect';
const TABS: { id: Tab; label: string }[] = [
  { id: 'script', label: 'Script' },
  { id: 'calls', label: 'Calls' },
  { id: 'recording', label: 'Recording' },
  { id: 'connect', label: 'Connect' },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reloads on llm.changed / project.reset. */
function useLlmReload(slug: string, fn: () => void) {
  const reload = useDebounced(fn, 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'llm.changed' || e.type === 'project.reset') reload();
  });
}

/** /p/:slug/llm — fake OpenAI and Anthropic APIs: scripted replies, faults, call log, record-to-mock, connect. */
export default function LlmMocksPage() {
  const { slug } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'script') as Tab;
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'script') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );
  const ov = useFetch<LlmOverview>(llmBase(slug), [slug]);
  const faultList = useFetch<LlmMock[]>(`${llmBase(slug)}/faults`, [slug]);
  useLlmReload(slug, () => (void ov.reload(), void faultList.reload()));
  // Script badge: scripted replies + faults that still fire (a fault with "0 left" is used up).
  const activeFaults = faultList.data ? faultList.data.filter((f) => f.remaining !== 0).length : (ov.data?.faults ?? 0);
  const spentFaults = faultList.data ? faultList.data.length - activeFaults : 0;
  const scriptCount = (ov.data?.mocks ?? 0) + activeFaults;
  const scriptTitle = ov.data ? `${ov.data.mocks} scripted repl${ov.data.mocks === 1 ? 'y' : 'ies'} · ${activeFaults} active fault${activeFaults === 1 ? '' : 's'}${spentFaults ? ` (${spentFaults} used up)` : ''}` : undefined;
  const recording = (ov.data?.recordings ?? []).length > 0;
  return (
    <Page
      title="LLM mocks"
      description="Fake OpenAI (Chat Completions, Responses, embeddings) and Anthropic (Messages) APIs. Script replies and tool calls, inject faults, watch every call, or record real answers once and replay them."
      actions={
        <Link className="btn" to={providersPath(slug, 'llm')}>
          <Icon name="plug" size={14} /> LLM providers
        </Link>
      }
    >
      <Tabs
        className="llm-tabs"
        label="LLM mocks"
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({
          id: t.id,
          label: t.label,
          count: t.id === 'script' ? scriptCount : undefined,
          title: t.id === 'script' && scriptCount > 0 ? scriptTitle : undefined,
          extra: t.id === 'recording' && recording ? <span className="llm-rec-dot" aria-label="recording" /> : undefined,
        }))}
      />
      {tab === 'script' && <ScriptTab />}
      {tab === 'calls' && <CallsTab />}
      {tab === 'recording' && <RecordingTab />}
      {tab === 'connect' && <ConnectTab />}
    </Page>
  );
}

// ---------------- Script ----------------

function ScriptTab() {
  return (
    <div className="stack">
      <FaultsCard />
      <MocksCard />
      <SettingsCard />
    </div>
  );
}

function FaultsCard() {
  const { slug } = useProject();
  const toast = useToast();
  const faults = useFetch<LlmMock[]>(`${llmBase(slug)}/faults`, [slug]);
  useLlmReload(slug, () => void faults.reload());
  const [kind, setKind] = useState<string>('rate_limit');
  const [arg, setArg] = useState('');
  const [times, setTimes] = useState('1');
  const [provider, setProvider] = useState('any');
  const [error, setError] = useState<string | null>(null);
  const argDef = FAULT_ARG[kind as keyof typeof FAULT_ARG];
  const add = async () => {
    setError(null);
    try {
      await llmApi.addFault(slug, { fault: arg.trim() ? `${kind}:${arg.trim()}` : kind, times: times.trim() ? Number(times) : null, provider });
      toast('Fault added');
      void faults.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  // Active faults first; used-up ones ("0 left") stay listed below, dimmed, until removed.
  const list = [...(faults.data ?? [])].sort((a, b) => Number(a.remaining === 0) - Number(b.remaining === 0));
  return (
    <div className="card">
      <div className="card-head">
        <h3>Faults</h3>
        {list.length > 0 && (
          <button className="btn sm ghost" onClick={() => void llmApi.clearFaults(slug).then(() => faults.reload())}>
            Clear all
          </button>
        )}
      </div>
      <div className="card-pad stack">
        <p className="small muted">
          The next matching calls fail the way the real API does (checked before any scripted reply). One-off: send the header <code>X-Hub-Scenario: rate_limit</code> on a request.
        </p>
        <div className="llm-fault-form">
          <label className="field">
            Fault
            <select value={kind} onChange={(e) => (setKind(e.target.value), setArg(''))}>
              {FAULT_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          {argDef && (
            <label className="field">
              {argDef.label}
              <input inputMode="numeric" value={arg} onChange={(e) => setArg(e.target.value)} placeholder={argDef.placeholder} />
            </label>
          )}
          <label className="field">
            Times <span className="hint">empty = every call</span>
            <input inputMode="numeric" value={times} onChange={(e) => setTimes(e.target.value)} placeholder="∞" />
          </label>
          <label className="field">
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="any">any</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <button className="btn primary" onClick={() => void add()} disabled={!!argDef?.required && !arg.trim()}>
            <Icon name="plus" size={14} /> Add fault
          </button>
        </div>
        <ErrorBox error={error} />
        {list.length > 0 && (
          <ul className="llm-fault-list">
            {list.map((f) => (
              <li key={f.id} className={`row ${f.remaining === 0 ? 'spent' : ''}`}>
                <Badge kind={f.remaining === 0 ? '' : 'warn'}>{f.fault}</Badge>
                <span className="small">{f.remaining === null ? 'every call' : f.remaining === 0 ? 'used up' : `${f.remaining} left`}</span>
                {f.provider !== 'any' && <Badge>{f.provider}</Badge>}
                {f.run && <Badge kind="accent">run {f.run}</Badge>}
                <span className="small faint">{matchSummary(f.match)}</span>
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => void llmApi.deleteMock(slug, f.id).then(() => faults.reload())} aria-label={`Remove fault ${f.fault}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MocksCard() {
  const { slug } = useProject();
  const toast = useToast();
  const mocks = useFetch<LlmMock[]>(`${llmBase(slug)}/mocks`, [slug]);
  useLlmReload(slug, () => void mocks.reload());
  const [editing, setEditing] = useState<LlmMock | 'new' | null>(null);
  const [q, setQ] = useState('');
  const list = (mocks.data ?? []).filter((m) => m.kind === 'mock');
  const shown = q.trim() ? list.filter((m) => `${m.name} ${matchSummary(m.match)} ${responseSummary(m.responses[0])}`.toLowerCase().includes(q.trim().toLowerCase())) : list;
  const move = async (m: LlmMock, dir: -1 | 1) => {
    const ids = list.map((x) => x.id);
    const i = ids.indexOf(m.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await llmApi.reorder(slug, ids);
    void mocks.reload();
  };
  const toggle = async (m: LlmMock) => {
    await llmApi.updateMock(slug, m.id, { enabled: !m.enabled });
    void mocks.reload();
  };
  const remove = async (m: LlmMock) => {
    if (!confirm(`Delete mock "${m.name}"?`)) return;
    await llmApi.deleteMock(slug, m.id);
    toast('Mock deleted');
    void mocks.reload();
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Scripted replies {list.length > 0 && <span className="faint small">({list.length})</span>}</h3>
        <div className="row">
          {list.length > 4 && <input className="llm-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter mocks" />}
          <button className="btn sm primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={13} /> New mock
          </button>
        </div>
      </div>
      <ErrorBox error={mocks.error} />
      {!mocks.data && !mocks.error && <p className="muted card-pad">Loading…</p>}
      {mocks.data && !list.length && (
        <Empty title="No scripted replies yet">
          <p className="small">Add a mock (match on the last user message, a tool, the turn…) or record real answers under Recording. Without a match the API answers a provider-shaped 404 that lists why each mock missed.</p>
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New mock
          </button>
        </Empty>
      )}
      {shown.length > 0 && (
        <ol className="llm-mocks">
          {shown.map((m) => (
            <li key={m.id} className={`llm-mock ${m.enabled ? '' : 'off'}`}>
              <div className="llm-mock-order">
                <button className="icon-btn" disabled={!!q || list[0]?.id === m.id} onClick={() => void move(m, -1)} aria-label="Move up">
                  ↑
                </button>
                <button className="icon-btn" disabled={!!q || list[list.length - 1]?.id === m.id} onClick={() => void move(m, 1)} aria-label="Move down">
                  ↓
                </button>
              </div>
              <button className="llm-mock-main" onClick={() => setEditing(m)}>
                <span className="row llm-mock-title">
                  <strong className="ellipsis">{m.name}</strong>
                  {m.provider !== 'any' && <Badge>{m.provider}</Badge>}
                  {m.source === 'recorded' && <Badge kind="accent">recorded</Badge>}
                  {m.run && <Badge kind="accent">run {m.run}</Badge>}
                  {m.fault && <Badge kind="warn">{m.fault}</Badge>}
                  {!m.enabled && <Badge kind="bad">off</Badge>}
                </span>
                <span className="small muted llm-mock-match">{matchSummary(m.match)}</span>
                <span className="small llm-mock-reply">
                  {responseSummary(m.responses[0])}
                  {m.responses.length > 1 && <span className="faint"> +{m.responses.length - 1} ({m.mode})</span>}
                </span>
              </button>
              <div className="llm-mock-side">
                <span className="small faint">
                  {m.hits} hit{m.hits === 1 ? '' : 's'}
                  {m.remaining !== null && ` · ${m.remaining} left`}
                </span>
                <Menu label={<span aria-label="Mock actions">⋯</span>} className="llm-menu" floating>
                  {(close) => (
                    <>
                      <button onClick={() => (close(), setEditing(m))}>Edit</button>
                      <button onClick={() => (close(), void toggle(m))}>{m.enabled ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => (close(), void remove(m))}>Delete</button>
                    </>
                  )}
                </Menu>
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing && <MockEditor mock={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void mocks.reload())} />}
    </div>
  );
}

interface RespDraft {
  text: string;
  tools: string;
  stopReason: string;
  usageIn: string;
  usageOut: string;
  raw?: LlmResponse['raw'];
}

const toDraft = (r: LlmResponse): RespDraft => ({
  text: r.text ?? '',
  tools: r.toolCalls?.length ? JSON.stringify(r.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })), null, 2) : '',
  stopReason: r.stopReason ?? '',
  usageIn: r.usage?.input !== undefined ? String(r.usage.input) : '',
  usageOut: r.usage?.output !== undefined ? String(r.usage.output) : '',
  raw: r.raw,
});

function fromDraft(d: RespDraft, i: number): LlmResponse {
  const r: LlmResponse = {};
  if (d.text) r.text = d.text;
  if (d.tools.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(d.tools);
    } catch {
      throw new Error(`Reply ${i + 1}: tool calls are not valid JSON`);
    }
    r.toolCalls = (Array.isArray(parsed) ? parsed : [parsed]) as LlmResponse['toolCalls'];
  }
  if (d.stopReason) r.stopReason = d.stopReason as LlmResponse['stopReason'];
  if (d.usageIn || d.usageOut) r.usage = { ...(d.usageIn ? { input: Number(d.usageIn) } : {}), ...(d.usageOut ? { output: Number(d.usageOut) } : {}) };
  if (d.raw) r.raw = d.raw;
  return r;
}

type TextKind = 'contains' | 'equals' | 'regex';

function MockEditor({ mock, onClose, onSaved }: { mock: LlmMock | null; onClose: () => void; onSaved: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const m0 = mock?.match ?? {};
  const lu0 = m0.lastUser ?? {};
  const kind0: TextKind = lu0.equals !== undefined ? 'equals' : lu0.regex !== undefined ? 'regex' : 'contains';
  const [name, setName] = useState(mock?.name ?? '');
  const [provider, setProvider] = useState<string>(mock?.provider ?? 'any');
  const [endpoint, setEndpoint] = useState<string>(m0.endpoint ?? '');
  const [model, setModel] = useState(m0.model ?? '');
  const [luKind, setLuKind] = useState<TextKind>(kind0);
  const [lu, setLu] = useState(lu0[kind0] ?? '');
  const [system, setSystem] = useState(m0.system?.contains ?? '');
  const [hasTool, setHasTool] = useState(m0.hasTool ?? '');
  const [trName, setTrName] = useState(m0.toolResult?.name ?? '');
  const [trOn, setTrOn] = useState(!!m0.toolResult);
  const [turn, setTurn] = useState(m0.turn !== undefined ? String(m0.turn) : '');
  const [stream, setStream] = useState(m0.stream === undefined ? '' : String(m0.stream));
  const [mode, setMode] = useState<LlmMockMode>(mock?.mode ?? 'first');
  const [times, setTimes] = useState(mock?.remaining != null ? String(mock.remaining) : '');
  const [fault, setFault] = useState(mock?.fault ?? '');
  const [resps, setResps] = useState<RespDraft[]>(mock?.responses.length ? mock.responses.map(toDraft) : [toDraft({ text: '' })]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setResp = (i: number, p: Partial<RespDraft>) => setResps(resps.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = async () => {
    setError(null);
    try {
      const match: LlmMatch = {};
      if (endpoint) match.endpoint = endpoint as LlmEndpoint;
      if (model.trim()) match.model = model.trim();
      if (lu) match.lastUser = { [luKind]: lu };
      if (system.trim()) match.system = { contains: system.trim() };
      if (hasTool.trim()) match.hasTool = hasTool.trim();
      if (trOn) match.toolResult = trName.trim() ? { name: trName.trim() } : {};
      if (turn.trim()) match.turn = Number(turn);
      if (stream) match.stream = stream === 'true';
      const body = {
        name: name.trim() || undefined,
        provider: provider as LlmMock['provider'],
        match,
        responses: resps.map(fromDraft),
        mode,
        times: times.trim() ? Number(times) : null,
        fault: fault.trim() || null,
      };
      setBusy(true);
      if (mock) await llmApi.updateMock(slug, mock.id, body);
      else await llmApi.createMock(slug, body);
      toast(mock ? 'Mock saved' : 'Mock added');
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!mock || !confirm(`Delete mock "${mock.name}"?`)) return;
    await llmApi.deleteMock(slug, mock.id);
    onSaved();
  };

  return (
    <Modal
      title={mock ? `Edit ${mock.name}` : 'New LLM mock'}
      onClose={onClose}
      wide
      footer={
        <>
          {mock && (
            <button className="btn ghost" onClick={() => void del()}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {mock ? 'Save' : 'Add mock'}
          </button>
        </>
      }
    >
      <div className="stack llm-editor">
        <div className="form form-2">
          <label className="field">
            Name <span className="hint">optional</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="greeting" />
          </label>
          <label className="field">
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="any">any (OpenAI and Anthropic)</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
        </div>
        <fieldset className="llm-fieldset">
          <legend>When</legend>
          <div className="form form-2">
            <label className="field">
              Last user message
              <div className="row nowrap llm-text-match">
                <select value={luKind} onChange={(e) => setLuKind(e.target.value as TextKind)} aria-label="Text match kind">
                  <option value="contains">contains</option>
                  <option value="equals">equals</option>
                  <option value="regex">regex</option>
                </select>
                <input value={lu} onChange={(e) => setLu(e.target.value)} placeholder={luKind === 'regex' ? '/weather in (\w+)/i' : 'hello'} />
              </div>
            </label>
            <label className="field">
              Model <span className="hint">glob, e.g. gpt-5*</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="any" />
            </label>
            <label className="field">
              Endpoint
              <select value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
                <option value="">any</option>
                <option value="chat">chat (chat/completions)</option>
                <option value="responses">responses</option>
                <option value="messages">messages (Anthropic)</option>
              </select>
            </label>
            <label className="field">
              System prompt contains
              <input value={system} onChange={(e) => setSystem(e.target.value)} placeholder="optional" />
            </label>
            <label className="field">
              Tool offered <span className="hint">request lists this tool</span>
              <input value={hasTool} onChange={(e) => setHasTool(e.target.value)} placeholder="get_weather" />
            </label>
            <label className="field">
              Turn <span className="hint">assistant replies so far</span>
              <input inputMode="numeric" value={turn} onChange={(e) => setTurn(e.target.value)} placeholder="any" />
            </label>
            <label className="field">
              <span className="row nowrap">
                <input type="checkbox" checked={trOn} onChange={(e) => setTrOn(e.target.checked)} /> After a tool result
              </span>
              <input value={trName} disabled={!trOn} onChange={(e) => setTrName(e.target.value)} placeholder="tool name (any)" />
            </label>
            <label className="field">
              Stream
              <select value={stream} onChange={(e) => setStream(e.target.value)}>
                <option value="">either</option>
                <option value="true">streaming only</option>
                <option value="false">non-streaming only</option>
              </select>
            </label>
          </div>
        </fieldset>
        <fieldset className="llm-fieldset">
          <legend>Reply</legend>
          {resps.map((r, i) => (
            <div key={i} className="llm-resp">
              <div className="row">
                <strong className="small">{resps.length > 1 ? `Reply ${i + 1}` : 'Reply'}</strong>
                {r.raw && <Badge kind="accent" title="Replayed byte for byte when provider, endpoint and stream mode match">raw {r.raw.endpoint}{r.raw.stream ? ' stream' : ''}</Badge>}
                <span className="spacer" />
                {r.raw && (
                  <button className="btn xs ghost" onClick={() => setResp(i, { raw: undefined })}>
                    Drop raw bytes
                  </button>
                )}
                {resps.length > 1 && (
                  <button className="btn xs ghost" onClick={() => setResps(resps.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
              <label className="field">
                Text <span className="hint">{'{{lastUser}}, {{model}} and the API mock helpers work'}</span>
                <textarea rows={3} value={r.text} onChange={(e) => setResp(i, { text: e.target.value })} placeholder="Hi! How can I help?" />
              </label>
              <label className="field">
                Tool calls <span className="hint">JSON: [{'{'}"name": "get_weather", "arguments": {'{'}"city": "Paris"{'}}'}]</span>
                <textarea rows={r.tools ? 4 : 2} className="mono" value={r.tools} onChange={(e) => setResp(i, { tools: e.target.value })} placeholder="none" />
              </label>
              <div className="form form-3">
                <label className="field">
                  Stop reason
                  <select value={r.stopReason} onChange={(e) => setResp(i, { stopReason: e.target.value })}>
                    <option value="">auto</option>
                    <option value="stop">stop / end_turn</option>
                    <option value="tool_calls">tool_calls / tool_use</option>
                    <option value="length">length / max_tokens</option>
                    <option value="stop_sequence">stop_sequence</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">
                    Input tokens <span className="hint">auto ≈ chars/4</span>
                  </span>
                  <input inputMode="numeric" value={r.usageIn} onChange={(e) => setResp(i, { usageIn: e.target.value })} placeholder="auto" />
                </label>
                <label className="field">
                  Output tokens
                  <input inputMode="numeric" value={r.usageOut} onChange={(e) => setResp(i, { usageOut: e.target.value })} placeholder="auto" />
                </label>
              </div>
            </div>
          ))}
          <div className="row">
            <button className="btn sm" onClick={() => setResps([...resps, toDraft({ text: '' })])}>
              <Icon name="plus" size={13} /> Another reply
            </button>
            {resps.length > 1 && (
              <label className="field row nowrap llm-inline">
                Pick
                <select value={mode} onChange={(e) => setMode(e.target.value as LlmMockMode)}>
                  <option value="first">first only</option>
                  <option value="sequence">in sequence (last repeats)</option>
                  <option value="cycle">cycle</option>
                </select>
              </label>
            )}
          </div>
        </fieldset>
        <div className="form form-2">
          <label className="field">
            Times <span className="hint">answer this many calls, then stop matching</span>
            <input inputMode="numeric" value={times} onChange={(e) => setTimes(e.target.value)} placeholder="unlimited" />
          </label>
          <label className="field">
            Fault <span className="hint">optional, e.g. slow:800 or cut:4</span>
            <input value={fault} onChange={(e) => setFault(e.target.value)} placeholder="none" />
          </label>
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function SettingsCard() {
  const { slug } = useProject();
  const toast = useToast();
  const s = useFetch<LlmSettings>(`${llmBase(slug)}/settings`, [slug]);
  const [draft, setDraft] = useState<LlmSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = draft ?? s.data;
  if (!cur) return null;
  const set = (p: Partial<LlmSettings>) => setDraft({ ...cur, ...p });
  const save = async () => {
    setError(null);
    try {
      await llmApi.saveSettings(slug, cur);
      setDraft(null);
      void s.reload();
      toast('Settings saved');
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>When nothing matches · streaming</h3>
        {draft && (
          <div className="row">
            <button className="btn sm ghost" onClick={() => setDraft(null)}>
              Reset
            </button>
            <button className="btn sm primary" onClick={() => void save()}>
              Save
            </button>
          </div>
        )}
      </div>
      <div className="card-pad">
        <div className="form form-3">
          <label className="field">
            No mock matched
            <select value={cur.fallback} onChange={(e) => set({ fallback: e.target.value as LlmSettings['fallback'] })}>
              <option value="error">404 error listing the misses</option>
              <option value="echo">echo the last user message</option>
              <option value="text">answer a fixed text</option>
            </select>
          </label>
          {cur.fallback === 'text' && (
            <label className="field">
              Fallback text
              <input value={cur.fallbackText} onChange={(e) => set({ fallbackText: e.target.value })} />
            </label>
          )}
          <label className="field">
            Stream chunk size <span className="hint">characters</span>
            <input inputMode="numeric" value={cur.defaultChunk.size} onChange={(e) => set({ defaultChunk: { ...cur.defaultChunk, size: Number(e.target.value) || 1 } })} />
          </label>
          <label className="field">
            Delay between chunks <span className="hint">ms</span>
            <input inputMode="numeric" value={cur.defaultChunk.delayMs} onChange={(e) => set({ defaultChunk: { ...cur.defaultChunk, delayMs: Number(e.target.value) || 0 } })} />
          </label>
          <label className="field">
            Extra models <span className="hint">for GET /v1/models, comma separated</span>
            <input value={cur.models.join(', ')} onChange={(e) => set({ models: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="my-fine-tune" />
          </label>
        </div>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

// ---------------- Calls ----------------

function CallsTab() {
  const { slug } = useProject();
  const toast = useToast();
  useTick();
  const [provider, setProvider] = useState('');
  const [mode, setMode] = useState('');
  const path = `${llmBase(slug)}/calls?limit=200${provider ? `&provider=${provider}` : ''}${mode ? `&mode=${mode}` : ''}`;
  const calls = useFetch<LlmCall[]>(path, [path]);
  useLlmReload(slug, () => void calls.reload());
  const [open, setOpen] = useState<string | null>(null);
  const list = calls.data ?? [];
  return (
    <div className="card">
      <div className="card-head llm-calls-head">
        <h3>Calls {list.length > 0 && <span className="faint small">({list.length})</span>}</h3>
        <div className="row llm-filters">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
            <option value="">All providers</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Outcome">
            <option value="">All outcomes</option>
            <option value="mock">mock</option>
            <option value="unmatched">unmatched</option>
            <option value="fault">fault</option>
            <option value="fallback">fallback</option>
            <option value="record">record</option>
          </select>
          {list.length > 0 && (
            <button className="btn sm ghost" onClick={() => void llmApi.clearCalls(slug).then(() => (toast('Calls cleared'), calls.reload()))}>
              Clear
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={calls.error} />
      {calls.data && !list.length && (
        <Empty title="No calls yet">
          <p className="small">
            Point your app at the base URLs under <em>Connect</em>; every request shows up here live.
          </p>
        </Empty>
      )}
      {list.length > 0 && (
        <div className="table-wrap">
          <table className="llm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>API</th>
                <th>Last user message</th>
                <th>Reply</th>
                <th>Outcome</th>
                <th className="num">Tokens</th>
                <th className="num">ms</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(c.id)}>
                  <td className="nowrap small" data-label="When" title={c.createdAt}>
                    {timeAgo(c.createdAt)}
                  </td>
                  <td data-label="API">
                    <span className="small">
                      {c.provider} · {c.endpoint}
                      {c.stream && <span className="faint"> · stream</span>}
                    </span>
                    {c.model && <div className="faint small ellipsis llm-model">{c.model}</div>}
                    {c.run && <Badge kind="accent">run {c.run}</Badge>}
                  </td>
                  <td data-label="User">
                    <div className="llm-cell-text">{c.lastUser || <span className="faint">—</span>}</div>
                  </td>
                  <td data-label="Reply">
                    <div className="llm-cell-text">
                      {c.toolCalls.length > 0 && <code className="small">{c.toolCalls.map((t) => `${t}()`).join(', ')} </code>}
                      {c.reply || (!c.toolCalls.length && <span className="faint">—</span>)}
                    </div>
                  </td>
                  <td data-label="Outcome">
                    <Badge kind={MODE_KIND[c.mode]}>{c.mode}</Badge>
                    {c.fault && <Badge kind="warn">{c.fault}</Badge>}
                    {c.status !== null && c.status >= 400 && <span className="small faint"> {c.status}</span>}
                    {c.mock && <div className="small faint ellipsis llm-model">{c.mock.name}</div>}
                  </td>
                  <td className="num small" data-label="Tokens">
                    {c.tokensIn ?? '–'} / {c.tokensOut ?? '–'}
                  </td>
                  <td className="num small" data-label="ms">
                    {c.durationMs ?? '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <CallDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CallDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const c = useFetch<LlmCall>(`${llmBase(slug)}/calls/${id}`, [id]);
  const [log, setLog] = useState(false);
  const d = c.data;
  const makeMock = async () => {
    if (!d) return;
    try {
      await llmApi.createMock(slug, {
        name: d.lastUser ? `Reply to "${d.lastUser.slice(0, 40)}"` : undefined,
        match: { ...(d.lastUser ? { lastUser: { equals: d.lastUser } } : {}), ...(d.turn !== null ? { turn: d.turn } : {}) },
        responses: [{ text: d.reply || 'Scripted reply' }],
      });
      toast('Mock added: edit it under Script');
    } catch (e) {
      toast(errText(e));
    }
  };
  if (log && d?.logId) return <LogDrawer id={d.logId} onClose={() => setLog(false)} />;
  return (
    <Drawer
      title={d ? `${d.provider} · ${d.endpoint}${d.model ? ` · ${d.model}` : ''}` : 'Call'}
      onClose={onClose}
      actions={
        d && (
          <>
            {d.logId && (
              <button className="btn sm" onClick={() => setLog(true)}>
                Traffic row
              </button>
            )}
            {d.endpoint !== 'embeddings' && d.endpoint !== 'models' && (
              <button className="btn sm" onClick={() => void makeMock()}>
                Mock this
              </button>
            )}
          </>
        )
      }
    >
      <ErrorBox error={c.error} />
      {d && (
        <div className="stack">
          <dl className="kv">
            <dt>Outcome</dt>
            <dd>
              <Badge kind={MODE_KIND[d.mode]}>{d.mode}</Badge> {d.fault && <Badge kind="warn">{d.fault}</Badge>} {d.status}
            </dd>
            {d.mock && (
              <>
                <dt>Mock</dt>
                <dd>{d.mock.name}</dd>
              </>
            )}
            <dt>Tokens</dt>
            <dd>
              {d.tokensIn ?? '–'} in / {d.tokensOut ?? '–'} out
            </dd>
            <dt>Duration</dt>
            <dd>{d.durationMs ?? '–'} ms</dd>
            {d.run && (
              <>
                <dt>Run</dt>
                <dd>{d.run}</dd>
              </>
            )}
          </dl>
          <CodeBlock title="Request (normalized)" code={JSON.stringify(d.request ?? null, null, 2)} />
          <CodeBlock title="Response" code={JSON.stringify(d.response ?? null, null, 2)} />
        </div>
      )}
    </Drawer>
  );
}

// ---------------- Recording ----------------

function RecordingTab() {
  const { slug } = useProject();
  const toast = useToast();
  useTick();
  const recs = useFetch<LlmRecording[]>(`${llmBase(slug)}/recordings`, [slug]);
  const providers = useFetch<{ providers: AiProvider[] }>('/api/system/ai-providers');
  const mocks = useFetch<LlmMock[]>(`${llmBase(slug)}/mocks`, [slug]);
  useLlmReload(slug, () => (void recs.reload(), void mocks.reload()));
  const usable = (providers.data?.providers ?? []).filter((p) => p.kind !== 'google' && p.enabled);
  const [provider, setProvider] = useState('');
  const [mode, setMode] = useState<'new' | 'all'>('new');
  const [maxCalls, setMaxCalls] = useState('');
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = provider || usable[0]?.id || '';
  const active = (recs.data ?? []).filter((r) => r.status === 'active');
  const recorded = (mocks.data ?? []).filter((m) => m.source === 'recorded').length;
  const start = async () => {
    setError(null);
    try {
      const num = (v: string, label: string) => {
        if (!v.trim()) return undefined;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a whole number of 1 or more`);
        return n;
      };
      await llmApi.startRecording(slug, { provider: chosen, mode, maxCalls: num(maxCalls, 'Max calls'), ttlMinutes: num(ttl, 'Stop after (minutes)') });
      toast('Recording started');
      void recs.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Record real answers</h3>
          {active.length > 0 && <Badge kind="bad">● recording</Badge>}
        </div>
        <div className="card-pad stack">
          <p className="small muted">
            While a recording is on, calls no mock answers are forwarded to a real provider with the key stored under System → AI providers (your app’s key is dropped), and each answer is saved as a mock. Stop it and the same requests replay offline, byte for byte. Embeddings and token counts are never recorded.
          </p>
          {providers.data && !usable.length && (
            <div className="info-box small">
              No OpenAI or Anthropic provider yet. Add one under <Link to="/system?tab=ai">System → AI providers</Link> (OpenAI, Anthropic, OpenRouter or any OpenAI-compatible URL).
            </div>
          )}
          {usable.length > 0 && (
            <div className="llm-fault-form">
              <label className="field">
                Forward to
                <select value={chosen} onChange={(e) => setProvider(e.target.value)}>
                  {usable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.kind}
                      {p.env ? ', env' : ''})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Record
                <select value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'all')}>
                  <option value="new">only calls no mock answers</option>
                  <option value="all">every call (re-record)</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">
                  Max calls <span className="hint">forwarded</span>
                </span>
                <input inputMode="numeric" value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)} placeholder="200" aria-label="Max calls" />
              </label>
              <label className="field">
                Stop after (minutes)
                <input inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="60" aria-label="Stop after (minutes)" />
              </label>
              <button className="btn primary" onClick={() => void start()} disabled={!chosen}>
                Start recording
              </button>
            </div>
          )}
          <ErrorBox error={error} />
          {active.map((r) => (
            <div key={r.id} className="llm-rec-active row">
              <span className="llm-rec-dot" aria-hidden />
              <strong>{r.name}</strong>
              <Badge>{r.kind}</Badge>
              <span className="small muted">
                via {r.providerRef} · {r.mode === 'all' ? 'every call' : 'new calls'} · {r.calls} saved · started {timeAgo(r.createdAt)}
              </span>
              <span className="small llm-rec-limits">
                <b>{r.callsLeft}</b> of {r.maxCalls} calls left
                {r.expiresAt && (
                  <span className="faint" title={new Date(r.expiresAt).toLocaleString()}>
                    {' '}
                    · stops {new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({timeUntil(r.expiresAt)})
                  </span>
                )}
              </span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => void llmApi.stopRecording(slug, r.id).then(() => (toast('Recording stopped'), recs.reload()))}>
                Stop
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>History</h3>
          {recorded > 0 && (
            <button
              className="btn sm ghost"
              onClick={() => {
                if (confirm(`Delete all ${recorded} recorded mocks?`)) void llmApi.deleteMocks(slug, 'recorded').then(() => mocks.reload());
              }}
            >
              Delete {recorded} recorded mock{recorded === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {recs.data && !recs.data.length && <p className="card-pad small muted">No recordings yet.</p>}
        {(recs.data ?? []).length > 0 && (
          <ul className="llm-rec-list">
            {recs.data!.map((r) => (
              <li key={r.id} className="row">
                <strong className="ellipsis">{r.name}</strong>
                <Badge kind={r.status === 'active' ? 'bad' : ''}>{r.status}</Badge>
                <span className="small muted">
                  {r.kind} via {r.providerRef} · {r.calls} saved · {r.forwarded}/{r.maxCalls} forwarded
                  {r.run ? ` · run ${r.run}` : ''} · {timeAgo(r.createdAt)}
                </span>
                {r.status === 'stopped' && r.stopReason && (
                  <Badge kind={r.stopReason === 'manual' ? '' : 'warn'} title={r.stoppedAt ? `Stopped ${new Date(r.stoppedAt).toLocaleString()}` : undefined}>
                    {STOP_REASON[r.stopReason] ?? r.stopReason}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const STOP_REASON: Record<string, string> = { manual: 'stopped by hand', 'max-calls': 'max calls reached', expired: 'time limit reached', 'run-stopped': 'run stopped' };

/** "in 42 min", "in 1 h 5 min", "now". */
function timeUntil(iso: string): string {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (min <= 0) return 'now';
  return min < 60 ? `in ${min} min` : `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

// ---------------- Connect ----------------

function ConnectTab() {
  const { slug } = useProject();
  const c = useFetch<LlmConnect>(`${llmBase(slug)}/connect`, [slug]);
  const [snippet, setSnippet] = useState(0);
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data) return <p className="muted">Loading…</p>;
  const d = c.data;
  return <ConnectView d={d} snippet={snippet} setSnippet={setSnippet} />;
}

export function ConnectView({ d, snippet, setSnippet }: { d: LlmConnect; snippet: number; setSnippet: (i: number) => void }) {
  const s = d.snippets[snippet] ?? d.snippets[0];
  return (
    <div className="stack">
      <div className="llm-connect-grid">
        <div className="card card-pad stack">
          <h3>OpenAI</h3>
          <CopyUrl url={d.openai.baseUrl} label="Base URL copied" />
          <p className="small muted">Chat Completions, Responses, embeddings and models. Any API key works and is never stored.</p>
        </div>
        <div className="card card-pad stack">
          <h3>Anthropic</h3>
          <CopyUrl url={d.anthropic.baseUrl} label="Base URL copied" />
          <p className="small muted">Messages (with streaming and tool use), count_tokens and models. The official SDK appends /v1 itself.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-head llm-snippet-head">
          <h3>Snippets</h3>
          <div className="chips llm-snippet-tabs" role="tablist">
            {d.snippets.map((x, i) => (
              <button key={x.title} role="tab" aria-selected={i === snippet} className={`chip ${i === snippet ? 'active' : ''}`} onClick={() => setSnippet(i)}>
                {x.title}
              </button>
            ))}
          </div>
        </div>
        <div className="card-pad">{s && <CodeBlock title={s.title} code={s.code} />}</div>
      </div>
      <div className="llm-connect-grid">
        <div className="card card-pad stack">
          <h3>Endpoints</h3>
          <ul className="llm-plain small">
            {d.endpoints.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
          <p className="small muted">
            Test runs: send <code>X-Hub-Run: &lt;run&gt;</code> or use <code className="llm-break">{d.runPrefix}</code>.
          </p>
        </div>
        <div className="card card-pad stack">
          <h3>Faults per request</h3>
          <p className="small muted">
            Header <code>X-Hub-Scenario</code>, e.g. <code>rate_limit:2</code>:
          </p>
          <ul className="llm-plain small">
            {d.faults.map((f) => (
              <li key={f.fault}>
                <code>{f.fault}</code> {f.does}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Small helpers reused by the Providers tab. */
export function useLlmConnect(slug: string) {
  const c = useFetch<LlmConnect>(`${llmBase(slug)}/connect`, [slug]);
  useLlmReload(slug, () => void c.reload());
  return c;
}

export const llmPagePath = (slug: string, tab?: Tab) => `/p/${slug}/llm${tab && tab !== 'script' ? `?tab=${tab}` : ''}`;

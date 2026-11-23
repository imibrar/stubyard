import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type DynamicToolUIPart, type UIMessage } from 'ai';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import ChatAgents from '../components/ChatAgents';
import ChatMatrix from '../components/ChatMatrix';
import ChatSaveCall, { SaveTurnButton } from '../components/ChatSaveCall';
import ChatPrompts from '../components/ChatPrompts';
import { Icon, Menu, useLocalState } from '../components/people';
import { Badge, Empty, ErrorBox, timeAgo, useToast } from '../components/ui';
import { useProject } from '../context';
import { useFetch } from '../hooks';
import { chatBase, fmtTokens, pendingKey, type AiProvider, type ChatAgent, type Conversation, type ConversationFull, type StoredMessage } from '../chatApi';
import { Page } from './ProjectPage';
import '../styles/chat.css';
import { Tabs } from '../components/layout';
import { CHAT_TABS, projectPath } from '../nav';

/**
 * /p/:slug/chat/* — AI chat v1: conversations with an agent (streamed with useChat), agents (model, instructions,
 * tool allowlist) and saved prompts with deterministic expectations.
 */
export default function ChatPage() {
  const { slug } = useProject();
  const rest = useParams()['*'] ?? '';
  const [section, id] = rest.split('/');
  const tab = section === 'agents' ? 'agents' : section === 'prompts' ? 'prompts' : section === 'matrix' ? 'matrix' : 'chat';
  const agents = useFetch<ChatAgent[]>(`${chatBase(slug)}/agents`, [slug]);
  const providers = useFetch<{ providers: AiProvider[] }>('/api/system/ai-providers');

  return (
    <Page
      title="Chat"
      description={
        <>
          Talk to an LLM agent that can call stubyard’s read-only tools and your MCP servers (via the MCP tester). Keys live in{' '}
          <Link to="/system?tab=ai">System → AI providers</Link>; tokens are counted, cost is not.
        </>
      }
    >
      <Tabs
        className="chat-tabs"
        label="AI chat"
        value={tab}
        items={CHAT_TABS.map((t) => ({ id: t.id, label: t.label, to: projectPath(slug, t.path!), count: t.id === 'agents' ? agents.data?.length : undefined, zero: t.id === 'agents' }))}
      />
      {tab === 'agents' ? (
        <ChatAgents agents={agents.data} reload={agents.reload} providers={providers.data?.providers ?? []} error={agents.error} />
      ) : tab === 'prompts' ? (
        <ChatPrompts agents={agents.data ?? []} />
      ) : tab === 'matrix' ? (
        <ChatMatrix agents={agents.data ?? []} providers={providers.data?.providers ?? []} runId={id} />
      ) : (
        <Conversations agents={agents.data} providers={providers.data?.providers ?? null} convId={section === 'c' ? id : undefined} />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- conversations

function Conversations({ agents, providers, convId }: { agents: ChatAgent[] | null; providers: AiProvider[] | null; convId?: string }) {
  const { slug } = useProject();
  const nav = useNavigate();
  const toast = useToast();
  const base = chatBase(slug);
  const list = useFetch<Conversation[]>(`${base}/conversations`, [slug]);
  const [lastAgent, setLastAgent] = useLocalState<string>(`stubyard.chat.agent.${slug}`, '');
  const [q, setQ] = useState('');
  const defaultAgent = agents?.find((a) => a.id === lastAgent) ?? agents?.[0] ?? null;

  const create = async (agentId?: string) => {
    try {
      const c = await api.post<ConversationFull>(`${base}/conversations`, { agent: agentId ?? defaultAgent?.id });
      void list.reload();
      nav(`/p/${slug}/chat/c/${c.id}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (c: Conversation) => {
    if (!confirm(`Delete the conversation “${c.title || 'Untitled'}”?`)) return;
    await api.del(`${base}/conversations/${c.id}`);
    void list.reload();
    if (c.id === convId) nav(`/p/${slug}/chat`);
  };
  const rename = async (c: Conversation) => {
    const title = prompt('Title', c.title);
    if (title === null) return;
    await api.patch(`${base}/conversations/${c.id}`, { title });
    void list.reload();
  };

  if (agents && !agents.length) {
    const usable = (providers ?? []).filter((p) => p.enabled && (p.hasKey || !p.needsKey));
    return (
      <div className="card card-pad">
        <Empty title="No agents yet">
          {usable.length ? (
            <p>
              Create an agent (provider, model, instructions, tools) first. <Link to={`/p/${slug}/chat/agents`}>Agents →</Link>
            </p>
          ) : (
            <p>
              Add an AI provider with a key in <Link to="/system?tab=ai">System → AI providers</Link> (or set e.g. <code>OPENAI_API_KEY</code> for the container), then
              create an agent.
            </p>
          )}
        </Empty>
      </div>
    );
  }

  const rows = (list.data ?? []).filter((c) => !q || (c.title || 'Untitled').toLowerCase().includes(q.toLowerCase()));
  return (
    <div className={`chat-split ${convId ? 'has-selection' : ''}`}>
      <div className="card chat-list">
        <div className="card-head">
          <h2 className="grow">Conversations</h2>
          <button className="btn sm primary" onClick={() => void create()} disabled={!defaultAgent}>
            <Icon name="plus" size={14} /> New
          </button>
        </div>
        <div className="chat-list-filter">
          <input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter conversations" />
        </div>
        <ErrorBox error={list.error} />
        <ul className="chat-list-body">
          {rows.map((c) => (
            <li key={c.id} className={c.id === convId ? 'active' : ''}>
              <Link to={`/p/${slug}/chat/c/${c.id}`} className="chat-list-item">
                <span className="ellipsis chat-list-title">{c.title || 'Untitled'}</span>
                <span className="small faint ellipsis">
                  {c.agent?.name ?? 'no agent'} · {c.messages ?? 0} msg · {fmtTokens(c.tokensIn + c.tokensOut)} tok · {timeAgo(c.updatedAt)}
                </span>
              </Link>
              <Menu floating className="btn xs ghost chat-list-menu" label={<span aria-label="Conversation actions">⋯</span>}>
                {(close) => (
                  <>
                    <button onClick={() => (close(), void rename(c))}>Rename…</button>
                    <button onClick={() => (close(), void remove(c))}>Delete</button>
                  </>
                )}
              </Menu>
            </li>
          ))}
          {list.data && !rows.length && <li className="small faint chat-list-empty">{q ? 'No match.' : 'No conversations yet.'}</li>}
        </ul>
      </div>
      <div className="chat-detail">
        {convId ? (
          <ThreadLoader
            key={convId}
            convId={convId}
            agents={agents ?? []}
            defaultAgent={defaultAgent}
            onAgent={setLastAgent}
            onChanged={() => void list.reload()}
            onNew={(a) => void create(a)}
          />
        ) : (
          <div className="card card-pad">
            <Empty title="Pick or start a conversation">
              <p>
                {defaultAgent ? (
                  <button className="btn primary" onClick={() => void create()}>
                    New conversation with {defaultAgent.name}
                  </button>
                ) : (
                  'Loading agents…'
                )}
              </p>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadLoader(props: { convId: string; agents: ChatAgent[]; defaultAgent: ChatAgent | null; onAgent: (id: string) => void; onChanged: () => void; onNew: (agent?: string) => void }) {
  const { slug } = useProject();
  const conv = useFetch<ConversationFull>(`${chatBase(slug)}/conversations/${props.convId}`, [slug, props.convId]);
  if (conv.error)
    return (
      <div className="card card-pad stack">
        <ErrorBox error={conv.error} />
        <Link to={`/p/${slug}/chat`}>← Conversations</Link>
      </div>
    );
  if (!conv.data) return <div className="card card-pad faint">Loading…</div>;
  return <Thread {...props} initial={conv.data} reloadMeta={conv.reload} meta={conv.data} />;
}

const toUi = (m: StoredMessage): UIMessage => ({ id: m.id, role: m.role, parts: m.parts as UIMessage['parts'] });

function Thread({
  convId,
  agents,
  defaultAgent,
  onAgent,
  onChanged,
  onNew,
  initial,
  meta,
  reloadMeta,
}: {
  convId: string;
  agents: ChatAgent[];
  defaultAgent: ChatAgent | null;
  onAgent: (id: string) => void;
  onChanged: () => void;
  onNew: (agent?: string) => void;
  initial: ConversationFull;
  meta: ConversationFull;
  reloadMeta: () => Promise<void>;
}) {
  const { slug } = useProject();
  const [agentId, setAgentId] = useState(initial.agentId ?? defaultAgent?.id ?? '');
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const agent = agents.find((a) => a.id === agentId) ?? null;
  const [input, setInput] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: `${chatBase(slug)}/conversations/${convId}/stream`,
        // Only the new message goes up: the server keeps the history.
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
          body: { message: trigger === 'submit-message' ? messages.at(-1) : undefined, trigger, messageId, agent: agentRef.current || undefined },
        }),
      }),
    [slug, convId],
  );
  const { messages, sendMessage, status, stop, error, regenerate, clearError } = useChat({
    id: convId,
    messages: initial.messages.filter((m) => m.role !== 'system').map(toUi),
    transport,
    onFinish: () => {
      // The server stores the reply (tokens, steps) right after the stream ends.
      setTimeout(() => {
        void reloadMeta();
        onChanged();
      }, 250);
    },
  });
  const busy = status === 'submitted' || status === 'streaming';
  const metaById = useMemo(() => new Map(meta.messages.map((m) => [m.id, m])), [meta]);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, status]);
  useEffect(() => {
    if (window.matchMedia('(width < 1024px)').matches) cardRef.current?.scrollIntoView({ block: 'start' });
  }, []);
  // A message handed over by the Explain button (§AC.4): send it once, as if typed.
  useEffect(() => {
    const key = pendingKey(convId);
    const text = sessionStorage.getItem(key);
    if (!text || !agentRef.current) return;
    sessionStorage.removeItem(key);
    void sendMessage({ text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);
  const lastUserText = (() => {
    const u = [...messages].reverse().find((m) => m.role === 'user');
    return u ? u.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
  })();

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy || !agentId) return;
    setInput('');
    clearError();
    void sendMessage({ text });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e as unknown as FormEvent);
  };
  const pickAgent = (id: string) => {
    setAgentId(id);
    onAgent(id);
  };

  const lastIsAssistant = messages.at(-1)?.role === 'assistant';
  return (
    <div className="card chat-thread" ref={cardRef}>
      <div className="card-head chat-thread-head">
        <Link to={`/p/${slug}/chat`} className="btn xs ghost chat-back" aria-label="Back to conversations">
          ←
        </Link>
        <div className="grow chat-thread-title">
          <h2 className="ellipsis">{meta.title || 'New conversation'}</h2>
          <span className="small faint">
            {fmtTokens(meta.tokensIn)} in · {fmtTokens(meta.tokensOut)} out tokens
          </span>
        </div>
        <select className="chat-agent-pick" value={agentId} onChange={(e) => pickAgent(e.target.value)} aria-label="Agent" disabled={busy}>
          {!agentId && <option value="">Pick an agent…</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.model}
            </option>
          ))}
        </select>
        <Menu floating className="btn xs ghost" label={<span aria-label="More">⋯</span>}>
          {(close) => (
            <>
              <button onClick={() => (close(), onNew(agentId || undefined))}>New conversation</button>
              <Link
                className="menu-link"
                to={`/p/${slug}/chat/matrix?${new URLSearchParams({ prompt: lastUserText, ...(agentId ? { agent: agentId } : {}) }).toString()}`}
                onClick={close}
              >
                Compare models…
              </Link>
              <Link className="menu-link" to={`/p/${slug}/chat/agents`} onClick={close}>
                Edit agents
              </Link>
            </>
          )}
        </Menu>
      </div>
      {agent && !agent.providerOk && (
        <div className="error-box chat-banner">
          {agent.providerError} — <Link to="/system?tab=ai">AI providers</Link>
        </div>
      )}
      <div className="chat-messages" aria-live="polite" ref={boxRef}>
        {!messages.length && (
          <div className="faint small chat-hint">
            {agent ? (
              <>
                <b>{agent.name}</b> uses <span className="mono">{agent.model}</span>
                {agent.instructions ? <> — “{agent.instructions.slice(0, 140)}{agent.instructions.length > 140 ? '…' : ''}”</> : null}. Ask something like “Which
                test users does this project have?”.
              </>
            ) : (
              'Pick an agent to start.'
            )}
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} m={m} meta={metaById.get(m.id)} convId={convId} streaming={busy && m === messages.at(-1) && m.role === 'assistant'} />
        ))}
        {status === 'submitted' && <div className="chat-msg assistant faint small">Thinking…</div>}
        {error && (
          <div className="error-box chat-banner">
            {error.message}
            {!busy && (
              <button className="btn xs" onClick={() => (clearError(), void regenerate())}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
      <form className="chat-compose" onSubmit={send}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={agentId ? 'Message… (Enter to send, Shift+Enter for a new line)' : 'Pick an agent first'}
          rows={2}
          disabled={!agentId}
          aria-label="Message"
        />
        <div className="chat-compose-actions">
          {busy ? (
            <button type="button" className="btn" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            lastIsAssistant && (
              <button type="button" className="btn ghost" onClick={() => void regenerate()} title="Ask the model again for the last message">
                Regenerate
              </button>
            )
          )}
          <button type="submit" className="btn primary" disabled={busy || !input.trim() || !agentId}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

/** True when a part renders something inside the bubble (empty text and step markers do not). */
const partVisible = (p: UIMessage['parts'][number]) =>
  p.type === 'text' || p.type === 'reasoning' ? !!p.text : p.type === 'dynamic-tool' || p.type === 'file' || p.type.startsWith('tool-');

function MessageView({ m, meta, streaming, convId }: { m: UIMessage; meta?: StoredMessage; streaming: boolean; convId: string }) {
  // Tool calls can be saved once the message is stored (meta loaded).
  const save = meta && !streaming ? { convId, messageId: m.id } : undefined;
  // A failed reply has no content: show only its meta line (model, error) instead of an empty bubble.
  const showBubble = streaming || m.parts.some(partVisible);
  return (
    <div className={`chat-msg ${m.role}`}>
      {showBubble && (
        <div className="chat-bubble">
          {m.parts.map((p, i) => {
            if (p.type === 'text') return p.text ? <div key={i} className="chat-text">{p.text}</div> : null;
            if (p.type === 'reasoning')
              return p.text ? (
                <details key={i} className="chat-reasoning">
                  <summary className="small faint">Reasoning</summary>
                  <div className="chat-text small muted">{p.text}</div>
                </details>
              ) : null;
            if (p.type === 'dynamic-tool') return <ToolCard key={i} p={p} save={save} />;
            if (p.type.startsWith('tool-')) return <ToolCard key={i} p={{ ...(p as unknown as DynamicToolUIPart), toolName: p.type.slice(5) }} save={save} />;
            if (p.type === 'step-start' && i > 0) return <hr key={i} className="chat-step" />;
            if (p.type === 'file') return <div key={i} className="small faint">[file {(p as { mediaType?: string }).mediaType}]</div>;
            return null;
          })}
          {streaming && <span className="chat-caret" aria-hidden />}
        </div>
      )}
      {meta && m.role === 'assistant' && (
        <div className="chat-meta small faint">
          {meta.model && <span className="mono">{meta.model}</span>}
          {meta.tokensIn !== null && (
            <span title="input / output tokens">
              {fmtTokens(meta.tokensIn)} / {fmtTokens(meta.tokensOut)} tok
            </span>
          )}
          {meta.steps !== null && meta.steps > 1 && <span>{meta.steps} steps</span>}
          {meta.durationMs !== null && <span>{(meta.durationMs / 1000).toFixed(1)} s</span>}
          {meta.finishReason && meta.finishReason !== 'stop' && <Badge kind={meta.finishReason === 'error' ? 'bad' : 'warn'}>{meta.finishReason}</Badge>}
          {meta.error && <span className="chat-meta-error" title={meta.error}>error: {meta.error.slice(0, 120)}</span>}
          {save && !meta.error && m.parts.some(partVisible) && <SaveTurnButton convId={save.convId} messageId={save.messageId} />}
        </div>
      )}
    </div>
  );
}

const pretty = (v: unknown) => {
  if (v === undefined) return '';
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
};

function ToolCard({ p, save }: { p: DynamicToolUIPart; save?: { convId: string; messageId: string } }) {
  const { slug } = useProject();
  const [server, tool] = p.toolName.includes('__') ? [p.toolName.slice(0, p.toolName.indexOf('__')), p.toolName.slice(p.toolName.indexOf('__') + 2)] : ['', p.toolName];
  const output = p.state === 'output-available' ? pretty(p.output) : p.state === 'output-error' ? p.errorText : '';
  const failed = p.state === 'output-error' || (typeof p.output === 'string' && p.output.startsWith('Error:'));
  const running = p.state === 'input-streaming' || p.state === 'input-available';
  return (
    <details className={`chat-tool ${failed ? 'failed' : ''}`}>
      <summary>
        <Icon name={server === 'stubyard' ? 'home' : 'plug'} size={13} />
        <span className="mono ellipsis">{tool}</span>
        {server && <span className="small faint">{server === 'stubyard' ? 'stubyard' : server}</span>}
        <span className="spacer" />
        <Badge kind={running ? 'accent' : failed ? 'bad' : 'ok'}>{running ? 'running' : failed ? 'error' : 'done'}</Badge>
      </summary>
      <div className="chat-tool-body">
        <div className="small faint">Input</div>
        <pre className="chat-pre">{pretty(p.input) || '{}'}</pre>
        {output && (
          <>
            <div className="small faint">Result</div>
            <pre className="chat-pre">{output}</pre>
          </>
        )}
        {save && !running && <ChatSaveCall convId={save.convId} messageId={save.messageId} callId={p.toolCallId} toolName={p.toolName} />}
        {server && server !== 'stubyard' && (
          <Link className="small" to={`/p/${slug}/mcp-tester`}>
            Open in MCP tester → (session log, tagged “chat”)
          </Link>
        )}
      </div>
    </details>
  );
}

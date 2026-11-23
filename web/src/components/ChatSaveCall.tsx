import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { chatBase } from '../chatApi';
import { useGate } from '../auth';
import { useProject } from '../context';
import { Menu } from './people';

/**
 * "Save ▾" on a tool-call card of a stored conversation: as an MCP tester saved call (tools of MCP tester targets
 * only) or as LLM mocks, so a fake model asks for exactly this call (§AC.3).
 */
export default function ChatSaveCall({ convId, messageId, callId, toolName }: { convId: string; messageId: string; callId: string; toolName: string }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const [result, setResult] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const isTarget = toolName.includes('__') && !toolName.startsWith('stubyard__');
  const save = async (body: Record<string, unknown>) => {
    setResult(null);
    try {
      const r = await api.post<{ link: string; savedCall?: { name: string }; mocks?: { id: string }[]; target?: { name: string } }>(
        `${chatBase(slug)}/conversations/${convId}/messages/${encodeURIComponent(messageId)}/tool-calls/${encodeURIComponent(callId)}/save`,
        body,
      );
      setResult({
        ok: true,
        link: r.link,
        text: r.savedCall ? `Saved as “${r.savedCall.name}” in MCP tester (${r.target?.name ?? 'target'})` : `Saved ${r.mocks?.length ?? 0} LLM mock${r.mocks?.length === 1 ? '' : 's'}`,
      });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="chat-save">
      <Menu floating align="start" menuClassName="chat-save-menu" className="btn xs" label="Save ▾">
        {(close) => (
          <>
            {isTarget && (
              <>
                <button onClick={() => (close(), void save({ as: 'saved-call' }))} {...gate}>
                  MCP tester saved call
                  <span className="sub">expects no error</span>
                </button>
                <button onClick={() => (close(), void save({ as: 'saved-call', expect: 'same-result' }))} {...gate}>
                  MCP tester saved call, same result
                  <span className="sub">also expects the first 200 characters</span>
                </button>
              </>
            )}
            <button onClick={() => (close(), void save({ as: 'llm-mock' }))} {...gate}>
              LLM mock
              <span className="sub">a fake model asks for this call</span>
            </button>
            <button onClick={() => (close(), void save({ as: 'llm-mock', includeFollowUp: true }))} {...gate}>
              LLM mock + answer
              <span className="sub">also mocks the reply after the result</span>
            </button>
          </>
        )}
      </Menu>
      {result && (
        <span className={`small ${result.ok ? 'faint' : 'chat-meta-error'}`} role="status">
          {result.text}
          {result.link && (
            <>
              {' '}
              · <Link to={result.link}>Open →</Link>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** "Save turn as LLM mocks" (every step of an assistant message, in order: replay the conversation offline). */
export function SaveTurnButton({ convId, messageId }: { convId: string; messageId: string }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    try {
      const r = await api.post<{ mocks: unknown[] }>(`${chatBase(slug)}/conversations/${convId}/messages/${encodeURIComponent(messageId)}/save-as-llm-mocks`, {});
      setMsg({ ok: true, text: `${r.mocks.length} LLM mock${r.mocks.length === 1 ? '' : 's'} saved` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <>
      <button className="btn xs ghost" onClick={() => void save()} disabled={!!gate.disabled} title={gate.title ?? 'Save every step of this reply as LLM mocks, so the conversation replays offline'}>
        Save turn as LLM mocks
      </button>
      {msg && (
        <span className={msg.ok ? '' : 'chat-meta-error'} role="status">
          {msg.text}
          {msg.ok && (
            <>
              {' '}
              · <Link to={`/p/${slug}/llm`}>LLM mocks →</Link>
            </>
          )}
        </span>
      )}
    </>
  );
}

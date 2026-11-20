import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { chatBase, pendingKey, type ExplainKind } from '../chatApi';
import { useProjects } from '../context';
import { Menu } from './people';
import { useToast } from './ui';

/**
 * "Explain" for one stubyard item (§AC.4): POST …/chat/explain builds a redacted context and a conversation, then the
 * conversation opens and sends that message on the normal stream endpoint. `project` is a slug or project id.
 */
export default function ExplainButton({ kind, id, project, className = 'btn sm' }: { kind: ExplainKind; id: string; project: string; className?: string }) {
  const { projects } = useProjects();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const p = projects?.find((x) => x.slug === project || x.id === project);
  if (!p) return null;
  const go = async (question?: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ conversation: { id: string }; message: { parts: { type: string; text: string }[] } }>(`${chatBase(p.slug)}/explain`, { kind, id, question });
      sessionStorage.setItem(pendingKey(r.conversation.id), r.message.parts.map((x) => x.text).join('\n'));
      nav(`/p/${p.slug}/chat/c/${r.conversation.id}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu floating className={className} label={busy ? 'Explaining…' : 'Explain ▾'}>
      {(close) => (
        <>
          <button onClick={() => (close(), void go())}>
            Explain this
            <span className="sub">opens a chat with the item (secrets removed)</span>
          </button>
          <button
            onClick={() => {
              close();
              const q = prompt('Your question about this item');
              if (q && q.trim()) void go(q.trim());
            }}
          >
            Ask a question…
          </button>
        </>
      )}
    </Menu>
  );
}

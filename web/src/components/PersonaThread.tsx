import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProject } from '../context';
import { useFetch, useHubEvents, useDebounced } from '../hooks';
import { GOAL_KIND, peApi, peBase, STATE_KIND, type PersonaThread, type PersonaTurn, type ThreadDetail } from '../personasApi';
import { fmtTokens } from '../chatApi';
import { Badge, Drawer, ErrorBox, timeAgo, useToast } from './ui';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CH: Record<string, string> = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' };

/** Goal chips of a thread: open, reached (ok) or failed (bad). */
export function GoalChips({ goals }: { goals: PersonaThread['goalList'] }) {
  if (!goals.length) return <span className="faint small">no goals</span>;
  return (
    <span className="pe-chips">
      {goals.map((g) => (
        <Badge key={g.id} kind={GOAL_KIND[g.state]} title={g.text}>
          {g.state === 'reached' ? '✓ ' : g.state === 'failed' ? '✗ ' : ''}
          {g.id}
        </Badge>
      ))}
    </span>
  );
}

/** "n / cap" with a small bar. */
export function Meter({ value, cap, label }: { value: number; cap: number | null | undefined; label: string }) {
  const pct = cap ? Math.min(100, Math.round((value / cap) * 100)) : 0;
  return (
    <span className="pe-meter" title={`${label}: ${value}${cap ? ` of ${cap}` : ''}`}>
      <span className="small">
        {label === 'tokens' ? fmtTokens(value) : value}
        {cap ? <span className="faint"> / {label === 'tokens' ? fmtTokens(cap) : cap}</span> : null}
      </span>
      {cap ? (
        <span className="pe-bar" aria-hidden>
          <span style={{ width: `${pct}%` }} className={pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''} />
        </span>
      ) : null}
    </span>
  );
}

function TurnInfo({ turn }: { turn: PersonaTurn }) {
  const controls = [
    ...(turn.controls?.goals ?? []).map((g) => `[[GOAL:${g.id}:${g.is}]]`),
    ...(turn.controls?.note ? [`[[NOTE: …]]`] : []),
    ...(turn.controls?.button ? [`[[BUTTON:${turn.controls.button}]]`] : []),
    ...(turn.controls?.subject ? ['[[SUBJECT: …]]'] : []),
    ...(turn.controls?.noReply ? ['[[NO_REPLY]]'] : []),
    ...(turn.controls?.done ? ['[[DONE]]'] : []),
  ];
  return (
    <div className="pe-turn small">
      <span className="faint">
        {turn.status} · {turn.tokensIn + turn.tokensOut} tokens · {turn.durationMs} ms
      </span>
      {controls.map((c) => (
        <code key={c} className="pe-control">
          {c}
        </code>
      ))}
      {turn.error && <span className="ar-warning">⚠ {turn.error}</span>}
      {turn.warnings.map((w) => (
        <span key={w} className="ar-warning">
          ⚠ {w}
        </span>
      ))}
    </div>
  );
}

/** One thread: state, goals, tokens n / cap, Stop / Reset, and the transcript (app left, persona right). */
export function ThreadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const t = useFetch<ThreadDetail>(`${peBase(slug)}/threads/${encodeURIComponent(id)}`, [slug, id]);
  const reload = useDebounced(() => void t.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'personas.changed' || e.type === 'message.created' || e.type === 'message.updated') reload();
  });
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      toast(done);
      void t.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  const d = t.data;
  const turns = new Map((d?.turns ?? []).map((x) => [x.id, x]));
  // Turns without a reply message (silent, error, capped) are shown after the app message that triggered them.
  const loose = new Map<string, PersonaTurn[]>();
  for (const x of d?.turns ?? []) if (!x.replyMessageId && x.triggerMessageId) loose.set(x.triggerMessageId, [...(loose.get(x.triggerMessageId) ?? []), x]);
  return (
    <Drawer
      title={
        <strong>
          {d ? `${d.persona?.name ?? 'Persona'} ↔ ${d.user?.name ?? 'user'}` : 'Thread'} {d && <Badge kind={STATE_KIND[d.state]}>{d.state}</Badge>}
        </strong>
      }
      onClose={onClose}
      actions={
        d && (
          <>
            {d.state === 'active' && (
              <button className="btn sm" onClick={() => void act(() => peApi.stopThread(slug, d.id), 'Thread stopped')}>
                Stop
              </button>
            )}
            <button className="btn sm" onClick={() => void act(() => peApi.resetThread(slug, d.id), 'Thread reset')} title="Back to active: goals open, counters and notes cleared">
              Reset
            </button>
          </>
        )
      }
    >
      <div className="stack">
        <ErrorBox error={error ?? t.error} />
        {d && (
          <>
            <dl className="ar-dl small">
              <dt>Channel</dt>
              <dd>
                {CH[d.channel] ?? d.channel}
                {d.run && <Badge kind="accent">run {d.run}</Badge>}
              </dd>
              <dt>State</dt>
              <dd>
                {d.state}
                {d.stopReason ? ` (${d.stopReason})` : ''}
                {d.errors > 0 && d.state === 'active' ? ` · ${d.errors} error(s) in a row` : ''}
              </dd>
              <dt>Goals</dt>
              <dd>
                <GoalChips goals={d.goalList} />
              </dd>
              <dt>Replies</dt>
              <dd>
                <Meter value={d.replies} cap={d.limits?.maxReplies} label="replies" />
              </dd>
              <dt>Tokens</dt>
              <dd>
                <Meter value={d.tokens} cap={d.limits?.maxTokens} label="tokens" />
              </dd>
              {d.notes && (
                <>
                  <dt>Notes</dt>
                  <dd className="pe-notes">{d.notes}</dd>
                </>
              )}
              <dt>User</dt>
              <dd>{d.user ? <Link to={`/p/${slug}/users/${d.user.id}`}>{d.user.name}</Link> : '—'}</dd>
            </dl>
            {!d.messages.length && <p className="small muted">No messages yet.</p>}
            <ol className="pe-transcript">
              {d.messages.map((m) => {
                const turn = m.turnId ? turns.get(m.turnId) : undefined;
                const persona = m.direction === 'inbound';
                return (
                  <li key={m.id} className={`pe-msg ${persona ? 'from-persona' : 'from-app'}`}>
                    <div className="pe-bubble">
                      <div className="pe-msg-head small faint">
                        {persona ? (m.opener ? 'Persona (opener)' : 'Persona') : 'App'} · {timeAgo(m.createdAt)}
                        {m.subject ? ` · ${m.subject}` : ''}
                      </div>
                      <div className="pe-msg-text">{m.text || <span className="faint">(empty)</span>}</div>
                    </div>
                    {turn && <TurnInfo turn={turn} />}
                    {(loose.get(m.id) ?? []).map((x) => (
                      <div key={x.id} className="pe-msg from-persona pe-loose">
                        <TurnInfo turn={x} />
                      </div>
                    ))}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </Drawer>
  );
}

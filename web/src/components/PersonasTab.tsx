import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fmtTokens } from '../chatApi';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { peApi, peBase, STATE_KIND, type Persona, type PersonaInput, type PersonaReference, type PersonaThread, type ThreadState } from '../personasApi';
import { Icon, Menu } from './people';
import { PersonaAssign, PersonaEditor, PersonaStart, PersonaTryIt } from './PersonaEditor';
import { GoalChips, Meter, ThreadDrawer } from './PersonaThread';
import { Badge, Empty, ErrorBox, timeAgo, useToast } from './ui';
import '../styles/personas.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CH: Record<string, string> = { any: 'any channel', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' };
const STATES: ThreadState[] = ['active', 'done', 'limit', 'error', 'stopped'];

type Dialog = { kind: 'edit'; initial: Persona | PersonaInput } | { kind: 'assign' | 'start' | 'try'; persona: Persona } | null;

/** The Personas tab of the auto-replies page (?tab=personas): AI-written replies, their assignments and threads. */
export default function PersonasTab() {
  const { slug } = useProject();
  const g = useGate(slug);
  const gate = g('project.providers');
  const run = g('walkthroughs.run');
  const toast = useToast();
  const list = useFetch<Persona[]>(peBase(slug), [slug]);
  const ref = useFetch<PersonaReference>('/api/persona-presets', []);
  const [params, setParams] = useSearchParams();
  const [persona, setPersona] = useState(() => params.get('persona') ?? '');
  const [state, setState] = useState<ThreadState | ''>('');
  const threads = useFetch<PersonaThread[]>(`${peBase(slug)}/threads?limit=200${persona ? `&persona=${encodeURIComponent(persona)}` : ''}${state ? `&state=${state}` : ''}`, [slug, persona, state]);
  const reload = useDebounced(() => (void list.reload(), void threads.reload()), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'personas.changed' || e.type === 'autoreplies.changed' || e.type === 'project.reset' || e.type === 'runs.changed') reload();
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [openThread, setOpenThread] = useState<string | null>(() => params.get('thread'));
  const [error, setError] = useState<string | null>(null);
  // ?thread=<id> / ?persona=<id> (links from the Activity tab) are read once, then dropped from the URL.
  useEffect(() => {
    if (params.has('thread') || params.has('persona'))
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('thread');
          n.delete('persona');
          return n;
        },
        { replace: true },
      );
  }, [params, setParams]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      if (done) toast(done);
      reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  const remove = (p: Persona) => {
    if (!confirm(`Delete persona "${p.name}"? Its ${p.assigned.length} assignment rule(s) and its threads are deleted too.`)) return;
    void act(() => peApi.remove(slug, p.id), 'Persona deleted');
  };
  const personas = list.data ?? [];
  const today = personas[0]?.today;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head ar-head">
          <h3>Personas {personas.length > 0 && <span className="faint small">({personas.length})</span>}</h3>
          <div className="row ar-head-actions">
            {ref.data && (
              <Menu label={<>Start from…</>} className="btn sm" floating>
                {(close) => (
                  <>
                    {ref.data!.presets.map((p) => (
                      <button key={p.id} onClick={() => (close(), setDialog({ kind: 'edit', initial: { provider: 'mock:openai', model: 'gpt-5-mini', ...p.persona } }))} {...gate} title={gate.title ?? p.description}>
                        {p.name}
                      </button>
                    ))}
                  </>
                )}
              </Menu>
            )}
            <button className="btn sm primary" onClick={() => setDialog({ kind: 'edit', initial: { provider: 'mock:openai', model: 'gpt-5-mini' } })} {...gate}>
              <Icon name="plus" size={13} /> New persona
            </button>
          </div>
        </div>
        <ErrorBox error={error ?? list.error} />
        {!list.data && !list.error && <p className="muted card-pad">Loading…</p>}
        {list.data && !personas.length && (
          <Empty title="No personas yet">
            <p className="small">
              A persona is a test user played by an LLM: it reads what your app sends and answers in character (asks questions, sends codes back, gives up), with goals your test can wait for. Use <code>mock:openai</code> or <code>mock:anthropic</code> to answer from this project's LLM mocks, without a key.
            </p>
            <div className="row ar-empty-actions">
              {ref.data?.presets.slice(0, 2).map((p) => (
                <button key={p.id} className="btn" onClick={() => setDialog({ kind: 'edit', initial: { provider: 'mock:openai', model: 'gpt-5-mini', ...p.persona } })} {...gate}>
                  {p.name}
                </button>
              ))}
              <button className="btn primary" onClick={() => setDialog({ kind: 'edit', initial: { provider: 'mock:openai', model: 'gpt-5-mini' } })} {...gate}>
                <Icon name="plus" size={14} /> New persona
              </button>
            </div>
          </Empty>
        )}
        {personas.length > 0 && (
          <div className="pe-cards">
            {personas.map((p) => (
              <article key={p.id} className={`pe-card ${p.enabled ? '' : 'off'}`}>
                <div className="pe-card-head">
                  <div className="pe-card-title">
                    <strong className="ellipsis">{p.name}</strong>
                    <span className="faint small pe-mono">{p.slug}</span>
                  </div>
                  <Menu label={<span aria-label={`Actions for ${p.name}`}>⋯</span>} className="btn sm ghost ar-menu-btn" floating>
                    {(close) => (
                      <>
                        <button onClick={() => (close(), setDialog({ kind: 'edit', initial: p }))} {...gate}>Edit</button>
                        <button onClick={() => (close(), setDialog({ kind: 'start', persona: p }))} {...run}>Start conversation…</button>
                        <button {...gate} onClick={() => (close(), void act(() => peApi.update(slug, p.id, { enabled: !p.enabled }), p.enabled ? 'Persona off' : 'Persona on'))}>{p.enabled ? 'Turn off' : 'Turn on'}</button>
                        {p.threads.total > 0 && <button {...run} onClick={() => (close(), void act(() => peApi.deleteThreads(slug, p.id), 'Threads cleared'))}>Clear threads</button>}
                        <button onClick={() => (close(), remove(p))} {...gate}>Delete</button>
                      </>
                    )}
                  </Menu>
                </div>
                <div className="pe-badges">
                  {p.mock ? (
                    <Badge kind="ok" title="Answered by this project's LLM mocks; no key, nothing leaves stubyard">
                      mock
                    </Badge>
                  ) : (
                    <Badge kind="warn" title="A real model">
                      real model
                    </Badge>
                  )}
                  <span className="small pe-mono pe-model ellipsis" title={`${p.provider} · ${p.model}`}>
                    {p.provider} · {p.model}
                  </span>
                  {p.run && <Badge kind="accent">run {p.run}</Badge>}
                  {!p.enabled && <Badge>off</Badge>}
                </div>
                {p.sendsContentTo && (
                  <span className="small pe-sends" title="Each reply sends the app's message text and the test user's facts to this provider">
                    <Badge kind="warn">sends message content to {p.sendsContentTo}</Badge>
                  </span>
                )}
                <p className="small pe-prompt">{p.prompt || <span className="faint">(no description)</span>}</p>
                {p.goals.length > 0 && (
                  <ul className="pe-goals small">
                    {p.goals.map((g) => (
                      <li key={g.id}>
                        <code>{g.id}</code> {g.text}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="pe-assigned">
                  {p.assigned.length === 0 ? (
                    <span className="small faint">Not assigned</span>
                  ) : (
                    p.assigned.map((a) => (
                      <span key={a.ruleId} className={`pe-user-chip ${a.enabled ? '' : 'off'}`} title={a.enabled ? a.name : `${a.name} (off${a.disabledReason ? `: ${a.disabledReason}` : ''})`}>
                        {a.user ? a.user.name : `role ${a.role}`} · {CH[a.channel] ?? a.channel}
                        {a.run ? ` · run ${a.run}` : ''}
                      </span>
                    ))
                  )}
                </div>
                {p.warnings.map((w) => (
                  <span key={w} className="small ar-warning">
                    ⚠ {w}
                  </span>
                ))}
                <div className="pe-stats small faint">
                  <span title="Model calls today (UTC) by this persona">
                    {p.today.calls} call{p.today.calls === 1 ? '' : 's'} today
                  </span>
                  <span title="Tokens today, input + output">{fmtTokens(p.today.tokensIn + p.today.tokensOut)} tokens today</span>
                  <button className="pe-link" onClick={() => setPersona(p.id)} title="Show its threads">
                    {p.threads.total} thread{p.threads.total === 1 ? '' : 's'}
                    {p.threads.active ? ` (${p.threads.active} active)` : ''}
                  </button>
                </div>
                <div className="pe-card-actions">
                  <button className="btn sm primary" onClick={() => setDialog({ kind: 'assign', persona: p })} {...run}>
                    Assign to user…
                  </button>
                  <button className="btn sm" onClick={() => setDialog({ kind: 'try', persona: p })} {...run}>
                    Try it
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {today && (
          <p className="small faint card-pad ar-foot">
            Project model calls today (UTC): {today.projectCalls} of {today.dailyCalls}. Personas answer through auto-reply rules: they show on the Rules tab as "persona", checked top to bottom with the other rules.
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-head ar-activity-head">
          <h3>Threads</h3>
          <div className="row ar-filters">
            <select value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Filter by persona">
              <option value="">All personas</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="chips" role="group" aria-label="Filter by state">
              <button className={`chip ${state === '' ? 'active' : ''}`} onClick={() => setState('')}>
                all
              </button>
              {STATES.map((s) => (
                <button key={s} className={`chip ${state === s ? 'active' : ''}`} onClick={() => setState(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ErrorBox error={threads.error} />
        {threads.data && !threads.data.length && (
          <Empty title="No threads">
            <p className="small">A thread starts when the app messages a user a persona is assigned to: one per persona, user, channel and test run.</p>
          </Empty>
        )}
        {threads.data && threads.data.length > 0 && (
          <div className="table-wrap">
            <table className="ar-table pe-table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>User</th>
                  <th>State</th>
                  <th>Goals</th>
                  <th>Replies</th>
                  <th>Tokens</th>
                  <th>Last turn</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {threads.data.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => setOpenThread(t.id)}>
                    <td data-label="Persona">
                      <span className="ar-cell">{t.persona?.name ?? '(deleted)'}</span>
                      {t.run && <Badge kind="accent">run {t.run}</Badge>}
                    </td>
                    <td data-label="User">
                      {t.user?.name ?? '—'} <span className="faint small">{CH[t.channel]}</span>
                    </td>
                    <td data-label="State">
                      <Badge kind={STATE_KIND[t.state]}>{t.state}</Badge>
                      {t.stopReason && t.state !== 'active' && <span className="small faint"> {t.stopReason}</span>}
                    </td>
                    <td data-label="Goals">
                      <GoalChips goals={t.goalList} />
                    </td>
                    <td data-label="Replies">
                      <Meter value={t.replies} cap={t.limits?.maxReplies} label="replies" />
                    </td>
                    <td data-label="Tokens">
                      <Meter value={t.tokens} cap={t.limits?.maxTokens} label="tokens" />
                    </td>
                    <td data-label="Last turn" className="nowrap small">
                      {t.lastTurnAt ? timeAgo(t.lastTurnAt) : '—'}
                    </td>
                    <td className="ar-actions-cell">
                      {t.state === 'active' && (
                        <button className="btn sm ghost" {...run} onClick={(e) => (e.stopPropagation(), void act(() => peApi.stopThread(slug, t.id), 'Thread stopped'))}>
                          Stop
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.kind === 'edit' && <PersonaEditor initial={dialog.initial} reference={ref.data} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), reload())} />}
      {dialog?.kind === 'assign' && <PersonaAssign persona={dialog.persona} onClose={() => setDialog(null)} onDone={() => (setDialog(null), reload())} />}
      {dialog?.kind === 'start' && <PersonaStart persona={dialog.persona} onClose={() => setDialog(null)} onDone={(id) => (setDialog(null), setOpenThread(id), reload())} />}
      {dialog?.kind === 'try' && <PersonaTryIt persona={dialog.persona} onClose={() => setDialog(null)} />}
      {openThread && <ThreadDrawer id={openThread} onClose={() => setOpenThread(null)} />}
    </div>
  );
}

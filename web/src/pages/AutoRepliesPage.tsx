import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Channel, Message } from '../api';
import {
  arApi,
  arBase,
  FIRE_KIND,
  FIRE_STATUSES,
  fmtDelay,
  type ArChannel,
  type ArFire,
  type ArMatch,
  type ArReference,
  type ArRule,
  type ArRuleInput,
  type ArTestResult,
  type ArText,
  type FireStatus,
} from '../autoRepliesApi';
import { Icon, Menu } from '../components/people';
import PersonasTab from '../components/PersonasTab';
import { Badge, CodeBlock, Drawer, Empty, ErrorBox, Modal, timeAgo, timeUntil, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Page } from './ProjectPage';
import '../styles/autoreplies.css';
import { Tabs } from '../components/layout';
import { AUTO_REPLY_TABS } from '../nav';

type Tab = 'rules' | 'activity' | 'personas';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CHANNELS: ArChannel[] = ['any', 'sms', 'whatsapp', 'email'];
const CHANNEL_NAME: Record<ArChannel, string> = { any: 'Any channel', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' };

function useArReload(slug: string, fn: () => void) {
  const reload = useDebounced(fn, 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'autoreplies.changed' || e.type === 'project.reset' || e.type === 'runs.changed') reload();
  });
}

/** /p/:slug/auto-replies — scripted auto-replies: test users answer the app's messages by themselves. */
export default function AutoRepliesPage() {
  const { slug } = useProject();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'activity' ? 'activity' : params.get('tab') === 'personas' ? 'personas' : 'rules';
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'rules') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );
  const pending = useFetch<ArFire[]>(`${arBase(slug)}/fires?status=pending&limit=100`, [slug]);
  useArReload(slug, () => void pending.reload());
  const nPending = pending.data?.length ?? 0;
  return (
    <Page
      title="Auto-replies"
      description="Make fake test users answer by themselves: when your app sends one of them an email, SMS or WhatsApp message that matches a rule, the user replies through the provider's inbound webhook (echo the code, reply STOP, tap a button)."
    >
      <Tabs
        className="ar-tabs"
        label="Auto-replies"
        value={tab}
        onChange={(id) => setTab(id as Tab)}
        items={AUTO_REPLY_TABS.map((t) => ({ id: t.id, label: t.label, count: t.id === 'activity' ? nPending : undefined, title: t.id === 'activity' && nPending > 0 ? `${nPending} pending` : undefined }))}
      />
      {tab === 'rules' ? <RulesTab /> : tab === 'activity' ? <ActivityTab /> : <PersonasTab />}
    </Page>
  );
}

// ---------------- Rules ----------------

function RulesTab() {
  const { slug } = useProject();
  const toast = useToast();
  const rules = useFetch<ArRule[]>(arBase(slug), [slug]);
  const ref = useFetch<ArReference>('/api/auto-reply-presets', []);
  useArReload(slug, () => void rules.reload());
  const [editing, setEditing] = useState<ArRule | ArRuleInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?rule=<id> (links from a message's "Auto-reply" row) opens that rule's editor once the rules load.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('rule');
  useEffect(() => {
    if (!wanted || !rules.data) return;
    const r = rules.data.find((x) => x.id === wanted);
    if (r) setEditing(r);
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete('rule');
        return n;
      },
      { replace: true },
    );
  }, [wanted, rules.data, setParams]);
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const all = rules.data ?? [];
  const project = all.filter((r) => !r.runId);
  const byRun = new Map<string, ArRule[]>();
  for (const r of all) if (r.run) byRun.set(r.run, [...(byRun.get(r.run) ?? []), r]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      if (done) toast(done);
      void rules.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  const move = (list: ArRule[], r: ArRule, to: number) => {
    const ids = list.map((x) => x.id).filter((id) => id !== r.id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, r.id);
    return act(() => arApi.reorder(slug, ids, r.run));
  };
  const onDrop = (list: ArRule[], target: ArRule) => (e: DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const src = list.find((x) => x.id === dragId.current);
    dragId.current = null;
    if (!src || src.id === target.id) return;
    void move(list, src, list.findIndex((x) => x.id === target.id));
  };
  const openRule = (r: ArRule) => {
    if (!r.persona) return setEditing(r);
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set('tab', 'personas');
        n.set('persona', r.persona!.id);
        return n;
      },
      { replace: true },
    );
  };
  const remove = (r: ArRule) => {
    if (!confirm(`Delete auto-reply "${r.name}"?${r.pendingFires ? ` Its ${r.pendingFires} pending repl${r.pendingFires === 1 ? 'y is' : 'ies are'} dropped.` : ''}`)) return;
    void act(() => arApi.remove(slug, r.id), 'Rule deleted');
  };

  const renderList = (list: ArRule[]) => (
    <ol className="ar-rules">
      {list.map((r, i) => (
        <li
          key={r.id}
          className={`ar-rule ${r.enabled && !r.usedUp ? '' : 'off'} ${dragOver === r.id ? 'drag-over' : ''}`}
          draggable
          onDragStart={(e) => ((dragId.current = r.id), e.dataTransfer.setData('text/plain', r.id), (e.dataTransfer.effectAllowed = 'move'))}
          onDragOver={(e) => (e.preventDefault(), setDragOver(r.id))}
          onDragLeave={() => setDragOver((v) => (v === r.id ? null : v))}
          onDrop={onDrop(list, r)}
        >
          <div className="ar-order">
            <span className="ar-grip" aria-hidden title="Drag to reorder">
              ⋮⋮
            </span>
            <button className="icon-btn" disabled={i === 0} onClick={() => void move(list, r, i - 1)} aria-label={`Move ${r.name} up`}>
              ↑
            </button>
            <button className="icon-btn" disabled={i === list.length - 1} onClick={() => void move(list, r, i + 1)} aria-label={`Move ${r.name} down`}>
              ↓
            </button>
          </div>
          <button className="ar-rule-main" onClick={() => openRule(r)}>
            <span className="row ar-rule-title">
              <span className="faint small ar-pos">{i + 1}</span>
              <strong className="ellipsis">{r.name}</strong>
              <Badge kind={r.channel === 'any' ? '' : r.channel}>{CHANNEL_NAME[r.channel]}</Badge>
              {r.run && <Badge kind="accent">run {r.run}{r.runStatus === 'stopped' ? ' (stopped)' : ''}</Badge>}
              {!r.enabled && <Badge kind={r.disabledReason === 'loop' ? 'bad' : ''}>{r.disabledReason === 'loop' ? 'stopped: loop' : 'off'}</Badge>}
              {r.usedUp && <Badge kind="warn">used up</Badge>}
              {!r.stop && <Badge title="Later rules are evaluated too">continues</Badge>}
            </span>
            <span className="small ar-when">
              <span className="faint">When </span>
              {r.summary}
            </span>
            <span className="small ar-then">
              <span className="faint">Reply </span>
              {fmtDelay(r.delayMs, r.jitterMs)}: <ReplySummary reply={r.reply} persona={r.persona} />
            </span>
            {r.warnings.map((w) => (
              <span key={w} className="small ar-warning">
                ⚠ {w}
              </span>
            ))}
          </button>
          <div className="ar-rule-side">
            <span className="small faint ar-uses" title="Replies sent / limit">
              {r.uses}
              {r.maxUses !== null ? `/${r.maxUses}` : ''} use{r.uses === 1 && r.maxUses === null ? '' : 's'}
              {r.pendingFires > 0 && <span className="ar-pending"> · {r.pendingFires} pending</span>}
            </span>
            <label className="ar-switch" title={r.enabled ? 'On' : 'Off'}>
              <input type="checkbox" checked={r.enabled} onChange={() => void act(() => arApi.update(slug, r.id, { enabled: !r.enabled }))} aria-label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`} />
              <span aria-hidden />
            </label>
            <Menu label={<span aria-label={`Actions for ${r.name}`}>⋯</span>} className="btn sm ghost ar-menu-btn" floating>
              {(close) => (
                <>
                  <button onClick={() => (close(), openRule(r))}>{r.persona ? 'Open persona' : 'Edit'}</button>
                  {!r.persona && <button onClick={() => (close(), setEditing({ ...strip(r), name: `${r.name} (copy)` }))}>Duplicate</button>}
                  {(r.usedUp || r.uses > 0) && <button onClick={() => (close(), void act(() => arApi.update(slug, r.id, { uses: 0 }), 'Uses reset'))}>Reset uses</button>}
                  <button onClick={() => (close(), remove(r))}>Delete</button>
                </>
              )}
            </Menu>
          </div>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head ar-head">
          <h3>Rules {project.length > 0 && <span className="faint small">({project.length})</span>}</h3>
          <div className="row ar-head-actions">
            {ref.data && (
              <Menu label={<>Start from…</>} className="btn sm" floating>
                {(close) => (
                  <>
                    {ref.data!.presets.map((p) => (
                      <button key={p.id} onClick={() => (close(), setEditing(p.rule))} title={p.description}>
                        {p.name}
                      </button>
                    ))}
                  </>
                )}
              </Menu>
            )}
            <button className="btn sm primary" onClick={() => setEditing({})}>
              <Icon name="plus" size={13} /> New rule
            </button>
          </div>
        </div>
        <ErrorBox error={error ?? rules.error} />
        {!rules.data && !rules.error && <p className="muted card-pad">Loading…</p>}
        {rules.data && !project.length && (
          <Empty title="No auto-replies yet">
            <p className="small">
              A rule answers for the test user, e.g. "when a message with a code arrives, reply with the code". Only messages that reached a test user (status delivered) trigger rules; replies never trigger rules themselves.
            </p>
            <div className="row ar-empty-actions">
              {ref.data?.presets.slice(0, 2).map((p) => (
                <button key={p.id} className="btn" onClick={() => setEditing(p.rule)}>
                  {p.name}
                </button>
              ))}
              <button className="btn primary" onClick={() => setEditing({})}>
                <Icon name="plus" size={14} /> New rule
              </button>
            </div>
          </Empty>
        )}
        {project.length > 0 && renderList(project)}
        {project.length > 0 && (
          <p className="small faint card-pad ar-foot">
            Rules are checked from top to bottom; the first match answers unless it is set to continue. Drag or use the arrows to reorder.
            {ref.data && ` Loop guard: more than ${ref.data.loopGuard.fires} replies by one rule to one user within ${ref.data.loopGuard.windowSeconds} s switch the rule off.`}
          </p>
        )}
      </div>
      {[...byRun.entries()].map(([run, list]) => (
        <div className="card" key={run}>
          <div className="card-head">
            <h3>
              Run <code>{run}</code> <span className="faint small">checked before the project rules, only for this run's messages</span>
            </h3>
          </div>
          {renderList(list)}
        </div>
      ))}
      {editing && <RuleEditor initial={editing} variables={ref.data?.variables ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void rules.reload())} />}
    </div>
  );
}

const strip = (r: ArRule): ArRuleInput => ({ name: r.name, channel: r.channel, match: r.match, reply: r.reply, delayMs: r.delayMs, jitterMs: r.jitterMs, maxUses: r.maxUses, stop: r.stop, enabled: r.enabled });
const isSaved = (r: ArRule | ArRuleInput): r is ArRule => 'id' in r && typeof (r as ArRule).id === 'string';

// ---------------- Editor ----------------

type TextMode = 'contains' | 'equals' | 'regex';
interface TextDraft {
  mode: TextMode;
  value: string;
}
const TEXT_FIELDS: { key: 'body' | 'subject' | 'from' | 'to'; label: string; emailOnly?: boolean }[] = [
  { key: 'body', label: 'Body' },
  { key: 'subject', label: 'Subject', emailOnly: true },
  { key: 'from', label: 'From (app sender)' },
  { key: 'to', label: 'To (user address)' },
];
const toText = (t?: ArText): TextDraft => (t?.regex !== undefined ? { mode: 'regex', value: t.regex } : t?.equals !== undefined ? { mode: 'equals', value: t.equals } : { mode: 'contains', value: t?.contains ?? '' });
const tri = (v: boolean | undefined) => (v === undefined ? '' : v ? 'yes' : 'no');
const fromTri = (v: string) => (v === 'yes' ? true : v === 'no' ? false : undefined);
const secs = (ms: number | undefined) => (ms ? String(ms / 1000) : '');

function RuleEditor({ initial, variables, onClose, onSaved }: { initial: ArRule | ArRuleInput; variables: { name: string; help: string }[]; onClose: () => void; onSaved: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const saved = isSaved(initial) ? initial : null;
  const m = initial.match ?? {};
  const [name, setName] = useState(initial.name ?? '');
  const [channel, setChannel] = useState<ArChannel>(initial.channel ?? 'any');
  const [texts, setTexts] = useState<Record<string, TextDraft>>(() => Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, toText(m[f.key])])));
  const [userRef, setUserRef] = useState(m.user ?? '');
  const [role, setRole] = useState(m.role ?? '');
  const [instance, setInstance] = useState(m.instance ?? '');
  const [hasOtp, setHasOtp] = useState(tri(m.hasOtp));
  const [hasLink, setHasLink] = useState(tri(m.hasLink));
  const r = initial.reply ?? { text: '' };
  const [replyChannel, setReplyChannel] = useState<string>(r.channel ?? '');
  const [text, setText] = useState(r.text ?? '');
  const [subject, setSubject] = useState(r.subject ?? '');
  const [html, setHtml] = useState(r.html ?? '');
  const [button, setButton] = useState(r.button ?? '');
  const [thread, setThread] = useState(r.thread !== false);
  const [replyInstance, setReplyInstance] = useState(r.instance ?? '');
  const [delay, setDelay] = useState(secs(initial.delayMs));
  const [jitter, setJitter] = useState(secs(initial.jitterMs));
  const [maxUses, setMaxUses] = useState(initial.maxUses === null || initial.maxUses === undefined ? '' : String(initial.maxUses));
  const [stop, setStop] = useState(initial.stop !== false);
  const [enabled, setEnabled] = useState(initial.enabled !== false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const effective: string = replyChannel || (channel === 'any' ? '' : channel);
  const showEmail = channel === 'email' || channel === 'any' || effective === 'email';
  const replyIsEmail = effective === 'email' || (!effective && channel === 'any');
  const replyIsWa = effective === 'whatsapp' || (!effective && channel === 'any');

  const build = (): ArRuleInput => {
    const match: ArMatch = {};
    for (const f of TEXT_FIELDS) {
      const t = texts[f.key];
      if (t.value.trim()) match[f.key] = { [t.mode]: t.value };
    }
    if (userRef.trim()) match.user = userRef.trim();
    if (role.trim()) match.role = role.trim();
    if (instance.trim()) match.instance = instance.trim();
    const o = fromTri(hasOtp);
    if (o !== undefined) match.hasOtp = o;
    const l = fromTri(hasLink);
    if (l !== undefined) match.hasLink = l;
    const reply: ArRuleInput['reply'] = { text };
    if (replyChannel) reply.channel = replyChannel as Channel;
    if (replyIsEmail && subject.trim()) reply.subject = subject;
    if (replyIsEmail && html.trim()) reply.html = html;
    if (replyIsEmail && !thread) reply.thread = false;
    if (replyIsWa && button.trim()) reply.button = button.trim();
    if (replyInstance.trim()) reply.instance = replyInstance.trim();
    const num = (s: string) => (s.trim() === '' ? 0 : Math.round(Number(s) * 1000));
    return {
      name: name.trim() || undefined,
      channel,
      match,
      reply,
      delayMs: num(delay),
      jitterMs: num(jitter),
      maxUses: maxUses.trim() === '' ? null : Number(maxUses),
      stop,
      enabled,
    };
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const b = build();
      if (saved) await arApi.update(slug, saved.id, b);
      else await arApi.create(slug, b);
      toast(saved ? 'Rule saved' : 'Rule created');
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const insertVar = (v: string) => {
    const el = textRef.current;
    const token = `{{${v}}}`;
    if (!el) return setText((t) => t + token);
    const s = el.selectionStart ?? text.length;
    const e = el.selectionEnd ?? text.length;
    const next = text.slice(0, s) + token + text.slice(e);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };

  return (
    <Modal
      title={saved ? `Edit "${saved.name}"` : 'New auto-reply'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {saved ? 'Save' : 'Create rule'}
          </button>
        </>
      }
    >
      <div className="ar-editor">
        <div className="ar-editor-main stack">
          <div className="ar-grid">
            <label className="field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Echo the login code" />
            </label>
            <label className="field">
              Listens on
              <select value={channel} onChange={(e) => setChannel(e.target.value as ArChannel)}>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_NAME[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="ar-fieldset">
            <legend>When the app sends a message that…</legend>
            {TEXT_FIELDS.filter((f) => !f.emailOnly || showEmail).map((f) => (
              <div className="field" key={f.key}>
                <span>{f.label}</span>
                <div className="row ar-text-match">
                  <select value={texts[f.key].mode} onChange={(e) => setTexts({ ...texts, [f.key]: { ...texts[f.key], mode: e.target.value as TextMode } })} aria-label={`${f.label} condition`}>
                    <option value="contains">contains</option>
                    <option value="equals">equals</option>
                    <option value="regex">matches regex</option>
                  </select>
                  <input
                    value={texts[f.key].value}
                    onChange={(e) => setTexts({ ...texts, [f.key]: { ...texts[f.key], value: e.target.value } })}
                    placeholder={texts[f.key].mode === 'regex' ? (f.key === 'body' ? '/code (\\d{6})/' : '/^order/i') : 'any'}
                    aria-label={f.label}
                    spellCheck={false}
                  />
                </div>
              </div>
            ))}
            <p className="small faint">
              Text checks ignore case. A regex is <code>/pattern/flags</code> or a plain pattern (case-insensitive), at most 500 characters. Groups of the body regex become <code>{'{{body.1}}'}</code> (or <code>{'{{$1}}'}</code>); named groups <code>{'(?<code>…)'}</code> become <code>{'{{body.code}}'}</code>.
            </p>
            <div className="ar-grid">
              <label className="field">
                Has a code
                <select value={hasOtp} onChange={(e) => setHasOtp(e.target.value)}>
                  <option value="">either</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
              <label className="field">
                Has a link
                <select value={hasLink} onChange={(e) => setHasLink(e.target.value)}>
                  <option value="">either</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
              <label className="field">
                Test user <span className="hint">name, email, phone or id</span>
                <input value={userRef} onChange={(e) => setUserRef(e.target.value)} placeholder="any" />
              </label>
              <label className="field">
                Role
                <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="any, e.g. customer" />
              </label>
              <label className="field">
                Provider instance <span className="hint">slug</span>
                <input value={instance} onChange={(e) => setInstance(e.target.value)} placeholder="any" />
              </label>
            </div>
          </fieldset>

          <fieldset className="ar-fieldset">
            <legend>…the test user replies</legend>
            <div className="ar-grid">
              <label className="field">
                Reply on
                <select value={replyChannel} onChange={(e) => setReplyChannel(e.target.value)}>
                  <option value="">the same channel</option>
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                </select>
              </label>
              <label className="field">
                Through instance <span className="hint">default: the one the app used</span>
                <input value={replyInstance} onChange={(e) => setReplyInstance(e.target.value)} placeholder="same" />
              </label>
            </div>
            <div className="field">
              <div className="row ar-text-head">
                <span>Text</span>
                <span className="spacer" />
                <Menu label={<>{'{{ }}'} Insert variable</>} className="btn sm ghost" floating>
                  {(close) => (
                    <>
                      {variables.map((v) => (
                        <button key={v.name} onClick={() => (close(), insertVar(v.name))} title={v.help}>
                          <code>{v.name}</code>
                          <span className="sub ar-var-help">{v.help}</span>
                        </button>
                      ))}
                    </>
                  )}
                </Menu>
              </div>
              <textarea ref={textRef} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="{{otp}}" spellCheck={false} aria-label="Reply text" />
            </div>
            {replyIsWa && (
              <label className="field">
                WhatsApp: tap button <span className="hint">id or title of a button of the message, or #1 for the first</span>
                <input value={button} onChange={(e) => setButton(e.target.value)} placeholder="none (plain text reply)" />
              </label>
            )}
            {replyIsEmail && (
              <>
                <label className="field">
                  Email subject <span className="hint">default: Re: the original subject</span>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Re: {{subject}}" />
                </label>
                <label className="field">
                  Email HTML <span className="hint">optional; values are HTML-escaped</span>
                  <textarea rows={2} value={html} onChange={(e) => setHtml(e.target.value)} spellCheck={false} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={thread} onChange={(e) => setThread(e.target.checked)} /> Reply in the thread (In-Reply-To, References)
                </label>
              </>
            )}
          </fieldset>

          <fieldset className="ar-fieldset">
            <legend>Timing and limits</legend>
            <div className="ar-grid">
              <label className="field">
                Delay <span className="hint">seconds</span>
                <input inputMode="decimal" value={delay} onChange={(e) => setDelay(e.target.value)} placeholder="0" />
              </label>
              <label className="field">
                Random extra <span className="hint">0…n seconds</span>
                <input inputMode="decimal" value={jitter} onChange={(e) => setJitter(e.target.value)} placeholder="0" />
              </label>
              <label className="field">
                Max uses <span className="hint">empty = unlimited</span>
                <input inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} /> Stop here: later rules are not checked after this one matched
            </label>
            <label className="check">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
            </label>
          </fieldset>
          <ErrorBox error={error} />
        </div>
        <TryIt build={build} />
      </div>
    </Modal>
  );
}

/** {{variables}} of a reply template, set apart from the literal text. */
function Template({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\{\{[^}]*\}\})/).map((p, i) =>
        p.startsWith('{{') && p.endsWith('}}') ? (
          <span key={i} className="ar-var">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** One-line reply of a rule: channel, button, "Subject …" and the text, each labelled and separated. */
function ReplySummary({ reply, persona }: { reply: ArRule['reply']; persona?: ArRule['persona'] }) {
  const parts: ReactNode[] = [];
  if (reply.persona)
    return (
      <span>
        <span className="faint">persona: </span>
        <strong>{persona?.name ?? reply.persona}</strong>
        {reply.instruction && <span className="faint"> · “{reply.instruction.length > 80 ? `${reply.instruction.slice(0, 77)}…` : reply.instruction}”</span>}
      </span>
    );
  if (reply.channel) parts.push(<span key="ch">as {CHANNEL_NAME[reply.channel as ArChannel] ?? reply.channel}</span>);
  if (reply.button)
    parts.push(
      <span key="btn">
        tap “<Template text={reply.button} />”
      </span>,
    );
  if (reply.subject)
    parts.push(
      <span key="subj">
        <span className="faint">Subject </span>
        <span className="ar-reply-text">
          <Template text={reply.subject} />
        </span>
      </span>,
    );
  const text = reply.text ? (reply.text.length > 120 ? `${reply.text.slice(0, 117)}…` : reply.text) : reply.html ? '' : null;
  if (text !== null)
    parts.push(
      <span key="text">
        {reply.subject && <span className="faint">Body </span>}
        <span className="ar-reply-text">{text ? <Template text={text} /> : '(HTML)'}</span>
      </span>,
    );
  if (!parts.length) return <span className="faint">(empty)</span>;
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="faint ar-sep"> · </span>}
          {p}
        </Fragment>
      ))}
    </>
  );
}

function TryIt({ build }: { build: () => ArRuleInput }) {
  const { slug } = useProject();
  const msgs = useFetch<Message[]>(`/api/projects/${encodeURIComponent(slug)}/messages?limit=60`, [slug]);
  const outbound = (msgs.data ?? []).filter((m) => m.direction === 'outbound').slice(0, 20);
  const [pick, setPick] = useState('');
  // Until one is picked: the newest message on the rule's channel (the newest of all for "any channel").
  const ruleChannel = build().channel;
  const fallback = (ruleChannel && ruleChannel !== 'any' ? outbound.find((m) => m.channel === ruleChannel) : undefined) ?? outbound[0];
  const chosen = outbound.some((m) => m.id === pick) ? pick : (fallback?.id ?? '');
  const [result, setResult] = useState<ArTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setResult(null);
    const id = chosen;
    if (!id) return setError('No outbound message yet. Send one from your app first.');
    try {
      setResult(await arApi.test(slug, build(), id));
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <aside className="ar-try card">
      <div className="card-head">
        <h3>Try it</h3>
      </div>
      <div className="card-pad stack">
        <p className="small muted">Check the rule against one of the last outbound messages. Nothing is sent.</p>
        <label className="field">
          Message
          <select value={chosen} onChange={(e) => setPick(e.target.value)} disabled={!outbound.length}>
            {!outbound.length && <option value="">no outbound messages yet</option>}
            {outbound.map((m) => (
              <option key={m.id} value={m.id}>
                {m.channel} · {m.to} · {(m.subject || m.bodyText || '').slice(0, 50)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={() => void run()} disabled={!outbound.length}>
          Test rule
        </button>
        <ErrorBox error={error} />
        {result && (
          <div className="stack ar-try-result">
            <div className="row">
              <Badge kind={result.matched ? 'ok' : 'bad'}>{result.matched ? 'matches' : 'no match'}</Badge>
              {result.message.user && <span className="small muted">user {result.message.user}</span>}
            </div>
            {result.reasons.length > 0 && (
              <ul className="small ar-list">
                {result.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {result.notes.length > 0 && (
              <ul className="small ar-list ar-notes">
                {result.notes.map((r) => (
                  <li key={r}>⚠ {r}</li>
                ))}
              </ul>
            )}
            {Object.keys(result.captures).length > 0 && (
              <div className="small">
                <div className="faint">Captures</div>
                <ul className="ar-list mono">
                  {Object.entries(result.captures).map(([k, v]) => (
                    <li key={k}>
                      {k} = {v}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.plan && (
              <div className="small">
                <div className="faint">Reply ({result.plan.channel})</div>
                {result.plan.subject && <div><strong>{result.plan.subject}</strong></div>}
                {result.plan.button && <div>taps "{result.plan.button}"</div>}
                <pre className="ar-pre">{result.plan.text}</pre>
              </div>
            )}
            {result.warnings.map((w) => (
              <span key={w} className="small ar-warning">
                ⚠ {w}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------- Activity ----------------

function ActivityTab() {
  const { slug } = useProject();
  const toast = useToast();
  useTick(15_000);
  const [status, setStatus] = useState<FireStatus | ''>('');
  // ?tab=activity&rule=<id>&fire=<id> (links from a message's "Auto-reply" row): filter by the rule, open the fire.
  const [params, setParams] = useSearchParams();
  const [rule, setRule] = useState(() => params.get('rule') ?? '');
  const [wantFire, setWantFire] = useState(() => params.get('fire'));
  const rules = useFetch<ArRule[]>(arBase(slug), [slug]);
  const list = useFetch<ArFire[]>(`${arBase(slug)}/fires?limit=200${status ? `&status=${status}` : ''}${rule ? `&rule=${encodeURIComponent(rule)}` : ''}`, [slug, status, rule]);
  useArReload(slug, () => (void list.reload(), void rules.reload()));
  const [open, setOpen] = useState<ArFire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fires = list.data ?? [];
  useEffect(() => {
    if (params.has('rule') || params.has('fire'))
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('rule');
          n.delete('fire');
          return n;
        },
        { replace: true },
      );
  }, [params, setParams]);
  useEffect(() => {
    if (!wantFire || !list.data) return;
    const f = list.data.find((x) => x.id === wantFire);
    if (f) setOpen(f);
    setWantFire(null);
  }, [wantFire, list.data]);
  const pendingCount = fires.filter((f) => f.status === 'pending').length;
  const flush = async () => {
    setError(null);
    try {
      const r = await arApi.flush(slug);
      toast(`${r.fired.length} repl${r.fired.length === 1 ? 'y' : 'ies'} sent`);
      void list.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  const cancel = async (f: ArFire) => {
    setError(null);
    try {
      await arApi.cancel(slug, f.id);
      void list.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  const msgLink = (f: ArFire, id: string | null) => (f.testUserId && id ? `/p/${slug}/users/${f.testUserId}?m=${encodeURIComponent(id)}` : null);
  return (
    <div className="card">
      <div className="card-head ar-activity-head">
        <h3>Activity</h3>
        <div className="row ar-filters">
          <select value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Filter by rule">
            <option value="">All rules</option>
            {(rules.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.run ? ` (run ${r.run})` : ''}
              </option>
            ))}
          </select>
          <div className="chips" role="group" aria-label="Filter by status">
            <button className={`chip ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>
              all
            </button>
            {FIRE_STATUSES.map((s) => (
              <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
                {s}
              </button>
            ))}
          </div>
          <button className="btn sm primary" onClick={() => void flush()} disabled={!pendingCount && status !== ''}>
            Fire pending now
          </button>
        </div>
      </div>
      <ErrorBox error={error ?? list.error} />
      {list.data && !fires.length && (
        <Empty title="Nothing yet">
          <p className="small">Each time a rule matches a message it shows here: pending (waiting for its delay), then sent, failed, cancelled or skipped.</p>
        </Empty>
      )}
      {fires.length > 0 && (
        <div className="table-wrap">
          <table className="ar-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Rule</th>
                <th>User</th>
                <th>Message</th>
                <th>Reply</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {fires.map((f) => {
                const tl = msgLink(f, f.triggerMessageId);
                const rl = msgLink(f, f.replyMessageId);
                return (
                  <tr key={f.id} className="clickable" onClick={() => setOpen(f)}>
                    <td data-label="When" className="nowrap small" title={f.createdAt}>
                      {f.status === 'pending' ? `due ${timeUntil(f.dueAt)}` : timeAgo(f.firedAt ?? f.createdAt)}
                    </td>
                    <td data-label="Rule">
                      <span className="ar-cell">{f.ruleName ?? '(deleted)'}</span>
                      {f.run && <Badge kind="accent">run {f.run}</Badge>}
                    </td>
                    <td data-label="User">{f.user?.name ?? '—'}</td>
                    <td data-label="Message">
                      {tl ? (
                        <Link to={tl} onClick={(e) => e.stopPropagation()} className="ar-cell">
                          {f.trigger ? (f.trigger.subject || f.trigger.text || '(empty)') : 'open'}
                        </Link>
                      ) : (
                        <span className="ar-cell faint">{f.trigger?.text ?? '(gone)'}</span>
                      )}
                    </td>
                    <td data-label="Reply">
                      {rl ? (
                        <Link to={rl} onClick={(e) => e.stopPropagation()} className="ar-cell">
                          {f.reply?.text || f.plan.rendered?.text || 'open'}
                        </Link>
                      ) : (
                        <span className="ar-cell faint">{f.plan.rendered?.text ?? (f.status === 'pending' ? 'rendered when sent' : '—')}</span>
                      )}
                      {f.plan.persona?.threadId && (
                        <Link to={`/p/${slug}/auto-replies?tab=personas&thread=${encodeURIComponent(f.plan.persona.threadId)}`} onClick={(e) => e.stopPropagation()} className="small">
                          persona thread
                        </Link>
                      )}
                    </td>
                    <td data-label="Status">
                      <Badge kind={FIRE_KIND[f.status]}>{f.status}</Badge>
                      {f.webhookOk === false && <Badge kind="bad" title={f.error ?? ''}>app {f.webhookStatus ?? 'error'}</Badge>}
                      {f.status !== 'sent' && f.error && <span className="small faint ar-cell"> {f.error}</span>}
                    </td>
                    <td className="ar-actions-cell">
                      {f.status === 'pending' && (
                        <button className="btn sm ghost" onClick={(e) => (e.stopPropagation(), void cancel(f))}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <FireDrawer fire={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FireDrawer({ fire, onClose }: { fire: ArFire; onClose: () => void }) {
  const { slug } = useProject();
  const link = (id: string | null) => (fire.testUserId && id ? `/p/${slug}/users/${fire.testUserId}?m=${encodeURIComponent(id)}` : null);
  const tl = link(fire.triggerMessageId);
  const rl = link(fire.replyMessageId);
  return (
    <Drawer title={<strong>{fire.ruleName ?? 'Auto-reply'} · <Badge kind={FIRE_KIND[fire.status]}>{fire.status}</Badge></strong>} onClose={onClose}>
      <div className="stack">
        <dl className="ar-dl small">
          <dt>User</dt>
          <dd>{fire.user?.name ?? '—'}</dd>
          <dt>Due</dt>
          <dd>{fire.dueAt}</dd>
          <dt>Sent</dt>
          <dd>{fire.firedAt ?? '—'}</dd>
          <dt>App webhook</dt>
          <dd>{fire.webhookOk === null ? '—' : fire.webhookOk ? `accepted (${fire.webhookStatus})` : `failed (${fire.webhookStatus ?? 'no answer'})`}</dd>
          {fire.error && (
            <>
              <dt>Note</dt>
              <dd>{fire.error}</dd>
            </>
          )}
          <dt>Message</dt>
          <dd>{tl ? <Link to={tl}>open in the user's timeline</Link> : '—'}</dd>
          <dt>Reply</dt>
          <dd>{rl ? <Link to={rl}>open in the user's timeline</Link> : '—'}</dd>
          {fire.plan.persona && (
            <>
              <dt>Persona</dt>
              <dd>
                {fire.plan.persona.name} ({fire.plan.persona.status}){' '}
                {fire.plan.persona.threadId && <Link to={`/p/${slug}/auto-replies?tab=personas&thread=${encodeURIComponent(fire.plan.persona.threadId)}`}>open the thread</Link>}
              </dd>
            </>
          )}
        </dl>
        {fire.plan.warnings.map((w) => (
          <span key={w} className="small ar-warning">
            ⚠ {w}
          </span>
        ))}
        {fire.plan.rendered && <CodeBlock title="Rendered reply" code={JSON.stringify(fire.plan.rendered, null, 2)} lang="json" />}
        {Object.keys(fire.plan.captures).length > 0 && <CodeBlock title="Captures" code={JSON.stringify(fire.plan.captures, null, 2)} lang="json" />}
      </div>
    </Drawer>
  );
}

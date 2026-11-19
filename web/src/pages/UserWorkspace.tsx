import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, RECEIVED, type Channel, type Message, type TestUser } from '../api';
import { RulesPanel } from '../components/Rules';
import { AuthenticatorCard, useAuthenticatorCodes } from '../components/Authenticators';
import { Avatar, Icon, RoleBadge } from '../components/people';
import { LogDrawer } from '../components/TrafficLog';
import { RunChip } from '../components/RunChip';
import { CopyLoginMenu, PinStar, UserModal } from '../components/users';
import { Badge, CHANNEL_LABEL, ChannelIcon, Empty, ErrorBox, timeAgo, useCopy, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { WaContentView, messageKind, replyOptions, verifyLabel, waOf } from '../components/WaContent';

const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/** Everything one test user received, on one screen: credentials, latest code, 2FA, and all channels. */
export default function UserWorkspace({ unassigned }: { unassigned?: boolean }) {
  useTick(15_000);
  const { slug, overview, reload: reloadProject } = useProject();
  const { users, providers } = overview;
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const user = unassigned ? null : users.find((u) => u.id === userId) ?? null;
  const [channel, setChannel] = useState<Channel | ''>('');
  const [provider, setProvider] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [editing, setEditing] = useState(false);
  const selectedId = params.get('m');
  const setSelectedId = (id: string | null) => setParams(id ? { m: id } : {}, { replace: true });
  const toast = useToast();
  const copy = useCopy();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    setChannel('');
    setProvider('');
    setSearch('');
  }, [userId, unassigned]);

  const who = unassigned ? 'unassigned' : userId;
  const path = `/api/projects/${slug}/messages${qs({ user: who, q: debounced, limit: 200 })}`;
  const msgs = useFetch<Message[]>(who ? path : null, [path]);
  const reload = useDebounced(() => void msgs.reload(), 150);
  useHubEvents(slug, (e) => {
    if (e.type === 'message.created' || e.type === 'project.reset' || e.type === 'message.updated') reload();
  });

  const all = msgs.data ?? [];
  const providerName = (id: string | null) => providers.find((p) => p.id === id)?.slug;
  const list = all.filter((m) => (!channel || m.channel === channel) && (!provider || providerName(m.providerInstanceId) === provider));
  const counts = useMemo(() => {
    const c: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };
    for (const m of all) c[m.channel]++;
    return c;
  }, [all]);
  const selected = list.find((m) => m.id === selectedId) ?? all.find((m) => m.id === selectedId) ?? null;
  // Only messages the user actually received count (not rejected / failed attempts).
  const latestCode = all.find((m) => m.otp && RECEIVED.includes(m.status) && m.direction === 'outbound') ?? null;
  const latestLink = all.find((m) => m.links.length > 0 && RECEIVED.includes(m.status) && m.direction === 'outbound') ?? null;

  // A message opened from a link (?m=…) counts as read too.
  useEffect(() => {
    if (selected && !selected.readAt) void api.post(`/api/messages/${selected.id}/read`).catch(() => undefined);
  }, [selected?.id, selected?.readAt]);

  const open = async (m: Message) => {
    setSelectedId(m.id);
  };

  // Phones show the list or the open message (see .split.has-selection); bring the swapped-in panel into view.
  const splitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    const el = splitRef.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  }, [selected?.id]);

  // Shortcuts: c = copy latest code, j/k = next/previous message.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'c' && latestCode?.otp) void copy(latestCode.otp, `Copied ${latestCode.otp}`);
      if (e.key === 'j' || e.key === 'k') {
        const i = list.findIndex((m) => m.id === selectedId);
        const next = list[e.key === 'j' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0)];
        if (next) void open(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const markAllRead = async () => {
    await api.post(`/api/projects/${slug}/users/${who}/read`);
    reload();
  };
  const clear = async () => {
    if (!confirm(`Delete all messages in this inbox?`)) return;
    const r = await api.post<{ messages: number }>(`/api/projects/${slug}/users/${who}/clear`);
    toast(`Deleted ${r.messages} messages`);
    setSelectedId(null);
    reload();
  };

  if (!unassigned && !user) {
    return (
      <div className="card">
        <Empty title="Test user not found">
          <Link to={`/p/${slug}`} className="btn">
            Back to {overview.project.name}
          </Link>
        </Empty>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="crumbs">
        <Link to={`/p/${slug}`}>{overview.project.name}</Link>
        <span>/</span>
        <span>{user ? user.name : 'Unassigned'}</span>
      </div>

      {user ? (
        <UserHeader user={user} onEdit={() => setEditing(true)} />
      ) : (
        <div className="card card-pad">
          <h2>Unassigned</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Messages to addresses that don't belong to any test user in this project. Open one and click "Create test user" to adopt the address.
          </p>
        </div>
      )}

      <div className="quick">
        <div className={`card quick-card code`} key={latestCode?.id ?? 'none'}>
          <span className="label">
            Latest code {latestCode && <span style={{ textTransform: 'none', letterSpacing: 0 }}>· {CHANNEL_LABEL[latestCode.channel]} · {timeAgo(latestCode.createdAt)}</span>}
          </span>
          {latestCode?.otp ? (
            <div className="row nowrap">
              <button className="big grow" onClick={() => copy(latestCode.otp!, `Copied ${latestCode.otp}`)} title="Click or press c to copy">
                {latestCode.otp}
              </button>
              <button className="btn sm" onClick={() => copy(latestCode.otp!, `Copied ${latestCode.otp}`)}>
                <Icon name="copy" size={13} /> Copy <kbd>c</kbd>
              </button>
            </div>
          ) : (
            <span className="faint small">No code yet. Trigger a login / OTP in your app; it shows up here instantly.</span>
          )}
        </div>
        <div className="card quick-card">
          <span className="label">
            <Icon name="link" size={12} /> Latest link {latestLink && <span style={{ textTransform: 'none', letterSpacing: 0 }}>· {timeAgo(latestLink.createdAt)}</span>}
          </span>
          {latestLink ? (
            <>
              <a href={latestLink.links[0]} target="_blank" rel="noreferrer" className="mono small ellipsis" title={latestLink.links[0]}>
                {latestLink.links[0]}
              </a>
              <div className="row">
                <a className="btn sm" href={latestLink.links[0]} target="_blank" rel="noreferrer">
                  <Icon name="external" size={13} /> Open
                </a>
                <button className="btn sm" onClick={() => copy(latestLink.links[0], 'Link copied')}>
                  <Icon name="copy" size={13} /> Copy
                </button>
                <span className="small faint ellipsis grow">{latestLink.subject}</span>
              </div>
            </>
          ) : (
            <span className="faint small">Verification and reset links from messages appear here.</span>
          )}
        </div>
        {user && <UserAuthenticators userId={user.id} />}
      </div>

      {user && <RulesPanel slug={slug} scope="user" ownerRef={user.id} providers={providers} title={`Scenario for ${user.name}`} />}

      <div className={`split ${selected ? 'has-selection' : ''}`} ref={splitRef}>
        <div className="card msg-list" style={{ overflow: 'hidden' }}>
          <div className="filters">
            <div className="chips">
              <button className={`chip ${channel === '' ? 'active' : ''}`} onClick={() => setChannel('')}>
                All <span className="n">{all.length}</span>
              </button>
              {CHANNELS.map((c) => (
                <button key={c} className={`chip ${channel === c ? 'active' : ''}`} onClick={() => setChannel(c)}>
                  <ChannelIcon channel={c} size={12} /> {CHANNEL_LABEL[c]} <span className="n">{counts[c]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="filters msg-filters">
            <input type="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {providers.length > 1 && (
              <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
            )}
            <button className="btn sm ghost" onClick={markAllRead} title="Mark all read">
              Mark read
            </button>
            <button className="btn sm ghost danger" onClick={clear} title="Delete all messages in this inbox">
              Clear
            </button>
          </div>
          {user && <ReplyBar user={user} messages={all} selected={selected} onSent={reload} />}
          <ErrorBox error={msgs.error} />
          {list.length === 0 && !msgs.loading ? (
            <Empty title={all.length ? 'No messages match' : 'No messages yet'}>
              {all.length ? 'Try another channel or search.' : user ? 'Send an email, SMS or WhatsApp to this user from your app and it appears here instantly.' : 'Nothing unassigned.'}
            </Empty>
          ) : (
            <div className="timeline">
              {list.map((m) => (
                <div key={m.id} className={`msg ${!m.readAt ? 'unread' : ''} ${m.id === selectedId ? 'selected' : ''} ${m.direction}`} onClick={() => open(m)}>
                  <span className="msg-icon">
                    <ChannelIcon channel={m.channel} size={14} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="msg-subject ellipsis">
                      {m.direction === 'inbound' && <span className="faint">↩ reply · </span>}
                      {messageKind(m) && <span className="kind-tag">{messageKind(m)}</span>}
                      {verifyLabel(m) && <span className="kind-tag">{verifyLabel(m)}</span>}
                      {m.subject ?? ((messageKind(m) ? m.bodyText?.replace(/^\[[^\]]*\]\s*/, '') : m.bodyText)?.slice(0, 60) || '(empty)')}
                    </div>
                    <div className="small faint ellipsis">
                      {m.direction === 'inbound' ? `to ${m.to}` : unassigned ? `to ${m.to}` : `from ${m.from ?? 'unknown'}`}
                      {providerName(m.providerInstanceId) && ` · via ${providerName(m.providerInstanceId)}`}
                      {m.runId && (
                        <>
                          {' '}
                          <RunChip runId={m.runId} slug={slug} />
                        </>
                      )}
                    </div>
                    {(m.status !== 'delivered' || m.duplicateOfId) && (
                      <div className="row" style={{ gap: 4, marginTop: 2 }}>
                        {m.status !== 'delivered' && <StatusBadge status={m.status} />}
                        {m.duplicateOfId && <Badge kind="warn" title={String(m.metadata.duplicateWarning ?? '')}>possible duplicate</Badge>}
                        {m.appliedRule?.id && <span className="small faint ellipsis">{m.appliedRule.label}</span>}
                      </div>
                    )}
                    {m.channel === 'email' && m.bodyText && <div className="msg-preview">{m.bodyText.slice(0, 160)}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }} className="stack">
                    <span className="small faint" style={{ whiteSpace: 'nowrap' }}>
                      {timeAgo(m.createdAt)}
                    </span>
                    {m.otp && <span className="otp small">{m.otp}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <MessageViewer
          message={selected}
          slug={slug}
          providerName={providerName(selected?.providerInstanceId ?? null)}
          canCreateUser={!!unassigned}
          onBack={() => setSelectedId(null)}
          onUserCreated={() => {
            reloadProject();
            reload();
          }}
        />
      </div>
      {editing && user && <UserModal user={user} onClose={() => setEditing(false)} />}
    </div>
  );
}

const STATUS_KIND: Record<string, string> = {
  delivered: 'ok',
  received: 'ok',
  failed: 'bad',
  rejected: 'bad',
  bounced: 'bad',
  timeout: 'bad',
  complained: 'warn',
  dropped: 'warn',
  scheduled: 'accent',
  sending: 'accent',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge kind={STATUS_KIND[status] ?? ''}>{status}</Badge>;
}

/**
 * Simulate the user replying: SMS / WhatsApp (provider inbound webhook), WhatsApp button / list taps, or email
 * (SendGrid Inbound Parse, Mailgun route, SES receipt or JSON to the email instance's inbound URL).
 */
function ReplyBar({ user, messages, selected, onSent }: { user: TestUser; messages: Message[]; selected: Message | null; onSent: () => void }) {
  const { slug, overview } = useProject();
  const channels = (['sms', 'whatsapp', 'email'] as Channel[]).filter(
    (c) => overview.providers.some((p) => p.channel === c && (c === 'email' || p.preset !== 'smtp')) && (c === 'email' ? !!user.email : !!(user.phone || user.whatsapp)),
  );
  const [channel, setChannel] = useState<Channel>(channels[0] ?? 'sms');
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!channels.includes(channel) && channels[0]) setChannel(channels[0]);
  }, [channels.join(','), channel]);
  // Answer on the channel of the message being looked at.
  useEffect(() => {
    if (selected && channels.includes(selected.channel)) setChannel(selected.channel);
  }, [selected?.id]);
  if (!channels.length) return null;

  // Email: answer the selected email (threaded), else the latest one from the app.
  const emailParent = channel === 'email' ? (selected?.channel === 'email' && selected.direction === 'outbound' ? selected : messages.find((m) => m.channel === 'email' && m.direction === 'outbound')) ?? null : null;
  // WhatsApp: buttons of the selected / latest interactive message.
  const interactive = channel === 'whatsapp' ? ((selected && replyOptions(selected).length ? selected : null) ?? messages.find((m) => m.channel === 'whatsapp' && replyOptions(m).length > 0) ?? null) : null;
  const options = interactive ? replyOptions(interactive) : [];
  const instanceSlug = (id: string | null) => overview.providers.find((p) => p.id === id)?.slug;

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api.post<{ webhook: { ok: boolean; status: number | null; error: string | null } | null }>(`/api/projects/${slug}/users/${user.id}/reply`, body);
      toast(!r.webhook ? 'Saved; set an inbound URL on the provider to notify your app' : r.webhook.ok ? `Sent to your app (HTTP ${r.webhook.status})` : `Your app did not accept it: ${r.webhook.error ?? r.webhook.status}`);
      setText('');
      setSubject('');
      onSent();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    if (!text.trim()) return;
    if (channel === 'email') return post({ channel, text, subject: subject.trim() || undefined, inReplyTo: emailParent?.id, instance: emailParent ? instanceSlug(emailParent.providerInstanceId) : undefined });
    return post({ channel, text });
  };
  const tap = (id: string) => interactive && post({ channel: 'whatsapp', button: id, contextMessageId: interactive.id, instance: instanceSlug(interactive.providerInstanceId) });

  return (
    <div className="reply-wrap">
      <form className={`reply-bar ${channel === 'email' ? 'email' : ''}`} onSubmit={(e) => (e.preventDefault(), void send())}>
        <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} aria-label="Reply channel">
          {channels.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
        {channel === 'email' && (
          <input className="reply-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={emailParent?.subject ? `Re: ${emailParent.subject.replace(/^re:\s*/i, '')}` : 'Subject'} aria-label="Subject" />
        )}
        <input className="reply-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={channel === 'email' ? `Email reply as ${user.name}…` : `Reply as ${user.name}… (e.g. STOP, YES)`} aria-label="Reply text" />
        <button className="btn sm" type="submit" disabled={!text.trim() || busy}>
          Send
        </button>
      </form>
      {channel === 'email' && emailParent && (
        <div className="reply-hint small faint ellipsis">
          ↩ threads with “{emailParent.subject ?? '(no subject)'}” from {emailParent.from ?? 'the app'} (In-Reply-To)
        </div>
      )}
      {options.length > 0 && (
        <div className="reply-options">
          <span className="small faint">Tap:</span>
          {options.map((o) => (
            <button key={o.kind + o.id} type="button" className="btn sm wa-btn" disabled={busy} title={`${o.kind} · id ${o.id}${o.description ? ` · ${o.description}` : ''}`} onClick={() => void tap(o.id)}>
              {o.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserHeader({ user: u, onEdit }: { user: TestUser; onEdit: () => void }) {
  const copy = useCopy();
  const [showPw, setShowPw] = useState(false);
  const cred = (k: string, v: string | null, opts: { secret?: boolean } = {}) =>
    v ? (
      <span className="cred">
        <span className="k">{k}</span>
        <span className="ellipsis">{opts.secret && !showPw ? '•'.repeat(Math.min(v.length, 10)) : v}</span>
        {opts.secret && (
          <button onClick={() => setShowPw(!showPw)} title={showPw ? 'Hide' : 'Show'}>
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={13} />
          </button>
        )}
        <button onClick={() => copy(v, `${k} copied`)} title={`Copy ${k.toLowerCase()}`}>
          <Icon name="copy" size={13} />
        </button>
      </span>
    ) : null;
  return (
    <div className="card ws-head">
      <Avatar user={u} size="lg" />
      <div className="grow">
        <div className="row">
          <h1 style={{ fontSize: 18 }}>{u.name}</h1>
          <RoleBadge role={u.role} />
          {u.marketingOptOut && <Badge title="Marketing opt-out (DND)">DND</Badge>}
          <PinStar user={u} />
        </div>
        <div className="creds">
          {cred('Email', u.email)}
          {cred('Phone', u.phone)}
          {u.whatsapp && u.whatsapp !== u.phone && cred('WhatsApp', u.whatsapp)}
          {cred('Password', u.password, { secret: true })}
        </div>
        {u.notes && <p className="small muted" style={{ margin: '8px 0 0' }}>{u.notes}</p>}
      </div>
      <div className="row">
        <CopyLoginMenu user={u} />
        <button className="btn sm" onClick={onEdit}>
          Edit
        </button>
      </div>
    </div>
  );
}

/** Live authenticator codes for keys linked to this test user. */
function UserAuthenticators({ userId }: { userId: string }) {
  const { slug } = useProject();
  const { data, now } = useAuthenticatorCodes(slug);
  const mine = data?.items.filter((a) => a.testUserId === userId) ?? [];
  if (!mine.length) {
    return (
      <div className="card quick-card">
        <span className="label">
          <Icon name="shield" size={12} /> 2FA codes
        </span>
        <span className="faint small">
          No authenticator key linked. <Link to={`/p/${slug}/authenticator`}>Add one</Link> and pick this user to see live codes here.
        </span>
      </div>
    );
  }
  return (
    <>
      {mine.map((a) => (
        <AuthenticatorCard key={a.id} a={a} now={now} compact />
      ))}
    </>
  );
}

function MessageViewer({
  message,
  slug,
  providerName,
  canCreateUser,
  onBack,
  onUserCreated,
}: {
  message: Message | null;
  slug: string;
  providerName?: string;
  canCreateUser: boolean;
  onBack: () => void;
  onUserCreated: () => void;
}) {
  const [view, setView] = useState<'html' | 'text' | 'raw'>('html');
  const [mobile, setMobile] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [reportLog, setReportLog] = useState<string | null>(null);
  const detail = useFetch<Message>(message ? `/api/messages/${message.id}` : null, [message?.id]);
  const copy = useCopy();
  const toast = useToast();

  useEffect(() => setView(message?.hasHtml ? 'html' : 'text'), [message?.id, message?.hasHtml]);

  if (!message) {
    return (
      <div className="card viewer">
        <Empty title="Select a message">Its content, links and delivery details show here.</Empty>
      </div>
    );
  }
  const m = detail.data ?? message;

  const createUser = async () => {
    const name = prompt('Name for the new test user', m.to.split('@')[0]);
    if (!name) return;
    const body = m.channel === 'email' ? { name, email: m.to } : m.channel === 'sms' ? { name, phone: m.to } : { name, whatsapp: m.to };
    try {
      await api.post(`/api/projects/${slug}/users`, body);
      toast('Test user created; new messages to this address go to their inbox');
      onUserCreated();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const markRead = async () => {
    try {
      await api.post(`/api/projects/${slug}/messages/${m.id}/read-receipt`, {});
      toast('Read receipt sent to your app');
      void detail.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="card viewer">
      <div className="card-head">
        <button className="btn sm ghost viewer-back" onClick={onBack} aria-label="Back to messages">
          ← Messages
        </button>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{m.subject ?? `${CHANNEL_LABEL[m.channel]} message`}</h2>
        </div>
        {canCreateUser && (
          <button className="btn sm" onClick={createUser}>
            Create test user
          </button>
        )}
        {m.channel === 'whatsapp' && m.direction === 'outbound' && m.status === 'delivered' && !m.metadata.readReceiptAt && (
          <button className="btn sm" onClick={markRead} title="The user read it: send a 'read' status webhook to your app">
            Mark as read
          </button>
        )}
        {m.logId && (
          <button className="btn sm" onClick={() => setLogOpen(true)}>
            Show request
          </button>
        )}
      </div>
      <div className="viewer-body">
        <dl className="kv">
          <dt>Channel</dt>
          <dd className="row">
            <ChannelIcon channel={m.channel} size={14} /> {CHANNEL_LABEL[m.channel]}
            {providerName && <Badge>via {providerName}</Badge>}
          </dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={m.status} />
            {m.statusDetail && <span className="muted small"> {m.statusDetail}</span>}
          </dd>
          {m.appliedRule && (
            <>
              <dt>Rule</dt>
              <dd className="small">
                {m.appliedRule.label} <span className="faint">({m.appliedRule.level})</span>
              </dd>
            </>
          )}
          {m.duplicateOfId && (
            <>
              <dt>Warning</dt>
              <dd className="small" style={{ color: 'var(--warn)' }}>
                {String(m.metadata.duplicateWarning ?? 'Possible duplicate send')}
              </dd>
            </>
          )}
          {m.providerMessageId && (
            <>
              <dt>Provider id</dt>
              <dd className="mono small">{m.providerMessageId}</dd>
            </>
          )}
          {Array.isArray(m.metadata.reports) && m.metadata.reports.length > 0 && (
            <>
              <dt>Reports</dt>
              <dd className="stack" style={{ gap: 2 }}>
                {(m.metadata.reports as { status: string; at: string; httpStatus: number | null; error: string | null; logId: string }[]).map((r) => (
                  <span key={r.logId} className="row small nowrap">
                    <StatusBadge status={r.status} />
                    <span className="faint">→ your app</span>
                    <span className={r.httpStatus && r.httpStatus < 400 ? '' : 'faint'} style={{ color: r.httpStatus && r.httpStatus < 400 ? 'var(--ok)' : 'var(--bad)' }}>
                      {r.httpStatus ?? r.error ?? 'no answer'}
                    </span>
                    <a href={`/traffic?log=${r.logId}`} onClick={(e) => (e.preventDefault(), setReportLog(r.logId))}>
                      details
                    </a>
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt>From</dt>
          <dd>{m.from ?? '—'}</dd>
          <dt>To</dt>
          <dd>
            {m.to}
            {m.metadata?.bcc === true && <Badge>bcc</Badge>}
          </dd>
          <dt>Received</dt>
          <dd>{new Date(m.createdAt).toLocaleString()}</dd>
          {typeof m.metadata.readReceiptAt === 'string' && (
            <>
              <dt>Read</dt>
              <dd className="small">{new Date(m.metadata.readReceiptAt).toLocaleString()} (read receipt sent)</dd>
            </>
          )}
          {verifyLabel(m) && (
            <>
              <dt>Verify</dt>
              <dd className="small">
                {verifyLabel(m)} <span className="mono faint">{String((m.metadata.verify as Record<string, unknown>).verificationSid ?? (m.metadata.verify as Record<string, unknown>).requestId ?? '')}</span>
              </dd>
            </>
          )}
          {m.otp && (
            <>
              <dt>Code</dt>
              <dd>
                <span className="otp" onClick={() => copy(m.otp!, 'Code copied')}>
                  {m.otp}
                </span>
              </dd>
            </>
          )}
          {m.links.length > 0 && (
            <>
              <dt>Links</dt>
              <dd className="stack" style={{ gap: 2 }}>
                {m.links.slice(0, 8).map((l) => (
                  <span key={l} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <a href={l} target="_blank" rel="noreferrer" className="ellipsis grow">
                      {l}
                    </a>
                    <button className="btn sm ghost" onClick={() => copy(l, 'Link copied')}>
                      Copy
                    </button>
                  </span>
                ))}
              </dd>
            </>
          )}
          {m.attachments > 0 && (
            <>
              <dt>Attachments</dt>
              <dd>{m.attachments} (open the raw message or the Mailpit view)</dd>
            </>
          )}
        </dl>
        <WaContentView m={m} slug={slug} instanceSlug={providerName} />
        {m.channel === 'email' && m.mailpit ? (
          <>
            <div className="tabs" style={{ margin: 0, padding: '0 12px' }}>
              {m.hasHtml && (
                <a className={`tab ${view === 'html' ? 'active' : ''}`} onClick={() => setView('html')} href="#html" onClickCapture={(e) => e.preventDefault()}>
                  HTML
                </a>
              )}
              <a className={`tab ${view === 'text' ? 'active' : ''}`} onClick={() => setView('text')} href="#text" onClickCapture={(e) => e.preventDefault()}>
                Text
              </a>
              <a className={`tab ${view === 'raw' ? 'active' : ''}`} onClick={() => setView('raw')} href="#raw" onClickCapture={(e) => e.preventDefault()}>
                Source
              </a>
              <span className="spacer" />
              {view === 'html' && (
                <a className={`tab ${mobile ? 'active' : ''}`} href="#mobile" onClick={(e) => (e.preventDefault(), setMobile(!mobile))} title="Preview at phone width">
                  📱 Mobile
                </a>
              )}
              <a className="tab" href={`/mailpit/view/${m.mailpitId}`} target="_blank" rel="noreferrer">
                Open in Mailpit ↗
              </a>
            </div>
            {view === 'html' && (
              <div className={`frame-wrap ${mobile ? 'mobile' : ''}`}>
                <iframe title="Email HTML" sandbox="allow-popups allow-popups-to-escape-sandbox" src={m.mailpit.html} />
              </div>
            )}
            {view === 'text' && <pre className="body">{m.bodyText}</pre>}
            {view === 'raw' && <RawSource url={m.mailpit.raw} />}
          </>
        ) : waOf(m) && waOf(m)!.type !== 'text' ? null : (
          <pre className="body">{m.bodyText}</pre>
        )}
      </div>
      {logOpen && m.logId && <LogDrawer id={m.logId} onClose={() => setLogOpen(false)} />}
      {reportLog && <LogDrawer id={reportLog} onClose={() => setReportLog(null)} />}
    </div>
  );
}

function RawSource({ url }: { url: string }) {
  const [text, setText] = useState<string>('Loading…');
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setText)
      .catch((e) => setText(String(e)));
  }, [url]);
  return <pre className="dump" style={{ margin: 12, maxHeight: '60vh' }}>{text}</pre>;
}

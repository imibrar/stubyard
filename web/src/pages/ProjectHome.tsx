import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { qs, type Channel, type Message, type TestUser } from '../api';
import { Avatar, Icon, RoleBadge, knownRoles, roleStyle } from '../components/people';
import { CopyLoginMenu, GenerateModal, KeptBadge, PinStar, UserModal } from '../components/users';
import { CHANNEL_LABEL, ChannelIcon, Empty, timeAgo, useCopy, useTick } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents, useNewAction } from '../hooks';
import { LintCounter } from '../components/Lint';
import { PageHeader } from '../components/layout';

const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];
const unread = (u: TestUser) => (u.inbox ? u.inbox.email.unread + u.inbox.sms.unread + u.inbox.whatsapp.unread : 0);

export default function ProjectHome() {
  useTick(15_000);
  const { slug, overview } = useProject();
  const { project, users, stats } = overview;
  const [editing, setEditing] = useState<TestUser | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  useNewAction({ user: () => setEditing('new'), generate: () => setGenerating(true) });
  const pinned = users.filter((u) => u.pinned > 0).sort((a, b) => a.pinned - b.pinned);
  // Latest codes strip: pinned users, or the three most recently active ones.
  const strip = pinned.length
    ? pinned
    : [...users].filter((u) => u.latest?.at).sort((a, b) => (b.latest!.at! > a.latest!.at! ? 1 : -1)).slice(0, 3);

  return (
    <>
      <PageHeader
        title={project.name}
        meta={
          <>
            <code>{project.slug}</code>
            <span className="home-counts small muted">
              {stats.users} users · <Link to={`/p/${slug}/providers`}>{stats.providers} providers</Link> · {stats.messages} messages · {stats.logs} requests
            </span>
            <Link to={`/p/${slug}/settings?tab=checks`} title="Content checks: see Settings">
              <LintCounter />
            </Link>
          </>
        }
        description={project.description || undefined}
        descriptionKey={`home.${slug}`}
        primary={
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> Add user
          </button>
        }
        secondary={[
          <button key="gen" className="btn" onClick={() => setGenerating(true)}>
            Generate users
          </button>,
        ]}
        more={(close) => (
          <>
            <Link to={`/p/${slug}/setup`} role="menuitem" className="menu-link" onClick={close}>
              <Icon name="code" size={14} /> Connect your app
            </Link>
            <Link to={`/p/${slug}/settings`} role="menuitem" className="menu-link" onClick={close}>
              <Icon name="settings" size={14} /> Edit project
            </Link>
          </>
        )}
      />

      {users.length === 0 ? (
        <div className="card">
          <Empty title="No test users yet">
            <p>Generate a set of users per role (admin, sales, support, customers…) or add one by hand.</p>
            <div className="row">
              <button className="btn primary" onClick={() => setGenerating(true)}>
                Generate test users
              </button>
              <Link to={`/p/${slug}/setup`} className="btn ghost">
                Connect your app
              </Link>
            </div>
          </Empty>
        </div>
      ) : (
        <div className="home-layout">
          {strip.length > 0 && (
            <section className="codes-strip" aria-label={pinned.length ? 'Latest codes of pinned users' : 'Latest codes of recently active users'}>
              <div className="section-title">
                Latest codes <span className="nav-label-hint">{pinned.length ? '· pinned users · press 1–9 to open' : '· most recently active users'}</span>
              </div>
              <div className="codes-row">
                {strip.map((u, i) => (
                  <CodeTile key={u.id} user={u} index={pinned.length ? i : undefined} />
                ))}
              </div>
            </section>
          )}
          <div className="home-split">
            <UsersTable onEdit={setEditing} />
            <aside className="home-side" aria-label="Activity and setup">
              <RecentActivity />
              {stats.messages === 0 && <SetupStatus />}
            </aside>
          </div>
        </div>
      )}
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {generating && <GenerateModal onClose={() => setGenerating(false)} />}
    </>
  );
}

/** One tile of the latest-codes strip: who, the code (click to copy), how old, unread dot. */
function CodeTile({ user: u, index }: { user: TestUser; index?: number }) {
  const { slug } = useProject();
  const copy = useCopy();
  const code = u.latest?.otp;
  const n = unread(u);
  return (
    <div className="code-tile" style={roleStyle(u.role)}>
      <Link to={`/p/${slug}/users/${u.id}`} className="code-tile-who" title={`Open ${u.name}`}>
        <Avatar user={u} size="sm" />
        <span className="code-tile-name">{u.name}</span>
        {n > 0 && <span className="unread-dot" aria-label={`${n} unread`} title={`${n} unread`} />}
        {index !== undefined && index < 9 && <kbd className="code-tile-key">{index + 1}</kbd>}
      </Link>
      {code ? (
        <button className="code-tile-code" title={`Copy ${code}`} onClick={() => void copy(code, `Copied ${code}`)}>
          <span>{code}</span>
          <Icon name="copy" size={12} />
        </button>
      ) : (
        <span className="code-tile-code none">no code yet</span>
      )}
      <span className="code-tile-meta">{code ? `${CHANNEL_LABEL[u.latest!.otpChannel ?? 'email']} · ${timeAgo(u.latest!.otpAt!)}` : u.latest?.at ? `last message ${timeAgo(u.latest.at)}` : 'no messages'}</span>
    </div>
  );
}

function UsersTable({ onEdit }: { onEdit: (u: TestUser) => void }) {
  const { slug, overview } = useProject();
  const nav = useNavigate();
  const copy = useCopy();
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const roles = knownRoles(overview.users).filter((r) => overview.users.some((u) => u.role === r));
  const f = q.trim().toLowerCase();
  const list = overview.users.filter(
    (u) => (!role || u.role === role) && (!f || [u.name, u.email, u.phone, u.notes].some((v) => v?.toLowerCase().includes(f))),
  );
  const pw = (u: TestUser) => u.password ?? overview.project.settings.defaultPassword ?? '';
  return (
    <div className="card users-card">
      <div className="filters">
        <div className="chips ui-filter grow">
          <button className={`chip ${role === '' ? 'active' : ''}`} onClick={() => setRole('')} aria-pressed={role === ''}>
            All <span className="n">{overview.users.length}</span>
          </button>
          {roles.map((r) => (
            <button key={r} className={`chip ${role === r ? 'active' : ''}`} onClick={() => setRole(r)} aria-pressed={role === r}>
              <span className="role-dot" style={roleStyle(r)} />
              {r.replace(/-/g, ' ')} <span className="n">{overview.users.filter((u) => u.role === r).length}</span>
            </button>
          ))}
        </div>
        <input type="search" className="users-filter" placeholder="Filter users…" aria-label="Filter users" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="users-table">
          <thead>
            <tr>
              <th className="col-star">
                <span className="sr-only">Pinned</span>
              </th>
              <th scope="col">User</th>
              <th scope="col" className="col-sm col-contact">
                Contact
              </th>
              <th scope="col">Latest code</th>
              <th scope="col" className="col-wide">
                Password
              </th>
              <th scope="col" className="col-wide">
                Rules
              </th>
              <th scope="col" className="align-end">
                Unread
              </th>
              <th scope="col" className="col-sm align-end">
                Last
              </th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => nav(`/p/${slug}/users/${u.id}`)}>
                <td className="col-star" onClick={(e) => e.stopPropagation()}>
                  <PinStar user={u} />
                </td>
                <td className="user-cell">
                  <div className="row nowrap">
                    <Avatar user={u} size="sm" />
                    <div className="user-cell-main">
                      <Link to={`/p/${slug}/users/${u.id}`} className="user-cell-name" onClick={(e) => e.stopPropagation()}>
                        {u.name}
                      </Link>
                      <div className="user-cell-tags">
                        <RoleBadge role={u.role} />
                        {u.marketingOptOut && (
                          <span className="badge" title="Marketing opt-out">
                            DND
                          </span>
                        )}
                        <KeptBadge keep={u.keep} />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="mono col-sm contact-cell">
                  <div className="ellipsis">{u.email ?? <span className="faint">—</span>}</div>
                  <div className="ellipsis muted">{u.phone}</div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {u.latest?.otp ? (
                    <button className="otp otp-copy" title={`Copy ${u.latest.otp}`} onClick={() => void copy(u.latest!.otp!, `Copied ${u.latest!.otp}`)}>
                      {u.latest.otp}
                    </button>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="col-wide mono" onClick={(e) => e.stopPropagation()}>
                  {pw(u) ? (
                    <button className="btn xs ghost" title="Copy password" onClick={() => void copy(pw(u), 'Password copied')}>
                      •••••• <Icon name="copy" size={12} />
                    </button>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="col-wide">{u.activeRules ? <span className="badge warn">⚡ {u.activeRules}</span> : <span className="faint">—</span>}</td>
                <td className="align-end">{unread(u) > 0 ? <span className="count">{unread(u)}</span> : <span className="faint">0</span>}</td>
                <td className="muted col-sm align-end nowrap-cell">{u.latest?.at ? timeAgo(u.latest.at) : '—'}</td>
                <td className="row-actions-cell" onClick={(e) => e.stopPropagation()}>
                  <CopyLoginMenu user={u} compact />
                  <button className="btn xs ghost" onClick={() => onEdit(u)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <Empty title="No users match" />}
      </div>
    </div>
  );
}

/** Shown until the project receives its first message: what is set up and where to connect. */
function SetupStatus() {
  const { slug, overview } = useProject();
  const counts = overview.providerCounts ?? {};
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Setup status</h3>
      </div>
      <div className="card-pad stack setup-status">
        {entries.length ? (
          <div className="chips">
            {entries.map(([k, n]) => (
              <Link key={k} to={`/p/${slug}/providers/${k}`} className="chip">
                {k} <span className="n">{n}</span>
              </Link>
            ))}
          </div>
        ) : (
          <span className="muted small">No providers yet.</span>
        )}
        <Link to={`/p/${slug}/setup`} className="btn sm">
          <Icon name="code" size={13} /> Connect your app
        </Link>
      </div>
    </div>
  );
}

function RecentActivity() {
  const { slug, overview } = useProject();
  const path = `/api/projects/${slug}/messages${qs({ limit: 20 })}`;
  const msgs = useFetch<Message[]>(path, [path]);
  const reload = useDebounced(() => void msgs.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'message.created' || e.type === 'project.reset' || e.type === 'message.updated') reload();
  });
  const byId = useMemo(() => new Map(overview.users.map((u) => [u.id, u])), [overview.users]);
  // At most 8 rows; consecutive messages to the same recipient with the same text collapse into "× n".
  const list = useMemo(() => {
    const out: { m: Message; n: number }[] = [];
    for (const m of msgs.data ?? []) {
      const last = out[out.length - 1];
      const key = (x: Message) => `${x.testUserId ?? x.to}|${x.channel}|${x.subject ?? x.bodyText?.slice(0, 80)}`;
      if (last && key(last.m) === key(m)) last.n++;
      else out.push({ m, n: 1 });
    }
    return out.slice(0, 8);
  }, [msgs.data]);
  return (
    <div className="card activity-card">
      <div className="card-head">
        <h3>Recent activity</h3>
        <Link to={`/p/${slug}/traffic`} className="small">
          Traffic log →
        </Link>
      </div>
      {list.length === 0 && !msgs.loading ? (
        <Empty title="Nothing yet">Messages your app sends show up here live.</Empty>
      ) : (
        <div className="activity">
          {list.map(({ m, n }) => {
            const u = m.testUserId ? byId.get(m.testUserId) : undefined;
            const to = u ? `/p/${slug}/users/${u.id}?m=${m.id}` : `/p/${slug}/unassigned?m=${m.id}`;
            return (
              <Link key={m.id} to={to} className="act">
                <ChannelIcon channel={m.channel} size={14} />
                <div style={{ minWidth: 0 }}>
                  <div className="row nowrap small">
                    {u ? <Avatar user={u} size="sm" /> : <span className="badge">unassigned</span>}
                    <span className="ellipsis" style={{ fontWeight: m.readAt ? 400 : 650 }}>
                      {u?.name ?? m.to}
                    </span>
                  </div>
                  <div className="small muted ellipsis">
                    {m.subject ?? m.bodyText?.slice(0, 80)}
                    {n > 1 && <span className="repeat-n"> × {n}</span>}
                  </div>
                </div>
                <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
                  <span className="small muted nowrap-cell">
                    {timeAgo(m.createdAt)}
                  </span>
                  {m.otp && <span className="otp small">{m.otp}</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

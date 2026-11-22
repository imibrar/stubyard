import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { qs, type Channel, type Message, type TestUser } from '../api';
import { Avatar, Icon, RoleBadge, knownRoles, roleStyle } from '../components/people';
import { CopyLoginMenu, GenerateModal, KeptBadge, PinStar, UserModal } from '../components/users';
import { CHANNEL_LABEL, ChannelIcon, Empty, timeAgo, useCopy, useTick } from '../components/ui';
import { useProject, useProjects } from '../context';
import { PageHeader } from '../components/layout';
import { PROVIDER_TABS } from '../nav';
import { useDebounced, useFetch, useHubEvents, useNewAction } from '../hooks';
import { LintCounter } from '../components/Lint';

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

  // Latest codes strip: pinned users, or the three most recently active users when nothing is pinned.
  const strip = pinned.length ? pinned : [...users].filter((u) => u.latest?.at).sort((a, b) => (b.latest!.at! > a.latest!.at! ? 1 : -1)).slice(0, 3);

  return (
    <>
      <PageHeader
        title={project.name}
        meta={
          <>
            <code className="slug-chip">{project.slug}</code>
            <span className="small muted home-counts">
              {stats.users} users · <Link to={`/p/${slug}/providers`}>{stats.providers} providers</Link> · {stats.messages} messages · {stats.logs} requests
            </span>
            <Link to={`/p/${slug}/settings?tab=checks`} title="Content checks: see Settings">
              <LintCounter />
            </Link>
          </>
        }
        description={project.description || undefined}
        secondary={[
          <Link key="connect" to={`/p/${slug}/setup`} className="btn sm">
            <Icon name="code" size={14} /> Connect your app
          </Link>,
          <button key="gen" className="btn sm" onClick={() => setGenerating(true)}>
            Generate users
          </button>,
        ]}
        primary={
          <button className="btn sm primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> Add user
          </button>
        }
      />

      {users.length === 0 ? (
        <div className="card">
          <Empty title="No test users yet">
            <p>Generate a set of users per role (admin, sales, support, customers…) or add one by hand.</p>
            <button className="btn primary" onClick={() => setGenerating(true)}>
              Generate test users
            </button>
          </Empty>
        </div>
      ) : (
        <div className="home-grid">
          <div className="home-main">
            {strip.length > 0 && (
              <section className="codes-strip-wrap" aria-label="Latest codes">
                <div className="section-title">
                  Latest codes <span className="faint home-hint">{pinned.length ? '· pinned users, press 1–9 to open' : '· most recently active'}</span>
                </div>
                <div className="codes-strip">
                  {strip.map((u, i) => (
                    <CodeTile key={u.id} user={u} index={pinned.length ? i : undefined} />
                  ))}
                </div>
              </section>
            )}
            <UsersTable onEdit={setEditing} />
          </div>
          <aside className="home-side">
            <RecentActivity />
            <SetupStatus />
          </aside>
        </div>
      )}
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {generating && <GenerateModal onClose={() => setGenerating(false)} />}
    </>
  );
}

/** One compact tile per pinned user: avatar, name, latest code (click to copy), age, unread. */
function CodeTile({ user: u, index }: { user: TestUser; index?: number }) {
  const { slug } = useProject();
  const copy = useCopy();
  const code = u.latest?.otp;
  const n = unread(u);
  return (
    <div className="code-tile" style={roleStyle(u.role)}>
      <Link to={`/p/${slug}/users/${u.id}`} className="code-tile-who" title={`Open ${u.name}`}>
        <Avatar user={u} size="sm" />
        <span className="ellipsis">{u.name}</span>
        {n > 0 && <span className="count" aria-label={`${n} unread`}>{n}</span>}
        {index !== undefined && index < 9 && <kbd className="key">{index + 1}</kbd>}
      </Link>
      {code ? (
        <button className="code-tile-code" title="Click to copy" onClick={() => void copy(code, `Copied ${code}`)} aria-label={`Copy code ${code} of ${u.name}`}>
          {code}
          <Icon name="copy" size={12} />
        </button>
      ) : (
        <span className="code-tile-code none">no code yet</span>
      )}
      <span className="code-tile-meta small faint">{code ? `${CHANNEL_LABEL[u.latest!.otpChannel ?? 'email']} · ${timeAgo(u.latest!.otpAt!)}` : u.latest?.at ? `active ${timeAgo(u.latest.at)}` : 'no messages'}</span>
    </div>
  );
}

/** Setup status: providers per kind, HTTPS and Connect your app (shown until the first message arrives, then compact). */
function SetupStatus() {
  const { slug, overview } = useProject();
  const { system } = useProjects();
  const counts = overview.providerCounts ?? {};
  const kinds = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <div className="card setup-status">
      <div className="card-head">
        <h3>Setup</h3>
        <Link to={`/p/${slug}/setup`} className="small">
          Connect your app →
        </Link>
      </div>
      <dl className="kv bare setup-kv">
        {kinds.map(([k, n]) => (
          <div key={k} className="kv-row">
            <dt>{PROVIDER_TABS.find((t) => t.id === k)?.label.replace(/ \(.*\)$/, '') ?? k}</dt>
            <dd>
              <Link to={`/p/${slug}/providers/${k}`}>{n} provider{n === 1 ? '' : 's'}</Link>
            </dd>
          </div>
        ))}
        {!kinds.length && (
          <div className="kv-row">
            <dt>Providers</dt>
            <dd>
              <Link to={`/p/${slug}/providers`}>Add a provider</Link>
            </dd>
          </div>
        )}
        <div className="kv-row">
          <dt>HTTPS</dt>
          <dd>
            <Link to="/https" className="row nowrap" style={{ gap: 6 }}>
              <span className={`dot ${system?.tls ? 'on' : 'off'}`} aria-hidden /> {system?.tls ? `on :${system.ports.https}` : 'off'}
            </Link>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function UsersTable({ onEdit }: { onEdit: (u: TestUser) => void }) {
  const { slug, overview } = useProject();
  const nav = useNavigate();
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const copy = useCopy();
  const roles = knownRoles(overview.users).filter((r) => overview.users.some((u) => u.role === r));
  const f = q.trim().toLowerCase();
  const list = overview.users.filter(
    (u) => (!role || u.role === role) && (!f || [u.name, u.email, u.phone, u.notes].some((v) => v?.toLowerCase().includes(f))),
  );
  return (
    <div className="card users-card" style={{ overflow: 'hidden' }}>
      <div className="filters">
        <div className="chips grow">
          <button className={`chip ${role === '' ? 'active' : ''}`} onClick={() => setRole('')}>
            All <span className="n">{overview.users.length}</span>
          </button>
          {roles.map((r) => (
            <button key={r} className={`chip ${role === r ? 'active' : ''}`} onClick={() => setRole(r)}>
              <span className="role-dot" style={roleStyle(r)} />
              {r.replace(/-/g, ' ')} <span className="n">{overview.users.filter((u) => u.role === r).length}</span>
            </button>
          ))}
        </div>
        <input type="search" placeholder="Filter users…" aria-label="Filter users" value={q} onChange={(e) => setQ(e.target.value)} className="users-filter" />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}></th>
              <th>User</th>
              <th className="col-sm">Contact</th>
              <th>Latest code</th>
              <th>Unread</th>
              <th className="col-sm">Last</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => nav(`/p/${slug}/users/${u.id}`)}>
                <td>
                  <PinStar user={u} />
                </td>
                <td className="user-td">
                  <div className="row nowrap user-cell">
                    <Avatar user={u} />
                    <div className="user-cell-text">
                      <div className="user-cell-name">{u.name}</div>
                      <div className="row nowrap user-cell-sub">
                        <RoleBadge role={u.role} />
                        {u.marketingOptOut && <span className="badge" title="Marketing opt-out">DND</span>}
                        <KeptBadge keep={u.keep} />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="mono col-sm" style={{ maxWidth: 240 }}>
                  <div className="ellipsis">{u.email ?? <span className="faint">—</span>}</div>
                  <div className="ellipsis faint">{u.phone}</div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {u.latest?.otp ? (
                    <button className="otp" title="Copy code" onClick={() => void copy(u.latest!.otp!, `Copied ${u.latest!.otp}`)}>
                      {u.latest.otp}
                    </button>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td>{unread(u) > 0 ? <span className="count">{unread(u)}</span> : <span className="faint">0</span>}</td>
                <td className="small faint col-sm" style={{ whiteSpace: 'nowrap' }}>
                  {u.latest?.at ? timeAgo(u.latest.at) : '—'}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
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

function RecentActivity() {
  const { slug, overview } = useProject();
  const path = `/api/projects/${slug}/messages${qs({ limit: 20 })}`;
  const msgs = useFetch<Message[]>(path, [path]);
  const reload = useDebounced(() => void msgs.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'message.created' || e.type === 'project.reset' || e.type === 'message.updated') reload();
  });
  const byId = useMemo(() => new Map(overview.users.map((u) => [u.id, u])), [overview.users]);
  // Max 8 rows; consecutive messages with the same recipient and text collapse into one row with "× n".
  const list = useMemo(() => {
    const out: { m: Message; n: number }[] = [];
    for (const m of msgs.data ?? []) {
      const last = out[out.length - 1];
      const key = (x: Message) => `${x.testUserId ?? x.to}|${x.channel}|${x.direction}|${x.subject ?? x.bodyText?.slice(0, 80)}`;
      if (last && key(last.m) === key(m)) last.n++;
      else out.push({ m, n: 1 });
    }
    return out.slice(0, 8);
  }, [msgs.data]);
  return (
    <div className="card activity-card" style={{ overflow: 'hidden' }}>
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
                  <div className="small faint ellipsis">
                    {m.subject ?? m.bodyText?.slice(0, 80)}
                    {n > 1 && <span className="badge dup-n"> × {n}</span>}
                  </div>
                </div>
                <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
                  <span className="small faint" style={{ whiteSpace: 'nowrap' }}>
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

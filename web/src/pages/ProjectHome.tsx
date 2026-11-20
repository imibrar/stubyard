import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { qs, type Channel, type Message, type TestUser } from '../api';
import { Avatar, Icon, RoleBadge, knownRoles, roleStyle } from '../components/people';
import { CopyLoginMenu, GenerateModal, PinStar, UserModal } from '../components/users';
import { CHANNEL_LABEL, ChannelIcon, Empty, timeAgo, useCopy, useTick } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { LintCounter } from '../components/Lint';

const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];
const unread = (u: TestUser) => (u.inbox ? u.inbox.email.unread + u.inbox.sms.unread + u.inbox.whatsapp.unread : 0);

export default function ProjectHome() {
  useTick(15_000);
  const { slug, overview } = useProject();
  const { project, users, stats } = overview;
  const [editing, setEditing] = useState<TestUser | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const pinned = users.filter((u) => u.pinned > 0).sort((a, b) => a.pinned - b.pinned);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="row small">
            <code>{project.slug}</code>
            <span>
              {stats.users} users · <Link to={`/p/${slug}/providers`}>{stats.providers} providers</Link> · {stats.messages} messages · {stats.logs} requests
            </span>
            {project.description && <span>· {project.description}</span>}
            <Link to={`/p/${slug}/settings`} title="Content checks: see Settings">
              <LintCounter />
            </Link>
          </p>
        </div>
        <div className="row">
          <Link to={`/p/${slug}/setup`} className="btn">
            <Icon name="code" size={14} /> Connect your app
          </Link>
          <button className="btn" onClick={() => setGenerating(true)}>
            Generate users
          </button>
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> Add user
          </button>
        </div>
      </div>

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
        <div className="stack" style={{ gap: 20 }}>
          {pinned.length > 0 && (
            <section>
              <div className="section-title">
                Pinned users <span style={{ textTransform: 'none', letterSpacing: 0 }}>· press 1–9 anywhere to jump</span>
              </div>
              <div className="grid grid-cards">
                {pinned.map((u, i) => (
                  <PinnedCard key={u.id} user={u} index={i} />
                ))}
              </div>
            </section>
          )}
          <div className="two-col">
            <UsersTable onEdit={setEditing} />
            <RecentActivity />
          </div>
        </div>
      )}
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {generating && <GenerateModal onClose={() => setGenerating(false)} />}
    </>
  );
}

function PinnedCard({ user: u, index }: { user: TestUser; index: number }) {
  const { slug } = useProject();
  const nav = useNavigate();
  const copy = useCopy();
  const code = u.latest?.otp;
  return (
    <div className="card pin-card" style={roleStyle(u.role)} onClick={() => nav(`/p/${slug}/users/${u.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/p/${slug}/users/${u.id}`)}>
      {index < 9 && <kbd className="key">{index + 1}</kbd>}
      <div className="row nowrap">
        <Avatar user={u} />
        <div className="grow">
          <div className="ellipsis" style={{ fontWeight: 600 }}>
            {u.name}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <RoleBadge role={u.role} />
            {!!u.activeRules && <span className="badge warn" title="Scenario rules active">⚡ {u.activeRules} rule{u.activeRules > 1 ? 's' : ''}</span>}
          </div>
        </div>
      </div>
      <div>
        <div className="small faint">{code ? `Latest code · ${CHANNEL_LABEL[u.latest!.otpChannel ?? 'email']} · ${timeAgo(u.latest!.otpAt!)}` : 'No code received yet'}</div>
        {code ? (
          <button
            className="code-big"
            title="Click to copy"
            onClick={(e) => {
              e.stopPropagation();
              void copy(code, `Copied ${code}`);
            }}
          >
            {code}
          </button>
        ) : (
          <div className="code-big faint">— — —</div>
        )}
      </div>
      <div className="row nowrap small">
        <div className="channel-counts grow">
          {CHANNELS.map((c) => {
            const n = u.inbox?.[c];
            return (
              <span key={c} className={`chan ${n?.unread ? 'has' : ''}`} title={`${CHANNEL_LABEL[c]}: ${n?.unread ?? 0} unread / ${n?.total ?? 0}`}>
                <ChannelIcon channel={c} size={12} /> {n?.unread ? n.unread : n?.total ?? 0}
              </span>
            );
          })}
        </div>
        <span className="faint ellipsis" title={u.email ?? ''}>
          {u.latest?.at ? timeAgo(u.latest.at) : ''}
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <CopyLoginMenu user={u} compact />
        </span>
      </div>
    </div>
  );
}

function UsersTable({ onEdit }: { onEdit: (u: TestUser) => void }) {
  const { slug, overview } = useProject();
  const nav = useNavigate();
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const roles = knownRoles(overview.users).filter((r) => overview.users.some((u) => u.role === r));
  const f = q.trim().toLowerCase();
  const list = overview.users.filter(
    (u) => (!role || u.role === role) && (!f || [u.name, u.email, u.phone, u.notes].some((v) => v?.toLowerCase().includes(f))),
  );
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
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
        <input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}></th>
              <th>User</th>
              <th className="col-sm">Contact</th>
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
                <td className="cell-fill">
                  <div className="row nowrap">
                    <Avatar user={u} size="sm" />
                    <span className="ellipsis" style={{ fontWeight: 550 }}>
                      {u.name}
                    </span>
                    <RoleBadge role={u.role} />
                    {u.marketingOptOut && <span className="badge" title="Marketing opt-out">DND</span>}
                  </div>
                </td>
                <td className="mono col-sm" style={{ maxWidth: 240 }}>
                  <div className="ellipsis">{u.email ?? <span className="faint">—</span>}</div>
                  <div className="ellipsis faint">{u.phone}</div>
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
  const list = msgs.data ?? [];
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
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
          {list.map((m) => {
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
                  <div className="small faint ellipsis">{m.subject ?? m.bodyText?.slice(0, 80)}</div>
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

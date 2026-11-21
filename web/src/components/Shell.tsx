import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, type Message, type TestUser } from '../api';
import { useProjectMaybe, useProjects, type ProjectState } from '../context';
import { useHubEvents } from '../hooks';
import { Avatar, Icon, roleStyle, useLocalState, type IconName } from './people';
import { useCopy, useToast } from './ui';

export type Theme = 'dark' | 'light';

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

const unreadOf = (u: TestUser) => (u.inbox ? u.inbox.email.unread + u.inbox.sms.unread + u.inbox.whatsapp.unread : 0);

/** App frame: top bar, sidebar (global or project), command palette, shortcuts and notifications. */
export function Shell({ children }: { children: ReactNode }) {
  const project = useProjectMaybe();
  const nav = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useLocalState<Theme>('stubyard.theme', 'dark');
  const [notify, setNotify] = useLocalState<boolean>('stubyard.notify', false);
  const toast = useToast();

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => setSidebarOpen(false), [location.pathname, location.search]);
  // Off-canvas sidebar (mobile): Escape closes it.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSidebarOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  const pinned = useMemo(() => (project?.overview.users ?? []).filter((u) => u.pinned > 0).sort((a, b) => a.pinned - b.pinned), [project?.overview.users]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || paletteOpen) return;
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (project && /^[1-9]$/.test(e.key)) {
        const u = pinned[Number(e.key) - 1];
        if (u) nav(`/p/${project.slug}/users/${u.id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, pinned, nav, paletteOpen]);

  // New codes: in-app toast, plus a desktop notification when enabled and the tab is in the background.
  const usersRef = useRef(project?.overview.users);
  usersRef.current = project?.overview.users;
  useHubEvents(null, (e) => {
    if (e.type !== 'message.created') return;
    const m = e.data as Message;
    if (!m?.otp) return;
    const who = usersRef.current?.find((u) => u.id === m.testUserId)?.name ?? m.to;
    toast(`New code ${m.otp} → ${who}`);
    if (notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`${m.otp} — ${who}`, { body: m.subject ?? `${m.channel} to ${m.to}`, tag: m.id });
    }
  });

  const toggleNotify = async () => {
    if (notify) return setNotify(false);
    if (!('Notification' in window)) return toast('This browser does not support notifications');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm === 'granted') {
      setNotify(true);
      toast('Desktop notifications on for new codes');
    } else toast('Notifications are blocked for this site');
  };

  return (
    <div className="shell">
      <Topbar
        theme={theme}
        onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        notify={notify}
        onNotify={toggleNotify}
        onSearch={() => setPaletteOpen(true)}
        menuOpen={sidebarOpen}
        onMenu={() => setSidebarOpen(!sidebarOpen)}
      />
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      <nav
        id="sidebar"
        className={`sidebar ${sidebarOpen ? 'open' : ''}`}
        aria-label="Navigation"
        // Tapping any link closes the off-canvas sidebar, even when it points at the current page.
        onClick={(e) => (e.target as HTMLElement).closest('a') && setSidebarOpen(false)}
      >
        {project ? <ProjectSidebar project={project} pinned={pinned} /> : <GlobalSidebar />}
        <SidebarFoot inProject={!!project} />
      </nav>
      <main className="main">{children}</main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} theme={theme} setTheme={setTheme} />}
    </div>
  );
}

// ---------------- top bar ----------------

function Topbar(props: { theme: Theme; onTheme: () => void; notify: boolean; onNotify: () => void; onSearch: () => void; onMenu: () => void; menuOpen: boolean }) {
  const { projects, system, connected } = useProjects();
  const project = useProjectMaybe();
  const nav = useNavigate();
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" onClick={props.onMenu} aria-label="Menu" aria-expanded={props.menuOpen} aria-controls="sidebar">
        <Icon name="menu" />
      </button>
      <NavLink to="/" className="brand" end>
        <img src="/favicon.svg" alt="" />
        <span>
          stubyard <small>testing hub</small>
        </span>
      </NavLink>
      {projects && projects.length > 0 && (
        <select className="project-switch" value={project?.slug ?? ''} onChange={(e) => nav(e.target.value ? `/p/${e.target.value}` : '/')} aria-label="Project">
          {!project && <option value="">Select project…</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <button className="search-btn" onClick={props.onSearch} aria-label="Search" title={`Search (${mac ? '⌘' : 'Ctrl'} K)`}>
        <Icon name="search" size={14} />
        <span className="grow">Jump to user, page, request id…</span>
        <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <div className="status-pills">
        <span className="pill" title={connected ? 'Live updates connected' : 'Reconnecting…'}>
          <span className={`dot ${connected ? 'on' : 'off'}`} /> live
        </span>
        {system && (
          <>
            <span className="pill" title={`SMTP on port ${system.ports.smtp}${system.mailpit ? '' : ' (Mailpit unavailable)'}`}>
              <span className={`dot ${system.mailpit ? 'on' : 'off'}`} /> smtp:{system.ports.smtp}
            </span>
            <NavLink to="/https" className="pill" title={system.tls ? `HTTPS on port ${system.ports.https}` : 'HTTPS disabled'}>
              <span className={`dot ${system.tls ? 'on' : 'off'}`} /> https:{system.ports.https}
            </NavLink>
          </>
        )}
      </div>
      <button className={`icon-btn ${props.notify ? 'on' : ''}`} onClick={props.onNotify} title={props.notify ? 'Desktop notifications: on' : 'Desktop notifications: off'}>
        <Icon name="bell" />
      </button>
      <button className="icon-btn" onClick={props.onTheme} title={`Switch to ${props.theme === 'dark' ? 'light' : 'dark'} theme`}>
        <Icon name={props.theme === 'dark' ? 'sun' : 'moon'} />
      </button>
    </header>
  );
}

// ---------------- sidebars ----------------

function NavItem({ to, icon, label, end, right }: { to: string; icon: IconName; label: string; end?: boolean; right?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className="nav-link">
      <Icon name={icon} />
      <span className="label">{label}</span>
      {right}
    </NavLink>
  );
}

/** Instances across every Providers tab (email, SMS, WhatsApp, login, payments, LLM APIs, push), same counts as the tabs. */
function ProviderCount({ overview }: { overview: ProjectState['overview'] }) {
  const c = overview.providerCounts;
  const n = c ? Object.values(c).reduce((a, b) => a + b, 0) : overview.providers.length;
  const title = c ? Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ') : undefined;
  return (
    <span className="hint" title={title}>
      {n}
    </span>
  );
}

function GlobalSidebar() {
  const { projects } = useProjects();
  return (
    <>
      <div className="nav-label">Workspace</div>
      <NavItem to="/" end icon="folder" label="All projects" />
      <div className="nav-label">Projects</div>
      {projects?.map((p) => (
        <NavItem key={p.id} to={`/p/${p.slug}`} icon="home" label={p.name} right={!!p.stats?.unread && <span className="count">{p.stats.unread}</span>} />
      ))}
      {projects?.length === 0 && <span className="faint small" style={{ padding: '0 8px' }}>No projects yet</span>}
    </>
  );
}

function ProjectSidebar({ project, pinned }: { project: ProjectState; pinned: TestUser[] }) {
  const { slug, overview, reload } = project;
  const [filter, setFilter] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const others = overview.users.filter((u) => !u.pinned);
  const f = filter.trim().toLowerCase();
  const shown = f ? others.filter((u) => [u.name, u.role, u.email, u.phone].some((v) => v?.toLowerCase().includes(f))) : others;
  const unassigned = overview.unassigned.email.unread + overview.unassigned.sms.unread + overview.unassigned.whatsapp.unread;

  const drop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = pinned.map((u) => u.id).filter((id) => id !== dragId);
    const at = targetId === '__end' ? ids.length : ids.indexOf(targetId);
    ids.splice(at < 0 ? ids.length : at, 0, dragId);
    setDragId(null);
    setOverId(null);
    await api.put(`/api/projects/${slug}/pins`, { ids });
    reload();
  };

  const userLink = (u: TestUser, i?: number) => (
    <NavLink
      key={u.id}
      to={`/p/${slug}/users/${u.id}`}
      className={`nav-link ${dragId === u.id ? 'dragging' : ''} ${overId === u.id && dragId !== u.id ? 'drop-target' : ''}`}
      draggable
      onDragStart={(e) => {
        setDragId(u.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        setDragId(null);
        setOverId(null);
      }}
      onDragOver={(e) => {
        if (i === undefined || !dragId) return;
        e.preventDefault();
        setOverId(u.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (i !== undefined) void drop(u.id);
      }}
      title={`${u.name} · ${u.role}${u.email ? ` · ${u.email}` : ''}`}
    >
      <Avatar user={u} size="sm" />
      <span className="label">{u.name}</span>
      {!!u.activeRules && <span title={`${u.activeRules} active scenario rule(s)`} style={{ color: 'var(--warn)', fontSize: 11 }}>⚡</span>}
      {unreadOf(u) > 0 && <span className="count">{unreadOf(u)}</span>}
      {i !== undefined && i < 9 && <span className="hint">{i + 1}</span>}
    </NavLink>
  );

  return (
    <>
      <NavItem to={`/p/${slug}`} end icon="home" label={overview.project.name} />
      <div className="nav-label">
        Pinned <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>press 1–9</span>
      </div>
      <div
        onDragOver={(e) => dragId && !pinned.some((u) => u.id === dragId) && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && !pinned.some((u) => u.id === dragId)) void drop('__end');
        }}
        className="stack"
        style={{ gap: 1, minHeight: 30 }}
      >
        {pinned.map((u, i) => userLink(u, i))}
        {pinned.length === 0 && <span className="faint small" style={{ padding: '4px 8px' }}>Drag a user here, or press ☆ on a user.</span>}
      </div>
      <div className="nav-label">
        Users <span>{overview.users.length}</span>
      </div>
      {others.length > 8 && <input className="nav-filter" type="search" placeholder="Filter users…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="nav-scroll">
        {shown.map((u) => userLink(u))}
        {others.length === 0 && overview.users.length > 0 && <span className="faint small" style={{ padding: '4px 8px' }}>All users are pinned.</span>}
      </div>
      <NavLink to={`/p/${slug}/unassigned`} className="nav-link">
        <Icon name="inbox" />
        <span className="label">Unassigned</span>
        {unassigned > 0 && <span className="count">{unassigned}</span>}
      </NavLink>
      <div className="nav-label">Project</div>
      <NavItem to={`/p/${slug}/traffic`} icon="activity" label="Traffic log" />
      <NavItem to={`/p/${slug}/providers`} icon="plug" label="Providers" right={<ProviderCount overview={overview} />} />
      <NavItem to={`/p/${slug}/mocks`} icon="link" label="API mocks" />
      <NavItem to={`/p/${slug}/llm`} icon="code" label="LLM mocks" />
      <NavItem to={`/p/${slug}/webhooks`} icon="bell" label="Webhooks" />
      <NavItem to={`/p/${slug}/auto-replies`} icon="mail" label="Auto-replies" />
      <NavItem to={`/p/${slug}/storyboards`} icon="eye" label="Storyboards" />
      <NavItem to={`/p/${slug}/push`} icon="bell" label="Push" />
      <NavItem to={`/p/${slug}/payments`} icon="lock" label="Payments" />
      <NavItem to={`/p/${slug}/scheduled`} icon="activity" label="Scheduled" />
      <NavItem to={`/p/${slug}/storage`} icon="folder" label="Storage" />
      <NavItem to={`/p/${slug}/mcp-tester`} icon="code" label="MCP tester" />
      <NavItem to={`/p/${slug}/chat`} icon="mail" label="Chat" />
      <NavItem to={`/p/${slug}/runs`} icon="shield" label="Test runs" />
      <NavItem to={`/p/${slug}/authenticator`} icon="key" label="Authenticator" right={<span className="hint">{overview.authenticators.length}</span>} />
      <NavItem to={`/p/${slug}/setup`} icon="code" label="Connect your app" />
      <NavItem to={`/p/${slug}/settings`} icon="settings" label="Settings" />
    </>
  );
}

function SidebarFoot({ inProject }: { inProject: boolean }) {
  return (
    <div className="sidebar-foot">
      {inProject && <NavItem to="/" end icon="folder" label="All projects" />}
      <NavItem to="/traffic" icon="activity" label="Global traffic log" />
      <NavItem to="/https" icon="lock" label="HTTPS setup" />
      <NavItem to="/system" icon="settings" label="System" />
      <a href="/api/agent-guide" target="_blank" rel="noreferrer" className="nav-link" title="Markdown guide for AI agents, with this stubyard's addresses">
        <Icon name="external" />
        <span className="label">Agent guide</span>
      </a>
    </div>
  );
}

// ---------------- command palette ----------------

interface Item {
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: ReactNode;
  run: () => void;
}

function CommandPalette({ onClose, theme, setTheme }: { onClose: () => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const project = useProjectMaybe();
  const { projects } = useProjects();
  const nav = useNavigate();
  const copy = useCopy();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const out: Item[] = [];
    const go = (to: string) => () => nav(to);
    const query = q.trim();
    if (/^[0-9a-z]{19}$/.test(query)) {
      out.push({ group: 'Lookup', label: `Open request ${query}`, icon: <Icon name="activity" />, run: go(`/traffic?log=${query}`) });
    }
    if (project) {
      const { slug, overview } = project;
      const users = [...overview.users].sort((a, b) => (a.pinned || 999) - (b.pinned || 999));
      for (const u of users) {
        out.push({
          group: 'Test users',
          label: u.name,
          hint: u.email ?? u.phone ?? '',
          keywords: `${u.role} ${u.email ?? ''} ${u.phone ?? ''}`,
          icon: <Avatar user={u} size="sm" />,
          run: go(`/p/${slug}/users/${u.id}`),
        });
      }
      for (const u of users) {
        if (!u.latest?.otp) continue;
        const code = u.latest.otp;
        out.push({
          group: 'Copy code',
          label: `Copy latest code of ${u.name}`,
          hint: code,
          keywords: `otp ${u.role} ${u.email ?? ''}`,
          icon: <span className="role-dot" style={roleStyle(u.role)} />,
          run: () => void copy(code, `Copied ${code}`),
        });
      }
      const pages: [string, string, IconName][] = [
        ['Overview', '', 'home'],
        ['Unassigned inbox', '/unassigned', 'inbox'],
        ['Traffic log', '/traffic', 'activity'],
        ['Providers', '/providers', 'plug'],
        ['Providers · Email (SMTP, SendGrid, Mailgun, SES)', '/providers/email', 'mail'],
        ['Providers · SMS & Verify (Twilio, Vonage)', '/providers/sms', 'plug'],
        ['Providers · WhatsApp', '/providers/whatsapp', 'plug'],
        ['Providers · Login (OAuth / OIDC)', '/providers/login', 'key'],
        ['API mocks', '/mocks', 'link'],
        ['LLM mocks (OpenAI, Anthropic)', '/llm', 'code'],
        ['Providers · LLM APIs', '/providers/llm', 'code'],
        ['Webhooks (receive / send)', '/webhooks', 'bell'],
        ['Payments (Stripe, PayTabs, PayPal)', '/payments', 'lock'],
        ['Scheduled (send later, repeat)', '/scheduled', 'activity'],
        ['Storage (S3 files)', '/storage', 'folder'],
        ['MCP tester (tools, resources, prompts, checks)', '/mcp-tester', 'code'],
        ['Chat (AI agents, saved prompts)', '/chat', 'mail'],
        ['Test runs (parallel workers)', '/runs', 'shield'],
        ['Authenticator (2FA codes)', '/authenticator', 'key'],
        ['Connect your app', '/setup', 'code'],
        ['Project settings', '/settings', 'settings'],
      ];
      for (const [label, path, icon] of pages) out.push({ group: overview.project.name, label, icon: <Icon name={icon} />, run: go(`/p/${slug}${path}`) });
      for (const p of overview.providers) {
        out.push({
          group: 'Provider instances',
          label: p.name,
          hint: `${p.channel} · ${p.slug}`,
          keywords: `provider ${p.preset} ${p.labels.join(' ')}${p.isDefault ? ' default' : ''}`,
          icon: <Icon name="plug" />,
          run: go(`/p/${slug}/providers/${p.channel}/${p.slug}`),
        });
      }
    }
    for (const p of projects ?? []) {
      if (p.slug === project?.slug) continue;
      out.push({ group: 'Switch project', label: p.name, hint: p.slug, icon: <Icon name="folder" />, run: go(`/p/${p.slug}`) });
    }
    out.push(
      { group: 'stubyard', label: 'All projects', icon: <Icon name="folder" />, run: go('/') },
      { group: 'stubyard', label: 'Global traffic log', icon: <Icon name="activity" />, run: go('/traffic') },
      { group: 'stubyard', label: 'HTTPS setup (CA certificate)', icon: <Icon name="lock" />, run: go('/https') },
      { group: 'stubyard', label: 'System (storage, retention, factory reset)', icon: <Icon name="settings" />, run: go('/system') },
      {
        group: 'stubyard',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        icon: <Icon name={theme === 'dark' ? 'sun' : 'moon'} />,
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
    );
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return out;
    return out.filter((i) => {
      const hay = `${i.label} ${i.hint ?? ''} ${i.keywords ?? ''} ${i.group}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [q, project, projects, nav, copy, theme, setTheme]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === 'Escape') onClose();
  };

  let lastGroup = '';
  return (
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Type a user, role, email, page or request id…" />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="empty small">No matches</div>}
          {items.map((i, idx) => {
            const head = i.group !== lastGroup ? <div className="palette-group">{(lastGroup = i.group)}</div> : null;
            return (
              <div key={`${i.group}-${i.label}-${idx}`}>
                {head}
                <div className={`palette-item ${idx === active ? 'active' : ''}`} onMouseMove={() => setActive(idx)} onClick={() => run(i)}>
                  {i.icon}
                  <span className="ellipsis">{i.label}</span>
                  {i.hint && <span className="hint ellipsis">{i.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>1</kbd>–<kbd>9</kbd> pinned users
          </span>
          <span>
            <kbd>c</kbd> copy code (on a user)
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Message } from '../api';
import { useProjectMaybe, useProjects, type ProjectState } from '../context';
import { BottomBar, SubNav, TopNav } from './shell/CanvasNav';
import { useHubEvents } from '../hooks';
import { findNavItem, NAV_GROUPS, projectPath, pushRecent, useGlobalNav, useNavGroups, type NavItem } from '../nav';
import { CommandPalette } from './CommandPalette';
import { AppShell } from './layout/AppShell';
import { Icon } from './people';
import { useShellPrefs } from './StatusMenu';
import { Modal, useToast } from './ui';
import { usePinnedUsers, UserSwitcher } from './UserSwitcher';

// Kept here for existing imports.
export { applyTheme, type Theme } from './StatusMenu';

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/** "g then <key>" go-to shortcuts (nav item ids). */
export const GO_KEYS: Record<string, string> = { o: 'overview', u: 'users', t: 'traffic', p: 'providers', y: 'payments', s: 'storyboards', f: 'features', ',': 'settings' };

/**
 * App frame: state, shortcuts and notifications. The visual parts are separate components (AppShell, UserSwitcher,
 * StatusMenu, CommandPalette) so a direction can rearrange them without touching this behaviour.
 */
export function Shell({ children }: { children: ReactNode }) {
  const project = useProjectMaybe();
  const nav = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const prefs = useShellPrefs();
  const toast = useToast();

  useEffect(() => setSidebarOpen(false), [location.pathname, location.search]);
  // Off-canvas sidebar (mobile): Escape closes it.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSidebarOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  // Recent destinations for the palette.
  useEffect(() => {
    if (!project) return;
    const rel = location.pathname.replace(new RegExp(`^/p/${project.slug}/?`), '');
    const hit = findNavItem(rel);
    if (!hit || hit.item.id === 'users') return;
    pushRecent({ path: location.pathname + location.search, label: `${hit.item.label}${location.search.includes('tab=') ? ` (${new URLSearchParams(location.search).get('tab')})` : ''}`, group: project.overview.project.name });
  }, [location.pathname, location.search, project?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinned = usePinnedUsers(project);

  // Global keyboard shortcuts: Ctrl/Cmd+K, "/", 1-9 (pinned users), g-sequences, "?".
  const gPending = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || paletteOpen || document.querySelector('[aria-modal="true"]')) return;
      if (gPending.current && Date.now() - gPending.current < 1200) {
        gPending.current = 0;
        const id = GO_KEYS[e.key];
        const item = id && NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === id);
        if (item && project) {
          e.preventDefault();
          nav(projectPath(project.slug, item.path));
        }
        return;
      }
      if (e.key === 'g') {
        gPending.current = Date.now();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
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
    if (prefs.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`${m.otp} — ${who}`, { body: m.subject ?? `${m.channel} to ${m.to}`, tag: m.id });
    }
  });

  return (
    <AppShell
      className="canvas"
      header={<TopNav prefs={prefs} onSearch={() => setPaletteOpen(true)} menuOpen={sidebarOpen} onMenu={() => setSidebarOpen(!sidebarOpen)} />}
      nav={
        <>
          <SubNav pinned={pinned} />
          {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
          {/* Phones: every page (and the user list) in one sheet behind the Menu button. */}
          <nav
            id="sidebar"
            className={`sidebar nav-sheet ${sidebarOpen ? 'open' : ''}`}
            aria-label="All pages"
            aria-hidden={!sidebarOpen}
            onClick={(e) => (e.target as HTMLElement).closest('a') && setSidebarOpen(false)}
          >
            {project ? <ProjectSidebar project={project} pinned={pinned} /> : <GlobalSidebar />}
            <SidebarFoot inProject={!!project} />
          </nav>
        </>
      }
      overlays={
        <>
          <BottomBar />
          {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} prefs={prefs} onShortcuts={() => setShortcutsOpen(true)} />}
          {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
        </>
      }
    >
      {children}
    </AppShell>
  );
}

// ---------------- sidebars ----------------

function NavEntry({ to, icon, label, end, right }: { to: string; icon: NavItem['icon']; label: string; end?: boolean; right?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className="nav-link">
      <Icon name={icon} />
      <span className="label">{label}</span>
      {right}
    </NavLink>
  );
}

function CountBadge({ item, overview }: { item: NavItem; overview: ProjectState['overview'] }) {
  const c = item.count?.(overview);
  if (!c) return null;
  return c.kind === 'unread' ? (
    <span className="count" title={c.title}>
      {c.n}
    </span>
  ) : (
    <span className="hint" title={c.title}>
      {c.n}
    </span>
  );
}

function GlobalSidebar() {
  const { projects } = useProjects();
  return (
    <>
      <div className="nav-label">Workspace</div>
      <NavEntry to="/" end icon="folder" label="All projects" />
      <div className="nav-label">Projects</div>
      {projects?.map((p) => (
        <NavEntry key={p.id} to={`/p/${p.slug}`} icon="home" label={p.name} right={!!p.stats?.unread && <span className="count">{p.stats.unread}</span>} />
      ))}
      {projects?.length === 0 && <span className="faint small nav-empty">No projects yet</span>}
    </>
  );
}

/** 0.14 look: project home, pinned users, user list, then the sections grouped as in nav.ts. */
function ProjectSidebar({ project, pinned }: { project: ProjectState; pinned: ProjectState['overview']['users'] }) {
  const { slug, overview } = project;
  const location = useLocation();
  const rel = location.pathname.replace(new RegExp(`^/p/${slug}/?`), '');
  const activeId = findNavItem(rel)?.item.id;
  const inbox = NAV_GROUPS.find((g) => g.id === 'inbox')!;
  const item = (id: string) => inbox.items.find((i) => i.id === id)!;
  const unassigned = item('unassigned');
  const groups = useNavGroups();
  return (
    <>
      <NavEntry to={`/p/${slug}`} end icon="home" label={overview.project.name} />
      <UserSwitcher project={project} pinned={pinned} />
      <NavLink to={projectPath(slug, unassigned.path)} className="nav-link">
        <Icon name={unassigned.icon} />
        <span className="label">{unassigned.label}</span>
        <CountBadge item={unassigned} overview={overview} />
      </NavLink>
      {groups.map((g) => {
        const items = g.items.filter((i) => !['overview', 'users', 'unassigned'].includes(i.id));
        if (!items.length) return null;
        return (
          <div key={g.id} className="nav-group" role="group" aria-label={g.label}>
            <div className="nav-label">{g.label}</div>
            {items.map((i) => (
              <NavLink key={i.id} to={projectPath(slug, i.path)} className={() => `nav-link ${activeId === i.id ? 'active' : ''}`} aria-current={activeId === i.id ? 'page' : undefined}>
                <Icon name={i.icon} />
                <span className="label">{i.label}</span>
                <CountBadge item={i} overview={overview} />
              </NavLink>
            ))}
          </div>
        );
      })}
    </>
  );
}

function SidebarFoot({ inProject }: { inProject: boolean }) {
  const GLOBAL_NAV = useGlobalNav();
  return (
    <div className="sidebar-foot">
      {GLOBAL_NAV.filter((g) => inProject || g.id !== 'projects').map((g) =>
        g.external ? (
          <a key={g.id} href={g.path} target="_blank" rel="noreferrer" className="nav-link" title={g.title}>
            <Icon name={g.icon} />
            <span className="label">{g.label}</span>
          </a>
        ) : (
          <NavEntry key={g.id} to={g.path} end={g.path === '/'} icon={g.icon} label={g.label} />
        ),
      )}
    </div>
  );
}

// ---------------- shortcuts ----------------

const SHORTCUTS: [string, string][] = [
  ['Ctrl / ⌘ K, /', 'Search or jump (command palette)'],
  ['1 – 9', 'Open a pinned user'],
  ['g o', 'Overview'],
  ['g u', 'Users'],
  ['g t', 'Traffic log'],
  ['g p', 'Providers'],
  ['g y', 'Payments'],
  ['g s', 'Storyboards'],
  ['g f', 'Features'],
  ['g ,', 'Settings'],
  ['c', 'Copy the latest code (in a user workspace)'],
  ['?', 'This list'],
  ['Esc', 'Close the palette, menus, drawers and dialogs'],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <dl className="kv bare wide shortcuts-list">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="kv-row">
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

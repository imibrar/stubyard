import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Message } from '../api';
import { useProjectMaybe } from '../context';
import { useHubEvents } from '../hooks';
import { findNavItem, NAV_GROUPS, projectPath, pushRecent } from '../nav';
import { CommandPalette } from './CommandPalette';
import { AppShell } from './layout/AppShell';
import { useMediaQuery } from './layout/hooks';
import { Icon, useLocalState } from './people';
import { Rail } from './shell/Rail';
import { SectionPanel } from './shell/SectionPanel';
import { ShellSlotsContext } from './shell/slots';
import { StatusMenu, useShellPrefs } from './StatusMenu';
import { Modal, useToast } from './ui';
import { unreadOf, usePinnedUsers } from './UserSwitcher';

// Kept here for existing imports.
export { applyTheme, type Theme } from './StatusMenu';

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/** "g then <key>" go-to shortcuts (nav item ids). */
export const GO_KEYS: Record<string, string> = { o: 'overview', u: 'users', t: 'traffic', p: 'providers', y: 'payments', s: 'storyboards', ',': 'settings' };

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
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

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
          nav(projectPath(project.slug, item.id === 'users' ? '' : item.path));
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

  // Console shell state: panel collapsed (Ctrl+B, remembered), the group shown in the panel, overlay panel (narrow screens).
  const [collapsed, setCollapsed] = useLocalState<boolean>('stubyard.panelCollapsed', false);
  const [viewGroup, setViewGroup] = useState<string | null>(null);
  const wide = useMediaQuery('(width >= 1024px)');
  useEffect(() => setViewGroup(null), [location.pathname]);
  const rel = project ? location.pathname.replace(new RegExp(`^/p/${project.slug}/?`), '') : '';
  const hit = project ? findNavItem(rel) : null;
  const activeId = hit?.item.id ?? (project && rel.startsWith('users') ? 'users' : undefined);
  const activeGroup = project ? (hit?.group.id ?? 'inbox') : null;
  const shownGroup = viewGroup ?? activeGroup;
  const docked = wide && !collapsed;
  const onGroup = (id: string) => {
    setViewGroup(id);
    if (!docked) setSidebarOpen(!(sidebarOpen && shownGroup === id));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !isTyping(e)) {
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, setCollapsed]);

  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ title: titleSlot, actions: actionsSlot }), [titleSlot, actionsSlot]);
  const inboxUnread = project ? project.overview.users.reduce((a, u) => a + unreadOf(u), 0) : 0;

  return (
    <ShellSlotsContext.Provider value={slots}>
      <AppShell
        className={`console ${project ? 'in-project' : 'global'} ${project && docked ? 'docked' : ''}`}
        header={
          <header className="topbar">
            <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Menu" aria-expanded={sidebarOpen} aria-controls="sidebar" hidden={!project}>
              <Icon name="menu" />
            </button>
            <NavLink to="/" end className="topbar-brand" aria-label="stubyard, all projects" hidden={!!project}>
              <img src="/favicon.svg" alt="" width={20} height={20} />
            </NavLink>
            <div className="topbar-title" ref={setTitleSlot} />
            <button className="search-btn" onClick={() => setPaletteOpen(true)} aria-label="Search or jump" title="Search or jump (Ctrl K)">
              <Icon name="search" size={14} />
              <span className="grow">Search or jump…</span>
              <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
            </button>
            <div className="topbar-actions" ref={setActionsSlot} />
            <StatusMenu prefs={prefs} className="topbar-status" />
          </header>
        }
        nav={
          <>
            <Rail
              groups={project ? NAV_GROUPS : null}
              activeGroup={activeGroup}
              shownGroup={docked || sidebarOpen ? shownGroup : null}
              onGroup={onGroup}
              inboxUnread={inboxUnread}
              prefs={prefs}
              onSearch={() => setPaletteOpen(true)}
              onShortcuts={() => setShortcutsOpen(true)}
              panelCollapsed={collapsed}
              onTogglePanel={() => setCollapsed(!collapsed)}
              inProject={!!project}
            />
            {project && sidebarOpen && !docked && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
            {project && shownGroup && <SectionPanel project={project} group={shownGroup} activeId={activeId} pinned={pinned} open={sidebarOpen && !docked} onClose={() => setSidebarOpen(false)} />}
          </>
        }
        overlays={
          <>
            {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} prefs={prefs} onShortcuts={() => setShortcutsOpen(true)} />}
            {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
          </>
        }
      >
        {children}
      </AppShell>
    </ShellSlotsContext.Provider>
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
  ['g ,', 'Settings'],
  ['Ctrl / ⌘ B', 'Show or hide the section panel'],
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

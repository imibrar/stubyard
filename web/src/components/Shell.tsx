import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Message } from '../api';
import { useProjectMaybe } from '../context';
import { useHubEvents } from '../hooks';
import { findNavItem, NAV_GROUPS, projectPath, pushRecent } from '../nav';
import { CommandPalette } from './CommandPalette';
import { AppShell } from './layout/AppShell';
import { useLocalState } from './people';
import { GlobalHeader } from './shell/GlobalHeader';
import { NavColumn } from './shell/NavColumn';
import { PaneProvider, usePaneState } from './shell/panes';
import { useShellPrefs } from './StatusMenu';
import { Modal, useToast } from './ui';
import { usePinnedUsers } from './UserSwitcher';

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
  const [collapsed, setCollapsed] = useLocalState<boolean>('stubyard.navCollapsed', false);
  const panes = usePaneState();
  const { setListOpen, setContextOpen, contextOpen } = panes.value;

  useEffect(() => {
    setSidebarOpen(false);
    setListOpen(false);
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSidebarOpen(false), [location.search]);
  // Overlays (nav drawer, list sheet, narrow context panel): Escape closes them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      setListOpen(false);
      if (!panes.wide) setContextOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps
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
      if (e.key === ']' && panes.value.context) {
        e.preventDefault();
        setContextOpen(!contextOpen);
      } else if (e.key === '/') {
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
  }, [project, pinned, nav, paletteOpen, contextOpen, panes.value.context]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const { list, listOpen, context } = panes.value;
  return (
    <PaneProvider value={panes.value}>
      <AppShell
        className={`relay ${collapsed ? 'nav-collapsed' : ''} ${list ? `has-list list-${list.narrow} list-size-${list.size ?? 'list'}` : ''} ${listOpen ? 'list-open' : ''} ${context ? 'has-context' : ''} ${context && contextOpen ? 'context-open' : ''}`}
        header={<GlobalHeader prefs={prefs} onSearch={() => setPaletteOpen(true)} menuOpen={sidebarOpen} onMenu={() => setSidebarOpen(!sidebarOpen)} />}
        nav={
          <>
            {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
            <div className="nav-click" onClick={(e) => (e.target as HTMLElement).closest('a') && setSidebarOpen(false)}>
              <NavColumn prefs={prefs} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} open={sidebarOpen} />
            </div>
          </>
        }
        list={
          <>
            {listOpen && <div className="pane-backdrop list-backdrop" onClick={() => setListOpen(false)} aria-hidden="true" />}
            <aside id="list-pane" className="list-pane" ref={panes.listRef} aria-label={list?.title ?? 'List'} onClick={(e) => (e.target as HTMLElement).closest('a') && setListOpen(false)} />
          </>
        }
        context={
          <>
            {context && contextOpen && !panes.wide && <div className="pane-backdrop ctx-backdrop" onClick={() => setContextOpen(false)} aria-hidden="true" />}
            <aside id="context-pane" className="context-pane" ref={panes.contextRef} aria-label={context ?? 'Details'} />
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
    </PaneProvider>
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
  ['c', 'Copy the latest code (in a user workspace)'],
  ['j / k', 'Next / previous message'],
  ['↑ / ↓', 'Move through the list pane'],
  [']', 'Show or hide the details panel'],
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

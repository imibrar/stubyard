import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { GLOBAL_NAV, type NavGroup } from '../../nav';
import { Icon, Menu } from '../people';
import { densityLabel, StatusMenu, type ShellPrefs } from '../StatusMenu';

/** Icon of each nav group on the rail (unique, distinct from the item icons where possible). */
export const GROUP_ICON: Record<string, Parameters<typeof Icon>[0]['name']> = {
  inbox: 'inbox',
  simulate: 'plug',
  automate: 'play',
  tools: 'terminal',
  project: 'settings',
};

/**
 * Far-left icon rail (48 px): brand, one button per nav group (or the global pages outside a project), then search,
 * status and the workspace menu. Below 768 px it becomes the bottom tab bar.
 */
export function Rail({
  groups,
  activeGroup,
  shownGroup,
  onGroup,
  inboxUnread,
  prefs,
  onSearch,
  onShortcuts,
  panelCollapsed,
  onTogglePanel,
  inProject,
}: {
  groups: NavGroup[] | null;
  activeGroup: string | null;
  shownGroup: string | null;
  onGroup: (id: string) => void;
  inboxUnread: number;
  prefs: ShellPrefs;
  onSearch: () => void;
  onShortcuts: () => void;
  panelCollapsed: boolean;
  onTogglePanel: () => void;
  inProject: boolean;
}) {
  return (
    <nav className="rail" aria-label="Sections">
      <NavLink to="/" end className="rail-brand" title="stubyard · all projects" aria-label="stubyard, all projects">
        <img src="/favicon.svg" alt="" width={22} height={22} />
      </NavLink>
      <div className="rail-groups">
        {groups
          ? groups.map((g) => (
              <RailButton
                key={g.id}
                label={g.label}
                icon={GROUP_ICON[g.id] ?? 'folder'}
                active={activeGroup === g.id}
                shown={shownGroup === g.id}
                dot={g.id === 'inbox' && inboxUnread > 0 ? inboxUnread : 0}
                onClick={() => onGroup(g.id)}
              />
            ))
          : GLOBAL_NAV.filter((g) => !g.external).map((g) => (
              <NavLink key={g.id} to={g.path} end={g.path === '/'} className="rail-btn" title={g.label} aria-label={g.label}>
                <Icon name={g.icon} size={18} />
                <span className="rail-label">{g.label.replace('Global traffic log', 'Traffic').replace('HTTPS setup', 'HTTPS').replace('All projects', 'Projects')}</span>
              </NavLink>
            ))}
      </div>
      <div className="rail-foot">
        <button type="button" className="rail-btn rail-search" onClick={onSearch} title="Search or jump (Ctrl K)" aria-label="Search or jump">
          <Icon name="search" size={18} />
          <span className="rail-label">Search</span>
        </button>
        <StatusMenu prefs={prefs} showPrefs={false} className="rail-status" />
        <WorkspaceMenu prefs={prefs} onShortcuts={onShortcuts} panelCollapsed={panelCollapsed} onTogglePanel={onTogglePanel} inProject={inProject} />
      </div>
    </nav>
  );
}

function RailButton({ label, icon, active, shown, dot, onClick }: { label: string; icon: Parameters<typeof Icon>[0]['name']; active: boolean; shown: boolean; dot: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rail-btn ${active ? 'active' : ''} ${shown ? 'shown' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={dot ? `${label}, ${dot} unread` : label}
      aria-current={active ? 'true' : undefined}
      aria-controls="sidebar"
    >
      <Icon name={icon} size={18} />
      <span className="rail-label">{label}</span>
      {dot > 0 && <span className="rail-dot" aria-hidden />}
    </button>
  );
}

/** Workspace menu: global pages, theme, density, notifications, panel and shortcuts. */
export function WorkspaceMenu({ prefs, onShortcuts, panelCollapsed, onTogglePanel, inProject }: { prefs: ShellPrefs; onShortcuts: () => void; panelCollapsed: boolean; onTogglePanel: () => void; inProject: boolean }) {
  const item = (to: string, icon: Parameters<typeof Icon>[0]['name'], label: ReactNode, close: () => void, end = false) => (
    <NavLink key={to} to={to} end={end} role="menuitem" className="menu-link" onClick={close}>
      <Icon name={icon} size={14} /> {label}
    </NavLink>
  );
  return (
    <Menu label={<><Icon name="more" size={18} /><span className="rail-label">More</span></>} title="Workspace menu" className="rail-btn rail-more" floating align="start" menuClassName="workspace-menu">
      {(close) => (
        <>
          <div className="menu-head">Workspace</div>
          {GLOBAL_NAV.map((g) =>
            g.external ? (
              <a key={g.id} href={g.path} target="_blank" rel="noreferrer" role="menuitem" className="menu-link" title={g.title} onClick={close}>
                <Icon name={g.icon} size={14} /> {g.label}
              </a>
            ) : (
              item(g.path, g.icon, g.label, close, g.path === '/')
            ),
          )}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={prefs.toggleTheme}>
            <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} size={14} /> {prefs.theme === 'dark' ? 'Light' : 'Dark'} theme
          </button>
          <button type="button" role="menuitem" onClick={prefs.cycleDensity}>
            <Icon name="sliders" size={14} /> Density <span className="sub">{densityLabel(prefs.density)}</span>
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.notify} onClick={() => void prefs.toggleNotify()}>
            <Icon name="bell" size={14} /> Desktop notifications <span className="sub">{prefs.notify ? 'on' : 'off'}</span>
          </button>
          {inProject && (
            <button type="button" role="menuitem" className="hide-narrow" onClick={() => (onTogglePanel(), close())}>
              <Icon name="panel" size={14} /> {panelCollapsed ? 'Show' : 'Hide'} section panel <span className="sub">Ctrl B</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => (onShortcuts(), close())}>
            <Icon name="keyboard" size={14} /> Keyboard shortcuts <span className="sub">?</span>
          </button>
        </>
      )}
    </Menu>
  );
}

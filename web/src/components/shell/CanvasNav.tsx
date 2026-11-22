import { useLocation, NavLink, Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useProjectMaybe, useProjects, type ProjectState } from '../../context';
import { findNavItem, GLOBAL_NAV, NAV_GROUPS, projectPath, type NavGroup, type NavItem } from '../../nav';
import { Avatar, Icon, Menu, type IconName } from '../people';
import { StatusMenu, densityLabel, type ShellPrefs } from '../StatusMenu';
import { unreadOf, UserSwitcher } from '../UserSwitcher';
import type { TestUser } from '../../api';

/** Icons of the five nav groups (top tabs and the phone bottom bar). */
const GROUP_ICON: Record<NavGroup['id'], IconName> = { inbox: 'inbox', simulate: 'plug', automate: 'play', tools: 'terminal', project: 'settings' };

/** Where the shell is: the project-relative path, the active nav item and its group. */
export function useNavPosition() {
  const project = useProjectMaybe();
  const location = useLocation();
  if (!project) return { project, rel: '', group: null as NavGroup | null, item: null as NavItem | null };
  const rel = location.pathname.replace(new RegExp(`^/p/${project.slug}/?`), '');
  const hit = findNavItem(rel);
  return { project, rel, group: hit?.group ?? NAV_GROUPS[0], item: hit?.item ?? null };
}

const groupHref = (slug: string, g: NavGroup) => projectPath(slug, g.items[0].path);

function CountPill({ item, overview }: { item: NavItem; overview: ProjectState['overview'] }) {
  const c = item.count?.(overview);
  if (!c || !c.n) return null;
  return (
    <span className={c.kind === 'unread' ? 'count' : 'subnav-hint'} title={c.title}>
      {c.n}
    </span>
  );
}

/** Top bar (56 px): brand, project pill, group tabs, search, status, notifications, theme, workspace menu. */
export function TopNav({ prefs, onSearch, onMenu, menuOpen }: { prefs: ShellPrefs; onSearch: () => void; onMenu: () => void; menuOpen: boolean }) {
  const { group, project } = useNavPosition();
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  return (
    <header className="topbar canvas-top">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu" aria-expanded={menuOpen} aria-controls="sidebar" title="All pages">
        <Icon name="menu" />
      </button>
      <NavLink to="/" className="brand" end aria-label="stubyard: all projects">
        <img src="/favicon.svg" alt="" />
        <span className="brand-name">stubyard</span>
      </NavLink>
      <ProjectPill />
      {project ? (
        <nav className="group-tabs" aria-label="Sections">
          {NAV_GROUPS.map((g) => (
            <Link key={g.id} to={groupHref(project.slug, g)} className={`group-tab ${group?.id === g.id ? 'active' : ''}`} aria-current={group?.id === g.id ? 'true' : undefined}>
              {g.label}
            </Link>
          ))}
        </nav>
      ) : (
        <span className="grow" />
      )}
      <button className="search-btn" onClick={onSearch} aria-label="Search" title={`Search (${mac ? '⌘' : 'Ctrl'} K)`}>
        <Icon name="search" size={15} />
        <span className="search-label">Search</span>
        <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <StatusMenu prefs={prefs} showPrefs={false} className="canvas-status" />
      <button className={`icon-btn topbar-pref ${prefs.notify ? 'on' : ''}`} onClick={() => void prefs.toggleNotify()} title={prefs.notify ? 'Desktop notifications: on' : 'Desktop notifications: off'} aria-label="Desktop notifications" aria-pressed={prefs.notify}>
        <Icon name="bell" />
      </button>
      <button className="icon-btn topbar-pref" onClick={prefs.toggleTheme} title={`Switch to ${prefs.theme === 'dark' ? 'light' : 'dark'} theme`} aria-label="Switch theme">
        <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <WorkspaceMenu prefs={prefs} />
    </header>
  );
}

/** Project switcher as a pill button with the project name. */
function ProjectPill() {
  const { projects } = useProjects();
  const project = useProjectMaybe();
  const nav = useNavigate();
  if (!projects || projects.length === 0) return null;
  const name = project?.overview.project.name;
  return (
    <Menu
      className="project-pill"
      align="start"
      floating
      menuClassName="project-pop"
      title={name ? `Project: ${name} (switch project)` : 'Select a project'}
      label={
        <>
          <span className="project-pill-dot" aria-hidden />
          <span className="project-pill-name">{name ?? 'Select project'}</span>
          <Icon name="chevronDown" size={14} />
        </>
      }
    >
      {(close) => (
        <>
          <div className="menu-label">Projects</div>
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitem" className={p.slug === project?.slug ? 'active' : ''} onClick={() => (close(), nav(`/p/${p.slug}`))}>
              <Icon name="folder" size={14} />
              <span className="grow ellipsis">{p.name}</span>
              {!!p.stats?.unread && <span className="count">{p.stats.unread}</span>}
              {p.slug === project?.slug && <Icon name="check" size={14} />}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => (close(), nav('/'))}>
            <Icon name="home" size={14} /> All projects
          </button>
        </>
      )}
    </Menu>
  );
}

/** Global pages and preferences. */
function WorkspaceMenu({ prefs }: { prefs: ShellPrefs }) {
  const nav = useNavigate();
  return (
    <Menu className="icon-btn workspace-menu" floating menuClassName="workspace-pop" title="Workspace menu" label={<Icon name="more" />}>
      {(close) => (
        <>
          <div className="menu-label">Workspace</div>
          {GLOBAL_NAV.map((g) =>
            g.external ? (
              <a key={g.id} href={g.path} target="_blank" rel="noreferrer" role="menuitem" className="menu-link" title={g.title} onClick={close}>
                <Icon name={g.icon} size={14} /> {g.label}
              </a>
            ) : (
              <button key={g.id} type="button" role="menuitem" onClick={() => (close(), nav(g.path))}>
                <Icon name={g.icon} size={14} /> {g.label}
              </button>
            ),
          )}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.notify} onClick={() => void prefs.toggleNotify()}>
            <Icon name="bell" size={14} /> Desktop notifications <span className="sub">{prefs.notify ? 'on' : 'off'}</span>
          </button>
          <button type="button" role="menuitem" onClick={prefs.toggleTheme}>
            <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} size={14} /> {prefs.theme === 'dark' ? 'Light' : 'Dark'} theme
          </button>
          <button type="button" role="menuitem" onClick={prefs.cycleDensity}>
            <Icon name="sliders" size={14} /> Density <span className="sub">{densityLabel(prefs.density)}</span>
          </button>
        </>
      )}
    </Menu>
  );
}

/** Sub-navigation (44 px): the active group's items as pills; Inbox adds the Users dropdown and pinned avatars. */
export function SubNav({ pinned }: { pinned: TestUser[] }) {
  const { project, group, item } = useNavPosition();
  if (!project || !group) return <GlobalSubNav />;
  const { slug, overview } = project;
  return (
    <div className="subnav">
      <div className="subnav-inner">
        <nav className="subnav-pills" aria-label={`${group.label} pages`}>
          {group.items.map((i) => (
            <NavLink key={i.id} to={projectPath(slug, i.path)} end={i.end} className={() => `subnav-pill ${item?.id === i.id ? 'active' : ''}`} aria-current={item?.id === i.id ? 'page' : undefined}>
              <Icon name={i.icon} size={15} />
              <span className="label">{i.label}</span>
              <CountPill item={i} overview={overview} />
            </NavLink>
          ))}
        </nav>
        {group.id === 'inbox' && (
          <div className="subnav-users">
            <UsersDropdown project={project} pinned={pinned} />
            {pinned.length > 0 && (
              <div className="pinned-avatars" role="list" aria-label="Pinned users">
                {pinned.slice(0, 6).map((u, i) => (
                  <NavLink key={u.id} role="listitem" to={`/p/${slug}/users/${u.id}`} className="pinned-avatar" title={`${u.name} · ${u.role}${unreadOf(u) ? ` · ${unreadOf(u)} unread` : ''} (press ${i + 1})`} aria-label={`${u.name}${unreadOf(u) ? `, ${unreadOf(u)} unread` : ''}`}>
                    <Avatar user={u} size="sm" />
                    {unreadOf(u) > 0 && <span className="pinned-dot" aria-hidden />}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UsersDropdown({ project, pinned }: { project: ProjectState; pinned: TestUser[] }) {
  const total = project.overview.users.length;
  const unread = project.overview.users.reduce((n, u) => n + unreadOf(u), 0);
  return (
    <Menu
      className="users-drop"
      floating
      menuClassName="users-pop"
      title="Switch user"
      label={
        <>
          <Icon name="users" size={15} />
          <span className="label">Switch user</span>
          {unread > 0 ? <span className="count">{unread}</span> : <span className="subnav-hint">{total}</span>}
          <Icon name="chevronDown" size={13} />
        </>
      }
    >
      {(close) => (
        <div className="users-pop-body" onClick={(e) => (e.target as HTMLElement).closest('a') && close()}>
          <UserSwitcher project={project} pinned={pinned} filterAt={0} />
        </div>
      )}
    </Menu>
  );
}

function GlobalSubNav() {
  return (
    <div className="subnav">
      <div className="subnav-inner">
        <nav className="subnav-pills" aria-label="Workspace pages">
          {GLOBAL_NAV.map((g) =>
            g.external ? (
              <a key={g.id} href={g.path} target="_blank" rel="noreferrer" className="subnav-pill" title={g.title}>
                <Icon name={g.icon} size={15} />
                <span className="label">{g.label}</span>
              </a>
            ) : (
              <NavLink key={g.id} to={g.path} end={g.path === '/'} className={({ isActive }) => `subnav-pill ${isActive ? 'active' : ''}`}>
                <Icon name={g.icon} size={15} />
                <span className="label">{g.label}</span>
              </NavLink>
            ),
          )}
        </nav>
      </div>
    </div>
  );
}

/** Phones (< 768 px): the five groups as a bottom tab bar. */
export function BottomBar() {
  const { project, group } = useNavPosition();
  const location = useLocation();
  let items: { id: string; label: string; to: string; icon: IconName; active: boolean; badge?: ReactNode }[];
  if (project) {
    const unread = project.overview.users.reduce((n, u) => n + unreadOf(u), 0);
    items = NAV_GROUPS.map((g) => ({ id: g.id, label: g.label, to: groupHref(project.slug, g), icon: GROUP_ICON[g.id], active: group?.id === g.id, badge: g.id === 'inbox' && unread > 0 ? <span className="count">{unread}</span> : null }));
  } else {
    items = GLOBAL_NAV.filter((g) => !g.external).map((g) => ({ id: g.id, label: g.id === 'global-traffic' ? 'Traffic' : g.id === 'projects' ? 'Projects' : g.label.replace(' setup', ''), to: g.path, icon: g.icon, active: g.path === '/' ? location.pathname === '/' : location.pathname.startsWith(g.path) }));
  }
  return (
    <nav className="bottom-bar" aria-label="Sections">
      {items.map((i) => (
        <Link key={i.id} to={i.to} className={`bottom-item ${i.active ? 'active' : ''}`} aria-current={i.active ? 'true' : undefined}>
          <span className="bottom-icon">
            <Icon name={i.icon} size={20} />
            {i.badge}
          </span>
          <span className="bottom-label">{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}

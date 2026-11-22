import { NavLink, useNavigate } from 'react-router-dom';
import type { TestUser } from '../../api';
import { useProjects, type ProjectState } from '../../context';
import { NAV_GROUPS, projectPath, type NavItem } from '../../nav';
import { Icon, Menu } from '../people';
import { UserSwitcher } from '../UserSwitcher';

function CountBadge({ item, overview }: { item: NavItem; overview: ProjectState['overview'] }) {
  const c = item.count?.(overview);
  if (!c) return null;
  return c.kind === 'unread' ? (
    <span className="count" title={c.title} aria-label={`${c.n} unread`}>
      {c.n}
    </span>
  ) : (
    <span className="hint" title={c.title}>
      {c.n}
    </span>
  );
}

/** Project switcher: a button with the project name that opens a list of projects. */
export function ProjectSwitcher({ project }: { project: ProjectState }) {
  const { projects } = useProjects();
  const nav = useNavigate();
  const name = project.overview.project.name;
  return (
    <Menu
      label={
        <>
          <span className="ps-mark" aria-hidden>
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="ps-name">{name}</span>
          <Icon name="chevronDown" size={14} />
        </>
      }
      title={`Project: ${name}. Switch project`}
      className="project-switch"
      floating
      align="start"
      menuClassName="project-menu"
    >
      {(close) => (
        <>
          <div className="menu-head">Projects</div>
          {projects?.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={p.slug === project.slug ? 'active' : ''}
              onClick={() => {
                close();
                nav(`/p/${p.slug}`);
              }}
            >
              <span className="ps-mark sm" aria-hidden>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="grow ellipsis">{p.name}</span>
              {!!p.stats?.unread && <span className="count">{p.stats.unread}</span>}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <NavLink to="/" end role="menuitem" className="menu-link" onClick={close}>
            <Icon name="folder" size={14} /> All projects
          </NavLink>
        </>
      )}
    </Menu>
  );
}

/**
 * Section panel (216 px): project switcher, then the items of one nav group. The Inbox group also holds the
 * pinned users and the user list, so the panel is never longer than the viewport for the other groups.
 */
export function SectionPanel({ project, group, activeId, pinned, open, onClose }: { project: ProjectState; group: string; activeId: string | undefined; pinned: TestUser[]; open: boolean; onClose: () => void }) {
  const { slug, overview } = project;
  const g = NAV_GROUPS.find((x) => x.id === group) ?? NAV_GROUPS[0];
  return (
    <nav
      id="sidebar"
      className={`sidebar section-panel ${open ? 'open' : ''}`}
      aria-label={`${g.label} navigation`}
      // Tapping any link closes the overlay panel, even when it points at the current page.
      onClick={(e) => (e.target as HTMLElement).closest('a') && onClose()}
    >
      <div className="panel-top">
        <ProjectSwitcher project={project} />
        <button type="button" className="icon-btn panel-close" onClick={onClose} aria-label="Close navigation">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-scroll">
        <div className="nav-label">{g.label}</div>
        <div className="nav-group" role="group" aria-label={g.label}>
          {g.items.map((i) => (
            <NavLink
              key={i.id}
              to={projectPath(slug, i.path)}
              end={i.end}
              className={() => `nav-link ${activeId === i.id ? 'active' : ''}`}
              aria-current={activeId === i.id ? 'page' : undefined}
            >
              <Icon name={i.icon} />
              <span className="label">{i.label}</span>
              <CountBadge item={i} overview={overview} />
            </NavLink>
          ))}
        </div>
        {g.id === 'inbox' && <UserSwitcher project={project} pinned={pinned} />}
      </div>
    </nav>
  );
}

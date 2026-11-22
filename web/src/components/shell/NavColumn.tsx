import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useProjectMaybe, useProjects, type ProjectState } from '../../context';
import { findNavItem, GLOBAL_NAV, NAV_GROUPS, NEW_ACTIONS, projectPath, type NavGroup, type NavItem } from '../../nav';
import { Icon, Menu, useLocalState } from '../people';
import { StatusMenu, type ShellPrefs } from '../StatusMenu';

/** Counts next to nav items: unread as an accent pill, everything else as a plain number. */
function CountBadge({ item, overview }: { item: NavItem; overview: ProjectState['overview'] }) {
  const c = item.count?.(overview);
  if (!c) return null;
  return c.kind === 'unread' ? (
    <span className="count" title={c.title ?? 'Unread'}>
      {c.n}
    </span>
  ) : (
    <span className="hint" title={c.title}>
      {c.n}
    </span>
  );
}

/**
 * Relay navigation column: project switcher, New split button, the five groups as collapsible sections (Inbox open
 * by default, the others remember their state), then the workspace menu and status dot. Collapses to 56 px icons.
 */
export function NavColumn({ prefs, collapsed, onCollapse, open }: { prefs: ShellPrefs; collapsed: boolean; onCollapse: () => void; open: boolean }) {
  const project = useProjectMaybe();
  return (
    <nav id="sidebar" className={`sidebar nav-col ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`} aria-label="Navigation">
      <div className="nav-top">
        <ProjectSwitch />
        <button type="button" className="icon-btn nav-collapse" onClick={onCollapse} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-pressed={collapsed}>
          <Icon name="panel" size={15} />
        </button>
      </div>
      {project && <NewButton slug={project.slug} />}
      <div className="nav-scrollarea">{project ? <ProjectGroups project={project} /> : <GlobalItems />}</div>
      <div className="nav-bottom">
        <WorkspaceMenu inProject={!!project} />
        <StatusMenu prefs={prefs} className="nav-status" />
      </div>
    </nav>
  );
}

function ProjectSwitch() {
  const { projects } = useProjects();
  const project = useProjectMaybe();
  const nav = useNavigate();
  return (
    <div className="project-switch-wrap">
      <NavLink to="/" className="brand" end title="All projects">
        <img src="/favicon.svg" alt="stubyard" />
      </NavLink>
      {projects && projects.length > 0 ? (
        <select className="project-switch" value={project?.slug ?? ''} onChange={(e) => nav(e.target.value ? `/p/${e.target.value}` : '/')} aria-label="Project">
          {!project && <option value="">All projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="brand-name">stubyard</span>
      )}
    </div>
  );
}

function NewButton({ slug }: { slug: string }) {
  const nav = useNavigate();
  const [first, ...rest] = NEW_ACTIONS;
  const go = (path: string) => nav(projectPath(slug, '') + (path.startsWith('?') ? path : `/${path}`));
  return (
    <div className="new-split" role="group" aria-label="Create">
      <button type="button" className="btn primary new-main" onClick={() => go(first.path)} title={first.label}>
        <Icon name="plus" size={14} />
        <span className="nav-text">{first.label}</span>
      </button>
      <Menu label={<Icon name="chevronDown" size={14} />} title="More things to create" className="btn primary new-more" floating align="start">
        {(close) => (
          <>
            {rest.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => {
                  close();
                  go(a.path);
                }}
              >
                <Icon name="plus" size={14} /> {a.label}
              </button>
            ))}
          </>
        )}
      </Menu>
    </div>
  );
}

function GroupSection({ group, children, defaultOpen, active }: { group: Pick<NavGroup, 'id' | 'label'>; children: ReactNode; defaultOpen: boolean; active: boolean }) {
  const [saved, setSaved] = useLocalState<boolean | null>(`stubyard.nav.${group.id}`, null);
  const open = saved ?? defaultOpen;
  const id = `nav-group-${group.id}`;
  return (
    <div className={`nav-group ${open || active ? 'open' : ''}`} role="group" aria-labelledby={`${id}-h`}>
      <button type="button" id={`${id}-h`} className="nav-label nav-group-toggle" aria-expanded={open || active} aria-controls={id} onClick={() => setSaved(!open)}>
        <span>{group.label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <div id={id} className="nav-group-items">
        {children}
      </div>
    </div>
  );
}

function ProjectGroups({ project }: { project: ProjectState }) {
  const { slug, overview } = project;
  const location = useLocation();
  const rel = location.pathname.replace(new RegExp(`^/p/${slug}/?`), '');
  const activeId = findNavItem(rel)?.item.id;
  return (
    <>
      {NAV_GROUPS.map((g) => (
        <GroupSection key={g.id} group={g} defaultOpen={g.id === 'inbox' || g.id === 'simulate'} active={g.items.some((i) => i.id === activeId)}>
          {g.items.map((i) => (
            <NavLink key={i.id} to={projectPath(slug, i.path)} className={() => `nav-link ${activeId === i.id ? 'active' : ''}`} aria-current={activeId === i.id ? 'page' : undefined} title={i.label}>
              <Icon name={i.icon} />
              <span className="label">{i.label}</span>
              <CountBadge item={i} overview={overview} />
            </NavLink>
          ))}
        </GroupSection>
      ))}
    </>
  );
}

function GlobalItems() {
  return (
    <div className="nav-group open">
      <div className="nav-label">Workspace</div>
      {GLOBAL_NAV.map((g) =>
        g.external ? (
          <a key={g.id} href={g.path} target="_blank" rel="noreferrer" className="nav-link" title={g.title ?? g.label}>
            <Icon name={g.icon} />
            <span className="label">{g.label}</span>
          </a>
        ) : (
          <NavLink key={g.id} to={g.path} end={g.path === '/'} className="nav-link" title={g.label}>
            <Icon name={g.icon} />
            <span className="label">{g.label}</span>
          </NavLink>
        ),
      )}
    </div>
  );
}

/** All projects, global traffic, System, HTTPS and the agent guide, in one menu at the bottom of the column. */
function WorkspaceMenu({ inProject }: { inProject: boolean }) {
  const nav = useNavigate();
  if (!inProject) return <span className="grow" />;
  return (
    <Menu
      label={
        <>
          <Icon name="globe" size={15} />
          <span className="nav-text">Workspace</span>
        </>
      }
      title="Workspace: all projects, global traffic, System, HTTPS"
      className="btn ghost workspace-btn"
      floating
      align="start"
    >
      {(close) => (
        <>
          {GLOBAL_NAV.map((g) =>
            g.external ? (
              <a key={g.id} className="menu-link" href={g.path} target="_blank" rel="noreferrer" onClick={close} title={g.title}>
                <Icon name={g.icon} size={14} /> {g.label}
              </a>
            ) : (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  close();
                  nav(g.path);
                }}
              >
                <Icon name={g.icon} size={14} /> {g.label}
              </button>
            ),
          )}
        </>
      )}
    </Menu>
  );
}

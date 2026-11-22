import { Link, useLocation } from 'react-router-dom';
import { useProjectMaybe } from '../../context';
import { findNavItem, GLOBAL_NAV, projectPath } from '../../nav';
import { Icon } from '../people';
import { StatusMenu, type ShellPrefs } from '../StatusMenu';
import { usePanes } from './panes';

/**
 * Thin global header over the list, detail and context panes: menu button (phones), list toggle (below 1024 px),
 * breadcrumb (group / section), search field (palette), context toggle, quick theme / notification buttons.
 */
export function GlobalHeader({ prefs, onSearch, onMenu, menuOpen }: { prefs: ShellPrefs; onSearch: () => void; onMenu: () => void; menuOpen: boolean }) {
  const project = useProjectMaybe();
  const panes = usePanes();
  const location = useLocation();
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  const crumbs: { label: string; to?: string }[] = [];
  if (project) {
    const rel = location.pathname.replace(new RegExp(`^/p/${project.slug}/?`), '');
    const hit = findNavItem(rel);
    crumbs.push({ label: project.overview.project.name, to: projectPath(project.slug, '') });
    if (hit && hit.item.id !== 'overview') {
      crumbs.push({ label: hit.group.label });
      crumbs.push({ label: hit.item.label, to: projectPath(project.slug, hit.item.path) });
    }
  } else {
    const g = GLOBAL_NAV.find((x) => !x.external && (x.path === '/' ? location.pathname === '/' : location.pathname.startsWith(x.path)));
    crumbs.push({ label: 'Workspace' });
    if (g) crumbs.push({ label: g.label, to: g.path });
  }
  const list = panes?.list;
  return (
    <header className="topbar gheader">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu" aria-expanded={menuOpen} aria-controls="sidebar">
        <Icon name="menu" />
      </button>
      {list && list.narrow === 'sheet' && (
        <button type="button" className="btn sm ghost list-toggle" onClick={() => panes.setListOpen(!panes.listOpen)} aria-expanded={panes.listOpen} aria-controls="list-pane">
          <Icon name="list-checks" size={14} /> {list.title}
          {list.count !== undefined && <span className="hint">{list.count}</span>}
        </button>
      )}
      <nav className="gcrumbs" aria-label="Location">
        {crumbs.map((c, i) => (
          <span key={i} className="gcrumb">
            {i > 0 && (
              <span className="sep" aria-hidden>
                /
              </span>
            )}
            {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'location' : undefined}>{c.label}</span>}
          </span>
        ))}
      </nav>
      <button className="search-btn" onClick={onSearch} aria-label="Search" title={`Search (${mac ? '⌘' : 'Ctrl'} K)`}>
        <Icon name="search" size={14} />
        <span className="grow">Search users, pages, request ids…</span>
        <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      {panes?.context && (
        <button type="button" className={`icon-btn ctx-toggle ${panes.contextOpen ? 'on' : ''}`} onClick={() => panes.setContextOpen(!panes.contextOpen)} aria-pressed={panes.contextOpen} aria-controls="context-pane" aria-label={`${panes.contextOpen ? 'Hide' : 'Show'} ${panes.context}`} title={`${panes.context} (])`}>
          <Icon name="info" size={16} />
        </button>
      )}
      <button className={`icon-btn topbar-pref ${prefs.notify ? 'on' : ''}`} onClick={() => void prefs.toggleNotify()} title={prefs.notify ? 'Desktop notifications: on' : 'Desktop notifications: off'} aria-label="Desktop notifications" aria-pressed={prefs.notify}>
        <Icon name="bell" size={15} />
      </button>
      <button className="icon-btn topbar-pref" onClick={prefs.toggleTheme} title={`Switch to ${prefs.theme === 'dark' ? 'light' : 'dark'} theme`} aria-label="Switch theme">
        <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} size={15} />
      </button>
      <StatusMenu prefs={prefs} className="status-menu-compact" />
    </header>
  );
}

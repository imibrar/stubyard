import { useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, type TestUser } from '../api';
import { useGate } from '../auth';
import type { ProjectState } from '../context';
import { Avatar } from './people';

/** Unread messages of a user across channels. */
export const unreadOf = (u: TestUser) => (u.inbox ? u.inbox.email.unread + u.inbox.sms.unread + u.inbox.whatsapp.unread : 0);

/** Pinned users in pin order (keys 1-9 open them). */
export function usePinnedUsers(project: ProjectState | null) {
  return useMemo(() => (project?.overview.users ?? []).filter((u) => u.pinned > 0).sort((a, b) => a.pinned - b.pinned), [project?.overview.users]);
}

/**
 * Pinned strip + user list with filter, drag-to-pin / reorder (PUT /pins) and 1-9 hints. Rendered by the shell
 * (0.14: inside the sidebar); directions can place it in a panel, popover or list pane.
 * `filterAt`: show the filter input when more than this many unpinned users (default 8; 0 = always).
 */
export function UserSwitcher({ project, pinned, filterAt = 8, showUnpinned = true }: { project: ProjectState; pinned: TestUser[]; filterAt?: number; showUnpinned?: boolean }) {
  const { slug, overview, reload } = project;
  const gate = useGate(slug)('walkthroughs.run');
  const [filter, setFilter] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const others = overview.users.filter((u) => !u.pinned);
  const f = filter.trim().toLowerCase();
  const shown = f ? others.filter((u) => [u.name, u.role, u.email, u.phone].some((v) => v?.toLowerCase().includes(f))) : others;

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
      className={`nav-link user-link ${dragId === u.id ? 'dragging' : ''} ${overId === u.id && dragId !== u.id ? 'drop-target' : ''}`}
      draggable={!gate.disabled}
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
      {!!u.activeRules && (
        <span className="rule-mark" title={`${u.activeRules} active scenario rule(s)`} aria-label={`${u.activeRules} active scenario rules`}>
          ⚡
        </span>
      )}
      {unreadOf(u) > 0 && (
        <span className="count" aria-label={`${unreadOf(u)} unread`}>
          {unreadOf(u)}
        </span>
      )}
      {i !== undefined && i < 9 && <span className="hint">{i + 1}</span>}
    </NavLink>
  );

  return (
    <div className="user-switcher">
      <div className="nav-label">
        Pinned <span className="nav-label-hint">press 1–9</span>
      </div>
      <div
        onDragOver={(e) => dragId && !pinned.some((u) => u.id === dragId) && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && !pinned.some((u) => u.id === dragId)) void drop('__end');
        }}
        className="stack pinned-list"
      >
        {pinned.map((u, i) => userLink(u, i))}
        {pinned.length === 0 && <span className="faint small nav-empty">Drag a user here, or press ☆ on a user.</span>}
      </div>
      {showUnpinned && (
        <>
          <div className="nav-label">
            Users <span>{overview.users.length}</span>
          </div>
          {others.length > filterAt && <input className="nav-filter" type="search" placeholder="Filter users…" aria-label="Filter users" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <div className="nav-scroll">
            {shown.map((u) => userLink(u))}
            {others.length === 0 && overview.users.length > 0 && <span className="faint small nav-empty">All users are pinned.</span>}
          </div>
        </>
      )}
    </div>
  );
}

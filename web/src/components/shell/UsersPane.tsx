import { useMemo, useState, type KeyboardEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { TestUser } from '../../api';
import { useProject } from '../../context';
import { Avatar, Icon } from '../people';
import { timeAgo } from '../ui';
import { unreadOf } from '../UserSwitcher';
import { ListPane } from './panes';

/** Up / Down (and j / k when the list has focus) move between rows of a list pane. */
export function onListKeys(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.lrow')];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
  e.preventDefault();
  rows[next]?.focus();
}

/**
 * Inbox > Users in the list pane: pinned users first (keys 1-9), then everyone else, Unassigned last. Each row shows
 * the latest code and unread count, so most OTP tasks finish without opening the user.
 */
export function UsersPane() {
  const { slug, overview } = useProject();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<'all' | 'unread'>('all');
  const pinned = useMemo(() => overview.users.filter((u) => u.pinned > 0).sort((a, b) => a.pinned - b.pinned), [overview.users]);
  const f = q.trim().toLowerCase();
  const match = (u: TestUser) => (!f || [u.name, u.role, u.email, u.phone].some((v) => v?.toLowerCase().includes(f))) && (quick === 'all' || unreadOf(u) > 0);
  const others = overview.users.filter((u) => !u.pinned && match(u));
  const pins = pinned.filter(match);
  const un = overview.unassigned.email.unread + overview.unassigned.sms.unread + overview.unassigned.whatsapp.unread;
  const totalUnread = overview.users.reduce((n, u) => n + unreadOf(u), 0);

  const row = (u: TestUser, key?: number) => {
    const n = unreadOf(u);
    const code = u.latest?.otp;
    return (
      <NavLink key={u.id} to={`/p/${slug}/users/${u.id}`} className={`lrow ${n ? 'unread' : ''}`} title={`${u.name} · ${u.role}${u.email ? ` · ${u.email}` : ''}`}>
        <span className="lrow-lead">
          <Avatar user={u} />
        </span>
        <span className="lrow-title">
          <span className="t">{u.name}</span>
          {!!u.activeRules && (
            <span className="rule-mark" title={`${u.activeRules} active scenario rule(s)`} aria-label={`${u.activeRules} active scenario rules`}>
              ⚡
            </span>
          )}
        </span>
        <span className="lrow-meta">{u.latest?.at ? timeAgo(u.latest.at) : ''}</span>
        <span className="lrow-sub">
          {code ? <span className="otp" aria-label={`Latest code ${code}`}>{code}</span> : <span className="role-text">{u.role}</span>}
          <span className="ellipsis">{code ? u.role : u.email ?? u.phone ?? ''}</span>
        </span>
        <span className="lrow-end">
          {n > 0 && (
            <span className="count" aria-label={`${n} unread`}>
              {n}
            </span>
          )}
          {key !== undefined && key < 9 && <kbd aria-label={`Shortcut ${key + 1}`}>{key + 1}</kbd>}
        </span>
      </NavLink>
    );
  };

  return (
    <ListPane
      title="Users"
      count={overview.users.length}
      actions={
        <button type="button" className="icon-btn" aria-label="Add user" title="Add user" onClick={() => nav(`/p/${slug}?new=user`)}>
          <Icon name="plus" size={16} />
        </button>
      }
      toolbar={
        <>
          <label className="pane-search">
            <Icon name="search" size={13} />
            <input type="search" placeholder="Filter users…" aria-label="Filter users" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="chips" role="group" aria-label="Quick filter">
            <button type="button" className={`chip ${quick === 'all' ? 'active' : ''}`} aria-pressed={quick === 'all'} onClick={() => setQuick('all')}>
              All <span className="n">{overview.users.length}</span>
            </button>
            <button type="button" className={`chip ${quick === 'unread' ? 'active' : ''}`} aria-pressed={quick === 'unread'} onClick={() => setQuick('unread')}>
              Unread <span className="n">{totalUnread}</span>
            </button>
          </div>
        </>
      }
    >
      <div className="lrows" onKeyDown={onListKeys}>
        {pins.length > 0 && (
          <div className="pane-group-label">
            Pinned <span className="hint">press 1–9</span>
          </div>
        )}
        {pins.map((u) => row(u, pinned.indexOf(u)))}
        {others.length > 0 && <div className="pane-group-label">{pins.length ? 'Everyone else' : 'All users'}</div>}
        {others.map((u) => row(u))}
        {!pins.length && !others.length && <p className="faint small nav-empty">No users match.</p>}
        <div className="pane-group-label">Other inbox</div>
        <NavLink to={`/p/${slug}/unassigned`} className={`lrow ${un ? 'unread' : ''}`}>
          <span className="lrow-lead">
            <span className="lrow-icon">
              <Icon name="inbox" size={15} />
            </span>
          </span>
          <span className="lrow-title">
            <span className="t">Unassigned</span>
          </span>
          <span className="lrow-meta" />
          <span className="lrow-sub">Messages to unknown recipients</span>
          <span className="lrow-end">{un > 0 && <span className="count">{un}</span>}</span>
        </NavLink>
      </div>
    </ListPane>
  );
}

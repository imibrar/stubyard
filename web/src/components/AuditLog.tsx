import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { auditApi, actionLabel, actionTone, AUDIT_ACTIONS, AUDIT_GROUPS, type AuditEntry, type AuditFilters } from '../auditApi';
import { useProjects } from '../context';
import { membersApi, teamApi } from '../teamApi';
import { EmptyState, FilterBar, StatusBadge, usePhone, type ActiveFilter } from './layout';
import { Icon } from './people';
import { ErrorBox, fmtDateTime, timeAgo } from './ui';
import '../styles/audit.css';

const PAGE = 100;

/** A local calendar day (YYYY-MM-DD from a date input) as the ISO time of its start (or of the next day's start). */
function dayIso(d: string, next = false): string | undefined {
  if (!d) return undefined;
  const t = new Date(`${d}T00:00:00`);
  if (Number.isNaN(t.getTime())) return undefined;
  if (next) t.setDate(t.getDate() + 1);
  return t.toISOString();
}

/** Detail values as short text (arrays joined, objects as JSON). */
function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const DETAIL_LABELS: Record<string, string> = {
  via: 'Via',
  status: 'HTTP status',
  fields: 'Changed',
  email: 'E-mail',
  role: 'Role',
  from: 'From',
  to: 'To',
  name: 'Name',
  projects: 'Projects',
  projectRole: 'Project role',
  maxRole: 'Highest role',
  expiresAt: 'Expires',
  userAgent: 'Browser',
  sessionsEnded: 'Sessions ended',
  tokensRevoked: 'Tokens revoked',
  secrets: 'With secrets',
  mode: 'Mode',
};
const detailLabel = (k: string) => DETAIL_LABELS[k] ?? k;

/**
 * The audit log (Teams mode): System → Audit log (instance admins, every row) and Project settings → Audit log
 * (project admins, that project). Filters, newest first, "Load older", CSV export of the filtered rows; each row
 * expands to its details. Outside Teams mode it explains that the log needs Postgres.
 */
export default function AuditLog({ project }: { project?: string }) {
  const auth = useAuth();
  const slug = project ?? null;
  if (auth.mode !== 'teams') return <AuditNeedsTeams />;
  return <AuditTable slug={slug} />;
}

function AuditNeedsTeams() {
  const auth = useAuth();
  return (
    <div className="card card-pad stack audit-needs-teams">
      <h2>The audit log needs Teams mode</h2>
      <p style={{ margin: 0 }}>
        {auth.mode === 'single' ? 'This stubyard runs in Single admin mode: one account, and no audit log.' : 'This stubyard runs without sign-in (Open mode), so there is no one to audit.'}
      </p>
      <p style={{ margin: 0 }}>
        In Teams mode (<code>STUBYARD_DATABASE_URL</code> pointing at Postgres, plus the admin from <code>STUBYARD_ADMIN_EMAIL</code>) every sign-in, user, member, role, token
        and invite change, project change, export and settings change is written to the audit log. Entries are kept for <code>STUBYARD_AUDIT_RETENTION_DAYS</code> (default
        365).
      </p>
      <p className="muted small" style={{ margin: 0 }}>
        How to switch: the user guide, section "Teams", and docs/DEPLOY-SERVER.md ("Moving from Single admin to Teams").
      </p>
    </div>
  );
}

function AuditTable({ slug }: { slug: string | null }) {
  const phone = usePhone();
  const { projects } = useProjects();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [actions, setActions] = useState<string[]>([]);
  const [people, setPeople] = useState<{ id: string; email: string; name: string }[]>([]);

  // Debounced free text.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const filters: AuditFilters = useMemo(
    () => ({ q: q || undefined, user: user || undefined, action: action || undefined, project: slug ? undefined : projectFilter || undefined, from: dayIso(from), to: dayIso(to, true) }),
    [q, user, action, projectFilter, from, to, slug],
  );

  const load = useCallback(
    async (before?: number | null) => {
      setLoading(true);
      try {
        const r = await auditApi.page(slug, filters, before, PAGE);
        setEntries((cur) => (before && cur ? [...cur, ...r.entries] : r.entries));
        setNext(r.nextBefore);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [slug, filters],
  );
  useEffect(() => {
    setOpen(new Set());
    void load();
  }, [load]);

  // Filter choices: the actions in this log, and the people (Team users, or the project's members).
  useEffect(() => {
    void auditApi.actions(slug).then(setActions, () => undefined);
    const ppl = slug ? membersApi.list(slug).then((r) => r.members.map((m) => ({ id: m.userId, email: m.email, name: m.name }))) : teamApi.users().then((u) => u.map((x) => ({ id: x.id, email: x.email, name: x.name })));
    void ppl.then(setPeople, () => undefined);
  }, [slug]);

  const emailOf = useMemo(() => new Map(people.map((p) => [p.id, p.email])), [people]);
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const actionOptions = useMemo(() => {
    const known = new Set([...Object.keys(AUDIT_ACTIONS), ...actions]);
    return AUDIT_GROUPS.map((g) => ({ ...g, items: [...known].filter((a) => a.startsWith(g.prefix)).sort() })).filter((g) => g.items.length);
  }, [actions]);
  const otherActions = actions.filter((a) => !AUDIT_GROUPS.some((g) => a.startsWith(g.prefix)));

  const active: ActiveFilter[] = [];
  if (q) active.push({ id: 'q', label: `"${q}"`, onRemove: () => setText('') });
  if (user) active.push({ id: 'user', label: `User: ${emailOf.get(user) ?? user}`, onRemove: () => setUser('') });
  if (action) active.push({ id: 'action', label: `Action: ${action.endsWith('*') ? (AUDIT_GROUPS.find((g) => g.prefix + '*' === action)?.label ?? action) : actionLabel(action)}`, onRemove: () => setAction('') });
  if (projectFilter && !slug) active.push({ id: 'project', label: `Project: ${projectFilter}`, onRemove: () => setProjectFilter('') });
  if (from) active.push({ id: 'from', label: `From ${from}`, onRemove: () => setFrom('') });
  if (to) active.push({ id: 'to', label: `To ${to}`, onRemove: () => setTo('') });
  const clearAll = () => {
    setText('');
    setUser('');
    setAction('');
    setProjectFilter('');
    setFrom('');
    setTo('');
  };

  const who = (e: AuditEntry) => (e.user?.email ? e.user.email : e.user?.id ? (emailOf.get(e.user.id) ?? e.user.id) : e.action === 'auth.login_failed' ? 'Anonymous' : 'stubyard');
  const target = (e: AuditEntry) => {
    if (!e.target) return '—';
    // API calls recorded by route: the changed settings say more than "PATCH /api/projects/:slug".
    const fields = e.detail?.fields;
    if (Array.isArray(fields) && fields.length && /^[A-Z]+ \//.test(e.target)) return fields.join(', ');
    return emailOf.get(e.target) ?? e.target;
  };

  const details = (e: AuditEntry): { k: string; v: ReactNode }[] => {
    const rows: { k: string; v: ReactNode }[] = [
      { k: 'Time', v: `${fmtDateTime(e.at)} (${e.at})` },
      { k: 'User', v: e.user ? `${e.user.email ?? '—'}${e.user.id ? ` · ${e.user.id}` : ''}` : '—' },
      { k: 'Action', v: <code>{e.action}</code> },
      { k: 'Project', v: e.project ?? '—' },
      { k: 'Target', v: <span className="mono audit-wrap">{e.target ?? '—'}</span> },
    ];
    if (e.ip !== undefined) rows.push({ k: 'Address', v: <span className="mono">{e.ip ?? '—'}</span> });
    for (const [k, v] of Object.entries(e.detail ?? {})) rows.push({ k: detailLabel(k), v: <span className="audit-wrap">{show(v)}</span> });
    return rows;
  };

  const detailPanel = (e: AuditEntry) => (
    <dl className="kv bare audit-detail-kv">
      {details(e).map((d) => (
        <Fragment key={d.k}>
          <dt>{d.k}</dt>
          <dd>{d.v}</dd>
        </Fragment>
      ))}
    </dl>
  );

  const actionBadge = (e: AuditEntry) => {
    const tone = actionTone(e.action);
    return (
      <StatusBadge status={tone} title={e.action}>
        {actionLabel(e.action)}
      </StatusBadge>
    );
  };

  const empty = entries && entries.length === 0;
  return (
    <div className="card audit-log">
      <div className="card-pad audit-head">
        <div className="audit-title">
          <h2>Audit log</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {slug ? 'Changes in this project: settings, members, exports, resets. Newest first.' : 'Sign-ins, users, members, roles, tokens, invites, projects and settings. Newest first.'}
          </p>
        </div>
        <div className="audit-head-actions">
          <button type="button" className="btn sm" onClick={() => void load()} disabled={loading}>
            <Icon name="activity" size={14} /> Refresh
          </button>
          <a className="btn sm" href={auditApi.csvUrl(slug, filters)} download>
            <Icon name="external" size={14} /> Export CSV
          </a>
        </div>
      </div>
      <div className="card-pad audit-filters">
        <FilterBar search={text} onSearch={setText} placeholder="Search e-mail, target, details…" active={active} onClearAll={clearAll}>
          <select aria-label="User" value={user} onChange={(e) => setUser(e.target.value)} className="audit-select">
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ? `${p.name} (${p.email})` : p.email}
              </option>
            ))}
          </select>
          <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)} className="audit-select">
            <option value="">All actions</option>
            {actionOptions.map((g) => (
              <optgroup key={g.prefix} label={g.label}>
                <option value={g.prefix + '*'}>All {g.label.toLowerCase()}</option>
                {g.items.map((a) => (
                  <option key={a} value={a}>
                    {actionLabel(a)}
                  </option>
                ))}
              </optgroup>
            ))}
            {otherActions.length > 0 && (
              <optgroup label="Other">
                {otherActions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {!slug && (
            <select aria-label="Project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="audit-select audit-select-project">
              <option value="">All projects</option>
              {(projects ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <label className="audit-date">
            <span className="muted small">From</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="audit-date">
            <span className="muted small">To</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
        </FilterBar>
      </div>
      <ErrorBox error={error} />
      {entries === null && !error && <p className="card-pad muted small">Loading…</p>}
      {empty && (
        <EmptyState title={active.length ? 'No entries match these filters' : 'No audit entries yet'}>
          {active.length ? (
            <button type="button" className="btn sm" onClick={clearAll}>
              Clear filters
            </button>
          ) : (
            'Sign-ins and changes show up here.'
          )}
        </EmptyState>
      )}
      {entries && entries.length > 0 && !phone && (
        <div className="table-wrap data-table-wrap audit-table-wrap">
          <table className="data-table audit-table">
            <caption className="sr-only">Audit log entries, newest first</caption>
            <thead>
              <tr>
                <th scope="col" className="audit-col-toggle">
                  <span className="sr-only">Details</span>
                </th>
                <th scope="col" className="audit-col-time">Time</th>
                <th scope="col">User</th>
                <th scope="col">Action</th>
                {!slug && <th scope="col">Project</th>}
                <th scope="col" className="col-md">
                  Target
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isOpen = open.has(e.id);
                return (
                  <Fragment key={e.id}>
                    <tr className={`clickable ${isOpen ? 'selected' : ''}`} onClick={() => toggle(e.id)}>
                      <td className="audit-col-toggle">
                        <button
                          type="button"
                          className="icon-btn audit-toggle"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} details of entry ${e.id}`}
                          onClick={(ev) => (ev.stopPropagation(), toggle(e.id))}
                        >
                          <Icon name="chevron" size={14} className={`icon audit-chevron ${isOpen ? 'open' : ''}`} />
                        </button>
                      </td>
                      <td className="audit-col-time nowrap" title={fmtDateTime(e.at)}>
                        <span className="audit-time">{fmtDateTime(e.at)}</span>
                        <span className="faint small audit-ago">{timeAgo(e.at)}</span>
                      </td>
                      <td className="ellipsis audit-col-user" title={who(e)}>
                        {who(e)}
                      </td>
                      <td>{actionBadge(e)}</td>
                      {!slug && <td className="ellipsis audit-col-project">{e.project ?? <span className="faint">—</span>}</td>}
                      <td className="col-md ellipsis mono audit-col-target" title={e.target ?? undefined}>
                        {target(e)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="audit-detail-row">
                        <td />
                        <td colSpan={slug ? 4 : 5}>{detailPanel(e)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {entries && entries.length > 0 && phone && (
        <ul className="data-stack audit-stack" aria-label="Audit log entries, newest first">
          {entries.map((e) => {
            const isOpen = open.has(e.id);
            return (
              <li key={e.id} className={`audit-stack-row ${isOpen ? 'selected' : ''}`}>
                <button type="button" className="audit-stack-head" aria-expanded={isOpen} onClick={() => toggle(e.id)}>
                  <span className="audit-stack-main">
                    <span className="audit-stack-title">{actionBadge(e)}</span>
                    <span className="data-stack-meta">
                      <span title={fmtDateTime(e.at)}>{timeAgo(e.at)}</span>
                      <span className="ellipsis audit-stack-user">{who(e)}</span>
                      {!slug && e.project && <span>{e.project}</span>}
                    </span>
                  </span>
                  <Icon name="chevron" size={14} className={`icon audit-chevron ${isOpen ? 'open' : ''}`} />
                </button>
                {isOpen && <div className="audit-stack-detail">{detailPanel(e)}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {entries && entries.length > 0 && (
        <div className="card-pad audit-foot">
          <span className="muted small">
            {entries.length.toLocaleString()} {entries.length === 1 ? 'entry' : 'entries'}
            {next === null ? '' : ' shown'}
          </span>
          {next !== null && (
            <button type="button" className="btn sm" disabled={loading} onClick={() => void load(next)}>
              {loading ? 'Loading…' : 'Load older entries'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { roleLabel, roleOptions, useAuth, type ProjectRole } from '../auth';
import { DataTable, Section, StatusBadge, type Column } from '../components/layout';
import { Icon } from '../components/people';
import { Empty, ErrorBox, fmtDateTime, Modal, timeAgo, useToast } from '../components/ui';
import { useProject } from '../context';
import { membersApi, type ProjectMember } from '../teamApi';
import { Page } from './ProjectPage';
import '../styles/team.css';

type Candidate = { id: string; email: string; name: string };

/** /p/:slug/members (Teams mode): who can open this project and with which role. Project admins manage it. */
export default function MembersPage() {
  const auth = useAuth();
  const { slug, overview } = useProject();
  const toast = useToast();
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<ProjectRole>('developer');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const teams = auth.mode === 'teams';

  const reload = useCallback(async () => {
    if (!teams) return;
    try {
      const r = await membersApi.list(slug);
      setMembers(r.members);
      setCanManage(r.canManage);
      setError(null);
      if (r.canManage) setCandidates(await membersApi.candidates(slug).catch(() => []));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [slug, teams]);
  useEffect(() => void reload(), [reload]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const roles = roleOptions(auth);
  const columns: Column<ProjectMember>[] = [
    {
      key: 'name',
      header: 'Member',
      fill: true,
      render: (m) => (
        <span className="team-user">
          <strong className="ellipsis">{m.name || m.email}</strong>
          <span className="muted small ellipsis">{m.email}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (m) =>
        canManage ? (
          <select
            className="members-role"
            value={m.role}
            disabled={busy}
            aria-label={`Role of ${m.email}`}
            onChange={(e) => void act(() => membersApi.setRole(slug, m.userId, e.target.value as ProjectRole), `${m.email} is now ${roleLabel(e.target.value, auth)}`)}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        ) : (
          <StatusBadge status={m.role === 'project_admin' ? 'accent' : 'neutral'}>{roleLabel(m.role, auth)}</StatusBadge>
        ),
    },
    { key: 'status', header: 'Status', priority: 2, render: (m) => (m.disabled ? <StatusBadge status="bad">Disabled</StatusBadge> : <StatusBadge status="ok">Active</StatusBadge>) },
    { key: 'added', header: 'Added', priority: 3, render: (m) => <span className="nowrap" title={`${fmtDateTime(m.addedAt)}${m.addedBy ? ` by ${m.addedBy}` : ''}`}>{timeAgo(m.addedAt)}</span> },
  ];

  if (!teams)
    return (
      <Page title="Members">
        <div className="card">
          <Empty title="Teams mode only">Project members and roles need Teams mode (Postgres). See docs/GUIDE.md, "Sign-in".</Empty>
        </div>
      </Page>
    );

  const chosen = roles.find((r) => r.id === role);
  return (
    <Page title="Members" description={`Who can open ${overview.project.name} and what they may do. Instance admins see every project and are not listed here.`}>
      <div className="stack">
        <ErrorBox error={error} />
        {canManage && (
          <Section title="Add a member" description="People need an account first: an instance admin adds them, or sends an invite link, on the Team page.">
            {candidates.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Everyone with an active account is already a member.
              </p>
            ) : (
              <form
                className="members-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  const c = candidates.find((x) => x.id === pick);
                  if (c) void act(() => membersApi.add(slug, c.id, role), `Added ${c.email} as ${roleLabel(role, auth)}`).then((ok) => ok && setPick(''));
                }}
              >
                <label className="field">
                  Account
                  <select value={pick} onChange={(e) => setPick(e.target.value)} required>
                    <option value="">Choose…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name ? `${c.name} (${c.email})` : c.email}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Role
                  <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn primary" disabled={busy || !pick}>
                  <Icon name="plus" size={14} /> Add
                </button>
                {chosen?.description && <p className="muted small members-role-help">{chosen.description}</p>}
              </form>
            )}
          </Section>
        )}
        <Section title={`Members${members ? ` (${members.length})` : ''}`} description={canManage ? undefined : 'Only a project admin can change members.'} pad={false}>
          {!members ? (
            <p className="muted card-pad">Loading…</p>
          ) : (
            <DataTable
              caption="Project members"
              columns={columns}
              rows={members}
              rowKey={(m) => m.userId}
              empty={<Empty title="No members yet">{canManage ? 'Add an account above.' : 'Only instance admins can open this project so far.'}</Empty>}
              rowMenu={
                canManage
                  ? (m) => (
                      <button type="button" className="btn danger sm" disabled={busy} onClick={() => setRemoving(m)} aria-label={`Remove ${m.email}`}>
                        Remove
                      </button>
                    )
                  : undefined
              }
            />
          )}
        </Section>
        {roles.some((r) => r.description) && (
          <details className="card card-pad members-roles">
            <summary className="small">What each role can do</summary>
            <dl className="kv bare">
              {roles.map((r) => (
                <div key={r.id} className="kv-row">
                  <dt>{r.label}</dt>
                  <dd className="muted small">{r.description}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
      {removing && (
        <Modal
          title={`Remove ${removing.email}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void act(() => membersApi.remove(slug, removing.userId), `Removed ${removing.email}`).then((ok) => ok && setRemoving(null))}>
                Remove member
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>They can no longer open {overview.project.name}. Their account and other projects are kept.</p>
        </Modal>
      )}
    </Page>
  );
}

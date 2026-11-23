import { useCallback, useEffect, useState } from 'react';
import { roleLabel, roleOptions, useAuth, type InstanceRole, type ProjectRole } from '../auth';
import { useProjects } from '../context';
import { DataTable, PageHeader, Section, StatusBadge, type Column } from '../components/layout';
import { Icon, Menu } from '../components/people';
import { Empty, ErrorBox, fmtDateTime, Modal, timeAgo, useCopy, useToast } from '../components/ui';
import { teamApi, type TeamInvite, type TeamUser } from '../teamApi';
import '../styles/team.css';

const ENV_ADMIN_REASON = 'This admin comes from the environment (STUBYARD_ADMIN_*): change it there';

/** A secret shown once (temporary password, invite link) with a copy button. */
export function SecretOnce({ value, copied, testId }: { value: string; copied: string; testId?: string }) {
  const copy = useCopy();
  return (
    <div className="token-secret">
      <code className="mono" data-testid={testId}>
        {value}
      </code>
      <button type="button" className="btn primary sm" onClick={() => void copy(value, copied)}>
        <Icon name="copy" size={14} /> Copy
      </button>
    </div>
  );
}

function RoleSelect({ value, onChange, allowNone, id }: { value: ProjectRole | ''; onChange: (r: ProjectRole | '') => void; allowNone?: boolean; id?: string }) {
  const auth = useAuth();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as ProjectRole | '')}>
      {allowNone && <option value="">No project role</option>}
      {roleOptions(auth).map((r) => (
        <option key={r.id} value={r.id} title={r.description}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

/** /team (Teams mode, instance admins): accounts, their instance role and projects, and invite links. */
export default function TeamPage() {
  const auth = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [invites, setInvites] = useState<TeamInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [secret, setSecret] = useState<{ title: string; text: string; value: string; copied: string } | null>(null);
  const [resetting, setResetting] = useState<TeamUser | null>(null);
  const [disabling, setDisabling] = useState<TeamUser | null>(null);
  const [revoking, setRevoking] = useState<TeamInvite | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([teamApi.users(), teamApi.invites()]);
      setUsers(u);
      setInvites(i);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (done) toast(done);
      void reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const selfId = auth.user?.id;
  const userColumns: Column<TeamUser>[] = [
    {
      key: 'name',
      header: 'Name',
      fill: true,
      render: (u) => (
        <span className="team-user">
          <strong className="ellipsis">{u.name || u.email}</strong>
          <span className="muted small ellipsis">{u.email}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Instance role',
      render: (u) => (
        <span className="team-badges">
          <StatusBadge status={u.role === 'admin' ? 'accent' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Member'}</StatusBadge>
          {u.envAdmin && (
            <StatusBadge status="info" title={ENV_ADMIN_REASON}>
              Environment
            </StatusBadge>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (u) =>
        u.disabled ? (
          <StatusBadge status="bad">Disabled</StatusBadge>
        ) : u.mustChangePassword ? (
          <StatusBadge status="warn" title="Signs in with a temporary password and must choose a new one">
            Temporary password
          </StatusBadge>
        ) : (
          <StatusBadge status="ok">Active</StatusBadge>
        ),
    },
    {
      key: 'projects',
      header: 'Projects',
      priority: 2,
      render: (u) =>
        u.role === 'admin' ? (
          <span className="muted small">Every project</span>
        ) : u.projects.length ? (
          <span className="team-projects">
            {u.projects.map((p) => (
              <span key={p.slug} className="badge team-project" title={`${p.slug}: ${roleLabel(p.role, auth)}`}>
                <span className="ellipsis">{p.slug}</span> <span className="muted">· {roleLabel(p.role, auth)}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="muted small">None</span>
        ),
    },
    {
      key: 'login',
      header: 'Last sign-in',
      priority: 3,
      render: (u) => (u.lastLoginAt ? <span className="nowrap" title={fmtDateTime(u.lastLoginAt)}>{timeAgo(u.lastLoginAt)}</span> : <span className="muted">never</span>),
    },
  ];

  const userMenu = (u: TeamUser) => {
    const self = u.id === selfId;
    const locked = u.envAdmin ? ENV_ADMIN_REASON : self ? 'You cannot change your own role or disable yourself' : null;
    return (
      <Menu className="icon-btn" floating menuClassName="team-row-pop" title={`Actions for ${u.email}`} label={<Icon name="more" />}>
        {(close) => (
          <>
            <div className="menu-label">Instance role</div>
            {(['member', 'admin'] as InstanceRole[]).map((r) => (
              <button
                key={r}
                type="button"
                role="menuitemradio"
                aria-checked={u.role === r}
                disabled={!!locked || busy}
                title={locked ?? undefined}
                onClick={() => (close(), void act(() => teamApi.updateUser(u.id, { role: r }), `${u.email} is now ${r === 'admin' ? 'an instance admin' : 'a member'}`))}
              >
                <Icon name={u.role === r ? 'check' : r === 'admin' ? 'shield' : 'user'} size={14} /> {r === 'admin' ? 'Admin (every project, Team, System)' : 'Member (own projects only)'}
              </button>
            ))}
            <div className="menu-sep" role="separator" />
            <button type="button" role="menuitem" disabled={(!!u.envAdmin) || busy} title={u.envAdmin ? ENV_ADMIN_REASON : undefined} onClick={() => (close(), setResetting(u))}>
              <Icon name="key" size={14} /> Reset password…
            </button>
            {u.disabled ? (
              <button type="button" role="menuitem" disabled={!!locked || busy} title={locked ?? undefined} onClick={() => (close(), void act(() => teamApi.updateUser(u.id, { disabled: false }), `Enabled ${u.email}`))}>
                <Icon name="check" size={14} /> Enable account
              </button>
            ) : (
              <button type="button" role="menuitem" className="danger" disabled={!!locked || busy} title={locked ?? undefined} onClick={() => (close(), setDisabling(u))}>
                <Icon name="close" size={14} /> Disable account…
              </button>
            )}
          </>
        )}
      </Menu>
    );
  };

  const inviteColumns: Column<TeamInvite>[] = [
    {
      key: 'who',
      header: 'Invite',
      fill: true,
      render: (i) => (
        <span className="team-user">
          <strong className="ellipsis">{i.name || i.email || 'Anyone with the link'}</strong>
          <span className="muted small ellipsis">{i.email ?? 'E-mail chosen when accepting'}</span>
        </span>
      ),
    },
    {
      key: 'access',
      header: 'Access',
      render: (i) => (
        <span className="small">
          {i.role === 'admin' ? 'Instance admin' : i.project ? `${i.project} · ${roleLabel(i.projectRole, auth)}` : 'Member, no project'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (i) => (
        <StatusBadge status={i.status === 'pending' ? 'info' : i.status === 'accepted' ? 'ok' : 'neutral'}>
          {i.status === 'pending' ? 'Pending' : i.status === 'accepted' ? 'Accepted' : i.status === 'expired' ? 'Expired' : 'Revoked'}
        </StatusBadge>
      ),
    },
    {
      key: 'expires',
      header: 'Expires',
      priority: 2,
      render: (i) =>
        i.status === 'pending' ? (
          <span className="nowrap" title={fmtDateTime(i.expiresAt)}>
            {new Date(i.expiresAt).toLocaleDateString()}
          </span>
        ) : (
          <span className="muted nowrap" title={fmtDateTime(i.acceptedAt ?? i.revokedAt ?? i.expiresAt)}>
            {timeAgo(i.acceptedAt ?? i.revokedAt ?? i.expiresAt)}
          </span>
        ),
    },
    { key: 'created', header: 'Created', priority: 3, render: (i) => <span className="nowrap" title={fmtDateTime(i.createdAt)}>{timeAgo(i.createdAt)}</span> },
  ];

  const pending = invites?.filter((i) => i.status === 'pending') ?? [];
  const past = invites?.filter((i) => i.status !== 'pending') ?? [];

  return (
    <div className="stack team-page">
      <PageHeader
        title="Team"
        crumbs={[{ label: 'Workspace' }, { label: 'Team' }]}
        description="Accounts that can sign in to this stubyard. Instance admins see every project, this page and System; members see only the projects they belong to, with a role per project (Project → Members)."
        primary={
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add user
          </button>
        }
      />
      <ErrorBox error={error} />
      <Section title={`Users${users ? ` (${users.length})` : ''}`} pad={false}>
        {!users ? (
          <p className="muted card-pad">Loading…</p>
        ) : (
          <DataTable caption="Users" columns={userColumns} rows={users} rowKey={(u) => u.id} rowMenu={userMenu} empty={<Empty title="No users yet">Add one, or create an invite link below.</Empty>} />
        )}
      </Section>
      <Section
        title={`Invite links${invites ? ` (${pending.length} pending)` : ''}`}
        description="A link lets someone choose their own name and password. Valid for 7 days and works once. stubyard sends no e-mail: copy the link and send it yourself."
        actions={
          <button type="button" className="btn" onClick={() => setInviting(true)}>
            <Icon name="link" size={14} /> New invite link
          </button>
        }
        pad={false}
      >
        {!invites ? (
          <p className="muted card-pad">Loading…</p>
        ) : (
          <DataTable
            caption="Pending invite links"
            columns={inviteColumns}
            rows={pending}
            rowKey={(i) => i.id}
            empty={<p className="muted card-pad small team-empty">No pending invites.</p>}
            rowMenu={(i) => (
              <button type="button" className="btn danger sm" onClick={() => setRevoking(i)} aria-label={`Revoke the invite for ${i.email ?? i.name ?? 'anyone'}`}>
                Revoke
              </button>
            )}
          />
        )}
        {past.length > 0 && (
          <details className="team-past">
            <summary className="muted small">Accepted, expired and revoked ({past.length})</summary>
            <DataTable caption="Past invite links" columns={inviteColumns} rows={past} rowKey={(i) => i.id} />
          </details>
        )}
      </Section>

      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onCreated={(u, temp) => {
            setAdding(false);
            void reload();
            if (temp) setSecret({ title: 'Temporary password', text: `${u.email} signs in with this password once and then chooses their own. It is shown only now.`, value: temp, copied: 'Password copied' });
            else toast(`Added ${u.email}`);
          }}
        />
      )}
      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={(link, inv) => {
            setInviting(false);
            void reload();
            setSecret({ title: 'Copy the invite link', text: `Send this link to ${inv.email ?? 'the person you invite'}. It is shown only now, is valid for 7 days and works once.`, value: link, copied: 'Link copied' });
          }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(temp) => {
            const u = resetting;
            setResetting(null);
            void reload();
            if (temp) setSecret({ title: 'Temporary password', text: `${u.email} was signed out everywhere. They sign in with this password once and then choose their own. It is shown only now.`, value: temp, copied: 'Password copied' });
            else toast(`New password set for ${u.email}; they were signed out everywhere`);
          }}
        />
      )}
      {disabling && (
        <Modal
          title={`Disable ${disabling.email}?`}
          onClose={() => setDisabling(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDisabling(null)}>
                Cancel
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void act(() => teamApi.updateUser(disabling.id, { disabled: true }), `Disabled ${disabling.email}`).then((ok) => ok && setDisabling(null))}>
                Disable account
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>They are signed out and cannot sign in or use their API tokens. Their memberships are kept; enable the account again at any time.</p>
        </Modal>
      )}
      {revoking && (
        <Modal
          title="Revoke this invite link?"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRevoking(null)}>
                Cancel
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void act(() => teamApi.revokeInvite(revoking.id), 'Invite revoked').then((ok) => ok && setRevoking(null))}>
                Revoke link
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>The link stops working at once.</p>
        </Modal>
      )}
      {secret && (
        <Modal
          title={secret.title}
          onClose={() => setSecret(null)}
          footer={
            <button type="button" className="btn primary" onClick={() => setSecret(null)}>
              Done
            </button>
          }
        >
          <div className="stack">
            <p style={{ margin: 0 }}>{secret.text}</p>
            <SecretOnce value={secret.value} copied={secret.copied} testId="team-secret" />
          </div>
        </Modal>
      )}
    </div>
  );
}

function ProjectPicker({ value, onChange, id }: { value: string; onChange: (slug: string) => void; id?: string }) {
  const { projects } = useProjects();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No project</option>
      {projects?.map((p) => (
        <option key={p.slug} value={p.slug}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (u: TeamUser, temp?: string) => void }) {
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as InstanceRole, password: '', project: '', projectRole: 'developer' as ProjectRole | '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (form.password && form.password.length < 8) return setError('The password needs at least 8 characters (or leave it empty to generate one).');
    setBusy(true);
    setError(null);
    try {
      const r = await teamApi.createUser({
        email: form.email.trim(),
        name: form.name.trim() || undefined,
        role: form.role,
        password: form.password || undefined,
        projects: form.role === 'member' && form.project && form.projectRole ? [{ slug: form.project, role: form.projectRole }] : undefined,
      });
      onCreated(r.user, r.temporaryPassword);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-user-form" className="btn primary" disabled={busy || !form.email.trim()}>
            Add user
          </button>
        </>
      }
    >
      <form
        id="add-user-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="form form-2">
          <label className="field">
            E-mail
            <input type="email" required autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            Name <span className="hint">Optional</span>
            <input maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
        </div>
        <InstanceRoleField value={form.role} onChange={(role) => setForm({ ...form, role })} />
        <label className="field">
          Password <span className="hint">Optional. Leave empty to generate a temporary one; either way they choose their own at first sign-in.</span>
          <input type="text" autoComplete="off" spellCheck={false} className="mono" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {form.role === 'member' && (
          <div className="form form-2">
            <label className="field">
              First project <span className="hint">Optional</span>
              <ProjectPicker value={form.project} onChange={(project) => setForm({ ...form, project })} />
            </label>
            <label className="field">
              Project role
              <RoleSelect value={form.projectRole} onChange={(projectRole) => setForm({ ...form, projectRole })} />
            </label>
          </div>
        )}
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

function InstanceRoleField({ value, onChange }: { value: InstanceRole; onChange: (r: InstanceRole) => void }) {
  return (
    <fieldset className="team-role-choice">
      <legend>Instance role</legend>
      <label className="team-radio">
        <input type="radio" name="instance-role" checked={value === 'member'} onChange={() => onChange('member')} />
        <span>
          <strong>Member</strong> <span className="muted small">Sees only the projects they are a member of, with the role given there.</span>
        </span>
      </label>
      <label className="team-radio">
        <input type="radio" name="instance-role" checked={value === 'admin'} onChange={() => onChange('admin')} />
        <span>
          <strong>Admin</strong> <span className="muted small">Every project, the Team page and System settings.</span>
        </span>
      </label>
    </fieldset>
  );
}

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (link: string, invite: TeamInvite) => void }) {
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as InstanceRole, project: '', projectRole: 'developer' as ProjectRole | '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const member = form.role === 'member' && form.project && form.projectRole;
      const r = await teamApi.createInvite({
        email: form.email.trim() || undefined,
        name: form.name.trim() || undefined,
        role: form.role,
        project: member ? form.project : undefined,
        projectRole: member ? (form.projectRole as ProjectRole) : undefined,
      });
      onCreated(`${window.location.origin}${r.path}`, r.invite);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New invite link"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="invite-form" className="btn primary" disabled={busy}>
            Create link
          </button>
        </>
      }
    >
      <form
        id="invite-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="form form-2">
          <label className="field">
            E-mail <span className="hint">Optional. Empty: they enter it when accepting.</span>
            <input type="email" autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            Name <span className="hint">Optional, they can change it</span>
            <input maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
        </div>
        <InstanceRoleField value={form.role} onChange={(role) => setForm({ ...form, role })} />
        {form.role === 'member' && (
          <div className="form form-2">
            <label className="field">
              Project <span className="hint">Optional</span>
              <ProjectPicker value={form.project} onChange={(project) => setForm({ ...form, project })} />
            </label>
            <label className="field">
              Project role
              <RoleSelect value={form.projectRole} onChange={(projectRole) => setForm({ ...form, projectRole })} />
            </label>
          </div>
        )}
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: TeamUser; onClose: () => void; onDone: (temp?: string) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (password && password.length < 8) return setError('The password needs at least 8 characters (or leave it empty to generate one).');
    setBusy(true);
    setError(null);
    try {
      const r = await teamApi.resetPassword(user.id, password || undefined);
      onDone(r.temporaryPassword);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Reset the password of ${user.email}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="reset-password-form" className="btn danger" disabled={busy}>
            Reset password
          </button>
        </>
      }
    >
      <form
        id="reset-password-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p style={{ margin: 0 }}>They are signed out everywhere and must choose a new password at their next sign-in.</p>
        <label className="field">
          New temporary password <span className="hint">Optional. Leave empty to generate one.</span>
          <input type="text" autoComplete="off" spellCheck={false} className="mono" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

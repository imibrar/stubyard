import { useState } from 'react';
import { api, type TestUser } from '../api';
import { useProject } from '../context';
import { DEFAULT_ROLES, Icon, Menu, RoleCountsEditor, knownRoles, type RoleCount } from './people';
import { ErrorBox, Modal, useCopy, useToast } from './ui';

/** ☆ / ★ toggle that pins a user to the sidebar. */
export function PinStar({ user }: { user: TestUser }) {
  const { slug, reload } = useProject();
  const toast = useToast();
  const on = user.pinned > 0;
  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await api.patch(`/api/projects/${slug}/users/${user.id}`, { pinned: !on });
    toast(on ? `Unpinned ${user.name}` : `Pinned ${user.name}`);
    reload();
  };
  return (
    <button className={`star ${on ? 'on' : ''}`} onClick={toggle} title={on ? 'Unpin from sidebar' : 'Pin to sidebar'} aria-pressed={on}>
      {on ? '★' : '☆'}
    </button>
  );
}

/** Copy this user's login details in the format you need. */
export function CopyLoginMenu({ user, compact }: { user: TestUser; compact?: boolean }) {
  const copy = useCopy();
  const login = user.email ?? user.phone ?? '';
  const pw = user.password ?? '';
  const formats: [string, string, string][] = [
    ['Email / login', login, login],
    ['Password', pw, '••••••'],
    ['Login + password', `${login}\t${pw}`, 'tab-separated'],
    ['JSON', JSON.stringify({ email: user.email, password: pw, phone: user.phone }), '{ … }'],
    ['.env', `TEST_USER_EMAIL=${user.email ?? ''}\nTEST_USER_PASSWORD=${pw}\nTEST_USER_PHONE=${user.phone ?? ''}`, 'KEY=value'],
    ['Playwright / Cypress', `await page.fill('input[type=email]', '${login}');\nawait page.fill('input[type=password]', '${pw}');`, 'snippet'],
  ];
  return (
    <Menu
      className={compact ? 'btn xs ghost' : 'btn sm'}
      label={
        <>
          <Icon name="copy" size={13} /> {compact ? '' : 'Copy login ▾'}
        </>
      }
    >
      {(close) =>
        formats.map(([label, value, sub]) => (
          <button
            key={label}
            role="menuitem"
            onClick={() => {
              void copy(value, `${label} copied`);
              close();
            }}
          >
            {label}
            <span className="sub">{sub}</span>
          </button>
        ))
      }
    </Menu>
  );
}

export function UserModal({ user, onClose }: { user: TestUser | null; onClose: () => void }) {
  const { slug, overview, reload } = useProject();
  const roles = knownRoles(overview.users, overview.project.settings.roles);
  const [form, setForm] = useState({
    name: user?.name ?? '',
    role: user?.role ?? roles.find((r) => r !== 'admin') ?? 'customer',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    whatsapp: user?.whatsapp ?? '',
    password: user?.password ?? '',
    marketingOptOut: user?.marketingOptOut ?? false,
    pinned: user ? user.pinned > 0 : false,
    notes: user?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  const save = async () => {
    setError(null);
    try {
      const payload = { ...form, whatsapp: form.whatsapp || (user ? null : undefined), password: form.password || null };
      if (user) await api.patch(`/api/projects/${slug}/users/${user.id}`, payload);
      else await api.post(`/api/projects/${slug}/users`, payload);
      reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!user || !confirm(`Delete test user "${user.name}"? Their messages move to Unassigned.`)) return;
    await api.del(`/api/projects/${slug}/users/${user.id}`);
    reload();
    onClose();
  };

  return (
    <Modal
      title={user ? `Edit ${user.name}` : 'Add test user'}
      onClose={onClose}
      footer={
        <>
          {user && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!form.name.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Name
            <input autoFocus value={form.name} onChange={set('name')} placeholder="Sales 1" />
          </label>
          <label className="field">
            Role
            <input value={form.role} onChange={set('role')} list="user-roles" />
            <datalist id="user-roles">
              {roles.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
        </div>
        <div className="form form-2">
          <label className="field">
            Email
            <input type="email" value={form.email} onChange={set('email')} placeholder={`ali@${overview.project.settings.emailDomain || `${slug}.test`}`} />
          </label>
          <label className="field">
            Password <span className="hint">For logging in to your app</span>
            <input value={form.password} onChange={set('password')} placeholder={overview.project.settings.defaultPassword || 'Password123!'} />
          </label>
        </div>
        <div className="form form-2">
          <label className="field">
            Phone (SMS)
            <input value={form.phone} onChange={set('phone')} placeholder="+923001234567" />
          </label>
          <label className="field">
            WhatsApp <span className="hint">Defaults to the phone number</span>
            <input value={form.whatsapp} onChange={set('whatsapp')} placeholder={form.phone || '+923001234567'} />
          </label>
        </div>
        <label className="field">
          Notes <span className="hint">e.g. "has 2FA on", "KYC pending"</span>
          <input value={form.notes} onChange={set('notes')} />
        </label>
        <div className="row">
          <label className="row">
            <input type="checkbox" checked={form.pinned} onChange={set('pinned')} /> Pin to sidebar
          </label>
          <label className="row">
            <input type="checkbox" checked={form.marketingOptOut} onChange={set('marketingOptOut')} /> Marketing opt-out (DND)
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function GenerateModal({ onClose }: { onClose: () => void }) {
  const { slug, overview, reload } = useProject();
  const toast = useToast();
  const suggestions = knownRoles(overview.users, overview.project.settings.roles);
  const initial: RoleCount[] = (overview.project.settings.roles?.length ? overview.project.settings.roles : DEFAULT_ROLES).map((role) => ({
    role,
    count: overview.users.some((u) => u.role === role) ? 0 : role === 'customer' ? 3 : 1,
  }));
  const [roles, setRoles] = useState<RoleCount[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    try {
      const created = await api.post<TestUser[]>(`/api/projects/${slug}/users/generate`, { roles: roles.filter((r) => r.role && r.count > 0) });
      toast(`Created ${created.length} test users`);
      reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title="Generate test users"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go}>
            Generate
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <p className="muted" style={{ margin: 0 }}>
          Creates users with unique fake emails and phone numbers (domain and prefix from project settings). Numbering continues after existing users.
        </p>
        <RoleCountsEditor value={roles} onChange={setRoles} suggestions={suggestions} />
      </div>
    </Modal>
  );
}

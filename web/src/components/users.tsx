import { useState } from 'react';
import { api, type TestUser } from '../api';
import { useProject } from '../context';
import { useGate } from '../auth';
import { DEFAULT_ROLES, Icon, Menu, RoleCountsEditor, knownRoles, type RoleCount } from './people';
import { ErrorBox, Modal, useCopy, useToast } from './ui';
import { generateNationalId, nationalIdLabel, nationalIdProblem } from './NafathCard';
import '../styles/cleanup.css';
import '../styles/nafath.css';

/** Identity attributes of the form (server/src/nafath/claims.ts reads them; unset ones are derived from the name). */
const IDENTITY_FIELDS: { key: string; label: string; placeholder?: string; dir?: 'rtl' }[] = [
  { key: 'firstNameAr', label: 'First name (Arabic)', dir: 'rtl' },
  { key: 'fatherNameAr', label: "Father's name (Arabic)", dir: 'rtl' },
  { key: 'grandFatherNameAr', label: "Grandfather's name (Arabic)", dir: 'rtl' },
  { key: 'familyNameAr', label: 'Family name (Arabic)', dir: 'rtl' },
  { key: 'englishFirstName', label: 'First name (English)' },
  { key: 'englishSecondName', label: 'Second name (English)' },
  { key: 'englishThirdName', label: 'Third name (English)' },
  { key: 'englishLastName', label: 'Last name (English)' },
  { key: 'nationalityCode', label: 'Nationality code', placeholder: 'SA' },
  { key: 'nationality', label: 'Nationality', placeholder: 'Saudi Arabia' },
  { key: 'dateOfBirthG', label: 'Date of birth', placeholder: 'dd-MM-yyyy' },
  { key: 'idExpiryDateG', label: 'ID expiry date', placeholder: 'dd-MM-yyyy' },
];
const DATE_G_RE = /^\d{2}-\d{2}-\d{4}$/;
const identityText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

const KEEP_HELP = 'Keep: a shared fixture. Walkthrough cleanup never deletes this user or their messages.';

/** "Kept" badge for a Keep-pinned test user. */
export function KeptBadge({ keep }: { keep: boolean | undefined }) {
  return keep ? (
    <span className="badge accent kept-badge" title={KEEP_HELP}>
      <span className="kept-word">Kept</span>
    </span>
  ) : null;
}

/** Keep toggle (PATCH keep): a pinned user is a shared fixture that cleanup never deletes. */
export function KeepToggle({ userId, name, keep, onChanged, className = 'btn xs' }: { userId: string; name: string; keep: boolean; onChanged?: () => void; className?: string }) {
  const { slug, reload } = useProject();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Teams mode: changing a test user needs walkthroughs.run.
  const gate = useGate(slug)('walkthroughs.run');
  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await api.patch(`/api/projects/${slug}/users/${userId}`, { keep: !keep });
      toast(keep ? `${name} is no longer kept` : `${name} is kept: cleanup never deletes it`);
      reload();
      onChanged?.();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`${className} keep-toggle ${keep ? 'on' : ''}`} onClick={toggle} disabled={busy || !!gate.disabled} aria-pressed={keep} title={gate.title ?? (keep ? `${KEEP_HELP} Click to unpin.` : KEEP_HELP)}>
      {keep ? '● Kept' : '○ Keep'}
    </button>
  );
}

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
    keep: user?.keep ?? false,
    notes: user?.notes ?? '',
    nationalId: user?.nationalId ?? '',
  });
  // Identity attributes: the known ones are edited here; other keys of the stored object are kept as they are.
  const [identity, setIdentity] = useState<Record<string, unknown>>(user?.identity ?? {});
  const setId = (k: string, v: unknown) => {
    const next = { ...identity };
    if (v === '' || v === undefined || v === false) delete next[k];
    else next[k] = v;
    setIdentity(next);
  };
  const idProblem = nationalIdProblem(form.nationalId);
  const dateProblems = ['dateOfBirthG', 'idExpiryDateG'].filter((k) => identity[k] !== undefined && !DATE_G_RE.test(identityText(identity[k])));
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  const save = async () => {
    setError(null);
    try {
      const payload = { ...form, whatsapp: form.whatsapp || (user ? null : undefined), password: form.password || null, nationalId: form.nationalId.trim() || null, identity };
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
          <button className="btn primary" disabled={!form.name.trim() || !!idProblem} onClick={save}>
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
        <div className="field">
          <label htmlFor="user-national-id">
            {form.nationalId.trim() ? nationalIdLabel(form.nationalId.trim()) : 'National ID / Iqama'} <span className="hint">For fake Nafath: 10 digits, 1… citizen, 2… resident</span>
          </label>
          <div className="nafath-id-row">
            <input
              id="user-national-id"
              inputMode="numeric"
              maxLength={10}
              value={form.nationalId}
              onChange={set('nationalId')}
              placeholder="1xxxxxxxxx"
              aria-invalid={!!idProblem}
              aria-describedby={idProblem ? 'user-national-id-error' : undefined}
            />
            <button type="button" className="btn sm" onClick={() => setForm({ ...form, nationalId: generateNationalId('citizen') })}>
              Generate citizen
            </button>
            <button type="button" className="btn sm" onClick={() => setForm({ ...form, nationalId: generateNationalId('resident') })}>
              Generate resident
            </button>
          </div>
          {idProblem && (
            <span id="user-national-id-error" className="small nafath-field-error" role="alert">
              {idProblem}
            </span>
          )}
        </div>
        <details className="nafath-identity">
          <summary>Nafath identity <span className="hint">optional; empty fields are derived from the name</span></summary>
          <div className="form form-2">
            {IDENTITY_FIELDS.map((f) => {
              const bad = dateProblems.includes(f.key);
              return (
                <label className="field" key={f.key}>
                  {f.label}
                  <input
                    dir={f.dir}
                    value={identityText(identity[f.key])}
                    placeholder={f.placeholder}
                    aria-invalid={bad || undefined}
                    onChange={(e) => setId(f.key, f.key === 'nationalityCode' ? e.target.value.toUpperCase() : e.target.value)}
                  />
                  {bad && <span className="small nafath-field-error">Use dd-MM-yyyy, e.g. 01-07-1990.</span>}
                </label>
              );
            })}
            <label className="field">
              Gender
              <select value={identityText(identity.gender)} onChange={(e) => setId('gender', e.target.value)}>
                <option value="">Derived from the name</option>
                <option value="M">Male (M)</option>
                <option value="F">Female (F)</option>
              </select>
            </label>
            <label className="row">
              <input type="checkbox" checked={identity.isMinor === true} onChange={(e) => setId('isMinor', e.target.checked)} /> Minor (isMinor)
            </label>
          </div>
        </details>
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
          <label className="row" title={KEEP_HELP}>
            <input type="checkbox" checked={form.keep} onChange={set('keep')} /> Keep <span className="hint">shared fixture, never deleted by cleanup</span>
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

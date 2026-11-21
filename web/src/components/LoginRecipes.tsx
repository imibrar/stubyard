import { useState } from 'react';
import type { Authenticator } from '../api';
import { sbApi, issuesOf, toRecipeInput, TWO_FACTOR_KINDS, type LoginRecipe, type LoginRecipeView, type TwoFactorKind } from '../storyboardsApi';
import { ApiError } from '../api';
import { Icon, RoleBadge } from './people';
import { Badge, Empty, ErrorBox, useToast } from './ui';
import { Field, IssueList, Tpl, TplProvider, focusPath, type Issues } from './StoryboardEditor';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TWO_FACTOR_LABEL: Record<TwoFactorKind, string> = { none: 'None', totp: 'Authenticator app (TOTP)', 'email-otp': 'Code by email', 'sms-otp': 'Code by SMS' };

const blank = (role: string): LoginRecipe => ({ role, name: '', loginUrl: '/login', fields: { username: '#email', password: '#password' }, twoFactor: { kind: 'none' }, logoutUrl: null, notes: '' });

/** Login recipes tab: one card per role (configured roles, roles of test users, and roles that already have a recipe). */
export function LoginRecipesPanel({
  slug,
  recipes,
  error,
  roles,
  usersByRole,
  authenticators,
  reload,
}: {
  slug: string;
  recipes: LoginRecipeView[] | null;
  error: string | null;
  roles: string[];
  usersByRole: Record<string, number>;
  authenticators: Authenticator[];
  reload: () => void;
}) {
  const [extra, setExtra] = useState<string[]>([]);
  const [newRole, setNewRole] = useState('');
  const all = [...new Set([...(recipes ?? []).map((r) => r.role), ...roles, ...extra])];
  const add = () => {
    const r = newRole.trim().toLowerCase();
    if (!r) return;
    setExtra((x) => [...x, r]);
    setNewRole('');
  };
  return (
    <div className="stack">
      <div className="card card-pad">
        <p className="small muted" style={{ margin: 0 }}>
          A login recipe tells the extension how a role logs in to your app: the login page, the selectors of the username and password fields, and the second factor. Login steps of storyboards use the recipe of the actor's role.
        </p>
      </div>
      <ErrorBox error={error} />
      {!recipes && !error && <p className="muted">Loading…</p>}
      {recipes && !all.length && <Empty title="No roles yet">Add test users or roles in Settings, or type a role below.</Empty>}
      <TplProvider>
        <div className="sb-recipes">
          {recipes &&
            all.map((role) => (
              <RecipeCard
                key={`${role}:${recipes.find((r) => r.role === role)?.updatedAt ?? ''}`}
                slug={slug}
                role={role}
                recipe={recipes.find((r) => r.role === role) ?? null}
                users={usersByRole[role] ?? 0}
                authenticators={authenticators}
                reload={reload}
              />
            ))}
        </div>
      </TplProvider>
      <div className="card card-pad row sb-add-role">
        <label className="field grow">
          Recipe for another role
          <input value={newRole} onChange={(e) => setNewRole(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="role, e.g. reviewer" />
        </label>
        <button className="btn sm" onClick={add} disabled={!newRole.trim()}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
    </div>
  );
}

function RecipeCard({
  slug,
  role,
  recipe,
  users,
  authenticators,
  reload,
}: {
  slug: string;
  role: string;
  recipe: LoginRecipeView | null;
  users: number;
  authenticators: Authenticator[];
  reload: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<LoginRecipe | null>(recipe ? toRecipeInput(recipe) : null);
  const [saved, setSaved] = useState(() => JSON.stringify(recipe ? toRecipeInput(recipe) : null));
  const [issues, setIssues] = useState<Issues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== saved;

  const set = (patch: Partial<LoginRecipe>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setFields = (k: 'username' | 'password' | 'submit', v: string) =>
    setDraft((d) => {
      if (!d) return d;
      const f = { ...(d.fields ?? {}) };
      if (v) f[k] = v;
      else delete f[k];
      return { ...d, fields: f };
    });
  const set2fa = (patch: Partial<NonNullable<LoginRecipe['twoFactor']>>) =>
    setDraft((d) => {
      if (!d) return d;
      const t = { ...(d.twoFactor ?? { kind: 'none' as const }), ...patch } as Record<string, unknown>;
      for (const k of ['selector', 'authenticator', 'subject']) if (t[k] === '') delete t[k];
      if (t.kind === 'none') return { ...d, twoFactor: { kind: 'none' } };
      if (t.kind === 'totp') delete t.subject;
      else delete t.authenticator;
      return { ...d, twoFactor: t as LoginRecipe['twoFactor'] };
    });

  const save = async () => {
    if (!draft) return;
    setError(null);
    setBusy(true);
    try {
      const v = await sbApi.putRecipe(slug, role, { ...draft, role });
      setIssues(null);
      setSaved(JSON.stringify(toRecipeInput(v)));
      setDraft(toRecipeInput(v));
      toast(`Login recipe for ${role} saved`);
      reload();
    } catch (e) {
      const iss = issuesOf(e);
      setIssues(iss);
      setError(errText(e));
      if (iss?.errors[0]) focusPath(`${role}:${iss.errors[0].path}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!recipe) return setDraft(null);
    if (!confirm(`Delete the login recipe for ${role}?`)) return;
    setError(null);
    try {
      await sbApi.deleteRecipe(slug, role);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409 && confirm(`${e.message}\n\nDelete it anyway?`))) return setError(errText(e));
      try {
        await sbApi.deleteRecipe(slug, role, true);
      } catch (x) {
        return setError(errText(x));
      }
    }
    toast('Login recipe deleted');
    reload();
  };

  const p = (f: string) => `${role}:${f}`;
  const tf = draft?.twoFactor ?? { kind: 'none' as const };
  return (
    <div className="card sb-recipe">
      <div className="card-head">
        <h3 className="row" style={{ gap: 6 }}>
          <RoleBadge role={role} />
          <span className="faint small">
            {users} user{users === 1 ? '' : 's'}
          </span>
          {dirty && draft && <Badge kind="warn">unsaved</Badge>}
        </h3>
        {draft ? (
          <div className="row">
            <button className="btn sm ghost danger" onClick={() => void remove()}>
              {recipe ? 'Delete' : 'Cancel'}
            </button>
            <button className="btn sm primary" onClick={() => void save()} disabled={busy || !dirty}>
              Save
            </button>
          </div>
        ) : (
          <button className="btn sm" onClick={() => setDraft(blank(role))}>
            <Icon name="plus" size={13} /> Add recipe
          </button>
        )}
      </div>
      {!draft ? (
        <p className="muted small card-pad" style={{ margin: 0 }}>
          No login recipe: login steps for {role} actors fail validation.
        </p>
      ) : (
        <div className="card-pad stack">
          <ErrorBox error={error} />
          {issues && <IssueList issues={issues} onPick={(x) => focusPath(p(x))} />}
          <div className="sb-grid">
            <Field label="Login URL" hint="absolute or /path" path="loginUrl" issues={issues}>
              <Tpl value={draft.loginUrl} path={p('loginUrl')} onChange={(v) => set({ loginUrl: v })} placeholder="/login" />
            </Field>
            <Field label="Name" hint="optional" path="name" issues={issues}>
              <input value={draft.name ?? ''} data-path={p('name')} onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </div>
          <div className="sb-grid">
            <Field label="Username field" path="fields.username" issues={issues}>
              <input className="mono" value={draft.fields?.username ?? ''} data-path={p('fields.username')} onChange={(e) => setFields('username', e.target.value)} placeholder="#email" />
            </Field>
            <Field label="Password field" path="fields.password" issues={issues}>
              <input className="mono" value={draft.fields?.password ?? ''} data-path={p('fields.password')} onChange={(e) => setFields('password', e.target.value)} placeholder="#password" />
            </Field>
            <Field label="Submit button" hint="highlighted, never clicked" path="fields.submit" issues={issues}>
              <input className="mono" value={draft.fields?.submit ?? ''} data-path={p('fields.submit')} onChange={(e) => setFields('submit', e.target.value)} placeholder="button[type=submit]" />
            </Field>
          </div>
          <div className="sb-grid">
            <Field label="Second factor" path="twoFactor.kind" issues={issues}>
              <select value={tf.kind} data-path={p('twoFactor.kind')} onChange={(e) => set2fa({ kind: e.target.value as TwoFactorKind, ...(e.target.value === 'none' ? {} : { selector: tf.selector ?? '#code' }) })}>
                {TWO_FACTOR_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TWO_FACTOR_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            {tf.kind !== 'none' && (
              <Field label="Code field" path="twoFactor.selector" issues={issues}>
                <input className="mono" value={tf.selector ?? ''} data-path={p('twoFactor.selector')} onChange={(e) => set2fa({ selector: e.target.value })} placeholder="#code" />
              </Field>
            )}
            {tf.kind === 'totp' && (
              <Field label="Authenticator" hint="empty: the key linked to the user" path="twoFactor.authenticator" issues={issues}>
                <input value={tf.authenticator ?? ''} list="sb-authenticators" data-path={p('twoFactor.authenticator')} onChange={(e) => set2fa({ authenticator: e.target.value })} />
              </Field>
            )}
            {(tf.kind === 'email-otp' || tf.kind === 'sms-otp') && (
              <Field label="Subject filter" hint="optional" path="twoFactor.subject" issues={issues}>
                <input value={tf.subject ?? ''} data-path={p('twoFactor.subject')} onChange={(e) => set2fa({ subject: e.target.value })} placeholder="Your login code" />
              </Field>
            )}
          </div>
          <datalist id="sb-authenticators">
            {authenticators.map((a) => (
              <option key={a.id} value={a.label} />
            ))}
          </datalist>
          <div className="sb-grid">
            <Field label="Logout URL" hint="optional" path="logoutUrl" issues={issues}>
              <Tpl value={draft.logoutUrl ?? ''} path={p('logoutUrl')} onChange={(v) => set({ logoutUrl: v || null })} placeholder="/logout" />
            </Field>
            <Field label="Notes" path="notes" issues={issues}>
              <input value={draft.notes ?? ''} data-path={p('notes')} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type LogSummary, type LoginClient, type LoginPresets, type LoginProvider, type LoginRule, type LoginUrls, type TestUser } from '../api';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Icon } from './people';
import { ConnectHostSwitch, CopyUrl, DetailHead, InstanceRow, SectionTabs, providersPath, useConnectHost, useSection } from './providerLayout';
import { Badge, CodeBlock, OUTCOME_KIND, timeAgo, useCopy, useToast } from './ui';
import '../styles/auth.css';

/**
 * Login tab of the Providers page: fake Google / Microsoft / GitHub / … OAuth & OIDC providers under
 * /auth/<project>/<provider>/. `LoginProviderRow` is the compact list entry, `LoginProviderDetail` the detail column
 * (URLs and snippets, strict mode, clients, scenario rules, key rotation, "Get token as…", recent traffic).
 */
export function useLoginProviders(slug: string) {
  const list = useFetch<LoginProvider[]>(`/api/projects/${slug}/auth`, [slug]);
  const presets = useFetch<LoginPresets>('/api/auth-presets');
  const reload = useDebounced(() => void list.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'auth.changed' || e.type === 'user.changed') reload();
  });
  return { providers: list.data, error: list.error, presets: presets.data, reload };
}

export const OIDC_FLAVORS = ['generic', 'auth0', 'okta', 'keycloak', 'cognito'];

/** POST /api/projects/:slug/auth with a free slug (google, google-2, …) unless one is given. */
export async function createLoginProvider(slug: string, preset: string, flavor: string, existing: string[], wanted?: string): Promise<LoginProvider> {
  const id = preset === 'oidc' && flavor !== 'generic' ? flavor : preset;
  let s = wanted?.trim() || id;
  if (!wanted?.trim()) for (let i = 2; existing.includes(s); i++) s = `${id}-${i}`;
  return api.post<LoginProvider>(`/api/projects/${slug}/auth`, { preset: id, slug: s });
}

const mainUrl = (p: LoginProvider) => (p.protocol === 'oidc' ? p.urls.backend.issuer : p.urls.browser.authorize);

export function LoginProviderRow({ slug, p, active, category = 'login' }: { slug: string; p: LoginProvider; active: boolean; /** Providers-page category id (URL segment). */ category?: string }) {
  const activeRules = p.rules.filter((r) => r.active).length;
  return (
    <InstanceRow
      to={providersPath(slug, category, p.slug)}
      active={active}
      title={p.name}
      status={
        <>
          {activeRules > 0 && <Badge kind="warn">{activeRules} scenario{activeRules > 1 ? 's' : ''}</Badge>}
          {!p.enabled && <Badge kind="bad">disabled</Badge>}
        </>
      }
      meta={
        <>
          <Badge>{p.presetName}</Badge>
          <Badge>{p.protocol === 'oidc' ? 'OIDC' : 'OAuth 2'}</Badge>
          {p.config.strict && <Badge kind="accent">strict</Badge>}
          <code className="faint small">{p.slug}</code>
        </>
      }
      url={<CopyUrl url={mainUrl(p)} label={p.protocol === 'oidc' ? 'Issuer copied' : 'URL copied'} />}
    />
  );
}

const LOGIN_SECTIONS = ['connect', 'settings', 'scenarios', 'token', 'traffic'] as const;
const LOGIN_SECTION_LABEL = { connect: 'Connect', settings: 'Settings & keys', scenarios: 'Scenarios', token: 'Get token', traffic: 'Recent requests' };

export function LoginProviderDetail({
  slug,
  p,
  users,
  presets,
  reload,
  onDeleted,
  category = 'login',
}: {
  slug: string;
  p: LoginProvider;
  users: TestUser[];
  presets: LoginPresets | null;
  reload: () => void;
  onDeleted: () => void;
  /** Providers-page category id (URL segment). */
  category?: string;
}) {
  const toast = useToast();
  const [section, setSection] = useSection(LOGIN_SECTIONS);
  const base = `/api/projects/${slug}/auth/${p.slug}`;
  const call = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete login provider "${p.name}"? Apps configured with its URLs will stop working.`)) return;
    await call(() => api.del(base), 'Login provider deleted');
    onDeleted();
  };
  const activeRules = p.rules.filter((r) => r.active).length;
  return (
    <>
      <DetailHead
        backTo={providersPath(slug, category)}
        icon={<Icon name="key" size={16} />}
        title={p.name}
        sub={
          <>
            <code>{p.slug}</code>
            <span>
              {p.presetName} · {p.protocol === 'oidc' ? 'OpenID Connect' : 'OAuth 2'}
            </span>
          </>
        }
        badges={
          <>
            {p.config.flavor && p.config.flavor !== 'generic' && <Badge>{p.config.flavor}</Badge>}
            {p.config.strict ? <Badge kind="accent">strict</Badge> : <Badge title="Problems are warnings, not errors">lax</Badge>}
            {p.config.autoLogin && <Badge kind="warn">auto-login {users.find((u) => u.id === p.config.autoLogin)?.name ?? p.config.autoLogin}</Badge>}
            {activeRules > 0 && <Badge kind="warn">{activeRules} active scenario{activeRules > 1 ? 's' : ''}</Badge>}
            {p.enabled ? <Badge kind="ok">enabled</Badge> : <Badge kind="bad">disabled (503)</Badge>}
          </>
        }
        actions={
          <>
            <button className="btn sm" onClick={() => call(() => api.patch(base, { enabled: !p.enabled }), p.enabled ? 'Disabled' : 'Enabled')}>
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn sm ghost danger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        }
        sections={<SectionTabs sections={LOGIN_SECTIONS} labels={LOGIN_SECTION_LABEL} current={section} onChange={setSection} extra={{ scenarios: activeRules > 0 ? <span className="tab-n">{activeRules}</span> : null }} />}
      >
        <dl className="kv prov-facts">
          <dt>{p.protocol === 'oidc' ? 'Issuer' : 'Authorize'}</dt>
          <dd>
            <CopyUrl url={mainUrl(p)} label={p.protocol === 'oidc' ? 'Issuer copied' : 'URL copied'} className="prov-url-full" />
          </dd>
        </dl>
      </DetailHead>
      <div className="lp-body prov-body">
        {section === 'connect' && (
          <>
            <UrlsPanel p={p} />
            <SnippetsPanel p={p} />
          </>
        )}
        {section === 'settings' && (
          <>
            <SettingsPanel key={p.id} p={p} base={base} users={users} call={call} />
            <ClientsPanel key={`c-${p.id}`} p={p} base={base} call={call} />
            <KeysPanel p={p} base={base} call={call} />
          </>
        )}
        {section === 'scenarios' && <RulesPanel p={p} base={base} users={users} presets={presets} call={call} />}
        {section === 'token' && <TokenPanel key={p.id} p={p} base={base} users={users} />}
        {section === 'traffic' && <TrafficPanel slug={slug} p={p} base={base} />}
      </div>
    </>
  );
}

function UrlsPanel({ p }: { p: LoginProvider }) {
  const [which, setWhich] = useConnectHost();
  const copy = useCopy();
  const u: LoginUrls = p.urls[which];
  const rows: [string, string | null][] = [
    ['Issuer', p.protocol === 'oidc' ? u.issuer : null],
    ['Discovery', u.discovery],
    ['Authorize', u.authorize],
    ['Token', u.token],
    ['Userinfo', u.userinfo],
    ['JWKS', u.jwks],
    ['Revoke', u.revoke],
    ['Logout', u.logout],
  ];
  return (
    <div className="card lp-span">
      <div className="card-head">
        <h3>URLs</h3>
        <ConnectHostSwitch value={which} onChange={setWhich} />
      </div>
      <dl className="kv wide">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="lp-kv">
              <dt>{k}</dt>
              <dd>
                <button className="cred lp-cred-full" onClick={() => copy(v!, `${k} copied`)} title="Copy">
                  <span className="ellipsis">{v}</span>
                  <Icon name="copy" size={12} />
                </button>
              </dd>
            </div>
          ))}
      </dl>
      <p className="small faint lp-note">
        Discovery, token, userinfo and JWKS follow the Host the app calls (request-host mode); the authorize and logout URLs always point at the browser base. Use "fixed" issuer mode
        when one URL must work from both sides.
      </p>
    </div>
  );
}

/** Config keys edited by their own controls (the rest is shown as JSON). */
const OWN_FIELDS = ['strict', 'issuerMode', 'issuer', 'issOverride', 'browserBaseUrl', 'autoLogin', 'clients'];

function SettingsPanel({ p, base, users, call }: { p: LoginProvider; base: string; users: TestUser[]; call: (fn: () => Promise<unknown>, msg?: string) => void }) {
  const [mode, setMode] = useState(p.config.issuerMode ?? 'request-host');
  const [issuer, setIssuer] = useState(p.config.issuer ?? '');
  const [issOverride, setIssOverride] = useState(p.config.issOverride ?? '');
  const [browser, setBrowser] = useState(p.config.browserBaseUrl ?? '');
  const [auto, setAuto] = useState(p.config.autoLogin ?? '');
  const [extra, setExtra] = useState(() => JSON.stringify(Object.fromEntries(Object.entries(p.config).filter(([k]) => !OWN_FIELDS.includes(k))), null, 2));
  const save = () => {
    let more: Record<string, unknown>;
    try {
      more = extra.trim() ? JSON.parse(extra) : {};
    } catch {
      return call(async () => {
        throw new Error('Advanced config is not valid JSON');
      });
    }
    call(
      () =>
        api.patch(base, {
          config: { ...more, issuerMode: mode, issuer: issuer.trim() || null, issOverride: issOverride.trim() || null, browserBaseUrl: browser.trim() || null, autoLogin: auto || null },
        }),
      'Settings saved',
    );
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Settings</h3>
        <button className="btn sm primary" onClick={save}>
          Save
        </button>
      </div>
      <div className="card-pad form">
        <label className="row lp-check">
          <input type="checkbox" checked={!!p.config.strict} onChange={(e) => call(() => api.patch(base, { config: { strict: e.target.checked } }), e.target.checked ? 'Strict: problems are real errors' : 'Lax: problems are warnings')} />
          <span>
            Strict mode <span className="hint">unknown client, wrong secret, missing state / nonce / PKCE fail like in production</span>
          </span>
        </label>
        <label className="field">
          Issuer mode
          <select value={mode} onChange={(e) => setMode(e.target.value as 'request-host' | 'fixed')}>
            <option value="request-host">request-host (default)</option>
            <option value="fixed">fixed</option>
          </select>
        </label>
        {mode === 'fixed' && (
          <label className="field">
            Issuer base <span className="hint">e.g. https://host.docker.internal:4443 — must resolve from the browser and the app</span>
            <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://host.docker.internal:4443" />
          </label>
        )}
        <label className="field">
          Literal iss <span className="hint">only for apps that hardcode it (e.g. https://accounts.google.com)</span>
          <input value={issOverride} onChange={(e) => setIssOverride(e.target.value)} />
        </label>
        <label className="field">
          Browser base <span className="hint">default STUBYARD_PUBLIC_URL / https://localhost:4443</span>
          <input value={browser} onChange={(e) => setBrowser(e.target.value)} placeholder="https://localhost:4443" />
        </label>
        <label className="field">
          Auto-login <span className="hint">skip the account picker</span>
          <select value={auto} onChange={(e) => setAuto(e.target.value)}>
            <option value="">— show the picker —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Advanced config (JSON) <span className="hint">flavor, accessTokenTtl, refresh, rotateRefresh, extraClaims, audience, tenantId, teamId…</span>
          <textarea className="mono" rows={4} value={extra} onChange={(e) => setExtra(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

function ClientsPanel({ p, base, call }: { p: LoginProvider; base: string; call: (fn: () => Promise<unknown>, msg?: string) => void }) {
  const [clients, setClients] = useState<LoginClient[]>(() => p.config.clients ?? []);
  const set = (i: number, patch: Partial<LoginClient>) => setClients(clients.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const save = () =>
    call(
      () => api.patch(base, { config: { clients: clients.filter((c) => c.clientId.trim()).map((c) => ({ ...c, clientId: c.clientId.trim(), redirectUris: (c.redirectUris ?? []).map((u) => u.trim()).filter(Boolean) })) } }),
      'Clients saved',
    );
  return (
    <div className="card">
      <div className="card-head">
        <h3>Clients</h3>
        <div className="row">
          <button className="btn sm ghost" onClick={() => setClients([...clients, { clientId: `app-${clients.length + 1}`, clientSecret: 'secret', redirectUris: ['http://localhost:3000/callback'] }])}>
            <Icon name="plus" size={13} /> Client
          </button>
          <button className="btn sm primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
      <div className="card-pad form">
        {clients.length === 0 && <p className="small faint lp-flat">No clients registered: any client_id and secret is accepted (lax). Register clients to get warnings — or, in strict mode, errors — for wrong ones.</p>}
        {clients.map((c, i) => (
          <div key={i} className="lp-client">
            <div className="form-2">
              <label className="field">
                client_id
                <input value={c.clientId} onChange={(e) => set(i, { clientId: e.target.value })} />
              </label>
              <label className="field">
                client_secret
                <input value={c.clientSecret ?? ''} onChange={(e) => set(i, { clientSecret: e.target.value || null })} placeholder="(public client)" />
              </label>
            </div>
            <label className="field">
              Redirect URIs <span className="hint">one per line</span>
              <textarea className="mono" rows={2} value={(c.redirectUris ?? []).join('\n')} onChange={(e) => set(i, { redirectUris: e.target.value.split('\n') })} />
            </label>
            <button className="btn xs ghost danger" onClick={() => setClients(clients.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const ACTION_HINT: Record<string, string> = {
  access_denied: 'User clicks "Cancel"',
  login_required: 'prompt=none style error',
  mfa_required: 'Returned as interaction_required',
  state_mismatch: 'Callback carries a different state',
  invalid_grant: 'Token endpoint rejects the code / refresh token',
  expired_code: 'Code exchange says the code expired',
  invalid_client: '401 invalid_client',
  no_refresh_token: 'Token response without refresh_token',
  short_lived: 'Access token expires after ttl seconds',
  no_email: 'No email claim',
  email_unverified: 'email_verified=false',
  private_email: 'GitHub: hidden public email · Apple: relay address',
  bad_signature: 'id_token signature does not verify',
  wrong_aud: 'id_token aud is another client',
  wrong_iss: 'id_token iss is another issuer',
  wrong_nonce: 'id_token nonce does not match',
  expired_id_token: 'id_token exp in the past',
  unknown_kid: 'id_token kid not in JWKS',
  slow: 'Answer after delayMs',
  timeout: 'Never answer',
  down: '503',
  rate_limit: '429 with Retry-After',
};

function RulesPanel({ p, base, users, presets, call }: { p: LoginProvider; base: string; users: TestUser[]; presets: LoginPresets | null; call: (fn: () => Promise<unknown>, msg?: string) => void }) {
  const [action, setAction] = useState('access_denied');
  const [stage, setStage] = useState('any');
  const [user, setUser] = useState('');
  const [count, setCount] = useState('1');
  const [num, setNum] = useState('');
  const groups = presets?.actions ?? {};
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? id) : 'everyone');
  const add = () =>
    call(
      () =>
        api.post(user ? `${base}/users/${user}/rules` : `${base}/rules`, {
          action,
          stage,
          count: count ? Number(count) : null,
          ...(action === 'slow' ? { delayMs: Number(num || 2000) } : {}),
          ...(action === 'short_lived' ? { ttl: Number(num || 5) } : {}),
        }),
      'Scenario added',
    );
  const del = (r: LoginRule) => call(() => api.del(`${base}/rules/${r.id}`));
  return (
    <div className="card">
      <div className="card-head">
        <h3>Scenarios</h3>
        {p.rules.length > 0 && (
          <button className="btn sm ghost" onClick={() => call(() => api.del(`${base}/all-rules`), 'All scenarios removed')}>
            Reset all
          </button>
        )}
      </div>
      {p.rules.length === 0 ? (
        <p className="small faint card-pad lp-flat">Logins behave normally. Add a scenario to make the next login fail, return odd claims or broken tokens.</p>
      ) : (
        <div>
          {p.rules.map((r) => (
            <div key={r.id} className={`rule-row lp-rule ${r.active ? '' : 'faint'}`}>
              <code>{r.action}</code>
              <span className="small muted">
                {name(r.testUserId)} · {r.stage}
                {r.remainingCount !== null ? ` · next ${r.remainingCount}` : ' · always'}
                {r.hits ? ` · hit ${r.hits}×` : ''}
                {!r.active && ' · inactive'}
              </span>
              <button className="btn xs ghost danger" onClick={() => del(r)} aria-label="Delete scenario">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="card-pad form">
        <label className="field">
          Scenario <span className="hint">{ACTION_HINT[action]}</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(groups).map(([g, list]) => (
              <optgroup key={g} label={g}>
                {list.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="form-3">
          <label className="field">
            Who
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">everyone</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Stage
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              {(presets?.stages ?? ['any']).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Times <span className="hint">empty = always</span>
            <input value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
          </label>
        </div>
        {(action === 'slow' || action === 'short_lived') && (
          <label className="field">
            {action === 'slow' ? 'Delay (ms)' : 'Access token lifetime (s)'}
            <input value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={action === 'slow' ? '2000' : '5'} />
          </label>
        )}
        <div className="row">
          <button className="btn sm primary" onClick={add}>
            Add scenario
          </button>
          <span className="small faint">Per request: X-Hub-Scenario header or hub_scenario=… on the authorize URL.</span>
        </div>
      </div>
    </div>
  );
}

function decode(jwt: string | undefined): unknown {
  if (!jwt || jwt.split('.').length !== 3) return null;
  try {
    return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function TokenPanel({ p, base, users }: { p: LoginProvider; base: string; users: TestUser[] }) {
  const toast = useToast();
  const [user, setUser] = useState(users[0]?.id ?? '');
  const [scope, setScope] = useState('');
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  const get = async () => {
    try {
      setOut(await api.post(`${base}/token`, { user, scope: scope.trim() || undefined }));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const claims = useMemo(() => decode(out?.id_token as string | undefined), [out]);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Get token as…</h3>
      </div>
      <div className="card-pad form">
        <div className="form-2">
          <label className="field">
            Test user
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Scope <span className="hint">default for {p.presetName}</span>
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="openid email profile" />
          </label>
        </div>
        <div className="row">
          <button className="btn sm primary" onClick={get} disabled={!user}>
            Get token
          </button>
          <span className="small faint">POST {base}/token — same tokens the token endpoint issues.</span>
        </div>
        {out && <CodeBlock title="Token response" code={JSON.stringify({ ...out, claims: undefined }, null, 2)} />}
        {claims !== null && <CodeBlock title="id_token claims" code={JSON.stringify(claims, null, 2)} />}
      </div>
    </div>
  );
}

function KeysPanel({ p, base, call }: { p: LoginProvider; base: string; call: (fn: () => Promise<unknown>, msg?: string) => void }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Signing keys</h3>
        <div className="row">
          <button className="btn sm ghost" onClick={() => call(() => api.post(`${base}/keys/rotate`, {}), 'Key rotated (old key still in JWKS)')}>
            Rotate
          </button>
          <button className="btn sm ghost danger" onClick={() => confirm('Rotate and drop the old keys? Tokens signed with them stop verifying.') && call(() => api.post(`${base}/keys/rotate`, { dropOld: true }), 'Key rotated, old keys dropped')}>
            Rotate & drop old
          </button>
        </div>
      </div>
      <div className="card-pad">
        {p.keys.map((k) => (
          <div key={k.kid} className="row lp-key">
            <code className="ellipsis">{k.kid}</code>
            <Badge kind={k.status === 'active' ? 'ok' : undefined}>{k.status}</Badge>
            <span className="small faint">{k.alg} · {timeAgo(k.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrafficPanel({ slug, p, base }: { slug: string; p: LoginProvider; base: string }) {
  const path = `/api/logs${qs({ project: slug, q: `/auth/${slug}/${p.slug}/`, limit: 12 })}`;
  const logs = useFetch<LogSummary[]>(path, [path]);
  const warnings = useFetch<{ logId: string; at: string; endpoint: string | null; warnings: string[] }[]>(`${base}/warnings`, [base]);
  const reload = useDebounced(() => {
    void logs.reload();
    void warnings.reload();
  }, 400);
  useHubEvents(slug, (e) => {
    if (e.type === 'log.created' || e.type === 'log.updated') reload();
  });
  const recentWarnings = [...new Set((warnings.data ?? []).slice(0, 10).flatMap((w) => w.warnings))].slice(0, 6);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Recent requests</h3>
        <Link to={`/p/${slug}/traffic`} className="btn sm ghost">
          Traffic log <Icon name="external" size={12} />
        </Link>
      </div>
      {recentWarnings.length > 0 && (
        <ul className="lp-warnings small">
          {recentWarnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {(logs.data ?? []).length === 0 ? (
        <p className="small faint card-pad lp-flat">No requests yet.</p>
      ) : (
        <div className="lp-logs">
          {(logs.data ?? []).map((l) => (
            <div key={l.id} className="row nowrap lp-log">
              <Badge kind={OUTCOME_KIND[l.outcome]}>{l.resStatus ?? l.outcome}</Badge>
              <code className="ellipsis grow">
                {l.method} {(l.url ?? '').replace(`/auth/${slug}/${p.slug}`, '')}
              </code>
              <span className="small faint">{timeAgo(l.receivedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SnippetsPanel({ p }: { p: LoginProvider }) {
  return (
    <div className="card lp-span">
      <div className="card-head">
        <h3>Connect your app</h3>
      </div>
      <div className="card-pad lp-snippets">
        {p.snippets.map((s) => (
          <details key={s.title} className="lp-snippet">
            <summary>{s.title}</summary>
            <CodeBlock code={s.code} lang={s.language} />
          </details>
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { roleLabel, roleOptions, tokensApi, useAuth, type ApiToken, type ProjectRole, type TokenScope } from '../auth';
import { useProjects } from '../context';
import { DataTable, PageHeader, Section, StatusBadge, type Column } from '../components/layout';
import { Icon } from '../components/people';
import { Empty, ErrorBox, fmtDateTime, Modal, timeAgo, useCopy, useToast } from '../components/ui';

const EXPIRY = [
  { days: 0, label: 'Never' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

/** /account/tokens: personal API tokens for the browser extension, @stubyard/client, MCP clients and CI. */
export default function ApiTokensPage() {
  const auth = useAuth();
  const toast = useToast();
  const copy = useCopy();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: ApiToken; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  // Teams: "Narrow this token" (chosen projects, highest role).
  const { projects: allProjects } = useProjects();
  const teams = auth.mode === 'teams';
  const isAdmin = auth.user?.role === 'admin';
  const [narrow, setNarrow] = useState(false);
  const [scopeProjects, setScopeProjects] = useState<string[]>([]);
  const [maxRole, setMaxRole] = useState<ProjectRole | 'admin' | ''>('');
  const myProjects = (allProjects ?? []).filter((p) => isAdmin || !!auth.projects?.[p.slug]);
  const nameOf = (slug: string) => allProjects?.find((p) => p.slug === slug)?.name ?? slug;

  const reload = useCallback(async () => {
    try {
      setTokens(await tokensApi.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const scope: TokenScope | undefined =
        teams && narrow ? { ...(scopeProjects.length ? { projects: scopeProjects } : {}), ...(maxRole ? { maxRole } : {}) } : undefined;
      const r = await tokensApi.create(name.trim(), days || undefined, scope);
      setCreated(r);
      setName('');
      setNarrow(false);
      setScopeProjects([]);
      setMaxRole('');
      void reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: ApiToken) => {
    setBusy(true);
    try {
      await tokensApi.revoke(t.id);
      toast(`Revoked "${t.name}"`);
      setRevoking(null);
      void reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ApiToken>[] = [
    {
      key: 'name',
      header: 'Name',
      fill: true,
      render: (t) => (
        <span className="token-name">
          <strong className="ellipsis">{t.name}</strong>
          <code className="muted">{t.prefix}…</code>
        </span>
      ),
    },
    ...(teams
      ? [
          {
            key: 'scope',
            header: 'Scope',
            priority: 2 as const,
            render: (t: ApiToken) => (
              <span className="small token-scope" title={t.projects?.length ? t.projects.map(nameOf).join(', ') : undefined}>
                {t.projects?.length ? (t.projects.length === 1 ? nameOf(t.projects[0]) : `${t.projects.length} projects`) : <span className="muted">All my projects</span>}
                {t.maxRole && <span className="muted"> · up to {roleLabel(t.maxRole, auth)}</span>}
              </span>
            ),
          },
        ]
      : []),
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status === 'active' ? 'ok' : t.status === 'expired' ? 'warn' : 'neutral'}>{t.status === 'active' ? 'Active' : t.status === 'expired' ? 'Expired' : 'Revoked'}</StatusBadge> },
    { key: 'created', header: 'Created', priority: 2, render: (t) => <span className="nowrap" title={fmtDateTime(t.createdAt)}>{timeAgo(t.createdAt)}</span> },
    { key: 'used', header: 'Last used', priority: 2, render: (t) => (t.lastUsedAt ? <span className="nowrap" title={fmtDateTime(t.lastUsedAt)}>{timeAgo(t.lastUsedAt)}</span> : <span className="muted">never</span>) },
    { key: 'expires', header: 'Expires', priority: 3, render: (t) => (t.expiresAt ? <span className="nowrap" title={fmtDateTime(t.expiresAt)}>{new Date(t.expiresAt).toLocaleDateString()}</span> : <span className="muted">never</span>) },
  ];

  const active = tokens?.filter((t) => t.status === 'active') ?? [];
  const inactive = tokens?.filter((t) => t.status !== 'active') ?? [];

  return (
    <div className="stack api-tokens-page">
      <PageHeader
        title="API tokens"
        crumbs={[{ label: 'Account' }, { label: 'API tokens' }]}
        description={`Signed in as ${auth.user?.email ?? ''}. Tokens let the browser extension, @stubyard/client, MCP clients and CI call stubyard (Authorization: Bearer <token>).`}
      />
      <Section title="New token" description="The token is shown once, right after you create it. Store it where the tool reads it (extension Settings, STUBYARD_TOKEN, your MCP config).">
        <form
          className="form token-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={80} placeholder="e.g. Chrome extension, CI, Claude Code" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Expires</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY.map((x) => (
                <option key={x.days} value={x.days}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            <Icon name="key" size={14} /> Create token
          </button>
          {teams && (
            <div className="token-narrow">
              <label className="token-narrow-toggle">
                <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} />
                <span>
                  Narrow this token <span className="muted small">Fewer projects or a lower role than your own; it never gets more than you have.</span>
                </span>
              </label>
              {narrow && (
                <div className="token-narrow-body">
                  <fieldset className="token-projects">
                    <legend className="small">Projects {scopeProjects.length === 0 && <span className="muted">(none ticked: all my projects)</span>}</legend>
                    {myProjects.length === 0 ? (
                      <p className="muted small" style={{ margin: 0 }}>
                        You are not a member of any project yet.
                      </p>
                    ) : (
                      myProjects.map((p) => (
                        <label key={p.slug} className="token-project">
                          <input
                            type="checkbox"
                            checked={scopeProjects.includes(p.slug)}
                            onChange={(e) => setScopeProjects(e.target.checked ? [...scopeProjects, p.slug] : scopeProjects.filter((s) => s !== p.slug))}
                          />
                          <span className="ellipsis">{p.name}</span>
                          {!isAdmin && auth.projects?.[p.slug] && <span className="muted small">{roleLabel(auth.projects[p.slug], auth)}</span>}
                        </label>
                      ))
                    )}
                  </fieldset>
                  <label className="field">
                    <span>Highest role</span>
                    <select value={maxRole} onChange={(e) => setMaxRole(e.target.value as ProjectRole | 'admin' | '')}>
                      <option value="">My own roles</option>
                      {isAdmin && <option value="admin">Admin</option>}
                      {roleOptions(auth).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}
        </form>
        <ErrorBox error={error} />
      </Section>
      <Section title={`Active tokens${tokens ? ` (${active.length})` : ''}`} pad={false}>
        {!tokens ? (
          <p className="muted card-pad">Loading…</p>
        ) : (
          <DataTable
            caption="Active API tokens"
            columns={columns}
            rows={active}
            rowKey={(t) => t.id}
            empty={<Empty title="No tokens yet">Create one above for each tool that talks to stubyard.</Empty>}
            rowMenu={(t) => (
              <button type="button" className="btn danger sm" onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`}>
                Revoke
              </button>
            )}
          />
        )}
      </Section>
      {inactive.length > 0 && (
        <Section title={`Revoked and expired (${inactive.length})`} pad={false}>
          <DataTable caption="Revoked and expired API tokens" columns={columns} rows={inactive} rowKey={(t) => t.id} />
        </Section>
      )}

      {created && (
        <Modal
          title="Copy your new token"
          onClose={() => setCreated(null)}
          footer={
            <button type="button" className="btn primary" onClick={() => setCreated(null)}>
              Done
            </button>
          }
        >
          <div className="stack">
            <p>
              This is the only time stubyard shows <strong>{created.token.name}</strong>. Copy it now; if you lose it, revoke it and create a new one.
            </p>
            <div className="token-secret">
              <code className="mono" data-testid="new-token-secret">
                {created.secret}
              </code>
              <button type="button" className="btn primary sm" onClick={() => void copy(created.secret, 'Token copied')}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
            <p className="muted small">
              Use it as <code>Authorization: Bearer {created.token.prefix}…</code>, in the browser extension's Settings → API token, or as <code>STUBYARD_TOKEN</code> for @stubyard/client.
            </p>
          </div>
        </Modal>
      )}
      {revoking && (
        <Modal
          title={`Revoke "${revoking.name}"?`}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRevoking(null)}>
                Cancel
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void revoke(revoking)}>
                Revoke token
              </button>
            </>
          }
        >
          <p>Anything still using it gets 401 at once. This cannot be undone.</p>
        </Modal>
      )}
    </div>
  );
}

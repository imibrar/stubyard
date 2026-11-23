import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BundlePanel } from '../components/BundleImport';
import { CleanupStatusBadge, CleanupTab, ModePill } from '../components/Cleanup';
import { DataSetsPanel, FromSnapshotModal } from '../components/DataSetEditor';
import { LoginRecipesPanel } from '../components/LoginRecipes';
import { Icon, knownRoles } from '../components/people';
import { StoryboardEditor, type EditorContext } from '../components/StoryboardEditor';
import { Badge, Drawer, Empty, ErrorBox, fmtDateTime, timeAgo, useTick, useToast } from '../components/ui';
import { WalkthroughDrawer } from '../components/WalkthroughDrawer';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  sbApi,
  sbPaths,
  toStoryboardInput,
  VERDICT_KIND,
  WT_STATUS_KIND,
  type DataSetView,
  type LoginRecipeView,
  type PageSnapshotBrief,
  type PageSnapshotView,
  type Storyboard,
  type StoryboardBrief,
  type StoryboardSchemaDoc,
  type CleanupList,
  type StoryboardView,
  type WalkthroughBrief,
} from '../storyboardsApi';
import { Tabs } from '../components/layout';
import { resolveTab, STORYBOARD_LIBRARY, STORYBOARD_TABS } from '../nav';
import { Page } from './ProjectPage';
import '../styles/storyboards.css';

/** Views of the page. The tab strip has 4 (nav.ts STORYBOARD_TABS); the library views are a segmented control; bundle is a header action. */
type Tab = 'storyboards' | 'data-sets' | 'recipes' | 'snapshots' | 'walkthroughs' | 'cleanup' | 'bundle';
type LibView = 'data-sets' | 'recipes' | 'snapshots';
const LIB_VIEWS = STORYBOARD_LIBRARY.map((t) => t.id) as LibView[];

/** ?tab= (+ ?lib=) to a view. Old ids (?tab=data-sets|recipes|snapshots|bundle) keep working; unknown values show the list. */
function viewOf(params: URLSearchParams): Tab {
  const raw = params.get('tab');
  if (raw === 'bundle') return 'bundle';
  const r = resolveTab(STORYBOARD_TABS, raw);
  if (r.id === 'library') {
    const lib = (r.params.lib ?? params.get('lib')) as LibView | null;
    return lib && LIB_VIEWS.includes(lib) ? lib : 'data-sets';
  }
  return r.id as Tab;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** /p/:slug/storyboards — manual test walkthroughs: storyboards, data sets, login recipes, snapshots, walkthroughs, bundles. */
export default function StoryboardsPage() {
  const { slug, overview } = useProject();
  const [params, setParams] = useSearchParams();
  const tab: Tab = viewOf(params);
  const isLib = (LIB_VIEWS as string[]).includes(tab);
  const stripValue = isLib ? 'library' : tab;
  const setParam = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) n.delete(k);
          else n.set(k, v);
        }
        return n;
      },
      { replace: false },
    );
  const setTab = (t: Tab) =>
    setParam((LIB_VIEWS as string[]).includes(t) ? { tab: 'library', lib: t === 'data-sets' ? null : t, edit: null, wt: null } : { tab: t === 'storyboards' ? null : t, lib: null, edit: null, wt: null });
  const setStrip = (id: string) => setTab(id === 'library' ? 'data-sets' : (id as Tab));

  const storyboards = useFetch<StoryboardBrief[]>(sbPaths.storyboards(slug), [slug]);
  const dataSets = useFetch<DataSetView[]>(sbPaths.dataSets(slug), [slug]);
  const recipes = useFetch<LoginRecipeView[]>(sbPaths.recipes(slug), [slug]);
  const snapshots = useFetch<PageSnapshotBrief[]>(`${sbPaths.snapshots(slug)}?limit=200`, [slug]);
  const schema = useFetch<StoryboardSchemaDoc>('/api/storyboard-schema', []);
  const reloadAuthoring = useDebounced(() => {
    void storyboards.reload();
    void dataSets.reload();
    void recipes.reload();
    void snapshots.reload();
  }, 200);
  // Only for the Cleanup tab's count; the tab fetches its own list.
  const cleanup = useFetch<CleanupList>(`${sbPaths.cleanup(slug)}?status=pending`, [slug]);
  const reloadBriefs = useDebounced(() => (void storyboards.reload(), void cleanup.reload()), 300);
  useHubEvents(slug, (e) => {
    if (e.type === 'storyboards.changed' || e.type === 'project.reset') (reloadAuthoring(), reloadBriefs());
    else if (e.type === 'walkthrough.changed' || e.type === 'user.changed') reloadBriefs();
  });

  const users = overview.users;
  const settingsRoles = overview.project.settings.roles;
  const ctx: EditorContext = useMemo(
    () => ({
      slug,
      users,
      roles: knownRoles(users, settingsRoles),
      dataSets: (dataSets.data ?? []).map((d) => d.slug),
      recipes: (recipes.data ?? []).map((r) => r.role),
      variables: schema.data?.variables ?? [],
    }),
    [slug, users, settingsRoles, dataSets.data, recipes.data, schema.data],
  );
  const usersByRole = useMemo(() => {
    const m: Record<string, number> = {};
    for (const u of users) m[u.role] = (m[u.role] ?? 0) + 1;
    return m;
  }, [users]);
  const recipeRoles = useMemo(() => [...new Set([...(settingsRoles ?? []), ...users.map((u) => u.role)])], [settingsRoles, users]);
  const counts: Partial<Record<Tab, number | undefined>> = {
    storyboards: storyboards.data?.length,
    'data-sets': dataSets.data?.length,
    recipes: recipes.data?.length,
    snapshots: snapshots.data?.length,
    cleanup: cleanup.data?.counts.pending,
  };
  const edit = tab === 'storyboards' ? params.get('edit') : null;
  const noOrigins = !(overview.project.settings.appOrigins ?? []).length;
  const noDefaultPassword = !overview.project.settings.defaultPassword?.trim();
  const freshBoards = noDefaultPassword ? (storyboards.data ?? []).filter((s) => s.actors.some((a) => a.fresh)) : [];

  return (
    <Page
      title="Storyboards"
      description="Manual test walkthroughs for your app: ordered steps (open, log in, fill a form from a data set, wait for an email, check). A tester runs them with the stubyard browser extension; results, notes and screenshots land in Walkthroughs."
      secondary={[
        <button key="bundle" className={`btn ${tab === 'bundle' ? 'primary' : ''}`} onClick={() => setTab('bundle')} aria-pressed={tab === 'bundle'}>
          Import / export
        </button>,
      ]}
    >
      {tab === 'storyboards' && !edit && freshBoards.length > 0 && (
        <NoDefaultPasswordBox slug={slug} what={`${freshBoards.length === 1 ? `"${freshBoards[0]!.name}" creates` : `${freshBoards.length} storyboards create`} new test users (fresh actors)`} />
      )}
      {noOrigins && (
        <div className="info-box sb-origin-tip">
          The extension finds this project by your app's origin. Add it (e.g. <code>http://localhost:3000</code>) under <Link to={`/p/${slug}/settings`}>Settings → App origins</Link>.
        </div>
      )}
      <Tabs
        className="sb-tabs"
        label="Storyboards"
        value={stripValue}
        onChange={setStrip}
        items={STORYBOARD_TABS.map((t) => ({
          id: t.id,
          label: t.label,
          count: t.id === 'library' ? (counts['data-sets'] ?? 0) + (counts.recipes ?? 0) + (counts.snapshots ?? 0) : counts[t.id as Tab],
        }))}
      />
      {isLib && (
        <div className="sb-lib-switch">
          <Tabs
            variant="segmented"
            label="Library"
            value={tab}
            onChange={(id) => setTab(id as Tab)}
            items={STORYBOARD_LIBRARY.map((t) => ({ id: t.id, label: t.label, count: counts[t.id as Tab] }))}
          />
        </div>
      )}
      {tab === 'bundle' && <h2 className="sb-view-title">Import / export</h2>}
      {tab === 'storyboards' &&
        (edit ? (
          <StoryboardEditRoute key={edit} edit={edit} ctx={ctx} noDefaultPassword={noDefaultPassword} onDone={() => setParam({ edit: null })} onOpen={(s) => setParam({ edit: s })} reload={reloadAuthoring} />
        ) : (
          <StoryboardList list={storyboards.data} error={storyboards.error} onOpen={(s) => setParam({ edit: s })} onWalkthrough={(id) => setParam({ tab: 'walkthroughs', wt: id })} />
        ))}
      {tab === 'data-sets' && (
        <DataSetsPanel
          slug={slug}
          dataSets={dataSets.data}
          error={dataSets.error}
          storyboards={storyboards.data ?? []}
          snapshots={snapshots.data ?? []}
          variables={ctx.variables}
          reload={reloadAuthoring}
        />
      )}
      {tab === 'recipes' && (
        <LoginRecipesPanel slug={slug} recipes={recipes.data} error={recipes.error} roles={recipeRoles} usersByRole={usersByRole} authenticators={overview.authenticators} reload={reloadAuthoring} />
      )}
      {tab === 'snapshots' && <SnapshotsTab list={snapshots.data} error={snapshots.error} reload={reloadAuthoring} onDataSet={() => setTab('data-sets')} />}
      {tab === 'walkthroughs' && <WalkthroughsTab storyboards={storyboards.data ?? []} open={params.get('wt')} setOpen={(id) => setParam({ wt: id })} />}
      {tab === 'cleanup' && <CleanupTab onOpenRun={(id) => setParam({ tab: 'walkthroughs', wt: id })} />}
      {tab === 'bundle' && <BundlePanel slug={slug} storyboards={storyboards.data ?? []} onImported={reloadAuthoring} />}
    </Page>
  );
}

// ---------------- Storyboards ----------------

function StoryboardList({ list, error, onOpen, onWalkthrough }: { list: StoryboardBrief[] | null; error: string | null; onOpen: (slug: string) => void; onWalkthrough: (id: string) => void }) {
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set((list ?? []).flatMap((s) => s.tags))].sort(), [list]);
  const shown = (list ?? []).filter((s) => !tag || s.tags.includes(tag));
  const [view, setViewState] = useState<'grid' | 'list'>(() => (localStorage.getItem('stubyard.sb.view') === 'list' ? 'list' : 'grid'));
  const setView = (v: 'grid' | 'list') => {
    setViewState(v);
    try {
      localStorage.setItem('stubyard.sb.view', v);
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="card">
      <div className="card-head sb-head">
        <h3>
          Storyboards {list && <span className="faint small">({list.length})</span>}
        </h3>
        <div className="row nowrap sb-head-actions">
          <div className="seg sb-view-toggle" role="group" aria-label="Layout">
            <button type="button" className={`seg-btn ${view === 'grid' ? 'active' : ''}`} aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
              Cards
            </button>
            <button type="button" className={`seg-btn ${view === 'list' ? 'active' : ''}`} aria-pressed={view === 'list'} onClick={() => setView('list')}>
              List
            </button>
          </div>
          <button className="btn sm primary" onClick={() => onOpen('new')}>
            <Icon name="plus" size={13} /> New storyboard
          </button>
        </div>
      </div>
      {tags.length > 0 && (
        <div className="filters chips">
          <button className={`chip ${!tag ? 'active' : ''}`} onClick={() => setTag(null)}>
            All
          </button>
          {tags.map((t) => (
            <button key={t} className={`chip ${tag === t ? 'active' : ''}`} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      {!list && !error && <p className="muted card-pad">Loading…</p>}
      {list && !list.length && (
        <Empty title="No storyboards yet">
          <p className="small">
            A storyboard is a scripted manual test: actors (test users by role), then ordered steps. Create one here, import a bundle, or let an agent author one through MCP (<code>describe_storyboards</code>).
          </p>
        </Empty>
      )}
      {shown.length > 0 && view === 'grid' && (
        <div className="sb-grid">
          {shown.map((s) => (
            <article key={s.id} className="sb-card">
              <button type="button" className="sb-card-main" onClick={() => onOpen(s.slug)} title={`Edit ${s.name}`}>
                <span className="sb-card-title">
                  <strong>{s.name}</strong>
                  <span className="faint small">v{s.version}</span>
                </span>
                <code className="small faint">{s.slug}</code>
                {s.description && <span className="small muted sb-card-desc">{s.description}</span>}
              </button>
              {s.tags.length > 0 && (
                <div className="sb-tags">
                  {s.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              )}
              <dl className="sb-card-stats">
                <div>
                  <dt>Steps</dt>
                  <dd>{s.steps}</dd>
                </div>
                <div>
                  <dt>Actors</dt>
                  <dd className="ellipsis" title={s.actors.map((a) => `${a.key} (${a.role})`).join(', ')}>
                    {s.actors.map((a) => a.role).join(', ') || '—'}
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{timeAgo(s.updatedAt)}</dd>
                </div>
              </dl>
              <div className="sb-card-foot">
                {s.lastWalkthrough ? (
                  <button className="sb-link" onClick={() => onWalkthrough(s.lastWalkthrough!.id)}>
                    <Badge kind={WT_STATUS_KIND[s.lastWalkthrough.status]}>{s.lastWalkthrough.status}</Badge>
                    {s.lastWalkthrough.verdict && <Badge kind={VERDICT_KIND[s.lastWalkthrough.verdict]}>{s.lastWalkthrough.verdict}</Badge>}
                    <span className="faint small">{timeAgo(s.lastWalkthrough.startedAt)}</span>
                  </button>
                ) : (
                  <span className="small faint">Not walked through yet</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {shown.length > 0 && view === 'list' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Storyboard</th>
                <th>Steps</th>
                <th className="col-sm">Actors</th>
                <th className="col-sm">Last walkthrough</th>
                <th className="col-md">Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => onOpen(s.slug)}>
                  <td className="cell-fill">
                    <div className="row nowrap" style={{ gap: 6 }}>
                      <strong className="ellipsis">{s.name}</strong>
                      <span className="faint small">v{s.version}</span>
                    </div>
                    <div className="small faint ellipsis">
                      <code>{s.slug}</code>
                      {s.description ? ` · ${s.description}` : ''}
                    </div>
                    {s.tags.length > 0 && (
                      <div className="sb-tags">
                        {s.tags.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{s.steps}</td>
                  <td className="col-sm small">
                    {s.actors.map((a) => (
                      <div key={a.key} className="sb-nowrap">
                        <code>{a.key}</code> <span className="faint">{a.role}</span>
                        {a.fresh && <span className="faint"> · fresh</span>}
                      </div>
                    ))}
                  </td>
                  <td className="col-sm">
                    {s.lastWalkthrough ? (
                      <button className="sb-link" onClick={(e) => (e.stopPropagation(), onWalkthrough(s.lastWalkthrough!.id))}>
                        <Badge kind={WT_STATUS_KIND[s.lastWalkthrough.status]}>{s.lastWalkthrough.status}</Badge>
                        {s.lastWalkthrough.verdict && <Badge kind={VERDICT_KIND[s.lastWalkthrough.verdict]}>{s.lastWalkthrough.verdict}</Badge>}
                        <span className="faint small">{timeAgo(s.lastWalkthrough.startedAt)}</span>
                      </button>
                    ) : (
                      <span className="faint small">never run</span>
                    )}
                  </td>
                  <td className="col-md faint small">{timeAgo(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const blankStoryboard = (roles: string[]): Storyboard => ({
  slug: '',
  name: '',
  description: '',
  intent: '',
  tags: [],
  inputs: [],
  actors: [{ key: 'user', role: roles[0] ?? 'customer' }],
  steps: [],
});

/** Fresh actors while the project has no defaultPassword: their sign-up uses the fallback password (often rejected). */
function NoDefaultPasswordBox({ slug, what }: { slug: string; what: string }) {
  return (
    <div className="warn-box sb-password-warn" role="alert" data-testid="no-default-password">
      <strong>No default password.</strong> {what}, and this project has no default password, so they sign up and log in with <code>Password123!</code>. If the app's
      password rules reject it, the sign-up step fails. Set one the app accepts under <Link to={`/p/${slug}/settings`}>Settings → General → Default password</Link>.
    </div>
  );
}

function StoryboardEditRoute({ edit, ctx, noDefaultPassword, onDone, onOpen, reload }: { edit: string; ctx: EditorContext; noDefaultPassword: boolean; onDone: () => void; onOpen: (slug: string) => void; reload: () => void }) {
  const isNew = edit === 'new';
  const [view, setView] = useState<StoryboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (isNew) return;
    sbApi.getStoryboard(ctx.slug, edit).then(setView, (e) => setError(errText(e)));
  }, [ctx.slug, edit, isNew]);
  if (error)
    return (
      <div className="card">
        <ErrorBox error={error} />
        <div className="card-pad">
          <button className="btn sm" onClick={onDone}>
            ← Storyboards
          </button>
        </div>
      </div>
    );
  if (!isNew && !view) return <p className="muted">Loading…</p>;
  const fresh = noDefaultPassword ? (view?.actors ?? []).filter((a) => a.fresh).map((a) => a.label || a.key) : [];
  return (
    <>
    {fresh.length > 0 && <NoDefaultPasswordBox slug={ctx.slug} what={`The fresh actor${fresh.length === 1 ? '' : 's'} ${fresh.join(', ')} create${fresh.length === 1 ? 's' : ''} a new test user per walkthrough`} />}
    <StoryboardEditor
      initial={view ? toStoryboardInput(view) : blankStoryboard(ctx.roles)}
      existing={view}
      ctx={ctx}
      onClose={onDone}
      onSaved={(v) => {
        reload();
        if (isNew) onOpen(v.slug);
        else setView(v);
      }}
      onDeleted={() => (reload(), onDone())}
      onDuplicated={(v) => (reload(), onOpen(v.slug))}
    />
    </>
  );
}

// ---------------- Page snapshots ----------------

function SnapshotsTab({ list, error, reload, onDataSet }: { list: PageSnapshotBrief[] | null; error: string | null; reload: () => void; onDataSet: () => void }) {
  const { slug } = useProject();
  const [open, setOpen] = useState<PageSnapshotBrief | null>(null);
  return (
    <div className="card">
      <div className="card-head sb-head">
        <h3>
          Page snapshots {list && <span className="faint small">({list.length})</span>}
        </h3>
        <span className="faint small">Scanned form fields from the extension's "Page data" (newest 200 kept)</span>
      </div>
      <ErrorBox error={error} />
      {!list && !error && <p className="muted card-pad">Loading…</p>}
      {list && !list.length && (
        <Empty title="No page snapshots yet">
          <p className="small">Open your app with the stubyard extension and use "Page data → Save snapshot". The fields it finds can become a data set.</p>
        </Empty>
      )}
      {list && list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Fields</th>
                <th className="col-sm">Source</th>
                <th className="col-sm">Saved</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => setOpen(s)}>
                  <td className="cell-fill">
                    <div className="ellipsis">
                      <strong>{s.title || '(no title)'}</strong>
                      {s.formId && <span className="faint small"> #{s.formId}</span>}
                    </div>
                    <div className="small faint ellipsis">{s.url}</div>
                  </td>
                  <td>{s.fields}</td>
                  <td className="col-sm faint small">{s.source}</td>
                  <td className="col-sm faint small">{timeAgo(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <SnapshotDrawer slug={slug} brief={open} onClose={() => setOpen(null)} onDeleted={() => (setOpen(null), reload())} onDataSet={onDataSet} />}
    </div>
  );
}

function SnapshotDrawer({ slug, brief, onClose, onDeleted, onDataSet }: { slug: string; brief: PageSnapshotBrief; onClose: () => void; onDeleted: () => void; onDataSet: () => void }) {
  const toast = useToast();
  const snap = useFetch<PageSnapshotView>(`${sbPaths.snapshots(slug)}/${encodeURIComponent(brief.id)}`, [slug, brief.id]);
  const [make, setMake] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const s = snap.data;
  const fields = (s?.fields ?? []).filter((f) => hidden || f.visible);
  const remove = async () => {
    if (!confirm('Delete this page snapshot?')) return;
    try {
      await sbApi.deleteSnapshot(slug, brief.id);
      toast('Snapshot deleted');
      onDeleted();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Drawer
      title={<strong className="ellipsis">{brief.title || brief.url}</strong>}
      onClose={onClose}
      actions={
        <>
          <button className="btn sm primary" onClick={() => setMake(true)}>
            Make data set
          </button>
          <button className="btn sm ghost danger" onClick={() => void remove()}>
            Delete
          </button>
        </>
      }
    >
      <ErrorBox error={error ?? snap.error} />
      {!s && !snap.error && <p className="muted">Loading…</p>}
      {s && (
        <>
          <dl className="sb-dl">
            <dt>URL</dt>
            <dd>
              <code>{s.url}</code>
            </dd>
            <dt>URL pattern</dt>
            <dd>
              <code>{s.urlPattern || '—'}</code>
            </dd>
            <dt>Form</dt>
            <dd>{s.formId ? <code>#{s.formId}</code> : '—'}</dd>
            <dt>Saved</dt>
            <dd>
              {fmtDateTime(s.createdAt)} <span className="faint">· {s.source}</span>
            </dd>
            {s.note && (
              <>
                <dt>Note</dt>
                <dd>{s.note}</dd>
              </>
            )}
          </dl>
          <section>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 className="section-title">
                Fields ({fields.length}
                {!hidden && s.fields.length !== fields.length ? ` of ${s.fields.length}` : ''})
              </h3>
              <label className="sb-check small">
                <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Show hidden fields
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Kind</th>
                    <th className="col-sm">Label</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f, i) => (
                    <tr key={i}>
                      <td>
                        <code>{f.key}</code>
                        {f.required && <span className="sb-req" title="required"> *</span>}
                        {f.duplicateKey && (
                          <Badge kind="warn" title="Another field has the same key">
                            dup
                          </Badge>
                        )}
                        {!f.visible && <span className="faint small"> hidden</span>}
                      </td>
                      <td className="faint small">
                        {f.kind}
                        {f.inputType && f.inputType !== f.kind ? ` (${f.inputType})` : ''}
                      </td>
                      <td className="col-sm small">{f.label ?? f.placeholder ?? ''}</td>
                      <td className="small">
                        <code>{f.value === null ? '' : Array.isArray(f.value) ? f.value.join(', ') : String(f.value)}</code>
                        {f.options && f.options.length > 0 && <span className="faint"> · {f.options.length} options</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {make && <FromSnapshotModal slug={slug} snapshot={brief} onClose={() => setMake(false)} onCreated={() => (setMake(false), onClose(), onDataSet())} />}
    </Drawer>
  );
}

// ---------------- Walkthroughs ----------------

function WalkthroughsTab({ storyboards, open, setOpen }: { storyboards: StoryboardBrief[]; open: string | null; setOpen: (id: string | null) => void }) {
  const { slug } = useProject();
  useTick();
  const [sb, setSb] = useState('');
  const [status, setStatus] = useState('');
  const list = useFetch<WalkthroughBrief[]>(`${sbPaths.walkthroughs(slug)}?limit=200${sb ? `&storyboard=${encodeURIComponent(sb)}` : ''}${status ? `&status=${status}` : ''}`, [slug, sb, status]);
  const reload = useDebounced(() => void list.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'walkthrough.changed' || e.type === 'project.reset') reload();
  });
  return (
    <div className="card">
      <div className="card-head sb-head">
        <h3>
          Walkthroughs {list.data && <span className="faint small">({list.data.length})</span>}
        </h3>
        <span className="faint small">Started and run from the browser extension</span>
      </div>
      <div className="filters">
        <select value={sb} onChange={(e) => setSb(e.target.value)} aria-label="Storyboard">
          <option value="">All storyboards</option>
          {storyboards.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="finished">Finished</option>
          <option value="abandoned">Abandoned</option>
        </select>
      </div>
      <ErrorBox error={list.error} />
      {!list.data && !list.error && <p className="muted card-pad">Loading…</p>}
      {list.data && !list.data.length && (
        <Empty title={sb || status ? 'No walkthroughs match' : 'No walkthroughs yet'}>
          <p className="small">Open your app with the stubyard extension, pick a storyboard and press Start. Each run shows up here with its step results, notes and screenshots.</p>
        </Empty>
      )}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Walkthrough</th>
                <th>Status</th>
                <th className="col-sm">Progress</th>
                <th className="col-sm">Started</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((w) => {
                const total = Object.values(w.counts).reduce((a, b) => a + b, 0);
                const done = w.counts.done + w.counts.skipped + w.counts.failed;
                return (
                  <tr key={w.id} className={`clickable ${open === w.id ? 'selected' : ''}`} onClick={() => setOpen(w.id)}>
                    <td className="cell-fill">
                      <div className="ellipsis">
                        <strong>{w.label || w.storyboard.name}</strong> <code className="faint small">{w.key}</code>
                      </div>
                      <div className="small faint ellipsis">
                        {w.storyboard.name} v{w.storyboard.version}
                      </div>
                    </td>
                    <td>
                      <div className="row nowrap" style={{ gap: 4 }}>
                        <Badge kind={WT_STATUS_KIND[w.status]}>{w.status}</Badge>
                        {w.verdict && <Badge kind={VERDICT_KIND[w.verdict]}>{w.verdict}</Badge>}
                        {w.mode === 'quick' && <ModePill mode={w.mode} />}
                        {w.cleanupStatus && <CleanupStatusBadge status={w.cleanupStatus} />}
                      </div>
                    </td>
                    <td className="col-sm">
                      <div className="sb-progress" title={`${w.counts.done} done, ${w.counts.skipped} skipped, ${w.counts.failed} failed of ${total}`}>
                        <span className="sb-bar">
                          <span className="ok" style={{ width: `${total ? (w.counts.done / total) * 100 : 0}%` }} />
                          <span className="warn" style={{ width: `${total ? (w.counts.skipped / total) * 100 : 0}%` }} />
                          <span className="bad" style={{ width: `${total ? (w.counts.failed / total) * 100 : 0}%` }} />
                        </span>
                        <span className="small faint sb-nowrap">
                          {done}/{total}
                        </span>
                      </div>
                    </td>
                    <td className="col-sm faint small sb-nowrap">{timeAgo(w.startedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <WalkthroughDrawer slug={slug} id={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}

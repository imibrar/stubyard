import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../api';
import { Icon } from '../components/people';
import { GenerateModal, UserModal } from '../components/users';
import { Badge, ErrorBox, timeAgo, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { needRole, useCan, useGate } from '../auth';
import { useDebounced, useFetch, useHubEvents, useNewAction } from '../hooks';
import { LintCounter } from '../components/Lint';
import { STATUSES, STATUS_KIND, STATUS_LABEL, featuresApi, featuresBase, type FeatureBrief, type FeatureList, type FeatureStatus } from '../featuresApi';
import { sbPaths, type WalkthroughBrief } from '../storyboardsApi';
import { HomeStats, PinnedCard, RecentActivity, SetupStatus } from './ProjectHome';
import { PriorityBadge, Progress } from './FeaturesPage';

/**
 * /p/:slug — the project overview (first screen): header, numbers, the plan from the Features board, the latest codes
 * of the pinned users, recent activity, the latest walkthroughs and setup. The users table is on /p/:slug/users.
 */
export default function ProjectOverview() {
  useTick(15_000);
  const { slug, overview } = useProject();
  const { project, users, stats } = overview;
  const [editing, setEditing] = useState<'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const usersGate = useGate(slug)('walkthroughs.run');
  // Older links and bookmarks open the user dialogs on the overview (?new=user / ?new=generate).
  useNewAction(usersGate.disabled ? {} : { user: () => setEditing('new'), generate: () => setGenerating(true) });
  const setupDone = stats.users > 0 && stats.providers > 0 && stats.logs > 0 && stats.messages > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="row small">
            <code>{project.slug}</code>
            <span>
              <Link to={`/p/${slug}/users`}>{stats.users} users</Link> · <Link to={`/p/${slug}/providers`}>{stats.providers} providers</Link> · {stats.messages} messages · <Link to={`/p/${slug}/traffic`}>{stats.logs} requests</Link>
            </span>
            {project.description && <span>· {project.description}</span>}
            <Link to={`/p/${slug}/settings?tab=checks`} title="Content checks: see Settings">
              <LintCounter />
            </Link>
          </p>
        </div>
        <div className="row">
          <Link to={`/p/${slug}/setup`} className="btn">
            <Icon name="code" size={14} /> Connect your app
          </Link>
        </div>
      </div>

      <HomeStats className="ov-stats" />

      {users.length === 0 && (
        <div className="card ov-callout">
          <span className="ov-callout-icon" aria-hidden>
            <Icon name="users" size={18} />
          </span>
          <div className="grow">
            <h2 className="ov-callout-title">No test users yet</h2>
            <p className="small muted">Generate a set of users per role (admin, sales, support, customers…) or add one by hand.</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setEditing('new')} {...usersGate}>
              Add user
            </button>
            <button className="btn primary" onClick={() => setGenerating(true)} {...usersGate}>
              Generate test users
            </button>
          </div>
        </div>
      )}

      <div className="ov-grid">
        <div className="ov-main">
          <PlanCard />
          {users.length > 0 && <CodesStrip />}
          <RecentRuns />
        </div>
        <aside className="ov-side" aria-label="Activity and setup">
          <RecentActivity />
          {!setupDone && <SetupStatus />}
        </aside>
      </div>
      {editing && <UserModal user={null} onClose={() => setEditing(null)} />}
      {generating && <GenerateModal onClose={() => setGenerating(false)} />}
    </>
  );
}

const PLAN_SHOWN = 5;
const statusRank: Record<FeatureStatus, number> = { in_progress: 0, planned: 1, idea: 2, done: 3 };

/** The plan: feature counts by status, done progress, and the features in progress and planned next. */
function PlanCard() {
  const { slug } = useProject();
  const can = useCan();
  const canEdit = can('features.edit', slug);
  const list = useFetch<FeatureList>(featuresBase(slug), [slug]);
  const reload = useDebounced(() => void list.reload(), 150);
  useHubEvents(slug, (e) => {
    if (e.type === 'features.changed' || e.type === 'project.reset') reload();
  });
  const all = useMemo(() => list.data?.features ?? [], [list.data]);
  const counts = useMemo(() => {
    const c: Record<FeatureStatus, number> = { idea: 0, planned: 0, in_progress: 0, done: 0 };
    for (const f of all) c[f.status]++;
    return c;
  }, [all]);
  const next = useMemo(
    () =>
      all
        .filter((f) => f.status === 'in_progress' || f.status === 'planned')
        .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.position - b.position)
        .slice(0, PLAN_SHOWN),
    [all],
  );
  const open = `/p/${slug}/features`;
  const pct = all.length ? Math.round((counts.done / all.length) * 100) : 0;
  const active = counts.in_progress + counts.planned;

  return (
    <section className="card plan-card" aria-labelledby="plan-h">
      <div className="card-head">
        <h2 id="plan-h">Plan</h2>
        <Link to={open} className="small">
          Open Features →
        </Link>
      </div>
      {list.error && !list.data ? (
        <div className="plan-body">
          <ErrorBox error={list.error} />
        </div>
      ) : !list.data ? (
        <p className="plan-body muted small">Loading…</p>
      ) : all.length === 0 ? (
        <PlanEmpty canEdit={canEdit} onAdded={() => void list.reload()} />
      ) : (
        <div className="plan-body">
          <div className="plan-progress">
            <div className="plan-progress-line small">
              <span>
                <strong>{counts.done}</strong> of {all.length} feature{all.length === 1 ? '' : 's'} done
              </span>
              <span className="muted">{pct}%</span>
            </div>
            <div className="plan-bar" role="progressbar" aria-label="Features done" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={counts.done} aria-valuetext={`${counts.done} of ${all.length} features done`}>
              <span style={{ width: pct + '%' }} />
            </div>
          </div>
          <ul className="plan-counts" aria-label="Features by status">
            {STATUSES.map((s) => (
              <li key={s}>
                <Link to={`${open}?status=${s}`} className={`plan-count s-${s}`}>
                  <span className="plan-count-n">{counts[s]}</span>
                  <span className="plan-count-l">{STATUS_LABEL[s]}</span>
                </Link>
              </li>
            ))}
          </ul>
          {next.length > 0 ? (
            <ul className="plan-list" aria-label="In progress and planned">
              {next.map((f) => (
                <PlanRow key={f.id} f={f} />
              ))}
            </ul>
          ) : (
            <p className="small muted plan-note">Nothing in progress or planned. {counts.idea > 0 ? `${counts.idea} idea${counts.idea === 1 ? '' : 's'} waiting on the board.` : 'Every feature is done.'}</p>
          )}
          {active > next.length && (
            <Link to={open} className="small plan-more">
              {active - next.length} more in progress or planned →
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function PlanRow({ f }: { f: FeatureBrief }) {
  const { slug } = useProject();
  return (
    <li>
      <Link to={`/p/${slug}/features?f=${encodeURIComponent(f.key)}`} className="plan-row">
        <span className="plan-key mono">{f.key}</span>
        <span className="plan-title ellipsis">{f.title}</span>
        <span className="plan-meta">
          <Badge kind={STATUS_KIND[f.status]}>{STATUS_LABEL[f.status]}</Badge>
          <PriorityBadge p={f.priority} />
          <Progress done={f.progress.done} total={f.progress.total} compact />
        </span>
      </Link>
    </li>
  );
}

/** No features yet: a quick add (features.edit) or a link to the board. */
function PlanEmpty({ canEdit, onAdded }: { canEdit: boolean; onAdded: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const f = await featuresApi.create(slug, { title: t, status: 'planned' });
      setTitle('');
      toast(`Added ${f.key}`);
      onAdded();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plan-body plan-empty">
      <p className="small muted">
        <strong className="plan-empty-title">Plan this project.</strong> Track features with a status, priority and tasks; an AI agent can work on the same board over MCP.
      </p>
      {canEdit ? (
        <form className="row nowrap plan-add" onSubmit={(e) => void add(e)}>
          <label htmlFor="plan-add-input" className="sr-only">
            New feature title
          </label>
          <input id="plan-add-input" placeholder="First feature, e.g. Sign-up with email code" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          <button className="btn primary" type="submit" disabled={!title.trim() || busy}>
            Add
          </button>
        </form>
      ) : (
        <p className="small faint" title={needRole('features.edit')}>
          {needRole('features.edit')}
        </p>
      )}
    </div>
  );
}

const CODES_SHOWN = 4;

/** The latest codes of the first pinned users, with a link to the Users page. */
function CodesStrip() {
  const { slug, overview } = useProject();
  const pinned = overview.users.filter((u) => u.pinned > 0).sort((a, b) => a.pinned - b.pinned);
  return (
    <section className="card codes-card ov-codes" aria-labelledby="ov-codes-h">
      <div className="card-head">
        <h2 id="ov-codes-h">Latest codes</h2>
        <Link to={`/p/${slug}/users`} className="small">
          All users →
        </Link>
      </div>
      {pinned.length === 0 ? (
        <p className="plan-body small muted">Pin a user on the Users page (the star) to keep their latest code here.</p>
      ) : (
        <div className="codes-grid">
          {pinned.slice(0, CODES_SHOWN).map((u, i) => (
            <PinnedCard key={u.id} user={u} index={i} />
          ))}
        </div>
      )}
    </section>
  );
}

const VERDICT: Record<string, { kind: string; label: string }> = { pass: { kind: 'ok', label: 'Pass' }, fail: { kind: 'bad', label: 'Fail' }, partial: { kind: 'warn', label: 'Partial' } };

/** The latest walkthroughs (storyboard runs), hidden when there are none. */
function RecentRuns() {
  const { slug } = useProject();
  const path = `${sbPaths.walkthroughs(slug)}${qs({ limit: 5, mode: 'all' })}`;
  const runs = useFetch<WalkthroughBrief[]>(path, [path]);
  const reload = useDebounced(() => void runs.reload(), 300);
  useHubEvents(slug, (e) => {
    if (e.type === 'walkthrough.changed' || e.type === 'storyboards.changed' || e.type === 'project.reset') reload();
  });
  const list = runs.data ?? [];
  if (list.length === 0) return null;
  const base = `/p/${slug}/storyboards?tab=walkthroughs`;
  return (
    <section className="card" aria-labelledby="ov-runs-h">
      <div className="card-head">
        <h2 id="ov-runs-h">Latest walkthroughs</h2>
        <Link to={base} className="small">
          Walkthroughs →
        </Link>
      </div>
      <ul className="plan-list">
        {list.map((w) => {
          const v = w.verdict ? VERDICT[w.verdict] : null;
          const failed = w.counts.failed ?? 0;
          return (
            <li key={w.id}>
              <Link to={`${base}&wt=${encodeURIComponent(w.id)}`} className="plan-row">
                <span className="plan-title ellipsis">{w.label || w.storyboard.name}</span>
                <span className="plan-meta">
                  {v ? <Badge kind={v.kind}>{v.label}</Badge> : w.status === 'active' ? <Badge kind="info">Running</Badge> : <Badge>{w.status === 'abandoned' ? 'Abandoned' : 'No verdict'}</Badge>}
                  {failed > 0 && <span className="small ov-failed">{failed} failed</span>}
                  <span className="small faint">{timeAgo(w.finishedAt ?? w.updatedAt)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

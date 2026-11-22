import { useMemo, useState, type ReactNode } from 'react';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  CLEANUP_STATUS_KIND,
  CLEANUP_STATUS_LABEL,
  conflictsOf,
  KEPT_REASON_LABEL,
  sbApi,
  sbPaths,
  WT_STATUS_KIND,
  type CleanupConflict,
  type CleanupFilter,
  type CleanupItem,
  type CleanupList,
  type CleanupOnConflict,
  type CleanupResult,
  type CleanupRunRef,
  type CleanupStatus,
  type CleanupUser,
  type RunMode,
} from '../storyboardsApi';
import { Badge, Empty, ErrorBox, fmtDateTime, Modal, timeAgo, useTick, useToast } from './ui';
import { KeepToggle } from './users';
import '../styles/cleanup.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const runName = (r: CleanupRunRef) => r.label || r.storyboard?.name || r.key;

/** "2 users · 5 messages · the run record", or null when there is nothing. */
function removableText(r: { users: number; messages: number; record?: boolean; records?: number }): string | null {
  const parts: string[] = [];
  if (r.users) parts.push(plural(r.users, 'test user'));
  if (r.messages) parts.push(plural(r.messages, 'message'));
  if (r.record) parts.push('the run record');
  if (r.records) parts.push(plural(r.records, 'quick run record'));
  return parts.length ? parts.join(' · ') : null;
}

export function CleanupStatusBadge({ status }: { status: CleanupStatus }) {
  if (status === 'none') return null;
  return (
    <Badge kind={CLEANUP_STATUS_KIND[status]} title="Test data cleanup">
      {CLEANUP_STATUS_LABEL[status]}
    </Badge>
  );
}

export function ModePill({ mode }: { mode: RunMode }) {
  return <span className={`cu-mode mode-${mode}`}>{mode === 'quick' ? 'Quick' : 'Tracked'}</span>;
}

function RunRef({ run, onOpen }: { run: CleanupRunRef; onOpen?: (id: string) => void }) {
  const body = (
    <>
      <strong>{runName(run)}</strong> <code className="faint">{run.key}</code>
    </>
  );
  return (
    <span className="cu-ref">
      {onOpen ? (
        <button type="button" className="sb-link" onClick={() => onOpen(run.id)}>
          {body}
        </button>
      ) : (
        body
      )}
      {run.status === 'active' && <Badge kind={WT_STATUS_KIND.active}>active</Badge>}
    </span>
  );
}

function RefList({ runs, onOpen }: { runs: CleanupRunRef[]; onOpen?: (id: string) => void }) {
  return (
    <>
      {runs.map((r, i) => (
        <span key={r.id}>
          {i > 0 && ', '}
          <RunRef run={r} onOpen={onOpen} />
        </span>
      ))}
    </>
  );
}

// ---------------- the run flow: dryRun → conflicts / confirm → cleanup → report ----------------

/** onConflict: the choice the preview was made with (ask = the first dryRun; keep / include = after the conflict dialog). */
type FlowState =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'confirm'; ids: string[]; skipUsers: string[]; preview: CleanupResult; onConflict: CleanupOnConflict }
  | { step: 'running'; ids: string[]; skipUsers: string[]; preview: CleanupResult; onConflict: CleanupOnConflict }
  | { step: 'report'; result: CleanupResult };

/**
 * Clean up runs the way the spec asks: a dryRun first; when another run still needs a user, a dialog with
 * "Clean both" (include), "Keep those users" (keep) and Cancel. The choice runs a second dryRun with it, so the confirm
 * shows which runs and how many users, messages and records go. Then the real call and a report.
 */
export function useCleanupFlow(onDone: (r: CleanupResult) => void): { start: (ids: string[], skipUsers?: string[]) => Promise<void>; busy: boolean; error: string | null; dialogs: ReactNode } {
  const { slug } = useProject();
  const toast = useToast();
  const [state, setState] = useState<FlowState>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const check = async (ids: string[], skipUsers: string[], onConflict: CleanupOnConflict) => {
    setError(null);
    setState({ step: 'checking' });
    try {
      const preview = await sbApi.cleanupPreview(slug, { walkthroughs: ids, skipUsers, onConflict });
      setState({ step: 'confirm', ids, skipUsers, preview, onConflict });
    } catch (e) {
      setState({ step: 'idle' });
      setError(errText(e));
    }
  };
  const start = async (ids: string[], skipUsers: string[] = []) => {
    if (ids.length) await check(ids, skipUsers, 'ask');
  };
  /** The conflict dialog's choice: preview again with it, then confirm. */
  const choose = (onConflict: 'keep' | 'include') => {
    if (state.step === 'confirm') void check(state.ids, state.skipUsers, onConflict);
  };
  const run = async () => {
    if (state.step !== 'confirm') return;
    const { ids, skipUsers, preview, onConflict } = state;
    setState({ step: 'running', ids, skipUsers, preview, onConflict });
    try {
      const result = await sbApi.cleanupRuns(slug, { walkthroughs: ids, skipUsers, onConflict });
      setState({ step: 'report', result });
      toast(`Cleaned up ${plural(result.runs.length, 'run')}`);
      onDone(result);
    } catch (e) {
      const conflicts = conflictsOf(e);
      // Something changed since the preview: show the new conflicts and ask again.
      if (conflicts) setState({ step: 'confirm', ids, skipUsers, preview: { ...preview, conflicts }, onConflict: 'ask' });
      else {
        setState({ step: 'idle' });
        setError(errText(e));
      }
    }
  };
  const close = () => setState({ step: 'idle' });

  let dialogs: ReactNode = null;
  if (state.step === 'confirm' || state.step === 'running') {
    const { preview } = state;
    const running = state.step === 'running';
    // Conflicts only need an answer on the first preview; after "Clean both" / "Keep" they are settled by that choice.
    const conflicts = state.onConflict === 'ask' ? preview.conflicts : [];
    dialogs = (
      <Modal
        title={conflicts.length ? 'Another run still uses this data' : `Clean up ${plural(preview.runs.length || state.ids.length, 'run')}?`}
        onClose={() => !running && close()}
        footer={
          conflicts.length ? (
            <>
              <button className="btn" onClick={close} disabled={running}>
                Cancel
              </button>
              <button className="btn" onClick={() => choose('keep')} disabled={running}>
                Keep those users
              </button>
              <button className="btn primary danger-fill" onClick={() => choose('include')} disabled={running}>
                Clean both
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={close} disabled={running}>
                Cancel
              </button>
              <button className="btn primary danger-fill" onClick={() => void run()} disabled={running || !removableText(preview.totals)}>
                {running ? 'Cleaning up…' : 'Clean up'}
              </button>
            </>
          )
        }
      >
        <div className="stack cu-dialog">
          {conflicts.length > 0 ? (
            <>
              <ConflictList conflicts={conflicts} />
              <p className="small muted" style={{ margin: 0 }}>
                <strong>Clean both</strong> also cleans up the runs that use these users (active runs keep them). <strong>Keep those users</strong> cleans the rest and leaves these users in place.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: 0 }}>{removableText(preview.totals) ? <>stubyard removes {removableText(preview.totals)}.</> : 'There is nothing to remove right now.'}</p>
              {(preview.runs.length > 1 || state.onConflict !== 'ask') && <PreviewRuns preview={preview} />}
              <PreviewKept preview={preview} />
              <p className="small muted" style={{ margin: 0 }}>
                Only stubyard's own test data is removed. Records in your app (accounts, orders, registrations) stay; tracked runs keep their steps, notes, screenshots and sign-off.
              </p>
            </>
          )}
        </div>
      </Modal>
    );
  } else if (state.step === 'report') {
    dialogs = <CleanupReport result={state.result} onClose={close} />;
  }
  return { start, busy: state.step === 'checking' || state.step === 'running', error, dialogs };
}

function ConflictList({ conflicts }: { conflicts: CleanupConflict[] }) {
  return (
    <ul className="cu-list">
      {conflicts.map((c) => (
        <li key={`${c.walkthrough.id}:${c.userId}`}>
          <span className="sb-wrap">
            <code>{c.email ?? c.userId}</code> from <RunRef run={c.walkthrough} /> is also used by <RefList runs={c.usedBy} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Which runs the cleanup touches and what goes from each (after "Clean both" it includes the other runs). */
function PreviewRuns({ preview }: { preview: CleanupResult }) {
  return (
    <ul className="cu-list small">
      {preview.runs.map((r) => (
        <li key={r.id}>
          <span className="sb-wrap">
            <strong>{r.label || r.key}</strong> <code className="faint">{r.key}</code> <ModePill mode={r.mode} />{' '}
            <span className="muted">{removableText(r.removed) ?? 'nothing removed'}</span>
            {r.status === 'partial' && <span className="faint"> · partly</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PreviewKept({ preview }: { preview: CleanupResult }) {
  const kept = preview.runs.flatMap((r) => r.kept);
  if (!kept.length) return null;
  return (
    <div className="small">
      <span className="muted">Stays:</span>{' '}
      {kept.map((k, i) => (
        <span key={k.userId}>
          {i > 0 && ', '}
          <code>{k.email ?? k.userId}</code> <span className="faint">({KEPT_REASON_LABEL[k.reason]})</span>
        </span>
      ))}
    </div>
  );
}

/** The result of a cleanup: removed counts, kept users with reasons, partial runs, values left in the app. */
export function CleanupReport({ result, onClose }: { result: CleanupResult; onClose: () => void }) {
  const removed = removableText(result.totals);
  const vars = result.runs.flatMap((r) => Object.entries(r.vars).map(([k, v]) => ({ run: r, k, v })));
  return (
    <Modal
      title="Cleanup done"
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack cu-dialog">
        <p style={{ margin: 0 }}>{removed ? <>Removed {removed}.</> : 'Nothing was removed.'}</p>
        <ul className="cu-list">
          {result.runs.map((r) => (
            <li key={r.id} className="cu-report-run">
              <div className="row" style={{ gap: 6 }}>
                <strong className="sb-wrap">{r.label || r.key}</strong>
                <code className="faint small">{r.key}</code>
                <ModePill mode={r.mode} />
                <Badge kind={r.status === 'cleaned' ? 'ok' : 'warn'}>{r.status}</Badge>
                <span className="small faint">{removableText(r.removed) ?? 'nothing removed'}</span>
              </div>
              {r.kept.length > 0 && (
                <ul className="cu-kept small">
                  {r.kept.map((k) => (
                    <li key={k.userId}>
                      <code>{k.email ?? k.userId}</code> kept: {KEPT_REASON_LABEL[k.reason]}
                      {k.usedBy?.length ? (
                        <>
                          {' '}
                          (<RefList runs={k.usedBy} />)
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {r.status === 'partial' && <p className="small muted" style={{ margin: '4px 0 0' }}>Partly cleaned: the run stays in the cleanup list until its other users can go.</p>}
            </li>
          ))}
        </ul>
        {vars.length > 0 && <VarsNote vars={vars.map(({ run, k, v }) => ({ k: result.runs.length > 1 ? `${run.key} · ${k}` : k, v }))} />}
      </div>
    </Modal>
  );
}

function VarsNote({ vars }: { vars: { k: string; v: string }[] }) {
  return (
    <div className="cu-vars">
      <div className="small muted">Values in your app (not removed by stubyard)</div>
      <dl className="sb-dl">
        {vars.map(({ k, v }) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>
              <code>{k}</code>
            </dt>
            <dd>
              <code>{v}</code>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------- one run: users, vars, uses, warnings ----------------

function deletable(u: CleanupUser) {
  return u.exists && !u.keep;
}

function CleanupUsers({ item, skip, setSkip, onChanged, onOpen }: { item: CleanupItem; skip: Set<string>; setSkip?: (userId: string, on: boolean) => void; onChanged: () => void; onOpen?: (id: string) => void }) {
  if (!item.users.length) return <p className="small faint" style={{ margin: 0 }}>This run created no test users.</p>;
  return (
    <ul className="cu-users">
      {item.users.map((u) => {
        const can = deletable(u);
        return (
          <li key={u.userId} className={`cu-user ${!u.exists ? 'gone' : ''}`}>
            <label className="sb-check cu-user-main">
              <input type="checkbox" disabled={!can || !setSkip} checked={can && !skip.has(u.userId)} onChange={(e) => setSkip?.(u.userId, !e.target.checked)} aria-label={`Delete ${u.name}`} />
              <span className="cu-user-text">
                <strong className="sb-wrap">{u.name}</strong> <span className="faint small">{u.role}</span>
                <span className="small muted sb-wrap cu-user-email">{u.email ?? '—'}</span>
              </span>
            </label>
            <span className="cu-user-side">
              {!u.exists ? (
                <Badge>already deleted</Badge>
              ) : (
                <>
                  <span className="small faint sb-nowrap">{plural(u.messages, 'message')}</span>
                  <KeepToggle userId={u.userId} name={u.name} keep={u.keep} onChanged={onChanged} />
                </>
              )}
            </span>
            {u.exists && u.usedBy.length > 0 && (
              <span className="cu-used small">
                ⚠ Used by <RefList runs={u.usedBy} onOpen={onOpen} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The expanded body of a run: users, captured values, "uses data from", warnings, last report. */
function CleanupDetails({ item, skip, setSkip, onChanged, onOpen, hideVars }: { item: CleanupItem; skip: Set<string>; setSkip?: (userId: string, on: boolean) => void; onChanged: () => void; onOpen?: (id: string) => void; hideVars?: boolean }) {
  const vars = hideVars ? [] : Object.entries(item.vars).map(([k, v]) => ({ k, v }));
  return (
    <div className="cu-details">
      {item.warnings.length > 0 && (
        <ul className="sb-warn-list">
          {item.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      <CleanupUsers item={item} skip={skip} setSkip={setSkip} onChanged={onChanged} onOpen={onOpen} />
      {item.uses.length > 0 && (
        <p className="small" style={{ margin: 0 }}>
          <span className="muted">Uses data from</span> <RefList runs={item.uses} onOpen={onOpen} />
        </p>
      )}
      {vars.length > 0 && <VarsNote vars={vars} />}
      {item.lastReport && (
        <p className="small faint" style={{ margin: 0 }}>
          Last cleanup: {item.lastReport.status}, removed {removableText(item.lastReport.removed) ?? 'nothing'}
          {item.lastReport.kept.length > 0 && `, kept ${item.lastReport.kept.map((k) => `${k.email ?? k.userId} (${KEPT_REASON_LABEL[k.reason]})`).join(', ')}`}
          {item.walkthrough.cleanupAt && ` · ${fmtDateTime(item.walkthrough.cleanupAt)}`}
        </p>
      )}
    </div>
  );
}

/**
 * Whether a run offers Clean up: not active, pending, and something to remove. A user only other runs still use
 * (removable 0 because of conflicts) counts too: the conflict dialog then offers Clean both / Keep those users.
 */
function canClean(item: CleanupItem) {
  const w = item.walkthrough;
  return w.status !== 'active' && w.cleanupStatus === 'pending' && (item.users.some(deletable) || item.removable.users > 0 || item.removable.record);
}

function skipFor(item: CleanupItem, skip: Set<string>) {
  return item.users.filter((u) => skip.has(u.userId)).map((u) => u.userId);
}

// ---------------- the Storyboards → Cleanup tab ----------------

const FILTERS: [CleanupFilter, string][] = [
  ['pending', 'To clean'],
  ['cleaned', 'Cleaned'],
  ['dismissed', 'Dismissed'],
  ['all', 'All'],
];

/** Storyboards → Cleanup: the runs with test data, multi-select, dryRun + conflict dialog, report, dismiss, reopen. */
export function CleanupTab({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { slug } = useProject();
  const toast = useToast();
  useTick();
  const [status, setStatus] = useState<CleanupFilter>('pending');
  const [mode, setMode] = useState<RunMode | 'all'>('all');
  const list = useFetch<CleanupList>(`${sbPaths.cleanup(slug)}?status=${status}&mode=${mode}`, [slug, status, mode]);
  const reload = useDebounced(() => void list.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'walkthrough.changed' || e.type === 'user.changed' || e.type === 'project.reset') reload();
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const counts = list.data?.counts;
  const cleanable = useMemo(() => items.filter(canClean), [items]);
  const chosen = cleanable.filter((i) => selected.has(i.walkthrough.id));
  const flow = useCleanupFlow(() => {
    setSelected(new Set());
    setSkip(new Set());
    void list.reload();
  });

  type SetState = (fn: (s: Set<string>) => Set<string>) => void;
  const toggle = (setter: SetState, id: string, on: boolean) =>
    setter((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const allOn = cleanable.length > 0 && chosen.length === cleanable.length;
  const startSelected = () => void flow.start(chosen.map((i) => i.walkthrough.id), chosen.flatMap((i) => skipFor(i, skip)));
  const dismiss = async (item: CleanupItem, reopen: boolean) => {
    setError(null);
    try {
      if (reopen) await sbApi.reopenCleanup(slug, item.walkthrough.id);
      else await sbApi.dismissCleanup(slug, item.walkthrough.id);
      toast(reopen ? 'Back in the cleanup list' : 'Left as is: the data stays');
      void list.reload();
    } catch (e) {
      setError(errText(e));
    }
  };
  const countOf = (f: CleanupFilter) => (counts ? (f === 'all' ? counts.pending + counts.cleaned + counts.dismissed : counts[f]) : undefined);

  return (
    <div className="card">
      <div className="card-head sb-head">
        <h3>Clean up test data</h3>
        <span className="faint small">Nothing is removed automatically. stubyard only removes its own test users and their messages, never anything in your app.</span>
      </div>
      <div className="filters">
        <div className="chips" role="group" aria-label="Cleanup status">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={`chip ${status === k ? 'active' : ''}`} onClick={() => (setStatus(k), setSelected(new Set()))} aria-pressed={status === k}>
              {label} {countOf(k) !== undefined && <span className="n">{countOf(k)}</span>}
            </button>
          ))}
        </div>
        <select value={mode} onChange={(e) => (setMode(e.target.value as RunMode | 'all'), setSelected(new Set()))} aria-label="Run mode">
          <option value="all">Quick and tracked</option>
          <option value="quick">Quick runs</option>
          <option value="tracked">Tracked runs</option>
        </select>
      </div>
      {counts && counts.active > 0 && (
        <div className="cu-note small">
          {plural(counts.active, 'active run')} {counts.active === 1 ? 'has' : 'have'} test data too. Finish or abandon {counts.active === 1 ? 'it' : 'them'} before cleaning up.
        </div>
      )}
      <ErrorBox error={error ?? flow.error ?? list.error} />
      {list.data?.truncated && <div className="cu-note small">Showing the newest 500 runs. Clean some up (or filter by mode) to see the rest.</div>}
      {cleanable.length > 0 && (
        <div className="cu-bar">
          <label className="sb-check">
            <input type="checkbox" checked={allOn} onChange={(e) => setSelected(e.target.checked ? new Set(cleanable.map((i) => i.walkthrough.id)) : new Set())} /> Select all
          </label>
          <span className="spacer" />
          <button className="btn sm primary" disabled={!chosen.length || flow.busy} onClick={startSelected}>
            {flow.busy ? 'Checking…' : `Clean up selected${chosen.length ? ` (${chosen.length})` : ''}`}
          </button>
        </div>
      )}
      {!list.data && !list.error && <p className="muted card-pad">Loading…</p>}
      {list.data && !items.length && (
        <Empty title={status === 'pending' ? 'Nothing to clean up' : 'No runs here'}>
          <p className="small">
            {status === 'pending'
              ? 'Runs that created fresh test users show up here once they are finished or abandoned. Clean them up when you are done with the data.'
              : 'Change the filter to see other runs.'}
          </p>
        </Empty>
      )}
      {items.length > 0 && (
        <ul className="cu-items">
          {items.map((item) => {
            const w = item.walkthrough;
            const isOpen = open.has(w.id);
            const can = canClean(item);
            return (
              <li key={w.id} className={`cu-item ${selected.has(w.id) ? 'selected' : ''}`}>
                <div className="cu-item-head">
                  <input
                    type="checkbox"
                    className="cu-item-check"
                    disabled={!can}
                    checked={can && selected.has(w.id)}
                    onChange={(e) => toggle(setSelected, w.id, e.target.checked)}
                    aria-label={`Select ${runName(w)}`}
                  />
                  <button type="button" className="cu-item-toggle" onClick={() => toggle(setOpen, w.id, !isOpen)} aria-expanded={isOpen}>
                    <span className="cu-caret" aria-hidden>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="cu-item-title">
                      <strong className="sb-wrap">{runName(w)}</strong> <code className="faint small">{w.key}</code>
                    </span>
                    <span className="cu-item-meta">
                      <ModePill mode={w.mode} />
                      <CleanupStatusBadge status={w.cleanupStatus} />
                      <span className="small faint sb-nowrap" title={w.finishedAt ? fmtDateTime(w.finishedAt) : undefined}>
                        {w.finishedAt ? `finished ${timeAgo(w.finishedAt)}` : `started ${timeAgo(w.startedAt)}`}
                      </span>
                      {removableText(item.removable) && <span className="small muted">{removableText(item.removable)}</span>}
                      {item.users.some((u) => u.exists && u.usedBy.length) && <Badge kind="warn">used by other runs</Badge>}
                    </span>
                  </button>
                </div>
                {isOpen && (
                  <div className="cu-item-body">
                    <CleanupDetails item={item} skip={skip} setSkip={(id, on) => toggle(setSkip, id, on)} onChanged={() => void list.reload()} onOpen={onOpenRun} />
                    <div className="row cu-actions">
                      <button className="btn sm ghost" onClick={() => onOpenRun(w.id)}>
                        Open walkthrough
                      </button>
                      <span className="spacer" />
                      {w.cleanupStatus === 'dismissed' ? (
                        <button className="btn sm" onClick={() => void dismiss(item, true)}>
                          Reopen
                        </button>
                      ) : (
                        w.cleanupStatus === 'pending' && (
                          <button className="btn sm" onClick={() => void dismiss(item, false)} title="Leave the data in place and take the run off this list">
                            Dismiss
                          </button>
                        )
                      )}
                      {can && (
                        <button className="btn sm primary" disabled={flow.busy} onClick={() => void flow.start([w.id], skipFor(item, skip))}>
                          Clean up
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {flow.dialogs}
    </div>
  );
}

// ---------------- WalkthroughDrawer section ----------------

/** The cleanup section of one walkthrough: preview, Clean up now, Dismiss / Reopen. Hidden when the run created nothing. */
export function WalkthroughCleanup({ id, onRemoved, onChanged }: { id: string; onRemoved: () => void; onChanged: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const item = useFetch<CleanupItem>(sbPaths.walkthroughCleanup(slug, id), [slug, id]);
  const reload = useDebounced(() => void item.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'user.changed' || (e.type === 'walkthrough.changed' && (e.data as { id?: string } | null)?.id === id)) reload();
  });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const flow = useCleanupFlow((r) => {
    setSkip(new Set());
    if (r.runs.some((x) => x.id === id && x.removed.record)) onRemoved();
    else {
      void item.reload();
      onChanged();
    }
  });
  const it = item.data;
  if (!it) return item.error ? <ErrorBox error={item.error} /> : null;
  const w = it.walkthrough;
  if (w.cleanupStatus === 'none' && !it.users.length) return null;
  const can = canClean(it);
  const dismiss = async (reopen: boolean) => {
    setError(null);
    try {
      item.setData(reopen ? await sbApi.reopenCleanup(slug, id) : await sbApi.dismissCleanup(slug, id));
      toast(reopen ? 'Back in the cleanup list' : 'Left as is: the data stays');
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <section className="cu-section">
      <h3 className="section-title">
        Test data <CleanupStatusBadge status={w.cleanupStatus} />
      </h3>
      <ErrorBox error={error ?? flow.error} />
      <p className="small muted" style={{ margin: 0 }}>
        {w.cleanupStatus === 'cleaned'
          ? `Cleaned up${w.cleanupAt ? ` ${fmtDateTime(w.cleanupAt)}` : ''}. The steps, notes, screenshots and sign-off stay.`
          : removableText(it.removable)
            ? `Clean up removes ${removableText(it.removable)}. Nothing in your app is touched.`
            : can
              ? 'Its test users are still used by other runs: Clean up asks whether to clean those runs too or keep the users.'
              : 'Nothing left to remove right now.'}
      </p>
      <CleanupDetails item={it} skip={skip} setSkip={w.status === 'active' ? undefined : (uid, on) => setSkip((s) => {
        const n = new Set(s);
        if (on) n.add(uid);
        else n.delete(uid);
        return n;
      })} onChanged={() => void item.reload()} hideVars />
      {Object.keys(it.vars).length > 0 && <p className="small faint" style={{ margin: 0 }}>The captured vars below are values in your app; stubyard does not remove them.</p>}
      <div className="row cu-actions">
        <span className="spacer" />
        {w.cleanupStatus === 'dismissed' && (
          <button className="btn sm" onClick={() => void dismiss(true)}>
            Reopen
          </button>
        )}
        {w.cleanupStatus === 'pending' && w.status !== 'active' && (
          <button className="btn sm" onClick={() => void dismiss(false)} title="Leave the data in place and take the run off the cleanup list">
            Dismiss
          </button>
        )}
        {can && (
          <button className="btn sm primary" disabled={flow.busy} onClick={() => void flow.start([id], skipFor(it, skip))}>
            {flow.busy ? 'Checking…' : 'Clean up now'}
          </button>
        )}
      </div>
      {flow.dialogs}
    </section>
  );
}

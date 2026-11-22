// Cleanup (spec-cleanup.md): the runs whose test data (fresh users and their messages; a quick run's record) is still
// there. Select runs, uncheck or Keep-pin users, then Clean up selected: a dryRun first, a dialog when other runs still
// use the data, then the real call and a report. Dismiss leaves a run's data in place; the Dismissed filter can reopen it.
import { useEffect, useState } from 'react';
import {
  amountText,
  type CleanupItem,
  type CleanupModeFilter,
  type CleanupSelection,
  type CleanupStatusFilter,
  cleanupBody,
  EMPTY_SELECTION,
  isCleanable,
  pruneSelection,
  runTitle,
  selectionEstimate,
  toggleAll,
  toggleRun,
} from '../cleanup';
import { CleanupDetails, CleanupReport, ConflictDialog, useCleanupFlow } from '../cleanupUi';
import { ErrorBox, useAction, useLoad, usePanel } from '../context';
import { dismissCleanup, listCleanup, reopenCleanup, type HubTarget } from '../hub';

const STATUS_LABEL: Record<CleanupStatusFilter, string> = { pending: 'To clean', cleaned: 'Cleaned', dismissed: 'Dismissed', all: 'All' };

export function CleanupScreen() {
  const p = usePanel();
  if (!p.project) {
    return (
      <p className="muted">
        No project for this tab. <button className="link" onClick={() => p.go({ name: 'home' })}>Home</button>
      </p>
    );
  }
  return <CleanupList project={p.project} />;
}

function CleanupList({ project }: { project: string }) {
  const p = usePanel();
  const t = p.target(project);
  const [status, setStatus] = useState<CleanupStatusFilter>('pending');
  const [mode, setMode] = useState<CleanupModeFilter>('all');
  const list = useLoad(() => listCleanup(t, { status, mode }), [project, p.settings.apiUrl, status, mode, p.ticks.cleanup]);
  const [sel, setSel] = useState<CleanupSelection>(EMPTY_SELECTION);
  const [open, setOpen] = useState<string | null>(null);
  const flow = useCleanupFlow(t, () => {
    setSel(EMPTY_SELECTION);
    list.reload();
  });

  const items = list.data?.items ?? [];
  const counts = list.data?.counts;
  useEffect(() => setSel((s) => pruneSelection(s, items)), [list.data]);

  const cleanable = items.filter(isCleanable);
  const est = selectionEstimate(sel, items);
  const allOn = cleanable.length > 0 && cleanable.every((i) => sel.runs.includes(i.walkthrough.id));
  const count = (s: CleanupStatusFilter) => (s === 'all' || !counts ? '' : ` (${counts[s]})`);

  return (
    <div className="stack">
      <div className="row between">
        <h2>Clean up test data</h2>
        <button className="link small" onClick={() => p.go({ name: 'home' })}>
          Home
        </button>
      </div>
      <div className="row cu-filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as CleanupStatusFilter)} aria-label="Status">
          {(Object.keys(STATUS_LABEL) as CleanupStatusFilter[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
              {count(s)}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as CleanupModeFilter)} aria-label="Mode">
          <option value="all">Quick and tracked</option>
          <option value="quick">Quick tests</option>
          <option value="tracked">Tracked</option>
        </select>
      </div>
      {counts && counts.active > 0 && <p className="muted small">{counts.active} active run(s) also created data: finish or abandon them to clean it up.</p>}
      <ErrorBox error={list.error} />
      {list.data?.truncated && <p className="muted small">Showing the newest 500 runs: clean some up to see the rest.</p>}
      {flow.step.kind === 'report' && <CleanupReport result={flow.step.result} close={flow.close} />}
      {list.data && items.length === 0 && <p className="muted">{status === 'pending' ? 'Nothing to clean up.' : 'No runs here.'}</p>}
      {cleanable.length > 1 && (
        <label className="row small">
          <input type="checkbox" checked={allOn} onChange={() => setSel((s) => toggleAll(s, items))} /> Select all
        </label>
      )}
      {items.length > 0 && (
        <ul className="rows">
          {items.map((i) => (
            <CleanupCard
              key={i.walkthrough.id}
              t={t}
              item={i}
              sel={sel}
              setSel={setSel}
              expanded={open === i.walkthrough.id}
              toggle={() => setOpen(open === i.walkthrough.id ? null : i.walkthrough.id)}
              reload={list.reload}
            />
          ))}
        </ul>
      )}
      <ErrorBox error={flow.act.error} />
      {cleanable.length > 0 && (
        <div className="quick-foot stack">
          <button className="primary" disabled={!sel.runs.length || !!flow.act.busy} onClick={() => void flow.start(cleanupBody(sel, items))}>
            {flow.act.busy ? 'Cleaning…' : sel.runs.length ? `Clean up selected (${sel.runs.length})` : 'Clean up selected'}
          </button>
          {sel.runs.length > 0 && <span className="muted small">About {amountText(est)}</span>}
        </div>
      )}
      <ConflictDialog step={flow.step} choose={flow.choose} cancel={flow.close} busy={!!flow.act.busy} />
    </div>
  );
}

function CleanupCard(props: {
  t: HubTarget;
  item: CleanupItem;
  sel: CleanupSelection;
  setSel: (s: CleanupSelection) => void;
  expanded: boolean;
  toggle: () => void;
  reload: () => void;
}) {
  const { item, sel, t } = props;
  const w = item.walkthrough;
  const act = useAction();
  const cleanable = isCleanable(item);
  const when = w.finishedAt ?? w.startedAt;
  const title = runTitle(w);
  const sub = w.cleanupStatus === 'cleaned' && item.lastReport ? `removed ${amountText(item.lastReport.removed)}` : amountText(item.removable);
  const action = (label: string, fn: () => Promise<unknown>) =>
    void act.run(label, async () => {
      await fn();
      props.reload();
    });
  return (
    <li className="cu-card">
      <div className="item">
        <input
          type="checkbox"
          aria-label={`Select ${title}`}
          checked={sel.runs.includes(w.id)}
          disabled={!cleanable}
          onChange={(e) => props.setSel(toggleRun(sel, w.id, e.target.checked))}
        />
        <div className="item-main" onClick={props.toggle} title={`${w.storyboard?.name ?? ''} · key ${w.key}`}>
          <div className="item-name one-line">{title}</div>
          <div className="item-sub">
            <span className="chip">{w.mode === 'quick' ? 'Quick' : 'Tracked'}</span>
            {w.cleanupStatus !== 'pending' && <span className="chip">{w.cleanupStatus}</span>}
            <span className="one-line">
              {new Date(when).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · {sub}
            </span>
          </div>
        </div>
        <button className="link small" onClick={props.toggle} aria-expanded={props.expanded}>
          {props.expanded ? 'Less' : 'More'}
        </button>
      </div>
      {props.expanded && (
        <div className="cu-body">
          {label(item)}
          <CleanupDetails t={t} item={item} sel={sel} setSel={props.setSel} selectable={cleanable} reload={props.reload} />
          <div className="row wrap">
            {w.cleanupStatus === 'pending' && (
              <button disabled={!!act.busy} title="Leave the data in place and take the run off the list" onClick={() => action('dismiss', () => dismissCleanup(t, w.id))}>
                Dismiss
              </button>
            )}
            {w.cleanupStatus === 'dismissed' && (
              <button disabled={!!act.busy} onClick={() => action('reopen', () => reopenCleanup(t, w.id))}>
                Reopen
              </button>
            )}
          </div>
          <ErrorBox error={act.error} />
        </div>
      )}
    </li>
  );
}

/** The storyboard and key under a run's title (when the title is a label). */
function label(item: CleanupItem) {
  const w = item.walkthrough;
  return (
    <div className="muted small">
      {w.storyboard && w.label.trim() ? `${w.storyboard.name} · ` : ''}key <code>{w.key}</code> · {w.status}
    </div>
  );
}

// Cleanup UI pieces shared by the Cleanup screen and the "Clean up this run" section: a run's users (checkbox,
// messages, Keep toggle, used-by warning), its captured values, the dryRun → conflict dialog → run flow, the report.
import { useState } from 'react';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import {
  afterPreview,
  amountText,
  type CleanupBody,
  type CleanupItem,
  type CleanupResult,
  type CleanupSelection,
  type CleanupStep,
  type CleanupUser,
  cleanupBody,
  confirmText,
  conflictLines,
  conflictsFromError,
  isDeletableUser,
  keptReason,
  resolveConflicts,
  runTitle,
  selectionEstimate,
  toggleUser,
  userChecked,
  userLabel,
} from './cleanup';
import { ErrorBox, useAction, useLoad, usePanel } from './context';
import { cleanupRuns, dismissCleanup, getRunCleanup, reopenCleanup, setUserKeep, type HubTarget } from './hub';

/**
 * dryRun first; conflicts open the dialog, else a confirm and the real call. The dialog's choice runs a second dryRun
 * with it (so the confirm names the runs and counts that go); a 409 from the real call reopens the dialog.
 */
export function useCleanupFlow(t: HubTarget, after?: (r: CleanupResult) => void) {
  const act = useAction();
  const [step, setStep] = useState<CleanupStep>({ kind: 'idle' });
  const execute = async (body: CleanupBody) => {
    try {
      const result = await cleanupRuns(t, body);
      setStep({ kind: 'report', result });
      after?.(result);
    } catch (err) {
      const conflicts = conflictsFromError(err);
      if (!conflicts) throw err;
      setStep({ kind: 'conflicts', conflicts, body });
    }
  };
  const start = (body: CleanupBody) =>
    act.run('cleanup', async () => {
      setStep({ kind: 'idle' });
      const preview = await cleanupRuns(t, { ...body, dryRun: true });
      const next = afterPreview(preview, body);
      if (next) return setStep(next);
      if (!confirm(confirmText(preview))) return;
      await execute(body);
    });
  const choose = (choice: 'include' | 'keep') => {
    if (step.kind !== 'conflicts') return;
    const body = resolveConflicts(step.body, choice);
    void act.run('cleanup', async () => {
      const preview = await cleanupRuns(t, { ...body, dryRun: true });
      if (!confirm(confirmText(preview))) return; // back to the dialog
      setStep({ kind: 'idle' });
      await execute(body);
    });
  };
  return { act, step, start, choose, close: () => setStep({ kind: 'idle' }) };
}

export function ConflictDialog({ step, choose, cancel, busy }: { step: CleanupStep; choose: (c: 'include' | 'keep') => void; cancel: () => void; busy: boolean }) {
  if (step.kind !== 'conflicts') return null;
  return (
    <div className="dialog-back" onClick={cancel}>
      <div className="dialog card" role="dialog" aria-label="Data still in use" onClick={(e) => e.stopPropagation()}>
        <h3>Data still in use</h3>
        <ul className="warnings">
          {conflictLines(step.conflicts).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <p className="muted small">Clean both also cleans up the other runs (active runs keep their users). Keep those users leaves them in place.</p>
        <div className="row wrap">
          <button className="primary" disabled={busy} onClick={() => choose('include')}>
            Clean both
          </button>
          <button disabled={busy} onClick={() => choose('keep')}>
            Keep those users
          </button>
          <button disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function CleanupReport({ result, close }: { result: CleanupResult; close?: () => void }) {
  const kept = result.runs.flatMap((r) => r.kept.map((k) => ({ run: r, k })));
  const partial = result.runs.filter((r) => r.status === 'partial');
  return (
    <section className="card report">
      <div className="row between">
        <h3>Cleaned up</h3>
        {close && (
          <button className="link small" onClick={close}>
            OK
          </button>
        )}
      </div>
      <p>
        Removed {amountText(result.totals)} from {result.runs.length === 1 ? '1 run' : `${result.runs.length} runs`}.
      </p>
      {kept.length > 0 && (
        <>
          <div className="muted small">Kept users</div>
          <ul>
            {kept.map(({ run, k }) => (
              <li key={`${run.id}:${k.userId}`} className="small">
                {k.email ?? k.userId}: {keptReason(k)}
              </li>
            ))}
          </ul>
        </>
      )}
      {partial.length > 0 && (
        <p className="small">
          Partly cleaned (still in the list): {partial.map((r) => r.label || r.key).join(', ')}
        </p>
      )}
    </section>
  );
}

/** One user of a run: checkbox (on = delete), messages, Keep toggle, "Used by K". */
function UserRow(props: { u: CleanupUser; checked: boolean; selectable: boolean; onCheck: (on: boolean) => void; onKeep: () => void; disabled: boolean }) {
  const { u } = props;
  return (
    <li className={u.exists ? 'cu-user' : 'cu-user gone'}>
      <label className="row cu-user-main" title={u.role}>
        <input type="checkbox" checked={props.checked} disabled={!props.selectable || !isDeletableUser(u) || props.disabled} onChange={(e) => props.onCheck(e.target.checked)} />
        <span className="one-line">{userLabel(u)}</span>
      </label>
      {u.exists ? (
        <span className="row cu-user-side">
          <span className="muted small">{u.messages} msg</span>
          <button className={u.keep ? 'pill on' : 'pill'} title={u.keep ? 'Kept: a shared fixture, cleanup never deletes it' : 'Keep this user: cleanup never deletes it'} disabled={props.disabled} onClick={props.onKeep}>
            {u.keep ? 'Kept' : 'Keep'}
          </button>
        </span>
      ) : (
        <span className="muted small">already deleted</span>
      )}
      {u.usedBy.length > 0 && <div className="cu-warn small">Used by {u.usedBy.map((r) => r.key).join(', ')}</div>}
    </li>
  );
}

/** The expanded part of a run: users, captured values, the runs it reused, warnings. */
export function CleanupDetails(props: {
  t: HubTarget;
  item: CleanupItem;
  sel: CleanupSelection;
  setSel: (s: CleanupSelection) => void;
  /** Whether the users' checkboxes are live (the run is cleanable). */
  selectable: boolean;
  reload: () => void;
}) {
  const { item, sel } = props;
  const act = useAction();
  const vars = Object.entries(item.vars);
  const keep = (u: CleanupUser) =>
    void act.run('keep', async () => {
      await setUserKeep(props.t, u.userId, !u.keep);
      props.reload();
    });
  return (
    <div className="cu-details">
      {item.warnings.length > 0 && (
        <ul className="warnings small">
          {item.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {item.users.length > 0 ? (
        <ul className="cu-users">
          {item.users.map((u) => (
            <UserRow
              key={u.userId}
              u={u}
              checked={userChecked(sel, u)}
              selectable={props.selectable}
              disabled={!!act.busy}
              onCheck={(on) => props.setSel(toggleUser(sel, u.userId, on))}
              onKeep={() => keep(u)}
            />
          ))}
        </ul>
      ) : (
        <p className="muted small">This run created no users.</p>
      )}
      {vars.length > 0 && (
        <div className="cu-vars">
          <div className="muted small">Values in your app (not removed by stubyard)</div>
          <div className="chips">
            {vars.map(([k, v]) => (
              <span key={k} className="chip" title={v}>
                {k}: {v.length > 24 ? `${v.slice(0, 23)}…` : v}
              </span>
            ))}
          </div>
        </div>
      )}
      {item.uses.length > 0 && <p className="muted small">Uses data from {item.uses.map((r) => `${r.key} (${runTitle(r)})`).join(', ')}</p>}
      <ErrorBox error={act.error} />
    </div>
  );
}

/** "Clean up this run" after a run finished (tracked Summary, end of a quick run). Nothing happens automatically. */
export function RunCleanup({ t, w }: { t: HubTarget; w: Pick<WalkthroughView, 'id' | 'mode'> }) {
  const p = usePanel();
  const item = useLoad(() => getRunCleanup(t, w.id), [w.id, t.apiUrl, t.project, p.ticks.cleanup]);
  const [sel, setSel] = useState<CleanupSelection>({ runs: [w.id], skip: [] });
  const [later, setLater] = useState(false);
  const flow = useCleanupFlow(t, () => item.reload());
  const small = useAction();

  if (flow.step.kind === 'report') return <CleanupReport result={flow.step.result} />;
  const i = item.data;
  if (!i) return item.error ? <ErrorBox error={item.error} /> : null;
  const status = i.walkthrough.cleanupStatus;
  if (status === 'none' && i.users.length === 0) return null;
  if (status === 'cleaned') {
    return (
      <section className="card">
        <p className="small">
          Test data cleaned up{i.walkthrough.cleanupAt ? ` on ${new Date(i.walkthrough.cleanupAt).toLocaleString()}` : ''}
          {i.lastReport ? `: removed ${amountText(i.lastReport.removed)}.` : '.'}
        </p>
      </section>
    );
  }
  if (status === 'dismissed') {
    return (
      <section className="card">
        <div className="row between">
          <span className="small muted">Test data left in place.</span>
          <button className="small" disabled={!!small.busy} onClick={() => void small.run('reopen', async () => (await reopenCleanup(t, w.id), item.reload()))}>
            Reopen
          </button>
        </div>
        <ErrorBox error={small.error} />
      </section>
    );
  }
  if (later) {
    return (
      <p className="muted small">
        Left in the Clean up list.{' '}
        <button className="link small" onClick={() => setLater(false)}>
          Show
        </button>
      </p>
    );
  }
  const body = cleanupBody(sel, [i]);
  const nothing = selectionEstimate(sel, [i]).users === 0 && !i.removable.record;
  return (
    <section className="card cu-run">
      <h3>Clean up this run</h3>
      <p className="small">
        {i.removable.users === 0 && !i.removable.record && i.users.some((u) => isDeletableUser(u) && u.usedBy.length > 0)
          ? 'Its users are still used by other runs: Clean up asks whether to clean those too or keep the users.'
          : `Removes ${amountText(i.removable)}.`}
        {w.mode === 'tracked' && ' The record, steps and screenshots stay.'}
      </p>
      <CleanupDetails t={t} item={i} sel={sel} setSel={setSel} selectable={status === 'pending'} reload={item.reload} />
      <div className="row wrap">
        <button className="primary" disabled={!!flow.act.busy || status !== 'pending' || nothing} onClick={() => void flow.start(body)}>
          {flow.act.busy ? 'Cleaning…' : 'Clean up now'}
        </button>
        <button disabled={!!flow.act.busy} onClick={() => setLater(true)}>
          Later
        </button>
        {status === 'pending' && (
          <button className="link small" disabled={!!small.busy} onClick={() => void small.run('dismiss', async () => (await dismissCleanup(t, w.id), item.reload()))}>
            Leave it
          </button>
        )}
      </div>
      <ErrorBox error={flow.act.error ?? small.error} />
      <ConflictDialog step={flow.step} choose={flow.choose} cancel={flow.close} busy={!!flow.act.busy} />
    </section>
  );
}

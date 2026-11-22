// The React side of a shared long wait (run/waits.ts): start it (the pending state goes into the step data first, so a
// page that reloads or navigates right after can resume it), resume it when it is this view's, stop when another view
// took it over, and clear it when it ends, fails or is cancelled. An unmount (the widget's page navigated, the panel
// changed screen) leaves the pending state in place: that is what the next view resumes.
import { useEffect, useRef, useState } from 'react';
import type { WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { getWalkthrough, updateStep } from '@stubyard/client/walkthroughs';
import { useAbortable, useAction } from '../sidepanel/context';
import type { HubTarget } from '../sidepanel/hub';
import { isAbort } from '../sidepanel/tabs';
import { pageOrigin } from '../shared/settings';
import { useStepHost } from './host';
import { newPending, ownerLabel, pendingOf, type PendingWait, supersedes, WAIT_DATA_KEY, type WaitKind, waitRole } from './waits';

export interface WaitContext {
  signal: AbortSignal;
  pending: PendingWait;
  /** Re-reads the step from stubyard: true while this wait is still the step's pending one (check it right before filling). */
  mine: () => Promise<boolean>;
}

/** Returns the step data to store when it is done (the pending key is cleared with it), or null when it lost the wait. */
export type WaitTask = (ctx: WaitContext) => Promise<Record<string, unknown> | null>;

export interface SharedWaitOptions {
  kind: WaitKind;
  t: HubTarget;
  w: WalkthroughView;
  step: WalkthroughStepView;
  apply: (w: WalkthroughView) => void;
  /** How long the wait may run (its deadline is stored with it). */
  ms: number;
  task: WaitTask;
}

export function useSharedWait(o: SharedWaitOptions) {
  const p = useStepHost();
  const act = useAction();
  const abort = useAbortable();
  const key = WAIT_DATA_KEY[o.kind];
  const pending = pendingOf(o.step.data, o.kind);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [lostTo, setLostTo] = useState<PendingWait | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const current = useRef<PendingWait | null>(null);
  const why = useRef<'cancel' | 'lost' | null>(null);
  const resumed = useRef<string | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const tabId = p.tab?.id ?? null;
  const role = waitRole(pending, { surface: p.surface, tabId, windowId: p.windowId, runningId }, now);

  // A wait past its deadline is over: render again then.
  useEffect(() => {
    if (!pending) return;
    const ms = pending.until - Date.now();
    if (ms <= 0) return setNow(Date.now());
    const id = setTimeout(() => setNow(Date.now()), Math.min(ms + 50, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [pending?.id, pending?.until]);

  const stillMine = async (pw: PendingWait): Promise<boolean> => {
    const { t, w, step, kind } = latest.current;
    try {
      const fresh = await getWalkthrough(t, w.id);
      return pendingOf(fresh.steps.find((s) => s.id === step.id)?.data, kind)?.id === pw.id;
    } catch {
      return false; // cannot tell: do not fill (another view may own it)
    }
  };

  const write = async (data: Record<string, unknown>) => {
    const { t, w, step, apply } = latest.current;
    apply(await updateStep(t, w.id, step.id, { data }));
  };

  const run = (pw: PendingWait, written?: () => void) =>
    act.run(o.kind, async () => {
      const signal = abort.start();
      why.current = null;
      current.current = pw;
      resumed.current = pw.id;
      setRunningId(pw.id);
      setLostTo(null);
      p.setBusy?.(o.kind, true);
      try {
        if (written) {
          try {
            await write({ [key]: pw });
          } finally {
            written();
          }
        }
        const result = await latest.current.task({ signal, pending: pw, mine: () => stillMine(pw) });
        if (result) await write({ [key]: null, ...result });
      } catch (err) {
        // Unmounted (page reload or navigation, another screen) or taken over: the pending state stays for its owner.
        if (isAbort(err) && why.current !== 'cancel') return;
        if (await stillMine(pw)) await write({ [key]: null }).catch(() => {});
        throw err;
      } finally {
        if (current.current?.id === pw.id) {
          current.current = null;
          setRunningId(null);
        }
        p.setBusy?.(o.kind, false);
      }
    });

  /**
   * Start a new wait owned by this view (resolves once its pending state is stored). `origin`: where the wait started
   * (a take-over keeps the original one); by default the page origin of this view's tab, when the wait is for it.
   */
  const start = (onTab?: number | null, origin?: string | null): Promise<void> => {
    const target = onTab ?? tabId;
    if (target === null) return Promise.reject(new Error('No tab.'));
    const from = origin !== undefined ? origin : target === tabId ? pageOrigin(p.tab?.url ?? null) : null;
    const pw = newPending({ owner: p.surface, tabId: target, windowId: p.windowId, now: Date.now(), ms: o.ms, origin: from });
    return new Promise<void>((resolve) => void run(pw, resolve));
  };

  const cancel = () => {
    why.current = 'cancel';
    abort.cancel();
  };

  /** Run another view's wait here instead (the widget on its own tab; the panel on the wait's tab). */
  const takeOver = () => start(p.surface === 'widget' ? tabId : (pending?.tabId ?? tabId), pending ? (pending.origin ?? null) : undefined);

  // Another view took it over (a newer pending wait replaced ours): stop without filling or clearing.
  useEffect(() => {
    const mine = current.current;
    if (mine && supersedes(pending, mine)) {
      why.current = 'lost';
      setLostTo(pending);
      abort.cancel();
    }
  }, [pending?.id]);

  // This view's wait, started before a reload or a navigation (or before the panel changed screen): continue it.
  useEffect(() => {
    if (role !== 'resume' || !pending || current.current || resumed.current === pending.id) return;
    void run(pending);
  }, [role, pending?.id]);

  // The panel: a wait owned by a page widget that cannot be there (the tab navigated to a page without the widget, the
  // tab closed, the widget was switched off) is taken over, so the code is still filled.
  useEffect(() => {
    if (p.surface !== 'panel' || role !== 'elsewhere' || !pending || pending.owner !== 'widget') return;
    let live = true;
    const check = () =>
      void p.widgetOn(pending.tabId).then(
        (on) => {
          if (live && !on && !current.current) {
            live = false;
            void start(pending.tabId, pending.origin ?? null);
          }
        },
        () => {},
      );
    check();
    const id = setInterval(check, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [role, pending?.id]);

  return {
    role,
    pending,
    running: runningId !== null,
    error: act.error,
    /** "the side panel" / "the page widget", for an elsewhere wait. */
    where: pending ? ownerLabel(pending, { tabId }) : '',
    lostTo,
    start,
    cancel,
    takeOver,
  };
}

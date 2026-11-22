// The open run: load the walkthrough record (again on every reload tick, i.e. each walkthrough.changed event of it),
// find its current step and resolve that step (URLs, credentials, rendered entries; this also marks a pending step
// active). Shared by the side panel's Walkthrough screen and, later, the on-page widget. The hub's record is the only
// state: `apply` takes the view a PATCH returned.
import { useCallback, useEffect, useState } from 'react';
import type { ResolvedStep, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { getWalkthrough, resolveStep } from '@stubyard/client/walkthroughs';
import { errorText, type HubTarget } from '../sidepanel/hub';
import { currentStep } from '../sidepanel/state';

export interface RunState {
  w: WalkthroughView | null;
  loadError: string | null;
  /** The current step (null when all are finished, or the run is not loaded). */
  step: WalkthroughStepView | null;
  /** The last resolved step; check `stepId` (or use resolvedFor) before showing it for a step. */
  resolved: { stepId: string; r: ResolvedStep } | null;
  resolveError: string | null;
  /** Resolve the current step again (Retry). */
  reresolve: () => void;
  /** Show the view a stubyard call returned. */
  apply: (w: WalkthroughView) => void;
}

/** The resolved data of a step, only when it belongs to that step. */
export function resolvedFor(resolved: RunState['resolved'], stepId: string | null | undefined): ResolvedStep | null {
  return resolved && stepId && resolved.stepId === stepId ? resolved.r : null;
}

/**
 * @param t the stubyard target of the run's project (null: no run open)
 * @param id the walkthrough id (null: no run open)
 * @param reloadTick bumped to load the record again
 */
export function useRun(t: HubTarget | null, id: string | null, reloadTick: number): RunState {
  const [w, setW] = useState<WalkthroughView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<RunState['resolved']>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveNonce, setResolveNonce] = useState(0);

  useEffect(() => {
    if (!id || !t) return;
    let live = true;
    setW((prev) => (prev?.id === id ? prev : null));
    getWalkthrough(t, id).then(
      (v) => {
        if (!live) return;
        setW(v);
        setLoadError(null);
      },
      (err) => live && setLoadError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [id, t?.project, t?.apiUrl, reloadTick]);

  const step = w ? currentStep(w) : null;

  useEffect(() => {
    if (!w || !t || !step || w.status !== 'active') return;
    let live = true;
    setResolveError(null);
    resolveStep(t, w.id, step.id).then(
      (r) => live && setResolved({ stepId: step.id, r }),
      (err) => {
        if (!live) return;
        setResolved(null);
        setResolveError(errorText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [w?.id, w?.status, step?.id, resolveNonce]);

  const apply = useCallback((v: WalkthroughView) => setW(v), []);
  const reresolve = useCallback(() => setResolveNonce((n) => n + 1), []);
  return { w, loadError, step, resolved, resolveError, reresolve, apply };
}

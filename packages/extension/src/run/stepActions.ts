// The tracked step's outcome actions (Done / Skip / Fail with a note, Screenshot, Next), shared by the side panel's
// StepCard and the on-page widget's card, so both record a step the same way.
import type { WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import { addScreenshot, getWalkthrough, patchWalkthrough, updateStep } from '@stubyard/client/walkthroughs';
import { useAction } from '../sidepanel/context';
import type { HubTarget } from '../sidepanel/hub';
import { nextOpenStepId } from '../sidepanel/state';
import { captureClean } from '../sidepanel/tabs';
import { useStepHost } from './host';

export type StepOutcome = 'done' | 'skipped' | 'failed';

export function useStepActions(t: HubTarget, w: WalkthroughView, step: WalkthroughStepView, apply: (w: WalkthroughView) => void) {
  const p = useStepHost();
  const act = useAction();

  const screenshot = async () => {
    // captureClean hides stubyard's on-page widget for the shot. It captures the window's active tab.
    const dataUrl = await captureClean(p.tab?.id ?? null, p.tab?.windowId ?? p.windowId);
    await addScreenshot(t, w.id, step.id, dataUrl);
    apply(await getWalkthrough(t, w.id));
  };

  const finish = (status: StepOutcome, note: string) =>
    act.run(status, async () => {
      if (status === 'done' && step.screenshot === 'required' && step.shots.length === 0) {
        p.notify('This step needs a screenshot: taking one now.');
        await screenshot();
      }
      apply(await updateStep(t, w.id, step.id, { status, note }));
    });

  const nextId = nextOpenStepId(w, step.id);
  const next = () =>
    act.run('next', async () => {
      if (nextId) apply(await patchWalkthrough(t, w.id, { currentStepId: nextId }));
    });

  return { act, finish, next, hasNext: !!nextId, shoot: () => act.run('shot', screenshot) };
}

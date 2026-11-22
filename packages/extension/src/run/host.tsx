// The step host: what the step controls (steps/*Controls, StepCard, QuickRun) need from the view that shows them.
// The side panel provides it today; the on-page widget (docs/design/floating-widget.md) will provide its own, so the
// controls are shared, not forked. Keep it small: anything panel-only (settings, screens, cleanup ticks) stays in
// PanelState (sidepanel/context.tsx).
import { createContext, useContext } from 'react';
import type { ActiveWalkthrough } from '../shared/settings';
import type { HubTarget } from '../sidepanel/hub';
import type { TabInfo } from '../sidepanel/tabs';

export type StepSurface = 'panel' | 'widget';

export interface StepHost {
  /** Which view the controls are in. */
  surface: StepSurface;
  /** The tab the controls act on: the panel's window's active tab; the widget's own tab. Null when there is none. */
  tab: TabInfo | null;
  windowId: number;
  /** The target for stubyard calls of a project. */
  target: (project: string) => HubTarget;
  /** A short message to the user (panel: a toast; widget: its status line). */
  notify: (msg: string) => void;
  /** Bumped by the "fill-form" keyboard command. */
  fillRequest: number;
  /** Open (or with null close) the walkthrough of this window. */
  openWalkthrough: (a: ActiveWalkthrough | null) => Promise<void>;
  /** Shorter labels and details collapsed (the widget). */
  compact: boolean;
}

export const StepHostContext = createContext<StepHost | null>(null);

export function useStepHost(): StepHost {
  const h = useContext(StepHostContext);
  if (!h) throw new Error('useStepHost outside StepHostContext');
  return h;
}

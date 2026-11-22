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
  /**
   * The run's origins (the run's origin and the project's appOrigins; ActiveWalkthrough.origins). Credentials and form
   * data go into other pages only after the tester confirms in the panel; the widget refuses (review items 1 and 3).
   * Undefined: not known (a run opened before origins were stored): nothing is checked, as before.
   */
  appOrigins?: readonly string[] | null;
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
  /**
   * Whether the on-page widget shows on a tab (the widget: true for its own tab; the panel: the widget's eligibility
   * rules). The panel takes over a widget's 2FA or email wait when the widget cannot be on that tab (run/waits.ts).
   */
  widgetOn: (tabId: number) => Promise<boolean>;
  /** Open the side panel (the widget only; must run inside a click). */
  openPanel?: () => void;
  /** A long wait started or ended in this view (the widget shows it on its collapsed pill). */
  setBusy?: (key: string, on: boolean) => void;
}

export const StepHostContext = createContext<StepHost | null>(null);

export function useStepHost(): StepHost {
  const h = useContext(StepHostContext);
  if (!h) throw new Error('useStepHost outside StepHostContext');
  return h;
}

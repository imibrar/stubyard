// Starting a walkthrough, shared by the Start screen and Home's one-tap "Quick" button.
import { getStoryboard } from '@stubyard/client/storyboards';
import { startWalkthrough } from '@stubyard/client/walkthroughs';
import type { PanelState } from './context';
import { getProject } from './hub';
import { defaultOrigin, initialVars, missingDefaultPassword, oneTapQuick, startBody } from './state';
import { startVideoFor } from '../run/useVideo';

/** Starts a run, opens it in this window, and shows the hub's warnings. */
export async function launchRun(p: PanelState, project: string, body: ReturnType<typeof startBody>): Promise<void> {
  const w = await startWalkthrough(p.target(project), body);
  await p.openWalkthrough({ project, id: w.id });
  // Video: start the capture of this window's tab now, still inside the Start click (Chrome's tab capture).
  let videoError: string | null = null;
  if (w.recording?.mode === 'video') {
    const r = await startVideoFor(p.tab?.id).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!r.ok) videoError = `The video did not start: ${r.error}`;
  }
  const notes = [...w.warnings, ...(videoError ? [videoError] : [])];
  if (notes.length) p.notify(notes.join('\n'));
}

/**
 * Starts a quick test with the Start screen's defaults (input defaults, default actors, preselected origin) when
 * nothing needs choosing; otherwise opens the Start screen with the quick test button first.
 */
export async function quickStartOrOpen(p: PanelState, project: string, slug: string): Promise<void> {
  const t = p.target(project);
  const [sb, proj] = await Promise.all([getStoryboard(t, slug), getProject(t)]);
  // The Start screen also when fresh users would get the fallback password: its warning must be seen first.
  if (!oneTapQuick(sb) || missingDefaultPassword(sb, proj.settings)) return p.go({ name: 'start', storyboard: slug, mode: 'quick' });
  await launchRun(
    p,
    project,
    startBody({ storyboard: sb.slug, origin: defaultOrigin(p.origin, proj.settings.appOrigins ?? []), label: '', vars: initialVars(sb.inputs), actors: {}, mode: 'quick' }),
  );
}

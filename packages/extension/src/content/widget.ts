// The content script's side of the on-page widget (docs/design/floating-widget.md). Phase 0 has no widget yet:
// only the hooks every later version relies on, so that screenshots and re-injection already behave.
//  - suspend/resume: captureClean() hides any widget host for the screenshot and shows it again afterwards.
//  - removeWidgetHosts: a replaced (orphaned) content script's widget is taken off the page.
import { WIDGET_AUTO_RESUME_MS, WIDGET_HOST_ATTR, type WidgetResumeResult, type WidgetSuspendResult } from '../shared/protocol';

export function widgetHosts(doc: Document = document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(`[${WIDGET_HOST_ATTR}]`));
}

/** Remove every widget host (for example one left behind by a content script from before an extension reload). */
export function removeWidgetHosts(doc: Document = document): number {
  const hosts = widgetHosts(doc);
  for (const h of hosts) h.remove();
  return hosts.length;
}

/** Two animation frames, so the hidden widget is off the next painted frame; a timeout stands in when frames do not come. */
export function nextFrames(n = 2, win: Window = window, maxMs = 150): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const done = setTimeout(resolve, maxMs);
    const tick = () => {
      left -= 1;
      if (left <= 0) {
        clearTimeout(done);
        resolve();
      } else win.requestAnimationFrame(tick);
    };
    if (typeof win.requestAnimationFrame !== 'function') return;
    win.requestAnimationFrame(tick);
  });
}

let autoResume: ReturnType<typeof setTimeout> | null = null;

export async function suspendWidget(doc: Document = document): Promise<WidgetSuspendResult> {
  const hosts = widgetHosts(doc);
  if (!hosts.length) return { ok: true, hidden: 0 };
  for (const h of hosts) h.style.setProperty('visibility', 'hidden', 'important');
  if (autoResume) clearTimeout(autoResume);
  autoResume = setTimeout(() => resumeWidget(doc), WIDGET_AUTO_RESUME_MS);
  await nextFrames(2, doc.defaultView ?? window);
  return { ok: true, hidden: hosts.length };
}

export function resumeWidget(doc: Document = document): WidgetResumeResult {
  if (autoResume) clearTimeout(autoResume);
  autoResume = null;
  for (const h of widgetHosts(doc)) h.style.removeProperty('visibility');
  return { ok: true };
}

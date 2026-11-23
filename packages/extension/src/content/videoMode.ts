// Video mode in the page (walkthrough recording R2): a video cannot mask anything, so while the tab is recorded as
// video the fields the extension typed a password or a 2FA code into show dots (-webkit-text-security: disc, set
// before the value lands), and the on-page widget collapses to its pill so its card stays out of the video. Both are
// undone when video mode ends. What the tester types by hand is visible: the Start screen says so.
import type { VideoModeResult, WidgetToggleResult } from '../shared/protocol';

const PROP = '-webkit-text-security';
/** Set on a field while it shows dots for the video (the style is the mask; the attribute says why it is there). */
export const VIDEO_DOTS_ATTR = 'data-stubyard-video-dots';

let on = false;
let collapsedByVideo = false;
const secretFields = new Set<HTMLElement>();
const saved = new WeakMap<HTMLElement, { value: string; priority: string }>();

function hide(el: HTMLElement): void {
  if (saved.has(el)) return;
  saved.set(el, { value: el.style.getPropertyValue(PROP), priority: el.style.getPropertyPriority(PROP) });
  el.style.setProperty(PROP, 'disc', 'important');
  el.setAttribute(VIDEO_DOTS_ATTR, '');
}

function unhide(el: HTMLElement): void {
  const s = saved.get(el);
  if (!s) return;
  saved.delete(el);
  el.removeAttribute(VIDEO_DOTS_ATTR);
  if (s.value) el.style.setProperty(PROP, s.value, s.priority);
  else el.style.removeProperty(PROP);
}

export const videoModeOn = () => on;

/** A field the extension is about to type a secret into: dots now when video is on, and whenever it turns on. */
export function noteSecretField(el: Element | null | undefined): void {
  if (!el || !(el as HTMLElement).style) return;
  secretFields.add(el as HTMLElement);
  if (on) hide(el as HTMLElement);
}

/** Turn video mode on or off. widget: the page's widget host (collapse / expand; isCollapsed: its state now or null). */
export function setVideoMode(next: boolean, widget: { isCollapsed(): boolean | null; toggle(collapsed: boolean): WidgetToggleResult }): VideoModeResult {
  for (const el of [...secretFields]) if (!el.isConnected) secretFields.delete(el);
  if (next) {
    on = true;
    for (const el of secretFields) hide(el);
    const c = widget.isCollapsed();
    if (c === false) {
      widget.toggle(true);
      collapsedByVideo = true;
    }
  } else if (on) {
    on = false;
    for (const el of secretFields) unhide(el);
    if (collapsedByVideo && widget.isCollapsed() === true) widget.toggle(false);
    collapsedByVideo = false;
  }
  return { ok: true, on, hidden: on ? secretFields.size : 0 };
}

/** Tests: forget everything. */
export function resetVideoMode(): void {
  for (const el of secretFields) unhide(el);
  secretFields.clear();
  on = false;
  collapsedByVideo = false;
}

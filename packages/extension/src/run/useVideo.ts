// Video mode in the views (walkthrough recording R2): the running capture and why the last one ended, read from
// chrome.storage.session (the service worker writes them; extension pages may read them, pages cannot), and the
// Record video action (a user gesture: Chrome's tab capture needs the extension invoked on the tab).
import { useEffect, useState } from 'react';
import { VIDEO_SESSION_KEY, type VideoSession, type VideoStartMessage, type VideoStartResult } from '../shared/video';

export const VIDEO_ENDED_KEY = 'videoEnded';
export interface VideoEnded {
  walkthroughId: string;
  reason: string;
  at: string;
}

type SessionArea = { get(k: string[]): Promise<Record<string, unknown>> };
const area = (): SessionArea | null => (typeof chrome !== 'undefined' && chrome.storage?.session ? (chrome.storage.session as unknown as SessionArea) : null);

/** The capture of this run (null: none) and the last end reason of this run's video. */
export function useVideo(walkthroughId: string | null | undefined): { session: VideoSession | null; ended: VideoEnded | null } {
  const [state, setState] = useState<{ session: VideoSession | null; ended: VideoEnded | null }>({ session: null, ended: null });
  useEffect(() => {
    const a = area();
    if (!a || !walkthroughId) return;
    let live = true;
    const read = () =>
      void a.get([VIDEO_SESSION_KEY, VIDEO_ENDED_KEY]).then(
        (r) => {
          if (!live) return;
          const s = r[VIDEO_SESSION_KEY] as VideoSession | undefined;
          const e = r[VIDEO_ENDED_KEY] as VideoEnded | undefined;
          setState({ session: s?.walkthroughId === walkthroughId ? s : null, ended: e?.walkthroughId === walkthroughId ? e : null });
        },
        () => {},
      );
    read();
    const onChanged = (changes: Record<string, unknown>, name: string) => {
      if (name === 'session' && (VIDEO_SESSION_KEY in changes || VIDEO_ENDED_KEY in changes)) read();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [walkthroughId]);
  return state;
}

/** Ask the service worker to record a tab (the view's active tab when none is given). */
export async function startVideoFor(tabId?: number | null): Promise<VideoStartResult> {
  let id = tabId ?? null;
  if (id === null) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    id = t?.id ?? null;
  }
  if (id === null) return { ok: false, error: 'No tab to record.' };
  const r = (await chrome.runtime.sendMessage({ type: 'video.start', tabId: id } satisfies VideoStartMessage)) as VideoStartResult | undefined;
  return r ?? { ok: false, error: 'The extension did not answer.' };
}

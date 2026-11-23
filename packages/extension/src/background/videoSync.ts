// The service worker's part of video recording (walkthrough recording R2; shared/video.ts). Like recordingSync.ts it
// keeps no state of its own: the running capture is in chrome.storage.session (VIDEO_SESSION_KEY), the recorder in
// the offscreen document. It starts a capture (a view's Record video / the Start button, or Alt+Shift+V), follows the
// run (pause and resume, step markers, stop when the run ends, recording is switched off or hits the cap; pause while
// the tab shows a page outside the run's origins), uploads the offscreen chunks to the hub and tells the tab's content
// script that video is on (the widget collapses to its pill, the extension's secret fills show as dots).
// chrome.* and the hub calls are passed in, so the logic is unit-tested.
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { CONTENT_VERSION, type ContentRequest } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import {
  type BeginResult,
  captureSize,
  newVideoKey,
  NOT_INVOKED_HELP,
  NOT_INVOKED_RE,
  type OffscreenStatus,
  type ToOffscreen,
  type VideoChunkMessage,
  type VideoChunkReply,
  type VideoEndedMessage,
  VIDEO_SESSION_KEY,
  type VideoSession,
  type VideoStartResult,
} from '../shared/video';
import { recordsOn } from './recordingSync';

/** Why the last capture of a run ended (chrome.storage.session; the views show it next to Record video). */
export const VIDEO_ENDED_KEY = 'videoEnded';
export interface VideoEndedInfo {
  walkthroughId: string;
  reason: string;
  at: string;
}

export interface VideoTab {
  id?: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
  width?: number;
  height?: number;
}

export interface VideoUploadBody {
  kind: 'video';
  segment: { key: string; url: string; startedAt: string; stepId: string | null };
  seq: number;
  data: string;
  mime: string;
  durationMs: number;
  markers: { at: number; stepId: string }[];
  width?: number;
  height?: number;
  final: boolean;
}

export interface VideoDeps {
  loadSettings(): Promise<Settings>;
  getWalkthrough(apiUrl: string, project: string, id: string): Promise<WalkthroughView>;
  session: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };
  getTab(tabId: number): Promise<VideoTab | null>;
  /** chrome.tabCapture.getMediaStreamId({targetTabId}) (throws when the extension was not invoked on the tab). */
  getStreamId(tabId: number): Promise<string>;
  ensureOffscreen(): Promise<void>;
  closeOffscreen(): Promise<void>;
  toOffscreen(msg: ToOffscreen): Promise<unknown>;
  ping(tabId: number): Promise<string | null>;
  inject(tabId: number): Promise<void>;
  send(tabId: number, msg: ContentRequest): Promise<unknown>;
  upload(apiUrl: string, project: string, id: string, body: VideoUploadBody): Promise<{ bytes: number; maxBytes: number; state: Extract<VideoChunkReply, { ok: true }>['state'] }>;
  /** chrome.runtime.getURL('offscreen.html'): chunks are only taken from there. */
  offscreenUrl: string;
  now?: () => Date;
}

const STOP_STATUSES = new Set([400, 404, 409, 413]);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function readSession(deps: Pick<VideoDeps, 'session'>): Promise<VideoSession | null> {
  const r = (await deps.session.get(VIDEO_SESSION_KEY))[VIDEO_SESSION_KEY];
  return r && typeof r === 'object' && typeof (r as VideoSession).key === 'string' ? (r as VideoSession) : null;
}
const saveSession = (deps: Pick<VideoDeps, 'session'>, s: VideoSession) => deps.session.set({ [VIDEO_SESSION_KEY]: s });

/** Tell the tab's content script video is on or off (the widget pill, dots over secret fills). Best effort. */
async function contentVideo(tabId: number, on: boolean, deps: Pick<VideoDeps, 'ping' | 'inject' | 'send'>): Promise<void> {
  try {
    const v = await deps.ping(tabId);
    if (v === null && !on) return;
    if (v !== CONTENT_VERSION) await deps.inject(tabId);
    await deps.send(tabId, { type: 'recording.video', on });
  } catch {
    /* a page that cannot be scripted, or one navigating: the next tab event retries */
  }
}

/** The offscreen recorder's status, or null when there is none (the document was closed or crashed). */
async function offscreenStatus(deps: Pick<VideoDeps, 'toOffscreen'>): Promise<OffscreenStatus | null> {
  try {
    const r = (await deps.toOffscreen({ target: 'offscreen', type: 'video.status' })) as OffscreenStatus | undefined;
    return r && typeof r === 'object' && 'recording' in r ? r : null;
  } catch {
    return null;
  }
}

/** End the capture: the recorder sends its last chunk, then video.ended (handleVideoEnded clears up). */
export async function stopVideo(reason: string, deps: VideoDeps): Promise<void> {
  const s = await readSession(deps);
  if (!s) return;
  const st = await offscreenStatus(deps);
  if (st?.recording && st.key === s.key) {
    await deps.toOffscreen({ target: 'offscreen', type: 'video.stop', reason }).catch(() => {});
    return;
  }
  await finish(s, reason, deps); // no recorder left: clear up here
}

async function finish(s: VideoSession, reason: string, deps: VideoDeps): Promise<void> {
  await deps.session.remove(VIDEO_SESSION_KEY);
  await deps.session.set({ [VIDEO_ENDED_KEY]: { walkthroughId: s.walkthroughId, reason, at: (deps.now?.() ?? new Date()).toISOString() } satisfies VideoEndedInfo });
  await deps.closeOffscreen().catch(() => {});
  await contentVideo(s.tabId, false, deps);
}

/** Start recording a tab as video for the run open in its window (called on a user gesture). */
export async function startVideo(tabId: number, deps: VideoDeps): Promise<VideoStartResult> {
  const tab = await deps.getTab(tabId);
  if (!tab || tab.id === undefined) return { ok: false, error: 'The tab is gone.' };
  const settings = await deps.loadSettings();
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  if (!active) return { ok: false, error: 'No walkthrough is open in this window.' };
  let w: WalkthroughView;
  try {
    w = await deps.getWalkthrough(settings.apiUrl, active.project, active.id);
  } catch (err) {
    return { ok: false, error: `stubyard could not be reached: ${errText(err)}` };
  }
  const r = w.recording;
  if (w.status !== 'active') return { ok: false, error: 'This walkthrough has ended.' };
  if (!r || r.mode !== 'video') return { ok: false, error: 'This run does not record video (choose Video when starting it, or on the dashboard).' };
  if (r.stopped) return { ok: false, error: r.stopped };

  const running = await readSession(deps);
  if (running) {
    const st = await offscreenStatus(deps);
    if (st?.recording && st.key === running.key) {
      if (running.walkthroughId === w.id && running.tabId === tabId) return { ok: true, already: true };
      return { ok: false, error: 'Another tab is being recorded as video. Finish or pause that run first (one video at a time).' };
    }
    await deps.session.remove(VIDEO_SESSION_KEY); // a stale session (the recorder is gone)
  }

  let streamId: string;
  try {
    streamId = await deps.getStreamId(tabId);
  } catch (err) {
    const m = errText(err);
    return { ok: false, error: NOT_INVOKED_RE.test(m) ? NOT_INVOKED_HELP : `Chrome did not allow recording this tab: ${m}` };
  }
  const url = tab.url || tab.pendingUrl || '';
  const offOrigin = !recordsOn(url, active);
  const session: VideoSession = {
    tabId,
    windowId: tab.windowId,
    project: active.project,
    walkthroughId: w.id,
    key: newVideoKey(),
    startedAt: (deps.now?.() ?? new Date()).toISOString(),
    url,
    stepId: w.currentStepId ?? null,
    paused: r.paused || offOrigin,
    pausedFor: r.paused ? 'run' : offOrigin ? 'origin' : null,
  };
  try {
    await deps.ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `The recorder could not start: ${errText(err)}` };
  }
  await saveSession(deps, session);
  let res: BeginResult;
  try {
    res = ((await deps.toOffscreen({ target: 'offscreen', type: 'video.begin', streamId, session, size: captureSize(tab.width, tab.height) })) as BeginResult | undefined) ?? { ok: false, error: 'the recorder did not answer' };
  } catch (err) {
    res = { ok: false, error: errText(err) };
  }
  if (!res.ok) {
    await deps.session.remove(VIDEO_SESSION_KEY);
    await deps.closeOffscreen().catch(() => {});
    return { ok: false, error: res.error };
  }
  await saveSession(deps, { ...session, mime: res.mime, width: res.width, height: res.height });
  await deps.session.remove(VIDEO_ENDED_KEY);
  if (!offOrigin) await contentVideo(tabId, true, deps);
  return { ok: true };
}

/** Apply the run's state to the running capture: stop, pause / resume, a step marker. */
async function follow(
  s: VideoSession,
  st: { mode: string; status: string; paused: boolean; stopped: string | null; currentStepId: string | null },
  offOrigin: boolean | null,
  deps: VideoDeps,
): Promise<'recording' | 'paused' | 'stopped'> {
  if (st.status !== 'active') return stopVideo('The walkthrough ended', deps).then(() => 'stopped');
  if (st.mode !== 'video') return stopVideo('Video recording was switched off for this run', deps).then(() => 'stopped');
  if (st.stopped) return stopVideo(st.stopped, deps).then(() => 'stopped');
  const origin = offOrigin ?? s.pausedFor === 'origin';
  const paused = st.paused || origin;
  const next: VideoSession = { ...s, paused, pausedFor: st.paused ? 'run' : origin ? 'origin' : null };
  if (paused !== s.paused) await deps.toOffscreen({ target: 'offscreen', type: paused ? 'video.pause' : 'video.resume' }).catch(() => {});
  if ((st.currentStepId ?? null) !== s.stepId) {
    next.stepId = st.currentStepId ?? null;
    if (next.stepId) await deps.toOffscreen({ target: 'offscreen', type: 'video.step', stepId: next.stepId }).catch(() => {});
  }
  if (next.paused !== s.paused || next.pausedFor !== s.pausedFor || next.stepId !== s.stepId) await saveSession(deps, next);
  return paused ? 'paused' : 'recording';
}

/**
 * Follow the run (recording.sync from the views, tab updates): reads the hub. tabId: only when that tab is the
 * captured one (tab events of other tabs are ignored).
 */
export async function syncVideo(deps: VideoDeps, tabId?: number): Promise<'none' | 'recording' | 'paused' | 'stopped' | 'error'> {
  const s = await readSession(deps);
  if (!s || (tabId !== undefined && tabId !== s.tabId)) return 'none';
  const tab = await deps.getTab(s.tabId);
  if (!tab) return stopVideo('The tab was closed', deps).then(() => 'stopped');
  const settings = await deps.loadSettings();
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  if (!active || active.id !== s.walkthroughId) return stopVideo('The run was closed in this window', deps).then(() => 'stopped');
  const st = await offscreenStatus(deps);
  if (!st || !st.recording || st.key !== s.key) {
    await finish(s, 'The recorder stopped', deps);
    return 'stopped';
  }
  let w: WalkthroughView;
  try {
    w = await deps.getWalkthrough(settings.apiUrl, active.project, active.id);
  } catch {
    return 'error';
  }
  const url = tab.url || tab.pendingUrl || '';
  const offOrigin = !recordsOn(url, active);
  const out = await follow(s, { mode: w.recording?.mode ?? 'off', status: w.status, paused: !!w.recording?.paused, stopped: w.recording?.stopped ?? null, currentStepId: w.currentStepId ?? null }, offOrigin, deps);
  if (out !== 'stopped' && !offOrigin) await contentVideo(s.tabId, true, deps);
  return out;
}

/** A WebM chunk from the offscreen recorder: uploaded with the settings' hub URL; the reply carries the hub's state. */
export async function handleVideoChunk(msg: VideoChunkMessage, sender: { id?: string; url?: string }, deps: VideoDeps): Promise<VideoChunkReply> {
  if (sender.url !== deps.offscreenUrl) return { ok: false, error: 'not the recorder', stop: true };
  const s = await readSession(deps);
  if (!s || s.key !== msg.key) return { ok: false, error: 'no video is being recorded', stop: true };
  if (typeof msg.seq !== 'number' || typeof msg.data !== 'string') return { ok: false, error: 'bad chunk', stop: true };
  const settings = await deps.loadSettings();
  try {
    const r = await deps.upload(settings.apiUrl, s.project, s.walkthroughId, {
      kind: 'video',
      // The hub keeps the segment fields of the first chunk: the step the video started on (its marker at 0).
      segment: { key: s.key, url: s.url, startedAt: s.startedAt, stepId: msg.markers.find((m) => m.at === 0)?.stepId ?? s.stepId },
      seq: msg.seq,
      data: msg.data,
      mime: msg.mime,
      durationMs: msg.durationMs,
      markers: msg.markers ?? [],
      width: msg.width,
      height: msg.height,
      final: msg.final,
    });
    // Follow pauses and step changes made anywhere (dashboard, another view) without waiting for a sync.
    if (!msg.final) void follow(s, r.state, null, deps).catch(() => {});
    return { ok: true, bytes: r.bytes, maxBytes: r.maxBytes, state: r.state };
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
    return { ok: false, error: errText(err), stop: status !== undefined && STOP_STATUSES.has(status), status };
  }
}

/** The recorder has ended (its last chunk is out): forget the session, close the offscreen document. */
export async function handleVideoEnded(msg: VideoEndedMessage, sender: { url?: string }, deps: VideoDeps): Promise<void> {
  if (sender.url !== deps.offscreenUrl) return;
  const s = await readSession(deps);
  if (!s || s.key !== msg.key) return;
  await finish(s, msg.reason, deps);
}

// Walkthrough recording R2, video mode (docs/design/storyboards.md "R2 video"): what the service worker
// (background/videoSync.ts), the offscreen document that runs MediaRecorder (src/offscreen/) and the views share.
// The worker gets a tab capture stream id (chrome.tabCapture.getMediaStreamId: Chrome allows it only for a tab the
// user invoked the extension on), opens the offscreen document (reason USER_MEDIA) and hands it the id; the offscreen
// recorder sends a WebM chunk about every 5 s back to the worker, which uploads it to the hub (the same chunk endpoint
// as DOM recording, kind 'video'). The capture follows the tab across navigations; it ends when the tab closes.

/** MediaRecorder timeslice: one chunk (and one upload) about this often. */
export const VIDEO_TIMESLICE_MS = 5000;
/** Between chunks, an empty heartbeat chunk this often (the hub's pause or stop reaches the recorder quickly). */
export const VIDEO_HEARTBEAT_MS = 2000;
/** Frames per second asked of the tab capture (a walkthrough is mostly still pages and typing). */
export const VIDEO_FPS = 8;
/** MediaRecorder target bitrate; 500 kbps is about 3.75 MB per minute at most (still pages need far less). */
export const VIDEO_BITS_PER_SECOND = 500_000;
/** The video is scaled down to this width at most (the height follows the tab's aspect ratio). */
export const VIDEO_MAX_WIDTH = 1280;
/** Chunks waiting for an upload (a hub that is offline for a while) at most; past it the video stops. */
export const VIDEO_MAX_QUEUE = 24;
/** The chrome.storage.session key of the running capture (one at a time; extension pages read it, pages cannot). */
export const VIDEO_SESSION_KEY = 'videoCapture';
export const OFFSCREEN_PATH = 'offscreen.html';

/** The capture that runs now (chrome.storage.session VIDEO_SESSION_KEY). */
export interface VideoSession {
  tabId: number;
  windowId: number;
  project: string;
  walkthroughId: string;
  /** The segment key (letters, digits, - and _; the hub stores it as a video segment). */
  key: string;
  startedAt: string;
  url: string;
  stepId: string | null;
  /** Paused now (the run is paused, or the tab is on a page outside the run's origins). */
  paused: boolean;
  /** Why it is paused when not by the run: 'origin' (another site in the tab). */
  pausedFor?: 'run' | 'origin' | null;
  mime?: string;
  width?: number;
  height?: number;
}

/** WebM codecs, best first. */
export const VIDEO_MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const;

export function pickVideoMime(isTypeSupported: (t: string) => boolean): string {
  return VIDEO_MIME_TYPES.find((t) => isTypeSupported(t)) ?? 'video/webm';
}

/** The capture size: the tab scaled to VIDEO_MAX_WIDTH at most, even numbers (encoders want them). */
export function captureSize(width: number | undefined, height: number | undefined): { width: number; height: number } {
  const w = width && width > 0 ? width : VIDEO_MAX_WIDTH;
  const h = height && height > 0 ? height : Math.round((w * 10) / 16);
  const scale = Math.min(1, VIDEO_MAX_WIDTH / w);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * scale), height: even(h * scale) };
}

/** getUserMedia constraints for a tab capture stream id (Chrome's legacy "mandatory" form; video only). */
export function captureConstraints(streamId: string, size: { width: number; height: number }) {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: size.width,
        maxHeight: size.height,
        maxFrameRate: VIDEO_FPS,
      },
    },
  } as unknown as MediaStreamConstraints;
}

/** Minutes of video left under the cap at the nominal bitrate (a lower bound: still pages record far less). */
export function videoMinutesLeft(bytes: number, maxBytes: number, bitsPerSecond = VIDEO_BITS_PER_SECOND): number {
  const left = Math.max(0, maxBytes - bytes);
  return Math.floor(left / (bitsPerSecond / 8) / 60);
}

/** A random segment key (the hub's KEY_RE: letters, digits, - and _). */
export const newVideoKey = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------------------------------------------
// Messages. The worker addresses the offscreen document with target 'offscreen' (every extension page gets
// runtime messages; the others ignore them).

export type ToOffscreen =
  | { target: 'offscreen'; type: 'video.begin'; streamId: string; session: VideoSession; size: { width: number; height: number } }
  | { target: 'offscreen'; type: 'video.pause' }
  | { target: 'offscreen'; type: 'video.resume' }
  | { target: 'offscreen'; type: 'video.step'; stepId: string | null }
  | { target: 'offscreen'; type: 'video.stop'; reason: string }
  | { target: 'offscreen'; type: 'video.status' };

export type BeginResult = { ok: true; mime: string; width: number; height: number } | { ok: false; error: string };
export interface OffscreenStatus {
  recording: boolean;
  key: string | null;
  paused: boolean;
  seq: number;
  durationMs: number;
  queued: number;
}

/** Offscreen → worker: one WebM chunk (base64) of the running segment. */
export interface VideoChunkMessage {
  type: 'video.chunk';
  key: string;
  seq: number;
  data: string;
  mime: string;
  durationMs: number;
  markers: { at: number; stepId: string }[];
  width?: number;
  height?: number;
  final: boolean;
}

/** The worker's answer to a chunk: the hub's state, or why it failed (stop: no more chunks; else retry it). */
export type VideoChunkReply =
  | { ok: true; bytes: number; maxBytes: number; state: { mode: string; paused: boolean; stopped: string | null; currentStepId: string | null; status: string } }
  | { ok: false; error: string; stop: boolean; status?: number };

/** Offscreen → worker: the recorder has ended (the last chunk went out, or could not). */
export interface VideoEndedMessage {
  type: 'video.ended';
  key: string;
  reason: string;
}

/** A view (panel, widget) → worker: start the video of a tab (a user gesture: the Start or Record video button). */
export interface VideoStartMessage {
  type: 'video.start';
  tabId: number;
}
export type VideoStartResult = { ok: true; already?: boolean } | { ok: false; error: string };

/** Chrome's answer when the user has not invoked the extension on the tab (tabCapture needs that). */
export const NOT_INVOKED_RE = /not been invoked|activeTab|Chrome pages cannot be captured/i;
export const NOT_INVOKED_HELP =
  'Chrome lets the extension record a tab only after you use the extension on it: click the stubyard toolbar button while this tab is open (or press Alt+Shift+V on it), then press Record video again.';

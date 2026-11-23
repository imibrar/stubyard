// The service worker's part of walkthrough recording (R1; shared/recording.ts). Stateless like widgetSync.ts: every
// event reads the settings and the hub again. It starts the recorder in the top frame of each tab whose window has a
// run open that records (mode dom, not stopped, still active) and whose page is one of the run's app origins, stops
// it elsewhere, and uploads the chunks the recorders send (with the hub URL of the settings: the page never has it).
// chrome.* and the hub calls are passed in, so the logic is unit-tested.
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { CONTENT_VERSION, type ContentRequest } from '../shared/protocol';
import type { RecordingChunkMessage, RecordingChunkReply, RecordingConfig } from '../shared/recording';
import type { ActiveWalkthrough, Settings } from '../shared/settings';
import { originAllowed } from '../shared/widget';
import type { TabLike } from './widgetSync';

export interface RecordingDeps {
  loadSettings(): Promise<Settings>;
  ping(tabId: number): Promise<string | null>;
  inject(tabId: number): Promise<void>;
  send(tabId: number, msg: ContentRequest): Promise<unknown>;
  getWalkthrough(apiUrl: string, project: string, id: string): Promise<WalkthroughView>;
  upload(apiUrl: string, project: string, id: string, chunk: Omit<RecordingChunkMessage, 'type' | 'project' | 'walkthroughId'>): Promise<{ state: Extract<RecordingChunkReply, { ok: true }>['state'] }>;
}

/** The recorder config for a run, or null when it does not record now. */
export function recordingConfig(active: ActiveWalkthrough, w: WalkthroughView | null): RecordingConfig | null {
  const r = w?.recording;
  if (!w || !r || w.status !== 'active' || r.mode !== 'dom' || r.stopped) return null;
  return { project: active.project, walkthroughId: w.id, stepId: w.currentStepId ?? null, paused: r.paused, maskAllInputs: r.maskAllInputs, maskSelectors: r.maskSelectors ?? [] };
}

/** Recording follows the run's app origins only (a run opened by an older panel without origins: none). */
export const recordsOn = (url: string | undefined, active: ActiveWalkthrough | null): boolean => !!active?.origins?.length && originAllowed(url, active.origins);

export type RecordingSyncResult = 'recording' | 'stopped' | 'none' | 'error';

/** A walkthrough fetch per pass, shared by the tabs of a window. */
export type RunCache = Map<string, Promise<WalkthroughView | null>>;

function runOf(active: ActiveWalkthrough, settings: Settings, deps: RecordingDeps, cache: RunCache) {
  const k = `${active.project}/${active.id}`;
  let p = cache.get(k);
  if (!p) {
    p = deps.getWalkthrough(settings.apiUrl, active.project, active.id).catch(() => null);
    cache.set(k, p);
  }
  return p;
}

/** Start, update or stop the recorder of one tab. */
export async function syncRecordingTab(tab: TabLike, deps: RecordingDeps, pre?: { settings: Settings; cache: RunCache }): Promise<RecordingSyncResult> {
  if (tab.id === undefined || tab.id < 0) return 'none';
  const settings = pre?.settings ?? (await deps.loadSettings());
  const cache = pre?.cache ?? new Map();
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  const url = tab.url || tab.pendingUrl || '';
  try {
    const cfg = active && recordsOn(url, active) ? recordingConfig(active, await runOf(active, settings, deps, cache)) : null;
    const version = await deps.ping(tab.id);
    if (!cfg) {
      if (version === null) return 'none';
      await deps.send(tab.id, { type: 'recording.stop' });
      return 'stopped';
    }
    if (version !== CONTENT_VERSION) await deps.inject(tab.id);
    await deps.send(tab.id, { type: 'recording.start', config: cfg });
    return 'recording';
  } catch {
    return 'error'; // a page that cannot be scripted, or one navigating away: the next event retries
  }
}

/** Every tab (one hub read per run). */
export async function syncRecordingTabs(tabs: TabLike[], deps: RecordingDeps): Promise<RecordingSyncResult[]> {
  const settings = await deps.loadSettings();
  const cache: RunCache = new Map();
  return Promise.all(tabs.map((t) => syncRecordingTab(t, deps, { settings, cache })));
}

export interface ChunkSender {
  id?: string;
  tab?: { id?: number; windowId: number; url?: string };
  frameId?: number;
  url?: string;
}

const STOP_STATUSES = new Set([400, 404, 409, 413]);

/**
 * A recorder's chunk: checked against the tab it came from (top frame, an app origin of the run open in that tab's
 * window, the same project and walkthrough), then uploaded.
 */
export async function handleRecordingChunk(msg: RecordingChunkMessage, sender: ChunkSender, deps: Pick<RecordingDeps, 'loadSettings' | 'upload'>): Promise<RecordingChunkReply> {
  const tab = sender.tab;
  if (!tab || sender.frameId !== 0) return { ok: false, error: 'not a top frame', stop: true };
  const settings = await deps.loadSettings();
  const active = settings.activeWalkthroughByWindow[String(tab.windowId)] ?? null;
  const url = sender.url ?? tab.url;
  if (!active || active.id !== msg.walkthroughId || active.project !== msg.project) return { ok: false, error: 'this run is not open in the window', stop: true };
  if (!recordsOn(url, active)) return { ok: false, error: 'not an app page of the run', stop: true };
  if (!Array.isArray(msg.events) || typeof msg.seq !== 'number' || !msg.segment || typeof msg.segment.key !== 'string') return { ok: false, error: 'bad chunk', stop: true };
  try {
    const r = await deps.upload(settings.apiUrl, active.project, active.id, { segment: msg.segment, seq: msg.seq, events: msg.events, final: msg.final });
    return { ok: true, state: r.state };
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
    return { ok: false, error: err instanceof Error ? err.message : String(err), stop: status !== undefined && STOP_STATUSES.has(status), status };
  }
}

// Service worker (design §6.3): kept minimal and stateless, so nothing is lost when Chrome stops it.
// It opens the side panel on the toolbar button, relays the "fill-form" shortcut to the panel, and puts the on-page
// step widget on the tabs that should show it (background/widgetSync.ts; docs/design/floating-widget.md).
import { forgetTab, handleHello, handleTokenRequest, routeFill, syncTab, syncTabs, type SyncDeps, toggleWidgetCommand } from './background/widgetSync';
import type { PingResult, WidgetHello } from './shared/protocol';
import { loadSettings } from './shared/settings';
import { isOverrideKey, tabOfKey } from './shared/widget';
import { getWalkthrough, uploadRecordingChunk } from '@stubyard/client/walkthroughs';
import { handleRecordingChunk, type RecordingDeps, syncRecordingTab, syncRecordingTabs } from './background/recordingSync';
import type { RecordingChunkMessage } from './shared/recording';
import { hubJson } from '@stubyard/client/http';
import { handleVideoChunk, handleVideoEnded, startVideo, stopVideo, syncVideo, type VideoDeps, readSession } from './background/videoSync';
import { OFFSCREEN_PATH, type VideoChunkMessage, type VideoEndedMessage, type VideoStartMessage } from './shared/video';

const enablePanel = () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
};


// ---------------------------------------------------------------------------------------------------------------
// On-page widget

const deps: SyncDeps = {
  loadSettings: () => loadSettings(),
  session: chrome.storage.session as unknown as SyncDeps['session'],
  ping: (tabId) =>
    (chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 }) as Promise<PingResult | undefined>).then(
      (r) => (r && typeof r === 'object' && 'version' in r ? r.version : null),
      () => null,
    ),
  inject: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'] });
  },
  send: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }),
  newToken: () => crypto.randomUUID(),
  widgetUrl: chrome.runtime.getURL('widget.html'),
};

// Keyboard commands. Alt+Shift+F goes to the active tab's widget first, else the panel (one fill per press);
// Alt+Shift+W collapses / expands the widget, or shows it on this tab.
async function onCommand(command: string): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
  if (command === 'fill-form') return routeFill(tab?.id, { broadcast: (msg) => chrome.runtime.sendMessage(msg) });
  if (command === 'toggle-widget') return toggleWidgetCommand(tab, deps);
  // Alt+Shift+V: a keyboard command invokes the extension on the tab, which Chrome's tab capture asks for.
  if (command === 'record-video' && tab?.id !== undefined) return startVideo(tab.id, videoDeps).then((r) => (r.ok ? 'video' : `video: ${r.error}`));
  return 'none';
}
chrome.commands.onCommand.addListener((command) => void onCommand(command));
// Headless Chrome cannot press extension shortcuts: test/widget-spike/widget1b.py calls this in the worker instead.
// Test builds only (`npm run build:test`, vite mode "harness"): a production build has no such hook (review item 6).
if (__STUBYARD_TEST_HOOKS__) (self as unknown as { __stubyardCommand?: typeof onCommand }).__stubyardCommand = onCommand;

// Walkthrough recording (background/recordingSync.ts): the hub calls use the settings' hub URL.
const recDeps: RecordingDeps = {
  loadSettings: deps.loadSettings,
  ping: deps.ping,
  inject: deps.inject,
  send: deps.send,
  getWalkthrough: (apiUrl, project, id) => getWalkthrough({ apiUrl, project }, id),
  upload: (apiUrl, project, id, chunk) => uploadRecordingChunk({ apiUrl, project }, id, chunk),
};
// Video mode (background/videoSync.ts): one capture at a time, recorded by the offscreen document.
let offscreenOpening: Promise<void> | null = null;
const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
const videoDeps: VideoDeps = {
  loadSettings: deps.loadSettings,
  getWalkthrough: recDeps.getWalkthrough,
  session: chrome.storage.session as unknown as VideoDeps['session'],
  getTab: (tabId) => chrome.tabs.get(tabId).then((t) => t, () => null),
  getStreamId: (tabId) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
  ensureOffscreen: async () => {
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [offscreenUrl] });
    if (open.length) return;
    offscreenOpening ??= chrome.offscreen
      .createDocument({ url: OFFSCREEN_PATH, reasons: ['USER_MEDIA' as chrome.offscreen.Reason], justification: 'Records the walkthrough tab as a video (tab capture + MediaRecorder).' })
      .finally(() => {
        offscreenOpening = null;
      });
    await offscreenOpening;
  },
  closeOffscreen: () => chrome.offscreen.closeDocument().catch(() => {}),
  toOffscreen: (msg) => chrome.runtime.sendMessage(msg),
  ping: deps.ping,
  inject: deps.inject,
  send: deps.send,
  upload: (apiUrl, project, id, body) => hubJson({ apiUrl }, 'POST', `/api/projects/${encodeURIComponent(project)}/walkthroughs/${encodeURIComponent(id)}/recording/chunks`, body),
  offscreenUrl,
};
const syncRecordingAll = () => {
  void chrome.tabs.query({}).then((tabs) => syncRecordingTabs(tabs, recDeps), () => {});
  void syncVideo(videoDeps).catch(() => {});
};

// Widget first (it injects the content script where needed), then the recorders.
const syncAll = () =>
  void chrome.tabs.query({}).then(
    async (tabs) => {
      await syncTabs(tabs, deps);
      await syncRecordingTabs(tabs, recDeps);
    },
    () => {},
  );
const syncOne = async (tab: chrome.tabs.Tab) => {
  await syncTab(tab, deps);
  await syncRecordingTab(tab, recDeps);
  if (tab.id !== undefined) await syncVideo(videoDeps, tab.id).catch(() => {});
};

chrome.runtime.onInstalled.addListener(() => {
  enablePanel();
  syncAll();
});
chrome.runtime.onStartup.addListener(() => {
  enablePanel();
  syncAll();
});

// A page finished loading, or its URL changed (also SPA route changes and back/forward restores).
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.status === 'complete' || change.url) void syncOne(tab);
});
// A tab moved to another window: it follows that window's walkthrough.
chrome.tabs.onAttached.addListener((tabId) => {
  void chrome.tabs.get(tabId).then((t) => syncOne(t), () => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId, deps).catch(() => {});
  // The captured tab closed: its track ends too; this makes sure the recorder finishes.
  void readSession(videoDeps).then((s) => (s?.tabId === tabId ? stopVideo('The tab was closed', videoDeps) : undefined), () => {});
});

// A walkthrough opened or closed in a window, the Settings switch, or a tab's show/hide choice.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('activeWalkthroughByWindow' in changes || 'widgetEnabled' in changes || 'widgetHiddenOrigins' in changes)) syncAll();
  // A tab's show/hide choice (one key per tab): sync that tab only.
  if (area === 'session') {
    for (const k of Object.keys(changes)) {
      const tabId = isOverrideKey(k) ? tabOfKey(k) : null;
      if (tabId !== null) void chrome.tabs.get(tabId).then((t) => syncTab(t, deps), () => {});
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own contexts reach here (no externally_connectable): widget frames and content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  const type = (msg as { type?: unknown } | null)?.type;
  if (type === 'widget.hello') {
    handleHello(msg as WidgetHello, sender, deps).then(sendResponse, () => sendResponse({ error: 'denied' }));
    return true;
  }
  if (type === 'widget.token') {
    handleTokenRequest(sender, deps).then(sendResponse, () => sendResponse({ error: 'denied' }));
    return true;
  }
  // A recorder's chunk (content script) and "the run changed" from the panel or a widget.
  if (type === 'recording.chunk') {
    handleRecordingChunk(msg as RecordingChunkMessage, sender, recDeps).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err), stop: false }));
    return true;
  }
  if (type === 'recording.sync') {
    syncRecordingAll();
    return false;
  }
  // Video: a view's Record video button, and the offscreen recorder's chunks and end.
  if (type === 'video.start') {
    const tabId = (msg as VideoStartMessage).tabId;
    if (typeof tabId !== 'number') return false;
    startVideo(tabId, videoDeps).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (type === 'video.chunk') {
    handleVideoChunk(msg as VideoChunkMessage, sender, videoDeps).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err), stop: false }));
    return true;
  }
  if (type === 'video.ended') {
    void handleVideoEnded(msg as VideoEndedMessage, sender, videoDeps).catch(() => {});
    return false;
  }
  return false;
});

// Service worker (design §6.3): kept minimal and stateless, so nothing is lost when Chrome stops it.
// It opens the side panel on the toolbar button, relays the "fill-form" shortcut to the panel, and puts the on-page
// step widget on the tabs that should show it (background/widgetSync.ts; docs/design/floating-widget.md).
import { forgetTab, handleHello, syncTab, syncTabs, type SyncDeps } from './background/widgetSync';
import type { PanelMessage, PingResult, WidgetHello } from './shared/protocol';
import { loadSettings } from './shared/settings';
import { TAB_OVERRIDE_KEY } from './shared/widget';

const enablePanel = () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
};

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'fill-form') return;
  const msg: PanelMessage = { type: 'panel.command', command: 'fill-form' };
  // No receiver (the panel is closed) rejects; that is fine.
  chrome.runtime.sendMessage(msg).catch(() => {});
});

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

const syncAll = () => void chrome.tabs.query({}).then((tabs) => syncTabs(tabs, deps), () => {});

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
  if (change.status === 'complete' || change.url) void syncTab(tab, deps);
});
// A tab moved to another window: it follows that window's walkthrough.
chrome.tabs.onAttached.addListener((tabId) => {
  void chrome.tabs.get(tabId).then((t) => syncTab(t, deps), () => {});
});
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId, deps).catch(() => {}));

// A walkthrough opened or closed in a window, the Settings switch, or a tab's show/hide choice.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('activeWalkthroughByWindow' in changes || 'widgetEnabled' in changes)) syncAll();
  if (area === 'session' && TAB_OVERRIDE_KEY in changes) syncAll();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if ((msg as WidgetHello | null)?.type !== 'widget.hello') return false;
  handleHello(msg as WidgetHello, sender, deps).then(sendResponse, () => sendResponse({ error: 'denied' }));
  return true;
});

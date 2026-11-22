// Service worker (design §6.3): kept minimal and stateless, so nothing is lost when Chrome stops it.
// It opens the side panel on the toolbar button, relays the "fill-form" shortcut to the panel, and puts the on-page
// step widget on the tabs that should show it (background/widgetSync.ts; docs/design/floating-widget.md).
import { forgetTab, handleHello, handleTokenRequest, routeFill, syncTab, syncTabs, type SyncDeps, toggleWidgetCommand } from './background/widgetSync';
import type { PingResult, WidgetHello } from './shared/protocol';
import { loadSettings } from './shared/settings';
import { isOverrideKey, tabOfKey } from './shared/widget';

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
  return 'none';
}
chrome.commands.onCommand.addListener((command) => void onCommand(command));
// Headless Chrome cannot press extension shortcuts: test/widget-spike/widget1b.py calls this in the worker instead.
// Test builds only (`npm run build:test`, vite mode "harness"): a production build has no such hook (review item 6).
if (__STUBYARD_TEST_HOOKS__) (self as unknown as { __stubyardCommand?: typeof onCommand }).__stubyardCommand = onCommand;

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
  return false;
});

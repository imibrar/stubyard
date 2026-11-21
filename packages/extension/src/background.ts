// Service worker (design §6.3): kept minimal and stateless, so nothing is lost when Chrome stops it.
// It opens the side panel on the toolbar button and relays the "fill-form" shortcut to the panel.
import type { PanelMessage } from './shared/protocol';

const enablePanel = () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
};
chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(enablePanel);

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'fill-form') return;
  const msg: PanelMessage = { type: 'panel.command', command: 'fill-form' };
  // No receiver (the panel is closed) rejects; that is fine.
  chrome.runtime.sendMessage(msg).catch(() => {});
});

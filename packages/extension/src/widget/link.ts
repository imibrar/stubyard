// The widget iframe's links: the hello handshake with the service worker (token check), and the Port to its tab's
// content host (size, collapse, hide, progress).
import { type HostToWidget, WIDGET_PORT, type WidgetHelloResult, type WidgetToHost } from '../shared/protocol';
import { tokenFromHash } from '../shared/widget';

export async function hello(hash: string = location.hash): Promise<WidgetHelloResult> {
  const token = tokenFromHash(hash);
  if (!token) return { error: 'denied' };
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'widget.hello', token })) as WidgetHelloResult | undefined;
    return r && ('tabId' in r || 'error' in r) ? r : { error: 'denied' };
  } catch {
    return { error: 'denied' };
  }
}

export interface HostLink {
  post(m: WidgetToHost): void;
  close(): void;
}

/** Connect to the content host of the tab (frame 0); reconnects a few times when the port drops. */
export function connectHost(tabId: number, token: string, onMessage: (m: HostToWidget) => void): HostLink {
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  let tries = 0;
  let last: Partial<Record<WidgetToHost['t'], WidgetToHost>> = {};
  const open = () => {
    if (closed) return;
    try {
      port = chrome.tabs.connect(tabId, { frameId: 0, name: WIDGET_PORT });
    } catch {
      port = null;
      return;
    }
    port.onMessage.addListener((m) => onMessage(m as HostToWidget));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (!closed && tries++ < 5) setTimeout(open, 800);
    });
    port.postMessage({ t: 'ready', token } satisfies WidgetToHost);
    // Re-send the latest size, progress and busy state after a reconnect.
    for (const m of Object.values(last)) if (m) port.postMessage(m);
  };
  open();
  return {
    post: (m) => {
      if (m.t === 'size' || m.t === 'progress' || m.t === 'busy') last = { ...last, [m.t]: m };
      try {
        port?.postMessage(m);
      } catch {
        /* reconnecting */
      }
    },
    close: () => {
      closed = true;
      port?.disconnect();
    },
  };
}

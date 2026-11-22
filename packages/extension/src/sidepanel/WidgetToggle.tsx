// "Show on this tab": the panel's switch for the on-page step widget in the window's active tab. It writes the tab's
// override (chrome.storage.session); the service worker mounts or removes the widget.
import { useEffect, useState } from 'react';
import { pageOrigin } from '../shared/settings';
import { readTabState, type SessionArea, setTabOverride, TAB_OVERRIDE_KEY, type TabOverride, widgetEligibility } from '../shared/widget';
import { usePanel } from './context';

const session = () => chrome.storage.session as unknown as SessionArea;

export function WidgetTabToggle() {
  const p = usePanel();
  const [override, setOverride] = useState<TabOverride | null>(null);
  const tabId = p.tab?.id ?? null;

  useEffect(() => {
    if (tabId === null) return;
    const load = () => void readTabState(session()).then((s) => setOverride(s.overrides[String(tabId)] ?? null), () => {});
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && TAB_OVERRIDE_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [tabId]);

  if (!p.tab || !pageOrigin(p.tab.url)) return null;
  const { show, reason } = widgetEligibility({ enabled: p.settings.widgetEnabled, active: p.active, override, url: p.tab.url });
  const why =
    reason === 'other-origin'
      ? 'This page is not one of the run’s app origins: tick to show the widget here anyway.'
      : reason === 'disabled'
        ? 'The step widget is switched off in Settings: tick to show it on this tab anyway.'
        : 'The floating step card on the page (drag it, Esc collapses it).';
  const tabIdNow = p.tab.id;
  return (
    <label className="small w-toggle" title={why}>
      <input type="checkbox" checked={show} onChange={(e) => void setTabOverride(tabIdNow, e.target.checked ? 'show' : 'hide', session())} /> Show on this tab
    </label>
  );
}

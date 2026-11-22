// "Show on this tab": the panel's switch for the on-page step widget in the window's active tab. It writes the tab's
// override (chrome.storage.session); the service worker mounts or removes the widget.
import { useEffect, useState } from 'react';
import { pageOrigin } from '../shared/settings';
import { effectiveOverride, overrideKey, readTabOverride, type SessionArea, setTabOverride, type TabOverrideRec, widgetEligibility } from '../shared/widget';
import { usePanel } from './context';

const session = () => chrome.storage.session as unknown as SessionArea;

export function WidgetTabToggle() {
  const p = usePanel();
  const [override, setOverride] = useState<TabOverrideRec | null>(null);
  const tabId = p.tab?.id ?? null;

  useEffect(() => {
    if (tabId === null) return;
    const load = () => void readTabOverride(session(), tabId).then(setOverride, () => {});
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && overrideKey(tabId) in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [tabId]);

  if (!p.tab || !pageOrigin(p.tab.url)) return null;
  const { show, reason } = widgetEligibility({ enabled: p.settings.widgetEnabled, hiddenOrigins: p.settings.widgetHiddenOrigins, active: p.active, override: effectiveOverride(override, p.tab.url), url: p.tab.url });
  const why =
    reason === 'other-origin'
      ? 'This page is not one of the run’s app origins: tick to show the widget here anyway.'
      : reason === 'hidden-on-site'
        ? 'This site is on the Settings hide list: tick to show the widget on this tab anyway.'
      : reason === 'disabled'
        ? 'The step widget is switched off in Settings: tick to show it on this tab anyway.'
        : 'The floating step card on the page (drag it, Esc collapses it).';
  const tabIdNow = p.tab.id;
  const urlNow = p.tab.url;
  return (
    <label className="small w-toggle" title={why}>
      <input type="checkbox" checked={show} onChange={(e) => void setTabOverride(tabIdNow, e.target.checked ? 'show' : 'hide', session(), urlNow)} /> Show on this tab
    </label>
  );
}

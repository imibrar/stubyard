// Settings → "On-page step widget" (docs/design/floating-widget.md, phase 2): the on/off switch, the sites where it
// never shows by itself (per-site hide list), and the saved positions (reset one site or all). The widget on an open
// page follows a reset at once (the content script listens to the placement key).
import { useEffect, useState } from 'react';
import { PLACEMENT_KEY, placementOrigins, resetPlacements } from '../shared/widget';
import { usePanel } from './context';

const local = () => chrome.storage.local;

function useSavedPlaces(): [string[], (origin: string | null) => Promise<void>] {
  const [all, setAll] = useState<unknown>({});
  useEffect(() => {
    const load = () => void local().get(PLACEMENT_KEY).then((r) => setAll(r[PLACEMENT_KEY] ?? {}), () => {});
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && PLACEMENT_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const reset = async (origin: string | null) => {
    const cur = (await local().get(PLACEMENT_KEY))[PLACEMENT_KEY];
    await local().set({ [PLACEMENT_KEY]: resetPlacements(cur, origin) });
  };
  return [placementOrigins(all), reset];
}

export function WidgetSettings() {
  const p = usePanel();
  const [places, resetPlace] = useSavedPlaces();
  const hidden = p.settings.widgetHiddenOrigins;
  const here = p.origin;
  const setHidden = (next: string[]) => void p.updateSettings({ widgetHiddenOrigins: next });

  return (
    <section className="card" aria-labelledby="ws-title">
      <h3 id="ws-title">On-page step widget</h3>
      <label className="check">
        <input type="checkbox" checked={p.settings.widgetEnabled} onChange={(e) => void p.updateSettings({ widgetEnabled: e.target.checked })} /> Show the step widget on app
        pages
      </label>
      <p className="muted small">
        While a walkthrough is open, pages of its app show a small card with the current step. The Walkthrough screen's “Show on this tab” shows or hides it for
        one tab. Alt+Shift+W folds or opens it.
      </p>

      <h4 className="ws-sub">Hidden on these sites</h4>
      {hidden.length === 0 ? (
        <p className="muted small">None. The card shows on every page of the run's app.</p>
      ) : (
        <ul className="ws-list">
          {hidden.map((o) => (
            <li key={o}>
              <code className="one-line" title={o}>
                {o}
              </code>
              <button aria-label={`Show the widget on ${o} again`} onClick={() => setHidden(hidden.filter((x) => x !== o))}>
                Show again
              </button>
            </li>
          ))}
        </ul>
      )}
      {here && !hidden.includes(here) && (
        <button onClick={() => setHidden([...hidden, here])}>
          Hide on {here}
        </button>
      )}

      <h4 className="ws-sub">Position</h4>
      <p className="muted small">
        {places.length === 0 ? 'The card sits in its default corner on every site.' : `Saved for ${places.length} site${places.length === 1 ? '' : 's'}.`} Drag the bar on top
        of the card to move it; double-click the bar to put it back.
      </p>
      <div className="row wrap">
        {here && places.includes(here) && (
          <button onClick={() => void resetPlace(here).then(() => p.notify(`Widget position reset for ${here}`))}>
            Reset on this site
          </button>
        )}
        <button disabled={places.length === 0} onClick={() => void resetPlace(null).then(() => p.notify('Widget positions reset'))}>
          Reset all positions
        </button>
      </div>
    </section>
  );
}

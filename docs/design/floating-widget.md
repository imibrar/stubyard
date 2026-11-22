# On-page floating step widget (design record)

Status: spike done, phase 0 (refactor, no visible change) done on branch dev, 2026-11-22. Phases 1a, 1b, 2 and 3 to
come. Extension only: no server change, no migration.

The full plan and its review are working notes (`.cache/specs/plan-floating-widget.md`,
`.cache/specs/review-floating-widget.md`, final decisions in `.cache/specs/plans-final.md` §A). This file records
what was verified and decided, so later phases do not depend on those notes.

## Shape (D1 a)

The content script adds one host element on `document.documentElement` (outside `body`), marked with
`data-stubyard-widget`, with a **closed** shadow root. The shadow root holds the pill, the drag handle and an
`<iframe src="chrome-extension://<id>/widget.html">`. The iframe is an extension page: it calls stubyard with
`@stubyard/client` like the side panel (the hub guard accepts only `chrome-extension://` origins), credentials and
email bodies render only there, and the panel's React step controls are reused through `StepHost` (below).

## Spike (2026-11-22): what Chrome really does

Setup: Google Chrome 158 (`--headless=new`), driven over `--remote-debugging-pipe` with
`Extensions.loadUnpacked`; a spike extension built like the design (closed shadow root on documentElement, iframe
`widget.html` in `web_accessible_resources`); Python fixture servers that set the headers below; a fake hub that,
like the real one, sends **no CORS headers**. The harness is kept in `packages/extension/test/widget-spike/`
(`spike.py` the matrix, `extra.py` clipboard / capture / dialog fallback, `guard.py` the built extension); it is
not part of `npm test`. Clicks and typing are real input events (`Input.dispatchMouseEvent`, `Input.insertText`).

Every check below ran the same set in the frame: `chrome.tabs.getCurrent()`, `chrome.storage.session`, hub
GET + POST (JSON) + `EventSource`, `chrome.tabs.connect(tabId, {frameId: 0})` to the content script, a click, focus
and typing in an input, and the clipboard.

| Page / check | Result |
|---|---|
| Strict CSP `default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'`, and `default-src 'none'` (http and https) | **Pass.** The frame loads and everything in it works. The host's styles are set through CSSOM (`element.style`), which `style-src` does not block (computed `position: fixed`). |
| COEP `require-corp` + COOP `same-origin`; COEP `credentialless` | **Pass.** The extension frame is not blocked (risk R3 does not occur in Chrome 158). |
| `X-Frame-Options: DENY` + `frame-ancestors 'none'` on the app page | Pass (they limit who frames the app, not what the app frames). |
| Mixed content: https page, hub `http://127.0.0.1` and hub `http://<LAN IP>` | **Pass** (GET, POST, SSE). For the LAN hub over http Chrome sends no `Sec-Fetch-*` headers. |
| Local Network Access: page marked public (`--ip-address-space-overrides`), hub on loopback and on the LAN IP, with and without `allow="local-network-access"` | **Pass** in the frame, no prompt, no `allow` needed. Control: the page's own fetch to the same hub failed in the same run, so the override was in effect. |
| Origin seen by the hub | POST: `Origin: chrome-extension://<static id>` (matches the guard, `server/src/http/guard.ts`). GET: no Origin, the same as the panel today. Responses are readable without CORS headers (host permissions), the same as the panel. |
| `use_dynamic_url: true` | `getURL` returns `chrome-extension://<uuid>/widget.html`, but the frame's `location.origin` and the Origin header stay the **static** id, so the guard would still accept it. Not used anyway (final decision 4): it hides nothing worth hiding. |
| `chrome.tabs.getCurrent()` in the frame | Returns the embedding tab (`id`, `url`, `windowId`). The widget knows its tab without the background; `widget.hello` is only needed for the token check. |
| `chrome.storage.session`, `chrome.tabs.connect` to frame 0 | Work in the frame. |
| `chrome.sidePanel.open({tabId})` from a click in the frame | Works (the click is a user gesture). |
| What the page can see | `host.shadowRoot` is `null` (closed), no `<iframe>` in the light DOM, nothing of the widget in `document.body.innerText`. |
| Clipboard `navigator.clipboard.writeText` | Needs a click ("Document is not focused" otherwise). Works with `allow="clipboard-write"` on the iframe; without that attribute it is blocked by permissions policy; an app page with `Permissions-Policy: clipboard-write=()` blocks it even with the attribute. The fallback `document.execCommand('copy')` on a hidden textarea returned `true` in every case, also under that policy and without the `clipboardWrite` permission (return value only: headless cannot read the clipboard back). |
| **Radix modal Dialog** (real `@radix-ui/react-dialog` 1.3.1, FocusScope trapped, overlay over the page) | **Pass.** Clicking into the widget and typing works, focus stays in the widget (the page's `activeElement` is the host), the dialog stays open. Radix only sees a `focusout` with `relatedTarget: null`, which FocusScope ignores on purpose. Review item 6 does not occur with Radix; no "type in the panel" rule is needed. Other trap libraries (focus-trap, react-focus-lock) were not tested. |
| **Native `<dialog>.showModal()`** | **Fails as expected**: the widget is inert (no click, no focus). Also as `popover="manual"` shown before the dialog, and re-raised (`hidePopover()` + `showPopover()`) after it opened: the top layer fixes stacking only (review item 5 confirmed). **Fallback that works:** move the host into the open modal dialog with `dialog.moveBefore(host, null)`. The iframe is kept (no reload, same frame load count) and clicks and typing work. Move it back when the dialog closes. |
| Screenshot with the widget hidden | `visibility: hidden` on the host, two animation frames, then `captureVisibleTab`: the pixel under the widget changed from the widget's colour to the page's; after resume it was back. Chrome allows 2 `captureVisibleTab` calls per second (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`). |
| Re-inject after an extension reload (built extension) | Chrome 158 gives the reloaded extension a **fresh isolated world**: the old `window.__stubyardContent` is not visible, the old listener is dead ("Receiving end does not exist"), but the old script's DOM (an orphaned widget host) stays on the page. The phase 0 guard removes it on the next injection. Injecting twice into a live page keeps one instance. |

Not verified: Chrome with a window (the Local Network Access permission prompt UI; headless shows none), Chrome on
Windows/macOS (the user runs Chrome on Windows), and real app pages (Class PROvia). Phase 2 QA covers those.

### Decision D1: GO for (a)

The extension iframe inside a closed shadow root works on every page type tested. Option (b) (React in the shadow
root with a background relay) is not needed. What phase 1 must do because of the spike:

- iframe attribute `allow="clipboard-write"`; copy buttons try `navigator.clipboard.writeText`, then
  `execCommand('copy')`, then say "Select the text and copy it". No `allow="local-network-access"` needed.
- No `use_dynamic_url` in the manifest.
- `chrome.tabs.getCurrent()` gives the widget its tab; keep the token check of `widget.hello`.
- Native modal dialogs: watch for `dialog:modal` and move the host into it with `moveBefore` (Chrome 133+;
  without it, `append` reloads the frame, so show the pill only), and back on close. Watch for dialogs whose
  `transform`, `filter` or `contain` makes `position: fixed` relative to the dialog. Planned for phase 2 (polish);
  until then the widget says nothing inside native modals, and the panel still works.
- Screenshots: at most one capture per 500 ms across the panel and the widgets.

## Phase 0: shared groundwork (done, no visible change)

- **StepHost** (`src/run/host.tsx`): `surface`, `tab`, `windowId`, `target()`, `notify()`, `fillRequest`,
  `openWalkthrough()`, `compact`. `PanelState` extends it; the panel provides it (`surface: 'panel'`,
  `compact: false`). The step controls (`StepCard`, `LoginControls`, `FillControls`, `EmailControls`,
  `SimpleControls`, `QuickRun`) call `useStepHost()` instead of `usePanel()`. `cleanupUi` and `Summary` stay on
  `usePanel()` (they need settings and cleanup ticks, and are panel-only); so does `QuickRun`'s end screen
  (`RunCleanup`), so the widget must not render `QuickRun` itself.
- **useRun** (`src/run/useRun.ts`): loads the run (again on every reload tick), finds the current step, resolves it,
  and returns `{w, loadError, step, resolved, resolveError, reresolve, apply}` plus `resolvedFor()`. Taken out of
  `screens/Walkthrough.tsx` unchanged.
- **captureClean(tabId, windowId)** (`src/sidepanel/tabs.ts`): sends `widget.suspend` (waits at most 500 ms),
  captures, and always sends `widget.resume` (also when the capture throws). No content script or no widget: it
  captures as before. StepCard's Screenshot uses it.
- **Content side** (`src/content/widget.ts`): `widget.suspend` hides every `[data-stubyard-widget]` host
  (`visibility: hidden !important`) and answers after two animation frames (150 ms fallback), with an auto-resume
  after 1500 ms; `widget.resume` shows them again. With no host it answers at once (`hidden: 0`).
- **Re-inject guard** (`src/content/index.ts`): `window.__stubyardContent` now holds
  `{version, alive(), dispose()}`. A new injection replaces anything but a live instance of the same version (none,
  the 0.1.0 string, another version, an orphan whose `chrome.runtime.id` is gone): it disposes the old listener,
  removes orphaned widget hosts and registers its own. A listener whose runtime died removes itself.
  `CONTENT_VERSION` is 0.2.0 (new message types).
- Tests: `test/contentGuard.test.ts`, `test/widgetSuspend.test.ts`, `test/captureClean.test.ts`,
  `test/useRun.test.ts` (React rendered in happy-dom with a mocked client).

Left for phase 1a (not needed before there is a widget): `ActiveWalkthrough.origins` and the widget settings
(enabled switch; placement under its own storage key, saved on drag end only, review item 10).

## Phase 1a: the widget (done)

What the tester sees: while a walkthrough is open in a window, its app pages get a small card in a corner. It shows
the current step and its simple actions. Steps the widget cannot run yet (login with 2FA, email) say "Continue in
panel". The side panel keeps working as before, and both stay in sync.

- **Who shows it** is the service worker (`src/background/widgetSync.ts`, wired in `src/background.ts`), not the
  panel, so the card also shows while the panel is closed. On install and startup, on `tabs.onUpdated` (load
  complete or a URL change, which covers SPA route changes) and `tabs.onAttached`, and when
  `activeWalkthroughByWindow`, `widgetEnabled` or the per-tab choice changes, it checks every tab with
  `widgetEligibility()` (`src/shared/widget.ts`). For an eligible tab it injects the content script when the
  running version differs, then sends `widget.mount {token}`. A tab that is no longer eligible gets
  `widget.unmount` (only if a content script is there).
- **Eligibility:** the window has an active walkthrough, the page is http(s), it is in the top frame, and its origin
  is the run's origin or one of the project's `appOrigins`. Those are stored as `ActiveWalkthrough.origins` when
  the panel opens a run; the panel fills them in for runs opened before 1a. A run without stored origins shows no
  widget. The Settings switch "On-page step widget" (`widgetEnabled`, on by default) and the panel's "Show on this
  tab" checkbox (`widgetTabOverride` in `storage.session`) add to this. 'hide' always wins. 'show' works on any
  http(s) page, even with the switch off, but only while a run is active.
- **Token handshake:** one random token per tab (`widgetTokens` in `storage.session`). It is reused across reloads
  and SPA re-mounts and dropped when the tab closes. The host puts it in the frame URL (`widget.html#token=…`). The
  frame sends `widget.hello {token}` to the service worker. The worker answers `{tabId, windowId, url}` only if
  the sender is `widget.html` of this extension, in a sub-frame (frameId ≠ 0), and the token matches that tab, and
  the tab is still eligible. Otherwise it answers `{error: 'denied'}` and the widget shows "not available". The
  frame then connects a port (`stubyard-widget`) to frame 0 of its tab. The host trusts that port only after a
  `ready` message with the same token.
- **Host** (`src/content/widget.ts`, `WidgetHost`): a `<stubyard-widget data-stubyard-widget>` element on
  `<html>`, with a closed shadow root. Inside are a card (an 18 px drag bar plus the iframe) and the pill. All
  styling goes through `element.style`, because page CSP blocks `<style>`. The iframe has `allow="clipboard-write"`.
  Collapsing hides the card with `display: none` and keeps the frame loaded. The pill shows "n/total"; it is plain
  text, not a ring. The frame reports its height (capped at 60% of the viewport) and the progress over the port.
- **Placement** (`widgetPlacementByOrigin` in `storage.local`, saved on drag end and collapse/expand only):
  `{corner, x, y, sheetY?, collapsed}` per origin. The default is bottom-right (bottom-left when the page is
  `dir=rtl`). Dragging the bar moves the card, and on release it snaps to the nearest corner, keeping the offset
  from that corner. Double-click or Home resets it, the arrow keys nudge it (Shift for bigger steps), and Esc
  collapses it. Under 480 px it is a bottom sheet across the width, and a drag only moves it up and down.
- **Never steals focus:** mounting, re-sizing and step changes do not move focus. Focus moves only when the tester
  collapses the card (it goes to the pill) or expands it.
- **The widget app** (`widget.html`, `src/widget/`) is React. It uses the phase 0 `StepHost` (`surface:
  'widget'`, `compact: true`, `fillRequest: 0`) and `useRun`.
  - Sync and live data: it listens to the `walkthrough.changed` stream while the page is visible and reloads on
    becoming visible. It keeps the tab URL live through `tabs.onUpdated`, so open steps switch from Go to Reload
    after an SPA route change.
  - Step kinds it runs itself (`WIDGET_STEP_KINDS`): open, logout, instruction, check, capture and fill. Fill steps
    show the values in a fold-out list.
  - Tracked runs: Done, Skip, Fail, a folded note, a screenshot via `captureClean` (the widget is not in the shot)
    and Next. Fail opens the note first.
  - Quick runs: Next ✓ and Finish. When the run created users, Finish hands over with "Clean it up in the panel" and
    an Open panel button (`chrome.sidePanel.open({tabId})`), because the cleanup UI lives in the panel only.
  - When all steps are done, a tracked run says "Sign off in the panel".
  - The header tools are Open panel, Collapse and Hide on this tab. A first-run hint is kept in `widgetHintSeen`.
- **bfcache:** when `pageshow` reports a restored page (persisted), the host loads a fresh frame. The new frame does
  the handshake again with the same tab token.
- **Shared step code:** `useStepActions()` (`src/run/stepActions.ts`) holds the Done/Skip/Fail/Next/screenshot logic
  that StepCard and the widget share. `copyText()` (`src/run/clipboard.ts`) tries the async clipboard and falls
  back to `execCommand('copy')`. Storyboard text gets `dir="auto"`.
- **Content contract** 0.3.0: new messages `widget.mount` and `widget.unmount`, and `onConnect` for the port.
- **Tests:**
  - Unit tests: `test/widget.test.ts` (placement, snap, sheet, eligibility, token check), `test/widgetHost.test.ts`
    (the host in happy-dom: mount, collapse, drag, port trust, bfcache), `test/widgetSync.test.ts` (the worker sync
    and hello), `test/widgetCard.test.ts` (the card with React), plus additions to `settings.test.ts` and
    `contentGuard.test.ts`.
  - Real check: `test/widget-spike/widget1a.py` drives the built extension in headless Chrome against a throwaway
    stubyard (default `http://127.0.0.1:41900`) and fixture pages on 41811/41812. It has 28 checks, including
    390/768/1280/1920 px, light/dark, RTL, CSP, bfcache, drag and quick runs. It is not part of `npm test`.

Left for phase 1b:
- Login, 2FA and email steps in the widget. The widget has `fillRequest` 0, so there are no fill shortcut relays,
  and there are no login or email waits yet.
- The Alt+Shift+W command.
- The manifest version bump. 0.4.0 is meant to cover 1a and 1b; the manifest is still 0.3.0.

Left for phase 2: native `<dialog>` modals, using `moveBefore` (see above).

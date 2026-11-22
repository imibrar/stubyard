# Floating widget, phase 2: text for the lead to merge

Polish and hardening. The extension stays 0.4.0; the content-script contract is 0.5.0.

## CHANGELOG.md (Unreleased, extension 0.4.0 line, after the 1b text)

- On-page widget polish:
  - Native modal dialogs: the card moves into an open `<dialog>` (above it, clickable and typeable) and back when it
    closes, without reloading.
  - The card steps aside when it would cover the highlighted element or the page's Submit / primary button (another
    corner; on phones the sheet moves to the top). It does not save that place, and stops doing it once you move the
    card yourself.
  - Accessibility: screen readers hear step changes and waits; visible focus rings on the move handle and the round
    button; reduced motion respected; works at 200% zoom.
  - Hub offline: "stubyard is not reachable." with a countdown and Retry now; it recovers by itself.
  - Two tabs of one run stay in step; after an extension reload or update the old card removes itself.
  - New look: progress line, compact header with icons, a progress ring on the round button.
  - Settings → On-page step widget: hide it on chosen sites, reset its position on this site or all sites.
  - Fixed: a new tab could keep a refused card ("not available on this page") when two tabs opened at once.
  - Content-script contract 0.5.0.

## docs/GUIDE.md §15 (extension section), a "On-page step widget" subsection after the 1b lines

> ### On-page step widget
>
> While a walkthrough is open, every page of its app shows a small card with the current step: Done, Skip, Fail
> (with a note), a screenshot and Next, plus login, 2FA and email controls. Drag the bar on top to move it (arrow keys
> work too when the bar has focus; Home puts it back); double-click the bar to put it back. Esc or Alt+Shift+W folds
> it into a round button that shows progress as a ring.
>
> - It moves out of the way by itself when it would cover the highlighted field or the page's Submit button. Once you
>   move it yourself it stays where you put it.
> - Inside a modal dialog of the app it shows above the dialog and works as usual.
> - If stubyard stops answering, the card says "stubyard is not reachable." and retries by itself (Retry now tries at
>   once). Your last step stays on screen.
> - Settings → On-page step widget: turn it off everywhere, hide it on chosen sites ("Hide on …", "Show again"), or
>   reset its position on this site or all sites. "Show on this tab" on the Walkthrough screen still shows it on a
>   hidden site for one tab.
> - Screen readers announce each new step and when a wait starts or ends.

## docs/DEVELOPMENT.md

Under Gotchas, after the widget1b.py sentence: "`packages/extension/test/widget-spike/widget2.py` checks phase 2
(native and transformed modal dialogs, a Radix modal, the nudge off a fixed Submit button, long text, 200% zoom, RTL,
hub offline through a local proxy on 41901, two tabs, iframe-heavy pages, Settings, extension reload). Same hub as
widget1a.py; set `RADIX_JS` to a built Radix Dialog bundle for the Radix check (it is skipped without it):
`python3 -I packages/extension/test/widget-spike/widget2.py OUT_DIR http://127.0.0.1:41900`."

## docs/design/storyboards.md

§6.3 (Content script bullet): "Content-script contract 0.5.0 adds the `announce` frame message and marks the
highlighted element with `data-stubyard-target` (the widget keeps clear of it)."

## docs/AGENT_GUIDE.md §AF.9

Nothing: no API change. (Settings gained `widgetHiddenOrigins`, local to the extension.)

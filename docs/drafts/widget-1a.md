# Floating widget, phase 1a: text for the lead to merge

## CHANGELOG.md (Unreleased, extension line)

- Extension: an on-page step widget. While a walkthrough is open, its app pages (the run's origin and the project's
  app origins, top frame only) get a small card in a corner. The card shows the current step with its actions:
  open, instruction, check, capture and fill steps. Tracked runs get Done/Skip/Fail, a note, a screenshot and Next;
  quick runs get Next and Finish. Login (with 2FA) and email steps run in the card too (phase 1b, see
  docs/drafts/widget-1b.md). The card and the panel stay in sync.
  - Moving it: drag it to any corner (the place is remembered per site). Esc collapses it to a small pill. Under
    480 px it becomes a bottom sheet. It supports light and dark and right-to-left pages.
  - Turning it off: a Settings switch, plus "Show on this tab" in the panel.
  - Screenshots leave the widget out.
  - Content-script contract 0.3.0. The manifest gains `web_accessible_resources` for `widget.html`.

## docs/DEVELOPMENT.md

"Everyday commands", the `test -w @stubyard/extension` row: add "the on-page widget (placement, eligibility, host,
service-worker sync, card)".

Under Gotchas: "`packages/extension/test/widget-spike/widget1a.py` checks the built widget in headless Chrome.
Build the extension first, then start a throwaway hub on another port (for example 41900) and run
`python3 -I packages/extension/test/widget-spike/widget1a.py OUT_DIR http://127.0.0.1:41900`. It is not part of
`npm test`."

## docs/design/storyboards.md §6.3 (Content script bullet)

Add:

> The service worker (`src/background/widgetSync.ts`) also injects it into the eligible tabs of a window with an
> active walkthrough, which means the run's origin and the project's `appOrigins`, top frame only. Content-script
> contract 0.3.0 answers `widget.mount {token}` / `widget.unmount` and accepts the widget's port. See
> docs/design/floating-widget.md, "Phase 1a".

## docs/GUIDE.md (extension section), suggested text

> **On-page step widget.** While a walkthrough is open, your app's pages show a small card with the current step.
> - Step actions: you can do the step from the card (Go, Highlight, Fill form, Capture, Run assertion) and record
>   it (Done, Skip, Fail with a note, Screenshot, Next). A quick test gets Next ✓ and Finish.
> - Moving it: drag the bar at the top to move it to another corner, and double-click the bar to put it back. Esc
>   folds it into a small round counter; click that to open it again.
> - Turning it off: × hides it on that tab. The panel's "Show on this tab" brings it back. Settings → "On-page step
>   widget" turns it off everywhere.
> - The card only shows on the app's own addresses (the run's address and the project's app origins). It never
>   shows inside frames, and screenshots leave it out.

## docs/AGENT_GUIDE.md

Nothing (no API change). Optional: in the project settings, `appOrigins` now also decides where the extension's
on-page widget shows.

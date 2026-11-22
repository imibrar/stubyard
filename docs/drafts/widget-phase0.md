# Floating widget, spike + phase 0: text for the lead to merge

## CHANGELOG.md (Unreleased, extension line)

- Extension (no visible change): groundwork for the on-page step widget. The step controls use a shared
  `StepHost`, the run loading is a shared `useRun` hook, screenshots go through `captureClean()` (hides the coming
  widget for the shot), and the content script replaces a stale or orphaned copy of itself when injected again
  (content script contract 0.2.0). The spike results and the GO for the iframe design are in
  `docs/design/floating-widget.md`.

## docs/DEVELOPMENT.md

In the "Everyday commands" table, the `test -w @stubyard/extension` row:

> Extension tests only (vitest + happy-dom: fill engine, page scan, URL patterns, panel state, content-script
> re-inject guard, screenshot suspend/resume, the shared run hook)

In "Repository layout", the `packages/extension/` entry can add: "shared step-view code in `src/run/`".

Optional, under Gotchas: "`packages/extension/test/widget-spike/` holds a Chrome-only spike harness (Python, host
Google Chrome); it is not part of `npm test`. See docs/design/floating-widget.md."

## docs/design/storyboards.md §6.3 (Content script bullet)

Replace "It is idempotent (guarded by `window.__stubyardContent`)." with:

> It is idempotent: `window.__stubyardContent` holds the running instance (`version`, `alive()`, `dispose()`);
> a new injection keeps a live instance of the same version and replaces anything else (an older version, or an
> orphan left by an extension reload or update, whose widget host it also removes). It also answers
> `widget.suspend` / `widget.resume` for screenshots (docs/design/floating-widget.md).

## docs/AGENT_GUIDE.md, docs/GUIDE.md

Nothing (no user-visible change, no API change).

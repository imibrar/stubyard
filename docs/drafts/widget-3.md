# Floating widget, phase 3: text for the lead to merge

Security hardening after the Fable review. The extension stays 0.4.0; the content-script contract is 0.6.0.

## CHANGELOG.md (Unreleased, extension 0.4.0 line, after the phase 2 text)

- On-page widget security hardening:
  - A page can no longer reach into the widget, restyle it to trick clicks, or reuse its token.
  - The card ignores clicks while the page hides or covers it, and says "Widget hidden by the page — use the panel".
  - Login, form and 2FA fills stay on the run's app origins; the panel asks before filling anywhere else.
  - "Show on this tab" now ends when the tab goes to another site.
  - Content-script contract 0.6.0.

## docs/GUIDE.md §15, "On-page step widget" subsection (after the phase 2 bullets)

> - If the page hides or covers the card, its buttons do nothing and it says "Widget hidden by the page — use the
>   panel". Use the side panel then.
> - The widget fills logins, forms and 2FA codes only on the run's app sites. On any other site the side panel asks
>   first ("Fill anyway"). A 2FA wait that finds the code field on another site pauses until you confirm in the panel
>   or the tab comes back.
> - "Show on this tab" lasts while the tab stays on the same site.

## docs/DEVELOPMENT.md

Under Gotchas, after the widget2.py sentence, add:

> `packages/extension/test/widget-spike/widget3.py` checks the phase 3 security hardening. It covers:
> - the attachInternals repro;
> - the host restyle;
> - clickjacking through `<html>` opacity and an overlay;
> - widget.html framed with no, a made-up or a copied token;
> - "Show on this tab" across origins;
> - that the production worker has no test hook.
>
> It uses the same hub as widget1a.py. `widget1b.py` needs the test build, because only it has
> `self.__stubyardCommand`. Build it with `./scripts/npm.sh run build:test -w @stubyard/extension`; the output goes
> to `packages/extension/dist-test/`, which is git-ignored.

## docs/design/storyboards.md

In §6.3 (the Content script bullet), add: "Content-script contract 0.6.0:
- `fill` and `setValue` take an optional `origin` and refuse when the page is on another origin;
- `probe` reports `origin`;
- `widget.mount` carries no token (the host asks the worker with `widget.token`);
- the progress message has no title, and `announce` carries a fixed `kind` only."

## docs/AGENT_GUIDE.md §AF.9

Nothing to add: there is no API change. `PendingWait` in step data gains an optional `origin`, which the extension
reads and writes itself.

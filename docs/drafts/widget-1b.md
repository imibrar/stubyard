# Floating widget, phase 1b: text for the lead to merge

Phase 1b completes extension 0.4.0 (1a + 1b). docs/drafts/widget-1a.md was updated to match: its "Continue in panel"
sentences are gone.

## CHANGELOG.md (Unreleased, extension 0.4.0 line, after the 1a text)

- Extension 0.4.0: login, 2FA and email steps run in the on-page widget.
  - Login: the card shows the user, the username and the password (each with a copy button) and Fill login. After
    you click Log in the page can navigate: the card on the next page waits for the code field and fills the
    authenticator (TOTP) or email/SMS code. The wait is kept in the walkthrough's step data, so the panel and the card
    never both wait or fill. The other one says "Waiting for the 2FA code in the page widget" (or "in the side
    panel"), with Wait here instead. The panel takes the wait over by itself when the card cannot be on that page.
  - Email: Wait for message runs in the card, also while it is collapsed (the round button gets an amber ring). The
    card shows up to 5 links of the message, then "N more links in the panel".
  - Copy buttons fall back to selecting the text when the page blocks the clipboard.
  - Shortcuts: Alt+Shift+F fills the current form or login once, in the card when it can, else in the panel. New
    Alt+Shift+W collapses or expands the card, or shows it again on a tab where it was hidden.
  - Content-script contract 0.4.0 (`widget.toggle`).

## docs/DEVELOPMENT.md

Under Gotchas, after the widget1a.py sentence: "`packages/extension/test/widget-spike/widget1b.py` checks login with
TOTP across a page navigation, the email wait and link picker, and the shortcuts, with the side panel open in the same
window. It needs the throwaway hub's SMTP port too (third argument, default 41925), for example
`STUBYARD_DOCKER_ARGS=\"-p 127.0.0.1:41900:4000 -p 127.0.0.1:41925:1025 -e STUBYARD_HOST=0.0.0.0 -e
STUBYARD_DATA_DIR=/tmp/hub --name stubyard-qa\" ./scripts/npm.sh exec -w server -- tsx src/index.ts`, then
`python3 -I packages/extension/test/widget-spike/widget1b.py OUT_DIR http://127.0.0.1:41900 41925`."

## docs/design/storyboards.md

§6.3 (Content script bullet), extend the 1a addition: "Content-script contract 0.4.0 adds `widget.toggle`
(Alt+Shift+W)."

§6.7 (login) and §6.8 (email), add one sentence each:

> The 2FA wait (email: the message wait) is stored in the step's data (`twoFactorPending` / `emailWaitPending`), so
> the on-page widget of the next page resumes it after Log in navigates, and the panel and the widget never both wait.
> See docs/design/floating-widget.md, "Phase 1b".

Service worker paragraph (§6.3), add: "Alt+Shift+F goes to the active tab's widget first (`widget.command`); only
when no widget takes it does the worker relay `panel.command`. Alt+Shift+W (`toggle-widget`) collapses or shows the
widget."

## docs/GUIDE.md (extension section), replaces the 1a line about logging in and email

> - Logging in: press Fill login in the card (or Alt+Shift+F), then click Log in yourself. If the app asks for a
>   2FA code on the next page, the card fills it when the code field shows; click Verify yourself. The panel shows
>   "Waiting for the 2FA code in the page widget" meanwhile; Wait here instead moves the wait to the panel.
> - Email steps: press Wait for message. You can collapse the card meanwhile; the round button gets an amber ring
>   while it waits. Pick a link (the card lists 5; Choose in panel shows all of them) and press Open link.
> - Copy: when the page blocks the clipboard, the copy button shows the text selected; press Ctrl+C.
> - Shortcuts: Alt+Shift+F fills the current form or login once (in the card when it shows the step, else in the
>   panel). Alt+Shift+W folds or opens the card, or brings it back on a tab where you hid it. Change them in
>   chrome://extensions/shortcuts.

## docs/AGENT_GUIDE.md

Nothing (no API change). The new step-data keys (`twoFactorPending`, `emailWaitPending`) are written by the
extension only; agents reading walkthrough reports may see them (null once the wait ended).

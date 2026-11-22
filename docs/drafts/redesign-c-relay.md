# Redesign direction C: Relay

Branch `redesign/c-relay` (off `redesign/foundation`). Web only; no API, server or extension changes.

## What it looks like

A four-pane workbench, like a mail client or an issue tracker:

| Pane | Width | Contents |
| --- | --- | --- |
| Nav column | 208 px (56 px collapsed) | Project switcher, split **New** button, collapsible groups (Inbox, Simulate, Automate, Tools, Project) with counts, Workspace menu and status at the bottom |
| List pane | 320 px (360 px from 1920) | The list of the current section: users with latest code and unread counts, projects, settings sections |
| Detail | fluid | The selected item: user workspace, project preview, the page itself |
| Context panel | 300 px | Facts about the selection (sign-in details, latest link, 2FA, rules, push). Inline from 1536 px, overlay below; toggle with the header info button or `]` |

- **Header.** A 36 px global header: breadcrumb (project / group / page), search / command palette (Ctrl K), details toggle, notifications, theme and status.
- **Type and colour.** System UI sans and a system monospace stack (no web fonts). Neutral greys with one blue accent (#1f5fd1 light, #5b9dff dark). Codes use an amber "OTP" chip everywhere: home, list rows, activity and workspace header.
- **Density.** Compact by default: 30 px controls, 32 px table rows and 52 px two-line list rows. Comfortable density is still in the status menu.
- **Components.** Cards are flat with a 1 px line. Inputs are borderless on surface-2 until hover or focus. Tabs are a compact underline. Page headers are a sticky strip with the title, description, and primary and secondary actions.

## Key pages

- **Projects (/).** Projects are listed in the list pane; clicking one shows a preview (stats, description, jump links). Double-click or Enter opens it. On phones the list is inline and a tap opens the project. `?project=slug` keeps the selection.
- **Project home.** The PageHeader shows counts and actions. Below it:
  - a "Latest codes" strip (pinned users, or the 3 most recent)
  - a users table with a Latest code column; names are never truncated, and the role shows on a second line
  - recent activity, with consecutive duplicates collapsed to "x n"
  - a setup summary per provider kind, plus the HTTPS state
- **User workspace.**
  - The users list pane has a filter, All/Unread chips, Pinned (keys 1-9), Everyone else and the Other inbox.
  - The header bar holds the large copyable latest code (key `c`), the latest link, Keep, Copy login, Edit and a previous/next stepper.
  - Message list and viewer are unchanged.
  - Sign-in, 2FA, rules and push moved to the context panel.
- **Settings and System.** The section menu is the list pane from 1024 px (a select below).
- **Traffic log.** One search field plus a "Filters" disclosure below 1280 px. Each row is a single line on desktop: request on the left, error or summary truncated on the right. Phones get compact cards.
- **Other pages** (providers, payments, storyboards, mocks, LLM, webhooks, auto-replies, push, scheduled, storage, runs, authenticator, chat, MCP tester, connect, HTTPS) keep their structure and pick up the Relay components and tokens.

## Responsive

| Width | Nav | List pane | Context panel |
| --- | --- | --- | --- |
| >= 1536 | full | inline | inline |
| 1024-1535 | full | inline | overlay |
| 768-1023 | icons only | sheet, opened from the header button that shows the list name and count | overlay |
| < 768 | drawer (menu button) | sheet | overlay |

- At every width the breadcrumb shrinks to the current page and touch targets are 40 px.
- Screenshots at 390, 768, 1280 and 1920 in light and dark show no horizontal page scroll.

## Decisions

- **Panes are portals.** Pages keep their own state and render `<ListPane>` / `<ContextPane>`, which the shell places. This avoids moving data loading into the shell. A page without a list pane gets the full width.
- **Users left the nav column.** Users are now in the list pane of the Users section, so the nav stays short. Pinned users keep the 1-9 shortcuts.
- **"New" is one split button.** It adds a user directly, and its menu offers the other create actions (the `?new=` URLs from the foundation). The palette uses the same list.
- **No auto-select.** The workspace does not auto-select the first message, because opening a message marks it read.
- **URLs unchanged.** All routes, query tabs and `data-testid` attributes are unchanged. Tabs are not added or moved by the shell.

## Contrast (measured in the browser, text on background)

| Pair | Light | Dark |
| --- | --- | --- |
| fg / surface-0, 1, 2 | 16.3, 17.9, 15.7 | 15.7, 14.7, 13.7 |
| fg-muted / surface-0, 1, 2 | 6.5, 7.2, 6.3 | 8.0, 7.5, 7.0 |
| fg-faint / surface-0, 1, 2 | 5.2, 5.7, 5.0 | 5.9, 5.5, 5.1 |
| accent-fg / surface-1, accent-soft | 7.5, 6.5 | 9.3, 7.2 |
| fg-on-accent / accent | 5.8 | 6.8 |
| otp-fg / otp-bg | 7.6 | 9.0 |
| ok, warn, bad, info -fg / -soft | 5.7, 6.5, 6.5, 6.5 | 8.2, 8.6, 6.3, 7.5 |

Soft backgrounds are composited over surface-1. Every pair is >= 4.5:1.

## Known gaps

- The context panel is used only by the user workspace. Providers, payments and storyboards still show their details inside the page, through their existing SplitView, drawer or tabs.
- Feature stylesheets (payments checkout, storyboards, chat) keep their own layout. They read the new tokens but were not redesigned piece by piece.
- Chat still shows its own three-level breadcrumb under the global one.
- The "Connect your app" table wraps long HTTPS URLs character by character on phones.
- The JS bundle is still one 1.2 MB chunk (unchanged from foundation).

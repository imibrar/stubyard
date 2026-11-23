# Redesign B "Canvas": notes

Branch `redesign/b-canvas` (built on the foundation branch). Web only: no server, extension or API changes. All routes, query parameters and `data-testid` attributes are kept.

## The look

- **Shell.** There is no sidebar.
  - A 56 px top bar holds the brand, a project pill (switcher), the five group tabs (Inbox, Simulate, Automate, Tools, Project), search (Ctrl K), status, notifications, theme and a workspace menu.
  - A 44 px sub-nav shows the pages of the current group as pills. On Inbox it also has the "Switch user" drop-down and up to six pinned avatars.
  - Content is centred at `--content-max` (1360 px, or 1600 px from 1920 px).
- **Colour.** Neutral grey-green surfaces with a teal accent, in light and dark (`styles/tokens.css`).
  - Every text pair was measured at 4.5:1 or better, and control borders at 3:1 or better.
  - Comfortable density is the default.
  - Fonts are the system stacks only.
- **Components.** Rounded cards (12 px), pill tabs on a track, pill badges with a status dot (and a tick on "ok"), 34 px controls, a 2 px accent focus ring that no component shadow can hide, and `StatTile`/`StatTiles` (`components/layout/StatTile.tsx`), which act as links, filter buttons or tabs.
- **Phone (under 768 px).**
  - A bottom tab bar replaces the group tabs; the old sidebar stays available as a sheet from the menu button.
  - Cards run full width, stat tiles go 2x2 and drawers open as bottom sheets.
  - Touch targets are 40 px or more under 640 px.
- **CSS.** All of the Canvas look lives in `styles/canvas.css`, imported last in `main.tsx`.

## Pages

- **Projects.** A card grid: mark, name, slug, unread, description, and users/providers/messages counts. The last card is a "New project" tile.
- **Project home.**
  - "Latest codes" pinned cards, then the users table, which splits Email and Phone and never truncates names.
  - The side column holds stat tiles (users, unread, providers, requests), recent activity (repeats collapse to "×n") and a four-step setup status.
- **User workspace.**
  - Messages, Scenario rules and Push are tabs (`?view=rules|push`), so only one shows at a time.
  - The reply bar sits under the timeline.
- **Providers.** The list-head "Add" buttons are gone; the header action "Add {kind}" is the single entry point. In-card section tabs have spacing.
- **Payments.**
  - Status filters are six stat tiles with counts (an arrow-key tablist) instead of chips.
  - Checkout pages is an accordion: one row per gateway with the Realistic/Classic switch, expanding to language, timings and test controls.
  - The coverage table is a collapsed card.
- **Storyboards.** A card grid with a Cards/List toggle (remembered in `localStorage`). The editor keeps its centred main column plus a validation side card.
- **Traffic.** A summary row (requests, errors, median time of the loaded rows), search, a "Filters (n)" button that opens the selects panel, and 40 px rows. On phones the request line comes first in each row and the kind chips scroll sideways.
- **Settings/System.** A section list card plus stacked cards (foundation layout restyled).
- **Everything else** (mocks, LLM, webhooks, auto-replies, push, scheduled, storage, runs, authenticator, chat, MCP tester, setup, unassigned) inherits the card, table, tab and badge styling.

## Fixes found on the way

- `payments.css` declares a global `.nowrap { white-space: nowrap }`, which made every `.row.nowrap` stop wrapping text. This caused horizontal overflow on Connect your app. Canvas resets white-space on `.row.nowrap`.
- Phone settings forms overflowed: grid tracks are now `minmax(0, 1fr)`.
- Inputs inside labels inherited bold text; they now use normal weight.
- `Menu` now moves focus to the first item when opened from the keyboard, and Escape returns focus to the button.
- The `Tabs` overflow measurement uses the parent box, so fit-content pill tracks do not oscillate.

## Known gaps

- At 800 px tall, the user workspace shows about 4–5 messages above the fold, not 6.
- Providers keep the list + detail layout rather than a category card with an instance grid.
- The drawer width is `clamp(560px, 40vw, 880px)` rather than 520 px, because the payment and traffic drawers need the room.
- The favicon and brand mark are still the indigo mark.
- The storyboard step editor is restyled but not rebuilt as individual step cards.
- Traffic table rows are still mouse-only (unchanged from before).
- Audit views that name user ids from the audit seed show "not found" against a freshly seeded instance, because the ids differ per seed.

## Checks

- `./scripts/npm.sh run typecheck -w web` passes, and so does `tsc --noUnusedLocals --noUnusedParameters`.
- `./scripts/npm.sh run build -w web` passes.
- `./scripts/npm.sh test` passes.
- Every audit route was checked at 390, 768, 1280 and 1920 in light and dark: no horizontal page scroll and no console errors, apart from audit-seed user ids that do not exist after a fresh seed.
- Keyboard: Tab order runs brand → project pill → group tabs → search → status → preferences → workspace menu → sub-nav → page; the focus ring is visible everywhere tested.

# Redesign A: "Console"

Branch `redesign/a-console` (from `redesign/foundation`). Web only; no server, extension or API changes. Every route, URL and `data-testid` is unchanged.

## What it looks like

- **Shell.** The shell has three parts:
  - **Icon rail (48 px).** Holds the groups Inbox / Simulate / Automate / Tools / Project, or the global pages outside a project. At the foot are search, the status dot and a workspace menu (theme, density, notifications, panel toggle, shortcuts).
  - **Section panel (216 px; 232 px at 1920).** Has a project switcher and the links of the current group. In Inbox it also lists the pinned users and the users.
  - **Top bar (40 px), over the content column only.** Shows the breadcrumb, the page title (16 px) and its meta. On the right are a 240 px "Search or jump…" field and the page's actions. Pages pass these through `PageHeader`, which portals the title and actions into the bar.
  - **Collapsing.** `Ctrl/⌘ B` collapses the panel (saved in `localStorage` `stubyard.panelCollapsed`). From 768 to 1023 px, and whenever it is collapsed, the panel opens as an overlay. Below 768 px the rail becomes a bottom tab bar and the panel a bottom sheet.
- **Colour.**
  - **Dark (default).** Near-black, flat, separated by hairlines: `#0c0d11` / `#12141a` / `#181b22`.
  - **Light.** Cool grey page `#f4f5f7` with white cards.
  - **Accent.** One violet-indigo accent: `#7c83ff` dark, `#4a42d6` light.
  - **Status colours.** Each status has a soft background and a separate text colour (`-fg`) that passes AA.
  - **Shadows.** Cards and tables have none; only menus, dialogs and drawers do.
- **Type and density.**
  - **Fonts.** System or bundled fonts only; nothing is loaded from the network.
  - **Compact by default.** 13 px body, 28 px controls, 32 px table rows, sticky 11 px uppercase table headers. The page padding is 12 px top and bottom.
  - **Comfortable density** (workspace menu) gives a 48 px top bar and more padding.
  - **Radius.** 5 px controls, 6 px cards, 8 px overlays, 4 px badges.
- **Components.**
  - Tabs are underlines (32 px). When a page opens with tabs, they run full-bleed under the bar.
  - Chips are 22 px and buttons 28 px.
  - Drawers are 560 px (680 px with code; 640 / 820 px at 1920). Dialogs are at most 560 px.
  - Empty states are left-aligned. The focus ring is 2 px accent with a 1 px gap.

## Key pages

- **Projects.** A table: project, slug, description, users, providers, messages, unread, updated. A row opens on click or Enter. From 1536 px a summary pane on the right has Open / Connect / Settings.
- **Project home.**
  - The title and meta (slug, counts, content-check counter) sit in the bar. Add user is primary, Generate users is secondary, and Connect / Edit project are in the "⋯" menu.
  - Below that: a strip of "latest codes" tiles (pinned users, else the three most recent).
  - Then the users table (star, user and tags, contact, latest code with copy, password and rules, unread, last, actions) with a 320 px side column: setup status while there are no messages, and recent activity (8 rows, repeats folded to "× n").
- **User workspace.**
  - **Header.** The name, role, DND / kept badges and pin are in the bar. Prev / next user, Keep, Copy login and Edit are the bar actions. Below the bar, one row holds the avatar plus email / phone / WhatsApp / password copy fields.
  - **From 1280 px, three columns:**
    - message list, 260–400 px, with the channel filter, search and the reply composer docked at the bottom;
    - viewer: shows the newest message until one is picked, and does not mark it read until it is opened;
    - context column, 280–340 px: latest code (big, copy, `c`), latest link, 2FA codes, scenario rules, push.
  - **1024–1279 px.** List and viewer side by side; code and link above them, and a collapsible "Details" for 2FA, scenario and push.
  - **Phones.** Code and link, then "Details", then the list. Opening a message replaces them with the viewer, as before.
- **Traffic log.** One 32 px line per request: method, URL, kind tag, then the summary or error inline. From 1280 px the selected request opens docked to the right of the list (`DockPanel`, same content as the drawer), and the narrow columns hide. Below 1024 px the rows stay cards.
- **Payments.** One line per payment. The refund note, outcome, provider ref and card are inline, not stacked.
- **Settings / System.** A 200 px section list (sticky) and a form column of at most 800 px.
- **Providers, storyboards, mocks, webhooks and the rest.** These keep their foundation layouts and take on the new tokens, tables, tabs and controls. Congestion fixes:
  - text in `.row.nowrap` rows wraps instead of overflowing (Connect your app);
  - forms no longer grow past their card on phones;
  - the topbar breadcrumb is cut to the parent below 1280 px.

## Decisions

- The page title moves into the bar so content starts 52 px from the top. `PageHeader` still renders the description, tabs and toolbar in the page. Below 1024 px the actions stay in the page (the bar has no room).
- The auto-shown newest message is not marked read; only an explicit open does that (the `?m=` behaviour is unchanged).
- Inbound "received" status badges are hidden in the message list; delivery problems still show. The viewer shows every status.
- The content-check counter is not shown on Unassigned (the API has no "unassigned" lint scope; it returned 404).
- `StatusPills` (unused since the foundation) and its `.pill` CSS are removed.
- Contrast was measured on 96 token pairs (text roles on every surface, status `-fg` on soft backgrounds, on-accent, rail, code). The minimum is 4.5:1. `--fg-faint` was raised to `#868e9d` (dark) and `#606878` (light) to get there.

## Known gaps

- **Traffic.** It has no filter popover or request grouping; the filters are still a row of selects (they wrap on tablets and phones).
- **Providers.** Kept as the foundation's list plus detail (two panes), not the three panes in the spec.
- **Pages left on the foundation layout.** The secondary pages (auto-replies, scheduled, push, chat, MCP tester, LLM mocks, storage) only got token, table and control restyling. They have no page-specific layout work.
- **Inline styles.** Several older pages still use inline `style={{…}}` for spacing.
- **Payments on phones.** The table is still stacked cards with one field per line.
- **Keyboard.** There is no skip link. Tab order is: top bar, then rail, then panel, then content. Every stop has a visible focus ring (checked on home at 1280 and the user workspace at 390).

## Checks

- **Static checks.** `tsc --noEmit --noUnusedLocals --noUnusedParameters` is clean; the web build and `./scripts/npm.sh test` pass.
- **Layout and console.** 30 routes × 390 / 768 / 1280 / 1920 × light / dark show no horizontal overflow in `main`, nothing clipped at its right edge, one `h1` per page, and no console errors.
- **Screenshots.** All 178 audit views × 4 widths × 2 themes are in the session scratchpad, folder `redesign-a-console/`, under the audit file names.

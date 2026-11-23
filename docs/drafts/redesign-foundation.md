# Redesign foundation (branch redesign/foundation)

The shared base for the three dashboard redesign directions. It is style-neutral, and the 0.14 look is kept. It changes web/** only; there are no API, server or extension changes.

## What changed

- **Tokens** (`web/src/styles/tokens.css`): role tokens as CSS variables for surfaces, lines, text, accent, status, channels, elevation, spacing, type, radius, z-index, motion, layout and density. The 0.14 names are kept as aliases (`--bg`, `--panel`, `--border`, `--text`, `--muted`, `--radius`, `--mono`, `--topbar`, `--sidebar`, `--tap` …), so the old CSS still works.
  - Density is set by `html[data-density=compact|comfortable]` and stored in localStorage `stubyard.density`. With no attribute, the 0.14 values apply.
  - Breakpoints are 640/768/1024/1280/1536/1920 only. All CSS and matchMedia calls now use range syntax.
- **Navigation registry** (`web/src/nav.ts`): one source for the sidebar groups, the Ctrl+K palette, crumbs and tab ids.
  - Sidebar groups: Inbox, Simulate, Automate, Tools, Project.
  - `GLOBAL_NAV`.
  - Per-page tab registries: PROVIDER, PAYMENT, STORYBOARD (+LIBRARY), PUSH, LLM, AUTO_REPLY, WEBHOOK, CHAT, MCP, SETTINGS and SYSTEM tabs.
  - Helpers: `projectPath`, `tabHref`, `findNavItem`, `resolveTab` (aliases → id + extra params) and `readRecent`/`pushRecent`.
- **Shell** is split into AppShell, UserSwitcher, StatusMenu and CommandPalette.
  - The sidebar is grouped from NAV_GROUPS.
  - The status pills collapse into a status menu below 1024 px.
  - The theme and notification buttons move into that menu below 640 px.
  - Shortcuts: Ctrl/Cmd+K and `/` open the palette, `?` lists shortcuts, 1–9 open pinned users, and `g` then o/u/t/p/y/s/, go to Overview, Users, Traffic, Providers, Payments, Storyboards and Settings.
- **Ctrl+K palette** searches:
  - recent pages
  - users and their latest codes
  - every nav item and tab
  - actions (new user, generate users, new provider, new mock, new storyboard, new webhook endpoint, via `?new=`)
  - provider instances, projects, System tabs, theme and density
  - request ids

  It is an ARIA combobox and goes full screen on phones.
- **Settings** (`/p/:slug/settings?tab=general|data|checks|danger`) and **System** (`/system?tab=overview|ai|maintenance|danger`, plus an HTTPS link) use SettingsLayout. Unknown or missing tabs show the first section.
- **Tabs everywhere** (F8): Providers (one category strip; a select on phones), provider SectionTabs, Payments, Storyboards, Push, LLM, Auto-replies, Webhooks (now also `?tab=receive|send`), Chat, MCP tester, Scheduled and User workspace (channel filter). The old class names stay on each strip.
- **Storyboards: 7 tabs → 4.** The strip is Storyboards · Walkthroughs · Library · Cleanup.
  - Library has a segmented control: Data sets / Login recipes / Page snapshots (`?tab=library&lib=recipes|snapshots`).
  - Import / export is a header action.
  - The old `?tab=data-sets|recipes|snapshots|bundle` URLs still resolve.
- **Payments: Gateways tab.** `/p/:slug/providers/payments` is shown under the Payments title and tab strip, and the Payments sidebar item is active there. `/payments?tab=gateways` redirects to it.
- **Login providers:** the URL host switch is a segmented control, remembered across providers (`stubyard.connectHost`).
- **New routes:**
  - `/p/:slug/users` (the users overview)
  - `?new=user|generate|provider|mock|endpoint` handlers (the `useNewAction` hook in hooks.ts)
  - `/system?tab=ai` links from the LLM and Chat pages
  - `settings?tab=checks` from the home lint counter

  Every old URL still works.
- Modal and Drawer now trap focus, restore it on close, and set aria-labelledby.

## Component API (`web/src/components/layout`, import from `../components/layout`)

| Component | Props |
|---|---|
| `PageHeader` | `title, crumbs?: {label,to?}[], meta?, description? (one line + "?" toggle), descriptionKey?, primary?, secondary?: ReactNode[] (into More on phones), more?: (close)=>ReactNode, actions? (legacy), tabs?, toolbar?, sticky?` |
| `Tabs<T>` | `items: {id,label,text?,count?,zero?,extra?,icon?,title?,to?,disabled?}[], value, onChange?, variant 'page'\|'segmented'\|'filter', label, className?, phoneSelect=true, overflow=true, as 'div'\|'nav', panelId?`. Page tabs overflow into "More (n)" and become a bottom-sheet select on phones when there are more than 3. `to` makes them links. `TabPanel` is also exported. |
| `Toolbar` / `FilterBar` | FilterBar: `search?, children, chips? (active, removable), onClearAll?, end?` |
| `SplitView` | `list, detail, hasSelection, mode 'split'\|'stack', listWidth?, empty?`. Stacks below 1024 px. |
| `Workspace` | `header, summary?, primary, secondary?, context?` (template for detail pages) |
| `LogLayout` | `toolbar, children` (template for log/stream pages) |
| `SettingsLayout` | `sections: (TabDef & {danger?, href?})[], value, onChange, label`. Vertical nav at 1024 px and up, a select below. Use it with `useQueryTab(tabs, param='tab') → [id, set, aliasParams]`. |
| `DataTable` | `columns {key,header,render,priority 1-3,align,width,fill,mono}, rows, rowKey, onRowClick?, selectedKey?, empty?, stack 'phone'\|'never'\|'always', caption?, rowMenu?` |
| `Section`, `KeyValue`, `EmptyState`, `StatusBadge`, `CopyField` (truncates in the middle) | small building blocks |
| `AppShell` | `header, nav, children, overlays` (keeps `.shell`/`.main`) |
| hooks (`layout/hooks.ts`) | `BP`, `useMediaQuery`, `usePhone`, `useWidth`, `useFocusTrap` (stacked) |

Other modules:

- `components/UserSwitcher.tsx`: `UserSwitcher`, `usePinnedUsers`, `unreadOf`.
- `components/StatusMenu.tsx`: `useShellPrefs` (theme, density, notify), `StatusPills`, `StatusMenu`, `applyTheme`, `applyDensity`.
- `components/CommandPalette.tsx`.
- `providerLayout.tsx`: `SectionTabs` (same API), `useConnectHost`, `ConnectHostSwitch`.
- `pages/PaymentsPage.tsx`: `PaymentTabs`.
- `ProjectMaintenance` has a new `parts` prop.
- `Page` in ProjectPage now wraps PageHeader and accepts its props.

## Notes for the direction builders

- Restyle through tokens.css (role tokens) and layout.css. Pages already use these components, so a direction mostly changes token values and component CSS, not page code.
- To add a nav item or tab, change nav.ts. The sidebar, palette and crumbs follow it.
- data-testid attributes and the 0.14 class names are unchanged.
- Verified: web typecheck (also with noUnusedLocals), web build, and the full `./scripts/npm.sh test`. Screenshots of 31 views at 390/768/1280/1920 in light and dark show no horizontal page scroll.
- Not done: "Pause traffic" as a palette action. TrafficLog keeps its pause state internal.

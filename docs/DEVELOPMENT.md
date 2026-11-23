# Developing stubyard

A handoff guide for anyone working on stubyard itself: what you need, how to run it from source, where things live,
how to add a feature and how a release is made. For *using* stubyard, see [GUIDE.md](GUIDE.md); for the full
API reference, see [AGENT_GUIDE.md](AGENT_GUIDE.md).

## Branches

| Branch | Purpose |
|---|---|
| `main` | Released code. Every release is a commit on `main` plus a `vX.Y.Z` tag. |
| `dev` | Day-to-day development. Work here (or on short feature branches off `dev`), merge to `main` when releasing. |

```bash
git checkout dev && git pull
git checkout -b feature/my-thing      # optional, for bigger changes
# … work, commit …
git checkout dev && git merge feature/my-thing
```

CI (`.github/workflows/ci.yml`) runs on every push to every branch: typecheck, tests, build.

## What you need

- **Docker** (Docker Desktop on macOS/Windows, Docker Engine on Linux). That is all: Node is *not* required on
  the host. `scripts/npm.sh` runs npm inside a dev container (`docker/dev.Dockerfile`: Node 24 + the Mailpit binary).
- **git**.
- Optional: Node 24 on the host if you prefer running npm directly (then install Mailpit too, or the e2e tests that
  need it are skipped).
- Optional: an API key for Anthropic / OpenAI / Google / OpenRouter, only to try AI chat and personas against real
  models. Tests never need one (they use the built-in `mock:*` providers).

## First run

```bash
git clone https://github.com/imibrar/stubyard.git && cd stubyard
git checkout dev
./scripts/npm.sh ci                 # install all workspaces (first call also builds the dev image)
./scripts/npm.sh run typecheck
./scripts/npm.sh test               # full server test suite
./scripts/dev.sh                    # watch mode → http://localhost:5173 (dashboard), :4000 (API)
```

`scripts/dev.sh` runs the server with `tsx watch` and the dashboard with Vite (which proxies `/api` to the server).
Dev data goes to `./data` (git-ignored); delete it for a clean start.

**Ports already taken** (for example a stubyard container is running on the same machine)? Move the dev ports:

```bash
STUBYARD_DEV_HTTP_PORT=34000 STUBYARD_DEV_HTTPS_PORT=34443 STUBYARD_DEV_SMTP_PORT=31025 \
STUBYARD_DEV_APNS_PORT=32197 STUBYARD_DEV_WEB_PORT=35173 ./scripts/dev.sh
```

**Open it from another machine** on the same network: bind the ports to all interfaces and tell stubyard its address
(so login and payment pages redirect there, and the API accepts requests made to it):

```bash
STUBYARD_DEV_BIND=0.0.0.0 STUBYARD_PUBLIC_URL=http://<this-machine-ip>:4000 \n  STUBYARD_ALLOWED_HOSTS=<this-machine-ip> ./scripts/dev.sh
```

Without sign-in the dashboard is open to anyone who can reach it, so only do this on a network you trust, or run
with sign-in (below).

**Run with sign-in** (Single admin mode, GUIDE.md "Sign-in (single admin)"). `scripts/dev.sh` sets
`STUBYARD_DOCKER_ARGS` itself, so run the server directly with the admin settings (it serves the built dashboard;
the throwaway data dir lives inside the container):

```bash
./scripts/npm.sh run build -w web
STUBYARD_DOCKER_ARGS="-p 127.0.0.1:48700:4000 -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/tmp/sy-auth \
  -e STUBYARD_ADMIN_EMAIL=dev@example.test -e STUBYARD_ADMIN_PASSWORD=dev-password-1 -e STUBYARD_WEB_DIR=/app/web/dist" \
  ./scripts/npm.sh exec -w server -- tsx src/index.ts            # → http://localhost:48700
```

The server reads the dashboard's file list at start: restart it after rebuilding the web app.
`./scripts/npm.sh run hash-password -w server` prints a hash for `STUBYARD_ADMIN_PASSWORD_HASH`.

To run the production image from your checkout instead: `docker compose up -d --build` (root `docker-compose.yml`
includes `deploy/docker-compose.yml`).

## Everyday commands

All of these work as `./scripts/npm.sh …` (or plain `npm …` with Node on the host).

| Command | What it does |
|---|---|
| `run typecheck` | `tsc --noEmit` for server, web, `@stubyard/client` and `@stubyard/extension` |
| `test` | All server tests (vitest, files run one after another), then the extension tests |
| `test -w server -- test/personas.e2e.test.ts` | One test file |
| `test -w server -- -t "refund"` | Tests whose name matches |
| `run build` | Compile server (`server/dist`), dashboard (`web/dist`) and the Chrome extension (`packages/extension/dist`) |
| `run build -w @stubyard/extension` | The Chrome extension only; load `packages/extension/dist` unpacked in `chrome://extensions` |
| `run build:test -w @stubyard/extension` | The extension's test build in `packages/extension/dist-test/` (git-ignored): the same code plus a test-only command hook (`self.__stubyardCommand`) for the widget harnesses; never load it for real use |
| `test -w @stubyard/extension` | Extension tests only (vitest + happy-dom: fill engine, page scan, URL patterns, panel state, content-script re-inject guard, screenshot suspend / resume, the shared run hook, the on-page widget: placement, eligibility, host, service-worker sync, card) |
| `run test:sdk -w server` | Real-SDK conformance tests only |

`STUBYARD_BOTO3=1 ./scripts/npm.sh test -w server -- test/storage.sdk.test.ts` uses a dev image with Python and a
pinned boto3 (`docker/dev-boto3.Dockerfile`) so the boto3 S3 test runs instead of being skipped. CI installs the
same pinned version.

## Repository layout

```
server/                 Fastify server, Node built-in SQLite (node:sqlite), TypeScript ESM
  src/index.ts          createHub(): wires every repo/service into the Hub, starts HTTP/HTTPS/SMTP/APNs
  src/hub.ts            Hub interface: the one object route handlers and services receive
  src/config.ts         all STUBYARD_* environment variables (DEVHUB_* still read as a fallback)
  src/db/migrations.ts  ordered SQL migrations (append only)
  src/access/           sign-in: config of the admin, sessions + API tokens (AuthStore, SQLite now), the login
                        limiter, the onRequest hook (hook.ts) and the permission table (permissions.ts): every /api
                        route maps to a permission; a test fails for an unmapped route
  src/http/app.ts       buildApp(): registers the guard, hooks and every route module
  src/http/routes/      REST API (/api/…) and provider endpoints, one file per area
  src/repos/            table access (one repo per area)
  src/<feature>/        feature services: payments/, chat/, personas/, push/, storage/, auth/, webhooks/, …
  src/storyboards/      storyboards, data sets, login recipes, page snapshots, walkthroughs; schema.ts (zod) is the
                        contract, ontology.ts / guide.ts / mcp-tools.ts are the MCP authoring tools
  test/                 vitest suites: *.e2e.test.ts start a full hub; *.sdk.test.ts drive it with real vendor SDKs
web/                    React 19 + Vite dashboard
  src/App.tsx           top-level routes; project routes are in pages/ProjectPage.tsx
  src/nav.ts            navigation registry: nav groups, global pages, every page's tabs (see Dashboard layout)
  src/pages/            one page per area; src/*Api.ts are the typed API clients
  src/components/layout/  shared layout components (PageHeader, Tabs, DataTable, SettingsLayout, …)
  src/styles/           tokens.css (design tokens), canvas.css (the Canvas look), one CSS file per feature
packages/client/        @stubyard/client: the test helper library apps use in their own tests
packages/extension/     @stubyard/extension (private): the Chrome MV3 extension for walkthroughs (side panel in
                        src/sidepanel/, form fill, page scan and the widget host in src/content/, the on-page
                        widget frame in src/widget/, step-view code shared by both in src/run/, widget sync in
                        src/background/); test/widget-spike/ holds the headless Chrome harnesses; not shipped in
                        the Docker image
docs/                   GUIDE.md (users), AGENT_GUIDE.md (full reference, also served at /api/agent-guide),
                        CI.md, CONCEPT.md, PLAN.md, DEVELOPMENT.md (this file), design/ (feature design records),
                        examples/ (e.g. the Class PROvia storyboard bundle)
deploy/                 compose files, the offline Windows/macOS/Linux bundle (deploy/bundle), make-bundle.sh
docker/                 dev images used by scripts/npm.sh
Dockerfile              production image (multi-stage; exposes 4000 4443 1025 2197)
```

Ports inside the container: 4000 HTTP (dashboard, API, provider endpoints), 4443 HTTPS (local CA), 1025 SMTP,
2197 fake APNs (HTTP/2).

## Adding a feature (the usual path)

1. **Migration** — append a new `{ version: N, sql: \`…\` }` entry at the end of `server/src/db/migrations.ts`.
   Never edit or renumber an existing one (live installs have already applied it). Versions used: 1–5, 7–29;
   **the next free number is 30**. Every per-project table gets `project_id … REFERENCES projects(id) ON DELETE
   CASCADE` (and `run_id … REFERENCES runs(id) ON DELETE CASCADE` if it is run-scoped).
2. **Repo / service** — table access in `server/src/repos/` or a `server/src/<feature>/service.ts`.
3. **Wire it** — add the field to `Hub` in `hub.ts` and construct it in `createHub()` in `index.ts`.
4. **Routes** — a `registerXxxRoutes(app, hub)` module in `server/src/http/routes/`, registered in `http/app.ts`.
   Validate input with zod; throw `HttpError` for 4xx.
5. **Housekeeping hooks** if the feature stores data:
   - retention purge in `server/src/maintenance/retention.ts` (`purgePerProject`),
   - project export/import (see `personas/export.ts` for the pattern) — mask secrets unless `?secrets=1`,
   - project reset.
6. **Outbound calls** (webhooks, callbacks) must go through the outbound allowlist (`STUBYARD_OUTBOUND_ALLOW`) and
   URL check (`rejectUrl`); never call arbitrary hosts.
7. **Dashboard** — a page in `web/src/pages/`, its API client in `web/src/<feature>Api.ts`, a route in
   `ProjectPage.tsx` and an entry in `web/src/nav.ts` (see [Dashboard layout](#dashboard-layout)). Check it at 390,
   768, 1280 and 1920 px wide.
8. **Tests** — an `*.e2e.test.ts` that starts a hub on free ports with a temp data dir (copy the setup at the top of an
   existing suite such as `test/personas.e2e.test.ts`). Use real vendor SDKs in `*.sdk.test.ts` where one exists.
9. **Docs** — the reference section in `docs/AGENT_GUIDE.md` (the single source; the bundle copy is generated),
   a short walkthrough in `docs/GUIDE.md`, and a line in `CHANGELOG.md`.

### Conventions

- TypeScript strict, ESM, `.js` suffix in relative imports.
- Everything a provider receives or sends is written to the traffic log; keep it that way for new endpoints.
- Mask card numbers, tokens and secrets in logs and exports.
- Keep dependencies pinned in the AI packages (`ai`, `@ai-sdk/*`, `zod`) — they move fast.
- Env vars are `STUBYARD_*`; read them through `envVar()` in `config.ts` so the old `DEVHUB_*` names keep working.
  The Docker volume (`devhub-data`) and network (`devhub`) keep their pre-rename names on purpose, so do not
  rename them.

## Dashboard layout

The dashboard (0.14 redesign, "Canvas") has no sidebar. A 56 px top bar holds the brand, the project pill, the group
tabs Inbox / Simulate / Automate / Tools / Project, search, status, notifications, theme and the workspace menu. A 44 px
sub-nav under it shows the pages of the current group as pills (Inbox adds the "Switch user" drop-down and pinned
avatars). Content is centred at `--content-max` (1360 px, 1600 px from 1920 px). Below 768 px a bottom tab bar
replaces the group tabs, and the menu button opens every page of the project as a sheet.

| Where | What |
|---|---|
| `web/src/nav.ts` | The navigation registry, the one source for the nav groups (`NAV_GROUPS`), the global pages (`GLOBAL_NAV`), every page's tab list (`PAYMENT_TABS`, `STORYBOARD_TABS`, `SETTINGS_TABS`, `SYSTEM_TABS`, …), palette keywords and crumbs. Helpers: `projectPath`, `tabHref`, `findNavItem`, `resolveTab` (aliases → id + extra params), `readRecent` / `pushRecent`. |
| `web/src/styles/tokens.css` | Design tokens: colour roles for dark (default) and light, status `-fg` colours, spacing, type, radius, elevation, z-index, motion, layout sizes and density. Theme is `<html data-theme>` (`stubyard.theme`), density `<html data-density=compact\|comfortable>` (`stubyard.density`). The pre-redesign names (`--bg`, `--panel`, `--text`, `--muted`, `--border`, …) stay as aliases. Breakpoints are 640 / 768 / 1024 / 1280 / 1536 / 1920 only, written with range syntax (`@media (width < 640px)`). |
| `web/src/styles/canvas.css` | The Canvas look: shell, buttons, inputs, tables, pill tabs, badges, cards, overlays, stat tiles and the page-specific layouts. Imported last in `main.tsx` (after `styles.css` and the feature CSS) so it wins. Colours only from tokens. |
| `web/src/components/layout/*` | Shared layout components, imported from `components/layout`: `PageHeader` (title, crumbs, meta, description, `primary` / `secondary` / `more` actions, `tabs`, `toolbar`), `Tabs` / `TabPanel` (variants page, segmented, filter; overflow into "More", a select on phones), `Toolbar`, `FilterBar`, `SplitView`, `Workspace`, `LogLayout`, `SettingsLayout` + `useQueryTab`, `DataTable` (column priorities, stacks on phones), `Section`, `KeyValue`, `EmptyState`, `StatusBadge`, `CopyField`, `StatTile` / `StatTiles` (a tile is a link, a filter button or a tab; `StatTiles tablist` makes an arrow-key tablist), `AppShell` (with the "Skip to content" link); `hooks.ts` has `BP`, `useMediaQuery`, `usePhone`, `useWidth`, `useFocusTrap`. Styles in `layout.css`. |
| `web/src/components/Markdown.tsx` | A small, safe markdown renderer (React elements only, never HTML): headings (as h3–h6), lists and task lists, quotes, code, links (http, https, mailto) and images that resolve through a callback (the features board maps `image:<id>` to its own image URLs; other image URLs become links). Used by the features board for details and task notes. |
| `web/src/components/Shell.tsx`, `shell/CanvasNav.tsx` | The app frame: keyboard shortcuts (`GO_KEYS` for the `g` jumps, the `?` list) and the page-list sheet in `Shell.tsx`; the top bar (`TopNav`: brand, project pill, group tabs, workspace menu), the sub-nav (`SubNav`) and the phone `BottomBar` in `CanvasNav.tsx`. |
| `web/src/components/CommandPalette.tsx`, `StatusMenu.tsx`, `UserSwitcher.tsx` | The Ctrl/⌘+K palette (reads nav.ts), theme / density / notification prefs, pinned users. |
| `web/src/hooks.ts` `useNewAction` | `?new=user\|generate\|provider\|mock\|endpoint` handlers used by palette actions. |

**Adding a page:** add the route in `web/src/pages/ProjectPage.tsx` (project pages) or `App.tsx` (global pages),
then one `NavItem` in the right group of `NAV_GROUPS` (or `GLOBAL_NAV`) in `nav.ts`: `id`, `label`, `path`
(relative to `/p/:slug`), `icon`, `keywords`, optionally `alsoActive` path prefixes and a `count` badge. The group
tabs, sub-nav, page sheet, palette and crumbs pick it up. The page renders `PageHeader` (or `Page` in ProjectPage, which wraps
it) with one `h1`.

**Adding a tab:** add a `TabDef` to the page's tab list in `nav.ts` (`id` is the `?tab=` value; set `path` when the
tab is a route of its own; list old ids in `aliases` so old links keep working) and render it with
`<Tabs items=… value=… />` plus `useQueryTab(TABS)`. Settings-style pages use `SettingsLayout`. Unknown or missing
tab values fall back to the first tab. Keep `data-testid`s and the existing class names on tab strips.

Check every new screen at 390, 768, 1280 and 1920 px in light and dark: no horizontal page scroll, one `h1`, no console
errors. The screenshot and audit scripts used for the redesign are not in the repository (they lived in the session
scratchpad).

## Making a release

1. On `dev`: typecheck, run the test suite **twice** (to catch flaky tests), build.
2. Bump the version in all of these places:
   - `package.json`, `server/package.json`, `web/package.json`
   - `VERSION` in `server/src/http/routes/api.ts` and `version` in `server/src/http/routes/mcp.ts`
   - `packages/client/package.json` only if the client changed (it has its own version; 0.8.0 since stubyard 0.15.0)
   - `packages/extension/package.json` and `packages/extension/public/manifest.json` only if the extension changed
     (it has its own version, 0.5.0 in stubyard 0.15.0; keep the two in step)
3. Add the release to `CHANGELOG.md`; refresh the bundle docs with `deploy/make-bundle.sh`.
4. Build the image and smoke-test it on spare ports:
   ```bash
   docker build -t stubyard:latest .
   docker run -d --rm --name stubyard-smoke -p 127.0.0.1:25000:4000 stubyard:latest
   curl -s http://127.0.0.1:25000/api/system      # name + version
   docker stop stubyard-smoke
   ```
5. Merge `dev` into `main`, then tag and push:
   ```bash
   git checkout main && git merge --ff-only dev
   git tag v0.14.0 && git push origin main v0.14.0
   git checkout dev
   ```
   The `v*` tag triggers `.github/workflows/release.yml`, which publishes `ghcr.io/imibrar/stubyard:<version>` and
   `:latest` for amd64 and arm64.
6. Offline bundle (optional): `deploy/make-bundle.sh --image --tar` → `deploy/stubyard-bundle.tar.gz`.

### Upgrading a running instance

Data lives in the Docker volume, so an upgrade is: back up, then replace the container.

```bash
docker run --rm -v devhub-data:/data -v "$PWD":/backup alpine tar czf /backup/stubyard-data-backup.tgz -C /data .
docker compose -f deploy/docker-compose.yml up -d --build      # migrations run automatically at start
```

Never use `docker compose down -v` on an instance whose data you want: `-v` deletes the volume (projects, emails,
the HTTPS CA).

## Gotchas

- **e2e tests need Mailpit.** Present in the dev image and in CI; with host Node and no Mailpit, those suites skip.
- **Tests run one file at a time** (`fileParallelism: false`) because e2e suites start full hubs; timeouts are raised
  in `server/vitest.config.ts`.
- **Never commit secrets.** `.env` files and `deploy/bundle/.env` are git-ignored and excluded from the bundle
  tarball; keep it that way.
- **Behind an SSH tunnel with different ports**, set `STUBYARD_PUBLIC_URL` (e.g. `https://localhost:24443`) so login
  and payment pages redirect the browser to the right address.
- **Widget harnesses (headless Chrome, not part of `npm test`).** `packages/extension/test/widget-spike/` holds Python
  scripts that drive the built extension in host Google Chrome (133 or later) against a throwaway hub on another port
  (never the live one) and fixture app pages they serve themselves on 127.0.0.1:41811 / 41812. Each takes
  `[OUT_DIR] [HUB_URL]` (default `http://127.0.0.1:41900`) and writes screenshots and `results.json` to `OUT_DIR`.
  Start the hub, for example:

  ```bash
  STUBYARD_DOCKER_ARGS="-p 127.0.0.1:41900:4000 -p 127.0.0.1:41925:1025 -e STUBYARD_HOST=0.0.0.0 \
    -e STUBYARD_DATA_DIR=/tmp/hub --name stubyard-qa" ./scripts/npm.sh exec -w server -- tsx src/index.ts
  ```

  - `spike.py`, `guard.py`, `extra.py`: the iframe spike (fixture servers on 41801–41805; they need a self-signed
    cert in `certs/` and a bundled `fixtures/radix.js`, see the script headers and
    [design/floating-widget.md](design/floating-widget.md)).
  - `widget1a.py`: mounting, placement, drag, collapse, tracked and quick steps, sync, Settings.
  - `widget1b.py`: login with TOTP across a page navigation, the email wait and link picker, the shortcuts, with the
    side panel open. It loads the **test build** (`dist-test/`, which has the `self.__stubyardCommand` hook) and needs
    the hub's SMTP port as a third argument (default 41925).
  - `widget2.py`: native and transformed modal dialogs, a Radix modal (set `RADIX_JS` to a built Radix Dialog bundle,
    else skipped), the nudge off a fixed Submit button, 200% zoom, RTL, hub offline (local proxy on 41901), two tabs,
    Settings, extension reload.
  - `widget3.py`: the security hardening (the `attachInternals` repro, host restyle, clickjacking through `<html>`
    opacity and an overlay, `widget.html` framed with no, a made-up or a copied token, "Show on this tab" across
    origins, no test hook in the production worker).
  - `recording1.py`: DOM recording (segments per page load, step markers, masking, widget left out, Pause / Resume,
    another origin, sizes, the dashboard player). Loads the test build; throwaway hub on 48000, fixture pages on
    48011 / 48012.
  - `recording2.py`: video mode (Record video, dots, across page loads, pause on another origin, markers, Range
    serving, the dashboard `<video>`, sizes, the cap). Hub on 48200, fixtures on 48211 / 48212; `SECTIONS=a,b` runs
    some sections. Headless tab capture works only with `--allowlisted-extension-id=<id>` (the id of an unpacked
    extension is sha256 of its path, first 32 hex digits as a–p; the script computes it); `--use-fake-ui-for-media-stream`
    or `--auto-accept-this-tab-capture` make it fail (NotFoundError).
  - `recording-secrev.py`: the recording privacy regression (every field kind the security review found leaking, with
    every input unmasked so the rules alone must hold; server limits; a forged recording replayed with no script run
    and no request to the other site). Prints PASS / FAIL and exits 1 on any failure. Hub on 48300, fixtures on
    48311 / 48312.

    The recording scripts need `./scripts/npm.sh run build` and `run build:test -w @stubyard/extension`, and a hub
    started **after** the web build (it serves the dashboard files it found at start); each script header has the
    exact command. `APP_PORT` moves the fixture ports.

  Build first: `./scripts/npm.sh run build -w @stubyard/extension` (and `run build:test` for `widget1b.py`), then
  e.g. `python3 -I packages/extension/test/widget-spike/widget1a.py OUT_DIR http://127.0.0.1:41900`. Stop the hub
  afterwards.
- **Walkthrough recording code.** Server: `server/src/storyboards/recordings.ts` (storage, caps, retention, URL
  redaction, `addVideoChunk`, `videoFile`, `webmSetDuration`), routes and `parseRange` in
  `http/routes/walkthroughs.ts` (also the CSP replay page `…/recording/player`). Extension: `src/shared/recording.ts`
  (masking rules, rrweb options), `src/content/sensitive.ts` (`SensitiveTracker`), `src/content/recorder.ts`
  (segments, chunks, heartbeats), `src/background/recordingSync.ts` (start/stop, upload); video in
  `src/shared/video.ts`, `src/background/videoSync.ts`, `src/offscreen/` (MediaRecorder in `videoRecorder.ts`),
  `src/content/videoMode.ts` (dots, widget pill) and `src/run/useVideo.ts`. Dashboard:
  `web/src/components/RecordingTab.tsx` (rrweb-player in the sandboxed player frame, `VideoPlayer`). Tests:
  `server/test/walkthrough-recording.e2e.test.ts`, `…-privacy.e2e.test.ts`, `…-video.e2e.test.ts`,
  `packages/extension/test/recording.test.ts` and `recordingVideo.test.ts`.
  - The content script runs in the isolated world: rrweb sees the DOM, not the page's JS objects.
  - MediaRecorder's WebM has no Duration, Cues or SeekHead; the hub patches a Duration in when serving.
  - A video segment is a `walkthrough_recordings` row whose key starts with `video.`, its metadata in a chunk row
    with `seq = -1` (no migration in R2; a later one can add `kind` / `mime` columns).
- **HTTPS CA:** each data directory has its own CA. Deleting `./data` (dev) or the volume makes a new one, which
  browsers and apps must trust again.

## Where to look next

- [CONCEPT.md](CONCEPT.md) — the original design and principles.
- [PLAN.md](PLAN.md) — the roadmap history.
- [CHANGELOG.md](../CHANGELOG.md) — what each release added.
- [CI.md](CI.md) — running stubyard inside other projects' CI.

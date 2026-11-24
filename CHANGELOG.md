# Changelog

All notable changes to stubyard. Versions before 0.11.0 were released under the name **devhub**; the rename kept
`DEVHUB_*` environment variables, the `devhub-data` volume and the `devhub` network working.
Each release lists its database migrations, which run automatically at start.

## Unreleased

### Changed
- **Project Overview and Users are separate pages.** They showed the same screen before.
  - **Overview** (`/p/:slug`, the first screen) is a project dashboard: header with Connect your app, the four
    numbers (users, unread, providers, requests), a **Plan** card, the latest codes of the first pinned users,
    recent activity, the latest walkthroughs (when there are any) and Setup until every step is done.
  - The **Plan** card reads the Features board: counts by status (each opens the board filtered), a bar of done
    features, and the features in progress and planned next with priority and task progress. It updates live. A
    project without features shows "Plan this project" with a quick add (roles with `features.edit`).
  - A project without test users shows a short "No test users yet" bar with Add user and Generate test users.
  - **Users** (`/p/:slug/users`) holds the latest codes of all pinned users, the role filter, the users table and
    Add user / Generate users.
  - `g u` now opens Users, and the palette actions Add user and Generate users open the Users page.

## 0.16.0 — 2026-11-24

### Added
- **Sign-in (Single admin mode)**, off by default.
  - Turn it on with `STUBYARD_ADMIN_EMAIL` plus `STUBYARD_ADMIN_PASSWORD_HASH` (or `STUBYARD_ADMIN_PASSWORD`).
    Optional: `STUBYARD_SESSION_TTL_HOURS` (default 168) and `STUBYARD_COOKIE_SECURE` (default on when
    `STUBYARD_PUBLIC_URL` is https). The `DEVHUB_` names work too.
  - `node dist/access/hash-password.js` (in the image) and `npm run hash-password -w server` make a hash. The format
    is `scrypt:N:r:p:salt:hash`.
  - The dashboard gets a sign-in page, an account menu (signed in as, API tokens, sign out) and an **API tokens**
    page: create, name, copy once, revoke.
  - The API gains `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, and
    `GET/POST /api/auth/tokens` with `DELETE /api/auth/tokens/:id`.
  - With sign-in on, `/api/*`, `/mcp`, `/mailpit` and the event stream need the session cookie or
    `Authorization: Bearer <token>`.
    - Cookie requests that change data must also send `X-Stubyard-CSRF`.
    - App-facing endpoints stay open: `/mock`, `/hook`, `/auth`, `/pay`, `/storage`, `/llm`, `/push`, SMTP
      and APNs.
    - `GET /api/system` answers only `{name, version, authRequired}` without sign-in.
  - Failed sign-ins are limited (429 with `Retry-After`).
    - The admin e-mail is only slowed down: 2 to 60 s after 5 failures per address.
    - Other e-mails: 5 failures per e-mail and address, and 20 per address, in 15 minutes.
    - At most 2 password checks (async scrypt) run at once.
  - `STUBYARD_TRUST_PROXY` (off by default) takes the client address from `X-Forwarded-For` behind a reverse proxy.
  - The embedded Mailpit's UI and API get a random login that only stubyard uses (sign-in on only).
  - Password hashes are limited to 256 MiB of scrypt memory (128·N·r) and p ≤ 4; a larger one is refused at start.
  - stubyard warns at start when sign-in runs over plain HTTP to another machine.
  - Open mode (no admin configured) behaves exactly as before.
- **Database migration 29**: the `auth_sessions` and `api_tokens` tables.
- **Browser extension 0.6.0**:
  - Settings has an **API token** field. It is stored on this computer only (never synced) and shown masked.
  - The extension sends the token as Bearer to the hub, and loads screenshots with it.
  - A 401 shows "This hub needs a token: create one in the dashboard → API tokens".
- **@stubyard/client 0.9.0**:
  - Every helper takes an `apiToken` option; in Node the default is the `STUBYARD_TOKEN` environment variable.
  - The token is sent only to the hub's own origin.
  - `hubFetchFn()` is exported from `@stubyard/client/http`.
- **Features board**: a light plan per project (dashboard **Project → Features**, `g f`). Each feature has a key
  (`F-1`, `F-2`, … never reused), title, markdown details, status (Idea, Planned, In progress, Done), priority,
  images and an optional link to a storyboard, plus tasks with one level of subtasks (done, note, assignee). The page
  lists features grouped by status with a status filter, search, quick add (title, Enter; `n` focuses it), up / down
  reorder and a small board view; the drawer edits details (rendered markdown, paste or drop an image into the
  editor), shows an image gallery with a lightbox and edits tasks inline (checkbox, add, reorder, rename, delete).
  - **Images**: PNG, JPEG, WebP or GIF (type checked from the bytes), at most 5 MB each, 20 per feature and 200 MB per
    project; stored in the database, served with their own content type, `nosniff` and a sandbox CSP; deleted with
    the feature. Details show them with `![name](image:<id>)`.
  - **API**: `/api/projects/<p>/features` (list, create, reorder, get / patch / delete by key or id, `/tasks`,
    `/tasks/reorder`, `/tasks/<id>/toggle`, `/images` raw or data-URL upload); SSE event `features.changed`.
    `@stubyard/client/features` has the same calls. MCP: `list_features`, `get_feature`, `upsert_feature`,
    `delete_feature`, `add_task`, `update_task`, `delete_task`, `add_feature_image`.
  - Project export / import carries the board (images as data URLs; `GET /export?images=0` leaves them out). A
    project reset keeps it, like storyboards; deleting the project removes it.
  - **Migration 28**: tables `features`, `feature_counters`, `feature_tasks`, `feature_images`.
- **Chrome extension 0.5.1: filter the storyboard list** on the side panel's Home. A search box (title, slug,
  description and tags; case-insensitive, every word must match, instant) and a row of tag chips built from the
  project's tags, each with the number of shown storyboards that have it; selecting several tags shows storyboards
  with **all of** them. Each row shows up to 3 of its tags (+N); clicking one adds it to the filter. The header shows
  "x of y" while filtering, **Clear** resets it, and "No storyboards match" offers **Clear filters**. `/` focuses the
  search, Esc clears the text and then the tags. The filter is remembered per hub and project for the browser
  session (`chrome.storage.session`). No hub change: the storyboard list already carries the tags.
- **Teams mode** (sign-in for several people), off by default. `STUBYARD_DATABASE_URL=postgres://…` turns it on and
  needs the instance admin (`STUBYARD_ADMIN_EMAIL` + password) too. Without it, Open and Single admin mode work as
  before.
  - Postgres (its own container, pinned `pg` 8.23.1 driver) holds identity and access data only: users, project
    members, sessions, API tokens, invites and the audit log, in the schema `stubyard` with its own migrations. Project
    data stays in SQLite.
  - The env admin is bootstrapped as instance admin and always signs in with the env password. When
    `STUBYARD_ADMIN_EMAIL` changes, the previous one becomes a member and loses its sessions and tokens (audited).
  - **Users** (Team page, `/api/team/users`, instance admins): create with a temporary password (must be changed at
    the first sign-in), disable (sessions end and tokens are revoked at once), reset password (sessions end and API tokens are revoked), set the instance role.
    **Invite links** (`/invite#…`): single use, 7 days, only a hash is stored; the person sets their own password.
    Everyone can change their own password (`POST /api/auth/password`).
  - **Project members** (Project → Members, `/api/projects/:slug/members`) with 7 roles: instance admin, project
    admin, project manager, developer, designer, QA, viewer. Memberships follow project deletes and the factory reset.
  - The T1 permission table is enforced per project: project lists, `/api/logs`, messages, the event stream (filtered
    and closed when access goes), `/mcp` (tools list and every call), exports, lint and storyboard matching.
    Non-members get 404 as for a missing project, members without the permission 403. The MCP tools list shows only
    the tools the caller's roles can use in at least one project (composite tools included); Open and Single admin
    mode list every tool.
  - `/mailpit` is instance-admin only; members read mail through `/api/messages/:id/mail/{html,text,raw,detail}` and
    `…/mail/part/:part`, all sandboxed by CSP with `nosniff` (the HTML view may load remote images, sent with no Referer); raw is plain text and attachments download unless they are
    PNG, JPEG, GIF or WebP images.
  - stubyard's own in-process calls carry the acting user: MCP tools, schedules (run with the creator's current
    permissions; new column `schedules.created_by`, migration 30), AI chat tools (viewer in the chat's project) and
    the MCP tester's "this server" credential (developer in its project).
  - **API tokens** belong to a user and carry their roles; they can be narrowed to some projects and a highest role.
  - Audit rows for sign-ins (also failed), user, member, role, token and invite changes, project create / import /
    delete / reset, project and AI provider settings, maintenance and the factory reset.
  - Postgres health in `GET /api/system` (details for instance admins) and in the doctor.
  - Dashboard: Team page, Members page, a forced "choose a new password" step, Change password in the account menu,
    actions the role cannot use are hidden or disabled, assignee suggestions from project members on the features
    board, token narrowing on the API tokens page.
  - `./scripts/test-postgres.sh` runs the Postgres tests against a throwaway container; CI runs them with a postgres
    service.
- **Audit log pages and API** (Teams mode).
  - **System → Audit log** for instance admins: newest first, filters for person, action (single or a group such as
    "Members"), project, from / to dates and free text, active-filter chips, expandable rows with the details
    (changed setting names, roles, client address, via session / token), **Load older entries** and **Export CSV**.
    A stacked list on phones. In Open and Single admin mode the page explains that it needs Teams mode.
  - **Project → Settings → Audit log** for project admins: their project's entries since it was created (not those
    of an earlier project with the same slug), without client addresses.
  - API: `GET /api/audit` and `GET /api/projects/:slug/audit` with `user`, `project`, `action` (`member.*` for a
    group), `from`, `to`, `q`, `limit` and `before` (cursor, `nextBefore` in the answer); `format=csv` (at most
    50,000 rows, cells starting with `=`, `+`, `-`, `@` are quoted against spreadsheet formulas);
    `/actions` lists the actions present. 404 outside Teams mode.
  - `STUBYARD_AUDIT_RETENTION_DAYS` (default 365, `0` keeps everything): the automatic clean-up removes older
    entries and reports how many (`auditPurged`); System → Maintenance shows the setting.
  - New audit rows: `project.export` (with `detail.secrets`); `project.settings` and `system.ai_providers` record
    the names of the changed fields (never values); `project.import` records the mode; `project.create` without a
    slug in the body now records the slug stubyard chose.
- **Server compose file**: `deploy/docker-compose.server.yml` runs stubyard with `postgres:17-alpine` (own volume, not
  published, health-checked; stubyard starts once it is healthy) from a `.env` file; every variable is explained in
  `deploy/server.env.example`. Ports are bound to `0.0.0.0` on purpose (`STUBYARD_WEB_BIND=127.0.0.1` behind a
  reverse proxy). The local compose files are unchanged and stay the default.
- **docs/DEPLOY-SERVER.md**: host name, HTTPS (stubyard's CA or Caddy with `STUBYARD_TRUST_PROXY`), firewall, the
  admin password hash, first sign-in and adding people, backup and restore (with a test restore), upgrading from
  0.15.0, and moving from Single admin to Teams.
- **Storyboards: an email step can look back to an earlier step** with `since: "<stepId>"`. Its message window then
  starts where that step started, so a second mail sent by the same action as the first (a payment receipt and a
  confirmation) is still found. The id must name an earlier step (validation code `invalid_since`). The dashboard
  editor has a **Since step** field.
- **Storyboards: `{{vars.x}}` in selectors.** `target.selector`, `target.text`, a capture's `selector`,
  `assert.selector` and `assert.urlMatches` are rendered at resolve and checked by validation like other templates
  (`unknown_variable`, `var_not_captured`, `var_used_before_capture`). The resolved step has `target`
  (`{selector, text}` or null); the extension highlights that.
- **Moyasar invoice decline: Try again and Back to the merchant.** A declined card keeps the invoice page open with
  the error, **Try again** (the form stays) and **Back to the merchant**: `back_url` (else `success_url`) with
  `id`, `status=failed` and `message`, like Moyasar's own invoice page. As on Moyasar, each try is its own payment:
  a new payment id per try, webhooks carry that try's id, the invoice stays `initiated` after a decline and
  `GET /v1/invoices/:id` lists the declined tries in `payments[]` (also `GET /v1/payments/:id` and the payment list).
  Payments created with a card source stay final after a decline. **Back to the merchant** before any try cancels the
  invoice (its status becomes `canceled`).
- **The payment page preselects the test user** of the active walkthrough: the current step's actor of the
  walkthrough named in `metadata.stubyard_walkthrough`, else the one whose origin matches the payment's return URL,
  else, for a payment without URLs, the only active walkthrough. When several walkthroughs match, the most recently
  started one wins. Otherwise nothing is preselected. A user picked by hand is kept.
- **CA trust check**: the dashboard's HTTPS page checks whether this browser trusts the stubyard CA (a no-cors request)
  and shows what to do when it does not, with **Check again**, and says which address it checked: `STUBYARD_PUBLIC_URL`
  when it is https, else the HTTPS port when the page uses stubyard's own HTTP port, else (behind a port mapping such
  as 34000→4000) a guess with the same offset (34443) in a field you can change, remembered in this browser. The
  payments page shows a small banner when the CA is not trusted. `GET /api/https-guide` (signed in) has `publicUrl`.
- **Missing default password warning**: when a storyboard has fresh actors and the project has no default password,
  the extension's Start screen (`Password123!` would be used) and the dashboard's storyboard pages show a warning
  with a link to the project settings. Validation now always gives the `no_password` warning for fresh actors then.
- **Browser extension 0.6.1**: the resolved target for highlights, and the default password warning on Start.

### Fixed
- mada test cards that start with 4201 32 (Moyasar's `4201320111111010`) showed "visa" on the hosted pages. The
  card hint now uses the matching test card's own brand first, and 420132 is a mada BIN. The card hint line keeps its
  height, so the Pay button no longer moves while you type.
- The cross-site guard now also checks percent-encoded API paths (`/%61pi/projects` reached `/api/projects`
  unguarded).

## 0.15.0 — 2026-11-23

### Added
- **Walkthrough recording**: the Chrome extension can record a walkthrough so a reviewer can watch on the dashboard
  what the tester did. Turn it on per storyboard with `record` (`off` default, `dom` or `video`; storyboard editor
  **Record**) or per run (the extension's Start screen **Recording** select, `POST /walkthroughs {record?,
  maskAllInputs?}`, the client's `startWalkthrough`). Without an override, tracked runs follow the storyboard and
  quick tests are not recorded. Only the run's app pages are recorded (the run's origin and the project's app origins,
  top frame); the side panel and the on-page widget never are. A red dot with **Pause** / **Resume** shows in the side
  panel, the widget card and on the collapsed pill.
  - **Page recording** (`record: "dom"`, rrweb): DOM changes, mouse moves, clicks, scrolling and typing, one segment
    per page load (and per resume), with step markers. Typically under 10 KB per minute stored on simple pages; a page
    with a large DOM costs more at every load. Canvas drawings, video, cross-origin iframes and styles CSS-in-JS
    libraries add after load may be missing in the replay.
  - **Video mode** (`record: "video"`): a WebM video of the tab (VP9, else VP8; at most 1280 px wide, 8 fps, 500 kbps,
    no audio). Starting the run from the side panel starts the video; otherwise **Record video** in the run bar or the
    widget card, or **Alt+Shift+V**. It goes on across page loads, pauses while the tab shows a page outside the run,
    follows Pause / Resume and ends with the run or the tab. The step widget folds to its pill while it records.
    About 1 MB per minute on ordinary pages (2.4 MB on a page that animates all the time).
  - **Privacy**: in page recordings every input value is masked unless the storyboard lists the field in
    `recordPrivacy.unmaskSelectors`; fields that look like passwords (also after a show-password toggle), one-time
    codes, card numbers, IBANs or keys, the run's login and 2FA selectors, and fields the extension filled with a
    secret stay masked even then. Hidden inputs are left out; contenteditable text, `recordPrivacy.maskTextSelectors`
    and page text shaped like a secret (JWTs, provider keys, TOTP seeds and otpauth URLs, Luhn-valid card numbers,
    long hex, "key: value" labels) are starred; `recordPrivacy.blockSelectors` leaves areas out.
    `recordMaskAllInputs` (editor: "Mask all inputs and page text") masks every input and all page text. Query values,
    fragments and token-like path segments of recorded URLs become `*`. In a video, sensitive-looking fields show
    dots on screen, also while typed by hand; other fields and all page text are visible, and the run warns at start.
    Masking works by rules, not by knowing the app: watch one recording of a new app before sharing recordings of it.
  - **Replay** runs in a hub page (`…/recording/player`, sandboxed iframe) whose Content-Security-Policy runs no
    script and loads images, styles and fonts only from the run's app origins.
  - **Dashboard**: a **Recording** tab in the walkthrough drawer: segment list, player with a timeline of step markers,
    jump to a step, 1x / 2x / 4x, skip inactivity, Video and Page (DOM) tabs when a run has both, size against the
    cap, Pause / Resume / Record the rest while the run is active, and **Delete recording**.
  - **API**: `GET / PATCH / DELETE /api/projects/<p>/walkthroughs/<id>/recording` (list; `{paused?, mode?,
    maskAllInputs?}`; delete), `POST …/recording/chunks` (from the extension), `GET …/recording/segments/<no>` (DOM:
    NDJSON rrweb events, gzip when accepted; video: `video/webm` with Range requests), `GET …/recording/player`;
    `recording` on walkthrough views. Storyboard fields `record`, `recordMaskAllInputs`, `recordPrivacy`. MCP:
    `list_walkthrough_recordings`, `delete_walkthrough_recording`.
  - **Limits**: project setting `recordingMaxMb` (per walkthrough, default 50 MB stored; recording stops there with
    the reason on the run), plus 1000 segments per run, 32 MB uncompressed per segment and 10 × `recordingMaxMb`
    uncompressed per walkthrough; a page whose snapshot is over 7 MB is skipped with a note. Recordings are removed
    `recordingRetentionDays` after they end (default 14; 0 keeps them). They are stored in the database and are not
    part of bundle or project export.
  - **Migration 27**: `storyboards.record`, `storyboards.record_mask_all`, `storyboards.record_privacy`,
    `walkthroughs.record`, `walkthroughs.recording`, tables `walkthrough_recordings` and
    `walkthrough_recording_chunks`.
- **Chrome extension 0.5.0**: walkthrough recording (above). New permissions `tabCapture` and `offscreen` for video
  mode: Chrome asks to accept them (or disables the extension until you do) when you reload the updated unpacked
  extension. New shortcut **Alt+Shift+V** (record this tab as video). New dependencies, pinned and MIT: `@rrweb/record`
  2.2.2 (extension) and `rrweb-player` 2.2.2 (dashboard, loaded on first use).

### Known limits of recording
- Outside strict mode, page text is masked only when it matches a known secret shape.
- Link and image URLs inside the recorded DOM (`href` / `src` of the page's own elements) are not redacted; only the
  page URL is.
- A video masks nothing but sensitive-looking fields: other inputs and all page text are visible.
- A show-password toggle inside a shadow root or a same-origin iframe is not remembered (the password field itself is
  masked by its type).

## 0.14.0 — 2026-11-23

### Added
- **Storyboards**: manual test walkthroughs of business flows, stored per project. A storyboard has actors (existing
  test users by role, or fresh users created per walkthrough), inputs and ordered steps of 8 kinds: `open`, `login`,
  `logout`, `fill`, `email`, `instruction`, `capture`, `check`. Template variables (`{{user.email}}`, `{{unique}}`,
  `{{vars.x}}`, deterministic `{{fake.*}}`, `{{date.+7d}}`, …) are rendered by the server. Every write is validated
  with all issues listed by path and code (migration 24).
- **Login recipes** per role (login URL, field selectors, TOTP / email / SMS 2FA), **data sets** for form filling
  (entries matched by id, name, data-testid, label or placeholder; native and Radix widgets), **page snapshots** of
  scanned form fields, and **bundle import/export** (`stubyard-storyboards` v1 JSON, dry run, secrets masked).
- **Walkthroughs**: one person's run through a storyboard, with step status, notes, captured values, screenshots
  (stored in the database, capped), sign-off with a verdict, and a JSON / printable HTML summary.
- **Quick test runs**: any storyboard can run as a quick test (`POST /walkthroughs {mode: "quick"}`; default
  `tracked`). Same steps and automation (login, fill, email links, captured vars, fresh users), but no screenshots
  (409), no sign-off needed to finish, left out of `GET /walkthroughs` (unless `mode=quick` or `mode=all`) and of the
  storyboard's last walkthrough. Views and briefs carry `mode` (migration 25).
- **Test-data cleanup** (never automatic): a Clean up button in the side panel and on the dashboard's Storyboards page
  removes the fresh users a walkthrough created and their messages. Tracked runs keep their record and evidence; quick
  runs are removed once cleaned. Stubyard records which runs reuse another run's users (or declare it with `uses`) and
  warns before removing data another run still needs (Clean both / Keep those users). A **Keep** pin on a test user
  makes it a shared fixture that cleanup never deletes. Captured values are listed as "values in your app" and are not
  touched. API: `GET/POST /api/projects/<p>/cleanup` (with `dryRun`), `GET /walkthroughs/<id>/cleanup`,
  `…/cleanup/dismiss`, `…/cleanup/reopen`, `keep` on users; `cleanupStatus` / `cleanupAt` on walkthroughs;
  `DELETE /walkthroughs/<id>?users=1` follows the same rules (migration 26). Deleting a run that still has test data
  answers 409 unless `?users=1` or `?force=1` (and with `users=1`, 409 listing users other runs still need, unless
  `force=1`); a cleaned run cannot be reopened (409, start a new run). A quick run's record stays (cleaned, hidden)
  while a Keep-pinned user of it remains; un-pinning puts the run back to pending. Runs with nothing left to remove
  settle to cleaned by themselves, and older runs get their dependencies at startup.
- **`preferredMode`** on storyboards (`tracked` or `quick`): which start button the extension shows first. Editable
  in the dashboard editor, part of bundles, project export, the storyboard list and `upsert_storyboard`;
  `list_walkthroughs` takes `mode` (migration 25).
- **Chrome extension** 0.4.1 (`packages/extension`, load unpacked; host permission `<all_urls>`, which step
  screenshots need): a side panel that finds the project by the page
  origin, logs in as test users and fills the 2FA code, fills forms (Alt+Shift+F), waits for emails and opens their
  links, captures values, checks pages, takes screenshots and signs off. A Page data view scans a page into a data
  set or a snapshot. 0.2.0 adds **Quick test** runs: the same automation with no step verdicts, notes, screenshots
  or sign-off. 0.3.0 adds the Cleanup screen and "Clean up this run" after a run. 0.4.0 adds the on-page step
  widget (below). 0.4.1 has the new stubyard icons.
- **MCP authoring tools** (27): `describe_storyboards` (the ontology: objects, relations, build order, JSON Schemas,
  variables, validation codes), `storyboard_guide` (recipes by topic), and tools to set app origins, test users,
  login recipes, data sets, page snapshots, storyboards and bundles, plus read-only walkthrough results. Upserts are
  idempotent and report `created`, `updated` or `unchanged`. `docs/examples/classprovia-storyboards.json` is a
  complete example bundle.
- **Dashboard**: a Storyboards page (editor with live validation, data sets, login recipes, page snapshots,
  walkthroughs, import / export) and an **App origins** project setting.
- **@stubyard/client 0.7.0**: browser-safe helpers for users, messages, authenticators, the event stream,
  storyboards and walkthroughs (cleanup helpers and `uses`; `mode` on `startWalkthrough` / `listWalkthroughs`; `finishWalkthrough` without a
  sign-off for quick runs).
- **On-page step widget** (Chrome extension 0.4.0): while a walkthrough is open, the app's own pages (the run's
  origin and the project's app origins, top frame only) show a small card with the current step. The card and the side
  panel are two views of the same walkthrough and stay in sync, also across two tabs of one run.
  - Step actions in the card: Go, Highlight, Fill form, Capture, Run assertion. Tracked runs get Done / Skip / Fail
    with a note, a screenshot and Next; quick runs get Next ✓ and Finish. Sign-off and "Clean up this run" stay in the
    panel.
  - Login, 2FA and email in the card: the user, username and password with copy buttons and Fill login; after you
    click Log in, the card on the next page waits for the code field and fills the authenticator or email / SMS code.
    The wait is kept in the walkthrough's step data, so the panel and the card never both wait or fill ("Waiting for
    the 2FA code in the page widget", with Wait here instead). Wait for message runs in the card, also while it is
    collapsed; it lists up to 5 links of the message. Copy buttons fall back to selecting the text when the page
    blocks the clipboard.
  - Moving it: drag the bar to any corner (also with the arrow keys; double-click or Home puts it back); the place is
    remembered per site. Esc or the new **Alt+Shift+W** folds it into a round button with a progress ring.
    **Alt+Shift+F** fills in the card first, else in the panel. Under 480 px it is a bottom sheet. It steps aside when
    it would cover the highlighted element or the page's Submit button, and stops doing that once you move it.
  - It works above native modal `<dialog>`s, at 200% zoom, in light and dark and on right-to-left pages; screen
    readers hear step changes and waits; reduced motion is respected. When stubyard is unreachable it says so, counts
    down and recovers by itself (Retry now).
  - Turning it off: × hides it on a tab ("Show on this tab" in the panel brings it back while the tab stays on that
    site); Settings → On-page step widget turns it off everywhere, hides it on chosen sites and resets its position.
  - Screenshots leave the widget out.
  - Security: the card is an extension frame in a closed shadow root; a page cannot reach into it, restyle it or reuse
    its single-use token. While the page hides or covers the card its buttons do nothing ("Widget hidden by the page —
    use the panel"). Login, form and 2FA fills stay on the run's app origins; the panel asks before filling anywhere
    else. After an extension reload or update the old card removes itself (content-script contract 0.6.0).
- **Realistic payment pages**: every hosted page of the 14 gateways now comes in two views per payment provider.
  - **Realistic** follows the provider's own flow and screens in stubyard's neutral look (no logos, brand colours or
    fonts): Stripe Checkout (order summary, card form, 3-D Secure in a modal), Checkout.com (HPP and full-page ACS),
    PayTabs (including framed mode), Amazon Payment Services, Tap and MyFatoorah (method selection, simulated KNET /
    BENEFIT bank pages), Moyasar invoices, PayPal (log in → review → approve), Geidea (3-D Secure modal), HyperPay,
    Tabby (phone, SMS code, plan, card), Tamara (phone, code, terms, plan, card), JazzCash (Mobile Account with MPIN and
    OTP, card, voucher) and Easypaisa (Mobile Account, OTC voucher, card). Test shortcuts sit in a "Test controls"
    drawer; Pay, Decline and Cancel stay on the page. **Classic** is the earlier page with every test button in view.
  - New instances start realistic; existing and imported instances stay classic until switched under **Payments →
    Checkout pages** (one click per provider, with a fidelity table and a **Demo shop** link). Instance settings
    `experience`, `pageLocale` (English or Arabic, right to left), `pageTimings`, `pageDrawer`; per-payment URL
    overrides `?ui=`, `?stubyard_lang=`, `?stubyard_drawer=`.
  - Every page, popup, frame and SDK component shows "TEST · stubyard simulator · not a real payment, no money moves"
    and a `[TEST]` title. A hidden or cropped notice adds the lint `pay.test-notice-hidden`; it never blocks a payment.
  - Return URLs, return parameters and webhooks are the same in both views, and the classic `/complete` call keeps
    working on every payment.
  - `GET /api/payment-presets` lists each integration mode with its status and separate `api` / `screens` fidelity
    tags.
- **Fake payment SDKs** with the providers' real global, function and callback names, each with a demo shop at
  `<instance>/demo` (`?lang=ar`):
  - Moyasar Form (`Moyasar.init` with card + 3-D Secure, STC Pay OTP and a simulated Apple Pay sheet), GeideaCheckout
    (popup or drop-in, exactly one callback), PayPal Buttons (Pay Later with an offers screen), Card Fields and
    Messages.
  - Stripe: **PaymentIntents** (create / list / retrieve / update / confirm / capture / cancel, test PaymentMethods
    such as `pm_card_visa`, `next_action` for 3-D Secure, `payment_intent.*` and `charge.*` webhooks, publishable-key
    retrieve and confirm), **Embedded Checkout** sessions (`ui_mode=embedded_page`), and a fake **Stripe.js v3** at
    `<instance>/js.stripe.com/v3/` (Payment, Card, Address and Link Authentication Elements, `confirmPayment`,
    `confirmCardPayment`, `initEmbeddedCheckout`, 3-D Secure modal).
  - Checkout.com Flow (`CheckoutWebComponents`, `POST /payment-sessions`), Tap Card SDK v2 (`CardSDK.renderTapCard`),
    MyFatoorah `session.js` (`POST /v2/InitiateSession`), PayTabs managed form (`paylib.js`, `payment_token`) and the
    APS Merchant Page (`service_command=TOKENIZATION` in an iframe, then `paymentApi` with the token).
  - Promo widgets: TabbyPromo / TabbyCard, `<tamara-widget>` and `paypal.Messages`.
  - Card digits never reach the merchant page: frames pass card facts only. Messages use exact target origins (never
    `*` or `document.referrer`), checked against the instance's new `sdkOrigins` and the project's app origins. The
    Connect panel lists the script URLs (`STRIPE_JS_URL`, `CKO_WEB_COMPONENTS_URL`, `TAP_CARD_SDK_URL`,
    `MF_SESSION_JS_URL`, `PAYTABS_PAYLIB_URL`, `MOYASAR_FORM_JS`, `GEIDEA_CHECKOUT_JS`, `TABBY_PROMO_JS`,
    `TAMARA_WIDGET_JS`, …).
  - New lint checks: `pay.hpp-framed`, `pay.sdk-origin-unlisted`, `pay.sdk-origin-refused`,
    `pay.geidea-sdk-session`, `pay.stripe-raw-card-data`, `pay.test-notice-hidden`.
- **Sample data** (`samples/`): four seed projects (Brightpath consumer app, Ledgerline B2B SaaS, Souk Market shop,
  a near-empty Sandbox) that fill every dashboard page, and `samples/populate.mjs`, which sends traffic through
  stubyard's real endpoints (codes, duplicates, failed deliveries, replies, pushes, payments). `STUBYARD_DEV_SEED=1
  ./scripts/dev.sh` imports the seed at start; see `samples/README.md`.
- `scripts/dev.sh`: `STUBYARD_DEV_BIND=0.0.0.0` opens the dev ports to the network (default `127.0.0.1`), and
  `STUBYARD_PUBLIC_URL` is passed through so login and payment pages redirect to that address.

### Changed
- **Dashboard redesign ("Canvas").** The layout is new; every old URL still works.
  - **Navigation.** There is no sidebar. A 56 px top bar holds the brand, a project pill (switcher), five group tabs
    (Inbox, Simulate, Automate, Tools, Project), search, status, notifications, theme and the workspace menu. Under
    it, a sub-nav shows the pages of the current group as pills; in Inbox it also has a "Switch user" drop-down (with
    a filter) and up to six pinned users. On phones the group tabs become a bottom tab bar, and the menu button opens
    the full page list as a sheet.
  - **Ctrl/⌘+K palette** (also `/`). It finds pages, tabs, users and their latest codes, provider instances,
    projects and request ids, and runs actions (new user, generate users, new provider, mock, storyboard or webhook
    endpoint, theme, density).
  - **Shortcuts.** `?` lists them. `g` then o / u / t / p / y / s / , jumps to Overview, Users, Traffic log,
    Providers, Payments, Storyboards or Settings. 1–9 open pinned users.
  - **Look.** Neutral grey-green surfaces with a teal accent, in dark (the default) and light. Rounded cards, pill
    tabs and badges, and stat tiles. The default density is comfortable; Compact is in the workspace menu. All text
    meets AA contrast. New logo and favicon (a teal tile with code braces and a spark), also used by the
    server-rendered pages (hosted checkout pages, the `/favicon.ico` fallback) and the extension icons.
  - **Tabs in the URL.** Tabs now live in `?tab=` and turn into a select on phones.
    - **Settings** is split into General, Data, Checks & time and Danger zone.
    - **System** is split into Overview, AI providers, Maintenance and Danger zone.
    - **Storyboards** has 4 tabs (Storyboards, Walkthroughs, Library, Cleanup). Library holds data sets, login recipes
      and page snapshots, and Import / export is a header button.
    - **Payments** has a **Gateways** tab (the payment provider instances).
    - **Webhooks** has Receive / Send tabs.
  - **Page layouts.**
    - **Projects** is a card grid, with a "New project" tile.
    - **Project home** has latest-code cards for pinned users and a users table, with stat tiles, recent activity
      (repeats fold to "×n") and the setup status beside them. There is a new **Users** page at
      `/p/<project>/users`.
    - **User workspace** shows Messages, Scenario rules and Push as tabs (`?view=rules|push`), with the reply bar under
      the timeline.
    - **Traffic log** has a summary (requests, errors, median time), folds repeated requests ("× n") and puts the
      filters behind a Filters button.
    - **Payments** filters by status with stat tiles. **Checkout pages** is an accordion, with a Demo shop link per
      gateway.
    - **Storyboards** is a card grid with a Cards / List toggle.
  - **Accessibility.** Dialogs and drawers trap and restore focus, menus opened from the keyboard focus their first
    item, and a "Skip to content" link comes first.
- The API guard accepts write calls from `chrome-extension://` origins (`STUBYARD_EXTENSION_ORIGINS`, default
  `chrome-extension://*`; empty turns it off). Web pages are still refused.
- `GET /users/:id/latest` also returns `links` (every link of the message).
- Project settings take `appOrigins`. Project export / import covers login recipes, data sets and storyboards
  (walkthroughs and snapshots are not exported). Project reset deletes walkthroughs and page snapshots; retention
  purges finished and abandoned walkthroughs and old snapshots, but never a run whose test data is still to clean up.
- Payment pages: a retryable decline, a wrong OTP code and a form validation error (PayPal login, Tabby phone /
  card, Tamara terms) answer 200 with the message on the page instead of 402 / 400. After a decline the card form
  keeps what was typed except the CVC. The 3-D Secure modal's × cancels the authentication and keeps the payment open.
  The classic page and its done page follow the payment's language (Arabic, right to left). MyFatoorah and Geidea
  accept their documented sandbox cards (mada included) without the real-card warning. On the realistic OTP screens,
  three wrong codes decline the payment (`otp_failed`).

## 0.13.0 — 2026-11-20

### Added
- **AI personas**: test users whose replies an LLM writes, attached through auto-reply rules. A persona has a
  prompt, goals it closes with control lines, thread memory and limits on replies, tokens and daily model calls.
  Works with real providers or the keyless `mock:openai` / `mock:anthropic` (migration 23).
- **10 more payment gateways** (14 in total): Moyasar, Tap, Tabby, Tamara, Checkout.com, Amazon Payment Services,
  MyFatoorah, Geidea, JazzCash and Easypaisa, with hosted pages (KNET, Benefit, mada, buy-now-pay-later, wallets with
  OTP), their APIs, refunds and webhooks signed in each provider's format.
- **PayPal subscriptions and disputes**: Catalog Products, Billing Plans and Subscriptions v1 with scheduled billing
  on a per-subscription clock (`advance` to bill months in a second); Disputes v1 with buyer and merchant actions.

### Security
- Webhook secrets masked in responses and exported as secrets; limit on billing `advance`; caps on tokens and
  registries; constant-time signature checks; regex guard for saved-prompt expectations.

### Fixed
- Certificate serial encoding that made about 1 in 256 freshly generated CAs or leaf certificates unreadable by
  OpenSSL 3. Bad certificates are now detected and regenerated at start, and certificate files are written atomically.
- UI: OTP phone display, favicon, provider badge counts, active tab scrolling on phones.

## 0.12.0 — 2026-11-20

### Added
- **Scripted auto-replies**: rules make test users answer delivered email, SMS and WhatsApp messages (regex captures,
  OTP echo, delays through the scheduler, max uses, loop guards, run scoping, a "Try it" dry run) (migration 20).
- **AI chat extras**: model matrix (one prompt, 2–6 models), save a tool call as an MCP tester saved call or an LLM
  mock, "Explain this", keyless `mock:openai` / `mock:anthropic` providers (migration 21).
- **Push notifications**: fake FCM HTTP v1 (service-account OAuth, topics, conditions, Instance ID) and an APNs
  HTTP/2 listener on port **2197** (ES256 provider tokens, documented reason codes); devices on test users, push
  inbox, faults, wait API; `@stubyard/client/push` (client 0.6.0) (migration 22).

### Changed
- Retention also covers auto-reply fires and the push inbox. Port 2197 is exposed in the Dockerfile and compose files.

### Security
- Regex safety checks with a match time limit, prompt-injection isolation and broader redaction for "Explain this",
  APNs listener limits, matrix concurrency caps, FCM token store cap.

## 0.11.0 — 2026-11-20

First release under the name **stubyard**.

### Added
- **LLM API mocks**: fake OpenAI (chat completions, responses, embeddings) and Anthropic (messages) APIs with scripted
  replies and tool calls, faults, a call log, and record-to-mock with auto-stop limits (migrations 17, 19).
- **Payments 1b**: HyperPay COPYandPAY (mada, back office, encrypted webhooks), PayPal JS SDK Buttons and Card Fields,
  card + 3-D Secure, authorize / capture / void / reauthorize, Vault v3 (migration 18).
- Follow-ups: file storage section on the Runs page, traffic-log kind chips, attachments in email replies, Azure
  SharedKey verification, content-check re-run after settings change, MCP tester TLS and protocol 2025-11-25, clock
  offsets for login providers and API mocks, report tile grid.

### Changed
- Renamed from devhub to stubyard: `STUBYARD_*` environment variables (`DEVHUB_*` still honoured), `@stubyard/*`
  packages, image `ghcr.io/imibrar/stubyard`. Old storage keys, export files, the login cookie and chat tool names
  are still accepted. MIT license, new README, CI and multi-arch release workflows.

### Security
- Cross-site requests refused while a recording is on; credential headers redacted on `/llm` and `/pay`;
  SDK-scoped PayPal tokens; full-length GCM tags; guards against hijacked streams.

### Fixed
- PayPal traffic rows logged as 404, HyperPay demo host, responsive traffic log and Providers tabs.

## 0.10.0 — 2026-11-20 (devhub)

### Added
- **AI chat** (migration 15): global AI providers with write-only keys (environment keys preferred, egress pinned to
  the provider host, no redirects), project agents with MCP-tester tools and allowlisted read-only tools, streamed
  conversations, saved prompts with deterministic expectations, MCP tools.
- **Payments 1a** (migration 16): payment engine with outcome precedence, hosted outcome page, fake Stripe Checkout,
  PayTabs and PayPal Standard APIs, signed webhooks through the scheduler with retries, payment rules, integration
  checks, mada / STC Pay OTP / Apple Pay, Payments page, MCP tools.

### Security
- Credential and card-field redaction in `/pay` traffic, return-URL validation, CSP on hosted pages, stored key
  cleared when a provider's host changes.

## 0.9.0 — 2026-11-20 (devhub)

### Added
- **Scheduled actions** (migration 14): send webhooks, sequences and replies later or on repeat; timed rules and
  mock scenarios; Scheduled page, "Later" buttons, REST and MCP tools.
- **HTML run reports** (`report.html`, download) and **per-feature clock offsets** (totp, auth, verify, webhooks)
  per project or per run, with REST and MCP.
- Client run helpers: `startRun`, `withRun`, `stopRun`, `getRunReport` (client 0.5.0).

### Fixed
- Floating "Later" menu, composer wrapping, runs filter bar, badges.

## Earlier versions (devhub)

- **0.8.0** (2026-11-20): Providers page with Email / SMS / WhatsApp / Login tabs; **MCP tester** (Streamable HTTP and
  legacy SSE, tools / resources / prompts, JSON-RPC log, 20+ checks, saved calls) (migration 13).
- **0.7.0** (2026-11-19): Cloudinary, Google Cloud Storage, Azure Blob and Supabase Storage; **content checks** on
  outbound messages; **webhook security check**.
- **0.6.0** (2026-11-19): Twilio Verify and Vonage Verify; inbound email replies; WhatsApp media, buttons, lists and read
  receipts; **S3 storage** and S3-compatible presets (R2, Spaces, B2, MinIO, Wasabi).
- **0.5.0** (2026-11-19): **test runs** for parallel workers; **login providers** (Google, Microsoft, GitHub, Facebook,
  LinkedIn, Apple, X, Discord, GitLab, Slack, generic OIDC); responsive dashboard.
- **0.4.0** (2026-11-19): hardening: wait cursors and count / none assertions, better OTP extraction, outbound
  allowlist, seeding at start, CI recipe, doctor, agent guide at `/api/agent-guide`, real-SDK conformance tests.
- **0.3.1** (2026-11-19): fixed a SendGrid snippet that sent mail to the real SendGrid; Twilio responses echo the SID.
- **0.3.0** (2026-11-19): webhooks (receive with JSON Schema, send signed templates, sequences, replay); SendGrid,
  Mailgun, SES and generic email APIs; API mocks; retention, resets and export / import.
- **0.2.0** (2026-11-19): foundation (projects, test users, SMTP capture, OTP extraction, TOTP, traffic log, local
  HTTPS CA) plus the user-centric dashboard, SMS / WhatsApp simulators, scenario rules, wait API and the MCP server.

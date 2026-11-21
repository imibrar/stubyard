# Changelog

All notable changes to stubyard. Versions before 0.11.0 were released under the name **devhub**; the rename kept
`DEVHUB_*` environment variables, the `devhub-data` volume and the `devhub` network working.
Each release lists its database migrations, which run automatically at start.

## 0.14.0 — 2026-11-21

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
  storyboard's last walkthrough, and deleted by the maintenance pass 24 h after their last change. Views and briefs
  carry `mode` (migration 25).
- **`preferredMode`** on storyboards (`tracked` or `quick`): which start button the extension shows first. Editable
  in the dashboard editor, part of bundles, project export, the storyboard list and `upsert_storyboard`;
  `list_walkthroughs` takes `mode` (migration 25).
- **Chrome extension** 0.2.0 (`packages/extension`, load unpacked; host permission `<all_urls>`, which step
  screenshots need): a side panel that finds the project by the page
  origin, logs in as test users and fills the 2FA code, fills forms (Alt+Shift+F), waits for emails and opens their
  links, captures values, checks pages, takes screenshots and signs off. A Page data view scans a page into a data
  set or a snapshot. 0.2.0 adds **Quick test** runs: the same automation with no step verdicts, notes, screenshots
  or sign-off.
- **MCP authoring tools** (27): `describe_storyboards` (the ontology: objects, relations, build order, JSON Schemas,
  variables, validation codes), `storyboard_guide` (recipes by topic), and tools to set app origins, test users,
  login recipes, data sets, page snapshots, storyboards and bundles, plus read-only walkthrough results. Upserts are
  idempotent and report `created`, `updated` or `unchanged`. `docs/examples/classprovia-storyboards.json` is a
  complete example bundle.
- **Dashboard**: a Storyboards page (editor with live validation, data sets, login recipes, page snapshots,
  walkthroughs, import / export) and an **App origins** project setting.
- **@stubyard/client 0.7.0**: browser-safe helpers for users, messages, authenticators, the event stream,
  storyboards and walkthroughs (`mode` on `startWalkthrough` / `listWalkthroughs`; `finishWalkthrough` without a
  sign-off for quick runs).

### Changed
- The API guard accepts write calls from `chrome-extension://` origins (`STUBYARD_EXTENSION_ORIGINS`, default
  `chrome-extension://*`; empty turns it off). Web pages are still refused.
- `GET /users/:id/latest` also returns `links` (every link of the message).
- Project settings take `appOrigins`. Project export / import covers login recipes, data sets and storyboards
  (walkthroughs and snapshots are not exported). Project reset deletes walkthroughs and page snapshots; retention
  purges finished and abandoned walkthroughs and old snapshots, and quick test runs after 24 h.

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

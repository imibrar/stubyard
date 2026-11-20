# devhub — Development Plan

Source of truth for scope: [`../developer_testing_hub_concept.md`](../developer_testing_hub_concept.md).
This file tracks **how** and **in what order** we build it.

## Repository layout

```text
.
├─ server/            Node.js + TypeScript backend (Fastify, SQLite, SMTP front)
│  ├─ src/
│  │  ├─ config.ts            env-driven settings (ports, data dir, limits)
│  │  ├─ db/                  SQLite connection + versioned migrations
│  │  ├─ events.ts            in-process event bus → SSE
│  │  ├─ traffic/             "log everything" traffic logger
│  │  ├─ tls/                 local CA + leaf certificates
│  │  ├─ mailpit/             Mailpit child process + API client
│  │  ├─ smtp/                SMTP front (log, tag, rules, relay → Mailpit)
│  │  ├─ messages/            message ingest, test-user matching, OTP extraction
│  │  ├─ rules/               dynamic rule engine (user + instance level)      [phase 2]
│  │  ├─ providers/           provider presets (Twilio, Vonage, Meta, …)       [phase 2+]
│  │  ├─ webhooks/            inbound endpoints, templates, signing, replay   [phase 3]
│  │  ├─ mocks/               rule-based API mocks                            [phase 5]
│  │  └─ http/                Fastify app + route modules
│  └─ test/                   vitest tests
├─ web/               React + TypeScript dashboard (Vite)
├─ docker/            container entrypoint
├─ scripts/           dev helpers (Node runs inside Docker; no host Node needed)
├─ Dockerfile         single production image: Node + embedded Mailpit
└─ docker-compose.yml convenience wrapper around the image
```

## Key technical choices

| Concern | Choice | Why |
|---|---|---|
| HTTP server | Fastify 5 | Fast, hooks make request/response logging easy |
| DB | Node's built-in `node:sqlite` | No native module to compile; single file in `/data` |
| SMTP front | `smtp-server` + `mailparser` | Full control of every SMTP step for logging and rules |
| Relay to Mailpit | `nodemailer` (raw message) | Mailpit stores and renders email |
| Mailpit | Binary copied from `axllent/mailpit` image, spawned by Node | One container, one supervisor (Node) |
| TLS | `node-forge` (local CA + leaf cert) | No external tooling |
| Live updates | Server-Sent Events | Simple, one-way, works through proxies |
| Frontend | React 19 + Vite + React Router | Standard, fast builds |
| Tests | Vitest | Same TS toolchain |

## Phases and milestones

### Phase 1 — Foundation
- [x] Repo scaffold, npm workspaces, TS config, Docker-based dev scripts
- [x] Config, SQLite + migrations
- [x] Projects, test users (CRUD + generate), provider instances (CRUD)
- [x] Traffic logger: every HTTP and SMTP request/response recorded (`X-Hub-Request-Id`)
- [x] Event bus + SSE stream
- [x] Mailpit child process + proxy under `/mailpit/`
- [x] SMTP front: auth username `project[.instance]`, session logging, relay to Mailpit with tags
- [x] Email ingest → message record matched to test user, OTP/link extraction
- [x] Local CA, HTTPS on 4443, CA download endpoint + instructions
- [x] Dashboard: projects, project overview (users, providers), user timeline, Unassigned, Traffic Log
- [x] Dockerfile + compose, image builds and runs end-to-end

### Added in phase 1 — Authenticator (TOTP)
- [x] TOTP engine (RFC 6238 vectors), otpauth:// parsing, keys per project with labels and optional test-user link
- [x] Authenticator tab with live codes and countdown, codes on the user page, code-by-label API

### UI redesign (0.2) — user-centric, developer-style
- [x] App shell: top bar (project switcher, status pills, theme, notifications), sidebar with pinned users (1–9 keys, drag to reorder)
- [x] Project home: pinned user cards with latest code, users table by role, recent activity
- [x] User workspace: credentials + copy login, latest code / link, 2FA, scenario rules, all channels, reply bar
- [x] Command palette (Ctrl/⌘+K), dark/light theme, desktop notifications for new codes
- [x] Roles (any), auto-pinning, test passwords, user references (`user=admin`), one shared SSE connection

### Phase 2 — Messaging + rules
- [x] Rule engine (user + instance levels, durations, fail rate, presets) + API + dashboard controls
- [x] SMS presets: Twilio, Vonage, Generic; WhatsApp presets: Meta Cloud API, Twilio WhatsApp, Generic
- [x] Delivery status callbacks (durable scheduler with retries), inbound replies
- [x] SMTP rule actions: reject/bounce_hard/bounce_soft/defer/blocked/rate_limit/timeout, delayed DSN bounce, complaint
- [x] Wait-for-message API, duplicate-send warning, marketing opt-out
- [x] MCP server at /mcp (tools for AI agents)

### Phase 3 — Webhooks
- [x] Inbound endpoints, JSON Schema validation + inference
- [x] Outbound templates, variables, signing (Stripe, HMAC), sequences, send-as-user
- [x] Replay (edit, re-sign)

### Phase 4 — Email API providers
- [x] SendGrid, Mailgun, Amazon SES, Generic email API presets → Mailpit
- [x] Delivered / bounce / complaint webhooks; connection guides

### Phase 5 — Mocks, cleanup, polish
- [x] Rule-based API mocks with live scenarios
- [x] Reset / clear / auto-reset / retention (7 days, 500 MB) / factory reset
- [x] Export / import project config
- [x] Traffic Log filters, copy-as-cURL, replay; networking docs; test coverage

Known gaps after phase 3–5 (from the agents' reports):
- SES notifications are not SNS-signed (apps must skip SNS signature checks locally); SES v1 query API not implemented
- Real SDKs (@sendgrid/mail, mailgun.js, AWS SDK v3, twilio, @vonage/server-sdk) not yet run against the mocks
- Inbound webhook endpoints have static responses only (no scenario rules yet)
- Replay of captured inbound requests assumes devhub reaches itself on 127.0.0.1

### Phase 5.5 — Hardening (from the independent Fable review, 2026-11-19)
- [x] Host / Origin / JSON-only guard on /api and /mcp (DNS rebinding, cross-site form posts) — `DEVHUB_ALLOWED_HOSTS`
- [x] Concurrent delivery-report callbacks no longer overwrite each other
- [x] Real SDKs verified manually (Sonnet QA, 2026-11-19): twilio 6.3, @vonage/server-sdk 3.31, @sendgrid/mail 8.1, mailgun.js 14.1, AWS SDK v3 SESv2 — all pass; SendGrid snippet order fixed (it sent mail to the real SendGrid)
- [x] Turn those scripts (`.cache/sdk-qa/`) into automated conformance tests in the suite / CI (`server/test/sdk-conformance.e2e.test.ts`, ~5 s, part of `npm test`; `npm run test:sdk -w server`)
- [x] Wait cursor (no stale code after "resend") + negative / count assertions ("no message within N s", "exactly one")
- [x] OTP extraction: avoid years / unrelated numbers, support alphanumeric codes
- [x] Consume email rules on accepted DATA, not at RCPT TO; purge finished jobs periodically; Mailpit storage under the size cap
- [x] Outbound allowlist (no accidental calls to production URLs from imported configs); option to call apps with self-signed HTTPS (`DEVHUB_OUTBOUND_ALLOW`, `DEVHUB_OUTBOUND_INSECURE_TLS`)
- [x] Correct SMS segment maths (GSM-7 160/153, UCS-2 70/67), optional Twilio credential check
- [x] Bind 127.0.0.1 by default everywhere (README `docker run`, config default outside containers), document Linux host-network callbacks (`deploy/docker-compose.host-network.yml`)
- [x] Seed file at boot (`DEVHUB_SEED=/config/devhub.json`), CI recipe (`docs/CI.md`, `deploy/github-actions-example.yml`)
- [ ] Published image (GHCR proposal in `docs/CI.md`; nothing published yet)
- [x] One agent guide (served at `/api/agent-guide`) instead of three drifting copies; `doctor` endpoint/MCP tool that probes callback URLs
- [x] MCP tools for webhooks, mocks, providers and project setup

### Responsive UI pass (requested by the user 2026-11-19, right after phase 5.5)
- [x] Use wide screens well (no narrow fixed-width pages), readable max-width only for long prose
- [x] Code blocks: header bar with title + Copy (no overlap), wrapped long lines
- [x] Tables / cards reflow or scroll inside their card; mobile: off-canvas sidebar, stacked panels, touch-size controls
- [x] Check every page at 390 / 768 / 1280 / 1920 px (screenshots + Claude in Chrome through the tunnel)

### Order (Fable review) — accepted by the user 2026-11-19
1. Phase 5.5 hardening (above)
2. **Run namespaces / isolation** (from phase 9): per-run rules, mock scenarios, messages and waits (`X-Hub-Run`), ephemeral users and
   "mint address" — parallel Playwright workers / several agents currently collide on project-global state
3. **Phase 6 login providers** together with the **helpers / CLI** from phase 10 (`loginAs()`, `waitForCode()`); OIDC pitfalls to design for:
   explicit issuer per instance (browser `localhost:4443` vs backend `devhub:4443`), HTTPS issuers, `login_hint` + `prompt=none` for headless
   tests, persisted RS256 key, lax-by-default redirect checks with "would fail in production" warnings, presets as claim shapes
4. New **6.5**: Twilio Verify / Vonage Verify, inbound email (SendGrid Inbound Parse, Mailgun routes), WhatsApp media / buttons / read receipts
5. **Phase 7 S3** after an architecture change: streaming route (no 25 MB buffered body), `aws-chunked` decoding, presign host valid for
   browser + backend, CORS, XML errors, ETags, ListObjectsV2 paging, Range, CopyObject; drop GCS/Azure/Cloudinary presets
6. New: **content lint** (unrendered `{{placeholders}}`, `undefined`, localhost/prod links, List-Unsubscribe, SMS encoding) and a
   **webhook security suite** (bad signature, stale timestamp, duplicates, out-of-order, oversized → what did the app wrongly accept?)
7. Phase 9 reshaped: test runs + per-feature time offsets (TOTP drift, token `exp`, presign expiry, webhook timestamp skew) instead of a global fake clock
8. Phase 10 trimmed: keep JazzCash / Easypaisa "choose outcome" page; turn proxy mode into record → generate mocks; drop generic Stripe flow
   (stripe-mock exists) and voice OTP
9. Phase 8 push last (firebase-admin is hard to repoint; APNs needs HTTP/2)

### Phase 6 — Login providers (OAuth 2.0 / OpenID Connect)
Approved by the user 2026-11-19.
- [x] OIDC provider per project: discovery, authorize, token, userinfo, JWKS, logout; PKCE; refresh tokens
- [x] Presets: Google, Microsoft (Entra ID), GitHub, Facebook, LinkedIn, Apple, X, Discord, GitLab, Slack, Generic OIDC (auth0/okta/keycloak/cognito flavours)
- [x] "Choose a test user" login screen (instead of a real login page); claims from the test user (email, name, role, picture)
- [x] Scenario rules: access_denied, invalid/expired/reused code, wrong redirect_uri, email not verified, MFA required, slow login
- [x] API / MCP: get a token as a user without the browser (for automated tests)
- [x] `@devhub/client` helper: `loginAs()`, `getTokens()`, `getAuthorizationCode()`
- [ ] Follow-ups: `auth_rules.run_id`; hide other runs' ephemeral users in the picker; Facebook `fb_exchange_token`; Google refresh-only-on-first-consent

### Phase 6.5 — Verify APIs, inbound email, WhatsApp rich messages (0.6)
- [x] Twilio Verify v2 (services, verifications, checks; devhub generates codes; real `twilio` SDK verified)
- [x] Vonage Verify v2 (workflows, check, cancel, next_workflow, summary callbacks; `@vonage/server-sdk` verify2 verified)
- [x] Inbound email: reply as a test user by email → SendGrid Inbound Parse / Mailgun routes / SES / generic JSON
- [x] WhatsApp media (upload + by link), interactive buttons/lists/CTA, reactions, location, contacts; read receipts; button/list replies; optional 24-hour window
- [ ] Gaps: attachments in email replies, inbound media from users, Twilio Verify Events webhooks

### Phase 7 — File storage (S3 + S3-compatible: R2, Spaces, B2, MinIO, Wasabi; Cloudinary, GCS, Azure Blob, Supabase Storage)
Approved by the user 2026-11-19.
- [x] S3 API: buckets, Put/Get/Head/Delete/ListV2 (paging, delimiter), Range, Copy, DeleteObjects, multipart, presigned GET/PUT, POST policy, aws-chunked + trailing checksums, optional SigV4 verify (0.6, real AWS SDK v3 verified)
- [x] Dashboard Storage page / file browser (preview, download, delete, upload); uploads in the traffic log (metadata only)
- [x] Rules: AccessDenied, SlowDown, slow transfers, quota, expired/broken presigned URL, checksum faults; run-scoped
- [x] Presets agreed with the user: Cloudinary, Google Cloud Storage, Azure Blob, Supabase Storage (0.7, real SDKs verified; Firebase Storage → point to Google's emulator)
- [ ] Follow-ups: Azure SharedKey verification, Cloudinary transformations / tags / folders, GCS compose + batch, Supabase RLS, test the GCS Python snippet
- [x] Streaming data-plane route, `aws-chunked` decoding, host-independent presigned URLs, per-bucket CORS, S3-compatible presets (R2, Spaces, B2, MinIO, Wasabi)
- [ ] Storage rows in the traffic log UI and on the Runs page; boto3 conformance run

### Phase 7.5 — Content checks and webhook security check (0.7)
- [x] 20 content checks on outbound email / SMS / WhatsApp (placeholders, leaked `undefined`, broken characters, links, List-Unsubscribe, text part, SMS encoding / segments, WhatsApp template params); per-project switches and production domains
- [x] Message viewer findings, counters, `?lint=` filter, `GET /api/projects/:p/lint`, MCP `lint_report`, run-report section
- [x] Webhook security check per template (baseline, bad / wrong-secret / missing signature, modified body, stale / future timestamp, replay, out-of-order, oversized, malformed JSON, wrong content-type); API + MCP `webhook_security_check`
- [ ] Follow-ups: re-check existing messages after settings change; lint section on the Runs page summary

### Phase 7.6 — Providers tabs and MCP tester (0.8)
- [x] Providers page: tabs Email / SMS / WhatsApp / Login (data-driven registry), list + detail, deep links from Connect, doctor, palette
- [x] MCP tester / inspector: Streamable HTTP + legacy SSE, tools / resources / prompts, schema forms, JSON-RPC log, 20+ checks, saved calls + run all, API + MCP tools
- [ ] Next (agreed 2026-11-20, see .cache/specs/roadmap-after-0.7.md): scheduling, HTML run reports + time offsets, AI chat, payments (HyperPay, PayTabs, Stripe Checkout, PayPal), LLM API mocks

### Phase 8 — Push notifications
- [ ] FCM (HTTP v1) and APNs simulators; device tokens on test users; push as a 4th channel in the user timeline
- [ ] Rules: invalid / expired token (UNREGISTERED, BadDeviceToken), quota, delays

### Phase 9 — Test runs and fake clock
- [x] Test runs (0.5): per-run rules, mock scenarios, messages, waits, minted users, `/run/<key>` URLs, SMTP `project+run`, JSON report
- [ ] Run helpers in `@devhub/client` (`startRun`, `mintUser`), HTML run report
- [ ] Per-feature time offsets instead of a global fake clock: TOTP drift, token `exp`, presign expiry, webhook timestamp skew

### Phase 10 — Payments, proxy mode, test helpers
- [ ] Payment-gateway flows (Stripe-style, JazzCash, Easypaisa) built on webhooks: pending → success / failed / refunded
- [ ] Proxy mode: devhub in front of a real external API, recording everything and injecting failures
- [ ] Playwright / Cypress helpers (`await devhub.waitForCode('admin')`) and a small CLI
- [ ] Voice-call OTP (call shown in the timeline with the spoken code)

## Dev workflow

Node is **not** required on the host. All commands run in the `node:24` container:

```bash
./scripts/npm.sh install            # install deps
./scripts/npm.sh test               # run tests
./scripts/dev.sh                    # run server + web in watch mode (ports 4000/4443/1025/5173)
docker compose up --build           # build and run the production image
```

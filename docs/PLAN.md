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
- [ ] Real SDK conformance tests (twilio, @vonage/server-sdk, @sendgrid/mail, mailgun.js, AWS SDK v3) in the test suite / CI
- [ ] Wait cursor (no stale code after "resend") + negative / count assertions ("no message within N s", "exactly one")
- [ ] OTP extraction: avoid years / unrelated numbers, support alphanumeric codes
- [ ] Consume email rules on accepted DATA, not at RCPT TO; purge finished jobs periodically; Mailpit storage under the size cap
- [ ] Outbound allowlist (no accidental calls to production URLs from imported configs); option to call apps with self-signed HTTPS
- [ ] Correct SMS segment maths (GSM-7 160/153, UCS-2 70/67), optional Twilio credential check
- [ ] Bind 127.0.0.1 by default everywhere (README `docker run`, config default), document Linux host-network callbacks
- [ ] Seed file at boot (`DEVHUB_SEED=/config/devhub.json`), published image, CI recipe (GitHub Actions service)
- [ ] One agent guide (served at `/api/agent-guide`) instead of three drifting copies; `doctor` endpoint/MCP tool that probes callback URLs
- [ ] MCP tools for webhooks, mocks, providers and project setup

### Proposed re-ordering (Fable review) — awaiting the user's decision
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
- [ ] OIDC provider per project: discovery, authorize, token, userinfo, JWKS, logout; PKCE; refresh tokens
- [ ] Presets: Google, Microsoft (Entra ID), GitHub (OAuth2, non-OIDC), Apple, Generic OIDC
- [ ] "Choose a test user" login screen (instead of a real login page); claims from the test user (email, name, role, picture)
- [ ] Scenario rules: access_denied, invalid/expired/reused code, wrong redirect_uri, email not verified, MFA required, slow login
- [ ] API / MCP: get a token as a user without the browser (for automated tests)

### Phase 7 — File storage (S3-compatible)
Approved by the user 2026-11-19.
- [ ] S3 API subset: buckets per project, Put/Get/Head/Delete/List objects, multipart upload, presigned URLs (SigV4 accepted)
- [ ] Dashboard file browser (preview, download, delete), uploads in the traffic log
- [ ] Rules: AccessDenied (403), SlowDown (503), slow upload, quota exceeded, broken presigned URL
- [ ] Later presets: Google Cloud Storage, Azure Blob, Cloudinary

### Phase 8 — Push notifications
- [ ] FCM (HTTP v1) and APNs simulators; device tokens on test users; push as a 4th channel in the user timeline
- [ ] Rules: invalid / expired token (UNREGISTERED, BadDeviceToken), quota, delays

### Phase 9 — Test runs and fake clock
- [ ] Test runs: start/stop markers; timeline and traffic scoped to a run; shareable run report (HTML/JSON)
- [ ] Fake clock per project: shift devhub time for OTP / link expiry and TOTP drift tests

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

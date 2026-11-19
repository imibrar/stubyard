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
- [ ] Inbound endpoints, JSON Schema validation + inference
- [ ] Outbound templates, variables, signing (Stripe, HMAC), sequences, send-as-user
- [ ] Replay (edit, re-sign)

### Phase 4 — Email API providers
- [ ] SendGrid, Mailgun, Amazon SES, Generic email API presets → Mailpit
- [ ] Delivered / bounce / complaint webhooks; connection guides

### Phase 5 — Mocks, cleanup, polish
- [ ] Rule-based API mocks with live scenarios
- [ ] Reset / clear / auto-reset / retention (7 days, 500 MB) / factory reset
- [ ] Export / import project config
- [ ] Traffic Log filters, copy-as-cURL, replay; networking docs; test coverage

### Later — noted by the user (2026-11-19), not scheduled yet
- [ ] **Login providers (OAuth / social sign-in) simulator**: set up different login providers in devhub
  (e.g. Google, Microsoft, GitHub, Apple, generic OpenID Connect) so the app's "Sign in with …" flow can be tested locally
  with test users, without real accounts. To be scoped when we get to it.
- [ ] **File storage simulator (S3-compatible + other providers)**: the app uploads files to devhub as if it were AWS S3
  (and later e.g. Google Cloud Storage, Azure Blob, Cloudinary), using the normal SDKs pointed at devhub's endpoint:
  PUT/GET/DELETE/list objects, presigned upload/download URLs, multipart uploads, buckets per project. Uploaded files are
  browsable/downloadable in the dashboard, logged in the traffic log, and can be made to fail with rules (access denied,
  slow upload, quota exceeded). Noted by the user 2026-11-19; to be scoped later.

## Dev workflow

Node is **not** required on the host. All commands run in the `node:24` container:

```bash
./scripts/npm.sh install            # install deps
./scripts/npm.sh test               # run tests
./scripts/dev.sh                    # run server + web in watch mode (ports 4000/4443/1025/5173)
docker compose up --build           # build and run the production image
```

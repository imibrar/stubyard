# Developer Testing Hub

## Concept Document (Revision 2)

**Status:** Concept revised after design review; ready to be turned into a detailed spec / RFP  
**Date:** 2026-11-18  
**Purpose:** A local, single-container developer tool for testing email, SMS, WhatsApp, webhooks, and external API integrations across multiple projects.

---

## 1. Overview

The **Developer Testing Hub** is a tool developers run on their own machine, as one Docker container with one dashboard. Applications under development send their email, SMS, WhatsApp, webhook, and third-party API traffic to the hub instead of to real providers. The hub:

- receives it and shows it in per-project, per-test-user inboxes;
- simulates provider behavior, including errors, delays, rate limits, and delivery callbacks;
- lets developers design, send, and replay webhooks;
- logs **every** request it receives and sends, together with the response.

It is **not** a production messaging service and not a hosted multi-tenant platform. Real SMS/WhatsApp delivery is out of scope. Running it on a shared server may come later (see §16).

---

## 2. Guiding Principles

1. **Local first.** Start with one `docker run` command. No external services, no accounts, no paid SaaS.
2. **One container, one dashboard.** Everything is managed from a single UI on a single port.
3. **A project is a complete workspace.** Each project has every service (email, SMS, WhatsApp, webhooks, mocks) plus its own test users and configuration.
4. **Test users are the recipients.** Messages are routed to the inbox of the test user they were addressed to.
5. **Behavior is dynamic.** Scenarios can be changed at any time, from the dashboard or the API, and apply to the next request.
6. **Log everything.** Every request the hub receives and every response it returns is recorded, including errors, 404s, invalid payloads, and forced failures. The same applies to every request the hub sends. Nothing is silently dropped.
7. **Minimal app changes.** Ideally an app only changes its SMTP settings, provider base URLs, and webhook URLs.
8. **Easy cleanup.** Test data can be wiped per project, per user, or entirely, without losing configuration.

---

## 3. Key Design Decisions

| Area | Decision |
|---|---|
| Deployment | A single Docker image/container; data kept on a mounted volume |
| Target environment | Local developer machine (server deployment deferred) |
| Backend | Node.js + TypeScript (single process) |
| Frontend | React + TypeScript, built and served by the backend |
| Database | SQLite (file on the `/data` volume) |
| Email storage and rendering | Mailpit, embedded as a binary inside the container |
| SMTP entry point | Thin Node SMTP front (`smtp-server`) that logs, tags, and applies rules, then relays to Mailpit |
| SMS/WhatsApp simulation | Built in Node (provider presets) |
| API mocking | Built in Node (rule-based). WireMock is not included in the MVP; it could be added later as an optional sidecar |
| Background jobs | In-process scheduler/queue, persisted in SQLite (for delayed callbacks, sequences, auto-reset) |
| Live updates | Server-Sent Events (SSE) |
| HTTPS | Built in. The hub creates its own local certificate authority (CA) and serves HTTPS on `4443` alongside HTTP on `4000` |
| Provider presets | 2–3 ready-made options per channel plus a configurable "Generic" preset (see §4.5) |
| Multiple providers | A project can have **any number of provider instances per channel** (e.g. primary, fallback, marketing), each with its own URL slug and rules (see §4.9). Fallback logic stays in the app, not the hub |
| Image name | `stubyard` |
| Authentication | None for local use (binds to localhost by default) |
| Real SMS/WhatsApp delivery | Out of scope |

**Why these changes from Revision 1:** a single container makes Postgres, Redis, and WireMock (a Java runtime) too heavy. SQLite, an in-process queue, and Node-native mocks keep the image small and the stack simple. Mailpit is kept because it is small and already solves email storage, rendering, and attachments well.

---

## 4. Core Concepts

### 4.1 Project

A self-contained test workspace, such as *Hyper*, *Mkhdoom*, or *Fleet*. It contains:

- enabled services (email, SMS, WhatsApp, webhooks, mocks), all available by default;
- test users;
- provider instances: one or more per channel (SMS, WhatsApp, email), each using a preset;
- webhook endpoints (inbound) and webhook templates (outbound);
- mock API rules;
- saved scenario presets;
- all captured data (messages, events, logs).

An app identifies its project through the **SMTP username** (email) or the **URL path segment** (`/mock/hyper/...`, `/hook/hyper/...`).

### 4.2 Test Users

Virtual recipients inside a project, such as 1 admin and 9 customers.

- Fields: name, role label, email, phone number, WhatsApp number, notes.
- Email, phone, and WhatsApp numbers are **unique within a project**. They may repeat across projects.
- **One-click generation**: for example, "1 admin + 9 customers" with fake but valid-looking details.
- Each user has **one unified inbox timeline** containing email, SMS, and WhatsApp, newest first, with the latest OTP or verification link pinned at the top.
- Messages to an unknown recipient go to the project's **Unassigned** inbox, which has a one-click "create test user from this recipient" action.

### 4.3 Dynamic Scenario Rules (per user)

Each test user has an **ordered list of rules for each channel** that can be changed at any time.

| Part | Options |
|---|---|
| **Action** | `deliver` · `fail` (custom error code/message) · `reject` (provider 4xx at send time) · `rate_limit` (429) · `delay` (N ms, then deliver) · `timeout` (no response) · `drop` (accepted, never delivered) · `blocked` (user cannot receive on this channel) · `fail_rate` (X % random failures) · email only: `bounce_hard` · `bounce_soft` · `defer` · `complaint` |
| **Channel** | SMS · WhatsApp · email · all |
| **Provider instance** (optional) | Limit the rule to one instance, e.g. "fails only via `sms-primary`" |
| **Duration** | `always` · `next N messages` · `for X minutes` · `until <datetime>` · `after N successful messages` |

- A rule disables itself automatically when its count runs out or its time expires.
- Example: *Customer1 receives the first SMS normally, then every SMS fails.*
  ```text
  Customer1 · SMS
    1. deliver                               next 1 message
    2. fail "Number unreachable" (30003)     always
  ```
- **Send time vs. delivery report:** `reject`, `rate_limit`, and `timeout` affect the immediate response to the app. `fail` and `drop` accept the message first, then send a failed delivery report to the app's status webhook (or send none at all). This tests both error paths.
- **Saved presets** such as "Flaky network", "Blocked user", and "Retry once" can be applied to any user with one click.

**Which rule applies** (first match wins):

1. The `X-Hub-Scenario` request header (optional, for automated tests).
2. **Provider instance rules** (§4.9). If the provider is "down", nobody receives messages through it.
3. The test user's rules that are limited to this instance.
4. The test user's general rules for the channel, top to bottom. The matching rule's counter decreases by one.
5. The instance's default behavior (normally `deliver`).
6. Unknown recipient: the message goes to Unassigned and steps 1, 2, and 5 still apply.

Every message records the rule that handled it, so the timeline shows something like *"Failed: rule #2 (Number unreachable)"*.

### 4.4 Webhooks

**Inbound endpoints** (the hub receives webhooks):

- Path and method, under `/hook/:project/:endpoint`.
- An optional **JSON Schema**. Each request is validated and marked pass/fail with the errors listed. **Schema inference** generates a schema from a pasted sample payload.
- A configurable response: status, headers, body, and delay. It can also be dynamic through scenario rules.

**Outbound templates** (the hub sends webhooks to the app):

- Target URL, method, headers, and a body template with variables:
  `{{uuid}}`, `{{now}}`, `{{faker.*}}`, `{{user.email}}`, `{{user.phone}}`, `{{user.role}}`, and fields taken from a captured event.
- **Signing presets**: generic HMAC-SHA256 (configurable header and secret) and Stripe-style signatures with a timestamp. Others can be added as adapters.
- **Sequences**: for example, `payment.pending`, then wait 2 s, then `payment.success`. Or send the same event twice to test duplicate handling (idempotency).
- **Send as a test user**: the template is filled in with that user's details.
- **Replay** any captured or previously sent event, either unchanged or edited, and re-signed with a fresh timestamp.

**Boundary:** schema, template, sign, send, sequence, replay. The webhooks feature is not a general API client (it is not a Postman or Hoppscotch replacement).

### 4.5 SMS and WhatsApp Simulation

- Provider-compatible mock endpoints under `/mock/:project/:provider/...`, so the app only changes its provider base URL.
- In each project, the developer **picks a preset per channel** from a short list:

| Channel | Ready-made presets (MVP) | Notes |
|---|---|---|
| **SMS** | 1. **Twilio** · 2. **Vonage (Nexmo)** · 3. **Generic** | Twilio and Vonage are the most common SDKs worldwide |
| **WhatsApp** | 1. **Meta WhatsApp Cloud API** · 2. **Twilio WhatsApp** · 3. **Generic** | Meta Cloud API is also the format used by most WhatsApp resellers (e.g. 360dialog). Twilio WhatsApp shares the Twilio SMS endpoint (`whatsapp:` prefix) |
| **Email** | 1. **SMTP** · 2. **SendGrid** · 3. **Mailgun** · 4. **Amazon SES** · 5. **Generic email API** | Each email instance gets a "how to connect" guide (SMTP settings or SDK base URL) |
| **Webhook signing** (payments etc.) | 1. **Stripe** · 2. **Generic HMAC-SHA256** · 3. **None / Basic auth** | Local gateways (e.g. JazzCash, Easypaisa) can be added later as presets |

- Each preset defines the request paths and fields, the success and error response formats (including real error codes), the delivery status callback format, the inbound message webhook format, and the signature scheme.
- **Generic preset**: for any provider not in the list, the developer configures it in the dashboard instead of waiting for code:
  - request path and method;
  - where to find *to*, *from*, and *message* in the request (JSON path or form field);
  - success and error response templates;
  - callback and inbound-message body templates.
  
  Any provider can therefore be simulated on day one, with a dedicated preset added later if it is used a lot.
- Presets are adapters, so new providers can be added without changing the core.
- Outgoing requests become messages in the recipient test user's inbox.
- **Delivery status callbacks** are sent to the app's configured status webhook URL according to the applied rule (delivered, failed, with a delay).
- **Inbound replies**: from the dashboard, a test user can "reply" by SMS or WhatsApp. The hub sends a provider-format inbound webhook to the app.
- Each preset has a short "how to point your SDK here" guide for Node, PHP, and Python, served over HTTPS (see §6.2).

### 4.6 Email

- Apps send through SMTP to the hub on port `1025`, using the **project slug as the SMTP username** (any password).
- The Node SMTP front:
  - logs every SMTP session, including connections, authentication, rejected recipients, and errors;
  - applies the test user's email rules, for example rejecting with `550` when the user is `blocked` or set to `reject`;
  - tags the message with the project and relays it to Mailpit.
- Mailpit stores the content and renders HTML, links, and attachments. The hub shows emails in the user's timeline, using Mailpit's API.
- Mailpit's new-message webhook tells the hub to index metadata and extract OTPs and links.
- **Multiple email instances**: the SMTP username is `project.instance` (e.g. `hyper.transactional`, `hyper.marketing`). The username `project` alone uses the project's default email instance.
- **Bounce testing**:

| Kind | How it is simulated |
|---|---|
| Immediate hard bounce | SMTP `550` at RCPT TO (`bounce_hard`) |
| Immediate soft bounce / deferral | SMTP `421`/`450` (`bounce_soft`, `defer`) |
| Bounce that arrives later | Email accepted, then a standard bounce email (DSN) is sent to the sender's bounce (Return-Path) address and appears in Mailpit |
| Spam complaint | Recorded on the message; sent as a webhook for email API instances |

- **Email API presets** (SendGrid, Mailgun, Amazon SES, Generic): the app calls the hub's HTTP API instead of SMTP. The hub converts the call into a normal email in Mailpit, and sends **delivered / bounce / complaint webhooks** to the app according to the rules. This is how most apps receive bounces in real use. *Included in the MVP.*

### 4.7 API Mocking

- Rule-based mocks under `/mock/:project/api/...`: match on method, path, query, headers, and body.
- Responses: status (200/201/401/404/429/500…), headers, a templated body, delay, timeout, or connection drop.
- Each rule can have scenario variants that are switched live from the dashboard or the API, for example "Payment API → timeout".

### 4.8 OTP / Link Extraction

- A regex per project (with sensible defaults) extracts OTP codes and verification links from email, SMS, and WhatsApp.
- The result is shown pinned in the user's timeline and is available through the API.

### 4.10 Authenticator (TOTP) Codes

For apps with "authenticator app" two-factor login, stubyard works like Google or Microsoft Authenticator, so testers don't need a phone.

- An **Authenticator** tab per project. Add a key by pasting the secret key your app shows ("Can't scan the QR code?") or the full `otpauth://totp/...` link.
- Each key has a **label** (e.g. "Admin 2FA") and can be **linked to a test user**. Linked codes also appear on that user's page.
- Shows the current code with a countdown, plus the next code. Clicking a code copies it.
- Standard TOTP (RFC 6238): SHA1/SHA256/SHA512, 6–10 digits, configurable period (defaults: 6 digits, 30 s, SHA1).
- API for automated tests: `GET /api/projects/:project/authenticators/code?label=Admin%202FA` returns the current code and the seconds remaining.
- For test accounts only. Keys are stored unencrypted in the local data volume.

### 4.9 Multiple Provider Instances

Real apps often use several providers for the same channel: a **primary** and a **fallback** SMS provider, a separate **marketing** provider, separate **transactional** and **marketing** email. A project can therefore have **any number of provider instances per channel**:

```text
Project "Hyper"
 SMS       sms-primary (Twilio · Primary · Transactional)
           sms-fallback (Vonage · Fallback · Transactional)
           sms-marketing (Generic · Marketing)
 WhatsApp  wa-main (Meta Cloud API)
 Email     mail-transactional (SMTP) · mail-marketing (SMTP)
```

- **The app decides; the hub plays the providers.** The hub contains no fallback or routing logic. "Primary", "Fallback", "Marketing", and "Transactional" are **labels** for readability only.
- The same preset may be used more than once, e.g. two Twilio accounts.
- Each instance has its own **URL slug** (`/mock/hyper/sms-primary/...`), credentials or signing secret, status-callback URL, inbound-message URL, default behavior, and on/off switch.
- **Instance rules**, which apply to every recipient on that instance: `down` (503 or connection refused), `slow` (delay), `rate_limit`, `fail_rate` (X % random failures), `timeout`, `reject`. They have the same durations as user rules (next N, for X minutes, until a time) and can be changed at any time from the dashboard or the API.
- Every message records **which instance handled it**. The timeline shows a "via sms-fallback" badge, and inboxes and logs can be filtered by instance.
- **Duplicate-send warning**: if the same user receives the same content through two instances within a short time (default 60 s), the hub flags a possible duplicate send. This catches the common fallback bug where the primary was only slow, not down.
- **Opt-out check (optional)**: a test user can be marked "marketing opt-out" (DND). Instances labelled *Marketing* then reject messages to that user the way real providers do, to test that the app respects opt-outs.

**Example: fallback test**

```text
1. sms-primary → instance rule: down (503) for 10 minutes
2. App sends an OTP to Customer1
3. Traffic Log:  sms-primary  503  (forced: provider down)
                 sms-fallback 201  delivered
4. Customer1 timeline: "OTP 4821 · via sms-fallback"
```

---

## 5. Logging Requirements: "Log Everything"

Logging is a core feature, not a debug extra. Developers must always be able to answer two questions: *did the hub receive my request?* and *what exactly did it return?*

### 5.1 What Is Logged

**Every inbound request** to the hub, whether or not it is valid:

| Case | Logged |
|---|---|
| Successful mock / webhook / SMS / WhatsApp call | ✓ |
| Unknown project slug, unknown endpoint, or unmatched route (404) | ✓ (as "unmatched", with the full request) |
| Invalid JSON, schema validation failure, wrong content type | ✓ (with the validation errors) |
| Error, 429, timeout, or drop forced by a rule | ✓ (with the rule that caused it) |
| Hub internal errors (500) | ✓ (with the error details) |
| Oversized bodies | ✓ (body truncated, with a flag and the original size) |
| SMTP sessions: connect, auth, MAIL FROM, RCPT TO (accepted/rejected), DATA, errors | ✓ |

**Every outbound request** the hub sends:

| Case | Logged |
|---|---|
| Delivery status callbacks | ✓ |
| Outbound webhook sends, sequences, replays | ✓ |
| Inbound-reply webhooks (simulated user replies) | ✓ |
| Network failure, DNS failure, connection refused, timeout | ✓ (with the error type; there is no response) |

### 5.2 What Each Log Entry Contains

- Unique log ID. This is returned to the caller in an `X-Hub-Request-Id` header.
- Direction (inbound / outbound), and protocol (HTTP / SMTP).
- Timestamps: received, response sent, and duration.
- Request: method, full URL, query, headers, body (raw and parsed), and client IP.
- Response: status, headers, and body, or the error type if there was no response.
- What the hub resolved: project, test user, channel, endpoint/template/mock rule, scenario rule applied, and the outcome (`ok` · `unmatched` · `invalid` · `forced_error` · `internal_error` · `network_error`).
- Links to related records, such as the message created, the callback triggered, or the replay of an earlier event.

### 5.3 Logging Behavior

- **Record when received, then respond.** The request is recorded as soon as it arrives, and the response is added when it is sent. Even if the hub crashes partway through, the receipt is already on record.
- **Correlation:** a message, its send-time response, its delivery callback, and any replays are linked and viewable as one chain.
- **Never silent:** there is no path in the hub that receives or sends something without writing a log entry.
- **Viewing:** a project-level **Traffic Log** with live updates and filters (direction, channel, outcome, status code, user, time range, text search), a request/response detail view, "copy as cURL", and "replay" actions.
- **Size limits:** a configurable maximum body size per log entry (default 1 MB). Anything larger is truncated with a flag.
- **Retention:** by default, logs older than **7 days** are deleted, and the oldest logs are also deleted once total log storage passes **500 MB**. Both limits are configurable per project. A project reset also clears all logs (§8).

---

## 6. Architecture

```text
 docker run -p 4000:4000 -p 4443:4443 -p 1025:1025 -v hub-data:/data stubyard

 ┌──────────────────────── single container ────────────────────────┐
 │                                                                  │
 │  Node.js (TypeScript) — one process                              │
 │   ├─ HTTP :4000  /  HTTPS :4443 (local CA certificate)           │
 │   │   ├─ /            React dashboard (static)                   │
 │   │   ├─ /api/*       dashboard + automation API, SSE stream     │
 │   │   ├─ /mock/:project/:provider/*   SMS / WhatsApp / API mocks │
 │   │   └─ /hook/:project/:endpoint     inbound webhook capture    │
 │   ├─ SMTP :1025  (smtp-server) ── log, tag, apply rules ──┐      │
 │   ├─ Rule engine (scenarios, per-user dynamic rules)      │      │
 │   ├─ Scheduler (callbacks, sequences, delays, auto-reset) │      │
 │   ├─ Outbound sender (webhooks, callbacks, replays)       │      │
 │   ├─ Traffic logger (every in/out request + response)     │      │
 │   └─ SQLite  /data/hub.db                                 │      │
 │                                                           v      │
 │  Mailpit (internal SMTP + API, storage /data/mailpit) ◄───┘      │
 │     └─ new-message webhook ──► Node (index metadata, OTP)        │
 └──────────────────────────────────────────────────────────────────┘
```

- Processes: Node and Mailpit, started by a small entrypoint or s6-overlay. Mailpit's ports are internal only.
- All persistent data lives in `/data`, so recreating the container keeps projects and history.

### 6.1 Connecting Applications

| App runs… | App → hub | Hub → app (callbacks, webhooks, replay) |
|---|---|---|
| On the host | `http://localhost:4000`, SMTP `localhost:1025` | `http://host.docker.internal:<port>`. On Linux, start the hub with `--add-host=host.docker.internal:host-gateway` |
| In another Docker Compose project | Shared Docker network, `http://stubyard:4000` | `http://<service-name>:<port>` on the shared network |
| Inside the same Compose file | `http://stubyard:4000` | `http://<service-name>:<port>` |

Typical app configuration changes:

```env
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=hyper            # project slug
SMS_PROVIDER_BASE_URL=https://localhost:4443/mock/hyper/twilio
WHATSAPP_BASE_URL=https://localhost:4443/mock/hyper/meta-whatsapp
PAYMENT_API_BASE_URL=https://localhost:4443/mock/hyper/api
NODE_EXTRA_CA_CERTS=/path/to/stubyard-ca.crt   # only if the CA is not installed system-wide
# Provider → app webhooks are configured in the hub, pointing at the app's URL
```

### 6.2 HTTPS

Most provider SDKs expect `https://` addresses, so HTTPS is a first-class feature.

- **On first start**, the hub generates a **local certificate authority (CA)**, stored in `/data/certs` and kept across restarts. It uses that CA to issue a certificate covering `localhost`, `127.0.0.1`, `stubyard`, `host.docker.internal`, and any extra names added in settings.
- HTTPS is served on **`4443`**. Plain HTTP on `4000` stays available for tools that don't need HTTPS.
- **Trusting the CA (one-time setup):** the dashboard has a "Download CA certificate" button plus copy-paste instructions for:
  - **OS trust store:** Linux (`update-ca-certificates`), macOS (Keychain), Windows (Certificate Manager);
  - **Node.js:** `NODE_EXTRA_CA_CERTS=/path/stubyard-ca.crt`;
  - **PHP:** `curl.cainfo` / `openssl.cafile` in `php.ini`;
  - **Python:** `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE`;
  - **Java:** `keytool -importcert`;
  - **App containers:** mount the CA file into the container and set the variable above.
- **SMTP** also supports STARTTLS with the same certificate, for apps that require TLS for email.
- **Fallback for SDKs whose host cannot be changed** (optional, advanced, off by default): point the provider's real hostname (e.g. `api.twilio.com`) at the hub with Docker `extra_hosts` for the app container. Use `/etc/hosts` on the developer machine only if there is no alternative, because it affects the whole machine. The hub then issues a certificate for that hostname from its local CA. The dashboard shows a clear warning while this is active.
- **Security note:** the CA private key never leaves `/data/certs`. The CA should only be trusted on development machines, and "Regenerate CA" is available in settings.

---

## 7. API Surface (initial, not final)

```http
# Projects
POST   /api/projects
GET    /api/projects
GET    /api/projects/:project
PATCH  /api/projects/:project
DELETE /api/projects/:project
POST   /api/projects/:project/reset            # wipe data, keep config
GET    /api/projects/:project/export           # config only (JSON)
POST   /api/projects/import

# Test users
POST   /api/projects/:project/users
POST   /api/projects/:project/users/generate   # e.g. {admins:1, customers:9}
PATCH  /api/projects/:project/users/:user
DELETE /api/projects/:project/users/:user
POST   /api/projects/:project/users/:user/clear   # clear this user's inbox

# Dynamic rules
GET    /api/projects/:project/users/:user/rules
PUT    /api/projects/:project/users/:user/rules     # replace the whole list
POST   /api/projects/:project/users/:user/rules     # add one
DELETE /api/projects/:project/users/:user/rules     # back to default
POST   /api/projects/:project/users/:user/rules/preset/:preset

# Provider instances
CRUD   /api/projects/:project/providers                    # instances (slug, preset, labels…)
GET    /api/projects/:project/providers/:slug/rules
PUT    /api/projects/:project/providers/:slug/rules        # e.g. down for 10 minutes
DELETE /api/projects/:project/providers/:slug/rules        # back to healthy

# Messages
GET    /api/projects/:project/messages?user=&channel=&provider=&since=
GET    /api/projects/:project/messages/wait?to=&channel=&timeout=30s   # long-poll, returns OTP/link
POST   /api/projects/:project/users/:user/reply     # simulate inbound SMS/WhatsApp

# Webhooks
CRUD   /api/projects/:project/webhook-endpoints
CRUD   /api/projects/:project/webhook-templates
POST   /api/projects/:project/webhook-templates/:id/send   # optional {asUser}
POST   /api/projects/:project/schemas/infer                # sample payload → JSON Schema
POST   /api/logs/:id/replay                                # optional {edits, target}

# Mocks
CRUD   /api/projects/:project/mocks
PATCH  /api/projects/:project/mocks/:id/active-scenario

# Traffic log
GET    /api/projects/:project/logs?direction=&outcome=&status=&user=&q=
GET    /api/logs/:id
GET    /api/stream                                 # SSE live updates

# Traffic entry points
ANY    /mock/:project/:instance/*         # e.g. /mock/hyper/sms-primary/...
ANY    /hook/:project/:endpoint
SMTP   :1025  (username = project or project.instance)
```

Example rule (`POST /api/projects/hyper/users/customer1/rules`):

```json
{ "channel": "sms", "action": "fail", "errorCode": "30003",
  "errorMessage": "Number unreachable", "count": 1 }
```

---

## 8. Cleanup

| Action | Removes | Keeps |
|---|---|---|
| **Clear user inbox** | That user's messages | Everything else |
| **Reset project data** | Messages, Mailpit emails for the project, traffic logs, replays; rule counters and timers reset | Project, users, rules, endpoints, schemas, templates, mocks, presets |
| **Reset all rules** | All users go back to `deliver` | Everything else |
| **Delete project** | Everything for the project | Nothing |
| **Auto-reset** (optional, per project) | Same as "Reset project data", after N days | Configuration |
| **Factory reset** | Everything in the hub | Nothing |

**Export/import** covers the project configuration only (users, rules, presets, endpoints, schemas, templates, mocks), as JSON. It can be committed to an app's repository so new developers can import it and start straight away.

---

## 9. Data Model (SQLite)

All project-owned tables include `project_id` with `ON DELETE CASCADE`.

| Table | Key columns / purpose |
|---|---|
| `projects` | id, slug, name, enabled_services, channel defaults, otp_regex, auto_reset_days |
| `test_users` | id, project_id, name, role, email, phone, whatsapp (unique per project), marketing_opt_out |
| `provider_instances` | id, project_id, channel, slug (unique per project), name, preset, labels (primary/fallback/transactional/marketing/custom), is_default, credentials/signing secret, status-callback URL, inbound URL, default action, enabled |
| `instance_rules` | id, provider_instance_id, position, action, error_code, error_message, delay_ms, fail_rate, remaining_count, expires_at, enabled |
| `user_rules` | id, test_user_id, channel, provider_instance_id (nullable = all instances), position, action, error_code, error_message, delay_ms, fail_rate, remaining_count, expires_at, after_success_count, enabled |
| `rule_presets` | id, project_id (nullable = global), name, rules (JSON) |
| `messages` | id, project_id, test_user_id (nullable = Unassigned), provider_instance_id, channel, direction (out/in), from, to, body / mailpit_id, status (incl. bounced/complained), applied_rule_id + rule level, duplicate_of_id, otp, links, log_id |
| `webhook_endpoints` | id, project_id, path, method, json_schema, response config |
| `webhook_templates` | id, project_id, name, target_url, method, headers, body_template, signing preset/secret, sequence steps |
| `mocks` | id, project_id, match (method/path/query/headers/body), scenarios (JSON), active_scenario |
| `traffic_logs` | id, project_id (nullable for unknown project), direction, protocol, received_at, responded_at, duration_ms, request (method, url, headers, body, truncated, size), response (status, headers, body) or error_type, resolved (user, channel, endpoint/template/mock, rule), outcome, parent_log_id |
| `scheduled_jobs` | id, project_id, type (callback/sequence-step/auto-reset), run_at, payload, status, attempts, last_error |

Email bodies and attachments stay in Mailpit and are not duplicated.

---

## 10. Dashboard

- **Projects list**: create, import, reset, and delete projects.
- **Project overview**: test user cards with unread counts per channel, current rule status (for example "SMS: failing, 2 left" or "WhatsApp: blocked 8:42"), and quick rule buttons (✓ Deliver · ✗ Fail next · ⏸ Block · ⏱ Delay). Also links to the Unassigned inbox and the setup snippet for connecting an app.
- **User view**: unified timeline with a "via <instance>" badge on each message, pinned OTP/link, the rule editor, "reply as user", and "send webhook as user".
- **Providers**: one card per provider instance showing its status (Healthy / Down / Slow / Rate-limited / Flaky), one-click outage buttons, the setup snippet for that instance, and its recent traffic.
- **Webhooks**: endpoints (with schema editor and inference), templates (with variables, signing, and sequences), and capture history with validation results.
- **Mocks**: rules, scenario variants, and an active scenario switch.
- **Traffic Log**: live, filterable list of everything in and out, with request/response details, copy as cURL, and replay.
- **Settings**: retention, body size limit, default OTP regex, presets.

---

## 11. Example Test Scenarios

1. A sign-up email OTP arrives in the Admin user's inbox, with the OTP pinned.
2. An SMS OTP to Customer1 is delivered. The next SMS fails with "Number unreachable" and a failed delivery callback reaches the app.
3. WhatsApp is blocked for Customer2 for 10 minutes, then works again automatically.
4. The SMS provider returns 429 twice for Customer3, so the app's retry logic is checked.
5. A WhatsApp reply from Customer4 triggers the app's inbound webhook handler.
6. The `payment.pending` then `payment.success` sequence is sent to the app, signed.
7. A duplicate `payment.success` is sent to test idempotency.
8. A captured provider webhook is replayed after editing its amount.
9. The external payment API mock is switched to "timeout" to check the app's error handling.
10. An app calls a wrong mock path. The 404 is visible in the Traffic Log with the full request.
11. An inbound webhook fails schema validation. The errors are visible and the configured response is still returned.
12. Project data is reset after the test run while users, rules, and templates are kept.
13. An automated test uses `messages/wait` to read an OTP and `rules` to force a failure mid-test.
14. `sms-primary` is set to "down": the app falls back to `sms-fallback`, and the OTP shows "via sms-fallback".
15. `sms-primary` is set to "slow 5 s": the app falls back too early, and the duplicate-send warning appears.
16. `sms-primary` is set to 30 % random failures, to check retry and fallback behavior under a flaky provider.
17. A marketing SMS to an opted-out user is rejected by the `sms-marketing` instance.
18. A transactional email to a user with `bounce_hard` gets SMTP 550. With delayed bounce, a bounce email appears in Mailpit instead.

---

## 12. Nonfunctional Requirements

- Starts with a single `docker run` command (a Compose example is also provided). Target image size under about 300 MB, and idle memory under about 300 MB.
- Binds to `127.0.0.1` by default. Exposing it to the network is an explicit opt-in.
- No mandatory internet access or paid dependencies.
- All data in `/data` survives container upgrades. Schema migrations are applied automatically.
- The dashboard updates within about 1 second of traffic arriving.
- API-first: everything the dashboard does is available through the API.
- Outbound sends to non-local hosts show a warning, and can optionally be restricted by an allowlist, to avoid accidentally calling production.
- Extensible adapters for SMS/WhatsApp provider presets and webhook signing schemes.

---

## 13. Out of Scope (MVP)

- Real SMS/WhatsApp/email delivery.
- Hosted/multi-tenant operation, developer accounts, roles, and SSO.
- Public internet webhook reception (tunnels).
- A general-purpose API client (Postman replacement).
- Full CI/CD assertion framework. Only the wait-for-message and rules APIs are included.
- Guaranteed fidelity for every provider. Presets are added as needed.

---

## 14. Implementation Phases (indicative)

| Phase | Deliverables | Estimate |
|---|---|---|
| 1. Foundation | Single image (Node + Mailpit), SQLite + migrations, projects, test users (incl. generation), **traffic logger**, SSE, dashboard shell, SMTP front → Mailpit, email in user timeline, **local CA + HTTPS + CA download/instructions** | 5–6 days |
| 2. Messaging + rules | SMS/WhatsApp simulator with presets (Twilio, Vonage, Meta Cloud API, Twilio WhatsApp, **Generic**), **multiple provider instances**, dynamic rule engine (user + instance levels, fail rate) and rule presets, delivery callbacks, inbound replies, OTP extraction, wait API, Unassigned inbox, duplicate-send warning, SMTP bounce actions and DSN | 7–9 days |
| 3. Webhooks | Inbound endpoints + schema validation/inference, outbound templates, variables, signing, sequences, replay | 5–7 days |
| 4. Email API providers | SendGrid, Mailgun, Amazon SES, Generic email API instances with delivered/bounce/complaint webhooks and connection guides | 2–3 days |
| 5. Mocks, cleanup, polish | Rule-based mocks with live scenarios, reset/clear/auto-reset, export/import, Traffic Log UI (filters, cURL, replay), networking docs, automated tests | 3–4 days |
| **Total (MVP)** | | **22–29 developer-days** |

This is an early estimate. Provider fidelity and UI polish are the main sources of variation.

---

## 15. Resolved Decisions (2026-11-18)

| Decision | Outcome |
|---|---|
| Providers | Pick per project from 2–3 presets per channel plus a Generic preset (§4.5) |
| HTTPS | Built-in local CA; HTTPS on `4443` (§6.2) |
| Ports | HTTP `4000`, HTTPS `4443`, SMTP `1025`; all configurable |
| Log retention | 7 days or 500 MB, whichever limit is reached first; configurable per project |
| Name | Developer Testing Hub, image `stubyard` |
| Multiple providers | Any number of provider instances per channel, with instance-level rules (§4.9) |
| Email providers | SMTP plus SendGrid, Mailgun, Amazon SES and Generic email API presets, all in the MVP (2026-11-19) |
| Provider coverage | Ready-made presets where they match; anything else uses the Generic preset (2026-11-19) |

No open decisions remain for the MVP.

---

## 16. Future (post-MVP)

- Running on a shared dev server: developer accounts, admin role, per-project access.
- Public webhook ingress (tunnel) for real provider sandboxes.
- WireMock or OpenAPI-based mock import.
- CI helpers: CLI, test SDK (Node/PHP), assertions.
- More provider and signing presets.

---

## 17. Acceptance Criteria (MVP)

- The hub starts with one documented `docker run` command, and data survives a container restart.
- After trusting the downloaded CA, a Node and a PHP app can call `https://localhost:4443/...` with the official Twilio and Meta WhatsApp SDKs without certificate errors.
- A provider not in the preset list can be simulated by configuring the Generic preset in the dashboard, with no code changes to the hub.
- A developer can create two projects, each with 10 generated test users and all services enabled.
- An email sent through SMTP with username `hyper` appears in the matching Hyper test user's timeline. An unknown recipient appears in Unassigned.
- An SMS/WhatsApp request to the mock appears in the correct user's timeline, and no real message is sent.
- Changing a user's rule (for example "fail next 1 SMS") takes effect on the very next message without a restart, and the rule expires automatically.
- `reject`/`rate_limit`/`timeout` affect the send-time response, and `fail` produces a failed delivery callback to the app.
- A simulated inbound WhatsApp reply reaches the app's webhook.
- A project can have two or more SMS instances (including two of the same preset). Setting one to "down" makes it fail for every recipient while the others keep working, and each message shows which instance handled it.
- A user rule limited to one instance affects only that instance.
- Sending the same content to the same user through two instances within 60 s raises the duplicate-send warning.
- An email to a user with `bounce_hard` is rejected with SMTP 550. A delayed bounce produces a bounce email in Mailpit.
- An inbound webhook endpoint with a schema marks valid and invalid payloads correctly. Schema inference produces a usable schema from a sample.
- An outbound template can be sent signed, in a sequence, and as a specific test user. Replay re-signs with a fresh timestamp.
- A mock API can be switched live between success, error, delay, and timeout.
- **Every** inbound request appears in the Traffic Log with its response, including 404/unmatched, invalid payloads, forced errors, and internal errors. **Every** outbound request appears with its response or network error. No request is handled without a log entry.
- "Reset project data" removes messages, emails, and logs but keeps users, rules, and configuration. "Delete project" removes everything.
- Export from one machine and import on another recreates the project configuration.

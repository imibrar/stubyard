# devhub — Guide for AI Agents

devhub (Developer Testing Hub) is a **local testing service** that stands in for real email, SMS, WhatsApp, webhook and
authenticator-app providers while an application is being developed. Nothing is ever delivered to real people.
Everything the app sends is captured, attached to a **test user**, and **logged with its full request and response**.

Use it to:

- read verification emails / OTP codes your app sends, without a real mailbox;
- get authenticator-app (TOTP) 2FA codes, without a phone;
- see exactly what your app sent and what it got back, including errors;
- reset all test data after a test run.

Everything the dashboard does is also available through the **REST API at `http://localhost:4000/api`**, which is
what an agent should use. Responses are JSON. No authentication is needed, because devhub only listens on localhost.

---

## 1. Feature status

| Feature | Status | How to use |
|---|---|---|
| Projects (one per app) with test users | ✅ Available | §4, §5 |
| Email capture over SMTP, per-user inbox, OTP and link extraction | ✅ Available | §6 |
| Multiple email provider instances per project (e.g. transactional + marketing) | ✅ Available | §6.3 |
| Authenticator app (TOTP) codes | ✅ Available | §7 |
| Traffic log of every request in and out (incl. 404s, bad JSON, rejected SMTP) | ✅ Available | §8 |
| HTTPS with a local certificate authority | ✅ Available | §9 |
| Live event stream (Server-Sent Events) | ✅ Available | §10 |
| Cleanup: clear inbox, reset project, delete project | ✅ Available | §11 |
| SMS and WhatsApp simulators (Twilio, Vonage, Meta Cloud API, Twilio WhatsApp, Generic), delivery reports, replies | ✅ Available | §C, §E |
| Dynamic failure rules (fail next N, block for X min, provider down, 429, bounces…) | ✅ Available | §D |
| Wait-for-message API, user lookup by role/email, test passwords | ✅ Available | §A, §B |
| MCP server for AI agents | ✅ Available | §F |
| Webhook endpoints, schemas, signed sending, replay | 🚧 Phase 3 | `/hook/...` calls are logged as 404 for now |
| Email API providers (SendGrid, Mailgun, SES) | 🚧 Phase 4 | — |
| API mocks, export/import, auto-retention | 🚧 Phase 5 | — |

**Do not depend on 🚧 features yet.** If a task needs one, tell the user it is not built yet.

---

## 2. Start devhub

From the devhub repository:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://localhost:4000/api/system        # → {"name":"devhub", ...} when ready
```

The first build takes a few minutes, and later starts are instant. Check whether it is already running:

```bash
curl -sf http://localhost:4000/api/system >/dev/null && echo running || echo "not running"
```

| Port | Purpose |
|---|---|
| `4000` | Dashboard (human UI), REST API, `/mock/...` and `/hook/...` endpoints |
| `4443` | Same as 4000 over HTTPS |
| `1025` | SMTP: apps send email here |

Data (projects, users, emails, logs, HTTPS CA) is kept in the `devhub-data` Docker volume across restarts.
`docker compose -f deploy/docker-compose.yml down -v` deletes all of it.

---

## 3. Core concepts

- **Project**: one per application (e.g. `hyper`, `fleet`). Identified by its **slug**, which is used in URLs and as the
  SMTP username. Every project automatically gets an SMTP email provider instance called `mail`.
- **Test user**: a fake person in a project, with an email, phone and WhatsApp number (e.g. an admin and some customers).
  A message sent to a test user's address lands in **their inbox**. Addresses are unique within a project.
- **Unassigned**: messages to addresses that don't match any test user in the project.
- **Provider instance**: a simulated provider in a project, e.g. `mail` (SMTP), `marketing` (SMTP), `sms-primary` (Twilio).
  A project can have several per channel. Every message records which instance handled it.
- **Authenticator key**: a TOTP secret with a label. devhub returns its current 2FA code.
- **Traffic log**: one entry per request devhub received or sent, with headers, bodies, status, timing and outcome.

---

## 4. Projects

```bash
# Create a project and generate test users (1 admin + 9 customers)
curl -s -X POST http://localhost:4000/api/projects -H 'content-type: application/json' \
  -d '{"name":"Hyper","slug":"hyper","generateUsers":{"admins":1,"customers":9}}'

curl -s http://localhost:4000/api/projects                      # list (with stats)
curl -s http://localhost:4000/api/projects/hyper                # one project
curl -s http://localhost:4000/api/projects/hyper/overview       # users (with unread counts), providers, authenticators
curl -s http://localhost:4000/api/projects/hyper/setup          # ready-made connection settings (Laravel, Node, Django, …)

# Update settings: custom OTP regex (first capture group = code), generator phone prefix / email domain
curl -s -X PATCH http://localhost:4000/api/projects/hyper -H 'content-type: application/json' \
  -d '{"settings":{"otpRegex":"code[:\\s]+(\\d{6})","phonePrefix":"+92300","emailDomain":"hyper.test"}}'
```

- Slug: lowercase letters, digits and dashes. It is derived from the name if omitted, and cannot be changed later.
- Creating a project whose slug already exists returns **409**.

---

## 5. Test users

```bash
curl -s http://localhost:4000/api/projects/hyper/users

curl -s -X POST http://localhost:4000/api/projects/hyper/users -H 'content-type: application/json' \
  -d '{"name":"Sara","role":"customer","email":"sara@hyper.test","phone":"+923001112233"}'
# whatsapp defaults to the phone number; set "whatsapp" to override.

curl -s -X POST http://localhost:4000/api/projects/hyper/users/generate -H 'content-type: application/json' \
  -d '{"admins":0,"customers":5}'

curl -s -X PATCH  http://localhost:4000/api/projects/hyper/users/<userId> -H 'content-type: application/json' -d '{"name":"Sara K"}'
curl -s -X DELETE http://localhost:4000/api/projects/hyper/users/<userId>
```

- Generated users look like `admin@hyper.test` / `+923000000001` and `customer1@hyper.test` / `+923000000002`.
- Emails are lowercased. Phone numbers are normalized to `+<digits>`, so `0092 300-111 2233` becomes `+923001112233`.
- Using an address that another user in the same project already has returns **409**.

---

## 6. Email

### 6.1 Point the app at devhub

| Setting | Value |
|---|---|
| Host | `localhost` (app on this machine) · `devhub` (app container on the `devhub` Docker network) · `host.docker.internal` (other containers) |
| Port | `1025` |
| Username | the project slug, e.g. `hyper` |
| Password | anything |
| Encryption | none (no TLS / STARTTLS) |

`GET /api/projects/<slug>/setup` returns copy-paste snippets for each framework.

If the app sends **without authenticating**, devhub picks the project from the recipient (the project that has a test
user with that address), or uses the only project if there is just one. Otherwise the recipient is rejected with
`550` and the rejection is logged.

### 6.2 Read the email / OTP

```bash
# Find the user id
curl -s http://localhost:4000/api/projects/hyper/users | jq -r '.[] | select(.email=="admin@hyper.test") | .id'

# Messages of that user, newest first (each has: subject, bodyText, otp, links[], status, from, to, createdAt, …)
curl -s "http://localhost:4000/api/projects/hyper/messages?user=<userId>&channel=email&limit=5"

# Latest OTP for an address (search matches to/from/subject/body)
curl -s "http://localhost:4000/api/projects/hyper/messages?q=admin@hyper.test&limit=1" | jq -r '.[0].otp'

# Unassigned inbox
curl -s "http://localhost:4000/api/projects/hyper/messages?user=unassigned"

# One message with links to the rendered HTML and raw source
curl -s http://localhost:4000/api/messages/<messageId>
#   .mailpit.html → /mailpit/view/<id>.html     .mailpit.raw → /mailpit/api/v1/message/<id>/raw
```

Message list filters: `user` (id or `unassigned`), `channel` (`email`|`sms`|`whatsapp`), `provider` (instance slug),
`since` (ISO timestamp, inclusive), `q` (text search), `limit` (≤500), `before` (message id, for paging).

OTP extraction: 4–8 digit codes near words like *code / OTP / PIN / verification*, or a standalone 6-digit number.
Links: every `http(s)` URL in the text and HTML (`links[]`, e.g. verification or reset links).

### 6.3 Several email providers in one project

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/providers -H 'content-type: application/json' \
  -d '{"preset":"smtp","slug":"marketing","name":"Marketing SMTP","labels":["marketing"]}'
```

The app then uses the SMTP username `hyper.marketing`. Filter messages with `?provider=marketing`.
`GET /api/system` → `.presets` lists every provider type. The default instance per channel is used when the username
is just the project slug.

### 6.4 Recipe: wait for an email after triggering it

Use the wait API (§B): `curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1" | jq -r .otp`. Polling also works:

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# … trigger the app action that sends the email …
for i in $(seq 1 20); do
  OTP=$(curl -s "http://localhost:4000/api/projects/hyper/messages?q=admin@hyper.test&since=$SINCE&limit=1" | jq -r '.[0].otp // empty')
  [ -n "$OTP" ] && break; sleep 0.5
done
echo "$OTP"
```

---

## 7. Authenticator app (TOTP 2FA) codes

When the app under test shows "scan this QR code with your authenticator app", take the **secret key** (usually shown
under "can't scan?") or the `otpauth://totp/...` link inside the QR code, and register it:

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/authenticators -H 'content-type: application/json' \
  -d '{"label":"Admin 2FA","secret":"otpauth://totp/Hyper:admin%40hyper.test?secret=JBSWY3DPEHPK3PXP&issuer=Hyper","testUserId":"<optional userId>"}'
# or a raw key (spaces and lowercase are fine):  "secret":"JBSW Y3DP EHPK 3PXP"
# optional for raw keys: "algorithm":"SHA1|SHA256|SHA512", "digits":6-10, "period":10-300, "issuer", "account"

# Current code by label (case-insensitive)
curl -s "http://localhost:4000/api/projects/hyper/authenticators/code?label=Admin%202FA"
# → {"id":"…","label":"Admin 2FA","code":"166220","nextCode":"252703","period":30,"remaining":17,"validFrom":…,"validUntil":…}

curl -s http://localhost:4000/api/projects/hyper/authenticators                 # all keys + current codes
curl -s http://localhost:4000/api/projects/hyper/authenticators/<id>/code
curl -s http://localhost:4000/api/projects/hyper/authenticators/<id>/secret     # secret + otpauth:// link
curl -s -X DELETE http://localhost:4000/api/projects/hyper/authenticators/<id>
```

- **If `remaining` is 2 or less, wait for the next period** (or use `nextCode` after `validUntil`). Otherwise the code
  may expire before the app checks it.
- Codes match Google/Microsoft Authenticator (RFC 6238).
- Label lookups return **404** if no key matches and **409** if several keys share the label.
- Only use test accounts. Keys are stored unencrypted.

---

## 8. Traffic log ("log everything")

devhub records **every request it receives on `/mock/...` and `/hook/...`, every request to an unknown URL, and every
SMTP transaction**, including rejected logins and recipients. Each entry is written as soon as the request arrives,
then completed with the response. Dashboard and API calls (`/api/...`) are **not** logged.

Every HTTP response from devhub includes `X-Hub-Request-Id: <logId>`.

```bash
curl -s "http://localhost:4000/api/logs?project=hyper&limit=20"     # summaries, newest first
curl -s "http://localhost:4000/api/logs?project=none"               # requests that matched no project
curl -s http://localhost:4000/api/logs/<logId>                      # full entry: headers, bodies, SMTP transcript
```

Filters: `project` (slug or `none`), `direction` (`inbound`|`outbound`), `protocol` (`http`|`smtp`), `outcome`,
`status` (HTTP/SMTP code), `q` (searches URL, bodies, errors), `limit`, `before` (log id).

| `outcome` | Meaning |
|---|---|
| `ok` | Handled successfully |
| `unmatched` | No route (404). Check the URL; `resolved.unknownProject` is set if the project slug is wrong |
| `invalid` | Bad request, e.g. invalid JSON (`resolved.bodyError`) |
| `rejected` | Refused, e.g. SMTP login with an unknown project (`535`), or a recipient that couldn't be matched to a project (`550`) |
| `forced_error` | Error caused on purpose by a scenario rule (phase 2) |
| `internal_error` | devhub failed (500 / SMTP 451). Report it |
| `network_error` | Connection dropped or target unreachable |
| `pending` | Request received, response not finished yet |

**Debugging recipe:** if the app says it sent something but it isn't in an inbox, check
`/api/logs?project=<slug>&limit=10`, then `/api/logs?project=none&limit=10`, and read `errorMessage`, `resStatus` and,
for SMTP, `transcript`.

---

## 9. HTTPS

devhub has its own certificate authority (CA), created on first start and kept in the data volume.

```bash
curl -s -o devhub-ca.crt http://localhost:4000/api/ca.crt
curl --cacert devhub-ca.crt https://localhost:4443/api/system      # verify
curl -s http://localhost:4000/api/https-guide                      # trust commands per OS / language
```

The certificate covers `localhost`, `127.0.0.1`, `::1`, `devhub` and `host.docker.internal` (more via `DEVHUB_TLS_NAMES`).
Trusting the CA system-wide (`sudo update-ca-certificates`, Keychain, etc.) changes the user's machine, so **ask the
user before doing it**. Prefer per-process options such as `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE` or `curl --cacert`.

---

## 10. Live events

```bash
curl -N "http://localhost:4000/api/stream?project=hyper"
```

Server-Sent Events: `message.created`, `message.updated`, `log.created`, `log.updated`, `user.changed`,
`provider.changed`, `authenticator.changed`, `project.*`. The payload is `{"projectId":…, "data":…}`.

---

## 11. Cleanup

| Action | Request | Keeps |
|---|---|---|
| Clear one inbox | `POST /api/projects/hyper/users/<userId|unassigned>/clear` | everything else |
| Mark inbox read | `POST /api/projects/hyper/users/<userId|unassigned>/read` | — |
| Reset project data | `POST /api/projects/hyper/reset` (messages, emails, logs) | project, users, providers, authenticator keys, settings |
| Delete project | `DELETE /api/projects/hyper` | nothing |

Reset the project before a test run when you need a clean inbox. **Never delete a project the user created without
asking.**

---

## 12. Errors

Errors return `{"error": "<message>"}` with an HTTP status: `400` invalid input, `404` not found, `409` conflict
(duplicate slug, address, or label), `500` devhub bug.

## 13. Rules for agents

1. Check devhub is running (`GET /api/system`) before relying on it. If it isn't, start it (§2) or ask the user.
2. Use the project slug the user's app is configured with (check the app's SMTP username / mock base URLs). Don't
   create duplicates. Read `GET /api/projects` first.
3. Prefer test-user addresses (`…@<slug>.test`, `+92300…`) in test data, so messages land in a known inbox.
4. Read OTPs and links from `/messages`, and 2FA codes from `/authenticators/code`. Never ask the user to check a real phone or mailbox.
5. When something is missing, look in the traffic log before changing app code.
6. Don't use features marked 🚧 in §1, and don't trust the devhub CA system-wide without asking.

---

# Added in version 0.2
## A. Test users: roles, pins, passwords and references

- Users have a **role** (any text: `admin`, `sales`, `support`, `customer`, `driver`…), an optional **test password**
  (default from project settings, `Password123!`), and can be **pinned** to the dashboard sidebar.
- Anywhere the API takes a user, you can pass an **id, email, phone, exact name or role** (`admin` = first admin):

```bash
curl -s http://localhost:4000/api/projects/hyper/users/admin                       # one user + inbox counts + latest code
curl -s "http://localhost:4000/api/projects/hyper/users/sales1@hyper.test/latest?otp=1"   # → {"otp":"482913","link":…,"message":{…}}
curl -s "http://localhost:4000/api/projects/hyper/messages?user=admin&channel=sms&limit=5"
# Generate users per role (numbering continues; the first of each role is pinned, up to 4)
curl -s -X POST http://localhost:4000/api/projects/hyper/users/generate -H 'content-type: application/json' \
  -d '{"roles":[{"role":"admin","count":1},{"role":"sales","count":2},{"role":"customer","count":5}]}'
```

## B. Wait for a message (no polling)

`GET /api/projects/:p/messages/wait` blocks until a matching message arrives and returns it (HTTP 408 on timeout).
Filters: `user`, `to`, `channel`, `otp=1` (only messages with a code), `after=<messageId>`, `since=<ISO>`,
`timeout` (seconds, default 30, max 120). Without `after`/`since`, messages from the last 10 s also count, so a code
sent just before the call is not missed. Delayed deliveries count when they are delivered.

```bash
# trigger the login in the app, then:
curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30" | jq -r .otp
```

Only messages the user actually **received** (status `delivered`) count for `otp=1` and "latest code";
rejected or failed attempts are ignored.

## C. SMS and WhatsApp simulators

Add a provider instance (dashboard → Providers, or the API), then point the app's SDK base URL at
`https://localhost:4443/mock/<project>/<instance>` (plain `http://localhost:4000/mock/…` works too). Supported presets:

| Preset | Endpoint the app calls (after the base URL) | Notes |
|---|---|---|
| `twilio` / `twilio-whatsapp` | `POST /2010-04-01/Accounts/<sid>/Messages.json` (form), `GET …/Messages/<sid>.json` | `whatsapp:` prefix = WhatsApp; callbacks signed with `X-Twilio-Signature` when `authToken` is set |
| `vonage` | `POST /sms/json` | Errors come back as HTTP 200 with `status` ≠ "0", like Vonage |
| `meta-whatsapp` | `POST /<version>/<phone-number-id>/messages` (JSON) | Text, template, interactive; webhooks signed with `X-Hub-Signature-256` when `appSecret` is set |
| `generic-sms` / `generic-whatsapp` | Any path (or `config.path`) | Field names and response/callback templates configurable |

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/providers -H 'content-type: application/json' -d '{
  "preset":"twilio","slug":"sms-primary","labels":["primary"],
  "config":{"statusCallbackUrl":"http://host.docker.internal:3000/webhooks/sms/status",
            "inboundUrl":"http://host.docker.internal:3000/webhooks/sms/inbound"}}'
```

- The message lands in the test user's timeline (matched by phone / WhatsApp number) with OTP and links extracted.
- **Delivery reports**: `sent`, then `delivered` / `failed` are POSTed to the status callback URL (per-message
  `StatusCallback` / `callback` wins), in the provider's own format. Each report is in the traffic log and on the message.
- **Duplicate warning**: the same text to the same user through two instances within 60 s, where the first was
  accepted, is flagged (`duplicateOfId`). A fallback after a rejected primary is not flagged.
- **Marketing opt-out**: users with `marketingOptOut: true` are rejected by instances labelled `marketing`.

## D. Scenario rules (make things fail on purpose)

Rules live on a **test user** (per channel, optionally per instance) or on a **provider instance** (everyone).
First match wins, top to bottom: `X-Hub-Scenario` header → instance rules → marketing opt-out → user rules → deliver.

| Action | Effect |
|---|---|
| `fail` | Accepted (2xx), then a failed delivery report; email: accepted, then a bounce email (DSN) to the sender |
| `reject` | The send call returns the provider's 4xx error; email: SMTP 550 |
| `rate_limit` | 429 (Vonage: status "1"); email: SMTP 451 |
| `timeout` | No response at all |
| `drop` | Accepted, never delivered, no report |
| `delay` | Accepted now, delivered after `delayMs` |
| `blocked` | User cannot receive (Twilio 21610, Vonage "7", Meta: failed report 131026, email 550 5.7.1) |
| `fail_rate` | `failRate` % random failures |
| `down` / `slow` (instance only) | 503 / answer after `delayMs` |
| `bounce_hard` / `bounce_soft` / `defer` (email) | SMTP 550 / 452 / 450 at RCPT TO |
| `complaint` / `bounce_delayed` (email) | Delivered then marked spam / delivered then a DSN after `delayMs` |

Duration: omit for "always", or `count` (next N), `minutes`, `until` (ISO), `after` (start after N normal messages).

```bash
# Next SMS to customer1 fails with Twilio 30003, later ones are fine
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/rules -H 'content-type: application/json' \
  -d '{"channel":"sms","action":"fail","count":1,"errorCode":"30003","errorMessage":"Unreachable"}'
# Primary SMS provider down for 10 minutes (test the fallback)
curl -s -X POST http://localhost:4000/api/projects/hyper/providers/sms-primary/rules/preset/down-10m
# Presets: GET http://localhost:4000/api/rule-presets   ·  Back to normal:
curl -s -X DELETE http://localhost:4000/api/projects/hyper/users/customer1/rules
curl -s -X DELETE http://localhost:4000/api/projects/hyper/providers/sms-primary/rules
# One request only: header  X-Hub-Scenario: fail:30003:Unreachable   (or reject, rate_limit, delay:5000, timeout…)
```

Every message records the rule that handled it (`appliedRule`) and its outcome (`status`: delivered, failed,
rejected, dropped, scheduled, bounced, complained, timeout).

## E. Replies from test users (inbound SMS / WhatsApp)

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/reply -H 'content-type: application/json' \
  -d '{"channel":"sms","text":"STOP"}'      # optional "instance":"sms-primary"
```

devhub sends the provider's inbound webhook (Twilio form, Vonage JSON, Meta envelope…) to the instance's
`inboundUrl` (Meta: the webhook URL) and returns `{message, webhook:{ok,status,error,logId}}`.

## F. MCP server (tools for AI agents)

devhub speaks the Model Context Protocol at **`http://localhost:4000/mcp`** (Streamable HTTP). Add it once, e.g. in Claude Code:

```bash
claude mcp add --transport http devhub http://localhost:4000/mcp
```

Tools: `list_projects`, `list_test_users`, `get_latest_code`, `wait_for_message`, `get_messages`, `get_2fa_code`,
`set_user_scenario`, `reset_user_scenario`, `set_provider_rule`, `reset_provider_rules`, `reply_as_user`,
`get_traffic`, `get_request`, `clear_inbox`, `reset_project_data`. Prefer them over raw curl when available.

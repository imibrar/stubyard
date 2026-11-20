<!-- Generated from docs/AGENT_GUIDE.md by deploy/make-bundle.sh. Do not edit; a running stubyard serves the same guide at http://localhost:4000/api/agent-guide -->

# stubyard — Guide for AI Agents

stubyard is a **local testing service** that stands in for real email, SMS, WhatsApp, webhook and
authenticator-app providers while an application is being developed. Nothing is ever delivered to real people.
Everything the app sends is captured, attached to a **test user**, and **logged with its full request and response**.

Use it to:

- read verification emails / OTP codes your app sends, without a real mailbox;
- get authenticator-app (TOTP) 2FA codes, without a phone;
- see exactly what your app sent and what it got back, including errors;
- reset all test data after a test run.

Everything the dashboard does is also available through the **REST API at `http://localhost:4000/api`**, which is
what an agent should use. Responses are JSON. No authentication is needed: stubyard is a local tool, its ports are
published on `127.0.0.1` only (this machine), and `/api` refuses calls from other web pages (Host / Origin checks).

A running stubyard serves this guide at **`GET http://localhost:4000/api/agent-guide`** (Markdown), with the host and
ports rewritten to the ones you used to reach it (e.g. through an SSH tunnel).

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
| Webhooks: receive with JSON Schema checks, send signed (HMAC/Stripe) templates, sequences, replay | ✅ Available | §G |
| Email API providers (SendGrid, Mailgun, Amazon SES, Generic) with event webhooks | ✅ Available | §H |
| API mocks with live scenarios (`/mock/<project>/api/...`) | ✅ Available | §J |
| Export / import project configuration | ✅ Available | §K |
| Automatic retention (7 days / 500 MB), auto-reset, reset all rules, factory reset | ✅ Available | §L |
| Test runs: isolated rules, mock scenarios, messages and minted users per parallel test worker | ✅ Available | §N |
| Login providers: Google, Microsoft, GitHub, Facebook, LinkedIn, Apple, X, Discord, GitLab, Slack, generic OIDC | ✅ Available | §O |
| Twilio Verify / Vonage Verify (stubyard generates and checks codes) | ✅ Available | §P |
| Inbound email: test users reply by email (SendGrid Inbound Parse, Mailgun routes, SES, generic) | ✅ Available | §Q |
| WhatsApp media, buttons, lists, read receipts, button replies, 24-hour window | ✅ Available | §R |
| File storage: Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi | ✅ Available | §S |
| File storage: Cloudinary, Google Cloud Storage, Azure Blob, Supabase Storage (real SDKs) | ✅ Available | §T |
| Content checks on every message (placeholders, broken links, unsubscribe, SMS encoding) | ✅ Available | §U |
| Webhook security check (bad signatures, stale timestamps, replays, malformed bodies) | ✅ Available | §U |
| MCP tester / inspector: connect your own MCP server, call tools, JSON-RPC log, checks, saved calls | ✅ Available | §V |
| Scheduled actions: send webhooks / sequences / replies later or on repeat, set rules and mock scenarios on a timer | ✅ Available | §W |
| HTML test-run reports, per-feature clock offsets (TOTP, login tokens, Verify, webhook timestamps), `@stubyard/client` run helpers | ✅ Available | §X |
| AI chat: providers (OpenAI, Anthropic, Google, OpenRouter, Ollama, compatible), agents with MCP tester + read-only stubyard tools, saved prompts with expectations | ✅ Available | §Y |
| Payments: fake Stripe Checkout, PayTabs, PayPal Standard with hosted outcome page, rules, signed webhooks, mada / STC Pay / Apple Pay | ✅ Available | §Z |
| Doctor: checks every callback / webhook URL from inside stubyard, with explanations | ✅ Available | §M |
| Outbound allowlist (never calls production URLs), self-signed HTTPS option | ✅ Available | §M |
| Seed projects at start (`STUBYARD_SEED`), CI recipe (GitHub Actions) | ✅ Available | §M |

All features listed above are available. Planned next (not built): HyperPay and PayPal Buttons / Expanded, LLM API mocks and record-to-mock, scripted auto-replies, push notifications.

---

## 2. Start stubyard

From the stubyard repository:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://localhost:4000/api/system        # → {"name":"stubyard", ...} when ready
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

Data (projects, users, emails, logs, HTTPS CA) is kept in the `devhub-data` Docker volume (name kept from before the rename) across restarts.
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
- **Authenticator key**: a TOTP secret with a label. stubyard returns its current 2FA code.
- **Traffic log**: one entry per request stubyard received or sent, with headers, bodies, status, timing and outcome.

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

### 6.1 Point the app at stubyard

| Setting | Value |
|---|---|
| Host | `localhost` (app on this machine) · `stubyard` (app container on the `stubyard` Docker network) · `host.docker.internal` (other containers) |
| Port | `1025` |
| Username | the project slug, e.g. `hyper` |
| Password | anything |
| Encryption | none (no TLS / STARTTLS) |

`GET /api/projects/<slug>/setup` returns copy-paste snippets for each framework.

If the app sends **without authenticating**, stubyard picks the project from the recipient (the project that has a test
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

#### How codes are detected

- A project `otpRegex` still wins (first capture group, else the whole match).
- Otherwise stubyard scores candidates and takes the one **closest to a keyword in the same sentence**:
  code, OTP, PIN, passcode, one-time password, verification / verify, token, 2FA/MFA, and basics in other languages
  (کوڈ, código, codigo, code/Code inside words like *Bestätigungscode*, код, 验证码, رمز, kode, senha, contraseña…).
  `keyword is 1234`, `code: 1234`, `1234 is your code`, `Use 1234 as your … code` get a bonus.
- Codes: 4–8 digits; `123-456` / `123 456` (returned without the separator); **alphanumeric** upper-case codes with
  at least one letter and one digit such as `A7K-92Q`, `X4F9P2` (returned as written) — alphanumeric ones only when
  next to a keyword. `G-123456` → `123456`.
- Never a code: years (unless right after the keyword, e.g. `PIN: 2019`), dates and times, phone numbers, prices
  and amounts (`$`, `Rs.`, `PKR`, `USD`, …), durations (`10 minutes`), percentages, order / invoice / card-ending /
  transaction / ticket / reference numbers, and numbers inside links or email addresses. "promo/coupon/discount code"
  does not anchor a code.
- Without any keyword, only a lone 6-digit number counts ("Here it is: 654321").

### 6.3 Several email providers in one project

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/providers -H 'content-type: application/json' \
  -d '{"preset":"smtp","slug":"marketing","name":"Marketing SMTP","labels":["marketing"]}'
```

The app then uses the SMTP username `hyper.marketing`. Filter messages with `?provider=marketing`.
`GET /api/system` → `.presets` lists every provider type. The default instance per channel is used when the username
is just the project slug.

### 6.4 Recipe: wait for an email after triggering it

Use the wait API with a cursor (§B), so a "resend code" never returns the previous code:

```bash
CUR=$(curl -s "http://localhost:4000/api/projects/hyper/messages/cursor?user=admin" | jq -r .cursor)
# … trigger the app action that sends the email …
curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1&after=$CUR&timeout=30" | jq -r .otp
```

Polling also works:

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

stubyard records **every request it receives on `/mock/...` and `/hook/...`, every request to an unknown URL, and every
SMTP transaction**, including rejected logins and recipients. Each entry is written as soon as the request arrives,
then completed with the response. Dashboard and API calls (`/api/...`) are **not** logged.

Every HTTP response from stubyard includes `X-Hub-Request-Id: <logId>`.

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
| `forced_error` | Error caused on purpose by a scenario rule (§D) |
| `internal_error` | stubyard failed (500 / SMTP 451). Report it |
| `network_error` | Connection dropped or target unreachable; also outbound calls refused by the allowlist (`errorType: blocked_by_allowlist`, §M) |
| `pending` | Request received, response not finished yet |

**Debugging recipe:** if the app says it sent something but it isn't in an inbox, check
`/api/logs?project=<slug>&limit=10`, then `/api/logs?project=none&limit=10`, and read `errorMessage`, `resStatus` and,
for SMTP, `transcript`.

---

## 9. HTTPS

stubyard has its own certificate authority (CA), created on first start and kept in the data volume.

```bash
curl -s -o stubyard-ca.crt http://localhost:4000/api/ca.crt
curl --cacert stubyard-ca.crt https://localhost:4443/api/system      # verify
curl -s http://localhost:4000/api/https-guide                      # trust commands per OS / language
```

The certificate covers `localhost`, `127.0.0.1`, `::1`, `stubyard` and `host.docker.internal` (more via `STUBYARD_TLS_NAMES`).
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
(duplicate slug, address, or label), `500` stubyard bug.

## 13. Rules for agents

1. Check stubyard is running (`GET /api/system`) before relying on it. If it isn't, start it (§2) or ask the user.
2. Use the project slug the user's app is configured with (check the app's SMTP username / mock base URLs). Don't
   create duplicates. Read `GET /api/projects` first.
3. Prefer test-user addresses (`…@<slug>.test`, `+92300…`) in test data, so messages land in a known inbox.
4. Read OTPs and links from `/messages`, and 2FA codes from `/authenticators/code`. Never ask the user to check a real phone or mailbox.
5. When something is missing, look in the traffic log before changing app code.
6. Don't trust the stubyard CA system-wide without asking.
7. Callbacks / webhooks to the app never arrive? Run the doctor (§M) before changing app code.

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

### Cursors, counts and negative assertions

Every messages response carries a **cursor**: the newest message id it covers. It is in the body (`cursor`)
of `wait`, `expect-none` and `cursor`, and in the `X-Stubyard-Cursor` header of those and of `GET /messages`.
`after=<cursor>` means "only messages created after that point". Message ids are strictly increasing, so a cursor
never skips a later message.

**Robust pattern (use this):** get a cursor → trigger the action → wait after the cursor.

```bash
P=http://localhost:4000/api/projects/hyper
CUR=$(curl -s "$P/messages/cursor?user=admin" | jq -r .cursor)     # 1. before the action
# 2. click "Resend code" in the app
curl -s "$P/messages/wait?user=admin&otp=1&after=$CUR&timeout=30" | jq -r .otp   # 3. never the old code
```

Without `after`/`since`, `wait` still also counts messages from the last 10 s (`lookback=<s>`) for backward
compatibility — convenient, but right after "resend code" it returns the *previous* code. Prefer the cursor.

| Endpoint | What it does |
|---|---|
| `GET /api/projects/:p/messages/cursor?user=&channel=&to=&provider=&otp=` | `{ cursor, newestAt }` — current newest matching message id (`"0"` when there is none). Cheap; no waiting. A cursor without filters is valid for any filter; a filtered one for the same or a narrower filter. |
| `GET /api/projects/:p/messages/wait?…` | Unchanged filters + `after`, `since`, `lookback`, `timeout` (s, default 30, max 120). Returns the message (as before) **plus `cursor`** (= its id). 408 `{ error, timeout, cursor }`. |
| `…/messages/wait?…&count=N` | Wait until **at least N** matching messages. 200 `{ expected, count, messages (oldest first), cursor }`; 408 with what arrived so far. |
| `…/messages/wait?…&exactly=N[&settle=2]` | Wait until N arrived, then keep listening `settle` s (default 2, max 60). 200 when still N; **409** `{ error, expected, count, messages, cursor }` as soon as there are more (e.g. a double send); 408 when fewer. |
| `GET /api/projects/:p/messages/expect-none?…&within=5` | **Negative assertion.** 200 `{ ok: true, within, count: 0, cursor }` when nothing matching arrives within `within` s (default 5, max 120); **409** with `{ error, count, messages, cursor }` as soon as one does. Counts from *now* (no lookback) unless `after`/`since`/`lookback` is given — pass `after=<cursor>` taken before the action to also catch a message that arrived before the call. |

`count` and `exactly` cannot be combined; `count=0` / `exactly=0` → 400 pointing to `expect-none`.
Delayed deliveries count when they are delivered; with `otp=1` only received messages count. The cursor is
by creation: a message created *before* the cursor but delivered after it does not count.

```bash
# "the user gets exactly one code" (no duplicate through the fallback provider)
curl -s "$P/messages/wait?user=customer3&channel=sms&after=$CUR&exactly=1&settle=3"
# "a blocked user gets no email"
curl -s -o /dev/null -w '%{http_code}\n' "$P/messages/expect-none?user=blocked1&channel=email&after=$CUR&within=5"   # 200
```

**MCP** (`wait_for_message`): new options `after` (cursor; `after_message_id` stays as an alias),
`get_cursor_only` (returns `{ cursor }` without waiting — call it before triggering), `count`, `exactly`,
`expect_no_message` + `within_seconds`. Assertion failures come back as tool errors with the offending messages.

## C. SMS and WhatsApp simulators

Add a provider instance (dashboard → Providers → SMS or WhatsApp tab, or the API), then point the app's SDK base URL at
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

### SMS segments

SMS messages get `metadata.segments`, `metadata.encoding` (`GSM-7` or `UCS-2`) and `metadata.characters`.
Rules: GSM-7 160 chars in one SMS, 153 per part; extension characters `^ { } [ ] ~ \ | €` count double;
any other character (Urdu, Arabic, emoji, curly quotes, `ç`…) switches to UCS-2: 70 in one SMS, 67 per part,
emoji count as two. Twilio's `num_segments` (and inbound `NumSegments`) use the same maths; WhatsApp is always 1.

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

### Email rules are used up on accepted DATA

For SMTP, rules are decided at `RCPT TO` but **counted** ("next N", "after N") only when the email is accepted at
the end of `DATA`. An abandoned transaction (RSET, QUIT, connection drop, size error) does not use up
"fail next 1". Refusals (reject, hard/soft bounce, blocked, defer, rate limit, down, opt-out) count when they are
returned at `RCPT TO`; a `timeout` rule counts when its 421 is finally sent.

## E. Replies from test users (inbound SMS / WhatsApp)

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/reply -H 'content-type: application/json' \
  -d '{"channel":"sms","text":"STOP"}'      # optional "instance":"sms-primary"
```

stubyard sends the provider's inbound webhook (Twilio form, Vonage JSON, Meta envelope…) to the instance's
`inboundUrl` (Meta: the webhook URL) and returns `{message, webhook:{ok,status,error,logId}}`.

## F. MCP server (tools for AI agents)

stubyard speaks the Model Context Protocol at **`http://localhost:4000/mcp`** (Streamable HTTP). Add it once, e.g. in Claude Code:

```bash
claude mcp add --transport http stubyard http://localhost:4000/mcp
```

Tools: `list_projects`, `list_test_users`, `get_latest_code`, `wait_for_message`, `get_messages`, `get_2fa_code`,
`set_user_scenario`, `reset_user_scenario`, `set_provider_rule`, `reset_provider_rules`, `reply_as_user`,
`get_traffic`, `get_request`, `clear_inbox`, `reset_project_data`. Prefer them over raw curl when available.

| Area | Tools |
|---|---|
| Diagnostics | `doctor` (§M) |
| Webhooks (§G) | `list_webhooks` (endpoints with recent hits, templates, sequences), `send_webhook` (template name/id, `as_user`, `data`), `run_webhook_sequence` |
| API mocks (§J) | `list_api_mocks`, `set_mock_scenario` (`mock`, `scenario`) |
| Providers | `list_providers` (instances with config and base URLs from this machine / from containers / SMTP username), `set_provider_config` (merges `config`, e.g. `statusCallbackUrl`, `inboundUrl`, `eventWebhookUrl`; `enabled`, `is_default`, `name`) |
| Project setup | `create_project` (`name`, `slug`, `roles: [{role,count}]`, `admins`, `customers` → project + users), `generate_users`, `export_project` (`include_secrets`) |

---

# Added in version 0.3

## G. Webhooks (receive and send)

stubyard both **receives** webhooks (inbound endpoints with JSON Schema checks) and **sends** them to your app
(templates with variables and signatures, sequences, replay). Every request in either direction is in the traffic log.

Dashboard: **Project → Webhooks** (tabs *Receive* and *Send*). Live updates come over the shared SSE stream
(`webhooks.changed`, plus `log.*` for hits/results).

### Receive: inbound endpoints

URL: `ANY http://localhost:4000/hook/<project>/<path>` (or `https://localhost:4443/...`).

An endpoint has:

| Field | Meaning |
|---|---|
| `path` | Relative to `/hook/<project>/`. `:name` matches one segment (`orders/:id`), a trailing `*` matches the rest. `""` = the project root. |
| `method` | `ANY` (default) or `GET POST PUT PATCH DELETE HEAD OPTIONS`. An exact method beats `ANY`; literal segments beat `:params`. |
| `schema` | Optional JSON Schema (object or JSON string). `null` = accept anything. |
| `response` | `{ status: 200, headers: {"content-type":"application/json"}, body: '{"received": true}', delayMs: 0, rejectInvalid: false }` |
| `enabled` | Disabled endpoints answer like unknown paths (logged 404). |

Each request is validated against the schema. The log entry's `resolved` gets
`{ endpoint, endpointId, pattern, params, schema: bool, valid: bool, errors: [{ path, message }] }` and the outcome is
`invalid` when validation fails (invalid JSON counts as a failure too). By default stubyard still answers with the configured
response; with `rejectInvalid: true` it answers `400 { error, errors }`.

Unknown path / unknown project → the usual logged `404` with a hint (outcome `unmatched`).

Response body and header values are templates. Extra variables: `{{body.<path>}}`, `{{params.<name>}}`,
`{{query.<name>}}`, `{{headers.<name>}}`, `{{request.id}}` (the log id), `{{request.path}}`, plus the general ones below.

Supported JSON Schema keywords: `type` (incl. arrays of types), `enum`, `const`, `properties`, `required`,
`additionalProperties`, `patternProperties`, `propertyNames`, `min/maxProperties`, `dependentRequired`, `items`,
`prefixItems`, `min/maxItems`, `uniqueItems`, `contains`, `min/maxLength`, `pattern`, `format` (email, date-time, date,
time, uri, url, uuid, ipv4, hostname), `minimum`, `maximum`, `exclusiveMinimum/Maximum`, `multipleOf`, `allOf`, `anyOf`,
`oneOf`, `not`, `if/then/else`, local `$ref` (`#/$defs/...`, `#/definitions/...`). Remote `$ref`s are not supported.

```bash
# create an endpoint
curl -X POST localhost:4000/api/projects/hyper/webhook-endpoints -H 'content-type: application/json' -d '{
  "name": "Payments", "path": "payments/:id", "method": "POST",
  "schema": {"type":"object","required":["amount","currency"],
             "properties":{"amount":{"type":"number","minimum":0},"currency":{"enum":["USD","PKR"]}}},
  "response": {"status": 201, "body": "{\"ok\":true,\"id\":\"{{params.id}}\"}"}
}'

# hit it
curl -X POST localhost:4000/hook/hyper/payments/pay_1 -H 'content-type: application/json' -d '{"amount":10,"currency":"USD"}'

# recent hits (pass/fail + errors), newest first
curl localhost:4000/api/projects/hyper/webhook-endpoints/<id>/hits?limit=25
```

#### Schema inference

`POST /api/projects/:p/schemas/infer` with `{ "sample": <payload> }` (or a JSON string) returns a 2020-12 JSON Schema:
types (integer vs number), every key `required`, nested objects, arrays (item shapes merged; keys required only if present
in every item), and formats `uuid`, `email`, `date-time`, `date`, `uri` when obvious. `null` values become `{"type":"null"}`
— loosen them by hand if needed.

### Send: outbound templates

| Field | Meaning |
|---|---|
| `name` | Unique per project, usually the event type (`payment_intent.succeeded`). Usable instead of the id in URLs. |
| `targetUrl` | Your app's webhook URL as reachable from stubyard (`http://host.docker.internal:3000/...` when the app runs on the host). May contain variables. |
| `method` | `POST` (default), `PUT`, `PATCH`, `DELETE`, `GET` |
| `headers` | Object; values may contain variables |
| `bodyTemplate` | Text; usually JSON. `content-type: application/json` is added when the body looks like JSON. |
| `signing` | See below |

#### Variables

| Variable | Value |
|---|---|
| `{{uuid}}` | A UUID — the **same** everywhere in one send (URL, headers, body), so `X-Event-Id` can match the body id |
| `{{run.id}}` | One id shared by all steps of a sequence run (single sends: a fresh id) |
| `{{now}}` / `{{timestamp}}` / `{{timestampMs}}` | ISO time / Unix seconds / Unix ms |
| `{{faker.name}}` `firstName` `lastName` `email` `phone` `amount` `word` `words` `number` `date` `uuid` `company` `city` `country` `url` `bool` | Random values (new value per placeholder) |
| `{{user.id}}` `name` `email` `phone` `whatsapp` `role` | The "send as" test user |
| `{{data.<path>}}` | From the `data` you pass, e.g. `{{data.order.id}}`, `{{data.items[0].sku}}`; objects are inserted as JSON |

In JSON bodies string values are JSON-escaped automatically, so write `"name": "{{user.name}}"` and
`"amount": {{faker.amount}}`. Unknown/empty variables render as empty and are reported in the send result (`missing`)
and in the log (`resolved.missingVariables`).

#### Signing presets

| Preset | Config | Header(s) sent |
|---|---|---|
| `none` | – | – |
| `hmac` | `secret`, `header` (default `X-Signature`), `prefix` (default `sha256=`), `encoding` (`hex`/`base64`), optional `timestampHeader` | `<header>: <prefix><HMAC-SHA256(secret, body)>`; with `timestampHeader`: signs `"<ts>.<body>"` and sends `<timestampHeader>: <ts>` |
| `stripe` | `secret` (e.g. `whsec_…`) | `Stripe-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<body>")>` — verifiable with Stripe SDKs' `constructEvent` |
| `basic` | `username`, `password` | `Authorization: Basic …` |

The signature is computed over the exact bytes sent, with a fresh timestamp on every send (including repeats and replays).
Secrets are stored and returned in plain text (local test secrets). On PATCH, sending the same preset without `secret`
keeps the stored one.

```bash
curl -X POST localhost:4000/api/projects/hyper/webhook-templates -H 'content-type: application/json' -d '{
  "name": "payment_intent.succeeded",
  "targetUrl": "http://host.docker.internal:3000/stripe/webhook",
  "bodyTemplate": "{\"id\":\"evt_{{uuid}}\",\"type\":\"payment_intent.succeeded\",\"data\":{\"object\":{\"amount\":{{data.amount}},\"receipt_email\":\"{{user.email}}\"}}}",
  "signing": {"preset": "stripe", "secret": "whsec_test"}
}'

# send now (optionally as a test user: id, email, phone, name or role) → outbound result + logId
curl -X POST localhost:4000/api/projects/hyper/webhook-templates/payment_intent.succeeded/send \
  -H 'content-type: application/json' -d '{"asUser": "customer1@hyper.test", "data": {"amount": 4200}}'
# → { ok, status, body, error, logId, request: {method,url,headers,body}, missing, warnings }

# render without sending
curl -X POST localhost:4000/api/projects/hyper/webhook-templates/payment_intent.succeeded/preview -d '{}' -H 'content-type: application/json'

# last results
curl localhost:4000/api/projects/hyper/webhook-templates/payment_intent.succeeded/results
```

Send results are in the traffic log as outbound entries with
`resolved = { template, templateId, signing, signedAt, user, userId, sequence?, step? }`.

### Sequences

A sequence is a list of steps `{ templateId (or template name), delayMs, repeat }`:

- `delayMs` — wait after the previous step (first step: after the run starts).
- `repeat` — send this step N times (1–20) back to back with the **identical payload** (same `{{uuid}}`, re-signed),
  to test duplicate delivery / idempotency.

Runs go through the durable scheduler (`scheduled_jobs`, type `webhook.sequence`), so they survive a stubyard restart.
Each step is scheduled after the previous one was sent; timing granularity is the scheduler tick (~200 ms).

```bash
curl -X POST localhost:4000/api/projects/hyper/webhook-sequences -H 'content-type: application/json' -d '{
  "name": "pay flow",
  "steps": [
    {"template": "payment.pending", "delayMs": 0},
    {"template": "payment.success", "delayMs": 2000},
    {"template": "payment.success", "delayMs": 0, "repeat": 2}
  ]
}'
curl -X POST localhost:4000/api/projects/hyper/webhook-sequences/pay%20flow/run -H 'content-type: application/json' -d '{"asUser":"admin","data":{}}'
# → 202 { runId, sequence, steps: [{ step, template, repeat, atMs }] }
curl localhost:4000/api/projects/hyper/webhook-sequences/pay%20flow/results
```

A template used by a sequence cannot be deleted (409).

### Replay

`POST /api/logs/:id/replay` with optional `{ url, method, headers, body, resign }`:

- **Outbound** log (template send, status callback…): re-sent to the same URL by default.
- **Inbound** captured request (e.g. a `/hook/...` hit): re-sent to stubyard's own URL by default (so it hits the endpoint
  again); pass `url` to forward it to your app instead.
- `headers` are merged into the captured ones (`null` removes a header). `body` replaces the body (objects are
  JSON-encoded). Captured bodies that were truncated must be passed explicitly.
- `resign` defaults to `true` when the original came from a signed template: the old signature header is removed and a
  new one is computed over the (possibly edited) body with a fresh timestamp. `resign: true` on anything else → 400.
- The new outbound log has `parentLogId` = the original, and `resolved.replayOf`, `resigned`, `edited`.

```bash
curl -X POST localhost:4000/api/logs/<logId>/replay -H 'content-type: application/json' -d '{}'
curl -X POST localhost:4000/api/logs/<logId>/replay -H 'content-type: application/json' \
  -d '{"body": {"id": "evt_dup", "type": "payment_intent.succeeded"}}'
# → { ok, status, body, error, logId, parentLogId, resigned, request }
```

The dashboard's traffic-log drawer has a **Replay** button (replay as is, or edit URL/method/headers/body).

### API summary

```http
ANY    /hook/:project/<path>
GET    /api/webhooks/reference                          # methods, signing presets, template variables
POST   /api/projects/:p/schemas/infer                    # {sample} → JSON Schema
GET    /api/projects/:p/webhook-endpoints                # incl. urls {http,https} and stats {hits,invalid,lastHitAt}
POST   /api/projects/:p/webhook-endpoints
GET    /api/projects/:p/webhook-endpoints/:id
PATCH  /api/projects/:p/webhook-endpoints/:id
DELETE /api/projects/:p/webhook-endpoints/:id
GET    /api/projects/:p/webhook-endpoints/:id/hits?limit=
GET    /api/projects/:p/webhook-templates
POST   /api/projects/:p/webhook-templates
GET    /api/projects/:p/webhook-templates/:idOrName
PATCH  /api/projects/:p/webhook-templates/:idOrName
DELETE /api/projects/:p/webhook-templates/:idOrName
POST   /api/projects/:p/webhook-templates/:idOrName/send      # {asUser?, data?}
POST   /api/projects/:p/webhook-templates/:idOrName/preview   # {asUser?, data?}
GET    /api/projects/:p/webhook-templates/:idOrName/results?limit=
GET    /api/projects/:p/webhook-sequences
POST   /api/projects/:p/webhook-sequences
GET    /api/projects/:p/webhook-sequences/:idOrName
PATCH  /api/projects/:p/webhook-sequences/:idOrName
DELETE /api/projects/:p/webhook-sequences/:idOrName
POST   /api/projects/:p/webhook-sequences/:idOrName/run       # {asUser?, data?} → 202
GET    /api/projects/:p/webhook-sequences/:idOrName/results?limit=
POST   /api/logs/:id/replay                                   # {url?, method?, headers?, body?, resign?}
```

Data model (migration 5): `webhook_endpoints`, `webhook_templates`, `webhook_sequences`, all `ON DELETE CASCADE` with the
project. Project reset clears logs (so hits/results) but keeps endpoints, templates and sequences.

The **Connect your app** page lists the HTTP and HTTPS URLs of every configured endpoint.

## H. Email API providers (SendGrid, Mailgun, Amazon SES, Generic)

### Email API simulators

Add an email provider instance with preset `sendgrid`, `mailgun`, `ses` or `generic-email` (dashboard → Providers → Email tab, or
the API), then point the SDK's base URL at `https://localhost:4443/mock/<project>/<instance>` (plain
`http://localhost:4000/mock/…` works too). The setup guide (`GET /api/projects/<project>/setup`) shows ready-made snippets.

| Preset | Endpoint the app calls (after the base URL) | Success response | Events sent to `eventWebhookUrl` |
|---|---|---|---|
| `sendgrid` | `POST /v3/mail/send` (JSON) | `202`, empty body, `X-Message-Id` header (sandbox mode: `200`, not delivered) | JSON array of SendGrid events: `processed`, `delivered`, `deferred`, `bounce` (`type` bounce/blocked), `dropped`, `spamreport` |
| `mailgun` | `POST /v3/<domain>/messages` (multipart or urlencoded), `POST /v3/<domain>/messages.mime` | `200 {"id":"<…@domain>","message":"Queued. Thank you."}` (`o:testmode=yes`: not delivered) | `{"signature":{timestamp,token,signature},"event-data":{…}}`: `accepted`, `delivered`, `failed` (severity temporary/permanent), `complained` |
| `ses` | `POST /v2/email/outbound-emails` (JSON: Simple, Raw, Template) | `200 {"MessageId":"…"}` | SNS `Notification` envelope (`Message` = stringified SES event): `Delivery`, `Bounce`, `Complaint` (event-publishing format also `Send`, `DeliveryDelay`, `Reject`) |
| `generic-email` | Any path (or `config.path`) | `successTemplate` | `eventTemplate` with `{{event}}` = processed / delivered / deferred / bounced / dropped / complained |

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/providers -H 'content-type: application/json' -d '{
  "preset":"sendgrid","slug":"sendgrid","labels":["transactional"],
  "config":{"apiKey":"SG.stubyard","eventWebhookUrl":"http://host.docker.internal:3000/webhooks/sendgrid"}}'
```

- Every accepted call becomes a real MIME email (built with nodemailer's MailComposer; SES Raw / Mailgun MIME are
  relayed as is) in Mailpit, tagged `X-Tags: project-<p>, instance-<i>` (+ up to 5 provider tags), and is captured per
  recipient (to, cc, bcc) as a normal email message: test-user inbox, OTP/link extraction, HTML view, attachments,
  `providerMessageId` = the provider's id (SendGrid X-Message-Id, Mailgun id, SES MessageId).
- Templates: stubyard doesn't have your provider-side templates. SendGrid `template_id` + `dynamic_template_data`, Mailgun
  `template` + `t:variables`, SES `Template` (by name) are shown as text (`[SendGrid dynamic template d-123]` + `key: value`
  lines), so codes and links in the data are still extracted. Inline content (SES `TemplateContent`, SendGrid content
  with `{{var}}` / substitutions, Mailgun text/html with `t:variables`) is rendered with the data.
- Each event is in the traffic log (linked to the send call) and on the message (`metadata.reports`, shown in the viewer).
  Failed deliveries of events to your app (5xx / no answer) are retried.

#### Config fields (`provider_instances.config`)

| Preset | Key | Meaning |
|---|---|---|
| all | `eventWebhookUrl` | Where stubyard POSTs events (SES: the HTTP endpoint subscribed to your SNS topic) |
| `sendgrid` | `apiKey` | Optional. When set, `Authorization: Bearer <key>` is required (else 401 like SendGrid) |
| `sendgrid` | `eventWebhookPrivateKey` | Optional ECDSA P-256 private key (PEM). Events then carry `X-Twilio-Email-Event-Webhook-Signature` (base64 DER ECDSA-SHA256 over `timestamp + body`) and `X-Twilio-Email-Event-Webhook-Timestamp`; verify with the matching public key. Create: `openssl ecparam -name prime256v1 -genkey -noout \| openssl pkcs8 -topk8 -nocrypt` |
| `mailgun` | `domain` | Optional. Other domains in the URL → `404 {"message":"Domain not found: …"}` |
| `mailgun` | `apiKey` | Optional. When set, HTTP Basic `api:<key>` is required (else `401 Forbidden`) |
| `mailgun` | `webhookSigningKey` | `signature = hex(HMAC-SHA256(key, timestamp + token))`. Defaults to `apiKey`, else `stubyard-signing-key` |
| `ses` | `region` | Used in ARNs / Message-IDs (default `us-east-1`) |
| `ses` | `topicArn` | `TopicArn` in notifications (default `arn:aws:sns:<region>:123456789012:stubyard-<instance>`) |
| `ses` | `notificationFormat` | `notification` (default; `notificationType`: Delivery/Bounce/Complaint) or `event` (`eventType`, adds Send, DeliveryDelay, Reject and `mail.tags`) |
| `ses` | `rawMessageDelivery` | `true` = POST the SES JSON itself, without the SNS envelope |
| `generic-email` | `path`, `toField`, `ccField`, `bccField`, `fromField`, `subjectField`, `textField`, `htmlField` | Field names / JSON paths (e.g. `recipient.address`). Recipients may be a string, `"a@x, B <b@y>"`, an array of strings or of `{email,name}` |
| `generic-email` | `successStatus`, `successTemplate`, `errorTemplate`, `eventTemplate` | Response and event bodies (`{{id}} {{to}} {{from}} {{subject}} {{timestamp}}`; errors `{{errorCode}} {{errorMessage}}`; events `{{event}} {{email}} {{reason}} {{bounceType}}`) |

SNS messages are **not signed** (`Signature` is a placeholder): turn SNS signature verification off in development.
There is no `SubscriptionConfirmation` handshake.

#### SDK setup

```js
// SendGrid (@sendgrid/mail)
const sgMail = require('@sendgrid/mail'); const client = require('@sendgrid/client');
sgMail.setClient(client); sgMail.setApiKey(process.env.SENDGRID_API_KEY);
// Must come AFTER setApiKey: setApiKey() resets the base URL to the real api.sendgrid.com
client.setDefaultRequest('baseUrl', 'https://localhost:4443/mock/hyper/sendgrid');

// Mailgun (mailgun.js)
const mg = new Mailgun(FormData).client({ username: 'api', key: process.env.MAILGUN_API_KEY, url: 'https://localhost:4443/mock/hyper/mailgun' });

// Amazon SES v2 (AWS SDK v3)
const ses = new SESv2Client({ region: 'us-east-1', endpoint: 'https://localhost:4443/mock/hyper/ses',
  credentials: { accessKeyId: 'stubyard', secretAccessKey: 'stubyard' } });
```

Python: `SendGridAPIClient(key, host=BASE)`, `boto3.client("sesv2", endpoint_url=BASE)`, Mailgun via `requests.post(BASE + "/v3/<domain>/messages", auth=("api", key), data=…)`.

```bash
curl -i -X POST http://localhost:4000/mock/hyper/sendgrid/v3/mail/send -H 'Authorization: Bearer SG.stubyard' -H 'Content-Type: application/json' \
  -d '{"personalizations":[{"to":[{"email":"customer1@hyper.test"}]}],"from":{"email":"no-reply@hyper.app"},"subject":"Sign in","content":[{"type":"text/plain","value":"Your code is 123456"}]}'
curl -s --user 'api:key-stubyard' http://localhost:4000/mock/hyper/mailgun/v3/mg.example.com/messages \
  -F from='no-reply@mg.example.com' -F to='customer1@hyper.test' -F subject='Sign in' -F text='Your code is 123456'
curl -s -X POST http://localhost:4000/mock/hyper/ses/v2/email/outbound-emails -H 'Content-Type: application/json' \
  -d '{"FromEmailAddress":"no-reply@hyper.app","Destination":{"ToAddresses":["customer1@hyper.test"]},"Content":{"Simple":{"Subject":{"Data":"Sign in"},"Body":{"Text":{"Data":"Your code is 123456"}}}}}'
```

#### Validation errors (provider format)

- SendGrid: `400 {"errors":[{"message","field","help"}]}`, all problems at once (e.g. `from.email`, `personalizations`,
  `personalizations.0.to.0.email` "Does not contain a valid address.", `subject`, `content`). Invalid JSON →
  `{"errors":[{"message":"Bad Request","field":null,"help":null}]}`.
- Mailgun: `400 {"message":"to parameter is missing"}`, `"from parameter is missing"`, `"subject parameter is missing"`,
  `"Need at least one of 'text', 'html' or 'template' parameters specified"`, `"to parameter is not a valid address. please check documentation"`.
- SES: `400` with header `x-amzn-ErrorType: BadRequestException` and `{"message":"…"}` (missing Content / Destination /
  FromEmailAddress / Subject / Body, illegal address). SDK v3 maps these to typed exceptions.
- Generic: `errorTemplate` with codes `missing_to`, `invalid_to`, `missing_content`, `invalid_json`.

### Scenario rules on email API instances

Rules are evaluated **per recipient** (to, cc, bcc), like SMTP's RCPT TO. `d` = event delay (`STUBYARD_CALLBACK_DELAY_MS`,
default 1.5 s); "processed" is sent at d/3.

| Action | HTTP answer | Status in stubyard | Events (SendGrid · Mailgun · SES) |
|---|---|---|---|
| deliver (default) | 2xx | delivered | processed → delivered · accepted → delivered · Delivery |
| `reject` | 4xx (SendGrid 400 errors, Mailgun 400 message, SES 400 `MessageRejected`) | rejected | none |
| `rate_limit` | 429 (SendGrid + `X-RateLimit-*`, SES `TooManyRequestsException`) | rejected | none |
| `down` / instance disabled | 503 | rejected | none |
| `timeout` | no answer | timeout | none |
| `slow` | 2xx after `delayMs` | delivered | as deliver |
| `fail` | 2xx | failed | processed → bounce (hard) · accepted → failed permanent · Bounce Permanent/General |
| `bounce_hard` | 2xx | bounced | processed → bounce `type: bounce` 550 5.1.1 · failed permanent `reason: bounce` · Bounce Permanent/General |
| `bounce_soft` | 2xx | bounced | processed → deferred (d) → bounce `type: blocked` 452 4.2.2 (2d) · failed temporary → failed permanent · Bounce Transient/MailboxFull |
| `blocked` | 2xx (generic: 400 at send) | bounced | bounce `type: blocked` 550 5.7.1 · failed permanent · Bounce Permanent/Suppressed |
| `defer` | 2xx | scheduled → delivered | processed → deferred (d) → delivered (max(delayMs, 2d)) · failed temporary → delivered · (event format: DeliveryDelay) → Delivery |
| `delay` | 2xx | scheduled → delivered after `delayMs` | processed → delivered |
| `drop` | 2xx | dropped | dropped "Bounced Address" · failed permanent `suppress-bounce` · (event format: Reject; notifications: none) |
| `complaint` | 2xx | delivered → complained (2d) | processed → delivered → spamreport · accepted → delivered → complained · Delivery → Complaint |
| `bounce_delayed` | 2xx | delivered → bounced after `delayMs` (default 10 s) | processed → delivered → bounce · … → failed permanent · Delivery → Bounce |
| marketing opt-out (DND) on a `marketing` instance | 2xx (generic: 400 `unsubscribed`) | dropped | dropped "Unsubscribed Address" · failed `suppress-unsubscribe` · (event format: Reject) |

- `errorCode` / `errorMessage` on a rule feed the bounce: a 3-digit code (`550`) sets the SMTP code, `5.x.x` the
  enhanced status, the message the reason. For send-time errors a `4xx`/`5xx` `errorCode` sets the HTTP status.
- If any recipient of a call hits a send-time error (reject / rate_limit / down / timeout), the whole call fails like the
  real API; only those recipients are recorded as rejected.
- `X-Hub-Scenario` header works as for SMS (`reject`, `rate_limit`, `bounce_hard`, `complaint`, `delay:5000`, …).
- Duplicate-send warning and marketing opt-out work exactly as for SMS (same `capture()` / rule engine).

## J–L. API mocks, export/import, cleanup

### API mocks (§J)

You can mock any HTTP API the app calls (payments, maps, internal services). Point the app's base URL at
`http://localhost:4000/mock/<project>/api` (or `https://localhost:4443/...`). Each request is checked against the
project's mocks **from top to bottom**. The first mock that matches answers with its **active scenario**.

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/mocks -H 'content-type: application/json' -d '{
  "name": "Payment API",
  "method": "POST",
  "path": "/payments/:id/capture",
  "match": { "headers": { "X-Tenant": "acme" }, "bodyJson": { "amount.currency": "USD" } },
  "scenarios": [
    { "name": "OK",            "status": 200, "body": "{\"id\":\"{{params.id}}\",\"ref\":\"{{uuid}}\",\"at\":\"{{now}}\"}" },
    { "name": "Card declined", "status": 402, "body": "{\"error\":\"card_declined\",\"email\":\"{{body.customer.email}}\"}" },
    { "name": "Slow",          "status": 200, "delayMs": 8000, "body": "{}" },
    { "name": "Timeout",       "behaviour": "timeout" },
    { "name": "Connection drop", "behaviour": "drop" }
  ],
  "activeScenario": "OK"
}'

curl -s -X POST http://localhost:4000/mock/hyper/api/payments/p_1/capture \
  -H 'content-type: application/json' -H 'X-Tenant: acme' -d '{"amount":{"currency":"USD"}}'
```

**Matching**

| Field | Meaning |
|---|---|
| `method` | `GET`, `POST`, …, a list such as `"GET,HEAD"`, or `ANY` (the default) |
| `path` | Below `/mock/<project>/api`. `:name` matches one segment, and `*` matches the rest of the path (`{{params.*}}`). `*` inside a segment is a wildcard (`/img/*.png`). A trailing `/` is ignored. |
| `match.query` | `{ "name": "value" }`. The value must be equal, or `"*"` to only require the parameter to be present. |
| `match.headers` | Same as `match.query`. Header names are case-insensitive. |
| `match.bodyContains` | The raw body must contain this text. |
| `match.bodyJson` | `{ "user.email": "a@b.c", "items.0.qty": 2 }`. Dot paths into the JSON body. `"42"` equals `42`, and `"*"` means present. |

**Scenarios**: `name`, `status` (default 200), `headers`, `body`, `delayMs` (0–600000) and
`behaviour` (`respond` | `timeout` | `drop`). `timeout` holds the connection without ever answering.
`drop` closes the connection with no response. `content-type` defaults to JSON when the body is JSON, and to text otherwise.

**Templates** in the body and header values: `{{params.x}}` `{{query.x}}` `{{headers.x}}` `{{body.a.b}}` `{{body}}`
`{{uuid}}` `{{now}}` (ISO) `{{timestamp}}` (unix seconds) `{{method}}` `{{path}}`. Missing values become empty strings.

**Switch scenarios**

```bash
# Every following request gets "Card declined" (live, no restart)
curl -s -X PATCH http://localhost:4000/api/projects/hyper/mocks/Payment%20API/active-scenario \
  -H 'content-type: application/json' -d '{"scenario":"Card declined"}'
# One request only: header X-Hub-Scenario
curl -s ... -H 'X-Hub-Scenario: Timeout'     # a scenario name (case-insensitive)
#   built-ins: timeout | drop | 503 (or status:503) | delay:2000
```

**Endpoints** (`:mock` is the mock id or its name):

| Request | Purpose |
|---|---|
| `GET /api/projects/:p/mocks` | List the mocks in priority order, with `hits` and `lastHitAt` |
| `POST /api/projects/:p/mocks` | Create a mock. `name` defaults to `"METHOD /path"`; names are unique per project |
| `GET` / `PATCH` / `PUT` / `DELETE /api/projects/:p/mocks/:mock` | Read, update, or delete a mock. `{"position":1}` moves the mock to the top; `{"enabled":false}` turns it off |
| `PATCH /api/projects/:p/mocks/:mock/active-scenario` | Body `{"scenario":"<name>"}` |
| `GET /api/projects/:p/mocks/:mock/hits?limit=20` | Recent calls this mock answered, taken from the traffic log |
| `POST /api/projects/:p/mocks/reset-hits` | Set all hit counters back to 0 |

Every call is in the traffic log, with `resolved: { mock, mockId, scenario, scenarioSource: "active"|"header", behaviour, params }`.
Outcomes: `ok` for 2xx/3xx, and `forced_error` for 4xx/5xx, timeouts (`errorType: simulated_timeout`) and drops
(`simulated_drop`). When **no mock matches**, stubyard returns 404 with
`{"error":"Not found", "mocks":[{name, method, path, enabled, reason}]}`, where `reason` explains why each mock was
skipped (for example `path differs`, `method is POST`, `header "x-tenant" missing`). The 404 is logged as `unmatched`.

Dashboard: **API mocks** in the project sidebar (and in the Ctrl-K palette). It has the list in priority order, a
scenario switcher per mock, a copy-URL button, hit counts, recent hits (click a hit to open the log entry) and an editor.

---

### Export / import (§K) a project configuration

```bash
curl -s http://localhost:4000/api/projects/hyper/export > stubyard-hyper.json            # without secrets
curl -s "http://localhost:4000/api/projects/hyper/export?secrets=1" > stubyard-hyper.json # + authenticator keys
# ?download=1 adds Content-Disposition: attachment

curl -s -X POST http://localhost:4000/api/projects/import -H 'content-type: application/json' \
  -d "{\"json\": $(cat stubyard-hyper.json), \"slug\": \"hyper2\", \"mode\": \"create\"}"
# → 201 { project, mode, imported: {users: 10, providers: 2, rules: 3, mocks: 4, ...}, warnings: [] }
```

- The file contains the project's name, description and settings, plus test users (roles, passwords, pins, opt-outs, notes),
  provider instances (including `config`), user and instance rules, API mocks, and **only with `secrets=1`**
  the authenticator (TOTP) keys. Messages, emails, logs and hit counters are **not** included.
- `mode: "create"` (default) creates a new project. It uses `slug` from the request or from the file, and returns 409 if
  that slug is already taken. `mode: "replace"` overwrites the configuration of the existing project `slug`. Every
  section present in the file replaces the project's rows for that section. Sections missing from the file are left
  as they are. Captured messages and logs are kept, but messages lose their link to replaced users and instances.
- `json` may be the object or a JSON string. If the request body has no `json` key, the export can also be posted
  directly as the body.
- Rules keep their remaining count, "after N", expiry and enabled state. Rules whose user or instance is missing from
  the file are skipped and listed in `warnings`.
- Dashboard: **Settings → Export / import**. It has a download button (with an "include 2FA keys" checkbox), and an
  "Import file…" button that offers to create a new project or replace this one.

---

### Retention (§L), auto-reset, reset all rules, factory reset

| Setting (environment) | Default | Effect |
|---|---|---|
| `STUBYARD_LOG_RETENTION_DAYS` | `7` | Traffic logs older than this are deleted (`0` = keep forever). A project can override it with `settings.retentionDays`. |
| `STUBYARD_MAX_DB_MB` | `500` | When the live data in the database is larger than this, the **oldest logs are deleted first** (10 % per step) until it fits, then the file is compacted with `VACUUM`. `0` = no limit. |
| `STUBYARD_MAINTENANCE_INTERVAL_MS` | `600000` | How often the clean-up runs (first run 5 s after start). `0` = never. |

```bash
# Auto-reset: messages, emails and logs of this project older than N days are removed automatically
curl -s -X PATCH http://localhost:4000/api/projects/hyper -H 'content-type: application/json' \
  -d '{"settings":{"autoResetDays":3,"retentionDays":14}}'     # null switches either off

curl -s http://localhost:4000/api/system/storage          # DB size, row counts, retention config, last run, versions
curl -s -X POST http://localhost:4000/api/system/maintenance   # run the clean-up now → report

# "Reset all rules": every test user and provider instance goes back to normal delivery
curl -s -X POST http://localhost:4000/api/projects/hyper/rules/reset          # → {"deleted": 3}

# Factory reset: ALL projects, messages, Mailpit emails and logs. The HTTPS CA is kept.
curl -s -X POST http://localhost:4000/api/factory-reset -H 'content-type: application/json' \
  -d '{"confirm":"DELETE EVERYTHING"}'
```

- Auto-reset works as a rolling window. It does not wipe everything every N days. Each clean-up pass removes data
  that is **older than N days**, so recent test data is always kept.
- `POST /api/projects/:p/reset` (Reset project data) now also sets the **hit counters of rules and API mocks back to 0**.
- **Agents: never call factory reset unless the user explicitly asks for it.** It deletes every project.
- Dashboard: **Settings** has "Data retention" (per-project log retention and auto-reset), "Export / import" and "Reset all
  rules". The new global **System** page (sidebar footer, palette) shows storage, row counts, the last clean-up and
  versions, with "Run now" and a **Factory reset** button that asks you to type `DELETE EVERYTHING`.

---

#### Scheduled jobs

Finished scheduler jobs (done/failed, older than 24 h) are purged hourly, not only at start.

### §8 additions: traffic log

- New filters on `GET /api/logs`: `user=<test user id>` (with `project=`, also an email, role or name) matches
  entries whose `resolved.testUserIds` contains that user. `instance=<slug>` matches `resolved.instance`.
- Paging: `before=<log id>` (it already existed) returns the entries older than that id. The dashboard has a **Load older** button
  under the list, and **User** / **Instance** filters in a project's traffic log.
- The log drawer has **Copy as cURL** for HTTP entries.

### Events

New SSE event: `mocks.changed` (mock created, updated, deleted, scenario switched, hits reset, import).
Retention passes that delete logs publish `project.reset` with `projectId: null`.

## Rules for agents (0.3 additions)

- Never call `POST /api/factory-reset` or delete a project without the user asking for it. `reset_project_data` / project reset is fine before a test run.
- Don't overwrite a project with `import … mode: replace` unless asked; prefer `mode: create` with a new slug.
- Reset scenario rules and mock scenarios you changed when the test is done.

---

# Added in phase 5.5 (hardening)

## M. Doctor, outbound allowlist, seeding, CI

### Doctor: "why don't callbacks arrive?"

```bash
curl -s http://localhost:4000/api/projects/hyper/doctor
```

From where stubyard runs (usually its container), stubyard checks every URL it will call for the project: provider config
URLs (`statusCallbackUrl`, `inboundUrl`, `eventWebhookUrl`, …) and webhook-template target URLs (rendered with empty
data). For each one it runs **allowlist → DNS → TCP connect → HTTP `HEAD`** (2.5 s timeouts). It also checks Mailpit, the
HTTPS certificate names (against the Host you used) and the outbound policy. Also: MCP tool `doctor`, and
**Connect your app → Check the connection** in the dashboard.

```json
{"project":"hyper","ok":false,"summary":{"ok":3,"warn":1,"fail":1,"skip":0},
 "environment":{"inContainer":true,"listen":"0.0.0.0","outboundAllow":["localhost","…"],"insecureTls":[]},
 "checks":[{"kind":"url","label":"Twilio · statusCallbackUrl","url":"http://host.docker.internal:3000/sms/status",
   "status":"fail","message":"Cannot connect to host.docker.internal:3000 (ECONNREFUSED).",
   "hint":"ECONNREFUSED to host.docker.internal:3000: is your app listening on 0.0.0.0? …",
   "steps":[{"step":"allowlist","status":"ok","detail":"…"},{"step":"dns","status":"ok","detail":"host.docker.internal → 172.17.0.1"},
            {"step":"tcp","status":"fail","detail":"ECONNREFUSED: …"}]}]}
```

`status`: `ok`, `warn` (reachable but suspicious, e.g. the app answered 5xx, or `localhost` inside a container, which is
stubyard itself), `fail`, `skip`. Any HTTP answer counts as reachable: a `404` / `405` to `HEAD` is normal for POST-only
callback routes. `ok: false` when any check failed. Typical fixes, all spelled out in `hint`:

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED` to `host.docker.internal:<port>` | The app listens on 127.0.0.1 only (Linux). Start it on `0.0.0.0`, or run stubyard with `deploy/docker-compose.host-network.yml` |
| `ECONNREFUSED` to `localhost:<port>` (stubyard in a container) | `localhost` is stubyard itself. Use `host.docker.internal` or the app's service name |
| DNS fails for `host.docker.internal` | Add `--add-host=host.docker.internal:host-gateway` (compose: `extra_hosts`) |
| DNS fails for a service name | The app container is not on the `stubyard` network (Docker name `devhub`, kept from before the rename; see `deploy/docker-compose.app-example.yml`) |
| Timeout | A firewall drops traffic from the Docker bridge to that port |
| TLS error | Self-signed app certificate: `STUBYARD_OUTBOUND_INSECURE_TLS=1` (or a host list), or use `http://` |
| Blocked by the allowlist | See below |

### Outbound allowlist

stubyard only calls hosts that are obviously local, so an imported or copied config never calls a real or production URL:
`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `host.docker.internal`, `gateway.docker.internal`, `*.local`, `*.test`,
`*.internal`, `*.lan`, private IP ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, `fe80::/10`) and single-label
names (docker service names such as `app`). A name that resolves only to such private addresses is allowed too.

Other calls are **not sent**. The traffic log entry has `outcome: network_error`, `errorType: blocked_by_allowlist` and
the reason, and the caller's result has `error: "blocked_by_allowlist: …"` (e.g. `send_webhook`).
`STUBYARD_OUTBOUND_ALLOW=+staging.example.com,*.corp` adds entries, a list without `+` replaces the defaults, and `*`
disables the check. `STUBYARD_OUTBOUND_INSECURE_TLS=1` (or `myapp.test,*.local`) accepts self-signed certificates
when calling the app over HTTPS. Don't change these settings without asking the user.

### Seed projects at start

`STUBYARD_SEED=/config/stubyard-hyper.json` (one export, a file with an array of exports, or a directory of `*.json`
exports) imports each project whose slug doesn't exist yet when stubyard starts, and skips existing ones. Results are
logged. The seed is imported before stubyard listens, so once `/api/system` answers, the projects exist. Exports come
from `GET /api/projects/<p>/export` or the MCP tool `export_project`. The compose files have a commented example
(`./seed:/config:ro`).

### CI

[`docs/CI.md`](CI.md) and `deploy/github-actions-example.yml`: stubyard in GitHub Actions (build the image, start it with
`--network host` and `STUBYARD_SEED`, wait for `/api/system`, run the doctor, run the app's tests with the wait API, upload
the traffic log when something fails).

### Listening address and Linux callbacks

The image listens on `0.0.0.0` inside the container. The compose files and `docker run` examples publish the ports on
`127.0.0.1`. Outside Docker, stubyard listens on `127.0.0.1` unless `STUBYARD_HOST` is set. On Linux an app on the host that
listens on 127.0.0.1 can't be reached from stubyard's container: start it on `0.0.0.0` and use
`http://host.docker.internal:<port>`, or use `deploy/docker-compose.host-network.yml` (host networking, Linux only), where
`http://localhost:<port>` works.

---

# Added in version 0.5

## N. Test runs (parallel test workers)

When several test workers share one stubyard project, they share its test users, rules and mock scenarios: worker 1's
"next SMS fails" rule can hit worker 2, and `wait_for_message` may return another worker's code. A **test run**
isolates one worker:

- its own **ephemeral test users** (minted per run, deleted with it);
- its own **rules** (user and provider-instance rules) and **API mock scenario overrides**;
- everything addressed to its users, or explicitly tagged with it, is **attributed to the run**; waits, message lists,
  traffic and the report can be filtered to it.

Without runs, stubyard behaves exactly as before.

### N.1 Start a run, mint users

```http
POST /api/projects/hyper/runs
{ "key": "w3", "label": "checkout spec · worker 3", "ttlMinutes": 120,
  "users": [{ "role": "customer", "count": 2 }, { "role": "admin" }] }
```

`201` →

```json
{ "id": "…", "key": "w3", "status": "active", "startedAt": "…", "expiresAt": "…",
  "users": [{ "id": "…", "name": "Customer 1 (w3)", "role": "customer", "email": "customer1.w3@hyper.test",
              "phone": "+923009123456", "password": "Password123!", "runId": "…" }, …],
  "urls": { "mockPrefix": "/run/w3/mock/hyper", "hookPrefix": "/run/w3/hook/hyper", "smtpUsername": "hyper+w3" },
  "header": { "X-Hub-Run": "w3" },
  "counts": { "users": 3, "messages": 0, "logs": 0, "problems": 0 } }
```

| Field | Meaning |
|---|---|
| `key` | `[a-z0-9]{1,24}`, unique among the project's **active** runs (default: random). Use the worker index, e.g. `w3`. |
| `ttlMinutes` | Default 120, max 1440. Past it, the run is stopped automatically. |
| `captureUnattributed` | Serial CI: messages / requests nobody else claims belong to this run. Only one per project (409). |
| `claims` | Extra strings (e.g. an order-id prefix) that attribute API-mock / webhook calls to this run (§N.2, rule 6). |
| `replace` | `true`: an active run with the same key (a crashed worker) is stopped and purged first. Without it: `409`. |
| `users` | `[{role, count?, name?}]`, minted right away. |

More users later: `POST /api/projects/hyper/runs/w3/users` `{ "role": "customer", "count": 1, "email": true, "phone": true }` → `201 [TestUser]`.

Minted addresses: email `<role><n>.<key>@<emailDomain>`, phone `<phonePrefix>9<6 random digits>` (same number for
WhatsApp). They are added to the run's `claims`. Minted users are not pinned and do **not** appear in
`GET /users` or `/overview` unless `?run=w3` is given.

### N.2 How traffic is attributed

The app usually cannot send a per-worker header (all workers share one app instance), so attribution mainly comes from
**the recipient**: give each worker its own minted users, and everything sent to them belongs to that run. First hit wins:

| # | Source | Applies to | Example |
|---|---|---|---|
| 1 | Header | `/mock`, `/hook` | `X-Hub-Run: w3` |
| 2 | URL prefix | `/mock`, `/hook` (SDKs that take a base URL but no headers) | `http://localhost:4000/run/w3/mock/hyper/sms-primary/…` |
| 3 | SMTP username suffix | SMTP | `hyper+w3`, `hyper.marketing+w3` |
| 4 | Recipient is a run user | SMTP, SMS/WhatsApp, email APIs | `customer1.w3@hyper.test` |
| 5 | Plus-tag | email | `admin+w3@hyper.test` → user `admin@hyper.test`, run `w3` (an exact address match is tried first) |
| 6 | Content claim | API mocks and webhooks only | exactly one active run has a claim string in the path, query or first 64 KB of the body |
| 7 | Default run | everything | the project's active run with `captureUnattributed: true` |
| 8 | none | | as without runs |

An **unknown or stopped** run named explicitly (1–3) fails loudly: HTTP `404 {"error":"Unknown run","run":"w3"}`
(traffic outcome `unmatched`, `resolved.unknownRun`), SMTP `535`. Only active runs receive attribution.

Messages and traffic-log entries carry `runId`; log entries also have `resolved.run` (the key) and `resolved.runVia`
(`header`, `prefix`, `smtp-username`, `user`, `plus-tag`, `claim`, `default`).

**Limit:** two workers that log in as the same seeded user (`admin@hyper.test`) through a shared app cannot be told
apart. Each worker must use its own minted users (or plus-tags of a shared user).

### N.3 Scoping control calls to a run

Add `?run=<key|id>` (or the `X-Hub-Run` header) to these endpoints:

| Endpoint | Inside a run |
|---|---|
| `users/:id/rules` (GET/POST/PUT/DELETE, presets) | The run's rules on that user. Rules on a run's own user always belong to the run. |
| `providers/:instance/rules` (same) | Instance rules that only apply to the run's messages. |
| `PATCH mocks/:mock/active-scenario` | Writes a per-run override; everyone else keeps the mock's active scenario. `GET mocks?run=` shows `runScenario`. |
| `GET messages`, `messages/cursor`, `messages/wait` (incl. `count` / `exactly`), `messages/expect-none` | Only the run's messages. `wait` without `since`/`after`/`lookback` counts from the run's start (instead of the last 10 s). |
| `GET /api/logs?project=hyper&run=w3` | Only the run's traffic (a run id works without `project`). |
| `authenticators` (create, `code?label=` / `?user=`) | Keys created with `?run=` belong to the run; label lookups try the run's keys first, then the project's. |
| `users/:id`, `users/:id/latest`, `users/:id/clear`, `users/:id/reply` | User references resolve inside the run (below); `latest` / `clear` only see the run's messages. |
| `GET /api/stream?project=hyper&run=w3` | Only the run's message / log events (plus `runs.changed`). |

**User references:** inside a run, `user=customer` (name, role or email local part) means **the run's** customer; ids,
emails and phone numbers resolve any user. Without a run, names and roles only match project users.

**Rule precedence** (first match wins): `X-Hub-Scenario` header → instance rules of the run → instance rules of the project
→ marketing opt-out → user rules of the run (instance-specific, then general) → user rules of the project → instance
default. Another run's rules are never read or used up.

**Mock scenario precedence:** `X-Hub-Scenario` header → the run's override → the mock's active scenario
(`resolved.scenarioSource` is `header`, `run` or `active`).

### N.4 Stop, report, delete

| Call | Effect |
|---|---|
| `GET /api/projects/hyper/runs?status=active` | Runs with counts `{users, messages, logs, problems}`. |
| `GET …/runs/w3` | One run (with its users). Key or id; a key finds the active run, else the newest stopped one. |
| `PATCH …/runs/w3` `{label?, ttlMinutes?, claims?, meta?}` | Change it (`ttlMinutes` restarts the TTL from now). |
| `POST …/runs/w3/stop` | Freezes and returns `{run, report}`; deletes the run's rules and mock overrides. Users, messages and logs stay readable. |
| `POST …/runs/w3/stop?purge=1` | Also deletes its users, messages, emails (Mailpit) and logs; the run and its frozen report stay. |
| `GET …/runs/w3/report` | Live while active, frozen after stop. |
| `DELETE …/runs/w3` | Removes everything: `{deleted: {users, messages, logs, rules, emails}}`. |

Report:

```json
{ "run": { "id": "", "key": "w3", "label": "", "status": "stopped", "startedAt": "", "stoppedAt": "", "durationMs": 0, "meta": {} },
  "users": [{ "id": "", "name": "", "role": "", "email": "", "phone": "" }],
  "messages": { "total": 4, "byChannel": { "email": 2, "sms": 2 }, "byStatus": { "delivered": 3, "failed": 1 },
                "items": [{ "id": "", "channel": "", "to": "", "subject": "", "status": "", "otp": "", "appliedRule": "", "createdAt": "" }] },
  "traffic": { "total": 9, "byOutcome": { "ok": 8, "unmatched": 1 },
               "problems": [{ "id": "", "method": "POST", "url": "/mock/hyper/api/x", "resStatus": 404, "outcome": "unmatched", "errorMessage": null }] },
  "rules": [{ "id": "", "owner": "user:Customer 1 (w3)", "description": "#1 Fail", "hits": 1 }],
  "mocks": [{ "mock": "Charge", "scenario": "Declined", "hits": 2 }],
  "warnings": ["1 request had problems (unmatched)"] }
```

`problems` are traffic entries with outcome `unmatched`, `invalid`, `internal_error` or `network_error`.

**Lifecycle:** the maintenance pass stops runs past `expiresAt` and purges stopped runs older than
`STUBYARD_RUN_RETENTION_HOURS` (default 24). Project reset and factory reset remove all runs. Export skips run users,
rules and keys.

### N.5 MCP

New tools: `start_run`, `mint_test_user`, `stop_run`, `get_run_report`. These tools take an optional `run` argument:
`wait_for_message`, `get_messages`, `get_latest_code`, `set_user_scenario`, `set_provider_rule`, `get_traffic`,
`get_2fa_code` and `set_mock_scenario`.

### N.6 Recipe: Playwright with parallel workers

```ts
// global fixture, per worker
const key = `w${test.info().parallelIndex}`;
const run = await (await fetch(`${HUB}/api/projects/hyper/runs`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key, replace: true, users: [{ role: 'customer' }] }),
})).json();
const user = run.users[0];                          // sign up / log in with user.email, user.password

// in a test
await page.getByLabel('Email').fill(user.email);
await page.getByRole('button', { name: 'Send code' }).click();
const msg = await (await fetch(`${HUB}/api/projects/hyper/messages/wait?run=${key}&user=customer&otp=1`)).json();

// make only this worker's next SMS fail
await fetch(`${HUB}/api/projects/hyper/users/customer/rules?run=${key}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms', action: 'fail', count: 1 }),
});

// teardown
await fetch(`${HUB}/api/projects/hyper/runs/${key}/stop?purge=1`, { method: 'POST' });
```

### Rules for agents (runs)

- Running tests in parallel against one project? Start one run per worker and use **its** minted users; never share a
  seeded user between workers.
- Pass `run` to every wait / rule / mock-scenario call of that worker.
- Use `replace: true` when (re)starting a worker so a crashed previous run does not block the key.
- Stop runs at the end (`stop?purge=1` keeps the report but frees the data); TTL expiry is only the safety net.

## O. Login providers (fake OAuth 2.0 / OpenID Connect)

stubyard can stand in for **Google, Microsoft, GitHub, Facebook, LinkedIn, Apple, X (Twitter), Discord, GitLab, Slack**
and a **generic OIDC** provider (flavours `auth0`, `okta`, `keycloak`, `cognito`). The app keeps its normal OAuth / OIDC
library; you only change the host. The browser lands on a stubyard account picker that lists the project's test users,
and the app gets real-looking codes, RS256 id_tokens, access/refresh tokens and profile responses.

### URLs

Base: **`B = https://localhost:4443/auth/<project>/<provider-slug>`** (also `http://…:4000`). Below `B`, paths
mirror the real provider, so only the host part of each URL changes:

| Preset | Real host | Endpoints under `B` |
|---|---|---|
| `google` | accounts.google.com / oauth2.googleapis.com | `/.well-known/openid-configuration`, `/o/oauth2/v2/auth`, `/token`, `/oauth2/v3/certs`, `/oauth2/v1/certs` (PEM), `/v1/userinfo`, `/oauth2/v3/userinfo`, `/oauth2/v2/userinfo` (legacy shape), `/tokeninfo`, `/revoke` |
| `microsoft` | login.microsoftonline.com | `/{tenant}/v2.0/.well-known/openid-configuration`, `/{tenant}/oauth2/v2.0/{authorize,token,logout}`, `/{tenant}/discovery/v2.0/keys`, `/common/discovery/instance`, `/graph/v1.0/me`, `/graph/oidc/userinfo` |
| `github` | github.com / api.github.com | `/login/oauth/authorize`, `/login/oauth/access_token`, `/user`, `/user/emails` (also under `/api/v3/`) |
| `facebook` | www.facebook.com / graph.facebook.com | `(/vN.N)/dialog/oauth`, `(/vN.N)/oauth/access_token` (GET/POST), `(/vN.N)/me?fields=…`, `/debug_token`, `DELETE /me/permissions` |
| `linkedin` | www.linkedin.com / api.linkedin.com | `/oauth/.well-known/openid-configuration`, `/oauth/v2/authorization`, `/oauth/v2/accessToken`, `/v2/userinfo`, `/oauth/openid/jwks` (issuer `B/oauth`) |
| `apple` | appleid.apple.com | `/.well-known/openid-configuration`, `/auth/authorize`, `/auth/token`, `/auth/keys`, `/auth/revoke` |
| `x` | x.com / api.x.com | `/i/oauth2/authorize`, `/2/oauth2/token`, `/2/oauth2/revoke`, `/2/users/me` |
| `discord` | discord.com | `/oauth2/authorize`, `/api(/v10)/oauth2/token`, `/api/oauth2/token/revoke`, `/api(/v10)/users/@me` |
| `gitlab` | gitlab.com | `/.well-known/openid-configuration`, `/oauth/{authorize,token,userinfo,revoke}`, `/oauth/discovery/keys`, `/api/v4/user` |
| `slack` | slack.com | `/.well-known/openid-configuration`, `/openid/connect/authorize`, `/api/openid.connect.token`, `/api/openid.connect.userInfo`, `/openid/connect/keys` |
| `oidc` | your IdP | `/.well-known/openid-configuration`, `/authorize`, `/token`, `/userinfo`, `/jwks`, `/logout`, `/revoke`, `/introspect` + Auth0 (`/oauth/token`, `/.well-known/jwks.json`, `/v2/logout`), Cognito (`/oauth2/*`), Keycloak (`/protocol/openid-connect/*`), Okta (`/v1/*`) aliases |

`GET /api/projects/<p>/auth/<provider>` returns every URL for the browser and for backends (`urls.browser`,
`urls.backend` = `https://stubyard:4443/…`, `urls.backendLocal` = `http://localhost:4000/…`) plus framework snippets.
The project setup guide (`GET /api/projects/<p>/setup`) has a section per login provider.

### Issuer: browser vs. container

- **`issuerMode: "request-host"` (default).** Discovery, token, userinfo and JWKS URLs — and the id_token `iss` — are
  built from the scheme + Host the *app* used. The authorize and logout URLs always use the browser base
  (`browserBaseUrl`, else `STUBYARD_PUBLIC_URL`, default `https://localhost:4443`). A backend in Docker configured with
  issuer `https://stubyard:4443/auth/hyper/google` passes strict discovery and `iss` checks, while the user's browser is
  sent to `https://localhost:4443/…`. No RFC 9207 `iss` callback parameter is sent.
- **`issuerMode: "fixed"` + `issuer`.** One base everywhere (e.g. `https://host.docker.internal:4443`; on Linux add
  `extra_hosts: ["host.docker.internal:host-gateway"]` to the app). Needed for implicit / hybrid flows (id_token from
  the browser) or when a SPA and an API validate the same token. A bare origin gets `/auth/<project>/<provider>`
  appended; a URL with a path is used verbatim.
- **`issOverride`.** Literal `iss` (e.g. `https://accounts.google.com`) for apps that hardcode it. It only fixes the
  string: the app must still fetch keys from stubyard.
- HTTPS uses the stubyard CA. Trust it in the app: `NODE_EXTRA_CA_CERTS=stubyard-ca.crt` (Node), `SSL_CERT_FILE` /
  `CURL_CA_BUNDLE` (PHP, Python, Ruby, curl), `keytool -importcert … -cacerts` (Java). HTTP on :4000 works for
  Passport, Socialite and Spring; openid-client / Auth.js need HTTPS (or `allowInsecureRequests`); MSAL needs HTTPS.

### Library notes (tested in `server/test/auth.sdk.test.ts`)

- **openid-client v6** – `client.discovery(new URL(issuer), clientId, secret)`; code + PKCE, userinfo, refresh tested for
  google, microsoft, gitlab, linkedin, slack, oidc, keycloak, auth0.
- **jose** – `createRemoteJWKSet(jwks_uri)` + `jwtVerify` (also across key rotation; `bad_signature` / `wrong_aud` are rejected).
- **google-auth-library** – `new OAuth2Client({ clientId, clientSecret, redirectUri, endpoints: { oauth2AuthBaseUrl,
  oauth2TokenUrl, oauth2RevokeUrl, oauth2FederatedSignonPemCertsUrl: B+'/oauth2/v1/certs', oauth2FederatedSignonJwkCertsUrl,
  tokenInfoUrl }, issuers: [B] })`; `generateAuthUrl`, `getToken`, `verifyIdToken`, `getTokenInfo` work.
- **@azure/msal-node** – `auth: { authority: 'https://stubyard:4443/auth/<p>/microsoft/<tenantId>/v2.0', knownAuthorities: ['stubyard:4443'] }`,
  `system: { protocolMode: 'OIDC' }`; `getAuthCodeUrl` + `acquireTokenByCode` work. (The default AAD mode was not
  tested; it expects Microsoft's own path layout — use OIDC mode.) The tenant id is in the dashboard URLs / `config.tenantId`.
- **Auth.js / NextAuth** – set `issuer` (OIDC presets) or `authorization`, `token`, `userinfo` URLs (OAuth 2 presets).
- **Passport** – `authorizationURL`, `tokenURL`, `userProfileURL` (`profileURL` for Facebook).
- **Spring Security** – `spring.security.oauth2.client.provider.<id>.issuer-uri` (OIDC) or `authorization-uri` / `token-uri` / `user-info-uri`.
- **Laravel Socialite** – only GitHub Enterprise-style or a custom / SocialiteProviders driver; core Google and Facebook
  drivers hardcode their URLs (subclass them).
- **Cannot be faked:** Google One Tap / Identity Services, Facebook JS SDK, Sign in with Apple JS, Firebase Auth, native
  mobile SDKs (they talk to the real provider).

### Picking the user

The authorize request shows the picker (`data-testid="stubyard-user-<id>"`, `stubyard-deny`, `stubyard-outcome-<error>`,
Apple: `stubyard-apple-hide`). It works without JavaScript. The picker is skipped, in this order, by:

1. `login_hint=<user>` (GitHub: `login=`) — id, email, name or role;
2. cookie `stubyard_login_as=<user>` on the browser host (path `/auth/<p>/<provider>` or `/auth/<p>`) — what the Playwright helper sets;
3. `config.autoLogin`;
4. the stubyard SSO session cookie from an earlier login (not with `prompt=login` / `select_account`).

`prompt=none` without any of these redirects with `error=login_required`.

### Lax (default) vs. strict

Always enforced: code lifetime (`codeTtlSeconds`, default 60), single use, PKCE verifier, `redirect_uri` equal to the
authorize request, refresh-token rotation. Lax mode accepts — but records as **warnings** (picker banner, traffic log
`resolved.warnings`, `GET …/auth/<provider>/warnings`) — unknown `client_id`, unregistered `redirect_uri`, wrong or
missing secret, missing `state` / `nonce`, missing PKCE where the provider requires it (X), unknown scopes, wrong client
auth method (LinkedIn: `client_secret_post` only), Apple `client_secret` JWT problems and `form_post` rules.
`config.strict: true` turns each into the provider's real error.

Built in: reusing a code → `invalid_grant` and every token issued from it is revoked; reusing a rotated refresh
token → `invalid_grant` and the whole token family is revoked.

### Scenarios

Rules per provider (everyone) or per test user, same count / `after` / `minutes` semantics as message rules. Precedence:
`X-Hub-Scenario` header or `hub_scenario=` parameter (comma-separated, e.g. `no_email,short_lived=30`), then user rule,
then provider rule. `stage`: `any`, `authorize`, `token`, `refresh`, `userinfo`, `jwks`.

| Group | Actions |
|---|---|
| authorize (redirect with `error=`) | `access_denied`, `login_required`, `interaction_required`, `consent_required`, `mfa_required` (as `interaction_required`), `server_error`, `temporarily_unavailable`, `state_mismatch` (success with a different `state`) |
| token / refresh | `invalid_grant`, `expired_code`, `invalid_client`, `no_refresh_token`, `short_lived` (`ttl` seconds) |
| claims | `no_email`, `email_unverified`, `private_email` (GitHub: `/user` email `null`, still in `/user/emails`; Apple: relay address) |
| id_token defects | `bad_signature`, `wrong_aud`, `wrong_iss`, `wrong_nonce`, `expired_id_token`, `unknown_kid` |
| transport | `slow` (`delayMs`), `timeout`, `down` (503), `rate_limit` (429 + `Retry-After`) |

Error bodies use each provider's own shape (GitHub `200 error=bad_verification_code`, Facebook `OAuthException`,
Microsoft `AADSTS…` with `error_codes`, Slack `{ok:false,error}`, X `invalid_request`, …).

### Identities

Each user × provider has a stable `sub` in the provider's format (Google 21 digits, GitHub integer id, Apple
`001234.<hex>.1234`, Slack `U…`, Auth0 `auth0|…`, Okta `00u…`, Microsoft pairwise + `oid` / `tid`, …), stored in
`auth_identities` and kept by export → import. Per-provider overrides: `PATCH /api/projects/<p>/auth/<provider>/identities/<user>`
`{ "sub"?, "claims": { "email", "email_verified", "picture", "hd", "login", "name", "hideEmail" }, "consented"? }` (`null`
removes a key). The same email at two providers = two providers, two subs. Apple sends the `user` JSON (name + email)
only on the first authorization per user; `{"consented": false}` resets that.

### Control API

Under `/api/projects/<p>/auth`:

| Call | Purpose |
|---|---|
| `GET /` · `POST /` `{preset, slug?, name?, config?}` | list / create (`preset` also accepts `auth0`, `okta`, `keycloak`, `cognito`, `twitter`) |
| `GET` · `PATCH` `{name?, slug?, enabled?, config?}` · `DELETE /<provider>` | one provider (PATCH merges `config`; `null` removes a key) |
| `GET/POST/PUT/DELETE /<provider>/rules`, `/<provider>/users/<user>/rules`, `PATCH/DELETE /<provider>/rules/<id>`, `DELETE /<provider>/all-rules` | scenarios `{action, stage?, count?, minutes?, until?, after?, delayMs?, ttl?, label?}` |
| `POST /<provider>/keys/rotate` `{dropOld?}` | new signing key; the old one stays in JWKS unless dropped |
| `GET /<provider>/identities`, `GET/PATCH /<provider>/identities/<user>` | subs and claim overrides |
| `GET /<provider>/warnings` | recent lax-mode warnings |
| `POST /<provider>/token` `{user, clientId?, scope?, nonce?, audience?, expiresIn?, claims?, scenario?, refresh?, baseUrl?}` | tokens without a browser (`baseUrl` = the issuer base your backend validates, default the browser base) |
| `POST /<provider>/code` `{user, clientId?, redirectUri, state?, nonce?, codeChallenge?, scope?, scenario?}` | a code + `redirectTo` callback URL; the app does the real exchange |
| `GET /api/auth-presets` | presets, scenario actions, stages |

Config keys: `strict`, `clients: [{clientId, clientSecret, redirectUris}]`, `issuerMode`, `issuer`, `issOverride`,
`browserBaseUrl`, `autoLogin`, `codeTtlSeconds`, `accessTokenTtl`, `idTokenTtl`, `refresh` (`auto` | `always` | `never`),
`rotateRefresh`, `extraClaims` (JSON template: `{"roles":["{{user.role}}"]}`; also `{{user.email}}`, `{{user.name}}`,
`{{user.id}}`, `{{sub}}`), `audience`, `accessTokenFormat` (`jwt` | `opaque`, generic OIDC), `flavor`, `tenantId`
(Microsoft), `includeEmail` (Microsoft), `hostedDomain` (Google `hd`), `teamId` + `clientPublicKey` (Apple
client_secret checks), `teamName` (Slack).

### MCP tools

`list_login_providers`, `create_login_provider`, `login_as` (tokens, or `{code, redirectTo}` when `redirect_uri` is
given), `set_login_scenario`, `reset_login_scenarios`.

### Playwright helper (`packages/client`, `@stubyard/client/auth`)

```ts
import { loginAs, getTokens } from '@stubyard/client/auth';
await loginAs(page.context(), { baseUrl: 'https://localhost:4443', project: 'hyper', provider: 'google', user: 'admin' });
await page.getByText('Sign in with Google').click();      // no picker: signed in as admin
const t = await getTokens({ project: 'hyper', provider: 'google', user: 'customer1' }); // API tests
```

Without the helper, click `page.getByTestId('stubyard-user-<id>')` on the picker.

### Traffic log

Every request under `/auth/` is logged with `resolved = { kind: 'auth', project, provider, preset, endpoint,
clientId, user, testUserIds, scenario, warnings, … }`. Expired codes, tokens and sessions are purged by the
maintenance pass.

### Not simulated

Provider JavaScript / native SDKs (One Tap, Facebook JS, Apple JS, Firebase, mobile); real issuers and keys
(`issOverride` only fixes the string); Apple client_secret signature without `clientPublicKey`; Apple server-to-server
notifications; real cross-site cookie behaviour (`localhost:4443` and `localhost:3000` are same-site); MSAL AAD mode,
B2C, Conditional Access, on-behalf-of, device code; X OAuth 1.0a; Facebook `fb_exchange_token`; SAML, WS-Fed, SCIM,
WebAuthn, real MFA / consent screens; provider APIs beyond the profile endpoints; dynamic client registration, PAR,
DPoP, mTLS, JWE id_tokens.

---

# Added in version 0.6

## P. Verify APIs (stubyard generates the code)

Both run on the existing SMS instances, under the same base URL `http://localhost:4000/mock/<project>/<instance>`.
stubyard generates the code, delivers it to the test user's timeline (OTP set to the exact code), and checks it.
Scenario rules (§D) apply to the delivery; test runs (§N) attribute the message by recipient like any other message.

### P.1 Twilio Verify v2 (preset `twilio` / `twilio-whatsapp`)

Real Twilio serves Verify from `verify.twilio.com`, Messaging from `api.twilio.com`. **Rewrite both hosts** to the
same stubyard base URL:

```js
class StubyardClient extends twilio.RequestClient {
  request(opts) {
    opts.uri = opts.uri.replace('https://api.twilio.com', BASE).replace('https://verify.twilio.com', BASE);
    return super.request(opts);
  }
}
const client = twilio(sid, token, { httpClient: new StubyardClient() });
await client.verify.v2.services(VA_SID).verifications.create({ to: '+923001234567', channel: 'sms' });
const check = await client.verify.v2.services(VA_SID).verificationChecks.create({ to: '+923001234567', code });
// check.status === 'approved'
```

Python: same `TwilioHttpClient` subclass with both `.replace(...)` calls.

| Endpoint (after the base URL) | Behaviour |
|---|---|
| `POST /v2/Services` (`FriendlyName`, `CodeLength` 4–10, default 6, other flags stored) | `201` service JSON (`sid` `VA…`, `code_length`, `url: https://verify.twilio.com/v2/Services/VA…`, `links`) |
| `GET /v2/Services`, `GET/POST/DELETE /v2/Services/:sid` | list / fetch / update (`FriendlyName`, `CodeLength`) / delete (`204`) |
| `POST /v2/Services/:sid/Verifications` (`To`, `Channel` sms·whatsapp·email·call, `CustomCode`, `Locale`, `CustomFriendlyName`, `CustomMessage`, `Amount`, `Payee`) | `201` verification JSON (`sid` `VE…`, `status: pending`, `valid: false`, `send_code_attempts[]`). Same `To` + service while pending → **same verification, same code**, one more send attempt |
| `GET /v2/Services/:sid/Verifications/:sid` | fetch |
| `POST /v2/Services/:sid/Verifications/:sid` (`Status=canceled` / `approved`) | update a pending verification |
| `POST /v2/Services/:sid/VerificationCheck` (`Code` + `To` or `VerificationSid`) | `200` `{status: "approved", valid: true}`; wrong code → `200 {status: "pending", valid: false}` |

Messages: SMS `Your <FriendlyName> verification code is: 123456`; WhatsApp `*123456* is your verification code…`;
email (subject `<FriendlyName> verification code`, relayed to Mailpit); **call** → stored on the SMS channel with
`metadata.voice = true`, text `[Voice call] … 1 2 3 4 5 6 …` (badge "voice call" in the timeline).
`metadata.verify = {api, serviceSid, verificationSid, channel, locale}`.

Errors (Twilio JSON `{code, message, more_info, status}`):

| Case | HTTP | code |
|---|---|---|
| Missing `FriendlyName` / `To` / `Channel` / `Code` | 400 | 20001 `Missing required parameter X in the post body` |
| Invalid `Channel`, `To`, `CustomCode`, `Locale`, `CodeLength`, `Status`; neither `To` nor `VerificationSid` | 400 | 60200 `Invalid parameter…` |
| 6th send for the same pending verification (5 max) | 429 | 60203 `Max send attempts reached` |
| 6th check (5 checks max); status becomes `max_attempts_reached` | 429 | 60202 `Max check attempts reached` |
| Check / fetch after approval, cancel or expiry (10 min, `verifyExpirySeconds` to shorten); unknown service / verification | 404 | 20404 `The requested resource … was not found` |
| Rule `reject` | 400 | 60200 (or the rule's `errorCode`) |
| Rule `rate_limit` | 429 | 60203 |
| Rule `blocked` / marketing opt-out | 403 | 60410 `Verification delivery attempt blocked` |
| Rule `down` / instance disabled | 503 | 20503 |
| Rule `timeout` | no answer | — |
| Rule `fail` / `drop` / `delay` | 201 (pending) | message `failed` / `dropped` / `scheduled → delivered` (the user never / later gets the code) |

Config (instance): `verifyExpirySeconds` (default 600), `verifyAutoCreateServices` (default on: an unknown `VA…` sid
used in `Verifications` is created on first use — the app's hard-coded sid from `.env` just works; `"false"` → 20404
like Twilio), `verifyFriendlyName` (name for auto-created services, default the project name), `verifyEmailFrom`,
`fromNumber`. Account SID in responses: from HTTP Basic auth (`AC…`), else `config.accountSid`.

### P.2 Vonage Verify v2 (preset `vonage`)

Verify v2 uses `apiHost` (`api.nexmo.com`), SMS uses `restHost`: point **both** at stubyard.

```js
const vonage = new Vonage({ applicationId, privateKey }, { apiHost: BASE, restHost: BASE });
const { requestId } = await vonage.verify2.newRequest({ brand: 'HYPER', workflow: [{ channel: 'sms', to: '923001234567' }] });
await vonage.verify2.checkCode(requestId, code);   // 'completed'
await vonage.verify2.cancel(requestId);            // true / false
```

| Endpoint | Behaviour |
|---|---|
| `POST /v2/verify` `{brand ≤16, workflow: [{channel: sms·whatsapp·email·voice, to, from?}] (1–3), code_length 4–10 (default 4), code?, channel_timeout 15–900 (default 300), client_ref?, locale?}` | `202 {request_id}` (UUID); first workflow delivered |
| `POST /v2/verify/:id` `{code}` | `200 {request_id, status: "completed"}` |
| `POST /v2/verify/:id/next_workflow` | delivers the next workflow (`200 {status:"ok"}`; none left → `409`) |
| `DELETE /v2/verify/:id` | `204`; unknown / finished → `404` (SDK `cancel()` → `false`) |

Errors are RFC 7807 (`application/problem+json`: `type`, `title`, `detail`, `instance`):

| Case | HTTP | title |
|---|---|---|
| No `Authorization` header (any JWT / Basic is accepted) | 401 | Unauthorized |
| Validation (`invalid_parameters: [{name, reason}]`, all at once) | 422 | Invalid request params |
| Active request to the same `to` | 409 | Conflict (`request_id` of the active one) |
| Wrong code (1st, 2nd) | 400 | Invalid Code |
| 3rd wrong code → request `failed` (+ `failed` callback); further checks | 410 | Gone ("An incorrect code has been provided too many times. Workflow terminated.") |
| Expired (`channel_timeout × workflows`, or `verifyExpirySeconds`) | 410 | Gone (+ `expired` callback, sent by a scheduled job at expiry) |
| Unknown / completed / cancelled | 404 | Not Found |
| Rule `rate_limit` | 429 | Rate Limit Hit |
| Rule `blocked` / opt-out | 403 | Forbidden (fraud check) |
| Rule `reject` | 422 | Invalid request params (`workflow[0].to`) |
| Rule `down` | 503 | Service Unavailable |

Summary callbacks (`completed`, `failed`, `expired`) go to `config.verifyCallbackUrl` (fallback `statusCallbackUrl`):

```json
{ "request_id": "…", "submitted_at": "…", "status": "completed", "type": "summary", "channel_timeout": 300,
  "workflow": [{ "channel": "sms", "initiated_at": "…", "status": "completed" }], "price": "0.10000000", "client_ref": "…" }
```

`GET /api/projects/<p>/verifications` lists both kinds (newest first, with codes and attempts) for debugging.

## Q. Inbound email (a test user replies by email)

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/reply -H 'content-type: application/json' \
  -d '{"channel":"email","text":"My order is late","inReplyTo":"<stubyard message id>","subject":"optional","html":"optional","instance":"optional","to":"optional"}'
```

- `inReplyTo` (a stubyard message id) threads the reply: `In-Reply-To: <original Message-ID>`, `References`, subject
  `Re: <original>`, recipient = the original sender. Without it: `to` → `config.inboundAddress` → the sender of the
  user's last email → `inbound@<project>.test`.
- The reply is a real MIME message (Mailpit, HTML view), stored as an **inbound** email in the user's timeline, and
  POSTed to the email instance's **`inboundUrl`** (default instance: the project's default email instance; SMTP too).
  The call is in the traffic log (outbound); response `{message, webhook: {ok, status, error, logId}}`.

| Instance preset | Format sent to `inboundUrl` |
|---|---|
| `sendgrid` | **Inbound Parse**, `multipart/form-data`: `headers, dkim, to, from, text, html, sender_ip, spam_report, envelope, attachments, subject, spam_score, charsets, SPF`. `inboundFormat: "raw"` → "POST the raw, full MIME message": `email` instead of `headers/text/html` |
| `mailgun` | **Route forward**, urlencoded: `recipient, sender, from, subject, body-plain, stripped-text, stripped-signature, body-html, stripped-html, attachment-count, timestamp, token, signature, message-headers` (JSON pairs) + `Message-Id, From, To, Subject, Date, In-Reply-To, References…`; `signature = hex(HMAC-SHA256(webhookSigningKey ‖ apiKey ‖ "stubyard-signing-key", timestamp + token))` |
| `ses` | **SNS Notification** (`Subject: Amazon SES Email Receipt Notification`), `Message` = `{notificationType: "Received", mail{…, commonHeaders}, receipt{recipients, spam/virus/spf/dkim/dmarcVerdict PASS, action{type:"SNS", topicArn, encoding:"UTF8"}}, content: <raw MIME>}`; `rawMessageDelivery: "true"` → the JSON without the envelope; topic `inboundTopicArn` ‖ `topicArn`. Not SNS-signed |
| `generic-email` | JSON `{from, fromName, to, subject, text, html, messageId, inReplyTo, references, receivedAt, headers}` or `inboundTemplate` (`{{var}}`, values JSON-escaped) |
| `smtp` | JSON as above (default) or `inboundFormat: "sendgrid"` / `"sendgrid-raw"` |

No attachments in replies (yet). Dashboard: the reply bar has an **Email** channel (subject + body); it threads with
the selected email (or the latest one from the app).

## R. WhatsApp: media, interactive messages, read receipts, button replies, 24-hour window

### Meta Cloud API (`meta-whatsapp`)

Accepted `type`s with Meta's validation (errors `400` `(#100) …` / `131053` like Graph):

| Type | Rules checked |
|---|---|
| `text` | `body` required, ≤ 4096 |
| `image`, `video`, `document`, `audio`, `sticker` | exactly one of `link` (http/s) / `id` (uploaded); `caption` ≤ 1024, not on audio/sticker; `document.filename`; an `id` must exist and its MIME must fit the type (else `131053`) |
| `location` | `latitude` −90..90, `longitude` −180..180, `name`, `address` |
| `contacts` | non-empty array, `name.formatted_name` required; phones / emails shown |
| `interactive` `button` | `body.text`; 1–3 `reply` buttons, `id` ≤ 256, `title` ≤ 20, unique; header ≤ 60, footer ≤ 60 |
| `interactive` `list` | `action.button` ≤ 20; 1–10 sections (title required when > 1, ≤ 24); ≤ 10 rows total; row `id` ≤ 200 unique, `title` ≤ 24, `description` ≤ 72 |
| `interactive` `cta_url` | `action.name = "cta_url"`, `display_text` ≤ 20, valid `url` |
| `reaction` | `message_id` required, `emoji` ("" = remove) |
| `template` | `name`, `language.code`; quick-reply buttons (`components[type=button, sub_type=quick_reply]`) are remembered |

The structured content is stored as `metadata.wa` (`type`, `caption`, `media`, `location`, `contacts`,
`interactive{buttons|sections}`, `reaction`, `template{buttons}`, `replyTo`), rendered in the viewer (type badge,
caption, link / filename, buttons, list rows, map link, contacts). `bodyText` stays a searchable summary
(`[image] caption link`, `body\n[buttons: Yes | No]`), so OTPs and links are still extracted.

Media API (stored in the DB, limit `STUBYARD_MAX_MEDIA_BYTES`, default 5 MB, and Meta's per-type limits):

| Endpoint | Behaviour |
|---|---|
| `POST /<version>/<phone-number-id>/media` (multipart: `messaging_product=whatsapp`, `file`, `type`) | `200 {id}` (16-digit numeric). Unsupported MIME / too large → `400` code `131053` |
| `GET /<version>/<media-id>` | `{messaging_product, url, mime_type, sha256, file_size, id}`; unknown → `400` code 100 subcode 33 |
| `DELETE /<version>/<media-id>` | `{success: true}` |
| `GET <url>` (`…/whatsapp_business/attachments/?mid=<id>`) | the bytes with the right `Content-Type` (any auth accepted) |

`POST …/messages {"messaging_product":"whatsapp","status":"read","message_id":"wamid…"}` (the app marks a user's
message read) → `{success: true}` (noted on the inbound message as `metadata.markedReadByApp`).

### Twilio WhatsApp

`MediaUrl` (repeatable, ≤ 10, http/s; else `21620` / `21623`), `num_media` in responses, `ContentSid` must look like
`HX…` (`21656`), `Body` ≤ 1600 (`21617`). Stored as `metadata.wa {type: "media"|"template", mediaUrls, caption}`.

### Read receipts

- Instance config `readReceipts: "true"` (Meta, Twilio WhatsApp): after `delivered`, stubyard also reports `read`
  (Meta `statuses[].status = "read"`, Twilio `MessageStatus=read`), at 2× the callback delay. Sets `metadata.readReceiptAt`.
- **Mark as read** (viewer button, or `POST /api/projects/<p>/messages/<id>/read-receipt` → `202`) sends it now, for
  delivered outbound WhatsApp messages (`400` other channels, `409` not delivered).

### Button / list replies (inbound)

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/reply -H 'content-type: application/json' \
  -d '{"channel":"whatsapp","button":"Yes"}'      # id or title; optional "contextMessageId", "instance"
# Twilio (stubyard does not know ContentSid buttons): {"channel":"whatsapp","buttonReply":{"id":"CONFIRM","title":"Confirm"}}
```

stubyard finds the button / list row on the given (or latest) interactive message of that user and sends:
Meta `messages[0] = {context: {from, id: <wamid>}, type: "interactive", interactive: {type: "button_reply", button_reply: {id, title}}}`
(`list_reply` with `description`; template quick replies → `type: "button", button: {payload, text}`);
Twilio `Body`, `ButtonText`, `ButtonPayload`, `MessageType=button` (list: `ListId`, `ListTitle`, `MessageType=interactive`),
`OriginalRepliedMessageSid`. Unknown button → `400` listing the options. Dashboard: "Tap:" chips under the reply bar.

### 24-hour customer service window

Instance config `enforce24hWindow: "true"` (default off): a non-template message to a user without an inbound
WhatsApp message in the last 24 h is accepted, then fails with Meta **131047** "Re-engagement message" / Twilio
**63016** (failed status callback; message `failed`, rule label "24-hour window closed"). Templates (Meta
`type: template`, Twilio `ContentSid`) always pass; a reply (`/reply`) opens the window.

### MCP additions (§F, 0.6)

`reply_as_user` now takes `channel: sms | whatsapp | email`, `button` (WhatsApp), `subject`, `in_reply_to` (email);
`text` is optional when `button` is given.

### Config fields added in 0.6 (dashboard → Providers, then the matching tab)

| Preset | Keys |
|---|---|
| `twilio`, `twilio-whatsapp` | `readReceipts`, `enforce24hWindow`, `verifyExpirySeconds`, `verifyAutoCreateServices` (+ undocumented `verifyFriendlyName`, `verifyEmailFrom`) |
| `vonage` | `verifyCallbackUrl`, `verifyExpirySeconds` |
| `meta-whatsapp` | `readReceipts`, `enforce24hWindow` |
| all email presets + `smtp` | `inboundUrl`, `inboundAddress`; `sendgrid`/`smtp`: `inboundFormat`; `generic-email`: `inboundTemplate`; `ses`: `inboundTopicArn` (not in the form) |

Env: `STUBYARD_MAX_MEDIA_BYTES` (default 5 MB). Retention also drops old `wa_media` rows and verifications.

### Not simulated / known gaps (§P–§R)

- Vonage: no automatic fallback to the next workflow after `channel_timeout` (use `next_workflow`); `silent_auth`,
  `rcs`, `whatsapp_interactive` channels rejected with 422; templates API not implemented.
- Twilio Verify: no Verify Events webhooks, no push / TOTP factors, no SNA; `CustomCode` accepted without the
  account flag; Locale is stored but messages are English.
- WhatsApp: no inbound media from the user; Twilio button titles are not known (send `buttonReply`); product /
  flow / address interactive types are stored without validation of their action.
- Inbound email: no attachments; SNS not signed (as before).

## S. File storage (Amazon S3 and S3-compatible: R2, Spaces, B2, MinIO, Wasabi)

stubyard can stand in for an S3-compatible object store: Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2,
MinIO and Wasabi. Apps point their S3 SDK at stubyard. Every file is kept on disk, shown in the dashboard and logged
in the traffic log. The log records sizes, checksums and the operation, but never the file bytes.

### Endpoints

| What | URL |
|---|---|
| Data plane (S3 API) | `http(s)://<host>:4000|4443/storage/<project>/<instance>/<bucket>/<key>` (path-style) |
| Test run | `/run/<key>/storage/<project>/<instance>/…`, or the `X-Hub-Run` header |
| Virtual-hosted (opt-in) | `STUBYARD_STORAGE_DOMAIN=s3.localhost`, then `<bucket>.<instance>.<project>.s3.localhost` (needs wildcard DNS and a matching certificate) |
| Dashboard upload | `PUT /storage/<project>/<instance>/__hub/objects/<bucket>/<key>` (streamed) |
| Control API | `/api/projects/:slug/storage/…` (JSON only), presets at `GET /api/storage-presets` |

Buckets are created on the first write (`autoCreateBuckets`, default true). When that happens, the response carries a
warning, because the real provider would answer `NoSuchBucket`.

### Connect your app

```js
import { S3Client } from '@aws-sdk/client-s3';
const config = { region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'stubyard', secretAccessKey: 'stubyard-secret' } };
const s3 = new S3Client({ ...config, endpoint: 'http://localhost:4000/storage/hyper/s3' });         // backend I/O (Docker: http://stubyard:4000/…)
const presigner = new S3Client({ ...config, endpoint: 'https://localhost:4443/storage/hyper/s3' }); // URLs for browsers
```

```python
s3 = boto3.client("s3", endpoint_url="http://localhost:4000/storage/hyper/s3", region_name="us-east-1",
                  aws_access_key_id="stubyard", aws_secret_access_key="stubyard-secret",
                  config=Config(s3={"addressing_style": "path"}))
```

Other clients:

- **AWS CLI:** `--endpoint-url`.
- **Laravel:** `AWS_ENDPOINT` together with `AWS_USE_PATH_STYLE_ENDPOINT=true`.
- **Rails:** `endpoint` together with `force_path_style: true`.

The project's "Connect your app" page and the Storage page print these snippets with the real values filled in.

Default credentials:

- **S3, R2, Spaces, B2, Wasabi:** `stubyard` / `stubyard-secret`.
- **MinIO:** `minioadmin` / `minioadmin`.

In lax mode (the default), stubyard accepts any key.

#### Signatures and hosts

Your app's SDK signs presigned URLs, so stubyard cannot choose their host. By default, stubyard parses signatures but does
not enforce them, so a URL signed for `stubyard:4000` still works on `localhost:4000`. To have stubyard verify
signatures, set `verifySignatures` (an error on mismatch) or `strict` on the instance. stubyard then tries the
signature against these hosts: the request Host, the `STUBYARD_PUBLIC_URL` host, the instance's `browserBaseUrl` host,
and `stubyard`, `localhost`, `127.0.0.1` and `host.docker.internal` on both ports.

Some checks apply in every mode: presigned URLs expire, `X-Amz-Expires` can be at most 7 days, and credentials must be
well formed. In strict mode, these become errors:

- an unknown access key (`InvalidAccessKeyId`);
- a bad signature (`SignatureDoesNotMatch`);
- clock skew of more than 15 minutes;
- anonymous access to a private bucket;
- a POST policy condition that fails;
- a non-last multipart part smaller than 5 MiB (`EntityTooSmall`).

### Supported S3 operations

| Area | Operations and behaviour |
|---|---|
| Buckets | ListBuckets, CreateBucket, HeadBucket, DeleteBucket; `?location`, `?versioning` (GET only), `?acl`, `?cors` (GET, PUT, DELETE) |
| Objects | PutObject (`Content-MD5`, `x-amz-checksum-*`, `If-None-Match: *`, `x-amz-meta-*`, `x-amz-acl`), GetObject and HeadObject (Range, conditional headers, `response-*` overrides, `x-amz-checksum-mode`), DeleteObject, DeleteObjects, CopyObject (metadata directive), object ACL |
| Listing | ListObjectsV2 (pagination, delimiter, `start-after`, `encoding-type=url`, `fetch-owner`), ListObjects v1, ListObjectVersions (every object as version `null`), ListMultipartUploads |
| Multipart | Create, UploadPart, UploadPartCopy, ListParts, Complete (ETag `md5-of-md5s-N`, composite or full-object checksums), Abort |
| Bodies | `aws-chunked` with signed or unsigned chunks and trailing checksums. CRC32, CRC32C, CRC64NVME, SHA-1 and SHA-256 are computed in one pass. Mismatches return `BadDigest`, `XAmzContentSHA256Mismatch` or `IncompleteBody`. |
| Presigned URLs | GET, PUT, HEAD, DELETE. An expired URL returns 403 `AccessDenied` "Request has expired". |
| POST policy | Browser form uploads. `expiration` and `content-length-range` are always enforced. Supports `success_action_status` 200, 201 or 204, and `success_action_redirect`. |
| Anything else | Policy, lifecycle, tagging, versioning writes and similar: 501 `NotImplemented` |

Every object response carries `X-Content-Type-Options: nosniff`. HTML, SVG and XML objects also get
`Content-Security-Policy: sandbox`, unless the instance sets `allowActiveContent`. The dashboard content endpoint is
always sandboxed.

### CORS

Each bucket has one of three modes:

- **`permissive` (default):** reflects the Origin, allows any method and header, and adds a warning that the real
  bucket needs a CORS rule.
- **`rules`:** enforces S3 `CORSRule`s exactly. Set them with `PutBucketCors` or the dashboard.
- **`none`:** sends no CORS headers.

### Scenarios

You can trigger a scenario three ways:

- the `X-Hub-Scenario: <action>` header;
- `?hub_scenario=<action>` on any URL, including presigned ones;
- a rule: `POST /api/projects/:slug/storage/:instance/rules`. Add `?run=<key>` to scope the rule to one test run;
  run rules are deleted when the run stops.

Rules are checked in this order: run rules, then bucket rules, then instance rules. Each rule can filter by `op`
(any, put, get, head, delete, list, copy, multipart, bucket), `bucket` and `keyPrefix`. Rules support `count`,
`after`, `failRate` and `minutes`.

| Action | S3 result |
|---|---|
| `access_denied` | 403 `AccessDenied` |
| `slow_down` | 503 `SlowDown` + `Retry-After` (the AWS SDK retries 3 times: use `count` ≥ 3 to make it visible) |
| `internal_error` | 500 `InternalError` |
| `quota_exceeded` | 403 `QuotaExceeded` (MinIO: 507 `XMinioStorageFull`) |
| `entity_too_large{maxBytes}` | 400 `EntityTooLarge` (with `maxBytes`: only larger uploads) |
| `expired_url` | 403 `AccessDenied` "Request has expired" |
| `bad_signature` | 403 `SignatureDoesNotMatch` |
| `checksum_mismatch` | upload: 400 `BadDigest`; download: one byte flipped, headers intact |
| `not_found` | 404 `NoSuchKey` |
| `complete_error_200` | CompleteMultipartUpload answers HTTP 200 with an `<Error>` body |
| `cors_blocked` | preflight 403, no CORS headers |
| `slow{delayMs|bytesPerSec}` | delay, or throttle the body |
| `timeout` / `reset{afterBytes}` | hold then close / cut the connection mid-body |

### Limits and lifecycle

| Setting | Default | Meaning |
|---|---|---|
| `STUBYARD_STORAGE_MAX_MB` | 5120 | All projects together |
| `STUBYARD_STORAGE_PROJECT_MB` | 2048 | Per project |
| `STUBYARD_STORAGE_MAX_OBJECT_MB` | 1024 | Per object. Instances can lower it with `config.maxObjectBytes`, and can set `config.quotaBytes`. |
| `STUBYARD_STORAGE_RETENTION_DAYS` | 0 | 0 keeps files forever |
| `STUBYARD_STORAGE_DOMAIN` | unset | Turns on virtual-hosted style |

When an upload would exceed a limit, stubyard refuses it with the preset's error and an `x-stubyard-reason` header. It
never deletes files silently.

- **Files on disk:** files live under `<data>/storage/<projectId>/<instanceId>/objects/…` and are named by id, never
  by key.
- **Export:** export includes instances, buckets and project-level rules. Credentials are only included with
  `?secrets=1`. Objects are never exported.
- **Project reset:** removes uploads in progress and run objects. Send `{ "storage": true }` to remove every file.
- **Run purge:** removes the files uploaded explicitly inside the run.
- **Project delete and factory reset:** remove the project's storage directory.
- **Maintenance pass:** purges multipart uploads after 24 h, applies retention, and sweeps files and directories that
  have no database row and are older than 1 h.
- **Run reports:** include `storage{uploads, bytes, downloads, deletes, items, rules}`.

### MCP tools and test helper

MCP tools: `list_storage`, `list_files`, `get_file` (includes a text preview up to 64 KB), `get_file_url`,
`wait_for_upload`, `delete_files`, `set_storage_scenario`, `reset_storage_scenarios`.

```ts
import { s3Config, waitForUpload, getFile, presign, setStorageScenario, resetStorageScenarios, emptyBucket } from '@stubyard/client/storage';
const s3 = new S3Client(s3Config({ project: 'hyper', instance: 's3' }));
const [file] = await waitForUpload({ project: 'hyper', instance: 's3', bucket: 'uploads', prefix: 'avatars/' });
```

### Out of scope

Versioning, object lock, lifecycle rules, bucket policies and IAM, SSE encryption (the headers are only echoed),
tagging, S3 Select, event notifications, SigV4A, and `partNumber` GETs. The GCS, Azure Blob, Cloudinary and Supabase
providers run on the same engine; see §T.

---

## T. File storage: Cloudinary, Google Cloud Storage, Azure Blob, Supabase Storage

Draft for the docs. Every repointing setting below is exercised by `server/test/storage-providers.sdk.test.ts`
with the real SDKs (cloudinary 2.11.0, @google-cloud/storage 9.0.0, @azure/storage-blob 12.34.0,
@supabase/supabase-js 2.119.2). `B` is the instance base, e.g. `http://localhost:4000/storage/hyper/gcs`.

All four providers share the S3 engine's machinery:
- scenario rules, mapped to each provider's own error format;
- quotas and the maximum object size;
- the traffic log (sizes, never bytes);
- test-run attribution;
- the dashboard file browser.

Signatures follow the S3 convention. They are parsed and logged, but they are only enforced when the instance is
**Strict** or **Verify signatures** is on. Expiry is always enforced.

### Cloudinary (preset `cloudinary`)

Buckets are resource types (`image`, `video`, `raw`). Keys are public ids. The cloud name is `stubyard`
(`config.cloudName`).

| Area | Endpoints |
| --- | --- |
| Upload API | `POST B/v1_1/<cloud>/<image\|video\|raw\|auto>/upload` (multipart, urlencoded or JSON; `file` as a part, a data URI, base64 or a remote URL), `destroy`, `rename`, `explicit` |
| Chunked | `upload_large`: `X-Unique-Upload-Id` + `Content-Range: bytes a-b/(total\|-1)`; intermediate chunks answer `{done:false}` |
| Admin API | `GET B/v1_1/<cloud>/resources[/<rt>[/<type>[/<public_id>]]]`, `DELETE …/resources/<rt>/upload` (`public_ids[]`, `prefix`), `ping`, `usage`, `upload_presets`; Basic auth `api_key:api_secret` |
| Delivery | `GET B/<cloud>/<rt>/<type>/[<transformations>/][v<version>/]<public_id>[.<ext>]`: original bytes, header `x-stubyard-transformations-ignored` |

**Auth:**
- Signed requests use SHA-1 or SHA-256 over the sorted params plus `api_secret`. The timestamp must be within 1 hour.
- Unsigned requests use `upload_preset`, which must be listed in `config.uploadPresets`; an unknown preset is
  rejected only in strict mode.
- Errors look like `{"error":{"message":…}}` and carry an `X-Cld-Error` header. `slow_down` maps to 420.

**Remote URLs:** a remote `file` URL is fetched only when the outbound policy allows that host
(`STUBYARD_OUTBOUND_ALLOW`). Otherwise stubyard stores a placeholder (`placeholder: true`) and adds a warning.

**Repointing (verified):**
- **Node:** put the endpoint in `CLOUDINARY_URL=cloudinary://key:secret@stubyard?upload_prefix=B` before the first
  `require('cloudinary')`. The SDK picks the `http` or `https` module when it is loaded, so calling
  `cloudinary.config({ upload_prefix: 'http://…' })` later fails for http endpoints. An https endpoint on 4443 with
  the stubyard CA works with `config()`. The path prefix is preserved for both the Upload and Admin APIs.
- **`cloudinary.url()`:** pass `{ secure: false, cname: '<host:port>/storage/<project>/<instance>' }`. A path in
  `cname` works; the SDK adds `v1/` and `?_a=…`, which stubyard accepts. Apps that render the returned
  `secure_url` need nothing.
- `api_proxy` is a forward proxy and is not needed.

### Google Cloud Storage (preset `gcs`)

| Area | Endpoints |
| --- | --- |
| JSON API | `B/storage/v1/b` (list, insert), `b/<bucket>` (get, patch, delete), `b/<bucket>/o` (list with prefix, delimiter, pageToken, startOffset/endOffset), `o/<object>` (get, `alt=media`, patch, delete), `copyTo`, `rewriteTo` |
| Uploads | `B/upload/storage/v1/b/<bucket>/o?uploadType=media\|multipart\|resumable` (resumable: `Location` with `upload_id`, 308 + `Range`, overlapping chunks skipped, `DELETE` cancels with 499) |
| XML API | `GET/HEAD/PUT/DELETE B/<bucket>/<object>`, V4 signed URLs (`GOOG4-RSA-SHA256`) |
| Preconditions | `ifGenerationMatch` / `ifGenerationNotMatch` / `ifMetagenerationMatch` / `ifMetagenerationNotMatch` |
| Not simulated | `compose`, `batch` (501) |

Errors:
- JSON API: `{"error":{"code","message","errors":[{"message","domain","reason"}]}}`, e.g. `notFound`,
  `conditionNotMet`, `rateLimitExceeded`.
- XML API: `<Error><Code>…`. Expired signed URLs return 400 `ExpiredToken`.

Responses carry `x-goog-hash` (crc32c, md5) and `x-goog-generation`.

**Correction to spec 3 §4:** @google-cloud/storage **v9** does not work with a path-prefixed `apiEndpoint` the
way the spec describes:
1. Every request goes through google-auth-library, even for a custom endpoint. Without credentials it fails with
   "Could not load the default credentials".
2. JSON API calls are resolved with `new URL('/storage/v1/…', baseUrl)`, which drops the endpoint path. Uploads
   keep the path because they are built as `${apiEndpoint}/upload/…`.

stubyard handles both. Root-level `/storage/v1/…` requests are mapped to a GCS instance by:
- the `x-goog-api-key` header `<project>/<instance>`;
- otherwise the instance that owns the bucket in the path;
- otherwise `?project=<slug>`;
- otherwise the only GCS instance.

This mapping happens only when no project is named `v1`.

**Repointing (verified):**

```js
const storage = new Storage({ apiEndpoint: B, projectId: 'stubyard', apiKey: '<project>/<instance>' });
```

`apiKey` satisfies google-auth-library offline and tells stubyard which instance is meant.

**Signed URLs:** `getSignedUrl()` needs a private key. Download the instance's fake service account from
`GET /api/projects/<p>/storage/<i>/service-account.json`; the dashboard card has a link. Then:
1. Create a signer with `new Storage({ apiEndpoint: B, credentials: serviceAccount })`. Signing happens offline.
2. The client signs `/<bucket>/<object>`, with the host taken without its port, and replaces the endpoint path.
   Put the instance path back before use: `url.replace(new URL(url).origin, B)`.

stubyard verifies both the path with the prefix and the path without it, and each candidate host with and without
its port.

**Python:** the `api_endpoint` client option or `STORAGE_EMULATOR_HOST`. The snippet is provided, but it is not
exercised by the tests.

### Azure Blob Storage (preset `azure`)

The base is `A = B/<account>`. The default account is `devstoreaccount1` with Azurite's well-known key, so an
Azurite connection string only needs `BlobEndpoint` changed.

| Area | Operations |
| --- | --- |
| Containers | create, get properties, delete (with its blobs), list (`comp=list`), ACL, metadata |
| Blobs | Put Blob, Put Block, Put Block List, Get Block List, Get/Head (`x-ms-range`, `Range`), Delete (202), Copy (same account), set metadata / properties |
| Listing | List Blobs XML (prefix, delimiter, `marker`, `maxresults`) |
| Service | get/set service properties, account info |
| Not simulated | other `comp=` values (501) |

**Errors:** XML `<Error><Code>…` plus an `x-ms-error-code` header, e.g. `BlobNotFound`, `ContainerAlreadyExists`,
`AuthenticationFailed`, `ServerBusy`.

**Auth:**
- SharedKey is accepted but **not verified**.
- Anonymous access to a non-public container gets a warning, or 401 `NoAuthenticationInformation` in strict mode.
- SAS expiry and permission letters are always checked. The service-SAS signature is verified in verify mode.

**Repointing (verified):**

```
DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=<key>;BlobEndpoint=B/devstoreaccount1;
```

The path prefix works for every client operation, including `uploadData` with blocks.

**SAS:** `ContainerClient` takes the container name from the second path segment of the URL, which is wrong when
the endpoint has a path prefix. Pass `containerName` and `blobName` explicitly to
`generateBlobSASQueryParameters`.

### Supabase Storage (preset `supabase`)

Everything lives under `B/storage/v1`:
- **Buckets:** CRUD and empty.
- **Uploads:** `POST` (create) and `PUT` (upsert, or `x-upsert: true`) of `object/<bucket>/<path>`, as multipart
  (field `''`) or a raw body. Bucket `file_size_limit` and `allowed_mime_types` are enforced.
- **Object reads:** `object/public|authenticated/…`.
- **Object management:** `DELETE object/<bucket>` with `{prefixes}`, `list`, `list-v2`, `move`, `copy`.
- **Signed URLs:** `object/sign` (single and batch), `object/upload/sign` (create and `PUT`), `info`.
- **Images:** `render/image/…` serves the original bytes with `x-stubyard-transformations-ignored`.
- **S3 endpoint:** `/s3/*` is the S3 engine.

**Errors** use the storage-api body `{statusCode: "<code>", error, message}`. As in the real service, the HTTP
status is often 400 while the body's `statusCode` carries the real code:

| Case | HTTP | Body `statusCode` |
| --- | --- | --- |
| Duplicate | 400 | `409` |
| Not found | 400 | `404` |
| Invalid MIME type | 400 | `415` |
| Too large | 400 | `413` |

**Keys:**
- The keys are the Supabase CLI demo `anon` and `service_role` JWTs (HS256 with the demo secret, or
  `config.jwtSecret`). They are accepted unverified in lax mode.
- Row Level Security is not simulated.
- A public URL of a private bucket always returns "Bucket not found", as on the real service.

**Repointing (verified):** `createClient(B, key)`. supabase-js appends `/storage/v1` itself, and the path prefix
works for every storage call, including `createSignedUrl` and `uploadToSignedUrl`.

### Dashboard

The presets appear in **Add storage** automatically. Each instance card shows provider-appropriate credentials:

| Provider | Credentials shown |
| --- | --- |
| Cloudinary | cloud, `api_key`, `api_secret` |
| Azure | account, account key |
| Supabase | anon key, `service_role` key |
| GCS | a `service-account.json` link |

The **Verify signatures** tooltip names what is verified for each protocol. Object URLs in the file browser use
each provider's own read path:
- Cloudinary: delivery URLs
- GCS: XML API
- Azure: `/<account>/<container>/<blob>`
- Supabase: `object/public/…`

---

## U. Content checks and webhook security check

### Content checks ("message lint")

Every captured **outbound** email, SMS and WhatsApp message is checked when it is captured. The findings are stored with the message (`messages.lint`, migration 12). Inbound messages are not checked. The checks are synchronous and fast: they scan at most 300 KB, use bounded regexes, and keep at most 8 findings per check. If a check throws, the message is still captured, with no findings.

Each finding has the shape `{ check, severity: 'error'|'warn'|'info', message, excerpt?, where?: 'subject'|'text'|'html'|'link' }`.

| Check | Channels | Severity | What it flags | False-positive safeguards |
|---|---|---|---|---|
| `placeholder` | all | error | `{{x}}`, `${x}`, `%s` / `%(x)s`, `{x}`, `:name`, `__NAME__`, `*\|FNAME\|*` | `:name` and `__x__` only for snake_case or known slot names; `%` and `:name` are scanned with URLs and emails removed; `{x}` only for identifier-like content |
| `leaked-value` | all | error / warn | `undefined`, `NaN`, `[object Object]`, `Invalid Date`; `null`, `{}`, `[]` as standalone tokens | skipped after English words ("an undefined…") and in phrases like "null and void"; one finding per kind |
| `encoding-error` | all | error | U+FFFD, mojibake (`â€™`, `Ã©`) | only known mojibake sequences |
| `mixed-scripts` | all | info | Latin mixed with Cyrillic or Greek inside one word | per word only, so mixed-language text is fine |
| `link-local` | all | warn | localhost, 127.x, private IPs, `*.local`, `*.test`, `*.internal` | links that contain placeholders are skipped |
| `link-production` | all | warn | links to `settings.productionDomains` | only `href` links count; images from a production CDN are allowed |
| `link-http` | all | info | `http://` links | |
| `link-broken` | all | warn | spaces, unbalanced brackets, a doubled scheme, an empty href | |
| `link-tracking` | all | warn | the same `utm_*` / `gclid` / `fbclid` parameter twice, or a second `?` | |
| `mailto-empty` | email | warn | `mailto:` with no address | |
| `email-unsubscribe` | email | error | instance labelled `marketing` without `List-Unsubscribe` plus `List-Unsubscribe-Post` | only for marketing-labelled instances |
| `email-text-part` | email | warn | HTML without a text/plain part | detected from the raw MIME (mailparser generates a text part from the HTML) |
| `email-subject` | email | warn | empty subject, or longer than 120 characters | |
| `email-from-name` | email | info | From address with no display name | |
| `email-img-alt` | email | info | `<img>` without alt | tracking pixels and spacers are ignored |
| `email-size` | email | warn | HTML over 102 KB (Gmail clips it) | |
| `sms-encoding` | sms | warn / info | UCS-2 only because of smart quotes, dashes or emoji | only when *every* non-GSM character is one of these; warn if it costs extra segments, info otherwise |
| `sms-segments` | sms | info / warn | more than 1 segment (info), more than 3 (warn) | |
| `wa-template-params` | whatsapp | error | a template parameter that was sent empty | covers both Meta and Twilio ContentVariables |
| `wa-length` | whatsapp | error | text over 4096 characters | |

For HTML-only email, the HTML is checked and the text that mailparser derives from it is ignored, because that text wraps URLs.

**Settings** (Project → Settings → Content checks): `settings.lintDisabled: string[]` turns off individual checks, and `settings.productionDomains: string[]` sets the production domains. Changes apply to new messages only.

**UI**
- Message list: error and warning badges on each row.
- Message viewer: a "Content checks" list.
- User workspace toolbar: a counter for that user; click it to show only messages with warnings or errors.
- Project home: a project counter.

**API**
- `GET /api/projects/:p/messages?lint=error|warn|info|any`. Each level includes the levels above it; `any` means any finding.
- Every message JSON includes `lint`.
- `GET /api/projects/:p/lint?user=&run=&since=&limit=` returns totals, `byCheck`, `byUser`, recent messages, and the check list with `enabled` flags.
- `GET /api/lint/checks` returns the check catalogue.
- `POST /api/lint/check?project=` takes `{channel, subject?, text?, html?, headers?, labels?, fromName?, template?}` and checks the content without sending it.

**MCP**
- `get_messages` returns findings and accepts `lint`.
- `lint_report` returns the project or user summary, or runs an ad-hoc check when `text`, `html` or `subject` is passed.

**Test runs**: the report has a `lint` section (counts, `byCheck`, items) and adds a warning when messages have errors or warnings.

### Webhook security check

`POST /api/projects/:p/webhook-templates/:id/security-check` with body `{ asUser?, data?, gapMs? }` runs the check. `GET` on the same path returns the latest result, or 404 if no check has run. Only the latest result per template is stored, in `webhook_security_checks`. The MCP tool is `webhook_security_check`.

The variants run one after another, with a 150 ms gap by default (`gapMs` accepts 0–2000). All of them go through `sendOutbound`, so the allowlist and the traffic log apply. Each traffic-log entry is tagged with `securityCheck: <variant>`.

| Variant | Expected | Verdict |
|---|---|---|
| baseline (valid) | 2xx | anything else: fail, and the run stops (`baselineFailed`) |
| bad-signature, wrong-secret, missing-signature, tampered-body | 4xx | 2xx: fail · 4xx: pass · 3xx/5xx: warn · no answer: error |
| stale-10m, stale-1h, future-10m (timestamped presets only) | 4xx | same as above |
| replay (exact duplicate) | any | info (5xx: warn); the note says when the answer differs from the first delivery |
| out-of-order (only if the template is in a sequence) | any | info, with both log ids |
| oversized (1 MB) | 4xx | 2xx: warn · 4xx: pass · 5xx: warn |
| malformed-json | 4xx | 2xx: fail · 4xx: pass · 5xx: warn |
| wrong-content-type (`text/plain`) | 4xx | 2xx: info · 4xx: pass · 5xx: warn |

Signing presets change which variants run:
- **Unsigned templates** skip the signature variants and add a note.
- **Basic auth** uses a wrong password, wrong credentials, or no header, and skips the tampered-body variant.
- **HMAC without `timestampHeader`** skips the timestamp variants and adds a note.

Only one check per template runs at a time; a second request gets 409.

The result is shown under Webhooks → Send → template → **Security check**: a summary, then a table with variant, expected, status, verdict and a log link that opens the traffic-log drawer.

---

## V. MCP tester (test an MCP server you are building)

stubyard can act as an **MCP client** for an MCP server you are developing. It connects to the server, shows its tools,
resources and prompts, calls them, keeps a full JSON-RPC log and runs a set of checks ("MCP lint"). It works like MCP
Inspector, but the client is the stubyard server. Browser CORS and session headers are therefore not a problem, and every
request also appears in the traffic log.

Dashboard: **project → MCP tester** (`/p/<project>/mcp-tester`). The page has a target bar, then the tabs Tools,
Resources, Prompts, Log, Checks and Saved calls.

To try it, choose the target **stubyard (this server, demo)**, which is stubyard's own `/mcp`, and press Connect.

### Transports

| Transport | Support |
|---|---|
| Streamable HTTP (2025-03-26, 2025-06-18, 2025-11-25) | ✅ JSON and SSE responses, `Mcp-Session-Id`, `MCP-Protocol-Version`, 202 for notifications, optional GET stream (405 accepted), SSE priming events and resume with `Last-Event-ID`, DELETE on disconnect |
| Session expiry | ✅ A 404 on a request that carries a session id starts a new `initialize` automatically. It is counted in `stats.sessionReinits` and logged |
| Legacy HTTP+SSE (2024-11-05) | ✅ GET stream, `endpoint` event, POST to that endpoint. In `auto` mode stubyard tries Streamable HTTP first and falls back on 400/404/405. It tries SSE first when the URL ends in `/sse` |
| stdio | ❌ Use a bridge (see below) |

The client sends protocol version `2025-11-25` and accepts what the server negotiates. It answers server `ping`
requests and rejects other server→client requests (sampling, elicitation, roots) with -32601. It records
`notifications/message` (server logs), `notifications/progress` (attached to the call) and `*/list_changed` (the list
is marked stale and is fetched again).

### Reaching your server (networking)

- **stubyard in Docker:** `localhost` is stubyard itself. Use `http://host.docker.internal:<port>/mcp` for a server on
  your machine (on Linux, start it on `0.0.0.0`). For another container on the stubyard network, use its service name.
- **stubyard run with Node on the host:** `http://localhost:<port>/mcp`.
- The **outbound allowlist** applies. By default only local and private hosts are allowed (`STUBYARD_OUTBOUND_ALLOW`).
  A blocked URL returns **403** `blocked_by_allowlist`.

**stdio servers.** Run them behind a bridge, then connect to the bridge URL:

```bash
# supergateway (Node): stdio → Streamable HTTP at http://host.docker.internal:8000/mcp
npx -y supergateway --stdio "node build/index.js" --outputTransport streamableHttp --port 8000

# mcp-proxy (Python): stdio → HTTP+SSE at http://host.docker.internal:8080/sse
uv tool install mcp-proxy
mcp-proxy --host=0.0.0.0 --port=8080 -- uvx mcp-server-fetch
```

### Targets and sessions

- A **target** is a saved MCP server for a project: name, URL, transport (`auto` | `streamable` | `sse`), custom
  headers (e.g. `Authorization`) and notes. Ids are stable.
  - List responses mask header values (`Bearer ••••5678`). Send a masked value back unchanged to keep the stored one.
  - The headers `host`, `content-length`, `mcp-session-id` and `mcp-protocol-version` are rejected.
- A **session** is an open connection kept by stubyard, with id `mt_…`.
  - Sessions close after **30 minutes idle**, on disconnect, or when the project is deleted. At most 30 are open.
  - Every JSON-RPC message is kept in the session log, with direction, method, id, timing, size and payload.
  - Each HTTP exchange is also a traffic-log entry: purpose "MCP tester", outbound, headers masked.

### REST API

Base: `/api/projects/<project>/mcp-tester`

| Method and path | What it does |
|---|---|
| `GET /` | Targets, open sessions, the self URL, protocol versions, the check catalogue, the idle timeout |
| `GET /targets`, `POST /targets` | List or create targets: `{name?, url, transport?, headers?, notes?}`, or `{self: true}` for stubyard's own `/mcp` |
| `GET\|PATCH\|DELETE /targets/:id` | Read, change or delete a target (`:id` or the target name) |
| `POST /connect` | `{target}` \| `{url, headers?, transport?}` \| `{self: true}`, plus `reuse?` and `checks?` (default true). Returns `{session, checks}` |
| `POST /targets/:id/connect` | Connect a saved target |
| `GET /sessions`, `GET\|DELETE /sessions/:sid` | List sessions; read a session summary; disconnect |
| `GET /sessions/:sid/tools`, `…/resources`, `…/resource-templates`, `…/prompts` | Full lists (all pages). Add `?refresh=1` to fetch again |
| `POST /sessions/:sid/call` | `{name, arguments?, timeoutMs?}` → `{kind: result\|rpc_error\|transport_error, result, isError, durationMs, validation, contentProblems, progress}` |
| `POST /sessions/:sid/read` | `{uri}` → `resources/read` |
| `POST /sessions/:sid/prompt` | `{name, arguments?}` → `prompts/get` |
| `POST /sessions/:sid/ping` | `ping` |
| `POST /sessions/:sid/subscribe` | `{uri, subscribe?}` (only when the server declares `resources.subscribe`) |
| `POST /sessions/:sid/logging-level` | `{level}` → `logging/setLevel` |
| `POST /sessions/:sid/request` | `{method, params?}`, any raw JSON-RPC request |
| `GET /sessions/:sid/log?after=&limit=` | `{entries, lastSeq, serverLogs}`. `DELETE` clears the log |
| `POST\|GET /sessions/:sid/checks` | Run the checks, or get the last report |
| `GET\|POST /targets/:id/saved` | List saved calls, or save one: `{name, tool, arguments, expect?}` |
| `PATCH\|DELETE /saved/:cid`, `POST /saved/:cid/run` | Change, delete or run one saved call |
| `POST /targets/:id/run-saved` | `{ids?}` → `{passed, failed, durationMs, results[]}` |

`GET /api/mcp-tester/checks` returns the check catalogue without a project.

Connect errors return **502**, or **403** when the allowlist blocks the URL. The response is
`{error, details: {log}}`, where the log shows what was sent and received.

**Saved calls** give a target a small regression suite. A call is a tool name and arguments, plus an optional
`expect` that every run compares against:

- `isError`: default `false`.
- `contains`: text the result must contain.
- `maxMs`: the longest the call may take.
- `validOutput`: default `true` when the tool has an outputSchema.

### MCP tools (§F)

| Tool | What it does |
|---|---|
| `mcp_tester_targets` | Saved targets and open sessions |
| `mcp_tester_connect` | Connect to `target`, `url` (+ `headers`, `transport`) or `self`. Optional `save_as` saves the target. Returns session, server info, tools and checks |
| `mcp_tester_call` | Call a tool (`session` or `target`, `tool`, `arguments`, `timeout_seconds`). Optional `save_as` + `expect` saves it as a saved call |
| `mcp_tester_checks` | Run the checks for a session or target |
| `mcp_tester_run_saved` | Run a target's saved calls and return pass/fail |
| `mcp_tester_log` | The JSON-RPC log of a session |

### Checks ("MCP lint")

Checks run on connect and on demand. Definitions are checked on every run. Results (structuredContent, content
blocks) are checked for the tools called in the session. A run also sends `ping` and one `tools/call` with a tool
name that does not exist, `__stubyard_probe_unknown_tool__`.

| Check | Severity | Rule |
|---|---|---|
| `protocol-version` | error / info | Negotiated version is known (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05); info for 2024-11-05 |
| `server-info` | warn | `serverInfo.name` and `serverInfo.version` present |
| `capabilities` | error / warn | Error: a declared list fails. Warn: items are served without the capability declared |
| `ping` | error | `ping` answers with an empty result |
| `jsonrpc` | error | Every message from the server is valid JSON-RPC 2.0 |
| `tool-name` | warn / info | Warn: the name is not 1–128 characters of `[A-Za-z0-9_.-]`. Info: longer than 64 characters, or contains `.` (some LLM APIs reject these) |
| `tool-name-duplicate` | error | Tool names are unique |
| `tool-description` | warn | Description present and at most 2,000 characters |
| `tool-list-size` | warn | Whole tool list under ≈10,000 tokens (characters ÷ 4) |
| `input-schema` | error | `inputSchema` present, a valid JSON Schema, `type: "object"` |
| `schema-required` | error | `required` lists only existing properties |
| `property-description` | info | Input properties have descriptions |
| `output-schema` | error | `outputSchema` is a valid object schema |
| `structured-content` | error / info | Error: a tool with outputSchema returns no structuredContent, or returns one that does not validate. Info: no text block is included as a fallback |
| `tool-annotations` | warn | `readOnlyHint` and `destructiveHint` are not both true |
| `content-blocks` | error | Content blocks have a known type and their required fields |
| `error-handling` | warn | Tool failures come back as `isError` results, not JSON-RPC errors (other than -32602/-32601/-32600/-32700); an unknown tool is rejected |
| `slow-response` | warn / info | Warn: initialize, ping or a list call takes more than 2 s. Info: a tool call takes more than 10 s |
| `list-changed` | warn | `list_changed` notifications are sent only when the capability declares `listChanged` |
| `pagination` | error | `nextCursor` never repeats |
| `resource-shape` | warn | Resources have `uri` and `name`; templates have `uriTemplate` and `name` |
| `prompt-shape` | warn | Prompts and their arguments have names |

### Export / import

The project export includes the sections `mcpTargets` and `mcpSavedCalls`. Header values are exported blank,
with `headersMasked: true`, unless the export includes secrets. Import warns about targets whose headers have to be
filled in again. Open sessions are not exported.

### Not supported / known gaps

- stdio: use a bridge.
- OAuth authorization flows: set a ready token as an `Authorization` header instead.
- Sampling, elicitation and roots requests from the server are refused with -32601.
- stubyard's own `/mcp` negotiates up to 2025-06-18.

---

## W. Scheduled actions (send later, repeat)

stubyard can make a dashboard API call **later**, once or on a fixed-rate repeat. Use it to test what your app does when
something arrives late: a payment webhook 30 seconds after checkout, a user who replies STOP after a minute, a provider
that goes down in 5 minutes, a mock that switches to "Card declined" halfway through a test.

A scheduled action is one allowlisted REST call that stubyard stores and runs at the given time through its own API. The
result is the same as making the call yourself: same validation, same traffic log entries, same events.

Dashboard: **project → Scheduled** (`/p/<project>/scheduled`). There is also a **Later ▾** button next to **Send now** on a
webhook template, next to **Run** on a webhook sequence, and next to **Send** in a user's reply box. It offers 10 s, 1 min,
5 min, or **Custom…** (any delay, optional repeat, label).

### What can be scheduled

`path` is the part after `/api/projects/<project>`. A full `/api/projects/<project>/…` path is accepted too. Query strings,
`..`, other projects and calls that are not on this list are rejected with 400, and the error lists the allowed calls.

| Action | Call | Body (same as the REST call) |
|---|---|---|
| `webhook.send` | `POST /webhook-templates/:id/send` | `{"asUser":"admin","data":{…}}` |
| `webhook.sequence` | `POST /webhook-sequences/:id/run` | `{"asUser":"admin","data":{…}}` |
| `user.reply` | `POST /users/:id/reply` | `{"channel":"sms","text":"STOP"}` |
| `rule.set` | `POST /users/:id/rules`, `POST /providers/:instance/rules`, `…/rules/preset/:preset` | a rule, e.g. `{"action":"fail","channel":"sms"}` (none for a preset) |
| `rule.clear` | `DELETE /users/:id/rules`, `DELETE /providers/:instance/rules`, `DELETE /rules/:rule`, `POST /rules/reset` | none |
| `mock.scenario` | `PATCH /mocks/:mock/active-scenario` | `{"scenario":"Card declined"}` |

`:id` can be anything the REST call accepts (template / sequence id or name; user id, email, phone, name or role).

### Create

```bash
# Payment webhook 30 s from now
curl -s -X POST localhost:4000/api/projects/hyper/schedules -H 'content-type: application/json' -d '{
  "method": "POST", "path": "/webhook-templates/payment.succeeded/send",
  "body": {"data": {"order": {"id": "ord_1"}}},
  "delaySeconds": 30, "label": "payment after checkout"}'
# → 201 {"id":"…","status":"pending","nextAt":"…","fired":0,"maxFires":1,"url":"/api/projects/hyper/webhook-templates/payment.succeeded/send",…}

# Customer replies STOP every minute, 5 times, starting in 10 s
curl -s -X POST localhost:4000/api/projects/hyper/schedules -H 'content-type: application/json' -d '{
  "method": "POST", "path": "/users/customer/reply", "body": {"channel": "sms", "text": "STOP"},
  "delayMs": 10000, "everyMs": 60000, "maxFires": 5}'

# Twilio instance "sms" goes down at a fixed time
curl -s -X POST localhost:4000/api/projects/hyper/schedules -H 'content-type: application/json' -d '{
  "method": "POST", "path": "/providers/sms/rules/preset/down-10m", "at": "2026-11-20T15:00:00Z"}'
```

| Field | Meaning |
|---|---|
| `method`, `path`, `body` | The call (see the table above). `body` is JSON, max 256 KB |
| `delayMs` \| `delaySeconds` \| `at` | When: give **exactly one**. `at` is an ISO time. Max 30 days ahead. An `at` up to the grace period in the past fires now; older is 400 |
| `everyMs` | Repeat at a fixed rate (≥ 1000). Leave out for one fire |
| `maxFires` | Fires in total: default 1, or 10 with `everyMs`. Max 100. More than 1 needs `everyMs` |
| `label` | Shown in the dashboard |
| `?run=<key>` or `X-Hub-Run` | Run-scoped (see below). The run must be active |

A project can have at most 500 pending or paused schedules (409 above that).

### Status and results

| Status | Meaning |
|---|---|
| `pending` | Waiting for `nextAt` |
| `paused` | Not firing until resumed |
| `done` | All fires made (`fired == maxFires`) |
| `failed` | The call answered HTTP ≥ 400 (or could not run). A repeat stops there |
| `cancelled` | Cancelled by you, by a project reset, or because its test run stopped |
| `missed` | A one-shot whose time passed while stubyard was not running (more than the grace period) |

Each schedule records `fired`, `missed`, `lastFiredAt`, `lastStatus` (HTTP status of the call), `lastResult` (response
body, first 2 KB) and `lastError`. A webhook that **your app** rejects still counts as fired. The send call answers 200
with `"ok": false`, and the details are in `lastResult` and the traffic log.

**Late fires.** If stubyard was stopped, a fire that is less than the grace period late (`STUBYARD_SCHEDULE_GRACE_MS`, default
600000 = 10 min) still runs. An older one-shot becomes `missed`. An older repeat skips to its next future slot,
adds the skipped slots to `missed` and does not fire them all at once. Only real fires count towards `maxFires`.

### Manage

```bash
S=localhost:4000/api/projects/hyper/schedules
curl -s "$S"                              # all (pending/paused first); ?status=pending,paused | active | finished; ?run=w1
curl -s "$S/<id>"
curl -s -X PATCH "$S/<id>" -H 'content-type: application/json' -d '{"delaySeconds": 5, "body": {"data": {"n": 2}}}'
curl -s -X POST "$S/<id>/run-now"         # fire now (counts as a fire; the timetable stays)
curl -s -X POST "$S/<id>/pause"
curl -s -X POST "$S/<id>/resume"          # a passed one-shot fires now; a repeat continues at its next slot
curl -s -X DELETE "$S/<id>"               # cancel (pending/paused); delete (finished)
curl -s -X POST "$S/flush" -H 'content-type: application/json' -d '{}'   # fire every pending one once, now, in time order
```

- **PATCH** changes `label`, `body`, the time (`delayMs` / `delaySeconds` / `at`), `everyMs` (null = no repeat) and `maxFires`. It
  works on pending and paused schedules only (409 otherwise). The action and target cannot change: cancel and create a new
  one instead.
- **flush** returns `{"fired": n, "results": [{"id","status","ok","error","result","label","action"}]}`. With `{"run":"w1"}`
  (or `?run=w1`) only that run's schedules fire. In tests this is faster than waiting.
- Finished schedules are deleted 24 h after they finish, by the maintenance pass.

### Test runs

Created with `?run=<key>` (or `X-Hub-Run`), a schedule belongs to that run. It fires with `X-Hub-Run: <key>`, so a rule
it sets, a mock scenario it switches, or a user it replies as is the run's. When the run stops, its pending and paused
schedules are cancelled. A fire that finds the run already stopped cancels the schedule.

```bash
curl -s -X POST "localhost:4000/api/projects/hyper/schedules?run=w1" -H 'content-type: application/json' \
  -d '{"method":"POST","path":"/users/customer/rules/preset/blocked","delaySeconds":20}'
```

### MCP tools

| Tool | Use |
|---|---|
| `schedule_action` | `{project, action, template \| sequence \| user \| instance \| mock \| rule, preset?, body?, delay_seconds \| at, every_seconds?, max_times?, label?, run?}`. For example `{"project":"hyper","action":"webhook.send","template":"payment.succeeded","body":{"data":{"order":{"id":"o1"}}},"delay_seconds":30}`. `rule.set` needs `user` or `instance`, plus `preset` or a rule `body`. `rule.clear` with no target resets all rules of the project |
| `list_scheduled` | `{project, status?, run?}`: id, call, status, nextAt, fired / maxFires, last status / error (read-only) |
| `cancel_scheduled` | `{project, id}` |
| `flush_scheduled` | `{project, run?}`: fire every pending one now and return the results |

### Dashboard

**Scheduled** lists pending and paused actions, with tabs for finished ones and all. Each row shows the label or action,
the target, the next run with a countdown and the repeat count, the status, its run chip, and the last result. The row
actions are **▶ Run now**, **Pause** / **Resume**, **Edit (✎)** and **Cancel (✕)**. A finished row has **Delete**. **Flush
pending** fires everything pending once. **New…** creates any allowed call by hand. The list updates live. On narrow
screens each schedule is shown as a stacked card.

**Internal delayed jobs** (collapsed) is a read-only list of stubyard's own queued jobs: status callbacks, delayed
deliveries and bounces. It is the same data as `GET /api/projects/<project>/jobs`, without the jobs that fire schedules.

### Notes and limits

- Schedules are stored in the database and survive a restart. After a crash during a fire, that fire is not repeated.
- There is no cron syntax and no catch-up of missed repeats. The dashboard has no **Later** button for rules or mock
  scenarios: use the API, MCP or **New…** for those.
- A project **reset** cancels every pending or paused schedule. Deleting the project deletes its schedules. Schedules
  are not part of the project export.
- `GET /api/schedules/reference` lists the actions, the allowed calls, the statuses and the grace period.

---

## X. HTML run reports, clock offsets, @stubyard/client run helpers

Three additions for test runs: a self-contained **HTML report** per run, **per-feature clock offsets** ("time travel" for expiry tests), and **run helpers** in `@stubyard/client`. Examples use project `hyper` and http://localhost:4000.

### HTML run reports

Every run (active or stopped) has a one-page HTML report: inline CSS, no scripts, no external assets, light/dark theme, prints cleanly. Save it as a CI artifact next to your test results.

| Call | Result |
|---|---|
| GET /api/projects/hyper/runs/<run>/report.html | text/html page (<run> = key or id) |
| GET …/report.html?download=1 | same, as attachment stubyard-run-<key>.html |
| GET …/runs/<run>/report?format=html | alias of report.html (format=json or none = JSON; else 400) |
| GET …/runs/<run>/report | JSON report (unchanged) |
| POST …/runs/<run>/stop | now also returns reportHtmlUrl |

Sections: run header (key, label, status, start/stop, duration, meta, clock offsets), warnings, summary tiles (users, messages, requests, problems, lint errors/warnings), users, messages (channel, to, subject, status, OTP, rule, lint, time + counts by channel/status), content checks (counts by check + findings per message), traffic (counts by outcome + problem requests), rules with hits, mock overrides, file storage (only when the run touched storage). Every value is HTML-escaped; the page is served with a strict content-security-policy. A stopped run shows its frozen report.

```bash
curl -s -X POST localhost:4000/api/projects/hyper/runs/w1/stop | jq .reportHtmlUrl
curl -s -o run-w1.html "localhost:4000/api/projects/hyper/runs/w1/report.html?download=1"
```

UI: Test runs → a run → **Open HTML report** (new tab), **Download HTML**, **Download JSON**.

### Clock offsets (per feature)

A signed amount added to **stubyard's own clock** for one feature (your app's clock is untouched). Use it to test "code expired", "token expired", "webhook timestamp too old" without waiting.

| Feature | What moves |
|---|---|
| totp | Authenticator codes (GET …/authenticators, …/authenticators/code, …/authenticators/:id/code). serverTime stays real; response adds offsetMs. |
| auth | Login providers: id_token iat/exp/auth_time; expiry of codes, refresh tokens, access tokens, pending logins; expiry checks for code exchange, refresh, userinfo, introspection. |
| verify | Twilio Verify / Vonage Verify: expiry when a code is **checked** (stored expiry and expire job stay real). |
| webhooks | Signed timestamp (Stripe t=, Svix / Standard Webhooks, …) of sent webhooks, sequences and re-signed replays. |

Not shifted: message timestamps, storage presigned-URL expiry, the job scheduler, retention, the iat inside access-token JWTs of the oidc/microsoft presets (their expiry and checks do follow auth).

Offsets: strings "+2h", "-90s", "1d", "1h30m", "5min", "500ms" (units ms, s, m/min, h, d, w, y; signs and combinations allowed); numbers are **milliseconds**; 0 / null / "" clears; limit ±10 years; bare "90" → 400.

Scope: project offsets live in project settings (settings.timeOffsets, ms), kept through export/import and project reset. A run override (?run=<key> or X-Hub-Run) applies only to that run's traffic (its users, requests with its header or /run/<key>/ prefix, its authenticator keys). Resolution **active run > project > 0**. Run overrides end when the run stops. While any offset is active, the run report warns "Clock offsets active: auth +2h, …".

#### API

```bash
# Set (merged; 0/null clears one feature)
curl -X PUT localhost:4000/api/projects/hyper/time -H 'content-type: application/json' -d '{"offsets":{"auth":"+2h","totp":0}}'
# One feature
curl -X PUT localhost:4000/api/projects/hyper/time -H 'content-type: application/json' -d '{"feature":"verify","offset":"+11m"}'
# Read
curl localhost:4000/api/projects/hyper/time
# Run override (run must be active: 409 when stopped, 404 unknown)
curl -X PUT 'localhost:4000/api/projects/hyper/time?run=w1' -H 'content-type: application/json' -d '{"offsets":{"auth":"-2h"}}'
# Clear all (project, or run with ?run=)
curl -X DELETE localhost:4000/api/projects/hyper/time
```

GET/PUT/DELETE answer:

```json
{ "serverTime": "2026-11-20T10:00:00.000Z", "features": ["totp","auth","verify","webhooks"],
  "offsets": { "auth": 7200000 },
  "run": { "id": "…", "key": "w1", "status": "active", "offsets": {} },
  "effective": { "totp": "…", "auth": "2026-11-20T12:00:00.000Z", "verify": "…", "webhooks": "…" },
  "effectiveOffsets": { "totp": 0, "auth": 7200000, "verify": 0, "webhooks": 0 },
  "active": { "auth": "+2h" } }
```

offsets = project's stored values; run only with ?run=/X-Hub-Run; effective* / active = run override > project. Unknown feature, unreadable offset or missing offsets/feature → 400. Project change publishes project.updated; run change runs.changed.

#### Recipes
- Expired login code: POST /api/projects/hyper/auth/<provider>/code ({user, redirectUri, clientId}), set auth +2h, exchange at the token endpoint → invalid_grant "The authorization code has expired".
- Already-expired id_token: auth -2h, then POST /api/projects/hyper/auth/<provider>/token {user} → exp in the past.
- Expired OTP (Verify): send, set verify +11m, check the right code → Twilio 404 (20404), Vonage 410 "expired".
- Stale webhook: webhooks -10m, send a signed template; your app should reject it.
- Next TOTP window: totp +30s, read …/authenticators/code?label=….
- One worker only: PUT /api/projects/hyper/time?run=w3 {"offsets":{"auth":"+2h"}}.

#### MCP
| Tool | Input | Notes |
|---|---|---|
| set_time_offset | { project, feature: totp\|auth\|verify\|webhooks, offset: "+2h" \| number(ms) \| 0, run? } | 0/"" clears; with run, only that active run |
| get_time_offsets | { project, run? } | read-only; same answer as GET /time |

#### UI
**Project Settings → Clock offsets**: one row per feature with presets (−1h, +5 min, +1h, +1d), a custom field (-90s, 2h30m) with Set, and Reset; header "N active" badge + Reset all; rows with an offset show the shifted time. The **Authenticator** page shows a "clock +5m" badge while a totp offset is set; its countdown follows the shifted clock.

### @stubyard/client run helpers

Import from @stubyard/client/runs (also re-exported from @stubyard/client). fetch-only: Node 18+, Playwright, Vitest, Jest.

```ts
import fs from 'node:fs';
import { startRun, withRun, stopRun, getRunReport } from '@stubyard/client/runs';

const run = await startRun({
  project: 'hyper',
  key: `w${process.env.TEST_WORKER_INDEX}`,
  replace: true,                           // stop+purge a crashed worker's run with the same key
  users: [{ role: 'customer', count: 2 }],
});
await page.setExtraHTTPHeaders(run.headers);              // { 'X-Hub-Run': 'w0' }
const customer = run.user('customer');                    // run.user('customer', 1) = second; throws when absent
const [admin] = await run.mint({ role: 'admin' });        // added to run.users
const msg = await run.waitForMessage({ user: customer.email!, channel: 'email', timeoutMs: 10_000 });
await run.setTimeOffset('auth', '+2h');                    // this run only; 0 clears
const json = await run.report();
const { report, reportHtmlUrl } = await run.stop();        // or run.stop({ purge: true })
fs.writeFileSync('run.html', await getRunReport({ project: 'hyper', run: run.id, format: 'html' }));

await withRun({ project: 'hyper', users: [{ role: 'admin' }] }, async (run) => { /* stopped in finally, error rethrown */ });
```

| Function | Notes |
|---|---|
| startRun({ apiUrl?, project, key?, label?, ttlMinutes?, users?, captureUnattributed?, claims?, meta?, replace?, fetch? }) | returns RunHandle |
| RunHandle fields | id, key, project, users, headers, urls (mockPrefix, hookPrefix, smtpUsername, report, reportHtml) |
| RunHandle methods | user(role, index?), mint({role?, name?, count?, email?, phone?}), report(), reportHtml(), setTimeOffset(feature, offset), waitForMessage({user?, to?, channel?, timeoutMs?}), stop({purge?}) |
| stopRun({ apiUrl?, project, run, purge? }) | { run, report, reportHtmlUrl } |
| getRunReport({ apiUrl?, project, run, format?: 'json'\|'html' }) | JSON report or HTML string |
| withRun(options & { purge? }, fn) | starts, passes run to fn, stops in finally, returns fn's value |

apiUrl defaults to http://localhost:4000; pass fetch for a custom fetch. HTTP errors throw "stubyard answered <status> for <METHOD> <url>: <body>". waitForMessage long-polls /messages/wait?run=<id> and throws "No message for … within N ms" on timeout.

---

## Y. AI chat (agents, conversations, saved prompts)

stubyard can run a small LLM agent per project, built on the Vercel AI SDK v7. The agent talks to a model and calls
**stubyard's own read-only tools** (always scoped to that project) and the tools of **your MCP servers** (any MCP
tester target). Use it to check by hand that your MCP server works with a real model, and save prompts with
deterministic expectations to re-run after every change. Tokens are counted per message and per conversation;
stubyard never estimates cost.

### Y.1 AI providers (global; keys are write-only)

`System → AI providers`, or `/api/system/ai-providers`:

| Preset | kind / preset | Default base URL | Env var (wins over a stored key) |
|---|---|---|---|
| OpenAI | `openai` | https://api.openai.com/v1 | `STUBYARD_OPENAI_API_KEY` or `OPENAI_API_KEY` |
| Anthropic | `anthropic` | https://api.anthropic.com/v1 | `ANTHROPIC_API_KEY` |
| Google | `google` | https://generativelanguage.googleapis.com/v1beta | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenRouter | `openai-compatible` / `openrouter` | https://openrouter.ai/api/v1 | `OPENROUTER_API_KEY` |
| Ollama | `openai-compatible` / `ollama` | http://host.docker.internal:11434/v1 | `STUBYARD_OLLAMA_URL` (base URL, no key) |
| Custom | `openai-compatible` / `custom` | (required) | none |

- Each env var that is set also appears as a read-only provider `env:openai`, `env:anthropic`, `env:google`,
  `env:openrouter` or `env:ollama`, marked with an "env" badge. It cannot be changed or deleted.
- Responses never contain a key: you get `hasKey`, `source` (`env` | `stored`), `envVar` and `keyHint`
  ("••••1234"). On PATCH, leaving out `apiKey` keeps the key and `apiKey: ""` removes it. Extra `headers` come back masked;
  sending a masked value back unchanged keeps it.
- **Changing the base URL to another host clears the stored key and header values**, unless you send a new
  `apiKey` / `headers` in the same PATCH (masked values sent back are dropped then).
- **Environment keys apply only on the kind's default host** (api.openai.com, api.anthropic.com,
  generativelanguage.googleapis.com, openrouter.ai). A provider with a custom base URL uses only its stored key.
- Keys are never exported, logged or sent to MCP tools. Provider error messages are scrubbed of keys before
  they reach the API, the stream or the database.
- **Egress is pinned.** Each provider may only call the host of its own base URL. Any other host is refused with
  `stubyard blocked a chat request to <host>: provider "X" may only call <host>`. Redirects are not followed.
- A factory reset deletes all stored providers; a project reset does not.

```bash
curl -X POST localhost:4000/api/system/ai-providers -H 'content-type: application/json' \
  -d '{"name":"local","kind":"openai-compatible","preset":"custom","baseUrl":"http://host.docker.internal:1234/v1"}'
curl -X POST localhost:4000/api/system/ai-providers/local/test -H 'content-type: application/json' -d '{"model":"qwen3"}'
curl localhost:4000/api/system/ai-providers/local/models        # the provider's own /models list
```

### Y.2 Agents

`/p/<slug>/chat/agents`, or `/api/projects/<slug>/chat/agents` (GET, POST; GET, PATCH or DELETE `/:id`, where :id is the id or slug):

```json
{ "name": "QA helper", "provider": "openai", "model": "gpt-5-mini",
  "instructions": "You are a QA assistant for this project. Be brief.",
  "tools": { "builtin": true, "targets": [ { "target": "My MCP server", "tools": "*" } ] },
  "maxSteps": 10, "maxOutputTokens": 2000, "temperature": 0.2 }
```

- `tools.builtin` is `true` (all), `false` (none) or a list of names. Built-in tools are a fixed allowlist of
  read-only, project-scoped stubyard MCP tools (`GET …/chat/builtin-tools`); `mcp_tester_checks`, `mcp_tester_connect`
  / `_call`, `export_project` and every tool that changes state are never offered. The model sees them as `stubyard__<tool>` without the `project`
  argument, which stubyard always sets to the agent's project, whatever the model asks for.
- `tools.targets` lists MCP tester targets (name or id), each with `"*"` or a list of tool names. The model sees
  them as `<target>__<tool>`. Calls go through the MCP tester session, so they show up in its log tagged "chat". A
  target that is missing or unreachable becomes a per-target error and does not break the turn. A failing tool
  returns `Error: …` text to the model; it is not thrown.
- `maxSteps` caps the tool loop: 1–25, default 10.
- `GET …/agents/:id/tools` shows the tools exactly as the model sees them, plus `errors` per target.
- The response includes `providerOk` and `providerError` (e.g. "provider X has no API key").

### Y.3 Conversations (streamed)

`/p/<slug>/chat`, or `/api/projects/<slug>/chat/conversations`:
- GET (`?agent=`), POST `{agent?, title?}`
- GET, PATCH `{title?, agent?}`, DELETE `/:id`

GET `/:id` returns the stored messages: AI SDK UIMessage `parts` plus `model`, `tokensIn`, `tokensOut`,
`steps`, `finishReason`, `durationMs` and `error`.

`POST …/conversations/:id/stream` is an AI SDK v7 **UI message stream**: `text/event-stream` with the header
`x-vercel-ai-ui-message-stream: v1`, which `useChat` + `DefaultChatTransport` read. Send **only the new message**;
stubyard keeps the history:

```json
{ "message": { "id": "m1", "role": "user", "parts": [ { "type": "text", "text": "Which test users exist?" } ] },
  "agent": "qa-helper", "trigger": "submit-message" }
```

- `trigger: "regenerate-message"` (no message) drops the last reply and asks again.
- Errors found before streaming starts are JSON 4xx: unknown agent, missing key, bad message.
- Errors during the stream arrive as an `error` chunk and are stored on the assistant message.
- If the client disconnects, the model call is aborted, and whatever arrived so far is still saved.
- A project reset deletes conversations. Agents and saved prompts are kept and exported; conversations are not
  exported.

### Y.4 Saved prompts and expectations

`/p/<slug>/chat/prompts`, or `/api/projects/<slug>/chat/prompts`:
- GET (`?agent=`), POST `{agent, name?, prompt, expectations}`
- GET, PATCH, DELETE `/:id`
- POST `/:id/run`
- POST `/run` `{ids?, agent?}`, which runs them one after another

Each check is deterministic, and text checks are case-insensitive:

| Expectation | Passes when |
|---|---|
| `contains: ["admin"]` | the reply contains every string |
| `notContains: ["sorry"]` | the reply contains none of them |
| `matches: "/\\d+ users/i"` | the regex matches (a plain pattern gets flag `i`) |
| `toolCalled: ["list_test_users"]` | each tool was called (full name, or the part after `__`) |
| `toolNotCalled: [...]` | none of them was called |
| `maxSteps: 3` / `maxTokens: 5000` | steps ≤ limit / input + output tokens ≤ limit |
| `finishReason: "stop"` | the run finished that way |

A run with an error never passes. The result `{passed, checks:[{id, ok, detail}], text, toolCalls, steps, usage}`
is stored as `lastResult`.

### Y.5 MCP tools

| Tool | What it does |
|---|---|
| `list_chat_agents {project}` | Agents with provider/model, tools and `providerOk` (read-only) |
| `ask_agent {project, agent, prompt, conversation?}` | One non-streamed turn. Returns `text`, `toolCalls`, `steps`, `usage`, `finishReason`, `conversation` (pass it back to continue) |
| `run_saved_prompts {project, ids?, agent?}` | Runs saved prompts and returns `{passed, failed, results}` |

No MCP tool reads or writes provider keys. Agents cannot call `ask_agent`, `run_saved_prompts` or any write tool.

### Y.6 Dashboard

- **Chat → Conversations:** a list and a thread. On phones you see one or the other, with a back arrow. Pick the
  agent in the thread header. Tool calls are collapsible cards showing input and result, and MCP-target tools link
  to the MCP tester. Each reply shows model, tokens in/out, steps and time; the header shows the conversation total.
  Enter sends, Shift+Enter starts a new line; Stop and Regenerate are next to Send.
- **Chat → Agents:** cards plus an editor with provider, a model list loaded from the provider, instructions, step and
  token caps, temperature, and a tool allowlist tree (stubyard: all / pick / none; each MCP target: all / only…).
  The **Tools** button shows the resolved list.
- **Chat → Saved prompts:** expectations shown as chips, Run / Run all, and pass/fail with the failed checks expanded.
- **System → AI providers:** add from a preset; Test sends one prompt; List models; Edit, Disable or Delete.
  Rows from environment variables are read-only.

---

## Z. Payments (fake Stripe Checkout, PayTabs, PayPal)

stubyard has fake payment gateways that your app talks to instead of the real ones. Each one has a hosted payment
page, test cards, a forced-outcome system, signed webhooks, refunds and integration checks ("lint"). No real
money moves, no real account is needed, and nothing ever reaches Stripe, PayTabs or PayPal.

| Preset | id | Methods | What is simulated |
|---|---|---|---|
| Stripe Checkout | `stripe-checkout` | card, applepay | `/v1/checkout/sessions` (hosted, `mode=payment`, `price_data` line items), payment_intents, charges, refunds, events |
| PayTabs | `paytabs` | card, mada, stcpay, applepay | `/payment/request` (sale / auth, then capture / void / refund) and `/payment/query`, return POST + callback (IPN) |
| PayPal Standard | `paypal` | paypal | `/v1/oauth2/token`, `/v2/checkout/orders` (intent CAPTURE), capture, captures / refunds, `verify-webhook-signature` |

Out of scope: subscriptions, saved cards, Connect, disputes, Stripe Elements / PaymentIntents-only flows.

### Z.1 Add a gateway and connect your app

Dashboard: **Providers → Payments → Add payment provider**. API:

```bash
curl -X POST localhost:4000/api/projects/shop/payment-instances -H 'content-type: application/json' \
  -d '{"preset":"stripe-checkout","config":{"webhookUrl":"http://host.docker.internal:3000/webhooks/stripe"}}'
```

- The slug defaults to `stripe`, `paytabs` or `paypal` (then `-2`, `-3`…). Credentials are generated:
  `sk_test_…` / `pk_test_…` / `whsec_…` for Stripe; a profile id and server key for PayTabs; a client id and
  secret, a webhook id and an RSA key pair for PayPal.
- Each instance answers under `/pay/<project>/<instance>/`. The response has `urls` (`browser`, `backend`
  for an app in Docker, `backendLocal`) and `connect.env`, a ready `.env` block (`STRIPE_API_BASE`,
  `PAYTABS_BASE_URL`, `PAYPAL_API_BASE`…).
- Point the SDK base URL at the instance:
  - stripe-python `stripe.api_base`, stripe-php `api_base`, stripe-go `SetBackend`.
  - stripe-node only takes host / port, no path prefix. Set `STUBYARD_STORAGE_DOMAIN` (for example `stubyard.test`)
    and use the host `<instance>.<project>.pay.<domain>`.
  - PayTabs: replace `https://secure.paytabs.sa`. PayPal: replace `https://api-m.sandbox.paypal.com`.
- Secrets are masked in GET responses unless you add `?secrets=1`. In a project export they go in a separate
  secret section.
- `PATCH …/payment-instances/<slug>` changes `name`, `enabled` and `config`. Config keys:
  - `webhookUrl`
  - `webhookDelayMs`: default 500; 0 = the webhook is sent before the browser returns
  - `settleDelayMs`: `pending_then_success`, default 3000
  - `defaultOutcome`
  - `magicAmounts`: off by default
  - `strictKeys`: accept only this instance's credentials
  - the credentials themselves

  A disabled instance answers 503.
- A live key (`sk_live_…`) gets 401 and a `pay.live-key` lint error.
- Return / cancel / callback URLs must be absolute http(s) URLs. Anything else (relative, `javascript:`…) is
  rejected at create with the provider's own 400 (Stripe `url_invalid`, PayPal `INVALID_PARAMETER_SYNTAX`,
  PayTabs code 4) and a `pay.return-url-missing-or-bad` lint. Without a usable return URL the done page shows
  `stubyard-no-return`. Hosted pages send a strict Content-Security-Policy.
- In the traffic log of `/pay/…` calls, credential headers are redacted (`Bearer sk_test_••••wxyz`), and card
  fields sent to a gateway API (`number`, `pan`, `card_number`, `cvc`, `cvv`, `security_code`) are masked
  (last 4 kept), also in the stored request.

### Z.2 The flow

1. Your app creates the checkout (Stripe session, PayTabs `payment/request`, PayPal order) with the provider's own
   request format. The response has the provider's redirect URL (`url`, `redirect_url`, the `approve` /
   `payer-action` link). It points to stubyard's hosted page `…/page/<payment id>`.
2. The browser opens the page. The page offers a test-user picker, the payment methods, a card field (test cards
   only) and the buttons **Pay**, **Decline**, **Cancel** and "More outcomes".
   - Card digits never leave the page. Only the brand, the last 4 digits and the magic id are posted.
   - A real-looking card number is refused and flagged as `pay.real-card-entered`.
   - `3ds` shows a challenge page. STC Pay sends an OTP to the test user's SMS inbox.
3. stubyard redirects to your return URL (Stripe `success_url?session_id=…`, PayTabs signed form POST, PayPal
   `return_url?token=…&PayerID=…`) or to the cancel URL. It also schedules the webhooks (Z.4).
4. PayPal only: your app captures the order (`POST /v2/checkout/orders/<id>/capture`). PayTabs `auth`: your app
   captures with `tran_type: capture`.

Stable page selectors for browser tests (`data-testid`):

- `stubyard-pay`, `stubyard-decline`, `stubyard-cancel`
- `stubyard-method-<method>`
- `stubyard-otp`
- `stubyard-3ds-pass` / `stubyard-3ds-fail`
- `stubyard-continue` (shown when an outcome is forced)
- `stubyard-done`

### Z.3 Outcomes, test cards and rules

Outcome grammar: `success`, `decline[:generic|insufficient_funds|expired_card|incorrect_cvc|processing_error]`,
`cancel`, `abandon`, `3ds_success`, `3ds_fail`, `pending_then_success`. Add modifiers with `+` or `,`:

- `no_webhook`
- `duplicate_webhook`
- `webhook_delay=<ms>`
- `no_redirect`
- `slow=<ms>`

Example: `success+duplicate_webhook`.

What decides the outcome, first match wins:

1. The `X-Hub-Payment-Outcome` header on the create call. For PayPal, `PayPal-Mock-Response` also works.
2. Run rule
3. User rule
4. Instance rule
5. Magic card
6. Magic amount
7. The button clicked on the page, or the API `complete`
8. The instance `defaultOutcome`

| Card | Magic id | Outcome |
|---|---|---|
| 4242 4242 4242 4242 | `success` | succeeds |
| 4000 0000 0000 0002 | `decline` | declined (generic) |
| 4000 0000 0000 9995 | `insufficient_funds` | declined |
| 4000 0000 0000 0069 | `expired_card` | declined |
| 4000 0000 0000 0127 | `incorrect_cvc` | declined |
| 4000 0000 0000 0119 | `processing_error` | declined |
| 4000 0025 0000 3155 | `3ds` | 3-D Secure challenge |

Other public test numbers (4111 1111 1111 1111, 5555 5555 5555 4444, Amex 3782 8224 6310 005…) are accepted.
With them, the clicked button decides the outcome.

Magic amounts (only when `magicAmounts` is on) use the last two minor digits: `.02` decline, `.05` insufficient
funds, `.12` 3DS fail, `.99` pending then success.

Rules force the next payments:

```bash
# next 2 Stripe payments of run w3 decline with insufficient funds
curl -X POST 'localhost:4000/api/projects/shop/payment-rules?run=w3' -H 'content-type: application/json' \
  -d '{"outcome":"decline:insufficient_funds","instance":"stripe","count":2}'
curl 'localhost:4000/api/projects/shop/payment-rules?all=1'          # list (also used-up rules)
curl -X DELETE 'localhost:4000/api/projects/shop/payment-rules?run=w3' # or /payment-rules/<id>, ?instance=, ?user=
```

Rule body fields:

- `outcome`: required
- `instance`, `user`, `run`: the scope (or `?run=` / the `X-Hub-Run` header)
- `count`: default until deleted
- `after`: let N payments through first
- `minutes`: expiry
- `label`

A run's rules are removed when the run stops.

### Z.4 Webhooks

They are sent like the provider sends them, through stubyard's scheduler, so you can see them under **Scheduled**
and fire them at once with `POST /api/projects/<slug>/schedules/flush`.

- **Stripe** signs with `Stripe-Signature` and the instance `whsec_`, so `constructEvent` works unchanged.
  - Paid: `payment_intent.succeeded` + `checkout.session.completed`.
  - Pending: `checkout.session.completed` (unpaid), later `payment_intent.succeeded` +
    `checkout.session.async_payment_succeeded`.
  - `payment_intent.payment_failed`, `checkout.session.expired`, `charge.refunded`.
- **PayTabs** POSTs to the request's `callback` (or the instance `webhookUrl`) with a `Signature` header: the
  HMAC-SHA256 of the raw body, keyed with the server key. The browser return is a form POST with a `signature`
  field (GET when `return_using_get`).
- **PayPal** sends `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED`.
  - The `PAYPAL-TRANSMISSION-*` headers are RSA-signed with the instance key. The cert is at
    `…/v1/notifications/certs/<id>`.
  - `POST …/v1/notifications/verify-webhook-signature` checks the signature for real and returns `SUCCESS` or
    `FAILURE`.
  - Apps that never call it get `pay.paypal-signature-never-verified`.
- If your app does not answer 2xx, stubyard retries after 5 s, 30 s and 120 s and flags `pay.webhook-rejected`.
- Resend: `POST /api/projects/<slug>/payments/<id>/webhooks/resend {"event":"checkout.session.completed"}` (an
  event type or a webhook row id from the timeline).

### Z.5 Control API (`/api/projects/<slug>/…`)

| Call | Purpose |
|---|---|
| `GET /api/payment-presets` | presets, statuses, outcomes, decline reasons, modifiers, magic cards, lint checks |
| `GET/POST payment-instances`, `GET/PATCH/DELETE payment-instances/<slug>` | gateways |
| `GET payments?status=paid,failed&instance=&user=&run=&reference=&limit=` | list, newest first |
| `GET payments/<id>` | detail: `events` timeline, `refunds`, `provider` (the object the provider API returns), `lint` |
| `POST payments/wait {status, reference, run, after, timeoutMs≤60000}` | long-poll for a payment |
| `POST payments/<id>/complete {outcome, user, method, card, phone, otp}` | finish without a browser (rules still win) |
| `POST payments/<id>/refund {amount?, reason?}` | amount in minor units; omit for the rest |
| `POST payments/<id>/expire` | expire an open payment |
| `POST payments/<id>/webhooks/resend {event}` | deliver again |
| `GET payments/lint[?run=]` | integration findings |
| `GET/POST/DELETE payment-rules`, `DELETE payment-rules/<id>` | forced outcomes |

Statuses: `created`, `pending`, `requires_action`, `authorized`, `paid`, `failed`, `cancelled`, `expired`,
`partially_refunded`, `refunded`. A declined Stripe session can be retried on the same page: `failed`
goes back to open. `providerStatus` shows the provider's own wording, for example `open / unpaid`.

Payments are tied to a test run by `X-Hub-Run` / `/run/<key>/`, by the run that owns the customer's test user, or by
the default run. They are tied to a test user when `customer_email` (or the PayTabs / PayPal payer email) matches
the user. A project reset deletes payments and rules. Instances are kept.

Lint checks:

- Errors: `pay.live-key`, `pay.amount-zero`, `pay.currency-unknown`, `pay.return-url-missing-or-bad`,
  `pay.capture-before-approve`, `pay.double-capture`, `pay.refund-exceeds`, `pay.real-card-entered`.
- Warnings: `pay.amount-precision`, `pay.no-webhook-url`, `pay.webhook-rejected`, `pay.no-reference`,
  `pay.paypal-signature-never-verified`.
- Info: `pay.no-idempotency-key`.

### Z.6 MCP tools

| Tool | Use |
|---|---|
| `list_payments` | filter by status / instance / user / reference / run |
| `get_payment` | full detail with timeline and webhook attempts |
| `wait_for_payment` | wait until e.g. `status:"paid"` for a reference or run |
| `complete_payment` | finish an open payment (outcome, method, card, STC Pay otp `auto`) |
| `refund_payment` | full or partial refund |
| `set_payment_rule` / `reset_payment_rules` | force outcomes per run / user / instance |
| `resend_payment_webhook` | redeliver a webhook |
| `payment_lint` | integration findings |

Typical agent loop:

1. `set_payment_rule` (optional).
2. Drive the app to checkout.
3. `list_payments` with `status:"created,pending"`, then `complete_payment` (or click through the page).
4. `wait_for_payment` with `status:"paid"`.
5. `get_payment` to check the webhooks were 2xx, then `payment_lint`.

### Z.7 Dashboard

- **Payments** (sidebar):
  - **Payments** tab: a list with status chips, a provider filter and an order-reference search.
  - **Outcome rules** tab.
  - **Integration checks** tab.
  - Payment detail: summary, checks, webhook attempts with **Resend**, refunds, a timeline (click an event for its
    JSON), the provider object, and **Complete as…**, **Refund…**, **Expire** and **Hosted page** actions.
- **Providers → Payments**: the instances. Each has **Connect** (URLs, `.env`, SDK notes, test cards),
  **Settings** (credentials, delays, default outcome, magic amounts, strict keys) and **Outcome rules** (the rules of
  that instance).

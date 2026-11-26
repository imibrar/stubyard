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
ports rewritten to the ones you used to reach it (e.g. through an SSH tunnel). The `localhost` addresses in API
responses (`urls.backendLocal`, `*_LOCAL` connect values, storage `urls.backend`) use the host ports stubyard is
configured with (`STUBYARD_HOST_HTTP_PORT` / `STUBYARD_HOST_HTTPS_PORT`, see section 2), not the request's port.

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
| SMS and WhatsApp simulators (Twilio, Vonage, Infobip, Plivo, Sinch, Telnyx, Amazon SNS, Unifonic, Taqnyat, Msegat, 4Jawaly, OurSMS, Meta Cloud API, 360dialog, Infobip WhatsApp, Gupshup, Unifonic WhatsApp, Twilio WhatsApp, Generic), delivery reports, replies | ✅ Available | §C, §E |
| WhatsApp message templates: create, approve / reject, status webhooks, sends of unapproved templates fail (132001) | ✅ Available | §R |
| Dynamic failure rules (fail next N, block for X min, provider down, 429, bounces…) | ✅ Available | §D |
| Wait-for-message API, user lookup by role/email, test passwords | ✅ Available | §A, §B |
| MCP server for AI agents | ✅ Available | §F |
| Webhooks: receive with JSON Schema checks, send signed (HMAC/Stripe) templates, sequences, replay | ✅ Available | §G |
| Email API providers (SendGrid, Mailgun, Amazon SES, Resend, Postmark, Brevo, Mailjet, Mailchimp Transactional, Generic) with event webhooks | ✅ Available | §H |
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
| Payments: HyperPay COPYandPAY (mada), PayPal Buttons / Card Fields, PayPal authorize/capture/void, Vault | ✅ Available | §Z |
| LLM API mocks: fake OpenAI (chat, responses, embeddings) and Anthropic (messages) APIs, scripted replies, faults, record-to-mock | ✅ Available | §AA |
| Scripted auto-replies: fake test users answer emails, SMS and WhatsApp messages by rule | ✅ Available | §AB |
| AI chat extras: model matrix, save tool call as mock / saved call, Explain this, mock providers | ✅ Available | §AC |
| Push notifications: fake FCM HTTP v1 and APNs (HTTP/2) with per-user inbox | ✅ Available | §AD |
| AI personas: test users whose replies an LLM writes (goals, limits, mock providers) | ✅ Available | §AE |
| Features board: per-project plan (features with markdown details, images, status, priority; tasks and subtasks), MCP tools to keep it up to date | ✅ Available | §AG |
| Storyboards: manual walkthroughs of business flows, login recipes, data sets, Chrome extension side panel and on-page step widget, MCP authoring tools | ✅ Available | §AF |
| Payment gateways batch: Moyasar, Tap, Tabby, Tamara, Checkout.com, APS, MyFatoorah, Geidea, JazzCash, Easypaisa | ✅ Available | §Z.13–Z.19 |
| PayPal subscriptions (products, plans, billing) and disputes | ✅ Available | §Z.21 |
| Realistic payment pages (each provider's own flow, TEST notice, EN / AR) with a classic view, per provider | ✅ Available | §Z.22, §Z.23 |
| Fake payment SDKs: Stripe.js v3 + PaymentIntents + Embedded Checkout, PayPal Buttons / Card Fields / Messages, Moyasar Form, GeideaCheckout, Checkout.com Flow, Tap Card SDK, MyFatoorah session.js, PayTabs paylib, APS Merchant Page, Tabby / Tamara widgets | ✅ Available | §Z.24–Z.27 |
| Doctor: checks every callback / webhook URL from inside stubyard, with explanations | ✅ Available | §M |
| Outbound allowlist (never calls production URLs), self-signed HTTPS option | ✅ Available | §M |
| Seed projects at start (`STUBYARD_SEED`), CI recipe (GitHub Actions) | ✅ Available | §M |

All features listed above are available. Planned next: more ideas welcome (no planned items left from the roadmap).

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
| `2197` | APNs HTTP/2 (`STUBYARD_APNS_PORT`, `0` disables) |

If the container is published on other host ports (`-p 5500:4000 -p 5501:4443`), tell stubyard with
`STUBYARD_HOST_HTTP_PORT=5500` and `STUBYARD_HOST_HTTPS_PORT=5501`. They set the port of every `http(s)://localhost:…`
address stubyard gives to apps on the host (`urls.backendLocal`, `*_LOCAL` connect values, storage `urls.backend`,
webhook and mock URLs). Without them stubyard uses the port of `STUBYARD_PUBLIC_URL` when it names one
(`http://192.168.0.5:5500` gives the HTTP port 5500), else 4000 / 4443. The compose files set both from
`STUBYARD_HTTP_PORT` / `STUBYARD_HTTPS_PORT`. Docker-network addresses (`stubyard:4000`, `stubyard:4443`) do not change.

Data (projects, users, emails, logs, HTTPS CA) is kept in the `devhub-data` Docker volume (name kept from before the rename) across restarts.
`docker compose -f deploy/docker-compose.yml down -v` deletes all of it.

### 2.1 Sign-in and API tokens

A stubyard may have sign-in on (Single admin or Teams mode). Check with `GET /api/system`: `"authRequired": true` means every
`/api` call (except `GET /api/system`, `GET /api/auth/me`, `POST /api/auth/login`, `GET /api/ca.crt`), `/mcp`,
`/mailpit` and `/api/stream` need credentials. Without them the answer is 401
`{"error":"Sign in required"}` with `WWW-Authenticate: Bearer realm="stubyard"`.

**Agents and scripts use an API token.** A person creates it in the dashboard (account menu → API tokens; the
secret `sy_…` is shown once) and gives it to you, usually as `STUBYARD_TOKEN`. Send it on every call:

```bash
curl -s -H "Authorization: Bearer $STUBYARD_TOKEN" http://localhost:4000/api/projects
```

- Bearer requests need no CSRF header.
- An invalid, revoked or expired token gets 401 everywhere except the public endpoints above.
- A token cannot create or list tokens (403): tokens are managed from a signed-in dashboard session only.
- `GET /api/auth/me` returns `{mode, user, csrf, via}`; `via` is `"token"` for a token.

**MCP.** Add the header to the MCP client configuration:

```bash
claude mcp add --transport http stubyard http://localhost:4000/mcp --header "Authorization: Bearer $STUBYARD_TOKEN"
```

```json
{ "mcpServers": { "stubyard": { "type": "http", "url": "http://localhost:4000/mcp", "headers": { "Authorization": "Bearer sy_…" } } } }
```

**@stubyard/client.** Set `STUBYARD_TOKEN` in the test environment, or pass `apiToken` to any helper
(`startRun({ project, apiToken })`, `waitForPush({ …, apiToken })`, …). The token goes only to the hub's origin.

**Installing @stubyard/client.** The package is not on npm. The hub serves it, built from the same source as the hub,
at **`GET /api/client.tgz`** (public, no token: npm sends none for a tarball URL, and the package holds no data):

```bash
npm i -D http://localhost:4000/api/client.tgz      # package.json: "@stubyard/client": "http://localhost:4000/api/client.tgz"
```

It is ESM with built JS and type definitions (`@stubyard/client`, `/auth`, `/runs`, `/storyboards`, …) and has no
dependencies. Only the Docker image ships the tarball; a dev server started with `npm run dev` answers 404 with the
commands that build one (`npm run build -w packages/client && npm pack -w packages/client`; set `STUBYARD_CLIENT_TGZ`
to the file to serve it). Lockfiles pin the URL, not a version: re-run `npm i` after upgrading stubyard.

**Browser sessions (dashboard).**
- `POST /api/auth/login {email, password}` sets an HttpOnly cookie (`stubyard_session`, or `__Host-stubyard_session`
  when Secure) and returns `{user, csrf, expiresAt}`.
- Requests with the cookie that change data (POST, PUT, PATCH, DELETE) must send `X-Stubyard-CSRF: <csrf>`; without it
  they get 403.
- `POST /api/auth/logout` ends the session.
- Agents should not use this; use a token.

**Endpoints**

| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/login | Public. 401 wrong e-mail or password. 429 + `Retry-After`: the admin e-mail waits 2–60 s after 5 failures per address; other e-mails are blocked 15 min after 5 failures per e-mail + address or 20 per address; at most 2 checks run at once (`Retry-After: 1`) |
| POST | /api/auth/logout | 204, clears the cookie |
| GET | /api/auth/me | Public. `{mode: "open" \| "single" \| "teams", user, csrf, via}`; Teams mode adds `projects` (`{slug: role}`, `null` for instance admins), `roles` and `adminPermissions` |
| GET | /api/auth/tokens | `{tokens: [{id, name, prefix, createdAt, lastUsedAt, expiresAt, revokedAt, status}]}` (session only) |
| POST | /api/auth/tokens | `{name, expiresInDays?, projects?, maxRole?}` → 201 `{token, secret}`; the secret is shown only here (session only). `projects` / `maxRole`: Teams mode only |
| DELETE | /api/auth/tokens/:id | Revokes; `{token}` (session only) |

**What never needs sign-in:**
- the app-facing endpoints: `/mock`, `/hook`, `/auth` (fake login providers), `/pay`, `/storage` (except the
  dashboard upload path `/storage/<p>/<i>/__hub/…`), `/llm` and `/push`;
- SMTP and APNs;
- the dashboard's static files.

**Teams mode** (`GET /api/auth/me` → `"mode": "teams"`): several people, each with a role per project.
- A token belongs to the person who created it and acts with their roles, now: a role change or removal applies to
  the next call. A disabled person's tokens are revoked.
- A token can be narrowed when it is created: `projects: ["shop"]` (only these of the person's projects) and
  `maxRole: "viewer"` (at most this role in each; one of `project_admin`, `project_manager`, `developer`,
  `designer`, `qa`, `viewer`, or `admin` for instance admins). `GET /api/auth/me` with the token shows what it
  can reach in `projects`.
- A project the token cannot reach answers **404** `Project "x" not found`, exactly like a missing one; `/api/projects`,
  `/api/logs` and `/api/stream` only include reachable projects. **403** means the project is reachable but the role
  lacks the permission (the error names it and the hint lists the roles that have it).
- `/mcp` lists only the tools the token may use, and every tool call runs with the token's permissions.
- `/mailpit` is for instance admins only. Read mail with `GET /api/messages/:id` and
  `/api/messages/:id/mail/{html,text,raw,detail}` (the `mailpit` links in the message point there).
- Schedules you create run with your permissions when they fire; if you lose the permission they fail with 403.
- A 403 with `"code": "must_change_password"` is for dashboard sessions only (a temporary password); tokens never get it.
- **Audit log** (read only; 404 outside Teams mode):

| Method | Path | Notes |
|---|---|---|
| GET | /api/audit | Instance admins. `{entries: [{id, at, user: {id, email} \| null, action, project, target, detail, ip}], nextBefore}`, newest first. Query: `user` (id or e-mail), `project`, `action` (comma-separated; `member.*` = every `member.` action), `from` / `to` (ISO time, or `YYYY-MM-DD`: `to` includes that day), `q` (text in e-mail, target, project, address, details), `limit` (1–500, default 100), `before` (the previous page's `nextBefore`; `null` = no more). `format=csv` downloads the filtered rows (at most 50,000). |
| GET | /api/audit/actions | Instance admins. `{actions: [...]}`: the actions present, sorted |
| GET | /api/projects/:slug/audit | Project admins (and instance admins): the same for one project, from its creation on, without `ip` |
| GET | /api/projects/:slug/audit/actions | The actions present in that project |

  Actions: `auth.login`, `auth.login_failed` (target = the e-mail tried), `auth.logout`, `user.create`, `user.update`,
  `user.role`, `user.disable`, `user.enable`, `user.password_reset`, `user.password_change`,
  `user.env_admin_replaced`, `member.add`, `member.role`, `member.remove`, `token.create`, `token.revoke`,
  `invite.create`, `invite.revoke`, `invite.accept`, `project.create`, `project.import`, `project.export`
  (`detail.secrets`), `project.settings` (`detail.fields`: the changed setting names, never values),
  `project.reset`, `project.delete`, `system.ai_providers`, `system.maintenance`, `system.factory_reset`. Rows written
  for API calls have `target` = `"<METHOD> <route>"` and `detail.via` (`session`, `token`, or
  `internal (for the user)` for MCP tools and schedules). Retention: `STUBYARD_AUDIT_RETENTION_DAYS` (default 365).

Rules for agents:
- When a call returns 401 and `/api/system` says `authRequired`, ask the person for an API token. Never ask for the
  admin password.
- Never print a token in full in logs or reports. Its first 11 characters (the `prefix`) identify it.

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
- MCP: `add_authenticator {project, user, label, secret | otpauth}` does the POST above for a test user and returns the
  current code (§F).

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

The traffic list has **kind chips** (API mock, storage, payments, login, webhook, provider, LLM, SMTP, MCP tester, other) with counts for the loaded rows; click one to filter. Each row shows its kind, and the summary line shows the storage operation and `bucket/key`, the mock scenario and the auth (`resolved.auth` type, account, ✓/✗ verified). The drawer shows Kind, Object and Auth.

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
  (default from project settings, `Password123!`), and can be **pinned** in the dashboard (shown in the Inbox sub-nav and as latest-code cards on the Overview; keys 1–9 open them).
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
| `unifonic` | `POST /rest/SMS/messages` (form, JSON or query; `AppSid`) | Error envelope `{success:false, errorCode:"ER-…"}`; DLR = `eventName:"dlr"`, final status only |
| `taqnyat` | `POST /v1/messages` (JSON, bearer); `GET /account/balance`, `GET /v1/messages/senders` | 201 `{statusCode, messageId, accepted…}`; errors `{statusCode, message}`; DLR final status only |
| `msegat` | `POST /gw/sendsms.php` (`userName`, `apiKey`); `/gw/Credits.php` | Always HTTP 200 with `{code, message}` (`"1"` = OK, `M0002`, `1060`, `1110`…); no DLR push |
| `4jawaly` | `POST /api/v1/account/area/sms/send` (Basic key:secret); `GET …/account/area/me/packages` | `job_id` response; errors in Arabic, also as `messages[0].err_text`; DLR `numbers[].status` 3 = delivered |
| `oursms` | `POST /msgs/sms` (bearer; `src`, `dests`, `body`), legacy `/api-a/msgs`; `GET /billing/credits` | Errors `{status, errorCode, message, value}`; no DLR push |
| `infobip` | `POST /sms/3/messages`, `/sms/2/text/advanced`, `/sms/1/text/single` (`Authorization: App <key>`); `GET /account/1/balance` | `{bulkId, messages[]}` with PENDING status; sender / credit / number rejections = HTTP 200 with a REJECTED status; DLR `{results:[…]}` final only |
| `plivo` | `POST /v1/Account/<auth_id>/Message/` (Basic auth_id:auth_token), `GET …/Message/<uuid>/` | 202 `{message_uuid:[…]}`; errors `{api_id, error}`; form callbacks (sent, delivered / undelivered) signed `X-Plivo-Signature-V2` when `authToken` is set |
| `sinch` | `POST /xms/v1/<service_plan_id>/batches` (bearer), `GET …/batches/<id>` | 201 batch; errors `{code, text}`; DLRs only when the batch sets `delivery_report` (`per_recipient`, `summary`, …) |
| `telnyx` | `POST /v2/messages` (bearer), `GET /v2/messages/<id>`, `GET /v2/balance` | `{data:{record_type:"message"…}}`; errors `{errors:[{code, title, detail}]}`; `message.sent` + `message.finalized` webhooks signed with Ed25519 |
| `sns` | `POST /` form `Action=Publish&PhoneNumber=…&Message=…` (AWS query protocol, SigV4) | XML `PublishResponse` / `ErrorResponse`; no delivery reports (SNS has none) |
| `meta-whatsapp` | `POST /<version>/<phone-number-id>/messages` (JSON); `/<version>/<waba-id>/message_templates` | Text, template, interactive; webhooks signed with `X-Hub-Signature-256` when `appSecret` is set; template lifecycle (§R) |
| `360dialog` | `POST /messages` (Cloud API JSON, `D360-API-KEY` header); `/v1/configs/templates`, `/message_templates` | Missing / wrong key → 401; Meta webhooks (statuses, replies, template status) on the one webhook URL |
| `infobip-whatsapp` | `POST /whatsapp/1/message/{text,image,document,audio,video,sticker,location,interactive/buttons,interactive/list,template}` (`Authorization: App <key>`); `/whatsapp/2/senders/<sender>/templates` | Single send `{to, messageCount, messageId, status:PENDING_ENROUTE}`, template `{messages[], bulkId}`; errors `{requestError:{serviceException}}`; DLR + seen report `{results:[…]}`; inbound `{results:[{integrationType:"WHATSAPP", message:{type:"TEXT"…}}]}` |
| `gupshup` | `POST /wa/api/v1/msg` (also `/sm/api/v1/msg`), `/wa/api/v1/template/msg` (form, `apikey` header); `/partner/app/<appId>/templates` | `202 {status:"submitted", messageId}`; bad key → 401 `Authentication Failed`; `message-event` / `message` / `template-event` callbacks (v2) on the callback URL |
| `unifonic-whatsapp` | `POST /v1/messages` (JSON `{recipient:{contact, channel:"whatsapp"}, content:{type…}}`, `PublicId` + `Secret` headers) | `202 {messageId, status:"queued"}`; status + inbound webhooks (shapes assumed); templates from the dashboard / REST only |
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

### Saudi / GCC SMS presets

`unifonic`, `taqnyat`, `msegat`, `4jawaly` and `oursms` answer in the vendor's own shapes (sources and which details
are verified: `docs/plans/research-sms-gcc.md`). Point the app's base URL (e.g. `https://api.taqnyat.sa`) at the
instance URL; the vendor's path stays the same.

- Numbers: `9665…`, `009665…`, `+9665…` and local `05…` / `5…` all match a test user with `+9665…`.
- Credentials: any value works unless the instance sets one (`appSid`, `bearerToken`, `userName` + `apiKey`,
  `apiKey` + `apiSecret`, `token`); a wrong or missing one gets the vendor's auth error.
- `config.balance: "0"`: every send fails with the vendor's balance error. `config.approvedSenders: "A,B"`: any
  other sender fails with "sender not approved / not active". The balance endpoints report `balance` (default 1000).
- Rules: a `reject` rule (or `X-Hub-Scenario: reject:<code>`) with errorCode `sender`, `balance`, `auth` or `number`
  returns that vendor error, e.g. Taqnyat `{"statusCode":400,"message":"Sender Name not active"}`.
- Delivery reports go to `statusCallbackUrl` (the webhook set in the vendor portal in real life), final status only.
  Msegat and OurSMS have no DLR push.
- Multi-recipient sends: the response counts every number; only the first lands in a test user's inbox.

### Global SMS presets

`infobip`, `plivo`, `sinch`, `telnyx` and `sns` (Amazon SNS) answer in the vendor's own shapes (sources and which
details are verified: `docs/plans/research-sms-global.md`). The instance's Connect tab shows the base-URL override for
each SDK:

- Infobip: `baseUrl` in every SDK (`https://<subdomain>.api.infobip.com` → instance URL).
- Plivo: plivo-python `client.base_uri = "<instance URL>/v1/Account"`; plivo-node has no override (call the REST API).
- Sinch: replace `https://us.sms.api.sinch.com` with the instance URL; the path keeps `/xms/v1/<service_plan_id>`.
- Telnyx: `TELNYX_BASE_URL=<instance URL>/v2`. Webhooks are signed with a per-instance Ed25519 key; put the public key
  from the Connect tab in `TELNYX_PUBLIC_KEY` and `client.webhooks.unwrap()` verifies them.
- Amazon SNS: `AWS_ENDPOINT_URL_SNS=<instance URL>` (or `endpoint` / `endpoint_url`). The SigV4 signature is not
  checked; `config.accessKeyId` makes other keys fail with 403 `InvalidClientTokenId`.

Credentials, `config.balance`, `config.approvedSenders` and `reject` rules with errorCode `sender`, `balance`, `auth`
or `number` work as for the GCC presets. `down` → 503 and `rate_limit` → 429, both in the vendor's error envelope.
Delivery reports: Infobip and Sinch send the final status (Sinch only when the batch asks for reports), Plivo and
Telnyx also send `sent`; SNS has no delivery-report webhook. A send's own callback (`notifyUrl` /
`webhooks.delivery.url`, `url`, `callback_url`, `webhook_url`) wins over `statusCallbackUrl`.

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
To make a test user answer by themselves, use scripted auto-replies (§AB).

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
| Providers | `list_providers` (instances with config and base URLs from this machine / from containers / SMTP username), `set_provider_config` (merges `config`, e.g. `statusCallbackUrl`, `inboundUrl`, `eventWebhookUrl`; `enabled`, `is_default`, `name`), `list_wa_templates`, `create_wa_template`, `set_wa_template_status` (WhatsApp templates; status change sends the vendor's webhook) |
| Project setup | `create_project` (`name`, `slug`, `roles: [{role,count}]`, `admins`, `customers` → project + users), `generate_users`, `export_project` (`include_secrets`) |
| Authenticator (§7) | `add_authenticator` (`user`, `label`, `secret` base32 **or** `otpauth` link; optional `issuer`, `account`, `algorithm`, `digits`, `period`, `run`) → key (no secret), linked user and current `code` / `nextCode` / `remaining`. The same label on the same user is replaced (`status: updated`) |
| Payment gateways (§Z) | `list_payment_gateways` (gateway preset ids with config fields + the project's instances with their env vars), `create_payment_instance` (`gateway` preset id, `name`, `slug`, `webhook_url`, `default_outcome`, `config`) → instance, URLs and `connect.env` (the env vars the Connect panel shows) |
| Webhook endpoints (§G) | `create_webhook_endpoint` (`path`, `name`, `method`, `schema`, `response {status, headers, body, delayMs, rejectInvalid}`) → endpoint, `url` and `urls.fromContainers` |

With these, an agent can set up a project end to end (users, origins, login recipes, authenticators, payment gateways,
webhook endpoints, storyboards) over MCP alone, without curl.

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

## H. Email API providers (SendGrid, Mailgun, Amazon SES, Resend, Postmark, Brevo, Mailjet, Mandrill, Generic)

### Email API simulators

Add an email provider instance with preset `sendgrid`, `mailgun`, `ses`, `resend`, `postmark`, `brevo`, `mailjet`, `mandrill`
(Mailchimp Transactional) or `generic-email` (dashboard → Providers → Email tab, or
the API), then point the SDK's base URL at `https://localhost:4443/mock/<project>/<instance>` (plain
`http://localhost:4000/mock/…` works too). The setup guide (`GET /api/projects/<project>/setup`) shows ready-made snippets.

| Preset | Endpoint the app calls (after the base URL) | Success response | Events sent to `eventWebhookUrl` |
|---|---|---|---|
| `sendgrid` | `POST /v3/mail/send` (JSON) | `202`, empty body, `X-Message-Id` header (sandbox mode: `200`, not delivered) | JSON array of SendGrid events: `processed`, `delivered`, `deferred`, `bounce` (`type` bounce/blocked), `dropped`, `spamreport` |
| `mailgun` | `POST /v3/<domain>/messages` (multipart or urlencoded), `POST /v3/<domain>/messages.mime` | `200 {"id":"<…@domain>","message":"Queued. Thank you."}` (`o:testmode=yes`: not delivered) | `{"signature":{timestamp,token,signature},"event-data":{…}}`: `accepted`, `delivered`, `failed` (severity temporary/permanent), `complained` |
| `ses` | `POST /v2/email/outbound-emails` (JSON: Simple, Raw, Template) | `200 {"MessageId":"…"}` | SNS `Notification` envelope (`Message` = stringified SES event): `Delivery`, `Bounce`, `Complaint` (event-publishing format also `Send`, `DeliveryDelay`, `Reject`) |
| `resend` | `POST /emails` (JSON), `POST /emails/batch` (array, no attachments) | `200 {"id":"<uuid>"}`; batch `200 {"data":[{"id"},…]}` | Svix-signed JSON `{type,created_at,data}`: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced` (`data.bounce` Permanent/Transient), `email.suppressed`, `email.complained` |
| `postmark` | `POST /email`, `/email/batch`, `/email/withTemplate`, `/email/batchWithTemplates` (JSON) | `200 {"To","SubmittedAt","MessageID","ErrorCode":0,"Message":"OK"}` (batch: array). Token `POSTMARK_API_TEST`: accepted, not delivered | Unsigned JSON: `Delivery`, `Bounce` (`HardBounce` 1, `SoftBounce` 4096, `Transient` 2 for a deferral, `Blocked` 100006), `SpamComplaint` |
| `brevo` | `POST /v3/smtp/email` (JSON, `messageVersions` supported) | `201 {"messageId":"<…@smtp-relay.mailin.fr>"}` (versions: `{"messageIds":[…]}`) | Unsigned JSON: `request`, `delivered`, `deferred`, `soft_bounce`, `hard_bounce`, `blocked`, `spam` |
| `mailjet` | `POST /v3.1/send` (JSON `Messages`, `Globals`, `SandboxMode`) | `200 {"Messages":[{"Status":"success","CustomID","To":[{Email,MessageUUID,MessageID,MessageHref}],"Cc","Bcc"}]}` | Unsigned JSON object (array with `eventGrouping`): `sent`, `bounce`, `blocked`, `spam` |
| `mandrill` | `POST /api/1.x/messages/send[.json]`, `…/messages/send-template[.json]` (key in the body) | `200 [{"email","status":"sent","_id","reject_reason":null}]`, one entry and one email per recipient | Form POST `mandrill_events=<JSON array>` with `X-Mandrill-Signature`: `send`, `delivered`, `deferral`, `hard_bounce`, `soft_bounce`, `reject`, `spam` |
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
| `resend` | `apiKey` | Optional. When set, `Authorization: Bearer <key>` is required (else `401 {"statusCode":401,"name":"validation_error","message":"API key is invalid"}`) |
| `resend` | `webhookSecret` | `whsec_…` secret for the Svix headers `svix-id`, `svix-timestamp`, `svix-signature` (`v1,` + base64 HMAC-SHA256 of `id.timestamp.body` with the base64-decoded secret). Verify with `resend.webhooks.verify()` or the `svix` library. Default `whsec_c3R1YnlhcmQtcmVzZW5kLXdlYmhvb2stc2VjcmV0` |
| `postmark` | `apiKey` | Server token. Optional. When set, `X-Postmark-Server-Token` must match (else `401 {"ErrorCode":10,…}`) |
| `brevo` | `apiKey` | Optional. When set, the `api-key` header must match (else `401 {"code":"unauthorized","message":"Key not found"}`) |
| `brevo` | `webhookBearerToken` | Optional. Events carry `Authorization: Bearer <token>` (Brevo's webhook `auth` type bearer) |
| `mailjet` | `apiKey`, `apiSecret` | Optional. When set, HTTP Basic `<apiKey>:<apiSecret>` is required (else `401 {"ErrorIdentifier","StatusCode":401,"ErrorMessage"}`) |
| `mailjet` | `eventGrouping` | `true` = each event POST is a JSON array (Mailjet's grouped format); default one object per POST |
| `mandrill` | `apiKey` | Optional. When set, the body's `key` must match (else `401 {"status":"error","code":401,"name":"Invalid_Key"}`) |
| `mandrill` | `webhookKey` | `X-Mandrill-Signature = base64(HMAC-SHA1(key, webhookUrl + "mandrill_events" + <the JSON>))`. Default `stubyard-webhook-key` |
| `generic-email` | `path`, `toField`, `ccField`, `bccField`, `fromField`, `subjectField`, `textField`, `htmlField` | Field names / JSON paths (e.g. `recipient.address`). Recipients may be a string, `"a@x, B <b@y>"`, an array of strings or of `{email,name}` |
| `generic-email` | `successStatus`, `successTemplate`, `errorTemplate`, `eventTemplate` | Response and event bodies (`{{id}} {{to}} {{from}} {{subject}} {{timestamp}}`; errors `{{errorCode}} {{errorMessage}}`; events `{{event}} {{email}} {{reason}} {{bounceType}}`) |

SNS messages are **not signed** (`Signature` is a placeholder): turn SNS signature verification off in development.
Postmark, Brevo and Mailjet do not sign webhooks either; they use Basic auth in the webhook URL. Put it in
`eventWebhookUrl` (`https://user:pass@host/…`) and stubyard sends it as an `Authorization: Basic` header.
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

```js
// Resend (resend): baseUrl option or RESEND_BASE_URL
const resend = new Resend(process.env.RESEND_API_KEY, { baseUrl: 'https://localhost:4443/mock/hyper/resend' });

// Postmark (postmark): requestHost is host[:port]/path without the scheme
const pm = new postmark.ServerClient(token, { useHttps: true, requestHost: 'localhost:4443/mock/hyper/postmark' });

// Brevo (@getbrevo/brevo): the base URL includes /v3 (older SDK: api.basePath = '…/v3')
const brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY, baseUrl: 'https://localhost:4443/mock/hyper/brevo/v3' });

// Mailjet (node-mailjet): HTTPS only, host without the scheme
const mailjet = new Mailjet({ apiKey, apiSecret, config: { host: 'localhost:4443/mock/hyper/mailjet' } });

// Mailchimp Transactional (@mailchimp/mailchimp_transactional): no option, but basePath is a plain property
const mc = require('@mailchimp/mailchimp_transactional')(key); mc.basePath = 'https://localhost:4443/mock/hyper/mandrill/api/1.3';
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
- Resend: `422 {"statusCode":422,"name":"missing_required_field","message":"Missing `from` field."}`; invalid addresses
  give `"name":"validation_error"`.
- Postmark: `422 {"ErrorCode":300,"Message":"Invalid 'To' address: '…'."}`, `"Zero recipients specified"`,
  `"Provide either email TextBody or HtmlBody or both."`. A batch with one bad message fails as a whole (real Postmark
  answers 200 with a per-message ErrorCode).
- Brevo: `400 {"code":"missing_parameter","message":"sender is missing"}`, `"to is missing"`, `"subject is missing"`;
  `{"code":"invalid_parameter","message":"email is not valid in to"}`.
- Mailjet: `400 {"Messages":[{"Status":"error","Errors":[{"ErrorIdentifier","ErrorCode":"mj-0013","StatusCode":400,"ErrorMessage","ErrorRelatedTo":["To[0].Email"]}]}]}`
  (`mj-0003` for a missing property).
- Mandrill: `500 {"status":"error","code":-2,"name":"ValidationError","message":"Validation error: …"}`.
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

The newer presets map the same actions to their own wording:

- Send-time errors: Resend `422 validation_error` / `429 rate_limit_exceeded` (+ `ratelimit-*`, `retry-after`) / `503
  service_unavailable`; Postmark `422 ErrorCode 300` / `429` / `503`; Brevo `400 invalid_parameter` / `429
  too_many_requests` / `503`; Mailjet `400` Messages error `mj-0013` / `429` / `503`. Mandrill answers a refused
  recipient with `200` and `status: "rejected"` (`reject_reason` `hard-bounce`, `unsub` for opt-out, `custom` for
  `blocked`, or the rule's errorCode when it is a Mandrill reason); `rate_limit` → `200 status: "queued"`,
  `queued_reason: "hourly-quota-exhausted"` (stubyard does not deliver it later); `down` → `500 GeneralError`.
- Postmark and Mandrill refuse suppressed recipients at send time: `blocked` and marketing opt-out give Postmark `422
  ErrorCode 406` (inactive recipient) and Mandrill `rejected`. The others accept and report it as an event.
- Events: Resend `email.sent` → `email.delivered`, bounces `email.bounced`, `drop` `email.suppressed`, complaint
  `email.complained`. Postmark has no "processed" or "dropped" webhook (Delivery, Bounce, SpamComplaint only). Brevo
  `request` → `delivered`, `blocked` for a drop. Mailjet sends `sent` on delivery and has no processed/deferred event.
  Mandrill `send` → `delivered`, `deferral`, `hard_bounce`/`soft_bounce`, `reject` for a drop, `spam`.
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

Dashboard: **API mocks** in the project's Simulate group (and in the Ctrl-K palette). It has the list in priority order, a
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
- Dashboard: **Settings → Data → Export / import** (`/p/<project>/settings?tab=data`). It has a download button (with an "include 2FA keys" checkbox), and an
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
- Dashboard: **Settings → Data** has "Data retention" (per-project log retention and auto-reset) and "Export / import";
  "Reset all rules" is under **Settings → Checks & time**, and "Reset project data" and delete under **Danger zone**.
  The global **System** page (`/system`, in the top bar's workspace menu and the palette) has the tabs Overview (storage,
  row counts, versions), AI providers, Maintenance (the last clean-up and "Run now") and Danger zone (a **Factory
  reset** button that asks you to type `DELETE EVERYTHING`).

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
| `google` | accounts.google.com / oauth2.googleapis.com | `/.well-known/openid-configuration`, `/o/oauth2/v2/auth`, `/token`, `/oauth2/v3/certs`, `/oauth2/v1/certs` (PEM), `/v1/userinfo`, `/oauth2/v3/userinfo`, `/oauth2/v2/userinfo` (legacy shape), `/tokeninfo`, `/revoke`, `/Logout` (`continue=`; not in discovery, like the real one) |
| `microsoft` | login.microsoftonline.com | `/{tenant}/v2.0/.well-known/openid-configuration`, `/{tenant}/oauth2/v2.0/{authorize,token,logout}`, `/{tenant}/discovery/v2.0/keys`, `/common/discovery/instance`, `/graph/v1.0/me` (also `/v1.0/me`), `/graph/oidc/userinfo` (also `/oidc/userinfo`) |
| `github` | github.com / api.github.com | `/login/oauth/authorize`, `/login/oauth/access_token`, `/user`, `/user/emails` (also under `/api/v3/`), `/logout` |
| `facebook` | www.facebook.com / graph.facebook.com | `(/vN.N)/dialog/oauth`, `(/vN.N)/oauth/access_token` (GET/POST), `(/vN.N)/me?fields=…`, `/debug_token`, `DELETE /me/permissions` |
| `linkedin` | www.linkedin.com / api.linkedin.com | `/oauth/.well-known/openid-configuration`, `/oauth/v2/authorization`, `/oauth/v2/accessToken`, `/v2/userinfo`, `/oauth/openid/jwks` (issuer `B/oauth`) |
| `apple` | appleid.apple.com | `/.well-known/openid-configuration`, `/auth/authorize`, `/auth/token`, `/auth/keys`, `/auth/revoke` |
| `x` | x.com / api.x.com | `/i/oauth2/authorize`, `/2/oauth2/token`, `/2/oauth2/revoke`, `/2/users/me` |
| `discord` | discord.com | `/oauth2/authorize`, `/api(/v10)/oauth2/token`, `/api/oauth2/token/revoke`, `/api(/v10)/users/@me` |
| `gitlab` | gitlab.com | `/.well-known/openid-configuration`, `/oauth/{authorize,token,userinfo,revoke}`, `/oauth/discovery/keys`, `/api/v4/user` |
| `slack` | slack.com | `/.well-known/openid-configuration`, `/openid/connect/authorize`, `/api/openid.connect.token`, `/api/openid.connect.userInfo`, `/openid/connect/keys` |
| `oidc` | your IdP | `/.well-known/openid-configuration`, `/authorize`, `/token`, `/userinfo`, `/jwks`, `/logout`, `/revoke`, `/introspect` + Auth0 (`/oauth/token`, `/.well-known/jwks.json`, `/v2/logout`), Cognito (`/oauth2/*`), Keycloak (`/protocol/openid-connect/*`), Okta (`/v1/*`) aliases |

Every preset also answers **`B/__hub/logout`** (GET or POST): it ends the SSO session, clears the
`stubyard_sso_<provider>` cookie and redirects to `post_logout_redirect_uri` / `continue` / `returnTo` / `logout_uri` /
`redirect_uri` (with `state`), or shows a "Signed out" page. `urls.browser.logout` lists the real logout path where the
preset has one, else `B/__hub/logout`.

`GET /api/projects/<p>/auth/<provider>` returns every URL for the browser and for backends (`urls.browser`,
`urls.backend` = `https://stubyard:4443/…`, `urls.backendLocal` = `http://localhost:4000/…`, with the host port from
`STUBYARD_HOST_HTTP_PORT`) plus framework snippets.
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

To switch test users, end the SSO session: open the provider's logout URL (`urls.browser.logout`: Microsoft
`/{tenant}/oauth2/v2.0/logout`, Google `/Logout`, GitHub `/logout`, any preset `/__hub/logout`), or revoke it
server-side with `DELETE /api/projects/<p>/auth/sessions` (all providers), `DELETE /api/projects/<p>/auth/<provider>/sessions`,
`DELETE /api/projects/<p>/auth/<provider>/sessions/<user>` (one test user), the `sign_out_login_sessions` MCP tool or
**Sign out test users** on the dashboard's Login providers page. `GET /api/projects/<p>/auth/<provider>/sessions` (MCP
`list_login_sessions`, dashboard **Signed in** tab) lists who is signed in. A browser
logout only clears the cookie on the host it is opened on: if authorize ran on `http://127.0.0.1:…`, a logout on
`http://localhost:…` reports "Signed out" but the real cookie stays. The server-side reset works whatever the host.

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
only on the first authorization per user; `{"consented": false}` resets that. On Microsoft, `email_verified` is sent as the
`xms_edov` claim when that optional claim is enabled (`optionalClaims`).

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
| `DELETE /sessions` · `DELETE /<provider>/sessions` | sign test users out (all providers / one): revokes the SSO sessions, the next authorize shows the picker; `{revoked}` |
| `GET /<provider>/sessions` | signed-in test users, newest first: `[{userId, name, email, role, sessions, signedInAt, expiresAt}]` (`sessions` = live session count; provider views also carry `signedIn`, the number of users) |
| `DELETE /<provider>/sessions/<user>` | sign one test user (id, email, name or role) out of that provider; `{revoked}` |
| `POST /<provider>/token` `{user, clientId?, scope?, nonce?, audience?, expiresIn?, claims?, scenario?, refresh?, baseUrl?}` | tokens without a browser (`baseUrl` = the issuer base your backend validates, default the browser base) |
| `POST /<provider>/code` `{user, clientId?, redirectUri, state?, nonce?, codeChallenge?, scope?, scenario?}` | a code + `redirectTo` callback URL; the app does the real exchange |
| `GET /api/auth-presets` | presets, scenario actions, stages |

Config keys: `strict`, `clients: [{clientId, clientSecret, redirectUris}]`, `issuerMode`, `issuer`, `issOverride`,
`browserBaseUrl`, `autoLogin`, `codeTtlSeconds`, `accessTokenTtl`, `idTokenTtl`, `refresh` (`auto` | `always` | `never`),
`rotateRefresh`, `extraClaims` (JSON template: `{"roles":["{{user.role}}"]}`; also `{{user.email}}`, `{{user.name}}`,
`{{user.id}}`, `{{sub}}`), `audience`, `accessTokenFormat` (`jwt` | `opaque`, generic OIDC), `flavor`, `tenantId`
(Microsoft), `includeEmail` (Microsoft), `optionalClaims` (Microsoft ID-token optional claims, like the app
registration in Entra: `["email", "xms_edov"]`; `xms_edov` = email domain owner verified, omitted without an email;
unknown values ignored; `includeEmail: true` = `"email"`), `hostedDomain` (Google `hd`), `teamId` + `clientPublicKey` (Apple
client_secret checks), `teamName` (Slack).

### MCP tools

`list_login_providers`, `create_login_provider`, `login_as` (tokens, or `{code, redirectTo}` when `redirect_uri` is
given), `set_login_scenario`, `reset_login_scenarios`, `list_login_sessions` (`project`, `provider`: who is signed in),
`sign_out_login_sessions` (`project`, `provider?`, `user?`: ends the SSO sessions so the picker shows again; `user` needs
`provider`).

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

To make a test user reply by email automatically, use scripted auto-replies (§AB).

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

Attachments: add `"attachments": [{"filename":"receipt.pdf","contentType":"application/pdf","contentBase64":"JVBERi0…"}]` to the reply body. At most **10 files and 5 MB in total** (decoded); more → 413, a bad entry (no filename, invalid base64, not a MIME type) → 400. `contentType` defaults to `application/octet-stream`; `text` may be empty when files are attached. The files are real MIME attachments (Mailpit shows them), the stored message has `attachments: <n>` and `metadata.attachments: [{filename, contentType, size}]`.

| Preset | How the files reach `inboundUrl` |
|---|---|
| `sendgrid` | file parts `attachment1…N`, `attachments: "<n>"`, `attachment-info` = JSON `{"attachment1": {"filename","name","type"}}`; raw mode: inside `email` |
| `mailgun` | the forward becomes `multipart/form-data` with file parts `attachment-1…N` and `attachment-count` (urlencoded as before when there are no files); signature unchanged |
| `ses` | inside the raw MIME `content` |
| `generic-email` / `smtp` (JSON) | `attachments: [{filename, contentType, size, contentBase64}]` (`inboundTemplate` is unchanged) |

Dashboard: the reply bar's Email channel has **Attach** (file picker, removable chips). The MCP tool `reply_as_user` does not take attachments yet.

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

### Message templates (Meta, 360dialog, Infobip, Gupshup, Unifonic WhatsApp)

Templates the app creates through the vendor's template API (or the dashboard: Providers → WhatsApp instance →
Settings → **Templates**) are stored per instance and start `PENDING`.

| Call | Behaviour |
|---|---|
| Meta `POST /<version>/<waba-id>/message_templates {name, language, category, components}` | `200 {id, status:"PENDING", category}`; name must match `^[a-z0-9_]+$`; same name + language → `400` code 100 subcode 2388024 |
| Meta `GET …/message_templates[?name=&status=]`, `GET /<version>/<template-id>`, `DELETE …/message_templates?name=[&hsm_id=]` | `{data:[…], paging}`, the template, `{success:true}` |
| 360dialog `/v1/configs/templates` (`GET` → `{waba_templates:[…]}`), `/message_templates`, `DELETE /v1/configs/templates/<name>` | same rules |
| Infobip `POST/GET /whatsapp/2/senders/<sender>/templates`, `GET/DELETE …/templates/<id or name>` | `201` template `{id, name, language, status, category, structure}`; delete `204` |
| Gupshup `POST/GET /partner/app/<appId>/templates` (form: `elementName`, `languageCode`, `category`, `content`…), `DELETE …/template/<elementName>` | `{status:"success", template}` / `{templates:[…]}`; template ids are UUIDs, sends name the id |
| `GET /api/projects/<p>/providers/<instance>/templates` | List (`id, name, language, category, status, reason, quality`) |
| `POST /api/projects/<p>/providers/<instance>/templates {name, language, category, body or components}` | Create from a test (same as the vendor call) |
| `PATCH /api/projects/<p>/providers/<instance>/templates/<id> {status?, reason?, quality?}` | `status` APPROVED / REJECTED / PAUSED / DISABLED / PENDING, `quality` GREEN / YELLOW / RED. Sends the vendor's webhook and returns `{template, webhooks:[{ok, status, logId}]}` |
| `DELETE /api/projects/<p>/providers/<instance>/templates/<id>` | Delete |
| MCP `list_wa_templates {project, instance}`, `create_wa_template {project, instance, name, language?, category?, components?}`, `set_wa_template_status {project, instance, id_or_name, status?, reason?, quality?}` | The REST calls above as agent tools; `id_or_name` takes the template id or its name |

Webhooks (to the instance's status / webhook URL): Meta and 360dialog `field: "message_template_status_update"`
(`event`, `message_template_id`, `message_template_name`, `message_template_language`, `reason`, `message_template_category`,
`rejection_info` when rejected) and `message_template_quality_update` (`previous_quality_score`, `new_quality_score`);
Gupshup `type: "template-event"`. Infobip and Unifonic send none.

Sending a template: a template created on the instance must be `APPROVED`. Pending / rejected / unknown language →
Meta / 360dialog `404` `(#132001) Template name does not exist in the translation`, paused → `400` `132015`, disabled
→ `400` `132016`. Infobip, Gupshup and Unifonic accept the message and report the same code in a failed delivery
report. Template names never created on the instance are sent as before, unless `enforceTemplates: "true"`.

Instance config: `templateReview` (`pending` default; `approve` / `reject` decide automatically after the callback
delay, with the webhook), `templateRejectPattern` (regex: matching names are rejected `INVALID_FORMAT`),
`enforceTemplates`.

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
`type: template`, Twilio `ContentSid`) always pass; a reply (`/reply`) opens the window. The BSP presets behave the
same: 360dialog, Infobip WhatsApp and Unifonic WhatsApp report 131047, Gupshup 470.

Read receipts (`readReceipts`) work on the BSP presets too: 360dialog as Meta, Infobip as a seen report
(`{results:[{messageId, seenAt}]}`), Gupshup as a `read` message event, Unifonic as `status: "read"`.

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

### Limits and simulated errors (all storage providers)

- Limits: `PATCH /api/projects/<p>/storage/<instance>` `{"config":{"maxObjects":10,"quotaBytes":52428800,"maxObjectBytes":1048576}}` (non-negative integers; null clears). `GET` on the instance returns `usage.{objects,bytes,maxObjects,quotaBytes,maxObjectBytes}`.
- Refusals are the provider's native error (table in GUIDE §5). Read `x-stubyard-reason` (e.g. `instance maxObjects=10`, `quota: instance quotaBytes=...`, `object limit 1048576 bytes`, `scenario quota_exceeded`) or the traffic log's `resolved.error` to see which limit or rule fired.
- The instance response lists `simulate`: `[{id, label, action, op, params, error: {status, code, message} | null}]`, the native error each toggle produces on this provider.
- To switch a toggle on from code: `POST /api/projects/<p>/storage/<instance>/rules` `{"action":"quota_exceeded","op":"put","params":{"simulate":"quota"}}` (add `count` or `failRate` for "next N" / a share; `maxBytes` for file too large). Rules with `params.simulate` are checked first, in the dashboard's list order.
- Dashboard-style upload: `PUT /storage/<p>/<instance>/__hub/objects/<bucket>/<key>`. On refusal it answers JSON `{error, code, reason, native:{status,code,message}, limit?}`; scenario rules apply.
- `GET /api/projects/<p>/storage-summary?limit=5` returns totals, instances (with buckets and limits), the latest files and the server caps.
- There is no MCP tool for instance config, so limits are set over the HTTP API; `set_storage_scenario` / `reset_storage_scenarios` still manage rules.

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
- `SharedKey` and `SharedKeyLite` are **checked against the account key** (`accountKey`, default the Azurite key) on every request, using the same string-to-sign as the Azure SDKs (the full request path, including `/storage/<project>/<instance>/` and any `/run/<key>` prefix). The traffic log shows `resolved.auth = {type: "sharedkey", account, verified}`.
- A mismatch (wrong key, wrong account, tampered signed header) is a warning in lax mode and **403 `AuthenticationFailed`** in strict mode or with `verifySignatures: true`; the error detail shows the string stubyard signed.
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

**Settings** (Project → Settings → Checks & time, the Content checks card; `?tab=checks`): `settings.lintDisabled: string[]` turns off individual checks, and `settings.productionDomains: string[]` sets the production domains. Changing `lintDisabled` or `productionDomains` re-checks the **newest 500 outbound messages** in the background (one `message.updated` event with `{lintRechecked, ids}`). Email bodies are re-read from Mailpit; if one is gone, the old findings are kept, findings of disabled checks are dropped and `link-production` is recomputed from the stored links. Run it by hand:

```bash
curl -s -X POST localhost:4000/api/projects/hyper/lint/recheck -H 'content-type: application/json' -d '{"limit":200,"run":"w1"}'
# → {"project":"hyper","run":"w1","checked":12,"changed":3,"partial":0}
```

`limit` a positive integer, capped at 500 (default 500), `run` limits it to one run's messages.

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
- stubyard's own `/mcp` negotiates up to 2025-11-25 (the first protocol version it offers).
- A self-signed HTTPS server works only when its host is in the outbound policy's `insecureTls` list (`STUBYARD_OUTBOUND_INSECURE_TLS`: `1` or host patterns like `myapp.test,*.local`); otherwise the connect fails with the TLS error.

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
| mocks | API mocks: `{{now}}` and `{{timestamp}}` in mock responses (run override via `/run/<key>/` or `X-Hub-Run`). |

Not shifted: message timestamps, storage presigned-URL expiry, the job scheduler, retention.

- `auth` now also shifts `iat` (and Microsoft `nbf`) inside access-token JWTs of the `oidc` and `microsoft` presets, so iat/exp stay consistent. `features` in `GET …/time` is `["totp","auth","verify","webhooks","mocks"]`.

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
**Project Settings → Checks & time → Clock offsets**: one row per feature with presets (−1h, +5 min, +1h, +1d), a custom field (-90s, 2h30m) with Set, and Reset; header "N active" badge + Reset all; rows with an offset show the shifted time. The **Authenticator** page shows a "clock +5m" badge while a totp offset is set; its countdown follows the shifted clock.

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

The summary tiles use 6 columns on wide screens, 3 under 900 px and 2 under 480 px. The dashboard's run page shows the same **File storage** section (upload / download / delete counts, objects with a link to the traffic entry, storage rules). Uploads, downloads and deletes are counted for every storage preset (S3, Azure `PutBlob`/`GetBlob`/`DeleteBlob`, GCS, Cloudinary, Supabase).

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

`matches` patterns are at most 500 characters, and patterns that can backtrack without end (nested quantifiers such as `(a+)+`) are refused with 400; the check runs on the first 8 KB of the reply with a time limit, and a stored unsafe pattern fails its check.

### Y.5 MCP tools

| Tool | What it does |
|---|---|
| `list_chat_agents {project}` | Agents with provider/model, tools and `providerOk` (read-only) |
| `ask_agent {project, agent, prompt, conversation?}` | One non-streamed turn. Returns `text`, `toolCalls`, `steps`, `usage`, `finishReason`, `conversation` (pass it back to continue) |
| `run_saved_prompts {project, ids?, agent?}` | Runs saved prompts and returns `{passed, failed, results}` |

No MCP tool reads or writes provider keys. Agents cannot call `ask_agent`, `run_saved_prompts` or any write tool.

### Y.6 Dashboard

- **AI chat → Conversations:** a list and a thread. On phones you see one or the other, with a back arrow. Pick the
  agent in the thread header. Tool calls are collapsible cards showing input and result, and MCP-target tools link
  to the MCP tester. Each reply shows model, tokens in/out, steps and time; the header shows the conversation total.
  Enter sends, Shift+Enter starts a new line; Stop and Regenerate are next to Send.
- **AI chat → Agents:** cards plus an editor with provider, a model list loaded from the provider, instructions, step and
  token caps, temperature, and a tool allowlist tree (stubyard: all / pick / none; each MCP target: all / only…).
  The **Tools** button shows the resolved list.
- **AI chat → Saved prompts:** expectations shown as chips, Run / Run all, and pass/fail with the failed checks expanded.
- **System → AI providers:** add from a preset; Test sends one prompt; List models; Edit, Disable or Delete.
  Rows from environment variables are read-only.
- **Chat extras:** mock providers, the model matrix, saving tool calls and Explain this are in §AC.

---

## Z. Payments (14 fake gateways: Stripe, PayPal, PayTabs, HyperPay, Moyasar, Tap, Tabby, Tamara, Checkout.com, APS, MyFatoorah, Geidea, JazzCash, Easypaisa)

stubyard has fake payment gateways that your app talks to instead of the real ones. Each one has a hosted payment
page, test cards, a forced-outcome system, signed webhooks, refunds and integration checks ("lint"). No real
money moves, no real account is needed, and nothing ever reaches Stripe, PayTabs or PayPal.

| Preset | id | Methods | What is simulated |
|---|---|---|---|
| Stripe Checkout | `stripe-checkout` | card, applepay | `/v1/checkout/sessions` (hosted, `mode=payment`, `price_data` line items; Embedded Checkout), the PaymentIntents API and a fake Stripe.js v3 (Z.25), charges, refunds, events |
| PayTabs | `paytabs` | card, mada, stcpay, applepay | `/payment/request` (sale / auth, then capture / void / refund) and `/payment/query`, return POST + callback (IPN) |
| PayPal Standard | `paypal` | paypal | `/v1/oauth2/token`, `/v2/checkout/orders` (intent CAPTURE), capture, captures / refunds, `verify-webhook-signature` |

Out of scope: Stripe saved cards / SetupIntents and Connect. PayPal subscriptions and disputes are in Z.21. Every
gateway's realistic pages and browser SDKs are in Z.22–Z.28.

### Z.1 Add a gateway and connect your app

Dashboard: **Payments → Gateways → Add payment provider** (`/p/<project>/payments?tab=gateways`; the same list is
under Providers → Payments, `/p/<project>/providers/payments`). API:

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
  - `experience`, `pageLocale`, `pageTimings`, `pageDrawer`: the realistic / classic page (Z.22)
  - `sdkOrigins`: page origins allowed to use the fake SDKs (Z.24)
  - `browserBaseUrl`: the address the browser is sent to for hosted pages, 3-D Secure, SDK and return URLs (Stripe Checkout `url`, PayPal `payer-action`, PayTabs `redirect_url`, every other gateway too). An http(s) URL without a path, for example `http://localhost:5500` (a trailing `/` is dropped), or `"request-host"`: the scheme and Host the app's own `/pay` request came in on (a call to `localhost:5500` gets `localhost:5500` URLs, one to `host.docker.internal:5500` gets that). Order: instance `browserBaseUrl`, then `STUBYARD_PUBLIC_URL`, then the host-published address. Use it when `STUBYARD_PUBLIC_URL` is a LAN address for phones but a desktop browser (or browser automation limited to `localhost`) must stay on `localhost`. `null` clears it. The dashboard shows the effective address as **Browser** on the Connect tab; with `request-host` that line is the fallback for calls made outside a `/pay` request (the dashboard, MCP)
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
2. The browser opens the page. On the classic view the page offers a test-user picker, the payment methods, a card
   field (test cards only) and the buttons **Pay**, **Decline**, **Cancel** and "More outcomes". The realistic view
   (Z.22, the default for new instances) follows the provider's own screens and keeps the test shortcuts in a drawer.
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

**PayTabs `payment_methods`.** `POST /payment/request` limits the hosted page to the methods you send, like PayTabs:

- An array of method names; `["all"]` or no field offers every method. A `-` prefix removes one (`["all", "-applepay"]`).
- stubyard offers `creditcard` / `amex` / `unionpay` (the Card tab), `mada`, `stcpay` and `applepay`. The page lists them in
  request order and preselects the first. A single method (`["mada"]`) is shown alone and checked on the realistic page; the classic page offers the same methods (a single one is preselected without a tab).
- Other names PayTabs documents (`valu`, `knet`, `tabby`, …) are accepted and ignored; a list with nothing stubyard offers is a 400.
- An unknown name is a 400 `{ "code": 4, "message": "Invalid payment_methods value …" }`. The list of names is taken from the
  PayTabs docs (verified). PayTabs documents no error body for a bad name, so the 400 shape and code 4 are assumed.
- The dashboard payment detail shows the `payment_methods` you sent and what the page offers. Completing the payment with a
  method outside the list (a direct POST to the page endpoint) records the warning `pay.paytabs-method-not-allowed`.

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

Refund rules (Stripe Checkout and PaymentIntents): an `outcome` starting with `refund:` forces the next refunds
instead of payments, with the same scopes, `count`, `after` and `minutes`. The same value without the prefix in
`X-Hub-Payment-Outcome` on `POST /v1/refunds` forces that one refund (it wins over rules).

| Refund outcome | `POST /v1/refunds` answers | Webhooks |
|---|---|---|
| `refund:succeeded` (default) | `status: succeeded` | `refund.created`, `charge.refunded` |
| `refund:pending_then_success` | `status: pending` | `refund.created` (pending); after the instance `settleDelayMs` (default 3 s): `refund.updated` (succeeded), `charge.refunded` |
| `refund:failed[:<failure_reason>]` | `status: succeeded` (like Stripe's refund-failure test card 4000 0000 0000 5126) | `refund.created`, `charge.refunded`; after `settleDelayMs`: `refund.updated` + `refund.failed` with `status: failed`, `failure_reason` (default `expired_or_canceled_card`) |

A failed refund gives its amount back: the payment returns to `paid` / `partially_refunded`. `GET /v1/refunds/<id>`
shows the current status. The Refund object carries the `metadata` and `reason` sent on the create.

```bash
# the next refund on the stripe instance fails with lost_or_stolen_card
curl -X POST localhost:4000/api/projects/shop/payment-rules -H 'content-type: application/json'   -d '{"outcome":"refund:failed:lost_or_stolen_card","instance":"stripe","count":1}'
# or per call
curl <STRIPE_API_BASE>/v1/refunds -u "$STRIPE_SECRET_KEY:" -H 'X-Hub-Payment-Outcome: pending_then_success'   -d payment_intent=pi_… -d 'metadata[order_id]=42'
```

### Z.4 Webhooks

They are sent like the provider sends them, through stubyard's scheduler, so you can see them under **Scheduled**
and fire them at once with `POST /api/projects/<slug>/schedules/flush`.

- **Stripe** signs with `Stripe-Signature` and the instance `whsec_`, so `constructEvent` works unchanged.
  - Paid: `payment_intent.succeeded` + `checkout.session.completed`.
  - Pending: `checkout.session.completed` (unpaid), later `payment_intent.succeeded` +
    `checkout.session.async_payment_succeeded`.
  - `payment_intent.payment_failed`, `checkout.session.expired`.
  - Refund: `refund.created`, then `charge.refunded`; `refund.updated` / `refund.failed` when a pending or failing
    refund resolves (refund outcomes in Z.3).
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
  `pay.capture-before-approve`, `pay.double-capture`, `pay.refund-exceeds`, `pay.real-card-entered`,
  `pay.sdk-origin-refused`.
- Warnings: `pay.amount-precision`, `pay.no-webhook-url`, `pay.webhook-rejected`, `pay.no-reference`,
  `pay.paypal-signature-never-verified`, `pay.test-notice-hidden`, `pay.hpp-framed`, `pay.geidea-sdk-session`,
  `pay.stripe-raw-card-data`, `pay.paytabs-method-not-allowed`.
- Info: `pay.no-idempotency-key`, `pay.sdk-origin-unlisted`.
- Gateway-specific checks are listed with each gateway (Z.8–Z.19); realistic pages and SDKs in Z.22–Z.26.

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

- **Payments** (Simulate group), tabs Payments · Gateways · Outcome rules · Checkout pages · Subscriptions & disputes ·
  Integration checks:
  - **Payments** tab: a list with status chips, a provider filter and an order-reference search.
  - **Gateways** tab: the instances (below).
  - **Outcome rules** tab.
  - **Checkout pages** tab: realistic / classic per provider (§Z.22).
  - **Subscriptions & disputes** tab (§Z.21).
  - **Integration checks** tab.
  - Payment detail: summary, checks, webhook attempts with **Resend**, refunds, a timeline (click an event for its
    JSON), the provider object, and **Complete as…**, **Refund…**, **Expire** and **Hosted page** actions.
- **Payments → Gateways** (also Providers → Payment gateways): the instances. Each has **Connect** (URLs, `.env`, SDK notes, test cards),
  **Settings** (credentials, delays, default outcome, magic amounts, strict keys) and **Outcome rules** (the rules of
  that instance).

### Z.8 HyperPay COPYandPAY

Add an instance with preset `hyperpay`. Payments → Gateways → Connect shows `HYPERPAY_BASE_URL`, `HYPERPAY_ENTITY_ID`, `HYPERPAY_MADA_ENTITY_ID`, `HYPERPAY_ACCESS_TOKEN`, `HYPERPAY_WEBHOOK_KEY`, `HYPERPAY_WIDGET_BASE` and `HYPERPAY_BASE_URL_LOCAL`, plus code snippets.
Base URL: `/pay/<project>/<instance>`.

1. **Prepare (server).** `POST /v1/checkouts` with header `Authorization: Bearer <token>` and a form body: `entityId, amount (e.g. 92.00), currency, paymentType=DB|PA`. Optional fields: `merchantTransactionId`, `shopperResultUrl`, `integrity=true`.
   - Response: `{result:{code:"000.200.100"}, id, ndc}`. With `integrity=true` it also returns an `integrity` value (sha384 SRI).
   - Errors use the HyperPay shape `{result:{code,description}, buildNumber, timestamp, ndc}`. A bad token gives `800.900.300`; a missing or wrong parameter gives `200.300.404`.
2. **Widget (browser).** Add `<script src="BASE/v1/paymentWidgets.js?checkoutId=ID" integrity="..." crossorigin="anonymous">` and `<form action="https://your.app/result" class="paymentWidgets" data-brands="VISA MASTER MADA">`.
   - The script sends CORS and CORP headers.
   - Loading it without `integrity` when you asked for it gives lint `pay.hyperpay-no-integrity`.
   - The widget renders the stubyard card page in an iframe (`/widget/<id>?embed=1`). The iframe resizes to its content and redirects the top window to `shopperResultUrl?id=..&resourcePath=..`.
3. **Result (server).** `GET /v1/checkouts/<id>/payment?entityId=..` with Bearer auth.
   - Success: HTTP 200 with `000.100.110` (integrator test mode).
   - A decline gives HTTP 400 with a decline code (e.g. `800.100.152` generic, `800.100.155` insufficient funds, `100.100.303` expired). A still-open checkout gives `000.200.000`.
   - Polling more than twice a minute raises lint `pay.hyperpay-result-overpolled`. Never querying within 30 s after completion raises `pay.hyperpay-result-never-queried`.
   - Classify codes with the official regex groups. The success group is `^(000\.000\.|000\.100\.1|000\.[36]|000\.400\.[1][12]0|000\.500\.)`; see `HYPERPAY_RESULT_PATTERNS` in server/src/payments/hyperpay/index.ts. Do not compare exact strings.
4. **Backoffice.** `POST /v1/payments/<paymentId>` with `paymentType=CP` (capture a PA, partial allowed), `RV` (reverse) or `RF` (refund, partial allowed). `GET /v1/query/<paymentId>` reads one payment.
5. **Webhooks.** Payloads have `type:"PAYMENT"`.
   - When the instance webhook key is 64 hex characters, the body is AES-256-GCM encrypted. The body is a hex string, sent with headers `X-Initialization-Vector` and `X-Authentication-Tag` (uppercase hex). Decrypt with `createDecipheriv(…, { authTagLength: 16 })` and reject a tag that is not 32 hex characters (the published snippet does).
   - Decrypt with key = hex(key), iv = hex(IV header) and tag = hex(tag header). Reply 200 quickly.
   - Any other key gives a plain JSON body.
6. **mada.** Use the mada entity for MADA brand cards. A mada BIN paid on the cards entity raises lint `pay.hyperpay-mada-entity`. Related checks: `pay.hyperpay-mada-missing-fields` and `pay.hyperpay-testmode-with-mada`.
7. **Demo.** `BASE/demo` is a merchant page that runs the full flow in the browser.

### Z.9 PayPal JS SDK (Buttons v5)

- **Script.** `<script src="BASE/sdk/js?client-id=<clientId>&currency=USD&intent=capture|authorize&components=buttons,card-fields">`. A wrong client id gives a script that throws, like PayPal does.
- **Buttons.** `paypal.Buttons({createOrder, onApprove, onCancel, onError}).render('#el')`.
  - `createOrder` should call your server, which creates the order with `POST /v2/checkout/orders`.
  - `actions.order.create(...)` in the browser also works, but it raises lint `pay.paypal-client-side-create`.
  - The approval opens a popup, or an overlay when the instance setting "Buttons mode" is inline. `onApprove({orderID, payerID})` fires when the buyer approves. Your server then captures or authorizes.
  - Approving without a capture or authorize within 30 s raises `pay.paypal-approve-without-capture`.
- **Card Fields.** `paypal.CardFields({createOrder, onApprove, onError})`, then `.NumberField().render(..)`, `.ExpiryField()`, `.CVVField()` and `.NameField()`. Call `cardFields.submit()`.
  - The fields are iframes on stubyard. Your page only gets brand and last 4.
  - Only test numbers are accepted. A real-looking number is cleared and warned about, and never stored.
  - If 3DS is needed, a challenge overlay opens. `onApprove({orderID, liabilityShift})` fires after it.
- **facilitatorAccessToken.** The token `onApprove` gets is SDK-scoped (15 min): the server API (`/v2/…`, `/v1/…`)
  answers 401 to it. Your server uses its own token from `POST /v1/oauth2/token`.

### Z.10 PayPal Expanded (server side)

- **Card payments.** Put `payment_source.card` (`number`, `expiry: "YYYY-MM"`, `name`, `security_code`) in `POST /v2/checkout/orders`.
  - Only test card numbers are accepted. A real-looking Luhn-valid number gives 422 `CARD_NUMBER_NOT_A_TEST_CARD` and a lint.
  - The digits are never stored: DB, traffic and exports keep only brand and last 4.
- **3D Secure.** Set `attributes.verification.method: "SCA_ALWAYS"`, or use the magic card `4000 0025 0000 3155` with `SCA_WHEN_REQUIRED`.
  - The order becomes `PAYER_ACTION_REQUIRED` with a `payer-action` link. Send the buyer there.
  - After the challenge, `GET` the order and read `payment_source.card.authentication_result`: `liability_shift` is `POSSIBLE` (enrollment Y, authentication Y) or `NO` (enrollment Y, authentication N).
  - Capturing without reading the order after approval raises lint `pay.paypal-capture-without-liability-check`.
- **Card declines.** The capture returns 201 with `status: "DECLINED"` and `processor_response.response_code`: 0500 generic, 5120 insufficient funds, 5400 expired, 5110 CVC, 9500 processing error.
- **AUTHORIZE intent.** `intent: "AUTHORIZE"`, approve, then `POST /v2/checkout/orders/<id>/authorize`. This returns `purchase_units[0].payments.authorizations[0]` (status `CREATED`, expiration about 29 days).
  - Then call `/v2/payments/authorizations/<authId>` with one of:
    - `GET`
    - `POST .../capture` (`{amount, final_capture}`; several partial captures are allowed; going over the total gives 422 `MAX_CAPTURE_AMOUNT_EXCEEDED`)
    - `POST .../void` (204, or 200 with `Prefer: return=representation`; 422 `PREVIOUSLY_CAPTURED` / `PREVIOUSLY_VOIDED`)
    - `POST .../reauthorize` (new authorization id; the old id then gives 422)
  - Calling `/capture` on an AUTHORIZE order gives 422 `ACTION_DOES_NOT_MATCH_INTENT`.
  - Webhooks: `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED` and `PAYMENT.CAPTURE.COMPLETED` (one per capture).
- **Vault v3.**
  - **Save at payment time.** `payment_source.card.attributes.vault.store_in_vault: "ON_SUCCESS"` (also on `paypal`). After a successful capture, the order shows `attributes.vault {id, status: "VAULTED", customer.id}`.
  - **Save without a payment.**
    1. `POST /v3/vault/setup-tokens` with `{payment_source:{card:{...}}}` (status `APPROVED`) or `{payment_source:{paypal:{usage_type:"MERCHANT", experience_context:{return_url,cancel_url}}}}` (`PAYER_ACTION_REQUIRED`; send the buyer to the `approve` link).
    2. `POST /v3/vault/payment-tokens` with `{payment_source:{token:{id:<setupTokenId>, type:"SETUP_TOKEN"}}}`. An unapproved setup token gives 422 `SETUP_TOKEN_NOT_APPROVED`.
  - **Pay with a token.** `payment_source.card.vault_id` or `payment_source.paypal.vault_id`. The order completes without the buyer.
  - **Manage tokens.** `GET /v3/vault/payment-tokens?customer_id=..`, `GET /v3/vault/payment-tokens/<id>`, `DELETE /v3/vault/payment-tokens/<id>`.
  - Webhooks: `VAULT.PAYMENT-TOKEN.CREATED` and `VAULT.PAYMENT-TOKEN.DELETED`, PayPal-signed.
  - **ID token for returning buyers.** `POST /v1/oauth2/token` with `response_type=id_token` returns `id_token`. This is an unsigned stand-in, so don't verify it.

### Z.11 Control API, MCP and dashboard additions

- `GET /api/projects/<slug>/payments/tokens?instance=&customer=&run=&kind=&limit=` lists vault tokens.
- `GET .../payments/<id>` now also returns `tokens` and `providerData`, which holds:
  - `authorization` (captures, previous ids)
  - `ops` (HyperPay CP/RV/RF)
  - `widget`, `sca`, `sdk` and `vault`
- No new MCP tools. `get_payment` shows tokens and authorization. `complete_payment` accepts the HyperPay and PayPal card outcomes. `payment_lint` lists the new checks.
- The payment detail page has a "HyperPay checkout" / "PayPal details" card: intent, 3DS, SDK flow, the authorization with its captures, backoffice operations and saved payment methods. Connect panels show copyable snippets.

### Z.12 Not verified against the real providers

These are stubyard's choices:
- **Issue names:** `CARD_NUMBER_NOT_A_TEST_CARD`, `SETUP_TOKEN_NOT_APPROVED`, `AUTHORIZATION_ALREADY_REAUTHORIZED`, `REAUTHORIZE_AMOUNT_EXCEEDED`, `REAUTHORIZATION_NOT_ALLOWED`, and `INVALID_RESOURCE_ID` for an unknown `vault_id`.
- **Card declines:** returned as 201 with a `DECLINED` capture; the processor code mapping is stubyard's.
- **Reauthorize:** allowed at any time; real PayPal allows it from day 4 to day 29.
- **SDK auth:** the SDK talks to stubyard with an `X-Stubyard-Client-Id` header, not a facilitator token.
- **Unverified values:** FUNDING values, the HyperPay open-checkout code (`000.200.000`) and the mada BIN and entity rules.
- **HyperPay PA declines:** shown with the decline code while the internal status stays "authorized".

### Z.13 More gateways: shared rules

Round 4 adds ten gateways. All of them run on the payment engine from Z.1 to Z.12: the same statuses, outcome order, rules, magic cards, runs, timeline, lint and export.

- **Create an instance:** POST /api/projects/<p>/payment-instances {"preset": "<id>", "config": {...}}. You can also use **Payments → Gateways → Add**. The default slug is the preset id (stripe-checkout gets "stripe"). The instance answer has connect.env (copy it into the app's .env), connect.notes and two connect.snippets that show how to verify the webhooks.
- **Base URL:** <stubyard>/pay/<project>/<instance>. Use it in place of the provider host. Inside a run, use /run/<key>/pay/<project>/<instance> or send the X-Hub-Run header.
- **Kinds:** hpp means the hosted page finishes the payment (Moyasar, Tap, Checkout.com). With manual / authorize / capture:false it stops at "authorized". order means the page only approves, and your server must capture (Tabby, Tamara). For Tabby and Tamara a decline already rejects on the page. The capture never fails later.
- **New page methods:** knet and benefit (debit redirect, no card form); bnpl (Tabby / Tamara: a phone number plus an OTP); wallet (a phone number plus an OTP); voucher (stays pending until it settles, like pending_then_success). The OTP goes to the project SMS inbox. Each gateway also accepts its documented test code (Tabby 8888; Moyasar STC Pay 123456 / 000000; Tamara 123456).
- **Provider test cards:** each gateway's documented sandbox cards are accepted on the page and on its card API without the real-card warning. A card mapped to an outcome (for example Checkout.com 4539467987109256 → decline 20005) forces that outcome. Any other Luhn-valid number is refused: it adds pay.real-card-entered and is never stored.
- **Webhooks are self-signed.** Each gateway builds the provider's own body and signature. The stubyard X-Hub-Signature headers are not added. Retries, duplicates, no_webhook and webhook_delay work as in Z.6. Gateways whose create call carries a callback / notification URL send webhooks there. Those gateways show no "no webhook URL" warning while the request has one.
- **Errors come in the provider's envelope** (for example Tap {errors:[{code, description}]}, Tabby {status:"error", errorType, error}, Checkout.com 422 {request_id, error_type, error_codes} and an empty 401).
- **Live keys** (sk_live_…, and Checkout.com production-format keys) are refused with 401 and add pay.live-key.
- **Late checks:** a payment that has been untouched for 30 s gets checks that need time to pass (charge never fetched, Tabby payment never captured, Tamara order never authorised). They show in **Payments → Integration checks**.

| Preset | Auth to stubyard | Amount format | Webhook / callback proof |
|---|---|---|---|
| stripe-checkout | Bearer sk_test_ | integer minor units | Stripe-Signature (HMAC-SHA256, t=…,v1=…) |
| paytabs | authorization: server key | decimal | signature header (HMAC-SHA256 of body, server key) |
| paypal | OAuth client credentials → Bearer | decimal string | verify-webhook-signature API |
| hyperpay | Bearer access token | decimal string "92.00" | AES-256-GCM encrypted body (hex key) |
| moyasar | Basic secret key (publishable key only for POST /v1/payments) | integer minor units | secret_token field in the body (shared secret) |
| tap | Bearer sk_test_ (pk_test_ for tokens) | decimal (KWD/BHD/OMR 3 places) | hashstring header: hex HMAC-SHA256 of x_id…x_created…, secret key |
| tabby | Bearer secret key | decimal string "100.00" | your own header title / value (no signature) |
| tamara | Bearer API token | {amount: decimal, currency} | tamaraToken: HS256 JWT signed with the notification token (query + Authorization) |
| checkout | Bearer sk_sbox_ | integer minor units (3-decimal currencies end in 0) | Cko-Signature: hex HMAC-SHA256 of the raw body, signature key; plus your Authorization header |
| aps | signature in the request (access_code + merchant_identifier) | integer minor units | signature: SHA-256 (or SHA-512 / HMAC) of the sorted pairs wrapped in the response phrase |
| myfatoorah | Bearer token | decimal | MyFatoorah-Signature: base64 HMAC-SHA256 of the sorted Data fields |
| geidea | Basic publicKey:apiPassword | decimal, 2 places in signatures | signature: base64 HMAC-SHA256 with the API password |
| jazzcash | pp_SecureHash in the request | integer paisa | pp_SecureHash: HMAC-SHA256 with the integrity salt |
| easypaisa | merchantHashedReq (AES/ECB, hash key) | decimal PKR | IPN GET with url= (fetch the details; no signature) |

### Z.14 Moyasar (preset moyasar)

**Connect:**
- MOYASAR_SECRET_KEY: HTTP Basic user name, with an empty password.
- MOYASAR_PUBLISHABLE_KEY: Moyasar Form. Allowed only for POST /v1/payments; any other call answers 403.
- MOYASAR_WEBHOOK_SECRET.
- MOYASAR_BASE_URL: use it instead of https://api.moyasar.com/v1. The value already ends in /v1.

Amounts are integers in the smallest unit (1000 = 10.00 SAR, at least 100).

| Endpoint | What |
|---|---|
| POST /v1/invoices | Hosted invoice: amount, currency, description, callback_url (the server receives the invoice object), success_url, back_url, metadata. 201 with url. |
| GET /v1/invoices, GET /v1/invoices/:id | List or fetch. The fetch counts as a status check. |
| PUT /v1/invoices/:id/cancel | Cancel an initiated invoice (status canceled). |
| POST /v1/payments | source.type creditcard (with 3-D Secure by default → status initiated plus source.transaction_url), token, applepay or stcpay (OTP: POST/GET source.transaction_url with otp_value). Takes manual: true (authorized), given_id (UUID, idempotent; a reused one gives used_given_id), callback_url and metadata. |
| GET /v1/payments, GET /v1/payments/:id | Filters: metadata[key], status, id. |
| POST /v1/payments/:id/refund · /capture · /void | Refund (partial or full) · capture an authorized payment · void an authorized payment. |
| POST / GET / DELETE /v1/webhooks, GET /v1/webhooks/available_events | Webhook registry, kept in the instance config. |

**Flow:** create the payment or invoice → the browser goes to url / transaction_url → stubyard page → redirect to callback_url (payments) or success_url / back_url (invoices) with ?id=&status=&message= → GET /v1/payments/:id. The query string is not proof of payment.

**Test values:** Moyasar's documented cards, for example 4201320111111010 (mada) and 5421080101000000 (Mastercard) approve; 4123120001090000 gives insufficient funds (51); 4123120001090109 declines (05); 4201322267774310 gives an expired card (54). The stubyard magic cards work too.

**Webhooks:** payment_paid, payment_captured (manual), payment_authorized, payment_failed, payment_refunded, payment_voided. The body is {id, type, created_at, secret_token, account_name, live: false, data: <payment>}. It goes to the registered webhook for that event (secret_token = its shared_secret), else to the instance webhook URL with the instance secret. Compare secret_token in constant time:

```js
const ok = crypto.timingSafeEqual(Buffer.from(String(req.body.secret_token)), Buffer.from(process.env.MOYASAR_WEBHOOK_SECRET));
```

**Refunds:** partial or full, through the API, the dashboard or the control API. Lint checks: pay.moyasar-amount-unit, pay.moyasar-card-on-server (card numbers sent with the secret key) and pay.moyasar-payment-not-fetched.

**Not simulated:** tokens creation (POST /v1/tokens), Samsung Pay, payouts, settlements and webhook verification calls.

### Z.15 Tap Payments (preset tap)

**Connect:**
- TAP_SECRET_KEY: Authorization: Bearer. It is also the hashstring key.
- TAP_PUBLIC_KEY: POST /v2/tokens only.
- TAP_BASE_URL: use it instead of https://api.tap.company/v2.

Tap's server SDKs have no base URL option: call the REST API, or use the host form. Amounts are decimals with the currency's places (10.500 KWD, 25.00 SAR).

| Endpoint | What |
|---|---|
| POST /v2/charges | source.id src_all (page with card, mada, KNET, BENEFIT, Apple Pay), src_card, src_kw.knet, src_sa.mada, src_bh.benefit, tok_… (card token; with threeDSecure: false the result comes back at once) or auth_… (capture an authorize). redirect.url is required for redirects (error 1110). post.url is the webhook. |
| POST /v2/authorize | Same body. Status AUTHORIZED after the page or at once for a token. |
| POST /v2/authorize/:id/void | Release an authorize (stubyard extension, see Z.20). |
| GET /v2/charges/:id, GET /v2/authorize/:id | Retrieve. Counts as a status check. |
| PUT /v2/charges/:id | Update description / metadata. |
| POST /v2/refunds, GET /v2/refunds/:id | {charge_id, amount, currency, reason, post.url}. Answers re_… with status REFUNDED. |
| POST /v2/tokens | {card: {number, exp_month, exp_year, cvc, name}}: Tap test cards only. |
| POST /v2/charges/list, /v2/authorize/list, /v2/refunds/list | {limit, status}. |

**Flow:** create the charge → transaction.url → page → redirect.url?tap_id=chg_… → GET /v2/charges/:id → status CAPTURED (response.code 000).

**Test values:** with tokens, the expiry decides the result: 01/39 approves, 05/22 declines (501), 04/27 gives an expired card (407), 08/28 a timeout. The cards are 5123450000000008, 4508750015741019 (3-D Secure), 4012000033330026 and 5111111111111118 (no 3-D Secure), and 4464040000000007 (mada). The response codes are 000 captured, 001 authorized, 100 initiated, 301 abandoned, 302 cancelled, 501 declined, 502 CVV, 505 insufficient funds, 407 expired card and 516 3-D Secure failed.

**Webhooks:** the charge, authorize or refund object is POSTed to post.url (else the default post URL). The hashstring header is a hex HMAC-SHA256, keyed with the secret key, of x_id<id>x_amount<amount with the currency's decimals>x_currency<c>x_gateway_reference<reference.gateway>x_payment_reference<reference.payment>x_status<status>x_created<transaction.created> (for a refund: its created):

```js
const created = o.object === 'refund' ? o.created : o.transaction.created;
const s = 'x_id' + o.id + 'x_amount' + Number(o.amount).toFixed(dec) + 'x_currency' + o.currency + 'x_gateway_reference' + (o.reference?.gateway ?? '') + 'x_payment_reference' + (o.reference?.payment ?? '') + 'x_status' + o.status + 'x_created' + created;
const ok = crypto.createHmac('sha256', process.env.TAP_SECRET_KEY).update(s).digest('hex') === req.headers.hashstring;
```

**Refunds:** partial or full. A refund over what is left gives 400 with code 1161. Lint checks: pay.tap-redirect-missing and pay.tap-charge-not-retrieved.

**Not simulated:** customers, saved cards and the card SDK UI; invoices, orders, subscriptions, destinations and businesses; Apple Pay / Google Pay tokens.

### Z.16 Tabby (preset tabby)

**Connect:**
- TABBY_SECRET_KEY: Authorization: Bearer for every server call.
- TABBY_PUBLIC_KEY.
- TABBY_MERCHANT_CODE.
- TABBY_WEBHOOK_HEADER / TABBY_WEBHOOK_SECRET: the default webhook header.
- TABBY_BASE_URL: use it instead of https://api.tabby.ai or api.tabby.sa.

Tabby has no server SDK. Amounts are decimal strings ("400.00"); a number adds pay.tabby-amount-format. Currencies are AED, SAR and KWD.

| Endpoint | What |
|---|---|
| POST /api/v2/checkout | Session with pre-scoring. status created plus configuration.available_products.installments[0].web_url, or status rejected (rejection_reason not_available, no web_url). |
| GET /api/v2/checkout/:id | The session again. |
| GET /api/v2/payments/:id | Payment: CREATED, AUTHORIZED, CLOSED, REJECTED or EXPIRED, with captures[] and refunds[]. |
| PUT /api/v2/payments/:id | Update order.reference_id. |
| POST /api/v2/payments/:id/captures | {amount, reference_id} on AUTHORIZED. Idempotent per reference_id. A full capture gives CLOSED. |
| POST /api/v2/payments/:id/refunds | {amount, reference_id, reason} on CLOSED. Idempotent per reference_id. |
| POST /api/v2/payments/:id/close | Release the rest. With no capture it voids. |
| POST / GET / PUT / DELETE /api/v1/webhooks | X-Merchant-Code header. {url, header: {title, value}}. |

**Flow:** create the session → web_url → page (mobile number, then the OTP) → merchant_urls.success / cancel / failure?payment_id=… → GET the payment → capture when you ship.

**Test values:**
- otp.success@tabby.ai with +971500000001 or +966500000001: approved.
- +971500000002 or +966500000002: pre-scoring rejected.
- otp.rejected@tabby.ai: rejected on the page.
- OTP: 8888, or the code in the SMS inbox.

**Webhooks:** the payment object with a lowercase status (authorized, closed, rejected, expired) goes to the first registered webhook, else to the default URL. It carries your header title and value; there is no signature. Compare the header, then re-fetch the payment:

```js
const ok = crypto.timingSafeEqual(Buffer.from(String(req.headers['x-auth-key'] ?? '')), Buffer.from(process.env.TABBY_WEBHOOK_SECRET));
```

**Refunds:** only after a capture (CLOSED). Partial refunds are allowed. Lint: pay.tabby-not-captured (AUTHORIZED but never captured).

**Not simulated:** the Tabby Card and other products, promo widgets, disputes, the payment list filters beyond limit, and the on-site pre-scoring endpoint.

### Z.17 Tamara (preset tamara)

**Connect:**
- TAMARA_API_TOKEN: Authorization: Bearer.
- TAMARA_NOTIFICATION_TOKEN: the HS256 key of tamaraToken.
- TAMARA_PUBLIC_KEY.
- TAMARA_API_URL: use it instead of https://api-sandbox.tamara.co. The Tamara SDKs take it as a constructor argument.

Amounts are {amount: decimal, currency} objects.

| Endpoint | What |
|---|---|
| POST /checkout | {order_reference_id, total_amount, items, consumer, shipping_address, country_code, merchant_url{success, failure, cancel, notification}}. Answers {order_id, checkout_id, checkout_url, status "new"}. |
| POST /orders/:id/authorise | Required after approval. Answers status authorised. |
| POST /payments/capture | {order_id, total_amount, shipping_info}. Answers partially_captured or fully_captured. Before authorise it answers 409 and adds lint. |
| POST /payments/simplified-refund/:order_id | {total_amount, comment}. Answers partially_refunded or fully_refunded. |
| POST /orders/:id/cancel | Only on authorised orders. Full amount. |
| GET /orders/:id, GET /merchants/orders/reference-id/:ref | Order with transactions {captures, refunds, cancels}. |
| PUT /orders/:id/reference-id | Change order_reference_id. |
| POST / GET / PUT / DELETE /webhooks | {type: "order", events, url, headers}. |

**Flow:** checkout → checkout_url → page (mobile number plus OTP) → merchant_url.success?orderId=…&paymentStatus=approved → order_approved webhook → authorise → capture when you ship.

**Test values:** the phones 536422337 (KSA) and 526422337 (UAE) are declined. Any other phone is approved. The OTP is the SMS code or 123456.

**Webhooks:** order_approved, order_declined, order_authorised, order_captured, order_refunded, order_canceled and order_expired. The body is {order_id, order_reference_id, order_number, event_type, data}. The target is a registered webhook that subscribes to the event, else merchant_url.notification, else the default URL. tamaraToken (HS256 JWT, iss "Tamara", 15-minute expiry, signed with the notification token) is sent as ?tamaraToken= and as Authorization: Bearer:

```js
import { jwtVerify } from 'jose';
await jwtVerify(req.query.tamaraToken, new TextEncoder().encode(process.env.TAMARA_NOTIFICATION_TOKEN), { algorithms: ['HS256'], issuer: 'Tamara' });
```

**Refunds:** after a capture, partial or full. Lint: pay.tamara-not-authorised (approved but never authorised).

**Not simulated:** in-store / pay-by-link checkouts, payment options pre-check, order update of items, and settlement reports.

### Z.18 Checkout.com (preset checkout)

**Connect:**
- CKO_SECRET_KEY: Authorization: Bearer sk_sbox_…. A bare key gives 401 and adds pay.checkout-key-without-bearer.
- CKO_PUBLIC_KEY: POST /tokens.
- CKO_SIGNATURE_KEY and CKO_WEBHOOK_AUTHORIZATION.
- CKO_BASE_URL: use it instead of https://api.sandbox.checkout.com. For checkout-sdk-node: new Checkout(key, { host: CKO_BASE_URL }); Java: CustomEnvironment. The Python and .NET SDKs have no base URL option.

Amounts are integer minor units. In 3-decimal currencies (KWD, BHD, OMR, JOD, IQD, LYD, TND) the last digit must be 0, else 422 amount_invalid and pay.checkout-amount-invalid.

| Endpoint | What |
|---|---|
| POST /hosted-payments | {amount, currency, reference, billing.address.country, success_url, failure_url, cancel_url}. 201 {id hpp_…, _links.redirect.href}. |
| POST /payment-links | {amount, currency, billing.address.country, return_url, expires_in}. 201 {id pl_…, expires_on, _links.redirect}. |
| GET /hosted-payments/:id, GET /payment-links/:id | Payment Pending / Payment Received / Expired (links: Active). |
| POST /payments | source {type: card, number, expiry_month, expiry_year, cvv} or {type: token, token}. capture: false gives Authorized. 3ds.enabled (or a 3-D Secure test card) gives 202 Pending + _links.redirect. Otherwise 201 Authorized / Captured / Declined with response_code. |
| GET /payments/:id | Accepts pay_… or sid_… (cko-session-id). Counts as a status check. |
| GET /payments/:id/actions | Authorization, Capture, Refund and Void actions. |
| POST /payments/:id/captures · /refunds · /voids | 202 {action_id, reference, _links.payment}. A capture or void in the wrong state answers 403. A refund over the balance answers 422. |
| POST /tokens | Public key. Test cards only. |

Cko-Idempotency-Key is honoured on every POST. The same key with another body answers 409.

**Flow (hosted):** create → _links.redirect.href → page → success_url?cko-payment-id=pay_… → GET /payments/:id. **Flow (card API, 3-D Secure):** 202 → _links.redirect.href → success_url?cko-session-id=sid_… → GET /payments/sid_….

**Test values:**
- 4242424242424242, 4543474002249996, 5436031030606378 and 345678901234564 approve.
- 4539467987109256 and 4024007181869214 decline with 20005.
- 4243754271700719 and 4485597929486000 go through a 3-D Secure challenge.
- Amount 101 gives 20051 (insufficient funds).
- A refund of 3738 is declined (payment_refund_declined).
- A past expiry gives an expired card (30033).

**Webhooks:** payment_approved, payment_captured, payment_declined, payment_pending, payment_refunded, payment_refund_declined, payment_voided, payment_canceled and payment_expired. The body is {id evt_…, type, version, created_on, data{id, action_id, amount, currency, reference, response_code, response_summary, balances…}, _links}. Cko-Signature is the hex HMAC-SHA256 of the raw body with the signature key. Your configured Authorization value is sent too:

```js
const ok = crypto.createHmac('sha256', process.env.CKO_SIGNATURE_KEY).update(rawBody).digest('hex') === req.headers['cko-signature']
  && req.headers.authorization === process.env.CKO_WEBHOOK_AUTHORIZATION;
```

**Refunds:** partial or full with 202. The result arrives as a webhook.

**Not simulated:** Flow / Frames UI, the Workflows API (webhooks are set on the instance), alternative payment methods, customers and instruments, disputes, payouts, and incremental authorizations.

### Z.19 Gateways batch 2: APS, MyFatoorah, Geidea, JazzCash, Easypaisa

Common to all five:

- Create an instance: POST /api/projects/<slug>/payment-instances {"preset": "aps" | "myfatoorah" | "geidea" | "jazzcash" | "easypaisa", "config": {...}}. The instance answer has connect.env (copy it into the app's .env), connect.notes and connect.snippets.
- Base URL: <stubyard>/pay/<project>/<instance>. Use it in place of the provider host. Inside a run use /run/<key>/pay/<project>/<instance>.
- Outcome: the buyer chooses it on the stubyard hosted page (success, decline:<reason>, cancel, pending_then_success for vouchers). A server-to-server call can force it with X-Hub-Payment-Outcome: decline:insufficient_funds. Payment rules (set_payment_rule) work the same way as for the other gateways.
- Decline reasons map to provider codes (tables below): generic, insufficient_funds, expired_card, incorrect_cvc, processing_error, authentication_failed, otp_failed, cancelled.
- Provider sandbox test cards are listed for reference only. On the stubyard page, use the stubyard test cards or the outcome buttons (see "Not verified" below).
- Every gateway signs its own webhooks. The usual stubyard signing headers are not added. Verify the provider's way: the snippets are below.
- Dashboard and control-API refunds (POST /api/projects/<slug>/payments/<id>/refund) work for all five. They send the provider's refund webhook where one exists.

#### Z.19.1 Amazon Payment Services (PayFort), preset aps

Connect: APS_MERCHANT_IDENTIFIER, APS_ACCESS_CODE, APS_SHA_REQUEST_PHRASE, APS_SHA_RESPONSE_PHRASE, APS_SHA_TYPE (SHA-256 by default; SHA-512 and HMAC-SHA256/512 can be set in config.shaType), APS_PAGE_URL (instead of https://sbcheckout.payfort.com/FortAPI/paymentPage) and APS_API_URL (instead of https://sbpaymentservices.payfort.com/FortAPI/paymentApi). Config: feedbackFormat "form" (default) or "json", webhookUrl (the direct transaction feedback URL).

| Endpoint | What |
|---|---|
| POST /FortAPI/paymentPage (form) | Redirection: command PURCHASE or AUTHORIZATION. 303 to the hosted page. |
| POST /FortAPI/paymentApi (JSON) command CAPTURE | 04000 success, 05xxx failure (an already captured order gives 05). |
| … command VOID_AUTHORIZATION | 08000 success, 09047 not voidable. |
| … command REFUND | 06000 success, 07048 amount exceeds what is left. |
| … query_command CHECK_STATUS | 12000 with transaction_status, transaction_code, transaction_message and authorized/captured/refunded_amount. |

Flow: sign the form → POST it to APS_PAGE_URL → the buyer pays → the browser is form-posted to return_url (response_code 14000 for a purchase, 02000 for an authorization) → feedback goes to webhookUrl → CHECK_STATUS → CAPTURE / REFUND by fort_id.

Return and feedback params: fort_id (18 digits), merchant_reference, amount (minor units), currency, status, response_code, response_message, payment_option, card_number (BIN******last4), expiry_date (YYMM), authorization_code, customer_email, eci, signature (made with the response phrase).

Request errors (form-posted back to return_url, else shown as an error page):

| Code | Meaning |
|---|---|
| 00008 | Signature mismatch (also adds lint pay.aps-signature) |
| 00009 / 00010 | Bad merchant_identifier / access_code |
| 00005 | Invalid amount (a decimal point also adds pay.aps-amount-unit) |
| 00013 | Invalid currency |
| 00066 | Duplicate merchant_reference |
| 00049 | KNET or MADA with AUTHORIZATION (purchase only) |

Declines: response_code = status + message code. Examples: 13029 insufficient funds, 13012 expired card, 13016 invalid card, 13030 authentication failed, 13666 generic, 13072 cancelled by the consumer.

Signature: the phrase, then the sorted name=value pairs (no separator, empty values left out, signature left out), then the phrase again, all hashed with SHA-256 → hex. The official docs example (phrase PASS) gives 94C38AFC…2C882; the tests check it.

~~~js
const crypto = require('node:crypto');
const sign = (p, phrase) => crypto.createHash('sha256').update(phrase + Object.keys(p).filter((k) => k !== 'signature' && p[k] !== '').sort().map((k) => k + '=' + p[k]).join('') + phrase).digest('hex');
const ok = sign(feedback, process.env.APS_SHA_RESPONSE_PHRASE) === feedback.signature;
~~~

Feedback event commands: PURCHASE, AUTHORIZATION, CAPTURE, REFUND, VOID_AUTHORIZATION.

Refunds: partial or full, more than one allowed, by fort_id. Lint pay.refund-exceeds applies.

Test cards (APS sandbox, reference only): 4005550000000001 success, 5123456789012346 MasterCard, 4557012345678902 3DS, 4916783391760242 declined, mada 5297410000000002, KNET test 0000000001.

Not simulated: the merchant page (tokenization), Apple Pay / STC Pay / Valu APIs, installments, recurring and the tokenization service, the Mobile SDK token API, and settlement reports.

#### Z.19.2 MyFatoorah, preset myfatoorah

Connect: MYFATOORAH_API_KEY (Authorization: Bearer <token>; any token of 20 or more characters that matches the instance is accepted), MYFATOORAH_BASE_URL (instead of https://apitest.myfatoorah.com) and MYFATOORAH_WEBHOOK_SECRET. Config: country (KWT, SAU, ARE, QAT, BHR, OMN, JOR, EGY) sets the currency and the methods; webhookVersion "1" (default) or "2".

| Endpoint | What |
|---|---|
| POST /v2/InitiatePayment | Payment methods with PaymentMethodId: 1 KNET (kn), 2 VISA/MASTER (vm), 5 Benefit (b), 6 mada (md), 11 Apple Pay (ap), 14 STC Pay (stc). |
| POST /v2/ExecutePayment | PaymentMethodId required. Answers PaymentURL. (A SessionId, the embedded payment, is rejected.) |
| POST /v2/SendPayment | NotificationOption LNK, EML, SMS or ALL. EML and SMS show up in the stubyard inbox as an email / SMS with the invoice link. |
| POST /v2/GetPaymentStatus | KeyType InvoiceId, PaymentId or CustomerReference. |
| POST /v2/MakeRefund | KeyType InvoiceId or PaymentId; Amount. |
| POST /v2/GetRefundStatus | By RefundId / RefundReference. |
| GET /<CTY>/ie/<key>, /En/<CTY>/PayInvoice/Checkout?invoiceKey= | Invoice page, redirects to the hosted page. |

Flow: ExecutePayment (or SendPayment) → PaymentURL → the buyer pays → redirect to CallBackUrl?paymentId=…&Id=… (ErrorUrl on failure) → GetPaymentStatus with KeyType PaymentId → the webhook → MakeRefund.

Statuses: InvoiceStatus Paid / Pending / Canceled. InvoiceTransactions[].TransactionStatus is Succss / Failed / InProgress / Canceled. MyFatoorah still serves the misspelling "Succss" and stubyard keeps it.

Errors: IsSuccess false, Message and ValidationErrors [{Name, Error}] with HTTP 400. A bad token gives 401. Declines show ErrorCode MF001 (3DS failed), MF002 (insufficient funds), MF003 (expired card), MF004 (invalid card), MF005 (processing error), MF006 (canceled) or MF020 (generic).

Webhooks go to the WebhookUrl of the invoice or the instance webhookUrl. They have a MyFatoorah-Signature header when webhookSecret is set.

- v1: EventType 1 TransactionsStatusChanged (Data.TransactionStatus SUCCESS / FAILED / CANCELED) and 2 RefundStatusChanged. The signature takes the Data properties (non-object) sorted by name as "Name=value" joined with "," (null becomes ""), as base64 HMAC-SHA256 with the secret. For refunds, GatewayReference is left out.
- v2: Event.Name PAYMENT_STATUS_CHANGED / REFUND_STATUS_CHANGED. It signs a fixed list of dotted keys, e.g. Invoice.Id, Invoice.Status, Transaction.Status, Transaction.PaymentId, Invoice.ExternalIdentifier.

~~~js
const sig = (data, secret) => crypto.createHmac('sha256', secret).update(Object.keys(data).filter((k) => data[k] === null || typeof data[k] !== 'object').sort().map((k) => k + '=' + (data[k] ?? '')).join(',')).digest('base64');
const ok = sig(body.Data, process.env.MYFATOORAH_WEBHOOK_SECRET) === req.headers['myfatoorah-signature'];
~~~

Refunds: partial or full. A refund over what is left gives 400 with ValidationErrors[Name=Amount]. Each refund sends a RefundStatusChanged webhook.

Test values (MyFatoorah sandbox, reference only): KNET 8888880000000001 09/30, mada 4464040000000007, Benefit 4600410123456789. The STC Pay OTP is 1234 (accepted on the stubyard OTP step).

Lint: pay.myfatoorah-items-mismatch (InvoiceItems do not add up to InvoiceValue) and pay.myfatoorah-status-never-checked.

Not simulated: the embedded payment (SessionId, InitiateSession), recurring and tokens, suppliers and multi-vendor, shipping, CancelToken / CancelRecurring, and the portal.

#### Z.19.3 Geidea, preset geidea

Connect: GEIDEA_PUBLIC_KEY, GEIDEA_API_PASSWORD (Basic auth publicKey:apiPassword), GEIDEA_BASE_URL (instead of https://api.merchant.geidea.net, https://api.ksamerchant.geidea.net or https://api.geidea.ae), GEIDEA_HPP_URL and GEIDEA_CHECKOUT_JS.

| Endpoint | What |
|---|---|
| POST /payment-intent/api/v2/direct/session | Signed create session. paymentOperation Pay (default), PreAuthorize or AuthorizeCapture. Answers responseCode 000 and session {id, orderId, status Initiated, …}. |
| GET /hpp/checkout/?<sessionId> | Hosted page (redirect mode). |
| GET /hpp/geideaCheckout.min.js | Shim: new GeideaCheckout(onSuccess, onError, onCancel).startPayment(sessionId) redirects. |
| GET /pgw/api/v1/direct/order/{orderId} | Order: status Success / Failed / InProgress, detailedStatus (Paid, Authorized, Captured, PartiallyRefunded, Refunded, Voided, OrderFailed …), totals, transactions[]. |
| POST /pgw/api/v1/direct/capture | {orderId, captureAmount?} for PreAuthorize orders. |
| POST /pgw/api/v3/direct/void | {orderId} for authorized orders that are not captured. |
| POST /pgw/api/v1/direct/cancel | {orderId, reason} before payment. Answers responseCode 010. |
| POST /pgw/api/v2/direct/refund | {orderId, refundAmount, timestamp, signature}. (v1 refund is also accepted, unsigned, with a warning.) |

Flow: create the session on the server → GEIDEA_HPP_URL?<session.id> (or the JS shim) → the buyer pays → redirect to returnUrl with responseCode, responseMessage, detailedResponseCode, orderId, sessionId, merchantReferenceId, timeStamp and signature → the callback to callbackUrl → GET order.

Signatures (base64 HMAC-SHA256 keyed with the API password; amounts with 2 decimals):

- session: publicKey + amount + currency + merchantReferenceId + timestamp
- refund: timestamp + publicKey + refundAmount + orderId
- callback and return: publicKey + amount + currency + orderId + status + merchantReferenceId + timeStamp

~~~js
const sign = (s) => crypto.createHmac('sha256', process.env.GEIDEA_API_PASSWORD).update(s).digest('base64');
const o = body.order;
const ok = sign(process.env.GEIDEA_PUBLIC_KEY + Number(o.amount).toFixed(2) + o.currency + o.orderId + o.status + o.merchantReferenceId + body.timeStamp) === body.signature;
~~~

Errors: HTTP 400 {responseCode "110", detailedResponseCode "003" invalid amount / "004" currency / "011" signature …}. 401 means bad Basic auth. Declines: responseCode 210 with detailed codes 051 insufficient funds, 054 expired card and 082 CVV; 300 means 3DS failed; 010 means cancelled.

Callback: JSON {order, responseCode, responseMessage, detailedResponseCode, timeStamp, signature} on paid, failed, cancelled and refunded.

Refunds: partial or full (v2 needs refundAmount).

Test cards (Geidea, reference only): 5123450000000008, 4440000042200014 (frictionless), mada 4464040000000007; failure 5111111111111118.

Lint: pay.geidea-signature and pay.geidea-callback-not-https (Geidea only calls HTTPS).

Not simulated: the drop-in and modal UI callbacks (the shim always redirects), direct API pay with card data (/pgw/api/v6/direct/pay), 3DS initiate / authenticate, tokens and subscriptions, Meeza / ValU / Shahry / Souhoola, and Pay by Link.

#### Z.19.4 JazzCash, preset jazzcash

Connect: JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD, JAZZCASH_INTEGRITY_SALT, JAZZCASH_PAGE_URL (instead of https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/) and JAZZCASH_BASE_URL (instead of https://sandbox.jazzcash.com.pk; the REST paths go under it).

| Endpoint | What |
|---|---|
| POST /CustomerPortal/transactionmanagement/merchantform/ (form) | Page redirection, pp_TxnType MPAY (card), MWALLET or OTC (voucher). 303 to the hosted page. |
| POST /ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction (also /Purchase/DoMWalletTransaction and DoMWalletTxn) | Mobile account (REST, JSON). |
| POST /ApplicationAPI/API/PaymentInquiry/Inquire | Status by pp_TxnRefNo: pp_Status Completed / Pending / Failed …. |
| POST /ApplicationAPI/API/authorize/Refund, /Purchase/domwalletrefundtransaction | Card / wallet refund. |

Flow: build the pp_ fields → pp_SecureHash → POST the form → the buyer pays → form POST to pp_ReturnURL with the pp_ fields + pp_SecureHash → Inquire → the IPN (vouchers and wallets).

Amount: PKR only, in paisa (Rs 1,500 → 150000). Other values give 110 plus lint pay.jazzcash-amount.

Codes: 000 success, 121 settled (IPN), 124 voucher waiting for payment, 157 wallet pending, 110 invalid value or hash. Declines: 004 low balance, 003 inactive or expired, 134 authentication / MPIN failed, 101 cancelled, 133 expired, 199 system error, 999 generic.

Hash: HMAC-SHA256 keyed with the integrity salt, over salt + "&" + the values of the non-empty pp* fields (sorted by name, without pp_SecureHash) joined with "&", as UPPER-case hex.

~~~js
const hash = (f, salt) => crypto.createHmac('sha256', salt).update([salt, ...Object.keys(f).filter((k) => k.startsWith('pp') && k !== 'pp_SecureHash' && f[k] !== '').sort().map((k) => f[k])].join('&')).digest('hex').toUpperCase();
const ok = hash(body, process.env.JAZZCASH_INTEGRITY_SALT) === String(body.pp_SecureHash).toUpperCase();
~~~

IPN: JSON pp_ fields + pp_SecureHash to the instance webhookUrl, sent when a voucher or wallet settles (121), fails or expires. Answer with JSON {pp_ResponseCode: "000"}.

Refunds: partial or full via the API. Over the remaining amount gives a non-000 code.

Test values (JazzCash sandbox, reference only): mobile account 03123456789, CNIC last 6 digits 345678.

Lint: pay.jazzcash-secure-hash, pay.jazzcash-amount and pay.jazzcash-never-inquired.

Not simulated: the card REST API (3DS, Authorize / Capture / Void), tokenized payments, the voucher (OTC) REST API, the merchant portal, and settlement.

#### Z.19.5 Easypaisa, preset easypaisa

Connect: EASYPAY_STORE_ID, EASYPAY_HASH_KEY, EASYPAY_USERNAME / EASYPAY_PASSWORD (REST "Credentials" header = base64 user:pass), EASYPAY_ACCOUNT_NUM, EASYPAY_CHECKOUT_URL / EASYPAY_CONFIRM_URL (instead of https://easypaystg.easypaisa.com.pk/easypay/Index.jsf and Confirm.jsf) and EASYPAY_REST_BASE_URL. config.requireHash (on by default) makes merchantHashedReq mandatory.

| Endpoint | What |
|---|---|
| POST /easypay/Index.jsf (form) | Hosted checkout step 1: storeId, amount, postBackURL, orderRefNum, expiryDate, paymentMethod (CC_ / MA_ / OTC_PAYMENT_METHOD), merchantHashedReq. 302 to postBackURL?auth_token=…&postBackURL=…. |
| POST or GET /easypay/Confirm.jsf | Step 2 with auth_token + the final postBackURL. 303 to the hosted page. |
| POST /easypay-service/rest/v4/initiate-ma-transaction | Mobile account (REST). |
| POST /easypay-service/rest/v4/inquire-transaction | Status: transactionStatus PAID / PENDING / FAILED …. |
| GET /easypay-service/rest/ipn/<token> | IPN details (snake_case JSON), the URL the IPN hands over. |

Flow: Index.jsf → your page posts auth_token to Confirm.jsf → the buyer pays → redirect to the final postBackURL with success, status (0000), desc, orderRefNumber (and paymentToken for OTC vouchers) → the IPN → fetch its url= → inquire-transaction.

merchantHashedReq: the posted fields as sorted "k=v&…" (empty values left out), encrypted with AES-ECB (PKCS5 padding; AES-128/192/256 picked by the hash key length) and base64-encoded. A mismatch gives HTTP 400 plus lint pay.easypaisa-hash.

~~~js
const plain = Object.keys(f).filter((k) => f[k] !== '').sort().map((k) => k + '=' + f[k]).join('&');
const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(process.env.EASYPAY_HASH_KEY), null);
f.merchantHashedReq = Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');
~~~

IPN: GET <webhookUrl>?url=<details URL>. The IPN call has no status and no signature, so fetch the URL (or call inquire-transaction). Sent on paid (not vouchers), settled, failed and expired. Lint pay.easypaisa-ipn-not-fetched applies.

Codes: 0000 success, 0001 failed (generic, card or OTP errors), 0013 cancelled by the user, 0014 low balance, 0015 expired.

Refunds: Easypaisa has no public refund API. Refund from the stubyard dashboard or the control API (partial or full).

Not simulated: the OTC voucher REST API, tokenized and recurring payments, direct debit, and the merchant portal.

### Z.20 Not verified against the real providers (round 4)

These are stubyard's choices.

| Gateway | Not verified / stubyard's choice |
|---|---|
| Core | The test-card list per gateway is from public docs. Cards there map to an outcome; other published sandbox numbers may behave differently on the real sandbox. Late checks fire after 30 s untouched. |
| Moyasar | The "APPROVED" message on paid payments; a partially refunded payment shows status "refunded" (with refunded < amount); the webhook body field names other than type / data / secret_token; the 403 text for publishable keys on other endpoints. |
| Tap | GET /v2/charges/:id and POST /v2/authorize/:id/void were not found on the public reference (taken from the SDKs); the tap_id return parameter; src_sa.mada and src_bh.benefit source ids; the activities, card and receipt fields; the error codes other than 1110 / 1150 / 2104. |
| Tabby | The webhook body (modelled as the payment with a lowercase status); acceptance of the public key on POST /api/v2/checkout (accepted with a warning); the 4-webhook limit; the close behaviour on a partly captured payment; error texts. |
| Tamara | The redirect query parameters (orderId, paymentStatus); the 123456 test OTP; the jti claim in tamaraToken and its 900 s lifetime; GET /merchants/orders/reference-id/:ref (SDK only); cancel limited to authorised orders and the full amount; the error codes. |
| Checkout.com | The full hosted-payments response and the cko-payment-id return parameter; the 403 body for captures / voids in the wrong state; the 409 for a reused idempotency key; the declined refund's response code 20057; the webhook version string; the treatment of production-format keys. |
| APS | HMAC-SHA256/512 signature wrapping (phrase-wrapped string vs bare string) (Ambiguous in the docs; both accepted) |
| APS | Request-error codes other than 00008 (00005, 00009, 00010, 00013, 00049, 00066) (Taken from the response-code table; the triggering rules are stubyard's) |
| APS | CHECK_STATUS answer fields beyond transaction_status / code / message (Partly modelled) |
| MyFatoorah | The Id= param on CallBackUrl next to paymentId (Not verified) |
| MyFatoorah | PaymentMethodCode md / stc / b and PaymentMethodIds 5, 6, 11, 14 (Not verified (vary by account)) |
| MyFatoorah | GetRefundStatus answer shape; MF0xx decline codes (Not verified; codes are stubyard's) |
| Geidea | Return URL query parameters and their signature (Not documented; stubyard design) |
| Geidea | Callback body shape and signature field order (Field list from the docs, order assumed) |
| Geidea | Session timestamp format (Undefined; any string accepted) |
| Geidea | Decline responseCode / detailed codes (210 / 051, 054, 082) (stubyard's) |
| JazzCash | Official docs unreachable; all from secondary sources (Not verified) |
| JazzCash | merchantform path, DoMWalletTransaction vs DoMWalletTxn, Inquire field names, decline codes (Not verified) |
| JazzCash | IPN acknowledgement format (stubyard accepts any 2xx) (Not verified) |
| Easypaisa | Official docs unreadable; all from secondary sources (plugins / SDKs) (Not verified) |
| Easypaisa | Return params (success / status / desc), codes 0013, 0014, 0015, IPN details JSON keys (Not verified) |
| Easypaisa | REST v4 paths and Credentials header (From secondary sources) |
| APS, JazzCash, Easypaisa | Provider test card numbers are not known to the stubyard page (Use the stubyard outcomes). MyFatoorah and Geidea accept their documented sandbox cards (Z.23). |

### Z.21 PayPal subscriptions (Catalog Products v1, Billing Plans v1, Subscriptions v1) and Disputes v1

Everything runs on an existing PayPal instance with the same base URL (PAYPAL_API_BASE = <stubyard>/pay/<project>/<instance>, and /run/<key>/pay/… inside a run). The same OAuth token (POST /v1/oauth2/token) is used, and so are the RSA-signed webhooks (verify them with POST /v1/notifications/verify-webhook-signature or with the instance certificate). Products, plans, subscriptions and disputes are stored as payment tokens (kinds pp_product, pp_plan, pp_subscription, pp_dispute), so no migration was needed. Each charge is a normal payment row, which means the Payments list, refunds and outcome rules all work on it.

#### Z.21.1 Products and plans

| Endpoint | What |
|---|---|
| POST /v1/catalogs/products | 201. name is required. type is PHYSICAL (default), DIGITAL or SERVICE. id is optional (PROD-… is generated). Duplicate id gives 422 DUPLICATE_RESOURCE_IDENTIFIER. |
| GET /v1/catalogs/products?page_size&page&total_required | {products, total_items?, total_pages?, links} |
| GET / PATCH /v1/catalogs/products/<id> | PATCH is a JSON Patch array that returns 204. Patchable: /description, /category, /image_url, /home_url (anything else gives 400 INVALID_PATCH_PATH). |
| POST /v1/billing/plans | 201. Needs product_id (it must exist), name, billing_cycles and payment_preferences. status defaults to ACTIVE (CREATED or INACTIVE are allowed). Without "Prefer: return=representation" the answer is the minimal form (no billing_cycles). |
| GET /v1/billing/plans?product_id&plan_ids&page_size&page&total_required | {plans, …} |
| GET / PATCH /v1/billing/plans/<id> | PATCH returns 204. Paths: /description, /name, /payment_preferences/{auto_bill_outstanding, payment_failure_threshold, setup_fee, setup_fee_failure_action}, /taxes/percentage. An INACTIVE plan gives 422 PLAN_STATUS_INACTIVE. |
| POST /v1/billing/plans/<id>/activate, /deactivate | 204. A wrong current status gives 422 PLAN_STATUS_INVALID. |
| POST /v1/billing/plans/<id>/update-pricing-schemes | 204. {pricing_schemes: [{billing_cycle_sequence, pricing_scheme}]}. Each change bumps pricing_scheme.version. |

Cycle rules (checked):
- Sequences run 1..n with no gaps.
- TRIAL cycles come before the single REGULAR cycle.
- Only the last cycle may be infinite (total_cycles 0), and a TRIAL cycle can never be infinite.
- interval_unit is DAY, WEEK, MONTH or YEAR, with an interval_count up to 365, 52, 12 or 1 respectively.
- Pricing is either fixed_price or tiers with pricing_model VOLUME or TIERED (TIERED and VOLUME tiers are priced by quantity when quantity_supported is set).
- All amounts use one currency, otherwise 422 CURRENCY_MISMATCH.

Webhooks:
- CATALOG.PRODUCT.CREATED and CATALOG.PRODUCT.UPDATED.
- BILLING.PLAN.CREATED, BILLING.PLAN.UPDATED, BILLING.PLAN.ACTIVATED, BILLING.PLAN.DEACTIVATED and BILLING.PLAN.PRICING-CHANGE.ACTIVATED.

#### Z.21.2 Subscriptions

| Endpoint | What |
|---|---|
| POST /v1/billing/subscriptions | 201 APPROVAL_PENDING with an "approve" link. Needs plan_id (the plan must be ACTIVE, else 422 PLAN_STATUS_INVALID). Optional: quantity (needs quantity_supported, else 422 SUBSCRIPTION_CANNOT_HAVE_QUANTITY), start_time, shipping_amount, custom_id, subscriber, plan (override of pricing / total_cycles / payment_preferences), and application_context {return_url, cancel_url, brand_name, user_action}. Minimal answer unless Prefer: return=representation. |
| GET /v1/billing/subscriptions?plan_ids&statuses&created_after&created_before&page_size&page | {subscriptions, links} (minimal objects). |
| GET /v1/billing/subscriptions/<id>?fields=last_failed_payment,plan | Includes billing_info: outstanding_balance, cycle_executions, last_payment, next_billing_time, final_payment_time, failed_payments_count and last_failed_payment. |
| PATCH /v1/billing/subscriptions/<id> | 204. Only for ACTIVE or SUSPENDED subscriptions. Paths: /custom_id, /shipping_amount, /billing_info/outstanding_balance (can only go down), /subscriber/shipping_address, /plan/payment_preferences/{payment_failure_threshold, auto_bill_outstanding}. |
| POST …/<id>/suspend, /cancel | 204. {reason} is required (400 MISSING_REQUIRED_PARAMETER). A wrong status gives 422 SUBSCRIPTION_STATUS_INVALID. |
| POST …/<id>/activate | 204, from SUSPENDED. reason is optional. Cycles missed while suspended are not billed: the next billing is one interval from now. |
| POST …/<id>/revise | 200 {plan_id, quantity, shipping_amount, plan_overridden, links: [approve]}. The new plan must be ACTIVE, belong to the same product (else 422 PLAN_PRODUCT_NOT_COMPATIBLE) and use the same currency. The change applies when the buyer approves it on the page. |
| POST …/<id>/capture | {note, capture_type: "OUTSTANDING_BALANCE", amount}, all required. Returns 202 with a transaction {status COMPLETED or DECLINED, id, amount_with_breakdown, payer_name, payer_email, time}. Errors: 422 ZERO_OUTSTANDING_BALANCE, AMOUNT_GREATER_THAN_OUTSTANDING_BALANCE. |
| GET …/<id>/transactions?start_time&end_time | Both parameters are required. Lists the charges as COMPLETED, DECLINED, REFUNDED or PARTIALLY_REFUNDED. |
| GET /v1/payments/sale/<id>, POST …/refund | v1 sale of one charge (state completed, refunded, partially_refunded or denied; billing_agreement_id). Refund: {amount: {total, currency}} returns 201. |

Approval flow:
1. The app redirects the buyer to the "approve" link (<base>/webapps/billing/subscriptions?ba_token=BA-…).
2. That link opens the stubyard PayPal page (outcome buttons, rules and the X-Hub-Payment-Outcome header on the create call, as for orders).
3. The page charges setup fee + the first cycle. A trial at price 0 or a later start_time charges only the setup fee (possibly 0).
4. The buyer returns to return_url?subscription_id=I-…&ba_token=BA-…&token=EC-…, or to cancel_url (the subscription stays APPROVAL_PENDING).
5. If the first charge is declined, the subscription is ACTIVE with an outstanding balance and BILLING.SUBSCRIPTION.PAYMENT.FAILED. With a setup fee and setup_fee_failure_action CANCEL it is CANCELLED instead.

Billing cycles:
- A durable job (it survives restarts) bills each cycle at next_billing_time.
- Each subscription has its own clock: real time + data.clockOffsetMs. Moving it is how you test a month in a second, and it does not touch the global clock.
- Each billed cycle is a payment row (kind order, providerData.subscription, sale id in providerData.saleId) that sends PAYMENT.SALE.COMPLETED. Tax is added when taxes.inclusive is false, and shipping_amount is added per cycle.
- Declined cycles go into the outstanding balance and send BILLING.SUBSCRIPTION.PAYMENT.FAILED. The next successful cycle adds the outstanding balance when auto_bill_outstanding is set.
- When failed_payments_count reaches payment_failure_threshold (if it is above 0), the subscription becomes SUSPENDED and sends BILLING.SUBSCRIPTION.SUSPENDED.
- After the last finite cycle it becomes EXPIRED and sends BILLING.SUBSCRIPTION.EXPIRED.
- Which outcome a cycle gets: an explicit outcome (control API), then queued outcomes, then the instance defaultOutcome, then success.

Webhooks:
- BILLING.SUBSCRIPTION.CREATED, ACTIVATED, UPDATED, SUSPENDED, CANCELLED, EXPIRED and PAYMENT.FAILED (resource = the subscription).
- PAYMENT.SALE.COMPLETED and PAYMENT.SALE.REFUNDED (resource = the v1 sale or refund, resource_version 1.0).
- Delivery uses the instance webhookDelayMs. Retries follow the payment webhook delays (5 s, 30 s, 120 s). The attempts are listed in the dashboard.

#### Z.21.3 Disputes

The buyer side is stubyard: open a dispute from the dashboard (Payments → Subscriptions & disputes → "Open a dispute as the buyer"), the control API or MCP. It opens on a captured PayPal payment: an order capture or a subscription sale, with status paid or partially_refunded. Only one dispute per payment can be open at a time.

| Endpoint (app side) | What |
|---|---|
| GET /v1/customer/disputes?disputed_transaction_id&dispute_state&start_time&page_size(1-50)&page | {items: [dispute_info with dispute_state], links}. page_size outside 1-50 gives 400 INVALID_PAGE_SIZE. |
| GET /v1/customer/disputes/<id> | Full dispute: disputed_transactions, reason, status, dispute_amount, dispute_outcome, dispute_life_cycle_stage, dispute_channel, messages, evidences, offer.history, money_movements, response due dates, allowed_response_options, and links only for the actions that are allowed now. |
| POST …/<id>/make-offer | {note, offer_type REFUND, REFUND_WITH_RETURN, REFUND_WITH_REPLACEMENT or REPLACEMENT_WITHOUT_REFUND, offer_amount}. INQUIRY stage only. Status becomes WAITING_FOR_BUYER_RESPONSE. |
| POST …/<id>/accept-claim | {note, accept_claim_type, refund_amount?}. Refunds through the normal refund path (PAYMENT.CAPTURE.REFUNDED or PAYMENT.SALE.REFUNDED) and resolves as RESOLVED_BUYER_FAVOUR. refund_amount on MERCHANDISE_OR_SERVICE_NOT_RECEIVED gives 422 AMOUNT_SHOULD_NOT_BE_PASSED. The REFUND_WITH_RETURN types wait for acknowledge-return-item. |
| POST …/<id>/provide-evidence | multipart/form-data: a JSON part "input" {evidences: [{evidence_type, notes, …}]} plus evidence-file parts (JPG, GIF, PNG or PDF, at most 10 MB each, else 422 INVALID_EVIDENCE_FILE). Plain JSON is accepted too. Status becomes UNDER_REVIEW. |
| POST …/<id>/escalate | {note}. INQUIRY only. The stage becomes CHARGEBACK and the status UNDER_REVIEW. |
| POST …/<id>/send-message, /acknowledge-return-item, /provide-supporting-info | As documented. |
| POST …/<id>/require-evidence (sandbox) | {action SELLER_EVIDENCE or BUYER_EVIDENCE}, UNDER_REVIEW only. Status becomes WAITING_FOR_SELLER_RESPONSE or WAITING_FOR_BUYER_RESPONSE. |
| POST …/<id>/adjudicate (sandbox) | {adjudication_outcome BUYER_FAVOR or SELLER_FAVOR}, UNDER_REVIEW only. BUYER_FAVOR refunds the disputed amount. |
| POST …/<id>/accept-offer, /deny-offer | Buyer calls. Accepting refunds the offer (REFUND_WITH_RETURN waits for the return). Denying sends the dispute back to the seller. |

An action outside the allowed state gives 422 ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE. Every action returns 200 {links: [parent]}.

Webhooks: CUSTOMER.DISPUTE.CREATED, CUSTOMER.DISPUTE.UPDATED and CUSTOMER.DISPUTE.RESOLVED (resource = the dispute). Each step is also on the disputed payment's timeline (event "dispute").

#### Z.21.4 Control API, MCP and dashboard

Base: /api/projects/<slug>/payments.

| Route | What |
|---|---|
| GET /subscriptions?status&instance&run, GET /subscriptions/<id> | Views with plan, next amount and time, the subscription clock, cycles, failures, outstanding balance, approval URL, charges and webhook attempts. |
| POST /subscriptions/<id>/advance | {cycles: n} moves the clock to each next_billing_time and bills it. {by: "+30d"} moves the clock and bills every cycle that became due. At most 120 cycles per call: cycles above 120, or a "by" that would make more than 120 cycles due, gets a 400 and the clock does not move (advance in smaller steps). Optional outcome: "decline" for the first one. |
| POST /subscriptions/<id>/bill | {outcome?}: bill the current cycle now without moving the clock. |
| POST /subscriptions/<id>/outcomes | {outcomes: ["decline", "success"]}: queued outcomes for the next billings (scheduled ones too). |
| POST /subscriptions/<id>/status | {action: suspend, activate or cancel, reason?}, as PayPal or the buyer would do it. |
| GET /plans | Plans with product and subscription count. |
| GET /disputes?status&payment&run, GET /disputes/<id> | Views with what the app may do now (allowed) and what the buyer can do (buyerCan). |
| POST /<payment>/dispute | {reason?, amount?, stage?: INQUIRY or CHARGEBACK, message?}. Returns 201. |
| POST /disputes/<id>/buyer | {action: accept-offer, deny-offer, send-message or escalate, note?}. |
| POST /disputes/<id>/merchant | {action, input?}: the merchant / sandbox actions, run from the dashboard. |
| POST /disputes/<id>/resolve | {outcome: buyer (refund), seller or cancelled}. |

MCP tools: list_paypal_subscriptions, bill_paypal_subscription (cycles / by / outcome), set_paypal_subscription_status, open_paypal_dispute, list_paypal_disputes, act_on_paypal_dispute (buyer actions or resolve).

Dashboard: Payments → "Subscriptions & disputes" has four parts:
- Subscriptions table with row details (billing, charges, webhooks) and actions: bill now, bill declined, advance 30 days, decline next, suspend, activate, cancel, open the approval page.
- Disputes table with buyer and PayPal actions.
- An "open a dispute" form.
- The plans list.

Test recipe:
1. Create a product, then a plan, then a subscription.
2. Approve it (follow the approve link, or POST /api/projects/<slug>/payments/<approvalPayment>/complete {"outcome":"success"}).
3. Assert BILLING.SUBSCRIPTION.ACTIVATED and PAYMENT.SALE.COMPLETED.
4. Call bill_paypal_subscription {cycles: 1, outcome: "decline"} twice and assert PAYMENT.FAILED, then SUSPENDED.
5. Open a dispute on a sale, answer with accept-claim and assert PAYMENT.SALE.REFUNDED plus CUSTOMER.DISPUTE.RESOLVED.

#### Z.21.5 Not simulated / not verified

Checked against PayPal's published OpenAPI specs (subscriptions v1, catalog-products v1, customer-disputes v1): endpoints, status enums, request fields, 204 / 200 / 202 codes, error issue names and webhook event names.

Not verified (stubyard's best guess):
- resource_type and resource_version of the non-order events (product / plan / subscription 2.0, sale / refund / dispute 1.0).
- The v1 sale webhook resource shape (from older PayPal samples).
- The approve link form (/webapps/billing/subscriptions?ba_token=…) and the query PayPal adds to return_url (subscription_id, ba_token, token).
- The body of the 202 answer to capture.
- The outcome code after an accepted offer (RESOLVED_BUYER_FAVOUR is used).
- The multipart part name "input" for the JSON of provide-evidence.
- Response due-date lengths (20 days for an inquiry, 10 days later).
- The PP-D- dispute id format.
- Exact error issue names for: plan cycle validation (INVALID_BILLING_CYCLE_SEQUENCE), PLAN_PRODUCT_NOT_COMPATIBLE, INVALID_START_TIME, REFUND_AMOUNT_EXCEEDED.

Not simulated:
- Card (non-wallet) subscriptions and payer-initiated plan changes.
- Plan tier validation beyond basic shape.
- Appeals (appeal gives 422).
- Dispute PATCH (partner-only).
- The dispute "offer history" from the buyer side beyond accept / deny.
- Real dispute timers (due dates are informational).
- A global "payments" clock feature. Subscriptions use their own clock (data.clockOffsetMs) moved by advance; the project clock offsets (Z.x Time) do not move it.

### Z.22 Checkout experiences (realistic and classic payment pages)

Every page stubyard serves for a payment (hosted page, popup, lightbox, bank page, SDK frame), for all 14 gateways,
carries a test notice that cannot be switched off: "TEST · stubyard simulator · not a real payment, no money moves"
(Arabic: "تجربة · محاكي stubyard · ليست عملية دفع حقيقية، ولا تُنقل أي أموال"). Every page title starts with
`[TEST] `. On later screens (3-D Secure, OTP, result) and in small frames the notice may shrink to a thin strip or a
"TEST" tag, but it is never hidden. Selector: `[data-testid="stubyard-test-banner"]`.

**Two views per payment provider (instance config `experience`):**

- `realistic`: the page follows the provider's own flow and screens (Z.23), in stubyard's neutral look. The pages never
  use provider logos, brand colours or fonts; the provider appears only as text, for example "Stripe (simulated)".
  Test shortcuts sit in a collapsible "Test controls" drawer (`[data-testid="stubyard-drawer"]`): the outcome of the
  Pay button, the test user, magic cards, other outcomes (abandon, the decline reasons), language, the flow steps with
  a fidelity tag each, and a link to the classic view. Pay (`stubyard-pay`), Decline (`stubyard-decline`) and Cancel
  (`stubyard-cancel`) are on the page without opening the drawer, and finish the payment from any screen.
- `classic`: the earlier stubyard page (Z.2), every test button in view. It also follows the payment's page language
  (Arabic, right to left).

New instances start on `realistic`. Instances created before this feature, and instances imported from an export
without an `experience` key, stay on `classic`. Switch with one click in the dashboard (**Payments → Checkout
pages**, which also shows each integration mode with its fidelity tags and a **Demo shop** link) or:

```
PATCH /api/projects/<project>/payment-instances/<slug>   {"config": {"experience": "realistic"}}
```

**Other instance settings (realistic view only):**

| key | values | default | effect |
| --- | --- | --- | --- |
| `pageLocale` | `auto`, `en`, `ar` | `auto` | `auto` uses the language the request asked for (Stripe `locale`, PayTabs `paypage_lang`, PayPal `locale`, …), else English. `ar` gives a right-to-left page. JazzCash and Easypaisa are English only. |
| `pageTimings` | `auto`, `realistic`, `fast` | `auto` | Short Pay spinner and "contacting your bank" pause. `auto` skips them when the browser reports automation (`navigator.webdriver`). Timings are in the browser only; server answers are never delayed. |
| `pageDrawer` | `closed`, `open` | `closed` | Whether the Test controls drawer starts open. |

**Per-payment overrides on the page URL** (they stick for that payment): `?ui=classic` or `?ui=realistic` (also
`?stubyard_ui=`), `?stubyard_lang=en|ar`, `?stubyard_drawer=open|closed`. Entry URLs that redirect to the page
(MyFatoorah, Geidea) keep them.

**What does not change between the views:** return URLs, return parameters and webhooks. The classic
`POST …/page/<id>/complete` and the control API `POST payments/<id>/complete` keep working on every payment,
whatever the view, so existing tests that post to them are unaffected. Magic cards and rules (Z.3) work in both.

**Endpoints of the realistic page** (relative to `/pay/<project>/<instance>/page/<id>`):

- `POST x/pay`: the pay form and OTP step (same fields as the classic `/complete`).
- `GET x/acs`: the simulated bank (ACS) page; `POST x/3ds` with `outcome=3ds_success|3ds_fail|3ds_cancel`
  (`3ds_cancel` is the modal's ×: the challenge closes, the payment stays open, "Authentication cancelled").
- `POST x/select`, `x/bank`, `x/login`, `x/review`, `x/phone`, `x/otp`, `x/plan`, `x/card`, `x/terms`,
  `x/mpin`: the provider-specific steps (Z.23).
- `POST x/view` (`lang=en|ar`, 204): stores the page language. `POST x/notice`: the hidden-notice report.

Steps are kept in order on the server: a step answered twice, skipped, or answered before it was shown (for example
the PayPal review before the login, or the bank page twice) gets 409 (`[data-testid="stubyard-step-error"]`,
`data-reason="replay|skip"`). A retryable decline, a wrong OTP code and a form validation error answer 200 with the
message on the page (a `select` with an unknown method is still 400). After a decline the card form keeps what was
typed except the CVC. On the realistic OTP screens, three wrong codes decline the payment (`otp_failed`).

**Hidden notice:** if the page sees its notice hidden, cropped or moved off screen (for example a frame of your app
that is too small), it reports it once. The payment gets the lint finding `pay.test-notice-hidden` (warn) and the
event `test_notice_hidden`. The payment is never refused because of it.

**Fidelity:** `GET /api/payment-presets` lists `experiences` per preset: each integration mode with `status`
(`realistic`, `generic`, `sdk`, `planned`, `none`), its delivery phase, and two separate tags: `api` (requests,
responses and webhooks against the provider's docs) and `screens` (the page against the real screens). Each tag is
`verified`, `partial` or `assumed`. All API behaviour is `verified` (unchanged by the realistic pages). Screens are
`partial` for Stripe, Checkout.com, Tabby, Tamara, the Tap Card SDK, MyFatoorah `session.js` and the promo widgets,
and `assumed` (built from the documented steps, not compared with current screenshots) for the rest. Steps marked
"unverified" in the drawer follow the documented flow but were not compared with the live page. Only Tap goSell is
still `planned`.

**Browser automation tips:**

- Wait for the first screen's primary button: `stubyard-pay` everywhere, except the PayPal login (`stubyard-login`,
  then `stubyard-pay` on the review), the MyFatoorah method selection (`stubyard-method-<method>` buttons, then
  `stubyard-pay`) and the multi-step Tabby / Tamara / wallet flows (`stubyard-screen-<step>`, `stubyard-continue-step`).
- Magic cards still work: type the number, or pick a chip in the drawer.
- A 3-D Secure card opens `[data-testid="stubyard-3ds-modal"]` on Stripe and Geidea, whose frame holds
  `stubyard-3ds-pass` / `stubyard-3ds-fail`; the other gateways go to the full-page bank page (`stubyard-3ds-bank`).
- `pageTimings: "fast"` or `navigator.webdriver` removes the spinners; `pageDrawer: "open"` opens the drawer.

### Z.23 Realistic hosted pages per gateway

Each layout is marked on the page with `data-layout`. Return URLs, return parameters and webhooks are those of Z.1–Z.19.

| Gateway | Layout (`data-layout`) | Flow on the realistic page |
| --- | --- | --- |
| Stripe Checkout | `stripe-hosted` | Order summary with line items, email, card fields, cardholder, country, back arrow to `cancel_url`; a decline shows on the same page; 3-D Secure in a **modal** with the simulated bank in a frame. Embedded Checkout uses the same page in a frame (Z.25). |
| Checkout.com HPP / payment link | `checkout-hpp` | One page: method tabs (card, mada, Apple Pay), card fields, cardholder, Pay, "Back to store" (cancel_url). 3-D Secure is a **full-page redirect** to the ACS page, then success_url / failure_url with `cko-payment-id`. A `/3ds/<id>` payment (card already sent to `POST /payments`) opens the ACS page directly and returns with `cko-session-id`. |
| PayTabs HPP | `paytabs-hpp` | Cart, method tabs, card fields, Pay / Cancel; 3-D Secure full page; then a "Redirecting in 3…" page that POSTs the usual return fields (GET with `return_using_get`). `framed: true`: a compact page; `framed_return_top` / `framed_return_parent` submit the return into that window; with no return URL the result page sends `postMessage('hppDone', <origin of framed_message_target>)` to the parent (never `*`, never `document.referrer`; no target, no message). |
| Amazon Payment Services (redirection) | `aps-hosted` | Method list, cardholder, card fields, Pay / Cancel; KNET goes to the KNET bank page; 3-D Secure full page; the signed response fields are POSTed to return_url. |
| Tap hosted | `tap-hosted` | Method list (card, mada, KNET, BENEFIT, Apple Pay by source), card form with "Save card" (display only); KNET / BENEFIT go to the bank page; 3-D Secure full page; return `?tap_id=`. A single-method charge (`src_kw.knet`, `src_bh.benefit`) opens the bank page directly; a `tok_` charge opens the ACS page directly. |
| MyFatoorah | `myfatoorah-hosted` | **Method selection first** (the country's methods: KNET, VISA/MASTER, MADA, Benefit, Apple Pay, STC Pay), then that method's screen with "Change payment method"; KNET / Benefit go to the bank page; return `?paymentId=&Id=` (CallBackUrl, or ErrorUrl on failure / cancel). A single method skips the selection. |
| Moyasar invoice | `moyasar-invoice` | Invoice description as heading, invoice id, method tabs (mada, card, Apple Pay, STC Pay + OTP), Back (back_url); 3-D Secure full page. A payment created with `source.type=creditcard` opens the ACS page directly. |
| PayPal approval | `paypal-approval` | **Log in → review → approve.** Login: email (prefilled with the payer email) and a password that is never sent. Review: "Logged in as", "PayPal balance (simulated)", ship-to (hidden with `NO_SHIPPING`), "Not you?" (back to login), and "Pay Now" (`user_action: PAY_NOW`), "Continue" (otherwise) or "Agree & Subscribe" (subscriptions); "Cancel and return to <shop>". Pay Later (`funding=paylater`) shows "Pay in 4" / "Pay Monthly" offers (display only). A Decline outcome approves the order and fails at your capture call, as on the classic page. |
| Geidea | `geidea-hpp` | Card form, Pay / Cancel; 3-D Secure in a **modal** over the page (full screen on phones); return with `responseCode`, `orderId`, `signature`… |
| HyperPay COPYandPAY | `hyperpay-widget` | The widget iframe (`/widget/<id>`) is a compact form with the `data-brands` as text, card fields, Pay (submits the top window); 3-D Secure full page; return `?id=&resourcePath=`. |
| Tabby | `tabby-hpp` | Phone + email (prefilled from the buyer) → SMS code (4 digits; `8888` always works) → plan (4 payments; the first takes the remainder) → card → result. The documented reject phones (`+971500000002`, `+966500000002`, …) are rejected on the first screen with "We can't approve this purchase" (no SMS, status `failed`, failure URL); `otp.rejected@tabby.ai` is rejected after the code. "Back to store" asks for confirmation, then goes to the cancel URL. |
| Tamara | `tamara-hpp` | Phone → Send OTP → code (prefilled, as the Tamara sandbox does) → terms (checkbox required) → plan (2 / 3 / 4 / pay in full; the default from `instalments` or `payment_type`) → card ("Pay and Confirm Order") → result. Decline phones are declined after the code; the plan is recorded as a `tamara_plan` event. Cancel asks for confirmation like Tabby. |
| JazzCash | `jazzcash-hosted` | English only. Mobile Account: mobile number + the last 6 digits of the CNIC → MPIN (never posted or stored) → OTP (in the SMS inbox) → the signed `pp_*` POST back. Card: the card form with 3-D Secure. Voucher: the voucher number (`pp_RetreivalReferenceNo`) and expiry (`pp_SettlementExpiry`); the signed POST (response code 124) goes back when the buyer clicks Continue. |
| Easypaisa | `easypaisa-hosted` | English only. Mobile Account: number (prefilled from `mobileNum`) → OTP (in the SMS inbox) → redirect to `postBackURL`. OTC voucher: the payment token and its expiry, then the redirect with `paymentToken`. Card: the card form. |

**Simulated bank pages (KNET / BENEFIT)**, `[data-testid="stubyard-bank-page"]` with `data-bank="knet|benefit"`:
bank select (KNET: "Test bank 1/2/3"), card number, month / year, PIN (BENEFIT: also cardholder name), Submit
(`stubyard-pay`) and Cancel (`stubyard-bank-cancel`). The card number and PIN are never sent to stubyard. On
MyFatoorah pages the documented test cards decide: KNET `8888 8800 0000 0001` with 09/30 approves (another expiry
declines); BENEFIT `4600 4101 2345 6789` approves, `4550 1201 2345 6789` is an expired card, `4845 5501 2345 6789` /
`4575 5501 2345 6789` / `4895 5501 2345 6789` decline. Elsewhere Submit approves; use the Test controls for other
outcomes.

**Simulated ACS page (full-page 3-D Secure)**: `[data-testid="stubyard-3ds-bank"]`, a code input
(`stubyard-3ds-code`, any code works), Authenticate (`stubyard-3ds-pass`) / Fail (`stubyard-3ds-fail`). Checkout.com's
page mentions its sandbox password `Checkout1!` (unverified). Inside a modal or a framed page the ACS frame posts to
its parent, so a framed hosted page (Geidea popup or drop-in) stays in place.

**Gateway test cards on card forms:** besides the magic cards (Z.3), MyFatoorah accepts 5123 4500 0000 0008,
4508 7500 1574 1019, 4012 0000 3333 0026, 5111 1111 1111 1118 and the mada card 4464 0400 0000 0007; Geidea accepts
5123 4500 0000 0008, 4440 0000 4220 0014, 4464 0400 0000 0007 and 5111 1111 1111 1118. They work on the page and in
the server's card check without the real-card warning; the clicked button decides the outcome.

**Test ids of the multi-step flows** (Tabby, Tamara, wallets):

- Flow: `stubyard-screen-<step>`, `stubyard-step-no`, `stubyard-continue-step`, `stubyard-back-step`,
  `stubyard-change-number`, `stubyard-otp`, `stubyard-send-otp`, `stubyard-terms`, `stubyard-plan`,
  `stubyard-plan-<2|3|4|full>`, `stubyard-instalment`, `stubyard-pay`.
- Cancel: `stubyard-provider-cancel`, then `stubyard-cancel-confirm` / `stubyard-cancel-keep`.
- Tabby result: `stubyard-tabby-rejected`, `stubyard-tabby-cancelled`, `stubyard-provider-message`, `stubyard-return`.
- Wallets: `stubyard-phone`, `stubyard-cnic`, `stubyard-mpin`, `stubyard-otp-submit`, `stubyard-voucher`,
  `stubyard-voucher-expiry`, `stubyard-return-form`.

**Lint `pay.hpp-framed`** (warn): the Checkout.com HPP / payment link or the APS redirection page was loaded in an
iframe (`Sec-Fetch-Dest: iframe`). The real pages refuse to be framed and would stay blank; stubyard still shows
them. The APS Merchant Page (Z.26), which is meant for an iframe, is exempt.

### Z.24 Fake payment SDKs: shared rules, Moyasar Form, GeideaCheckout, PayPal JS SDK

stubyard serves fake versions of the providers' browser SDKs with their real global, object, method and callback
names. Load stubyard's script instead of the provider's (the Connect panel's `connect.env` has the URL) and keep the
app code. Rules shared by every SDK (also Z.25–Z.27):

- **UI:** each SDK draws its UI in a stubyard iframe (PayPal Buttons as neutral buttons in your container). The TEST
  notice is inside every component: the kit strip in the frame, a "TEST" tag inside single-input frames (PayPal Card
  Fields; the full notice as hidden text, linked with `aria-describedby`), or the SDK badge (`stubyard-sdk-badge`)
  added to the shop's container. English and Arabic (right to left) and phone widths are supported.
- **Card data:** card digits never reach the merchant page or stubyard's server. The frames compute and send card
  facts only (brand, last 4, BIN, expiry, magic id, Luhn / test flags). A Luhn-valid number that is not a test card
  is cleared in the frame and refused (`pay.real-card-entered`).
- **Origins:** messages between the page and the frames use `postMessage` with an exact target origin, never `*` and
  never `document.referrer`. A frame posts `{ source, ch, type, … }`; the page answers with `source + '-host'`; the
  channel `ch` must match and both sides check `event.origin` and `event.source`. Every frame is opened with the
  page's `location.origin`, which the server checks against the instance's **`sdkOrigins`** config (an array, or a
  comma / space separated string) and the project's **app origins**. Neither list set: the origin is allowed and the
  info lint `pay.sdk-origin-unlisted` is recorded. A list set but no match: the frame answers 403 with the error lint
  `pay.sdk-origin-refused`. CORS on the SDK's API calls reflects allowed origins only.
- **Scripts** are served as `application/javascript`, `no-store`, with CORP cross-origin. Your app's CSP must allow
  the stubyard origin in `script-src`, `frame-src` and `connect-src`.
- **Demo shops:** `{instance browser base}/demo` (`?lang=ar` for Arabic) is a plain shop page that runs the SDK end to
  end, for Stripe, PayPal, Moyasar, Geidea, HyperPay, Checkout.com, Tap, MyFatoorah, PayTabs and APS (linked as
  **Demo shop** on Payments → Checkout pages, `data-testid="checkout-demo-<slug>"`). `/demo/result` prints what the
  return page got; `stubyard-demo-log` prints every callback.
- **Wallet sheet** (`{base}/stubyard-sdk/wallet`, used for Apple Pay / Google Pay in Moyasar Form and MyFatoorah
  `session.js`): a neutral sheet titled "<wallet> (simulated)" with the TEST notice, the magic test cards (approve,
  decline, insufficient funds, …), Confirm (`stubyard-wallet-confirm`) and Cancel (`stubyard-wallet-cancel`). It posts
  `{ type: 'wallet', result: 'authorized' | 'cancelled', card: { brand, last4, magicId } }` to the page origin only.

| SDK | Load | API | Flow |
| --- | --- | --- | --- |
| Moyasar Form | `{base}/mpf/moyasar.js` (+ `/mpf/moyasar.css`), env `MOYASAR_FORM_JS` / `MOYASAR_FORM_CSS` | `Moyasar.init({ element, amount, currency, description, publishable_api_key, callback_url, methods: ['creditcard','stcpay','applepay'], supported_networks, language, metadata, given_id, apple_pay: { label }, on_initiating, on_completed, on_failure, on_redirect })` | The form frame (`/mpf/form`) has method tiles, the cardholder name and the card fields, and creates the payment itself (`POST /mpf/payments`, publishable key, card facts only). `on_initiating()` runs first (`false` stops; an object overrides amount / currency / description / metadata / callback_url / given_id; a promise is allowed). `on_completed(payment)` runs once the payment exists (a rejected promise stops). `on_failure(message)` runs when it cannot be created. `on_redirect(url)` takes over every redirect. **Card**: 3-D Secure as a full-page redirect to `source.transaction_url` (in the form's `language`), then `callback_url?id=&status=&message=`. **STC Pay**: mobile number, then the OTP inside the form (SMS in the stubyard inbox; `123456` / `000000` also work), then the callback. **Apple Pay**: the wallet sheet, then `source.type=applepay` (paid or failed at once by the chosen card), then the callback. |
| GeideaCheckout | `{base}/hpp/geideaCheckout.min.js` (env `GEIDEA_CHECKOUT_JS`) | `new GeideaCheckout(onSuccess, onError, onCancel).startPayment(sessionId)` opens a **popup** (overlay iframe); `startPayment(sessionId, null, 'container-id')` opens a **drop-in** iframe inside that element | Exactly one callback fires per `startPayment`, with `{ responseCode, responseMessage, detailedResponseCode, detailedResponseMessage, orderId, reference }`. `responseCode` `"000"` gives onSuccess; the buyer cancelling (Cancel, or the overlay's Close) gives onCancel; anything else gives onError: a decline, or an unknown, expired or used session (checked first with `GET /hpp/sdk/sessions/<id>`, lint `pay.geidea-sdk-session`, warn). The frame is the realistic Geidea page with the strip notice (3-D Secure in a modal, full screen on phones); instead of redirecting, its result screen posts the result to your page. Instance config `checkoutJsMode: "redirect"` keeps the old full-page redirect. |
| PayPal JS SDK | `{base}/sdk/js?client-id=…&components=buttons,card-fields,messages[&locale=ar_SA]` | `paypal.Buttons({ fundingSource?, style?, onInit, onClick, createOrder, onApprove, onCancel, onError }).render(el)`; `paypal.CardFields({ createOrder, onApprove, onError, inputEvents })` with `NumberField / ExpiryField / CVVField / NameField`, `getState`, `submit`; `paypal.FUNDING.PAYLATER`; `paypal.Messages` (Z.27) | Without `fundingSource` the buttons are PayPal, Pay Later and Debit or Credit Card (neutral look, no PayPal colours). The approval page (Z.23) opens in a popup (`buttonsMode: "inline"`: an overlay). The close page posts only to the page origin that `/checkoutnow` accepted; with no origin it posts nothing, and the SDK's state poll still sees the result. The Card Fields frames post only to the page origin given in `origin=`; each starts at 56 px and reports its height (`event: 'resize'`, 44–240 px), growing when an error shows. Z.9 has the server side. |

**Automation hooks:**

- Frames: `stubyard-moyasar-frame`, `stubyard-geidea-frame`, `stubyard-cf-frame-<type>`.
- Overlays: `stubyard-sdk-overlay` (close button `stubyard-sdk-close`) and `stubyard-paypal-overlay`.
- Buttons and notices: `stubyard-paypal-buttons`, `stubyard-paypal-button` (`-paylater`, `-card`), `stubyard-sdk-badge`.
- Moyasar form: `stubyard-moyasar-form`, `stubyard-cardholder`, `stubyard-pay`, `stubyard-applepay`, `stubyard-phone`,
  `stubyard-stc-pay`, `stubyard-otp`, `stubyard-otp-submit`, `stubyard-form-error`.

### Z.25 Stripe: PaymentIntents, Embedded Checkout and Stripe.js v3

**PaymentIntents API** (secret key, form-encoded, `Idempotency-Key` as usual; base `STRIPE_API_BASE`):

- `POST /v1/payment_intents`: amount (positive integer, minor units), currency, capture_method (`automatic`,
  `automatic_async` (default) or `manual`), payment_method_types or automatic_payment_methods, metadata, description,
  receipt_email, setup_future_usage, customer, shipping, payment_method, confirm, return_url, off_session.
- `GET /v1/payment_intents` (the instance's intents), `GET / POST /v1/payment_intents/:id` (retrieve / update while
  open), `POST …/confirm`, `POST …/capture` (amount_to_capture, manual only), `POST …/cancel` (cancellation_reason),
  `GET /v1/payment_methods/:id`.
- Statuses: `requires_payment_method` → (`requires_confirmation` when a payment_method was set) → `requires_action`
  (3-D Secure) → `succeeded` / `processing` (async outcomes only) / `requires_capture`; `canceled`. A decline answers
  402 `card_error` (with `payment_intent`); the intent goes back to `requires_payment_method` with
  `last_payment_error` and can be confirmed again.
- `next_action`: `use_stripe_sdk` (`three_d_secure_redirect` to the stubyard 3DS page) for Stripe.js confirms and for
  server confirms without return_url; `redirect_to_url` (`url` + `return_url`) for a server confirm with return_url.
  The redirect ends at `return_url?payment_intent=…&payment_intent_client_secret=…&redirect_status=succeeded|failed|pending`.
- Test PaymentMethods: `pm_card_visa`, `pm_card_visa_debit`, `pm_card_mastercard`, `pm_card_amex`,
  `pm_card_chargeDeclined` (and the `visa_` forms), `…InsufficientFunds`, `…ExpiredCard`, `…IncorrectCvc`,
  `…ProcessingError`, `pm_card_threeDSecure2Required`, `pm_card_threeDSecureRequired`,
  `pm_card_authenticationRequired`, the `tok_…` names of the same, plus any `pm_1…` / `tok_1…` created by Stripe.js.
  Forced outcomes (header, rules, test users) win over the card, as everywhere else.
- Raw card data (`payment_method_data[card][number]`, `card[cvc]`) is refused with Stripe's "Sending credit card
  numbers directly…" error and the lint `pay.stripe-raw-card-data` (warn).
- Lints on create: `pay.no-idempotency-key`, `pay.no-reference` (no metadata), `pay.amount-precision`,
  `pay.currency-unknown`, `pay.return-url-missing-or-bad`.
- Webhooks (signed like the other Stripe events): `payment_intent.created`, `.requires_action`, `.processing`,
  `.amount_capturable_updated`, `.succeeded`, `.payment_failed`, `.canceled`, and `charge.succeeded` /
  `charge.captured` / `charge.failed` / `charge.refunded`. One card payment: `payment_intent.created` →
  (`payment_intent.requires_action`) → `charge.succeeded` + `payment_intent.succeeded`. Manual capture:
  `charge.succeeded` + `payment_intent.amount_capturable_updated`, then `charge.captured` + `payment_intent.succeeded`.
- Publishable-key access for Stripe.js (`key=pk_test_…` in the query or form, no Authorization header, CORS for
  allowed origins only): `GET /v1/payment_intents/:id?client_secret=…` (without metadata) and
  `POST /v1/payment_intents/:id/confirm` (client_secret + payment_method). `sk_` and `pk_live_` keys get 401 (live key
  lint); under `strictKeys` the key must be the instance's own; a refused origin gets 403.
- In stubyard's own list a PaymentIntent is a payment of kind `checkout_session` with a `pi_` reference. A canceled
  open intent shows as `expired` (`cancelled` when it was `requires_capture`); the Stripe JSON says `canceled`.

**Embedded Checkout sessions:** `POST /v1/checkout/sessions` with `ui_mode=embedded_page` (or the older `embedded`).
It needs `return_url` unless `redirect_on_completion=never` (which refuses a return_url); `success_url` /
`cancel_url` are refused, as Stripe does; `redirect_on_completion` is `always` (default), `if_required` or `never`.
The session then has `client_secret` (`cs_…_secret_…`), `ui_mode`, `return_url`, `redirect_on_completion`,
`url: null`. Hosted sessions are unchanged.

**Fake Stripe.js v3:** `{instance}/js.stripe.com/v3/` (env `STRIPE_JS_URL`; also `/v3`, `/v3/stripe.js` and
`/js.stripe.com/<release>/stripe.js`, e.g. `basil`). Use `STRIPE_PUBLISHABLE_KEY` for `Stripe()`.

- `Stripe(pk[, {locale}])` (with or without `new`; a secret key throws), `_registerWrapper`, `registerAppInfo`.
- `stripe.elements({clientSecret} | {mode, amount, currency})` → `create('payment' | 'card' | 'address' |
  'linkAuthentication' | 'expressCheckout' | 'paymentRequestButton')`, `getElement`, `update`, `fetchUpdates`,
  `submit()`. Elements: `mount`, `unmount`, `destroy`, `on / off / once` (`ready`, `change`, `focus`, `blur`,
  `escape`), `update`, `focus`, `blur`, `clear`, `collapse`, `getValue` (address). Each element is a
  `.__PrivateStripeElement` wrapper with a stubyard iframe (`{base}/stripe-js/elements/<type>`). The Payment Element
  offers card only.
- `confirmPayment({elements, clientSecret?, confirmParams: {return_url, payment_method_data, receipt_email},
  redirect})`: an `IntegrationError` without return_url unless `redirect: 'if_required'`; deferred mode needs
  `elements.submit()` first (`elements_submit_required`). With a redirect it sends the window to
  `return_url?payment_intent&payment_intent_client_secret&redirect_status` and never resolves; otherwise it resolves
  `{paymentIntent}` or `{error}`.
- Also `confirmCardPayment(cs, {payment_method: {card, billing_details} | 'pm_…'}, {handleActions})`,
  `handleNextAction({clientSecret})`, `handleCardAction`, `retrievePaymentIntent(cs)`,
  `createPaymentMethod({elements} | {type:'card', card})`, `createToken(cardElement)`.
- 3-D Secure: `requires_action` with `use_stripe_sdk` opens `{base}/stripe-js/3ds/<pi>` in a modal (Complete / Fail
  authentication); closing the modal fails it. The intent is then retrieved and the result resolved.
- `initEmbeddedCheckout({fetchClientSecret | clientSecret, onComplete})` (alias `createEmbeddedCheckoutPage`) →
  `mount / unmount / destroy`, one at a time. The frame is the realistic Stripe hosted page; its entry checks that the
  session is embedded, the secret and the origin. When paid, `redirect_on_completion=always` sends the top window to
  return_url (`{CHECKOUT_SESSION_ID}` replaced); otherwise `onComplete` runs.
- The element frames send card facts only to `{base}/stripe-js/confirm`, `/payment_methods` and `/tokens`; a
  Luhn-valid non-test card is cleared and refused (`live_mode_test_card`). The TEST notice is the kit strip in the
  Payment / Address Element frames, the Embedded Checkout page and the 3DS page, and the SDK badge around the
  single-line Card and Link Authentication Elements. `locale: 'ar'` gives Arabic, right to left.
- Test cards in the element frames: `4242 4242 4242 4242` success, `4000 0000 0000 0002` decline,
  `4000 0000 0000 3220` 3-D Secure (and the magic cards of Z.3). Any future expiry and CVC.

**Loading it with `@stripe/stripe-js`:** `loadStripe()` injects `https://js.stripe.com/v3` unless `window.Stripe`
already exists, so add `<script src="STRIPE_JS_URL"></script>` before `loadStripe` runs; it then uses the fake.
The served script also works when `document.currentScript.src` is still `js.stripe.com` (it falls back to the
instance base the server embedded), for a future redirect rule.

**Demo shop:** `{instance}/demo?mode=payment|card|deferred|embedded` (`&lang=ar`): Payment Element + Link
Authentication with `confirmPayment`; Card Element with `confirmCardPayment`; a deferred intent (`elements.submit()`,
then `POST /demo/intent`); Embedded Checkout. `/demo/result` prints the query and the status read back with the
secret key.

**Test ids:** `stubyard-stripe-element` (wrapper, `data-type`), `stubyard-stripe-frame`,
`stubyard-stripe-element-frame`, `stubyard-card` / `stubyard-card-expiry` / `stubyard-card-cvc` /
`stubyard-card-error`, `stubyard-stripe-country`, `stubyard-stripe-name` / `-line1` / `-line2` / `-city` /
`-postal`, `stubyard-stripe-email`, `stubyard-stripe-placeholder`, `stubyard-stripe-3ds-frame`, `stubyard-stripe-3ds`,
`stubyard-3ds-complete`, `stubyard-3ds-fail`, `stubyard-3ds-done`, `stubyard-stripe-embedded-checkout`,
`stubyard-stripe-checkout-frame`; demo: `stubyard-demo-pay`, `stubyard-demo-mode-<mode>`, `stubyard-demo-log`,
`stubyard-demo-result`, `stubyard-demo-status`.

### Z.26 Embedded SDKs: Checkout.com Flow, Tap Card SDK, MyFatoorah session.js, PayTabs paylib, APS Merchant Page

Shared rules as in Z.24 (TEST notice inside the component, card facts only, exact origins, `sdkOrigins`, demo shop at
`{instance}/demo`). Sessions and tokens of these SDKs live in memory (Flow 60 min, MyFatoorah 60 min, paylib 30 min,
APS session 30 min / token 24 h) and are lost when stubyard restarts.

**Checkout.com Flow** (`checkout-web-components`):

- Script: `{instance}/checkout-web-components/index.js` (any version prefix and `.min.js` work). Env
  `CKO_WEB_COMPONENTS_URL`.
- Server: `POST /payment-sessions` (Bearer sk) → `{id: ps_…, payment_session_secret: pss_…, payment_session_token,
  _links}`. It requires amount, success_url, failure_url and billing.address.country, and adds `pay.no-reference`
  without a reference. `POST /payment-sessions/:id/submit` is also available.
- Browser: `await CheckoutWebComponents({publicKey, environment, paymentSession, locale, appearance,
  componentOptions, onReady, onChange, onError, onPaymentCompleted, handleSubmit})` → `.create('flow' | 'card')`;
  components have mount, unmount, isValid, isAvailable, submit, tokenize, update.
- Outcomes: a 3-D Secure card answers `Action Required` and redirects the page to the ACS page, then success_url with
  `cko-payment-session-id` and `cko-payment-id`; a card without 3-D Secure is `Approved` and calls
  `onPaymentCompleted`; a decline calls `onError` with a CheckoutError (name, type, code, message, details). The
  payment carries `metadata.cko_payment_session_id`; an approved session refuses another submit (422
  `payment_session_completed`).

**Tap Card SDK v2** (`window.CardSDK`):

- Script: `{instance}/card-sdk/index.js`. Env `TAP_CARD_SDK_URL`.
- `renderTapCard(id, config)` → `{unmount}`. Callbacks: onReady, onFocus, onBinIdentification, onValidInput,
  onInvalidInput, onError, onSuccess(`tok_…`), onChangeSaveCardLater. Functions: tokenize, saveCard,
  resetCardInputs, updateTheme, updateCardConfiguration, loadSavedCard. Constants: Theme, Currencies, Direction,
  Edges, Locale.
- The `tok_` goes into `POST /v2/charges` `source.id`; the charge answers `transaction.url` (3-D Secure), then
  `redirect.url?tap_id=`. Test cards with a past expiry are accepted (the expiry picks the outcome, as for Tap API
  cards).

**MyFatoorah embedded payment** (`session.js`):

1. `POST /v2/InitiateSession` → `{SessionId, CountryCode, CustomerTokens: []}`.
2. Script `{instance}/payment/v1/session.js` (env `MF_SESSION_JS_URL`): `myfatoorah.init({sessionId, countryCode,
   currencyCode, amount, containerId, paymentOptions: ['Card','ApplePay','GooglePay','STCPay'], callback})`.
3. `callback({isSuccess, sessionId, paymentType, cardBrand})`. `myfatoorah.submit()` (a Pay button outside the frame)
   is a stubyard extra.
4. `POST /v2/ExecutePayment {SessionId, InvoiceValue, CallBackUrl, ErrorUrl}` → `PaymentURL`. A SessionId works for
   one ExecutePayment only.

- Card: `PaymentURL` is the 3-D Secure page. In an iframe its return posts
  `JSON.stringify({sender:'MF-3DSecure', url})` to the session's page origin only; at top level it navigates.
- Apple Pay / Google Pay: paid at ExecutePayment; `PaymentURL` is the CallBackUrl. STC Pay: the usual OTP page.
- The frame accepts MyFatoorah's test cards (Z.23).

**PayTabs managed form** (`paylib.js`):

- Script: `{instance}/payment/js/paylib.js`. Env `PAYTABS_PAYLIB_URL`, `PAYTABS_CLIENT_KEY` (new config field
  `clientKey`; new instances get `CK…-…-…`).
- `paylib.inlineForm({key, form, autoSubmit, callback})` works on inputs with `data-paylib="number|expmonth|expyear|cvv"`.
  It warns when one of them has a `name`, adds a hidden `payment_token` field and submits the form.
  `paylib.handleError(el, response)` shows errors.
- `POST /payment/request` accepts `payment_token` (single use, 30 minutes): a 3-D Secure card answers `redirect_url`,
  then the ACS page, then the signed return; otherwise the result comes at once (`payment_result`, `payment_info`).

**APS Merchant Page** (iframe):

- The shop posts a signed form into an iframe: `POST /FortAPI/paymentPage` with `service_command=TOKENIZATION`
  (access_code, merchant_identifier, merchant_reference, language, return_url, optional token_name).
- The iframe shows the stubyard card form. On submit, the signed response is posted to return_url inside the iframe:
  response_code 18000, status 18, token_name, card_number masked (`400000******3155`), expiry_date, card_bin,
  card_holder_name.
- `POST /FortAPI/paymentApi` with command PURCHASE / AUTHORIZATION + token_name answers `3ds_url` (status 20,
  response_code 20064) → the ACS page → the signed POST to return_url (14000 / 13xxx). With `check_3ds: 'NO'` it pays
  at once. An unknown token answers `…024` "Invalid token name".

### Z.27 Promo widgets (Tabby, Tamara, PayPal Pay Later messages)

Fake scripts with a TEST label inside each widget; served with `application/javascript`, `no-store`, CORP
cross-origin and ACAO `*`. Their "Learn more" popups are kit pages with the TEST strip and a strict CSP.

- **Tabby:** `<instance>/tabby-promo.js` and `/tabby-card.js` (`.min.js` and a path prefix work too; env
  `TABBY_PROMO_JS`, `TABBY_CARD_JS`) define `new TabbyPromo({selector, currency, price, lang, source, publicKey,
  merchantCode, shouldInheritBg})` and `new TabbyCard({...})`. Text like "4 interest-free payments of AED 500.00. No
  fees. Learn more"; honours `--snippetTextColor` / `--snippetLinkTextColor`; console warnings for a wrong key,
  currency or price. Learn more opens `/promos/learn-more`; the static snippet
  `/promos/product-page/installments/{en|ar}/` is served too.
- **Tamara:** `<instance>/widget-v2/tamara-widget.js` (env `TAMARA_WIDGET_JS`) defines the
  `<tamara-widget type amount inline-type config lang>` custom element. It reads `window.tamaraWidgetConfig` (`lang`,
  `country`, `publicKey`) and re-renders when an attribute changes; `window.TamaraWidgetV2.refresh()` re-renders all
  widgets. Also served: the iframe variant `/widget-v2/tamara-widget.html` and the popup `/widget-v2/popup`.
- **PayPal:** `sdk/js?components=…,messages` adds `paypal.Messages({amount, currency, placement, style, onRender,
  onClick}).render(selector)` and auto-renders `[data-pp-message]` elements. Learn more opens
  `/sdk/messages/learn-more`.
- Test ids: `stubyard-tabby-promo`, `stubyard-tabby-card`, `stubyard-tabby-card-plan`, `stubyard-tamara-widget`,
  `stubyard-tamara-badge`, `stubyard-pp-message`, `stubyard-promo-text`, `stubyard-promo-more`, `stubyard-sdk-badge`,
  `stubyard-promo-info`.

### Z.28 Realistic pages and SDKs: not simulated, not verified

Not simulated:

- Stripe: SetupIntents (`confirmSetup`, `confirmCardSetup`, `retrieveSetupIntent` resolve `{error: {code:
  'stubyard_not_simulated'}}`) and saved-card reuse; the split `cardNumber` / `cardExpiry` / `cardCvc` Elements (an
  IntegrationError naming `card` / `payment`); wallets, Link and bank methods in the Payment Element; the Express
  Checkout Element and Payment Request Button (placeholders: badge, "not simulated" note, `ready` fires;
  `paymentRequest().canMakePayment()` resolves `null`); `stripe.initCheckout` (`ui_mode: custom`). Element
  `appearance`, layout and fonts are ignored.
- Checkout.com: wallets / APMs inside Flow (`isAvailable() === false`), `translations`, Checkout Frames.
- Tap: goSell (`planned`); `loadSavedCard` calls onError `not_simulated`.
- MyFatoorah: `shouldHandlePaymentUrl`, API v3 encrypted paymentData, saved cards.
- APS: Merchant Page 2.0 and saved-token reuse rules.
- Tabby / Tamara: Apple Pay / Google Pay on the card screens; Tabby offers Pay in 4 only. The PayPal Pay Later offer
  choice is shown but not stored; the PayPal guest card ("Pay with Debit or Credit Card") is not offered on the login
  page. Promo popups are static info pages (no merchant logo).
- Easypaisa has no MPIN step (the real flow approves in the app); JazzCash and Easypaisa have no magic OTP (the code
  is in the SMS inbox) and ignore `?stubyard_lang=ar`.

stubyard's choices (not verified against the live providers):

- Screens tagged `assumed` (Z.22) were built from the documented steps, not compared with current screenshots. The
  Arabic wording of the provider screens has not been reviewed by a native speaker.
- Flow submit statuses and CheckoutError fields where the docs are unclear; the Tap `onBinIdentification` /
  `onValidInput` payloads (from the docs' examples); `TamaraWidgetV2.refresh()`; the Tamara "/mo" figure (divided by
  12 months).
- The fake `paylib.js` computes the card facts on the page and sends only those; the real one sends the card number
  to PayTabs (SAQ A-EP).
- The Stripe 3DS page has two buttons (Complete / Fail authentication), like Stripe's test page; the publishable-key
  intent omits `metadata`; a Stripe.js confirm with return_url still gets `use_stripe_sdk`.
- The JazzCash MPIN is entered but never posted.
- Closing the Geidea overlay on the OTP screen ends the SDK with onCancel after 4 s; the payment stays open until it
  expires.

---

## AA. LLM API mocks (fake OpenAI and Anthropic APIs)

Every project has a fake OpenAI API and a fake Anthropic API. Point your app's SDK base URL at them, then script the
replies, the tool calls and the failures. You can also record real answers once and replay them offline. stubyard
never calls a real model unless a recording is on, and it never stores the API key your app sends.

| Provider | Base URL | Endpoints |
|---|---|---|
| OpenAI | `/llm/<project>/openai/v1` | `POST chat/completions`, `POST responses`, `POST embeddings`, `GET models`, `GET models/<id>` |
| Anthropic | `/llm/<project>/anthropic` (the SDK adds `/v1`) | `POST v1/messages`, `POST v1/messages/count_tokens`, `GET v1/models`, `GET v1/models/<id>` |

Both stream and non-stream modes work. The stream formats are:
- Chat Completions: `chat.completion.chunk` frames, then `data: [DONE]`. With `stream_options.include_usage`, a
  last chunk carries the usage and has empty `choices`.
- Responses: typed events with a `sequence_number`. There is no `[DONE]`.
- Messages: `message_start`, `content_block_*`, `ping`, `message_delta`, then `message_stop`.

Out of scope:
- Google Gemini
- the Assistants and Realtime APIs, audio, images, files and batches
- `previous_response_id` state: a request that sends one gets a 400 `previous_response_not_found`.

### AA.1 Connect your app

Dashboard: **LLM mocks → Connect**, or **Providers → LLM APIs**. API: `GET /api/projects/<p>/llm/connect` returns
the base URLs, a `.env` block and snippets for the OpenAI SDK, the Anthropic SDK, Python, the Vercel AI SDK and curl.

```bash
OPENAI_BASE_URL=http://localhost:4000/llm/bot/openai/v1
OPENAI_API_KEY=sk-test-stubyard          # any value; never stored, redacted in the traffic log
ANTHROPIC_BASE_URL=http://localhost:4000/llm/bot/anthropic
ANTHROPIC_API_KEY=sk-ant-test-stubyard
```

- An app running in Docker uses `host.docker.internal:4000`.
- The Vercel AI SDK's `createAnthropic` needs the `/v1` suffix: `baseURL: …/llm/bot/anthropic/v1`.
- Test runs work like the other mocks:
  - send `X-Hub-Run: <run>`, or use the prefix `/run/<run>/llm/<project>/…`;
  - mocks and faults created with `?run=<run>` apply only to that run;
  - they are deleted when the run stops.
- Validation follows the real APIs:
  - a missing `model` or `messages` / `input`, or a body that is not JSON, gets a provider-shaped 400;
  - an Anthropic request without `max_tokens` gets a 400;
  - a missing `anthropic-version` header only adds a warning to the traffic row.
- CORS is open on `/llm/`, so browser code can call the mocks too.

### AA.2 Script replies

A mock has a **match** and one or more **responses**. Mocks are checked in order, and the first enabled one that
matches answers. Run-scoped mocks come before project mocks.

```bash
curl -X POST localhost:4000/api/projects/bot/llm/mocks -H 'content-type: application/json' -d '{
  "name": "greeting",
  "match": { "lastUser": { "contains": "hello" } },
  "responses": [{ "text": "Hi! How can I help?" }]
}'
```

Match fields. All of them are optional, and every field given must match:

| Field | Matches |
|---|---|
| `endpoint` | `chat`, `responses`, `messages` |
| `model` | glob, e.g. `gpt-5*` |
| `lastUser` | `{contains}`, `{equals}` or `{regex: "/refund/i"}` on the last user message |
| `system` | `{contains}` on the system prompt / instructions |
| `hasTool` | the request offers this tool |
| `toolResult` | `{name?, contains?}`: the conversation ends with a result of this tool |
| `turn` | number of assistant turns so far (0 = first answer) |
| `stream` | `true` / `false` |

Mock fields:
- `provider`: `openai`, `anthropic` or `any` (the default).
- A response has:
  - `text`;
  - `toolCalls` (`[{name, arguments}]`);
  - `stopReason`: `stop`, `tool_calls`, `length` or `stop_sequence`. Each is mapped to the provider's own value
    (`end_turn`, `tool_use`, `max_tokens`…);
  - `usage` (`{input, output}`; the default estimate is characters / 4);
  - `chunk` (`{size, delayMs}` for streams).
- Shorthands: `"text": "…"` or `"toolCalls": […]` on the mock itself.
- With several responses, `mode` picks one: `first`, `sequence` (the last one repeats) or `cycle`.
- `times: n`: the mock answers n calls, then stops matching (the response shows it as `remaining`).
- `enabled` switches the mock off and on. `POST …/mocks/reorder {ids}` changes the order.
- `{{lastUser}}`, `{{model}}` and the API mock template helpers work inside `text`.
- The same mock answers in all three wire formats. Tool calls get fresh ids (`call_…`, `fc_…`, `toolu_…`).

A tool loop takes two mocks:

```json
{ "name": "call tool", "match": { "hasTool": "get_weather", "turn": 0 },
  "responses": [{ "toolCalls": [{ "name": "get_weather", "arguments": { "city": "Paris" } }] }] }
{ "name": "answer", "match": { "toolResult": { "name": "get_weather" } },
  "responses": [{ "text": "It is 18 °C and sunny in Paris." }] }
```

When no mock matches, `settings.fallback` decides what happens:
- `error` (the default): a provider-shaped 404 with code `stubyard_no_mock`. `error.stubyard.mocks` lists why
  each mock missed.
- `echo`: answers "Echo: <last user message>".
- `text`: answers `fallbackText`.

`PATCH …/llm/settings` sets `fallback`, `fallbackText`, `defaultChunk {size, delayMs}` and `models` (extra ids
for the models list).

Embeddings need no mock. Each input gets a deterministic unit vector (1536 dimensions, or the `dimensions` you
ask for). `encoding_format: "base64"` returns little-endian float32, which is what openai-node asks for by default.
`count_tokens` returns the characters / 4 estimate.

### AA.3 Faults

| Fault | Effect |
|---|---|
| `rate_limit[:secs]` | 429 with `retry-after` (OpenAI: also `retry-after-ms` and `x-ratelimit-*`; Anthropic: `anthropic-ratelimit-*`) |
| `error[:status]` | provider error with that status (default 500) |
| `overloaded` | Anthropic 529 `overloaded_error`; OpenAI 503 `server_is_overloaded` |
| `auth` | 401 (OpenAI `invalid_api_key`, Anthropic `authentication_error`) |
| `context_length` | 400 context too long |
| `timeout` / `drop` | never answer / close the connection |
| `slow:ms` | wait, then answer normally |
| `malformed` | broken JSON in the body or in one SSE frame |
| `cut[:n]` | close the stream after n frames, with no terminator |
| `stream_error[:n]` | after n frames, send the provider's in-stream error event |

There are three ways to inject a fault:
- One request: send the header `X-Hub-Scenario: rate_limit:2`.
- The next calls: `POST …/llm/faults {"fault":"overloaded","times":2,"provider":"anthropic"}`. It adds a fault rule
  that is checked before every mock. `DELETE …/llm/faults` clears all fault rules.
- On a mock: its `fault` field (for example `slow:800`, or `cut:4` to break that mock's stream).

### AA.4 Calls

Every request is logged. List the calls with `GET …/llm/calls`, filtered by `provider`, `mode`
(`mock|unmatched|fault|fallback|record`), `mock`, `after`, `run` and `limit`. Each call has:
- the model, the last user message, the turn, the reply text and the tool calls;
- the tokens, the status, the duration and the mock that answered;
- the traffic log id.

`GET …/llm/calls/<id>` adds the normalized request and the response. To wait for a call in a test:

```bash
curl -X POST localhost:4000/api/projects/bot/llm/calls/wait -H 'content-type: application/json' \
  -d '{"contains":"refund","provider":"anthropic","timeoutMs":10000}'
# → {"timedOut":false,"call":{…}}
```

In the dashboard, **LLM mocks → Calls** shows the calls live. **Mock this** turns a call into a mock.

### AA.5 Record real answers, replay offline

1. Add a real provider under **System → AI providers**: OpenAI, Anthropic, OpenRouter or any OpenAI-compatible
   URL. Google is not supported.
2. Start a recording:

   ```bash
   curl -X POST localhost:4000/api/projects/bot/llm/recordings -d '{"provider":"my-openai","mode":"new"}' \
     -H 'content-type: application/json'
   ```

   - `mode: "new"` forwards only the calls no mock answers. `mode: "all"` forwards every call and re-records it.
   - Each provider kind (openai / anthropic) can have one active recording; a second one gets a 409.
   - A recording stops by itself after `maxCalls` forwarded requests (default 200, max 10000) or `ttlMinutes`
     (default 60, max 1440), whichever comes first. Set them in the start body. The recording view shows
     `forwarded`, `callsLeft`, `expiresAt` and `stopReason` (`manual`, `max-calls`, `expired`, `run-stopped`).
   - While a recording is on, browser requests from other web pages (a foreign `Origin`, `Origin: null` or
     `Sec-Fetch-Site: cross-site`) are refused with 403 and never forwarded. Forwarded replies carry no CORS headers.
     Call the LLM API from your server (or from a stubyard page) while recording; mocked replies keep their CORS.
3. Forwarding works like this:
   - stubyard drops your app's key and uses the stored one;
   - it streams the reply back unchanged;
   - each successful answer is saved as a `recorded` mock. The match is the endpoint, the model, the turn and the
     exact last user message, plus a hash of the conversation;
   - errors are passed through but not saved;
   - redirects and other hosts are blocked (502), and so is a provider that was disabled or changed kind after the
     recording started;
   - LLM and payment requests have their credential headers (`authorization`, `x-api-key`, `api-key`, `cookie`, …)
     redacted in the traffic log, also under a `/run/<key>/` prefix. Other traffic keeps its headers for replay.
4. Stop the recording with `POST …/recordings/stop` (or `…/recordings/<id>/stop`). The same requests are then
   answered offline:
   - byte for byte when the provider, the endpoint and the stream mode are the same;
   - otherwise rebuilt from the saved answer, for example a Responses request replaying a Chat Completions
     recording, or a stream replaying a non-stream recording.

Notes:
- Embeddings and `count_tokens` are never recorded.
- Recorded mocks belong to the project, even when the recording had a `run`; the run only limits which traffic is
  recorded.
- `DELETE …/llm/mocks?source=recorded` removes all recorded mocks.
- Keys never appear in mocks, calls, traffic rows or error messages.

### AA.6 MCP tools, reset, export

MCP tools:
- `list_llm_mocks`, `set_llm_mock`, `delete_llm_mock`
- `set_llm_fault` (`fault: "none"` clears the faults)
- `list_llm_calls`, `wait_for_llm_call`
- `reset_llm_mocks` (`keep_recorded`)
- `start_llm_recording`, `stop_llm_recording`

Project reset clears the calls and the recordings and sets the hit counters back to 0; mocks stay. A project export
carries the project-level mocks (also the recorded ones) and the settings.

---

## AB. Scripted auto-replies

A rule makes a fake test user answer by themselves. When your app sends that user an email, SMS or WhatsApp message
that matches, the user replies through the provider's inbound webhook, the same way **reply as user** does
(`POST /api/projects/<p>/users/<user>/reply`, MCP `reply_as_user`). Use it for flows that wait for an answer:
- echo the login code back;
- reply STOP or YES;
- tap the first button of a WhatsApp message;
- send an out-of-office email in the thread.

No AI is involved: replies are templates.

```bash
curl -X POST localhost:4000/api/projects/shop/auto-replies -H 'content-type: application/json' -d '{
  "name": "Echo the login code",
  "channel": "sms",
  "match": { "hasOtp": true },
  "reply": { "text": "{{otp}}" }
}'
```

Your app sends "Your code is 482913" to a test user. stubyard answers the send request as usual, then the user's
reply "482913" goes to the instance's `inboundUrl` (for Meta WhatsApp, its `statusCallbackUrl`). The reply
is stored in the user's timeline with `metadata.autoReply {ruleId, ruleName, triggerMessageId, fireId}`.

### AB.1 Rules and matching

- Only outbound messages that reached a test user trigger rules, which means status `delivered`. A message moving to
  `delivered` later (a scheduled email, a delayed SMS) triggers when it gets there. These never trigger:
  - `failed`, `dropped`, `bounced`, `rejected`, `scheduled` and `complained` messages;
  - messages to addresses that are no test user (Unassigned);
  - inbound messages, including the auto-replies themselves.
- Rule order:
  1. rules of the message's test run, by position;
  2. project rules (no run), by position.
- A run rule only sees the messages of its run. Project rules see every message.
- `stop: true` (the default) ends the check after the first rule that matches. With `stop: false`, later rules are
  checked too, so one message can get several replies.
- Each rule fires at most once per message. The same message arriving as "created" and then "updated" is not answered
  twice.

Rule fields:

| Field | Meaning |
|---|---|
| `name` | label |
| `channel` | `email`, `sms`, `whatsapp` or `any` (default) |
| `match` | conditions, all must hold (`{}` matches every delivered message) |
| `reply` | what the user sends back (AB.2) |
| `delayMs` / `delaySeconds` | wait before replying (default 0, at most 7 days) |
| `jitterMs` / `jitterSeconds` | random extra wait 0…n (at most 1 day) |
| `maxUses` | stop after n replies (`null` = unlimited) |
| `stop` | see above (default `true`) |
| `enabled` | on / off |

Match fields:

| Field | Matches |
|---|---|
| `body` | the message text (email: the text part, else the HTML as text) |
| `subject` | email subject |
| `from` | the app's sender address / number |
| `to` | the user's address / number |
| `user` | test user id, email, phone or name |
| `role` | test user role, e.g. `customer` |
| `instance` | provider instance slug the app sent through |
| `hasOtp` / `hasLink` | `true` / `false`: stubyard found a code / a link in the message |

`body`, `subject`, `from` and `to` take one of these:
- `{contains}`: case-insensitive. A bare string means the same thing.
- `{equals}`: case-insensitive, ignores surrounding spaces.
- `{regex}`: `"/pattern/flags"`, or a plain pattern, which is case-insensitive. Patterns are limited to 500
  characters and are matched against the first 8 KB of the text. An invalid regex is a 400 when you save the rule
  (and in `/test` with an inline rule).
- To keep a crafted message from freezing stubyard, patterns that can backtrack without end are refused with a 400:
  backreferences (`\1`, `\k<name>`), nested quantifiers (`(a+)+`, `(\w*)*`, `(.*x){9}`, `(\d+\.){3}`), a
  repeated group whose length varies (`(a?)+`), alternation in a repeated group (`(a|ab)+`; use a class such as
  `[ab]+`), and more than 4 unbounded quantifiers (`*`, `+`, `{n,}`). A match that still runs longer than 100 ms
  is stopped and counts as no match (the reason says so).

### AB.2 Reply templates

`reply` fields:
- `text`: required, unless `button` is set.
- `subject` and `html`: email only.
- `channel`: default is the channel of the message. A different channel is allowed, e.g. answer an email by SMS.
- `instance`: default is the instance the app used, else the channel's default instance.
- `button`: WhatsApp only. The id or title of a button or list row of the message, or `#1`, `#2`… by position. The
  reply refers to that message (context).
- `thread`: email only, default `true`. The reply carries `In-Reply-To` / `References` of the message, and the
  subject defaults to `Re: <subject>`. With `false`, the reply goes to the sender as a new email.

Variables in `text`, `subject`, `html` and `button`:

| Variable | Value |
|---|---|
| `{{otp}}` | the code in the message (as detected; the project OTP regex applies) |
| `{{link}}`, `{{links.0}}`, `{{links.1}}`… | links in the message, 0 = first |
| `{{subject}}`, `{{body}}`, `{{from}}`, `{{to}}`, `{{channel}}` | fields of the message |
| `{{user.name}}`, `{{user.email}}`, `{{user.phone}}`, `{{user.role}}` | the test user |
| `{{body.1}}` (also `{{$1}}`), `{{body.<name>}}` | groups of the `match.body` regex (named groups too) |
| `{{subject.1}}`, `{{subject.<name>}}` | groups of the `match.subject` regex |
| `{{now}}` | send time, ISO 8601 |
| `{{uuid}}` | a random UUID |
| `{{random.digits:6}}` | n random digits |

Notes:
- Values put into `html` are HTML-escaped.
- An unknown variable renders empty and adds a warning to the fire (`plan.warnings`). The rule's `warnings` show
  such problems as soon as you save it, e.g. `{{body.1}}` without a body regex.
- Regex groups are captured when the message arrives. The template is rendered when the reply is sent, so `{{now}}`
  is the send time.

```json
{ "name": "Order confirmation", "channel": "email",
  "match": { "subject": "order", "body": { "regex": "/order #(?<num>\\d+)/i" } },
  "reply": { "text": "Thanks, I got order {{body.num}}." } }
```

### AB.3 Delays, limits, runs

- Every reply goes through a durable job, `autoreply.fire` in `/jobs`, even with no delay. So your app gets the
  provider's HTTP answer before the inbound webhook. Delays use real time; clock offsets do not apply.
- A match creates a **fire**. Its status:
  - `pending` (waiting for its delay), then
  - `sent`, `failed` (stubyard could not send the reply, e.g. no provider instance or an unknown button),
    `cancelled` or `skipped` (the rule was disabled or deleted, the test user or the message is gone, or the run
    stopped before the reply was due).
- `sent` only means the reply was sent. `webhookOk` / `webhookStatus` say whether your app accepted the inbound
  webhook. Without an inbound URL on the instance, the reply is stored and the fire has a warning.
- `maxUses`: when it is reached, the rule stays but stops matching. It shows as "used up". `PATCH {uses: 0}` or a
  higher `maxUses` re-arms it.
- Loop guard: your app might answer every reply, and the rule answers again, and so on. More than 20 fires of one
  rule for one user within 60 s switch the rule off with `disabledReason: "loop"`; more than 200 within an hour
  (a slow loop) with `disabledReason: "loop-hourly"`. The dashboard and `list_auto_replies` show a warning.
  `PATCH {enabled: true}` switches it back on.
- Pending fires survive a restart. A pending fire whose job is missing after a restart is marked `failed` with error
  `lost`. A fire that was being sent when stubyard stopped is marked `failed` (`interrupted`) at the next start.
- Test runs:
  - rules created with `?run=<run>` or `X-Hub-Run` belong to that run;
  - stopping the run cancels its pending fires, and purging the run deletes its fires;
  - run rules go when the run is deleted.
- Project reset: pending fires are cancelled, fires are deleted, `uses` goes back to 0 and rules the loop guard
  switched off are enabled again. Rules stay; rules you switched off stay off.
- Export / import: project rules only, in the `autoReplies` section. Run rules and fires are not exported.

### AB.4 API (`/api/projects/<p>/auto-replies`)

| Call | |
|---|---|
| `GET` | rules, each with `uses`, `usedUp`, `pendingFires`, `lastFire`, `summary`, `warnings` (`?run=`: that run's rules) |
| `POST` | create (`?run=` or `X-Hub-Run`, or `"run"` in the body: a run rule) |
| `GET` / `PATCH` / `PUT` / `DELETE /<id>` | one rule |
| `POST /reorder {ids}` | new order (`?run=` for a run's rules) |
| `DELETE` | every project rule (`?run=`: every rule of that run) |
| `POST /test {rule, message}` | dry run (below) |
| `GET /fires` | `?rule=&status=&user=&run=&after=&limit=`, newest first (`after`: oldest first) |
| `GET /fires/<id>` | one fire: `plan.captures`, `plan.rendered`, `plan.warnings`, trigger and reply message |
| `DELETE /fires/<id>` | cancel a pending fire (409 when it is not pending) |
| `POST /fires/wait` | `{rule?, user?, status? (default "sent,failed"), after?, run?, timeoutMs ≤ 60000}` → `{timedOut, fire, cursor}` |
| `POST /flush {run?}` | send every pending fire now, in due order → `{fired: [...]}` |
| `GET /api/auto-reply-presets` | presets, template variables, trigger statuses, loop-guard limits |

`POST /test` takes a rule id or an inline rule `{channel, match, reply}`, and a message id or an inline
message `{channel, to, from, subject, body}`. It returns:
- `matched`;
- `reasons`: why it did not match;
- `notes`: e.g. "the rule is used up", "the message is failed";
- `captures`, `plan` (the rendered reply) and `warnings`.

Nothing is stored or sent.

In a test, use `/flush` instead of sleeping through a delay. Use `/fires/wait` to wait for the reply:

```bash
CURSOR=$(curl -s 'localhost:4000/api/projects/shop/auto-replies/fires?limit=1' | jq -r '.[0].id // ""')
# … the app sends the code …
curl -s -X POST localhost:4000/api/projects/shop/auto-replies/fires/wait -H 'content-type: application/json' \
  -d "{\"after\": \"$CURSOR\", \"timeoutMs\": 10000}"
```

### AB.5 MCP tools and dashboard

MCP tools:
- Read-only:
  - `list_auto_replies`;
  - `list_auto_reply_fires`;
  - `test_auto_reply` (dry run);
  - `wait_for_auto_reply {project, rule?, user?, after?, timeout_seconds?}`.
- Changing:
  - `set_auto_reply {project, id?, name, channel?, match, reply, delay_seconds?, jitter_seconds?, max_uses?, stop?, enabled?, run?}`;
  - `delete_auto_reply {project, id | all}`;
  - `flush_auto_replies`.

Which tool to use:
- one manual reply right now: `reply_as_user`;
- a call at a fixed time: `schedule_action`;
- a standing answer to whatever the app sends: an auto-reply.

Dashboard: **Auto-replies** (Automate group).
- **Rules**:
  - ordered cards that read "when … → reply …", with the delay, uses n/max, a run chip, an on/off switch and
    a loop warning;
  - drag, or ↑ / ↓, to reorder;
  - **Start from…** offers the presets: Reply with the code, Reply STOP, Confirm YES, Out of office, Tap first button.
- **The editor** has:
  - the channel and the match fields, with regex help;
  - the reply template with a variable picker;
  - delay, random extra, max uses and stop;
  - a **Try it** panel that runs the dry run against one of the last 20 outbound messages and shows the captures
    and the rendered reply.
- **Activity**:
  - fires with their status, and links to the trigger and to the reply in the user's timeline;
  - **Cancel** on pending fires, and **Fire pending now**.

### AB.6 Not simulated

- Clicking links in a message (e.g. a magic link). Read `{{link}}` in a test and open it yourself.
- Attachments in auto-replies. `reply_as_user` can send email attachments.
- AI-written replies: see §AE (a persona answers through a rule whose reply is `{persona}`).
- Read receipts or typing indicators as part of a reply.

---

## AC. AI chat extras (mock providers, model matrix, save a tool call, explain this)

Everything here works without a real key: the two mock providers answer from the project's LLM mocks (§AA).

### AC.1 Mock providers (no key)

Two read-only providers are always listed in System → AI providers and in `GET /api/system/ai-providers`:

| Provider | Kind | Base URL |
|---|---|---|
| `mock:openai` | openai-compatible | `http://127.0.0.1:<port>/llm/<project>/openai/v1` |
| `mock:anthropic` | anthropic | `http://127.0.0.1:<port>/llm/<project>/anthropic/v1` |

- `<project>` is the agent's (or matrix run's) project, so each project's LLM mocks answer its own agents.
- No key is needed. stubyard sends the dummy key `sk-stubyard-mock` and the calls appear in LLM mocks → Calls.
- They cannot be edited, disabled, deleted or used as the upstream for record-to-mock. Names starting `mock:` and `env:` are reserved.
- `POST /api/system/ai-providers/mock:openai/test` needs `{model, project}` (400 without `project`).
- The model list comes from the LLM mocks' default model ids. Any model id works; mocks can match on it (`match.model: "gpt-5*"`).

```bash
curl -X POST localhost:4000/api/projects/shop/chat/agents -H 'content-type: application/json' \
  -d '{"name":"Support bot","provider":"mock:openai","model":"gpt-5-mini","tools":{"builtin":["list_test_users"]}}'
```

### AC.2 Model matrix (one prompt, 2–6 models)

`/p/<slug>/chat/matrix`, or `/api/projects/<slug>/chat/matrix`:
- GET: the list, newest first (the newest 50 runs are kept per project).
- POST `{prompt, models, agent?, tools?, confirmSideEffects?, expectations?, system?, temperature?, maxOutputTokens?, maxSteps?, name?}` returns 202 with the run. With `?wait=1` it returns 200 once the run has finished.
- GET `/:id`, DELETE `/:id`.
- POST `/:id/cancel`, POST `/:id/rerun` (body may replace `models`).
- POST `/:id/adopt {column, agent}`: sets that agent's provider and model to the column's.
- POST `/:id/conversation {column, agent?}` (201): copies the column into a new conversation, to continue it there.
- POST `/api/projects/<slug>/chat/prompts/:id/matrix {models}`: runs a saved prompt (with its agent and expectations).

Details:
- `models` holds 2–6 items, each `{provider, model}` or `"provider/model"`. Up to 3 run at a time, and each has a 5-minute limit.
- At most 3 matrix runs run at once per project, and 10 in all of stubyard. Starting another (POST, rerun, saved prompt, `compare_models`) answers 429 until one finishes or is cancelled.
- `agent` supplies the defaults (instructions, temperature, caps).
- `tools`:
  - `none` is the default without an agent.
  - `builtin` (stubyard's read-only tools) is the default with an agent.
  - `agent` uses the agent's full allowlist, MCP targets included. It needs an agent and `confirmSideEffects: true`, otherwise 400, because each model calls the tools again.
- `expectations` are the same as for saved prompts (§Y.4) and are checked per column.
- Each column has `{provider, model, status: queued|running|done|error|cancelled, text, toolCalls, steps, usage, ms, finishReason, error?, checks?, passed?}`. Text is clipped to 32 KB and tool outputs to 4 KB.
- A failing model only fails its own column. The run's `tokensIn`/`tokensOut` are totals; there is no cost estimate.
- A restart marks unfinished runs `cancelled`. Project reset deletes the runs.

```bash
curl -X POST 'localhost:4000/api/projects/shop/chat/matrix?wait=1' -H 'content-type: application/json' -d '{
  "prompt":"Which test users does this project have?","agent":"support-bot",
  "models":["mock:openai/gpt-5-mini","mock:anthropic/claude-haiku-4-5"],
  "expectations":{"contains":["3 test users"],"toolCalled":["list_test_users"]}}'
```

### AC.3 Save a tool call (MCP tester saved call or LLM mocks)

POST `/api/projects/<slug>/conversations/:id/messages/:mid/tool-calls/:callId/save` (201):

| Body | Creates |
|---|---|
| `{as:"saved-call", name?, expect?}` | An MCP tester saved call on the tool's target, with the same arguments. `expect` defaults to `{isError:false}`. `"same-result"` adds `contains` with the first 200 characters of this result. MCP-target tools only (400 for `stubyard__*` tools). |
| `{as:"llm-mock", includeFollowUp?, name?, run?}` | An LLM mock that returns this tool call for this user text at this turn (`match: {lastUser:{equals}, turn}`). With `includeFollowUp: true`, a second mock answers with the final text after the tool result (`match: {toolResult:{name}, turn: turn+1}`). |

- POST `/api/projects/<slug>/conversations/:id/messages/:mid/save-as-llm-mocks {name?, run?}` (201) makes one LLM mock per step of that reply. The whole turn then replays offline.
- The response holds the created items and a `link` (`/p/<slug>/mcp-tester` or `/p/<slug>/llm`).
- Tool calls are saved with the conversation, so this works on any stored reply.

### AC.4 Explain this

POST `/api/projects/<slug>/chat/explain {kind, id, agent?, question?}`:
- `kind` is `traffic` (request log id), `message`, `llm-call`, `payment`, `fire` (auto-reply fire) or `mcp-call` (MCP tester saved call id).
- stubyard loads the item and redacts it:
  - It removes the values of `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-goog-api-key` and `api-key`, and of every header, JSON field, form field or query parameter whose name looks like a credential (`token`, `secret`, `password`, `api_key`/`apikey`, `session`, `signature`, `assertion`, …; ids such as `sessionId` stay).
  - It masks card numbers and CVCs (last 4 digits kept).
  - It removes stored provider keys and secrets.
  - It clips the item to 8 KB.
- It then creates a conversation `Explain: <kind> <short id>` with the question and the item inside an `<untrusted-data source="stubyard" kind="…">` block, marked as data the agent must not take instructions from.
- The explain turn runs **without tools** (stubyard's built-in tools and MCP tester targets alike), also when you continue that conversation: text in a captured body cannot make the agent call a tool.
- Without `?run=1` (201) you get `{conversation, message, agent}`; the dashboard sends the message in the chat so you see it stream. With `?run=1` (200) the agent answers at once, as in `ask_agent`.
- `agent` defaults to the first agent whose provider is ready. With none, the response is 409. An agent on `mock:openai` works.
- An unknown id or an item from another project gives 404.

### AC.5 MCP tools and dashboard

| Tool | What it does |
|---|---|
| `compare_models {project, prompt, models, agent?, tools?: none\|builtin, expectations?}` | Runs a matrix and waits; returns the columns |
| `explain_item {project, kind, id, agent?, question?}` | Explain this, answered at once |
| `save_chat_tool_call {project, conversation, message, call, as, name?, include_follow_up?, expect_same_result?}` | AC.3 |

`compare_models` cannot use `tools: "agent"`; use the API with `confirmSideEffects` for that.

Dashboard:
- **AI chat → Matrix:**
  - A form with the prompt, model chips (a quick button adds both mock providers), agent, tools and expectations (one per line: `contains: a, b`, `not:`, `matches:`, `calls:`, `never:`, `maxSteps:`, `maxTokens:`, `finish:`).
  - The result shows columns side by side on wide screens, scrolling horizontally on tablets and as accordions on phones.
  - Each column has its checks, tokens, steps and time, plus **Open as conversation** and **Use for agent…**.
  - The list of past runs is beside or below the form.
- **Compare models…** in the conversation header opens the matrix with the last prompt and the agent filled in.
- **Save ▾** on each tool card saves it as an MCP tester saved call or as LLM mocks. **Save turn as LLM mocks** is under each reply.
- **Explain ▾** in the Traffic log drawer has two items: **Explain this** and **Ask a question…**. Both open the chat with the item.
- **System → AI providers:** mock rows have a `mock` badge, "not needed (mock)" as the key, and no Test or menu.

---

## AD. Push notifications (fake FCM and APNs)

A project can have fake **Firebase Cloud Messaging** (HTTP v1) and fake **Apple Push Notification service** instances.
Your backend sends pushes with its usual SDK, pointed at stubyard. Each push lands in the inbox of the test user who
owns the device token, where you can check it, tap it, and wait for it from a test. stubyard never calls Google or Apple.

| Instance | What your backend talks to | Credentials stubyard gives you |
|---|---|---|
| `fcm` | `POST /push/<project>/<instance>/v1/projects/<firebase-id>/messages:send`, OAuth `POST …/token`, Instance ID `POST …/iid/v1:batchAdd` / `:batchRemove` | a service-account JSON whose `token_uri` points at stubyard |
| `apns` | the APNs provider API (`POST /3/device/<token>`) over **HTTP/2** on its own port (`STUBYARD_APNS_PORT`, default **2197**); also over HTTP/1.1 at `/push/<project>/<instance>/3/device/<token>` for curl | a `.p8` key (ES256), key id, team id |

Out of scope:
- the legacy FCM APIs (`/fcm/send`, `/batch`). They answer 404 with a hint and a lint error, because Google shut them down.
- APNs certificate (mTLS) authentication. In lax mode, a request without `authorization` is accepted with a warning.
- Web Push (VAPID), Huawei and other providers.
- real delivery to devices.

### AD.1 Set up an instance and connect your app

Use **Providers → Push → Add**, **Push → Connect**, or `POST /api/projects/<p>/push/instances` with one of these bodies:
- `{ "preset": "fcm", "config": { "fcmProjectId"?: "my-app-123" } }`
- `{ "preset": "apns", "config": { "bundleIds": ["com.acme.app"], "environment": "sandbox" } }`

The slug defaults to `fcm` / `apns`. `GET …/instances/<i>/connect` returns the URLs, a `.env` block and snippets.

FCM:

```bash
curl -o sa.json http://localhost:4000/api/projects/chat/push/instances/fcm/service-account.json
export GOOGLE_APPLICATION_CREDENTIALS=$PWD/sa.json
# send to: http://localhost:4000/push/chat/fcm/v1/projects/<project_id from sa.json>/messages:send
```

- **Python** (google-auth) and **Java** / **Go** honour `token_uri`, so only the FCM base URL has to change.
- **Node `google-auth-library`** always posts to `https://oauth2.googleapis.com/token` and ignores `token_uri`. The Connect snippet redirects that one request through `transporterOptions.fetchImplementation`. stubyard accepts both audiences: the Google token URL and the `token_uri`.
- **firebase-admin (Node)** has no option to change the FCM host. Use **host mode**:
  1. Map `fcm.googleapis.com`, `oauth2.googleapis.com` and `iid.googleapis.com` to stubyard (hosts file or Docker `extra_hosts`).
  2. Add those names to `STUBYARD_TLS_NAMES`.
  3. Trust the stubyard CA (`NODE_EXTRA_CA_CERTS`).
  4. Make stubyard's HTTPS answer on 443.

  Requests carrying those Host headers are routed to the instance. stubyard finds it from the assertion's `iss`, the access token, or the Firebase project id in the URL.

APNs:

```js
const provider = new apn.Provider({
  token: { key: './AuthKey_ABC123DEFG.p8', keyId: 'ABC123DEFG', teamId: 'TEAM123456' },
  address: 'localhost', port: 2197, production: false,
  ca: [fs.readFileSync('stubyard-ca.pem')],   // GET /api/ca.crt
});
```

- When TLS is on, the listener uses TLS with the stubyard CA. When stubyard runs without TLS it uses cleartext HTTP/2 (h2c, prior knowledge).
- An HTTP/1.1 client gets a single `505` answer and the connection closes.
- Pushy (Java): `setApnsServer("localhost", 2197)` plus `setTrustedServerCertificateChain`.
- `apns2` (Node) has a `host` option only.
- PyAPNs2 and a2 (Rust) have fixed Apple hosts. Map `api.sandbox.push.apple.com` / `api.development.push.apple.com` to stubyard, add the names to `STUBYARD_TLS_NAMES`, and trust the CA.
- A path prefix `/push/<project>/<instance>/3/device/…` on the HTTP/2 listener picks the instance explicitly. Without one, the instance is found from the JWT `kid`+`iss`, then the device token, then "the only APNs instance".

Docker: publish the APNs port (`-p 127.0.0.1:2197:2197`). `STUBYARD_APNS_PORT=0` turns the listener off.

### AD.2 Devices and test users

- **Register** a device: `POST /api/projects/<p>/push/devices` with `{ user?, platform: "android"|"ios"|"web", instance?, token?, name?, topics?, appId? }`.
  - stubyard generates a realistic token: an FCM registration token (`<22 chars>:APA91b…`) or a 64-hex APNs token.
  - Store that token in your app as the user's push token, or register the token your app already has.
- **Unknown tokens** (`config.unknownTokens: "accept"`, the default) become **unassigned** devices on their first push, with the `push.unknown-token` lint. With `"reject"`, FCM answers `404 UNREGISTERED` and APNs `400 BadDeviceToken`.
- **Uninstall**: `POST …/devices/<id>/unregister`. FCM then answers `404 UNREGISTERED`, and APNs `410 {"reason":"Unregistered","timestamp":…}`. `…/register` undoes it.
- **Topics**: `POST …/devices/<id>/topics { add, remove }`, or the real Instance ID API: `POST /push/<p>/<i>/iid/v1:batchAdd` with `access_token_auth: true` and `{ to: "/topics/x", registration_tokens: [...] }`, up to 1000 tokens.
- `GET /api/projects/<p>/users/<id>/push-devices` lists a user's devices. The user page shows a **Push** block with the latest pushes and an unread count.

### AD.3 What FCM checks

`messages:send` follows HTTP v1:
- **Exactly one target**: `token`, `topic`, or `condition`. Conditions take up to 5 topics, with `&&`, `||`, `!` and parentheses.
- **Unknown fields** get a 400 `Invalid JSON payload received. Unknown name "…"`.
- **`data` values must be strings.**
- **Payload limit**: 4096 bytes, or 2048 for topic messages.
- **Field ranges**: `android.priority` must be NORMAL or HIGH, and `ttl` must be like `"3600s"`.
- `validate_only: true` answers `projects/<id>/messages/fake_message_id` and stores the push as `validated`.

Errors use the google.rpc shape `{ error: { code, message, status, details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] } }`.

**Topic and condition sends** fan out to every subscribed device, and those rows share a `groupId`. With no subscriber, one row is stored with status `no_subscribers`.

**Strict vs lax** (`PATCH …/instances/<i> { "strict": true }`):
- In **lax** mode (the default), problems are warnings on the traffic row: a bad JWT signature, a missing `firebase.messaging` scope, or a project id that differs from the service account's (`push.fcm-sender-mismatch` lint).
- In **strict** mode the real errors come back: `invalid_grant` / `Invalid JWT Signature.`, `403 PERMISSION_DENIED`, and `403 SENDER_ID_MISMATCH`.
- Expired or not-yet-valid assertions always fail.

### AD.4 What APNs checks

All the documented reasons are returned with the documented status codes:
- **Path, method and token**: `BadPath`, `MethodNotAllowed`, `MissingDeviceToken`, `BadDeviceToken`.
- **Topic**: `MissingTopic` (token auth), `TopicDisallowed` (the bundle id is not in `bundleIds`), `DeviceTokenNotForTopic`.
- **Headers**:
  - `BadMessageId` (`apns-id` must be a UUID);
  - `InvalidPushType`, for any push type other than: alert, background, location, voip, complication, fileprovider, mdm, liveactivity, pushtotalk, widgets, controls, accessory;
  - `BadPriority` (10, 5 or 1);
  - `BadExpirationDate` (not digits, or beyond year 5138);
  - `BadCollapseId` (more than 64 bytes).
- **Payload**: `PayloadEmpty`, and `PayloadTooLarge` (413) above 4096 bytes, or 5120 for VoIP.
- **Provider token**: `MissingProviderToken`, `InvalidProviderToken` (403), `ExpiredProviderToken` (`iat` more than one hour old, always enforced). `TooManyProviderTokenUpdates` (429) applies in strict mode only; in lax mode a token refreshed within 20 minutes on one connection gets the `push.apns-token-churn` lint.
- **Device state**: `Unregistered` (410 with `timestamp`).

A 200 carries `apns-id` (yours or a new UUID). In the sandbox environment it also carries `apns-unique-id`.

`/run/<key>` and `X-Hub-Run` on the HTTP/2 listener resolve the run in the project the request is for (from the
`/push/<p>/<i>` prefix, else the provider token or device token); a run key of another project gives `BadPath`.

Listener limits (it has no authentication): 100 concurrent streams per connection, 10 MB per session, 256 sessions and
512 connections; connections idle for 2 minutes are closed, a request whose body never ends is reset after 30 s, and an
h2c socket that sends no HTTP/2 preface within 10 s is dropped.

Lint on each push:
- the push-type suffix does not match the topic (`.voip`, `.complication`, `.push-type.liveactivity`, …);
- no `apns-push-type`;
- a background push without priority 5 and `content-available: 1`. Strict mode answers this one with `BadPriority`.

`apns-collapse-id` (FCM: `collapse_key`) marks the older notification on that device as `collapsed`. `aps.badge` is stored on the device.

### AD.5 Inbox, waiting and tapping

`GET /api/projects/<p>/push/notifications` returns notifications newest first.
- **Filters**: `user`, `device`, `provider`, `instance`, `topic`, `status`, `contains`, `title`, `dataKey`, `run`, `after`, `since`, `limit`.
- **Statuses**: `delivered`, `collapsed`, `dropped`, `rejected` (with `errorCode`), `validated`, `no_subscribers`.
- The response sets the `X-Stubyard-Cursor` header.

Wait for a push in a test:

```bash
C=$(curl -s 'localhost:4000/api/projects/chat/push/notifications/cursor?user=alice@example.test' | jq -r .cursor)
# … the app sends a push …
curl -s "localhost:4000/api/projects/chat/push/notifications/wait?user=alice@example.test&after=$C&title=New%20message&timeout=10"
```

`wait` always answers 200 with `{ timedOut, notifications, cursor }`:
- It returns oldest first.
- `count=N` waits for N notifications. `exactly=N` also waits `settle` seconds (default 2) and reports an `error` if more arrive.
- Without `after`, notifications from the last `lookback` seconds count (default 10). Inside a run, the window starts at the run start.

`POST …/notifications/<id>/open` simulates a tap. It returns `tap` (`click_action`, `webpush.fcm_options.link`, a `url` / `link` / `deeplink` data key, `target-content-id` or `category`) and the `data`, and marks the notification read.

The SDK helper is `@stubyard/client/push`:
- `registerDevice`, `unregisterDevice`, `subscribeTopic`
- `pushCursor`, `waitForPush` (throws on timeout), `listPushes`, `openPush`
- `setPushFault`, `resetPushFaults`
- `fcmServiceAccount`, `apnsConfig`

### AD.6 Faults

Add a rule with `POST /api/projects/<p>/push/faults { fault, user?, token?, topic?, instance?, times? }`. To fault one request, send the header `X-Hub-Scenario: <fault>`.

| Fault | FCM | APNs |
|---|---|---|
| `unregistered` | 404 UNREGISTERED | 410 Unregistered + timestamp |
| `bad_token` | 400 INVALID_ARGUMENT | 400 BadDeviceToken |
| `quota[:secs]` | 429 QUOTA_EXCEEDED + Retry-After | 429 TooManyRequests |
| `unavailable` / `internal` | 503 UNAVAILABLE / 500 INTERNAL | 503 ServiceUnavailable / 500 InternalServerError |
| `auth` | 401 THIRD_PARTY_AUTH_ERROR | 403 InvalidProviderToken |
| `sender_mismatch` | 403 SENDER_ID_MISMATCH | 400 DeviceTokenNotForTopic |
| `payload_too_large` / `topic_disallowed` | 400 INVALID_ARGUMENT | 413 PayloadTooLarge / 400 TopicDisallowed |
| `timeout` | held for `STUBYARD_TIMEOUT_HOLD_MS`, then the connection is closed | the stream is reset |
| `drop` | 200, but stored as `dropped` | same |
| `slow:<ms>` | normal answer after the delay | same |

Rule order:
- Run rules (`?run=<key>` or `"run"`) come before project rules, and the first match wins.
- `times` counts down; a rule at 0 is spent.
- `DELETE …/faults` removes all rules, or only the run's rules when `run` is given.

### AD.7 Runs, reset, export

**Runs**:
- Attach a run with `X-Hub-Run` or the prefix `/run/<key>/push/…`. On the APNs listener, `/run/<key>/3/device/…` works too.
- Devices registered in a run get only that run's pushes. Project devices get every push.
- Purging a run deletes its devices, its notifications and its fault rules.

**Project reset** deletes notifications and auto-created devices, resets badges, and puts rule hits back to 0. Instances, registered devices and rules stay.

**Export**:
- Instances are exported **without private keys**; import generates new keys and warns you to download them again.
- Devices are exported only when they belong to a test user and not to a run.
- Fault rules are exported too.

**Traffic log**: every request is logged. The `authorization` header and the `assertion` form field are redacted. The row's `resolved` field holds the instance, device, user, status, faults and lint.

### AD.8 MCP tools

- `list_push_devices`, `register_push_device`, `unregister_push_device` (`re_register` undoes it)
- `list_push_notifications`, `get_push_notification`, `wait_for_push`
- `set_push_fault` (`fault: "none"` clears the rules)
- `reset_push`

### AD.9 Not verified against the real services

- **google.rpc status names per FCM error code**: the standard google.rpc mapping is used (UNREGISTERED → NOT_FOUND, QUOTA_EXCEEDED → RESOURCE_EXHAUSTED, …); not confirmed in the FCM docs.
- **FCM limits and formats not confirmed in Google's docs**:
  - the limit of 5 topics per condition;
  - the topic-name regex `[a-zA-Z0-9-_.~%]+`;
  - `fake_message_id` for `validate_only` (only third-party sources mention it).
- **Legacy FCM dates**: deprecated 2023-06-20, shut down from 2024-07-22. These come from third-party sources only.
- **APNs background pushes with priority 10**: Apple calls it an error but documents no reason string; `BadPriority` is a guess.
- **APNs `DuplicateHeaders`**: in practice it cannot be detected, because Node merges duplicate HTTP/2 headers before stubyard sees them.
- **APNs `PayloadEmpty` for a body that is not JSON**: chosen by stubyard; Apple documents no reason for it.
- **The Instance ID API** is scheduled for removal on 2027-09-29.
- **Go's FCM endpoint option**: Go probably supports `option.WithEndpoint` for the FCM base URL; not tested.

---

## AE. AI personas (LLM-written replies)

### AE.1 What a persona is

A persona is a test user whose replies an LLM writes. It reads what your app sends (email, SMS, WhatsApp) and answers
in character: it asks a question, sends a code back, taps a button, gets impatient, gives up. Each persona has:
- a **prompt**: who the user is and how they write;
- **goals** the model closes with control lines (e.g. "get the login code and send it back");
- a **provider + model** from the AI providers (§Y). Use the keyless `mock:openai` / `mock:anthropic` (§AC) to answer
  from the project's LLM mocks (§AA): no key is needed and nothing leaves stubyard;
- **limits** on replies, tokens and model calls.

A persona answers through an auto-reply rule (§AB) whose reply is `{persona}`. So rule order, `delay` / `jitter`,
runs, fires, the loop guard and the Activity tab work the same as for scripted rules.

Prefer a scripted rule (§AB) when the answer is fixed ("reply with the code", "reply STOP"): it is instant, free and
exact. Use a persona when the conversation has several turns and the next answer depends on what the app said, e.g.
a support bot, a booking dialog, or a chat flow that must cope with a confused user.

### AE.2 Create and assign

`POST /api/projects/<p>/personas`:

```json
{ "name": "Late parcel", "provider": "mock:openai", "model": "gpt-5-mini",
  "prompt": "A customer whose parcel is late. Polite but persistent.",
  "goals": [{ "id": "tracking", "text": "Get a tracking link" }, "Ask for a refund if it is more than a week late"],
  "style": { "language": "English", "tone": "polite", "maxChars": 300 },
  "limits": { "maxReplies": 5 },
  "fallback": "Sorry, I will call you instead.",
  "opener": "Hi, I never got my parcel." }
```

- `slug` comes from the name unless given. A goal given as a plain string gets the id `g1`, `g2`, …
- `GET /api/persona-presets` lists the presets (cooperative, confused, impatient, opt-out, …), the limit defaults and
  maximums, and the thread states.
- `POST /personas/<id|slug>/assign {user | role, channel?, delaySeconds? (2), jitterSeconds? (3), instruction?}`
  creates the rule `{match.user | match.role, reply: {persona, instruction?}}` first in line (`stop: true`), named
  "Persona: <name> → <user>". `?run=` or `X-Hub-Run` makes it a run rule. `instruction` is an extra line for this
  assignment only, e.g. "refuse the first offer".
- You can also write the rule yourself: `reply: {persona: "<id or slug>", instruction?, channel?, instance?, thread?}`.
  `persona` cannot be combined with `text`, `subject`, `html` or `button`.
- `POST /personas/<id>/start {user, channel, text?, subject?, instance?}` makes the user write first: the opener (or
  `text`) goes to your app through the provider's inbound webhook, and the thread starts.

A **thread** is one conversation: one per persona, test user, channel and test run. Its state:
- `active`;
- `done`: every goal is closed (`limits.endWhenDone`, default on) or the model wrote `[[DONE]]`;
- `limit`: a limit was reached (`stopReason` says which);
- `error`: 3 model errors in a row;
- `stopped`: by you, by `stop_persona_threads`, or because the test run stopped.

Only an `active` thread gets replies. A message to an ended thread makes the fire `skipped` ("the conversation has
ended (done)"). `POST /threads/<id>/reset` makes it active again with the goals open and the counters and notes cleared.

### AE.3 Goals, memory and limits

Each reply is one model call. The model sees:
- the system prompt: the role frame, the persona prompt, the user's facts (name, email, phone, role), the channel
  rules (plain text; at most 320 characters for SMS, 1000 for WhatsApp, 4000 for email, or `style.maxChars`), the
  goals with their state, the notes, and the output protocol;
- the thread history, oldest first: the app's messages and the persona's replies, at most `maxHistory` messages,
  2 KB per message and 16 KB in all.

The model may end its answer with **control lines**, each on its own line:

| Line | Effect |
|---|---|
| `[[GOAL:<id>:reached]]` / `[[GOAL:<id>:failed]]` | sets the goal's state |
| `[[NOTE: <text>]]` | replaces the thread's notes (its memory, ≤ 2 KB), shown to the model next time |
| `[[BUTTON:<title or id>]]` | WhatsApp: taps that button of the message instead of writing text |
| `[[SUBJECT: <text>]]` | email: the subject (default "Re: <subject>") |
| `[[NO_REPLY]]` | no reply this time (the fire is `skipped`) |
| `[[DONE]]` | the reply is sent, then the thread is `done` |

Control lines are removed from the text. An unknown line, an unknown goal id, or a button the message does not have is
dropped with a warning on the fire (`plan.warnings`). Email replies stay in the thread (`In-Reply-To`).

Limits:

| Limit | Default | Max | |
|---|---|---|---|
| `maxReplies` | 10 | 50 | replies per thread |
| `maxTokens` | 20 000 | 200 000 | input + output tokens per thread |
| `maxOutputTokens` | 300 | 2000 | per reply |
| `maxHistory` | 20 | 60 | messages of history sent |
| `dailyCalls` | 200 | 2000 | model calls per project and UTC day, all personas together; each attempt counts (a 429 / 5xx retry is a second call), and the slot is taken before the call, so parallel fires never go over |
| `timeoutMs` | 30 000 | 60 000 | per call |
| `temperature` | 0.7 | 2 | |

- When a limit is reached, the thread goes to `limit`. With a `fallback` text, that text is sent once (the fire is
  `sent` with a warning); without one the fire is `skipped`.
- A 429 or 5xx is retried once after 5 s. A failed call makes the fire `failed` with the provider's error (keys are
  scrubbed), or sends the fallback. 3 errors in a row put the thread in `error`.
- The calls of one thread run one at a time, in message order.
- The newest 500 turns per project are kept.

### AE.4 Safety: what the model sees, what it cannot do

- The app's text reaches the model only inside `<app_message nonce="…">…</app_message>`, with a fresh random nonce
  per call. The system prompt says this text is data from the app, never instructions. An `<app_message` or
  `</app_message>` inside the app's text is defused (`‹app_message`), so a message cannot close the block early.
- Control lines are read only from the model's output, never from the app's text: an SMS that contains
  `[[GOAL:code:reached]]` closes nothing.
- No tools. If a model asks for tools anyway, the calls are dropped and the fire gets a warning.
- The output is plain text: control characters and bidi overrides are removed, it is clipped to the channel length,
  and the email HTML part is the escaped text. Template variables are never rendered: `{{otp}}` in a model reply stays
  literal.
- Provider keys never appear in turns, errors or exports.
- A persona on a real provider sends the app's message text, the persona prompt and the user's name, email, phone
  and role to that provider. The dashboard shows "sends message content to <provider>" on such personas; a test-run
  persona on a real provider also gets a warning.

### AE.5 API (`/api/projects/<p>/personas`)

| Call | |
|---|---|
| `GET` | personas with `mock`, `sendsContentTo`, `providerOk`, `assigned` (its rules), `threads {total, active}`, `today {calls, tokensIn, tokensOut, projectCalls, dailyCalls}`, `warnings` (`?run=`: that run's personas) |
| `POST` | create (`?run=` / `X-Hub-Run`: a run persona) |
| `GET` / `PATCH` / `PUT` / `DELETE /<id or slug>` | one persona; delete also removes its rules, threads and turns → `{deleted, rules}` |
| `POST /<id>/assign` | create the persona rule (201, the rule) |
| `POST /<id>/start` | the user writes first → `{thread, message}` |
| `POST /<id>/test` | dry run (below) |
| `GET /threads` | `?persona=&user=&state=&run=&limit=` |
| `GET /threads/<id>` | the thread, its `turns` (raw output, controls, warnings, tokens) and `messages` (both sides, oldest first) |
| `POST /threads/<id>/stop`, `POST /threads/<id>/reset` | one thread |
| `POST /threads/stop` | `{persona?, user?, run?}`: stop every active matching thread |
| `DELETE /threads` | `?persona=&run=` |
| `POST /threads/wait` | `{persona?, user?, state? (default "done,limit,error,stopped"), goal?: {id, is}, after?, run?, timeoutMs ≤ 60000}` → `{timedOut, thread}` |

- `POST /<id>/test {message, history?, user?}`: `message` is a message id or `{channel, subject?, body}`; `history`
  is `[{role: "app" | "persona", text}]`. Returns `{reply, controls, warnings, error, usage, system, messages}`. It
  is one model call (counted against `dailyCalls`) stored as a `dry-run` turn; nothing is sent and no thread changes.
- `POST /auto-replies/test {rule, message, llm: true}` dry-runs a persona rule the same way. Without `llm` it only
  says whether the rule matches.
- A fire of a persona rule has `plan.persona {personaId, name, threadId, turnId, status, goals}`. The reply message
  has `metadata.persona`.
- Runs: stopping a run stops its threads; purging it deletes its threads, turns and run personas. Project reset
  deletes every thread and turn; personas and rules stay.
- Export / import: project personas, in the `personas` section (before `autoReplies`). Persona rules refer to the
  persona by slug. Import warns when a persona's provider does not exist on this stubyard.

### AE.6 MCP tools and dashboard

MCP tools:
- Read-only:
  - `list_personas {project, run?}`;
  - `get_persona_thread {project, id? | persona?, user?, state?, run?}`;
  - `test_persona {project, persona, message, user?, history?}` (one model call);
  - `wait_for_persona {project, persona?, user?, goal?, state?, run?, timeout_seconds?}`.
- Changing:
  - `set_persona {project, id?, name, prompt, goals?, provider, model, style?, limits?, fallback?, opener?, run?}`;
  - `assign_persona {project, persona, user | role, channel?, delay_seconds?, jitter_seconds?, instruction?, run?}`;
  - `start_persona_conversation {project, persona, user, channel, text?, subject?, instance?, run?}`;
  - `stop_persona_threads {project, id? | persona?, user?, run?}`;
  - `delete_persona {project, persona}`.

Dashboard: **Auto-replies → Personas** (`?tab=personas`).
- Persona cards show:
  - a mock / real model badge, and "sends message content to <provider>" for real providers;
  - the goals, the users and roles it is assigned to, calls and tokens today, and its threads;
  - **Assign to user…** and **Try it**: a dry run against one of the last 20 outbound messages (or a typed one)
    that shows the reply, the control lines, the system prompt and the messages;
  - in the menu: Edit, Start conversation…, Turn off, Clear threads, Delete.
- **Start from…** offers the presets. The editor has provider and model (from the AI providers), prompt, goals (one
  per line, `id: text`), style, limits with their defaults and maximums, fallback and opener.
- **Threads**: filter by persona and state; goals as chips, replies n / max and tokens n / cap with a bar. A thread
  opens a drawer with the transcript (app on the left, persona on the right; each reply shows its status, tokens and
  control lines), the notes, and **Stop** / **Reset**.
- On the Rules tab a persona rule reads "Reply … persona: <name>" and opens the persona. In Activity, a persona fire
  links to its thread.

### AE.7 CI with mock:openai

Script the model with LLM mocks (§AA). The persona's model calls go to the project's own mock endpoint, so the test
is keyless and deterministic.

```bash
P=localhost:4000/api/projects/shop
J='content-type: application/json'
# 1. Two scripted model answers: send the code back and close the goal; anything else gets a question.
curl -s -X POST $P/llm/mocks -H "$J" -d '{"name":"code","match":{"lastUser":{"contains":"482913"}},
  "responses":[{"text":"482913\n[[GOAL:code:reached]]"}]}'
curl -s -X POST $P/llm/mocks -H "$J" -d '{"name":"other","responses":[{"text":"What is this about?"}]}'
# 2. The persona and its assignment (no delay in CI).
curl -s -X POST $P/personas -H "$J" -d '{"name":"Pat","provider":"mock:openai","model":"gpt-5-mini",
  "prompt":"Sends codes back.","goals":[{"id":"code","text":"send the login code back"}]}'
curl -s -X POST $P/personas/pat/assign -H "$J" -d '{"user":"customer1","channel":"sms","delaySeconds":0,"jitterSeconds":0}'
# 3. Your app sends the code to customer1 … then wait for the goal.
curl -s -X POST $P/personas/threads/wait -H "$J" \
  -d '{"persona":"pat","goal":{"id":"code","is":"reached"},"timeoutMs":15000}' | jq '.timedOut, .thread.state'
```

- Mocks are checked in order, so the specific one goes first. `match.lastUser` matches the app's text inside the
  `<app_message>` block. In a real test, match on the code your app generated, or use a `sequence` mock.
- `GET /llm/calls/<id>` shows what the persona sent: the system prompt and the delimited app message.
- Fault rules (`POST /llm/faults {fault: "error:500", times: 2}`) test the retry, the fallback and the `error` state.

### AE.8 Not simulated

- Typing delays beyond the rule's `delay` / `jitter`; read receipts and typing indicators.
- Attachments, images, voice notes, locations.
- Clicking links (e.g. a magic link): read the link from the thread and open it in your test.
- Tools: a persona cannot call stubyard, your app or anything else.
- Memory across threads: each thread has its own history and notes.

---

## AF. Storyboards and walkthroughs (manual test flows, Chrome extension)

### AF.1 What it is

A **storyboard** is a business flow written down as ordered steps for a person to walk through in the browser:
"a new participant signs up, confirms the email, registers for an event; an admin logs in with 2FA and approves it;
the participant gets the decision email". stubyard stores the storyboards of a project, and the **stubyard Chrome
extension** (AF.9) shows them in a side panel next to the app: it opens pages, logs in as test users (filling the
TOTP or emailed code), fills forms from data sets, waits for emails and opens their links, captures values, checks
pages and takes screenshots. One person's run through a storyboard is a **walkthrough**; it ends with a sign-off
(pass, fail or partial) and a summary. A walkthrough can also run as a **quick test** (AF.9): the same steps and
automation, but no step verdicts, notes, screenshots or sign-off, not kept in history.

Agents build storyboards (through MCP, AF.8, or REST); people run them with the extension, and an agent can run them
itself in its own browser (`executor: "agent"`, AF.11).

The objects, all per project:

| Object | Key | What it is |
|---|---|---|
| App origins | `settings.appOrigins` | Origins of the app under test (`http://localhost:3183`). The extension finds the project by the page origin; relative step URLs (`/path`) are opened on the first origin (or the one chosen at start) |
| Login recipe | role | How to log in as a role: login URL, field selectors, 2FA kind |
| Data set | slug | Values to fill into one form, matched to pages by a URL glob and/or form id |
| Page snapshot | id | The scanned fields of a page (from the extension or pasted by an agent); the source of data-set keys |
| Storyboard | slug | Actors, inputs and steps |
| Walkthrough | id or 6-char key | One run, by a person (extension) or an agent: a copy of the storyboard, the users of its actors, vars, step results, screenshots, verdict and sign-off |

Build order: app origins and roles → test users (existing staff) and authenticators → login recipes → page
snapshots → data sets → storyboards → validate → walk through.

### AF.2 Storyboards, actors and inputs

```json
{ "slug": "registration-approval", "name": "Registration needing approval",
  "description": "", "intent": "A new participant registers, an admin approves it, the participant is told.",
  "tags": ["registration"],
  "inputs": [{ "name": "event", "label": "Event code", "default": "HCE27", "required": false }],
  "actors": [
    { "key": "participant", "label": "New participant", "role": "participant", "fresh": true,
      "name": "{{fake.firstName}} Flow-{{unique}}" },
    { "key": "admin", "label": "Admin", "role": "admin", "user": "admin@classprovia.test" }],
  "steps": [ … ],
  "preferredMode": "tracked" }
```

- `slug`: lowercase letters, digits, dashes, max 48. Actor keys, input names and capture vars: a lowercase letter, then
  letters, digits or `_` (camelCase is fine: `regNo`). 1–10 actors, 0–20 inputs, 1–150 steps.
- **Actors**: `role` picks the login recipe. A non-fresh actor uses the test user `user` (id, email, name or role),
  or the first user with that role. A **fresh** actor gets a new project test user per walkthrough:
  email `<role>.<walkthrough key>@<emailDomain>` (with `-2`… on a clash), name from `name` (default
  `{{fake.firstName}} {{fake.lastName}}`), a phone number, and no password of its own (the project
  `defaultPassword` applies, else `Password123!`). `fresh` and `user` cannot be combined.
- **Inputs** are asked for when a walkthrough starts and become `{{vars.<name>}}`.
- Steps get ids `s1`, `s2`, … when none is given; ids stay stable afterwards. A step's `actor` defaults to the previous
  step's actor (the first step: the first actor).
- `PUT` is idempotent: `version` goes up only when the content changes.
- `preferredMode` (`tracked` default, or `quick`) is a hint: which start button the extension shows first. Set
  `quick` for simple form-fill or smoke flows a person just wants to click through; keep `tracked` where evidence and
  a sign-off matter. The person can still pick the other mode, and `POST /walkthroughs` defaults to `tracked` whatever
  this says. It is part of the content (a change bumps `version`), of bundles and of project export. The storyboard
  list (`GET /storyboards`, `list_storyboards`) shows it.

### AF.3 Step kinds

Every step has `title`, `intent` (one plain sentence: what the person does and why; no selectors), and optionally
`id`, `actor`, `notes`, `optional`, `screenshot` (`off` | `offer` (default) | `required`) and `target`
(`{selector?, text?}`: what the panel highlights).

`target.selector`, `target.text`, a capture's `selector`, `assert.selector` and `assert.urlMatches` are templates:
`{{vars.x}}` is rendered when the step resolves, so `[data-testid="pay-bank-{{vars.regNo}}"]` points at the row of the
captured registration. Validation checks these variables like any other template. Keep the quotes of an attribute
selector around the variable (`[data-x="{{vars.id}}"]`), since a value can contain characters a bare selector does
not allow.

| Kind | Fields | What the panel does |
|---|---|---|
| `open` | `url` | Opens the URL |
| `login` | `actor` (required), `recipe?` (role; default the actor's role), `url?` | Opens the login URL, fills username and password, highlights the submit button. With 2FA it waits for the code field and fills the code (AF.4). The person clicks Log in / Verify |
| `logout` | `url?` (default the recipe's `logoutUrl`) | Opens the logout URL, or tells the person to sign out by hand |
| `fill` | `dataSet` (slug), `url?`, `formId?` | Fills the visible fields of the form from the data set and shows the counts (filled, unmatched, skipped, errors). Never clicks Next or Submit |
| `email` | `actor` (required), `channel` (`email` \| `sms` \| `whatsapp`, default email), `match {subject?, text?}`, `link {pattern?, index?}`, `timeoutSec` (5–600, default 120), `open` (`same-tab` \| `new-tab` \| `none`), `since?` (an earlier step id) | Waits for the message to the actor's user, lists its links (the matching one preselected) and opens the chosen one |
| `instruction` | — | Shows the intent; highlights `target` |
| `capture` | `var`, `selector?`, `attribute?`, `textPattern?` (regex; group 1 or the whole match), `required` (default true), `secret?` | Reads a value from the page (editable before saving) into `{{vars.<var>}}`. Needs `selector` or `textPattern` |
| `check` | `expect` (what the person should see), `assert {textPresent?, selector?, urlMatches?}` | Runs the assertion if there is one; the person marks Pass or Fail |

- `match.subject` and `link.pattern` are substrings or `/regex/flags`. `match.text` must appear in the subject or body.
- An email step sees messages from the start of the nearest earlier started step that is not a `check` (a check
  performs no action, so the mail sent by the step before it arrives before the check starts). When one action sends two
  mails (a payment receipt and a confirmation), the second email step would miss the second mail, which arrived
  before the first email step started. Give it `since: "<id of the step that triggered both>"`: its window then
  starts where that step started. The id must name an earlier step (`invalid_since` otherwise). An email step right
  after a `check` step without `since` gets the warning `email_after_check`: set `since` to the step that sends the mail.
- Secret vars: a capture with `secret: true`, or any var whose name matches `secret|password|token|otp_?key`
  (case-insensitive) or whose value is an `otpauth://` URI or a base32 TOTP key (16+ characters `A-Z2-7`), is listed in
  the walkthrough view's `secretVars` and masked (`***`) in the summary JSON / HTML and as dots in the dashboard. Steps
  still get the raw value.
- Without `link`, the person picks the link (`unsubscribe` links are listed last).
- There is one browser session per profile, so switching actors needs a `logout` of the previous actor and a
  `login` of the next one.
- Wizard forms: one `fill` per wizard page, or one `fill` pressed again on each page with an `instruction`
  ("Click Next") in between. Fields of other pages show as unmatched ("not on this page").

### AF.4 Login recipes

`PUT /api/projects/<p>/login-recipes/<role>`:

```json
{ "role": "admin", "name": "Staff (Admin)", "loginUrl": "/auth/staff-user/login",
  "fields": { "username": "#email", "password": "#password", "submit": "button[type=submit]" },
  "twoFactor": { "kind": "totp", "selector": "#code", "authenticator": "Class PROvia admin 2FA" },
  "logoutUrl": null, "notes": "" }
```

- `fields.username` / `fields.password` default to `#email` / `#password`. `submit` is only highlighted, never clicked.
- `twoFactor.kind`:
  - `none` (default);
  - `totp`: `selector` (default `#code`) and `authenticator` (a label, §7). Without a label, the key linked to the
    actor's user is used. If neither exists, the step resolves without 2FA (with a warning) and the person types the
    code;
  - `email-otp` / `sms-otp`: `selector` and an optional `subject` filter; the panel waits for the next message with
    an OTP to the actor's user.
- The username is the actor user's email; the password is the user's password, else the project `defaultPassword`,
  else `Password123!`.
- `DELETE` answers 409 while a storyboard uses the recipe, unless `?force=1`.

### AF.5 Data sets, page snapshots and filling

```json
{ "slug": "person-sign-up", "name": "Participant sign-up", "description": "",
  "match": { "urlPattern": "/auth/person/register" },
  "entries": [
    { "key": "email", "value": "{{user.email}}" },
    { "key": "title", "value": "Dr", "kind": "radix-select" },
    { "key": "organisationName", "value": "Flow Test Org {{unique}}" },
    { "key": "terms", "value": true },
    { "key": "interests", "value": ["Cardiology", "Research"] }] }
```

- **Entry**: `key` (unique per data set), `value` (text template, boolean, or a list for multi-selects and checkbox
  groups), `kind` (default `auto`), `selector?` (overrides key matching), `label?`, `note?`. At most 300 entries.
- **Kinds**: `auto`, `text`, `select`, `radio`, `checkbox`, `radix-select`, `radix-checkbox`, `radix-radio`, `date`,
  `otp`, `skip`. `auto` detects native inputs, selects, checkboxes, radios and date inputs, and Radix-style
  `role=combobox` / `role=checkbox` / `role=radio` widgets. For a Radix select the value is the visible option text.
- **Matching**, first hit wins, visible elements only (inside `form#formId` when given): `selector`, then element
  id, `name`, `data-testid`, `<label>` text (case-insensitive; for radio groups and checkbox groups without an id,
  the controls next to the label), `placeholder`, `aria-label`.
- Disabled, read-only and file inputs are skipped. A field that rewrites the value (masked phone inputs) is an error
  unless the digits are the same. Filling twice is safe: values are the same for the whole walkthrough.
- **`match.urlPattern`** is a glob on the URL path: `*` = any characters inside one segment, `**` = any characters
  across segments (`/admin/**` also matches `/admin`). The query is compared only when the pattern contains `?`; the
  origin, fragment and a trailing `/` are ignored. An empty pattern matches every page. The most specific pattern
  (most literal characters) wins. `/register/*` matches `/register/HCE27`, not `/register/HCE27/step2`.

Data set API (`/api/projects/<p>/data-sets`):

| Call | |
|---|---|
| `GET ?url=<page url>` | all data sets (`usedBy`: storyboard slugs); with `url`, only those matching, with `matchScore` |
| `GET` / `PUT` / `DELETE /<slug>` | one data set; PUT is an upsert (201 created, 200 updated); DELETE 409 while used, unless `?force=1` |
| `PATCH /<slug>` | `{name?, description?, match?, entries?, upsertEntries?, removeKeys?}`; `upsertEntries` merges by key |
| `POST /<slug>/preview` | `{storyboard?, actor?, walkthrough?}` → `{entries, warnings}`: the values rendered as a walkthrough would. Without a walkthrough, fresh actors get a placeholder user and `{{unique}}` is `preview` |
| `POST /from-snapshot` | `{snapshot, slug, name, include?: "visible" \| "all", values?: {key: template}}` → 201; one entry per field, value from `values` else the scanned value; 409 when the slug exists |

**Page snapshots** (`/api/projects/<p>/page-snapshots`) record the fields of a page: `POST {url, urlPattern?, title?,
formId?, fields: [{key, id, name, testId, kind, inputType, label, placeholder, value, options?, required, visible,
formId, duplicateKey}], note?, source?: "extension" | "agent"}` → 201 `{id, …}`; `GET ?url=&limit=` (brief),
`GET /<id>`, `DELETE /<id>`. The newest 200 per project are kept. A field's `key` is its id, else name, else
`data-testid`, else label: use it as the data-set entry key. The extension's **Page data** view sends a snapshot
(hidden wizard fields included) with **Send to stubyard**.

### AF.6 Template variables

URLs (steps and recipes), data-set values, fresh actor names, `email.match.text` and `check.assert.textPresent` are
rendered by the server when a step is resolved; the extension never renders templates. Resolve also returns the
step's `title`, `intent`, `expect` and `notes` rendered in `text` (a variable without a value renders empty there).

| Variable | Value |
|---|---|
| `user.name` `.email` `.phone` `.role` `.password` `.firstName` `.lastName` | The step actor's test user (first / last name: the name split at the first space) |
| `users.<actorKey>.<field>` | Any actor of the walkthrough |
| `vars.<name>` | Inputs given at start and values captured by earlier `capture` steps |
| `unique` | The walkthrough key (6 chars `a-z0-9`): use it in anything the app needs to be unique |
| `walkthrough.id` `.key` `.started` | `started` is `YYYY-MM-DD` |
| `project.slug` `.name` `.emailDomain` `.phonePrefix` | |
| `app.origin` | The origin chosen at start (default the first app origin) |
| `fake.firstName` `.lastName` `.fullName` `.company` `.jobTitle` `.city` `.word` | Fake data, **the same value for the whole walkthrough** (seeded by walkthrough id and name) |
| `fake.email` | `<first>.<last>.<unique>@<emailDomain>`, from `fake.firstName` / `fake.lastName` |
| `fake.phone`, `fake.digits:N` (1–32) | Phone prefix + digits (12 in all); N digits |
| `date.today`, `date.+7d`, `date.-18y`, `date.+2m`, `date.+1w`, `date.+3h` | `YYYY-MM-DD` (UTC); `m` = months, clamped to the month end |
| `datetime.now`, `datetime.+1d` | `YYYY-MM-DDTHH:mm` (UTC, for `datetime-local` inputs) |
| `uuid`, `random.digits:N` | Also the same for the whole walkthrough |
| `now` | Render time, ISO 8601 |

- A suffix gives another value: `fake.firstName:2`, `fake.email:2` (adds `.2` before the `@`), `uuid:2`,
  `random.digits:6:b`.
- Any other name (also auto-reply variables such as `{{otp}}`) renders empty with a warning. Validation reports
  unknown names as `unknown_variable`.
- A rendered URL starting with `/` gets `app.origin` in front.
- `GET /api/storyboard-schema` returns the variable list, the JSON Schemas (`LoginRecipe`, `DataEntry`, `DataSet`,
  `Actor`, `Step`, `Storyboard`, `Bundle`, `PageSnapshot`), the field kinds and the step kinds.

### AF.7 Storyboard API, validation and bundles

`/api/projects/<p>/storyboards`:

| Call | |
|---|---|
| `GET ?tag=` | briefs: `{id, slug, name, description, tags, version, steps, actors, updatedAt, lastWalkthrough?}` |
| `GET /<slug>` | the storyboard with step ids, `version`, `refs {dataSets, roles, vars}` and `warnings` (it is re-validated on read: data sets and users can change after the save) |
| `PUT /<slug>` | upsert; 400 with every issue when invalid; warnings in the response |
| `DELETE /<slug>` | walkthroughs keep their copy of the steps |
| `POST /validate` | `{storyboard}` or `{slug}` → `{ok, errors, warnings, refs}`, always 200 (dry run) |
| `POST /<slug>/duplicate` | `{slug, name?}` |
| `GET /export?storyboards=a,b&secrets=1` | a bundle |
| `POST /import` | `{bundle, mode?: "upsert" \| "create-only" \| "replace", dryRun?}` |

Login recipes: `GET /login-recipes`, `GET` / `PUT` / `DELETE /login-recipes/<role>`. Discovery:
`GET /api/storyboards/match?origin=<origin>` → `{origin, projects: [{slug, name, storyboards}]}` (what the extension
calls).

**Validation.** An invalid write answers `400 {error: "Storyboard is invalid (3 problems)", details: {errors,
warnings}}`. Every issue is listed as `{path, code, message, expected?}`, with paths such as `steps[3].dataSet`
(in bundles, `storyboards[0].steps[3].dataSet`; recipes `loginRecipes[<role>]`).

| Code | Severity | Meaning |
|---|---|---|
| `schema` | error | Wrong shape: a missing field, a bad type or pattern, a duplicate actor key / input name / entry key, a reserved slug (`export`, `import`, `validate`, `match`, `from-snapshot`). Reference checks run once the schema passes |
| `duplicate_step_id` | error | Two steps share an id |
| `unknown_actor` | error | `step.actor` is not an actor key |
| `missing_data_set` | error | A fill step's data set is neither in the project nor in the same bundle |
| `missing_login_recipe` | error | A login step's role (`recipe`, else the actor's role) has no recipe |
| `unknown_role` | warning | The actor role is not in the project roles and no test user has it |
| `missing_user` | error | A non-fresh actor's user ref matches no test user (or no user has the role) |
| `unknown_variable` | error | A `{{x}}` that is not a storyboard variable |
| `var_not_captured` | error | `{{vars.x}}` with no capture step and no input named `x` |
| `var_used_before_capture` | error | `{{vars.x}}` used on or before the step that captures it |
| `invalid_since` | error | An email step's `since` is not the id of an earlier step |
| `email_after_check` | warning | An email step directly follows a `check` step and has no `since`; name the step that sends the mail |
| `missing_authenticator` | error (warning for fresh actors) | A totp recipe's authenticator label does not exist, or there is none and the user has no linked key |
| `no_password` | warning | The project has no `defaultPassword` and a fresh actor is in the storyboard (it signs up with `Password123!`), or an actor that logs in has no password |
| `relative_url_no_origin` | warning | A `/path` URL while the project has no app origins |
| `no_app_origins` | warning | The project has no app origins |
| `masked_value` | warning | Import only: a data-set value is `"***"` and there is no stored value to keep |

**Bundles** move storyboards between projects and machines, and are the easiest way for an agent to build them:

```json
{ "format": "stubyard-storyboards", "version": 1,
  "project": { "appOrigins": ["http://localhost:3183"], "roles": ["admin", "participant"] },
  "users": [{ "email": "admin@classprovia.test", "name": "Class PROvia admin", "role": "admin" }],
  "loginRecipes": [ … ], "dataSets": [ … ], "storyboards": [ … ] }
```

- Import validates the whole bundle first (references are satisfied by the project plus the bundle), then writes it
  in one transaction: project settings (origins and roles merged, `defaultPassword` replaced), users by email,
  recipes by role, data sets by slug, storyboards by slug. A failure rolls everything back.
- The answer is `{ok, dryRun, created, updated, unchanged, skipped, warnings}` (key lists per collection), or 400 with
  every issue. `dryRun` makes the same writes and rolls them back.
- `create-only` skips what exists; `replace` also deletes the project's recipes, data sets and storyboards that the
  bundle lacks.
- Export holds the named storyboards (default all) with the data sets, recipes and users they reference. Without
  `secrets=1`, literal values whose key or label looks secret (`password`, `secret`, `token`, `otp`, `pin`) are
  `"***"`, and user passwords and `defaultPassword` are left out. Re-importing a masked export keeps the stored values.
- A complete example: `docs/examples/classprovia-storyboards.json` in the stubyard repository.
- Project export / import (§K) also carries login recipes, data sets and storyboards (not walkthroughs or snapshots).

### AF.8 MCP tools

Connect once (`claude mcp add --transport http stubyard http://localhost:4000/mcp`), then:

1. `describe_storyboards` (no arguments): the ontology — objects, relations, build order, enums, template variables
   and validation codes with fixes. `describe_storyboards {object: "step.fill"}` returns one object's fields, JSON
   Schema, validation rules, an example and pitfalls. Objects: `project`, `role`, `loginRecipe`, `testUser`,
   `authenticator`, `storyboard`, `actor`, `input`, `step`, `step.open` … `step.check`, `dataSet`, `dataEntry`,
   `pageSnapshot`, `templateVariables`, `bundle`, `walkthrough`, `agentRun` (AF.11).
2. `storyboard_guide {topic?}`: markdown recipes. Topics: `business-flow`, `forms`, `login`, `email`, `variables`,
   `multi-step-forms`, `checklist`, `agent-run`.
3. Build, then `validate_storyboard` until `ok: true`.

| Area | Tools |
|---|---|
| Project | `set_app_origins {project, origins, roles?, email_domain?, default_password?}`, `upsert_test_user {project, email, name, role, phone?, password?, notes?}`, `list_authenticators` (labels and linked users, no secrets) |
| Login recipes | `upsert_login_recipe {project, recipe}`, `list_login_recipes`, `delete_login_recipe {project, role, force?}` |
| Data sets | `upsert_data_set {project, dataSet}`, `patch_data_set_entries {project, slug, upsert?, remove?, name?, description?, match?}`, `list_data_sets {project, url?}`, `get_data_set`, `delete_data_set {project, slug, force?}`, `preview_data_set {project, slug, storyboard?, actor?}` |
| Page snapshots | `save_page_snapshot {project, url, urlPattern?, title?, formId?, fields, note?}` (a `/path` URL gets the first app origin), `list_page_snapshots`, `get_page_snapshot`, `data_set_from_snapshot {project, snapshot, slug, name, values?, include?}` |
| Storyboards | `validate_storyboard {project, storyboard? \| slug?}`, `upsert_storyboard {project, storyboard}`, `list_storyboards {project, tag?}`, `get_storyboard`, `delete_storyboard` |
| Bundles | `import_storyboard_bundle {project, bundle, mode?, dry_run?}`, `export_storyboard_bundle {project, storyboards?, include_secrets?}` |
| Results (read-only) | `list_walkthroughs {project, storyboard?, status?, mode?, executor?}` (`mode`: `tracked` default, `quick`, `all`; `executor`: `human` or `agent`), `get_walkthrough_result {project, id}` (the summary, no images) |
| Agent runs | `start_walkthrough`, `resolve_step`, `report_step`, `finish_walkthrough` (AF.11) |
| Playwright export | `export_storyboard_playwright {project, storyboard}` (AF.12) |
| Recordings | `list_walkthrough_recordings {project, id}` (read-only), `delete_walkthrough_recording {project, id}` (destructive), AF.10 |

- Every tool takes `project`. `bundle`, `storyboard`, `recipe` and `dataSet` may also be passed as JSON text.
- Upserts are idempotent and return `status: "created" | "updated" | "unchanged"`, so a build script can be re-run.
  `data_set_from_snapshot` returns `status: "exists"` and changes nothing when the slug is taken.
- A 4xx answer comes back as `stubyard answered 400: <error>` followed by the `{errors, warnings}` JSON, so every
  path is visible.
- Never put real passwords in a bundle: staff use their stubyard test-user password; fresh users get the project
  `defaultPassword`. Use `{{unique}}` in every value the app needs to be unique (data is not reset between
  walkthroughs).

### AF.9 Walkthroughs and the Chrome extension

**Install the extension** (unpacked; it is not in the Chrome Web Store):

```bash
./scripts/npm.sh run build -w @stubyard/extension      # → packages/extension/dist
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/dist`. Click the stubyard icon
to open the side panel.

- It has the `<all_urls>` host permission (since extension 0.1.1): `chrome.tabs.captureVisibleTab`, used for step
  screenshots, needs it, because `activeTab` is lost when the page navigates. Any stubyard URL or app origin works.
- The stubyard URL (default `http://localhost:4000`) and the sign-off name are set in the panel's Settings.
- The project is found by the tab's origin (`settings.appOrigins`); with no match the panel offers a project list and
  **Add this origin to project**.
- **Alt+Shift+F** fills the current form (from the open fill step, or the data set selected in Page data); when the
  on-page widget shows the step, the widget does it. **Alt+Shift+W** folds, opens or re-shows the widget.
- **On-page step widget** (extension 0.4.0): while a walkthrough is open, the run's origin and the project's
  `appOrigins` (top frame only) show a card with the current step, its actions and Done / Skip / Fail / note /
  screenshot / Next (quick runs: Next and Finish), plus login with 2FA and the email wait. It is a view of the same
  walkthrough as the panel, so `appOrigins` also decides where it shows. Logins, form fills and 2FA codes are filled
  only on those origins. No API change: the 2FA and email waits are kept in the step's data as `twoFactorPending` /
  `emailWaitPending` (written by the extension, null once the wait ended), which agents reading walkthrough results
  may see. The widget settings (`widgetHiddenOrigins`, positions) are local to the extension.
- **Page data** works without a walkthrough: scan the page, compare it with the matching data set, fill from a data
  set, save the page as a data set, send it to stubyard as a snapshot, copy the JSON.

**API guard.** Write calls from the extension carry `Origin: chrome-extension://<id>`. stubyard accepts them by
default; `STUBYARD_EXTENSION_ORIGINS` (comma-separated) pins them to one extension id
(`chrome-extension://abcd…`), and an empty value turns the exception off. Web pages are still refused.

**Walkthrough API** (`/api/projects/<p>/walkthroughs`; `<id>` also accepts the key):

| Call | |
|---|---|
| `POST` | `{storyboard, origin?, label?, vars?, actors?: {actorKey: userRef}, mode?: tracked \| quick}` → 201 view. `mode` defaults to `tracked` (not the storyboard's `preferredMode`); any other value → 400. Missing required inputs → 400. Creates the fresh users |
| `GET ?storyboard=&status=&mode=&limit=50` | briefs. `mode`: `tracked` (default), `quick` or `all`; quick test runs are left out unless asked for |
| `GET /<id>` | the view: steps with status, note, data and shots; actors; vars; counts; sign-off |
| `PATCH /<id>` | `{label?, vars?: {name: value \| null}, currentStepId?, origin?}` |
| `POST /<id>/steps/<stepId>/resolve` | the step ready to run: rendered URL and `text`, actor, and per kind: login (username, password, selectors, `twoFactor` with a `codePath` or `waitPath`), fill (rendered entries), email (`waitPath`, subject, link pattern), capture, check. Marks the step active |
| `PATCH /<id>/steps/<stepId>` | `{status?: pending \| done \| skipped \| failed, note?, data?, value?}`; `value` sets a capture step's var |
| `POST /<id>/steps/<stepId>/shots` | `{dataUrl}` (JPEG or PNG) → 201 `{id, bytes}`; at most 600 KB each, 40 per walkthrough, 50 MB per project (413 above); 409 on a quick test run |
| `GET` / `DELETE /<id>/shots/<shotId>` | one screenshot |
| `POST /<id>/refresh` | take the current storyboard's steps (results kept by step id) |
| `POST /<id>/finish` | `{verdict: pass \| fail \| partial, signedOffBy, note?, allowIncomplete?}`; 409 while required steps are open, unless `allowIncomplete` (they become `skipped`, "not run"). Quick test runs: `{}` is enough (verdict null, signedOffBy `''`) and open steps are always skipped |
| `POST /<id>/abandon`, `POST /<id>/reopen` | reopen clears the sign-off; 409 "Its test data was cleaned up; start a new run" once the run's cleanup is `cleaned` |
| `GET /<id>/summary` | steps, notes, data, vars, actors (passwords `***`), sign-off, duration |
| `GET /<id>/summary.html` | printable report with the screenshots inline |
| `DELETE /<id>?users=1&force=1` | a run with `cleanupStatus: "pending"` answers 409 "has test data to clean up: use Clean up, ?users=1, or ?force=1" unless `users=1` or `force=1`. `users=1` also deletes the fresh users it created, with their messages, by the cleanup rules (Keep-pinned users stay); a user other runs still need answers 409 listing them (`details.kept`) unless `force=1` (they then stay). `force=1` alone deletes the record and leaves the data. → `{deleted, users, kept: [{userId, email, reason, usedBy?}]}` |
| `GET /<id>/cleanup` | the run's cleanup item (any status; an active run gets a warning) |
| `POST /<id>/cleanup/dismiss` | `{note?}`: leave the data; the run leaves the pending list. 409 while active, once cleaned, or when the run created nothing (`none`) |
| `POST /<id>/cleanup/reopen` | dismissed → pending; 409 otherwise |

- The view and brief carry `mode`: `tracked` or `quick`.
- **Quick test runs** (`mode: "quick"`): the same steps, resolve and step `PATCH` as a tracked run (the extension marks
  steps done to move `currentStepId` on), with fill, login, email links, captured vars and fresh users. No screenshots
  (409), no sign-off needed to finish, not in the default list nor in the storyboard's `lastWalkthrough`. Nothing
  deletes them automatically: they show up in the Cleanup list, and cleaning one up removes its fresh users, their
  messages and the run record itself (the record stays, `cleaned` and still hidden from the list, while a Keep-pinned
  user of it remains). Summary and report work until then.
- `POST` (start) also takes `uses?: string[]`: ids or keys (at most 20) of earlier walkthroughs whose captured values
  this run reuses; an unknown one → 400 naming it.
- Resolve, step changes, refresh, finish and abandon need an active walkthrough (409 otherwise; reopen first).
- The email step waits for messages since the previous non-check step started (or its `since` step), so a mail the
  app sent during that step is found, also with a `check` step in between.
- Events: `storyboards.changed` and `walkthrough.changed` on the live stream (§10); the dashboard and the panel follow
  each other.
- Project reset deletes walkthroughs, their screenshots and page snapshots; storyboards, data sets, recipes and the
  users fresh actors created stay. Retention removes finished and abandoned walkthroughs and old snapshots, except
  runs whose test data is still to clean up (`cleanupStatus: "pending"`).

#### Cleaning up test data

A walkthrough leaves test data behind: the **fresh users** it created and the **messages** sent to them (emails, SMS,
WhatsApp and the codes in them). Nothing is removed automatically. The human presses **Clean up** in the side panel
(Home → "Clean up · N", or "Clean up this run" after a run) or on the dashboard's Storyboards page.

- **Tracked runs** keep their record and evidence (steps, notes, screenshots, sign-off); only the test data goes.
  **Quick runs** lose their record too, once none of their users remains (a Keep-pinned user keeps the record, as
  `cleaned`, so un-pinning it can reopen the run).
- **Captured vars** are only listed ("values in your app, not removed by stubyard"). They usually identify records the
  run created inside the app under test; removing those is up to that app.
- The view and brief carry `cleanupStatus`: `none` (nothing created), `pending` (data still there; set as soon as a
  fresh user is created), `cleaned` (every created user removed, already gone or Keep-pinned) or `dismissed` (left in
  place on purpose; reopen brings it back), plus `cleanupAt`. A pending run with no existing, non-Keep user left is set
  to `cleaned` by itself (when listed or previewed, after `DELETE /users/<id>` or a Keep pin, and at startup);
  un-pinning a user (`keep: false`) sets its cleaned run back to `pending`. A cleaned run cannot be reopened.
- **Dependencies.** A run that reuses another run's data depends on it:
  - automatically, when one of its actors resolves to the other run's fresh user (an `actors` override, a `user` ref
    or a role);
  - by declaration, with `uses: [idOrKey]` at start, when it reuses values the other run captured (stubyard cannot see
    that). It then depends on all of that run's fresh users.
  A dependent still needs the data while it is active, or while its own cleanup is pending. A finished run that
  created nothing (`none`) does not block. Runs from before 0.14.0 get their actor dependencies at startup.
- **Keep pin.** `PATCH /users/<id> {keep: true}` (also on `POST /users`, in every user view and in project export /
  import) makes a user a shared fixture: cleanup and `DELETE ?users=1` never delete it.
- Fresh actors of one run get distinct names.

| Call (`/api/projects/<p>`) | |
|---|---|
| `GET /cleanup?status=pending\|cleaned\|dismissed\|all&mode=all\|quick\|tracked` | `{items, counts: {pending, active, cleaned, dismissed}, truncated}`; defaults pending and all; active runs are never items (`counts.active` = active runs with pending data); newest finished first; at most 500 items (`truncated: true` when cut) |
| `POST /cleanup` | `{walkthroughs: [idOrKey] (1–100), skipUsers?: [userId] (at most 500), onConflict?: ask \| keep \| include, dryRun?: boolean}` → `{dryRun, runs, conflicts, totals: {users, messages, records}}` |

Each item: `walkthrough` (id, key, label, status, mode, storyboard, cleanupStatus, cleanupAt, startedAt, finishedAt),
`users` (userId, name, email, role, `exists`, `keep`, `messages`, `usedBy`), `vars`, `uses`, `removable`
(`{users, messages, record}` a default cleanup would remove now), `warnings` and `lastReport`.

`POST /cleanup` rules:
- An unknown run → 404; an active one → 409 "Walkthrough K is still active: finish or abandon it first".
- It deletes the fresh users that exist, are not Keep-pinned and are not in `skipUsers`, with their messages (Mailpit
  copies included), in one transaction.
- A **conflict** is such a user still needed by a run outside the selection:
  - `ask` (default): 409 `{error, conflicts: [{userId, email, walkthrough, usedBy}], requestId}`, nothing changes. A
    `dryRun` returns 200 with the conflicts instead.
  - `keep`: those users stay (`kept[].reason: "used-by"`).
  - `include`: the non-active dependent runs are cleaned too, transitively (only through users this cleanup deletes:
    not Keep-pinned or skipped ones); active ones keep their users (`"used-by-active"`). A run that created nothing
    keeps its `none` status. Preview with `dryRun` and the same `onConflict` to see which runs and counts go.
- Each run in `runs` is `cleaned` (no created user left except Keep-pinned ones) or `partial` (it stays pending, with
  its report). `kept[].reason` is `keep`, `skipped`, `used-by` or `used-by-active`.
- `dryRun: true` computes the same answer and changes nothing: use it for a preview.
- Events: `walkthrough.changed {id, status, cleanup, deleted?}` per run and `user.changed {deleted}` per user.

From code, `@stubyard/client/walkthroughs` has `listCleanup`, `cleanupPreview`, `cleanupRuns` (`cleanupConflicts(err)`
reads a 409), `dismissCleanup` and `reopenCleanup`; `@stubyard/client/users` has `setUserKeep`.

Agents do not clean up: walkthroughs are the human's. When a storyboard reuses data from an earlier run, tell the
human to start it with `uses` (or pick that run's user as the actor), so cleanup warns before deleting shared data.

Dashboard: **Storyboards** in the project's Automate group, with tabs Storyboards (editor with live validation and a
JSON tab), Walkthroughs, Library (Data sets, Login recipes, Page snapshots: `?tab=library&lib=data-sets|recipes|snapshots`)
and Cleanup; **Import / export** is a header button (`?tab=bundle`). The old `?tab=data-sets|recipes|snapshots` URLs
still work. **App origins** is in **Settings → General**.

### AF.10 Walkthrough recording

The extension can record a walkthrough so the person reviewing it can watch what the tester did. Recording is for
humans: an agent turns it on for a storyboard, lists and deletes recordings, and never starts a capture itself.

**Turning it on (storyboard fields, `upsert_storyboard`, REST or a bundle)**

| Field | Default | |
|---|---|---|
| `record` | `off` | `dom`: page recording with rrweb (DOM changes, mouse, clicks, scrolling, typing). `video`: a WebM video of the tab |
| `recordMaskAllInputs` | `false` | strict masking: every input and **all page text** (the unmask list is ignored). The editor calls it "Mask all inputs and page text" |
| `recordPrivacy` | `{}` | `{unmaskSelectors?, maskSelectors?, maskTextSelectors?, blockSelectors?}`, CSS selector lists, at most 50 each |

- `unmaskSelectors`: inputs a reviewer needs to see in clear (every input is masked by default). Fields that look
  sensitive stay masked even when listed.
- `maskSelectors`: more inputs to treat as sensitive (masked in page recordings, dots in video).
- `maskTextSelectors`: page text to star (an account number, an API key shown on a settings page).
- `blockSelectors`: areas left out of the recording altogether.
- At their defaults these fields are left out of the content hash, so older storyboards keep their `version`.
- The editor has **Record** and the strict checkbox; it has no fields for `recordPrivacy` yet (use MCP, REST or a
  bundle).

**Per run.** `POST /walkthroughs` takes `record?: off | dom | video` (override) and `maskAllInputs?: boolean`
(strict for this run). Without `record`, a tracked run follows the storyboard and a quick test is not recorded. The
extension's Start screen has a **Recording** select (storyboard default, record the app pages, record a video of the tab, do not record); the client's
`startWalkthrough` passes both fields. There is no MCP tool that starts a walkthrough. A `video` run gets a
warning at start (`warnings` on the view).

**What is recorded.** Only the run's app pages: the run's origin and the project's `appOrigins`, top frame only, in
the window that has the run open. The side panel and the on-page widget never are. A page recording has one segment
per page load and one per resume after a pause; a video is one segment that goes on across page loads and pauses
while the tab shows a page outside the run. Step changes become markers (rrweb custom events with tag
`stubyard.step`, `{stepId}`; for video, `markers: [{at: ms into the video, stepId}]`).

**Video.** VP9 (else VP8) WebM, at most 1280 px wide, 8 fps, 500 kbps, no audio. Chrome allows tab capture only for a
tab the user invoked the extension on, so the tester starts it: starting the run from the side panel starts it, else
**Record video** in the run bar or the widget card, or **Alt+Shift+V**. It ends when the run ends, the tab closes or
the capture ends. Choose `video` only when a page replay is not good enough (canvas, charts, CSS-in-JS styling,
cross-origin iframes): a video shows what was on screen.

**Masking**

| | Page recording (`dom`) | Video |
|---|---|---|
| Input values | all masked (`*`) unless in `unmaskSelectors` | visible, except sensitive-looking fields |
| Sensitive-looking fields (below) | always masked, also when unmasked | dots on screen, also while typed by hand |
| Hidden inputs | not recorded | not visible anyway |
| contenteditable, `[data-stubyard-mask]`, `maskTextSelectors` | starred | **visible** |
| Other page text | starred only when it looks like a secret (below); all of it in strict mode | **visible** |
| `blockSelectors`, `[data-stubyard-block]` | left out | **visible** |
| Page URL | query values, fragments and token-like path segments become `*`, userinfo dropped | the segment URL likewise |

- Sensitive-looking fields: password type (also after a show-password toggle turned it into text, and a text input
  that replaced a removed password input), `-webkit-text-security`, short numeric code boxes, `autocomplete`
  `cc-*`, `one-time-code` or `*-password`, names, ids, labels or placeholders with password, secret, token, key, OTP,
  card, IBAN, CVV or expiry words, the run's `maskSelectors` (the password and 2FA selectors of its login recipes plus
  one-time-code and card inputs, merged with `recordPrivacy.maskSelectors`) and any field the extension filled with a
  secret.
- Text that looks like a secret: otpauth URLs, JWTs, provider API keys, base32 seeds, long hex, Luhn-valid card
  numbers, "key: value" labels, and values the extension typed as secrets.
- **Not masked, say so when you hand a recording on:**
  - Outside strict mode, page text in a format the patterns do not know (a customer number, an address, a secret
    with an unusual shape). Use `maskTextSelectors` or `recordMaskAllInputs` for apps that show personal data.
  - `href` / `src` URLs of the page's own links and images inside the recorded DOM (only the page URL is redacted).
  - In video: every field that does not look sensitive, and all page text, including what `maskTextSelectors` and
    `blockSelectors` cover.
  - A show-password toggle inside a shadow root or a same-origin iframe is not remembered (the field is still masked
    by its type).
  - Recordings stored before the privacy rules (development builds only) keep their stored URLs inside the events.

**Replay.** The dashboard plays a page recording in a sandboxed iframe on `GET …/recording/player`, a hub page whose
Content-Security-Policy is `default-src 'none'` with no script, connect, frame, media or object sources; images,
styles and fonts come only from `data:` and the run's app origins. A recording can therefore not run script or call
other sites when it is watched. Canvas drawings, video elements, cross-origin iframes and CSSOM rules added after
the snapshot (some CSS-in-JS libraries) may be missing or look different; the content script sees the DOM, not the
page's JS objects.

**REST** (`/api/projects/<p>/walkthroughs/<id>`; `<id>` also accepts the key)

| Call | |
|---|---|
| `GET /recording` | `{walkthrough: {id, key, status}, mode: off \| dom \| video, requested, maskAllInputs, maskAllText, paused, pausedAt, stopped, stoppedAt, maskSelectors, unmaskSelectors, maskTextSelectors, blockSelectors, segmentCount, bytes, maxBytes, segments}`; `stopped` is the reason recording stopped at a cap, `bytes` the stored bytes. Each segment: `no`, `kind` (`dom` \| `video`), `url`, `stepId`, `startedAt`, `endedAt`, `durationMs`, `events`, `bytes`, `rawBytes`, `status` (`recording` \| `complete` \| `cut`), and for video `mime` and `markers` |
| `PATCH /recording` | `{paused?, mode?: off \| dom \| video, maskAllInputs?}`: pause, resume, switch on (also clears a stop at the cap) or off for the rest of the run |
| `DELETE /recording` | removes every segment (steps, notes and screenshots stay); also clears a stop at the cap → `{deleted, bytes}` |
| `GET /recording/segments/<no>` | DOM: NDJSON, one rrweb event per line (gzip when accepted). Video: `video/webm`, Range requests (206, 416 past the end); the hub writes a Duration into the file when serving |
| `GET /recording/player` | the replay page the dashboard frames (see Replay) |
| `POST /recording/chunks` | the extension's upload (DOM events or `kind: "video"` WebM chunks, plus empty heartbeats every 2 s). 409 for a run that is not active or not recording that kind, 413 at a cap |

The walkthrough view and brief carry `recording` (the same state without segments). From code,
`@stubyard/client/walkthroughs` has `getRecording`, `setRecording`, `deleteRecording` and `getRecordingEvents` (which
reads the whole response; the dashboard streams).

**MCP**
- `list_walkthrough_recordings {project, id}` (read-only): the `GET /recording` answer. The events and video bytes are
  served only by REST for the dashboard.
- `delete_walkthrough_recording {project, id}` (destructive): ask the person first; it cannot be undone.

**Caps and retention** (project settings: `PATCH /api/projects/<p> {settings: {recordingMaxMb, recordingRetentionDays}}`, `null` back to the default)
- `recordingMaxMb`: per walkthrough, default 50 (MB stored: gzip for DOM, WebM bytes for video). At the cap the hub
  cuts the segment, sets `stopped` and answers 413; delete the recording or switch recording on again to record more.
  A video stops itself just before the cap.
- Also: 1000 segments per run, 32 MB uncompressed per DOM segment (the recorder then starts a new one), 10 ×
  `recordingMaxMb` uncompressed per walkthrough; a page whose snapshot is over 7 MB is not recorded (a note in the
  segment says so) and the next page records again. Pausing drops events after `pausedAt` (video: 8 s grace); a chunk
  after the run ended is refused, except a last flush of an existing segment within 15 s.
- `recordingRetentionDays`: recordings go this many days after their last segment ended (default 14; 0 keeps them).
  Project reset and deleting a walkthrough remove them too. They are not part of bundle or project export; the
  storyboard's `record` fields are.
- Typical sizes: page recording under 10 KB per minute on simple pages (more on pages with a large DOM, at every page
  load); video about 1 MB per minute on ordinary pages, 2.4 MB per minute on a page that animates all the time.

### AF.11 Agent runs

An agent can run a storyboard itself: it drives its own browser (Playwright MCP, Claude in Chrome, a Playwright
script) and stubyard stays the source of the steps, users, data, codes and evidence. Such a walkthrough has
`executor: "agent"` and the `runner` the agent named; the extension does not show it, and the dashboard marks it with
an **agent** badge (Walkthroughs has a Human / Agent filter). stubyard has no browser of its own.

Recipe (MCP):

```text
1. start_walkthrough {project, storyboard, inputs?: {event: "HCE27"}, label?, runner: {name: "playwright-mcp", version: "0.0.30"}}
   → key, actors (with passwords), steps, and `step`: the first step resolved
2. Do `step` in your browser, following step.todo: open `url`; login: fill `username` / `password` into `selectors`,
   then the 2FA code (twoFactor.code for totp; email / SMS codes: wait_for_message with twoFactor.wait);
   fill: every entries[].key → value; capture: read the value; check: verify `expect` / `assert`
3. report_step {project, walkthrough: key, step: step.step.id, status: "done" | "failed" | "skipped",
   note?, data?, value? (capture), screenshot? ("data:image/jpeg;base64,…", ≤ 600 KB)}  → `next`: the next step resolved
4. Email step: resolve_step {project, walkthrough, wait_seconds: 30} → message, code and link (the one the step opens)
5. Repeat 2–4 until `next` is null, then finish_walkthrough {project, walkthrough, verdict?, note?}
   (verdict default: fail when a step failed, partial when one was skipped or open, else pass;
   allowIncomplete: true when you stop early: open steps become skipped "not run")
6. get_walkthrough_result {project, id: key} for the summary; the person reviews it in the dashboard
```

- **Statuses** are the step statuses: `done`, `failed`, `skipped` (there is no separate "passed" or "blocked": report
  a blocked step as `failed` with the reason in `note`).
- **Verdict vs sign-off.** A person finishes a human run and signs it off in one go (`signedOffBy`). An agent's
  `finish_walkthrough` (REST: `POST …/finish {verdict, note?, allowIncomplete?}`, no `signedOffBy`, which is refused
  with 400) sets the run's verdict only: `signoff.verdictBy` is `"agent"`, `signedOffBy` and `signedOffAt` stay null.
  A person signs it off later in the dashboard (walkthrough drawer → Sign off; REST
  `POST …/walkthroughs/:id/signoff {signedOffBy, verdict?, note?}`: finished agent runs only, once; 409 otherwise),
  which sets `signedOffBy` and `verdictBy: "human"`. There is no MCP tool for the sign-off.
- **resolve_step** adds to the REST resolve (below): `todo` (one line: what to do), `report` (the report_step call),
  for a totp login `twoFactor.code` and `remaining`, for an email/SMS code login `twoFactor.wait` (the
  `wait_for_message` arguments), and for an email step `message` (`id`, `subject`, `otp`, `links`, `bodyText`),
  `code` and `link`; what arrived is recorded on the step (`data.messageId`, `subject`, `link`), as the extension does.
  Without `step` it resolves the current step; after the last one it answers `{done: true}`.
- **report_step** records the status first, then the screenshot (a failed upload is a warning, not an error; quick
  runs keep no screenshots), and returns `next` resolved without waiting for email.
- Recording is off for agent runs unless `record: "video"` (upload the video yourself, AF.10). Fresh actors are new
  users per run; clean them up like any run.
- **REST** is the same flow: `POST /api/projects/<p>/walkthroughs {storyboard, executor: "agent", runner: {name,
  version?}, vars?, label?, actors?, mode?}`, `POST …/:id/steps/:stepId/resolve`, `PATCH …/:id/steps/:stepId
  {status, note?, data?, value?}`, `POST …/:id/steps/:stepId/shots {dataUrl}`, `POST …/:id/finish {verdict}`.
  `GET …/walkthroughs?executor=agent|human` filters the list; views and briefs carry `executor` and `runner`.
  `@stubyard/client/walkthroughs`: `startAgentWalkthrough`, `resolveStep`, `reportStep` (status, screenshot, next step),
  `finishWalkthrough`, `signOffWalkthrough`.
- Permissions (Teams mode): the same as a human run, `walkthroughs.run` (admin, project admin, project manager,
  developer, QA; not designer or viewer).

### AF.12 Export a storyboard as a Playwright test

A storyboard someone walked once can become a CI test. The export is a TypeScript Playwright spec that runs the
storyboard as an agent run (AF.11): each run starts a walkthrough with runner `playwright-export`, so its results,
screenshots and verdict show in the dashboard like any agent run.

- **Get it**: `GET /api/projects/<p>/storyboards/<slug>/export?format=playwright` (`text/plain`, downloaded as
  `<slug>.spec.ts`; 404 for an unknown storyboard, 400 for another format), MCP `export_storyboard_playwright
  {project, storyboard}` (the same text), or the dashboard: storyboard editor → ⋯ → **Export as Playwright test** (the
  saved version). Same access as reading the storyboard. (`GET …/storyboards/export` stays the bundle export, AF.7.)
- **Run it**: `npm i -D @playwright/test http://localhost:4000/api/client.tgz`, then
  `STUBYARD_URL=http://localhost:4000 APP_URL=http://localhost:3183 npx playwright test <slug>.spec.ts`. Env:
  `STUBYARD_URL` (default the hub's URL at export), `STUBYARD_TOKEN` (an API token when sign-in is on), `APP_URL`
  (default the project's first app origin), `STUBYARD_INPUT_<NAME>` for storyboard inputs (`regNo` →
  `STUBYARD_INPUT_REG_NO`; default the input's default). stubyard ships no browser: Playwright and Chromium are the
  app repo's or CI's.
- **How it works**: one `test.step` per storyboard step, addressed by step id. Each step calls `resolveStep` (the hub
  renders data sets, fresh users, vars, TOTP codes and email waits at run time; nothing is baked into the file), runs
  the Playwright code for its kind, takes a JPEG screenshot and calls `reportStep` (`done`, `skipped`, or `failed` with
  the error). `finishWalkthrough` runs in `finally` with the verdict from the steps (fail / partial / pass,
  `allowIncomplete`, so steps that never ran become skipped). A step whose kind changed fails with "export the
  storyboard again"; changed titles, intents or data set values need no new export.

| Step kind | Generated code |
|---|---|
| `open` | `page.goto(r.url)` |
| `login` | fill `selectors.username` / `password`, click `submit` (or Enter), then the 2FA code: TOTP from the linked authenticator, email / SMS code waited for |
| `logout` | `page.goto(r.url)`; without a `logoutUrl`, clears cookies (`// TODO`) |
| `fill` | one line per data set entry by field kind: `fill` (text, date, otp), `selectOption` (select), `setChecked` (checkbox), `check` (radio, checkbox groups), a type check on the page (auto); Radix select / checkbox / radio get a best-effort click sequence with `// TODO`; `skip` entries are left out. Entries added to the data set later are filled by type. Never submits |
| `email` | waits for the message (`timeoutSec`, subject filter), opens the link (`link.pattern` / `index`) with `page.goto`, or types the code into `target.selector` when the step opens nothing |
| `capture` | reads `selector` (value, text or `attribute`) or the page text, applies `textPattern`, reports it as `value` (the hub stores the var) |
| `check` | `expect(page).toHaveURL` (urlMatches), `toBeVisible` (selector), `toContainText` (textPresent, ignoring case); no `assert`: `// TODO` and reported `skipped` |
| `instruction` | with `target.selector` / `target.text`: a click on it (`// TODO`, a guess); otherwise `// TODO: automate` and reported `skipped` |
| other | `// TODO` and reported `skipped` |

- Optional steps report their failure and the test goes on; any other failure stops the test (later steps become
  skipped "not run" at finish).
- A field the page does not show makes its fill step wait and fail: for wizard forms, delete the lines of the other
  pages' fields. Review every `// TODO` before the spec goes into CI.

### AF.13 Not supported

- File uploads, iframes, shadow DOM and `contenteditable` fields (reported as skipped or unmatched).
- Clicking buttons: fill never submits or clicks Next; the person does (an agent run does whatever it decides).
- Other browsers than Chrome (and Chromium-based browsers that load unpacked MV3 extensions).

---

## AG. Features board (project plan: features, tasks, subtasks)

### AG.1 What it is

A light plan per project: one **feature** per thing the app should do, with markdown details, images, a status, a
priority and an optional link to the storyboard that tests it, plus **tasks** with one level of **subtasks**. Use it
to read what is planned and to keep it up to date while you work (tick tasks, add the ones you discover). It is not a
project-management tool: no dates, estimates or sprints. Dashboard: Project → Features (`/p/<p>/features`,
`?f=F-3` opens one).

| Object | Fields |
|---|---|
| Feature | `id`, `key` (`F-<number>`, per project, never reused), `title` (≤ 200), `details` (markdown, ≤ 100 000), `status` `idea`\|`planned`\|`in_progress`\|`done`, `priority` `none`\|`low`\|`medium`\|`high`, `position`, `storyboard` (`{id, slug, name}` or null), `progress` `{done, total}` (tasks and subtasks together), `imageCount`, `createdAt`, `updatedAt`; the full view adds `tasks` and `images` |
| Task | `id`, `parentTaskId` (null for a task, the task id for a subtask), `title`, `done`, `doneAt`, `note` (markdown, ≤ 4000), `assignee` (free text, ≤ 80), `position`, `subtasks` (tasks only) |
| Image | `id`, `name`, `mime`, `bytes`, `width`, `height`, `url`, `markdown` (`![name](image:<id>)`), `createdAt` |

A feature is addressed by id or key (`F-3`, `f-3` or `3`). Only two levels: a subtask cannot have subtasks.

### AG.2 REST

Base `/api/projects/<p>/features`. Errors are `{error, details?}` with 400 (validation), 404, 409 (limits), 413
(too large) or 415 (wrong image type).

| Call | What it does |
|---|---|
| `GET /` `?status=planned&q=text&full=1` | `{features, counts}`; briefs in board order (`full=1`: with details, tasks, images); `q` searches title, key, details and task title / note / assignee |
| `POST / {title, details?, status?, priority?, storyboard?, tasks?}` | create (201); `tasks`: `[{title, done?, note?, assignee?, subtasks?: [{…}]}]`; `storyboard` is a slug or id |
| `POST /reorder {ids}` | the given features take the board places they hold now, in the order given (`[b, a]` swaps two); `{features}` |
| `GET /<ref>` · `PATCH /<ref> {title?, details?, status?, priority?, storyboard?}` · `DELETE /<ref>` | read, change (`storyboard: null` or `""` unlinks), delete with tasks and images |
| `GET /<ref>/tasks` · `POST /<ref>/tasks {title, done?, note?, assignee?, parentTaskId?, position?, subtasks?}` | the task tree; add a task (or a subtask with `parentTaskId`); `{task, progress}` |
| `PATCH /<ref>/tasks/<taskId> {title?, done?, note?, assignee?, parentTaskId?}` | change or move (`parentTaskId: null` = top level; a task with subtasks cannot become a subtask) |
| `POST /<ref>/tasks/<taskId>/toggle {done?}` | set done (or flip it without a body) |
| `POST /<ref>/tasks/reorder {parentTaskId?, ids}` | new order of all siblings (all ids of that level); the feature |
| `DELETE /<ref>/tasks/<taskId>` | delete with its subtasks; `{deleted, subtasks}` |
| `GET /<ref>/images` · `DELETE /<ref>/images/<imageId>` | list, delete |
| `POST /<ref>/images?name=shot.png` with `content-type: image/png` and the raw bytes, or JSON `{dataUrl, name?}` | upload (201); the image with its `markdown` |
| `GET /<ref>/images/<imageId>` (`?download=1` as attachment) | the bytes with their own type, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` |
| `GET /api/features/reference` | statuses, priorities, limits, image types |

Every change sends the SSE event `features.changed` `{id, key, kind}` (§10).

```bash
P=http://localhost:4000/api/projects/my-app/features
curl -s -X POST $P -H 'content-type: application/json' \
  -d '{"title":"Saved cards","status":"planned","tasks":[{"title":"API","subtasks":[{"title":"Migration"}]},{"title":"UI"}]}'
curl -s -X POST "$P/F-1/images?name=mock.png" -H 'content-type: image/png' --data-binary @mock.png
curl -s -X PATCH $P/F-1 -H 'content-type: application/json' -d '{"status":"in_progress"}'
```

From code: `@stubyard/client/features` (`listFeatures`, `getFeature`, `createFeature`, `updateFeature`,
`deleteFeature`, `reorderFeatures`, `addTask`, `updateTask`, `toggleTask`, `deleteTask`, `reorderTasks`,
`addFeatureImage`, `listFeatureImages`, `deleteFeatureImage`).

### AG.3 MCP tools

| Tool | Arguments |
|---|---|
| `list_features` (read-only) | `{project, status?, q?}`: briefs with progress |
| `get_feature` (read-only) | `{project, feature}`: details, task tree, images |
| `upsert_feature` | `{project, feature?, title?, details?, status?, priority?, storyboard?, tasks?}`: without `feature` it creates (title required; `tasks` only here), with it it changes the given fields |
| `delete_feature` (destructive) | `{project, feature}` |
| `add_task` | `{project, feature, title, parent?, done?, note?, assignee?, subtasks?}` |
| `update_task` | `{project, feature, task, title?, done?, note?, assignee?, parent?}` (`parent: ""` = top level) |
| `delete_task` (destructive) | `{project, feature, task}` |
| `add_feature_image` | `{project, feature, data_url, name?}`: returns the id and the markdown to put into `details` |

Typical loop: `list_features {status: "in_progress"}` → `get_feature` → work → `update_task {done: true}` and
`add_task` for what you found → `upsert_feature {status: "done"}` when every task is done. Ask the person before
deleting.

### AG.4 Limits, export, reset

- Images: PNG, JPEG, WebP or GIF, checked from the bytes (SVG and other types get 415; a declared type that does
  not match the bytes too); at most 5 MB each (413), 20 per feature and 200 MB per project (409).
- 1000 features per project and 500 tasks and subtasks per feature (409).
- Keys are never reused: after deleting F-3 the next feature is still F-<highest + 1> or later.
- Deleting a storyboard keeps the features and unlinks them.
- Project export (§K) has a `features` section with tasks and images as data URLs; `GET …/export?images=0` leaves
  the images out (the export lists them under `imagesLeftOut`). Import recreates them with new ids, rewrites
  `image:<id>` references in the details, and links storyboards by slug (a warning when the storyboard is missing).
  `POST /api/projects/import` accepts bodies up to about 330 MB (the 200 MB image cap as base64 plus 64 MB), not the
  app-wide 25 MB limit of other routes.
- A project reset keeps the board (it is plan, not test data), like storyboards. Deleting the project deletes it.

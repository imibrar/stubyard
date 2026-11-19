# devhub — Instructions for AI Agents

You (the agent) have access to **devhub**, a local testing hub. While the app is in development, it stands in for real
email, SMS, WhatsApp, webhook and authenticator-app providers. Nothing is ever delivered to real people. Everything
the app sends is captured, attached to a **test user**, and **logged with its full request and response**.

Use devhub to:

- read verification emails, OTP codes and magic links the app sends, without a real mailbox;
- get authenticator-app (TOTP) 2FA codes, without a phone;
- see exactly what the app sent and what it got back, including errors;
- clean up test data after a test run.

---

## 0. Connection details (this machine)

devhub runs on a Linux server and is reached from this Windows PC through an **SSH tunnel** that the user keeps open.
Use these addresses, **not** the default ones (4000 / 4443 / 1025) that devhub's own setup pages show:

| What | Address on this PC |
|---|---|
| REST API + dashboard | `http://localhost:14000` (use this for API calls) |
| HTTPS | `https://localhost:14443` |
| SMTP (for the app) | host `localhost`, port **`11025`** |

```
DEVHUB = http://localhost:14000
```

**Check it's reachable before you start:**

```bash
curl -s http://localhost:14000/api/system
```

```powershell
Invoke-RestMethod http://localhost:14000/api/system
```

If this fails, **the tunnel is closed**. Do not try to install or start devhub. Ask the user to run:

```powershell
ssh -L 14000:localhost:4000 -L 14443:localhost:4443 -L 11025:localhost:1025 ibrar@ibrar-h270-gaming-3
```

…and keep that window open.

- The API needs no authentication and returns JSON.
- In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe`, or the `Invoke-RestMethod`
  examples below. `jq` may not be installed. The PowerShell examples don't need it.
- If the app runs **in Docker on this PC**, it reaches devhub at `host.docker.internal:14000` (SMTP `host.docker.internal:11025`).

---

## 1. What is available

| Feature | Status |
|---|---|
| Projects (one per app) with test users | ✅ |
| Email capture over SMTP → per-user inbox, OTP and link extraction | ✅ |
| Several email provider instances per project (e.g. transactional + marketing) | ✅ |
| Authenticator app (TOTP 2FA) codes | ✅ |
| Traffic log of every request (incl. 404s, bad JSON, rejected SMTP) | ✅ |
| HTTPS with a local certificate authority | ✅ |
| Cleanup: clear inbox, reset project, delete project | ✅ |
| SMS and WhatsApp simulators (Twilio, Vonage, Meta WhatsApp, Generic) with delivery reports and replies | ✅ (§C, §E at the end) |
| Scenario rules: fail next N, block for X min, provider down, 429, timeouts, email bounces | ✅ (§D) |
| Wait-for-message API, user lookup by role/email, test passwords | ✅ (§A, §B) |
| MCP server for AI agents at `http://localhost:14000/mcp` | ✅ (§F) |
| Webhooks, email APIs (SendGrid/Mailgun/SES), API mocks | 🚧 not built yet |

**Do not rely on 🚧 features.** Calls to `/hook/...` currently return a logged 404. If a task needs webhooks, email
APIs or API mocks, tell the user these are not available yet.

---

## 2. Concepts

- **Project**: one per application (e.g. `hyper`, `mkhdoom`, `fleet`), identified by its **slug**. The slug is the SMTP
  username. Each project automatically has an SMTP email instance called `mail`.
- **Test user**: a fake person in a project with an email, phone and WhatsApp number (e.g. an admin and some customers).
  Messages sent to a test user's address land in **their inbox**. Addresses are unique within a project.
- **Unassigned**: messages to addresses that match no test user.
- **Authenticator key**: a TOTP secret with a label. devhub returns its current 2FA code.
- **Traffic log**: one entry per request devhub received, with headers, bodies, status, timing and outcome.

**Before creating anything, list existing projects** (`GET /api/projects`) and reuse the one that matches the app.
Ask the user if unsure.

---

## 3. Configure the app to send email to devhub

| Setting | Value |
|---|---|
| SMTP host | `localhost` (or `host.docker.internal` if the app runs in Docker) |
| SMTP port | `11025` |
| Username | the project slug, e.g. `hyper` (or `hyper.marketing` for a second email instance) |
| Password | any value, e.g. `devhub` |
| Encryption / TLS | **none** |

Laravel `.env` example:

```dotenv
MAIL_MAILER=smtp
MAIL_HOST=localhost
MAIL_PORT=11025
MAIL_USERNAME=hyper
MAIL_PASSWORD=devhub
MAIL_ENCRYPTION=null
```

Node (nodemailer): `{ host: 'localhost', port: 11025, secure: false, auth: { user: 'hyper', pass: 'devhub' } }`.
Other frameworks: `GET /api/projects/<slug>/setup` returns snippets for each framework. **Replace port 1025 with 11025**
in them.

---

## 4. API reference (base `http://localhost:14000`)

### Projects

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects` | List with stats |
| POST | `/api/projects` | `{"name":"Hyper","slug":"hyper","generateUsers":{"admins":1,"customers":9}}` → 201. A duplicate slug returns 409 |
| GET | `/api/projects/{slug}` | |
| GET | `/api/projects/{slug}/overview` | Users (with unread counts), providers, authenticator keys |
| PATCH | `/api/projects/{slug}` | `{"name":…,"description":…,"settings":{"otpRegex":"…","phonePrefix":"+92300","emailDomain":"hyper.test"}}` |
| POST | `/api/projects/{slug}/reset` | Deletes messages, emails and logs. **Keeps** users, providers, keys and settings |
| DELETE | `/api/projects/{slug}` | Deletes everything. **Ask the user first** |

### Test users

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/{slug}/users` | |
| POST | `/api/projects/{slug}/users` | `{"name":"Sara","role":"customer","email":"sara@hyper.test","phone":"+923001112233"}` (whatsapp defaults to phone) |
| POST | `/api/projects/{slug}/users/generate` | `{"admins":0,"customers":5}`, e.g. `customer1@hyper.test` / `+923000000002` |
| PATCH / DELETE | `/api/projects/{slug}/users/{userId}` | |
| POST | `/api/projects/{slug}/users/{userId or "unassigned"}/clear` | Empty that inbox |
| POST | `/api/projects/{slug}/users/{userId or "unassigned"}/read` | Mark all read |

### Messages (inboxes)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/{slug}/messages` | Newest first. Filters: `user` (id or `unassigned`), `channel` (`email`), `provider` (instance slug), `since` (ISO time, inclusive), `q` (text in to/from/subject/body), `limit` (≤500), `before` (message id) |
| GET | `/api/messages/{id}` | Full message. `.mailpit.html` / `.mailpit.raw` are paths for the rendered HTML / raw source |

Each message includes `to`, `from`, `subject`, `bodyText`, **`otp`** (extracted code or null), **`links`** (all URLs),
`status`, `testUserId`, `providerInstanceId`, `logId` and `createdAt`.

### Email provider instances

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/{slug}/providers` | |
| POST | `/api/projects/{slug}/providers` | `{"preset":"smtp","slug":"marketing","name":"Marketing SMTP","labels":["marketing"]}` → app uses SMTP user `hyper.marketing` |
| PATCH / DELETE | `/api/projects/{slug}/providers/{instanceSlug}` | |

### Authenticator (TOTP 2FA)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects/{slug}/authenticators` | `{"label":"Admin 2FA","secret":"<base32 key or otpauth://totp/… link>","testUserId":"<optional>"}` |
| GET | `/api/projects/{slug}/authenticators/code?label=Admin%202FA` | `{"code":"166220","nextCode":"252703","remaining":17,"period":30,…}` |
| GET | `/api/projects/{slug}/authenticators` | All keys with current codes |
| GET | `/api/projects/{slug}/authenticators/{id}/code` | |
| GET | `/api/projects/{slug}/authenticators/{id}/secret` | Secret + `otpauth://` link |
| PATCH / DELETE | `/api/projects/{slug}/authenticators/{id}` | |

### Traffic log

| Method | Path | Notes |
|---|---|---|
| GET | `/api/logs` | Filters: `project` (slug, or `none` for requests that matched no project), `protocol` (`http`/`smtp`), `outcome`, `status`, `q`, `limit` |
| GET | `/api/logs/{logId}` | Full entry: headers, bodies, `errorMessage`, SMTP `transcript` |

Every HTTP response from devhub has an `X-Hub-Request-Id` header, which is the log id.

| `outcome` | Meaning |
|---|---|
| `ok` | Handled |
| `unmatched` | Wrong URL (404). `resolved.unknownProject` is set if the slug is wrong |
| `invalid` | Bad request, e.g. invalid JSON |
| `rejected` | Refused, e.g. SMTP username isn't a project slug (535), or the recipient can't be matched to a project (550) |
| `internal_error` | devhub bug. Tell the user |
| `pending` | Still in progress |

### Other

`GET /api/system` (status and ports) · `GET /api/ca.crt` (HTTPS CA certificate) · `GET /api/stream?project={slug}`
(live Server-Sent Events). Errors are `{"error":"…"}` with status 400 / 404 / 409 / 500.

---

## 5. Recipes

### Get the latest OTP / link sent to an address

```bash
curl -s "http://localhost:14000/api/projects/hyper/messages?q=admin@hyper.test&limit=1"
# read .[0].otp and .[0].links
```

```powershell
$m = Invoke-RestMethod "http://localhost:14000/api/projects/hyper/messages?q=admin@hyper.test&limit=1"
$m[0].otp
$m[0].links
```

### Wait for an email after triggering it

There is no blocking wait endpoint yet. Note the time **before** triggering, then poll:

```powershell
$since = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
# ... trigger the action in the app (sign-up, login, password reset) ...
$otp = $null
for ($i = 0; $i -lt 20 -and -not $otp; $i++) {
  $m = Invoke-RestMethod "http://localhost:14000/api/projects/hyper/messages?q=admin@hyper.test&since=$since&limit=1"
  if ($m.Count -gt 0) { $otp = $m[0].otp } else { Start-Sleep -Milliseconds 500 }
}
$otp
```

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# ... trigger ...
for i in $(seq 1 20); do
  OTP=$(curl -s "http://localhost:14000/api/projects/hyper/messages?q=admin@hyper.test&since=$SINCE&limit=1" | jq -r '.[0].otp // empty')
  [ -n "$OTP" ] && break; sleep 0.5
done; echo "$OTP"
```

If nothing arrives within about 10 s, go to "Debug" below.

### Get an authenticator (2FA) code

1. When the app shows its "scan this QR code" screen, take the secret key (shown under "can't scan?"), or the
   `otpauth://totp/...` link in the QR code.
2. Register it once:

```powershell
$body = @{ label = "Admin 2FA"; secret = "JBSW Y3DP EHPK 3PXP" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:14000/api/projects/hyper/authenticators -ContentType "application/json" -Body $body
```

3. Whenever a code is needed:

```powershell
$c = Invoke-RestMethod "http://localhost:14000/api/projects/hyper/authenticators/code?label=Admin%202FA"
if ($c.remaining -le 2) { Start-Sleep -Seconds ($c.remaining + 1); $c = Invoke-RestMethod "http://localhost:14000/api/projects/hyper/authenticators/code?label=Admin%202FA" }
$c.code
```

If `remaining` is 2 seconds or less, wait for the next code first. Otherwise the code may expire before the app
checks it.

### Set up a project for an app (only if none exists)

```powershell
$body = @{ name = "Hyper"; slug = "hyper"; generateUsers = @{ admins = 1; customers = 9 } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:14000/api/projects -ContentType "application/json" -Body $body
Invoke-RestMethod http://localhost:14000/api/projects/hyper/users | Select-Object role, email, phone
```

Use these test-user addresses in test data (sign-ups, logins), so messages land in a known inbox.

### Clean up before or after a test run

```powershell
Invoke-RestMethod -Method Post http://localhost:14000/api/projects/hyper/reset
```

### Debug "the app sent an email but it isn't in devhub"

1. `GET /api/logs?project=hyper&limit=10`: did devhub receive it? Check `outcome` and `errorMessage`.
2. `GET /api/logs?project=none&limit=10`: received but not matched to a project. Usually the SMTP username isn't
   the slug, or the app didn't authenticate and the recipient isn't a test user.
3. `GET /api/logs/{id}`: read `transcript` (the SMTP conversation) and `resStatus` (535 = bad username,
   550 = project unknown).
4. Nothing in the logs: the app isn't connecting. Check host `localhost`, port **11025**, no TLS, and that the tunnel
   is open (`/api/system`).
5. Message arrived but under **Unassigned** (`?user=unassigned`): the recipient isn't a test user. Use a test-user
   address, or add one with that email.

---

## 6. HTTPS (only if the app requires https)

devhub's certificate is signed by its own local CA, and the browser shows "Not secure" until the CA is trusted.
Download it: `curl.exe -o devhub-ca.crt http://localhost:14000/api/ca.crt`. The certificate is valid for `localhost`,
so `https://localhost:14443` works once the CA is trusted.

- Per process (preferred): `NODE_EXTRA_CA_CERTS=C:\path\devhub-ca.crt`, `REQUESTS_CA_BUNDLE`, or `curl.exe --cacert devhub-ca.crt`.
- System-wide on Windows (admin PowerShell):
  `Import-Certificate -FilePath .\devhub-ca.crt -CertStoreLocation Cert:\LocalMachine\Root`.
  This changes the user's machine, so **ask the user first**.

For API calls, plain `http://localhost:14000` is fine and needs no certificate.

---

## 7. Rules

1. Check devhub is reachable (`/api/system`) before relying on it. If it's not, ask the user to open the SSH tunnel.
   Don't try to install or run devhub yourself.
2. Use ports **14000 / 14443 / 11025** on this PC. Ignore 4000 / 4443 / 1025 in devhub's own screens.
3. Reuse the app's existing project. Don't create duplicates. Never delete a project, or trust the CA system-wide,
   without asking.
4. Read OTPs, links and 2FA codes from devhub. Never ask the user to check a real phone or mailbox.
5. When something is missing, check the traffic log before changing app code.
6. SMS, WhatsApp, webhooks and API mocks are not available yet. Say so rather than guessing.
7. Dashboard for the user: `http://localhost:14000` (Projects, test-user inboxes, Authenticator tab, Traffic log).

---

# Added in version 0.2
## A. Test users: roles, pins, passwords and references

- Users have a **role** (any text: `admin`, `sales`, `support`, `customer`, `driver`…), an optional **test password**
  (default from project settings, `Password123!`), and can be **pinned** to the dashboard sidebar.
- Anywhere the API takes a user, you can pass an **id, email, phone, exact name or role** (`admin` = first admin):

```bash
curl -s http://localhost:14000/api/projects/hyper/users/admin                       # one user + inbox counts + latest code
curl -s "http://localhost:14000/api/projects/hyper/users/sales1@hyper.test/latest?otp=1"   # → {"otp":"482913","link":…,"message":{…}}
curl -s "http://localhost:14000/api/projects/hyper/messages?user=admin&channel=sms&limit=5"
# Generate users per role (numbering continues; the first of each role is pinned, up to 4)
curl -s -X POST http://localhost:14000/api/projects/hyper/users/generate -H 'content-type: application/json' \
  -d '{"roles":[{"role":"admin","count":1},{"role":"sales","count":2},{"role":"customer","count":5}]}'
```

## B. Wait for a message (no polling)

`GET /api/projects/:p/messages/wait` blocks until a matching message arrives and returns it (HTTP 408 on timeout).
Filters: `user`, `to`, `channel`, `otp=1` (only messages with a code), `after=<messageId>`, `since=<ISO>`,
`timeout` (seconds, default 30, max 120). Without `after`/`since`, messages from the last 10 s also count, so a code
sent just before the call is not missed. Delayed deliveries count when they are delivered.

```bash
# trigger the login in the app, then:
curl -s "http://localhost:14000/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30" | jq -r .otp
```

Only messages the user actually **received** (status `delivered`) count for `otp=1` and "latest code";
rejected or failed attempts are ignored.

## C. SMS and WhatsApp simulators

Add a provider instance (dashboard → Providers, or the API), then point the app's SDK base URL at
`https://localhost:14443/mock/<project>/<instance>` (plain `http://localhost:14000/mock/…` works too). Supported presets:

| Preset | Endpoint the app calls (after the base URL) | Notes |
|---|---|---|
| `twilio` / `twilio-whatsapp` | `POST /2010-04-01/Accounts/<sid>/Messages.json` (form), `GET …/Messages/<sid>.json` | `whatsapp:` prefix = WhatsApp; callbacks signed with `X-Twilio-Signature` when `authToken` is set |
| `vonage` | `POST /sms/json` | Errors come back as HTTP 200 with `status` ≠ "0", like Vonage |
| `meta-whatsapp` | `POST /<version>/<phone-number-id>/messages` (JSON) | Text, template, interactive; webhooks signed with `X-Hub-Signature-256` when `appSecret` is set |
| `generic-sms` / `generic-whatsapp` | Any path (or `config.path`) | Field names and response/callback templates configurable |

```bash
curl -s -X POST http://localhost:14000/api/projects/hyper/providers -H 'content-type: application/json' -d '{
  "preset":"twilio","slug":"sms-primary","labels":["primary"],
  "config":{"statusCallbackUrl":"http://host.docker.internal:3000/webhooks/sms/status",
            "inboundUrl":"http://host.docker.internal:3000/webhooks/sms/inbound"}}'
```

> **This machine is special:** devhub runs on the Linux box `ibrar-h270-gaming-3`, the app runs on the Windows PC.
> Status callbacks and inbound replies are sent *from the Linux box*, so `localhost` / `host.docker.internal` in
> `statusCallbackUrl` / `inboundUrl` would point at the Linux box, not at the app. Use the Windows PC's LAN
> hostname or IP (e.g. `http://<windows-pc>:3000/webhooks/sms/status`; the app must listen on `0.0.0.0` and the
> Windows firewall must allow the port). If a callback fails, the traffic log shows it as `network_error`.
> Sending messages to devhub works through the SSH tunnel as usual.

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
curl -s -X POST http://localhost:14000/api/projects/hyper/users/customer1/rules -H 'content-type: application/json' \
  -d '{"channel":"sms","action":"fail","count":1,"errorCode":"30003","errorMessage":"Unreachable"}'
# Primary SMS provider down for 10 minutes (test the fallback)
curl -s -X POST http://localhost:14000/api/projects/hyper/providers/sms-primary/rules/preset/down-10m
# Presets: GET http://localhost:14000/api/rule-presets   ·  Back to normal:
curl -s -X DELETE http://localhost:14000/api/projects/hyper/users/customer1/rules
curl -s -X DELETE http://localhost:14000/api/projects/hyper/providers/sms-primary/rules
# One request only: header  X-Hub-Scenario: fail:30003:Unreachable   (or reject, rate_limit, delay:5000, timeout…)
```

Every message records the rule that handled it (`appliedRule`) and its outcome (`status`: delivered, failed,
rejected, dropped, scheduled, bounced, complained, timeout).

## E. Replies from test users (inbound SMS / WhatsApp)

```bash
curl -s -X POST http://localhost:14000/api/projects/hyper/users/customer1/reply -H 'content-type: application/json' \
  -d '{"channel":"sms","text":"STOP"}'      # optional "instance":"sms-primary"
```

devhub sends the provider's inbound webhook (Twilio form, Vonage JSON, Meta envelope…) to the instance's
`inboundUrl` (Meta: the webhook URL) and returns `{message, webhook:{ok,status,error,logId}}`.

## F. MCP server (tools for AI agents)

devhub speaks the Model Context Protocol at **`http://localhost:14000/mcp`** (Streamable HTTP). Add it once, e.g. in Claude Code:

```bash
claude mcp add --transport http devhub http://localhost:14000/mcp
```

Tools: `list_projects`, `list_test_users`, `get_latest_code`, `wait_for_message`, `get_messages`, `get_2fa_code`,
`set_user_scenario`, `reset_user_scenario`, `set_provider_rule`, `reset_provider_rules`, `reply_as_user`,
`get_traffic`, `get_request`, `clear_inbox`, `reset_project_data`. Prefer them over raw curl when available.

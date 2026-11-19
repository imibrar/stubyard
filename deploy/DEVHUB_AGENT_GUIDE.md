# devhub — Instructions for AI Agents

> **Note:** this file is a hand-made copy for the SSH-tunnel setup (ports 14000 / 14443 / 11025) and is no longer
> updated. devhub now serves the current guide itself, already rewritten for the address you use:
> `curl -s http://localhost:14000/api/agent-guide` (PowerShell: `Invoke-RestMethod http://localhost:14000/api/agent-guide`;
> through the tunnel the HTTPS / SMTP ports are derived as 14443 / 11025). Save it over this file to refresh it:
> `curl -s http://localhost:14000/api/agent-guide -o DEVHUB_AGENT_GUIDE.md`. Source: `docs/AGENT_GUIDE.md`.

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
| Webhooks (receive + send signed), email APIs (SendGrid/Mailgun/SES), API mocks, export/import, retention | ✅ (§G–§L at the end) |

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

---

# Added in version 0.3

## G. Webhooks (receive and send)

devhub both **receives** webhooks (inbound endpoints with JSON Schema checks) and **sends** them to your app
(templates with variables and signatures, sequences, replay). Every request in either direction is in the traffic log.

Dashboard: **Project → Webhooks** (tabs *Receive* and *Send*). Live updates come over the shared SSE stream
(`webhooks.changed`, plus `log.*` for hits/results).

### Receive: inbound endpoints

URL: `ANY http://localhost:14000/hook/<project>/<path>` (or `https://localhost:14443/...`).

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
`invalid` when validation fails (invalid JSON counts as a failure too). By default devhub still answers with the configured
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
curl -X POST localhost:14000/api/projects/hyper/webhook-endpoints -H 'content-type: application/json' -d '{
  "name": "Payments", "path": "payments/:id", "method": "POST",
  "schema": {"type":"object","required":["amount","currency"],
             "properties":{"amount":{"type":"number","minimum":0},"currency":{"enum":["USD","PKR"]}}},
  "response": {"status": 201, "body": "{\"ok\":true,\"id\":\"{{params.id}}\"}"}
}'

# hit it
curl -X POST localhost:14000/hook/hyper/payments/pay_1 -H 'content-type: application/json' -d '{"amount":10,"currency":"USD"}'

# recent hits (pass/fail + errors), newest first
curl localhost:14000/api/projects/hyper/webhook-endpoints/<id>/hits?limit=25
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
| `targetUrl` | Your app's webhook URL as reachable from devhub (`http://host.docker.internal:3000/...` when the app runs on the host). May contain variables. |
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
curl -X POST localhost:14000/api/projects/hyper/webhook-templates -H 'content-type: application/json' -d '{
  "name": "payment_intent.succeeded",
  "targetUrl": "http://host.docker.internal:3000/stripe/webhook",
  "bodyTemplate": "{\"id\":\"evt_{{uuid}}\",\"type\":\"payment_intent.succeeded\",\"data\":{\"object\":{\"amount\":{{data.amount}},\"receipt_email\":\"{{user.email}}\"}}}",
  "signing": {"preset": "stripe", "secret": "whsec_test"}
}'

# send now (optionally as a test user: id, email, phone, name or role) → outbound result + logId
curl -X POST localhost:14000/api/projects/hyper/webhook-templates/payment_intent.succeeded/send \
  -H 'content-type: application/json' -d '{"asUser": "customer1@hyper.test", "data": {"amount": 4200}}'
# → { ok, status, body, error, logId, request: {method,url,headers,body}, missing, warnings }

# render without sending
curl -X POST localhost:14000/api/projects/hyper/webhook-templates/payment_intent.succeeded/preview -d '{}' -H 'content-type: application/json'

# last results
curl localhost:14000/api/projects/hyper/webhook-templates/payment_intent.succeeded/results
```

Send results are in the traffic log as outbound entries with
`resolved = { template, templateId, signing, signedAt, user, userId, sequence?, step? }`.

### Sequences

A sequence is a list of steps `{ templateId (or template name), delayMs, repeat }`:

- `delayMs` — wait after the previous step (first step: after the run starts).
- `repeat` — send this step N times (1–20) back to back with the **identical payload** (same `{{uuid}}`, re-signed),
  to test duplicate delivery / idempotency.

Runs go through the durable scheduler (`scheduled_jobs`, type `webhook.sequence`), so they survive a devhub restart.
Each step is scheduled after the previous one was sent; timing granularity is the scheduler tick (~200 ms).

```bash
curl -X POST localhost:14000/api/projects/hyper/webhook-sequences -H 'content-type: application/json' -d '{
  "name": "pay flow",
  "steps": [
    {"template": "payment.pending", "delayMs": 0},
    {"template": "payment.success", "delayMs": 2000},
    {"template": "payment.success", "delayMs": 0, "repeat": 2}
  ]
}'
curl -X POST localhost:14000/api/projects/hyper/webhook-sequences/pay%20flow/run -H 'content-type: application/json' -d '{"asUser":"admin","data":{}}'
# → 202 { runId, sequence, steps: [{ step, template, repeat, atMs }] }
curl localhost:14000/api/projects/hyper/webhook-sequences/pay%20flow/results
```

A template used by a sequence cannot be deleted (409).

### Replay

`POST /api/logs/:id/replay` with optional `{ url, method, headers, body, resign }`:

- **Outbound** log (template send, status callback…): re-sent to the same URL by default.
- **Inbound** captured request (e.g. a `/hook/...` hit): re-sent to devhub's own URL by default (so it hits the endpoint
  again); pass `url` to forward it to your app instead.
- `headers` are merged into the captured ones (`null` removes a header). `body` replaces the body (objects are
  JSON-encoded). Captured bodies that were truncated must be passed explicitly.
- `resign` defaults to `true` when the original came from a signed template: the old signature header is removed and a
  new one is computed over the (possibly edited) body with a fresh timestamp. `resign: true` on anything else → 400.
- The new outbound log has `parentLogId` = the original, and `resolved.replayOf`, `resigned`, `edited`.

```bash
curl -X POST localhost:14000/api/logs/<logId>/replay -H 'content-type: application/json' -d '{}'
curl -X POST localhost:14000/api/logs/<logId>/replay -H 'content-type: application/json' \
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

Add an email provider instance with preset `sendgrid`, `mailgun`, `ses` or `generic-email` (dashboard → Providers, or
the API), then point the SDK's base URL at `https://localhost:14443/mock/<project>/<instance>` (plain
`http://localhost:14000/mock/…` works too). The setup guide (`GET /api/projects/<project>/setup`) shows ready-made snippets.

| Preset | Endpoint the app calls (after the base URL) | Success response | Events sent to `eventWebhookUrl` |
|---|---|---|---|
| `sendgrid` | `POST /v3/mail/send` (JSON) | `202`, empty body, `X-Message-Id` header (sandbox mode: `200`, not delivered) | JSON array of SendGrid events: `processed`, `delivered`, `deferred`, `bounce` (`type` bounce/blocked), `dropped`, `spamreport` |
| `mailgun` | `POST /v3/<domain>/messages` (multipart or urlencoded), `POST /v3/<domain>/messages.mime` | `200 {"id":"<…@domain>","message":"Queued. Thank you."}` (`o:testmode=yes`: not delivered) | `{"signature":{timestamp,token,signature},"event-data":{…}}`: `accepted`, `delivered`, `failed` (severity temporary/permanent), `complained` |
| `ses` | `POST /v2/email/outbound-emails` (JSON: Simple, Raw, Template) | `200 {"MessageId":"…"}` | SNS `Notification` envelope (`Message` = stringified SES event): `Delivery`, `Bounce`, `Complaint` (event-publishing format also `Send`, `DeliveryDelay`, `Reject`) |
| `generic-email` | Any path (or `config.path`) | `successTemplate` | `eventTemplate` with `{{event}}` = processed / delivered / deferred / bounced / dropped / complained |

```bash
curl -s -X POST http://localhost:14000/api/projects/hyper/providers -H 'content-type: application/json' -d '{
  "preset":"sendgrid","slug":"sendgrid","labels":["transactional"],
  "config":{"apiKey":"SG.devhub","eventWebhookUrl":"http://host.docker.internal:3000/webhooks/sendgrid"}}'
```

- Every accepted call becomes a real MIME email (built with nodemailer's MailComposer; SES Raw / Mailgun MIME are
  relayed as is) in Mailpit, tagged `X-Tags: project-<p>, instance-<i>` (+ up to 5 provider tags), and is captured per
  recipient (to, cc, bcc) as a normal email message: test-user inbox, OTP/link extraction, HTML view, attachments,
  `providerMessageId` = the provider's id (SendGrid X-Message-Id, Mailgun id, SES MessageId).
- Templates: devhub doesn't have your provider-side templates. SendGrid `template_id` + `dynamic_template_data`, Mailgun
  `template` + `t:variables`, SES `Template` (by name) are shown as text (`[SendGrid dynamic template d-123]` + `key: value`
  lines), so codes and links in the data are still extracted. Inline content (SES `TemplateContent`, SendGrid content
  with `{{var}}` / substitutions, Mailgun text/html with `t:variables`) is rendered with the data.
- Each event is in the traffic log (linked to the send call) and on the message (`metadata.reports`, shown in the viewer).
  Failed deliveries of events to your app (5xx / no answer) are retried.

#### Config fields (`provider_instances.config`)

| Preset | Key | Meaning |
|---|---|---|
| all | `eventWebhookUrl` | Where devhub POSTs events (SES: the HTTP endpoint subscribed to your SNS topic) |
| `sendgrid` | `apiKey` | Optional. When set, `Authorization: Bearer <key>` is required (else 401 like SendGrid) |
| `sendgrid` | `eventWebhookPrivateKey` | Optional ECDSA P-256 private key (PEM). Events then carry `X-Twilio-Email-Event-Webhook-Signature` (base64 DER ECDSA-SHA256 over `timestamp + body`) and `X-Twilio-Email-Event-Webhook-Timestamp`; verify with the matching public key. Create: `openssl ecparam -name prime256v1 -genkey -noout \| openssl pkcs8 -topk8 -nocrypt` |
| `mailgun` | `domain` | Optional. Other domains in the URL → `404 {"message":"Domain not found: …"}` |
| `mailgun` | `apiKey` | Optional. When set, HTTP Basic `api:<key>` is required (else `401 Forbidden`) |
| `mailgun` | `webhookSigningKey` | `signature = hex(HMAC-SHA256(key, timestamp + token))`. Defaults to `apiKey`, else `devhub-signing-key` |
| `ses` | `region` | Used in ARNs / Message-IDs (default `us-east-1`) |
| `ses` | `topicArn` | `TopicArn` in notifications (default `arn:aws:sns:<region>:123456789012:devhub-<instance>`) |
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
client.setDefaultRequest('baseUrl', 'https://localhost:14443/mock/hyper/sendgrid');

// Mailgun (mailgun.js)
const mg = new Mailgun(FormData).client({ username: 'api', key: process.env.MAILGUN_API_KEY, url: 'https://localhost:14443/mock/hyper/mailgun' });

// Amazon SES v2 (AWS SDK v3)
const ses = new SESv2Client({ region: 'us-east-1', endpoint: 'https://localhost:14443/mock/hyper/ses',
  credentials: { accessKeyId: 'devhub', secretAccessKey: 'devhub' } });
```

Python: `SendGridAPIClient(key, host=BASE)`, `boto3.client("sesv2", endpoint_url=BASE)`, Mailgun via `requests.post(BASE + "/v3/<domain>/messages", auth=("api", key), data=…)`.

```bash
curl -i -X POST http://localhost:14000/mock/hyper/sendgrid/v3/mail/send -H 'Authorization: Bearer SG.devhub' -H 'Content-Type: application/json' \
  -d '{"personalizations":[{"to":[{"email":"customer1@hyper.test"}]}],"from":{"email":"no-reply@hyper.app"},"subject":"Sign in","content":[{"type":"text/plain","value":"Your code is 123456"}]}'
curl -s --user 'api:key-devhub' http://localhost:14000/mock/hyper/mailgun/v3/mg.example.com/messages \
  -F from='no-reply@mg.example.com' -F to='customer1@hyper.test' -F subject='Sign in' -F text='Your code is 123456'
curl -s -X POST http://localhost:14000/mock/hyper/ses/v2/email/outbound-emails -H 'Content-Type: application/json' \
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

Rules are evaluated **per recipient** (to, cc, bcc), like SMTP's RCPT TO. `d` = event delay (`DEVHUB_CALLBACK_DELAY_MS`,
default 1.5 s); "processed" is sent at d/3.

| Action | HTTP answer | Status in devhub | Events (SendGrid · Mailgun · SES) |
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
`http://localhost:14000/mock/<project>/api` (or `https://localhost:14443/...`). Each request is checked against the
project's mocks **from top to bottom**. The first mock that matches answers with its **active scenario**.

```bash
curl -s -X POST http://localhost:14000/api/projects/hyper/mocks -H 'content-type: application/json' -d '{
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

curl -s -X POST http://localhost:14000/mock/hyper/api/payments/p_1/capture \
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
curl -s -X PATCH http://localhost:14000/api/projects/hyper/mocks/Payment%20API/active-scenario \
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
(`simulated_drop`). When **no mock matches**, devhub returns 404 with
`{"error":"Not found", "mocks":[{name, method, path, enabled, reason}]}`, where `reason` explains why each mock was
skipped (for example `path differs`, `method is POST`, `header "x-tenant" missing`). The 404 is logged as `unmatched`.

Dashboard: **API mocks** in the project sidebar (and in the Ctrl-K palette). It has the list in priority order, a
scenario switcher per mock, a copy-URL button, hit counts, recent hits (click a hit to open the log entry) and an editor.

---

### Export / import (§K) a project configuration

```bash
curl -s http://localhost:14000/api/projects/hyper/export > devhub-hyper.json            # without secrets
curl -s "http://localhost:14000/api/projects/hyper/export?secrets=1" > devhub-hyper.json # + authenticator keys
# ?download=1 adds Content-Disposition: attachment

curl -s -X POST http://localhost:14000/api/projects/import -H 'content-type: application/json' \
  -d "{\"json\": $(cat devhub-hyper.json), \"slug\": \"hyper2\", \"mode\": \"create\"}"
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
| `DEVHUB_LOG_RETENTION_DAYS` | `7` | Traffic logs older than this are deleted (`0` = keep forever). A project can override it with `settings.retentionDays`. |
| `DEVHUB_MAX_DB_MB` | `500` | When the live data in the database is larger than this, the **oldest logs are deleted first** (10 % per step) until it fits, then the file is compacted with `VACUUM`. `0` = no limit. |
| `DEVHUB_MAINTENANCE_INTERVAL_MS` | `600000` | How often the clean-up runs (first run 5 s after start). `0` = never. |

```bash
# Auto-reset: messages, emails and logs of this project older than N days are removed automatically
curl -s -X PATCH http://localhost:14000/api/projects/hyper -H 'content-type: application/json' \
  -d '{"settings":{"autoResetDays":3,"retentionDays":14}}'     # null switches either off

curl -s http://localhost:14000/api/system/storage          # DB size, row counts, retention config, last run, versions
curl -s -X POST http://localhost:14000/api/system/maintenance   # run the clean-up now → report

# "Reset all rules": every test user and provider instance goes back to normal delivery
curl -s -X POST http://localhost:14000/api/projects/hyper/rules/reset          # → {"deleted": 3}

# Factory reset: ALL projects, messages, Mailpit emails and logs. The HTTPS CA is kept.
curl -s -X POST http://localhost:14000/api/factory-reset -H 'content-type: application/json' \
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

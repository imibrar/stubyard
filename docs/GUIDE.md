# stubyard user guide

A tour of stubyard for people who are new to it: how the pieces fit together, then one short section per feature
with a "try it" walkthrough. Every section ends with a pointer into [AGENT_GUIDE.md](AGENT_GUIDE.md), the complete
reference (written for AI agents, but just as useful for people).

The examples use a project called `hyper` and the default ports. Replace them with your own.

Contents:

1. [How stubyard works](#1-how-stubyard-works)
2. [Messaging and inbound replies](#2-messaging-email-sms-whatsapp-and-inbound-replies)
3. [Auto-replies and AI personas](#3-auto-replies-and-ai-personas)
4. [Login providers and the authenticator](#4-login-providers-and-the-authenticator)
5. [File storage](#5-file-storage)
6. [Payments](#6-payments)
7. [API mocks and webhooks](#7-api-mocks-and-webhooks)
8. [LLM API mocks and record-to-mock](#8-llm-api-mocks-and-record-to-mock)
9. [AI chat](#9-ai-chat)
10. [Push notifications](#10-push-notifications)
11. [Test runs, HTML reports, clock offsets and scheduling](#11-test-runs-html-reports-clock-offsets-and-scheduling)
12. [Content checks](#12-content-checks)
13. [MCP tester](#13-mcp-tester)
14. [@stubyard/client](#14-stubyardclient)
15. [Storyboards and the Chrome extension](#15-storyboards-and-the-chrome-extension)
16. [FAQ and troubleshooting](#16-faq-and-troubleshooting)

---

## 1. How stubyard works

stubyard is **one Docker container** that pretends to be the outside services your app talks to: email, SMS and
WhatsApp providers, OAuth login providers, object storage, payment gateways, LLM APIs and push services. Your app keeps
its real SDKs; you only change the base URL (or SMTP host) so they talk to stubyard. Nothing is delivered to real
people, no real money moves, and everything is recorded.

```text
                       your app (unchanged SDKs, base URLs point at stubyard)
                                             │
         SMTP :1025 ─────────┬───────────────┼────────────────┬─────────── APNs HTTP/2 :2197
                             ▼               ▼ HTTP :4000 / HTTPS :4443
  ┌─────────────────────────────────────── stubyard ─────────────────────────────────────────┐
  │  /mock/<project>/<instance>   SMS, WhatsApp, email APIs     /auth/<project>/<provider>   │
  │  /mock/<project>/api/...      your own API mocks            /storage/<project>/<inst>    │
  │  /hook/<project>/...          webhooks you receive          /pay/<project>/<instance>    │
  │  /llm/<project>/openai|anthropic                            /push/<project>/<instance>   │
  │                                                                                          │
  │  projects → test users → inboxes (email, SMS, WhatsApp, push) with OTPs and links        │
  │  traffic log of every request in and out · rules that make things fail on purpose        │
  └──────────────────┬───────────────────────────────┬───────────────────────────────┬───────┘
                     ▼                               ▼                               ▼
          dashboard (browser)            REST control API /api/...          MCP server /mcp
          http://localhost:4000          (tests, CI, scripts)               (AI coding agents)
```

### The building blocks

| Concept | What it is |
|---|---|
| **Project** | One per application, identified by its slug (`hyper`). The slug appears in every URL and is the SMTP username. |
| **Test user** | A fake person in a project with an email, phone and WhatsApp number, and an inbox. Generated users look like `admin@hyper.test` / `customer1@hyper.test`. A message to their address lands in their inbox with the OTP and links extracted. Messages to unknown addresses go to **Unassigned**. |
| **Provider instance** | A simulated provider inside a project, such as `mail` (SMTP, created automatically), `sms-primary` (Twilio) or `stripe` (Stripe Checkout). A project can have several per channel, for example a primary and a fallback SMS provider. |
| **Rules / scenarios** | Make things fail on purpose: "the next SMS to customer1 fails", "the primary provider is down for 10 minutes", "the next payment is declined". One request can also be forced with the `X-Hub-Scenario` header. |
| **Traffic log** | One entry per request stubyard received or sent (HTTP and SMTP), with headers, bodies, status, timing and outcome. Every response carries `X-Hub-Request-Id`, the log id. |
| **Test run** | An isolated slice of a project for one test worker: its own minted users, rules, mock scenarios and report. |

### Three ways to drive it

- **Dashboard** at http://localhost:4000: projects, user inboxes, providers, traffic log, payments, chat and so on.
  Press Ctrl/⌘+K for the command palette. Each project has a **Connect your app** page with copy-paste settings.
- **REST control API** under `http://localhost:4000/api`: everything the dashboard does, as JSON. This is what tests and
  CI use. There is no login; the ports are bound to `127.0.0.1` and `/api` refuses calls from other web pages.
- **MCP server** at `http://localhost:4000/mcp` (streamable HTTP): tools for AI coding agents
  (`get_latest_code`, `wait_for_message`, `set_user_scenario`, `get_traffic`, …).
  Add it with `claude mcp add --transport http stubyard http://localhost:4000/mcp`.

### Ports

| Port | What |
|---|---|
| 4000 | Dashboard, REST API, `/mcp` and every provider endpoint over HTTP |
| 4443 | The same over HTTPS, with a certificate from stubyard's local CA |
| 1025 | SMTP: apps send email here |
| 2197 | APNs over HTTP/2 (`STUBYARD_APNS_PORT`, `0` turns it off) |

### Start it

```bash
docker run -d --name stubyard \
  -p 127.0.0.1:4000:4000 -p 127.0.0.1:4443:4443 -p 127.0.0.1:1025:1025 -p 127.0.0.1:2197:2197 \
  -v stubyard-data:/data --add-host=host.docker.internal:host-gateway \
  ghcr.io/imibrar/stubyard:0.14.0          # or :latest

curl -s http://localhost:4000/api/system   # {"name":"stubyard","version":"0.14.0",...} when ready
```

From a clone of the repository, `docker compose up -d --build` does the same (its data volume is the Docker volume
`devhub-data`, a name kept from before the rename).

### Reaching your app, and your app reaching stubyard

- App on your machine → stubyard: `localhost:4000` / `localhost:1025`.
- App in another container on the compose network → host `stubyard` (`http://stubyard:4000`, SMTP `stubyard:1025`).
- stubyard → your app (delivery reports, webhooks, inbound replies): use `http://host.docker.internal:<port>`, because
  `localhost` inside the container is stubyard itself. On Linux, start the app on `0.0.0.0` or use
  `deploy/docker-compose.host-network.yml`.
- `GET /api/projects/hyper/doctor` checks every callback URL from inside stubyard and explains failures.

### HTTPS and the local CA

stubyard creates its own certificate authority on first start and keeps it in the data volume. The certificate covers
`localhost`, `127.0.0.1`, `::1`, `stubyard` and `host.docker.internal` (add more with `STUBYARD_TLS_NAMES`).

```bash
curl -s -o stubyard-ca.crt http://localhost:4000/api/ca.crt
curl --cacert stubyard-ca.crt https://localhost:4443/api/system
```

Prefer per-process trust (`NODE_EXTRA_CA_CERTS=stubyard-ca.crt`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `curl --cacert`)
over trusting it system-wide. The dashboard's **HTTPS setup** page (`GET /api/https-guide`) has commands per OS and
language. Most features work over plain HTTP on 4000; some libraries (openid-client, MSAL, APNs clients) need HTTPS.

### Your first five minutes

1. Create a project with test users:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects -H 'content-type: application/json' \
     -d '{"name":"Hyper","slug":"hyper","generateUsers":{"admins":1,"customers":9}}'
   ```

2. Open http://localhost:4000, pick the project and open **Connect your app** for settings per framework.
3. Point your app's SMTP at `localhost:1025` with username `hyper` (any password), then trigger a sign-up.
4. Read the code back, from the dashboard or from a test:

   ```bash
   curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=customer1&otp=1&timeout=30" | jq -r .otp
   ```

5. If nothing arrived, open **Traffic** (or `GET /api/logs?project=hyper&limit=10`, then `?project=none`) to see
   what stubyard received and why it was refused.

Full reference: AGENT_GUIDE §2–§5, §8, §9, §F, §M.

---

## 2. Messaging (email, SMS, WhatsApp) and inbound replies

**What it is for:** capture every email, SMS and WhatsApp message your app sends, attach it to a test user, extract
the OTP and links, simulate delivery reports and failures, and send replies back to your app the way the real
provider would.

Supported: SMTP; SendGrid, Mailgun, Amazon SES and generic email APIs; Twilio (Messaging and Verify), Vonage (SMS and
Verify), Meta WhatsApp Cloud API, Twilio WhatsApp and configurable generic SMS / WhatsApp APIs.

**Try it**

1. Send an email over SMTP (any password; the username is the project slug):

   ```bash
   printf 'From: app@example.test\r\nTo: customer1@hyper.test\r\nSubject: Your login code\r\n\r\nYour verification code is 482913.\r\n' > mail.txt
   curl -s --url smtp://localhost:1025 --user hyper:x \
     --mail-from app@example.test --mail-rcpt customer1@hyper.test -T mail.txt
   ```

2. Add a Twilio instance with callback URLs for delivery reports and inbound replies:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/providers -H 'content-type: application/json' -d '{
     "preset":"twilio","slug":"sms-primary",
     "config":{"statusCallbackUrl":"http://host.docker.internal:3000/webhooks/sms/status",
               "inboundUrl":"http://host.docker.internal:3000/webhooks/sms/inbound"}}'
   ```

3. Point the Twilio SDK at `http://localhost:4000/mock/hyper/sms-primary` (or `https://localhost:4443/…`). The raw call
   looks like this:

   ```bash
   curl -s -X POST http://localhost:4000/mock/hyper/sms-primary/2010-04-01/Accounts/ACtest/Messages.json \
     -u ACtest:secret --data-urlencode "To=+923000000002" --data-urlencode "From=+15005550006" \
     --data-urlencode "Body=Your code is 551234"
   ```

4. Wait for the code (blocks until it arrives; HTTP 408 on timeout):

   ```bash
   curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=customer1&channel=sms&otp=1&timeout=30" | jq -r .otp
   ```

5. Make the next SMS fail, or reply as the user (stubyard posts the provider's inbound webhook to `inboundUrl`):

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/rules -H 'content-type: application/json' \
     -d '{"channel":"sms","action":"fail","count":1,"errorCode":"30003","errorMessage":"Unreachable"}'
   curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/reply -H 'content-type: application/json' \
     -d '{"channel":"sms","text":"STOP"}'
   ```

Good to know: rule actions include `fail`, `reject`, `rate_limit`, `timeout`, `delay`, `blocked` and email bounces;
`DELETE …/users/customer1/rules` puts the user back to normal. Replies by email (`"channel":"email"`) are
threaded and delivered as SendGrid Inbound Parse, Mailgun routes, SES or generic JSON. Twilio Verify and Vonage Verify
generate and check codes themselves. WhatsApp supports media, buttons, lists, read receipts and the 24-hour window.

Full reference: AGENT_GUIDE §6, §A–§E, §H, §P, §Q, §R.

---

## 3. Auto-replies and AI personas

**What it is for:** flows that wait for the user to answer. An **auto-reply rule** makes a test user answer by
template (echo the code, reply STOP or YES, tap the first WhatsApp button, out-of-office email). An **AI persona** is a
test user whose replies an LLM writes, for multi-turn conversations such as a support bot or a booking dialog.

**Try it: scripted auto-reply**

1. Make sure the SMS instance has an `inboundUrl` (section 2, step 2): replies are delivered there.
2. Create the rule:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/auto-replies -H 'content-type: application/json' -d '{
     "name": "Echo the login code", "channel": "sms",
     "match": { "hasOtp": true }, "reply": { "text": "{{otp}}" } }'
   ```

3. Your app sends "Your code is 482913" to a test user; that user replies "482913" through the provider's inbound
   webhook. The reply is in the user's timeline.
4. In tests, don't sleep through delays: `POST /api/projects/hyper/auto-replies/flush` sends pending replies now, and
   `POST …/auto-replies/fires/wait` waits for one. **Auto-replies → Try it** in the dashboard dry-runs a rule
   against a recent message.

**Try it: AI persona (no API key needed)**

1. Create a persona on the keyless `mock:openai` provider, which answers from the project's LLM mocks (section 8). Use
   a real provider (section 9) for genuinely model-written answers.

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/personas -H 'content-type: application/json' -d '{
     "name":"Pat","provider":"mock:openai","model":"gpt-5-mini","prompt":"Sends codes back.",
     "goals":[{"id":"code","text":"send the login code back"}]}'
   ```

2. Assign it to a user and channel:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/personas/pat/assign -H 'content-type: application/json' \
     -d '{"user":"customer1","channel":"sms","delaySeconds":0,"jitterSeconds":0}'
   ```

3. Your app writes to customer1; the persona answers in character and closes its goals with control lines such as
   `[[GOAL:code:reached]]`. Wait for it with `POST /api/projects/hyper/personas/threads/wait`.
4. Limits (replies, tokens, daily calls) keep cost bounded. A persona cannot call tools or click links.

Full reference: AGENT_GUIDE §AB (auto-replies), §AE (personas).

---

## 4. Login providers and the authenticator

**What it is for:** test "Sign in with Google / Microsoft / GitHub / Apple / …" without real accounts, and get
authenticator-app (TOTP) codes without a phone. The fake providers show an account picker listing your test users and
issue real-looking codes, RS256 id_tokens, access and refresh tokens.

Presets: Google, Microsoft, GitHub, Facebook, LinkedIn, Apple, X, Discord, GitLab, Slack and generic OIDC
(Auth0, Okta, Keycloak, Cognito flavours).

**Try it**

1. Add a login provider:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/auth -H 'content-type: application/json' -d '{"preset":"google"}'
   ```

2. Copy the URLs into your OAuth library: `GET /api/projects/hyper/auth/google` lists them for the browser and for
   backends, with framework snippets. The base is `https://localhost:4443/auth/hyper/google` and paths mirror Google's
   (discovery, `/o/oauth2/v2/auth`, `/token`, …), so you only change the host.
3. Click "Sign in with Google" in your app: the picker lists your test users. Pick one and the app gets the code.
4. For API tests, skip the browser:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/auth/google/token -H 'content-type: application/json' \
     -d '{"user":"customer1"}'      # access_token, id_token, refresh_token, claims
   ```

5. Authenticator codes: register the secret your app shows under "can't scan?" (or the `otpauth://` link), then read
   the current code:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/authenticators -H 'content-type: application/json' \
     -d '{"label":"Admin 2FA","secret":"JBSWY3DPEHPK3PXP"}'
   curl -s "http://localhost:4000/api/projects/hyper/authenticators/code?label=Admin%202FA"   # code, nextCode, remaining
   ```

Good to know: lax mode (default) accepts mistakes such as an unregistered `redirect_uri` but records them as warnings;
`config.strict: true` returns the real provider errors. Scenario rules simulate `access_denied`, `invalid_grant`,
`email_unverified`, bad id_token signatures and more. If `remaining` is 2 or less, wait for the next TOTP period.

Full reference: AGENT_GUIDE §O (login providers), §7 (authenticator).

---

## 5. File storage

**What it is for:** uploads and downloads without a cloud bucket. Files are kept on disk, shown in the dashboard's
file browser and logged (metadata only, never the bytes).

Presets: Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi, Google Cloud Storage, Azure
Blob, Cloudinary and Supabase Storage, each driven by the real SDK.

**Try it**

1. Add an S3 instance:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/storage -H 'content-type: application/json' \
     -d '{"preset":"s3","slug":"s3"}'
   ```

2. Point your SDK at it with path-style addressing (default credentials `stubyard` / `stubyard-secret`; MinIO uses
   `minioadmin` / `minioadmin`):

   ```js
   const s3 = new S3Client({ endpoint: 'http://localhost:4000/storage/hyper/s3', forcePathStyle: true, region: 'us-east-1',
     credentials: { accessKeyId: 'stubyard', secretAccessKey: 'stubyard-secret' } });
   ```

3. Upload something. Buckets are created on first write (with a warning, since real S3 would say `NoSuchBucket`).
   Plain curl works too: `curl -X PUT --data-binary 'hello' http://localhost:4000/storage/hyper/s3/uploads/hello.txt`.
4. Browse it under **Storage** in the dashboard. Presigned GET/PUT URLs, multipart uploads, Range, Copy and CORS work.
5. Make it fail: add `?hub_scenario=access_denied` to a URL, send `X-Hub-Scenario: slow_down`, or add a rule with
   `POST /api/projects/hyper/storage/s3/rules` (`quota_exceeded`, `expired_url`, `checksum_mismatch`, …).

Full reference: AGENT_GUIDE §S (S3 and compatibles), §T (Cloudinary, GCS, Azure, Supabase).

---

## 6. Payments

**What it is for:** run checkout flows end to end without a sandbox account. Each gateway has a hosted payment page
(realistic or classic, below) with test cards and outcome buttons, its browser SDKs, signed webhooks, refunds and
integration checks ("lint").

**14 gateways:** Stripe Checkout, PayPal (Orders v2, JS SDK Buttons / Card Fields, authorize/capture, Vault,
subscriptions and disputes), PayTabs, HyperPay, Moyasar, Tap, Tabby, Tamara, Checkout.com, Amazon Payment Services,
MyFatoorah, Geidea, JazzCash and Easypaisa. Payment methods include cards, 3-D Secure, mada, STC Pay, Apple Pay, KNET,
Benefit, buy-now-pay-later and wallets.

**Try it (Stripe Checkout)**

1. Add the gateway; the answer includes generated test keys and a ready `.env` block (`connect.env`):

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/payment-instances -H 'content-type: application/json' \
     -d '{"preset":"stripe-checkout","config":{"webhookUrl":"http://host.docker.internal:3000/webhooks/stripe"}}' \
     | jq .connect.env
   ```

2. Point the SDK at `http://localhost:4000/pay/hyper/stripe` (stripe-python: `stripe.api_base`; stripe-php `api_base`).
   Create a session the usual way:

   ```bash
   SK=$(curl -s "http://localhost:4000/api/projects/hyper/payment-instances/stripe?secrets=1" | jq -r .connect.env.STRIPE_SECRET_KEY)
   curl -s http://localhost:4000/pay/hyper/stripe/v1/checkout/sessions -H "Authorization: Bearer $SK" \
     -d mode=payment -d success_url=http://localhost:3000/ok -d cancel_url=http://localhost:3000/cancel \
     -d customer_email=customer1@hyper.test -d 'line_items[0][quantity]=1' \
     -d 'line_items[0][price_data][currency]=usd' -d 'line_items[0][price_data][unit_amount]=4200' \
     -d 'line_items[0][price_data][product_data][name]=T-shirt' | jq -r .url
   ```

3. Open the returned `url`: stubyard's hosted page looks like Stripe Checkout, with a card field (test cards only,
   e.g. `4242 4242 4242 4242` succeeds, `4000 0000 0000 9995` is insufficient funds), **Pay**, **Decline** and
   **Cancel**, and a Test controls drawer with the test-user picker and the other outcomes.
4. Without a browser, finish it from the API (rules still win):
   `POST /api/projects/hyper/payments/<id>/complete {"outcome":"success"}` (ids from `GET /api/projects/hyper/payments`).
5. stubyard redirects to `success_url` and sends `checkout.session.completed` and `payment_intent.succeeded`, signed with
   the instance `whsec_` secret, so `stripe.webhooks.constructEvent` works unchanged. Webhooks are retried after 5 s, 30 s and
   120 s if your app does not answer 2xx; `POST /api/projects/hyper/schedules/flush` fires pending ones immediately.
6. Force outcomes for the next payments:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/payment-rules -H 'content-type: application/json' \
     -d '{"outcome":"decline:insufficient_funds","instance":"stripe","count":2}'
   ```

**Realistic and classic payment pages.** Each payment provider's pages come in two views. The **realistic** view
looks and behaves like the provider's own checkout, in stubyard's neutral look: Stripe Checkout with its order summary
and a 3-D Secure pop-up, Checkout.com, PayTabs (also framed), Amazon Payment Services, Tap and MyFatoorah with their
method choice and simulated KNET / BENEFIT bank pages, Moyasar invoices, PayPal (log in, review, approve), Geidea,
HyperPay, Tabby and Tamara (phone, SMS code, plan, card), JazzCash and Easypaisa (mobile account, voucher, card).
stubyard's test shortcuts sit in a **Test controls** drawer; Pay, Decline and Cancel are always on the page. The
**classic** view is the original page with every test button in view. New providers start realistic; older ones stay
classic until you switch them under **Payments → Checkout pages** (one click per provider, which also shows how
closely each screen follows the real one). Return URLs, return parameters and webhooks are the same in both views,
so switching never changes what your app receives. Every page shows a "TEST · stubyard simulator · not a real
payment, no money moves" notice and a [TEST] title, works on phones and can be English or Arabic (right to left),
picked from the request's language or set per provider. Add `?ui=classic` or `?stubyard_lang=ar` to a page URL to
change one payment.

**Payment SDKs.** Front ends built on a provider's JavaScript SDK work too: load stubyard's script instead of the
provider's (the **Connect** panel lists the URLs, e.g. `STRIPE_JS_URL`) and keep your code. Covered: Stripe.js v3
(Payment and Card Elements with PaymentIntents, Embedded Checkout), PayPal Buttons, Card Fields and Pay Later
messages, Moyasar Form, Geidea Checkout (popup or drop-in), Checkout.com Flow, Tap Card SDK, MyFatoorah
`session.js`, PayTabs `paylib.js`, the APS Merchant Page, and the Tabby and Tamara promo widgets. They use the
provider's own function and callback names, show the TEST notice inside the component, and card numbers never reach
your page. If the provider's SDK talks to your app's origin, list that origin in the project's **App origins** (or the
instance's SDK origins). Each of these providers has a **Demo shop** (link on Payments → Checkout pages, or
`<instance>/demo`) to try it before wiring your app.

**PayPal subscriptions and disputes:** on a PayPal instance, your app uses the real Catalog Products, Billing Plans,
Subscriptions and Disputes v1 APIs. The buyer approves on stubyard's page; billing cycles run on a per-subscription
clock that you can move (`POST /api/projects/hyper/payments/subscriptions/<id>/advance {"by":"+30d"}`), so a year of
renewals takes a second. Open a dispute as the buyer from **Payments → Subscriptions & disputes** or
`POST /api/projects/hyper/payments/<payment>/dispute`.

Good to know: live keys (`sk_live_…`) and real card numbers are refused and flagged. **Payments → Integration checks**
lists problems such as a missing webhook URL, double capture or a PayPal signature that was never verified.

Full reference: AGENT_GUIDE §Z (Z.1–Z.7 basics, Z.8–Z.10 HyperPay and PayPal, Z.13–Z.19 the other gateways, Z.21
subscriptions and disputes, Z.22–Z.28 realistic pages and SDKs).

---

## 7. API mocks and webhooks

**What it is for:** mock any HTTP API your app calls (with switchable scenarios), receive webhooks with JSON Schema
checks, and send signed webhooks to your app.

**Try it: API mock**

1. Create a mock with scenarios. Your app's base URL becomes `http://localhost:4000/mock/hyper/api`:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/mocks -H 'content-type: application/json' -d '{
     "name": "Payment API", "method": "POST", "path": "/payments/:id/capture",
     "scenarios": [
       { "name": "OK",            "status": 200, "body": "{\"id\":\"{{params.id}}\",\"at\":\"{{now}}\"}" },
       { "name": "Card declined", "status": 402, "body": "{\"error\":\"card_declined\"}" },
       { "name": "Timeout",       "behaviour": "timeout" } ],
     "activeScenario": "OK" }'
   curl -s -X POST http://localhost:4000/mock/hyper/api/payments/p_1/capture
   ```

2. Switch the scenario live, no restart:

   ```bash
   curl -s -X PATCH http://localhost:4000/api/projects/hyper/mocks/Payment%20API/active-scenario \
     -H 'content-type: application/json' -d '{"scenario":"Card declined"}'
   ```

3. Or for one request only: header `X-Hub-Scenario: Timeout` (built-ins: `timeout`, `drop`, `503`, `delay:2000`).
   When no mock matches, the 404 explains why each mock was skipped.

**Try it: webhooks**

1. Receive: create an endpoint with a schema, then point the third party at `http://localhost:4000/hook/hyper/payments/<id>`:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/webhook-endpoints -H 'content-type: application/json' -d '{
     "name": "Payments", "path": "payments/:id", "method": "POST",
     "schema": {"type":"object","required":["amount","currency"]} }'
   ```

2. Send: create a signed template and send it as a test user:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/webhook-templates -H 'content-type: application/json' -d '{
     "name": "payment_intent.succeeded",
     "targetUrl": "http://host.docker.internal:3000/stripe/webhook",
     "bodyTemplate": "{\"id\":\"evt_{{uuid}}\",\"type\":\"payment_intent.succeeded\",\"data\":{\"object\":{\"amount\":{{data.amount}},\"receipt_email\":\"{{user.email}}\"}}}",
     "signing": {"preset": "stripe", "secret": "whsec_test"} }'
   curl -s -X POST http://localhost:4000/api/projects/hyper/webhook-templates/payment_intent.succeeded/send \
     -H 'content-type: application/json' -d '{"asUser": "customer1", "data": {"amount": 4200}}'
   ```

3. Chain templates into **sequences** (with delays and duplicate deliveries), **replay** any logged request
   (`POST /api/logs/<logId>/replay`, re-signed), and run the **webhook security check**
   (`POST …/webhook-templates/<id>/security-check`) to see whether your app accepts bad signatures, stale timestamps or
   replays.

Full reference: AGENT_GUIDE §J (API mocks), §G (webhooks), §U (security check).

---

## 8. LLM API mocks and record-to-mock

**What it is for:** test code that calls OpenAI or Anthropic without paying for (or waiting on) a real model. Every
project has a fake OpenAI API (chat completions, responses, embeddings) and a fake Anthropic API (messages), streaming
and non-streaming. Script replies and tool calls, inject faults, or record real answers once and replay them offline.

**Try it**

1. Point your SDK at the project (any API key works; it is never stored):

   ```bash
   OPENAI_BASE_URL=http://localhost:4000/llm/hyper/openai/v1
   ANTHROPIC_BASE_URL=http://localhost:4000/llm/hyper/anthropic      # Vercel AI SDK createAnthropic: add /v1
   ```

2. Script a reply:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/llm/mocks -H 'content-type: application/json' -d '{
     "name": "greeting", "match": { "lastUser": { "contains": "hello" } },
     "responses": [{ "text": "Hi! How can I help?" }] }'
   ```

3. Call it:

   ```bash
   curl -s http://localhost:4000/llm/hyper/openai/v1/chat/completions -H 'content-type: application/json' \
     -H 'authorization: Bearer sk-test' \
     -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"hello there"}]}' | jq .choices[0].message
   ```

4. Add faults: header `X-Hub-Scenario: rate_limit:2` for one request, or
   `POST /api/projects/hyper/llm/faults {"fault":"overloaded","times":2}` for the next calls (also `timeout`,
   `context_length`, `cut:4` to break a stream, …).
5. Record-to-mock: add a real provider under **System → AI providers**, start a recording
   (`POST /api/projects/hyper/llm/recordings {"provider":"<name>","mode":"new"}`); unanswered calls are forwarded once
   and saved as mocks, so later runs are offline and deterministic. Recordings stop by themselves after `maxCalls` or
   `ttlMinutes`.

Good to know: **LLM mocks → Calls** shows every call live, and **Mock this** turns a call into a mock. Embeddings need no
mock (deterministic vectors).

Full reference: AGENT_GUIDE §AA.

---

## 9. AI chat

**What it is for:** a small chat agent per project that talks to a model and calls stubyard's read-only tools plus
the tools of your own MCP servers (MCP tester targets). Use it to check by hand that your MCP server works with a real
model, and save prompts with deterministic expectations to re-run after each change.

**Try it**

1. Add a provider: set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY` or
   `STUBYARD_OLLAMA_URL` on the container, or add one under **System → AI providers** (keys are write-only). No key at
   all? Use the built-in `mock:openai` / `mock:anthropic` providers, which answer from the LLM mocks (section 8).
2. Create an agent:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/chat/agents -H 'content-type: application/json' \
     -d '{"name":"Support bot","provider":"mock:openai","model":"gpt-5-mini","tools":{"builtin":["list_test_users"]}}'
   ```

3. Open **Chat** in the project and talk to it. Tool calls show as cards with input and result; each reply shows
   model, tokens and time.
4. Save a prompt with expectations (`contains`, `toolCalled`, `maxSteps`, …) under **Chat → Saved prompts** and
   **Run all** after every change to your MCP server.
5. Compare models: the model matrix (`/p/hyper/chat/matrix`) runs one prompt against 2–6 models side by side.

Full reference: AGENT_GUIDE §Y (providers, agents, conversations, saved prompts), §AC (mock providers, model
matrix, save a tool call, Explain this).

---

## 10. Push notifications

**What it is for:** test pushes without Firebase or Apple. Your backend sends with its usual SDK; each push lands in the
inbox of the test user who owns the device token, where you can inspect it, "tap" it and wait for it from a test.

Supported: FCM HTTP v1 (service-account OAuth, topics, conditions, Instance ID) and APNs over HTTP/2 on port 2197
(ES256 provider tokens, documented reason codes).

**Try it (FCM)**

1. Add an instance and download its service account (its `token_uri` points at stubyard):

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/push/instances -H 'content-type: application/json' -d '{"preset":"fcm"}'
   curl -o sa.json http://localhost:4000/api/projects/hyper/push/instances/fcm/service-account.json
   ```

2. Register a device for a test user; stubyard returns a realistic token to store in your app:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/push/devices -H 'content-type: application/json' \
     -d '{"user":"customer1","platform":"android"}' | jq -r .token
   ```

3. Send from your backend. With Python's google-auth only the FCM base URL changes:

   ```python
   from google.oauth2 import service_account
   from google.auth.transport.requests import AuthorizedSession
   creds = service_account.Credentials.from_service_account_file("sa.json", scopes=["https://www.googleapis.com/auth/firebase.messaging"])
   AuthorizedSession(creds).post(
       f"http://localhost:4000/push/hyper/fcm/v1/projects/{creds.project_id}/messages:send",
       json={"message": {"token": device_token, "notification": {"title": "New message", "body": "Hi"}}})
   ```

   **Push → Connect** has snippets for Node (google-auth-library), firebase-admin (host mode) and curl.
4. Wait for it in a test:

   ```bash
   curl -s "http://localhost:4000/api/projects/hyper/push/notifications/wait?user=customer1&title=New%20message&timeout=10"
   ```

5. Make it fail: `POST /api/projects/hyper/push/faults {"fault":"unregistered"}` (also `bad_token`, `quota`, `auth`, …).

For APNs, add `{"preset":"apns","config":{"bundleIds":["com.acme.app"]}}`, use the generated `.p8` key, key id and team id,
and point the client at `localhost:2197` with the stubyard CA. Remember to publish port 2197.

Full reference: AGENT_GUIDE §AD.

---

## 11. Test runs, HTML reports, clock offsets and scheduling

**What it is for:** parallel test workers that don't trip over each other, a report per test run, "time travel" for
expiry tests, and actions that happen later.

**Try it: test runs**

1. Start a run per worker; it mints its own users:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/runs -H 'content-type: application/json' \
     -d '{"key":"w1","replace":true,"users":[{"role":"customer"}]}'
   # users[0].email is customer1.w1@hyper.test; urls.smtpUsername is hyper+w1
   ```

2. Use the minted users in the app. Everything sent to them belongs to the run. Requests can also be tagged with
   the `X-Hub-Run: w1` header or the URL prefix `/run/w1/…` (e.g. `http://localhost:4000/run/w1/mock/hyper/sms-primary`).
3. Add `?run=w1` to waits, rules and mock-scenario calls so they only affect this worker:
   `GET /api/projects/hyper/messages/wait?run=w1&user=customer&otp=1`.
4. Stop it and keep the report:

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/runs/w1/stop | jq .reportHtmlUrl
   curl -s -o run-w1.html "http://localhost:4000/api/projects/hyper/runs/w1/report.html?download=1"
   ```

   The HTML report is one self-contained page (messages, content checks, traffic problems, rules, storage); save it
   as a CI artifact. `stop?purge=1` also frees the run's data.

**Try it: clock offsets.** Shift stubyard's clock for one feature (`totp`, `auth`, `verify`, `webhooks`, `mocks`);
your app's clock is untouched:

```bash
curl -s -X PUT http://localhost:4000/api/projects/hyper/time -H 'content-type: application/json' -d '{"offsets":{"auth":"+2h"}}'
curl -s -X DELETE http://localhost:4000/api/projects/hyper/time        # clear all
```

Use it for "code expired", "token expired" or "webhook timestamp too old" without waiting. Add `?run=w1` to shift only
one run.

**Try it: scheduling.** Run an allowlisted API call later, once or on repeat (send a webhook, reply as a user, set a
rule, switch a mock scenario):

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/schedules -H 'content-type: application/json' -d '{
  "method": "POST", "path": "/users/customer1/reply", "body": {"channel": "sms", "text": "STOP"},
  "delaySeconds": 30, "label": "late STOP"}'
```

The **Scheduled** page lists pending actions, and the **Later ▾** buttons next to Send / Run create them from the UI.

Full reference: AGENT_GUIDE §N (runs), §X (HTML reports, clock offsets, client helpers), §W (scheduling).

---

## 12. Content checks

**What it is for:** catch embarrassing message bugs before users do. Every outbound email, SMS and WhatsApp message is
checked when it is captured: unrendered `{{placeholders}}`, leaked `undefined` / `NaN`, broken characters, links to
localhost or production, missing `List-Unsubscribe` on marketing email, SMS encoding that costs extra segments, empty
WhatsApp template parameters and more (20 checks).

**Try it**

1. Send any message from your app. Findings show as error / warning badges on the message and a **Content checks**
   list in the viewer.
2. Filter: `GET /api/projects/hyper/messages?lint=warn`; summary: `GET /api/projects/hyper/lint`.
3. Check text without sending it:

   ```bash
   curl -s -X POST "http://localhost:4000/api/lint/check?project=hyper" -H 'content-type: application/json' \
     -d '{"channel":"email","subject":"Hi {{name}}","text":"Hello undefined"}'
   ```

4. Tune it under **Project → Settings → Content checks** (turn off checks, list production domains).

Full reference: AGENT_GUIDE §U.

---

## 13. MCP tester

**What it is for:** test an MCP server you are building, like MCP Inspector but with stubyard as the client: list and
call tools, read resources, get prompts, see the full JSON-RPC log and run 20+ checks ("MCP lint"). Because stubyard's
server is the client, browser CORS and session headers are not a problem.

**Try it**

1. Open **project → MCP tester**, choose **stubyard (this server, demo)** and press **Connect** to see how it works.
2. Add your own server as a target (Streamable HTTP or legacy SSE). From inside Docker, reach a server on your
   machine at `http://host.docker.internal:<port>/mcp`. A stdio-only server needs a bridge such as supergateway.

   ```bash
   curl -s -X POST http://localhost:4000/api/projects/hyper/mcp-tester/connect -H 'content-type: application/json' \
     -d '{"url":"http://host.docker.internal:8000/mcp"}'
   ```

3. Call tools from generated forms; every message is in the **Log** tab and the traffic log.
4. Save calls with expectations (`contains`, `maxMs`, …) and **Run all** after each change. The same targets can be
   given to an AI chat agent (section 9).

Full reference: AGENT_GUIDE §V.

---

## 14. @stubyard/client

**What it is for:** TypeScript helpers for tests (Node 18+, Playwright, Vitest, Jest). It is not on npm yet: build it
with `npm run build -w @stubyard/client` in this repository and depend on the `packages/client` folder.

| Import | Helpers |
|---|---|
| `@stubyard/client/runs` | `startRun`, `withRun`, `stopRun`, `getRunReport`; a run handle has `user()`, `mint()`, `waitForMessage()`, `setTimeOffset()`, `report()`, `stop()` |
| `@stubyard/client/auth` | `loginAs` (skip the account picker in Playwright), `getTokens` |
| `@stubyard/client/storage` | `s3Config`, `waitForUpload`, `getFile`, `presign`, `setStorageScenario`, `emptyBucket` |
| `@stubyard/client/push` | `registerDevice`, `waitForPush`, `openPush`, `setPushFault`, `fcmServiceAccount`, `apnsConfig` |

**Try it**

```ts
import { withRun } from '@stubyard/client/runs';
import { loginAs } from '@stubyard/client/auth';

await withRun({ project: 'hyper', users: [{ role: 'customer' }] }, async (run) => {
  await page.setExtraHTTPHeaders(run.headers);                 // X-Hub-Run for app → stubyard calls
  const customer = run.user('customer');
  // … sign up as customer.email in the app …
  const msg = await run.waitForMessage({ user: customer.email!, channel: 'email' });
  await page.getByLabel('Code').fill(msg.otp!);
});                                                            // the run is stopped in finally

await loginAs(page.context(), { baseUrl: 'https://localhost:4443', project: 'hyper', provider: 'google', user: 'admin' });
```

`apiUrl` defaults to `http://localhost:4000`.

Full reference: AGENT_GUIDE §X (run helpers), §O (auth helper), §S (storage helper), §AD.5 (push helper).

---

## 15. Storyboards and the Chrome extension

**What it is for:** manual testing of whole business flows, done the same way every time. A **storyboard** is a flow
written as steps ("sign up as a new participant", "confirm the email", "log in as admin", "approve the registration",
"check the decision email"). The **stubyard Chrome extension** shows the steps in a side panel next to your app and
does the tedious parts: it opens pages, logs in as test users and fills the 2FA code, fills forms with fresh test data,
waits for emails and opens their links, notes values such as a registration number, and takes screenshots. Each run
through a storyboard is a **walkthrough**; you sign it off as pass, fail or partial and get a printable summary.

An AI agent can write the storyboards for you through MCP; you walk through them.

**Try it**

1. **Load the extension** (once; it is not in the Chrome Web Store):

   ```bash
   ./scripts/npm.sh run build -w @stubyard/extension
   ```

   Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick
   `packages/extension/dist`. Pin the stubyard icon; clicking it opens the side panel. After a rebuild, press the
   reload button on the extension's card.
2. **Tell stubyard where your app runs.** In **project → Settings**, add the app's origin under **App origins**, e.g.
   `http://localhost:3183`. The extension finds the project from the page you are on. (Or open your app, open the
   panel and press **Add this origin to project**.) If stubyard is not at `http://localhost:4000`, set the URL in the panel's
   Settings. The extension has access to all sites (`<all_urls>`), which Chrome requires for step screenshots.
3. **Let an agent build the storyboards.** Register stubyard as an MCP server in your coding agent, e.g. Claude Code:

   ```bash
   claude mcp add --transport http stubyard http://localhost:4000/mcp
   ```

   Then ask it something like "Using stubyard, call describe_storyboards and build a storyboard in project hyper for:
   a new customer signs up, confirms the email and places an order". The agent sets up login recipes (how each role
   logs in), data sets (what goes into each form) and the storyboard, and runs `validate_storyboard` until there are
   no problems. To get the exact field names of a form, open the page, choose **Page data** in the panel, press
   **Scan**, then **Send to stubyard**: the agent can read that snapshot.

   You can also write or edit storyboards yourself in **project → Storyboards** (the editor checks them as you type),
   or import a bundle file under **Import / export**.
4. **Walk through.** Open your app, open the panel, click the storyboard, check the actors and inputs, then
   press **Start tracked walkthrough** (or **Start quick test**, below). Fresh actors (a new participant, say) get a new test user for this walkthrough. For each step, read the intent, use the step's buttons
   (Go, Fill login, Fill form, Wait for message, Open link, Capture, Run assertion), then press **Done**, **Skip** or **Fail** and add
   a note or a **Screenshot** where it helps. Fill never clicks Next or Submit: you do, so you see what the app does.
   Everything is saved in stubyard as you go, so you can close the panel and **Continue** it later from Home. On Home, **▶ Quick** next to a storyboard starts a quick test at once when nothing needs choosing.
5. **Sign off.** On the last screen, choose the verdict, type your name and press **Sign off**. **Open printable
   report** shows every step with its notes, captured values and screenshots.
6. **Read the summary.** The walkthrough is listed in **project → Storyboards → Walkthroughs** with its steps, notes
   and screenshots. An agent reads it with `get_walkthrough_result`; scripts use
   `GET /api/projects/hyper/walkthroughs/<id>/summary`.

Tips:
- Data such as names and emails stays the same for the whole walkthrough, so pressing Fill twice is safe. `{{unique}}`
  (the walkthrough key) keeps sign-up emails and organisation names from clashing between runs.
- On a multi-page form, press **Fill form** on each page and click Next yourself; fields of other pages show as "not
  on this page".
- **Alt+Shift+F** fills the current form (the on-page card first, if it shows the step).

**On-page step widget**

While a walkthrough is open, your app's own pages (the run's address and the project's app origins, never inside
frames) show a small card with the current step, so you do not have to look away to the side panel. The card and the
panel show the same walkthrough and follow each other.

- **Doing the step:** the card has the step's buttons (Go, Highlight, Fill form, Capture, Run assertion) and records
  it (Done, Skip, Fail with a note, Screenshot, Next). A quick test gets **Next ✓** and **Finish**. Sign-off and
  **Clean up this run** stay in the side panel.
- **Logging in:** press **Fill login** in the card (or Alt+Shift+F), then click Log in yourself. If the app asks for a
  2FA code on the next page, the card fills it when the code field shows; click Verify yourself. The panel shows
  "Waiting for the 2FA code in the page widget" meanwhile; **Wait here instead** moves the wait to the panel.
- **Email steps:** press **Wait for message**. You can fold the card meanwhile; the round button gets an amber ring
  while it waits. Pick a link (the card lists 5; **Choose in panel** shows all of them) and press **Open link**.
- **Copy:** when the page blocks the clipboard, the copy button selects the text instead; press Ctrl+C.
- **Moving it:** drag the bar on top to another corner (arrow keys work too when the bar has focus; Home or a
  double-click puts it back). It remembers the place per site. Esc or **Alt+Shift+W** folds it into a round button
  that shows progress as a ring; click it to open it again. On a phone-sized window it is a sheet at the bottom.
- **Out of the way:** it moves by itself when it would cover the highlighted field or the page's Submit button. Once
  you move it yourself it stays where you put it. Inside a modal dialog of the app it shows above the dialog and works
  as usual.
- **When stubyard stops answering** the card says "stubyard is not reachable." and retries by itself (**Retry now**
  tries at once). Your last step stays on screen.
- **Turning it off:** × hides it on that tab; **Show on this tab** on the panel's Walkthrough screen brings it back for
  as long as the tab stays on that site. **Settings → On-page step widget** turns it off everywhere, hides it on chosen
  sites ("Hide on …", "Show again") or resets its position on this site or all sites.
- **Safety:** if the page hides or covers the card, its buttons do nothing and it says "Widget hidden by the page — use
  the panel"; use the side panel then. The widget fills logins, forms and 2FA codes only on the run's app sites. On
  any other site the side panel asks first (**Fill anyway**), and a 2FA wait that finds the code field on another site
  pauses until you confirm in the panel or the tab comes back.
- Screenshots leave the card out, and screen readers announce each new step and when a wait starts or ends.
- Shortcuts: **Alt+Shift+F** fills the current form or login once (in the card when it shows the step, else in the
  panel); **Alt+Shift+W** folds or opens the card, or brings it back on a tab where you hid it. Change them in
  `chrome://extensions/shortcuts`.

**Quick test vs tracked walkthrough**

The Start screen offers two buttons for every storyboard; the actors, inputs and origin are the same for both.

- **Start quick test** is for everyday manual testing: you want the helpers (open the page, log in with 2FA, fill
  the form, follow the email link, capture a value) without the bookkeeping. The panel shows a compact step list with
  the current step open. Press **Next ✓** to move on, or click any row to jump to it. Check steps only show what to
  expect. Press **Finish** when you are done. A quick test keeps no verdicts, notes, screenshots, sign-off or history.
  It only remembers how far you got, so you can resume it from Home, where it is marked **Quick**. Nothing deletes it
  automatically: it goes when you clean up its test data (below).
- **Start tracked walkthrough** is for a run you need a record of, such as a release check or a bug report. You press
  Done, Skip or Fail on each step, add notes and screenshots, sign it off and get the printable report described above.

The storyboard decides which button comes first. An agent sets this with the storyboard's `preferredMode`
(`quick` or `tracked`; tracked if unset). Both buttons are always there.

**Cleaning up test data**

Fresh actors leave test users behind, with their emails, SMS and WhatsApp messages. stubyard never removes them on its
own: nothing is automatic. You decide when a run's data can go.

- **Where:** **project → Storyboards → Cleanup** lists every finished or abandoned run that still has test data
  (filter by *To clean*, *Cleaned*, *Dismissed* and quick or tracked). The walkthrough drawer has the same thing for
  one run under **Test data**, and the extension offers **Clean up this run** when a run ends.
- **The button:** tick the runs (and, inside a run, the users) and press **Clean up selected**. stubyard first works
  out what would go and shows it; nothing is removed until you confirm. Then you get a report: what was removed, which
  users stayed and why, and which runs were only partly cleaned.
- **What goes:** the users the run created and all their messages. A **quick** run's record goes too once none of
  its users is left (a **Kept** user keeps the record, hidden as before, until you un-pin it); a **tracked** run keeps
  its steps, notes, screenshots and sign-off. A cleaned run cannot be reopened: start a new run instead.
- **By itself:** a run whose users are all gone or kept (deleted on the user page, say) moves to *Cleaned* on its
  own. Un-pinning **Keep** on a user puts its run back in *To clean*.
- **Only stubyard's own data:** accounts, orders or registrations the run created **in your app** are never touched.
  Values the run captured (a registration number, say) are listed under *Values in your app* so you can remove them
  there yourself if you want to.
- **Keep:** a test user with the **Keep** pin (on the user page, in its Edit dialog, or next to the user in a cleanup
  card) is a shared fixture: cleanup never deletes it. Kept users carry a **Kept** badge.
- **Dependency warnings:** when a later run logged in as a user an earlier run created, or an agent declared that it
  reuses that run's data, the user shows **Used by** that run. Cleaning it up asks first: **Clean both** cleans the
  other run too, **Keep those users** leaves them in place, **Cancel** stops. Either choice then shows exactly which
  runs and how many users, messages and records go before anything is removed. Users an active run still needs always
  stay. A finished run that created no users of its own does not hold data back. A run whose only user is shared can
  still be cleaned this way.
- **Dismiss** takes a run off the list and leaves its data as it is; **Reopen** (under *Dismissed*) brings it back.
- **Deleting a walkthrough** that still has test data: the drawer's Delete dialog offers *Also delete the test users*
  (on by default; kept users stay). If another run still needs one of them, it lists those users and asks again:
  **Delete anyway** removes the run and leaves those users. Unticking the box deletes only the run and leaves all its
  test data, no longer traceable to a run. To keep the record and remove only the data, use **Clean up** instead.

Full reference: AGENT_GUIDE §AF.

---

## 16. FAQ and troubleshooting

**My app says "certificate not trusted" (or "self-signed certificate in chain").**
Download the CA (`curl -o stubyard-ca.crt http://localhost:4000/api/ca.crt`) and trust it for that process:
`NODE_EXTRA_CA_CERTS` (Node), `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` (Python, PHP, Ruby), `keytool -importcert`
(Java), `curl --cacert`. For the browser, import it once (the **HTTPS setup** page shows how per OS). If you reach
stubyard by another hostname or IP, add it to `STUBYARD_TLS_NAMES` and restart. The CA lives in the data volume, so it
survives upgrades; deleting the volume creates a new one that you must trust again.

**The ports are busy, or I run stubyard on another machine (e.g. Windows laptop, Linux box over SSH).**
Forward other local ports and tell stubyard which address the browser uses, so login and payment pages redirect
correctly:

```bash
ssh -L 14000:localhost:4000 -L 14443:localhost:4443 -L 11025:localhost:1025 -L 12197:localhost:2197 user@stubyard-host
```

Then start stubyard with `STUBYARD_PUBLIC_URL=https://localhost:14443` (compose reads it from `.env`). Open
http://localhost:14000. The agent guide served at `/api/agent-guide` rewrites hosts and ports to the ones you used.
Running stubyard locally with different host ports works the same way: `-p 127.0.0.1:14000:4000` and so on, plus
`STUBYARD_PUBLIC_URL`. On Windows, some ports can be reserved by Hyper-V / WSL; picking ports above 10000 usually avoids
that.

**Callbacks (delivery reports, webhooks, replies) never reach my app.**
Run the doctor: `curl -s http://localhost:4000/api/projects/hyper/doctor` (or **Connect your app → Check the
connection**). Typical causes: using `localhost` instead of `host.docker.internal`, an app bound to `127.0.0.1` on Linux,
a missing `--add-host=host.docker.internal:host-gateway`, or a host outside the outbound allowlist
(`STUBYARD_OUTBOUND_ALLOW`). Self-signed HTTPS on your app needs `STUBYARD_OUTBOUND_INSECURE_TLS=1`.

**Where is my data, and how do I back it up?**
Everything (SQLite database, stored emails, files, the CA) is in the container's `/data` volume: `stubyard-data` in the
`docker run` example, `devhub-data` with the compose files. Stop stubyard for a consistent copy, then:

```bash
docker run --rm -v devhub-data:/data -v "$PWD:/b" alpine tar czf /b/stubyard-backup.tgz -C /data .
```

Restore by extracting into an empty volume (the portable bundle's `start.sh --restore FILE.tgz` /
`start.ps1 -Restore FILE.tgz` does it for you). To move only configuration, use project export / import
(`GET /api/projects/hyper/export`, `POST /api/projects/import`) or seed it at start with `STUBYARD_SEED`. Traffic logs are
kept 7 days / 500 MB by default (`STUBYARD_LOG_RETENTION_DAYS`, `STUBYARD_MAX_DB_MB`).

**How do I start a test from a clean slate?**

| Need | Call |
|---|---|
| Clear one inbox | `POST /api/projects/hyper/users/<userId>/clear` |
| All rules back to normal | `POST /api/projects/hyper/rules/reset` |
| Delete messages, emails and logs, keep users and providers | `POST /api/projects/hyper/reset` |
| Delete the project | `DELETE /api/projects/hyper` |
| Everything, all projects (keeps the CA) | **System → Factory reset** (asks you to type `DELETE EVERYTHING`) |

For parallel tests, prefer test runs (section 11) over resets.

**How do I upgrade?**

```bash
docker pull ghcr.io/imibrar/stubyard:latest       # or a version tag such as :0.14.0
docker rm -f stubyard
docker run -d --name stubyard ...same flags and the same -v volume as before... ghcr.io/imibrar/stubyard:latest
```

With compose from a clone: `git pull && docker compose up -d --build`. Data and the CA stay in the volume and database
migrations run automatically at start. See [CHANGELOG.md](../CHANGELOG.md) for what changed.

**The old name was devhub. Do my settings still work?**
Yes: `DEVHUB_*` environment variables still work as fallbacks, and the compose files keep the `devhub-data` volume and
the `devhub` network, so existing data and app compose files carry over.

**Is it safe to expose?**
No. stubyard is for local development and testing only and its API has no login. Keep the ports on `127.0.0.1` and
never use real API keys or real card numbers with it.

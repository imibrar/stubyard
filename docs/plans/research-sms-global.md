# Research: global SMS presets (Infobip, Plivo, Sinch, Telnyx, Amazon SNS)

Collected 2026-11-25 for the `infobip`, `plivo`, `sinch`, `telnyx` and `sns` presets
(`server/src/providers/adapters/`).

"Verified" means it comes from the vendor's docs or the official SDK source. "Seen in SDKs" means open-source client
code reads or writes it. "Unverified" means stubyard picked the most likely shape (from memory of the API or by
analogy), and an app should not depend on the exact wording.

All five accept E.164 numbers with or without `+`; stubyard normalises them to `+…` to match test users.

## Infobip

Sources: https://github.com/infobip/infobip-api-java-client (`SmsApi.java`), the Rust `infobip-sms-sdk` models
(https://docs.rs/crate/infobip-sms-sdk/latest/source/src/models/send.rs),
https://www.infobip.com/docs/developer-resources/api-fundamentals/message-status-codes ,
https://www.infobip.com/docs/developer-resources/api-fundamentals/handling-errors ,
https://www.infobip.com/docs/developer-resources/quickstart .

- Send: the current SDKs call `POST /sms/3/messages` (Java client: `sendSmsMessages`). **Verified.** stubyard also
  takes the older `POST /sms/2/text/advanced` and `POST /sms/1/text/single|multi`, answering in each one's shape.
- Base URL: per account (`https://<subdomain>.api.infobip.com`); every SDK takes it as a constructor argument
  (`baseUrl`). **Verified.**
- Auth: `Authorization: App <api key>`. stubyard also accepts `Basic`, `IBSSO` and `Bearer`. **Verified.**
- v3 request: `{messages:[{sender, destinations:[{to, messageId?}], content:{text}, webhooks:{delivery:{url,
  intermediateReport, notify}, contentType, callbackData}}], options}`. **Verified (SDK models).**
- v2 request: `{bulkId?, messages:[{from, destinations:[{to}], text, notifyUrl, notify, callbackData}]}`. **Verified.**
- Response (HTTP 200): `{bulkId, messages:[{messageId, status:{groupId:1, groupName:"PENDING", id:26,
  name:"PENDING_ACCEPTED", description}, destination, details:{messageCount}}]}` (v3); v2 has `to` and `smsCount`.
  **Verified** (field names; description text unverified).
- Rejections (invalid destination, sender not registered, no credit) come back as HTTP 200 with a REJECTED status:
  `REJECTED_DESTINATION` (52), `REJECTED_SOURCE` (11), `REJECTED_NOT_ENOUGH_CREDITS` (12), group 5. **Verified**
  (status codes page). That they arrive in the send response rather than only in the DLR is **unverified**.
- Errors: v3 uses the unified model `{errorCode:"E401", description, action, violations:[], resources:[]}`.
  **Verified** (E401 wording from the docs). `E429` / `E503` codes: **unverified**. v1/v2 use the legacy
  `{requestError:{serviceException:{messageId:"UNAUTHORIZED", text:"Invalid login details"}}}`. **Verified**
  (well known); `TOO_MANY_REQUESTS` / `SERVICE_UNAVAILABLE` ids **unverified**.
- Delivery report (push to `webhooks.delivery.url` / `notifyUrl`, else the URL set in the portal):
  `{results:[{bulkId, messageId, to, sentAt, doneAt, messageCount|smsCount, price, status, error, callbackData}]}`,
  final status only. `DELIVERED_TO_HANDSET` (group 3, id 5) and `UNDELIVERABLE_NOT_DELIVERED` (2/9) are **verified**;
  the error object values (`EC_ABSENT_SUBSCRIBER` 27, `EC_CALL_BARRED`) are **unverified**.
- Balance: `GET /account/1/balance` → `{balance, currency}`. **Verified** (well-known endpoint).
- Inbound: `{results:[{messageId, from, to, text, cleanText, keyword, receivedAt, smsCount, price, callbackData}],
  messageCount, pendingMessageCount}`. **Unverified.**

## Plivo

Sources: https://www.plivo.com/docs/messaging/api/message/send-a-message ,
https://www.plivo.com/docs/messaging/concepts/callbacks , https://github.com/plivo/plivo-node
(`lib/rest/client.js`, `lib/rest/axios.js`), https://github.com/plivo/plivo-python (`plivo/rest/client.py`,
`plivo/utils/__init__.py`).

- Send: `POST https://api.plivo.com/v1/Account/{auth_id}/Message/`, JSON (`src`, `dst` with `<` between numbers,
  `text`, `url`, `method`, `powerpack_uuid`, `type`, `log`). **Verified.**
- Auth: Basic `auth_id:auth_token`. **Verified.**
- Response: `{"message":"message(s) queued","message_uuid":["…"],"api_id":"…"}`. **Verified.** HTTP 202:
  **seen in SDKs** (the client accepts 2xx), the exact status is from memory.
- Errors: `{api_id, error}`; the Node SDK maps 400 → `InvalidRequestError`, 401 → `AuthenticationError`, 403 on
  `/Message/` → `GeoPermissionError`. **Verified (SDK).** The error texts ("Authentication failed",
  "insufficient credit" with 402, "invalid destination number", sender text) are **unverified**.
- Status callback to `url` (form POST, or GET if `method=GET`): `From, To, Status (queued / sent / delivered /
  undelivered / failed), MessageUUID, ErrorCode, Units, TotalRate, TotalAmount, MCC, MNC, MessageTime, …`.
  Statuses **verified**; the full field list is from memory (**unverified**). Error codes `70` (destination
  permanently unavailable) and `200` (blocked by STOP): **unverified**.
- Signature: callbacks carry `X-Plivo-Signature-V2` + `X-Plivo-Signature-V2-Nonce` (**verified**, callbacks page);
  value = base64(HMAC-SHA256(auth token, URL without query + nonce)) (**verified**, `plivo.utils.validate_signature`).
  stubyard signs when the instance sets `authToken`.
- Fetch: `GET /v1/Account/{auth_id}/Message/{uuid}/` (`message_state`, `error_code`, …). **Verified** (endpoint);
  fields from memory.
- Base URL override: plivo-node hard-codes `https://api.plivo.com/v1/Account/<id>` (no option, no env var);
  plivo-python keeps it in `client.base_uri`, which can be reassigned. **Verified.**

## Sinch

Sources: https://developers.sinch.com/docs/sms/api-reference/sms/batches/sendsms.md ,
https://developers.sinch.com/docs/sms/api-reference/status-codes.md .

- Send: `POST https://<region>.sms.api.sinch.com/xms/v1/{service_plan_id}/batches` (regions `us`, `eu`, …),
  `Authorization: Bearer <api token>`. **Verified.** (Sinch marks the API "end of sale" in favour of the
  Conversation API, but existing integrations use it.)
- Request: `{from, to:[…], body, type:"mt_text", delivery_report:"none|summary|full|per_recipient|
  per_recipient_final", callback_url, client_reference}`. **Verified.**
- Response 201: the batch (`id` ULID like `01FC66621XXXXX119Z8PMV1QPQ`, `to`, `from`, `canceled`, `body`, `type`,
  `created_at`, `modified_at`, `delivery_report`, `expire_at`, …). Id format **verified**, field list from memory.
- Errors: `{code, text}`. 400 `syntax_constraint_violation` / `syntax_invalid_json` /
  `syntax_invalid_parameter_format`; 403 `blocked_account` / `illegal_number_type` / `missing_callback_url`
  ("Requesting delivery report without any callback URL.") / `unknown_group`; 401 "Authentication token is invalid
  for this service plan." (no body documented). **Verified.** stubyard's 401 body `{code:"unauthorized", …}`, 429
  and 503 codes, and the mapping balance → 403 `blocked_account` are **unverified**.
- Delivery reports: only when `delivery_report` is not `none` (the default). `per_recipient`:
  `{type:"recipient_delivery_report_sms", batch_id, recipient, code, status, at, operator_status_at,
  client_reference}`; `summary` / `full`: `{type:"delivery_report_sms", batch_id, total_message_count,
  statuses:[{code, status, count, recipients?}]}`. Enum **verified**; bodies from memory (**unverified**). Status
  codes 0 Delivered, 401 Dispatched, 402 unroutable, 413 Blocked: **unverified**.
- Inbound (MO): `{type:"mo_text", id, from, to, body, received_at, operator_id}`. **Unverified.**
- Base URL: the SDKs pick the host from a region setting; a hostname override is **unverified**.

## Telnyx

Sources: https://developers.telnyx.com/docs/development/api-fundamentals/api-errors.md ,
https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks.md ,
https://developers.telnyx.com/docs/development/sdk/node/webhooks , https://github.com/team-telnyx/telnyx-node
(`src/client.ts`, `src/lib/webhooks.ts`).

- Send: `POST https://api.telnyx.com/v2/messages` with `Authorization: Bearer <api key>`;
  `{from, to, text, messaging_profile_id, webhook_url, webhook_failover_url, …}`. **Verified.**
- Base URL: telnyx-node takes `baseURL` or `TELNYX_BASE_URL` (default `https://api.telnyx.com/v2`). **Verified.**
- Response: `{data:{record_type:"message", direction:"outbound", id, type:"SMS", from:{phone_number, carrier,
  line_type}, to:[{phone_number, status:"queued", …}], text, encoding, parts, cost, received_at, sent_at,
  completed_at, valid_until, errors:[]}}`. **Verified** (field names, from the webhook payloads).
- Errors: `{errors:[{code, title, detail, source?, meta?}]}`; 10009 Authentication failed, 10011 Too many requests,
  10037 Service unavailable, 20100 Insufficient Funds, 40305 Invalid 'from' address, 40310 Invalid 'to' address,
  40300 Blocked due to STOP message. **Verified** (codes and titles). HTTP statuses for 20100 (stubyard: 403) and the
  `detail` texts are **unverified**; failure code 40008 "Undeliverable" is **unverified**.
- Webhooks: `message.sent` then `message.finalized` (to[].status `delivered`, `delivery_failed`, …),
  `message.received` for inbound; envelope `{data:{event_type, id, occurred_at, payload, record_type:"event"},
  meta:{attempt, delivered_to}}`. **Verified.**
- Signature: Ed25519 over `"<telnyx-timestamp>|<raw body>"`, base64 in `telnyx-signature-ed25519`; public key is
  base64 of the raw 32 bytes (`TELNYX_PUBLIC_KEY`). **Verified (SDK source).** stubyard derives a key per instance
  (SHA-256 of the instance id as the seed), so it needs no storage; the public key is on the Connect tab.
- Balance: `GET /v2/balance` → `{data:{record_type:"balance", balance, credit_limit, available_credit, currency}}`.
  From memory (**unverified**).

## Amazon SNS (SMS)

Sources: https://github.com/aws/aws-sdk-js-v3 (`clients/client-sns/src/runtimeConfig.shared.ts`: `AwsQueryProtocol`),
AWS SNS API reference (Publish, CheckIfPhoneNumberIsOptedOut), AWS common errors.

- Protocol: the SDKs still use the AWS query protocol for SNS: form POST to `/` with `Action=Publish&Version=
  2010-03-31&PhoneNumber=+…&Message=…&MessageAttributes.entry.N.Name/Value.DataType/Value.StringValue`, XML answers.
  **Verified (SDK v3 source).** `AWS.SNS.SMS.SenderID`, `AWS.SNS.SMS.SMSType`, `AWS.MM.SMS.OriginationNumber`
  attributes: **verified** (documented).
- Endpoint override: `endpoint` (SDK v3), `endpoint_url` (boto3), or `AWS_ENDPOINT_URL_SNS`. **Verified.**
- Response: `<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>…`
  **Verified.**
- Auth: SigV4. stubyard reads the access key id and region from the `Credential=` part; it does not check the
  signature (it would need the raw body and the secret). Missing header → 403 `MissingAuthenticationToken`, other
  key than `config.accessKeyId` → 403 `InvalidClientTokenId`. **Verified** (AWS common errors).
- Errors: `<ErrorResponse><Error><Type>Sender|Receiver</Type><Code/><Message/></Error><RequestId/></ErrorResponse>`.
  **Verified.** `InvalidParameter` "Invalid parameter: PhoneNumber Reason: … is not valid to publish to":
  **probably right**. The sender / spend-limit messages are **unverified**: real SNS usually accepts the Publish and
  the message fails later (CloudWatch delivery logs), so these exist so rules can force them. 429 `Throttling` and
  503 `ServiceUnavailable` follow the task's convention (real SNS throttling is HTTP 400): **assumed**.
- Delivery reports: SNS has no DLR webhook; delivery status goes to CloudWatch Logs. stubyard sends none.
  **Verified.**
- Inbound (two-way SMS via an SNS topic): an SNS Notification whose `Message` is `{originationNumber,
  destinationNumber, messageKeyword, messageBody, inboundMessageId, previousPublishedMessageId}`. **Verified**
  (shape documented for two-way SMS); the envelope is unsigned, like the SES preset's.

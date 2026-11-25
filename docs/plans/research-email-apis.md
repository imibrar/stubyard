# Research: email API presets (Resend, Postmark, Brevo, Mailjet, Mailchimp Transactional)

Notes behind the `resend`, `postmark`, `brevo`, `mailjet` and `mandrill` presets (feature-ideas §B1). Checked against
the vendors' docs and official SDK source on 2026-11-25. Anything marked **unverified** comes from memory or older
SDK behaviour and could not be confirmed in current docs; the simulator uses it as the best guess.

## Resend

- **Send:** `POST https://api.resend.com/emails`, `Authorization: Bearer re_…`. Body: `from` ("Name <a@b>"), `to`
  (string or array, max 50), `cc`, `bcc`, `reply_to`, `subject`, `html`, `text`, `headers` (object), `attachments`
  (`content` base64 or `path` URL, `filename`, `content_type`, `content_id` for inline), `tags` (`[{name,value}]`),
  `scheduled_at`, `template: {id, variables}` (not together with html/text). Optional `Idempotency-Key` header.
  Success `200 {"id":"<uuid>"}`.
- **Batch:** `POST /emails/batch`, array of up to 100 emails, no attachments. Success `200 {"data":[{"id"},…]}`.
- **Errors:** body `{statusCode, name, message}` (shape confirmed from the Node SDK's `ErrorResponse` type). Names:
  `missing_api_key` 401, `validation_error` 401 "API key is invalid" (sending endpoints), `validation_error` 403
  (unverified domain, testing-only recipients), `missing_required_field` 422, `invalid_attachment` 422,
  `rate_limit_exceeded` 429, `daily_quota_exceeded` / `monthly_quota_exceeded` 429, `application_error` 500,
  `service_unavailable` 503. Rate-limit headers `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`,
  `retry-after`. The exact wording of the 422 field messages ("Missing `from` field.", "Invalid `to` field. The email
  address needs to follow the `email@example.com` or `Name <email@example.com>` format.") is **unverified**.
- **Webhooks:** JSON `{type, created_at, data}`. Types `email.sent`, `email.delivered`, `email.delivery_delayed`,
  `email.bounced` (`data.bounce {message, subType, type}`), `email.complained`, `email.suppressed`, `email.failed`,
  `email.opened`, `email.clicked`. `data` has `email_id`, `from`, `to[]`, `subject`, `tags` (object), `created_at`.
  Signed with Svix: headers `svix-id`, `svix-timestamp`, `svix-signature` = `v1,` + base64 HMAC-SHA256 over
  `id.timestamp.body` with the base64-decoded part of the `whsec_` secret (standard Svix scheme).
- **SDK:** `resend` (Node) takes `new Resend(key, { baseUrl })` or reads `RESEND_BASE_URL` (confirmed in
  `src/resend.ts`).
- Sources: https://resend.com/docs/api-reference/emails/send-email, https://resend.com/docs/api-reference/emails/send-batch-emails,
  https://resend.com/docs/api-reference/errors, https://resend.com/docs/api-reference/rate-limit,
  https://resend.com/docs/webhooks/emails/bounced, https://resend.com/docs/webhooks/verify-webhooks-requests,
  https://github.com/resend/resend-node/blob/canary/src/resend.ts

## Postmark

- **Send:** `POST https://api.postmarkapp.com/email`, header `X-Postmark-Server-Token`. Body: `From`, `To`, `Cc`, `Bcc`
  (comma-separated, max 50 recipients in total), `Subject`, `HtmlBody`, `TextBody`, `ReplyTo`, `Headers`
  (`[{Name,Value}]`), `Tag` (one), `Metadata` (object), `Attachments` (`[{Name, Content, ContentType, ContentID}]`),
  `TrackOpens`, `TrackLinks`, `MessageStream` (default `outbound`). Also `/email/batch` (array), `/email/withTemplate`
  (`TemplateId` or `TemplateAlias`, `TemplateModel`) and `/email/batchWithTemplates` (`{Messages:[…]}`).
  Success `200 {"To","SubmittedAt","MessageID","ErrorCode":0,"Message":"OK"}`; batch returns an array of those.
  Token `POSTMARK_API_TEST` validates without delivering.
- **Errors:** body `{ErrorCode, Message}`. 401 ErrorCode 10 (bad or missing token), 422 ErrorCode 300 (send
  validation: zero recipients, invalid address, missing body), 406 inactive recipient, 412 pending account, 429 rate
  limit, 500, 503. The exact Message texts for 10, 300 and 406 are **unverified** (from SDK experience). The body of a
  429 / 503 is **unverified**. In a batch, real Postmark answers 200 with per-message ErrorCode entries; stubyard fails
  the whole batch with 422 (the simulator validates the whole request at once).
- **Webhooks:** no signature; protect with Basic auth in the URL and IP allowlisting (confirmed). Delivery
  `{RecordType:"Delivery", ServerID, MessageStream, MessageID, Recipient, Tag, DeliveredAt, Details, Metadata}`
  (confirmed from postmark.js `DeliveryWebhook`). Bounce `{RecordType:"Bounce", ID, Type, TypeCode, Name, Tag,
  MessageID, Metadata, ServerID, MessageStream, Description, Details, Email, From, BouncedAt, DumpAvailable, Inactive,
  CanActivate, Subject, Content}`; HardBounce 1, Transient 2, SoftBounce 4096 confirmed; Blocked 100006 **unverified**.
  SpamComplaint: `RecordType` and `Type` `SpamComplaint`, TypeCode 100001.
- **SDK:** `postmark` (`ServerClient(token, { useHttps, requestHost })`); the base URL is
  `${useHttps ? 'https' : 'http'}://${requestHost}`, so `requestHost` can carry a port and path (confirmed in
  `src/client/models/client/HttpClient.ts`).
- Sources: https://postmarkapp.com/developer/user-guide/send-email-with-api, https://postmarkapp.com/developer/api/overview,
  https://postmarkapp.com/developer/webhooks/delivery-webhook, https://postmarkapp.com/developer/webhooks/bounce-webhook,
  https://postmarkapp.com/developer/webhooks/spam-complaint-webhook, https://github.com/ActiveCampaign/postmark.js

## Brevo (ex-Sendinblue)

- **Send:** `POST https://api.brevo.com/v3/smtp/email`, header `api-key: xkeysib-…` (or OAuth bearer). Body: `sender
  {email, name}` (or `{id}`), `to [{email,name}]`, `cc`, `bcc`, `replyTo {email,name}`, `subject`, `htmlContent`,
  `textContent`, `attachment [{content base64 | url, name}]`, `headers` (e.g. `X-Mailin-custom`, `idempotencyKey`),
  `templateId` (int), `params`, `tags`, `messageVersions [{to, cc, bcc, replyTo, subject, htmlContent, textContent,
  params}]`, `scheduledAt`, `batchId`. Success `201 {"messageId":"<…@smtp-relay…>"}`, with versions `messageIds`;
  `202` when scheduled.
- **Errors:** `400 {"code","message"}` with codes `invalid_parameter`, `missing_parameter`, `unauthorized`,
  `not_enough_credits`, `permission_denied`, … (confirmed). The 401 body `{"code":"unauthorized","message":"Key not
  found"}`, the 429 code `too_many_requests` and the `x-sib-ratelimit-*` headers are **unverified**. Exact
  `missing_parameter` messages ("sender is missing") are **unverified**.
- **Webhooks:** JSON per event: `request`, `delivered`, `deferred`, `soft_bounce`, `hard_bounce`, `blocked`, `spam`,
  `invalid_email`, `error`, `opened`, `click`, `unsubscribed`. Fields `event, email, id, date, ts, message-id (no angle
  brackets), ts_event, subject, tags, sending_ip, ts_epoch, reason, template_id, X-Mailin-custom`. No signature; Basic
  auth in the URL, a bearer token (`auth: {type: "bearer", token}`) or custom headers (confirmed).
- **SDK:** `@getbrevo/brevo` (current major) `new BrevoClient({ apiKey, baseUrl })`, default base
  `https://api.brevo.com/v3` (confirmed in the README). The older generated SDK exposes `api.basePath`.
- Sources: https://developers.brevo.com/reference/sendtransacemail, https://developers.brevo.com/docs/transactional-webhooks,
  https://developers.brevo.com/docs/secured-webhooks.md, https://github.com/getbrevo/brevo-node

## Mailjet (Send API v3.1)

- **Send:** `POST https://api.mailjet.com/v3.1/send`, HTTP Basic `apiKey:secretKey`. Body `{Messages:[{From {Email,
  Name}, To/Cc/Bcc [{Email,Name}], ReplyTo, Subject, TextPart, HTMLPart, TemplateID, TemplateLanguage, Variables,
  Attachments [{ContentType, Filename, Base64Content}], InlinedAttachments (+ContentID), Headers, CustomID,
  EventPayload, CustomCampaign}], Globals, SandboxMode, AdvanceErrorHandling}` (field names confirmed from node-mailjet
  types). Success `200 {"Messages":[{"Status":"success","CustomID","To":[{Email, MessageUUID, MessageID,
  MessageHref}],"Cc":[],"Bcc":[]}]}`.
- **Errors:** per message `{"Status":"error","Errors":[{ErrorIdentifier, ErrorCode, StatusCode, ErrorMessage,
  ErrorRelatedTo}]}` (confirmed from node-mailjet types). Codes `mj-0013` (invalid email) and `mj-0003` (missing
  property), the 401 body (`{ErrorIdentifier, StatusCode:401, ErrorMessage:"API key authentication/authorization
  failure…"}`) and the 429 / 503 bodies are **unverified**.
- **Webhooks:** event types `sent, open, click, bounce, spam, blocked, unsub` (confirmed). No signature; Basic auth in
  the URL (confirmed). Payload fields `event, time, MessageID, Message_GUID, email, mj_campaign_id, mj_contact_id,
  customcampaign, CustomID, Payload, smtp_reply (sent), blocked, hard_bounce, error_related_to, error (bounce /
  blocked), source (spam)` are **unverified** (the docs page renders them client-side). Whether a POST holds one
  object or an array depends on the callback's version / grouping: **unverified**, so stubyard sends an object and
  `eventGrouping: true` switches to an array.
- **SDK:** node-mailjet builds `https://` + `config.host` + version + path and rejects `http://` hosts, so it needs
  stubyard's HTTPS port with the CA trusted; `host` may carry a port and path (confirmed in `lib/request/index.ts`).
- Sources: https://dev.mailjet.com/email/guides/send-api-v31/, https://dev.mailjet.com/email/guides/webhooks/,
  https://github.com/mailjet/mailjet-apiv3-nodejs (lib/types/api/SendEmail.ts, lib/request/index.ts)

## Mailchimp Transactional (Mandrill)

- **Send:** `POST https://mandrillapp.com/api/1.x/messages/send` (docs show 1.4, the Node SDK uses 1.3, older clients
  1.0 and a `.json` suffix). The API key is the `key` field of the JSON body. `message`: `html, text, subject,
  from_email, from_name, to [{email, name, type: to|cc|bcc}], headers, important, track_opens, track_clicks, tags,
  metadata, recipient_metadata [{rcpt, values}], global_merge_vars / merge_vars [{rcpt, vars:[{name, content}]}],
  merge_language (mailchimp | handlebars), attachments / images [{type, name, content}]`. `messages/send-template`
  adds `template_name`, `template_content`.
- **Response:** `200` array, one entry per recipient: `{email, status: sent|queued|scheduled|rejected|invalid, _id,
  reject_reason (hard-bounce, soft-bounce, spam, unsub, custom, invalid-sender, invalid, test-mode-limit, unsigned,
  rule), queued_reason (… hourly-quota-exhausted …)}` (confirmed). Rejections are per recipient in a 200.
- **Errors:** `{status:"error", code, name, message}`; 401 `Invalid_Key` (code 401, confirmed; it used to be 500),
  402 `PaymentRequired`, 500 for others. `ValidationError` code -2 with status 500 and `GeneralError` code -1 are
  **unverified** (classic Mandrill behaviour).
- **Webhooks:** form POST with one field `mandrill_events` = JSON array of `{event, msg, _id, ts}`; events `send,
  deferral, hard_bounce, soft_bounce, delivered, open, click, spam, unsub, reject` (confirmed). `msg` fields (`ts,
  _id, state, subject, email, sender, tags, metadata, opens, clicks, smtp_events, bounce_description, diag, _version`)
  follow the classic format (**unverified** in detail). Signature `X-Mandrill-Signature` = base64(HMAC-SHA1(webhook
  key, URL as entered + each POST key and value, keys sorted)) (confirmed).
- **SDK:** `@mailchimp/mailchimp_transactional` has no base URL option, but `client.basePath` is a plain property used
  for every call (confirmed in `src/ApiClient.js`).
- Sources: https://mailchimp.com/developer/transactional/api/messages/send.md,
  https://mailchimp.com/developer/transactional/docs/webhooks.md,
  https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks.md,
  https://mailchimp.com/developer/release-notes/added-support-for-401-unauthorized-response-code,
  https://github.com/mailchimp/mailchimp-transactional-node

## Simplifications in stubyard

- Remote attachments (Resend `path`, Brevo `url`) are not fetched: a text note takes their place.
- Provider-side templates are shown as `[<Vendor> template <id>]` plus the variables as `key: value` lines, so codes
  and links are still extracted.
- Open and click events are not generated (stubyard has no tracking pixels).
- Sender verification (Resend unverified domain 403, Postmark sender signature, Mandrill `unsigned`) is not checked;
  force it with a `reject` rule and a custom message.

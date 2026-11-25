# Research: WhatsApp BSP presets and template lifecycle (B1)

Collected 2026-11-25 for the `360dialog`, `infobip-whatsapp`, `gupshup` and `unifonic-whatsapp` presets and the
template lifecycle on `meta-whatsapp` (`server/src/providers/adapters/`, `server/src/messages/wa-templates.ts`).

"Verified" means it comes from the vendor's own docs as read on 2026-11-25. "Known" means it matches widely used
client code and earlier versions of the docs, but no current page was read. "Assumed" means stubyard picked the
most likely shape. No live calls were made.

Several vendor doc sites could not be read this time (Infobip's API reference returned 404 to the fetcher, and
Unifonic's WhatsApp payload pages are not public). Their entries below are mostly "known" or "assumed".

## Meta WhatsApp Cloud API: templates

Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management ,
https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update ,
https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes

- Create: `POST /{version}/{WABA_ID}/message_templates` with `name`, `language`, `category`, `components`. The name
  must match `^[a-z0-9_]+$`. **Verified.** The response `{id, status:"PENDING", category}` is **known**: the page
  points to the API reference instead of showing it.
- Same name and language again: error code `100`, subcode `2388024`. **Verified.** The rest of that error body is
  **assumed**.
- List: `GET …/message_templates` returns `{data:[{name, parameter_format, components, language, status, category,
  id}], paging:{cursors, next}}` and takes a `fields` filter. **Verified.** stubyard also filters on `name` and `status`.
- Delete: `DELETE …/message_templates?name=…` (every language of that name), or with `hsm_id` for a single one.
  Answers `{"success": true}`. **Verified.** The not-found error is **assumed**.
- Get by id: `GET /{version}/{template-id}`. **Known.** The media `GET /{id}` uses the same path, so stubyard answers
  with the template when that id is a template, and with media otherwise.
- Status webhook: `field: "message_template_status_update"`, with value `{event, message_template_id,
  message_template_name, message_template_language, reason, message_template_category}`. A rejection also carries
  `rejection_info: {reason, recommendation}`. Events include APPROVED, REJECTED, PAUSED, DISABLED, PENDING, FLAGGED,
  REINSTATED and others; reasons are NONE, INVALID_FORMAT, PROMOTIONAL, ABUSIVE_CONTENT, SCAM, INCORRECT_CATEGORY and
  TAG_CONTENT_MISMATCH. The entry also has `time`. **Verified.**
- Quality webhook: `field: "message_template_quality_update"` with `previous_quality_score`, `new_quality_score`
  and the template id, name and language. **Known.**
- Send errors: `132001` "The template does not exist in the specified language or the template has not been
  approved", `132015` paused for low quality, `132016` disabled. **Verified** (code meanings).
  - The Graph wording "(#132001) Template name does not exist in the translation", with details "template name (x)
    does not exist in en_US", is **known** from developer community threads.
  - HTTP 404 for 132001 is **assumed**. Reports show both 400 and 404.
  - HTTP 400 for 132015 and 132016 is **assumed**.

## 360dialog

Sources: https://docs.360dialog.com/docs/waba-messaging/messaging ,
https://docs.360dialog.com/docs/messaging-api/api-reference/messages.md ,
https://docs.360dialog.com/docs/messaging-api/api-reference/templates.md , and the template pages found by search
(`docs.360dialog.com/docs/waba-basics/templates`).

- Send: `POST https://waba-v2.360dialog.io/messages` with a Cloud API body, authenticated by the `D360-API-KEY`
  header. **Verified.** The response is the Cloud API one (`messaging_product`, `contacts`, `messages`). **Verified**
  (schema).
- Webhooks: Cloud API format (`object: "whatsapp_business_account"`) on the one webhook URL set via
  `POST /v1/configs/webhook {url}`. **Known.** stubyard answers that call with `{url}` but does not store it: set the
  URL on the instance.
- Bad key: 401. The schema says `{error: string}`. stubyard answers `{"meta":{"success":false,"http_code":401,
  "developer_message":"Invalid api key"}}`, the shape apps see in community reports. **Assumed.**
- 403 `insufficient_balance`: documented. **Verified**, but not simulated.
- Templates:
  - `POST/GET /v1/configs/templates` and `DELETE /v1/configs/templates/{name}`. **Verified** (paths).
  - The newer reference has `/message_templates` (Graph-shaped, `DELETE ?name=` / `hsm_id`). **Verified** (schema).
  - The older list body `{count, filters, limit, offset, sort, total, waba_templates:[…]}` is **known**. Its lowercase
    `status` values are **assumed**.
  - Template status webhooks: Meta format. **Known.**

## Infobip WhatsApp

Sources: https://www.infobip.com/docs/whatsapp/whatsapp-over-api ,
https://www.infobip.com/docs/developer-resources/api-fundamentals/message-status-codes (via search); the API
reference pages returned 404 to the fetcher. Shapes match Infobip's open-source SDK models.

- Send: `POST /whatsapp/1/message/text` (and `image`, `document`, `audio`, `video`, `sticker`, `location`,
  `interactive/buttons`, `interactive/list`) with `{from, to, messageId?, content:{…}, callbackData?, notifyUrl?}`.
  **Known.** Rate limit 4000 req/s. **Verified.**
- Template send: `POST /whatsapp/1/message/template` with `{messages:[{from, to, content:{templateName,
  templateData:{body:{placeholders}}, language}}], bulkId?}` returns `{messages:[…], bulkId}`. **Known.** stubyard
  handles the first message of a batch.
- Auth: `Authorization: App <key>`; Basic, Bearer and IBSSO are also accepted. **Known.** The 401 body
  `{"requestError":{"serviceException":{"messageId":"UNAUTHORIZED","text":"Invalid login details"}}}` is **known**.
- Send response: `{to, messageCount:1, messageId, status:{groupId:1, groupName:"PENDING", id:7,
  name:"PENDING_ENROUTE", description:"Message sent to next instance"}}`. **Verified** (the status code meaning) and
  **known** (envelope).
- Validation errors: 400 `{requestError:{serviceException:{messageId:"BAD_REQUEST", text, validationErrors:{field:[…]}}}}`.
  **Known.**
- Delivery report: `{results:[{bulkId, price, status:{groupName:"DELIVERED", name:"DELIVERED_TO_HANDSET"…}, error:{…},
  messageId, doneAt, messageCount, sentAt, to, callbackData}]}`, final status only. **Known.**
  - The failed `status` (UNDELIVERABLE / UNDELIVERABLE_NOT_DELIVERED) is **known**.
  - The `error.id` values are **assumed**: stubyard puts the WhatsApp code (131047, 132001…) there.
- Seen report: `{results:[{messageId, to, sentAt, seenAt}]}` on the same URL. **Known.**
- Inbound: `{results:[{from, to, integrationType:"WHATSAPP", receivedAt, messageId, pairedMessageId, callbackData,
  message:{type:"TEXT", text}, contact:{name}, price}], messageCount, pendingMessageCount}`. **Known.**
  - Button replies `INTERACTIVE_BUTTON_REPLY {id, title}`, list replies `INTERACTIVE_LIST_REPLY` and template quick
    replies `BUTTON {text, payload}`: **known**.
- Templates: `POST/GET /whatsapp/2/senders/{sender}/templates` and `DELETE …/templates/{templateName}`; the body is
  `{name, language, category, structure:{header?, body:{text}, footer?, buttons?}}`. **Known.** The `201` status,
  the `204` on delete and the 404 body are **assumed**.
- Template status webhooks: none documented, so stubyard sends none.
- Unapproved template / closed window: Infobip accepts the message and reports the failure in the delivery report.
  **Assumed.**

## Gupshup

Sources: https://docs.gupshup.io/docs/session-messages , https://docs.gupshup.io/docs/template-messages ,
https://docs.gupshup.io/reference/post_wa-api-v1-msg-6 (search).

- Send: `POST https://api.gupshup.io/wa/api/v1/msg`, form-encoded with `channel`, `source`, `src.name`,
  `destination`, and `message` (a JSON object as a string, or plain text). **Verified.**
- Header: the docs use both `apikey` and `api_key`, and stubyard accepts both. **Verified** (both spellings appear
  in the docs).
- The older `/sm/api/v1/msg` path is **known** and accepted too.
- Success: `{"status":"submitted","messageId":"<uuid>"}` with HTTP 2xx. **Verified.** HTTP 202 is **known**.
- Template send: `POST /wa/api/v1/template/msg`, form with `source`, `destination`, `template={"id":"<uuid>",
  "params":[…]}` and an optional `message`. **Verified.**
- Bad key: 401 `{"status":"error","message":"Authentication Failed"}`. **Known.** The other error texts are
  **assumed**.
- Callbacks (v2), all on one callback URL per app:
  - `{app, timestamp, version:2, type:"message-event", payload:{id, gsId, type:"enqueued"|"sent"|"delivered"|"read"|"failed",
    destination, payload:{…}}}`. Failed events carry `{code, reason}`. **Known.**
  - Inbound `type:"message"`, `payload:{id, source, type:"text", payload:{text}, sender:{phone, name, country_code,
    dial_code}}`. **Known.**
  - Window failure code 470. **Known** (the WhatsApp on-premise code that Gupshup passes through).
- Templates: Partner API `POST/GET /partner/app/{appId}/templates` (form: `elementName`, `languageCode`, `category`,
  `templateType`, `content`, `example`…) and `DELETE /partner/app/{appId}/template/{elementName}`. **Known.**
  - stubyard also takes `/wa/app/{appId}/template`.
  - The response envelope `{status:"success", template|templates}` is **known**.
  - The `template-event` callback `{type:"template-event", payload:{id, elementName, languageCode, status,
    rejectedReason}}` is **assumed**.

## Unifonic WhatsApp

Sources: https://docs.unifonic.com/articles/products-documentation/whatsapp-apis ,
https://docs.unifonic.com/docs/getting-your-api-access , the template-messages page (by search), and
https://packagist.org/packages/apimaticsupport/conversationsapi .

- Endpoint: `https://apis.unifonic.com/v1/messages` with `publicId` and secret key "as headers". **Verified.**
  - The header names `PublicId` / `Secret` are **assumed**. stubyard also accepts `x-authenticate-app-id` /
    `x-authenticate-app-secret`.
- The docs list Template Message, Session Message and Template Management APIs, plus incoming-message, delivery-status
  and account webhooks (template status, number quality). **Verified** (that they exist).
- Request body `{recipient:{contact, channel:"whatsapp"}, content:{type:"text", text}}` (templates:
  `content:{type:"template", name, language:{code}, components}`): **assumed**. stubyard validates the content with
  the Cloud API rules.
- Response `202 {messageId, status:"queued"}`, the status webhook `{event:"message.status", messageId, status,
  recipient, timestamp, error?}` and the inbound webhook `{event:"message.inbound", sender, recipient, content}`:
  **assumed**.
- Template management and template webhooks: not public, so not simulated. Templates can be created and approved in
  the dashboard / REST, and sends are checked against them.

## How stubyard uses this

- Templates live in `wa_templates` (migration 31), per provider instance. A send that names a template created on
  the instance needs status `APPROVED`. Templates never created on the instance are sent unless the instance sets
  `enforceTemplates: "true"`, which keeps existing apps working.
- Meta and 360dialog refuse an unapproved template synchronously (`132001` / `132015` / `132016`). The other presets
  accept the message and report the same code in a failed status.
- Review: `templateReview` = `pending` (manual), `approve` or `reject` (automatic after the callback delay), plus
  `templateRejectPattern` (regex) for names that are always rejected.

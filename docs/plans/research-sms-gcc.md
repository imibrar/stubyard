# Research: Saudi / GCC SMS presets (B1)

Collected 2026-11-25 for the `unifonic`, `taqnyat`, `msegat`, `4jawaly` and `oursms` presets
(`server/src/providers/adapters/`). Mobily was skipped.

"Verified" means it comes from the vendor's own docs, or from a live call with fake credentials (made on
2026-11-25; no message was sent). "Seen in SDKs" means open-source client code reads it. "Unverified" means stubyard
picked the most likely shape.

All five take numbers in international format without `+` or `00` (`9665…`). Some apps send local `05…`; stubyard
accepts both.

## Unifonic

Sources: https://docs.unifonic.com/articles/products-documentation/sms-03-sending-api ,
https://docs.unifonic.com/docs/sending-your-first-sms-via-unifonic-api , test fixtures in
https://github.com/getdokan/texty (`tests/fixtures/gateways/unifonic`), https://github.com/omqkhafi/sently
(`src/transports/unifonic.ts`).

- Send: `POST https://el.cloud.unifonic.com/rest/SMS/messages`. Fields `AppSid`, `SenderID`, `Recipient`, `Body`,
  optional `CorrelationID`, `async`, `responseType`. Sent as form data, JSON or a query string. The older
  `/rest/Messages/Send` path is accepted too. **Verified.**
- Auth: `AppSid` as a body or query parameter. **Verified.**
- Success: HTTP 200 `{"success":true,"message":"","errorCode":"ER-00","data":{"MessageID":42000348806924,
  "CorrelationID":"…","Status":"Sent","NumberOfUnits":…,"Cost":…,"Balance":…,"Recipient":"9665…","TimeCreated":
  "2022-09-06 14:06:25.979","CurrencyCode":""}}`. **Verified** (docs).
- Errors: the HTTP status carries the meaning (401 auth, 402 missing AppSid, 403 IP, 429 too many requests,
  480 "This user cannot use the specified SenderID", 482 "Invalid destination number", …). The envelope is
  `{success:false, message, errorCode, Status, data:{}}`.
  - No AppSid: 402 `{"success":false,"message":"No AppSid Parameter Specified","errorCode":"ER-2","Status":"Bad Request","data":{}}`. **Verified (live).**
  - Bad AppSid: 401 `{"success":false,"message":"Missing or Invalid AppSid","errorCode":"ER-1",…}`. **Verified (live).**
  - Bad number: 400 `ER-04` "Dest num is too short". **Verified** (docs).
  - Sender not allowed (480), invalid destination (482), balance exhausted (400 "Insufficient balance", `ER-03`),
    and the `ER-…` codes of the other errors: **unverified**. The HTTP statuses and texts come from the docs table,
    but the `errorCode` values are made up. The docs do not document a balance error.
- DLR: a webhook set in the account (event `dlr`): `{eventName:"dlr", productName, accountId, timeStamp,
  body:{submitUnitCount, deliveredUnitCount, submitDate, doneDate, finalStatus, errorCode, freeText,
  destinationAddress, correlationId, messageId}}`. `finalStatus` "DELIVRD" is **verified**. "UNDELIV" and "REJECTD"
  for failures follow the SMPP convention and are **unverified**. stubyard reports only the final status.
- Balance / sender endpoints: not implemented (no clear current docs).

## Taqnyat

Sources: https://dev.taqnyat.sa/en/doc/sms/ , texty fixtures (`tests/fixtures/gateways/taqnyat`),
https://github.com/taqnyat/OpenAPI (cited by the fixtures).

- Send: `POST https://api.taqnyat.sa/v1/messages`, JSON `{recipients:[…], body, sender}`. Optional
  `scheduledDatetime`, or `templateName` + `variables`. **Verified.**
- Auth: `Authorization: Bearer <token>`. Old examples pass `bearerTokens` as a query parameter, and stubyard accepts
  both. **Verified.**
- Success: HTTP 201 `{"statusCode":201,"messageId":5452899970,"cost":0.026,"currency":"SAR","totalCount":1,
  "msgLength":1,"accepted":"[966500000000,]","rejected":"[]"}`. **Verified** (docs).
- Errors: `{statusCode, message}` with the same HTTP status.
  - 401 "invalid credentials information" (missing token). **Verified (docs + live).** A wrongly formed token got
    400 "Your Password is incorrect" in the live call. stubyard uses the documented 401 for both.
  - 400 "Mobile(s) number(s) is not specified or incorrect". **Verified.**
  - 400 "Sender Name not active". The wording comes from the OpenAPI example, as cited by texty. **Probably right.**
  - 400 "Your balance is 0". The docs table lists code 2 "Balance is 0", but the exact wording is **unverified**.
- Balance: `GET /account/balance` returns 200 `{statusCode:200, accountStatus:"active", accountExpiryDate:"dd-mm-yyyy",
  balance:"2044.000", currency:"SAR"}`. **Verified.**
- Senders: `GET /v1/messages/senders` returns 201 `{statusCode:201, senders:[{senderName, status, destination}]}`.
  **Verified.**
- DLR: a webhook URL and a pass phrase are set in the portal. The payload fields are not documented publicly, so
  stubyard sends `{messageId, mobile, sender, status, errorCode, errorMessage, dateTime, passPhrase}`
  (**unverified**).

## Msegat

Sources: the official Postman collection https://documenter.getpostman.com/view/39158411/2sBY4LT3EY (error-code
table), and https://github.com/omqkhafi/sently (`src/transports/msegat.ts`).

- Send: `POST https://www.msegat.com/gw/sendsms.php`, JSON or form `{userName, apiKey, numbers, userSender, msg}`.
  `numbers` is comma-separated. Optional `msgEncoding`, `reqBulkId`, `timeToSend`. **Verified.**
- Auth: `userName` + `apiKey` in the body. **Verified.**
- Every answer is HTTP 200 `{code, message}`. Success is `{"code":"1","message":"…"}`. **Verified.** A `bulk_id`
  field when `reqBulkId` is set is **unverified** (sently reads it).
- Error codes (**verified**, from the docs table): `M0002` Invalid login info, `1060` Balance is not enough, `1110` Sender
  name is missing or incorrect, `1120` Mobile numbers is not correct…, `1050` MSG body is empty, `M0034` Please Use
  POST Method. A live call with fake credentials returned `{"code":"M0002","message":"Invalid login info"}`, and an
  empty body returned `{"code":"M0002","message":"Missing required fields: userName, numbers, or msg"}`.
- Balance: `GET /gw/Credits.php?userName&apiKey` returns the balance as bare text, e.g. `272.6`. **Verified.**
- DLR: there is no push. Apps poll `getMessages.php`, which stubyard does not implement.

## 4Jawaly

Sources: SDKs and apps on GitHub, e.g. https://github.com/ibrahem-kamal/omni-messaging-jawaly-sms-driver (send,
packages, webhook parser), YasserElgammal/lara-sms, and a live-call log in BedBankSA/ChatE
(`docs/evidence/sms-live.md`). No public official API reference was found.

- Send: `POST https://api-sms.4jawaly.com/api/v1/account/area/sms/send`, JSON `{"messages":[{"text","numbers":[…],
  "sender"}]}`. **Seen in SDKs** and in the live-call log.
- Auth: HTTP Basic, API key and secret. **Seen in SDKs.**
- Success: 200 `{"code":200,"message":"تم حفظ الرسائل بنجاح","messages":[{"job_id","success_count":1,"error_count":0,
  "duplicated_count":0,"total_cost":1}],"job_id":"…","request_id":"req_…"}`. **Verified** (live-call log).
- Auth errors: no token gives 400 `{"code":400,"message":"التوكن مطلوب"}`, and a bad token gives 400
  `{"code":400,"message":"التوكن منتهى او انة غير مفعل","is_token_expired":true}`. **Verified (live).**
- Other errors: SDKs read `messages[0].err_text` on a 200, or `message` on a 400, and 422 for an empty body.
  stubyard answers 400 `{code, message, messages:[{err_text}]}` so both kinds of client see the error. The texts
  (sender not active, balance insufficient, invalid number) are **unverified**.
- Balance: `GET /api/v1/account/area/me/packages` returns `{code:200, total_balance, items:[…]}`. **Seen in SDKs**;
  the item fields come from the packagist README.
- DLR: `{sms_message:{sender_name,…}, numbers:[{number, msg_id, status, error_code_string}]}`, where `status` 3 means
  delivered. **Seen in an SDK webhook parser.** stubyard uses 4 for failed, which is **unverified**.

## OurSMS

Sources: apps and plugins on GitHub (e.g. Servi1/Backend_Loyalty, ahmedhegazy211977/newp,
wp-sms `class-wpsms-gateway-oursms.php`). docs.oursms.com is not public.

- Send: `POST https://api.oursms.com/msgs/sms`, JSON `{src, dests:[…], body, priority, delay, validity, maxParts,
  dlr, prevDups, msgClass}`. There is also the legacy `GET /api-a/msgs?username&token&src&dests&body`. **Seen in
  SDKs.**
- Auth: `Authorization: Bearer <token>`, or `token` on the legacy API. **Seen in SDKs.**
- Success: apps read `jobId` and `accepted` (count) (**seen in SDKs**). The other fields (`rejected`, `duplicates`,
  `msgParts`, `cost`) are **unverified**.
- Errors: `{status, errorCode, message, value}`.
  - A bad token gives 401 `{"status":401,"errorCode":"2003","message":"Invalid credentials","value":null}`, and a
    missing one gives the same with `errorCode:""`. **Verified (live).**
  - The 400 texts for sender, balance and number are **unverified**, and their `errorCode` is left empty rather
    than made up.
- Balance: `GET /billing/credits` returns `{credits}`. **Seen in SDKs.**
- DLR: requests carry a `dlr` flag, but no webhook format is documented, so stubyard sends no DLR.

## What stubyard adds on top

- `config.balance` ("0" means every send fails with the balance error) and `config.approvedSenders` (any other
  sender fails), so apps can test the failures Saudi senders really hit.
- A rule's errorCode `sender`, `balance`, `auth` or `number` turns the generic `reject` into that vendor's error.
- Blocked hours for promotional SMS are not modelled yet.

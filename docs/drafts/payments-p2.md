# Payments P2: popup and drop-in SDKs, batch 1 (draft for the lead to merge)

Also contains the P0 QA fixes made at the start of this phase (last section before "For the next phase").

## For docs/AGENT_GUIDE.md §Z.22 "Checkout experiences": add after the P1 table

**Fake SDKs (P2).** Three provider SDKs run against stubyard with their real global, object, method and callback names. Each draws its UI in a stubyard iframe (or, for PayPal Buttons, as neutral buttons in your container). The TEST notice is always inside the component. Every SDK works in English and Arabic (right to left) and on phones. Card digits never reach the merchant page: the frames pass only brand, last 4 and the magic id. Messages between the page and the frames use `postMessage` with an exact target origin, never `*` and never `document.referrer`. Every frame is opened with the page's `location.origin`, and the server checks it against the instance's **`sdkOrigins`** config (an array, or a comma / space separated string) and the project's **app origins**. Neither list set: the origin is allowed, with info lint `pay.sdk-origin-unlisted`. Set but no match: the frame answers 403 with lint `pay.sdk-origin-refused`. Each SDK has a demo shop at `{instance browser base}/demo` (`?lang=ar` for Arabic).

| SDK | Load | API | Flow |
| --- | --- | --- | --- |
| Moyasar Form | `{base}/mpf/moyasar.js` (+ `/mpf/moyasar.css`), env `MOYASAR_FORM_JS` / `MOYASAR_FORM_CSS` | `Moyasar.init({ element, amount, currency, description, publishable_api_key, callback_url, methods: ['creditcard','stcpay','applepay'], supported_networks, language, metadata, given_id, apple_pay: { label }, on_initiating, on_completed, on_failure, on_redirect })` | The form frame (`/mpf/form`) has method tiles, the cardholder name and the card fields. It creates the payment itself (`POST /mpf/payments`, publishable key, card facts only). The callbacks: `on_initiating()` runs first (`false` stops; an object overrides amount / currency / description / metadata / callback_url / given_id; a promise is allowed). `on_completed(payment)` runs once the payment exists (a rejected promise stops). `on_failure(message)` runs when the payment cannot be created. `on_redirect(url)` takes over every redirect. **Card**: 3-D Secure as a full-page redirect to `source.transaction_url`, then `callback_url?id=&status=&message=`. **STC Pay**: mobile number, then the OTP inside the form (SMS in the stubyard inbox; the documented test codes `123456` / `000000` also work), then the callback. **Apple Pay**: the simulated wallet sheet, then `source.type=applepay` (paid or failed at once by the chosen test card), then the callback. |
| GeideaCheckout | `{base}/hpp/geideaCheckout.min.js` (env `GEIDEA_CHECKOUT_JS`) | `new GeideaCheckout(onSuccess, onError, onCancel).startPayment(sessionId)` opens a **popup** (overlay iframe). `startPayment(sessionId, null, 'container-id')` opens a **drop-in** iframe inside that element. | Exactly one callback fires per `startPayment`, with `{ responseCode, responseMessage, detailedResponseCode, detailedResponseMessage, orderId, reference }`. `responseCode` `"000"` gives onSuccess. The buyer cancelling (Cancel, or the overlay's Close) gives onCancel. Anything else gives onError: a decline, or an unknown, expired or already used session (checked first with `GET /hpp/sdk/sessions/<id>`, lint `pay.geidea-sdk-session`). The frame is the realistic Geidea page (3-D Secure in a modal). Instead of redirecting, its result screen posts the result to your page. Instance config `checkoutJsMode: "redirect"` keeps the old full-page redirect. |
| PayPal JS SDK | `{base}/sdk/js?client-id=…&components=buttons,card-fields[&locale=ar_SA]` | `paypal.Buttons({ fundingSource?, style?, onInit, onClick, createOrder, onApprove, onCancel, onError }).render(el)`, `paypal.CardFields({ createOrder, onApprove, onError, inputEvents })` with `NumberField / ExpiryField / CVVField / NameField`, `getState`, `submit`; `paypal.FUNDING.PAYLATER` | Without `fundingSource` the buttons are PayPal, Pay Later and Debit or Credit Card (neutral look, no PayPal colours). The approval page opens in a popup (the instance's `buttonsMode: "inline"` uses an overlay instead). **Pay Later** (`funding=paylater`) shows "Pay in 4" and "Pay Monthly" offers on the review screen (display only). The close page posts only to the page origin that `/checkoutnow` accepted; with no origin it posts nothing, and the SDK's state poll still sees the result. The Card Fields frames post only to the page origin given in `origin=`. |

**Wallet sheet** (`{base}/stubyard-sdk/wallet`, used by Moyasar Apple Pay): a neutral sheet titled "<wallet> (simulated)" with the TEST notice. It lists the magic test cards (approve, decline, insufficient funds, …) and has Confirm (`stubyard-wallet-confirm`) and Cancel (`stubyard-wallet-cancel`). It posts `{ type: 'wallet', result: 'authorized' | 'cancelled', card: { brand, last4, magicId } }` to the page origin only.

**Automation hooks**:
- Frames: `stubyard-moyasar-frame`, `stubyard-geidea-frame`, `stubyard-cf-frame-<type>`.
- Overlays: `stubyard-sdk-overlay` (close button `stubyard-sdk-close`) and `stubyard-paypal-overlay`.
- Buttons and notices: `stubyard-paypal-buttons`, `stubyard-paypal-button` (`-paylater`, `-card`), the in-component notice `stubyard-sdk-badge`.
- Moyasar form: `stubyard-moyasar-form`, `stubyard-cardholder`, `stubyard-pay`, `stubyard-applepay`, `stubyard-phone`, `stubyard-stc-pay`, `stubyard-otp`, `stubyard-otp-submit`, `stubyard-form-error`.
- Demo pages: `stubyard-demo-log` prints every callback.

**New lint checks**: `pay.sdk-origin-unlisted` (info), `pay.sdk-origin-refused` (error), `pay.geidea-sdk-session` (warn).

**Fidelity**: the API surfaces are `verified` (the documented names). The screens are `assumed`. Stripe Embedded Checkout and the Payment Element are not in this batch (still `planned`).

## For docs/GUIDE.md §6 (payments), one paragraph

stubyard now also fakes three payment SDKs, so a checkout built with them can be tested end to end without a sandbox account: Moyasar Form (`Moyasar.init`, with card, STC Pay and a simulated Apple Pay sheet), Geidea Checkout JS (`new GeideaCheckout(...).startPayment(sessionId)` as a popup or a drop-in) and the PayPal JS SDK (Buttons with Pay Later, and Card Fields). Load stubyard's script instead of the provider's: the Connect panel lists the URLs. Every SDK uses the provider's own function and callback names, shows the TEST notice inside the component, and works in English and Arabic and on phones. Card numbers never reach your page. To allow your app's origin, list it in the project's app origins or the instance's SDK origins. Each SDK has a demo shop page under the instance to try it first.

## For CHANGELOG.md (lead)

- Payments P2: fake SDKs with the real API names.
  - Moyasar Form: `Moyasar.init` with all four callbacks; card with a 3-D Secure redirect, STC Pay OTP in the form, and a simulated Apple Pay sheet.
  - GeideaCheckout: popup, drop-in, or redirect via `checkoutJsMode`; exactly one callback.
  - PayPal Buttons: neutral restyle, Pay Later with an offers screen; Card Fields and the close page post only to the checked page origin.
- Also in P2: a neutral TEST wallet sheet, a demo shop per SDK, instance config `sdkOrigins`, and lint `pay.sdk-origin-unlisted`, `pay.sdk-origin-refused`, `pay.geidea-sdk-session`.
- P0 QA fixes:
  - Retryable declines and wrong OTP codes answer 200 (not 402 / 400).
  - The 3-D Secure modal's X cancels the authentication and keeps the payment open.
  - The decline keeps the typed card fields except the CVC.
  - Page-language switch via `x/view`; Arabic status words and OTP errors; the classic page in Arabic and right to left.
  - The banner host follows the browser host; no duplicate "Test user" label; colour contrast fixes; the drawer and outcome chips fit on phones.

## P0 QA fixes made in this phase (for the lead's notes)

- `kit/router.ts`:
  - A retryable decline and a wrong OTP answer 200 with the message on the page.
  - New `POST x/view` (`lang=en|ar`) stores the page language (204), used by the page when `?stubyard_lang` differs from the stored one.
  - `3ds_cancel` (the modal's X) closes the challenge: the payment stays open and the page shows "Authentication cancelled".
- Pay form (`kit/fields.ts`): after a decline, card number, expiry, name, email and country are restored (sessionStorage, per payment); the CVC is never kept.
- i18n:
  - Arabic for the status words (`statusLabel`) and for the "Wrong code, N tries left" message (`tMessage`).
  - The bank page is no longer titled "Simulated Simulated".
  - Hints on the Test controls.
- Banner: the thin strip shows only the page language; "Served by" uses `location.host` in the browser.
- Theme: `--faint` and the primary button colour now meet the contrast target; the drawer, the outcome chips and the footer fit at 390 px.
- Classic page: Arabic and right to left when the payment's page language is Arabic.

## For the next phase

- **Shared runtime**: `server/src/payments/sdk/runtime.ts`.
  - `SDK_RUNTIME` is the merchant-page half, embedded in each SDK script, global `SY`: `base`, `uid`, `lang`, `badge`, `frame`, `overlay`, `bridge`.
  - `frameBridge()` is the frame half (`SYB.post` / `SYB.on`, auto-resize).
  - `checkSdkOrigin()` handles the origin allow-list and its lint; `sdkCors()` reflects an allowed Origin; `js()` is safe inline JSON.
  - Message convention: a frame posts `{ source, ch, type, … }`; the page answers with `source + '-host'`; the channel `ch` must match; both sides check `event.origin` and `event.source`.
- **Other files**:
  - `sdk/wallet.ts`: the wallet sheet, `renderSdkError`, `htmlReply`.
  - `sdk/card.ts`: the card checks in the browser (`SYC`).
  - `sdk/demos.ts`: the demo pages.
  - `moyasar/form.ts`, `geidea/sdk.ts`; PayPal stays in `paypal/sdk.ts` (its API and tests unchanged).
- **New layout hooks**:
  - `HppConfig.scripts(c)` adds extra scripts to the pay screen (Geidea: the cancel bridge).
  - `ReturnCtx.svc` is new.
  - `resultScripts(p, svc)`.
  - A layout's `returnPage` may replace the redirect with an SDK result screen (Geidea does this when `providerData.sdkBridge` is set).
- **For the lead**:
  - **routes/payments.ts** (not mine): the classic done page ignores `?stubyard_lang`; apply the view from the query before `done()`. The realistic page works around it with `x/view`.
  - **happy-dom**: `server/test/checkout-sdk.test.ts` imports `happy-dom`, which is hoisted from the extension workspace but is not in `server`'s devDependencies. Please add `"happy-dom": "^21.0.4"` there (no new install: the same version is already in the lockfile).
  - **Banner host**: the "Served by" host on the GET page is corrected in the browser only (`data-host-template`); the server still renders the configured host first.
- **Known gaps**:
  - The Geidea overlay's Close cancels through the pay screen. On the OTP screen there is no cancel button, so the SDK ends with onCancel after 4 s and the payment stays open until it expires.
  - The Pay Later offer choice is shown but not stored.
  - Moyasar STC Pay phone numbers are stored as typed (with a leading +, as before).
  - Stripe Embedded Checkout and the Payment Element are not started (registry `planned`).
  - Arabic wording of the new strings has not been reviewed by a native speaker.

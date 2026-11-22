# Payments P3: BNPL, wallets and promo widgets (draft for the lead)

Status: built on `dev`, not committed. The lead merges this into CHANGELOG.md / docs/AGENT_GUIDE.md.

## What changed

### Tabby hosted page (realistic, `tabby-hpp`)
- Screens: phone + email (prefilled from `payment.buyer`) -> SMS code (4 digits; `8888` always works) -> plan (4 payments, the first takes the remainder) -> card -> result.
- Pre-scoring reject: the documented reject phones (+971500000002 / +966500000002 and the other test numbers) are rejected on the first screen with "We can't approve this purchase" (EN and AR texts). No SMS is sent. Status `failed`, failure URL. A session created with a reject phone is rejected straight away, as before.
- HPP reject: `otp.rejected@tabby.ai` (typed on the page or sent as the buyer email) is rejected after the code.
- Three wrong codes decline the payment with `otp_failed`.
- "Back to store" asks for confirmation (`stubyard-provider-cancel` -> `stubyard-cancel-confirm` / `stubyard-cancel-keep`), then goes to the cancel URL. Status `EXPIRED` and session expiry are unchanged.
- The finished page shows the rejection or cancel message, with a "Back to store" link.
- Fidelity tags: phone / OTP and cancel `partial`, plan / card `assumed`, reject texts `verified`.

### Tamara hosted page (realistic, `tamara-hpp`, tagged `partial`)
- Screens: phone -> Send OTP -> code (prefilled, as the Tamara sandbox does) -> terms (checkbox required) -> plan (2 / 3 / 4 / pay in full; the default comes from `instalments` or `payment_type`) -> card ("Pay and Confirm Order") -> result.
- Decline phones are declined after the code. The chosen plan is recorded as a `tamara_plan` event. Cancel has the same confirmation as Tabby.

### JazzCash hosted page (realistic, `jazzcash-hosted`, English only per D11, mostly `assumed`)
- Mobile Account: mobile number + the last 6 digits of the CNIC -> MPIN screen (the MPIN is never posted or stored) -> OTP -> the signed `pp_*` POST back, as before.
- Debit / Credit Card: the kit card form with 3-D Secure.
- Voucher: the voucher number (`pp_RetreivalReferenceNo`) and its expiry (`pp_SettlementExpiry`). The signed POST (response code 124) goes back only when the buyer clicks Continue.

### Easypaisa hosted page (realistic, `easypaisa-hosted`, English only, mostly `assumed`)
- Mobile Account: number (prefilled from `mobileNum`) -> OTP -> redirect to `postBackURL`.
- OTC voucher: the payment token and its expiry, then the redirect with `paymentToken`.
- Card: the kit card form.

### Promo widgets (fake scripts, TEST label inside each widget)
- Tabby: `<instance>/tabby-promo.js` and `/tabby-card.js` (`.min.js` and a path prefix work too) define `new TabbyPromo({selector, currency, price, lang, source, publicKey, merchantCode, shouldInheritBg})` and `new TabbyCard({...})`.
  - Text: "4 interest-free payments of AED 500.00. No fees. Learn more".
  - Honours `--snippetTextColor` / `--snippetLinkTextColor`. Logs console warnings for a wrong key, currency or price.
  - Learn more opens `/promos/learn-more`. The static snippet `/promos/product-page/installments/{en|ar}/` is served too.
  - Connect env: `TABBY_PROMO_JS`, `TABBY_CARD_JS`.
- Tamara: `<instance>/widget-v2/tamara-widget.js` defines the `<tamara-widget type amount inline-type config lang>` custom element.
  - Reads `window.tamaraWidgetConfig` (`lang`, `country`, `publicKey`) and re-renders when an attribute changes. `window.TamaraWidgetV2.refresh()` re-renders all widgets.
  - Also served: the iframe variant `/widget-v2/tamara-widget.html` and the popup `/widget-v2/popup`.
  - Connect env: `TAMARA_WIDGET_JS`.
- PayPal: loading `sdk/js?components=...,messages` adds `paypal.Messages({amount, currency, placement, style, onRender, onClick}).render(selector)` and auto-renders `[data-pp-message]` elements. Learn more opens `/sdk/messages/learn-more`.
- The scripts are served with `application/javascript`, `no-store`, CORP cross-origin and ACAO `*`. Popups are kit pages with the TEST strip and a strict CSP.

### Kit and service internals
- `kit/flow.ts`: new flows `tabby`, `tamara`, `jazzcash-wallet`, `easypaisa-ma`.
- `kit/router.ts`: new step names `phone|otp|plan|card|terms|mpin`.
  - Custom steps can have `enter` and `act`.
  - Layouts can have `payInto` (start a custom flow from the pay step) and `doneScreen` (a provider result screen on the finished page).
  - Quick shortcuts on multi-step layouts skip the OTP.
- `kit/steps.ts` (new): the step shell, "Step n of m", the cancel confirmation, OTP input, instalment maths.
- `kit/wallet.ts` (new): PK mobile / CNIC fields, MPIN, wallet OTP, voucher screen.
- `service.ts`: `otpStart` / `otpCheck` (configurable code length, 3 tries); `complete()` declines with `otp_failed` after three wrong codes.
- `http/routes/payments.ts` (lang fix): `?stubyard_lang` / view in the query is applied before the classic done page is rendered.

## Test ids (for QA / Playwright)
- Flow: `stubyard-screen-<step>`, `stubyard-step-no`, `stubyard-continue-step`, `stubyard-back-step`, `stubyard-change-number`, `stubyard-otp`, `stubyard-send-otp`, `stubyard-terms`, `stubyard-plan`, `stubyard-plan-<2|3|4|full>`, `stubyard-instalment`, `stubyard-pay`.
- Cancel: `stubyard-provider-cancel`, `stubyard-cancel-confirm`, `stubyard-cancel-keep`.
- Tabby result: `stubyard-tabby-rejected`, `stubyard-tabby-cancelled`, `stubyard-provider-message`, `stubyard-return`.
- Wallets: `stubyard-phone`, `stubyard-cnic`, `stubyard-mpin`, `stubyard-otp-submit`, `stubyard-voucher`, `stubyard-voucher-expiry`, `stubyard-return-form`.
- Widgets: `stubyard-tabby-promo`, `stubyard-tabby-card`, `stubyard-tabby-card-plan`, `stubyard-tamara-widget`, `stubyard-tamara-badge`, `stubyard-pp-message`, `stubyard-promo-text`, `stubyard-promo-more`, `stubyard-sdk-badge`, `stubyard-promo-info`.

## Assumptions / deviations
- The Tamara "/mo" figure divides by 12 months. The real widget's figure depends on the merchant's plans.
- `TamaraWidgetV2.refresh()` exists in the fake. Its real name and shape are not verified.
- The JazzCash MPIN is entered but never posted; the real page submits it to JazzCash only.
- No magic OTP for JazzCash or Easypaisa: the code is in the SMS inbox. Tabby accepts `8888`; Tamara prefills the code.
- Easypaisa has no MPIN step; the real flow approves in the app.
- JazzCash and Easypaisa ignore `?stubyard_lang=ar` (D11, English only).

## Tests
- `server/test/checkout-p3.e2e.test.ts` (23): every step of each flow, rejects, three wrong codes, cancel, AR, script routes and popups, the classic done-page language fix.
- `server/test/checkout-p3-sdk.test.ts` (9): happy-dom contract tests for TabbyPromo / TabbyCard, `<tamara-widget>` and paypal.Messages.
- `server/test/checkout-kit.e2e.test.ts`: the "banner on every gateway" map now knows the new first screens.

## Next phase notes
- Tabby has no plan choice (Pay in 4 only); add "pay in 3/6/12 months" if the account's products ask for it.
- Apple Pay / Google Pay inside Tabby and Tamara card screens are not simulated.
- The widgets' popups are static info pages; the real ones also show the merchant logo.

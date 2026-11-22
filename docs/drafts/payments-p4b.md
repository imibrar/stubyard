# Payments P4b: embedded SDKs for Checkout.com, Tap, MyFatoorah, PayTabs and APS (draft for the lead)

Status: built on `dev`, not committed. The lead merges this into CHANGELOG.md / docs/AGENT_GUIDE.md.

Every SDK keeps its real global, function and callback names. The TEST label sits inside the component (the frame's TEST strip, or the badge paylib adds to the shop's form). EN and AR are supported, with phone layouts from the kit. Card digits never leave stubyard frames: only card facts (brand, last 4, BIN, expiry, magic id) reach the server, and a Luhn-valid non-test number is cleared and refused with the `pay.real-card-entered` lint. Frames post only to the exact page origin, which is checked with `sdkOrigins` or the project app origins. Each provider has a demo shop at `{instance}/demo` (`?lang=ar` for Arabic).

## What changed

### Checkout.com Flow (`checkout-web-components`, realistic)
- Script: `{instance}/checkout-web-components/index.js` (any version prefix and `.min.js` also work). Connect env: `CKO_WEB_COMPONENTS_URL`.
- Server: `POST /payment-sessions` (Bearer sk) answers `{id: ps_…, payment_session_secret: pss_…, payment_session_token, _links}`. It requires amount, success_url, failure_url and billing.address.country, and adds a lint when there is no reference. `POST /payment-sessions/:id/submit` is also available.
- Browser: `await CheckoutWebComponents({publicKey, environment, paymentSession, locale, appearance, componentOptions, onReady, onChange, onError, onPaymentCompleted, handleSubmit})` gives `.create('flow' | 'card')`. Component methods: mount, unmount, isValid, isAvailable, submit, tokenize, update.
- Outcomes:
  - 3-D Secure answers `Action Required` and does a full-page redirect to the ACS page, then success_url with `cko-payment-session-id` and `cko-payment-id`.
  - A card without 3-D Secure is `Approved` and calls onPaymentCompleted.
  - A decline calls onError with a CheckoutError.
  - The payment carries `metadata.cko_payment_session_id`. An approved session refuses another submit (422 `payment_session_completed`).

### Tap Card SDK v2 (`window.CardSDK`, realistic)
- Script: `{instance}/card-sdk/index.js`. Connect env: `TAP_CARD_SDK_URL`.
- `renderTapCard(id, config)` returns `{unmount}`.
- Callbacks: onReady, onFocus, onBinIdentification, onValidInput, onInvalidInput, onError, onSuccess(tok_), onChangeSaveCardLater.
- Functions: tokenize, saveCard, resetCardInputs, updateTheme, updateCardConfiguration, loadSavedCard. Constants: Theme, Currencies, Direction, Edges, Locale.
- The tok_ works in `POST /v2/charges` source.id and gives transaction.url (3-D Secure), then redirect.url?tap_id. Test cards with a past expiry are allowed (the expiry picks the outcome, as for Tap API cards).
- goSell is not built (it stays `planned`).

### MyFatoorah embedded payment (`session.js`, realistic)
- Script: `{instance}/payment/v1/session.js`. Connect env: `MF_SESSION_JS_URL`.
- Flow:
  1. `POST /v2/InitiateSession` answers `{SessionId, CountryCode, CustomerTokens: []}`.
  2. `myfatoorah.init({sessionId, countryCode, currencyCode, amount, containerId, paymentOptions: ['Card','ApplePay','GooglePay','STCPay'], callback})`.
  3. callback({isSuccess, sessionId, paymentType, cardBrand}).
  4. `POST /v2/ExecutePayment {SessionId, InvoiceValue, CallBackUrl, ErrorUrl}` answers PaymentURL.
- By method:
  - Card: PaymentURL is the 3-D Secure page. Opened in an iframe, the return posts `JSON.stringify({sender:'MF-3DSecure', url})` to the session's page origin only; at top level it navigates.
  - Apple Pay / Google Pay: paid at ExecutePayment; PaymentURL is the CallBackUrl.
  - STC Pay: the usual OTP page.
- A SessionId works for one ExecutePayment only.
- `myfatoorah.submit()` (a Pay button outside the frame) is an extra.

### PayTabs managed form (`paylib.js`, realistic)
- Script: `{instance}/payment/js/paylib.js`. Connect env: `PAYTABS_PAYLIB_URL`, `PAYTABS_CLIENT_KEY`. New config field `clientKey`; new instances get `CK…-…-…`.
- `paylib.inlineForm({key, form, autoSubmit, callback})` works on inputs with `data-paylib="number|expmonth|expyear|cvv"`. It warns when one of them has a name, adds a hidden `payment_token` field and submits the form. `paylib.handleError(el, response)` shows errors.
- `POST /payment/request` accepts `payment_token` (single use, 30 minutes):
  - 3-D Secure card: `redirect_url`, then the ACS page, then the signed return.
  - Otherwise the result at once (`payment_result`, `payment_info`).

### APS Merchant Page (iframe, realistic)
- The shop posts a signed form into an iframe: `POST /FortAPI/paymentPage` with `service_command=TOKENIZATION` (access_code, merchant_identifier, merchant_reference, language, return_url, optional token_name).
- The iframe shows the stubyard card form. On submit, the signed response is posted to return_url inside the iframe: response_code 18000, status 18, token_name, card_number masked (`400000******3155`), expiry_date, card_bin, card_holder_name.
- `POST /FortAPI/paymentApi` with command PURCHASE / AUTHORIZATION + token_name:
  - answers `3ds_url` (status 20, response_code 20064), then the ACS page, then the signed POST to return_url (14000 / 13xxx);
  - with `check_3ds: 'NO'` it pays at once;
  - an unknown token answers 13024.
- `kit/router.ts`: the `pay.hpp-framed` lint no longer fires for the TOKENIZATION page, which is meant for an iframe.

### Registry
`checkout/flow`, `tap/card-sdk`, `myfatoorah/session`, `paytabs/paylib` and `aps/merchant-page` are now `realistic`, with notes, docs and steps.

## Deviations (and why)
- Flow:
  - The submit response statuses and the CheckoutError fields (name, type, code, message, details) follow the docs where they are clear; the rest are assumptions.
  - Wallets / APMs inside Flow (`create('applepay')` etc.) report `isAvailable() === false`.
  - `translations` is ignored. Frames is not built (as planned).
- Tap: the onBinIdentification / onValidInput payloads are modelled on the docs' examples. loadSavedCard calls onError `not_simulated`.
- MyFatoorah: `shouldHandlePaymentUrl`, API v3 encrypted paymentData and saved cards are not simulated. Apple Pay / Google Pay are paid at ExecutePayment.
- PayTabs: the real paylib sends the card number from the shop page to PayTabs (SAQ A-EP). The fake computes the card facts on the page and sends only those, so no digits reach stubyard.
- APS: Merchant Page 2.0 is skipped (as planned). Saved-token reuse rules are not checked.
- Sessions and tokens live in memory (Flow 60 min, MF 60 min, paylib 30 min, APS session 30 min / token 24 h), so they are lost on restart.
- MyFatoorah's documented test card 5123 4500 0000 0008 is accepted by the session.js frame.

## Files
- New:
  - `server/src/payments/sdk/checkout-flow.ts`
  - `sdk/tap-card.ts`
  - `sdk/myfatoorah-session.ts`
  - `sdk/myfatoorah-return.ts`
  - `sdk/paytabs-paylib.ts`
  - `sdk/aps-merchant.ts`
- Gateways: `checkout/index.ts`, `tap/index.ts`, `myfatoorah/index.ts`, `myfatoorah/experience.ts` (returnPage), `paytabs/index.ts`, `aps/index.ts`.
- Shared (small additions): `sdk/demos.ts` (exports the demo helpers), `kit/registry.ts` (five entries), `kit/router.ts` (one-line framed-lint exclusion).
- Tests: `server/test/checkout-p4b-sdk.test.ts` (happy-dom contracts), `server/test/checkout-p4b.e2e.test.ts`.

## Notes for the next phase
- No dashboard UI changes: the demos are linked only through the connect notes ("Try it: {browser base}/demo").
- goSell and Checkout Frames remain `planned`.
- The sessions are in memory. Move them to the repo if restarts during a flow matter.

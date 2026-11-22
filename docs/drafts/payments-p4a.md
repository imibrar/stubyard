# Payments P4a: Stripe PaymentIntents, Embedded Checkout, fake Stripe.js v3 (draft for the lead)

Status: built on `dev`, not committed. The lead merges this into CHANGELOG.md, docs/AGENT_GUIDE.md and docs/GUIDE.md.

## What changed

### PaymentIntents API (secret key, `stripe/intents.ts`)
- `POST /v1/payment_intents`: amount (positive integer, minor units), currency, capture_method (`automatic` / `automatic_async` default / `manual`), payment_method_types or automatic_payment_methods, metadata, description, receipt_email, setup_future_usage, customer, shipping, payment_method, confirm, return_url, off_session.
- `GET /v1/payment_intents` (list of the instance's intents), `GET / POST /v1/payment_intents/:id` (retrieve / update while open), `POST …/confirm`, `POST …/capture` (amount_to_capture, manual only), `POST …/cancel` (cancellation_reason), `GET /v1/payment_methods/:id`.
- Statuses: `requires_payment_method` → (`requires_confirmation` when a payment_method was set) → `requires_action` (3-D Secure) → `succeeded` / `processing` / `requires_capture`; `canceled`. A decline answers 402 `card_error` (with `payment_intent`) and the intent goes back to `requires_payment_method` with `last_payment_error`; it can be confirmed again.
- `next_action`: `use_stripe_sdk` (`three_d_secure_redirect`, the URL of the stubyard 3DS page) for Stripe.js confirms and server confirms without return_url; `redirect_to_url` (`url` + `return_url`) for a server confirm with return_url. The redirect ends at `return_url?payment_intent=…&payment_intent_client_secret=…&redirect_status=succeeded|failed|pending`.
- Test payment methods: `pm_card_visa`, `pm_card_visa_debit`, `pm_card_mastercard`, `pm_card_amex`, `pm_card_chargeDeclined` (and the `visa_` forms), `…InsufficientFunds`, `…ExpiredCard`, `…IncorrectCvc`, `…ProcessingError`, `pm_card_threeDSecure2Required`, `pm_card_threeDSecureRequired`, `pm_card_authenticationRequired`, the `tok_…` names of the same, plus any `pm_1…` / `tok_1…` created by Stripe.js. Forced outcomes (header, rules, test users) win over the card, as everywhere else.
- Raw card data (`payment_method_data[card][number]` / `card[cvc]`) is refused with Stripe's "Sending credit card numbers directly…" error and the new lint `pay.stripe-raw-card-data` (warn).
- Webhooks: `payment_intent.created`, `.requires_action`, `.processing`, `.amount_capturable_updated`, `.succeeded`, `.payment_failed`, `.canceled`, and `charge.succeeded` / `charge.captured` / `charge.failed` / `charge.refunded`. Signed like the existing Stripe events.
- Lints on create: `pay.no-idempotency-key`, `pay.no-reference` (no metadata), `pay.amount-precision`, `pay.currency-unknown`, `pay.return-url-missing-or-bad`.
- Publishable-key access (Stripe.js; `key=pk_test_…` in the query / form, no Authorization header, CORS for allowed origins only): `GET /v1/payment_intents/:id?client_secret=…` (no metadata) and `POST /v1/payment_intents/:id/confirm` (client_secret + payment_method). `sk_` and `pk_live_` keys are refused (401, live key lint); under `strictKeys` the key must be the instance's own; a refused origin gets 403.

### Embedded Checkout sessions (`stripe/index.ts`)
- `POST /v1/checkout/sessions` accepts `ui_mode=embedded_page` (and the older `embedded`). It needs `return_url` unless `redirect_on_completion=never`; `success_url` / `cancel_url` are refused as Stripe does; `redirect_on_completion` is `always` (default), `if_required` or `never` (with `return_url` refused for `never`).
- The session object then has `client_secret` (`cs_…_secret_…`), `ui_mode`, `return_url`, `redirect_on_completion`, `url: null`, `success_url: null`. Hosted sessions are unchanged.

### Fake Stripe.js v3 (`stripe/js.ts`)
- Served at `{instance}/js.stripe.com/v3/` (also `/v3`, `/v3/stripe.js` and `/js.stripe.com/<release>/stripe.js`, e.g. `basil`), `application/javascript`, no-store, CORP cross-origin.
- `Stripe(pk[, {locale}])` (with or without `new`; a secret key throws), `_registerWrapper`, `registerAppInfo`.
- `stripe.elements({clientSecret} | {mode, amount, currency})` → `create('payment' | 'card' | 'address' | 'linkAuthentication' | 'expressCheckout' | 'paymentRequestButton')`, `getElement`, `update`, `fetchUpdates`, `submit()`.
- Elements: `mount`, `unmount`, `destroy`, `on / off / once` (`ready`, `change`, `focus`, `blur`, `escape`), `update`, `focus`, `blur`, `clear`, `collapse`, `getValue` (address). Each element is an SDK-owned `.__PrivateStripeElement` wrapper with a stubyard iframe (`{base}/stripe-js/elements/<type>?ch&origin&lang`).
- `expressCheckout` / `paymentRequestButton` are placeholders (badge + "not simulated" note, `ready` fires); `paymentRequest().canMakePayment()` resolves `null`.
- `confirmPayment({elements, clientSecret?, confirmParams: {return_url, payment_method_data, receipt_email}, redirect})`: `IntegrationError` without return_url unless `redirect: 'if_required'`; deferred mode needs `elements.submit()` first (error `elements_submit_required`). With a redirect it sends the window to `return_url?payment_intent&payment_intent_client_secret&redirect_status` and never resolves; else `{paymentIntent}` or `{error}`.
- Also: `confirmCardPayment(cs, {payment_method: {card, billing_details} | 'pm_…'}, {handleActions})`, `handleNextAction({clientSecret})`, `handleCardAction`, `retrievePaymentIntent(cs)`, `createPaymentMethod({elements} | {type:'card', card})`, `createToken(cardElement)`.
- 3-D Secure: `requires_action` with `use_stripe_sdk` opens `{base}/stripe-js/3ds/<pi>` in a modal (Complete / Fail authentication); closing the modal fails it. Then the intent is retrieved and the result resolved.
- `initEmbeddedCheckout({fetchClientSecret | clientSecret, onComplete})` (alias `createEmbeddedCheckoutPage`) → `mount / unmount / destroy`. Only one at a time. The frame is the Stripe hosted page (`/c/pay/<cs>?client_secret&stubyard_sdk&stubyard_origin&stubyard_mode=embedded`); the entry checks the session is embedded, the secret and the origin. When paid the frame posts `complete`: `redirect_on_completion=always` sends the top window to return_url (`{CHECKOUT_SESSION_ID}` replaced), otherwise `onComplete` runs.
- Not simulated: `confirmSetup` / `confirmCardSetup` / `retrieveSetupIntent` (they resolve `{error: {code: 'stubyard_not_simulated'}}`), the split `cardNumber / cardExpiry / cardCvc` Elements (IntegrationError), wallets.

### Security
- Card digits stay in the element frames. A frame posts card facts only (brand, last 4, magic id, Luhn / test flags) to `{base}/stripe-js/confirm`, `/payment_methods` and `/tokens` (same origin, publishable key). A Luhn-valid non-test card is cleared in the frame and refused (`live_mode_test_card`).
- postMessage goes only to exact origins: the page to the stubyard origin of the script, the frames to the merchant origin the server checked (`origin=` against the instance sdkOrigins / project app origins; lint `pay.sdk-origin-unlisted` / `pay.sdk-origin-refused`). Never `*`, never `document.referrer`.
- TEST label inside every component: the kit strip in the Payment / Address Element frames, the Embedded Checkout page and the 3DS page; the SDK badge in the page wrapper of the single-line Card and Link Authentication Elements (their frames have no strip). EN / AR (`locale: 'ar'` / `lang=ar`), RTL, mobile widths.

### Demo shop (`sdk/stripe-demo.ts`)
- `{instance}/demo?mode=payment|card|deferred|embedded` (`&lang=ar`): Payment Element + Link Authentication with confirmPayment and return_url; Card Element with confirmCardPayment; deferred intent (`elements.submit()`, then `POST /demo/intent` creates the intent); Embedded Checkout. `/demo/result` prints the query and the status read back with the secret key.

### Connect panel
- New env: `STRIPE_PUBLISHABLE_KEY`, `STRIPE_JS_URL` (`{browser base}/js.stripe.com/v3/`). New notes on loading Stripe.js, CSP and origins.

### Shared files touched (small additions)
- `lint.ts`: `pay.stripe-raw-card-data`.
- `kit/registry.ts`: `stripe-checkout / embedded` and `stripe-checkout / payment-element` are now `realistic` (P4) with notes, docs and steps.
- `stripe/experience.ts`: the Embedded Checkout bridge (ready + auto-height on the pay page; `returnPage` / `resultScripts` post `complete`).
- `server/test/checkout-p2.e2e.test.ts`: one assertion said "Stripe Embedded Checkout stays planned"; it now expects `realistic`.

## How apps load the fake Stripe.js

1. Script tag: replace `https://js.stripe.com/v3/` with `STRIPE_JS_URL` (`{stubyard}/pay/<project>/<instance>/js.stripe.com/v3/`). Use `STRIPE_PUBLISHABLE_KEY` for `Stripe()` and point the server's Stripe client at `STRIPE_API_BASE` as before.
2. `@stripe/stripe-js` `loadStripe()`: it injects `https://js.stripe.com/v3` (or `/<release>/stripe.js`) unless `window.Stripe` already exists. Either:
   - add `<script src="STRIPE_JS_URL"></script>` before `loadStripe` runs. `loadStripe` then uses the fake `window.Stripe`. This works today, with no extension.
   - or, later, the extension redirect rule (declarativeNetRequest): `^https://js\.stripe\.com/(.*)$` → `{instance base}/js.stripe.com/\1`. The served script works under that rule: when `document.currentScript.src` is still `js.stripe.com` it falls back to the instance base the server embedded (`requestBase`). The script answers on `/js.stripe.com/v3`, `/v3/`, `/v3/stripe.js` and `/<release>/stripe.js`. No other endpoint is needed: everything else is under `{base}/stripe-js/…` and `{base}/v1/…` with CORS for allowed origins.
3. The app's CSP must allow the stubyard origin in `script-src`, `frame-src` and `connect-src`. Put the app origin in the project app origins (or the instance `sdkOrigins`); with neither list set every origin works and `pay.sdk-origin-unlisted` is recorded.

## Text for docs/AGENT_GUIDE.md (new `Z.22 "Stripe PaymentIntents and Stripe.js")
- Create intents with the secret key: `POST {STRIPE_API_BASE}/v1/payment_intents` (form-encoded, `Idempotency-Key`). Confirm from the browser with the fake Stripe.js, or from the server with a test PaymentMethod (`pm_card_visa`, `pm_card_chargeDeclined`, `pm_card_threeDSecure2Required` …).
- Test cards in the element frames: `4242 4242 4242 4242` success, `4000 0000 0000 0002` decline, `4000 0000 0000 3220` 3-D Secure (modal: Complete / Fail authentication). Any future expiry and CVC.
- Test ids: `stubyard-stripe-element` (wrapper, `data-type`), `stubyard-stripe-frame`, `stubyard-stripe-element-frame`, `stubyard-card` / `stubyard-card-expiry` / `stubyard-card-cvc` / `stubyard-card-error`, `stubyard-stripe-country`, `stubyard-stripe-name` / `-line1` / `-line2` / `-city` / `-postal`, `stubyard-stripe-email`, `stubyard-stripe-placeholder`, `stubyard-stripe-3ds-frame`, `stubyard-stripe-3ds`, `stubyard-3ds-complete`, `stubyard-3ds-fail`, `stubyard-3ds-done`, `stubyard-stripe-embedded-checkout`, `stubyard-stripe-checkout-frame`, `stubyard-sdk-badge`, `stubyard-sdk-overlay`, `stubyard-sdk-close`; demo: `stubyard-demo-pay`, `stubyard-demo-mode-<mode>`, `stubyard-demo-log`, `stubyard-demo-result`, `stubyard-demo-status`.
- Webhook order for one card payment: `payment_intent.created` → (`payment_intent.requires_action`) → `charge.succeeded` + `payment_intent.succeeded`; manual capture: `charge.succeeded` + `payment_intent.amount_capturable_updated`, then `charge.captured` + `payment_intent.succeeded`.

## GUIDE paragraph (Stripe section)
Stripe instances now also simulate PaymentIntents and Stripe.js. Load `STRIPE_JS_URL` instead of `https://js.stripe.com/v3/` and use `STRIPE_PUBLISHABLE_KEY`. The Payment Element, Card Element, Address and Link Authentication Elements, `confirmPayment` / `confirmCardPayment` with the 3-D Secure modal, and Embedded Checkout (`ui_mode: 'embedded_page'` + `initEmbeddedCheckout`) then work against stubyard. Every component carries the TEST label, and card numbers never leave stubyard's frames. Try it at `<instance>/demo`.

## CHANGELOG lines
- Stripe: PaymentIntents API (create / retrieve / update / list / confirm / capture / cancel, client_secret, next_action use_stripe_sdk and redirect_to_url for 3-D Secure, test PaymentMethods, payment_intent.* webhooks, publishable-key retrieve / confirm with CORS).
- Stripe: Embedded Checkout sessions (ui_mode embedded_page / embedded, return_url, redirect_on_completion).
- Stripe: fake Stripe.js v3 at `<instance>/js.stripe.com/v3/`: Elements (payment, card, address, linkAuthentication), confirmPayment, confirmCardPayment, handleNextAction, retrievePaymentIntent, createPaymentMethod, createToken, initEmbeddedCheckout; 3-D Secure modal; TEST label in every component; demo shop at `<instance>/demo`.
- Lint: `pay.stripe-raw-card-data`.

## Deviations / assumptions
- SetupIntents are not simulated; it was not cheap: no setup object, no saved-card reuse flow. `confirmSetup` and its friends resolve a `stubyard_not_simulated` error.
- The split card Elements (`cardNumber` / `cardExpiry` / `cardCvc`) throw an IntegrationError that names `card` / `payment` instead.
- A PaymentIntent is stored as a payment of kind `checkout_session` (the DB CHECK allows only `checkout_session` / `hpp` / `order`); it is told apart by its `pi_` reference. A canceled open intent is `expired` in stubyard's own status (`cancelled` when it was `requires_capture`); the Stripe JSON says `canceled`.
- The default capture_method is `automatic_async` (current Stripe default). `processing` appears only for async outcomes.
- The Payment Element offers card only (one "Card" tab). Wallets, Link and bank methods are not drawn. The element's layout, appearance and fonts are ignored; the look is stubyard's neutral kit.
- A Stripe.js confirm with a return_url still gets `use_stripe_sdk` (the modal), as real Stripe.js does for cards; only a server-side confirm with return_url gets `redirect_to_url`.
- The 3DS page has two buttons (Complete / Fail authentication), like Stripe's test page, not a password screen.
- The publishable-key intent omits `metadata` (the real one hides more fields).
- `STRIPE_JS_URL` ends in `/js.stripe.com/v3/` under the instance base, so the extension redirect only has to swap the host prefix.

## Tests
- `server/test/checkout-p4a.e2e.test.ts` (18): the PaymentIntents API (create / validation / list, confirm success, decline + retry, 3DS redirect_to_url round trip, 3DS use_stripe_sdk fail, manual capture, cancel, update, raw card refusal), publishable-key retrieve / confirm / CORS / refused origin, script paths, element frames (banner rules, AR, origin / channel checks), frame confirm (success, decline, 3DS modal, real card), payment methods / tokens, Embedded Checkout sessions (validation, entry checks, complete post with redirect, if_required), demo pages, the connect env.
- `server/test/checkout-p4a-sdk.test.ts` (13): happy-dom contract tests for `Stripe()`, Elements / mount / events (origin, channel and source checks), confirmPayment (if_required, redirect, decline, 3DS modal, deferred + submit), confirmCardPayment, retrievePaymentIntent, initEmbeddedCheckout (onComplete, redirect, one at a time, destroy), and the frame script (ready to the exact origin, card facts only, validation errors, foreign origins ignored).

## Next phase notes
- The extension's DNR rule for `js.stripe.com`: redirect to `{base}/js.stripe.com/\1`; the script already works when `currentScript.src` is the Stripe host.
- SetupIntents (`/v1/setup_intents`, `confirmSetup`, `mode: 'setup'` Elements) and saved cards (customer + `setup_future_usage` → reusable `pm_` for `off_session` confirms). `off_session` with a 3DS card already fails with `authentication_required` semantics (the decline path).
- Express Checkout Element / Payment Request Button with the shared wallet sheet (`sdk/wallet.ts`).
- Payment Element tabs for more methods (bank redirects as `redirect_to_url` next actions).
- `stripe.initCheckout` / the Checkout Sessions custom-UI SDK (ui_mode `custom`) is not started.

# Payments QA fixes (draft for the lead)

Fixes for the QA findings on the realistic payment experiences (P0 to P4), plus a quick headless Chrome pass over the P3 and P4 demos.

## High

- **The Geidea popup with a 3-D Secure card replaced the merchant page and never called back.** The bank page inside the 3-D Secure modal posted with `target="_top"`. When the hosted page is itself framed (the GeideaCheckout popup or drop-in), `_top` is the merchant page. The ACS frame now posts with `target="_parent"`, which is the hosted page. Verified in Chrome: `onSuccess` is logged and the demo stays open, at 390 and 1280 px, EN/AR, light/dark. (`kit/pages.ts` renderKitBank)
- **PayPal Card Fields frames had no TEST notice.** Each field frame now shows a small "TEST" tag inside the input (`data-testid="stubyard-test-banner"`, `role="note"`). The tag carries the full test notice as hidden text, and the input points to it with `aria-describedby`. The first rendered field also adds the SDK badge to the shop's container. (`pages.ts` renderCardFieldPage, `paypal/sdk.ts`)

## Medium

- **RTL: the card number was hidden under the brand badge.** `[dir=rtl] .k-pan .k-input` swaps the padding, so the badge side is padded in Arabic. (`kit/theme.ts`)
- **PayPal login validation answered HTTP 400.** Validation errors on custom steps now render the step again with the error and HTTP 200, like decline and OTP errors since P0. This covers PayPal login, Tabby phone/card and Tamara terms. A `select` with an unknown method is still 400, because a real page cannot send one. (`kit/router.ts`; tests in checkout-p1 and checkout-p3 updated)
- **The Geidea 3-D Secure modal overflowed on phones (about 330 px of chrome).** Three changes:
  - The modal goes full screen at <= 480 px wide or <= 640 px high, and the box never exceeds the viewport.
  - The bank page inside the frame uses a compact header.
  - A Geidea page opened through the SDK uses the strip banner instead of the full one (`HppConfig.bannerStrip`).
  - The SDK overlay (`SY.overlay`) has no padding and no rounded corners below 480 px.
  - Verified: at 390 px both ACS buttons are inside the frame without scrolling. (`kit/theme.ts`, `kit/hpp.ts`, `geidea/experience.ts`, `sdk/runtime.ts`)
- **The MyFatoorah mada test card 4464040000000007 was refused.** Gateways can now declare their own `testCards`. These cards are accepted by the card form and by the server's card check (not "real card"):
  - MyFatoorah: `MF_TEST_CARDS` (5123450000000008, 4508750015741019, 4012000033330026, 5111111111111118, 4464040000000007).
  - Geidea: `GEIDEA_TEST_CARDS` (5123450000000008, 4440000042200014, 4464040000000007, 5111111111111118).
  - Verified: the hosted MyFatoorah page pays with the mada card (brand mada, last 4 0007).
- **Classic Stripe page contrast.** Light: `--faint` #677080. Dark: `--faint` #8b929e, and primary buttons use `--accent-btn` (#4f46e5 light, #5850ec dark) with white text. The low-contrast check reports nothing on the classic page or the demo pages, in light and dark. (`pages.ts`)
- **Moyasar `language: 'ar'` was not carried to the 3-D Secure page.** The form frame sends `stubyard_lang` with the payment request. `/mpf/payments` strips it before the request is stored and saves it as the payment's `checkoutView.locale`. The 3-D Secure page then opens in Arabic. (`moyasar/form.ts`, `moyasar/index.ts`)

## Low

- Dark demo primary buttons: same `--accent-btn` fix as the classic page.
- Demo copy under `?lang=ar`: the Moyasar, Geidea and PayPal demo paragraphs, buttons and the Card Fields heading now have Arabic text. The demo subtitle is also translated.
- The PayPal number frame was 96 px with a gap. Every field frame now starts at 56 px and reports its real height (`event: 'resize'`, clamped to 44 to 240 px). It grows when an error shows and shrinks back when the error clears.
- Apple Pay / Google Pay wallet sheet: the card labels are Arabic in AR (`walletCardLabel`).
- The banner at 390 px is more compact (smaller padding and font). The tap targets of its buttons keep their size.
- PayPal "Ship to": long mono text wraps at word boundaries where possible (`overflow-wrap: anywhere` instead of `word-break: break-all`).
- MyFatoorah and Geidea entry URLs keep `?ui`, `?stubyard_ui`, `?stubyard_lang` and `?stubyard_drawer` on the redirect to the page (`viewQueryString` in `kit/view.ts`).
- A demo opened on 127.0.0.1 (or any other stubyard origin) no longer hits CSP errors. Every demo page adds the stubyard origins of the request to `script-src`, `frame-src`, `child-src` and `connect-src` (`demoCsp` in `sdk/demos.ts`).

## Found in the P3 / P4 demo pass

- **Stripe deferred-intent demo: "Pay" failed with a 404.** The page posted to the relative URL `intent`. From `{instance}/demo?mode=deferred` that resolves to `{instance}/intent`. It now posts to `location.pathname + '/intent'`. (`sdk/stripe-demo.ts`)

The pass covered:
- the Tabby, Tamara, JazzCash and Easypaisa hosted pages;
- the TabbyPromo, TabbyCard, Tamara widget and PayPal Messages widgets on a plain product page;
- Stripe.js in the payment, card, deferred and embedded modes;
- Checkout.com Flow, the Tap Card SDK, MyFatoorah session.js, PayTabs paylib and the APS Merchant Page.

Each ran at 390 and 1280 px, in EN/AR and light/dark. The checks were:
- no horizontal scroll and no covered controls;
- no contrast failures;
- the TEST label inside every visible component;
- RTL in Arabic;
- callbacks logged:
  - Stripe `succeeded`;
  - Checkout `onReady/onChange/tokenized`;
  - MyFatoorah `Paid`;
  - PayTabs `Authorised` and the error callback;
  - APS `TOKENIZATION` form;
  - Tap redirect to the 3-D Secure page.

There were no other console errors. The only console warnings came from the test page itself: TabbyCard without publicKey, and a Tamara key mismatch. Those warnings are intended.

## Dashboard

- Each checkout instance card for a preset with a demo shop (Stripe, PayPal, Moyasar, Geidea, HyperPay, Checkout.com, Tap, MyFatoorah, PayTabs, APS) has a "Demo shop" link to `{browser base}/demo` (`data-testid="checkout-demo-<slug>"`). (`web/src/components/CheckoutExperience.tsx`, `web/src/styles/payments-checkout.css`)

## Deviations

- `select` with an unknown method still answers 400. Only form-validation errors moved to 200.
- The Card Fields TEST notice is a small "TEST" tag plus hidden full text, not the full strip: a 44 to 56 px field has no room for the strip. The shop container also gets the SDK badge.
- The Moyasar language travels as an extra body field `stubyard_lang`, which is removed before the request is stored. The real Moyasar API never sees or returns it.
- Demo copy is translated only for the visible paragraph, buttons and headings. Log lines stay English, like a developer console.
- AGENT_GUIDE: the MyFatoorah and Geidea test-card lists are now backed by the gateways' `testCards`. If the guide lists these cards, the text still holds. The lead may want to say that these numbers are accepted without the real-card warning.

## Tests

- checkout-kit: the ACS frame posts with `target="_parent"`.
- checkout-p1:
  - PayPal empty login answers 200 with the error;
  - the MyFatoorah card form accepts its own test cards (mada included).
- checkout-p2:
  - every Card Fields frame has the TEST notice and the resize message;
  - the AR wallet sheet has Arabic card labels;
  - the PayPal demo has Arabic copy and the request origin in `frame-src`;
  - the Moyasar `stubyard_lang` goes to `checkoutView.locale` and is not stored in the request;
  - the Geidea entry redirect keeps `?ui` and `?stubyard_lang`.
- checkout-p3: Tabby phone/card and Tamara terms validation steps answer 200.
- checkout-p4a: the deferred demo posts to `/demo/intent`.

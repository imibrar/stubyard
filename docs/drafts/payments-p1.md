# Payments P1: redirect hosted pages (draft for the lead to merge)

## For docs/AGENT_GUIDE.md §Z.22 "Checkout experiences": replace "The other gateways use a generic realistic page for now." with:

Nine more gateways have their own realistic layout (P1). Tabby, Tamara, JazzCash and Easypaisa still use the generic realistic page.

| Gateway | Layout (`data-layout`) | Flow on the realistic page |
| --- | --- | --- |
| Checkout.com HPP / payment link | `checkout-hpp` | One page: method tabs (card, mada, Apple Pay), card fields, cardholder, Pay, "Back to store" (cancel_url). 3-D Secure is a **full-page redirect** to the simulated ACS page (`…/x/acs`), then success_url / failure_url with `cko-payment-id`. A `/3ds/<id>` payment (card already sent to `POST /payments`) opens the ACS page directly and returns with `cko-session-id`. |
| PayTabs HPP | `paytabs-hpp` | Cart, method tabs, card fields, Pay / Cancel; 3-D Secure full page; then a "Redirecting in 3…" page that POSTs the usual return fields (GET with `return_using_get`: the plain 303 as before). `framed: true`: compact page; `framed_return_top` / `framed_return_parent` submit the return into that window; with no return URL the result page sends `postMessage('hppDone', <origin of framed_message_target>)` to the parent (never `*`, never `document.referrer`; no target, no message). |
| Amazon Payment Services (redirection) | `aps-hosted` | Method list, cardholder, card fields, Pay / Cancel; KNET goes to the simulated KNET page; 3-D Secure full page; the signed response fields are POSTed to return_url as before. |
| Tap hosted | `tap-hosted` | Method list (card, mada, KNET, BENEFIT, Apple Pay by source), card form with "Save card" (display only), KNET / BENEFIT go to the simulated bank page; 3-D Secure full page; return `?tap_id=`. A single-method charge (`src_kw.knet`, `src_bh.benefit`) opens the bank page directly; a `tok_` charge opens the ACS page directly. |
| MyFatoorah | `myfatoorah-hosted` | **Method selection first** (the country's methods: KNET, VISA/MASTER, MADA, Benefit, Apple Pay, STC Pay), then that method's screen with "Change payment method"; KNET / Benefit go to the bank page; return `?paymentId=&Id=` (CallBackUrl, or ErrorUrl on failure / cancel). A single method skips the selection. |
| Moyasar invoice | `moyasar-invoice` | Invoice description as heading, invoice id, method tabs (mada, card, Apple Pay, STC Pay + OTP), Back (back_url); 3-D Secure full page. A payment created with `source.type=creditcard` opens the ACS page directly. |
| PayPal approval | `paypal-approval` | **Login → review → approve.** Login: email (prefilled with the payer email) and a password that is never sent; "Log In". Review: "Logged in as", "PayPal balance (simulated)", ship-to (hidden with `NO_SHIPPING`), "Not you?" (back to login), and the button "Pay Now" (`user_action: PAY_NOW`), "Continue" (otherwise) or "Agree & Subscribe" (subscriptions); "Cancel and return to <shop>". Return `return_url?token=&PayerID=` / cancel_url as before. A Decline outcome approves the order and fails at your capture call, exactly as on the classic page. |
| Geidea | `geidea-hpp` | Card form, Pay / Cancel; 3-D Secure in a **modal** over the page; return with `responseCode`, `orderId`, `signature`… as before. |
| HyperPay COPYandPAY | `hyperpay-widget` | The widget iframe (`/widget/<id>`) is a compact form with the `data-brands` as text, card fields, Pay (submits the top window); 3-D Secure full page; return `?id=&resourcePath=`. |

**Simulated bank pages (KNET / BENEFIT)**, `[data-testid="stubyard-bank-page"]` with `data-bank="knet|benefit"`: bank select (KNET: "Test bank 1/2/3"), card number, month / year, PIN (BENEFIT: also cardholder name), Submit (`stubyard-pay`) and Cancel (`stubyard-bank-cancel`). The card number and PIN are never sent to stubyard. On MyFatoorah pages the documented test cards work: KNET `8888 8800 0000 0001` with 09/30 approves (another expiry declines); BENEFIT `4600 4101 2345 6789` approves, `4550 1201 2345 6789` expired card, `4845 5501 2345 6789` / `4575 5501 2345 6789` / `4895 5501 2345 6789` decline. Elsewhere Submit approves; use the Test controls for other outcomes.

**Simulated ACS page (full-page 3-D Secure)**: `[data-testid="stubyard-3ds-bank"]`, a code input (`stubyard-3ds-code`, any code works), Authenticate (`stubyard-3ds-pass`) / Fail (`stubyard-3ds-fail`). Checkout.com's page mentions its sandbox password `Checkout1!` (marked unverified).

**Primary button per first screen** (for automation): `stubyard-pay` everywhere except the PayPal login (`stubyard-login`, then `stubyard-pay` on the review) and the MyFatoorah selection (`stubyard-method-<method>` buttons, then `stubyard-pay`). Decline / Cancel shortcuts (`stubyard-decline`, `stubyard-cancel`) and the drawer finish the payment from any screen, including the login and the selection screen. Steps are kept in order on the server: skipping or replaying one (for example POSTing the review before the login, or the bank page twice) is refused with a 409 page.

**New lint check**: `pay.hpp-framed` (warn). The Checkout.com HPP / payment link or the APS redirection page was loaded in an iframe (`Sec-Fetch-Dest: iframe`). The real pages refuse to be framed and would stay blank; stubyard still shows them.

**Fidelity tags** (Payments → Checkout pages, and the Test controls drawer, which now lists the flow steps with a tag each): API behaviour is unchanged by P1 (`api: verified` as before). Screens: Checkout.com HPP `partial` (public docs and research); all other P1 layouts `assumed` (built from the documented steps; no current screenshots compared). Steps marked "unverified" in the drawer follow the documented flow but were not compared with the live page.

## For docs/GUIDE.md §6 (payments), one paragraph

Realistic pages now follow each provider's own flow for Checkout.com, PayTabs (including framed mode), Amazon Payment Services, Tap, MyFatoorah, Moyasar invoices, PayPal (login, review, approve), Geidea and HyperPay: method choice the way the provider shows it, 3-D Secure as a full-page bank page (a modal on Stripe and Geidea), and simulated KNET / BENEFIT bank pages. Return URLs, return parameters and webhooks are the same as before, so switching between the realistic and classic view never changes what your app receives. Every page stays in the neutral stubyard look with the TEST notice, in English or Arabic (right to left), and works on phones.

## For CHANGELOG.md (lead)

- Payments P1: realistic hosted pages for Checkout.com (HPP + full-page ACS), PayTabs (HPP, framed mode, hppDone to the configured origin), APS redirection, Tap (KNET / BENEFIT bank pages), MyFatoorah (method selection), Moyasar invoice, PayPal (login → review → approve), Geidea and HyperPay; new lint `pay.hpp-framed`; returns and webhooks unchanged.

## For the next phase

- Layouts live in `server/src/payments/<gateway>/experience.ts` and are registered in `kit/dispatch.ts` (`LAYOUTS`). Most are a configuration of `kit/hpp.ts` (`hostedLayout(cfg, { threeds, bankMethods, bankRules, select, acsDirect, returnPage, resultScripts, embedOk })`). PayPal shows the custom-step pattern: `steps` (flow, next, back, validate, answers) + `renderStep`, served by `POST x/<step>` in `kit/router.ts`. Add a step name to `X_RE` in the router and a flow to `FLOWS` in `kit/flow.ts`.
- `ProviderLayout.prepare` runs at the GET of the page (start PayPal's login flow, open the ACS or bank page directly). It is skipped in the classic view.
- The generic page still has the P0 behaviour (3-D Secure answered on a full bank page in the x/pay response); no gateway uses it with cards any more, so that path is no longer covered by an e2e test.
- Moyasar STC Pay and PayTabs / MyFatoorah STC Pay keep the kit OTP screen (`renderKitOtp`); a provider-styled OTP screen would be a P2 item.
- Not done: Arabic provider wording was written by the builder and has not been reviewed (the AR notice says so); screen fidelity (all P1 layouts except the Checkout.com HPP are `assumed`) needs screenshots; the PayPal guest card ("Pay with Debit or Credit Card") is not offered on the login page (card orders keep the card form).

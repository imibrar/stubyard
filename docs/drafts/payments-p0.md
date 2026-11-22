# Payments P0: checkout pages (draft for the lead to merge)

## For docs/AGENT_GUIDE.md, new section §Z.22 "Checkout experiences"

### Z.22 Checkout experiences (realistic and classic payment pages)

Every hosted payment page stubyard serves, for all 14 gateways, carries a test notice that cannot be switched off:
"TEST · stubyard simulator · not a real payment, no money moves" (Arabic: "تجربة · محاكي stubyard · ليست عملية دفع حقيقية، ولا تُنقل أي أموال").
Every page title starts with `[TEST] `. The notice may shrink to a thin strip on later screens (3-D Secure, OTP, result) but is never hidden.
Selectors: `[data-testid="stubyard-test-banner"]`.

**Two views per payment provider (instance config `experience`):**

- `realistic`: the page follows the provider's own flow. Test shortcuts sit in a collapsible "Test controls" drawer (`[data-testid="stubyard-drawer"]`): outcome of the Pay button, test user, magic cards, other outcomes (abandon, the decline reasons), language, a link to the classic view. Pay (`stubyard-pay`), Decline (`stubyard-decline`) and Cancel (`stubyard-cancel`) are on the page without opening the drawer. Stripe Checkout has its own layout (order summary with line items, email, card fields, cardholder, country, back arrow to `cancel_url`; decline on the same page; 3-D Secure in a modal with the simulated bank in a frame). The other gateways use a generic realistic page for now.
- `classic`: the earlier stubyard page, every test button in view. Unchanged apart from the notice and the `[TEST]` title.

New instances start on `realistic`. Instances created before this feature, and instances imported from an export that has no `experience` key, stay on `classic`. Switch with one click in the dashboard (Payments → Checkout pages) or:

```
PATCH /api/projects/<project>/payment-instances/<slug>   {"config": {"experience": "realistic"}}
```

**Other instance settings (realistic view only):**

| key | values | default | effect |
| --- | --- | --- | --- |
| `pageLocale` | `auto`, `en`, `ar` | `auto` | `auto` uses the language the request asked for (Stripe `locale`, PayTabs `paypage_lang`, ...), else English. `ar` gives a right-to-left page. |
| `pageTimings` | `auto`, `realistic`, `fast` | `auto` | Short Pay spinner and "contacting your bank" pause. `auto` skips them when the browser reports automation (`navigator.webdriver`). Timings are in the browser only; server answers are never delayed. |
| `pageDrawer` | `closed`, `open` | `closed` | Whether the Test controls drawer starts open. |

**Per-payment overrides on the page URL** (they stick for that payment): `?ui=classic` or `?ui=realistic`, `?stubyard_lang=ar`, `?stubyard_drawer=open`.

**Endpoints of the realistic page** (relative to `/pay/<project>/<instance>/page/<id>`): `POST x/pay` (the form and OTP step, same fields as the classic `/complete`), `GET x/acs` (simulated bank frame), `POST x/3ds` (`outcome=3ds_success|3ds_fail`), `POST x/notice`. The classic `POST .../complete` keeps working on every payment, whatever the view, so existing tests that post to it are unaffected. A 3-D Secure step answered twice, or answered before it was shown, gets 409 (`[data-testid="stubyard-step-error"]`, `data-reason="replay|skip"`).

**Hidden notice:** if the page sees its notice hidden, cropped or moved off screen (for example a frame of your app that is too small), it reports it once. The payment gets the lint finding `pay.test-notice-hidden` (warn) and the event `test_notice_hidden`. The payment is never refused because of it.

**Fidelity:** `GET /api/payment-presets` lists `experiences` per preset: each integration mode with `status` (`realistic`, `generic`, `sdk`, `planned`, `none`), the delivery phase, and two separate tags: `api` (requests, responses and webhooks against the provider's docs) and `screens` (the page against the real screens). Each tag is `verified`, `partial` or `assumed`. The pages never use provider logos, brand colours or fonts; the provider appears only as text, for example "Stripe (simulated)".

**Browser automation tips:** wait for `[data-testid="stubyard-pay"]`; magic cards still work (type the number, or pick a chip in the drawer); a 3-D Secure card opens `[data-testid="stubyard-3ds-modal"]` on Stripe, whose frame holds `stubyard-3ds-pass` / `stubyard-3ds-fail`; other gateways show the full bank page (`stubyard-3ds-bank`).

## For docs/GUIDE.md §6 (Payments), one paragraph

**Realistic and classic payment pages.** stubyard's payment pages come in two views. The realistic view looks and behaves like the provider's checkout (Stripe Checkout first: order summary, card form, 3-D Secure in a pop-up, decline on the same page), with stubyard's test shortcuts tucked into a "Test controls" drawer. The classic view is the original page with every test button in view. New payment providers start realistic; older ones stay classic until you switch them under Payments → Checkout pages, one click per provider. Both views always show a "TEST · stubyard simulator · not a real payment, no money moves" notice and a [TEST] page title, so nobody mistakes them for a real checkout. The pages can be English or Arabic (right to left), picked from the request's language or set per provider.

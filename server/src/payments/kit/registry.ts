import type { PaymentPresetId } from '../repo.js';

/**
 * Provider × integration mode registry of the checkout experiences, with fidelity tags split into what the
 * provider's API is known to do and what its screens are known to look like (plans-final B, Fable review 13).
 *
 * - verified: stated in the provider's official docs (research R1-R3).
 * - partial: the API is documented, the screens are assembled from general knowledge.
 * - assumed: no public source; built from the documented steps only.
 *
 * status says what this build serves for the mode:
 * - realistic: a provider-recognisable layout of the checkout kit (behind the instance's realistic switch);
 * - generic: the kit's generic hosted page (banner, drawer, EN/AR), the provider layout is planned;
 * - sdk: works today through stubyard's fake SDK with the generic look;
 * - planned: not simulated yet, planned for the phase given;
 * - none: not planned.
 */

export type Fidelity = 'verified' | 'partial' | 'assumed';
export type ModeKind = 'redirect' | 'popup' | 'embedded' | 'fields' | 'steps' | 'promo';
export type ModeStatus = 'realistic' | 'generic' | 'sdk' | 'planned' | 'none';

/** Kit layouts of the hosted pages: a provider layout (stripe/experience.ts, checkout/experience.ts, …) or the generic page. */
export const LAYOUT_IDS = ['stripe-hosted', 'checkout-hpp', 'paytabs-hpp', 'aps-hosted', 'tap-hosted', 'myfatoorah-hosted', 'moyasar-invoice', 'paypal-approval', 'geidea-hpp', 'hyperpay-widget', 'tabby-hpp', 'tamara-hpp', 'jazzcash-hosted', 'easypaisa-hosted'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

/** One screen of a mode's flow with its own screens tag (most screens are documented only in part). */
export interface FlowStepInfo {
  id: string;
  label: string;
  screens: Fidelity;
}

export interface ExperienceMode {
  preset: PaymentPresetId;
  /** Stable id within the preset ("hosted", "buttons-popup"). */
  mode: string;
  kind: ModeKind;
  label: string;
  status: ModeStatus;
  /** Kit layout used on the hosted page for this mode (realistic / generic only). */
  layout: LayoutId | 'generic' | null;
  api: Fidelity;
  screens: Fidelity;
  /** Delivery phase of the realistic layout (P0 = this build). */
  phase: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
  notes?: string;
  docs?: string[];
  /** The screens of this mode in order, each with its own screens tag (shown in the drawer and the dashboard). */
  steps?: FlowStepInfo[];
}

const m = (preset: PaymentPresetId, mode: string, kind: ModeKind, label: string, status: ModeStatus, api: Fidelity, screens: Fidelity, phase: ExperienceMode['phase'], extra: Partial<ExperienceMode> = {}): ExperienceMode => ({
  preset,
  mode,
  kind,
  label,
  status,
  layout: status === 'realistic' || status === 'generic' ? 'generic' : null,
  api,
  screens,
  phase,
  ...extra,
});

export const EXPERIENCES: readonly ExperienceMode[] = [
  m('stripe-checkout', 'hosted', 'redirect', 'Checkout (hosted page, redirect)', 'realistic', 'verified', 'partial', 'P0', {
    layout: 'stripe-hosted',
    notes: 'Two-column summary + payment form, card validation, decline on the same page, 3D Secure in a modal frame, success_url / cancel_url redirects.',
    docs: ['https://docs.stripe.com/payments/checkout/how-checkout-works', 'https://docs.stripe.com/payments/3d-secure/authentication-flow'],
  }),
  m('stripe-checkout', '3ds-modal', 'popup', '3D Secure modal', 'realistic', 'verified', 'partial', 'P0', { layout: 'stripe-hosted' }),
  m('stripe-checkout', 'embedded', 'embedded', 'Embedded Checkout (ui_mode embedded_page)', 'realistic', 'verified', 'partial', 'P4', {
    layout: 'stripe-hosted',
    notes: 'Checkout Session with ui_mode embedded_page / embedded (return_url, redirect_on_completion always / if_required / never; success_url and cancel_url are refused). stripe.initEmbeddedCheckout({ fetchClientSecret, onComplete }) mounts the hosted page in a stubyard frame (origin checked against sdkOrigins / app origins); when paid it calls onComplete or sends the top window to return_url ({CHECKOUT_SESSION_ID} replaced).',
    docs: ['https://docs.stripe.com/checkout/embedded/quickstart', 'https://docs.stripe.com/js/embedded_checkout/init'],
    steps: [{ id: 'mount', label: 'initEmbeddedCheckout → mount (frame)', screens: 'partial' }, { id: 'pay', label: 'Card form, 3D Secure modal', screens: 'partial' }, { id: 'complete', label: 'onComplete or return_url redirect', screens: 'verified' }],
  }),
  m('stripe-checkout', 'payment-element', 'fields', 'Payment Element / Card Element (PaymentIntents, Stripe.js v3)', 'realistic', 'verified', 'partial', 'P4', {
    layout: null,
    notes: 'Fake Stripe.js at {base}/js.stripe.com/v3/: Stripe(pk).elements({ clientSecret } | { mode, amount, currency }).create(payment | card | address | linkAuthentication).mount(), confirmPayment / confirmCardPayment / handleNextAction / retrievePaymentIntent / createPaymentMethod / createToken. Elements are stubyard frames (card digits never reach the page); 3D Secure (next_action use_stripe_sdk) opens a modal, a server confirm with return_url gets redirect_to_url. PaymentIntents API: create / retrieve / update / confirm / capture (manual) / cancel / list with payment_intent.* webhooks. SetupIntents are not simulated.',
    docs: ['https://docs.stripe.com/payments/payment-element', 'https://docs.stripe.com/api/payment_intents', 'https://docs.stripe.com/js/payment_intents/confirm_payment'],
    steps: [{ id: 'elements', label: 'Elements frames (payment, card, address, email)', screens: 'assumed' }, { id: 'confirm', label: 'confirmPayment → 3D Secure modal', screens: 'partial' }, { id: 'return', label: 'return_url?payment_intent&redirect_status', screens: 'verified' }],
  }),
  m('paypal', 'redirect', 'redirect', 'Approval page (redirect): log in → review → approve', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'paypal-approval',
    notes: 'Orders API, return_url ?token=&PayerID= and cancel_url are as before. The login and review screens are built from the documented steps only (no public screen spec); the review button follows experience_context.user_action (PAY_NOW → "Pay Now", else "Continue"). Guest card checkout on this page uses a plain card form.',
    docs: ['https://developer.paypal.com/docs/checkout/standard/integrate/', 'https://developer.paypal.com/docs/api/orders/v2/#orders_create'],
    steps: [{"id":"login","label":"Log in (email + password, any value)","screens":"assumed"}, {"id":"review","label":"Review: ship to, pay with, total, Pay Now / Continue","screens":"assumed"}, {"id":"return","label":"Back to return_url (?token=&PayerID=) or cancel_url","screens":"verified"}],
  }),
  m('paypal', 'buttons-popup', 'popup', 'JS SDK Buttons (popup / overlay): PayPal, Pay Later, card', 'realistic', 'verified', 'assumed', 'P2', {
    layout: 'paypal-approval',
    notes: 'paypal.Buttons renders neutral stacked buttons (PayPal, Pay Later, Debit or Credit Card) with the TEST notice; the approval page opens in a popup (or an overlay, buttonsMode "inline"); Pay Later shows Pay in 4 / Pay Monthly offers on the review screen. onClick, createOrder, onApprove (actions.order.capture / authorize), onCancel, onError as documented. The close page posts only to the page origin the server accepted.',
    docs: ['https://developer.paypal.com/sdk/js/reference/', 'https://developer.paypal.com/docs/checkout/pay-later/us/'],
    steps: [{ id: 'buttons', label: 'Buttons on the shop page', screens: 'assumed' }, { id: 'login', label: 'Popup: log in', screens: 'assumed' }, { id: 'review', label: 'Popup: review (Pay Later: offers)', screens: 'assumed' }, { id: 'approve', label: 'onApprove → capture on the server', screens: 'verified' }],
  }),
  m('paypal', 'card-fields', 'fields', 'Card Fields', 'realistic', 'verified', 'assumed', 'P2', {
    notes: 'NumberField / ExpiryField / CVVField / NameField are stubyard iframes posting only brand / last 4 / validity to the page origin; submit() confirms the card (SCA_ALWAYS or the 3DS card: challenge overlay) and calls onApprove with liabilityShift.',
    docs: ['https://developer.paypal.com/docs/checkout/advanced/integrate/'],
  }),
  m('paypal', 'pay-later-messages', 'promo', 'Pay Later messages', 'realistic', 'verified', 'partial', 'P3', {
    layout: null,
    notes: 'components=messages: paypal.Messages({amount, currency, placement, style, onRender, onClick}).render(selector) and the [data-pp-message] auto-render (data-pp-amount, data-pp-placement, data-pp-style-*). Learn more opens the info popup. The offers shown are simulated (Pay in 4 / Pay Monthly); no credit check.',
    docs: ['https://developer.paypal.com/docs/checkout/pay-later/us/integrate/reference/'],
  }),
  m('checkout', 'hpp', 'redirect', 'Hosted Payments Page / Payment Links', 'realistic', 'verified', 'partial', 'P1', {
    layout: 'checkout-hpp',
    notes: 'Single centred page: order summary, payment method list, card number / expiry / CVV / name, Pay. 3D Secure is a full-page redirect to the simulated ACS. Returns to success_url / failure_url / cancel_url with cko-payment-id as before. The real HPP cannot be framed: stubyard only reports it (lint pay.hpp-framed), it never refuses.',
    docs: ['https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-a-hosted-page'],
    steps: [{"id":"pay","label":"Summary + method list + card form","screens":"partial"}, {"id":"acs","label":"3D Secure: full-page redirect to the issuer ACS","screens":"partial"}, {"id":"return","label":"Redirect with cko-payment-id","screens":"partial"}],
  }),
  m('checkout', '3ds-acs', 'redirect', 'Payments API 3D Secure (_links.redirect → ACS page)', 'realistic', 'verified', 'partial', 'P1', {
    layout: 'checkout-hpp',
    notes: 'A card payment created with 3ds.enabled opens the simulated ACS page directly (the card was already sent to the API).',
    steps: [{"id":"acs","label":"Issuer ACS page (code entry, any code)","screens":"assumed"}, {"id":"return","label":"Redirect to success_url / failure_url with cko-session-id","screens":"partial"}],
  }),
  m('checkout', 'flow', 'fields', 'Flow (web components)', 'realistic', 'verified', 'partial', 'P4', {
    notes: 'POST /payment-sessions → CheckoutWebComponents({ publicKey, paymentSession }) → create("flow" | "card").mount(): a stubyard frame with the card form. submit() (or your handleSubmit) pays the session; 3-D Secure as a full-page redirect, back with cko-payment-id. Wallets and APMs inside Flow, translations and Frames are not simulated.',
    docs: ['https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-your-website/flow-library-reference'],
    steps: [{ id: 'session', label: 'POST /payment-sessions (server)', screens: 'verified' }, { id: 'mount', label: 'create("flow").mount(): card form frame', screens: 'assumed' }, { id: 'acs', label: '3-D Secure: full-page redirect', screens: 'partial' }, { id: 'return', label: 'success_url?cko-payment-id', screens: 'verified' }],
  }),
  m('aps', 'redirection', 'redirect', 'Redirection (hosted form POST)', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'aps-hosted',
    notes: 'The merchant form POSTs to /FortAPI/paymentPage; the page shows the order header, a method selector, card number / holder name / expiry / CVV (+ "save card" with remember_me=YES), Pay; 3D Secure is a full-page ACS redirect; KNET goes to a simulated KNET page; the result is the signed form POST to return_url as before. The hosted page screens are not in the fetched docs. The real page must not be framed: lint pay.hpp-framed only.',
    docs: ['https://paymentservices.amazon.com/docs/accepting-payments/hosted-checkout/integrate'],
    steps: [{"id":"pay","label":"Order header + method selector + card form","screens":"assumed"}, {"id":"acs","label":"3D Secure ACS redirect","screens":"assumed"}, {"id":"bank","label":"KNET bank page (KWD)","screens":"assumed"}, {"id":"return","label":"Signed form POST to return_url","screens":"verified"}],
  }),
  m('aps', 'merchant-page', 'embedded', 'Merchant Page (iframe)', 'realistic', 'verified', 'assumed', 'P4', {
    notes: 'Signed TOKENIZATION form POSTed into your iframe → stubyard card form → signed return (18000, token_name) inside the iframe → PURCHASE / AUTHORIZATION with token_name → 3ds_url (20064). Merchant Page 2.0 is skipped (no source, plans-final D10).',
    docs: ['https://paymentservices-reference.payfort.com/docs/api/build/index.html#merchant-page'],
    steps: [{ id: 'form', label: 'Card form in the iframe', screens: 'assumed' }, { id: 'token', label: 'Return with token_name (18000)', screens: 'verified' }, { id: 'acs', label: 'PURCHASE → 3ds_url (top window)', screens: 'assumed' }, { id: 'return', label: 'Signed form POST to return_url', screens: 'verified' }],
  }),
  m('paytabs', 'hpp', 'redirect', 'Hosted payment page', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'paytabs-hpp',
    notes: 'Cart description and amount, method tabs (card, mada, STC Pay, Apple Pay), card form, Pay; 3D Secure ACS redirect; STC Pay mobile + OTP; then a result screen that returns to the shop (form POST, or GET with return_using_get) after a short countdown. The countdown is not documented (assumed).',
    docs: ['https://docs.paytabs.com/manuals/PT-API-Endpoints/Integration-Types-Manuals/Hosted-Payment-Page/HPP-Step-3-Initiating-Payment/HPP-Payment-Workflow/'],
    steps: [{"id":"pay","label":"Method tabs + card form","screens":"assumed"}, {"id":"acs","label":"3D Secure ACS page","screens":"assumed"}, {"id":"otp","label":"STC Pay OTP","screens":"assumed"}, {"id":"result","label":"Result screen with a countdown, then the return","screens":"assumed"}],
  }),
  m('paytabs', 'framed', 'embedded', 'Framed hosted page (framed=true)', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'paytabs-hpp',
    notes: 'framed=true: a compact page for the merchant iframe. The return opens in the frame (framed), the top window (framed_return_top) or the parent frame (framed_return_parent). Without a return URL and with framed_message_target, the result page posts "hppDone" to the origin of framed_message_target (never "*", never document.referrer). The docs are inconsistent about the return location; built from the parameter list.',
    docs: ['https://docs.paytabs.com/manuals/PT-API-Endpoints/Integration-Types-Manuals/Request-Response-Parameters/Request-Response-Framed/'],
  }),
  m('paytabs', 'paylib', 'fields', 'Managed form (paylib.js)', 'realistic', 'verified', 'assumed', 'P4', {
    notes: 'paylib.inlineForm({ key, form, autoSubmit, callback }) on your data-paylib inputs adds payment_token and submits; POST /payment/request with payment_token answers redirect_url (3-D Secure) or payment_result. Unlike the real paylib, only card facts (never the digits) leave the page.',
    docs: ['https://support.paytabs.com/en/support/solutions/articles/60000711358-what-is-the-paytabs-managed-form-'],
    steps: [{ id: 'form', label: 'Your form + paylib (TEST label in the form)', screens: 'assumed' }, { id: 'request', label: 'payment_token → /payment/request', screens: 'assumed' }, { id: 'acs', label: '3-D Secure redirect', screens: 'assumed' }, { id: 'return', label: 'Signed return', screens: 'verified' }],
  }),
  m('hyperpay', 'widget', 'embedded', 'COPYandPAY widget (paymentWidgets.js)', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'hyperpay-widget',
    notes: 'The widget form (brand row from data-brands, card number with brand detection, holder, MM / YY expiry, CVV, "Pay now"), in the widget frame or opened as a page. 3D Secure is a redirect to the simulated ACS; the result is the redirect to shopperResultUrl with resourcePath as before. The wpwlOptions subset (style, locale, callbacks) comes in P2.',
    docs: ['https://hyperpay.docs.oppwa.com/integrations/widget'],
    steps: [{"id":"pay","label":"Widget card form","screens":"assumed"}, {"id":"acs","label":"3D Secure (redirect)","screens":"assumed"}, {"id":"return","label":"Redirect to shopperResultUrl?resourcePath=…","screens":"verified"}],
  }),
  m('moyasar', 'invoice', 'redirect', 'Invoice / hosted page', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'moyasar-invoice',
    notes: 'Invoice description and amount, method selector (card, mada, Apple Pay, STC Pay), card form with "Pay <amount>", a back link to back_url; 3D Secure is a full-page redirect to the simulated bank; success goes to success_url (or callback_url ?id=&status=&message= for API payments) as before. Expired invoices cannot be paid.',
    docs: ['https://docs.moyasar.com/guides/invoices/creating-invoices', 'https://docs.moyasar.com/guides/card-payments/basic-integration'],
    steps: [{"id":"pay","label":"Invoice summary + method selector + form","screens":"assumed"}, {"id":"acs","label":"3D Secure bank page (opened directly for API card payments: source.transaction_url)","screens":"partial"}, {"id":"otp","label":"STC Pay mobile + OTP","screens":"partial"}, {"id":"return","label":"Redirect to success_url / callback_url","screens":"verified"}],
  }),
  m('moyasar', 'form', 'embedded', 'Moyasar Form (JS)', 'realistic', 'verified', 'assumed', 'P2', {
    notes: 'Moyasar.init renders a stubyard iframe (method tiles, cardholder name, card, STC Pay, simulated Apple Pay sheet) and runs on_initiating / on_completed / on_failure / on_redirect. Card: 3-D Secure as a full-page redirect to source.transaction_url, then callback_url?id=&status=&message=. STC Pay: OTP inside the form. Card digits never reach the page.',
    docs: ['https://docs.moyasar.com/guides/card-payments/basic-integration/', 'https://docs.moyasar.com/guides/apple-pay/using-moyasar-form/'],
    steps: [{ id: 'form', label: 'Form: method, name, card', screens: 'assumed' }, { id: 'acs', label: '3-D Secure: full-page redirect', screens: 'partial' }, { id: 'callback', label: 'callback_url?id&status&message', screens: 'verified' }],
  }),
  m('tap', 'hosted', 'redirect', 'Hosted checkout (src_all) with KNET / BENEFIT', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'tap-hosted',
    notes: 'Amount and merchant, the method list of the source (src_all: card, mada, KNET, BENEFIT, Apple Pay), card form, Pay with the amount; 3D Secure is a redirect; KNET and BENEFIT go to simulated bank pages (KNET: card, expiry, PIN). src_kw.knet / src_bh.benefit open the bank page directly. Token charges (tok_…) open the 3D Secure page directly. The browser returns to redirect.url?tap_id= as before.',
    docs: ['https://developers.tap.company/docs/redirect', 'https://developers.tap.company/docs/knet'],
    steps: [{"id":"pay","label":"Method list + card form","screens":"assumed"}, {"id":"acs","label":"3D Secure (redirect)","screens":"assumed"}, {"id":"bank","label":"KNET / BENEFIT bank page","screens":"partial"}, {"id":"return","label":"Redirect with tap_id","screens":"verified"}],
  }),
  m('tap', 'card-sdk', 'fields', 'Card SDK v2', 'realistic', 'verified', 'partial', 'P4', {
    notes: 'window.CardSDK.renderTapCard(id, config) mounts a stubyard card frame with onReady / onFocus / onBinIdentification / onValidInput / onInvalidInput / onError / onSuccess / onChangeSaveCardLater; tokenize() → tok_; POST /v2/charges with source.id tok_ → transaction.url (3-D Secure). Saved cards (loadSavedCard) are not simulated.',
    docs: ['https://developers.tap.company/docs/card-sdk-web-v2'],
    steps: [{ id: 'mount', label: 'renderTapCard: card frame', screens: 'partial' }, { id: 'token', label: 'tokenize() → onSuccess(tok_)', screens: 'verified' }, { id: 'acs', label: 'Charge → 3-D Secure redirect', screens: 'assumed' }, { id: 'return', label: 'redirect.url?tap_id', screens: 'verified' }],
  }),
  m('tap', 'gosell', 'popup', 'goSell lightbox (legacy)', 'planned', 'verified', 'assumed', 'P4', { notes: 'Only if an app needs it (plans-final D10).' }),
  m('myfatoorah', 'hosted', 'redirect', 'Hosted invoice page (KNET / BENEFIT / mada / STC Pay)', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'myfatoorah-hosted',
    notes: 'SendPayment / invoice links open a method selection page (the country methods: KNET, BENEFIT, VISA/MASTER, mada, Apple Pay, STC Pay); ExecutePayment with a PaymentMethodId opens that method directly (KNET / BENEFIT: the bank page). KNET and BENEFIT follow the documented test cards (KNET 8888880000000001 09/30 captured, other expiry not captured; BENEFIT cards per the test-cards page). STC Pay: mobile + OTP (1234 works). Returns to CallBackUrl / ErrorUrl ?paymentId=&Id= as before. The hosted page screens are not documented.',
    docs: ['https://docs.myfatoorah.com/docs/test-cards', 'https://docs.myfatoorah.com/docs/execute-payment'],
    steps: [{"id":"select","label":"Method selection","screens":"assumed"}, {"id":"pay","label":"Method form (card / mada / STC Pay / Apple Pay)","screens":"assumed"}, {"id":"bank","label":"KNET / BENEFIT bank page","screens":"partial"}, {"id":"return","label":"Redirect with paymentId","screens":"verified"}],
  }),
  m('myfatoorah', 'session', 'embedded', 'Embedded payment (session.js)', 'realistic', 'verified', 'partial', 'P4', {
    notes: 'InitiateSession → myfatoorah.init({ sessionId, countryCode, currencyCode, amount, containerId, paymentOptions, callback }) mounts a stubyard frame (card, Apple Pay, Google Pay, STC Pay); ExecutePayment with SessionId → PaymentURL; a framed 3-D Secure ends with postMessage(JSON.stringify({ sender: "MF-3DSecure", url })) to your origin. shouldHandlePaymentUrl, API v3 and saved cards are not simulated.',
    docs: ['https://docs.myfatoorah.com/docs/embedded-payment'],
    steps: [{ id: 'form', label: 'session.js frame: method + card', screens: 'partial' }, { id: 'execute', label: 'ExecutePayment with SessionId (server)', screens: 'verified' }, { id: 'acs', label: '3-D Secure (iframe or redirect)', screens: 'assumed' }, { id: 'return', label: 'CallBackUrl?paymentId', screens: 'verified' }],
  }),
  m('geidea', 'redirect', 'redirect', 'Hosted payment page (redirect)', 'realistic', 'verified', 'assumed', 'P1', {
    layout: 'geidea-hpp',
    notes: 'Merchant name and amount, method tabs (card, mada, Apple Pay), card form, Pay and Cancel; 3D Secure in a frame on the same page; then the redirect to returnUrl with responseCode / orderId / signature as before. Session lifetime (15 min) unchanged. Screens are not documented.',
    docs: ['https://docs.geidea.net/docs/geidea-checkout-v2'],
    steps: [{"id":"pay","label":"Card form + Pay / Cancel","screens":"assumed"}, {"id":"3ds","label":"3D Secure in a frame on the page","screens":"assumed"}, {"id":"return","label":"Redirect to returnUrl","screens":"partial"}],
  }),
  m('geidea', 'popup', 'popup', 'Checkout JS popup / drop-in', 'realistic', 'verified', 'assumed', 'P2', {
    layout: 'geidea-hpp',
    notes: 'new GeideaCheckout(onSuccess, onError, onCancel).startPayment(sessionId[, options, container]): the hosted page in an overlay iframe (popup) or inside the container (drop-in); exactly one callback with responseCode ("000" = success). An unknown, expired or used session calls onError at once (lint pay.geidea-sdk-session).',
    docs: ['https://docs.geidea.net/docs/checkout-v2'],
    steps: [{ id: 'open', label: 'Popup / drop-in frame', screens: 'assumed' }, { id: 'pay', label: 'Card form, 3D Secure in a frame', screens: 'assumed' }, { id: 'callback', label: 'onSuccess / onError / onCancel', screens: 'verified' }],
  }),
  m('tabby', 'hpp', 'steps', 'Hosted page: phone + email → OTP → plan → card → result', 'realistic', 'verified', 'partial', 'P3', {
    layout: 'tabby-hpp',
    notes: 'OTP 8888 (or the 4-digit SMS code). Pre-scoring reject phones (+971500000002 / +966500000002) and otp.rejected@tabby.ai end on "We can\'t approve this purchase" → failure URL (REJECTED); "Back to store" asks for a confirmation → cancel URL (EXPIRED). Statuses, expiry (60 min) and webhooks are unchanged.',
    docs: ['https://docs.tabby.ai/testing-guidelines/testing-credentials', 'https://docs.tabby.ai/pay-in-4-custom-integration/payment-processing'],
    steps: [{ id: 'phone', label: 'Phone + email', screens: 'partial' }, { id: 'otp', label: 'OTP (8888 in the sandbox)', screens: 'partial' }, { id: 'plan', label: '4-payment plan', screens: 'assumed' }, { id: 'card', label: 'Bank card for the first payment', screens: 'assumed' }, { id: 'reject', label: '"We can\'t approve this purchase" + Back to store', screens: 'verified' }, { id: 'cancel', label: 'Back to store with a confirmation', screens: 'partial' }],
  }),
  m('tabby', 'promo', 'promo', 'TabbyPromo / TabbyCard widgets', 'realistic', 'verified', 'partial', 'P3', {
    layout: null,
    notes: 'tabby-promo.js / tabby-card.js from the instance: new TabbyPromo({selector, currency, price, lang, source, publicKey, merchantCode}) and new TabbyCard({...}) render "4 payments of …" with Learn more (an info popup) and the TEST label; the CSS variables --snippetTextColor / --snippetLinkTextColor apply. No callbacks (as documented).',
    docs: ['https://docs.tabby.ai/pay-in-4-custom-integration/promo-messages'],
  }),
  m('tamara', 'hpp', 'steps', 'Hosted checkout: phone → OTP → terms → plan → card → confirm', 'realistic', 'verified', 'partial', 'P3', {
    layout: 'tamara-hpp',
    notes: 'The OTP is filled in for you (sandbox). Plan: split in 2 / 3 / 4 or pay in full (default: the checkout\'s instalments; kept with the flow only). Decline phones 536422337 / 526422337 decline after the OTP. Return ?orderId=&paymentStatus= unchanged.',
    docs: ['https://docs.tamara.co/docs/testing-scenarios'],
    steps: [{ id: 'phone', label: 'Phone → Send OTP', screens: 'partial' }, { id: 'otp', label: 'OTP (filled in, sandbox)', screens: 'partial' }, { id: 'terms', label: 'Terms and conditions', screens: 'partial' }, { id: 'plan', label: 'Plan 2 / 3 / 4 or in full', screens: 'partial' }, { id: 'card', label: 'Card → Pay and Confirm Order', screens: 'partial' }, { id: 'return', label: 'Redirect ?orderId=&paymentStatus=', screens: 'verified' }],
  }),
  m('tamara', 'widget', 'promo', 'tamara-widget', 'realistic', 'verified', 'partial', 'P3', {
    layout: null,
    notes: 'widget-v2/tamara-widget.js with window.tamaraWidgetConfig and <tamara-widget type="tamara-summary" amount inline-type config>; the iframe variant widget-v2/tamara-widget.html. "More options" opens the info popup (How it works, Why Tamara). Amounts are whole currency units.',
    docs: ['https://docs.tamara.co/docs/tamara-widget'],
  }),
  m('jazzcash', 'page-redirection', 'redirect', 'Page redirection: Mobile Account (MPIN + OTP), card, voucher', 'realistic', 'verified', 'assumed', 'P3', {
    layout: 'jazzcash-hosted',
    notes: 'English only. Mobile Account: number + CNIC (last 6) → MPIN (any, never posted) → SMS OTP. Card: 3-D Secure on the ACS page. Voucher: the voucher number and expiry, then the signed POST (124 pending). pp_SecureHash post-back unchanged.',
    steps: [{ id: 'pay', label: 'Method choice + mobile number / card', screens: 'assumed' }, { id: 'mpin', label: 'MPIN', screens: 'assumed' }, { id: 'otp', label: 'SMS OTP', screens: 'assumed' }, { id: 'voucher', label: 'Voucher number', screens: 'assumed' }, { id: 'return', label: 'Signed POST to pp_ReturnURL', screens: 'verified' }],
  }),
  m('easypaisa', 'index-jsf', 'redirect', 'Hosted checkout: Mobile Account (OTP), OTC voucher, card', 'realistic', 'verified', 'assumed', 'P3', {
    layout: 'easypaisa-hosted',
    notes: 'English only. Mobile Account: number → SMS OTP → confirm. OTC: payment token + expiry (72 h), then the redirect with paymentToken. Card: 3-D Secure on the ACS page. postBackURL redirect unchanged.',
    steps: [{ id: 'pay', label: 'Method list + account number / card', screens: 'assumed' }, { id: 'otp', label: 'SMS OTP', screens: 'assumed' }, { id: 'voucher', label: 'OTC payment token', screens: 'assumed' }, { id: 'return', label: 'Redirect to postBackURL', screens: 'partial' }],
  }),
];

export function experiencesOf(preset: string): ExperienceMode[] {
  return EXPERIENCES.filter((e) => e.preset === preset);
}

/** The mode a hosted page (GET /page/<id>) belongs to: the preset's first realistic or generic redirect-style mode. */
export function hostedModeOf(preset: string): ExperienceMode | null {
  const list = experiencesOf(preset);
  return list.find((e) => e.status === 'realistic' && e.kind !== 'popup') ?? list.find((e) => e.status === 'generic') ?? null;
}

/** Kit layout of the hosted page in realistic view: a provider layout where one exists, else the generic kit page. */
export function layoutFor(preset: string): LayoutId | 'generic' {
  return hostedModeOf(preset)?.layout ?? 'generic';
}

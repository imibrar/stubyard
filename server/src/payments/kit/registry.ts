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

export interface ExperienceMode {
  preset: PaymentPresetId;
  /** Stable id within the preset ("hosted", "buttons-popup"). */
  mode: string;
  kind: ModeKind;
  label: string;
  status: ModeStatus;
  /** Kit layout used on the hosted page for this mode (realistic / generic only). */
  layout: 'stripe-hosted' | 'generic' | null;
  api: Fidelity;
  screens: Fidelity;
  /** Delivery phase of the realistic layout (P0 = this build). */
  phase: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
  notes?: string;
  docs?: string[];
}

const m = (preset: PaymentPresetId, mode: string, kind: ModeKind, label: string, status: ModeStatus, api: Fidelity, screens: Fidelity, phase: ExperienceMode['phase'], extra: Partial<ExperienceMode> = {}): ExperienceMode => ({
  preset,
  mode,
  kind,
  label,
  status,
  layout: status === 'realistic' ? (preset === 'stripe-checkout' ? 'stripe-hosted' : 'generic') : status === 'generic' ? 'generic' : null,
  api,
  screens,
  phase,
  ...extra,
});

export const EXPERIENCES: readonly ExperienceMode[] = [
  m('stripe-checkout', 'hosted', 'redirect', 'Checkout (hosted page, redirect)', 'realistic', 'verified', 'partial', 'P0', {
    notes: 'Two-column summary + payment form, card validation, decline on the same page, 3D Secure in a modal frame, success_url / cancel_url redirects.',
    docs: ['https://docs.stripe.com/payments/checkout/how-checkout-works', 'https://docs.stripe.com/payments/3d-secure/authentication-flow'],
  }),
  m('stripe-checkout', '3ds-modal', 'popup', '3D Secure modal', 'realistic', 'verified', 'partial', 'P0'),
  m('stripe-checkout', 'embedded', 'embedded', 'Embedded Checkout (ui_mode embedded_page)', 'planned', 'verified', 'partial', 'P2'),
  m('stripe-checkout', 'payment-element', 'fields', 'Payment Element (PaymentIntents)', 'planned', 'verified', 'partial', 'P4'),
  m('paypal', 'redirect', 'redirect', 'Approval page (redirect)', 'generic', 'verified', 'partial', 'P1'),
  m('paypal', 'buttons-popup', 'popup', 'JS SDK Buttons (popup / overlay)', 'sdk', 'verified', 'partial', 'P2'),
  m('paypal', 'card-fields', 'fields', 'Card Fields', 'sdk', 'verified', 'partial', 'P2'),
  m('paypal', 'pay-later-messages', 'promo', 'Pay Later messages', 'planned', 'verified', 'partial', 'P3'),
  m('checkout', 'hpp', 'redirect', 'Hosted Payments Page / Payment Links', 'generic', 'verified', 'partial', 'P1'),
  m('checkout', 'flow', 'fields', 'Flow (web components)', 'planned', 'verified', 'partial', 'P4'),
  m('aps', 'redirection', 'redirect', 'Redirection (hosted page)', 'generic', 'verified', 'partial', 'P1'),
  m('aps', 'merchant-page', 'embedded', 'Merchant Page (iframe)', 'planned', 'verified', 'assumed', 'P4', { notes: 'Merchant Page 2.0 is skipped (no source, plans-final D10).' }),
  m('paytabs', 'hpp', 'redirect', 'Hosted payment page', 'generic', 'verified', 'partial', 'P1'),
  m('paytabs', 'framed', 'embedded', 'Framed hosted page (framed=true)', 'planned', 'verified', 'assumed', 'P1'),
  m('paytabs', 'paylib', 'fields', 'Managed form (paylib.js)', 'planned', 'verified', 'assumed', 'P4'),
  m('hyperpay', 'widget', 'embedded', 'COPYandPAY widget (paymentWidgets.js)', 'generic', 'verified', 'partial', 'P2'),
  m('moyasar', 'invoice', 'redirect', 'Invoice / hosted page', 'generic', 'verified', 'partial', 'P1'),
  m('moyasar', 'form', 'embedded', 'Moyasar Form (JS)', 'planned', 'verified', 'partial', 'P2'),
  m('tap', 'hosted', 'redirect', 'Hosted checkout (src_all) with KNET / BENEFIT', 'generic', 'verified', 'partial', 'P1'),
  m('tap', 'card-sdk', 'fields', 'Card SDK v2', 'planned', 'verified', 'partial', 'P4'),
  m('tap', 'gosell', 'popup', 'goSell lightbox (legacy)', 'planned', 'verified', 'assumed', 'P4', { notes: 'Only if an app needs it (plans-final D10).' }),
  m('myfatoorah', 'hosted', 'redirect', 'Hosted invoice page (KNET / BENEFIT / STC Pay)', 'generic', 'verified', 'assumed', 'P1'),
  m('myfatoorah', 'session', 'embedded', 'Embedded payment (session.js)', 'planned', 'verified', 'partial', 'P4'),
  m('geidea', 'redirect', 'redirect', 'Hosted payment page (redirect)', 'generic', 'verified', 'partial', 'P1'),
  m('geidea', 'popup', 'popup', 'Checkout popup / drop-in', 'planned', 'verified', 'partial', 'P2'),
  m('tabby', 'hpp', 'steps', 'Hosted page: phone → OTP → plan → card → result', 'generic', 'verified', 'assumed', 'P3', { notes: 'OTP 8888 is accepted in the sandbox; the screen order is assumed.' }),
  m('tabby', 'promo', 'promo', 'TabbyPromo / TabbyCard widgets', 'planned', 'verified', 'partial', 'P3'),
  m('tamara', 'hpp', 'steps', 'Hosted checkout: phone → OTP → plan → confirm', 'generic', 'verified', 'assumed', 'P3'),
  m('tamara', 'widget', 'promo', 'tamara-widget', 'planned', 'verified', 'partial', 'P3'),
  m('jazzcash', 'page-redirection', 'redirect', 'Page redirection (MWALLET MPIN + OTP, voucher)', 'generic', 'verified', 'assumed', 'P3'),
  m('easypaisa', 'index-jsf', 'redirect', 'Hosted checkout (Index.jsf: MA OTP, OTC voucher)', 'generic', 'verified', 'assumed', 'P3'),
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
export function layoutFor(preset: string): 'stripe-hosted' | 'generic' {
  return hostedModeOf(preset)?.layout ?? 'generic';
}

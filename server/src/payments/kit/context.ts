import type { PayPageInput } from '../pages.js';
import type { Payment, PaymentMethod } from '../repo.js';
import type { ExperienceMode } from './registry.js';
import type { CheckoutView } from './view.js';

/** Relative URLs a kit page posts to / links to. Relative, so the host-form URLs (rewritePayHost) keep working. */
export interface KitRel {
  /** POST: the pay / OTP step (…/page/<id>/x/pay). */
  pay: string;
  /** POST: real-card warning (…/page/<id>/warning, the classic endpoint). */
  warning: string;
  /** POST: hidden-notice report (…/page/<id>/x/notice). */
  notice: string;
  /** GET: the simulated bank (ACS) frame of the 3DS modal (…/page/<id>/x/acs). */
  acs: string;
  /** POST: the 3DS answer (…/page/<id>/x/3ds). */
  threeds: string;
  /** GET: this payment page (…/page/<id>), for view / language links. */
  self: string;
  /** Prefix of the other step URLs (x + "bank", x + "login", …). */
  x: string;
}

/** Links from GET …/page/<id>. */
export const relFromPage = (id: string): KitRel => ({ pay: `${id}/x/pay`, warning: `${id}/warning`, notice: `${id}/x/notice`, acs: `${id}/x/acs`, threeds: `${id}/x/3ds`, self: id, x: `${id}/x/` });
/** Links from …/page/<id>/x/<step>. */
export const relFromStep = (id: string): KitRel => ({ pay: 'pay', warning: '../warning', notice: 'notice', acs: 'acs', threeds: '3ds', self: `../../${id}`, x: '' });

export interface KitPayCtx {
  input: PayPageInput;
  payment: Payment;
  view: CheckoutView;
  /** The shop's name (the stubyard project name). */
  merchant: string;
  /** Host of stubyard's browser URL, shown in the banner. */
  host: string | null;
  rel: KitRel;
  mode: ExperienceMode | null;
  /** Show the 3-D Secure modal over the page (the challenge step of card-3ds). */
  challenge?: boolean;
  /** The method chosen on a method-selection screen (MyFatoorah): the page shows only that method's form. */
  selected?: PaymentMethod | null;
  /** A validation message of a custom step (PayPal login). */
  stepError?: string | null;
}

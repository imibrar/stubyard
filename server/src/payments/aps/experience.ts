import { hostedLayout } from '../kit/hpp.js';

/**
 * Amazon Payment Services redirection (merchant page POSTs the signed form to /FortAPI/paymentPage): the hosted
 * payment page with the amount, card number / expiry / CVC / holder name and Pay, KNET to the bank page, 3-D Secure as
 * a full-page redirect, then an auto-submitted POST of the response fields to return_url (as today).
 * Screens: assumed (no public screenshots of the current page were checked).
 */
export const apsLayout = hostedLayout(
  {
    layout: 'aps-hosted',
    provider: 'Amazon Payment Services',
    methodStyle: 'list',
    cardholder: 'before',
    methodLabels: { applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' }, knet: { en: 'KNET', ar: 'كي نت' } },
    cancel: { en: 'Cancel', ar: 'إلغاء' },
    summary: (c) => [[{ en: 'Order', ar: 'الطلب' }, c.input.reference]],
  },
  { threeds: 'redirect', bankMethods: ['knet'] },
);

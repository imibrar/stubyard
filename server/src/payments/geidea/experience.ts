import { hostedLayout } from '../kit/hpp.js';

/**
 * Geidea hosted payment page (redirect to the session's page): amount, card form, Pay; 3-D Secure in a frame over
 * the page; then the redirect to the callback / return URL with responseCode etc. (as today).
 */
export const geideaLayout = hostedLayout(
  {
    layout: 'geidea-hpp',
    provider: 'Geidea',
    methodStyle: 'tabs',
    cardholder: 'before',
    methodLabels: { applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' } },
    cancel: { en: 'Cancel', ar: 'إلغاء' },
    summary: (c) => [[{ en: 'Order', ar: 'الطلب' }, c.input.reference]],
  },
  { threeds: 'modal' },
);

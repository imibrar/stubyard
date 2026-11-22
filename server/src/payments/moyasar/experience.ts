import { hostedLayout } from '../kit/hpp.js';

/**
 * Moyasar hosted invoice (invoice.url): the invoice description and amount, the method choice (mada, card, Apple Pay,
 * STC Pay), the card form or the STC Pay phone (then the OTP screen), Pay, and a back link to back_url. 3-D Secure is a
 * full-page redirect. A payment created with source creditcard opens the ACS page (transaction_url) directly.
 */
export const moyasarLayout = hostedLayout(
  {
    layout: 'moyasar-invoice',
    provider: 'Moyasar',
    methodStyle: 'tabs',
    cardholder: 'before',
    methodLabels: { applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' }, stcpay: { en: 'STC Pay', ar: 'STC Pay' } },
    back: { en: 'Back', ar: 'رجوع' },
    heading: (c) => c.input.description ?? (typeof c.payment.request?.description === 'string' ? c.payment.request.description : null) ?? c.merchant,
    summary: (c) => [
      [{ en: 'Merchant', ar: 'التاجر' }, c.merchant],
      [{ en: 'Invoice', ar: 'الفاتورة' }, c.input.providerRef],
    ],
  },
  { threeds: 'redirect' },
);

import { hostedLayout } from '../kit/hpp.js';

/**
 * Checkout.com Hosted Payments Page (research R1 §2, Checkout.com docs "Hosted Payments Page"): one page with the
 * order amount, the method choice (card; mada for SAR; Apple Pay), card number / expiry / CVC and the cardholder
 * name, a Pay button and a back link to cancel_url. 3-D Secure is a full-page redirect to the issuer's ACS page, then
 * back to success_url / failure_url with cko-session-id. A /3ds/<ref> payment (card already sent to POST /payments,
 * the app redirected to _links.redirect) opens the ACS page directly. The HPP refuses to be framed (lint only here).
 */
export const checkoutLayout = hostedLayout(
  {
    layout: 'checkout-hpp',
    provider: 'Checkout.com',
    methodStyle: 'tabs',
    cardholder: 'after',
    methodLabels: { applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' } },
    back: { en: 'Back to store', ar: 'العودة إلى المتجر' },
    summary: (c) => [
      [{ en: 'Reference', ar: 'المرجع' }, c.input.reference],
      [{ en: 'Description', ar: 'الوصف' }, c.input.description],
    ],
    footer: [{ en: 'Secure payment page', ar: 'صفحة دفع آمنة' }],
  },
  {
    threeds: 'redirect',
    acsHint: { en: 'Checkout.com sandbox ACS pages ask for the password "Checkout1!" (unverified here: any code works).', ar: 'تطلب صفحات ACS التجريبية لدى Checkout.com كلمة المرور "Checkout1!" (لم يتم التحقق هنا: أي رمز يعمل).' },
  },
);

import { hostedLayout } from '../kit/hpp.js';
import { payBridge, resultPost, sdkReturnPage } from './sdk.js';

/**
 * Geidea hosted payment page (redirect to the session's page): amount, card form, Pay; 3-D Secure in a frame over
 * the page; then the redirect to the callback / return URL with responseCode etc. (as today).
 * Opened by GeideaCheckout as a popup or drop-in (providerData.sdkBridge, geidea/sdk.ts): no redirect at the end; the
 * result screen posts the result to the merchant page instead (exactly one of onSuccess / onError / onCancel).
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
    scripts: payBridge,
  },
  {
    threeds: 'modal',
    returnPage: (r) => sdkReturnPage(r.svc, r),
    resultScripts: (p, svc) => {
      const s = resultPost(svc, p);
      return s ? [s] : [];
    },
  },
);

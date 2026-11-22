import { hostedLayout } from '../kit/hpp.js';

/**
 * HyperPay COPYandPAY: the widget is drawn inside the merchant's page (form.paymentWidgets → the /widget/<id>
 * iframe), so the "hosted page" is the compact widget form: the data-brands as text, card number / expiry / CVC /
 * holder, Pay; 3-D Secure as a full-page redirect of the top window; then the shopper result URL
 * ?id=&resourcePath= (as today). Opened directly (no widget) it is the same form on a full page.
 */
export const hyperpayLayout = hostedLayout(
  {
    layout: 'hyperpay-widget',
    provider: 'HyperPay',
    methodStyle: 'tabs',
    cardholder: 'after',
    methodLabels: { applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' }, stcpay: { en: 'STC Pay', ar: 'STC Pay' } },
    compact: (c) => !!c.input.embed,
    brandRow: (c) => {
      const w = c.payment.providerData.widget as { brands?: string[] } | undefined;
      return w?.brands?.length ? w.brands : null;
    },
  },
  { threeds: 'redirect', embedOk: true },
);

import { hostedLayout } from '../kit/hpp.js';

/**
 * Tap hosted checkout (charge with source src_all / src_card / a single method; the app redirects to
 * transaction.url): the method list, the card form, KNET / BENEFIT to the (simulated) bank page, 3-D Secure as a
 * full-page redirect, then back to redirect.url?tap_id=. A tok_ charge (card tokenised by the app) opens the ACS page
 * directly. Research R2.
 */
export const tapLayout = hostedLayout(
  {
    layout: 'tap-hosted',
    provider: 'Tap',
    methodStyle: 'list',
    cardholder: 'after',
    saveCard: () => true,
    methodLabels: { knet: { en: 'KNET', ar: 'كي نت' }, benefit: { en: 'BENEFIT', ar: 'بنفت' }, applepay: { en: 'Apple Pay (simulated)', ar: 'Apple Pay (محاكاة)' } },
    cancel: { en: 'Cancel', ar: 'إلغاء' },
    summary: (c) => [[{ en: 'Description', ar: 'الوصف' }, c.input.description]],
  },
  { threeds: 'redirect', bankMethods: ['knet', 'benefit'] },
);

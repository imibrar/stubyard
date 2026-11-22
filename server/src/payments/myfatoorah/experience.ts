import { hostedLayout } from '../kit/hpp.js';
import type { BankRule } from '../kit/layout.js';
import { mfSessionReturnPage } from '../sdk/myfatoorah-return.js';

/**
 * MyFatoorah hosted page (SendPayment / InitiatePayment → InvoiceURL, or ExecutePayment → PaymentURL): first the
 * method selection (the country's methods: KNET, VISA/MASTER, mada, Benefit, Apple Pay, STC Pay), then that method's
 * screen ("Change payment method" goes back): card form, STC Pay phone + OTP, or the simulated KNET / Benefit bank
 * page; then back to CallBackUrl / ErrorUrl with ?paymentId=&Id= (as today). A single method (ExecutePayment with a
 * PaymentMethodId) skips the selection. The bank pages accept MyFatoorah's documented test cards.
 */
const KNET: BankRule[] = [{ number: '8888880000000001', expiry: '09/30', outcome: 'success', otherExpiry: 'decline', label: 'Approved with 09/30, declined with another expiry' }];
const BENEFIT: BankRule[] = [
  { number: '4600410123456789', outcome: 'success', label: 'Approved' },
  { number: '4550120123456789', outcome: 'decline:expired_card', label: 'Expired card' },
  { number: '4845550123456789', outcome: 'decline', label: 'Declined' },
  { number: '4575550123456789', outcome: 'decline', label: 'Declined' },
  { number: '4895550123456789', outcome: 'decline', label: 'Declined' },
];

export const myfatoorahLayout = hostedLayout(
  {
    layout: 'myfatoorah-hosted',
    provider: 'MyFatoorah',
    methodStyle: 'list',
    cardholder: 'before',
    // MF_METHODS' names (index.ts), copied: importing index.ts here would make a module cycle through the kit.
    methodLabels: {
      knet: { en: 'KNET', ar: 'كي نت' },
      card: { en: 'VISA/MASTER', ar: 'فيزا / ماستر' },
      mada: { en: 'MADA', ar: 'مدى' },
      benefit: { en: 'Benefit', ar: 'بنفت' },
      applepay: { en: 'Apple Pay', ar: 'أبل الدفع' },
      stcpay: { en: 'STC Pay', ar: 'STC Pay' },
    },
    summary: (c) => [
      [{ en: 'Invoice', ar: 'الفاتورة' }, c.input.providerRef],
      [{ en: 'Reference', ar: 'المرجع' }, c.input.reference],
    ],
    cancel: { en: 'Cancel', ar: 'إلغاء' },
  },
  // Embedded-session payments (session.js): a framed PaymentURL ends with the MF-3DSecure message to the shop.
  { threeds: 'redirect', select: true, bankMethods: ['knet', 'benefit'], bankRules: (m) => (m === 'benefit' ? BENEFIT : KNET), returnPage: mfSessionReturnPage },
);

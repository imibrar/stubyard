/**
 * Checkout kit strings (English + Arabic). Only kit strings live here; provider-specific labels come from the
 * provider's experience file. The Arabic was written by an agent and is not yet reviewed by a native speaker
 * (the test drawer says so).
 */

export type Locale = 'en' | 'ar';
export const LOCALES: readonly Locale[] = ['en', 'ar'];

/** The mandatory test notice. Its wording is fixed (plans-final D13); it is never removable. */
export const TEST_NOTICE: Record<Locale, string> = {
  en: 'TEST · stubyard simulator · not a real payment, no money moves',
  ar: 'تجربة · محاكي stubyard · ليست عملية دفع حقيقية، ولا تُنقل أي أموال',
};

const EN = {
  testControls: 'Test controls',
  testShortcuts: 'Test shortcuts',
  servedBy: 'Served by {host}',
  decline: 'Decline',
  cancel: 'Cancel',
  cancelReturn: 'Cancel and return',
  continue: 'Continue',
  close: 'Close',
  forced: 'Outcome set by {via}: {outcome}',
  forcedHint: 'Any button continues with that outcome.',
  payDoes: 'When you press Pay',
  outSuccess: 'Success (a test card can still decide)',
  outDecline: 'Decline',
  testUser: 'Test user',
  none: '(none)',
  thisRun: 'This run',
  projectUsers: 'Project users',
  testCards: 'Test cards (fill the card field)',
  otherOutcomes: 'Other outcomes (submit now)',
  language: 'Language',
  view: 'View',
  classicView: 'Classic view',
  realisticView: 'Realistic view',
  openStubyard: 'Open in stubyard',
  fidelity: 'How close is this page to the real one?',
  fidelityApi: 'API',
  fidelityScreens: 'Screens',
  verified: 'verified',
  partial: 'partly verified',
  assumed: 'assumed',
  arNote: 'The Arabic text is not yet reviewed by a native speaker.',
  timings: 'Timings',
  timingsFast: 'fast (automation detected or set on the instance)',
  timingsReal: 'realistic short delays',
  email: 'Email',
  paymentMethod: 'Payment method',
  cardInfo: 'Card information',
  cardNumber: 'Card number',
  expiry: 'MM / YY',
  expiryLabel: 'Expiration date',
  cvc: 'CVC',
  cardholder: 'Cardholder name',
  fullName: 'Full name on card',
  country: 'Country or region',
  zip: 'ZIP',
  errNumIncomplete: 'Your card number is incomplete.',
  errNumInvalid: 'Your card number is invalid.',
  errExpIncomplete: "Your card's expiration date is incomplete.",
  errExpPast: "Your card's expiration year is in the past.",
  errCvcIncomplete: "Your card's security code is incomplete.",
  errRealCard: 'That looks like a real card number. It was cleared and not sent. Use a test card such as 4242 4242 4242 4242.',
  errPhone: 'Enter a mobile number (or pick a test user with a phone) to get the one-time code.',
  pay: 'Pay',
  payAmount: 'Pay {amount}',
  book: 'Book',
  donate: 'Donate',
  approveAmount: 'Approve {amount}',
  processing: 'Processing…',
  back: 'Back to {merchant}',
  payMerchant: 'Pay {merchant}',
  subtotal: 'Subtotal',
  totalDue: 'Total due',
  qty: 'Qty {n}',
  each: '{amount} each',
  walletSim: '{wallet} (simulated)',
  walletHint: 'stubyard shows its own simulated wallet: no real wallet sheet opens and nothing is charged.',
  orCard: 'Or pay with card',
  simulatedBy: 'Simulated {provider} checkout · stubyard',
  noRealProvider: 'Nothing here talks to the real {provider}. Card digits never leave this page.',
  terms: 'Terms',
  privacy: 'Privacy',
  testMode: 'Test mode',
  auth3ds: '3D Secure authentication',
  contactingBank: 'Contacting your bank…',
  simulatedBank: 'Simulated bank',
  acsText: 'This is a test 3D Secure page. Complete or fail the authentication of {amount} to {merchant}.',
  acsComplete: 'Complete authentication',
  acsFail: 'Fail authentication',
  verification: 'Verification',
  otpSent: 'We sent a {n}-digit code by SMS to {phone}. Find it in the stubyard SMS inbox.',
  code: 'Code',
  verifyPay: 'Verify and pay',
  threeWrong: 'Three wrong codes decline the payment.',
  mobile: 'Mobile number',
  otpHint: "A one-time code goes to the stubyard SMS inbox (empty: the selected test user's phone).",
  voucherHint: 'Voucher: the payment stays pending until it is paid at the counter (it settles after the settle delay).',
  noDigitsHint: 'No card digits are needed in the simulator.',
  stepDone: 'This step is already done.',
  stepNotNow: 'This step is not available now.',
  resComplete: 'Payment complete',
  resThanks: 'Thanks for your payment',
  resAuthorised: 'Payment authorised',
  resApproved: 'Payment approved',
  resDeclined: 'Payment declined',
  resCancelled: 'Payment cancelled',
  resExpired: 'Session expired',
  resOpen: 'Payment open',
  msgComplete: 'This payment went through.',
  msgCapture: 'The shop captures it next.',
  msgProcessing: 'The payment is processing; it settles shortly.',
  msgCancelled: 'The buyer cancelled.',
  msgExpired: 'This payment page has expired.',
  msgOpen: 'Nothing was chosen (abandoned).',
  returnShop: 'Return to the shop',
  noReturn: 'No return URL: the request had none, or it is not an absolute http(s) URL.',
  status: 'Status: {s}',
  reference: 'Reference',
  forLabel: 'For',
  run: 'Run',
};

export type KitKey = keyof typeof EN;

const AR: Record<KitKey, string> = {
  testControls: 'أدوات الاختبار',
  testShortcuts: 'اختصارات الاختبار',
  servedBy: 'تقدمها {host}',
  decline: 'رفض',
  cancel: 'إلغاء',
  cancelReturn: 'إلغاء والعودة',
  continue: 'متابعة',
  close: 'إغلاق',
  forced: 'النتيجة محددة عبر {via}: {outcome}',
  forcedHint: 'أي زر يتابع بهذه النتيجة.',
  payDoes: 'عند الضغط على زر الدفع',
  outSuccess: 'نجاح (يمكن لبطاقة الاختبار أن تحدد النتيجة)',
  outDecline: 'رفض',
  testUser: 'مستخدم الاختبار',
  none: '(لا أحد)',
  thisRun: 'هذا التشغيل',
  projectUsers: 'مستخدمو المشروع',
  testCards: 'بطاقات الاختبار (تملأ حقل البطاقة)',
  otherOutcomes: 'نتائج أخرى (إرسال فوري)',
  language: 'اللغة',
  view: 'العرض',
  classicView: 'العرض الكلاسيكي',
  realisticView: 'العرض الواقعي',
  openStubyard: 'فتح في stubyard',
  fidelity: 'ما مدى قرب هذه الصفحة من الصفحة الحقيقية؟',
  fidelityApi: 'الواجهة البرمجية',
  fidelityScreens: 'الشاشات',
  verified: 'مُتحقق منها',
  partial: 'مُتحقق منها جزئياً',
  assumed: 'مُفترضة',
  arNote: 'النص العربي لم يُراجَع بعد من متحدث أصلي.',
  timings: 'التوقيت',
  timingsFast: 'سريع (تم اكتشاف أتمتة أو ضُبط على المثيل)',
  timingsReal: 'تأخيرات قصيرة واقعية',
  email: 'البريد الإلكتروني',
  paymentMethod: 'طريقة الدفع',
  cardInfo: 'معلومات البطاقة',
  cardNumber: 'رقم البطاقة',
  expiry: 'شهر / سنة',
  expiryLabel: 'تاريخ الانتهاء',
  cvc: 'رمز التحقق',
  cardholder: 'اسم حامل البطاقة',
  fullName: 'الاسم الكامل على البطاقة',
  country: 'الدولة أو المنطقة',
  zip: 'الرمز البريدي',
  errNumIncomplete: 'رقم بطاقتك غير مكتمل.',
  errNumInvalid: 'رقم بطاقتك غير صالح.',
  errExpIncomplete: 'تاريخ انتهاء بطاقتك غير مكتمل.',
  errExpPast: 'سنة انتهاء بطاقتك في الماضي.',
  errCvcIncomplete: 'رمز الأمان لبطاقتك غير مكتمل.',
  errRealCard: 'يبدو هذا رقم بطاقة حقيقية. تم مسحه ولم يُرسل. استخدم بطاقة اختبار مثل 4242 4242 4242 4242.',
  errPhone: 'أدخل رقم جوال (أو اختر مستخدم اختبار لديه رقم) لاستلام رمز التحقق.',
  pay: 'ادفع',
  payAmount: 'ادفع {amount}',
  book: 'احجز',
  donate: 'تبرّع',
  approveAmount: 'وافق على {amount}',
  processing: 'جارٍ المعالجة…',
  back: 'العودة إلى {merchant}',
  payMerchant: 'ادفع إلى {merchant}',
  subtotal: 'المجموع الفرعي',
  totalDue: 'المبلغ المستحق',
  qty: 'الكمية {n}',
  each: '{amount} للقطعة',
  walletSim: '{wallet} (محاكاة)',
  walletHint: 'يعرض stubyard محفظة محاكاة خاصة به: لا تُفتح محفظة حقيقية ولا يُخصم أي مبلغ.',
  orCard: 'أو ادفع بالبطاقة',
  simulatedBy: 'صفحة دفع {provider} محاكاة · stubyard',
  noRealProvider: 'لا شيء هنا يتصل بـ {provider} الحقيقي. أرقام البطاقة لا تغادر هذه الصفحة.',
  terms: 'الشروط',
  privacy: 'الخصوصية',
  testMode: 'وضع الاختبار',
  auth3ds: 'التحقق ثلاثي الأبعاد (3D Secure)',
  contactingBank: 'جارٍ الاتصال بمصرفك…',
  simulatedBank: 'مصرف محاكى',
  acsText: 'هذه صفحة اختبار للتحقق ثلاثي الأبعاد. أكمل أو أفشل التحقق من دفع {amount} إلى {merchant}.',
  acsComplete: 'إكمال التحقق',
  acsFail: 'إفشال التحقق',
  verification: 'التحقق',
  otpSent: 'أرسلنا رمزاً من {n} أرقام برسالة نصية إلى {phone}. تجده في صندوق رسائل stubyard.',
  code: 'الرمز',
  verifyPay: 'تحقق وادفع',
  threeWrong: 'ثلاثة رموز خاطئة ترفض عملية الدفع.',
  mobile: 'رقم الجوال',
  otpHint: 'يُرسل رمز لمرة واحدة إلى صندوق رسائل stubyard (إن تُرك فارغاً: رقم مستخدم الاختبار المختار).',
  voucherHint: 'القسيمة: تبقى عملية الدفع معلقة حتى تُدفع عند الكاونتر (تُسوّى بعد مهلة التسوية).',
  noDigitsHint: 'لا حاجة لأرقام بطاقة في المحاكي.',
  stepDone: 'تم إنجاز هذه الخطوة بالفعل.',
  stepNotNow: 'هذه الخطوة غير متاحة الآن.',
  resComplete: 'تم الدفع',
  resThanks: 'شكراً لك على الدفع',
  resAuthorised: 'تم تفويض الدفع',
  resApproved: 'تمت الموافقة على الدفع',
  resDeclined: 'تم رفض الدفع',
  resCancelled: 'تم إلغاء الدفع',
  resExpired: 'انتهت صلاحية الجلسة',
  resOpen: 'عملية الدفع مفتوحة',
  msgComplete: 'تمت عملية الدفع بنجاح.',
  msgCapture: 'سيقوم المتجر بتحصيل المبلغ لاحقاً.',
  msgProcessing: 'عملية الدفع قيد المعالجة وستُسوّى قريباً.',
  msgCancelled: 'ألغى المشتري العملية.',
  msgExpired: 'انتهت صلاحية صفحة الدفع هذه.',
  msgOpen: 'لم يتم اختيار أي شيء (تم التخلي عن العملية).',
  returnShop: 'العودة إلى المتجر',
  noReturn: 'لا يوجد رابط عودة: الطلب لم يتضمن رابطاً، أو أنه ليس رابط http(s) كاملاً.',
  status: 'الحالة: {s}',
  reference: 'المرجع',
  forLabel: 'مقابل',
  run: 'التشغيل',
};

const TABLES: Record<Locale, Record<KitKey, string>> = { en: EN, ar: AR };

/** A kit string with {var} placeholders filled (values are inserted as given; escape when writing HTML). */
export function t(locale: Locale, key: KitKey, vars: Record<string, string | number> = {}): string {
  const s = TABLES[locale][key] ?? EN[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** English decline messages (service DECLINE_MESSAGES) in Arabic, looked up by the English text. */
const DECLINE_AR: Record<string, string> = {
  'Your card was declined.': 'تم رفض بطاقتك.',
  'Your card has insufficient funds.': 'رصيد بطاقتك غير كافٍ.',
  'Your card has expired.': 'انتهت صلاحية بطاقتك.',
  "Your card's security code is incorrect.": 'رمز الأمان لبطاقتك غير صحيح.',
  'An error occurred while processing your card. Try again in a little bit.': 'حدث خطأ أثناء معالجة بطاقتك. حاول مرة أخرى بعد قليل.',
  'We are unable to authenticate your payment method.': 'تعذر علينا التحقق من طريقة الدفع الخاصة بك.',
  'The verification code was entered wrongly too many times.': 'تم إدخال رمز التحقق بشكل خاطئ عدة مرات.',
};

/** A server message (decline text) in the page language; unknown messages stay as they are. */
export function tMessage(locale: Locale, message: string): string {
  if (locale === 'ar') return DECLINE_AR[message] ?? message;
  return message;
}

const METHOD: Record<Locale, Record<string, string>> = {
  en: { card: 'Card', mada: 'mada', stcpay: 'STC Pay', applepay: 'Apple Pay', paypal: 'PayPal', knet: 'KNET', benefit: 'BENEFIT', bnpl: 'Pay later', wallet: 'Mobile wallet', voucher: 'Voucher / over the counter' },
  ar: { card: 'بطاقة', mada: 'مدى', stcpay: 'STC Pay', applepay: 'Apple Pay', paypal: 'PayPal', knet: 'KNET', benefit: 'BENEFIT', bnpl: 'ادفع لاحقاً', wallet: 'محفظة الجوال', voucher: 'قسيمة / الدفع عند الكاونتر' },
};

export function methodLabel(locale: Locale, m: string): string {
  return METHOD[locale][m] ?? METHOD.en[m] ?? m;
}

/**
 * The first candidate that names a supported language: "ar", "ar-SA", "ar_EG" → ar; "en", "en-GB" → en.
 * "auto", empty and unknown values are skipped; nothing usable → en.
 */
export function pickLocale(...candidates: unknown[]): Locale {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const s = c.trim().toLowerCase();
    if (!s || s === 'auto') continue;
    if (s === 'ar' || s.startsWith('ar-') || s.startsWith('ar_') || s === 'arabic') return 'ar';
    if (s === 'en' || s.startsWith('en-') || s.startsWith('en_') || s === 'english') return 'en';
  }
  return 'en';
}

export const dirOf = (l: Locale): 'rtl' | 'ltr' => (l === 'ar' ? 'rtl' : 'ltr');

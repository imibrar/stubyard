import { describe, expect, it } from 'vitest';
import { extractLinks, extractOtp, htmlToText } from '../src/messages/extract.js';

describe('extractOtp', () => {
  it.each([
    ['Your OTP is 123456', '123456'],
    ['Use code 4821 to sign in', '4821'],
    ['849302 is your verification code', '849302'],
    ['Verification code: 77 12 99', null],
    ['Your one-time password: 99887766', '99887766'],
    ['Order #12345678 shipped on 2026-11-19', null],
    ['Here it is: 654321.', '654321'],
    ['Call +923001234567 for help', null],
  ])('%s → %s', (text, expected) => {
    expect(extractOtp(text)).toBe(expected);
  });

  it.each([
    // Providers and big senders
    ['Your Twilio Verify verification code is: 482913', '482913'],
    ['Your Acme verification code is: 123456\n\n@acme.example #123456', '123456'],
    ['G-735201 is your Google verification code.', '735201'],
    ['Your Uber code: 4821. Never share this code. Reply STOP ALL to 81752 to unsubscribe.', '4821'],
    ['Use 7731 as your Microsoft account security code', '7731'],
    ['*482190* is your verification code. For your security, do not share this code.', '482190'],
    ['WhatsApp code 551-207. You can also tap on this link to verify your phone: v.whatsapp.com/551207', '551207'],
    ['Your Amazon OTP is 902114. Do not share it with anyone.', '902114'],
    ['Your Instagram code is 384 112. Don\'t share it.', '384112'],
    // Banks: amounts, cards and dates around the code
    ['Dear Customer, 482910 is your OTP for transaction of PKR 5,000.00 at AMAZON on card ending 1234. Valid for 5 mins. Do not share.', '482910'],
    ['OTP for your payment of Rs. 25000 is 667788. Valid till 19/11/2026 10:45.', '667788'],
    ['Your HBL card ending 4455 was charged USD 1500 on 2026-11-19. Your one-time PIN is 3390.', '3390'],
    ['Transaction ID 99887766 approved. Your verification code is 120934.', '120934'],
    // Years, validity and other numbers next to a code
    ['Your code is 1234. Valid until 2026', '1234'],
    ['Your code is 5521. © 2026 Acme Inc.', '5521'],
    ['© 2026 Acme Inc. Your login code: 908172', '908172'],
    ['Your PIN: 2019', '2019'],
    ['Your code expires in 2026 seconds', null],
    ['Welcome to Acme! © 2026 Acme Inc. All rights reserved.', null],
    ['Valid until 2026. Call 0300 1234567 for help.', null],
    ['Your verification code for order 55555 is 123456', '123456'],
    ['Order #123456 confirmed. Your verification code is 8821.', '8821'],
    ['Your order 782341 has shipped.', null],
    ['Your code is 4821. Ticket 123456 is still open.', '4821'],
    ['Pay $123456 by Friday', null],
    ['Total: 150000 PKR, valid for 1440 minutes', null],
    ['Call us at 1-800-555-0199 or visit https://acme.test/verify?code=123456', null],
    ['Click https://app.test/login?otp=998877 to sign in. Your code: 445566', '445566'],
    ['Your code is 3344 and expires in 10 minutes', '3344'],
    // Alphanumeric codes
    ['Your verification code is A7K-92Q', 'A7K-92Q'],
    ['Your code: X4F9P2', 'X4F9P2'],
    ['Use promo code SAVE20 for 20% off', null],
    ['COVID-19 update: our office is open', null],
    ['Enable 2FA today. Your login code is 771203', '771203'],
    // Other languages
    ['آپ کا تصدیقی کوڈ 482193 ہے۔ اسے کسی کے ساتھ شیئر نہ کریں۔', '482193'],
    ['Tu código de verificación es 662341', '662341'],
    ['Votre code de vérification est 553201', '553201'],
    ['Ihr Bestätigungscode lautet 771122', '771122'],
    ['Ваш код подтверждения: 4492', '4492'],
    ['您的验证码是 839201，5分钟内有效。', '839201'],
    ['Seu código é 1029', '1029'],
  ])('real-world: %s → %s', (text, expected) => {
    expect(extractOtp(text)).toBe(expected);
  });

  it('uses a custom project regex first', () => {
    expect(extractOtp('Token ABC-778 ready', 'Token ([A-Z]+-\\d+)')).toBe('ABC-778');
  });

  it('ignores an invalid custom regex', () => {
    expect(extractOtp('code 1234', '(')).toBe('1234');
  });
});

describe('extractLinks', () => {
  it('finds links in text and href attributes, unescaping &amp;', () => {
    const links = extractLinks('Verify: https://app.test/verify?t=abc.', '<a href="https://app.test/x?a=1&amp;b=2">x</a>');
    expect(links).toContain('https://app.test/verify?t=abc');
    expect(links).toContain('https://app.test/x?a=1&b=2');
  });
});

describe('htmlToText', () => {
  it('strips tags, scripts and entities', () => {
    expect(htmlToText('<style>p{}</style><p>Hello&nbsp;<b>World</b></p><br>Bye &amp; thanks')).toBe('Hello World\n\nBye & thanks');
  });
});

describe('extractLinks brackets', () => {
  it('drops the closing bracket mailparser adds around links, keeps IPv6 hosts', () => {
    expect(extractLinks('Verify [https://app.test/verify?t=abc] now')).toEqual(['https://app.test/verify?t=abc']);
    expect(extractLinks('Open http://[::1]:4000/x please')).toEqual(['http://[::1]:4000/x']);
    expect(extractLinks('Docs [http://[::1]:4000/a]')).toEqual(['http://[::1]:4000/a']);
  });
});

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

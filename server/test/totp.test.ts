import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, parseOtpauth, totp } from '../src/totp/totp.js';

// RFC 6238 Appendix B test vectors (8 digits). Seeds are ASCII "1234567890" repeated to the key length.
const seed = (len: number) => base32Encode(Buffer.from('1234567890'.repeat(7).slice(0, len)));
const vectors: [number, string, string, string][] = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(vectors)('t=%i', (t, sha1, sha256, sha512) => {
    const at = t * 1000;
    expect(totp({ secret: seed(20), algorithm: 'SHA1', digits: 8, period: 30 }, at).code).toBe(sha1);
    expect(totp({ secret: seed(32), algorithm: 'SHA256', digits: 8, period: 30 }, at).code).toBe(sha256);
    expect(totp({ secret: seed(64), algorithm: 'SHA512', digits: 8, period: 30 }, at).code).toBe(sha512);
  });

  it('reports remaining seconds and the next code', () => {
    const r = totp({ secret: seed(20), algorithm: 'SHA1', digits: 8, period: 30 }, 1111111109 * 1000);
    expect(r.remaining).toBe(1); // 1111111109 % 30 = 29
    expect(r.nextCode).toBe(totp({ secret: seed(20), algorithm: 'SHA1', digits: 8, period: 30 }, 1111111110 * 1000).code);
  });

  it('accepts secrets with spaces, lowercase and padding', () => {
    expect(base32Decode('jbsw y3dp ehpk 3pxp==')).toEqual(base32Decode('JBSWY3DPEHPK3PXP'));
    expect(() => base32Decode('NOT-BASE32-1!')).toThrow(/not valid base32/);
  });
});

describe('otpauth:// links', () => {
  it('parses issuer, account and parameters', () => {
    const p = parseOtpauth('otpauth://totp/Hyper:admin%40hyper.test?secret=JBSWY3DPEHPK3PXP&issuer=Hyper&digits=6&period=30');
    expect(p).toEqual({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Hyper', account: 'admin@hyper.test', algorithm: 'SHA1', digits: 6, period: 30 });
  });

  it('uses defaults and the label issuer when parameters are missing', () => {
    const p = parseOtpauth('otpauth://totp/Fleet:ops?secret=jbswy3dpehpk3pxp&algorithm=SHA256');
    expect(p).toMatchObject({ issuer: 'Fleet', account: 'ops', algorithm: 'SHA256', digits: 6, period: 30, secret: 'JBSWY3DPEHPK3PXP' });
  });

  it('rejects counter-based (hotp) and malformed links', () => {
    expect(() => parseOtpauth('otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1')).toThrow(/time-based/);
    expect(() => parseOtpauth('https://example.com')).toThrow(/otpauth/);
    expect(() => parseOtpauth('otpauth://totp/X?issuer=Y')).toThrow(/no secret/);
  });
});

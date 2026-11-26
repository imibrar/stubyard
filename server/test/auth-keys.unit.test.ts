import crypto from 'node:crypto';
import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '../src/auth/keys.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** What a consumer does with the cert: parse it, take its public key, verify a signature made with the key. */
function assertUsable(k: ReturnType<typeof generateSigningKey>): crypto.X509Certificate {
  const x = new crypto.X509Certificate(k.certPem);
  expect(x.checkPrivateKey(crypto.createPrivateKey(k.privatePem))).toBe(true);
  const sig = crypto.createSign('RSA-SHA256').update('payload').sign(k.privatePem, 'base64');
  expect(crypto.createVerify('RSA-SHA256').update('payload').verify(k.certPem, sig, 'base64')).toBe(true);
  return x;
}

describe('signing key certificate (auth, Nafath, PayPal webhooks)', () => {
  it('is accepted by OpenSSL even when the random serial bytes start with zeros', () => {
    // The worst case for the old serial ('0' + hex of 15 random bytes): leading 0x00 followed by a byte < 0x80,
    // which forge encoded as the non-minimal INTEGER 00 01 ... ("asn1 encoding routines::illegal padding").
    const zeros = (n: number) => Buffer.concat([Buffer.alloc(2), Buffer.alloc(n - 2, 0x01)]);
    vi.spyOn(forge.random, 'getBytesSync').mockImplementation((n: number) => zeros(n).toString('binary'));
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((n: number) => zeros(n)) as typeof crypto.randomBytes);
    // A positive, minimal 16-byte serial (first byte 0x40..0x7f).
    expect(assertUsable(generateSigningKey('messageverificationcerts.stubyard.paypal')).serialNumber).toMatch(/^[4-7][0-9A-F]{31}$/);
  });

  it('is accepted by OpenSSL across many fresh keys', { timeout: 120_000 }, () => {
    for (let i = 0; i < 300; i++) assertUsable(generateSigningKey(`stubyard test ${i}`));
  });
});

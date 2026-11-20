import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTls, randomSerial } from '../src/tls/ca.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-tls-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('local CA', () => {
  it('random serials are always minimal, positive DER integers', () => {
    for (let i = 0; i < 5000; i++) {
      const s = randomSerial();
      expect(s).toMatch(/^[4-7][0-9a-f]{31}$/);
    }
  });

  it('produces material OpenSSL accepts', () => {
    const m = ensureTls(tmpDir());
    expect(() => tls.createSecureContext({ key: m.keyPem, cert: m.certPem })).not.toThrow();
    expect(() => new crypto.X509Certificate(m.caCertPem)).not.toThrow();
  });

  it('replaces a stored CA that OpenSSL rejects (illegal-padding serial) instead of crashing', () => {
    const dir = tmpDir();
    const first = ensureTls(dir);
    // Re-sign the CA with the non-minimal serial an older version could produce (leading 0x00 before a byte < 0x80).
    const key = forge.pki.privateKeyFromPem(fs.readFileSync(path.join(dir, 'ca.key'), 'utf8'));
    const cert = forge.pki.certificateFromPem(first.caCertPem);
    // The old randomSerial(): '0' + hex of 15 random bytes, here with a first random byte of 0x00.
    cert.serialNumber = '0' + '0077b3bb15182810579b6b0694ecad';
    cert.sign(key, forge.md.sha256.create());
    fs.writeFileSync(path.join(dir, 'ca.crt'), forge.pki.certificateToPem(cert));
    expect(() => new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8'))).toThrow(/illegal padding/);

    const fixed = ensureTls(dir);
    expect(fixed.caFingerprint).not.toBe(first.caFingerprint);
    expect(() => tls.createSecureContext({ key: fixed.keyPem, cert: fixed.certPem })).not.toThrow();
    expect(new crypto.X509Certificate(fixed.certPem).verify(new crypto.X509Certificate(fixed.caCertPem).publicKey)).toBe(true);
  });

  it('reissues a truncated leaf key and keeps a valid CA', () => {
    const dir = tmpDir();
    const first = ensureTls(dir);
    fs.writeFileSync(path.join(dir, 'server.key'), first.keyPem.slice(0, 200));
    const again = ensureTls(dir);
    expect(again.caFingerprint).toBe(first.caFingerprint);
    expect(() => tls.createSecureContext({ key: again.keyPem, cert: again.certPem })).not.toThrow();
  });
});

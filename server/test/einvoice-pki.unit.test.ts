import { describe, expect, it } from 'vitest';
import crypto, { X509Certificate } from 'node:crypto';
import { buildCsr, type CsrInput } from '../src/einvoice/zatca/csr.js';
import {
  binarySecurityToken,
  certFromToken,
  certHash,
  certHashRaw,
  certHashVariants,
  certInfo,
  certIssuedBy,
  createCa,
  ecdsaSign,
  ecdsaVerify,
  issueCert,
  parseCsr,
} from '../src/einvoice/zatca/pki.js';

/** The fake ZATCA PKI: CSR build/parse with proof of possession, the CA, CSID issue and the digest helpers. */

const key = () => crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;

const INPUT: Omit<CsrInput, 'privateKey'> = {
  commonName: 'EGS1-886431145',
  vatNumber: '399999999900003',
  egsSerial: '1-stubyard|2-POS|3-0001',
  orgUnit: 'Riyadh Branch',
  org: 'Maximum Speed Tech Supply LTD',
  invoiceTypes: '1100',
  address: 'RRRD2929',
  industry: 'Supply activities',
  template: 'TSTZATCA-Code-Signing',
};

const ca = createCa();

describe('CSR build and parse', () => {
  const privateKey = key();
  const pem = buildCsr({ privateKey, ...INPUT });

  it('round-trips every field', () => {
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
    const csr = parseCsr(pem);
    expect(csr.subject).toEqual({ C: 'SA', OU: INPUT.orgUnit, O: INPUT.org, CN: INPUT.commonName });
    expect(csr.san).toEqual({
      SN: INPUT.egsSerial,
      UID: INPUT.vatNumber,
      title: '1100',
      registeredAddress: INPUT.address,
      businessCategory: INPUT.industry,
    });
    expect(csr.egsSerial).toBe(INPUT.egsSerial);
    expect(csr.vatNumber).toBe(INPUT.vatNumber);
    expect(csr.invoiceTypes).toBe('1100');
    expect(csr.template).toBe('TSTZATCA-Code-Signing');
    expect(csr.curve).toBe('secp256k1');
    expect(csr.signatureAlgorithm).toBe('1.2.840.10045.4.3.2');
    expect(csr.popValid).toBe(true);
    expect(csr.publicKey.export({ format: 'der', type: 'spki' })).toEqual(
      crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }),
    );
  });

  it('accepts base64 of the PEM (the {csr} body) and keeps UTF-8 text', () => {
    const arabic = buildCsr({ privateKey, ...INPUT, org: 'شركة توريد', template: 'ZATCA-Code-Signing' });
    const csr = parseCsr(Buffer.from(arabic).toString('base64'));
    expect(csr.subject.O).toBe('شركة توريد');
    expect(csr.template).toBe('ZATCA-Code-Signing');
    expect(csr.popValid).toBe(true);
  });

  it('fails proof of possession when the CSR is tampered', () => {
    const der = parseCsr(pem).der;
    const at = der.indexOf(Buffer.from('Riyadh'));
    expect(at).toBeGreaterThan(0);
    const bad = Buffer.from(der);
    bad[at] = 'J'.charCodeAt(0);
    const csr = parseCsr(bad.toString('base64'));
    expect(csr.subject.OU).toBe('Jiyadh Branch');
    expect(csr.popValid).toBe(false);
  });

  it('reports a non-secp256k1 curve', () => {
    const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const csr = parseCsr(buildCsr({ privateKey: p256, ...INPUT, template: 'PREZATCA-Code-Signing' }));
    expect(csr.curve).toBe('prime256v1');
    expect(csr.template).toBe('PREZATCA-Code-Signing');
    expect(csr.popValid).toBe(true);
  });

  it('rejects input that is not a CSR', () => {
    expect(() => parseCsr('not a csr')).toThrow();
    expect(() => parseCsr(ca.certPem)).toThrow();
  });
});

describe('CA and CSID certificates', () => {
  const privateKey = key();
  const csr = parseCsr(buildCsr({ privateKey, ...INPUT }));
  const certPem = issueCert(ca, csr, { template: 'TSTZATCA-Code-Signing', days: 30, serial: '0abc12' });

  it('creates a self-signed secp256k1 CA', () => {
    const x = new X509Certificate(ca.certPem);
    expect(x.subject).toContain('CN=stubyard fake ZATCA CA');
    expect(x.ca).toBe(true);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('secp256k1');
    expect(crypto.createPrivateKey(ca.keyPem).asymmetricKeyDetails?.namedCurve).toBe('secp256k1');
  });

  it('issues a certificate node verifies against the CA', () => {
    const x = new X509Certificate(certPem);
    const caX = new X509Certificate(ca.certPem);
    expect(x.verify(caX.publicKey)).toBe(true);
    expect(x.checkIssued(caX)).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.subject.split('\n')).toEqual(['C=SA', `OU=${INPUT.orgUnit}`, `O=${INPUT.org}`, `CN=${INPUT.commonName}`]);
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(x.publicKey.export({ format: 'der', type: 'spki' })).toEqual(csr.spkiDer);
    expect(certIssuedBy(certPem, ca)).toBe(true);
    expect(certIssuedBy(certPem, createCa())).toBe(false);
  });

  it('exposes certInfo fields', () => {
    const info = certInfo(certPem);
    expect(info.serial).toBe('0abc12');
    expect(info.subject).toContain(`CN=${INPUT.commonName}`);
    expect(info.issuer).toContain('CN=stubyard fake ZATCA CA');
    expect(info.egsSerial).toBe(INPUT.egsSerial);
    expect(info.vatNumber).toBe(INPUT.vatNumber);
    expect(info.template).toBe('TSTZATCA-Code-Signing');
    const days = (info.notAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(info.spkiDer).toEqual(csr.spkiDer);
    // the signature value is the CA's ECDSA signature over the TBS certificate
    const x = new X509Certificate(certPem);
    expect(info.signatureValue[0]).toBe(0x30);
    expect(x.raw.subarray(x.raw.length - info.signatureValue.length)).toEqual(info.signatureValue);
  });

  it('defaults the template from the CSR and accepts a PEM CSR', () => {
    const pem = buildCsr({ privateKey, ...INPUT, template: 'ZATCA-Code-Signing' });
    expect(certInfo(issueCert(ca, pem)).template).toBe('ZATCA-Code-Signing');
  });

  it('round-trips the binarySecurityToken', () => {
    const token = binarySecurityToken(certPem);
    const b64Der = Buffer.from(token, 'base64').toString('latin1');
    expect(Buffer.from(b64Der, 'base64')).toEqual(new X509Certificate(certPem).raw);
    expect(certFromToken(token)).toBe(certPem);
  });

  it('computes the certificate hash quirk and the raw variant', () => {
    const raw = new X509Certificate(certPem).raw;
    const hex = crypto.createHash('sha256').update(raw).digest('hex');
    expect(certHash(certPem)).toBe(Buffer.from(hex).toString('base64'));
    expect(certHashRaw(certPem)).toBe(Buffer.from(hex, 'hex').toString('base64'));
    expect(certHash(certPem)).not.toBe(certHashRaw(certPem));
    const v = certHashVariants(certPem);
    expect(new Set(Object.values(v)).size).toBe(4);
    expect(Buffer.from(v.hexText, 'base64').toString()).toBe(
      crypto.createHash('sha256').update(raw.toString('base64')).digest('hex'),
    );
  });
});

describe('ECDSA helpers', () => {
  const privateKey = key();
  const keyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const certPem = issueCert(ca, buildCsr({ privateKey, ...INPUT }));

  it('signs and verifies with a certificate, a KeyObject and a public key PEM', () => {
    const sig = ecdsaSign(keyPem, 'invoice hash');
    expect(ecdsaVerify(certPem, 'invoice hash', sig)).toBe(true);
    expect(ecdsaVerify(crypto.createPublicKey(privateKey), Buffer.from('invoice hash'), sig)).toBe(true);
    const pubPem = crypto.createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }) as string;
    expect(ecdsaVerify(pubPem, 'invoice hash', sig)).toBe(true);
  });

  it('rejects a wrong message, key or garbage signature', () => {
    const sig = ecdsaSign(keyPem, 'invoice hash');
    expect(ecdsaVerify(certPem, 'other', sig)).toBe(false);
    expect(ecdsaVerify(ca.certPem, 'invoice hash', sig)).toBe(false);
    expect(ecdsaVerify(certPem, 'invoice hash', 'AAAA')).toBe(false);
  });
});

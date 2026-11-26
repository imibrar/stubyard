import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/einvoice/zatca/c14n.js';
import { hashVariants, sha256b64, sha256hexb64 } from '../src/einvoice/zatca/hash.js';
import { certHashVariants, ecdsaSign } from '../src/einvoice/zatca/pki.js';
import { decodeTlv, encodeTlv } from '../src/einvoice/zatca/qr.js';
import { cryptoChecks, cryptoRules } from '../src/einvoice/zatca/rules/crypto.js';
import { BREAKS, BREAK_NAMES, demoEgs, sample, type BreakName, type SampleOptions } from '../src/einvoice/zatca/sample.js';
import { parseInvoice, validateInvoice, type RuleContext, type ValidateInput } from '../src/einvoice/zatca/validate.js';
import { descendants, parseXml } from '../src/einvoice/zatca/xml.js';
import type { Csid } from '../src/einvoice/types.js';

/** Phase 2 crypto + QR rules (B6 S16). */

const egs = demoEgs();
const other = demoEgs(); // another CA
const sibling = demoEgs(egs.ca); // same CA, another certificate

const base = (over: Partial<SampleOptions> = {}): SampleOptions => ({
  type: 'simplified',
  kind: '388',
  icv: 3,
  number: 'SME00003',
  egs,
  issueAt: '2026-11-20T09:30:15Z',
  ...over,
});

const csidOf = (certPem: string): Csid => ({ certPem, kind: 'production' }) as Csid;

function ctxOf(xml: string, input: Partial<ValidateInput> = {}): RuleContext {
  const p = parseInvoice(xml);
  if (!p.ok) throw new Error(p.error);
  return {
    doc: p.doc,
    root: p.doc.documentElement!,
    xml: p.xml,
    extracted: p.extracted,
    input: { xml, config: { checks: 'full', chainCheck: 'off', caCertPem: egs.ca.certPem }, ...input },
  };
}

const run = (xml: string, input?: Partial<ValidateInput>) => cryptoChecks(ctxOf(xml, input));
const codes = (xml: string, input?: Partial<ValidateInput>) => run(xml, input).findings.map((f) => f.code);
const sigValue = (xml: string): string => /<ds:SignatureValue>([^<]+)</.exec(xml)![1];
const notes = (xml: string) => run(xml).lint.filter((l) => l.check === 'einv.signature-method' || l.check === 'einv.signature-variant').map((l) => l.message);

/** Recompute the SignedProperties digest after editing them (the signature value is over the invoice hash, unaffected). */
function redigestSp(xml: string): string {
  const sp = descendants(parseXml(xml), 'xades:SignedProperties')[0];
  return xml.replace(/(Type="http:\/\/uri\.etsi\.org\/01903#SignedProperties"[^>]*>\s*<ds:DigestMethod[^>]*\/>\s*<ds:DigestValue>)[^<]*/, `$1${sha256hexb64(canonicalize(sp))}`);
}

/** Replace QR tags (the QR is outside the invoice hash, so nothing else changes). */
function retag(xml: string, tags: Record<number, string | Buffer>): string {
  const payload = /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(xml)![1];
  const d = decodeTlv(payload);
  if (!d.ok) throw new Error(d.error);
  const next = encodeTlv(d.fields.map((f) => ({ tag: f.tag, value: tags[f.tag] ?? f.bytes })));
  return xml.replace(payload, next);
}

describe('crypto rules: valid samples', () => {
  for (const type of ['simplified', 'standard'] as const) {
    for (const kind of ['388', '381', '383'] as const) {
      it(`${type} ${kind}: no findings, the signature input is reported as info`, () => {
        const s = sample(base({ type, kind }));
        const r = run(s.xml, { csid: csidOf(egs.certPem) });
        expect(r.findings).toEqual([]);
        expect(r.lint.map((l) => [l.check, l.severity])).toEqual([['einv.signature-method', 'info']]);
        expect(r.lint[0].message).toMatch(/invoice hash bytes/);
      });
    }
  }

  it('cryptoRules is the findings of cryptoChecks', () => {
    const s = sample(base({ break: ['qr-total'] }));
    expect(cryptoRules(ctxOf(s.xml))).toEqual(run(s.xml).findings);
  });

  it('skips the CA and CSID checks when the context has neither', () => {
    const s = sample(base({ egs: other }));
    expect(codes(s.xml, { config: { checks: 'full', chainCheck: 'off' } })).toEqual([]);
  });
});

describe('crypto rules: the sample breaks', () => {
  const crypto = new Set<BreakName>(['tamper-after-sign', 'no-signature', 'qr-total', 'minified-hash']);

  it('tamper-after-sign: invalid-signature, and QR tag 6 no longer matches', () => {
    const r = run(sample(base({ break: ['tamper-after-sign'] })).xml);
    expect(r.findings.map((f) => f.code)).toEqual(['invalid-signature', 'QRCODE_INVALID']);
    expect(r.findings[0].message).toMatch(/changed after signing/);
    expect(r.findings[1].message).toMatch(/QR tag 6/);
  });

  it('no-signature: BR-KSA-60 on a simplified invoice, nothing on a standard one', () => {
    expect(codes(sample(base({ break: ['no-signature'] })).xml)).toEqual(['BR-KSA-60']);
    expect(codes(sample(base({ type: 'standard', break: ['no-signature'] })).xml)).toEqual([]);
  });

  it('qr-total: one QRCODE_INVALID naming tag 4', () => {
    const r = run(sample(base({ break: ['qr-total'] })).xml);
    expect(r.findings.map((f) => f.code)).toEqual([BREAKS['qr-total'].code]);
    expect(r.findings[0].message).toMatch(/QR tag 4 \(total with VAT\)/);
  });

  it('minified-hash: the body hash is phase 1 (invalid-invoice-hash + einv.hash-variant); the XML itself is fine', () => {
    const s = sample(base({ break: ['minified-hash'] }));
    expect(codes(s.xml)).toEqual([]);
    const v = validateInvoice({ xml: s.xml, invoiceHash: s.invoiceHash, config: { checks: 'basic', chainCheck: 'off' } });
    expect(v.findings.map((f) => f.code)).toEqual(['invalid-invoice-hash']);
    expect(v.lint.find((l) => l.check === 'einv.hash-variant')?.message).toMatch(/minified/);
  });

  it('a signed digest computed the minified way: invalid-invoice-hash + einv.hash-variant, the signature still verifies', () => {
    const s = sample(base());
    const minified = hashVariants(s.xml).find((v) => v.variant === 'minified')!.hash;
    const xml = s.xml.replace(`<ds:DigestValue>${s.invoiceHash}</ds:DigestValue>`, `<ds:DigestValue>${minified}</ds:DigestValue>`);
    const r = run(xml);
    expect(r.findings.map((f) => f.code)).toEqual(['invalid-invoice-hash']);
    expect(r.lint.find((l) => l.check === 'einv.hash-variant')?.message).toMatch(/"minified"/);
  });

  for (const b of BREAK_NAMES.filter((n) => !crypto.has(n))) {
    it(`${b}: no crypto findings (not a crypto break)`, () => {
      expect(codes(sample(base({ break: [b] })).xml)).toEqual([]);
    });
  }
});

describe('crypto rules: the signing certificate', () => {
  it('a certificate from another CA: certificate-mismatch', () => {
    const r = run(sample(base({ egs: other })).xml);
    expect(r.findings.map((f) => f.code)).toEqual(['certificate-mismatch']);
    expect(r.findings[0].message).toMatch(/not issued by this instance's CA/);
  });

  it("not the request CSID's certificate: certificate-mismatch", () => {
    const s = sample(base());
    expect(codes(s.xml, { csid: csidOf(sibling.certPem) })).toEqual(['certificate-mismatch']);
    expect(codes(sample(base({ egs: sibling })).xml, { csid: csidOf(sibling.certPem) })).toEqual([]);
  });

  it('every certHashVariants form of the CertDigest is accepted, with a lint note when not the hex one', () => {
    const s = sample(base());
    const v = certHashVariants(egs.certPem);
    for (const k of ['raw', 'hexText', 'rawText'] as const) {
      const xml = redigestSp(s.xml.replace(`<ds:DigestValue>${v.hex}</ds:DigestValue>`, `<ds:DigestValue>${v[k]}</ds:DigestValue>`));
      expect(codes(xml), k).toEqual([]);
      expect(notes(xml).some((m) => m.startsWith('The CertDigest was computed as')), k).toBe(true);
    }
  });

  it('a wrong CertDigest, serial or issuer: certificate-mismatch', () => {
    const s = sample(base());
    const v = certHashVariants(egs.certPem);
    const wrongDigest = redigestSp(s.xml.replace(`<ds:DigestValue>${v.hex}</ds:DigestValue>`, `<ds:DigestValue>${sha256b64('x')}</ds:DigestValue>`));
    expect(codes(wrongDigest)).toEqual(['certificate-mismatch']);
    const wrongSerial = redigestSp(s.xml.replace(/(<ds:X509SerialNumber>)(\d+)/, (_m, a: string, d: string) => a + (BigInt(d) + 1n).toString()));
    expect(codes(wrongSerial)).toEqual(['certificate-mismatch']);
    const wrongIssuer = redigestSp(s.xml.replace(/(<ds:X509IssuerName>)[^<]*/, '$1CN=Someone Else'));
    expect(codes(wrongIssuer)).toEqual(['certificate-mismatch']);
  });

  it('the issuer name is compared without regard to RDN order', () => {
    const s = sample(base());
    const xml = redigestSp(s.xml.replace(/(<ds:X509IssuerName>)([^<]*)/, (_m, a: string, dn: string) => a + dn.split(', ').reverse().join(', ')));
    expect(codes(xml)).toEqual([]);
  });

  it('no certificate in KeyInfo: certificate-mismatch', () => {
    const s = sample(base());
    expect(codes(s.xml.replace(/<ds:X509Certificate>[^<]*<\/ds:X509Certificate>/, '<ds:X509Certificate></ds:X509Certificate>'))).toContain('certificate-mismatch');
  });
});

describe('crypto rules: SignedProperties and the signature value', () => {
  it('a wrong SignedProperties digest: signed-properties-hashing', () => {
    const s = sample(base());
    const xml = s.xml.replace('<xades:SigningTime>', '<xades:SigningTime>X');
    expect(codes(xml)).toEqual(['signed-properties-hashing']);
  });

  it('a raw SignedProperties digest is accepted with a lint note', () => {
    const s = sample(base());
    const sp = descendants(parseXml(s.xml), 'xades:SignedProperties')[0];
    const xml = s.xml.replace(sha256hexb64(canonicalize(sp)), sha256b64(canonicalize(sp)));
    expect(codes(xml)).toEqual([]);
    expect(notes(xml).some((m) => m.includes('raw (not hex)'))).toBe(true);
  });

  it('Type xmldsig#SignatureProperties is accepted with a lint note', () => {
    const s = sample(base());
    const xml = s.xml.replace('Type="http://uri.etsi.org/01903#SignedProperties"', 'Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties"');
    expect(codes(xml)).toEqual([]);
    expect(notes(xml).some((m) => m.includes('xmldsig#SignatureProperties'))).toBe(true);
  });

  it('a signature over the canonical SignedInfo is accepted, reported as info', () => {
    const s = sample(base());
    const si = descendants(parseXml(s.xml), 'ds:SignedInfo')[0];
    const sig = ecdsaSign(egs.privateKey, canonicalize(si));
    const xml = retag(s.xml.replace(sigValue(s.xml), sig), { 7: sig });
    expect(codes(xml)).toEqual([]);
    expect(notes(xml).some((m) => m.includes('canonical ds:SignedInfo'))).toBe(true);
  });

  it('a signature by another key: invalid-signature', () => {
    const s = sample(base());
    const sig = ecdsaSign(sibling.privateKey, Buffer.from(s.invoiceHash, 'base64'));
    const xml = retag(s.xml.replace(sigValue(s.xml), sig), { 7: sig });
    const r = run(xml);
    expect(r.findings.map((f) => f.code)).toEqual(['invalid-signature']);
    expect(r.findings[0].message).toMatch(/does not verify/);
  });
});

describe('crypto rules: QR', () => {
  it('tags 6 and 7 as raw bytes are accepted', () => {
    const s = sample(base());
    expect(codes(retag(s.xml, { 6: Buffer.from(s.invoiceHash, 'base64'), 7: Buffer.from(sigValue(s.xml), 'base64') }))).toEqual([]);
  });

  it('a timestamp with Z is accepted; any other mismatch names its tag', () => {
    const s = sample(base());
    expect(codes(retag(s.xml, { 3: '2026-11-20T09:30:15Z' }))).toEqual([]);
    const wrong: Record<number, string | Buffer> = {
      1: 'Someone', 2: '300000000000003', 3: '2026-11-20T09:30:16', 4: '1.00', 5: '0.01',
      6: sha256b64('x'), 7: sha256b64('y'), 8: Buffer.from('k'), 9: Buffer.from('s'),
    };
    for (const [tag, value] of Object.entries(wrong)) {
      const r = run(retag(s.xml, { [tag]: value }));
      expect(r.findings.map((f) => f.code), `tag ${tag}`).toEqual(['QRCODE_INVALID']);
      expect(r.findings[0].message).toContain(`QR tag ${tag} `);
    }
  });

  it('amounts compare as decimals', () => {
    const s = sample(base());
    const tags = decodeTlv(/<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(s.xml)![1]);
    if (!tags.ok) throw new Error(tags.error);
    const total = tags.fields.find((f) => f.tag === 4)!.text;
    expect(codes(retag(s.xml, { 4: `${total}0` }))).toEqual([]);
  });

  it('a missing tag 9 on a simplified invoice; no tag 9 needed on a standard one', () => {
    const strip9 = (xml: string) => {
      const payload = /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(xml)![1];
      const d = decodeTlv(payload);
      if (!d.ok) throw new Error(d.error);
      return xml.replace(payload, encodeTlv(d.fields.filter((f) => f.tag !== 9).map((f) => ({ tag: f.tag, value: f.bytes }))));
    };
    const r = run(strip9(sample(base()).xml));
    expect(r.findings.map((f) => f.code)).toEqual(['QRCODE_INVALID']);
    expect(r.findings[0].message).toMatch(/QR tag 9 .* missing/);
    expect(codes(sample(base({ type: 'standard' })).xml)).toEqual([]);
  });

  it('an undecodable QR: QRCODE_INVALID; a missing QR is left to BR-KSA-27', () => {
    const s = sample(base());
    const payload = /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(s.xml)![1];
    expect(codes(s.xml.replace(payload, 'AQ=='))).toEqual(['QRCODE_INVALID']);
    const noQr = s.xml.replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, '');
    expect(codes(noQr)).toEqual([]);
  });
});

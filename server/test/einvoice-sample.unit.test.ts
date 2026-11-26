import { describe, expect, it } from 'vitest';
import type { Element } from '@xmldom/xmldom';
import { canonicalize } from '../src/einvoice/zatca/c14n.js';
import { add, eq, parse } from '../src/einvoice/zatca/dec.js';
import { FIRST_PIH, hashVariants, invoiceHash, sha256b64, sha256hexb64 } from '../src/einvoice/zatca/hash.js';
import { certHash, certInfo, certIssuedBy, ecdsaVerify } from '../src/einvoice/zatca/pki.js';
import { decodeTlv } from '../src/einvoice/zatca/qr.js';
import { ruleByCode } from '../src/einvoice/zatca/rules/catalog.js';
import { EINVOICE_LINT_CHECKS } from '../src/einvoice/lint.js';
import {
  BREAKS,
  BREAK_NAMES,
  buildInvoice,
  demoEgs,
  sample,
  signInvoice,
  type BreakName,
  type SampleOptions,
} from '../src/einvoice/zatca/sample.js';
import { descendants, find, findAll, parseXml, text } from '../src/einvoice/zatca/xml.js';

/** The sample generator (B6 S7): UBL builder, XAdES signer, QR, and the broken variants. */

const egs = demoEgs();
const ISSUE_AT = '2026-11-20T09:30:15Z';
const UUID = '3cf5ee18-ee25-44ea-a444-2c37ba7f28be';

const base = (over: Partial<SampleOptions> = {}): SampleOptions => ({
  type: 'simplified',
  kind: '388',
  icv: 7,
  number: 'SME00007',
  egs,
  issueAt: ISSUE_AT,
  uuid: UUID,
  ...over,
});

const root = (xml: string): Element => parseXml(xml).documentElement!;
const t = (xml: string, path: string): string => text(root(xml), path) ?? '';
const d = (s: string) => parse(s);

describe('demo EGS', () => {
  it('has a valid seller and a certificate issued by its CA for its VAT and serial', () => {
    expect(egs.vat).toMatch(/^3\d{13}3$/);
    expect(egs.address.building).toMatch(/^\d{4}$/);
    expect(egs.address.postal).toMatch(/^\d{5}$/);
    expect(egs.sellerName).toBe(egs.sellerNameAr);
    expect(demoEgs(egs.ca, { lang: 'en' }).sellerName).toBe(egs.sellerNameEn);
    expect(certIssuedBy(egs.certPem, egs.ca)).toBe(true);
    const info = certInfo(egs.certPem);
    expect(info.vatNumber).toBe(egs.vat);
    expect(info.egsSerial).toBe(egs.egsSerial);
  });
});

describe('buildInvoice', () => {
  const xml = buildInvoice({ type: 'standard', kind: '388', number: 'INV-1', icv: 1, issueAt: ISSUE_AT, seller: egs, uuid: UUID });
  const r = root(xml);

  it('has the ZATCA header fields', () => {
    expect(t(xml, 'cbc:ProfileID')).toBe('reporting:1.0');
    expect(t(xml, 'cbc:UUID')).toBe(UUID);
    expect(t(xml, 'cbc:IssueDate')).toBe('2026-11-20');
    expect(t(xml, 'cbc:IssueTime')).toBe('09:30:15');
    expect(find(r, 'cbc:InvoiceTypeCode')!.getAttribute('name')).toBe('0100000');
    expect(t(xml, 'cbc:DocumentCurrencyCode')).toBe('SAR');
    expect(t(xml, 'cbc:TaxCurrencyCode')).toBe('SAR');
    const refs = findAll(r, 'cac:AdditionalDocumentReference');
    expect(refs.map((x) => text(x, 'cbc:ID'))).toEqual(['ICV', 'PIH']);
    expect(text(refs[0], 'cbc:UUID')).toBe('1');
    expect(text(refs[1], 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject')).toBe(FIRST_PIH);
    expect(t(xml, 'cac:Delivery/cbc:ActualDeliveryDate')).toBe('2026-11-20');
    expect(t(xml, 'cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName')).not.toBe('');
    expect(find(r, 'cac:BillingReference')).toBeNull();
    expect(findAll(r, 'cac:TaxTotal')).toHaveLength(2);
    expect(find(r, 'cac:TaxTotal/cac:TaxSubtotal')).not.toBeNull();
  });

  it('computes consistent amounts', () => {
    const nets = findAll(r, 'cac:InvoiceLine').map((l) => d(text(l, 'cbc:LineExtensionAmount')!));
    const sum = nets.reduce(add, 0n);
    expect(eq(sum, d(t(xml, 'cac:LegalMonetaryTotal/cbc:LineExtensionAmount')))).toBe(true);
    const vat = d(t(xml, 'cac:TaxTotal/cbc:TaxAmount'));
    const excl = d(t(xml, 'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount'));
    expect(eq(add(excl, vat), d(t(xml, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount')))).toBe(true);
    expect(t(xml, 'cac:LegalMonetaryTotal/cbc:PayableAmount')).toBe(t(xml, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount'));
    for (const l of findAll(r, 'cac:InvoiceLine')) {
      expect(eq(add(d(text(l, 'cbc:LineExtensionAmount')!), d(text(l, 'cac:TaxTotal/cbc:TaxAmount')!)), d(text(l, 'cac:TaxTotal/cbc:RoundingAmount')!))).toBe(true);
      expect(text(l, 'cac:Item/cac:ClassifiedTaxCategory/cbc:ID')).toBe('S');
      expect(text(l, 'cac:Item/cac:ClassifiedTaxCategory/cbc:Percent')).toBe('15.00');
    }
    // 37.00 + 45.25 = 82.25; VAT 12.3375 → 12.34
    expect(t(xml, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount')).toBe('94.59');
  });

  it('rounds category VAT at document level, not by summing rounded lines', () => {
    const x = buildInvoice({
      type: 'simplified', kind: '388', number: 'INV-2', icv: 2, issueAt: ISSUE_AT, seller: egs,
      lines: [{ name: 'a', quantity: 3, price: '12.33' }, { name: 'b', quantity: 1, price: '7.77' }],
      allowance: '1.00',
    });
    const lines = findAll(root(x), 'cac:InvoiceLine').map((l) => text(l, 'cac:TaxTotal/cbc:TaxAmount'));
    expect(lines).toEqual(['5.55', '1.17']); // 36.99 × 15% = 5.5485; 7.77 × 15% = 1.1655
    expect(t(x, 'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount')).toBe('43.76');
    expect(t(x, 'cac:TaxTotal/cbc:TaxAmount')).toBe('6.56'); // 43.76 × 15% = 6.564
    expect(t(x, 'cac:AllowanceCharge/cbc:Amount')).toBe('1.00');
    expect(t(x, 'cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount')).toBe('43.76');
  });

  it('adds BillingReference and the reason to credit and debit notes', () => {
    for (const kind of ['381', '383'] as const) {
      const x = buildInvoice({ type: 'standard', kind, number: 'CN-1', icv: 3, issueAt: ISSUE_AT, seller: egs, billingRef: 'INV-1' });
      expect(t(x, 'cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID')).toBe('INV-1');
      expect(t(x, 'cac:PaymentMeans/cbc:InstructionNote')).not.toBe('');
      expect(t(x, 'cbc:InvoiceTypeCode')).toBe(kind);
    }
  });
});

describe('signInvoice', () => {
  for (const type of ['simplified', 'standard'] as const) {
    describe(type, () => {
      const unsigned = buildInvoice({ type, kind: '388', number: 'INV-9', icv: 9, issueAt: ISSUE_AT, seller: egs, uuid: UUID });
      const s = signInvoice(unsigned, egs);
      const r = root(s.xml);

      it('parses, and inserting the signature and QR keeps the invoice hash', () => {
        expect(s.uuid).toBe(UUID);
        expect(s.invoiceHash).toBe(invoiceHash(unsigned));
        expect(invoiceHash(s.xml)).toBe(s.invoiceHash);
        expect(s.xml).not.toBe(unsigned);
      });

      it('has the UBL signature structure and IDs', () => {
        const info = find(r, 'ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent/sig:UBLDocumentSignatures/sac:SignatureInformation')!;
        expect(info).not.toBeNull();
        expect(text(info, 'cbc:ID')).toBe('urn:oasis:names:specification:ubl:signature:1');
        expect(text(info, 'sbc:ReferencedSignatureID')).toBe('urn:oasis:names:specification:ubl:signature:Invoice');
        expect(t(s.xml, 'ext:UBLExtensions/ext:UBLExtension/ext:ExtensionURI')).toBe('urn:oasis:names:specification:ubl:dsig:enveloped:xades');
        expect(t(s.xml, 'cac:Signature/cbc:ID')).toBe('urn:oasis:names:specification:ubl:signature:Invoice');
        expect(t(s.xml, 'cac:Signature/cbc:SignatureMethod')).toBe('urn:oasis:names:specification:ubl:dsig:enveloped:xades');
        const refs = descendants(r, 'ds:Reference');
        expect(refs).toHaveLength(2);
        expect(descendants(refs[0], 'ds:XPath').map((x) => x.textContent)).toHaveLength(3);
        expect(text(refs[0], 'ds:DigestValue')).toBe(s.invoiceHash);
        expect(refs[1].getAttribute('URI')).toBe('#xadesSignedProperties');
      });

      it('signs the hash bytes with the certificate key', () => {
        const sv = descendants(r, 'ds:SignatureValue')[0].textContent!;
        expect(sv).toBe(s.signature);
        expect(ecdsaVerify(egs.certPem, Buffer.from(s.invoiceHash, 'base64'), sv)).toBe(true);
        expect(ecdsaVerify(egs.certPem, Buffer.from(sha256b64('x'), 'base64'), sv)).toBe(false);
        const cert = descendants(r, 'ds:X509Certificate')[0].textContent!;
        expect(cert).toBe(egs.certPem.replace(/-----[^-]+-----|\s/g, ''));
      });

      it('has a SignedProperties digest that recomputes, with the CertDigest quirk and issuer serial', () => {
        const sp = descendants(r, 'xades:SignedProperties')[0];
        expect(sp.getAttribute('Id')).toBe('xadesSignedProperties');
        const refs = descendants(r, 'ds:Reference');
        expect(text(refs[1], 'ds:DigestValue')).toBe(sha256hexb64(canonicalize(sp)));
        expect(descendants(sp, 'xades:SigningTime')[0].textContent).toBe('2026-11-20T09:30:15');
        expect(descendants(sp, 'ds:DigestValue')[0].textContent).toBe(certHash(egs.certPem));
        const serial = descendants(sp, 'ds:X509SerialNumber')[0].textContent!;
        expect(BigInt(serial).toString(16)).toBe(BigInt(`0x${certInfo(egs.certPem).serial}`).toString(16));
        expect(descendants(sp, 'ds:X509IssuerName')[0].textContent).toMatch(/^CN=.*C=SA$/);
      });

      it('has a QR whose tags equal the XML', () => {
        const qrRef = findAll(r, 'cac:AdditionalDocumentReference').find((x) => text(x, 'cbc:ID') === 'QR')!;
        const payload = text(qrRef, 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject')!;
        expect(payload).toBe(s.qr);
        const dec = decodeTlv(payload);
        if (!dec.ok) throw new Error(dec.error);
        const tags = new Map(dec.fields.map((f) => [f.tag, f]));
        expect([...tags.keys()]).toEqual(type === 'simplified' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 4, 5, 6, 7, 8]);
        expect(tags.get(1)!.text).toBe(t(s.xml, 'cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'));
        expect(tags.get(1)!.text).toBe(egs.sellerNameAr);
        expect(tags.get(2)!.text).toBe(egs.vat);
        expect(tags.get(3)!.text).toBe(`${t(s.xml, 'cbc:IssueDate')}T${t(s.xml, 'cbc:IssueTime')}`);
        expect(tags.get(4)!.text).toBe(t(s.xml, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount'));
        expect(tags.get(5)!.text).toBe(t(s.xml, 'cac:TaxTotal/cbc:TaxAmount'));
        expect(tags.get(6)!.text).toBe(s.invoiceHash);
        expect(tags.get(7)!.text).toBe(s.signature);
        const info = certInfo(egs.certPem);
        expect(tags.get(8)!.bytes.equals(info.spkiDer)).toBe(true);
        if (type === 'simplified') expect(tags.get(9)!.bytes.equals(info.signatureValue)).toBe(true);
      });

      it('keeps the UBL order: QR after PIH, cac:Signature before the seller', () => {
        const names = Array.from(r.childNodes).filter((n) => n.nodeType === 1).map((n) => (n as Element).tagName);
        expect(names[0]).toBe('ext:UBLExtensions');
        const i = names.indexOf('cac:Signature');
        expect(names[i + 1]).toBe('cac:AccountingSupplierParty');
        expect(names[i - 1]).toBe('cac:AdditionalDocumentReference');
      });
    });
  }
});

describe('sample', () => {
  const good = sample(base());

  it('is a valid signed sample with no expected codes', () => {
    expect(good.expect).toEqual([]);
    expect(good.uuid).toBe(UUID);
    expect(invoiceHash(good.xml)).toBe(good.invoiceHash);
    expect(t(good.xml, 'cbc:ID')).toBe('SME00007');
    expect(find(root(good.xml), 'cbc:InvoiceTypeCode')!.getAttribute('name')).toBe('0200000');
  });

  it('builds signed credit notes with a billing reference', () => {
    const cn = sample(base({ type: 'standard', kind: '381', billingRef: 'INV-5' }));
    expect(t(cn.xml, 'cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID')).toBe('INV-5');
    expect(invoiceHash(cn.xml)).toBe(cn.invoiceHash);
  });

  it('uses codes that exist in the rule catalog or the lint checks', () => {
    const lint = new Set(EINVOICE_LINT_CHECKS.map((c) => c.id as string));
    for (const name of BREAK_NAMES) {
      const { code, description } = BREAKS[name];
      expect(description.length).toBeGreaterThan(0);
      expect(!!ruleByCode(code) || lint.has(code), `${name} → ${code}`).toBe(true);
    }
  });

  it('rejects unknown breaks', () => {
    expect(() => sample(base({ break: ['nope' as BreakName] }))).toThrow(/unknown sample break/);
  });

  const broken = (b: BreakName) => sample(base({ break: [b] }));
  const amt = (xml: string, p: string) => t(xml, `cac:LegalMonetaryTotal/cbc:${p}`);
  const qrTags = (xml: string) => {
    const ref = findAll(root(xml), 'cac:AdditionalDocumentReference').find((x) => text(x, 'cbc:ID') === 'QR')!;
    const dec = decodeTlv(text(ref, 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject')!);
    if (!dec.ok) throw new Error(dec.error);
    return new Map(dec.fields.map((f) => [f.tag, f.text]));
  };
  const plus = (a: string, b: string) => add(d(a), d(b));

  it('maps every break to its code', () => {
    for (const b of BREAK_NAMES) expect(broken(b).expect).toEqual([BREAKS[b].code]);
    expect(sample(base({ break: ['icv-gap', 'wrong-uuid'] })).expect).toEqual(['einv.icv-gap', 'invalid-uuid']);
  });

  it('total-mismatch: TaxInclusive and Payable are off by 1.00, the rest is unchanged and the hash is valid', () => {
    const s = broken('total-mismatch');
    expect(eq(d(amt(s.xml, 'TaxInclusiveAmount')), plus(amt(good.xml, 'TaxInclusiveAmount'), '1'))).toBe(true);
    expect(eq(d(amt(s.xml, 'PayableAmount')), plus(amt(good.xml, 'PayableAmount'), '1'))).toBe(true);
    expect(amt(s.xml, 'TaxExclusiveAmount')).toBe(amt(good.xml, 'TaxExclusiveAmount'));
    expect(t(s.xml, 'cac:TaxTotal/cbc:TaxAmount')).toBe(t(good.xml, 'cac:TaxTotal/cbc:TaxAmount'));
    expect(qrTags(s.xml).get(4)).toBe(amt(s.xml, 'TaxInclusiveAmount'));
    expect(invoiceHash(s.xml)).toBe(s.invoiceHash);
  });

  it('line-vat: the first line TaxAmount and RoundingAmount are off by 0.01', () => {
    const s = broken('line-vat');
    const l = (xml: string, p: string) => text(findAll(root(xml), 'cac:InvoiceLine')[0], `cac:TaxTotal/cbc:${p}`)!;
    expect(eq(d(l(s.xml, 'TaxAmount')), plus(l(good.xml, 'TaxAmount'), '0.01'))).toBe(true);
    expect(eq(d(l(s.xml, 'RoundingAmount')), plus(l(good.xml, 'RoundingAmount'), '0.01'))).toBe(true);
    expect(text(findAll(root(s.xml), 'cac:InvoiceLine')[1], 'cac:TaxTotal/cbc:TaxAmount')).toBe(
      text(findAll(root(good.xml), 'cac:InvoiceLine')[1], 'cac:TaxTotal/cbc:TaxAmount'),
    );
    expect(amt(s.xml, 'TaxInclusiveAmount')).toBe(amt(good.xml, 'TaxInclusiveAmount'));
  });

  const pihOf = (xml: string) =>
    text(findAll(root(xml), 'cac:AdditionalDocumentReference').find((x) => text(x, 'cbc:ID') === 'PIH')!, 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject');
  const icvOf = (xml: string) => text(findAll(root(xml), 'cac:AdditionalDocumentReference').find((x) => text(x, 'cbc:ID') === 'ICV')!, 'cbc:UUID');

  it('pih-wrong / first-pih-raw / icv-gap change only the chain fields', () => {
    expect(pihOf(good.xml)).toBe(FIRST_PIH);
    const w = broken('pih-wrong');
    expect(pihOf(w.xml)).not.toBe(FIRST_PIH);
    expect(pihOf(w.xml)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(pihOf(broken('first-pih-raw').xml)).toBe(sha256b64('0'));
    const g = broken('icv-gap');
    expect(icvOf(g.xml)).toBe('8');
    expect(icvOf(good.xml)).toBe('7');
    for (const s of [w, g]) expect(invoiceHash(s.xml)).toBe(s.invoiceHash);
  });

  it('tamper-after-sign: the XML changed after signing, so the signature no longer verifies', () => {
    const s = broken('tamper-after-sign');
    expect(t(s.xml, 'cac:InvoiceLine/cac:Item/cbc:Name')).toMatch(/\(edited\)$/);
    expect(invoiceHash(s.xml)).toBe(s.invoiceHash);
    const r = root(s.xml);
    const signedDigest = text(descendants(r, 'ds:Reference')[0], 'ds:DigestValue');
    expect(signedDigest).not.toBe(s.invoiceHash);
    const sv = descendants(r, 'ds:SignatureValue')[0].textContent!;
    expect(ecdsaVerify(egs.certPem, Buffer.from(s.invoiceHash, 'base64'), sv)).toBe(false);
    expect(ecdsaVerify(egs.certPem, Buffer.from(signedDigest!, 'base64'), sv)).toBe(true);
  });

  it('qr-total: only QR tag 4 is off', () => {
    const s = broken('qr-total');
    const tags = qrTags(s.xml);
    expect(eq(d(tags.get(4)!), plus(amt(s.xml, 'TaxInclusiveAmount'), '1'))).toBe(true);
    expect(amt(s.xml, 'TaxInclusiveAmount')).toBe(amt(good.xml, 'TaxInclusiveAmount'));
    expect(tags.get(6)).toBe(s.invoiceHash);
    expect(invoiceHash(s.xml)).toBe(s.invoiceHash);
  });

  it('no-signature: no UBLExtensions or cac:Signature, the QR stays, the hash is unchanged', () => {
    const s = broken('no-signature');
    const r = root(s.xml);
    expect(find(r, 'ext:UBLExtensions')).toBeNull();
    expect(find(r, 'cac:Signature')).toBeNull();
    expect(qrTags(s.xml).get(6)).toBe(s.invoiceHash);
    expect(invoiceHash(s.xml)).toBe(s.invoiceHash);
    expect(s.invoiceHash).toBe(good.invoiceHash);
  });

  it('vat-14-digits / building-3-digits / postal-4-digits change the seller fields', () => {
    const seller = (xml: string, p: string) => t(xml, `cac:AccountingSupplierParty/cac:Party/${p}`);
    const v = broken('vat-14-digits');
    expect(seller(v.xml, 'cac:PartyTaxScheme/cbc:CompanyID')).toMatch(/^3\d{12}3$/);
    expect(qrTags(v.xml).get(2)).toBe(seller(v.xml, 'cac:PartyTaxScheme/cbc:CompanyID'));
    expect(seller(broken('building-3-digits').xml, 'cac:PostalAddress/cbc:BuildingNumber')).toMatch(/^\d{3}$/);
    expect(seller(broken('postal-4-digits').xml, 'cac:PostalAddress/cbc:PostalZone')).toMatch(/^\d{4}$/);
    expect(seller(good.xml, 'cac:PostalAddress/cbc:BuildingNumber')).toBe(egs.address.building);
  });

  it('minified-hash: the returned hash is the minified variant, the XML is the same invoice', () => {
    const s = broken('minified-hash');
    expect(s.invoiceHash).not.toBe(invoiceHash(s.xml));
    expect(s.invoiceHash).toBe(hashVariants(s.xml).find((x) => x.variant === 'minified')!.hash);
    expect(invoiceHash(s.xml)).toBe(good.invoiceHash);
  });

  it('wrong-uuid: the returned uuid differs from the XML UUID only', () => {
    const s = broken('wrong-uuid');
    expect(s.uuid).not.toBe(UUID);
    expect(t(s.xml, 'cbc:UUID')).toBe(UUID);
    expect(s.invoiceHash).toBe(good.invoiceHash);
  });
});

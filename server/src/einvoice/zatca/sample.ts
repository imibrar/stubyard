import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import { canonicalize, escapeAttr, escapeText } from './c14n.js';
import { buildCsr } from './csr.js';
import { add, div, fmt2, mul, parse, places, round, sub, toString, type Dec } from './dec.js';
import { FIRST_PIH, hashVariants, invoiceHash, sha256b64, sha256hexb64 } from './hash.js';
import { certHash, certInfo, createCa, ecdsaSign, issueCert, type Ca, type ZatcaTemplate } from './pki.js';
import { buildQr } from './qr.js';
import { NS, descendants, find, parseXml, text } from './xml.js';

/**
 * Sample ZATCA invoices: a demo EGS unit (key + CSID certificate from a fake CA), a UBL 2.1 invoice builder, the XAdES
 * signer with the QR, and "broken" variants that each map to the code the validator should report.
 *
 * Signing never changes the invoice hash: the signature parts and the QR are inserted right after the previous element
 * (before the whitespace that leads to the next one), so removing them, as the hash transforms do, gives back the
 * unsigned document byte for byte.
 */

// --- the demo EGS unit ---

export interface SaudiAddress {
  street: string;
  /** 4 digits (BR-KSA-37). */
  building: string;
  /** 5 digits (BR-KSA-66). */
  postal: string;
  district: string;
  city: string;
  country: string;
}

export interface Seller {
  /** 15 digits, starting and ending with 3. */
  vat: string;
  /** Commercial registration number (PartyIdentification schemeID CRN). */
  crn: string;
  sellerName: string;
  address: SaudiAddress;
}

export interface Buyer {
  name: string;
  vat?: string;
  address: SaudiAddress;
}

export interface Signer {
  /** PKCS#8 PEM. */
  privateKey: string;
  certPem: string;
}

export interface Egs extends Seller, Signer {
  sellerNameAr: string;
  sellerNameEn: string;
  /** "1-Manufacturer|2-Model|3-Serial" */
  egsSerial: string;
  csrPem: string;
  /** The CA that issued `certPem`. */
  ca: Ca;
}

const DEMO = {
  vat: '399999999900003',
  crn: '1010010000',
  sellerNameAr: 'شركة ستبيارد التجريبية للتوريد',
  sellerNameEn: 'Stubyard Demo Supply Co.',
  egsSerial: '1-stubyard|2-demo|3-0001',
  address: {
    street: 'King Fahd Road',
    building: '1234',
    postal: '12345',
    district: 'Al Olaya',
    city: 'Riyadh',
    country: 'SA',
  },
};

export const DEMO_BUYER: Buyer = {
  name: 'Demo Buyer Trading Est.',
  vat: '311111111111113',
  address: { street: 'Prince Sultan Street', building: '4321', postal: '23456', district: 'Al Rawdah', city: 'Jeddah', country: 'SA' },
};

/** A new demo EGS unit: secp256k1 key, CSR, and a CSID certificate issued by `ca` (a new CA when omitted). */
export function demoEgs(ca?: Ca, opts: { lang?: 'ar' | 'en'; template?: ZatcaTemplate | string } = {}): Egs {
  const issuer = ca ?? createCa();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const csrPem = buildCsr({
    privateKey,
    commonName: 'EGS1-stubyard-demo',
    vatNumber: DEMO.vat,
    egsSerial: DEMO.egsSerial,
    orgUnit: 'Riyadh Branch',
    org: DEMO.sellerNameEn,
    invoiceTypes: '1100',
    address: 'RRRD2929',
    industry: 'Supply activities',
    template: opts.template ?? 'TSTZATCA-Code-Signing',
  });
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    certPem: issueCert(issuer, csrPem),
    csrPem,
    ca: issuer,
    vat: DEMO.vat,
    crn: DEMO.crn,
    sellerName: opts.lang === 'en' ? DEMO.sellerNameEn : DEMO.sellerNameAr,
    sellerNameAr: DEMO.sellerNameAr,
    sellerNameEn: DEMO.sellerNameEn,
    egsSerial: DEMO.egsSerial,
    address: { ...DEMO.address },
  };
}

// --- a tiny pretty-printing XML builder ---

type X = [name: string, attrs: Record<string, string> | null, content: string | (X | null | false)[]];

const el = (name: string, content: X[2], attrs: Record<string, string> | null = null): X => [name, attrs, content];

const INDENT = '    ';

function render([name, attrs, content]: X, depth: number): string {
  const pad = INDENT.repeat(depth);
  const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('') : '';
  if (typeof content === 'string') return `${pad}<${name}${a}>${escapeText(content)}</${name}>`;
  const kids = content.filter((c): c is X => !!c);
  if (!kids.length) return `${pad}<${name}${a}/>`;
  return `${pad}<${name}${a}>\n${kids.map((c) => render(c, depth + 1)).join('\n')}\n${pad}</${name}>`;
}

/** A block for insertion right after a sibling: indented for depth 1, without its leading whitespace. */
const inline = (x: X): string => render(x, 1).trimStart();

// --- the invoice ---

export type InvoiceType = 'standard' | 'simplified';
export type InvoiceKind = '388' | '381' | '383';

export interface LineInput {
  name: string;
  quantity: string | number;
  /** Net price per unit, VAT exclusive. */
  price: string | number;
  /** Category S rate; default 15. */
  vatPercent?: string | number;
  unitCode?: string;
}

export interface BuildOptions {
  type: InvoiceType;
  kind: InvoiceKind;
  /** cbc:ID */
  number: string;
  uuid?: string;
  icv: number | string;
  /** Default FIRST_PIH. */
  pih?: string;
  /** Default now. Issue date and time are taken in UTC. */
  issueAt?: Date | string;
  seller: Seller;
  /** Default DEMO_BUYER; null leaves it out (simplified invoices only). */
  buyer?: Buyer | null;
  lines?: LineInput[];
  /** Document level allowance (VAT exclusive), in the rate of the first line. */
  allowance?: string | number;
  /** Credit / debit notes: the original invoice number (BillingReference). */
  billingRef?: string;
  /** Credit / debit notes: the reason (PaymentMeans/InstructionNote). */
  reason?: string;
}

export const DEMO_LINES: LineInput[] = [
  { name: 'Arabic coffee 250g', quantity: 2, price: '18.50' },
  { name: 'Dates box 1kg', quantity: 1, price: '45.25' },
];

const SAR = { currencyID: 'SAR' };
const HUNDRED = parse(100);

export interface Totals {
  lines: { net: Dec; vat: Dec; rounding: Dec; percent: Dec }[];
  lineExtension: Dec;
  allowance: Dec;
  taxExclusive: Dec;
  categories: { percent: Dec; taxable: Dec; tax: Dec }[];
  tax: Dec;
  taxInclusive: Dec;
  payable: Dec;
}

/**
 * Line net = round2(price / base quantity (1) × quantity); line VAT = round2(net × rate / 100). Category VAT is
 * rounded once at document level over the category's taxable amount, not summed from the rounded line VATs.
 */
export function computeTotals(lines: LineInput[], allowanceIn: string | number = 0): Totals {
  const out = lines.map((l) => {
    const percent = parse(l.vatPercent ?? 15);
    const net = round(mul(parse(l.price), parse(l.quantity)), 2);
    const vat = round(div(mul(net, percent), HUNDRED), 2);
    return { net, vat, rounding: add(net, vat), percent };
  });
  const allowance = round(parse(allowanceIn), 2);
  const lineExtension = out.reduce((s, l) => add(s, l.net), 0n);
  const taxExclusive = sub(lineExtension, allowance);
  const byRate = new Map<Dec, Dec>();
  for (const l of out) byRate.set(l.percent, add(byRate.get(l.percent) ?? 0n, l.net));
  const firstRate = out[0]?.percent ?? parse(15);
  byRate.set(firstRate, sub(byRate.get(firstRate) ?? 0n, allowance));
  const categories = [...byRate].map(([percent, taxable]) => ({ percent, taxable, tax: round(div(mul(taxable, percent), HUNDRED), 2) }));
  const tax = categories.reduce((s, c) => add(s, c.tax), 0n);
  const taxInclusive = add(taxExclusive, tax);
  return { lines: out, lineExtension, allowance, taxExclusive, categories, tax, taxInclusive, payable: taxInclusive };
}

function utc(issueAt: Date | string | undefined): { date: string; time: string } {
  const d = issueAt === undefined ? new Date() : new Date(issueAt);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid issueAt: ${String(issueAt)}`);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

const qty = (d: Dec): string => toString(d, places(d));
const price = (d: Dec): string => toString(d, Math.max(2, places(d)));

function taxCategory(name: string, percent: Dec): X {
  return el(name, [
    el('cbc:ID', 'S', { schemeID: 'UN/ECE 5305', schemeAgencyID: '6' }),
    el('cbc:Percent', fmt2(percent)),
    el('cac:TaxScheme', [el('cbc:ID', 'VAT', { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' })]),
  ]);
}

function address(a: SaudiAddress): X {
  return el('cac:PostalAddress', [
    el('cbc:StreetName', a.street),
    el('cbc:BuildingNumber', a.building),
    el('cbc:CitySubdivisionName', a.district),
    el('cbc:CityName', a.city),
    el('cbc:PostalZone', a.postal),
    el('cac:Country', [el('cbc:IdentificationCode', a.country)]),
  ]);
}

const vatScheme = (vat: string): X =>
  el('cac:PartyTaxScheme', [el('cbc:CompanyID', vat), el('cac:TaxScheme', [el('cbc:ID', 'VAT')])]);

/** An unsigned UBL 2.1 invoice (no UBLExtensions, cac:Signature or QR), pretty-printed with 4-space indents. */
export function buildInvoice(o: BuildOptions): string {
  const { date, time } = utc(o.issueAt);
  const lines = o.lines?.length ? o.lines : DEMO_LINES;
  const t = computeTotals(lines, o.allowance ?? 0);
  const note = o.kind !== '388';
  const buyer = o.buyer === undefined ? DEMO_BUYER : o.buyer;
  if (!buyer && o.type === 'standard') throw new Error('a standard invoice needs a buyer');
  const firstRate = t.lines[0].percent;

  const root = el(
    'Invoice',
    [
      el('cbc:ProfileID', 'reporting:1.0'),
      el('cbc:ID', o.number),
      el('cbc:UUID', o.uuid ?? randomUUID()),
      el('cbc:IssueDate', date),
      el('cbc:IssueTime', time),
      el('cbc:InvoiceTypeCode', o.kind, { name: o.type === 'standard' ? '0100000' : '0200000' }),
      el('cbc:DocumentCurrencyCode', 'SAR'),
      el('cbc:TaxCurrencyCode', 'SAR'),
      note && el('cac:BillingReference', [el('cac:InvoiceDocumentReference', [el('cbc:ID', o.billingRef ?? 'INV-0001')])]),
      el('cac:AdditionalDocumentReference', [el('cbc:ID', 'ICV'), el('cbc:UUID', String(o.icv))]),
      el('cac:AdditionalDocumentReference', [
        el('cbc:ID', 'PIH'),
        el('cac:Attachment', [el('cbc:EmbeddedDocumentBinaryObject', o.pih ?? FIRST_PIH, { mimeCode: 'text/plain' })]),
      ]),
      el('cac:AccountingSupplierParty', [
        el('cac:Party', [
          el('cac:PartyIdentification', [el('cbc:ID', o.seller.crn, { schemeID: 'CRN' })]),
          address(o.seller.address),
          vatScheme(o.seller.vat),
          el('cac:PartyLegalEntity', [el('cbc:RegistrationName', o.seller.sellerName)]),
        ]),
      ]),
      buyer &&
        el('cac:AccountingCustomerParty', [
          el('cac:Party', [
            address(buyer.address),
            buyer.vat ? vatScheme(buyer.vat) : null,
            el('cac:PartyLegalEntity', [el('cbc:RegistrationName', buyer.name)]),
          ]),
        ]),
      o.type === 'standard' && el('cac:Delivery', [el('cbc:ActualDeliveryDate', date)]),
      el('cac:PaymentMeans', [
        el('cbc:PaymentMeansCode', '10'),
        note && el('cbc:InstructionNote', o.reason ?? (o.kind === '381' ? 'Returned goods' : 'Price adjustment')),
      ]),
      t.allowance !== 0n &&
        el('cac:AllowanceCharge', [
          el('cbc:ChargeIndicator', 'false'),
          el('cbc:AllowanceChargeReason', 'discount'),
          el('cbc:Amount', fmt2(t.allowance), SAR),
          taxCategory('cac:TaxCategory', firstRate),
        ]),
      el('cac:TaxTotal', [el('cbc:TaxAmount', fmt2(t.tax), SAR)]),
      el('cac:TaxTotal', [
        el('cbc:TaxAmount', fmt2(t.tax), SAR),
        ...t.categories.map((c) =>
          el('cac:TaxSubtotal', [
            el('cbc:TaxableAmount', fmt2(c.taxable), SAR),
            el('cbc:TaxAmount', fmt2(c.tax), SAR),
            taxCategory('cac:TaxCategory', c.percent),
          ]),
        ),
      ]),
      el('cac:LegalMonetaryTotal', [
        el('cbc:LineExtensionAmount', fmt2(t.lineExtension), SAR),
        el('cbc:TaxExclusiveAmount', fmt2(t.taxExclusive), SAR),
        el('cbc:TaxInclusiveAmount', fmt2(t.taxInclusive), SAR),
        el('cbc:AllowanceTotalAmount', fmt2(t.allowance), SAR),
        el('cbc:PayableAmount', fmt2(t.payable), SAR),
      ]),
      ...lines.map((l, i) =>
        el('cac:InvoiceLine', [
          el('cbc:ID', String(i + 1)),
          el('cbc:InvoicedQuantity', qty(parse(l.quantity)), { unitCode: l.unitCode ?? 'PCE' }),
          el('cbc:LineExtensionAmount', fmt2(t.lines[i].net), SAR),
          el('cac:TaxTotal', [
            el('cbc:TaxAmount', fmt2(t.lines[i].vat), SAR),
            el('cbc:RoundingAmount', fmt2(t.lines[i].rounding), SAR),
          ]),
          el('cac:Item', [el('cbc:Name', l.name), taxCategory('cac:ClassifiedTaxCategory', t.lines[i].percent)]),
          el('cac:Price', [el('cbc:PriceAmount', price(parse(l.price)), SAR)]),
        ]),
      ),
    ],
    { xmlns: NS.inv, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext },
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, 0)}\n`;
}

// --- signing ---

const SIG_ID = 'urn:oasis:names:specification:ubl:signature:Invoice';
const SIG_INFO_ID = 'urn:oasis:names:specification:ubl:signature:1';
const SIG_METHOD = 'urn:oasis:names:specification:ubl:dsig:enveloped:xades';
const C14N11 = 'http://www.w3.org/2006/12/xml-c14n11';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const XPATH = 'http://www.w3.org/TR/1999/REC-xpath-19991116';
const HASH_XPATHS = [
  'not(//ancestor-or-self::ext:UBLExtensions)',
  'not(//ancestor-or-self::cac:Signature)',
  "not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])",
];
const SP_DIGEST_SLOT = '@@signed-properties-digest@@';

export interface Signed {
  xml: string;
  invoiceHash: string;
  uuid: string;
  /** The base64 TLV QR payload. */
  qr: string;
  /** ds:SignatureValue: base64 DER ECDSA-SHA256 over the invoice hash bytes. */
  signature: string;
}

interface SignTweaks {
  omitSignature?: boolean;
  qrTotal?: string;
}

/** "C=SA\nO=x\nCN=y" (node:crypto) → "CN=y, O=x, C=SA" (RFC 2253 order). */
const rfc2253 = (dn: string): string => dn.split('\n').filter(Boolean).reverse().join(', ');

function insertBefore(xml: string, tag: string, block: string): string {
  let i = xml.indexOf(`<${tag}`);
  if (i < 0) throw new Error(`no <${tag}> to insert before`);
  while (i > 0 && /\s/.test(xml[i - 1])) i--;
  return xml.slice(0, i) + block + xml.slice(i);
}

function signatureBlock(hash: string, signature: string, signer: Signer, signingTime: string): X {
  const info = certInfo(signer.certPem);
  const certB64 = signer.certPem.replace(/-----[^-]+-----|\s/g, '');
  return el('ext:UBLExtensions', [
    el('ext:UBLExtension', [
      el('ext:ExtensionURI', SIG_METHOD),
      el('ext:ExtensionContent', [
        el(
          'sig:UBLDocumentSignatures',
          [
            el('sac:SignatureInformation', [
              el('cbc:ID', SIG_INFO_ID),
              el('sbc:ReferencedSignatureID', SIG_ID),
              el(
                'ds:Signature',
                [
                  el('ds:SignedInfo', [
                    el('ds:CanonicalizationMethod', [], { Algorithm: C14N11 }),
                    el('ds:SignatureMethod', [], { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' }),
                    el(
                      'ds:Reference',
                      [
                        el('ds:Transforms', [
                          ...HASH_XPATHS.map((x) => el('ds:Transform', [el('ds:XPath', x)], { Algorithm: XPATH })),
                          el('ds:Transform', [], { Algorithm: C14N11 }),
                        ]),
                        el('ds:DigestMethod', [], { Algorithm: SHA256 }),
                        el('ds:DigestValue', hash),
                      ],
                      { Id: 'invoiceSignedData', URI: '' },
                    ),
                    el(
                      'ds:Reference',
                      [el('ds:DigestMethod', [], { Algorithm: SHA256 }), el('ds:DigestValue', SP_DIGEST_SLOT)],
                      { Type: 'http://uri.etsi.org/01903#SignedProperties', URI: '#xadesSignedProperties' },
                    ),
                  ]),
                  el('ds:SignatureValue', signature),
                  el('ds:KeyInfo', [el('ds:X509Data', [el('ds:X509Certificate', certB64)])]),
                  el('ds:Object', [
                    el(
                      'xades:QualifyingProperties',
                      [
                        el(
                          'xades:SignedProperties',
                          [
                            el('xades:SignedSignatureProperties', [
                              el('xades:SigningTime', signingTime),
                              el('xades:SigningCertificate', [
                                el('xades:Cert', [
                                  el('xades:CertDigest', [
                                    el('ds:DigestMethod', [], { Algorithm: SHA256 }),
                                    el('ds:DigestValue', certHash(signer.certPem)),
                                  ]),
                                  el('xades:IssuerSerial', [
                                    el('ds:X509IssuerName', rfc2253(info.issuer)),
                                    el('ds:X509SerialNumber', BigInt(`0x${info.serial}`).toString()),
                                  ]),
                                ]),
                              ]),
                            ]),
                          ],
                          { Id: 'xadesSignedProperties' },
                        ),
                      ],
                      { 'xmlns:xades': NS.xades, Target: 'signature' },
                    ),
                  ]),
                ],
                { 'xmlns:ds': NS.ds, Id: 'signature' },
              ),
            ]),
          ],
          { 'xmlns:sig': NS.sig, 'xmlns:sac': NS.sac, 'xmlns:sbc': NS.sbc },
        ),
      ]),
    ]),
  ]);
}

function need(root: Element, path: string): string {
  const v = text(root, path);
  if (v === null) throw new Error(`invoice has no ${path}`);
  return v.trim();
}

function sign(xml: string, signer: Signer, tweaks: SignTweaks = {}): Signed {
  const root = parseXml(xml).documentElement!;
  const uuid = need(root, 'cbc:UUID');
  const date = need(root, 'cbc:IssueDate');
  const time = need(root, 'cbc:IssueTime');
  const simplified = find(root, 'cbc:InvoiceTypeCode')?.getAttribute('name')?.startsWith('02') ?? false;
  const hash = invoiceHash(xml);
  const signature = ecdsaSign(signer.privateKey, Buffer.from(hash, 'base64'));
  const info = certInfo(signer.certPem);

  const qr = buildQr({
    sellerName: need(root, 'cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'),
    vatNumber: need(root, 'cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID'),
    timestamp: `${date}T${time}`,
    total: tweaks.qrTotal ?? need(root, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount'),
    vatTotal: need(root, 'cac:TaxTotal/cbc:TaxAmount'),
    hash,
    signature,
    publicKey: info.spkiDer,
    ...(simplified ? { certSignature: info.signatureValue } : {}),
  });
  const qrRef = el('cac:AdditionalDocumentReference', [
    el('cbc:ID', 'QR'),
    el('cac:Attachment', [el('cbc:EmbeddedDocumentBinaryObject', qr, { mimeCode: 'text/plain' })]),
  ]);
  const sigRef = el('cac:Signature', [el('cbc:ID', SIG_ID), el('cbc:SignatureMethod', SIG_METHOD)]);

  // No whitespace between the inserted siblings: any text left between them would survive the hash transforms.
  let out = insertBefore(xml, 'cac:AccountingSupplierParty', inline(qrRef) + (tweaks.omitSignature ? '' : inline(sigRef)));
  if (!tweaks.omitSignature) {
    out = insertBefore(out, 'cbc:ProfileID', inline(signatureBlock(hash, signature, signer, `${date}T${time}`)));
    const sp = descendants(parseXml(out), 'xades:SignedProperties')[0];
    out = out.replace(SP_DIGEST_SLOT, sha256hexb64(canonicalize(sp)));
  }
  return { xml: out, invoiceHash: hash, uuid, qr, signature };
}

/**
 * Sign an invoice from buildInvoice(): ECDSA over the invoice hash bytes (as the SDKs do), XAdES SignedProperties
 * (digest = base64(hex(sha256(c14n)))), cac:Signature and the QR (tags 1-8, plus 9 for simplified invoices).
 */
export function signInvoice(xml: string, signer: Signer): Signed {
  return sign(xml, signer);
}

// --- samples and broken variants ---

export const BREAKS = {
  'total-mismatch': { code: 'BR-CO-15', description: 'TaxInclusiveAmount and PayableAmount are 1.00 more than TaxExclusiveAmount + VAT (the QR follows the XML).' },
  'line-vat': { code: 'BR-KSA-51', description: 'The first line TaxAmount (and its RoundingAmount) is 0.01 more than net × rate.' },
  'pih-wrong': { code: 'einv.pih-mismatch', description: 'The PIH is not the hash of the previous invoice.' },
  'icv-gap': { code: 'einv.icv-gap', description: 'The ICV skips one value (icv + 1).' },
  'tamper-after-sign': { code: 'invalid-signature', description: 'An item name is edited after signing; invoiceHash is recomputed, so the signature (and QR tag 6) no longer match.' },
  'qr-total': { code: 'QRCODE_INVALID', description: 'QR tag 4 (total with VAT) is 1.00 more than TaxInclusiveAmount.' },
  'no-signature': { code: 'BR-KSA-60', description: 'No ext:UBLExtensions and no cac:Signature (the QR stays).' },
  'vat-14-digits': { code: 'BR-KSA-39', description: 'The seller VAT number has 14 digits.' },
  'building-3-digits': { code: 'BR-KSA-37', description: 'The seller building number has 3 digits.' },
  'postal-4-digits': { code: 'BR-KSA-66', description: 'The seller postal code has 4 digits.' },
  'first-pih-raw': { code: 'einv.first-pih-variant', description: 'The PIH is base64 of the raw sha256("0") instead of the ZATCA first-PIH constant.' },
  'minified-hash': { code: 'invalid-invoice-hash', description: 'The returned invoiceHash is computed over the minified XML (lint names it with einv.hash-variant).' },
  'wrong-uuid': { code: 'invalid-uuid', description: 'The returned uuid is not the UUID in the XML.' },
} as const satisfies Record<string, { code: string; description: string }>;

export type BreakName = keyof typeof BREAKS;

export const BREAK_NAMES = Object.keys(BREAKS) as BreakName[];

export interface SampleOptions {
  type: InvoiceType;
  kind: InvoiceKind;
  icv: number | string;
  pih?: string;
  number: string;
  egs: Seller & Signer;
  issueAt?: Date | string;
  uuid?: string;
  buyer?: Buyer | null;
  lines?: LineInput[];
  allowance?: string | number;
  billingRef?: string;
  reason?: string;
  break?: BreakName[];
}

export interface Sample {
  xml: string;
  invoiceHash: string;
  uuid: string;
  /** The codes the validator should report for the requested breaks (empty for a valid sample). */
  expect: string[];
}

function bump(xml: string, re: RegExp, by: string): string {
  if (!re.test(xml)) throw new Error(`sample: pattern not found: ${re}`);
  return xml.replace(re, (_m, pre: string, v: string, post: string) => pre + fmt2(add(parse(v), parse(by))) + post);
}

/** A signed sample invoice, optionally broken in the named ways. */
export function sample(o: SampleOptions): Sample {
  const breaks = new Set(o.break ?? []);
  for (const b of breaks) if (!(b in BREAKS)) throw new Error(`unknown sample break: ${b}`);
  const has = (b: BreakName) => breaks.has(b);

  const seller: Seller = {
    vat: has('vat-14-digits') ? o.egs.vat.slice(0, -2) + o.egs.vat.slice(-1) : o.egs.vat,
    crn: o.egs.crn,
    sellerName: o.egs.sellerName,
    address: {
      ...o.egs.address,
      ...(has('building-3-digits') ? { building: o.egs.address.building.slice(0, 3) } : {}),
      ...(has('postal-4-digits') ? { postal: o.egs.address.postal.slice(0, 4) } : {}),
    },
  };
  let pih = o.pih ?? FIRST_PIH;
  if (has('pih-wrong')) pih = sha256b64(`not the previous invoice ${o.icv}`);
  if (has('first-pih-raw')) pih = sha256b64('0');

  let xml = buildInvoice({
    type: o.type,
    kind: o.kind,
    number: o.number,
    uuid: o.uuid,
    icv: has('icv-gap') ? Number(o.icv) + 1 : o.icv,
    pih,
    issueAt: o.issueAt,
    seller,
    buyer: o.buyer,
    lines: o.lines,
    allowance: o.allowance,
    billingRef: o.billingRef,
    reason: o.reason,
  });
  if (has('total-mismatch')) {
    xml = bump(xml, /(<cbc:TaxInclusiveAmount currencyID="SAR">)([^<]+)(<\/cbc:TaxInclusiveAmount>)/, '1');
    xml = bump(xml, /(<cbc:PayableAmount currencyID="SAR">)([^<]+)(<\/cbc:PayableAmount>)/, '1');
  }
  if (has('line-vat')) {
    xml = bump(xml, /(<cac:InvoiceLine>[\s\S]*?<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="SAR">)([^<]+)(<)/, '0.01');
    xml = bump(xml, /(<cac:InvoiceLine>[\s\S]*?<cbc:RoundingAmount currencyID="SAR">)([^<]+)(<)/, '0.01');
  }

  let qrTotal: string | undefined;
  if (has('qr-total')) {
    const total = text(parseXml(xml).documentElement!, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount')!;
    qrTotal = fmt2(add(parse(total), parse(1)));
  }
  const signed = sign(xml, o.egs, { omitSignature: has('no-signature'), qrTotal });
  let out = signed.xml;
  let hash = signed.invoiceHash;
  let uuid = signed.uuid;
  if (has('tamper-after-sign')) {
    out = out.replace(/(<cac:Item>\s*<cbc:Name>)([^<]*)(<)/, '$1$2 (edited)$3');
    hash = invoiceHash(out);
  }
  if (has('minified-hash')) hash = hashVariants(out).find((v) => v.variant === 'minified')!.hash;
  if (has('wrong-uuid')) uuid = randomUUID();

  return { xml: out, invoiceHash: hash, uuid, expect: [...new Set([...breaks].map((b) => BREAKS[b].code))] };
}

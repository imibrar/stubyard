import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { C14nCanonicalization, ExclusiveCanonicalization } from 'xml-crypto';
import { canonicalize } from '../src/einvoice/zatca/c14n.js';
import {
  FIRST_PIH,
  hashInput,
  hashVariants,
  invoiceHash,
  isFirstPihVariant,
  sha256b64,
  sha256hexb64,
} from '../src/einvoice/zatca/hash.js';
import { XmlParseError, attr, find, findAll, parseXml, text } from '../src/einvoice/zatca/xml.js';

/** C14N engine and ZATCA invoice hash (B6 S2), cross-checked against xml-crypto's canonicalizers. */

const pretty = readFileSync(new URL('./fixtures/zatca/simplified-pretty.xml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const minified = pretty.replace(/>\s+</g, '><');
const crlf = pretty.replace(/\n/g, '\r\n');

function reference(xml: string, exclusive = false): string {
  const root = parseXml(xml).documentElement as unknown as globalThis.Element;
  return (exclusive ? new ExclusiveCanonicalization() : new C14nCanonicalization()).process(root, {});
}

/** Cuts the elements out of the source text, leaving the whitespace around them, as the XPath filter does. */
function cutOut(xml: string): string {
  return xml
    .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, '')
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '')
    .replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, '');
}

const fragments: Record<string, string> = {
  'redeclared and undeclared namespaces': `<a:root xmlns:a="urn:a" xmlns="urn:d" xmlns:b="urn:b"><a:x xmlns:a="urn:a" xmlns:c="urn:c"><y xmlns=""><z xmlns="urn:d2" b:k="1"/></y><y/></a:x><b:w xmlns:b="urn:b2"/></a:root>`,
  'attribute ordering': `<r xmlns="urn:r" xmlns:z="urn:a" xmlns:a="urn:z" z:b="1" a:b="2" b="3" a="4" a:a="5"><e xmlns:m="urn:m" m:q="x" q="y"/></r>`,
  'escaping': `<r a="tab&#9;nl&#10;cr&#13;amp&amp;lt&lt;gt&gt;quot&quot;apos'">text &amp; &lt; &gt; "q" 'a' cr&#13;end<![CDATA[ <cdata> & ]]></r>`,
  'comments and PIs': `<r><!-- c --><?pi  data ?><?bare?><e>x<!--y-->z</e></r>`,
  'whitespace and empty elements': `<r>\n  <e/>\n\t<e></e>  <e a="1" />\n</r>`,
  'unused declarations in nested scopes': `<r xmlns:u="urn:unused"><x:s xmlns:x="urn:x"><x:t xmlns:x="urn:x" xmlns:u="urn:other"/></x:s></r>`,
};

describe('canonicalize (inclusive C14N 1.0)', () => {
  for (const [name, xml] of Object.entries({ pretty, minified, crlf })) {
    it(`matches xml-crypto on the ${name} invoice`, () => {
      expect(canonicalize(parseXml(xml))).toBe(reference(xml));
    });
  }

  for (const [name, xml] of Object.entries(fragments)) {
    it(`matches xml-crypto: ${name}`, () => {
      expect(canonicalize(parseXml(xml))).toBe(reference(xml));
    });
    it(`exclusive mode matches xml-crypto: ${name}`, () => {
      expect(canonicalize(parseXml(xml), { exclusive: true })).toBe(reference(xml, true));
    });
  }

  it('matches xml-crypto on the hash input after the transforms', () => {
    const input = hashInput(pretty);
    expect(input).toBe(reference(cutOut(pretty)));
  });

  it('renders a subtree with its ancestors’ namespaces', () => {
    const doc = parseXml(fragments['redeclared and undeclared namespaces']);
    const ax = doc.documentElement!.firstChild;
    expect(canonicalize(ax as never)).toBe(
      '<a:x xmlns="urn:d" xmlns:a="urn:a" xmlns:b="urn:b" xmlns:c="urn:c"><y xmlns=""><z xmlns="urn:d2" b:k="1"></z></y><y></y></a:x>',
    );
  });

  it('drops the XML declaration and comments, keeps whitespace, writes empty elements in full', () => {
    const out = canonicalize(parseXml(pretty));
    expect(out.startsWith('<Invoice xmlns=')).toBe(true);
    expect(out).not.toContain('<!--');
    expect(out).toContain('<cac:Party></cac:Party>');
    expect(out).toContain('<cbc:Name>Widget &lt;large&gt; &amp; "quoted"</cbc:Name>');
    expect(out).toContain('</cbc:InvoiceTypeCode>\n    \n    <cbc:DocumentCurrencyCode>');
  });
});

describe('invoiceHash', () => {
  const h = invoiceHash(pretty);

  it('is base64 SHA-256 of the transformed canonical form', () => {
    expect(h).toBe(sha256b64(reference(cutOut(pretty))));
    expect(Buffer.from(h, 'base64')).toHaveLength(32);
  });

  it('keeps the whitespace around the removed elements', () => {
    const input = hashInput(pretty);
    expect(input).not.toContain('UBLExtensions');
    expect(input).not.toContain('cac:Signature');
    expect(input).not.toContain('QR-PLACEHOLDER');
    expect(input).toContain('<cbc:ID>PIH</cbc:ID>');
    expect(input).toMatch(/^<Invoice [^>]*>\n {4}\n {4}<cbc:ProfileID>/);
    expect(input).toContain('</cac:AdditionalDocumentReference>\n    \n    \n    <cac:AccountingSupplierParty>');
  });

  it('ignores changes inside the removed elements', () => {
    expect(invoiceHash(pretty.replace('SIGNATURE-PLACEHOLDER', 'something else'))).toBe(h);
    expect(invoiceHash(pretty.replace('QR-PLACEHOLDER', 'AQZTZWxsZXI='))).toBe(h);
    expect(invoiceHash(pretty.replace('<cbc:SignatureMethod>', '<cbc:SignatureMethod>x'))).toBe(h);
  });

  it('changes when an amount, the PIH or the whitespace outside them changes', () => {
    expect(invoiceHash(pretty.replace('<cbc:PayableAmount currencyID="SAR">115.00', '<cbc:PayableAmount currencyID="SAR">115.01'))).not.toBe(h);
    expect(invoiceHash(pretty.replace('mimeCode="text/plain">NWZl', 'mimeCode="text/plain">MWZl'))).not.toBe(h);
    expect(invoiceHash(pretty.replace('<cbc:ProfileID>', ' <cbc:ProfileID>'))).not.toBe(h);
  });

  it('is the same for CRLF and LF line endings, and ignores the XML declaration and attribute quoting', () => {
    expect(invoiceHash(crlf)).toBe(h);
    expect(invoiceHash(pretty.replace(/^<\?xml[^>]*>\n/, ''))).toBe(invoiceHash(pretty.replace(/^<\?xml[^>]*>/, '')));
    expect(invoiceHash(pretty.replace('name="0200000"', "name='0200000'"))).toBe(h);
  });

  it('rejects a DOCTYPE and malformed XML with XmlParseError', () => {
    expect(() => invoiceHash('<!DOCTYPE r [<!ENTITY e "boom">]><r>&e;</r>')).toThrow(XmlParseError);
    expect(() => invoiceHash('<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>')).toThrow(XmlParseError);
    expect(() => invoiceHash('<r><a></r>')).toThrow(XmlParseError);
    expect(() => invoiceHash('not xml')).toThrow(XmlParseError);
  });
});

describe('first PIH and digest helpers', () => {
  it('FIRST_PIH is base64 of the hex text of sha256("0")', () => {
    const hex = createHash('sha256').update('0').digest('hex');
    expect(Buffer.from(hex, 'utf8').toString('base64')).toBe(FIRST_PIH);
    expect(sha256hexb64('0')).toBe(FIRST_PIH);
    expect(sha256b64('0')).toBe(createHash('sha256').update('0').digest('base64'));
  });

  it('isFirstPihVariant spots the raw-digest and bare-hex spellings only', () => {
    const hex = createHash('sha256').update('0').digest('hex');
    expect(isFirstPihVariant(sha256b64('0'))).toBe(true);
    expect(isFirstPihVariant(hex)).toBe(true);
    expect(isFirstPihVariant(hex.toUpperCase())).toBe(true);
    expect(isFirstPihVariant(FIRST_PIH)).toBe(false);
    expect(isFirstPihVariant(invoiceHash(pretty))).toBe(false);
  });
});

describe('hashVariants', () => {
  const variants = Object.fromEntries(hashVariants(pretty).map((v) => [v.variant, v.hash]));
  const h = invoiceHash(pretty);

  it('lists every variant, each different from the real hash on a pretty-printed invoice', () => {
    expect(Object.keys(variants).sort()).toEqual(['exclusive-c14n', 'hex-digest', 'minified', 'no-transforms', 'qr-kept']);
    for (const v of Object.values(variants)) expect(v).not.toBe(h);
    expect(new Set(Object.values(variants)).size).toBe(5);
  });

  it('each variant is what the corresponding mistake produces', () => {
    expect(variants.minified).toBe(invoiceHash(minified));
    expect(variants['no-transforms']).toBe(sha256b64(reference(pretty)));
    expect(variants['hex-digest']).toBe(sha256hexb64(hashInput(pretty)));
    expect(variants['exclusive-c14n']).toBe(sha256b64(reference(cutOut(pretty), true)));
    const qrKept = pretty
      .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, '')
      .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '');
    expect(variants['qr-kept']).toBe(sha256b64(reference(qrKept)));
  });
});

describe('xml getters', () => {
  const root = parseXml(pretty).documentElement!;

  it('reads text and attributes by namespaced path', () => {
    expect(text(root, 'cac:LegalMonetaryTotal/cbc:PayableAmount')).toBe('115.00');
    expect(text(root, 'cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID')).toBe('S');
    expect(text(root, 'cac:Missing/cbc:ID')).toBeNull();
    expect(attr(find(root, 'cbc:InvoiceTypeCode')!, 'name')).toBe('0200000');
    expect(attr(find(root, 'cbc:InvoiceTypeCode')!, 'nope')).toBeNull();
    expect(findAll(root, 'cac:AdditionalDocumentReference/cbc:ID').map((e) => e.textContent)).toEqual(['ICV', 'PIH', 'QR']);
  });
});

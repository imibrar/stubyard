import { describe, expect, it } from 'vitest';
import { ksaRules } from '../src/einvoice/zatca/rules/ksa.js';
import { ruleByCode } from '../src/einvoice/zatca/rules/catalog.js';
import { buildInvoice, demoEgs, sample, type BuildOptions, type BreakName, type SampleOptions } from '../src/einvoice/zatca/sample.js';
import { parseInvoice, type RuleContext } from '../src/einvoice/zatca/validate.js';

/** Phase 2 KSA / BR / F field rules (B6 S14). */

const egs = demoEgs();
const ISSUE_AT = '2026-11-20T09:30:15Z';
const NOW = Date.parse('2026-11-26T12:00:00Z');

function run(xml: string, nowMs = NOW) {
  const p = parseInvoice(xml);
  if (!p.ok) throw new Error(p.error);
  const ctx = {
    doc: p.doc,
    root: p.doc.documentElement!,
    xml: p.xml,
    extracted: p.extracted,
    input: { xml, config: { checks: 'full', chainCheck: 'off' }, nowMs },
  } as unknown as RuleContext;
  return ksaRules(ctx);
}

const codes = (xml: string, nowMs?: number) => [...new Set(run(xml, nowMs).map((f) => f.code))].sort();

const opts = (over: Partial<SampleOptions> = {}): SampleOptions => ({
  type: 'standard',
  kind: '388',
  icv: 1,
  number: 'INV-0001',
  egs,
  issueAt: ISSUE_AT,
  ...over,
});

const built = (over: Partial<BuildOptions> = {}): string =>
  buildInvoice({ type: 'standard', kind: '388', number: 'INV-0001', icv: 1, issueAt: ISSUE_AT, seller: egs, ...over });

/** Replace exactly one match in the XML (fails loudly when the pattern is gone). */
function edit(xml: string, from: string | RegExp, to: string): string {
  const hit = typeof from === 'string' ? xml.includes(from) : from.test(xml);
  if (!hit) throw new Error(`pattern not found: ${String(from)}`);
  return xml.replace(from, to);
}

describe('ksaRules: valid samples', () => {
  for (const type of ['standard', 'simplified'] as const) {
    for (const kind of ['388', '381', '383'] as const) {
      it(`a ${type} ${kind} sample has no findings`, () => {
        expect(run(sample(opts({ type, kind })).xml)).toEqual([]);
      });
    }
  }

  it('a simplified invoice without a buyer has no findings', () => {
    expect(run(sample(opts({ type: 'simplified', buyer: null })).xml)).toEqual([]);
  });

  it('every finding uses a catalog code', () => {
    const xml = edit(built(), '<cbc:BuildingNumber>1234</cbc:BuildingNumber>', '<cbc:BuildingNumber>12</cbc:BuildingNumber>');
    for (const f of run(xml)) expect(ruleByCode(f.code)).toBeDefined();
  });
});

describe('ksaRules: sample breaks', () => {
  const cases: [BreakName, string][] = [
    ['vat-14-digits', 'BR-KSA-39'],
    ['building-3-digits', 'BR-KSA-37'],
    ['postal-4-digits', 'BR-KSA-66'],
  ];
  for (const [b, code] of cases) {
    it(`${b} → ${code}`, () => {
      const s = sample(opts({ break: [b] }));
      expect(s.expect).toEqual([code]);
      expect(codes(s.xml)).toEqual([code]);
    });
  }
});

describe('ksaRules: header', () => {
  it('BR-KSA-03: UUID with other characters', () => {
    expect(codes(built({ uuid: 'abc_123' }))).toEqual(['BR-KSA-03']);
  });

  it('BR-KSA-04: issue date after today (Riyadh time)', () => {
    expect(codes(built({ issueAt: '2026-11-27T10:00:00Z' }))).toEqual(['BR-KSA-04']);
    // 22:00 UTC on the 26th is already the 27th in Riyadh.
    expect(codes(built({ issueAt: '2026-11-27T10:00:00Z' }), Date.parse('2026-11-26T22:00:00Z'))).toEqual([]);
  });

  it('BR-KSA-70: issue time format', () => {
    expect(codes(edit(built(), /<cbc:IssueTime>[^<]+</, '<cbc:IssueTime>9:30<'))).toEqual(['BR-KSA-70']);
    expect(codes(edit(built(), /<cbc:IssueTime>([^<]+)</, '<cbc:IssueTime>$1Z<'))).toEqual([]);
  });

  it('BR-KSA-05: type code', () => {
    expect(codes(edit(built(), '>388</cbc:InvoiceTypeCode>', '>380</cbc:InvoiceTypeCode>'))).toEqual(['BR-KSA-05']);
  });

  it('BR-KSA-06 / 07 / 31: type code name', () => {
    const named = (n: string) => edit(built(), 'name="0100000"', `name="${n}"`);
    expect(codes(named('0300000'))).toContain('BR-KSA-06');
    expect(codes(named('01000'))).toContain('BR-KSA-06');
    expect(codes(named('0102000'))).toEqual(['BR-KSA-07']);
    expect(codes(named('0100101'))).toEqual(['BR-KSA-07']);
    expect(codes(named('0100100'))).toEqual([]);
    const simple = (n: string) => edit(built({ type: 'simplified' }), 'name="0200000"', `name="${n}"`);
    expect(codes(simple('0200100'))).toEqual(['BR-KSA-31']);
    expect(codes(simple('0200001'))).toEqual(['BR-KSA-31']);
    expect(codes(simple('0211010'))).toEqual([]);
  });

  it('BR-KSA-68: tax currency SAR', () => {
    expect(codes(edit(built(), '<cbc:TaxCurrencyCode>SAR<', '<cbc:TaxCurrencyCode>USD<'))).toEqual(['BR-KSA-68']);
    expect(codes(edit(built(), /\s*<cbc:TaxCurrencyCode>SAR<\/cbc:TaxCurrencyCode>/, ''))).toEqual(['BR-KSA-68']);
  });
});

describe('ksaRules: BR presence', () => {
  it('BR-02 / 03 / 05 / 06', () => {
    expect(codes(edit(built(), '<cbc:ID>INV-0001</cbc:ID>', '<cbc:ID> </cbc:ID>'))).toContain('BR-02');
    expect(codes(edit(built(), /\s*<cbc:IssueDate>[^<]+<\/cbc:IssueDate>/, ''))).toContain('BR-03');
    expect(codes(edit(built(), /\s*<cbc:DocumentCurrencyCode>SAR<\/cbc:DocumentCurrencyCode>/, ''))).toEqual(['BR-05']);
    expect(codes(edit(built(), /(<cac:AccountingSupplierParty>[\s\S]*?)<cbc:RegistrationName>[^<]+<\/cbc:RegistrationName>/, '$1<cbc:RegistrationName/>'))).toEqual(['BR-06', 'BR-KSA-F-03']);
  });

  it('BR-04: no type code (and no name rules)', () => {
    expect(codes(edit(built(), /\s*<cbc:InvoiceTypeCode[^>]*>388<\/cbc:InvoiceTypeCode>/, ''))).toEqual(['BR-04']);
  });

  it('BR-08 / BR-09: seller address and country', () => {
    const xml = built();
    const noAddr = edit(xml, /(<cac:AccountingSupplierParty>[\s\S]*?)<cac:PostalAddress>[\s\S]*?<\/cac:PostalAddress>/, '$1');
    expect(codes(noAddr)).toEqual(['BR-08']);
    const noCountry = edit(xml, /(<cac:AccountingSupplierParty>[\s\S]*?)<cac:Country>[\s\S]*?<\/cac:Country>/, '$1');
    expect(codes(noCountry)).toEqual(['BR-09', 'BR-KSA-09']);
  });

  it('BR-10 / BR-KSA-10: standard buyer without an address', () => {
    const xml = edit(built(), /(<cac:AccountingCustomerParty>[\s\S]*?)<cac:PostalAddress>[\s\S]*?<\/cac:PostalAddress>/, '$1');
    expect(codes(xml)).toEqual(['BR-10', 'BR-KSA-10']);
  });

  it('BR-13 / 14 / 15: totals', () => {
    expect(codes(edit(built(), /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/, ''))).toEqual(['BR-13']);
    expect(codes(edit(built(), /<cbc:TaxExclusiveAmount[^>]*>[^<]+<\/cbc:TaxExclusiveAmount>/, ''))).toEqual(['BR-14']);
    expect(codes(edit(built(), /<cbc:TaxInclusiveAmount[^>]*>[^<]+<\/cbc:TaxInclusiveAmount>/, ''))).toEqual(['BR-15']);
  });

  it('BR-16: no lines', () => {
    expect(codes(edit(built(), /<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/, ''))).toEqual(['BR-16']);
  });

  it('BR-21 / 22 / 24 / 25: line fields', () => {
    const xml = built();
    expect(codes(edit(xml, '<cbc:ID>1</cbc:ID>', ''))).toEqual(['BR-21']);
    expect(codes(edit(xml, /<cbc:InvoicedQuantity[^>]*>[^<]+<\/cbc:InvoicedQuantity>/, ''))).toEqual(['BR-22']);
    expect(codes(edit(xml, /(<cac:InvoiceLine>[\s\S]*?)<cbc:LineExtensionAmount[^>]*>[^<]+<\/cbc:LineExtensionAmount>/, '$1'))).toEqual(['BR-24']);
    expect(codes(edit(xml, '<cbc:Name>Arabic coffee 250g</cbc:Name>', ''))).toEqual(['BR-25']);
  });

  it('BR-55: billing reference without a number', () => {
    const xml = edit(built({ kind: '381' }), /<cac:InvoiceDocumentReference>[\s\S]*?<\/cac:InvoiceDocumentReference>/, '<cac:InvoiceDocumentReference/>');
    expect(codes(xml)).toEqual(['BR-55']);
  });
});

describe('ksaRules: notes and supply date', () => {
  it('BR-KSA-56: credit / debit note without a billing reference', () => {
    for (const kind of ['381', '383'] as const) {
      const xml = edit(built({ kind }), /<cac:BillingReference>[\s\S]*?<\/cac:BillingReference>/, '');
      expect(codes(xml)).toEqual(['BR-KSA-56']);
    }
  });

  it('BR-KSA-17: credit / debit note without a reason', () => {
    for (const kind of ['381', '383'] as const) {
      const xml = edit(built({ kind }), /<cbc:InstructionNote>[^<]+<\/cbc:InstructionNote>/, '');
      expect(codes(xml)).toEqual(['BR-KSA-17']);
    }
  });

  it('BR-KSA-15: standard 388 without a supply date', () => {
    const strip = (xml: string) => edit(xml, /<cac:Delivery>[\s\S]*?<\/cac:Delivery>/, '');
    expect(codes(strip(built()))).toEqual(['BR-KSA-15']);
    expect(codes(strip(built({ kind: '381' })))).toEqual([]);
  });
});

describe('ksaRules: seller', () => {
  it('BR-KSA-40: VAT not starting and ending with 3', () => {
    expect(codes(built({ seller: { ...egs, vat: '199999999900003' } }))).toEqual(['BR-KSA-40']);
    expect(codes(built({ seller: { ...egs, vat: '399999999900001' } }))).toEqual(['BR-KSA-40']);
  });

  it('BR-KSA-39: VAT with letters', () => {
    expect(codes(built({ seller: { ...egs, vat: '39999999990000A' } }))).toEqual(['BR-KSA-39']);
  });

  it('BR-KSA-08: other ID scheme', () => {
    expect(codes(edit(built(), 'schemeID="CRN"', 'schemeID="XYZ"'))).toEqual(['BR-KSA-08']);
    expect(codes(edit(built(), 'schemeID="CRN"', 'schemeID="MLS"'))).toEqual([]);
    expect(codes(edit(built(), /<cac:PartyIdentification>[\s\S]*?<\/cac:PartyIdentification>/, ''))).toEqual(['BR-KSA-08']);
  });

  it('BR-KSA-09: each seller address field', () => {
    for (const field of ['StreetName', 'BuildingNumber', 'PostalZone', 'CityName', 'CitySubdivisionName']) {
      const xml = edit(built(), new RegExp(`(<cac:AccountingSupplierParty>[\\s\\S]*?)<cbc:${field}>[^<]+</cbc:${field}>`), '$1');
      expect(codes(xml), field).toEqual(['BR-KSA-09']);
    }
  });

  it('BR-KSA-37 / 66: letters count as not digits', () => {
    expect(codes(built({ seller: { ...egs, address: { ...egs.address, building: '12A4' } } }))).toEqual(['BR-KSA-37']);
    expect(codes(built({ seller: { ...egs, address: { ...egs.address, postal: '123456' } } }))).toEqual(['BR-KSA-66']);
  });
});

describe('ksaRules: buyer', () => {
  const buyer = { name: 'Buyer Co.', vat: '311111111111113', address: { street: 'S', building: '4321', postal: '23456', district: 'D', city: 'C', country: 'SA' } };

  it('BR-KSA-42: standard buyer without a name', () => {
    expect(codes(edit(built(), /<cbc:RegistrationName>Demo Buyer[^<]*<\/cbc:RegistrationName>/, ''))).toEqual(['BR-KSA-42']);
  });

  it('BR-KSA-44: buyer VAT format (standard and simplified)', () => {
    expect(codes(built({ buyer: { ...buyer, vat: '31111111111111' } }))).toEqual(['BR-KSA-44']);
    expect(codes(built({ type: 'simplified', buyer: { ...buyer, vat: '211111111111113' } }))).toEqual(['BR-KSA-44']);
  });

  it('BR-KSA-81: standard buyer without VAT needs another ID', () => {
    const noVat = built({ buyer: { ...buyer, vat: undefined } });
    expect(codes(noVat)).toEqual(['BR-KSA-81']);
    const withId = edit(noVat, /(<cac:AccountingCustomerParty>\s*<cac:Party>)/, '$1<cac:PartyIdentification><cbc:ID schemeID="NAT">1000000001</cbc:ID></cac:PartyIdentification>');
    expect(codes(withId)).toEqual([]);
    expect(codes(built({ type: 'simplified', buyer: { ...buyer, vat: undefined } }))).toEqual([]);
  });

  it('BR-KSA-63: Saudi buyer building and postal code', () => {
    expect(codes(built({ buyer: { ...buyer, address: { ...buyer.address, building: '432' } } }))).toEqual(['BR-KSA-63']);
    expect(codes(built({ buyer: { ...buyer, address: { ...buyer.address, postal: '2345' } } }))).toEqual(['BR-KSA-63']);
    expect(codes(built({ buyer: { ...buyer, address: { ...buyer.address, country: 'AE', postal: '2345' } } }))).toEqual([]);
  });

  it('BR-KSA-67: Saudi buyer address fields (standard only)', () => {
    for (const field of ['StreetName', 'CityName', 'CitySubdivisionName', 'PostalZone']) {
      const re = new RegExp(`(<cac:AccountingCustomerParty>[\\s\\S]*?)<cbc:${field}>[^<]+</cbc:${field}>`);
      expect(codes(edit(built(), re, '$1')), field).toEqual(['BR-KSA-67']);
      expect(codes(edit(built({ type: 'simplified' }), re, '$1')), field).toEqual([]);
    }
  });
});

describe('ksaRules: categories and decimals', () => {
  it('BR-KSA-18: VAT category code', () => {
    const xml = edit(built(), /(<cac:ClassifiedTaxCategory>\s*<cbc:ID[^>]*>)S</, '$1X<');
    expect(codes(xml)).toEqual(['BR-KSA-18']);
  });

  it('BR-DEC-*: amounts with more than 2 decimals', () => {
    const amt = (tag: string, code: string, re = new RegExp(`(<cbc:${tag} currencyID="SAR">)([^<]+)<`)) => {
      expect(codes(edit(built(), re, '$1$21<')), tag).toEqual([code]);
    };
    amt('TaxExclusiveAmount', 'BR-DEC-16');
    amt('TaxInclusiveAmount', 'BR-DEC-19');
    amt('AllowanceTotalAmount', 'BR-DEC-14');
    amt('PayableAmount', 'BR-KSA-DEC-01');
    amt('LineExtensionAmount', 'BR-DEC-09', /(<cac:LegalMonetaryTotal>\s*<cbc:LineExtensionAmount currencyID="SAR">)([^<]+)</);
    amt('LineExtensionAmount', 'BR-DEC-23', /(<cac:InvoiceLine>[\s\S]*?<cbc:LineExtensionAmount currencyID="SAR">)([^<]+)</);
    amt('TaxAmount', 'BR-DEC-18', /(<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="SAR">)([^<]+)</);
    amt('TaxAmount', 'BR-DEC-17', /(<\/cac:TaxTotal>\s*<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="SAR">)([^<]+)</);
  });

  it('BR-DEC-10: document allowance amount', () => {
    const xml = edit(built({ allowance: '1.00' }), /(<cac:AllowanceCharge>[\s\S]*?<cbc:Amount currencyID="SAR">)([^<]+)</, '$1$21<');
    expect(codes(xml)).toEqual(['BR-DEC-10']);
  });

  it('prices may have more decimals', () => {
    expect(codes(built({ lines: [{ name: 'Bolt', quantity: 3, price: '0.125' }] }))).toEqual([]);
  });

  it('BR-KSA-DEC-02: percent over 100', () => {
    expect(codes(edit(built(), /(<cac:ClassifiedTaxCategory>[\s\S]*?<cbc:Percent>)[^<]+</, '$1150.00<'))).toEqual(['BR-KSA-DEC-02']);
  });
});

describe('ksaRules: formats', () => {
  it('BR-KSA-F-01: dates', () => {
    expect(codes(edit(built(), /<cbc:ActualDeliveryDate>[^<]+</, '<cbc:ActualDeliveryDate>20/11/2026<'))).toEqual(['BR-KSA-F-01']);
    expect(codes(edit(built(), /<cbc:ActualDeliveryDate>[^<]+</, '<cbc:ActualDeliveryDate>2026-02-30<'))).toEqual(['BR-KSA-F-01']);
    expect(codes(edit(built(), /<cbc:IssueDate>[^<]+</, '<cbc:IssueDate>2026-11-20T00:00:00<'))).toEqual(['BR-KSA-F-01']);
  });

  it('BR-KSA-F-02: indicators', () => {
    const xml = edit(built({ allowance: '1.00' }), '<cbc:ChargeIndicator>false<', '<cbc:ChargeIndicator>no<');
    expect(codes(xml)).toEqual(['BR-KSA-F-02']);
  });

  it('BR-KSA-F-03: empty elements', () => {
    expect(codes(edit(built(), '<cbc:ProfileID>reporting:1.0</cbc:ProfileID>', '<cbc:ProfileID/>'))).toEqual(['BR-KSA-F-03']);
  });

  it('BR-KSA-F-04: negative amounts and quantities', () => {
    expect(codes(edit(built(), /(<cbc:InvoicedQuantity[^>]*>)([^<]+)</, '$1-$2<'))).toEqual(['BR-KSA-F-04']);
    expect(codes(edit(built(), /(<cbc:PriceAmount[^>]*>)([^<]+)</, '$1-$2<'))).toEqual(['BR-KSA-F-04']);
    expect(codes(edit(built(), /(<cbc:PriceAmount[^>]*>)([^<]+)</, '$1abc<'))).toEqual(['BR-KSA-F-04']);
  });

  it('BR-KSA-F-06: too long (a warning)', () => {
    const f = run(built({ lines: [{ name: 'x'.repeat(1001), quantity: 1, price: 1 }] }));
    expect(f.map((x) => [x.code, x.severity])).toEqual([['BR-KSA-F-06', 'warning']]);
  });
});

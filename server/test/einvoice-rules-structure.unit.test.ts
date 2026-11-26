import { describe, expect, it } from 'vitest';
import { ruleByCode } from '../src/einvoice/zatca/rules/catalog.js';
import { structureRules } from '../src/einvoice/zatca/rules/structure.js';
import { buildInvoice, demoEgs, sample, type InvoiceKind, type InvoiceType } from '../src/einvoice/zatca/sample.js';
import { parseInvoice, type RuleContext } from '../src/einvoice/zatca/validate.js';

/** The phase 2 structure rules (B6 S13): a valid sample gives nothing; one edit per check gives its code. */

const egs = demoEgs();
const ISSUE_AT = '2026-11-20T09:30:15Z';

const make = (type: InvoiceType = 'simplified', kind: InvoiceKind = '388') =>
  sample({ type, kind, icv: 7, number: 'SME00007', egs, issueAt: ISSUE_AT, uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be' }).xml;

function run(xml: string) {
  const p = parseInvoice(xml);
  if (!p.ok) throw new Error(`sample does not parse: ${p.error}`);
  const ctx: RuleContext = {
    doc: p.doc,
    root: p.doc.documentElement!,
    xml: p.xml,
    extracted: p.extracted,
    input: { xml, config: { checks: 'full', chainCheck: 'off' } },
  };
  return structureRules(ctx);
}

const codes = (xml: string): string[] => run(xml).map((f) => f.code);

/** Replaces the first match of `re`; fails when it does not match, so a test cannot pass by editing nothing. */
function edit(xml: string, re: RegExp, to: string): string {
  if (!re.test(xml)) throw new Error(`pattern not found: ${re}`);
  return xml.replace(re, to);
}
const drop = (xml: string, re: RegExp): string => edit(xml, re, '');

describe('structureRules: valid invoices', () => {
  it.each([
    ['simplified', '388'],
    ['simplified', '381'],
    ['simplified', '383'],
    ['standard', '388'],
    ['standard', '381'],
    ['standard', '383'],
  ] as [InvoiceType, InvoiceKind][])('%s %s: no findings', (type, kind) => {
    expect(run(make(type, kind))).toEqual([]);
  });

  it('a simplified invoice may omit the buyer', () => {
    const xml = sample({ type: 'simplified', kind: '388', icv: 1, number: 'S1', egs, issueAt: ISSUE_AT, buyer: null }).xml;
    expect(run(xml)).toEqual([]);
  });

  it('an unsigned invoice (no QR yet) only lacks the QR', () => {
    const xml = buildInvoice({ type: 'simplified', kind: '388', number: 'S1', icv: 1, issueAt: ISSUE_AT, seller: egs });
    expect(codes(xml)).toEqual(['BR-KSA-27']);
  });

  it('every code it uses is in the catalog', () => {
    const found = new Set<string>();
    const xml = make('standard');
    for (const re of [/<cbc:ID>SME00007<\/cbc:ID>/, /<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/, /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/]) {
      for (const f of run(drop(xml, re))) found.add(f.code);
    }
    expect(found.size).toBeGreaterThan(0);
    for (const code of found) expect(ruleByCode(code), code).toBeDefined();
  });
});

describe('structureRules: header', () => {
  const cases: [string, (xml: string) => string, string, string?][] = [
    ['ProfileID missing', (x) => drop(x, /\s*<cbc:ProfileID>[^<]*<\/cbc:ProfileID>/), 'BR-KSA-25', 'cbc:ProfileID'],
    ['ProfileID wrong', (x) => edit(x, /reporting:1\.0/, 'reporting:2.0'), 'BR-KSA-25', 'cbc:ProfileID'],
    ['ID missing', (x) => drop(x, /\s*<cbc:ID>SME00007<\/cbc:ID>/), 'BR-02', 'cbc:ID'],
    ['ID empty', (x) => edit(x, /<cbc:ID>SME00007<\/cbc:ID>/, '<cbc:ID> </cbc:ID>'), 'BR-02', 'cbc:ID'],
    ['UUID missing', (x) => drop(x, /\s*<cbc:UUID>[^<]*<\/cbc:UUID>/), 'BR-KSA-25', 'cbc:UUID'],
    ['UUID with a space', (x) => edit(x, /3cf5ee18-ee25/, '3cf5ee18 ee25'), 'BR-KSA-03', 'cbc:UUID'],
    ['UUID with an underscore', (x) => edit(x, /3cf5ee18-ee25/, '3cf5ee18_ee25'), 'BR-KSA-03', 'cbc:UUID'],
    ['IssueDate missing', (x) => drop(x, /\s*<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/), 'BR-03', 'cbc:IssueDate'],
    ['IssueDate not YYYY-MM-DD', (x) => edit(x, /<cbc:IssueDate>[^<]*</, '<cbc:IssueDate>20/11/2026<'), 'BR-KSA-F-01', 'cbc:IssueDate'],
    ['IssueDate not a real day', (x) => edit(x, /<cbc:IssueDate>[^<]*</, '<cbc:IssueDate>2026-02-30<'), 'BR-KSA-F-01', 'cbc:IssueDate'],
    ['IssueTime missing', (x) => drop(x, /\s*<cbc:IssueTime>[^<]*<\/cbc:IssueTime>/), 'BR-KSA-70', 'cbc:IssueTime'],
    ['IssueTime without seconds', (x) => edit(x, /<cbc:IssueTime>[^<]*</, '<cbc:IssueTime>09:30<'), 'BR-KSA-70', 'cbc:IssueTime'],
    ['IssueTime hour 25', (x) => edit(x, /<cbc:IssueTime>[^<]*</, '<cbc:IssueTime>25:30:15<'), 'BR-KSA-70', 'cbc:IssueTime'],
    ['InvoiceTypeCode missing', (x) => drop(x, /\s*<cbc:InvoiceTypeCode[^>]*>[^<]*<\/cbc:InvoiceTypeCode>/), 'BR-04', 'cbc:InvoiceTypeCode'],
    ['InvoiceTypeCode empty', (x) => edit(x, /(<cbc:InvoiceTypeCode[^>]*>)388</, '$1<'), 'BR-04', 'cbc:InvoiceTypeCode'],
    ['InvoiceTypeCode 999', (x) => edit(x, />388<\/cbc:InvoiceTypeCode>/, '>999</cbc:InvoiceTypeCode>'), 'BR-KSA-05', 'cbc:InvoiceTypeCode'],
    ['InvoiceTypeCode without name', (x) => edit(x, / name="0200000"/, ''), 'BR-KSA-06', 'cbc:InvoiceTypeCode/@name'],
    ['InvoiceTypeCode name 6 chars', (x) => edit(x, /name="0200000"/, 'name="020000"'), 'BR-KSA-06', 'cbc:InvoiceTypeCode/@name'],
    ['InvoiceTypeCode name 03', (x) => edit(x, /name="0200000"/, 'name="0300000"'), 'BR-KSA-06', 'cbc:InvoiceTypeCode/@name'],
    ['InvoiceTypeCode name with flag 2', (x) => edit(x, /name="0200000"/, 'name="0200020"'), 'BR-KSA-06', 'cbc:InvoiceTypeCode/@name'],
    ['DocumentCurrencyCode missing', (x) => drop(x, /\s*<cbc:DocumentCurrencyCode>[^<]*<\/cbc:DocumentCurrencyCode>/), 'BR-05', 'cbc:DocumentCurrencyCode'],
    ['DocumentCurrencyCode lowercase', (x) => edit(x, /<cbc:DocumentCurrencyCode>SAR</, '<cbc:DocumentCurrencyCode>sar<'), 'BR-05', 'cbc:DocumentCurrencyCode'],
    ['TaxCurrencyCode missing', (x) => drop(x, /\s*<cbc:TaxCurrencyCode>[^<]*<\/cbc:TaxCurrencyCode>/), 'BR-KSA-68', 'cbc:TaxCurrencyCode'],
  ];

  it.each(cases)('%s', (_name, change, code, path) => {
    const found = run(change(make('simplified')));
    const hit = found.find((f) => f.code === code);
    expect(hit, JSON.stringify(found)).toBeDefined();
    if (path) expect(hit!.path).toBe(path);
    expect(found.every((f) => ruleByCode(f.code))).toBe(true);
  });

  it('a valid time with Z passes', () => {
    expect(run(edit(make(), /<cbc:IssueTime>[^<]*</, '<cbc:IssueTime>09:30:15Z<'))).toEqual([]);
  });

  it('a type code 386 passes', () => {
    expect(run(edit(make(), />388<\/cbc:InvoiceTypeCode>/, '>386</cbc:InvoiceTypeCode>'))).toEqual([]);
  });

  it('a second ProfileID is XSD_ZATCA_INVALID', () => {
    const xml = edit(make(), /(\s*)(<cbc:ProfileID>[^<]*<\/cbc:ProfileID>)/, '$1$2$1$2');
    const found = run(xml);
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('XSD_ZATCA_INVALID');
    expect(found[0].path).toBe('cbc:ProfileID[2]');
  });
});

describe('structureRules: ICV, PIH, QR', () => {
  const ref = (id: string) => new RegExp(`\\s*<cac:AdditionalDocumentReference>\\s*<cbc:ID>${id}</cbc:ID>[\\s\\S]*?</cac:AdditionalDocumentReference>`);

  it.each([
    ['ICV', 'BR-KSA-34'],
    ['PIH', 'BR-KSA-61'],
    ['QR', 'BR-KSA-27'],
  ])('%s reference missing', (id, code) => {
    const found = run(drop(make(), ref(id)));
    expect(found.map((f) => f.code)).toEqual([code]);
    expect(found[0].path).toBe(`cac:AdditionalDocumentReference[ID=${id}]`);
  });

  it('ICV without a value', () => {
    const found = run(edit(make(), /(<cbc:ID>ICV<\/cbc:ID>\s*<cbc:UUID>)7(<)/, '$1$2'));
    expect(found.map((f) => f.code)).toEqual(['BR-KSA-34']);
  });

  it('PIH without a value', () => {
    const found = run(edit(make(), /(<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">)[^<]*(<\/cbc:EmbeddedDocumentBinaryObject>\s*<\/cac:Attachment>\s*<\/cac:AdditionalDocumentReference>\s*<cac:AdditionalDocumentReference>\s*<cbc:ID>QR)/, '$1$2'));
    expect(found.map((f) => f.code)).toEqual(['BR-KSA-61']);
  });

  it('QR with an empty payload', () => {
    const found = run(edit(make(), /(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]*</, '$1<'));
    expect(found.map((f) => f.code)).toEqual(['BR-KSA-27']);
  });

  it('two ICV references', () => {
    const xml = make();
    const icv = ref('ICV').exec(xml)![0];
    const found = run(xml.replace(icv, icv + icv));
    expect(found.map((f) => f.code)).toEqual(['BR-KSA-34']);
    expect(found[0].path).toBe('cac:AdditionalDocumentReference[2]');
  });
});

describe('structureRules: seller and buyer', () => {
  it('seller missing', () => {
    const found = run(drop(make(), /\s*<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/));
    expect(found.map((f) => f.code)).toEqual(['BR-06']);
    expect(found[0].path).toBe('cac:AccountingSupplierParty');
  });

  it('seller name missing', () => {
    const found = run(drop(make(), /\s*<cac:PartyLegalEntity>\s*<cbc:RegistrationName>[^<]*<\/cbc:RegistrationName>\s*<\/cac:PartyLegalEntity>(?=\s*<\/cac:Party>\s*<\/cac:AccountingSupplierParty>)/));
    expect(found.map((f) => f.code)).toEqual(['BR-06']);
    expect(found[0].path).toBe('cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName');
  });

  it('seller address missing', () => {
    const found = run(edit(make(), /(<cac:AccountingSupplierParty>[\s\S]*?)\s*<cac:PostalAddress>[\s\S]*?<\/cac:PostalAddress>/, '$1'));
    expect(found.map((f) => f.code)).toEqual(['BR-08']);
    expect(found[0].path).toBe('cac:AccountingSupplierParty/cac:Party/cac:PostalAddress');
  });

  it('seller country missing', () => {
    const found = run(edit(make(), /(<cac:AccountingSupplierParty>[\s\S]*?)\s*<cac:Country>[\s\S]*?<\/cac:Country>/, '$1'));
    expect(found.map((f) => f.code)).toEqual(['BR-09']);
    expect(found[0].path).toBe('cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode');
  });

  const buyer = /\s*<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/;

  it('standard invoice without a buyer: name and address', () => {
    const found = run(drop(make('standard'), buyer));
    expect(found.map((f) => f.code).sort()).toEqual(['BR-10', 'BR-KSA-42']);
  });

  it('standard invoice with a buyer without a name', () => {
    const found = run(drop(make('standard'), /\s*<cac:PartyLegalEntity>\s*<cbc:RegistrationName>Demo Buyer[\s\S]*?<\/cac:PartyLegalEntity>/));
    expect(found.map((f) => f.code)).toEqual(['BR-KSA-42']);
    expect(found[0].path).toBe('cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName');
  });

  it('standard invoice with a buyer without an address', () => {
    const found = run(edit(make('standard'), /(<cac:AccountingCustomerParty>[\s\S]*?)\s*<cac:PostalAddress>[\s\S]*?<\/cac:PostalAddress>/, '$1'));
    expect(found.map((f) => f.code)).toEqual(['BR-10']);
  });

  it('simplified invoice without a buyer is fine', () => {
    expect(codes(drop(make('simplified'), buyer))).toEqual([]);
  });

  it('a standard invoice is recognised by the type code name', () => {
    // 0100000 → standard: the buyer becomes mandatory.
    expect(codes(drop(edit(make('simplified'), /name="0200000"/, 'name="0100000"'), buyer)).sort()).toEqual(['BR-10', 'BR-KSA-42']);
  });
});

describe('structureRules: tax totals', () => {
  const totals = (xml: string) => [...xml.matchAll(/\s*<cac:TaxTotal>(?:(?!<cac:InvoiceLine>)[\s\S])*?<\/cac:TaxTotal>/g)].map((m) => m[0]).filter((t) => !/^\s*<cac:TaxTotal>\s*<cbc:TaxAmount[^>]*>[^<]*<\/cbc:TaxAmount>\s*<cbc:RoundingAmount/.test(t));

  it('the document has two TaxTotal elements in the sample', () => {
    const doc = make().split('<cac:InvoiceLine>')[0];
    expect(doc.match(/<cac:TaxTotal>/g)).toHaveLength(2);
  });

  it('no TaxTotal at all: no VAT breakdown and no total in the tax currency', () => {
    const xml = make();
    const head = xml.split('<cac:LegalMonetaryTotal>')[0];
    const [a, b] = [head.indexOf('<cac:TaxTotal>'), xml.indexOf('<cac:LegalMonetaryTotal>')];
    const found = run(xml.slice(0, a).replace(/\s*$/, '') + '\n    ' + xml.slice(b));
    expect(found.map((f) => f.code).sort()).toEqual(['BR-53', 'BR-CO-18']);
  });

  it('only the TaxTotal with the breakdown: BR-53 (no total in the tax currency)', () => {
    const first = totals(make())[0];
    const found = run(make().replace(first, ''));
    expect(found.map((f) => f.code)).toEqual(['BR-53']);
  });

  it('only the TaxTotal without a breakdown: BR-CO-18', () => {
    const second = totals(make())[1];
    const found = run(make().replace(second, ''));
    expect(found.map((f) => f.code)).toEqual(['BR-CO-18']);
    expect(found[0].path).toBe('cac:TaxTotal/cac:TaxSubtotal');
  });

  it('three TaxTotal elements: XSD_ZATCA_INVALID', () => {
    const first = totals(make())[0];
    const found = run(make().replace(first, first + first));
    expect(found.map((f) => f.code)).toContain('XSD_ZATCA_INVALID');
    expect(found.find((f) => f.code === 'XSD_ZATCA_INVALID')!.path).toMatch(/^cac:TaxTotal\[\d\]/);
  });

  it('two TaxTotal elements with a breakdown: XSD_ZATCA_INVALID', () => {
    const [first, second] = totals(make());
    const found = run(make().replace(first, second));
    expect(found.map((f) => f.code)).toContain('XSD_ZATCA_INVALID');
  });

  it('TaxTotal without TaxAmount: XSD_ZATCA_INVALID', () => {
    const xml = make();
    const first = totals(xml)[0];
    const found = run(xml.replace(first, first.replace(/\s*<cbc:TaxAmount[^>]*>[^<]*<\/cbc:TaxAmount>/, '')));
    expect(found.some((f) => f.code === 'XSD_ZATCA_INVALID' && f.path === 'cac:TaxTotal[1]/cbc:TaxAmount')).toBe(true);
  });

  it('TaxAmount without currencyID: XSD_ZATCA_INVALID', () => {
    const xml = make();
    const first = totals(xml)[0];
    const found = run(xml.replace(first, first.replace(/ currencyID="SAR"/, '')));
    expect(found.some((f) => f.code === 'XSD_ZATCA_INVALID' && f.path === 'cac:TaxTotal[1]/cbc:TaxAmount/@currencyID')).toBe(true);
  });
});

describe('structureRules: totals and lines', () => {
  const lmt = /\s*<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/;
  const lmtChild = (name: string) => new RegExp(`\\s*<cbc:${name}[^>]*>[^<]*</cbc:${name}>`);

  it('LegalMonetaryTotal missing: BR-13', () => {
    const found = run(drop(make(), lmt));
    expect(found.map((f) => f.code)).toEqual(['BR-13']);
    expect(found[0].path).toBe('cac:LegalMonetaryTotal');
  });

  it.each([
    ['TaxExclusiveAmount', 'BR-14'],
    ['TaxInclusiveAmount', 'BR-15'],
    ['PayableAmount', 'XSD_ZATCA_INVALID'],
    ['LineExtensionAmount', 'XSD_ZATCA_INVALID'],
  ])('LegalMonetaryTotal without %s: %s', (name, code) => {
    const xml = make();
    const block = lmt.exec(xml)![0];
    const found = run(xml.replace(block, block.replace(lmtChild(name), '')));
    expect(found.map((f) => f.code)).toEqual([code]);
    expect(found[0].path).toBe(`cac:LegalMonetaryTotal/cbc:${name}`);
  });

  it('PayableAmount without currencyID', () => {
    const xml = make();
    const block = lmt.exec(xml)![0];
    const found = run(xml.replace(block, block.replace(/(<cbc:PayableAmount) currencyID="SAR"/, '$1')));
    expect(found.map((f) => f.code)).toEqual(['XSD_ZATCA_INVALID']);
    expect(found[0].path).toBe('cac:LegalMonetaryTotal/cbc:PayableAmount/@currencyID');
  });

  it('no invoice line: BR-16', () => {
    const found = run(drop(make(), /\s*<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/));
    expect(found.map((f) => f.code)).toEqual(['BR-16']);
  });

  const secondLine = (xml: string) => xml.split('<cac:InvoiceLine>')[2];
  const lineEdit = (re: RegExp, to = ''): string => {
    const xml = make();
    const line = secondLine(xml);
    return xml.replace(line, edit(line, re, to));
  };

  it.each([
    ['ID', /\s*<cbc:ID>2<\/cbc:ID>/, 'BR-21', 'cac:InvoiceLine[2]/cbc:ID'],
    ['InvoicedQuantity', /\s*<cbc:InvoicedQuantity[^>]*>[^<]*<\/cbc:InvoicedQuantity>/, 'BR-22', 'cac:InvoiceLine[2]/cbc:InvoicedQuantity'],
    ['LineExtensionAmount', /\s*<cbc:LineExtensionAmount[^>]*>[^<]*<\/cbc:LineExtensionAmount>/, 'BR-24', 'cac:InvoiceLine[2]/cbc:LineExtensionAmount'],
    ['Item/Name', /\s*<cbc:Name>[^<]*<\/cbc:Name>/, 'BR-25', 'cac:InvoiceLine[2]/cac:Item/cbc:Name'],
    ['Item', /\s*<cac:Item>[\s\S]*<\/cac:Item>/, 'BR-25', 'cac:InvoiceLine[2]/cac:Item/cbc:Name'],
    ['ClassifiedTaxCategory', /\s*<cac:ClassifiedTaxCategory>[\s\S]*?<\/cac:ClassifiedTaxCategory>/, 'BR-CO-04', 'cac:InvoiceLine[2]/cac:Item/cac:ClassifiedTaxCategory/cbc:ID'],
    ['PriceAmount', /\s*<cbc:PriceAmount[^>]*>[^<]*<\/cbc:PriceAmount>/, 'XSD_ZATCA_INVALID', 'cac:InvoiceLine[2]/cac:Price/cbc:PriceAmount'],
  ])('line 2 without %s: %s', (_name, re, code, path) => {
    const found = run(lineEdit(re as RegExp));
    expect(found.map((f) => f.code), JSON.stringify(found)).toContain(code);
    expect(found.find((f) => f.code === code)!.path).toBe(path);
  });

  it('a line is reported at its own index only', () => {
    const found = run(lineEdit(/\s*<cbc:ID>2<\/cbc:ID>/));
    expect(found).toHaveLength(1);
  });
});

describe('structureRules: root children', () => {
  it('a cbc element in the wrong namespace', () => {
    const xml = edit(make(), /xmlns:cbc="[^"]*"/, 'xmlns:cbc="urn:example:not-ubl"');
    const found = run(xml);
    expect(found.some((f) => f.code === 'XSD_ZATCA_INVALID' && /namespace urn:example:not-ubl/.test(f.message))).toBe(true);
    expect(found.map((f) => f.code)).toContain('BR-02');
  });

  it('an unknown element', () => {
    const xml = edit(make(), /(\s*)(<cbc:IssueDate>)/, '$1<cbc:Bogus>x</cbc:Bogus>$1$2');
    const found = run(xml);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'XSD_ZATCA_INVALID', path: 'cbc:Bogus' });
  });

  it('an element without a namespace', () => {
    const xml = edit(make(), /(\s*)(<cbc:IssueDate>)/, '$1<Bogus xmlns="">x</Bogus>$1$2');
    const found = run(xml);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'XSD_ZATCA_INVALID', path: 'Bogus' });
  });

  it('elements out of UBL order', () => {
    const xml = edit(make(), /(\s*)(<cbc:IssueDate>[^<]*<\/cbc:IssueDate>)(\s*)(<cbc:IssueTime>[^<]*<\/cbc:IssueTime>)/, '$1$4$3$2');
    const found = run(xml);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'XSD_ZATCA_INVALID', path: 'cbc:IssueDate' });
    expect(found[0].message).toMatch(/before cbc:IssueTime/);
  });

  it('InvoiceLine before LegalMonetaryTotal', () => {
    const xml = make();
    const m = /\s*<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/.exec(xml)![0];
    const found = run(xml.replace(m, '').replace(/\s*<\/Invoice>\s*$/, `${m}\n</Invoice>\n`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'XSD_ZATCA_INVALID', path: 'cac:LegalMonetaryTotal' });
  });

  it('signature extensions and cac:Signature before the parties are in order', () => {
    const xml = make('standard');
    expect(xml).toContain('<ext:UBLExtensions>');
    expect(xml).toContain('<cac:Signature>');
    expect(run(xml)).toEqual([]);
  });
});

describe('structureRules: findings', () => {
  it('each finding is a catalog finding with a path', () => {
    const xml = drop(drop(make('standard'), /\s*<cbc:ID>SME00007<\/cbc:ID>/), /\s*<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/);
    const found = run(xml);
    expect(found.length).toBeGreaterThan(1);
    for (const f of found) {
      const rule = ruleByCode(f.code)!;
      expect(rule).toBeDefined();
      expect(f.category).toBe(rule.category);
      expect(f.severity).toBe(rule.severity);
      expect(f.path).toBeTruthy();
      expect(f.message).toBeTruthy();
    }
  });

  it('is deterministic and does not mutate the document', () => {
    const xml = make();
    expect(run(xml)).toEqual(run(xml));
  });
});

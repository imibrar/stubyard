import { describe, expect, it } from 'vitest';
import { XMLSerializer, type Element } from '@xmldom/xmldom';
import { add, div, fmt2, mul, parse, round, sub, type Dec } from '../src/einvoice/zatca/dec.js';
import { ruleByCode } from '../src/einvoice/zatca/rules/catalog.js';
import { EXEMPTION_REASON_CODES, VAT_TOLERANCE, vatRules } from '../src/einvoice/zatca/rules/vat.js';
import { BREAKS, BREAK_NAMES, buildInvoice, demoEgs, sample, type BreakName, type LineInput, type SampleOptions } from '../src/einvoice/zatca/sample.js';
import { parseInvoice, type RuleContext } from '../src/einvoice/zatca/validate.js';
import { findAll, parseXml } from '../src/einvoice/zatca/xml.js';

/** The VAT arithmetic rule module (B6 S15): totals, line VAT, categories and the SAR total. */

const run = (xml: string) => {
  const p = parseInvoice(xml);
  if (!p.ok) throw new Error(p.error);
  const ctx: RuleContext = { doc: p.doc, root: p.doc.documentElement!, xml: p.xml, extracted: p.extracted, input: { xml, config: { checks: 'full', chainCheck: 'off' } } };
  return vatRules(ctx);
};
const codes = (xml: string): string[] => [...new Set(run(xml).map((f) => f.code))].sort();

// --- a small invoice builder with every category, the way a client would send it ---

interface BLine {
  qty: string;
  price: string;
  cat?: 'S' | 'Z' | 'E' | 'O';
  percent?: string;
  allowances?: string[];
  charges?: string[];
}
interface BDoc {
  amount: string;
  cat?: 'S' | 'Z' | 'E' | 'O';
  percent?: string;
}
interface Build {
  lines: BLine[];
  allowances?: BDoc[];
  charges?: BDoc[];
  prepaid?: string;
  payableRounding?: string;
  currency?: string;
}

const HUNDRED = parse(100);
const REASON = { Z: ['VATEX-SA-32', 'Export of goods'], E: ['VATEX-SA-30', 'Real estate transactions'], O: ['VATEX-SA-OOS', 'Not subject to VAT'] } as const;
const rateOf = (cat: string, percent?: string): string => (cat === 'S' ? (percent ?? '15') : '0');
const category = (tag: string, cat: string, percent: string, reason = false): string =>
  `<${tag}><cbc:ID>${cat}</cbc:ID><cbc:Percent>${percent}</cbc:Percent>` +
  (reason && cat !== 'S' ? `<cbc:TaxExemptionReasonCode>${REASON[cat as 'Z' | 'E' | 'O'][0]}</cbc:TaxExemptionReasonCode>${cat === 'E' ? `<cbc:TaxExemptionReason>${REASON.E[1]}</cbc:TaxExemptionReason>` : ''}` : '') +
  `<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></${tag}>`;

function build(b: Build): string {
  const sum = (xs: string[] = []): Dec => xs.reduce((s, x) => add(s, parse(x)), 0n);
  const cc = b.currency ?? 'SAR';
  const A = (v: Dec | string): string => ` currencyID="${cc}">${typeof v === 'string' ? v : fmt2(v)}`;
  const groups = new Map<string, { cat: string; percent: string; taxable: Dec }>();
  const bump = (cat: string, percent: string, by: Dec): void => {
    const k = `${cat}|${parse(percent)}`;
    const g = groups.get(k) ?? { cat, percent, taxable: 0n };
    g.taxable = add(g.taxable, by);
    groups.set(k, g);
  };
  let ext = 0n;
  const lineXml = b.lines.map((l, i) => {
    const cat = l.cat ?? 'S';
    const percent = rateOf(cat, l.percent);
    const net = add(sub(round(mul(parse(l.price), parse(l.qty)), 2), sum(l.allowances)), sum(l.charges));
    const vat = round(div(mul(net, parse(percent)), HUNDRED), 2);
    ext = add(ext, net);
    bump(cat, percent, net);
    return `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${l.qty}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount${A(net)}</cbc:LineExtensionAmount>
      ${(l.allowances ?? []).map((a) => `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount${A(a)}</cbc:Amount></cac:AllowanceCharge>`).join('')}
      ${(l.charges ?? []).map((a) => `<cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:Amount${A(a)}</cbc:Amount></cac:AllowanceCharge>`).join('')}
      <cac:TaxTotal><cbc:TaxAmount${A(vat)}</cbc:TaxAmount><cbc:RoundingAmount${A(add(net, vat))}</cbc:RoundingAmount></cac:TaxTotal>
      <cac:Item><cbc:Name>Item ${i + 1}</cbc:Name>${category('cac:ClassifiedTaxCategory', cat, percent)}</cac:Item>
      <cac:Price><cbc:PriceAmount${A(l.price)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  });
  const docAc = (list: BDoc[] = [], charge: boolean): string =>
    list
      .map((a) => {
        const cat = a.cat ?? 'S';
        const percent = rateOf(cat, a.percent);
        bump(cat, percent, charge ? parse(a.amount) : -parse(a.amount));
        return `<cac:AllowanceCharge><cbc:ChargeIndicator>${charge}</cbc:ChargeIndicator><cbc:AllowanceChargeReason>r</cbc:AllowanceChargeReason><cbc:Amount${A(a.amount)}</cbc:Amount>${category('cac:TaxCategory', cat, percent)}</cac:AllowanceCharge>`;
      })
      .join('');
  const docAllow = docAc(b.allowances, false);
  const docCharge = docAc(b.charges, true);
  const allowTotal = sum((b.allowances ?? []).map((a) => a.amount));
  const chargeTotal = sum((b.charges ?? []).map((a) => a.amount));
  const excl = add(sub(ext, allowTotal), chargeTotal);
  let tax = 0n;
  const subs = [...groups.values()].map((g) => {
    const t = round(div(mul(g.taxable, parse(g.percent)), HUNDRED), 2);
    tax = add(tax, t);
    return `<cac:TaxSubtotal><cbc:TaxableAmount${A(g.taxable)}</cbc:TaxableAmount><cbc:TaxAmount${A(t)}</cbc:TaxAmount>${category('cac:TaxCategory', g.cat, g.percent, true)}</cac:TaxSubtotal>`;
  });
  const incl = add(excl, tax);
  const rounding = parse(b.payableRounding ?? 0);
  const payable = add(sub(incl, parse(b.prepaid ?? 0)), rounding);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>T-1</cbc:ID>
  <cbc:DocumentCurrencyCode>${cc}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  ${docAllow}${docCharge}
  <cac:TaxTotal><cbc:TaxAmount${A(cc === 'SAR' ? tax : '999.99')}</cbc:TaxAmount></cac:TaxTotal>
  <cac:TaxTotal><cbc:TaxAmount${A(tax)}</cbc:TaxAmount>${subs.join('')}</cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount${A(ext)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount${A(excl)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount${A(incl)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount${A(allowTotal)}</cbc:AllowanceTotalAmount>
    ${chargeTotal !== 0n ? `<cbc:ChargeTotalAmount${A(chargeTotal)}</cbc:ChargeTotalAmount>` : ''}
    ${b.prepaid ? `<cbc:PrepaidAmount${A(b.prepaid)}</cbc:PrepaidAmount>` : ''}
    ${rounding !== 0n ? `<cbc:PayableRoundingAmount${A(rounding)}</cbc:PayableRoundingAmount>` : ''}
    <cbc:PayableAmount${A(payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lineXml.join('\n  ')}
</Invoice>
`;
}

const MIXED: Build = {
  lines: [
    { qty: '3', price: '12.345', allowances: ['1.00'] },
    { qty: '2', price: '7.99', percent: '5', charges: ['0.50'] },
    { qty: '1', price: '100', cat: 'Z' },
    { qty: '4', price: '25', cat: 'E' },
    { qty: '1', price: '40.10', cat: 'O' },
  ],
  allowances: [{ amount: '5.00' }],
  charges: [{ amount: '2.00', percent: '5' }],
  prepaid: '10.00',
  payableRounding: '0.02',
};

/** Edits an invoice: the callback gets the root element. */
function edit(xml: string, fn: (root: Element) => void): string {
  const doc = parseXml(xml);
  fn(doc.documentElement!);
  return new XMLSerializer().serializeToString(doc);
}
const must = (root: Element, path: string, n = 0): Element => {
  const hit = findAll(root, path)[n];
  if (!hit) throw new Error(`no ${path}[${n}]`);
  return hit;
};
const setText = (root: Element, path: string, v: string, n = 0): void => {
  must(root, path, n).textContent = v;
};
const bumpText = (root: Element, path: string, by: string, n = 0): void => {
  const el = must(root, path, n);
  el.textContent = fmt2(add(parse(el.textContent!), parse(by)));
};
const remove = (root: Element, path: string, n = 0): void => {
  const el = must(root, path, n);
  el.parentNode!.removeChild(el);
};

describe('the module and the catalog', () => {
  it('uses only catalog codes', () => {
    const src = [
      ...['BR-24', 'BR-53'],
      ...['BR-CO-10', 'BR-CO-11', 'BR-CO-12', 'BR-CO-13', 'BR-CO-14', 'BR-CO-15', 'BR-CO-16', 'BR-CO-17'],
      ...['BR-KSA-23', 'BR-KSA-24', 'BR-KSA-51', 'BR-KSA-52', 'BR-KSA-53', 'BR-KSA-69', 'BR-KSA-83'],
      ...['S', 'Z', 'E', 'O'].flatMap((c) => ['05', '08', '09'].map((n) => `BR-${c}-${n}`)),
      ...['09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '23', '24', '25', '27', '28'].map((n) => `BR-DEC-${n}`),
    ];
    for (const c of src) expect(ruleByCode(c), c).toBeDefined();
  });

  it('compares exactly, with one halala of room only for the category S VAT error', () => {
    expect(VAT_TOLERANCE.exact).toBe(0n);
    expect(VAT_TOLERANCE.categoryError).toBe(parse('0.01'));
    expect(EXEMPTION_REASON_CODES.O).toEqual(['VATEX-SA-OOS']);
  });
});

describe('valid invoices give no findings', () => {
  it('a hand-built invoice with S 15, S 5, Z, E, O, allowances, charges, prepaid and rounding', () => {
    expect(run(build(MIXED))).toEqual([]);
  });

  it('a single simple line, and a document allowance on a 0% category', () => {
    expect(run(build({ lines: [{ qty: '1', price: '10' }] }))).toEqual([]);
    expect(run(build({ lines: [{ qty: '2', price: '30', cat: 'Z' }, { qty: '1', price: '10' }], allowances: [{ amount: '4', cat: 'Z' }] }))).toEqual([]);
  });

  it('a non-SAR document currency: the SAR total is not compared', () => {
    expect(run(build({ ...MIXED, currency: 'USD' }))).toEqual([]);
  });

  it('half-up line rounding: 3 × 12.345 = 37.035 → 37.04, VAT 5.556 → 5.56', () => {
    const xml = build({ lines: [{ qty: '3', price: '12.345' }] });
    expect(xml).toContain('37.04');
    expect(run(xml)).toEqual([]);
  });

  it('a category VAT rounded once, not summed from the lines (3 × 0.10 at 15% → 0.045 each, 0.14 in total)', () => {
    const lines: BLine[] = Array.from({ length: 3 }, () => ({ qty: '1', price: '0.30' }));
    const xml = build({ lines });
    // each line VAT is round2(0.30 × 0.15) = 0.05 (3 × 0.05 = 0.15), the category is round2(0.90 × 0.15) = 0.14
    expect(run(xml)).toEqual([]);
    expect(xml).toMatch(/<cbc:TaxAmount currencyID="SAR">0\.14</);
  });

  it('generator invoices with several lines, allowances and rates', () => {
    const cases: { lines: LineInput[]; allowance?: string }[] = [
      { lines: [{ name: 'a', quantity: 3, price: '12.345' }, { name: 'b', quantity: '2.5', price: '7.99', vatPercent: 5 }, { name: 'c', quantity: 1, price: '100' }], allowance: '3.33' },
      { lines: [{ name: 'a', quantity: 7, price: '0.333' }, { name: 'b', quantity: 11, price: '1.005' }], allowance: '0.07' },
      { lines: [{ name: 'a', quantity: 1, price: '19.99' }] },
      { lines: [{ name: 'a', quantity: '0.5', price: '3.25', vatPercent: 5 }, { name: 'b', quantity: 9, price: '4.4', vatPercent: 5 }], allowance: '1' },
    ];
    // a deterministic spread of random-looking cases
    let seed = 12345;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 40; i++) {
      const lines: LineInput[] = Array.from({ length: 1 + next(5) }, (_, k) => ({
        name: `item ${k}`,
        quantity: `${1 + next(9)}${next(2) ? `.${next(100)}` : ''}`,
        price: `${next(500)}.${String(next(1000)).padStart(3, '0')}`.replace(/0+$/, '0'),
        vatPercent: next(3) === 0 ? 5 : 15,
      }));
      cases.push({ lines, allowance: next(2) ? `${next(3)}.${String(next(100)).padStart(2, '0')}` : undefined });
    }
    const egs = demoEgs();
    for (const [i, c] of cases.entries()) {
      for (const [type, kind] of [['simplified', '388'], ['standard', '381']] as const) {
        const xml = buildInvoice({ type, kind, number: `T-${i}`, icv: i + 1, seller: egs, lines: c.lines, allowance: c.allowance });
        expect(run(xml), JSON.stringify(c)).toEqual([]);
      }
    }
  });
});

describe('sample() break variants', () => {
  const egs = demoEgs();
  const base: SampleOptions = { type: 'simplified', kind: '388', icv: 5, number: 'SME00005', egs, lines: [{ name: 'a', quantity: 3, price: '12.345' }, { name: 'b', quantity: 2, price: '7.99', vatPercent: 5 }], allowance: '2.00' };

  it('a valid signed sample has no findings', () => {
    expect(run(sample({ ...base }).xml)).toEqual([]);
  });

  it('total-mismatch gives BR-CO-15 only, line-vat gives BR-KSA-51 only', () => {
    expect(codes(sample({ ...base, break: ['total-mismatch'] }).xml)).toEqual(['BR-CO-15']);
    expect(codes(sample({ ...base, break: ['line-vat'] }).xml)).toEqual(['BR-KSA-51']);
    expect(BREAKS['total-mismatch'].code).toBe('BR-CO-15');
    expect(BREAKS['line-vat'].code).toBe('BR-KSA-51');
  });

  it('the other breaks leave the arithmetic alone', () => {
    const others = BREAK_NAMES.filter((n: BreakName) => n !== 'total-mismatch' && n !== 'line-vat');
    for (const n of others) expect(codes(sample({ ...base, break: [n] }).xml), n).toEqual([]);
  });

  it('both arithmetic breaks together report both codes', () => {
    expect(codes(sample({ ...base, break: ['total-mismatch', 'line-vat'] }).xml)).toEqual(['BR-CO-15', 'BR-KSA-51']);
  });
});

describe('hand edits', () => {
  const ok = build(MIXED);
  const L = 'cac:InvoiceLine';

  it('line 1 VAT off by a halala: BR-KSA-51; the RoundingAmount alone: BR-KSA-53; both moved together: BR-KSA-51 only', () => {
    expect(codes(edit(ok, (r) => { bumpText(r, `${L}/cac:TaxTotal/cbc:TaxAmount`, '0.01'); }))).toEqual(['BR-KSA-51', 'BR-KSA-53']);
    expect(codes(edit(ok, (r) => { bumpText(r, `${L}/cac:TaxTotal/cbc:RoundingAmount`, '0.01'); }))).toEqual(['BR-KSA-53']);
    expect(codes(edit(ok, (r) => { bumpText(r, `${L}/cac:TaxTotal/cbc:TaxAmount`, '0.01'); bumpText(r, `${L}/cac:TaxTotal/cbc:RoundingAmount`, '0.01'); }))).toEqual(['BR-KSA-51']);
  });

  it('a missing line VAT amount: BR-KSA-51 (and BR-KSA-53 does not guess); a missing RoundingAmount: BR-KSA-52', () => {
    expect(codes(edit(ok, (r) => { remove(r, `${L}/cac:TaxTotal/cbc:TaxAmount`); }))).toEqual(['BR-KSA-51']);
    expect(codes(edit(ok, (r) => { remove(r, `${L}/cac:TaxTotal/cbc:RoundingAmount`); }))).toEqual(['BR-KSA-52']);
  });

  it('a line net that is not price × quantity − allowances + charges: BR-24 (and what hangs on it)', () => {
    const f = codes(edit(ok, (r) => { bumpText(r, `${L}/cbc:LineExtensionAmount`, '0.01'); }));
    expect(f).toContain('BR-24');
    expect(f).toContain('BR-CO-10');
    expect(f).toContain('BR-S-08');
  });

  it('a line allowance dropped from the net: BR-24 on line 1 and on the charge line 2', () => {
    expect(run(edit(ok, (r) => { setText(r, `${L}/cbc:LineExtensionAmount`, '37.04'); })).filter((x) => x.code === 'BR-24').map((x) => x.path)).toEqual(['cac:InvoiceLine[1]/cbc:LineExtensionAmount']);
    expect(run(edit(ok, (r) => { setText(r, `${L}/cbc:LineExtensionAmount`, '15.98', 1); })).filter((x) => x.code === 'BR-24').map((x) => x.path)).toEqual(['cac:InvoiceLine[2]/cbc:LineExtensionAmount']);
  });

  it('a price base quantity is divided out', () => {
    const xml = edit(build({ lines: [{ qty: '10', price: '8' }] }), (r) => {
      const price = must(r, `${L}/cac:Price`);
      const base = price.ownerDocument!.createElementNS('urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2', 'cbc:BaseQuantity');
      base.textContent = '4';
      price.appendChild(base);
    });
    expect(codes(xml)).toContain('BR-24');
    expect(run(xml).some((f) => f.code === 'BR-24' && /\/ 4/.test(f.message) && /20\.00/.test(f.message))).toBe(true);
  });

  it('BT-106, BT-107, BT-108 and BT-109 sums', () => {
    const M = 'cac:LegalMonetaryTotal';
    expect(codes(edit(ok, (r) => { bumpText(r, `${M}/cbc:LineExtensionAmount`, '1'); }))).toEqual(['BR-CO-10', 'BR-CO-13']);
    expect(codes(edit(ok, (r) => { bumpText(r, `${M}/cbc:AllowanceTotalAmount`, '1'); }))).toEqual(['BR-CO-11', 'BR-CO-13']);
    expect(codes(edit(ok, (r) => { bumpText(r, `${M}/cbc:ChargeTotalAmount`, '1'); }))).toEqual(['BR-CO-12', 'BR-CO-13']);
    expect(codes(edit(ok, (r) => { bumpText(r, `${M}/cbc:TaxExclusiveAmount`, '1'); }))).toEqual(['BR-CO-13', 'BR-CO-15']);
  });

  it('an allowance total that is missing while allowances exist: BR-CO-11', () => {
    expect(codes(edit(ok, (r) => { remove(r, 'cac:LegalMonetaryTotal/cbc:AllowanceTotalAmount'); }))).toEqual(['BR-CO-11']);
  });

  it('BT-112 and BT-115', () => {
    const M = 'cac:LegalMonetaryTotal';
    expect(codes(edit(ok, (r) => { bumpText(r, `${M}/cbc:TaxInclusiveAmount`, '1'); }))).toEqual(['BR-CO-15', 'BR-CO-16']);
    expect(codes(edit(ok, (r) => { bumpText(r, `${M}/cbc:PayableAmount`, '1'); }))).toEqual(['BR-CO-16']);
    expect(codes(edit(ok, (r) => { setText(r, `${M}/cbc:PrepaidAmount`, '0.00'); }))).toEqual(['BR-CO-16']);
    expect(codes(edit(ok, (r) => { remove(r, `${M}/cbc:PayableRoundingAmount`); }))).toEqual(['BR-CO-16']);
  });

  it('BT-110 against the category amounts; the SAR total against BT-110', () => {
    expect(codes(edit(ok, (r) => { bumpText(r, 'cac:TaxTotal/cbc:TaxAmount', '1', 1); }))).toEqual(['BR-CO-14', 'BR-CO-15']);
    // the first TaxTotal (no subtotals) is the SAR one
    expect(codes(edit(ok, (r) => { bumpText(r, 'cac:TaxTotal/cbc:TaxAmount', '1', 0); }))).toEqual(['BR-CO-14']);
    expect(run(edit(ok, (r) => { bumpText(r, 'cac:TaxTotal/cbc:TaxAmount', '1', 0); }))[0].path).toBe('cac:TaxTotal[1]/cbc:TaxAmount');
  });

  it('a missing SAR TaxTotal while TaxCurrencyCode is present: BR-53 (a warning)', () => {
    const f = run(edit(ok, (r) => { remove(r, 'cac:TaxTotal', 0); }));
    expect(f.map((x) => x.code)).toEqual(['BR-53']);
    expect(f[0].severity).toBe('warning');
  });

  it('category tax: a halala off is a BR-CO-17 warning with BR-CO-14, more is BR-S-09 too', () => {
    const subTax = 'cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount';
    const small = run(edit(ok, (r) => { bumpText(r, subTax, '0.01'); }));
    expect(small.map((f) => f.code).sort()).toEqual(['BR-CO-14', 'BR-CO-17']);
    expect(small.find((f) => f.code === 'BR-CO-17')!.severity).toBe('warning');
    expect(codes(edit(ok, (r) => { bumpText(r, subTax, '0.02'); }))).toEqual(['BR-CO-14', 'BR-CO-17', 'BR-S-09']);
    // a client that sums the rounded line VATs: it keeps its own totals consistent and only gets the warning
    const summed = edit(build({ lines: Array.from({ length: 3 }, () => ({ qty: '1', price: '0.30' })) }), (r) => {
      bumpText(r, 'cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount', '0.01', 0);
      for (const p of ['cac:TaxTotal/cbc:TaxAmount']) { bumpText(r, p, '0.01', 0); bumpText(r, p, '0.01', 1); }
      bumpText(r, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount', '0.01');
      bumpText(r, 'cac:LegalMonetaryTotal/cbc:PayableAmount', '0.01');
    });
    expect(codes(summed)).toEqual(['BR-CO-17']);
  });

  it('a category taxable amount that is not the sum of its lines (BR-CO-17 and BR-S-09 follow for category S): BR-S-08, BR-Z-08, BR-E-08, BR-O-08', () => {
    // MIXED groups: S15, S5, Z, E, O in this order
    const t = 'cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount';
    expect(codes(edit(ok, (r) => { bumpText(r, t, '1', 0); }))).toEqual(['BR-CO-17', 'BR-S-08', 'BR-S-09']);
    expect(codes(edit(ok, (r) => { bumpText(r, t, '1', 2); }))).toEqual(['BR-Z-08']);
    expect(codes(edit(ok, (r) => { bumpText(r, t, '1', 3); }))).toEqual(['BR-E-08']);
    expect(codes(edit(ok, (r) => { bumpText(r, t, '1', 4); }))).toEqual(['BR-O-08']);
  });

  it('a 0% category with VAT: BR-Z-09, BR-E-09, BR-O-09 (with BR-CO-17 and BR-CO-14)', () => {
    const t = 'cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount';
    expect(codes(edit(ok, (r) => { bumpText(r, t, '0.01', 2); }))).toEqual(['BR-CO-14', 'BR-CO-17', 'BR-Z-09']);
    expect(codes(edit(ok, (r) => { bumpText(r, t, '0.01', 3); }))).toEqual(['BR-CO-14', 'BR-CO-17', 'BR-E-09']);
    expect(codes(edit(ok, (r) => { bumpText(r, t, '0.01', 4); }))).toEqual(['BR-CO-14', 'BR-CO-17', 'BR-O-09']);
  });

  it('a category used by lines without a breakdown', () => {
    const f = run(edit(ok, (r) => { remove(r, 'cac:TaxTotal/cac:TaxSubtotal', 3); }));
    expect(f.map((x) => x.code).sort()).toEqual(['BR-E-08']);
    expect(f.find((x) => x.code === 'BR-E-08')!.message).toContain('no breakdown');
  });

  it('a doc allowance moves the category taxable amount: its category rate and amount count', () => {
    // the 5.00 allowance is S 15: dropping it from the breakdown's expectation is BR-S-08
    const f = run(edit(ok, (r) => { remove(r, 'cac:AllowanceCharge', 0); }));
    expect(f.map((x) => x.code)).toContain('BR-S-08');
    expect(f.map((x) => x.code)).toContain('BR-CO-11');
  });

  it('the category rate rules', () => {
    const rate = (n: number, v: string | null) => (r: Element) => {
      const lineEl = must(r, 'cac:InvoiceLine', n);
      const p = must(lineEl, 'cac:Item/cac:ClassifiedTaxCategory/cbc:Percent');
      if (v === null) p.parentNode!.removeChild(p);
      else p.textContent = v;
    };
    // S at 0 and S without a rate
    expect(codes(edit(ok, rate(0, '0.00')))).toContain('BR-S-05');
    expect(codes(edit(ok, rate(0, null)))).toContain('BR-S-05');
    // Z / E at 15 and without a rate
    expect(codes(edit(ok, rate(2, '15.00')))).toContain('BR-Z-05');
    expect(codes(edit(ok, rate(3, '15.00')))).toContain('BR-E-05');
    expect(codes(edit(ok, rate(2, null)))).toContain('BR-Z-05');
    // O: a 0 or no rate is fine, a real rate is not
    expect(codes(edit(ok, rate(4, null)))).toEqual([]);
    expect(codes(edit(ok, rate(4, '15.00')))).toContain('BR-O-05');
    // the same rules on the breakdown
    expect(codes(edit(ok, (r) => { setText(r, 'cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent', '15.00', 2); }))).toContain('BR-Z-05');
  });

  it('exemption reason codes: BR-KSA-69 (Z), BR-KSA-23 and BR-KSA-24 (E), BR-KSA-83 (O)', () => {
    const rc = 'cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReasonCode';
    expect(codes(edit(ok, (r) => { setText(r, rc, 'VATEX-SA-99', 0); }))).toEqual(['BR-KSA-69']);
    expect(codes(edit(ok, (r) => { remove(r, rc, 0); }))).toEqual(['BR-KSA-69']);
    expect(codes(edit(ok, (r) => { setText(r, rc, 'VATEX-SA-OOS', 1); }))).toEqual(['BR-KSA-23']);
    expect(codes(edit(ok, (r) => { setText(r, rc, 'VATEX-SA-32', 2); }))).toEqual(['BR-KSA-83']);
    expect(codes(edit(ok, (r) => { remove(r, 'cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReason', 0); }))).toEqual(['BR-KSA-24']);
    for (const c of EXEMPTION_REASON_CODES.Z) expect(codes(edit(ok, (r) => { setText(r, rc, c, 0); }))).toEqual([]);
    for (const c of EXEMPTION_REASON_CODES.E) expect(codes(edit(ok, (r) => { setText(r, rc, c, 1); }))).toEqual([]);
  });

  it('amounts with more than 2 decimals: the BR-DEC codes', () => {
    const M = 'cac:LegalMonetaryTotal';
    const dec = (path: string, n = 0, v = '1.005') => run(edit(ok, (r) => { setText(r, path, v, n); })).map((f) => f.code);
    expect(dec(`${M}/cbc:LineExtensionAmount`)).toContain('BR-DEC-09');
    expect(dec(`${M}/cbc:AllowanceTotalAmount`)).toContain('BR-DEC-14');
    expect(dec(`${M}/cbc:ChargeTotalAmount`)).toContain('BR-DEC-15');
    expect(dec(`${M}/cbc:TaxExclusiveAmount`)).toContain('BR-DEC-16');
    expect(dec(`${M}/cbc:TaxInclusiveAmount`)).toContain('BR-DEC-19');
    expect(dec(`${M}/cbc:PrepaidAmount`)).toContain('BR-DEC-20');
    expect(dec('cac:TaxTotal/cbc:TaxAmount', 1)).toContain('BR-DEC-17');
    expect(dec('cac:TaxTotal/cbc:TaxAmount', 0)).toContain('BR-DEC-18');
    expect(dec('cac:InvoiceLine/cbc:LineExtensionAmount')).toContain('BR-DEC-23');
    expect(dec('cac:InvoiceLine/cac:AllowanceCharge/cbc:Amount')).toContain('BR-DEC-24');
    expect(dec('cac:InvoiceLine/cac:AllowanceCharge/cbc:Amount', 1)).toContain('BR-DEC-25');
    expect(dec('cac:AllowanceCharge/cbc:Amount', 0)).toContain('BR-DEC-10');
    expect(dec('cac:AllowanceCharge/cbc:Amount', 1)).toContain('BR-DEC-12');
    // a quantity or price with decimals is fine, and two decimals are never a finding
    expect(run(build({ lines: [{ qty: '3.125', price: '12.3456' }] })).map((f) => f.code).filter((c) => c.startsWith('BR-DEC'))).toEqual([]);
  });

  it('is quiet about what it cannot read: no totals, text instead of a number', () => {
    expect(run(edit(ok, (r) => { remove(r, 'cac:LegalMonetaryTotal'); })).map((f) => f.code)).not.toContain('BR-CO-15');
    const garbled = edit(ok, (r) => { setText(r, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount', 'lots'); });
    expect(codes(garbled)).toEqual([]);
    expect(run('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>')).toEqual([]);
  });

  it('every finding carries the path and a catalog message', () => {
    const f = run(edit(ok, (r) => { bumpText(r, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount', '1'); }));
    expect(f).toHaveLength(2);
    for (const x of f) {
      expect(x.path).toMatch(/^cac:LegalMonetaryTotal\//);
      expect(x.category).toBe('EN_16931');
      expect(x.message).toMatch(/expected|is /);
    }
  });
});


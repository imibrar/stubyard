import { describe, expect, it } from 'vitest';
import { sha256b64 } from '../src/einvoice/zatca/hash.js';
import { httpStatusFor, validationResults } from '../src/einvoice/zatca/responses.js';
import type { RuleFinding } from '../src/einvoice/zatca/rules/catalog.js';
import { BREAKS, BREAK_NAMES, demoEgs, sample, type BreakName, type InvoiceKind, type InvoiceType, type SampleOptions } from '../src/einvoice/zatca/sample.js';
import { dedupeFindings, validateInvoice, type ChainState, type ValidateInput } from '../src/einvoice/zatca/validate.js';
import type { Csid } from '../src/einvoice/types.js';

/** The full phase 2 pipeline (B6 S17): every rule module, deduplicated, on the samples and their breaks. */

const egs = demoEgs();
const ISSUE_AT = '2026-11-20T09:30:15Z';
const NOW = Date.parse(ISSUE_AT) + 3600_000;
const PREV_HASH = sha256b64('the previous invoice');

const base = (over: Partial<SampleOptions> = {}): SampleOptions => ({
  type: 'simplified',
  kind: '388',
  icv: 5,
  pih: PREV_HASH,
  number: 'SME00005',
  egs,
  issueAt: ISSUE_AT,
  ...over,
});

const CHAIN: ChainState = { lastIcv: 4, lastHash: PREV_HASH, lastNumber: 'SME00004' };

function run(s: { xml: string; invoiceHash: string; uuid: string }, type: InvoiceType, over: Partial<ValidateInput> = {}) {
  return validateInvoice({
    xml: Buffer.from(s.xml, 'utf8').toString('base64'),
    invoiceHash: s.invoiceHash,
    uuid: s.uuid,
    endpoint: type === 'standard' ? 'clearance' : 'reporting',
    csid: { certPem: egs.certPem, kind: 'production' } as Csid,
    config: { checks: 'full', chainCheck: 'lint', caCertPem: egs.ca.certPem },
    chain: CHAIN,
    nowMs: NOW,
    ...over,
  });
}

const norm = (p: string | undefined) => (p ?? '').replace(/\[1\]/g, '');

/** Findings reported twice: the same code and (normalised) path, or the same code at a path and below it. */
function twice(findings: RuleFinding[]): string[] {
  const out: string[] = [];
  findings.forEach((a, i) =>
    findings.forEach((b, j) => {
      if (i >= j || a.code !== b.code) return;
      const pa = norm(a.path);
      const pb = norm(b.path);
      if (pa === pb || (pa && pb.startsWith(`${pa}/`)) || (pb && pa.startsWith(`${pb}/`))) out.push(`${a.code} ${pa} | ${pb}`);
    }),
  );
  return out;
}

const errors = (f: RuleFinding[]) => f.filter((x) => x.severity === 'error');

describe('validateInvoice full: valid samples', () => {
  const kinds: [InvoiceType, InvoiceKind][] = (['standard', 'simplified'] as const).flatMap((t) => (['388', '381', '383'] as const).map((k) => [t, k] as [InvoiceType, InvoiceKind]));
  for (const [type, kind] of kinds) {
    it(`${type} ${kind}: no error, nothing twice`, () => {
      const v = run(sample(base({ type, kind })), type);
      expect(errors(v.findings), JSON.stringify(v.findings, null, 1)).toEqual([]);
      expect(twice(v.findings)).toEqual([]);
      expect(validationResults(v.findings).status).toBe('PASS');
      // the signature input note from the crypto module reaches the lint
      expect(v.lint.map((l) => l.check)).toContain('einv.signature-method');
      expect(v.lint.filter((l) => l.severity !== 'info')).toEqual([]);
    });
  }
});

describe('validateInvoice full: sample breaks', () => {
  const chainFor = (b: BreakName): ChainState | null => (b === 'first-pih-raw' ? { lastIcv: null, lastHash: null } : CHAIN);
  for (const b of BREAK_NAMES) {
    it(`${b} → ${BREAKS[b].code}`, () => {
      const s = sample(base({ break: [b] }));
      const v = run(s, 'simplified', { chain: chainFor(b) });
      const got = new Set([...v.findings.map((f) => f.code), ...v.lint.map((l) => l.check)]);
      for (const code of s.expect) expect([...got], code).toContain(code);
      expect(twice(v.findings)).toEqual([]);
    });
  }

  it('standard invoice breaks: nothing twice', () => {
    for (const b of BREAK_NAMES) {
      const v = run(sample(base({ type: 'standard', number: 'INV-5', break: [b] })), 'standard', { chain: chainFor(b) });
      expect(twice(v.findings), b).toEqual([]);
    }
  });
});

describe('validateInvoice full: overlapping modules', () => {
  const std = sample(base({ type: 'standard', number: 'INV-5' }));
  const cases: [string, (xml: string) => string][] = [
    ['no buyer', (x) => x.replace(/<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/, '')],
    ['no buyer party', (x) => x.replace(/(<cac:AccountingCustomerParty>)[\s\S]*?(<\/cac:AccountingCustomerParty>)/, '$1$2')],
    ['no seller', (x) => x.replace(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/, '')],
    ['no UUID', (x) => x.replace(/<cbc:UUID>[^<]*<\/cbc:UUID>/, '')],
    ['bad UUID', (x) => x.replace(/(<cbc:UUID>)[^<]*(<\/cbc:UUID>)/, '$1a_b$2')],
    ['no TaxCurrencyCode', (x) => x.replace(/<cbc:TaxCurrencyCode>[^<]*<\/cbc:TaxCurrencyCode>/, '')],
    ['no ID', (x) => x.replace(/<cbc:ID>INV-5<\/cbc:ID>/, '')],
    ['empty item name', (x) => x.replace(/(<cac:Item>\s*<cbc:Name>)[^<]*(<)/, '$1$2')],
    ['no totals', (x) => x.replace(/<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/, '')],
    ['3 decimals', (x) => x.replace(/(<cbc:TaxExclusiveAmount currencyID="SAR">)([^<]+)(<)/, '$1$2' + '1$3')],
    ['bad type name', (x) => x.replace(/name="0100000"/, 'name="01000"')],
    ['ICV letters', (x) => x.replace(/(<cbc:ID>ICV<\/cbc:ID>\s*<cbc:UUID>)[^<]*(<)/, '$1A5$2')],
    ['PIH not a hash', (x) => x.replace(PREV_HASH, 'bm90IGEgaGFzaA==')],
  ];
  for (const [name, edit] of cases) {
    it(`${name}: each fact once`, () => {
      const xml = edit(std.xml);
      expect(xml).not.toBe(std.xml);
      const v = run({ xml, invoiceHash: std.invoiceHash, uuid: std.uuid }, 'standard', { invoiceHash: undefined, uuid: undefined });
      expect(v.parsed).toBe(true);
      expect(errors(v.findings).length).toBeGreaterThan(0);
      expect(twice(v.findings)).toEqual([]);
    });
  }

  it('chain rules: BR-KSA-33 and BR-KSA-26', () => {
    const icv = (x: string) => x.replace(/(<cbc:ID>ICV<\/cbc:ID>\s*<cbc:UUID>)[^<]*(<)/, '$1A5$2');
    const codes = (xml: string) => run({ xml, invoiceHash: '', uuid: '' }, 'standard', { invoiceHash: undefined, uuid: undefined }).findings.map((f) => f.code);
    expect(codes(icv(std.xml))).toContain('BR-KSA-33');
    expect(codes(std.xml.replace(PREV_HASH, 'bm90IGEgaGFzaA=='))).toContain('BR-KSA-26');
    expect(codes(std.xml)).not.toContain('BR-KSA-26');
    // the first-PIH constant and its variants are not BR-KSA-26
    expect(codes(sample(base({ type: 'standard', number: 'INV-5', pih: undefined })).xml)).not.toContain('BR-KSA-26');
    expect(codes(sample(base({ type: 'standard', number: 'INV-5', break: ['first-pih-raw'] })).xml)).not.toContain('BR-KSA-26');
  });

  it('dedupeFindings: same code and path once; pathless once; below an earlier module path dropped', () => {
    const f = (code: string, path?: string): RuleFinding => ({ code, category: 'BR', severity: 'error', message: `${code} ${path ?? ''}`, ...(path ? { path } : {}) });
    const out = dedupeFindings([
      [f('BR-25', 'cac:InvoiceLine/cac:Item/cbc:Name'), f('BR-KSA-42', 'cac:AccountingCustomerParty'), f('BR-CO-15')],
      [f('BR-25', 'cac:InvoiceLine[1]/cac:Item/cbc:Name'), f('BR-25', 'cac:InvoiceLine[2]/cac:Item/cbc:Name'), f('BR-KSA-42', 'cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'), f('BR-CO-15'), f('BR-CO-15', 'cac:LegalMonetaryTotal')],
    ]);
    expect(out.map((x) => `${x.code} ${x.path ?? ''}`)).toEqual([
      'BR-25 cac:InvoiceLine/cac:Item/cbc:Name',
      'BR-KSA-42 cac:AccountingCustomerParty',
      'BR-CO-15 ',
      'BR-25 cac:InvoiceLine[2]/cac:Item/cbc:Name',
      'BR-CO-15 cac:LegalMonetaryTotal',
    ]);
  });
});

describe('validateInvoice full: warnings, clock, lint', () => {
  it('a warning-only invoice → WARNING, 202', () => {
    const s = sample(base({ lines: [{ name: 'x'.repeat(1001), quantity: 1, price: '10.00' }] }));
    const v = run(s, 'simplified');
    expect(errors(v.findings)).toEqual([]);
    expect(v.findings.map((f) => f.code)).toContain('BR-KSA-F-06');
    const r = validationResults(v.findings);
    expect(r.status).toBe('WARNING');
    expect(r.errorMessages).toEqual([]);
    expect(r.warningMessages.map((m) => m.code)).toContain('BR-KSA-F-06');
    expect(httpStatusFor('reporting', r)).toBe(202);
    expect(v.lint.find((l) => l.check === 'BR-KSA-F-06')?.severity).toBe('warn');
  });

  it('errors → ERROR, 400', () => {
    const r = validationResults(run(sample(base({ break: ['total-mismatch'] })), 'simplified').findings);
    expect(r.status).toBe('ERROR');
    expect(r.errorMessages.map((m) => m.code)).toContain('BR-CO-15');
    expect(httpStatusFor('reporting', r)).toBe(400);
  });

  it('BR-KSA-04 uses nowMs', () => {
    const s = sample(base());
    expect(run(s, 'simplified', { nowMs: Date.parse('2026-11-01T00:00:00Z') }).findings.map((f) => f.code)).toContain('BR-KSA-04');
    expect(run(s, 'simplified').findings.map((f) => f.code)).not.toContain('BR-KSA-04');
  });

  it('every finding is lint; basic mode runs no module', () => {
    const s = sample(base({ break: ['vat-14-digits'] }));
    const full = run(s, 'simplified');
    for (const f of full.findings) expect(full.lint.some((l) => l.check === f.code && l.message === f.message)).toBe(true);
    const basic = run(s, 'simplified', { config: { checks: 'basic', chainCheck: 'lint' } });
    expect(basic.findings).toEqual([]);
    expect(basic.lint).toEqual([]);
  });
});

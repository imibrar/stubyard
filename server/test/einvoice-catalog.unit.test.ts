// E-invoicing (B6 S5): the ZATCA rule catalog, validationResults / response bodies, faults and the einv.* lint checks.
import { describe, expect, it } from 'vitest';
import { ZATCA_RULES, ruleByCode, ruleFinding } from '../src/einvoice/zatca/rules/catalog.js';
import { EINVOICE_LINT_CHECKS, finding, lintFromRule, lintLevel } from '../src/einvoice/lint.js';
import {
  CSID_TOKEN_TYPE,
  binarySecurityTokenFor,
  clearanceBody,
  clearanceOffBody,
  complianceInvoiceBody,
  csidBody,
  duplicateClearanceBody,
  duplicateReportingBody,
  httpErrorBody,
  httpStatusFor,
  notAcceptableBody,
  reportingBody,
  unauthorizedBody,
  validationResults,
  type ZatcaEndpoint,
} from '../src/einvoice/zatca/responses.js';
import { EINVOICE_FAULTS, FAULT_HELP, faultAppliesTo, parseFault } from '../src/einvoice/faults.js';

describe('ZATCA rule catalog', () => {
  it('has unique codes and complete entries', () => {
    const codes = ZATCA_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of ZATCA_RULES) {
      expect(r.message.length, r.code).toBeGreaterThan(10);
      expect(['error', 'warning']).toContain(r.severity);
      expect(typeof r.verified).toBe('boolean');
    }
  });

  it('lists the codes of the plan', () => {
    const must = [
      'XSD_ZATCA_INVALID', 'BR-02', 'BR-55', 'BR-CO-04', 'BR-CO-10', 'BR-CO-18', 'BR-S-08', 'BR-Z-09', 'BR-E-08', 'BR-O-09',
      'BR-DEC-16', 'BR-KSA-03', 'BR-KSA-26', 'BR-KSA-81', 'BR-KSA-23', 'BR-KSA-83', 'BR-KSA-DEC-02', 'BR-KSA-F-01', 'BR-KSA-F-06',
      'invalid-invoice-hash', 'signed-properties-hashing', 'invalid-uuid', 'certificate-mismatch', 'invalid-signature', 'QRCODE_INVALID',
    ];
    for (const c of must) expect(ruleByCode(c), c).toBeTruthy();
  });

  it('marks the documented warnings and the verified crypto codes', () => {
    const warnings = ZATCA_RULES.filter((r) => r.severity === 'warning').map((r) => r.code).sort();
    expect(warnings).toEqual(['BR-53', 'BR-CO-17', 'BR-KSA-F-06']);
    expect(ruleByCode('invalid-invoice-hash')).toMatchObject({ category: 'INVOICE_HASHING_ERRORS', verified: true });
    expect(ruleByCode('signed-properties-hashing')).toMatchObject({ category: 'CERTIFICATE_ERRORS', verified: true });
    expect(ruleByCode('invalid-uuid')!.verified).toBe(false);
    expect(ruleByCode('QRCODE_INVALID')!.category).toBe('QRCODE_ERRORS');
  });

  it('ruleFinding copies the catalog entry and throws on an unknown code', () => {
    expect(ruleFinding('BR-KSA-37', undefined, '/Invoice')).toMatchObject({ code: 'BR-KSA-37', category: 'KSA', severity: 'error', path: '/Invoice' });
    expect(ruleFinding('BR-CO-17', 'custom').message).toBe('custom');
    expect(() => ruleFinding('NOPE')).toThrow();
  });
});

describe('einv.* lint checks', () => {
  it('has unique einv.* ids, all from the plan', () => {
    const ids = EINVOICE_LINT_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
    for (const id of ids) expect(id.startsWith('einv.')).toBe(true);
    for (const c of EINVOICE_LINT_CHECKS) expect(['error', 'warn', 'info']).toContain(c.severity);
  });

  it('finding, lintFromRule and lintLevel', () => {
    expect(finding('einv.pih-mismatch', 'x')).toEqual({ check: 'einv.pih-mismatch', severity: 'error', message: 'x' });
    expect(finding('einv.icv-gap', 'y', { path: '/a' })).toMatchObject({ severity: 'warn', path: '/a' });
    expect(lintFromRule(ruleFinding('BR-CO-17'))).toMatchObject({ check: 'BR-CO-17', severity: 'warn' });
    expect(lintFromRule(ruleFinding('BR-02'))).toMatchObject({ check: 'BR-02', severity: 'error' });
    expect(lintFromRule({ code: 'X', category: 'KSA', severity: 'info', message: 'm' }).severity).toBe('info');
    expect(lintLevel([])).toBeNull();
    expect(lintLevel([finding('einv.signature-method', 'm'), finding('einv.icv-gap', 'm')])).toBe('warn');
    expect(lintLevel([finding('einv.icv-gap', 'm'), finding('einv.unknown-csid', 'm')])).toBe('error');
  });
});

describe('validationResults and bodies', () => {
  it('PASS with XSD_ZATCA_VALID when there are no findings', () => {
    const v = validationResults([]);
    expect(v.status).toBe('PASS');
    expect(v.errorMessages).toEqual([]);
    expect(v.warningMessages).toEqual([]);
    expect(v.infoMessages).toEqual([
      { type: 'INFO', code: 'XSD_ZATCA_VALID', category: 'XSD validation', message: 'Complied with UBL 2.1 standards in line with ZATCA specifications', status: 'PASS' },
    ]);
  });

  it('WARNING with warnings only, ERROR with any error', () => {
    const w = validationResults([ruleFinding('BR-CO-17')]);
    expect(w.status).toBe('WARNING');
    expect(w.warningMessages[0]).toMatchObject({ type: 'WARNING', code: 'BR-CO-17', category: 'EN_16931', status: 'WARNING' });
    expect(w.infoMessages[0]!.code).toBe('XSD_ZATCA_VALID');
    const e = validationResults([ruleFinding('BR-CO-17'), ruleFinding('BR-KSA-37')]);
    expect(e.status).toBe('ERROR');
    expect(e.errorMessages[0]).toMatchObject({ type: 'ERROR', code: 'BR-KSA-37', category: 'KSA', status: 'ERROR' });
    expect(e.warningMessages).toHaveLength(1);
  });

  it('drops XSD_ZATCA_VALID when the structure is invalid, keeps info findings', () => {
    const v = validationResults([ruleFinding('XSD_ZATCA_INVALID'), { code: 'I', category: 'KSA', severity: 'info', message: 'fyi' }]);
    expect(v.status).toBe('ERROR');
    expect(v.infoMessages.map((m) => m.code)).toEqual(['I']);
    expect(v.infoMessages[0]!.status).toBe('PASS');
    // a KSA error does not break the XSD verdict
    expect(validationResults([ruleFinding('BR-KSA-37')]).infoMessages[0]!.code).toBe('XSD_ZATCA_VALID');
  });

  it('httpStatusFor: 200 / 202 / 400 on the invoice endpoints, 200 elsewhere', () => {
    const pass = validationResults([]);
    const warn = validationResults([ruleFinding('BR-53')]);
    const err = validationResults([ruleFinding('BR-02')]);
    for (const ep of ['reporting', 'clearance', 'compliance_invoices'] as ZatcaEndpoint[]) {
      expect(httpStatusFor(ep, pass)).toBe(200);
      expect(httpStatusFor(ep, warn)).toBe(202);
      expect(httpStatusFor(ep, err)).toBe(400);
    }
    expect(httpStatusFor('compliance', err)).toBe(200);
  });

  it('reporting and clearance bodies', () => {
    expect(reportingBody(validationResults([])).reportingStatus).toBe('REPORTED');
    expect(reportingBody(validationResults([ruleFinding('BR-53')])).reportingStatus).toBe('REPORTED');
    expect(reportingBody(validationResults([ruleFinding('BR-02')])).reportingStatus).toBe('NOT_REPORTED');
    expect(clearanceBody(validationResults([]), 'QUJD')).toMatchObject({ clearanceStatus: 'CLEARED', clearedInvoice: 'QUJD' });
    expect(clearanceBody(validationResults([ruleFinding('BR-02')]), 'QUJD')).toMatchObject({ clearanceStatus: 'NOT_CLEARED', clearedInvoice: null });
  });

  it('compliance invoice body keeps the real misspellings', () => {
    const simple = complianceInvoiceBody(validationResults([]), 'simplified');
    expect(simple).toMatchObject({ reportingStatus: 'REPORTED', clearanceStatus: null, qrSellertStatus: null, qrBuyertStatus: null });
    expect(Object.keys(simple)).toEqual(expect.arrayContaining(['qrSellertStatus', 'qrBuyertStatus']));
    const std = complianceInvoiceBody(validationResults([ruleFinding('BR-02')]), 'standard');
    expect(std).toMatchObject({ clearanceStatus: 'NOT_CLEARED', reportingStatus: null });
  });

  it('csid body and token', () => {
    const b = csidBody({ requestID: 1234567890123, token: 'tok', secret: 's' });
    expect(b).toEqual({ requestID: 1234567890123, dispositionMessage: 'ISSUED', binarySecurityToken: 'tok', secret: 's', errors: null, tokenType: CSID_TOKEN_TYPE });
    expect(CSID_TOKEN_TYPE).toBe('http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3');
    const pem = '-----BEGIN CERTIFICATE-----\nQUJD\nREVG\n-----END CERTIFICATE-----\n';
    expect(Buffer.from(binarySecurityTokenFor(pem), 'base64').toString('utf8')).toBe('QUJDREVG');
  });

  it('error bodies', () => {
    expect(unauthorizedBody(new Date('2026-01-02T03:04:05.000Z'))).toEqual({ timestamp: '2026-01-02T03:04:05.000Z', status: 401, error: 'Unauthorized', message: '' });
    expect(httpErrorBody(503, 'down')).toEqual({ category: 'HTTP-Errors', code: '503', message: 'down' });
    expect(clearanceOffBody()).toMatchObject({ category: 'HTTP-Errors', code: '303' });
    expect(notAcceptableBody().message).toMatch(/Accept-Version/);
  });

  it('duplicate bodies', () => {
    expect(duplicateReportingBody()).toMatchObject({ reportingStatus: 'REPORTED', message: 'Invoice was already reported successfully earlier' });
    expect(duplicateReportingBody().validationResults.status).toBe('PASS');
    expect(duplicateClearanceBody('QUJD')).toMatchObject({ clearanceStatus: 'CLEARED', clearedInvoice: 'QUJD', message: 'Invoice Hash Previously Submitted' });
    expect(duplicateClearanceBody(null).clearedInvoice).toBeNull();
  });
});

describe('faults', () => {
  it('parses every plain form', () => {
    for (const k of ['duplicate', 'unauthorized', 'clearance_off', 'otp_invalid', 'otp_expired', 'not_compliant', 'renewal_not_compliant', 'too_large', 'server_error', 'unavailable', 'gateway_timeout', 'timeout', 'none']) {
      expect(parseFault(k), k).toEqual({ kind: k, code: null, arg: null, spec: k });
    }
    expect(parseFault('  TIMEOUT ').kind).toBe('timeout');
  });

  it('warning and reject: default and given codes', () => {
    expect(parseFault('warning')).toEqual({ kind: 'warning', code: 'BR-KSA-08', arg: null, spec: 'warning' });
    expect(parseFault('reject')).toEqual({ kind: 'reject', code: 'BR-KSA-26', arg: null, spec: 'reject' });
    expect(parseFault('reject:BR-CO-15')).toMatchObject({ kind: 'reject', code: 'BR-CO-15', spec: 'reject:BR-CO-15' });
    expect(parseFault('reject:br-ksa-37').code).toBe('BR-KSA-37');
    expect(parseFault('warning:INVALID-INVOICE-HASH').code).toBe('invalid-invoice-hash');
  });

  it('rate_limited and slow arguments', () => {
    expect(parseFault('rate_limited')).toEqual({ kind: 'rate_limited', code: null, arg: null, spec: 'rate_limited' });
    expect(parseFault('rate_limited:30')).toMatchObject({ arg: 30, spec: 'rate_limited:30' });
    expect(parseFault('slow:250')).toMatchObject({ kind: 'slow', arg: 250, spec: 'slow:250' });
  });

  it('rejects bad input with a 400', () => {
    for (const bad of ['', 'bogus', 'reject:NOPE-1', 'reject:', 'warning:', 'slow', 'slow:', 'slow:abc', 'slow:-5', 'rate_limited:-1', 'rate_limited:x', 'duplicate:3', 'timeout:1', 'none:1', 'server_error:']) {
      expect(() => parseFault(bad), bad).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    expect(() => parseFault(undefined)).toThrow();
  });

  it('FAULT_HELP covers every fault kind', () => {
    for (const k of EINVOICE_FAULTS) expect(FAULT_HELP.some((h) => h.fault.split(/[[:<]/)[0] === k), k).toBe(true);
  });

  it('faultAppliesTo', () => {
    const f = (s: string) => parseFault(s);
    expect(faultAppliesTo(f('duplicate'), 'reporting')).toBe(true);
    expect(faultAppliesTo(f('duplicate'), 'compliance')).toBe(false);
    expect(faultAppliesTo(f('clearance_off'), 'clearance')).toBe(true);
    expect(faultAppliesTo(f('clearance_off'), 'reporting')).toBe(false);
    expect(faultAppliesTo(f('otp_invalid'), 'compliance')).toBe(true);
    expect(faultAppliesTo(f('otp_invalid'), 'reporting')).toBe(false);
    expect(faultAppliesTo(f('not_compliant'), 'csids')).toBe(true);
    expect(faultAppliesTo(f('not_compliant'), 'csids_renew')).toBe(false);
    expect(faultAppliesTo(f('renewal_not_compliant'), 'csids_renew')).toBe(true);
    expect(faultAppliesTo(f('reject'), 'compliance_invoices')).toBe(true);
    expect(faultAppliesTo(f('warning'), 'compliance')).toBe(false);
    for (const ep of ['compliance', 'csids', 'reporting', 'clearance'] as ZatcaEndpoint[]) {
      expect(faultAppliesTo(f('server_error'), ep)).toBe(true);
      expect(faultAppliesTo(f('unauthorized'), ep)).toBe(true);
    }
  });
});

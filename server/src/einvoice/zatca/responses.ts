import type { RuleFinding } from './rules/catalog.js';

/** The six fake Fatoora endpoints. */
export type ZatcaEndpoint = 'compliance' | 'compliance_invoices' | 'csids' | 'csids_renew' | 'reporting' | 'clearance';

export const CSID_TOKEN_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';

export interface ValidationMessage {
  type: 'INFO' | 'WARNING' | 'ERROR';
  code: string;
  category: string;
  message: string;
  status: 'PASS' | 'WARNING' | 'ERROR';
}

export type ValidationStatus = 'PASS' | 'WARNING' | 'ERROR';

export interface ValidationResults {
  infoMessages: ValidationMessage[];
  warningMessages: ValidationMessage[];
  errorMessages: ValidationMessage[];
  status: ValidationStatus;
}

const XSD_VALID: ValidationMessage = {
  type: 'INFO',
  code: 'XSD_ZATCA_VALID',
  category: 'XSD validation',
  message: 'Complied with UBL 2.1 standards in line with ZATCA specifications',
  status: 'PASS',
};

/**
 * The `validationResults` object. XSD_ZATCA_VALID is added as the first info message unless the findings contain an
 * XSD_ZATCA_INVALID error.
 */
export function validationResults(findings: RuleFinding[]): ValidationResults {
  const info: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const errors: ValidationMessage[] = [];
  const xsdBroken = findings.some((f) => f.severity === 'error' && f.code === 'XSD_ZATCA_INVALID');
  if (!xsdBroken) info.push({ ...XSD_VALID });
  for (const f of findings) {
    const m = { code: f.code, category: f.category, message: f.message };
    if (f.severity === 'error') errors.push({ type: 'ERROR', ...m, status: 'ERROR' });
    else if (f.severity === 'warning') warnings.push({ type: 'WARNING', ...m, status: 'WARNING' });
    else info.push({ type: 'INFO', ...m, status: 'PASS' });
  }
  const status: ValidationStatus = errors.length ? 'ERROR' : warnings.length ? 'WARNING' : 'PASS';
  return { infoMessages: info, warningMessages: warnings, errorMessages: errors, status };
}

/** 200 passed, 202 accepted with warnings, 400 rejected. Only the three invoice endpoints carry validationResults. */
export function httpStatusFor(endpoint: ZatcaEndpoint, results: Pick<ValidationResults, 'status'>): 200 | 202 | 400 {
  if (endpoint !== 'reporting' && endpoint !== 'clearance' && endpoint !== 'compliance_invoices') return 200;
  return results.status === 'ERROR' ? 400 : results.status === 'WARNING' ? 202 : 200;
}

export function reportingBody(results: ValidationResults) {
  return { validationResults: results, reportingStatus: results.status === 'ERROR' ? 'NOT_REPORTED' : 'REPORTED' };
}

/** clearedInvoice is the base64 stamped XML, or null when the invoice was not cleared. */
export function clearanceBody(results: ValidationResults, clearedInvoiceB64: string | null) {
  const cleared = results.status !== 'ERROR';
  return {
    validationResults: results,
    clearanceStatus: cleared ? 'CLEARED' : 'NOT_CLEARED',
    clearedInvoice: cleared ? clearedInvoiceB64 : null,
  };
}

/**
 * The compliance check answer: reportingStatus for a simplified document, clearanceStatus for a standard one (the
 * other is null). `qrSellertStatus` and `qrBuyertStatus` are misspelled in the real API.
 */
export function complianceInvoiceBody(results: ValidationResults, docKind: 'standard' | 'simplified') {
  const ok = results.status !== 'ERROR';
  return {
    validationResults: results,
    reportingStatus: docKind === 'simplified' ? (ok ? 'REPORTED' : 'NOT_REPORTED') : null,
    clearanceStatus: docKind === 'standard' ? (ok ? 'CLEARED' : 'NOT_CLEARED') : null,
    qrSellertStatus: null,
    qrBuyertStatus: null,
  };
}

/** binarySecurityToken of a certificate: base64 of the base64 DER (the PEM body without the armor lines). */
export function binarySecurityTokenFor(certPem: string): string {
  const body = certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return Buffer.from(body, 'utf8').toString('base64');
}

/** The /compliance and /production/csids answer. `token` is the ready binarySecurityToken. */
export function csidBody(c: { requestID: number | string; token: string; secret: string }) {
  return {
    requestID: c.requestID,
    dispositionMessage: 'ISSUED',
    binarySecurityToken: c.token,
    secret: c.secret,
    errors: null,
    tokenType: CSID_TOKEN_TYPE,
  };
}

export function unauthorizedBody(now: Date = new Date()) {
  return { timestamp: now.toISOString(), status: 401, error: 'Unauthorized', message: '' };
}

/** 5xx and other gateway errors. */
export function httpErrorBody(status: number, message: string) {
  return { category: 'HTTP-Errors', code: String(status), message };
}

/** 409: the same hash was already reported within 24 h; clients should treat it as success. */
export function duplicateReportingBody(results: ValidationResults = validationResults([])) {
  return { validationResults: results, reportingStatus: 'REPORTED', message: 'Invoice was already reported successfully earlier' };
}

/** 208: the same hash was already cleared; the stored cleared invoice comes back. */
export function duplicateClearanceBody(clearedInvoiceB64: string | null, results: ValidationResults = validationResults([])) {
  return { validationResults: results, clearanceStatus: 'CLEARED', clearedInvoice: clearedInvoiceB64, message: 'Invoice Hash Previously Submitted' };
}

/** 303: a standard invoice while clearance is switched off for the taxpayer; use reporting instead. */
export function clearanceOffBody() {
  return httpErrorBody(303, 'Clearance is switched off: submit this invoice through the reporting API (invoices/reporting/single)');
}

/** 406: Accept-Version missing or not V2 (assumed shape). */
export function notAcceptableBody() {
  return { message: 'Not Acceptable: the Accept-Version header is missing or not supported (use Accept-Version: V2)' };
}

import type { RuleFinding } from './zatca/rules/catalog.js';

/**
 * E-invoicing integration checks ("would fail or hurt in production"): the stubyard-only `einv.*` findings (chain and
 * integration lint). Findings of the ZATCA rule engine are stored as lint too (check = the ZATCA code, see
 * lintFromRule), so the `einv.*` ids here never appear in validationResults.
 */
export const EINVOICE_LINT_CHECKS = [
  { id: 'einv.pih-mismatch', severity: 'error', label: 'PIH does not match the previous invoice', description: 'The PIH of the invoice is not the hash of the previous invoice of the same EGS unit (the message names both invoices, their ICVs and the expected and received values).' },
  { id: 'einv.icv-gap', severity: 'warn', label: 'ICV gap', description: 'The invoice counter (ICV) skipped one or more values since the previous invoice of the same EGS unit.' },
  { id: 'einv.icv-repeat', severity: 'error', label: 'ICV repeated', description: 'The invoice counter (ICV) was already used by another invoice of the same EGS unit.' },
  { id: 'einv.icv-reset', severity: 'warn', label: 'ICV went backwards', description: 'The invoice counter (ICV) is lower than the previous one of the same EGS unit, as after a reset of the counter on the device.' },
  { id: 'einv.first-pih-variant', severity: 'warn', label: 'First PIH is a variant', description: 'The first invoice of the chain uses a first-PIH value that is not the ZATCA constant (for example the base64 of the raw digest of "0", or the hex text).' },
  { id: 'einv.hash-variant', severity: 'error', label: 'Invoice hash computed the wrong way', description: 'The invoiceHash differs from ZATCA\'s, but matches a known wrong method (minified XML, QR kept, no transforms, exclusive C14N, hex digest); the message names it.' },
  { id: 'einv.wrong-endpoint', severity: 'error', label: 'Wrong endpoint for the invoice type', description: 'A standard invoice was sent to reporting, or a simplified invoice to clearance.' },
  { id: 'einv.ccsid-in-production', severity: 'error', label: 'Compliance CSID used for production', description: 'A compliance CSID (CCSID) was used to report or clear invoices; production calls need the production CSID (PCSID).' },
  { id: 'einv.csr-template-env', severity: 'warn', label: 'CSR template does not match the environment', description: 'The certificate template of the CSR (TSTZATCA / PREZATCA / ZATCA-Code-Signing) is not the one of the instance environment.' },
  { id: 'einv.csr-curve', severity: 'warn', label: 'CSR key is not secp256k1', description: 'The CSR key is not on the secp256k1 curve that ZATCA\'s tools and the SDKs use.' },
  { id: 'einv.csr-fields', severity: 'warn', label: 'CSR fields missing or malformed', description: 'The CSR lacks a required subject field (common name, serial number, organization identifier with the 15-digit VAT number, organizational unit, country SA, invoice type title) or one is malformed.' },
  { id: 'einv.accept-version-missing', severity: 'warn', label: 'Accept-Version header missing', description: 'The request has no Accept-Version header (V2); the real gateway answers 406.' },
  { id: 'einv.clearance-status-header', severity: 'info', label: 'Clearance-Status header missing or 0', description: 'A clearance request was sent without Clearance-Status: 1 (or with 0).' },
  { id: 'einv.reported-late', severity: 'warn', label: 'Simplified invoice reported late', description: 'A simplified invoice was reported more than the reporting window (24 hours by default) after its issue date and time.' },
  { id: 'einv.retry-storm', severity: 'warn', label: 'Same invoice sent many times', description: 'The same invoice hash was sent again and again in a short time (a retry loop that does not back off).' },
  { id: 'einv.duplicate-resubmitted', severity: 'warn', label: 'Accepted invoice resubmitted', description: 'An invoice ZATCA already accepted was sent again (answered 409 on reporting, 208 on clearance); treat that answer as success and stop retrying.' },
  { id: 'einv.uuid-reused', severity: 'warn', label: 'UUID reused', description: 'Another invoice with a different hash already used this invoice UUID.' },
  { id: 'einv.number-reused', severity: 'warn', label: 'Invoice number reused', description: 'Another invoice of the same seller with a different hash already used this invoice number (cbc:ID).' },
  { id: 'einv.unknown-csid', severity: 'error', label: 'Unknown CSID', description: 'The Basic authorization header does not match any CSID stubyard issued for this instance (it may belong to another instance, another project, or was never issued here).' },
  { id: 'einv.signature-method', severity: 'info', label: 'Signature input', description: 'Which input the ECDSA signature was made over: the invoice hash bytes or the canonical SignedInfo (both are accepted).' },
  { id: 'einv.signature-variant', severity: 'warn', label: 'Signature built a non-ZATCA way', description: 'The XAdES signature uses an accepted variant that is not the ZATCA form: the SignatureProperties reference Type, a SignedProperties digest that is raw, exclusive-C14N or over the text as written, or a CertDigest that is raw or over the PEM text.' },
] as const;

export type EinvoiceCheckId = (typeof EINVOICE_LINT_CHECKS)[number]['id'];

export interface EinvoiceLintFinding {
  /** An `einv.*` id, or a ZATCA rule code when the finding comes from the rule engine. */
  check: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  /** Location in the invoice, when known. */
  path?: string;
}

export function finding(check: EinvoiceCheckId, message: string, extra?: { path?: string }): EinvoiceLintFinding {
  const c = EINVOICE_LINT_CHECKS.find((x) => x.id === check)!;
  return { check, severity: c.severity, message, ...(extra?.path ? { path: extra.path } : {}) };
}

/** A ZATCA rule finding as lint (check = the ZATCA code; warning becomes warn). */
export function lintFromRule(f: RuleFinding): EinvoiceLintFinding {
  return { check: f.code, severity: f.severity === 'warning' ? 'warn' : f.severity, message: f.message, ...(f.path ? { path: f.path } : {}) };
}

const LEVEL: Record<EinvoiceLintFinding['severity'], number> = { info: 1, warn: 2, error: 3 };

/** The highest severity among the findings, or null when there are none. */
export const lintLevel = (findings: EinvoiceLintFinding[]): EinvoiceLintFinding['severity'] | null =>
  findings.reduce<EinvoiceLintFinding['severity'] | null>((a, f) => (!a || LEVEL[f.severity] > LEVEL[a] ? f.severity : a), null);

/** Findings merged without duplicates (same check + message + path). */
export function mergeFindings(a: EinvoiceLintFinding[], b: EinvoiceLintFinding[]): EinvoiceLintFinding[] {
  const out = [...a];
  for (const f of b) if (!out.some((x) => x.check === f.check && x.message === f.message && x.path === f.path)) out.push(f);
  return out;
}

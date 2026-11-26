import { HttpError } from '../util.js';
import { ruleByCodeLoose } from './zatca/rules/catalog.js';
import type { ZatcaEndpoint } from './zatca/responses.js';

/**
 * E-invoicing faults: a rule (einvoice_rules) or one request (X-Hub-Scenario) makes the fake Fatoora answer the way
 * the real gateway does when something is wrong.
 */
export const EINVOICE_FAULTS = [
  'warning',
  'reject',
  'duplicate',
  'unauthorized',
  'clearance_off',
  'otp_invalid',
  'otp_expired',
  'not_compliant',
  'renewal_not_compliant',
  'too_large',
  'rate_limited',
  'server_error',
  'unavailable',
  'gateway_timeout',
  'timeout',
  'slow',
  'none',
] as const;
export type EinvoiceFaultKind = (typeof EINVOICE_FAULTS)[number];

export interface EinvoiceFault {
  kind: EinvoiceFaultKind;
  /** warning / reject: the ZATCA code to report (the default when none was given). */
  code: string | null;
  /** rate_limited: Retry-After seconds; slow: delay in ms. */
  arg: number | null;
  /** Normalized text, parseable again. */
  spec: string;
}

export const DEFAULT_WARNING_CODE = 'BR-KSA-08';
export const DEFAULT_REJECT_CODE = 'BR-KSA-26';
export const DEFAULT_RETRY_AFTER_SECS = 60;

export const FAULT_HELP: { fault: string; answer: string }[] = [
  { fault: 'warning[:CODE]', answer: `202 with a warning message (default code ${DEFAULT_WARNING_CODE})` },
  { fault: 'reject[:CODE]', answer: `400 NOT_REPORTED / NOT_CLEARED with an error message (default code ${DEFAULT_REJECT_CODE})` },
  { fault: 'duplicate', answer: '409 on reporting, 208 on clearance (the invoice hash was already submitted)' },
  { fault: 'unauthorized', answer: '401 Unauthorized' },
  { fault: 'clearance_off', answer: '303 on clearance: clearance is switched off, use reporting' },
  { fault: 'otp_invalid', answer: '400 on /compliance (and renewal): the OTP is wrong' },
  { fault: 'otp_expired', answer: '400 on /compliance (and renewal): the OTP has expired' },
  { fault: 'not_compliant', answer: '400 on the production CSID request: compliance checks are missing' },
  { fault: 'renewal_not_compliant', answer: '428 on the CSID renewal' },
  { fault: 'too_large', answer: '413 Payload Too Large' },
  { fault: 'rate_limited[:secs]', answer: `429 + Retry-After (default ${DEFAULT_RETRY_AFTER_SECS} seconds)` },
  { fault: 'server_error', answer: '500' },
  { fault: 'unavailable', answer: '503' },
  { fault: 'gateway_timeout', answer: '504' },
  { fault: 'timeout', answer: 'hold the request (STUBYARD_TIMEOUT_HOLD_MS), then close the connection' },
  { fault: 'slow:<ms>', answer: 'answer normally after <ms> milliseconds' },
  { fault: 'none', answer: 'clears the fault (answers normally)' },
];

const ALL: readonly ZatcaEndpoint[] = ['compliance', 'compliance_invoices', 'csids', 'csids_renew', 'reporting', 'clearance'];
const INVOICES: readonly ZatcaEndpoint[] = ['compliance_invoices', 'reporting', 'clearance'];

/** Where each fault makes sense; the rest of the faults apply to every endpoint. */
const APPLIES: Partial<Record<EinvoiceFaultKind, readonly ZatcaEndpoint[]>> = {
  warning: INVOICES,
  reject: INVOICES,
  duplicate: ['reporting', 'clearance'],
  clearance_off: ['clearance'],
  otp_invalid: ['compliance', 'csids_renew'],
  otp_expired: ['compliance', 'csids_renew'],
  not_compliant: ['csids'],
  renewal_not_compliant: ['csids_renew'],
};

export function faultAppliesTo(fault: Pick<EinvoiceFault, 'kind'>, endpoint: ZatcaEndpoint): boolean {
  return (APPLIES[fault.kind] ?? ALL).includes(endpoint);
}

const bad = (m: string) => new HttpError(400, m);

export function parseFault(input: unknown): EinvoiceFault {
  const text = String(input ?? '').trim();
  const colon = text.indexOf(':');
  const kindText = (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase();
  const rawArg = colon < 0 ? undefined : text.slice(colon + 1).trim();
  if (!(EINVOICE_FAULTS as readonly string[]).includes(kindText)) {
    throw bad(`Unknown e-invoicing fault "${text}". Use one of: ${FAULT_HELP.map((f) => f.fault).join(', ')}`);
  }
  const kind = kindText as EinvoiceFaultKind;

  if (kind === 'warning' || kind === 'reject') {
    let code = kind === 'warning' ? DEFAULT_WARNING_CODE : DEFAULT_REJECT_CODE;
    if (rawArg !== undefined) {
      const rule = rawArg === '' ? undefined : ruleByCodeLoose(rawArg);
      if (!rule) throw bad(`Fault "${text}": unknown ZATCA code "${rawArg}". Use a code from the rules catalog (for example ${kind === 'warning' ? DEFAULT_WARNING_CODE : DEFAULT_REJECT_CODE})`);
      code = rule.code;
    }
    return { kind, code, arg: null, spec: rawArg !== undefined ? `${kind}:${code}` : kind };
  }

  let arg: number | null = null;
  if (rawArg !== undefined && rawArg !== '') {
    arg = Number(rawArg);
    if (!Number.isFinite(arg) || arg < 0) throw bad(`Fault "${text}": the number after ":" must be a number ≥ 0`);
  } else if (rawArg === '' && (kind === 'slow' || kind === 'rate_limited')) {
    throw bad(`Fault "${text}": the number after ":" is empty`);
  }
  if (kind === 'slow' && arg === null) throw bad('Fault "slow" needs a delay: slow:<ms>');
  if (arg !== null && kind !== 'slow' && kind !== 'rate_limited') throw bad(`Fault "${kind}" takes no argument`);
  if (rawArg === '') throw bad(`Fault "${kind}" takes no argument`);
  return { kind, code: null, arg, spec: arg !== null ? `${kind}:${arg}` : kind };
}

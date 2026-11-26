import { HttpError } from '../util.js';

/**
 * Nafath faults: a rule (nafath_rules) makes fake Nafath answer or decide the way the real service does when
 * something goes wrong. Each fault acts at one or more stages of a transaction (see appliesTo); a rule is matched and
 * consumed (`remaining`) only at a stage its fault acts on.
 */
export const NAFATH_FAULTS = [
  'rejected',
  'expired',
  'wrong_number',
  'already_active',
  'down',
  'timeout',
  'slow',
  'rate_limit',
  'invalid_credentials',
  'bad_signature',
  'unknown_kid',
  'no_callback',
  'duplicate_callback',
  'approve',
  'none',
] as const;
export type NafathFaultKind = (typeof NAFATH_FAULTS)[number];

/** request: POST /mfa/request; status: /status and /info; decide: signing the token; callback: delivering it. */
export type FaultStage = 'request' | 'status' | 'decide' | 'callback';

export interface NafathFault {
  kind: NafathFaultKind;
  /** slow: delay ms; approve / rejected: decide after this many ms (null: at once). */
  arg: number | null;
  spec: string;
}

export const FAULT_HELP: { fault: string; stage: string; effect: string }[] = [
  { fault: 'rejected[:<ms>]', stage: 'request', effect: 'the person rejects: REJECTED at once, or after <ms>' },
  { fault: 'approve[:<ms>]', stage: 'request', effect: 'the person approves: COMPLETED at once, or after <ms>' },
  { fault: 'expired', stage: 'request', effect: 'the transaction is EXPIRED from the start' },
  { fault: 'wrong_number', stage: 'request', effect: 'the person picks a wrong number: REJECTED (reason wrong_number)' },
  { fault: 'already_active', stage: 'request', effect: '400-034-050 "active transaction" even when none is waiting' },
  { fault: 'down', stage: 'request, status', effect: '503 Service Unavailable' },
  { fault: 'timeout', stage: 'request, status', effect: 'hold the request (STUBYARD_TIMEOUT_HOLD_MS), then close the connection' },
  { fault: 'slow:<ms>', stage: 'request, status', effect: 'answer normally after <ms> milliseconds' },
  { fault: 'rate_limit', stage: 'request, status', effect: '429 Too many requests' },
  { fault: 'invalid_credentials', stage: 'request, status', effect: '403 Invalid APP-ID or APP-KEY, also in lax mode' },
  { fault: 'bad_signature', stage: 'decide', effect: 'the token signature does not verify' },
  { fault: 'unknown_kid', stage: 'decide', effect: 'the token is signed with a key whose kid is not in the JWK set' },
  { fault: 'no_callback', stage: 'callback', effect: 'no callback is sent' },
  { fault: 'duplicate_callback', stage: 'callback', effect: 'the callback is delivered twice' },
  { fault: 'none', stage: '-', effect: 'clears the fault rules (set_nafath_fault)' },
];

const WITH_ARG: NafathFaultKind[] = ['slow', 'approve', 'rejected'];

export function parseFault(input: unknown): NafathFault {
  const spec = String(input ?? '').trim().toLowerCase();
  const [kind, rawArg] = spec.split(':');
  if (!(NAFATH_FAULTS as readonly string[]).includes(kind)) throw new HttpError(400, `Unknown Nafath fault "${spec}". Use one of: ${FAULT_HELP.map((f) => f.fault).join(', ')}`);
  let arg: number | null = null;
  if (rawArg !== undefined && rawArg !== '') {
    arg = Number(rawArg);
    if (!Number.isInteger(arg) || arg < 0) throw new HttpError(400, `Fault "${spec}": the number after ":" must be a whole number ≥ 0`);
  }
  if (kind === 'slow' && arg === null) throw new HttpError(400, 'Fault "slow" needs a delay: slow:<ms>');
  if (arg !== null && !WITH_ARG.includes(kind as NafathFaultKind)) throw new HttpError(400, `Fault "${kind}" takes no argument`);
  return { kind: kind as NafathFaultKind, arg, spec: arg !== null ? `${kind}:${arg}` : kind };
}

const STAGES: Record<NafathFaultKind, FaultStage[]> = {
  rejected: ['request'],
  approve: ['request'],
  expired: ['request'],
  wrong_number: ['request'],
  already_active: ['request'],
  down: ['request', 'status'],
  timeout: ['request', 'status'],
  slow: ['request', 'status'],
  rate_limit: ['request', 'status'],
  invalid_credentials: ['request', 'status'],
  bad_signature: ['decide'],
  unknown_kid: ['decide'],
  no_callback: ['callback'],
  duplicate_callback: ['callback'],
  none: [],
};

/** Does this fault act at this stage? */
export function appliesTo(fault: NafathFault | NafathFaultKind, stage: FaultStage): boolean {
  const kind = typeof fault === 'string' ? fault : fault.kind;
  return STAGES[kind]?.includes(stage) ?? false;
}

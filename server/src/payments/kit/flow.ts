import type { Json } from '../gateway.js';
import type { Payment } from '../repo.js';

/**
 * A small step machine for the multi-step parts of a checkout (only where a flow needs one; card pages without a
 * challenge never touch it). The state lives in payment.providerData.checkoutFlow, the answers of earlier steps
 * stay on the server (no hidden fields to replay), and a step that is not the current one is refused: replaying
 * a finished step or skipping ahead gives FlowError.
 *
 * Flows today:
 * - card-3ds: pay → challenge → done (the 3-D Secure challenge of the realistic pages; the ACS page opened directly
 *   for a card the app already sent to the API starts at challenge).
 * - bank: pay → bank → done (KNET / BENEFIT: the simulated bank page of Tap, MyFatoorah, APS).
 * - paypal-approval: login → review → done (review → login is "change account").
 * - tabby (P3): phone → otp → plan → card → done; a pre-scoring rejected phone ends at the phone screen and the
 *   rejected test buyer after the OTP (→ done); "Change number" goes back from otp to phone.
 * - tamara (P3): phone → otp → terms → plan → card → done (the order is documented by partners only).
 * - jazzcash-wallet (P3): pay (mobile number + CNIC) → mpin → otp → done.
 * - easypaisa-ma (P3): pay (mobile account number) → otp → done.
 */

export const FLOWS = {
  'card-3ds': { start: 'pay', next: { pay: ['challenge', 'done'], challenge: ['done'], done: [] as string[] } },
  bank: { start: 'pay', next: { pay: ['bank'], bank: ['done'], done: [] as string[] } },
  'paypal-approval': { start: 'login', next: { login: ['review'], review: ['done', 'login'], done: [] as string[] } },
  tabby: { start: 'phone', next: { phone: ['otp', 'done'], otp: ['plan', 'phone', 'done'], plan: ['card'], card: ['done', 'plan'], done: [] as string[] } },
  tamara: { start: 'phone', next: { phone: ['otp', 'done'], otp: ['terms', 'phone', 'done'], terms: ['plan'], plan: ['card', 'terms'], card: ['done', 'plan'], done: [] as string[] } },
  'jazzcash-wallet': { start: 'pay', next: { pay: ['mpin'], mpin: ['otp'], otp: ['done'], done: [] as string[] } },
  'easypaisa-ma': { start: 'pay', next: { pay: ['otp'], otp: ['done'], done: [] as string[] } },
} as const satisfies Record<string, { start: string; next: Record<string, readonly string[]> }>;

export type FlowName = keyof typeof FLOWS;

export interface FlowState {
  flow: FlowName;
  step: string;
  history: string[];
  /** Non-secret answers of earlier steps (card brand / last 4 / magic id, user, method; never digits). */
  answers: Record<string, string | null>;
  updatedAt: string;
}

export class FlowError extends Error {
  constructor(
    readonly reason: 'replay' | 'skip',
    message: string,
  ) {
    super(message);
  }
}

export function flowOf(p: Payment): FlowState | null {
  const f = p.providerData.checkoutFlow as FlowState | undefined;
  return f && typeof f === 'object' && f.flow in FLOWS ? f : null;
}

/** Start (or restart) a flow at its first step: a new attempt on the payment page. */
export function startFlow(p: Payment, flow: FlowName): Json {
  const s: FlowState = { flow, step: FLOWS[flow].start, history: [], answers: {}, updatedAt: new Date().toISOString() };
  return { ...p.providerData, checkoutFlow: s };
}

/** The flow is at `step`; anything else is a replay (the step already happened) or a skip. */
export function expectStep(p: Payment, flow: FlowName, step: string): FlowState {
  const s = flowOf(p);
  if (!s || s.flow !== flow) throw new FlowError('skip', `No ${flow} step is waiting on this payment`);
  if (s.step !== step) {
    const replay = s.history.includes(step);
    throw new FlowError(replay ? 'replay' : 'skip', replay ? `The ${step} step is already done` : `The ${step} step is not available now (current step: ${s.step})`);
  }
  return s;
}

/**
 * Start a flow at a later step (the screen the provider opens first, e.g. the ACS page of a card the app already sent
 * to the API, or the KNET page of a single-method payment). The steps before it count as done.
 */
export function startAt(p: Payment, flow: FlowName, step: string, answers: Record<string, string | null> = {}): Json {
  const start = FLOWS[flow].start as string;
  const s: FlowState = { flow, step, history: step === start ? [] : [start], answers, updatedAt: new Date().toISOString() };
  return { ...p.providerData, checkoutFlow: s };
}

/** Move to `to` (must be allowed from the current step); answers are merged. Returns the new providerData. */
export function advance(p: Payment, flow: FlowName, to: string, answers: Record<string, string | null> = {}): Json {
  const s = flowOf(p) ?? { flow, step: FLOWS[flow].start, history: [], answers: {}, updatedAt: '' };
  const allowed = (FLOWS[flow].next as Record<string, readonly string[]>)[s.step] ?? [];
  if (!allowed.includes(to)) throw new FlowError(s.history.includes(to) ? 'replay' : 'skip', `Cannot go from ${s.step} to ${to}`);
  const next: FlowState = { flow, step: to, history: [...s.history, s.step], answers: { ...s.answers, ...answers }, updatedAt: new Date().toISOString() };
  return { ...p.providerData, checkoutFlow: next };
}

import { z } from 'zod';
import { PAYMENT_STATUSES } from '../payments/engine.js';
import { formatPath } from '../storyboards/validate.js';
import { HttpError } from '../util.js';

/**
 * Run expectations (A2): what a test run should cause (declared items) plus the default "nothing unexpected" checks.
 * Stored per run in `runs.expectations`; the verdict engine (runs/verdict.ts) evaluates them.
 */

export const MAX_ITEMS = 50;
export const MAX_NAME = 120;
export const MAX_CONTAINS = 10;
export const MAX_CONTAINS_LEN = 300;

/** The default checks, on unless turned off with `defaults: false` or `{name: false}`. */
export const DEFAULT_CHECKS = [
  { name: 'providerCalls', description: 'Calls from the app to stubyard (inbound) that were unmatched, invalid, rejected or hit an internal error; forced errors are excluded' },
  { name: 'appCallbacks', description: 'Calls from stubyard to the app (outbound) that the app rejected (≥400) or that failed on the network; a failure fixed by a later retry is a warn' },
  { name: 'lintErrors', description: 'Messages with an error-level lint finding, or payments with lint level error' },
  { name: 'duplicateMessages', description: 'Duplicate messages: flagged as a duplicate, or two outbound messages with the same channel, recipient, subject and text' },
  { name: 'unassignedMessages', description: 'Run messages that reached no test user' },
  { name: 'failedMessages', description: 'Failed, rejected, bounced or timed-out messages that no rule caused' },
  { name: 'pendingWork', description: 'Run schedules still pending or messages still scheduled (pending on an active run, a warn at stop)' },
] as const;

export type DefaultCheckName = (typeof DEFAULT_CHECKS)[number]['name'];
export const DEFAULT_CHECK_NAMES = DEFAULT_CHECKS.map((c) => c.name) as DefaultCheckName[];

const LOG_OUTCOMES = ['pending', 'ok', 'unmatched', 'invalid', 'rejected', 'forced_error', 'internal_error', 'network_error'] as const;
const WEBHOOK_SOURCES = ['payment', 'template', 'sequence', 'status_callback', 'email_event', 'inbound', 'verify', 'any'] as const;

const text = z.string().trim().min(1);
const oneOrMany = <T extends z.ZodType>(s: T) => z.union([s, z.array(s).min(1)]);

/** HTTP status: a number, "2xx".."5xx", "error" (no response), or a list of these. */
const HttpStatus = oneOrMany(z.union([z.number().int().min(100).max(599), z.enum(['2xx', '3xx', '4xx', '5xx', 'error'])]));

const Count = z.union([
  z.number().int().min(0),
  z
    .strictObject({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() })
    .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, { message: 'min must not be greater than max' }),
]);

const IsoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO date-time' });

const MessageSelector = z.strictObject({
  channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  to: text.optional(),
  unassigned: z.literal(true).optional(),
  otp: z.union([z.boolean(), text]).optional(),
  contains: z.union([z.string().min(1).max(MAX_CONTAINS_LEN), z.array(z.string().min(1).max(MAX_CONTAINS_LEN)).min(1).max(MAX_CONTAINS)]).optional(),
  subject: text.optional(),
  template: text.optional(),
  status: oneOrMany(text).optional(),
  rule: z.boolean().optional(),
});

const PaymentSelector = z.strictObject({
  gateway: text.optional(),
  status: oneOrMany(z.enum(PAYMENT_STATUSES)).optional(),
  /** Major units ("150.00" or 150); compared in minor units. */
  amount: z.union([z.number().min(0), z.string().trim().regex(/^\d+(\.\d+)?$/, 'must be a decimal amount such as "150.00"')]).optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'must be a 3-letter currency code').optional(),
  user: text.optional(),
  reference: text.optional(),
});

const WebhookSelector = z.strictObject({
  url: text.optional(),
  source: z.enum(WEBHOOK_SOURCES).optional(),
  event: text.optional(),
  status: HttpStatus.optional(),
});

const ProviderCallSelector = z.strictObject({
  instance: text.optional(),
  method: text.optional(),
  path: text.optional(),
  status: HttpStatus.optional(),
  outcome: oneOrMany(z.enum(LOG_OUTCOMES)).optional(),
});

const TrafficSelector = z.strictObject({
  direction: z.enum(['inbound', 'outbound']).optional(),
  protocol: text.optional(),
  outcome: oneOrMany(z.enum(LOG_OUTCOMES)).optional(),
  status: HttpStatus.optional(),
  url: text.optional(),
});

/** For lint items `severity` is the minimum lint level (the selector), not the item's fail/warn severity. */
const LintSelector = z.strictObject({
  source: z.enum(['messages', 'payments', 'all']).optional(),
  severity: z.enum(['error', 'warn', 'info']).optional(),
  check: text.optional(),
});

const common = {
  name: z.string().trim().min(1).max(MAX_NAME).optional(),
  count: Count.optional(),
  severity: z.enum(['fail', 'warn']).optional(),
  since: IsoTime.optional(),
};

const item = <K extends string, S extends z.ZodObject>(kind: K, selector: S) =>
  selector.extend({ kind: z.literal(kind), ...common, each: selector.optional() });

const lintItem = LintSelector.extend({ kind: z.literal('lint'), name: common.name, count: common.count, since: common.since, each: LintSelector.optional() });

export const Expectation = z.discriminatedUnion('kind', [
  item('message', MessageSelector),
  item('payment', PaymentSelector),
  item('webhook', WebhookSelector),
  item('provider_call', ProviderCallSelector),
  item('traffic', TrafficSelector),
  lintItem,
]);
export type Expectation = z.infer<typeof Expectation>;
export type ExpectationKind = Expectation['kind'];
export type MessageExpectation = Extract<Expectation, { kind: 'message' }>;
export type PaymentExpectation = Extract<Expectation, { kind: 'payment' }>;
export type WebhookExpectation = Extract<Expectation, { kind: 'webhook' }>;
export type ProviderCallExpectation = Extract<Expectation, { kind: 'provider_call' }>;
export type TrafficExpectation = Extract<Expectation, { kind: 'traffic' }>;
export type LintExpectation = Extract<Expectation, { kind: 'lint' }>;
export type ExpectationCount = z.infer<typeof Count>;
export type HttpStatusSelector = z.infer<typeof HttpStatus>;

const Defaults = z.union([z.boolean(), z.partialRecord(z.enum(DEFAULT_CHECK_NAMES as [DefaultCheckName, ...DefaultCheckName[]]), z.boolean())]);
export type ExpectationDefaults = z.infer<typeof Defaults>;

/** A PUT / PATCH body: fields left out are "not given" (append keeps them). */
const ExpectationPatch = z.strictObject({
  items: z.array(Expectation).max(MAX_ITEMS, `at most ${MAX_ITEMS} expectations per run`).optional(),
  defaults: Defaults.optional(),
});
export type ExpectationPatch = z.infer<typeof ExpectationPatch>;

/** The stored document (per run). */
export const ExpectationDoc = z.strictObject({ items: z.array(Expectation).max(MAX_ITEMS), defaults: Defaults });
export type ExpectationDoc = z.infer<typeof ExpectationDoc>;

export const emptyExpectations = (): ExpectationDoc => ({ items: [], defaults: true });

/** `{items?, defaults?}` or a bare array (shorthand for `{items}`); 400 with `{issues: [{path, message}]}` on error. */
export function parseExpectationPatch(input: unknown): ExpectationPatch {
  const parsed = ExpectationPatch.safeParse(Array.isArray(input) ? { items: input } : (input ?? {}));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({ path: formatPath(i.path) || '(root)', message: i.message }));
  throw new HttpError(400, `Invalid expectations: ${issues[0].path}: ${issues[0].message}`, { issues });
}

/** A full document from user input: items default to none, defaults to on. */
export function parseExpectations(input: unknown): ExpectationDoc {
  const p = parseExpectationPatch(input);
  return { items: p.items ?? [], defaults: p.defaults ?? true };
}

/** A stored document (the column defaults to '{}'); anything unreadable becomes the empty document. */
export function storedExpectations(v: unknown): ExpectationDoc {
  const parsed = ExpectationPatch.safeParse(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return parsed.success ? { items: parsed.data.items ?? [], defaults: parsed.data.defaults ?? true } : emptyExpectations();
}

/** Whether a default check is on for a document. */
export function defaultOn(doc: ExpectationDoc, name: DefaultCheckName): boolean {
  if (typeof doc.defaults === 'boolean') return doc.defaults;
  return doc.defaults[name] !== false;
}

/** Replace: the patch becomes the document. Append: add its items, overlay its defaults onto the current ones. */
export function mergeExpectations(cur: ExpectationDoc, patch: ExpectationPatch, append: boolean): ExpectationDoc {
  if (!append) return { items: patch.items ?? [], defaults: patch.defaults ?? true };
  const items = [...cur.items, ...(patch.items ?? [])];
  if (items.length > MAX_ITEMS) {
    const message = `at most ${MAX_ITEMS} expectations per run (the run has ${cur.items.length}, adding ${patch.items?.length ?? 0})`;
    throw new HttpError(400, `Invalid expectations: items: ${message}`, { issues: [{ path: 'items', message }] });
  }
  let defaults = cur.defaults;
  if (typeof patch.defaults === 'boolean') defaults = patch.defaults;
  else if (patch.defaults) {
    const base = Object.fromEntries(DEFAULT_CHECK_NAMES.map((n) => [n, defaultOn(cur, n)]));
    defaults = { ...base, ...patch.defaults };
  }
  return { items, defaults };
}

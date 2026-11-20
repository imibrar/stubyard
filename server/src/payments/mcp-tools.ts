/** MCP tools for payments (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface PaymentTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('devhub project slug, e.g. "hyper"');
const RUN = s('Test run key or id: limit to / attach to that run');
const PAYMENT = s('Payment id, or the provider reference (cs_test_…, TST…, PayPal order id)');
const OUTCOME = s(
  'success | decline[:generic|insufficient_funds|expired_card|incorrect_cvc|processing_error] | cancel | abandon | 3ds_success | 3ds_fail | pending_then_success, ' +
    'plus modifiers after "+": no_webhook, duplicate_webhook, webhook_delay=<ms>, no_redirect, slow=<ms>. E.g. "decline:insufficient_funds+webhook_delay=5000"',
);
const base = (a: Json) => `/api/projects/${enc(String(a.project))}`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const RO = { readOnlyHint: true, openWorldHint: false };

const brief = (p: Json) => ({
  id: p.id,
  instance: p.instance,
  preset: p.preset,
  providerRef: p.providerRef,
  status: p.status,
  providerStatus: p.providerStatus,
  amount: p.amountFormatted,
  reference: p.reference,
  outcome: p.outcome,
  outcomeVia: p.outcomeVia,
  method: p.method,
  card: p.cardBrand ? `${p.cardBrand} …${p.cardLast4}` : null,
  user: (p.user as Json | null)?.name ?? null,
  run: p.run,
  lint: p.lintLevel,
  pageUrl: p.pageUrl,
  createdAt: p.createdAt,
});

export const PAYMENT_MCP_TOOLS: PaymentTool[] = [
  {
    name: 'list_payments',
    description: 'List simulated payments (Stripe Checkout, PayTabs, PayPal) of a project, newest first. Filter by status (comma list), instance, user, run or your order reference.',
    inputSchema: obj({ project: PROJECT, status: s('e.g. "paid" or "failed,cancelled"'), instance: s('Payment provider slug'), user: s('Test user (id, email, name…)'), reference: s('Your order reference (client_reference_id / cart_id / reference_id)'), run: RUN, limit: n('Max results (default 20)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      const list = (await api('GET', `${base(a)}/payments${qs({ status: a.status, instance: a.instance, user: a.user, reference: a.reference, run: a.run, limit: a.limit ?? 20 })}`)) as Json[];
      return list.map(brief);
    },
  },
  {
    name: 'get_payment',
    description: 'One payment in detail: status, the provider-shaped object (session / transaction / order), timeline events, webhook attempts, refunds and lint findings.',
    inputSchema: obj({ project: PROJECT, payment: PAYMENT }, ['project', 'payment']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/payments/${enc(String(a.payment))}`),
  },
  {
    name: 'wait_for_payment',
    description: 'Wait (up to timeout_seconds, default 10, max 60) for the newest payment matching the filters, e.g. status "paid" for a run, after your test clicked through checkout.',
    inputSchema: obj({ project: PROJECT, status: s('Comma list, e.g. "paid,authorized"'), instance: s('Payment provider slug'), user: s('Test user'), reference: s('Order reference'), run: RUN, after: s('Only payments created after this ISO time'), timeout_seconds: n('Max wait (default 10, max 60)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/payments/wait`, { status: a.status, instance: a.instance, user: a.user, reference: a.reference, run: a.run, after: a.after, timeoutMs: Math.round(Number(a.timeout_seconds ?? 10) * 1000) })) as Json;
      return r.payment ? { timedOut: false, payment: brief(r.payment as Json), events: ((r.payment as Json).events as Json[] | undefined)?.map((e) => e.type) } : { timedOut: true, payment: null };
    },
  },
  {
    name: 'complete_payment',
    description:
      'Finish an open payment without a browser, as if the buyer used the hosted page: outcome (default success), optional test user, method (card, mada, stcpay, applepay, paypal) and card (test number or magic id: success, decline, insufficient_funds, expired_card, incorrect_cvc, processing_error, 3ds). ' +
      'Rules / X-Hub-Payment-Outcome still win. STC Pay: otp defaults to "auto". Returns the new status and the return URL the browser would get.',
    inputSchema: obj({ project: PROJECT, payment: PAYMENT, outcome: OUTCOME, user: s('Test user (id, email, name…)'), method: s('card | mada | stcpay | applepay | paypal'), card: s('Test card number or magic card id'), phone: s('STC Pay mobile number'), otp: s('STC Pay code ("auto" = accept)') }, ['project', 'payment']),
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/payments/${enc(String(a.payment))}/complete`, { outcome: a.outcome, user: a.user, method: a.method, card: a.card, phone: a.phone, otp: a.otp })) as Json;
      return { outcome: r.outcome, via: r.via, forced: r.forced, redirectUrl: r.redirectUrl, redirect: r.redirect, declined: r.declined, payment: brief(r.payment as Json) };
    },
  },
  {
    name: 'refund_payment',
    description: 'Refund a paid payment (full by default, or amount in minor units: 500 = 5.00). Sends the provider refund webhook. Refunding more than is left fails and is flagged by payment_lint.',
    inputSchema: obj({ project: PROJECT, payment: PAYMENT, amount: n('Minor units; omit for the full remaining amount'), reason: s('Optional reason') }, ['project', 'payment']),
    annotations: { destructiveHint: false },
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/payments/${enc(String(a.payment))}/refund`, { amount: a.amount, reason: a.reason })) as Json;
      return { refundId: r.refundId, amount: r.amountFormatted, payment: brief(r.payment as Json) };
    },
  },
  {
    name: 'set_payment_rule',
    description:
      'Force the outcome of the next payments: scoped to a run (run), a test user (user) or a provider instance (instance); count = how many payments (default: until removed), after = skip that many first, minutes = expiry. ' +
      'Precedence: X-Hub-Payment-Outcome header > run rule > user rule > instance rule > magic card > magic amount > page click / API > default.',
    inputSchema: obj({ project: PROJECT, outcome: OUTCOME, run: RUN, user: s('Test user'), instance: s('Payment provider slug'), count: n('Apply to this many payments'), after: n('Skip this many matching payments first'), minutes: n('Expire after N minutes'), label: s('Label') }, ['project', 'outcome']),
    run: async (a, { api }) => api('POST', `${base(a)}/payment-rules`, { outcome: a.outcome, run: a.run, user: a.user, instance: a.instance, count: a.count, after: a.after, minutes: a.minutes, label: a.label }),
  },
  {
    name: 'reset_payment_rules',
    description: 'Remove payment outcome rules: one rule (rule), a run\'s rules (run), a user\'s or an instance\'s rules, or (no filter) all rules of the project.',
    inputSchema: obj({ project: PROJECT, rule: s('One rule id'), run: RUN, user: s('Test user'), instance: s('Payment provider slug') }, ['project']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => (a.rule ? api('DELETE', `${base(a)}/payment-rules/${enc(String(a.rule))}`) : api('DELETE', `${base(a)}/payment-rules${qs({ run: a.run, user: a.user, instance: a.instance })}`)),
  },
  {
    name: 'resend_payment_webhook',
    description: 'Deliver a payment webhook again now (fresh attempt, signed like the provider): event = the event type (e.g. "checkout.session.completed", "callback", "PAYMENT.CAPTURE.COMPLETED") or a webhook row id from get_payment.',
    inputSchema: obj({ project: PROJECT, payment: PAYMENT, event: s('Event type or webhook row id') }, ['project', 'payment', 'event']),
    run: async (a, { api }) => api('POST', `${base(a)}/payments/${enc(String(a.payment))}/webhooks/resend`, { event: a.event }),
  },
  {
    name: 'payment_lint',
    description: 'Payment integration problems found so far (live keys, bad amounts / return URLs, missing idempotency keys, rejected webhooks, double capture, refunds over the amount, PayPal webhooks never verified, real card numbers typed). Optionally for one run.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/payments/lint${qs({ run: a.run })}`),
  },
];

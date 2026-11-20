/** MCP tools for PayPal subscriptions and disputes (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface Tool {
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
const PROJECT = s('stubyard project slug, e.g. "shop"');
const RUN = s('Test run key or id: limit to that run');
const SUB = s('Subscription id (I-…)');
const DISPUTE = s('Dispute id (PP-D-…)');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/payments`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const RO = { readOnlyHint: true, openWorldHint: false };
const brief = (x: Json) => {
  const { resource: _r, webhooks, ...rest } = x;
  return { ...rest, webhooks: (webhooks as Json[] | undefined)?.slice(-5) };
};

export const PAYPAL_EXTRAS_MCP_TOOLS: Tool[] = [
  {
    name: 'list_paypal_subscriptions',
    description: 'PayPal subscriptions (Subscriptions v1) the app created on the stubyard PayPal fake: status (APPROVAL_PENDING, ACTIVE, SUSPENDED, CANCELLED, EXPIRED), plan, next billing time on the subscription clock, cycles done, failed payments, outstanding balance, billed payments and recent webhooks.',
    inputSchema: obj({ project: PROJECT, status: s('Comma list, e.g. "ACTIVE,SUSPENDED"'), instance: s('PayPal instance slug'), run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/subscriptions${qs({ status: a.status, instance: a.instance, run: a.run })}`)) as Json[]).map(brief),
  },
  {
    name: 'bill_paypal_subscription',
    description: 'Bill PayPal subscription cycles without waiting: cycles (default 1) moves the subscription clock to each next_billing_time and bills it, or by ("+30d", "+1h") moves the clock and bills every cycle that became due. outcome "decline" makes the (first) charge fail: BILLING.SUBSCRIPTION.PAYMENT.FAILED, and SUSPENDED once payment_failure_threshold is reached. Success sends PAYMENT.SALE.COMPLETED.',
    inputSchema: obj({ project: PROJECT, subscription: SUB, cycles: n('Cycles to bill (1-120, default 1)'), by: s('Clock offset instead of cycles, e.g. "+30d"'), outcome: s('success | decline') }, ['project', 'subscription']),
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/subscriptions/${enc(String(a.subscription))}/advance`, { cycles: a.cycles, by: a.by, outcome: a.outcome })) as Json;
      return { billed: r.billed, clockOffsetMs: r.clockOffsetMs, subscription: brief(r.subscription as Json) };
    },
  },
  {
    name: 'set_paypal_subscription_status',
    description: 'Change a PayPal subscription the way PayPal or the buyer would (outside your app): suspend, activate (from SUSPENDED) or cancel. Sends BILLING.SUBSCRIPTION.SUSPENDED / ACTIVATED / CANCELLED to the instance webhook URL.',
    inputSchema: obj({ project: PROJECT, subscription: SUB, action: s('suspend | activate | cancel', { enum: ['suspend', 'activate', 'cancel'] }), reason: s('Status change note') }, ['project', 'subscription', 'action']),
    run: async (a, { api }) => brief((await api('POST', `${base(a)}/subscriptions/${enc(String(a.subscription))}/status`, { action: a.action, reason: a.reason })) as Json),
  },
  {
    name: 'open_paypal_dispute',
    description: 'The buyer opens a PayPal dispute on a captured PayPal payment (order capture or subscription sale): CUSTOMER.DISPUTE.CREATED goes to the app, which answers with /v1/customer/disputes/<id>/make-offer, accept-claim, provide-evidence, escalate…',
    inputSchema: obj(
      {
        project: PROJECT,
        payment: s('stubyard payment id or PayPal order id of a paid PayPal payment'),
        reason: s('MERCHANDISE_OR_SERVICE_NOT_RECEIVED (default), MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED, UNAUTHORISED, CREDIT_NOT_PROCESSED, DUPLICATE_TRANSACTION, INCORRECT_AMOUNT, PAYMENT_BY_OTHER_MEANS, CANCELED_RECURRING_BILLING, PROBLEM_WITH_REMITTANCE, OTHER'),
        amount: s('Disputed amount, e.g. "10.00" (default: what is left on the payment)'),
        stage: s('INQUIRY (default) or CHARGEBACK', { enum: ['INQUIRY', 'CHARGEBACK'] }),
        message: s('The buyer\'s first message'),
      },
      ['project', 'payment'],
    ),
    run: async (a, { api }) => brief((await api('POST', `${base(a)}/${enc(String(a.payment))}/dispute`, { reason: a.reason, amount: a.amount, stage: a.stage, message: a.message })) as Json),
  },
  {
    name: 'list_paypal_disputes',
    description: 'PayPal disputes of a project: status, stage, reason, amount, refunded, outcome, the actions your app may still take, offer history, messages and recent webhooks.',
    inputSchema: obj({ project: PROJECT, status: s('Comma list, e.g. "WAITING_FOR_SELLER_RESPONSE,UNDER_REVIEW"'), payment: s('Only disputes of this payment id'), run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/disputes${qs({ status: a.status, payment: a.payment, run: a.run })}`)) as Json[]).map(brief),
  },
  {
    name: 'act_on_paypal_dispute',
    description: 'Move a PayPal dispute as the buyer or PayPal would: buyer actions accept-offer, deny-offer, send-message, escalate; or resolve with outcome buyer (refunds the disputed amount), seller or cancelled. Sends CUSTOMER.DISPUTE.UPDATED / RESOLVED.',
    inputSchema: obj({ project: PROJECT, dispute: DISPUTE, action: s('accept-offer | deny-offer | send-message | escalate | resolve', { enum: ['accept-offer', 'deny-offer', 'send-message', 'escalate', 'resolve'] }), outcome: s('For resolve: buyer | seller | cancelled'), note: s('Buyer note / message') }, ['project', 'dispute', 'action']),
    run: async (a, { api }) => {
      const id = enc(String(a.dispute));
      if (a.action === 'resolve') return brief((await api('POST', `${base(a)}/disputes/${id}/resolve`, { outcome: a.outcome ?? 'buyer' })) as Json);
      return brief((await api('POST', `${base(a)}/disputes/${id}/buyer`, { action: a.action, note: a.note, message: a.note })) as Json);
    },
  },
];

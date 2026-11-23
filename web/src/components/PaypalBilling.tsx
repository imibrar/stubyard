import { Fragment, useState } from 'react';
import { api } from '../api';
import { useGate } from '../auth';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { payBase, type Payment } from '../paymentsApi';
import { Menu } from './people';
import { RunChip } from './RunChip';
import { Badge, Empty, ErrorBox, fmtDateTime, timeAgo, useToast } from './ui';
import '../styles/paypal-billing.css';

/**
 * PayPal subscriptions and disputes the app created on the stubyard PayPal fake (Subscriptions v1, Disputes v1):
 * bill cycles now, move a subscription's clock, change status as PayPal / the buyer would, open a dispute on a captured
 * payment and play the buyer or PayPal in it. Mounted as a tab of the Payments page.
 */

interface Webhook {
  type: string;
  eventId: string;
  at: string;
  ok?: boolean;
  status?: number | null;
  error?: string;
  queued?: boolean;
  attempt?: number;
}
interface Subscription {
  id: string;
  instance: string;
  status: string;
  planId: string;
  planName: string | null;
  productName: string | null;
  quantity: string;
  customId: string | null;
  subscriber: { email_address?: string; name?: { given_name?: string; surname?: string } };
  currency: string;
  nextAmount: string | null;
  nextBillingTime: string | null;
  clockOffsetMs: number;
  now: string;
  cycles: { sequence: number; tenureType: string; completed: number; total: number; frequency: string }[];
  failedCount: number;
  failureThreshold: number;
  outstanding: string;
  approvalUrl: string | null;
  payments: { id: string; saleId: string; status: string; amount: string; currency: string; createdAt: string }[];
  webhooks: Webhook[];
  run: string | null;
  statusNote: string | null;
  createdAt: string;
}
interface Dispute {
  id: string;
  instance: string;
  status: string;
  state: string;
  stage: string;
  reason: string;
  amount: string;
  refunded: string;
  currency: string;
  outcome: string | null;
  paymentId: string | null;
  paymentStatus: string | null;
  sellerTransactionId: string;
  allowed: string[];
  buyerCan: string[];
  offer: { offer_type?: string; seller_offered_amount?: { value: string } } | null;
  returnPending: boolean;
  messages: { posted_by: string; time_posted: string; content: string }[];
  webhooks: Webhook[];
  run: string | null;
  createdAt: string;
}
interface Plan {
  id: string;
  instance: string;
  status: string;
  name: string;
  productName: string | null;
  currency: string;
  cycles: { tenure_type: string; total_cycles: number; frequency: { interval_unit: string; interval_count: number }; pricing_scheme?: { fixed_price?: { value: string } } }[];
  subscriptions: number;
}

const SUB_KIND: Record<string, string> = { APPROVAL_PENDING: 'accent', APPROVED: 'accent', ACTIVE: 'ok', SUSPENDED: 'warn', CANCELLED: '', EXPIRED: '' };
const DISPUTE_KIND: Record<string, string> = { WAITING_FOR_SELLER_RESPONSE: 'warn', WAITING_FOR_BUYER_RESPONSE: 'accent', UNDER_REVIEW: 'accent', RESOLVED: '', OPEN: 'warn' };
const REASONS = ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'UNAUTHORISED', 'CREDIT_NOT_PROCESSED', 'DUPLICATE_TRANSACTION', 'INCORRECT_AMOUNT', 'PAYMENT_BY_OTHER_MEANS', 'CANCELED_RECURRING_BILLING', 'PROBLEM_WITH_REMITTANCE', 'OTHER'];
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const days = (ms: number) => (ms ? `+${Math.round(ms / 86_400_000)}d` : '');

function Hooks({ list }: { list: Webhook[] }) {
  if (!list.length) return <p className="small faint">No webhooks yet.</p>;
  return (
    <ul className="ppb-hooks">
      {list
        .slice()
        .reverse()
        .map((w, i) => (
          <li key={`${w.eventId}-${w.attempt ?? 0}-${i}`}>
            <Badge kind={w.queued ? 'accent' : w.ok ? 'ok' : 'bad'}>{w.queued ? 'queued' : w.ok ? (w.status ?? 'ok') : (w.status ?? 'failed')}</Badge>
            <code className="ppb-ev">{w.type}</code>
            <span className="small faint">
              {timeAgo(w.at)}
              {(w.attempt ?? 1) > 1 ? ` · attempt ${w.attempt}` : ''}
            </span>
            {!w.ok && w.error && <span className="small bad-text">{w.error}</span>}
          </li>
        ))}
    </ul>
  );
}

export function PaypalBilling({ slug }: { slug: string }) {
  const toast = useToast();
  const g = useGate(slug)('walkthroughs.run');
  const base = `${payBase(slug)}/payments`;
  const subs = useFetch<Subscription[]>(`${base}/subscriptions`, [slug]);
  const disputes = useFetch<Dispute[]>(`${base}/disputes`, [slug]);
  const plans = useFetch<Plan[]>(`${base}/plans`, [slug]);
  const paid = useFetch<Payment[]>(`${base}?status=paid,partially_refunded&limit=100`, [slug]);
  const reload = useDebounced(() => {
    void subs.reload();
    void disputes.reload();
    void plans.reload();
    void paid.reload();
  }, 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset' || e.type === 'runs.changed') reload();
  });
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ payment: '', reason: REASONS[0]!, amount: '', stage: 'INQUIRY', message: '' });
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(label);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const subAct = (s: Subscription, path: string, body: unknown, label: string) => run(label, () => api.post(`${base}/subscriptions/${encodeURIComponent(s.id)}/${path}`, body));
  const dispAct = (d: Dispute, path: string, body: unknown, label: string) => run(label, () => api.post(`${base}/disputes/${encodeURIComponent(d.id)}/${path}`, body));
  const openDispute = async () => {
    setError(null);
    try {
      await api.post(`${base}/${encodeURIComponent(form.payment)}/dispute`, { reason: form.reason, amount: form.amount || undefined, stage: form.stage, message: form.message || undefined });
      toast('Dispute opened');
      setForm({ ...form, payment: '', amount: '', message: '' });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const disputable = (paid.data ?? []).filter((p) => p.preset === 'paypal' && !(disputes.data ?? []).some((d) => d.paymentId === p.id && d.status !== 'RESOLVED'));
  const sl = subs.data ?? [];
  const dl = disputes.data ?? [];

  return (
    <div className="stack ppb">
      <div className="card">
        <div className="card-head">
          <h3>
            PayPal subscriptions <span className="faint">({sl.length})</span>
          </h3>
        </div>
        <ErrorBox error={subs.error} />
        {!sl.length ? (
          <Empty title="No subscriptions yet">
            <p className="small muted">
              Your app creates them with POST /v1/catalogs/products, /v1/billing/plans and /v1/billing/subscriptions on the PayPal instance, then sends the buyer to the "approve" link. Cycles after the first are billed at next_billing_time; use "Bill now" or "Advance" here instead of waiting a month.
            </p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="ppb-table">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th>Status</th>
                  <th>Next billing</th>
                  <th>Cycles</th>
                  <th>Failed / owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sl.map((s) => {
                  const done = s.cycles.reduce((n, c) => n + c.completed, 0);
                  const total = s.cycles.some((c) => c.total === 0) ? '∞' : String(s.cycles.reduce((n, c) => n + c.total, 0));
                  const isOpen = open === s.id;
                  return (
                    <Fragment key={s.id}>
                      <tr className="ppb-row" onClick={() => setOpen(isOpen ? null : s.id)}>
                        <td data-label="Subscription">
                          <button type="button" className="linklike mono" aria-expanded={isOpen} onClick={(e) => (e.stopPropagation(), setOpen(isOpen ? null : s.id))}>
                            {s.id}
                          </button>
                          <div className="small faint">
                            {s.planName ?? s.planId}
                            {s.productName ? ` · ${s.productName}` : ''} · {s.instance}
                          </div>
                          {s.run && <RunChip runKey={s.run} />}
                        </td>
                        <td data-label="Status">
                          <Badge kind={SUB_KIND[s.status]}>{human(s.status)}</Badge>
                          {s.statusNote && <div className="small faint ppb-note">{s.statusNote}</div>}
                        </td>
                        <td data-label="Next billing" className="small">
                          {s.nextBillingTime ? (
                            <>
                              {s.nextAmount} {s.currency}
                              <div className="faint nowrap" title={s.nextBillingTime}>
                                {fmtDateTime(s.nextBillingTime)}
                              </div>
                            </>
                          ) : (
                            <span className="faint">none</span>
                          )}
                          {s.clockOffsetMs > 0 && <div className="faint">clock {days(s.clockOffsetMs)}</div>}
                        </td>
                        <td data-label="Cycles" className="small nowrap">
                          {done} / {total}
                        </td>
                        <td data-label="Failed / owed" className="small nowrap">
                          {s.failedCount}
                          {s.failureThreshold > 0 ? ` of ${s.failureThreshold}` : ''} · {s.outstanding} {s.currency}
                        </td>
                        <td className="ppb-actions" onClick={(e) => e.stopPropagation()}>
                          <Menu floating className="btn sm" label="Actions ▾">
                            {(close) => (
                              <>
                                {s.status === 'ACTIVE' && (
                                  <>
                                    <button {...g} onClick={() => (close(), void subAct(s, 'advance', { cycles: 1 }, 'Next cycle billed'))}>Bill next cycle now</button>
                                    <button {...g} onClick={() => (close(), void subAct(s, 'advance', { cycles: 1, outcome: 'decline' }, 'Next cycle declined'))}>Bill next cycle, declined</button>
                                    <button {...g} onClick={() => (close(), void subAct(s, 'advance', { by: '+30d' }, 'Clock moved 30 days'))}>Advance clock 30 days</button>
                                    <button {...g} onClick={() => (close(), void subAct(s, 'outcomes', { outcomes: ['decline'] }, 'Next billing will decline'))}>Decline the next scheduled billing</button>
                                    <button {...g} onClick={() => (close(), void subAct(s, 'status', { action: 'suspend', reason: 'Suspended by PayPal (stubyard)' }, 'Suspended'))}>Suspend</button>
                                  </>
                                )}
                                {s.status === 'SUSPENDED' && <button {...g} onClick={() => (close(), void subAct(s, 'status', { action: 'activate', reason: 'Reactivated (stubyard)' }, 'Activated'))}>Activate</button>}
                                {['ACTIVE', 'SUSPENDED', 'APPROVED'].includes(s.status) && <button {...g} onClick={() => (close(), void subAct(s, 'status', { action: 'cancel', reason: 'Cancelled by the buyer (stubyard)' }, 'Cancelled'))}>Cancel as the buyer</button>}
                                {s.approvalUrl && (
                                  <a role="menuitem" href={s.approvalUrl} target="_blank" rel="noreferrer" onClick={() => close()}>
                                    Open approval page
                                  </a>
                                )}
                                {!['ACTIVE', 'SUSPENDED', 'APPROVED'].includes(s.status) && !s.approvalUrl && <span className="small faint ppb-none">No actions ({human(s.status)})</span>}
                              </>
                            )}
                          </Menu>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="ppb-detail">
                          <td colSpan={6}>
                            <div className="ppb-grid">
                              <div>
                                <h4>Billing</h4>
                                <ul className="ppb-kv small">
                                  <li>
                                    Subscriber: {[s.subscriber.name?.given_name, s.subscriber.name?.surname].filter(Boolean).join(' ') || '—'} {s.subscriber.email_address ? `<${s.subscriber.email_address}>` : ''}
                                  </li>
                                  {s.customId && <li>custom_id: <code>{s.customId}</code></li>}
                                  <li>Subscription clock: {fmtDateTime(s.now)}</li>
                                  {s.cycles.map((c) => (
                                    <li key={c.sequence}>
                                      {c.sequence}. {human(c.tenureType)} every {c.frequency.toLowerCase()}: {c.completed} / {c.total || '∞'}
                                    </li>
                                  ))}
                                </ul>
                                <h4>Charges</h4>
                                {!s.payments.length ? (
                                  <p className="small faint">None yet.</p>
                                ) : (
                                  <ul className="ppb-kv small">
                                    {s.payments.map((p) => (
                                      <li key={p.id}>
                                        <Badge kind={p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'bad' : 'warn'}>{human(p.status)}</Badge> {p.amount} {p.currency} <code>{p.saleId}</code> <span className="faint">{timeAgo(p.createdAt)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              <div>
                                <h4>Webhooks</h4>
                                <Hooks list={s.webhooks} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            PayPal disputes <span className="faint">({dl.length})</span>
          </h3>
        </div>
        <ErrorBox error={disputes.error} />
        {!dl.length ? (
          <Empty title="No disputes">
            <p className="small muted">Open one below on a captured PayPal payment. Your app gets CUSTOMER.DISPUTE.CREATED and answers on /v1/customer/disputes/&lt;id&gt;/make-offer, accept-claim, provide-evidence or escalate.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="ppb-table">
              <thead>
                <tr>
                  <th>Dispute</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Amount</th>
                  <th>Your app may</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dl.map((d) => {
                  const isOpen = open === d.id;
                  return (
                    <Fragment key={d.id}>
                      <tr className="ppb-row" onClick={() => setOpen(isOpen ? null : d.id)}>
                        <td data-label="Dispute">
                          <button type="button" className="linklike mono" aria-expanded={isOpen} onClick={(e) => (e.stopPropagation(), setOpen(isOpen ? null : d.id))}>
                            {d.id}
                          </button>
                          <div className="small faint">
                            {human(d.stage)} · {d.instance} · {timeAgo(d.createdAt)}
                          </div>
                          {d.run && <RunChip runKey={d.run} />}
                        </td>
                        <td data-label="Status">
                          <Badge kind={DISPUTE_KIND[d.status]}>{human(d.status)}</Badge>
                          {d.outcome && <div className="small faint">{human(d.outcome)}</div>}
                        </td>
                        <td data-label="Reason" className="small">
                          {human(d.reason)}
                        </td>
                        <td data-label="Amount" className="small nowrap">
                          {d.amount} {d.currency}
                          {d.refunded !== '0.00' && <div className="faint">refunded {d.refunded}</div>}
                        </td>
                        <td data-label="Your app may" className="small">
                          {d.allowed.length ? d.allowed.join(', ') : <span className="faint">nothing</span>}
                        </td>
                        <td className="ppb-actions" onClick={(e) => e.stopPropagation()}>
                          <Menu floating className="btn sm" label="Actions ▾">
                            {(close) => (
                              <>
                                {d.buyerCan.includes('accept-offer') && (
                                  <button {...g} onClick={() => (close(), void dispAct(d, 'buyer', { action: 'accept-offer', note: 'Offer accepted' }, 'Buyer accepted the offer'))}>
                                    Buyer accepts the offer{d.offer?.seller_offered_amount ? ` (${d.offer.seller_offered_amount.value})` : ''}
                                  </button>
                                )}
                                {d.buyerCan.includes('deny-offer') && <button {...g} onClick={() => (close(), void dispAct(d, 'buyer', { action: 'deny-offer', note: 'Not enough' }, 'Buyer denied the offer'))}>Buyer denies the offer</button>}
                                {d.buyerCan.includes('escalate') && <button {...g} onClick={() => (close(), void dispAct(d, 'buyer', { action: 'escalate', note: 'Escalated to a claim' }, 'Escalated'))}>Buyer escalates to a claim</button>}
                                {d.buyerCan.includes('send-message') && <button {...g} onClick={() => (close(), void dispAct(d, 'buyer', { action: 'send-message', message: 'Any update on this?' }, 'Message sent'))}>Buyer sends a message</button>}
                                {d.status === 'UNDER_REVIEW' && <button {...g} onClick={() => (close(), void dispAct(d, 'merchant', { action: 'require-evidence', input: { action: 'SELLER_EVIDENCE' } }, 'Evidence requested'))}>PayPal asks the seller for evidence</button>}
                                {d.status !== 'RESOLVED' && (
                                  <>
                                    <button {...g} onClick={() => (close(), void dispAct(d, 'resolve', { outcome: 'buyer' }, 'Resolved for the buyer'))}>Resolve for the buyer (refund)</button>
                                    <button {...g} onClick={() => (close(), void dispAct(d, 'resolve', { outcome: 'seller' }, 'Resolved for the seller'))}>Resolve for the seller</button>
                                    <button {...g} onClick={() => (close(), void dispAct(d, 'resolve', { outcome: 'cancelled' }, 'Cancelled by the buyer'))}>Buyer cancels the dispute</button>
                                  </>
                                )}
                                {d.status === 'RESOLVED' && <span className="small faint ppb-none">Resolved</span>}
                              </>
                            )}
                          </Menu>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="ppb-detail">
                          <td colSpan={6}>
                            <div className="ppb-grid">
                              <div>
                                <h4>Messages</h4>
                                <ul className="ppb-kv small">
                                  {d.messages.map((m, i) => (
                                    <li key={i}>
                                      <Badge kind={m.posted_by === 'BUYER' ? 'warn' : m.posted_by === 'SELLER' ? 'accent' : ''}>{human(m.posted_by)}</Badge> {m.content} <span className="faint">{timeAgo(m.time_posted)}</span>
                                    </li>
                                  ))}
                                </ul>
                                <p className="small faint">
                                  Transaction <code>{d.sellerTransactionId}</code>
                                  {d.paymentStatus ? ` · payment ${human(d.paymentStatus)}` : ''}
                                  {d.returnPending ? ' · waiting for acknowledge-return-item' : ''}
                                </p>
                              </div>
                              <div>
                                <h4>Webhooks</h4>
                                <Hooks list={d.webhooks} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Open a dispute as the buyer</h3>
        </div>
        <div className="card-pad form">
          <ErrorBox error={error ?? paid.error} />
          <div className="form form-2">
            <label className="field">
              Captured PayPal payment
              <select value={form.payment} onChange={(e) => setForm({ ...form, payment: e.target.value })}>
                <option value="">{disputable.length ? 'Choose a payment…' : 'No captured PayPal payment without an open dispute'}</option>
                {disputable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.amountFormatted} · {p.providerRef} · {timeAgo(p.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Reason
              <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {human(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Amount <span className="hint">empty = what is left on the payment</span>
              <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="e.g. 10.00" />
            </label>
            <label className="field">
              Stage
              <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                <option value="INQUIRY">Inquiry (buyer and seller talk first)</option>
                <option value="CHARGEBACK">Chargeback / claim (PayPal reviews)</option>
              </select>
            </label>
            <label className="field ppb-wide">
              Buyer's message <span className="hint">optional</span>
              <input value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="I have not received the item." />
            </label>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!form.payment || !!g.disabled} title={g.title} onClick={() => void openDispute()}>
              Open dispute
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            Billing plans <span className="faint">({(plans.data ?? []).length})</span>
          </h3>
        </div>
        <ErrorBox error={plans.error} />
        {!(plans.data ?? []).length ? (
          <Empty title="No plans">
            <p className="small muted">Plans appear when your app calls POST /v1/billing/plans.</p>
          </Empty>
        ) : (
          <ul className="ppb-plans">
            {(plans.data ?? []).map((p) => (
              <li key={p.id}>
                <div className="ppb-plan-head">
                  <strong>{p.name}</strong> <Badge kind={p.status === 'ACTIVE' ? 'ok' : ''}>{human(p.status)}</Badge>
                </div>
                <div className="small faint">
                  <code>{p.id}</code> · {p.productName ?? '—'} · {p.instance} · {p.subscriptions} subscription{p.subscriptions === 1 ? '' : 's'}
                </div>
                <div className="small">
                  {(p.cycles ?? [])
                    .map((c) => `${human(c.tenure_type)} ${c.pricing_scheme?.fixed_price?.value ?? 'tiered'} ${p.currency} every ${c.frequency.interval_count} ${c.frequency.interval_unit.toLowerCase()} × ${c.total_cycles || '∞'}`)
                    .join(' → ')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

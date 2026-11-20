import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/people';
import { PaymentExtras } from '../components/PaymentExtras';
import { PaymentRulesPanel } from '../components/PaymentRules';
import { providersPath } from '../components/providerLayout';
import { RunChip } from '../components/RunChip';
import { Badge, CodeBlock, Empty, ErrorBox, fmtDateTime, Modal, timeAgo, timeUntil, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  LINT_KIND,
  payBase,
  QUICK_OUTCOMES,
  STATUS_KIND,
  fmtMinor,
  toMinor,
  type DeliverResult,
  type Payment,
  type PaymentEvent,
  type PaymentInstance,
  type PaymentLintReport,
  type PaymentStatus,
} from '../paymentsApi';
import { Page } from './ProjectPage';
import '../styles/payments.css';

/** /p/:slug/payments — payments made against the fake gateways: list, detail timeline, webhooks, rules, lint. */
export default function PaymentsPage() {
  return (
    <Routes>
      <Route index element={<PaymentsHome />} />
      <Route path=":id" element={<PaymentDetailPage />} />
    </Routes>
  );
}

type Tab = 'payments' | 'rules' | 'lint';
const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'created,pending,requires_action', label: 'Open' },
  { id: 'paid,authorized', label: 'Paid' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled,expired', label: 'Cancelled / expired' },
  { id: 'refunded,partially_refunded', label: 'Refunded' },
];

const statusText = (s: string) => s.replace(/_/g, ' ');

/** A check id (pay.no-webhook-url) that may wrap only after "." or "-", never inside a word. */
function CheckId({ id }: { id: string }) {
  return (
    <code className="small pay-check">
      {id.split(/(?<=[.-])/).map((part, i) => (
        <span key={i}>
          {i > 0 && <wbr />}
          {part}
        </span>
      ))}
    </code>
  );
}

function PaymentsHome() {
  const { slug } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'payments';
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'payments') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );
  const lint = useFetch<PaymentLintReport>(`${payBase(slug)}/payments/lint`, [slug]);
  const reloadLint = useDebounced(() => void lint.reload(), 300);
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset') reloadLint();
  });
  const lintN = (lint.data?.counts.error ?? 0) + (lint.data?.counts.warn ?? 0);
  return (
    <Page
      title="Payments"
      description="Checkouts your app started on the fake Stripe, PayTabs and PayPal gateways: status, the webhooks stubyard sent, refunds and integration problems. Add a gateway under Providers → Payments."
      actions={
        <Link className="btn" to={providersPath(slug, 'payments')}>
          <Icon name="plug" size={14} /> Payment providers
        </Link>
      }
    >
      <div className="tabs pay-tabs" role="tablist">
        {(['payments', 'rules', 'lint'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'payments' ? 'Payments' : t === 'rules' ? 'Outcome rules' : 'Integration checks'}
            {t === 'lint' && lintN > 0 && <span className="tab-n">{lintN}</span>}
          </button>
        ))}
      </div>
      {tab === 'payments' && <PaymentList />}
      {tab === 'rules' && (
        <div className="stack">
          <PaymentRulesPanel slug={slug} />
        </div>
      )}
      {tab === 'lint' && <LintPanel report={lint.data} error={lint.error} />}
    </Page>
  );
}

function PaymentList() {
  const { slug } = useProject();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const instance = params.get('instance') ?? '';
  const [q, setQ] = useState(params.get('reference') ?? '');
  const setParam = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (instance) query.set('instance', instance);
  if (params.get('reference')) query.set('reference', params.get('reference')!);
  const list = useFetch<Payment[]>(`${payBase(slug)}/payments?${query.toString()}`, [slug, query.toString()]);
  const instances = useFetch<PaymentInstance[]>(`${payBase(slug)}/payment-instances`, [slug]);
  const reload = useDebounced(() => {
    void list.reload();
    void instances.reload();
  }, 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset' || e.type === 'runs.changed') reload();
  });
  useTick(30_000);
  const rows = list.data ?? [];
  const noInstances = instances.data && !instances.data.length;
  return (
    <>
      <div className="pay-filter">
        <div className="chips" role="tablist">
          {STATUS_FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={status === f.id} className={`chip ${status === f.id ? 'active' : ''}`} onClick={() => setParam('status', f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="row pay-filter-fields">
          <select value={instance} onChange={(e) => setParam('instance', e.target.value)} aria-label="Payment provider">
            <option value="">All providers</option>
            {(instances.data ?? []).map((i) => (
              <option key={i.id} value={i.slug}>
                {i.name}
              </option>
            ))}
          </select>
          <form
            className="row nowrap pay-search"
            onSubmit={(e) => {
              e.preventDefault();
              setParam('reference', q.trim());
            }}
          >
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order reference" aria-label="Order reference" />
            <button className="btn" type="submit">
              Find
            </button>
          </form>
        </div>
      </div>
      <ErrorBox error={list.error} />
      <div className="card pay-cq">
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title={noInstances ? 'No payment providers yet' : 'No payments'}>
            {noInstances ? (
              <>
                <p className="small muted">Add a fake Stripe Checkout, PayTabs or PayPal gateway and point your app at it.</p>
                <Link className="btn primary" to={providersPath(slug, 'payments')}>
                  Add a payment provider
                </Link>
              </>
            ) : (
              <p className="small muted">Payments appear here when your app creates a checkout on one of the fake gateways.</p>
            )}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="pay-table">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => nav(p.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(p.id)}>
                    <td className="nowrap">
                      <Link to={p.id} className="pay-amount" onClick={(e) => e.stopPropagation()}>
                        {p.amountFormatted}
                      </Link>
                      {p.refunded > 0 && <div className="small faint">refunded {fmtMinor(p.refunded, p.currency)}</div>}
                    </td>
                    <td>
                      <div className="row pay-chips">
                        <Badge kind={STATUS_KIND[p.status]}>{statusText(p.status)}</Badge>
                        {p.lintLevel && (
                          <Badge kind={LINT_KIND[p.lintLevel]} title={p.lint.map((l) => l.message).join('\n')}>
                            {p.lint.length} check{p.lint.length === 1 ? '' : 's'}
                          </Badge>
                        )}
                        {p.run && <RunChip runKey={p.run} />}
                      </div>
                      {p.outcome && <div className="small faint">{p.outcome}{p.outcomeVia ? ` · ${p.outcomeVia}` : ''}</div>}
                    </td>
                    <td>
                      <div className="small">{p.instance}</div>
                      <code className="small faint pay-ref pay-ref-cut" title={p.providerRef}>
                        {p.providerRef}
                      </code>
                    </td>
                    <td className="small">{p.reference ?? <span className="faint">none</span>}</td>
                    <td className="small">
                      {p.user?.name ?? p.customerEmail ?? <span className="faint">guest</span>}
                      {p.cardLast4 && <div className="faint">{p.cardBrand} •••• {p.cardLast4}</div>}
                      {!p.cardLast4 && p.method && <div className="faint">{p.method}</div>}
                    </td>
                    <td className="small faint nowrap" title={fmtDateTime(p.createdAt)}>
                      {timeAgo(p.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function LintPanel({ report, error }: { report: PaymentLintReport | null; error: string | null }) {
  if (error) return <ErrorBox error={error} />;
  if (!report) return <p className="muted">Loading…</p>;
  return (
    <div className="card pay-cq">
      <div className="card-head">
        <h3>
          {report.findings.length} finding{report.findings.length === 1 ? '' : 's'} in {report.payments} payment{report.payments === 1 ? '' : 's'}
        </h3>
        <div className="row pay-chips">
          {(['error', 'warn', 'info'] as const).map((s) =>
            report.counts[s] ? (
              <Badge key={s} kind={LINT_KIND[s]}>
                {report.counts[s]} {s}
              </Badge>
            ) : null,
          )}
        </div>
      </div>
      {!report.findings.length ? (
        <Empty title="No problems found">
          <p className="small muted">Checks: live keys, missing webhook URL, webhook rejected by your app, no order reference, PayPal signature never verified, amount mistakes and more.</p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="pay-lint">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Check</th>
                <th>Message</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {report.findings.map((f, i) => (
                <tr key={i}>
                  <td>
                    <Badge kind={LINT_KIND[f.severity]}>{f.severity}</Badge>
                  </td>
                  <td>
                    <CheckId id={f.check} />
                  </td>
                  <td className="small pay-lint-msg">{f.message}</td>
                  <td className="small nowrap pay-lint-where">{f.payment ? <Link to={f.payment}>payment</Link> : f.instance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- detail ----------------

const EVENT_LABEL: Record<string, string> = {
  created: 'Created',
  page_opened: 'Hosted page opened',
  status: 'Status changed',
  outcome: 'Outcome decided',
  webhook_scheduled: 'Webhook planned',
  webhook_queued: 'Webhook queued',
  webhook_delivered: 'Webhook delivered',
  webhook_failed: 'Webhook failed',
  webhook_skipped: 'Webhook skipped',
  refund: 'Refunded',
  paypal_signature_verified: 'PayPal signature verified',
  authorized: 'Authorized',
  reauthorized: 'Reauthorized',
  captured: 'Captured',
  voided: 'Voided',
  vaulted: 'Saved to vault',
  payer_action_required: 'Buyer action required (3DS)',
  challenge_opened: '3DS challenge opened',
  status_queried: 'Result queried',
  widget_loaded: 'Widget script loaded',
  hyperpay_cp: 'Backoffice capture (CP)',
  hyperpay_rv: 'Backoffice reversal (RV)',
  hyperpay_rf: 'Backoffice refund (RF)',
};

function eventSummary(e: PaymentEvent): string {
  const d = e.data;
  switch (e.type) {
    case 'status':
      return `${statusText(String(d.from))} → ${statusText(String(d.to))}`;
    case 'webhook_scheduled':
    case 'webhook_queued':
      return `${String(d.eventType)}${d.delayMs || d.inMs ? ` in ${Number(d.delayMs ?? d.inMs)} ms` : ''}${d.attempt ? ` (attempt ${String(d.attempt)})` : ''}`;
    case 'webhook_delivered':
      return `${String(d.eventType)} → HTTP ${String(d.status)} (attempt ${String(d.attempt)})`;
    case 'webhook_failed':
      return `${String(d.eventType)}: ${String(d.error ?? d.status)} (attempt ${String(d.attempt)})`;
    case 'webhook_skipped':
      return `${String(d.eventType)}: ${String(d.reason)}`;
    case 'created':
      return d.presetOutcome ? `forced outcome ${String(d.presetOutcome)}` : '';
    default: {
      const keys = Object.entries(d).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
      return keys
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' · ');
    }
  }
}

function PaymentDetailPage() {
  const { slug } = useProject();
  const { id = '' } = useParams();
  const toast = useToast();
  const p = useFetch<Payment>(`${payBase(slug)}/payments/${id}`, [slug, id]);
  const reload = useDebounced(() => void p.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset') reload();
  });
  const [modal, setModal] = useState<'complete' | 'refund' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const base = `${payBase(slug)}/payments/${id}`;

  const act = async (key: string, fn: () => Promise<unknown>, msg?: (r: unknown) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (msg) toast(msg(r));
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const crumbs = (
    <Link to=".." relative="path" className="small">
      ← All payments
    </Link>
  );
  if (p.error && !p.data)
    return (
      <Page title="Payment">
        {crumbs}
        <ErrorBox error={p.error} />
      </Page>
    );
  if (!p.data)
    return (
      <Page title="Payment">
        <p className="muted">Loading…</p>
      </Page>
    );
  const pay = p.data;
  const events = pay.events ?? [];
  const isOpen = ['created', 'pending', 'requires_action'].includes(pay.status) || pay.status === 'failed';
  const canRefund = ['paid', 'partially_refunded'].includes(pay.status);
  const hooks = events.filter((e) => e.type === 'webhook_scheduled' && !e.data.silent);
  const attempts = (row: string) => events.filter((e) => (e.type === 'webhook_delivered' || e.type === 'webhook_failed') && e.data.scheduled === row);
  return (
    <Page
      title={`Payment ${pay.amountFormatted}`}
      description={
        <>
          {pay.instance} · <code className="pay-ref">{pay.providerRef}</code>
          {pay.reference ? <> · order {pay.reference}</> : null}
        </>
      }
      actions={
        <>
          {isOpen && (
            <button className="btn primary" onClick={() => setModal('complete')}>
              Complete as…
            </button>
          )}
          {canRefund && (
            <button className="btn" onClick={() => setModal('refund')}>
              Refund…
            </button>
          )}
          {['created', 'pending', 'requires_action'].includes(pay.status) && (
            <button className="btn" disabled={busy === 'expire'} onClick={() => void act('expire', () => api.post(`${base}/expire`), () => 'Expired')}>
              Expire
            </button>
          )}
          <a className="btn" href={pay.pageUrl} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} /> Hosted page
          </a>
        </>
      }
    >
      <div className="stack">
        {crumbs}
        <div className="pay-detail-grid">
          <div className="card">
            <div className="card-head">
              <h3>Summary</h3>
              <div className="row pay-chips">
                <Badge kind={STATUS_KIND[pay.status as PaymentStatus]}>{statusText(pay.status)}</Badge>
                <Badge title="What the provider API reports">{pay.providerStatus}</Badge>
                {pay.run && <RunChip runKey={pay.run} />}
              </div>
            </div>
            <dl className="kv card-pad pay-kv">
              <dt>Amount</dt>
              <dd>
                {pay.amountFormatted} <span className="faint small">({pay.amount} minor units)</span>
                {pay.refunded > 0 && <div className="small">refunded {fmtMinor(pay.refunded, pay.currency)}</div>}
              </dd>
              <dt>Outcome</dt>
              <dd>
                {pay.outcome ? <code>{pay.outcome}</code> : <span className="faint">not decided</span>}
                {pay.outcomeVia && <span className="faint small"> via {pay.outcomeVia}</span>}
                {pay.presetOutcome && <div className="small faint">forced at create: {pay.presetOutcome}</div>}
              </dd>
              <dt>Method</dt>
              <dd>
                {pay.method ?? <span className="faint">—</span>}
                {pay.cardLast4 && (
                  <span className="small">
                    {' '}
                    · {pay.cardBrand} •••• {pay.cardLast4}
                  </span>
                )}
              </dd>
              <dt>Customer</dt>
              <dd>{pay.user ? <Link to={`/p/${slug}/users/${pay.user.id}`}>{pay.user.name}</Link> : pay.customerEmail ?? <span className="faint">guest</span>}</dd>
              <dt>Provider id</dt>
              <dd>
                <code className="pay-ref">{pay.providerRef}</code>
                {pay.secondaryRef && (
                  <div>
                    <code className="pay-ref small">{pay.secondaryRef}</code>
                  </div>
                )}
              </dd>
              <dt>Return</dt>
              <dd className="pay-url">{pay.returnUrl ?? <span className="faint">none</span>}</dd>
              {pay.cancelUrl && (
                <>
                  <dt>Cancel</dt>
                  <dd className="pay-url">{pay.cancelUrl}</dd>
                </>
              )}
              {pay.callbackUrl && (
                <>
                  <dt>Callback</dt>
                  <dd className="pay-url">{pay.callbackUrl}</dd>
                </>
              )}
              <dt>Created</dt>
              <dd>
                {fmtDateTime(pay.createdAt)}
                {pay.expiresAt && (
                  <div className="small faint">
                    {new Date(pay.expiresAt).getTime() > Date.now() ? 'expires' : 'expired'} {fmtDateTime(pay.expiresAt)}
                    {timeUntil(pay.expiresAt) && ` (${timeUntil(pay.expiresAt)})`}
                  </div>
                )}
              </dd>
              {pay.logId && (
                <>
                  <dt>Request</dt>
                  <dd>
                    <Link to={`/p/${slug}/traffic?log=${pay.logId}`}>Traffic log entry</Link>
                  </dd>
                </>
              )}
            </dl>
          </div>
          <div className="stack">
            {pay.lint.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h3>Integration checks</h3>
                </div>
                <ul className="pay-lint-list card-pad">
                  {pay.lint.map((l) => (
                    <li key={l.check + l.message}>
                      <Badge kind={LINT_KIND[l.severity]}>{l.severity}</Badge> <CheckId id={l.check} />
                      <div className="small">{l.message}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="card">
              <div className="card-head">
                <h3>Webhooks</h3>
              </div>
              {!hooks.length ? (
                <p className="card-pad small muted" style={{ margin: 0 }}>
                  No webhooks yet. They are planned when the payment completes.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="pay-hooks">
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>Attempts</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {hooks.map((h) => {
                        const at = attempts(h.id);
                        const last = at[at.length - 1];
                        return (
                          <tr key={h.id}>
                            <td>
                              <code className="small">{String(h.data.eventType)}</code>
                              {h.data.eventId ? <div className="small faint pay-ref">{String(h.data.eventId)}</div> : null}
                            </td>
                            <td className="small">
                              {!last ? (
                                <span className="faint">planned</span>
                              ) : (
                                <>
                                  <Badge kind={last.type === 'webhook_delivered' ? 'ok' : 'bad'}>{last.type === 'webhook_delivered' ? `HTTP ${String(last.data.status)}` : 'failed'}</Badge>
                                  <span className="faint"> × {at.length}</span>
                                  {last.type === 'webhook_failed' && <div className="faint">{String(last.data.error ?? '')}</div>}
                                </>
                              )}
                            </td>
                            <td className="nowrap">
                              <button
                                className="btn sm"
                                disabled={busy === h.id}
                                onClick={() =>
                                  void act(
                                    h.id,
                                    () => api.post<DeliverResult>(`${base}/webhooks/resend`, { event: h.id }),
                                    (r) => {
                                      const d = r as DeliverResult;
                                      return d.ok ? `Delivered: HTTP ${d.status}` : `Failed: ${d.error ?? d.status}`;
                                    },
                                  )
                                }
                              >
                                Resend
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <PaymentExtras pay={pay} />
            {pay.refunds && pay.refunds.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h3>Refunds</h3>
                </div>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {pay.refunds.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <code className="small pay-ref pay-ref-cut" title={r.providerRef}>
                              {r.providerRef}
                            </code>
                          </td>
                          <td className="small nowrap">{fmtMinor(r.amount, pay.currency)}</td>
                          <td>
                            <Badge>{r.status}</Badge>
                          </td>
                          <td className="small faint nowrap">{timeAgo(r.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Timeline</h3>
            <span className="small faint">{events.length} events</span>
          </div>
          <ol className="pay-timeline">
            {events.map((e) => (
              <li key={e.id} className={`pay-ev pay-ev-${e.type}`}>
                <button type="button" className="pay-ev-head" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <span className="pay-ev-time faint small nowrap">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span className="pay-ev-type">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="pay-ev-sum small muted">{eventSummary(e)}</span>
                </button>
                {open === e.id && <CodeBlock code={JSON.stringify(e.data, null, 2)} lang="json" />}
              </li>
            ))}
          </ol>
        </div>
        {pay.provider !== undefined && (
          <details className="card pay-raw">
            <summary className="card-head">
              <h3>Provider object (as the API returns it)</h3>
            </summary>
            <CodeBlock code={JSON.stringify(pay.provider, null, 2)} lang="json" />
          </details>
        )}
      </div>
      {modal === 'complete' && <CompleteModal pay={pay} onClose={() => setModal(null)} onDone={(msg) => { toast(msg); setModal(null); reload(); }} base={base} />}
      {modal === 'refund' && <RefundModal pay={pay} onClose={() => setModal(null)} onDone={(msg) => { toast(msg); setModal(null); reload(); }} base={base} />}
    </Page>
  );
}

function CompleteModal({ pay, base, onClose, onDone }: { pay: Payment; base: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [outcome, setOutcome] = useState('success');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ payment: Payment; redirect?: string | null }>(`${base}/complete`, { outcome });
      onDone(`Payment is now ${statusText(r.payment.status)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Complete payment as…"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !outcome.trim()} onClick={() => void go()}>
            Complete
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <p className="small muted" style={{ margin: 0 }}>
          Same as the customer finishing the hosted page for {pay.amountFormatted}. Rules and a forced header still win over this choice.
        </p>
        <div className="chips pay-outcomes">
          {QUICK_OUTCOMES.map((o) => (
            <button key={o} type="button" className={`chip ${outcome === o ? 'active' : ''}`} onClick={() => setOutcome(o)}>
              {o}
            </button>
          ))}
        </div>
        <label className="field">
          Outcome <span className="hint">modifiers too, e.g. success+no_webhook</span>
          <input className="mono" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function RefundModal({ pay, base, onClose, onDone }: { pay: Payment; base: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = pay.amount - pay.refunded;
  const go = async () => {
    setError(null);
    const minor = amount.trim() ? toMinor(amount, pay.currency) : null;
    if (amount.trim() && minor === null) return setError('Enter an amount like 12.50');
    setBusy(true);
    try {
      const r = await api.post<{ amountFormatted: string }>(`${base}/refund`, { amount: minor });
      onDone(`Refunded ${r.amountFormatted}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Refund payment"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void go()}>
            Refund
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Amount in {pay.currency} <span className="hint">empty = the rest ({fmtMinor(left, pay.currency)})</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="full" />
        </label>
      </div>
    </Modal>
  );
}

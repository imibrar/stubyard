import type { ReactNode } from 'react';
import { Badge, fmtDateTime, timeAgo } from './ui';
import { fmtMinor, type Payment, type PaymentAuthorization, type PaymentToken } from '../paymentsApi';

type Json = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));

/**
 * Payments 1b details of one payment: PayPal authorization and its captures, 3D Secure, the JS SDK / Card Fields path,
 * vault tokens (used or saved) and HyperPay checkout facts (entity, payment type, SRI, backoffice operations).
 * Renders nothing for payments without such data.
 */
export function PaymentExtras({ pay }: { pay: Payment }) {
  const pd = (pay.providerData ?? {}) as Json;
  const auth = (pd.authorization as PaymentAuthorization | undefined) ?? null;
  const tokens = pay.tokens ?? [];
  const ops = (pd.ops as Json[] | undefined) ?? [];
  const hp = pay.preset === 'hyperpay';
  const challenged = !!pd.challenged || (pay.events ?? []).some((e) => e.type === '3ds');
  const rows: [string, ReactNode][] = [];
  if (pay.preset === 'paypal') {
    rows.push(['Intent', <code key="i">{String(pd.intent ?? 'CAPTURE')}</code>]);
    if (pd.sdk) rows.push(['Flow', <span key="f">JS SDK {pay.method === 'card' ? 'Card Fields' : 'Buttons'}{pd.clientCreated ? <Badge kind="accent">order created in the browser</Badge> : null}</span>]);
    if (pd.sca) rows.push(['3D Secure', <span key="s"><code>{String(pd.sca)}</code>{challenged ? ' · challenged' : ' · no challenge'}</span>]);
    if (pd.vaultUsed) rows.push(['Paid with', <span key="v">vault token <code className="pay-ref">{String(pd.vaultUsed)}</code></span>]);
    if (pd.storeInVault) rows.push(['store_in_vault', <span key="sv">ON_SUCCESS{(pd.vault as Json | undefined)?.id ? <> → <code className="pay-ref">{String((pd.vault as Json).id)}</code></> : ' (saved after a successful capture)'}</span>]);
  }
  if (hp) {
    rows.push(['Payment type', <code key="t">{String(pd.paymentType ?? 'DB')}</code>]);
    rows.push(['Entity', <span key="e"><code className="pay-ref">{String(pd.entityId ?? '')}</code> {pd.mada ? <Badge>mada</Badge> : <Badge>cards</Badge>}</span>]);
    rows.push(['SRI', pd.integrity ? <Badge key="sri" kind="ok">integrity sent</Badge> : <Badge key="sri" kind="warn">no integrity</Badge>]);
    const w = pd.widget as Json | undefined;
    if (w) rows.push(['Widget brands', <span key="b" className="small">{((w.brands as string[] | undefined) ?? []).join(' ') || 'all'}</span>]);
    const queries = (pay.events ?? []).filter((e) => e.type === 'status_queried').length;
    rows.push(['Result queried', <span key="q">{queries ? `${queries}×` : <span className="faint">never</span>}</span>]);
  }
  if (!rows.length && !auth && !tokens.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{hp ? 'HyperPay checkout' : 'PayPal details'}</h3>
      </div>
      {rows.length > 0 && (
        <dl className="kv card-pad pay-kv">
          {rows.map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </dl>
      )}
      {auth && (
        <div className="pay-extra-block">
          <div className="pay-extra-title row">
            <b>Authorization</b> <code className="pay-ref small">{auth.id}</code> <Badge kind={auth.status === 'VOIDED' || auth.status === 'DENIED' ? 'bad' : auth.status === 'CAPTURED' ? 'ok' : 'accent'}>{auth.status}</Badge>
          </div>
          <p className="small faint pay-extra-note">
            {fmtMinor(auth.capturedAmount, pay.currency)} of {fmtMinor(auth.amount, pay.currency)} captured · expires {fmtDateTime(auth.expiration)}
            {auth.previous.length > 0 && <> · reauthorized from {auth.previous.join(', ')}</>}
          </p>
          {auth.captures.length > 0 && (
            <div className="table-wrap">
              <table className="pay-captures">
                <thead>
                  <tr>
                    <th>Capture</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {auth.captures.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Capture">
                        <code className="small pay-ref">{c.id}</code>
                      </td>
                      <td data-label="Amount" className="small nowrap">
                        {fmtMinor(c.amount, pay.currency)} {c.final ? <span className="faint">final</span> : null}
                      </td>
                      <td data-label="Status">
                        <Badge kind={c.status === 'DECLINED' ? 'bad' : 'ok'}>{c.status}</Badge>
                      </td>
                      <td data-label="When" className="small faint nowrap">
                        {timeAgo(c.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {ops.length > 0 && (
        <div className="pay-extra-block">
          <div className="pay-extra-title">
            <b>Backoffice operations</b>
          </div>
          <div className="table-wrap">
            <table className="pay-captures">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={String(o.id)}>
                    <td data-label="Type">
                      <code>{String(o.paymentType)}</code>
                    </td>
                    <td data-label="Amount" className="small nowrap">
                      {String(o.amount)} {String(o.currency ?? pay.currency)}
                    </td>
                    <td data-label="Result" className="small">
                      <code>{String((o.result as Json | undefined)?.code ?? '')}</code> <span className="faint">{str((o.result as Json | undefined)?.description)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tokens.length > 0 && <TokenTable tokens={tokens} title="Saved payment methods" />}
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/** Vault tokens (PayPal Vault v3): brand / last 4 only, never digits. */
export function TokenTable({ tokens, title }: { tokens: PaymentToken[]; title?: string }) {
  return (
    <div className="pay-extra-block">
      {title && (
        <div className="pay-extra-title">
          <b>{title}</b>
        </div>
      )}
      <div className="table-wrap">
        <table className="pay-captures">
          <thead>
            <tr>
              <th>Token</th>
              <th>Source</th>
              <th>Customer</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td data-label="Token">
                  <code className="small pay-ref">{t.providerRef}</code> <span className="faint small">{t.kind}</span>
                </td>
                <td data-label="Source" className="small">
                  {t.source === 'card' ? `${t.cardBrand ?? 'card'} •••• ${t.cardLast4 ?? ''}${t.expiry ? ` · ${t.expiry}` : ''}` : str(t.data.email) ?? 'PayPal'}
                </td>
                <td data-label="Customer" className="small">
                  <code className="pay-ref">{t.customerId ?? '—'}</code>
                </td>
                <td data-label="Status">
                  <Badge kind={t.status === 'DELETED' || t.status === 'CANCELLED' ? 'warn' : t.status === 'ACTIVE' || t.status === 'APPROVED' ? 'ok' : 'accent'}>{t.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

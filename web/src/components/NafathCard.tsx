/**
 * Fake Nafath in a test user's workspace: the "Nafath app" quick card (a WAITING request with its three numbers and
 * Reject) and the Nafath tab (the user's request history). Both reload on nafath.changed / project.reset.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGate } from '../auth';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { nafathApi, nafathBase, type NafathRequest, type NafathStatus } from '../nafathApi';
import type { TestUser } from '../api';
import { Icon } from './people';
import { Badge, CodeBlock, Empty, ErrorBox, fmtDateTime, timeAgo, useTick, useToast } from './ui';
import '../styles/nafath.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------- National IDs (same rule as server/src/nafath/national-id.ts; the server validates) ----------------

export type NationalIdKind = 'citizen' | 'resident';
const NATIONAL_ID_RE = /^[12]\d{9}$/;

function luhnSum(digits: string): number {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum;
}

export const isNationalId = (s: string | null | undefined): boolean => typeof s === 'string' && NATIONAL_ID_RE.test(s) && luhnSum(s) % 10 === 0;

/** Why `s` is not a valid national ID / Iqama number (null when it is valid or empty). */
export function nationalIdProblem(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'Digits only.';
  if (v.length !== 10) return `10 digits (has ${v.length}).`;
  if (v[0] !== '1' && v[0] !== '2') return 'Starts with 1 (citizen) or 2 (resident).';
  if (luhnSum(v) % 10 !== 0) return 'The check digit (last digit) is wrong.';
  return null;
}

/** A random valid ID of this kind. */
export function generateNationalId(kind: NationalIdKind): string {
  let body = kind === 'citizen' ? '1' : '2';
  for (let i = 0; i < 8; i++) body += String(Math.floor(Math.random() * 10));
  return body + ((10 - (luhnSum(body + '0') % 10)) % 10);
}

/** "National ID" for a citizen (1…), "Iqama" for a resident (2…). */
export const nationalIdLabel = (id: string | null | undefined) => (id?.startsWith('2') ? 'Iqama' : 'National ID');

// ---------------- Data ----------------

/** This user's Nafath requests (newest first), live. */
function useUserNafath(slug: string, userId: string) {
  const f = useFetch<NafathRequest[]>(`${nafathBase(slug)}/requests?user=${encodeURIComponent(userId)}&limit=50`, [slug, userId]);
  const reload = useDebounced(() => void f.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'nafath.changed' || e.type === 'project.reset') reload();
  });
  return { data: f.data, error: f.error, reload };
}

/** Decide a request (pick a number or reject), with a toast. */
function useDecide(slug: string, reload: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (r: NafathRequest, done: string, fn: () => Promise<unknown>) => {
    setBusy(r.id);
    try {
      await fn();
      toast(done);
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(null);
      reload();
    }
  };
  return { busy, run };
}

const STATUS_KIND: Record<NafathStatus, string> = { WAITING: 'accent', COMPLETED: 'ok', REJECTED: 'bad', EXPIRED: 'warn' };
const STATUS_ICON: Record<NafathStatus, string> = { WAITING: 'clock', COMPLETED: 'check', REJECTED: 'close', EXPIRED: 'info' };
const STATUS_TEXT: Record<NafathStatus, string> = { WAITING: 'Waiting', COMPLETED: 'Approved', REJECTED: 'Rejected', EXPIRED: 'Expired' };

function NafathStatusBadge({ r }: { r: NafathRequest }) {
  const reason = r.reason && r.reason !== 'rejected' && r.reason !== 'expired' ? r.reason.replace(/_/g, ' ') : null;
  return (
    <Badge kind={STATUS_KIND[r.status]} title={r.decidedBy ? `Decided by ${r.decidedBy}` : undefined}>
      <span className="nafath-status">
        <Icon name={STATUS_ICON[r.status]} size={12} />
        {STATUS_TEXT[r.status]}
        {reason ? ` (${reason})` : ''}
      </span>
    </Badge>
  );
}

/**
 * Seconds left of a WAITING request: the server's expiresInSeconds (on the project's auth clock, which time offsets
 * move) minus the time since the list was fetched. expiresAt is on that same clock, so it is not compared with Date.now().
 */
const secondsLeft = (r: NafathRequest, fetchedAt: number) => Math.max(0, (r.expiresInSeconds ?? 0) - Math.floor((Date.now() - fetchedAt) / 1000));
const fmtLeft = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ---------------- Quick card ----------------

/**
 * The "Nafath app" quick card(s) of a test user: one card per WAITING request (service, countdown, the three numbers
 * and Reject). Without one it shows a hint and the national ID. Hidden when the project has no Nafath instance and
 * the user has no requests.
 */
export function NafathCard({ slug, user, hasInstances }: { slug: string; user: TestUser; hasInstances: boolean }) {
  const { data, error, reload } = useUserNafath(slug, user.id);
  const gate = useGate(slug)('walkthroughs.run');
  const { busy, run } = useDecide(slug, reload);
  useTick(1000);
  const fetchedAt = useMemo(() => Date.now(), [data]);
  const waiting = (data ?? []).filter((r) => r.status === 'WAITING');
  // The server expires requests lazily: reload once a countdown runs out so the card goes away (or shows the new time).
  const anyLapsed = waiting.some((r) => secondsLeft(r, fetchedAt) === 0);
  useEffect(() => {
    if (anyLapsed) reload();
  }, [anyLapsed]);

  if (!hasInstances && !data?.length) return null;

  if (!waiting.length) {
    return (
      <div className="card quick-card nafath-quick">
        <span className="label">
          <Icon name="shield" size={12} /> Nafath
        </span>
        {error ? (
          <ErrorBox error={error} />
        ) : (
          <span className="faint small">
            {user.nationalId ? (
              <>
                No request waiting. Log in with Nafath in your app using {nationalIdLabel(user.nationalId)} <code>{user.nationalId}</code>; the numbers show up here.
              </>
            ) : (
              <>This user has no national ID yet. Edit the user to add one, then log in with Nafath in your app.</>
            )}
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      {waiting.map((r) => {
        const left = secondsLeft(r, fetchedAt);
        const disabled = !!gate.disabled || busy === r.id;
        const service = r.service || 'Nafath login';
        return (
          <section key={r.id} className="card quick-card nafath-quick nafath-app" aria-labelledby={`nafath-q-${r.id}`} aria-live="polite">
            <span className="label row nowrap">
              <Icon name="shield" size={12} />
              <span className="grow ellipsis" id={`nafath-q-${r.id}`}>
                Nafath · <strong>{service}</strong>
              </span>
              <span className="nafath-left" aria-label={`Expires in ${left} seconds`} title={`Expires ${fmtDateTime(r.expiresAt)}`}>
                <Icon name="clock" size={12} /> {fmtLeft(left)}
              </span>
            </span>
            <span className="small muted">Pick the number your app shows.</span>
            <div className="nafath-pick" role="group" aria-label={`Numbers for ${service}`}>
              {r.choices.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="btn nafath-num"
                  disabled={disabled}
                  title={gate.title}
                  aria-label={`Pick ${n}`}
                  onClick={() => void run(r, n === r.random ? `Picked ${n}: approved` : `Picked ${n}: wrong number, rejected`, () => nafathApi.choose(slug, r.id, n))}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="row">
              <button type="button" className="btn sm danger" disabled={disabled} title={gate.title} onClick={() => void run(r, 'Rejected', () => nafathApi.reject(slug, r.id))}>
                Reject
              </button>
              <span className="small faint ellipsis grow">
                {nationalIdLabel(r.nationalId)} {r.nationalId}
              </span>
            </div>
          </section>
        );
      })}
    </>
  );
}

// ---------------- Tab ----------------

/** The decoded payload of a JWT (no verification), or null. */
function decodeJwt(token: string): unknown {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function CallbackText({ r }: { r: NafathRequest }) {
  if (!r.callback.length) return <span className="faint">none</span>;
  const last = r.callback[r.callback.length - 1];
  const ok = last.status !== null && last.status >= 200 && last.status < 300;
  return (
    <span title={last.error ?? last.url}>
      {r.callback.length} × · <span className={ok ? '' : 'nafath-bad'}>{last.status ?? 'no answer'}</span>
    </span>
  );
}

/** The Nafath tab of a test user: requests with status, numbers, who decided, callbacks and the decoded token. */
export function UserNafathBlock({ slug, user }: { slug: string; user: TestUser }) {
  const { data, error, reload } = useUserNafath(slug, user.id);
  const gate = useGate(slug)('walkthroughs.run');
  const { busy, run } = useDecide(slug, reload);
  useTick(30_000);
  const rows = data ?? [];
  return (
    <div className="card nafath-user">
      <ErrorBox error={error} />
      {data && !rows.length ? (
        <Empty title="No Nafath requests yet">
          {user.nationalId ? (
            <>
              Log in with Nafath in your app using {nationalIdLabel(user.nationalId)} <code>{user.nationalId}</code>. Instances are under{' '}
              <Link to={`/p/${slug}/providers/nafath`}>Providers → Nafath</Link>.
            </>
          ) : (
            <>Edit this user to add a national ID first.</>
          )}
        </Empty>
      ) : (
        rows.length > 0 && (
          <div className="table-wrap">
            <table className="nafath-table">
              <caption className="nafath-caption">Nafath requests of {user.name} (newest first, updated live)</caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Service</th>
                  <th scope="col">Number</th>
                  <th scope="col">Decided by</th>
                  <th scope="col">Callback</th>
                  <th scope="col">When</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const claims = r.token ? decodeJwt(r.token) : null;
                  return (
                    <tr key={r.id}>
                      <td>
                        <NafathStatusBadge r={r} />
                      </td>
                      <td>{r.service || <span className="faint">none</span>}</td>
                      <td>
                        <code className="nafath-number">{r.random}</code>
                        {r.chosen && r.chosen !== r.random && <span className="small nafath-bad"> picked {r.chosen}</span>}
                      </td>
                      <td>{r.decidedBy ?? <span className="faint">–</span>}</td>
                      <td>
                        <CallbackText r={r} />
                      </td>
                      <td title={fmtDateTime(r.createdAt)}>
                        <span className="nowrap">{timeAgo(r.createdAt)}</span>
                        {r.decidedAt && <div className="small faint nowrap">decided {timeAgo(r.decidedAt)}</div>}
                      </td>
                      <td>
                        {r.status === 'WAITING' ? (
                          <button type="button" className="btn xs danger" disabled={!!gate.disabled || busy === r.id} title={gate.title} aria-label={`Reject request for ${r.service || 'Nafath login'}`} onClick={() => void run(r, 'Rejected', () => nafathApi.reject(slug, r.id))}>
                            Reject
                          </button>
                        ) : claims ? (
                          <details className="nafath-token">
                            <summary className="small">Token</summary>
                            <CodeBlock code={JSON.stringify(claims, null, 2)} lang="json" />
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

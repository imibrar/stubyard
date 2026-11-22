// Login step (§6.7): Go to login, Fill login (username + password, highlight the submit button), then the 2FA
// wait: poll the code field until it shows, fetch the TOTP code (or wait for the OTP message) and type it in.
// The human clicks Log in and Verify.
// The 2FA wait is shared by the side panel and the on-page widget (run/waits.ts): Fill login stores it in the step
// data (twoFactorPending) before it fills, so when the page navigates after Log in, the widget on the next page resumes
// it; the other view shows "Waiting … in the page widget" and never waits or fills as well.
import { useEffect, useRef, useState } from 'react';
import { getTotpCode } from '@stubyard/client/authenticators';
import { waitForMessagePath } from '@stubyard/client/messages';
import { ErrorBox, useAction } from '../context';
import { CopyButton } from '../../run/CopyButton';
import { useStepHost } from '../../run/host';
import { useSharedWait } from '../../run/useSharedWait';
import { totpDelayMs } from '../state';
import { openUrl, samePage, sendToTab, sleep } from '../tabs';
import type { ResolvedOf, StepProps } from './StepCard';

export const TWO_FACTOR_WAIT_MS = 5 * 60_000;

export function LoginControls({ t, w, step, resolved, apply, quick }: StepProps<ResolvedOf<'login'>>) {
  const p = useStepHost();
  const act = useAction();
  const [status, setStatus] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState<{ code: string; validUntil: number } | null>(null);
  const tf = resolved.twoFactor;
  const url = resolved.url;
  const here = !!url && !!p.tab && samePage(p.tab.url, url);

  const setField = async (tabId: number, selector: string, value: string, what: string) => {
    const r = await sendToTab(tabId, { type: 'setValue', selector, value });
    if (!r.ok) throw new Error(`Could not fill the ${what} (${selector}): ${r.error ?? 'not found'}`);
  };

  const twoFa = useSharedWait({
    kind: '2fa',
    t,
    w,
    step,
    apply,
    ms: TWO_FACTOR_WAIT_MS,
    task: async ({ signal, pending, mine }) => {
      if (tf.kind === 'none') return null;
      const tabId = pending.tabId;
      setCode(null);
      setStatus('Waiting for the code field…');
      for (;;) {
        if (Date.now() > pending.until) throw new Error('The 2FA code field did not appear within 5 minutes.');
        try {
          const pr = await sendToTab(tabId, { type: 'probe', selector: tf.selector });
          if (pr.visible) break;
        } catch {
          /* navigating: the content script is re-injected on the next try */
        }
        await sleep(1000, signal);
      }
      let value: string;
      if (tf.kind === 'totp') {
        setStatus(`Getting the code of ${tf.label}…`);
        let c = await getTotpCode(t, tf.codePath);
        const delay = totpDelayMs(c, Date.now());
        if (delay) {
          setStatus('The code is about to expire: waiting for the next one…');
          await sleep(delay, signal);
          c = await getTotpCode(t, tf.codePath);
        }
        setCode({ code: c.code, validUntil: c.validUntil });
        value = c.code;
      } else {
        setStatus(`Waiting for the ${tf.kind === 'email-otp' ? 'email' : 'SMS'} with the code…`);
        let otp: string | null = null;
        while (!otp) {
          if (Date.now() > pending.until) throw new Error('No code message arrived within 5 minutes.');
          const msg = await waitForMessagePath(t, tf.waitPath, { signal });
          otp = msg?.otp ?? null;
          if (msg && !otp) throw new Error(`The message "${msg.subject ?? msg.id}" has no code in it.`);
        }
        setCode({ code: otp, validUntil: 0 });
        value = otp;
      }
      // Never fill twice: another view may have taken the wait over meanwhile.
      if (!(await mine())) {
        setStatus(null);
        return null;
      }
      await setField(tabId, tf.selector, value, '2FA code');
      setStatus(`Code filled. Click Verify in the page, then press ${quick ? 'Next' : 'Done'}.`);
      return { twoFactorFilled: true };
    },
  });

  useEffect(() => {
    if (twoFa.error) setStatus(null);
  }, [twoFa.error]);
  useEffect(() => {
    if (twoFa.lostTo) setStatus(null);
  }, [twoFa.lostTo]);

  const fillLogin = () =>
    act.run('fill', async () => {
      if (!p.tab) throw new Error('No tab.');
      const tabId = p.tab.id;
      // The wait is stored first: the page may navigate as soon as Log in is clicked.
      if (tf.kind !== 'none') await twoFa.start(tabId);
      try {
        await setField(tabId, resolved.selectors.username, resolved.username, 'username');
        await setField(tabId, resolved.selectors.password, resolved.password, 'password');
      } catch (err) {
        twoFa.cancel();
        throw err;
      }
      await sendToTab(tabId, { type: 'highlight', selector: resolved.selectors.submit ?? 'button[type=submit]' }).catch(() => {});
      p.notify('Click Log in in the page.');
    });

  // Alt+Shift+F (routed to exactly one view by the service worker) fills the login while this step is open.
  const first = useRef(p.fillRequest);
  useEffect(() => {
    if (p.fillRequest !== first.current && !act.busy) void fillLogin();
  }, [p.fillRequest]);

  const twoFaLabel = tf.kind === 'none' ? 'none' : tf.kind === 'totp' ? `authenticator app (${tf.label})` : tf.kind;
  const password = (
    <>
      <code>{showPassword ? resolved.password : '••••••••'}</code>{' '}
      <button className="link" aria-label={showPassword ? 'Hide the password' : 'Show the password'} onClick={() => setShowPassword((s) => !s)}>
        {showPassword ? 'hide' : 'show'}
      </button>{' '}
      <CopyButton text={resolved.password} what="password" />
    </>
  );

  return (
    <div className="controls">
      {p.compact ? (
        <div className="creds-compact small">
          <div>
            {resolved.actor?.name ?? '?'} <span className="muted">({resolved.actor?.role})</span>
            {tf.kind !== 'none' && <span className="muted"> · 2FA {tf.kind === 'totp' ? tf.label : tf.kind}</span>}
          </div>
          <div className="creds-line">
            <code>{resolved.username}</code> <CopyButton text={resolved.username} what="username" /> · {password}
          </div>
        </div>
      ) : (
        <dl className="creds">
          <dt>User</dt>
          <dd>
            {resolved.actor?.name ?? '?'} <span className="muted">({resolved.actor?.role})</span>
          </dd>
          <dt>Username</dt>
          <dd>
            <code>{resolved.username}</code> <CopyButton text={resolved.username} what="username" />
          </dd>
          <dt>Password</dt>
          <dd>{password}</dd>
          <dt>2FA</dt>
          <dd>{twoFaLabel}</dd>
        </dl>
      )}
      <div className="row wrap">
        {url && !here && (
          <button disabled={!p.tab || !!act.busy} onClick={() => void act.run('go', () => openUrl(p.tab!.id, url))}>
            Go to login
          </button>
        )}
        <button className="primary" disabled={!p.tab || !!act.busy} onClick={() => void fillLogin()}>
          Fill login
        </button>
        {tf.kind !== 'none' &&
          (twoFa.running ? (
            <button onClick={() => twoFa.cancel()}>Cancel 2FA wait</button>
          ) : twoFa.role === 'elsewhere' ? null : (
            <button disabled={!p.tab} onClick={() => void twoFa.start().catch(() => {})}>
              Fill 2FA code
            </button>
          ))}
      </div>
      {twoFa.role === 'elsewhere' && (
        <p className="status" role="status">
          Waiting for the 2FA code in {twoFa.where}.{' '}
          <button className="link" onClick={() => void twoFa.takeOver().catch(() => {})}>
            Wait here instead
          </button>
        </p>
      )}
      {twoFa.lostTo && twoFa.role !== 'elsewhere' && <p className="muted small">The 2FA wait moved to another view.</p>}
      {status && twoFa.role !== 'elsewhere' && <p className="status">{status}</p>}
      {code && <CodeView code={code.code} validUntil={code.validUntil} />}
      {step.data.twoFactorFilled === true && !status && twoFa.role === 'none' && <p className="muted small">The 2FA code was filled earlier.</p>}
      <ErrorBox error={act.error ?? twoFa.error} />
    </div>
  );
}

function CodeView({ code, validUntil }: { code: string; validUntil: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!validUntil) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [validUntil]);
  const left = validUntil ? Math.max(0, Math.ceil((validUntil - now) / 1000)) : null;
  return (
    <div className="code">
      <code>{code}</code> <CopyButton text={code} what="2FA code" />
      {left !== null && <span className={left < 5 ? 'muted bad' : 'muted'}> valid {left}s</span>}
    </div>
  );
}
